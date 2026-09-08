import {buildFixedTierContext, applyFixedTierPrice, verifyFixedTierBinding, loadFixedTierStandard} from './marketing_fixed_tier_pricing.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  buildLinkRowIndexFromBi,
  buildExposureTopLinkIndex,
  ceil2,
  exposureRankInfo,
  findMarketingCostEvidence,
  normalizeMarketingPricingPolicy,
  pctConfigToRatio,
  unwrapBiLinksData,
} from './marketing_pricing_policy.mjs';
import {
  assessLatestRawMarketingLinkCoverage,
  collectLatestRawMarketingLinkRows,
  mergeMarketingLinkRows,
} from './marketing_latest_raw_link_overlay.mjs';
import {normalizeGoodsSnDetailed} from './product_sku_normalizer.mjs';

const CANONICAL_CONTEXT_SCOPE = 'canonical-v2';
const legacyReceiptCapabilities = new WeakMap();

// Only this verifier can mint an in-process compatibility capability. Neither
// an environment flag nor a deserialized object can authorize a legacy row.
export async function verifyLegacyLowEtReceiptContinuation({
  root, date, queueFile, receiptFile, expectedReceiptSha256,
  expectedWorkFingerprint, planPath, guardPath, nowEpoch = Math.floor(Date.now() / 1000),
  queueSnapshotBytes,
} = {}) {
  if (!/^[a-f0-9]{64}$/.test(expectedReceiptSha256 || '')
    || !/^[a-f0-9]{64}$/.test(expectedWorkFingerprint || '')) throw new Error('legacy receipt requires exact hashes');
  const {verifyUnstartedRepairStageContinuation} = await import('./cloud_marketing_immediate_authorization.mjs');
  const {loadExactFallbackRepairPlan} = await import('./marketing_repair_manifest.mjs');
  const receipt = await verifyUnstartedRepairStageContinuation({
    root, date, queueFile, receiptFile, expectedReceiptSha256, nowEpoch, queueSnapshotBytes,
    stage: 'fallbackRepair', expectedWorkFingerprint, planPath, guardPath,
  });
  if (receipt.status !== 'consumed') {
    throw new Error('legacy receipt cannot start new groups outside its original graceful budget');
  }
  const queueBytes = queueSnapshotBytes || await fs.readFile(queueFile);
  if (crypto.createHash('sha256').update(queueBytes).digest('hex') !== receipt.currentQueueStateSha256) {
    throw new Error('legacy receipt queue changed after verification');
  }
  const queue = JSON.parse(queueBytes);
  if (!['pending', 'deferred_to_local'].includes(queue.status) || queue.stages?.fallbackRepair?.status !== 'pending'
    || queue.stages.fallbackRepair.workFingerprint !== expectedWorkFingerprint
    || Object.values(queue.stages).some(stage => !['pending', 'not_required'].includes(stage.status) || stage.resultPath)) {
    throw new Error('legacy receipt requires the exact untouched pending queue and stages');
  }
  const exactPlan = await loadExactFallbackRepairPlan({root, date, planPath, guardPath});
  if (exactPlan.workFingerprint !== expectedWorkFingerprint) throw new Error('legacy receipt exact plan drift');
  const rows = exactPlan.entries.flatMap(entry => entry.rescue.rows || []);
  if (!rows.length || rows.some(row => row.lowEtFastSellerPricePullback?.applied !== false
    || row.lowEtFastSellerPricePullback?.contextEvidenceScope
    || row.lowEtFastSellerPricePullback?.evidenceHash
    || !/^[a-f0-9]{64}$/.test(row.lowEtFastSellerPricePullback?.contextEvidenceHash || '')
    || row.manualSpecialLimitedDiscount === true)) throw new Error('legacy receipt scope is not an untouched non-applied plan');
  const scopedRescues = exactPlan.entries.map(entry => entry.rescue);
  for (const group of receipt.groups.filter(group => group.mode === 'transaction')) {
    const fencedPath = group.persisted?.journal?.createAttempt?.exactScope?.rescuePath || group.persisted?.journal?.operationRescuePath;
    if (!fencedPath) continue;
    const original = exactPlan.entries.find(entry => entry.path === group.path).rescue;
    const fencedBytes = await fs.readFile(path.resolve(root, fencedPath));
    const fenced = JSON.parse(fencedBytes.toString('utf8'));
    const scope = group.persisted?.journal?.createAttempt?.exactScope;
    const fence = scope || (group.persisted?.journal?.operationRescueHash ? {
      rescuePath: group.persisted.journal.operationRescuePath,
      rescueHash: group.persisted.journal.operationRescueHash,
    } : null);
    const excluded = fenced.excludedInventoryBlockedSkcs;
    // Match the actual writeInventoryExecutableSubset transformation. Its
    // timestamp/purpose are audit metadata; all business fields are inherited.
    // Only an exact transaction fence can authorize this derived artifact.
    const validSubsetMetadata = fence && typeof fence.rescuePath === 'string'
      && path.resolve(root, fence.rescuePath) === path.resolve(root, fencedPath)
      && fence.rescueHash === crypto.createHash('sha256').update(fencedBytes).digest('hex')
      && (!scope || evidenceHash(scope.targetSkcs) === evidenceHash([...new Set((fenced.rows || []).map(row => String(row.skc || '').trim()))].sort()))
      && Array.isArray(excluded) && excluded.every(value => typeof value === 'string')
      && new Set(excluded).size === excluded.length
      && typeof fenced.createdAt === 'string' && Number.isFinite(Date.parse(fenced.createdAt))
      && new Date(fenced.createdAt).toISOString() === fenced.createdAt;
    const expectedSubset = validSubsetMetadata ? {
      ...original,
      createdAt: fenced.createdAt,
      parentRescue: path.relative(root, group.path).replaceAll('\\', '/'),
      purpose: `${original.purpose || 'limited_discount_fallback'}_inventory_executable_subset`,
      excludedInventoryBlockedSkcs: excluded,
      originalRowCount: original.rows.length,
      executableRowCount: original.rows.filter(row => !excluded.includes(String(row.skc || '').trim())).length,
      rows: original.rows.filter(row => !excluded.includes(String(row.skc || '').trim())),
    } : null;
    if (!Array.isArray(fenced.rows) || !fenced.rows.length
      || (evidenceHash(fenced) !== evidenceHash(original)
        && (!expectedSubset || evidenceHash(fenced) !== evidenceHash(expectedSubset)))) {
      throw new Error('persisted legacy rescue differs from original locked rows or window');
    }
    scopedRescues.push(fenced);
  }
  const capability = Object.freeze({
    admission: receipt, groups: receipt.groups,
    mode: 'verified_consumed_legacy_unstarted_fallback', authorizationId: receipt.authorizationId,
    receiptSha256: receipt.receiptSha256, workFingerprint: expectedWorkFingerprint,
    maxGroups: receipt.maxGroups, gracefulCutoffEpoch: receipt.gracefulCutoffEpoch,
    remainingUnstartedGroups: receipt.remainingUnstartedGroups ?? receipt.maxGroups,
    outerHardDeadlineEpoch: receipt.outerHardDeadlineEpoch,
  });
  legacyReceiptCapabilities.set(capability, {
    rescues: new Set(scopedRescues.map(rescue => evidenceHash(rescue))),
    rows: new Set(rows.map(row => evidenceHash(row))),
  });
  return capability;
}

export const DEFAULT_LOW_ET_FAST_SELLER_POLICY = Object.freeze({
  enabled: true,
  criteria: {
    matchedEtOperationalSaleableMaxInclusive: 10,
    canonicalGoodsValidSales30dAcross19StoresMinExclusive: 30,
  },
  pricingAction: {
    ordinaryMarginIncreasePctPoints: 5,
    platformMinimumDiscountOrMaximumSignupPriceWins: true,
    costFloorAndMarginSafetyRemainHard: true,
  },
});

export function buildLowEtFastSellerPricingContext({
  inventoryTrendDoc,
  linksDataDoc,
  baselineDoc,
  costDoc = {},
  marketingPolicy = {},
  reportDate = '',
} = {}) {
  const effectiveMarketingPolicy = normalizeMarketingPricingPolicy(marketingPolicy);
  const policy = mergePolicy(effectiveMarketingPolicy.lowEtFastSellerPricePullback || {});
  const inventoryRows = inventoryProducts(inventoryTrendDoc);
  const linkRows = uniqueLinkRows(linksDataDoc);
  const baselineRows = Array.isArray(baselineDoc?.items) ? baselineDoc.items : [];
  const inventoryByCanonical = buildInventoryByCanonical(inventoryRows, reportDate);
  const salesByCanonical = buildSalesByCanonical(linkRows);
  const exposureIndex = buildExposureTopLinkIndex({storeLinks: linkRows}, effectiveMarketingPolicy);
  const baselineIndexes = buildBaselineIndexes(baselineRows, costDoc);
  const baselineByCanonical = baselineIndexes.byCanonical;
  const baselineByLink = baselineIndexes.byLink;
  const canonicalKeys = new Set([
    ...inventoryByCanonical.keys(),
    ...salesByCanonical.keys(),
    ...baselineByCanonical.keys(),
  ]);
  const byCanonical = new Map();
  const blockers = [];
  for (const key of canonicalKeys) {
    const inventory = inventoryByCanonical.get(key) || null;
    const sales30d = salesByCanonical.get(key) || {validSales30d: null, rowCount: 0};
    const baseline = baselineByCanonical.get(key) || null;
    const canonical = inventory?.canonical || sales30d?.canonical || baseline?.canonical || '';
    const evidence = {
      canonical,
      canonicalKey: key,
      etOperationalSaleable: inventory?.etOperationalSaleable ?? null,
      inventoryMatched: inventory?.matched === true,
      inventorySnapshotDate: inventory?.snapshotDate || '',
      validSales30d: sales30d?.validSales30d ?? null,
      salesLinkCount: sales30d?.rowCount || 0,
      ordinaryApprovedPrice: baseline?.ordinaryApprovedPrice ?? null,
      ordinaryTargetMargin: baseline?.ordinaryTargetMargin ?? null,
      baselineRowCount: baseline?.rowCount || 0,
      baselineOrdinaryRowCount: baseline?.ordinaryRowCount || 0,
      costEvidence: findMarketingCostEvidence(costDoc, canonical),
      topRows: exposureTopRows(exposureIndex, canonical),
    };
    evidence.complete = evidence.inventoryMatched
      && Number.isFinite(evidence.etOperationalSaleable)
      && Number.isFinite(evidence.validSales30d);
    evidence.evidenceHash = evidenceHash(evidence);
    byCanonical.set(key, evidence);
  }
  const maxEt = Number(policy.criteria.matchedEtOperationalSaleableMaxInclusive);
  const minSalesExclusive = Number(policy.criteria.canonicalGoodsValidSales30dAcross19StoresMinExclusive);
  for (const evidence of byCanonical.values()) {
    if (
      !evidence.inventoryMatched
      || !Number.isFinite(evidence.etOperationalSaleable)
      || evidence.etOperationalSaleable > maxEt
      || !Number.isFinite(evidence.validSales30d)
      || evidence.validSales30d <= minSalesExclusive
    ) continue;
    if (!(evidence.ordinaryApprovedPrice > 0)) {
      blockers.push({
        canonical: evidence.canonical,
        canonicalKey: evidence.canonicalKey,
        reason: 'top5_missing_canonical_ordinary_approved_price',
        evidenceHash: evidence.evidenceHash,
      });
    }
  }
  return {
    schemaVersion: 1,
    fixedTierContext: buildFixedTierContext({storeLinks:linkRows}, {reportDate}),
    reportDate,
    policy,
    // Bind policy even when a change leaves today's calculated price unchanged.
    policyEvidenceHash: evidenceHash({...effectiveMarketingPolicy, fixedTierRuleHash:loadFixedTierStandard().sha256, lowEtFastSellerPricePullback: policy}),
    byCanonical,
    baselineByLink,
    exposureIndex,
    blockers,
    evidenceHash: evidenceHash({
      fixedTierRuleHash:loadFixedTierStandard().sha256,
      canonicals: [...byCanonical.values()].map(value => ({
        canonicalKey: value.canonicalKey,
        evidenceHash: value.evidenceHash,
      })).sort((a, b) => a.canonicalKey.localeCompare(b.canonicalKey)),
    }),
  };
}

export function evaluateLowEtFastSellerCanonical(canonical, context) {
  const key = canonicalKey(canonical);
  const evidence = context?.byCanonical?.get(key) || null;
  const policy = context?.policy || mergePolicy({});
  if (policy.enabled === false) return {applies: false, reason: 'disabled', evidence};
  const maxEt = Number(policy.criteria.matchedEtOperationalSaleableMaxInclusive);
  const minSalesExclusive = Number(policy.criteria.canonicalGoodsValidSales30dAcross19StoresMinExclusive);
  if (!evidence?.inventoryMatched || !Number.isFinite(evidence?.etOperationalSaleable)) {
    return {applies: false, blocked: true, reason: 'missing_current_day_matched_et_inventory', evidence};
  }
  if (evidence.etOperationalSaleable > maxEt) {
    return {applies: false, reason: 'et_operational_saleable_above_threshold', evidence};
  }
  if (!Number.isFinite(evidence.validSales30d)) {
    return {applies: false, blocked: true, reason: 'missing_complete_canonical_valid_sales_30d', evidence};
  }
  if (evidence.validSales30d <= minSalesExclusive) {
    return {applies: false, reason: 'canonical_valid_sales_30d_not_above_threshold', evidence};
  }
  return {applies: true, reason: 'low_et_fast_seller_price_pullback', evidence};
}

export function applyLowEtFastSellerPricePullback({
  row,
  context,
  costDoc = {},
  manualSpecial = false,
  currentLockedPriceKeys = null,
} = {}) {
  const source = row || {};
  if (!manualSpecial && source.manualSpecialLimitedDiscount !== true) {
    const fixed = applyFixedTierPrice(source, context?.fixedTierContext);
    if (fixed) return fixed;
  }
  const canonical = canonicalFromRow(source);
  const manualSpecialRow = manualSpecial || source.manualSpecialLimitedDiscount === true;
  const currentLockedOverride = source.userExplicitCurrentPriceOverride === true
    && currentLockedPriceKeys instanceof Set
    && currentLockedPriceKeys.has(priceRowKey(source));
  if (manualSpecialRow && currentLockedOverride) {
    return {
      row: {...source},
      applied: false,
      blocked: true,
      manualReview: true,
      reason: 'active_manual_special_requires_user_review',
      evidence: null,
    };
  }
  if (currentLockedOverride) {
    const targetPrice = positiveNumber(source.targetPrice ?? source.finalTargetPrice);
    const finalTargetPrice = positiveNumber(source.finalTargetPrice ?? source.targetPrice);
    if (targetPrice === null || finalTargetPrice === null || Math.abs(targetPrice - finalTargetPrice) > 0.01) {
      return {
        row: {...source},
        applied: false,
        blocked: true,
        reason: 'user_explicit_current_price_override_invalid_target',
        evidence: null,
      };
    }
    const audit = {
      applied: false,
      mode: 'user_explicit_current_price_override',
      priority: 0,
      currentLockedPlan: true,
      targetPrice,
      finalTargetPrice,
    };
    return {
      row: {...source, lowEtFastSellerPricePullback: audit},
      applied: false,
      blocked: false,
      reason: 'user_explicit_current_price_override',
      evidence: null,
      audit,
    };
  }
  const evaluation = evaluateLowEtFastSellerCanonical(canonical, context);
  if (!evaluation.applies) {
    const audit = {
      applied: false,
      mode: evaluation.reason,
      reason: evaluation.reason,
      canonical,
      evidenceHash: evaluation.evidence?.evidenceHash ?? null,
      contextEvidenceScope: CANONICAL_CONTEXT_SCOPE,
      contextEvidenceHash: canonicalContextEvidenceHash(canonical, context),
    };
    return {
      row: {...source, lowEtFastSellerPricePullback: audit},
      applied: false,
      blocked: evaluation.blocked === true,
      reason: evaluation.reason,
      evidence: evaluation.evidence,
      audit,
    };
  }
  if (manualSpecialRow) {
    return {
      row: {...source},
      applied: false,
      blocked: true,
      manualReview: true,
      reason: 'active_manual_special_requires_user_review',
      evidence: evaluation.evidence,
    };
  }
  const storeKey = normalizeStoreKey(source.storeKey || source.store || source['店铺']);
  const skc = String(source.skc || source.SKC || '').trim();
  const linkBaseline = context?.baselineByLink?.get(linkKey(storeKey, skc)) || null;
  const rank = exposureRankInfo(context.exposureIndex, canonical, skc, storeKey);
  const isTop5 = rank.isTopExposureLink === true;
  const costEvidence = findMarketingCostEvidence(costDoc, canonical);
  const productCost = positiveNumber(
    source.productUnitCostSar
    ?? source.productCost
    ?? source.unitCostSar
    ?? costEvidence.productUnitCostSar,
  );
  let calculatedPrice;
  let targetMargin = null;
  let mode;
  if (isTop5) {
    calculatedPrice = positiveNumber(evaluation.evidence.ordinaryApprovedPrice);
    if (!(calculatedPrice > 0)) {
      return {
        row: {...source},
        applied: false,
        blocked: true,
        reason: 'top5_missing_canonical_ordinary_approved_price',
        evidence: evaluation.evidence,
        rank,
      };
    }
    mode = 'top5_restore_latest_approved_canonical_ordinary_price';
  } else {
    const baseMargin = normalizedMargin(
      evaluation.evidence.ordinaryTargetMargin
      ?? source.ordinaryTargetMargin
      ?? source.baseMargin
      ?? source.targetMargin
      ?? linkBaseline?.ordinaryTargetMargin,
    );
    const increase = pctConfigToRatio(
      context.policy?.pricingAction?.ordinaryMarginIncreasePctPoints ?? 5,
    );
    targetMargin = baseMargin === null ? null : round4(baseMargin + increase);
    if (!(productCost > 0) || !(targetMargin > 0 && targetMargin < 1)) {
      return {
        row: {...source},
        applied: false,
        blocked: true,
        reason: 'ordinary_link_price_pullback_missing_cost_or_margin',
        evidence: evaluation.evidence,
        rank,
      };
    }
    calculatedPrice = ceil2(productCost / (1 - targetMargin));
    mode = 'ordinary_link_target_margin_plus_5_points';
  }
  if (!(calculatedPrice > 0)) {
    return {
      row: {...source},
      applied: false,
      blocked: true,
      reason: 'price_pullback_calculation_failed',
      evidence: evaluation.evidence,
      rank,
    };
  }
  const platformMaximumPrice = positiveNumber(
    source.platformMaxAllowedSignupPrice
    ?? source.platformMaximumActivityPrice
    ?? source.maxAllowedActivityPrice,
  );
  const platformClipped = platformMaximumPrice !== null && calculatedPrice > platformMaximumPrice;
  const finalPrice = round2(platformClipped ? platformMaximumPrice : calculatedPrice);
  const floorMargin = pctConfigToRatio(
    context?.policy?.pricingAction?.floorMarginPct
    ?? context?.policy?.floorMarginPct
    ?? 15,
  );
  const hardFloorPrice = productCost > 0 ? ceil2(productCost / (1 - floorMargin)) : null;
  if (hardFloorPrice !== null && finalPrice < hardFloorPrice - 0.01) {
    return {
      row: {...source},
      applied: false,
      blocked: true,
      reason: 'platform_maximum_price_below_cost_margin_floor',
      evidence: evaluation.evidence,
      rank,
      calculatedPrice,
      platformMaximumPrice,
      hardFloorPrice,
    };
  }
  const audit = {
    applied: true,
    mode,
    priority: 1,
    canonical,
    isTop5,
    rank: rank.rank,
    etOperationalSaleable: evaluation.evidence.etOperationalSaleable,
    validSales30d: evaluation.evidence.validSales30d,
    ordinaryApprovedPrice: evaluation.evidence.ordinaryApprovedPrice,
    canonicalOrdinaryApprovedPrice: evaluation.evidence.ordinaryApprovedPrice ?? calculatedPrice,
    canonicalBaselineHash: evidenceHash({
      ordinaryApprovedPrice: evaluation.evidence.ordinaryApprovedPrice,
      ordinaryTargetMargin: evaluation.evidence.ordinaryTargetMargin,
    }),
    ordinaryTargetMargin: evaluation.evidence.ordinaryTargetMargin,
    targetMargin,
    productCost,
    calculatedPrice: round2(calculatedPrice),
    platformMaximumPrice,
    platformClipped,
    finalPrice,
    evidenceHash: evaluation.evidence.evidenceHash,
    contextEvidenceScope: CANONICAL_CONTEXT_SCOPE,
    contextEvidenceHash: canonicalContextEvidenceHash(canonical, context),
  };
  return {
    row: {
      ...source,
      targetPrice: finalPrice,
      finalTargetPrice: finalPrice,
      limitedDiscountPrice: source.limitedDiscountPrice !== undefined ? finalPrice : source.limitedDiscountPrice,
      lowEtFastSellerPricePullback: audit,
    },
    applied: true,
    blocked: false,
    reason: audit.mode,
    evidence: evaluation.evidence,
    audit,
  };
}

export function applyLowEtFastSellerPricePullbackToRows({
  rows,
  context,
  costDoc = {},
  isManualSpecial = row => row?.manualSpecialLimitedDiscount === true,
  currentLockedPriceKeys = null,
} = {}) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const results = sourceRows.map(row => applyLowEtFastSellerPricePullback({
    row,
    context,
    costDoc,
    manualSpecial: isManualSpecial(row),
    currentLockedPriceKeys,
  }));
  return {
    rows: results.map(result => result.row),
    results,
    appliedCount: results.filter(result => result.applied).length,
    blockedCount: results.filter(result => result.blocked).length,
    manualReviewCount: results.filter(result => result.manualReview).length,
    evidenceHash: context?.evidenceHash || '',
  };
}

export function revalidateLowEtFastSellerPricePullback({
  row,
  context,
  costDoc = {},
  currentLockedPriceKeys = null,
  legacyReceiptCapability = null,
} = {}) {
  if (row?.manualSpecialLimitedDiscount !== true) {
    const fixed = verifyFixedTierBinding(row, context?.fixedTierContext);
    if (fixed.applies || !fixed.ok) return {...fixed, reason:fixed.reason || 'user_fixed_tier_verified'};
  }
  const current = applyLowEtFastSellerPricePullback({
    row,
    context,
    costDoc,
    manualSpecial: row?.manualSpecialLimitedDiscount === true,
    currentLockedPriceKeys,
  });
  const planned = row?.lowEtFastSellerPricePullback || null;
  if (current.blocked) return {ok: false, reason: current.reason, current, planned};
  if (current.manualReview) return {ok: false, reason: current.reason, current};
  const legacyScope = legacyReceiptCapabilities.get(legacyReceiptCapability);
  if (legacyScope?.rows.has(evidenceHash(row)) && planned?.applied === false
    && !planned.contextEvidenceScope && !planned.evidenceHash && current.applied === false
    && current.audit?.contextEvidenceScope === CANONICAL_CONTEXT_SCOPE
    && current.evidence?.complete === true && context?.policy?.enabled !== false
    && positiveNumber(row.finalTargetPrice) !== null) {
    const {lowEtFastSellerPricePullback: ignoredPlanned, ...locked} = row;
    const {lowEtFastSellerPricePullback: ignoredCurrent, ...recomputed} = current.row;
    if (evidenceHash(locked) === evidenceHash(recomputed)) {
      return {ok: true, reason: 'legacy_non_applied_recomputed_under_consumed_receipt', current, planned,
        authorizationId: legacyReceiptCapability.authorizationId};
    }
  }
  // An explicitly locked current price retains its separate business override.
  // A historical marker without a current lock does not qualify.
  const explicitCurrentOverride = current.audit?.mode === 'user_explicit_current_price_override'
    && !planned?.applied && !planned?.contextEvidenceHash && !planned?.contextEvidenceScope;
  // Legacy artifacts (including unannotated non-applied rows) cannot prove the
  // canonical/policy lock. The originating task must refresh under its existing
  // authorization; this reason does not request renewed user authorization.
  if (!explicitCurrentOverride && planned?.contextEvidenceScope !== CANONICAL_CONTEXT_SCOPE) {
    return {ok: false, reason: 'low_et_price_pullback_context_scope_requires_rebuild', current, planned};
  }
  if (planned?.contextEvidenceScope === CANONICAL_CONTEXT_SCOPE
    && (!planned.contextEvidenceHash || !context?.policyEvidenceHash
      || planned.contextEvidenceHash !== canonicalContextEvidenceHash(canonicalFromRow(row), context))) {
    return {ok: false, reason: 'low_et_price_pullback_context_evidence_drift', current, planned};
  }
  if (planned?.canonicalBaselineHash && planned.canonicalBaselineHash !== current.audit?.canonicalBaselineHash) {
    return {ok: false, reason: 'low_et_price_pullback_canonical_baseline_drift', current, planned};
  }
  if (current.applied !== Boolean(planned?.applied)) {
    return {ok: false, reason: 'low_et_price_pullback_applicability_drift', current, planned};
  }
  if (current.applied && planned?.evidenceHash !== current.audit?.evidenceHash) {
    return {ok: false, reason: 'low_et_price_pullback_evidence_drift', current, planned};
  }
  if (current.applied && Math.abs(Number(row.finalTargetPrice) - Number(current.row.finalTargetPrice)) > 0.01) {
    return {ok: false, reason: 'low_et_price_pullback_target_price_drift', current, planned};
  }
  return {ok: true, reason: 'current', current, planned};
}

export async function revalidateLowEtFastSellerRescueArtifact({
  root = process.cwd(),
  rescue,
  reportDate = '',
  legacyReceiptCapability = null,
} = {}) {
  if (legacyReceiptCapability && !legacyReceiptCapabilities.get(legacyReceiptCapability)?.rescues.has(evidenceHash(rescue))) {
    return {ok: false, reason: 'legacy_receipt_locked_rescue_drift', rows: []};
  }
  const rows = Array.isArray(rescue?.rows) ? rescue.rows : [];
  const ordinaryRows = rows.filter(row => row?.manualSpecialLimitedDiscount !== true);
  if (!ordinaryRows.length) {
    return {ok: true, skipped: true, reason: 'manual_special_rows_are_not_auto_overridden', rows: []};
  }
  const sources = {
    linksData: resolveSource(root, rescue?.sourceLinksData || 'outputs/bi-portal/sections/linksData.json'),
    inventoryTrend: resolveSource(root, rescue?.sourceInventoryTrend || 'outputs/bi-portal/sections/inventoryTrend.json'),
    baseline: resolveSource(root, rescue?.sourcePriceOverrides || ''),
    costMap: resolveSource(root, rescue?.sourceCostMap || 'tmp/mbrs/marketing-cost-map.json'),
    pricingPolicy: resolveSource(root, rescue?.pricingPolicy || 'config/marketing_pricing_policy.json'),
    rawLinkHistory: resolveSource(root, rescue?.sourceRawLinkHistory || ''),
    storesConfig: resolveSource(root, rescue?.sourceStoresConfig || 'config/stores.json'),
  };
  if (!sources.baseline) {
    return {ok: false, reason: 'low_et_revalidation_missing_source_price_overrides', sources, rows: []};
  }
  let documents;
  try {
    documents = await Promise.all([
      readJson(sources.linksData),
      readJson(sources.inventoryTrend),
      readJson(sources.baseline),
      readJson(sources.costMap),
      readJson(sources.pricingPolicy),
    ]);
  } catch (error) {
    return {ok: false, reason: `low_et_revalidation_source_read_failed:${error.message}`, sources, rows: []};
  }
  const [linksDataDoc, inventoryTrendDoc, baselineDoc, costDoc, marketingPolicy] = documents;
  let currentLinksDataDoc = linksDataDoc;
  let rawLinkOverlay = null;
  if (sources.rawLinkHistory) {
    let storesConfig;
    try {
      storesConfig = await readJson(sources.storesConfig);
    } catch (error) {
      return {
        ok: false,
        reason: `low_et_revalidation_stores_config_read_failed:${error.message}`,
        sources,
        rows: [],
      };
    }
    const storeKeys = [...new Set((storesConfig?.stores || [])
      .filter(store => store?.enabled !== false)
      .map(store => normalizeStoreKey(store?.storeKey || store?.key || store?.store))
      .filter(Boolean))].sort();
    const latestRawLinks = collectLatestRawMarketingLinkRows({
      historyDir: sources.rawLinkHistory,
      reportDate: reportDate || dateOnly(rescue?.createdAt) || '',
      storeKeys,
    });
    const coverage = assessLatestRawMarketingLinkCoverage({
      sourceFiles: latestRawLinks.sourceFiles,
      errors: latestRawLinks.errors,
      storeKeys,
    });
    if (!coverage.complete) {
      return {
        ok: false,
        reason: 'low_et_revalidation_raw_link_overlay_incomplete',
        sources,
        rawLinkOverlay: {
          ...coverage,
          sourceFiles: latestRawLinks.sourceFiles,
          errors: latestRawLinks.errors,
        },
        rows: [],
      };
    }
    const linkRowIndex = buildLinkRowIndexFromBi(linksDataDoc);
    const merged = mergeMarketingLinkRows(
      [...linkRowIndex.byLinkKey.values()],
      latestRawLinks.rows,
    );
    currentLinksDataDoc = {storeLinks: merged.rows};
    rawLinkOverlay = {
      ...coverage,
      sourceFileCount: latestRawLinks.sourceFiles.length,
      sourceFiles: latestRawLinks.sourceFiles,
      rawRowCount: merged.rawRowCount,
      addedRowCount: merged.addedRowCount,
      updatedRowCount: merged.updatedRowCount,
    };
  }
  const context = buildLowEtFastSellerPricingContext({
    inventoryTrendDoc,
    linksDataDoc: currentLinksDataDoc,
    baselineDoc,
    costDoc,
    marketingPolicy,
    reportDate: reportDate || dateOnly(rescue?.createdAt) || '',
  });
  const results = ordinaryRows.map(row => ({
    storeKey: row.storeKey,
    skc: row.skc,
    ...revalidateLowEtFastSellerPricePullback({row, context, costDoc, legacyReceiptCapability}),
  }));
  return {
    ok: results.every(result => result.ok),
    reason: results.every(result => result.ok) ? 'current' : 'low_et_price_pullback_evidence_or_price_drift',
    evidenceHash: context.evidenceHash,
    sources,
    rawLinkOverlay,
    rows: results,
  };
}

function buildInventoryByCanonical(rows, reportDate) {
  const byCanonical = new Map();
  for (const row of rows) {
    const canonical = canonicalFromRow(row);
    const key = canonicalKey(canonical);
    if (!key) continue;
    const matchedStatus = String(row?.inventory_match_status || row?.inventoryMatchStatus || '').trim();
    const matched = matchedStatus
      ? matchedStatus === 'matched'
      : row?.has_et_inventory === true || row?.hasEtInventory === true;
    const quantity = numberOrNull(
      row?.operational_sellable_qty
      ?? row?.operationalSellableQty
      ?? row?.current_sellable_quantity
      ?? row?.currentSellableQuantity
      ?? row?.et_estimated_available_qty,
    );
    const policy = String(row?.et_operational_stock_policy || row?.operationalStockPolicy || '');
    const snapshotDate = dateOnly(
      row?.operational_snapshot_date
      ?? row?.operationalSnapshotDate
      ?? (policy.includes('01_full_carton_exception') ? row?.et_box_snapshot_date : row?.et_store_snapshot_date)
      ?? row?.snapshotDate,
    );
    const currentDay = !reportDate || snapshotDate === reportDate;
    const entry = {
      canonical,
      matched: matched && currentDay,
      etOperationalSaleable: quantity,
      snapshotDate,
      source: row,
    };
    const previous = byCanonical.get(key);
    if (!previous || scoreInventory(entry) > scoreInventory(previous)) byCanonical.set(key, entry);
  }
  return byCanonical;
}

function buildSalesByCanonical(rows) {
  const byCanonical = new Map();
  const seen = new Set();
  for (const row of rows) {
    const canonical = canonicalFromRow(row);
    const key = canonicalKey(canonical);
    const linkKey = `${normalizeStoreKey(row?.store_key || row?.storeKey || row?.store)}::${String(row?.skc || row?.SKC || '').trim()}`;
    if (!key || seen.has(linkKey)) continue;
    seen.add(linkKey);
    const sales = numberOrNull(
      row?.c30_valid_sale_cnt
      ?? row?.c30ValidSaleCnt
      ?? row?.c30_sale_cnt
      ?? row?.c30SaleCnt,
    );
    if (!byCanonical.has(key)) byCanonical.set(key, {canonical, validSales30d: 0, rowCount: 0, missingRows: 0});
    const entry = byCanonical.get(key);
    entry.rowCount += 1;
    if (sales === null) entry.missingRows += 1;
    else entry.validSales30d += Math.max(0, sales);
  }
  for (const entry of byCanonical.values()) {
    if (entry.missingRows > 0) entry.validSales30d = null;
  }
  return byCanonical;
}

function buildBaselineIndexes(rows, costDoc) {
  const grouped = new Map();
  const byLink = new Map();
  for (const row of rows) {
    const canonical = canonicalFromRow(row);
    const key = canonicalKey(canonical);
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, {canonical, rows: []});
    grouped.get(key).rows.push(row);
    const storeKey = normalizeStoreKey(row?.storeKey || row?.store || row?.['店铺']);
    const skc = String(row?.skc || row?.SKC || '').trim();
    if (storeKey && skc) {
      const explicitlyOrdinary = positiveNumber(
        row?.ordinaryLinkApprovedPrice
        ?? row?.ordinaryApprovedPrice
        ?? row?.preExposureTargetPrice
        ?? row?.baseTargetPrice,
      );
      const isOrdinaryTier = row?.isTopExposureLink !== true
        && row?.newListingTopTreatment !== true
        && row?.lowEtFastSellerPricePullback?.applied !== true;
      const ordinaryApprovedPrice = explicitlyOrdinary
        ?? (isOrdinaryTier ? positiveNumber(row?.finalTargetPrice ?? row?.targetPrice) : null);
      const ordinaryTargetMargin = normalizedMargin(
        row?.ordinaryTargetMargin ?? row?.baseMargin ?? row?.targetMargin,
      );
      byLink.set(linkKey(storeKey, skc), {
        canonical,
        storeKey,
        skc,
        ordinaryApprovedPrice,
        ordinaryTargetMargin,
      });
    }
  }
  const output = new Map();
  for (const [key, group] of grouped.entries()) {
    const ordinaryRows = group.rows.filter(row => (
      row?.isTopExposureLink !== true
      && row?.newListingTopTreatment !== true
      && row?.lowEtFastSellerPricePullback?.applied !== true
    ));
    const candidates = ordinaryRows.length ? ordinaryRows : group.rows;
    const explicitOrdinaryPrices = group.rows.map(row => positiveNumber(
      row?.ordinaryLinkApprovedPrice
      ?? row?.ordinaryApprovedPrice
      ?? row?.preExposureTargetPrice
      ?? row?.baseTargetPrice,
    )).filter(value => value !== null);
    const ordinaryApprovedPrice = representativePrice(
      explicitOrdinaryPrices.length
        ? explicitOrdinaryPrices
        : candidates.map(row => positiveNumber(row?.finalTargetPrice ?? row?.targetPrice)).filter(value => value !== null),
    );
    const explicitMargin = representativePrice(group.rows
      .map(row => normalizedMargin(row?.ordinaryTargetMargin ?? row?.baseMargin ?? row?.targetMargin))
      .filter(value => value !== null));
    const productCost = findMarketingCostEvidence(costDoc, group.canonical).productUnitCostSar;
    const derivedMargin = productCost > 0 && ordinaryApprovedPrice > productCost
      ? round4(1 - productCost / ordinaryApprovedPrice)
      : null;
    output.set(key, {
      canonical: group.canonical,
      ordinaryApprovedPrice,
      ordinaryTargetMargin: explicitMargin ?? derivedMargin,
      rowCount: group.rows.length,
      ordinaryRowCount: ordinaryRows.length,
    });
  }
  return {byCanonical: output, byLink};
}

function uniqueLinkRows(doc) {
  const data = unwrapBiLinksData(doc);
  const rows = [
    ...(Array.isArray(data.storeLinks) ? data.storeLinks : []),
    ...(Array.isArray(data.links) ? data.links : []),
  ];
  const byKey = new Map();
  for (const row of rows) {
    const key = `${normalizeStoreKey(row?.store_key || row?.storeKey || row?.store)}::${String(row?.skc || row?.SKC || '').trim()}`;
    if (!key.endsWith('::')) byKey.set(key, row);
  }
  return [...byKey.values()];
}

function inventoryProducts(doc) {
  return doc?.products
    || doc?.inventoryDepletion?.products
    || doc?.data?.products
    || doc?.data?.inventoryDepletion?.products
    || [];
}

function exposureTopRows(index, canonical) {
  const key = canonicalKey(canonical);
  const rows = index?.rowsByGroup?.get(key) || [];
  return rows.slice(0, index?.topN || 5).map(row => ({
    storeKey: row.storeKey,
    skc: row.skc,
    rank: row.rank,
    score: row.score,
  }));
}

function mergePolicy(configured) {
  return {
    ...DEFAULT_LOW_ET_FAST_SELLER_POLICY,
    ...configured,
    criteria: {
      ...DEFAULT_LOW_ET_FAST_SELLER_POLICY.criteria,
      ...(configured?.criteria || {}),
    },
    pricingAction: {
      ...DEFAULT_LOW_ET_FAST_SELLER_POLICY.pricingAction,
      ...(configured?.pricingAction || {}),
    },
  };
}

function canonicalFromRow(row) {
  const direct = String(
    row?.canonical
    || row?.standard_goods_sn
    || row?.standardGoodsSn
    || row?.['标准货号']
    || '',
  ).trim();
  if (direct) return direct;
  const raw = row?.raw_goods_sn || row?.rawGoodsSn || row?.supplierNo || row?.sku_supplier_no || '';
  return normalizeGoodsSnDetailed(raw, {
    goodsTitle: row?.product_display_name || row?.product_name_cn || row?.goodsName || '',
  }).canonical || String(raw || '').trim();
}

function canonicalKey(value) {
  return String(value || '')
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function evidenceHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function canonicalContextEvidenceHash(canonical, context) {
  const key = canonicalKey(canonical);
  return evidenceHash({
    scope: CANONICAL_CONTEXT_SCOPE,
    canonicalKey: key,
    reportDate: context?.reportDate,
    policyEvidenceHash: context?.policyEvidenceHash,
    evidenceHash: context?.byCanonical?.get(key)?.evidenceHash ?? null,
  });
}

function scoreInventory(value) {
  return (value.matched ? 100 : 0)
    + (value.snapshotDate ? Number(value.snapshotDate.replaceAll('-', '')) || 0 : 0);
}

function normalizedMargin(value) {
  const number = numberOrNull(value);
  if (number === null) return null;
  return number > 1 ? number / 100 : number;
}

function representativePrice(values) {
  const numbers = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!numbers.length) return null;
  return round4(numbers[Math.floor((numbers.length - 1) / 2)]);
}

function positiveNumber(value) {
  const number = numberOrNull(value);
  return number !== null && number > 0 ? number : null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(String(value).replace(/[%SAR,\s]/g, ''));
  return Number.isFinite(number) ? number : null;
}

function normalizeStoreKey(value) {
  return String(value || '').trim().toUpperCase();
}

function linkKey(storeKey, skc) {
  return `${normalizeStoreKey(storeKey)}::${String(skc || '').trim()}`;
}

function priceRowKey(row) {
  const storeKey = normalizeStoreKey(row?.storeKey || row?.store || row?.['店铺']);
  const activityId = Number(row?.activityId || 0);
  const skc = String(row?.skc || row?.SKC || '').trim().toLowerCase();
  return `${storeKey}:${activityId}:${skc}`;
}

function dateOnly(value) {
  return String(value || '').match(/\d{4}-\d{2}-\d{2}/)?.[0] || '';
}

function resolveSource(root, value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return path.isAbsolute(text) ? text : path.resolve(root, text);
}

async function readJson(file) {
  return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function round4(value) {
  return Math.round((Number(value) + Number.EPSILON) * 10_000) / 10_000;
}
