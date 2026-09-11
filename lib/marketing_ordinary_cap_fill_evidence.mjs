// Read-only acceptance of an exact submitted platform-capped fill. Never writes.
export function verifyOrdinaryCapFill(doc, expected) {
  const fail = reason => ({ok:false, reason});
  const same = (a,b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a-b)<0.005;
  if (!expected || !/^[a-f0-9]{64}$/.test(expected.workFingerprint || '')
    || doc?.executionWorkFingerprint !== expected.workFingerprint) return fail('work_fingerprint_mismatch');
  if (doc.store !== expected.storeKey || Number(doc.activity?.activityId ?? doc.activityId) !== Number(expected.activityId)) return fail('unit_mismatch');
  if (doc.ok !== true || doc.submit?.ok !== true || doc.submit?.submitted !== true
    || doc.submit?.state?.successUrl !== true || doc.submit?.state?.pendingConfirm === true) return fail('not_confirmed_submitted');
  const s=doc.selection, f=doc.fill;
  if (s?.ok !== true || s.selectedMatchesPlan !== true || f?.ok !== true) return fail('unclean_fill');
  for (const list of [s.missingAllowedSkcs,s.outOfPlanRows,f.missingCost,f.mismatches,f.priceStackBlockers,f.outOfPlanRows]) {
    if (!Array.isArray(list) || list.length) return fail('unclean_fill');
  }
  const targets=(f.targets || []).filter(r=>r.skc===expected.skc);
  if (targets.length!==1) return fail('target_not_unique');
  const r=targets[0], audit=r.platformPriceAudit;
  if (r.ok!==true || r.platformAdjusted!==true || r.platformAdjustmentApplied!==true
    || r.requiresReapproval!==false || r.floorBreached===true
    || r.platformPricePolicy!=='submit_platform_minimum_tier_and_audit'
    || audit?.platformAdjusted!==true) return fail('cap_policy_unproven');
  if (!same(r.approvedTargetPrice,expected.approvedPrice) || !same(audit.originalTargetPrice,expected.approvedPrice)) return fail('approved_price_mismatch');
  if (!Number.isFinite(r.currentPrice) || r.currentPrice<=0 || !Number.isFinite(r.minDiscount)
    || r.minDiscount<=0 || r.minDiscount>=100) return fail('cap_inputs_missing');
  // Match the submitted minimum-discount cap: floor cents, never round over it.
  const cap=Math.floor((r.currentPrice*(1-r.minDiscount/100)+1e-9)*100)/100;
  if (!(cap<expected.approvedPrice) || !same(r.targetPrice,cap)
    || !same(Number(r.targetPriceText),cap) || !same(audit.actualPrice,cap)
    || !same(r.activityTargetAfterPlatformAdjust,cap)) return fail('cap_calculation_mismatch');
  return {ok:true, price:cap, approvedPrice:expected.approvedPrice, source:'submitted_platform_cap_fill_verified'};
}
