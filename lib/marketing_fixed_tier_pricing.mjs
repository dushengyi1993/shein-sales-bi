import fs from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';

export const FIXED_TIER_STANDARD_URL = new URL('../config/marketing_fixed_tier_standard.json', import.meta.url);
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const num = value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const key = row => `${String(row?.storeKey ?? row?.store_key ?? row?.store ?? '').toUpperCase()}::${row?.skc ?? row?.SKC ?? ''}`;
export const fixedTierCanonicalKey = value => String(value || '').normalize('NFKC').match(/^[A-Za-z0-9-]+/)?.[0].replaceAll('-', '').toUpperCase() || '';
const canonicalOf = row => row?.canonical || row?.standard_goods_sn || row?.standardGoodsSn || row?.goodsSn || row?.supplierNo || '';

export function loadFixedTierStandard() {
  const bytes = fs.readFileSync(FIXED_TIER_STANDARD_URL);
  const doc = JSON.parse(bytes);
  if (doc.schemaVersion !== 'marketing-fixed-tier-standard/v1' || !doc.version || doc.currency !== 'SAR' || !Array.isArray(doc.items)) throw Error('fixed_tier_standard_invalid');
  const keys = new Set();
  for (const item of doc.items) {
    const k = fixedTierCanonicalKey(item.canonical);
    if (!k || keys.has(k) || item.prices?.length !== 3 || item.prices.some(p => !Number.isInteger(p) || p <= 0)) throw Error('fixed_tier_standard_invalid_item');
    keys.add(k);
  }
  return {doc, sha256:hash(bytes)};
}

export function fixedTierItem(canonical, standard = loadFixedTierStandard()) {
  return standard.doc.items.find(item => fixedTierCanonicalKey(item.canonical) === fixedTierCanonicalKey(canonical)) || null;
}

function rowsOf(doc) {
  const data = doc?.data || doc || {};
  return [...(data.storeLinks || []), ...(data.links || [])];
}
function shelf(row) {
  const value = row?.is_on_shelf ?? row?.isOnShelf;
  const status = String(row?.shelf_status_name || row?.shelfStatusName || row?.visible_shelf_statuses || '');
  if ([false,0,'0'].includes(value) || row?.is_out_shelf === true || /下架|售罄|SOLD_OUT|OUT_SHELF/i.test(status)) return false;
  return [true,1,'1'].includes(value) || /已上架|在售|ON_SHELF/i.test(status) ? true : null;
}
export function buildFixedTierContext(linksDataDoc, {reportDate = '', standard = loadFixedTierStandard()} = {}) {
  const byKey = new Map();
  for (const row of rowsOf(linksDataDoc)) {
    const k = key(row);
    if (k === '::') continue;
    const prior = byKey.get(k);
    // Conflicting duplicate evidence must not pick an arbitrary tier.
    if (prior && hash(prior) !== hash(row)) byKey.set(k, {...row, fixedTierDuplicateConflict:true});
    else byKey.set(k, row);
  }
  return {standard, reportDate, byKey};
}

export function resolveFixedTierPrice(row, context) {
  const standard = context?.standard || loadFixedTierStandard();
  if (context?.reportDate && context.reportDate < standard.doc.effectiveDate) return {applies:false};
  const item = fixedTierItem(canonicalOf(row), standard);
  if (!item) return {applies:false};
  const blocked = (reason, evidence = {}) => ({applies:true, blocked:true, reason, canonical:item.canonical, ruleVersion:standard.doc.version, ruleHash:standard.sha256, evidence});
  const link = context?.byKey?.get(key(row));
  if (!link || link.fixedTierDuplicateConflict) return blocked('fixed_tier_missing_or_conflicting_link_evidence');
  if (fixedTierCanonicalKey(canonicalOf(link)) !== fixedTierCanonicalKey(item.canonical)) return blocked('fixed_tier_link_identity_changed');
  if (shelf(link) !== true) return blocked('fixed_tier_on_shelf_evidence_missing');
  const exposure = num(link.c7_eps_uv ?? link.c7EpsUv);
  const clicks = num(link.c7_goods_uv ?? link.c7GoodsUv);
  const cart = num(link.c7_cart_uv ?? link.c7CartUv);
  const sales = num(link.c7_sale_cnt ?? link.c7SaleCnt);
  const rate = exposure !== null && exposure > 0 && clicks !== null ? clicks/exposure : num(link.c7_click_rate ?? link.c7ClickRate);
  const metrics = {exposure,clicks,cart,sales,rate};
  if (exposure === null || sales === null || exposure < 0 || sales < 0) return blocked('fixed_tier_missing_classification_metrics',metrics);
  const high = sales === 0 && ((exposure > 3000 && rate !== null && rate > .04) || (exposure >= 3000 && cart !== null && cart >= 20));
  if (!high && sales === 0 && ((exposure > 3000 && rate === null) || (exposure >= 3000 && cart === null))) return blocked('fixed_tier_high_click_qualification_unknown',metrics);
  let tier = high ? 0 : null;
  let rank = null;
  let ranking = [];
  const age = num(link.shelf_age_days ?? link.shelf_days ?? link.shelfAgeDays);
  if (tier === null) {
    if (age !== null && age >= 0 && age <= 7) tier = 1;
    else {
      const peers = [...context.byKey.values()].filter(r => fixedTierCanonicalKey(canonicalOf(r)) === fixedTierCanonicalKey(item.canonical) && shelf(r) !== false);
      if (peers.some(r => shelf(r) !== true || r.fixedTierDuplicateConflict || num(r.c7_eps_uv ?? r.c7EpsUv) === null)) return blocked('fixed_tier_global_exposure_evidence_incomplete');
      ranking = peers.map(r => ({key:key(r),exposure:num(r.c7_eps_uv ?? r.c7EpsUv)})).sort((a,b) => b.exposure-a.exposure || a.key.localeCompare(b.key));
      rank = ranking.findIndex(r => r.key === key(row)) + 1;
      if (!rank) return blocked('fixed_tier_global_rank_missing');
      if (rank > 5 && age === null) return blocked('fixed_tier_new_listing_evidence_missing');
      tier = rank <= 5 ? 1 : 2;
    }
  }
  // Subsequent explicit exceptions live in the same versioned authority, never in an unverified row flag.
  const exceptions = (standard.doc.exceptions || []).filter(e => fixedTierCanonicalKey(e.canonical) === fixedTierCanonicalKey(item.canonical) && (!e.storeKey || e.storeKey === key(row).split('::')[0]) && (!e.skc || e.skc === String(row.skc)));
  const exception = exceptions.at(-1);
  if (exception && (!exception.authorization || !exception.authorizedAt || exception.authorizedAt < standard.doc.effectiveDate || !(num(exception.price) > 0))) return blocked('fixed_tier_invalid_user_exception');
  const price = exception ? exception.price : item.prices[tier];
  const evidence = {key:key(row),canonical:item.canonical,reportDate:context.reportDate,metrics,age,rank,ranking,exception:exception || null};
  const binding = {schemaVersion:'marketing-fixed-tier-binding/v1',ruleVersion:standard.doc.version,ruleHash:standard.sha256,canonical:item.canonical,tier,price,evidenceHash:hash(evidence),evidence};
  const max = num(row.platformMaxAllowedSignupPrice ?? row.platformMaximumActivityPrice ?? row.maxAllowedActivityPrice);
  if (max !== null && price > max) return {...blocked('fixed_tier_platform_maximum_below_fixed_price',{platformMaximum:max,requiredPrice:price}),price,binding};
  return {applies:true,blocked:false,price,binding};
}

export function applyFixedTierPrice(row, context) {
  const decision = resolveFixedTierPrice(row,context);
  if (!decision.applies) return null;
  if (decision.blocked) return {row:{...row,fixedTierPricing:decision.binding || decision},applied:false,blocked:true,reason:decision.reason,evidence:decision.evidence};
  const audit = {applied:true,mode:'user_fixed_tier',priority:0,fixedTierPricing:decision.binding};
  return {row:{...row,targetPrice:decision.price,finalTargetPrice:decision.price,limitedDiscountPrice:decision.price,fixedTierPricing:decision.binding,lowEtFastSellerPricePullback:audit},applied:true,blocked:false,reason:'user_fixed_tier',audit};
}

export function verifyFixedTierBinding(row, context, {platformMaximum = null} = {}) {
  const current = resolveFixedTierPrice({...row,platformMaximumActivityPrice:platformMaximum ?? row.platformMaximumActivityPrice},context);
  if (!current.applies) return {ok:true,applies:false};
  if (current.blocked) return {ok:false,reason:current.reason,current};
  const planned = row.fixedTierPricing || row.lowEtFastSellerPricePullback?.fixedTierPricing;
  if (!planned || planned.ruleHash !== current.binding.ruleHash || planned.evidenceHash !== current.binding.evidenceHash || planned.price !== current.price || planned.tier !== current.binding.tier) return {ok:false,reason:'fixed_tier_rule_or_evidence_changed_rebuild_required',current};
  for (const field of ['targetPrice','finalTargetPrice','limitedDiscountPrice','specialPrice']) {
    if (row[field] !== undefined && num(row[field]) !== current.price) return {ok:false,reason:'fixed_tier_exact_price_changed',field,current};
  }
  if (platformMaximum !== null && current.price > platformMaximum) return {ok:false,reason:'fixed_tier_platform_maximum_below_fixed_price',current};
  return {ok:true,applies:true,binding:current.binding};
}

export async function verifyFixedTierRescue({root, rescue, reportDate}) {
  const targets=(rescue.rows || []).filter(row=>fixedTierItem(canonicalOf(row)));
  if (!targets.length) return {ok:true,rows:[]};
  const file=path.resolve(root,rescue.sourceLinksData || 'outputs/bi-portal/sections/linksData.json');
  const doc=JSON.parse(await fs.promises.readFile(file,'utf8'));
  const generated=doc.generatedAt || doc.data?.generatedAt;
  if (!generated || !Number.isFinite(Date.parse(generated)) || new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(generated)) !== reportDate || Date.parse(generated)>Date.now()+60_000) return {ok:false,reason:'fixed_tier_links_evidence_stale',rows:[]};
  let links=doc;
  if (rescue.sourceRawLinkHistory) {
    const {buildLinkRowIndexFromBi}=await import('./marketing_pricing_policy.mjs');
    const {collectLatestRawMarketingLinkRows,assessLatestRawMarketingLinkCoverage,mergeMarketingLinkRows}=await import('./marketing_latest_raw_link_overlay.mjs');
    const cfg=JSON.parse(await fs.promises.readFile(path.resolve(root,rescue.sourceStoresConfig || 'config/stores.json'),'utf8'));
    const storeKeys=cfg.stores.filter(s=>s.enabled!==false).map(s=>String(s.storeKey || s.key || s.store).toUpperCase());
    const raw=collectLatestRawMarketingLinkRows({historyDir:path.resolve(root,rescue.sourceRawLinkHistory),reportDate,storeKeys});
    const coverage=assessLatestRawMarketingLinkCoverage({sourceFiles:raw.sourceFiles,errors:raw.errors,storeKeys});
    if (!coverage.complete) return {ok:false,reason:'fixed_tier_global_store_evidence_incomplete',rows:[]};
    links={storeLinks:mergeMarketingLinkRows([...buildLinkRowIndexFromBi(doc).byLinkKey.values()],raw.rows).rows};
  }
  const context=buildFixedTierContext(links,{reportDate});
  const rows=targets.map(row=>({skc:row.skc,...verifyFixedTierBinding(row,context)}));
  return {ok:rows.every(row=>row.ok),ruleHash:context.standard.sha256,rows};
}
