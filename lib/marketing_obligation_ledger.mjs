import {createHash} from 'node:crypto';
import {parseChinaBusinessDateTime} from './marketing_datetime.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rowsOf=doc=>Array.isArray(doc)?doc:doc?.items || doc?.rows || doc?.blocked || [];
const store=row=>String(row.storeKey || row.store || row.st || '').trim().toUpperCase();
const linkKey=row=>`${store(row)}:${String(row.skc || '').trim().toLowerCase()}`;
const rowKey=row=>`${store(row)}:${Number(row.activityId ?? row.aid)}:${String(row.skc || '').trim().toLowerCase()}`;
const date=value=>parseChinaBusinessDateTime(value)?.getTime() ?? NaN;
const hasReceipt=row=>row.officialReadback===true && /^[a-f0-9]{64}$/.test(row.receiptSha256 || '')
  && Boolean(row.receiptPath) && Number.isFinite(date(row.readbackAt));
const receiptOk=row=>row && hasReceipt(row) && row.identityMatched===true && row.priceMatched===true
  && ['not_changed','restored'].includes(row.inventoryState);

// The approved roster remains the denominator, regardless of selection/filter
// results. Observations are normalized official readbacks, never plan flags.
export function buildMarketingObligationLedger({roster,observations=[],asOf=new Date()}={}) {
  const now=new Date(asOf).getTime();
  if (!Number.isFinite(now)) throw Error('invalid_obligation_as_of');
  const source=rowsOf(roster);
  if (!source.length) throw Error('marketing_obligation_roster_required');
  const unique=new Map();
  for(const row of source) {
    const canonical=String(row.canonical || row.c || '').trim();
    if (!store(row) || !row.skc || !canonical || !Number.isInteger(Number(row.activityId ?? row.aid)) || Number(row.activityId ?? row.aid)<=0) throw Error('invalid_marketing_obligation_identity');
    const key=rowKey(row),prior=unique.get(key);
    if (prior && (prior.canonical || prior.c)!==canonical) throw Error('marketing_obligation_identity_conflict');
    unique.set(key,row);
  }
  const rows=[...unique].map(([key,row])=>{
    const exact=observations.filter(r=>rowKey(r)===key);
    const linked=observations.filter(r=>linkKey(r)===linkKey(row));
    const sameProduct=r=>String(r.canonical || '').trim()===String(row.canonical || row.c).trim();
    const latest=(candidates,kind)=>candidates.filter(r=>hasReceipt(r) && sameProduct(r)
      && String(r.state || '').startsWith(kind) && date(r.readbackAt)<=now+60000)
      .sort((a,b)=>date(a.readbackAt)-date(b.readbackAt)).at(-1);
    const lastOrdinary=latest(exact,'ordinary_'),lastLimited=latest(linked,'limited_');
    const ordinary=lastOrdinary?.state==='ordinary_confirmed' && receiptOk(lastOrdinary)?lastOrdinary:null;
    const limited=lastLimited?.state==='limited_confirmed' && receiptOk(lastLimited)
      && date(lastLimited.validFrom)<=now+2*3600000 && date(lastLimited.validTo)>now?lastLimited:null;
    const pending=!ordinary && exact.some(r=>['submitted','pending','unknown'].includes(r.submissionState));
    const last=exact.at(-1);
    const deadline=date(row.sourceActivityDeadline || row.deadline);
    const expired=Number.isFinite(deadline) && deadline<=now;
    const state=ordinary?'ordinary_readback_confirmed':limited?'limited_fallback_readback_confirmed':'unfinished';
    return {key,storeKey:store(row),activityId:Number(row.activityId ?? row.aid),skc:String(row.skc),canonical:String(row.canonical || row.c),
      state,ordinarySubmissionLocked:pending,ordinaryExpired:expired,
      coverageReceipt:ordinary?.receiptPath || limited?.receiptPath || null,
      reason:state!=='unfinished'?'official_matching_readback':pending?'submitted_or_uncertain_readback_pending':last?.reason || row.reason || 'coverage_not_yet_verified',
      nextAction:pending?'read_back_original_submission_without_retry':ordinary||limited?'keep_verified_coverage':expired?'check_price_stack_and_complete_limited_fallback':'refresh_platform_eligibility_and_enroll_or_complete_limited_fallback'};
  });
  const counts={total:rows.length,uniqueLinks:new Set(rows.map(linkKey)).size,
    ordinaryConfirmed:rows.filter(r=>r.state==='ordinary_readback_confirmed').length,
    limitedFallbackConfirmed:rows.filter(r=>r.state==='limited_fallback_readback_confirmed').length,
    unfinished:rows.filter(r=>r.state==='unfinished').length,
    pendingOriginalSubmission:rows.filter(r=>r.ordinarySubmissionLocked).length};
  return {schemaVersion:'marketing-obligation-ledger/v1',asOf:new Date(now).toISOString(),rosterSha256:hash(source),sourceRoster:source,observations,
    complete:counts.unfinished===0,counts,rows};
}
