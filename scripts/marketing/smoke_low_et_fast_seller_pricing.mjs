#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  applyLowEtFastSellerPricePullback,
  buildLowEtFastSellerPricingContext,
  evaluateLowEtFastSellerCanonical,
  revalidateLowEtFastSellerPricePullback,
} from '../../lib/marketing_low_et_fast_seller_pricing.mjs';

const reportDate = '2026-08-02';
const canonical = 'SK-FAST';
const baseline = {
  items: [
    {storeKey: 'DX', skc: 'top-1', canonical, finalTargetPrice: 100, ordinaryLinkApprovedPrice: 120, ordinaryTargetMargin: 0.30},
    {storeKey: 'HL', skc: 'top-2', canonical, finalTargetPrice: 101, ordinaryLinkApprovedPrice: 125, ordinaryTargetMargin: 0.30},
    {storeKey: 'LQ', skc: 'top-3', canonical, finalTargetPrice: 102, ordinaryLinkApprovedPrice: 120, ordinaryTargetMargin: 0.30},
    {storeKey: 'TS', skc: 'top-4', canonical, finalTargetPrice: 103, ordinaryLinkApprovedPrice: 120, ordinaryTargetMargin: 0.30},
    {storeKey: 'YJ', skc: 'top-5', canonical, finalTargetPrice: 104, ordinaryLinkApprovedPrice: 120, ordinaryTargetMargin: 0.30},
    {storeKey: 'ZL', skc: 'normal-1', canonical, finalTargetPrice: 110, ordinaryLinkApprovedPrice: 120, ordinaryTargetMargin: 0.30},
  ],
};
const costDoc = {
  costMap: {
    [canonical]: 70,
  },
  trueCostMap: {
    [canonical]: {
      unitCostSar: 70,
      storageUnitCostSar: 8,
    },
  },
};

function inventory(quantity) {
  return {
    products: [{
      canonical,
      inventory_match_status: 'matched',
      operational_sellable_qty: quantity,
      operational_snapshot_date: reportDate,
    }],
  };
}

function links(totalSales = 31) {
  return {
    storeLinks: baseline.items.map((row, index) => ({
      store_key: row.storeKey,
      skc: row.skc,
      standard_goods_sn: canonical,
      c7_eps_uv: 10_000 - index * 500,
      c30_valid_sale_cnt: index === 0 ? totalSales : 0,
    })),
  };
}

function context({et = 10, sales = 31} = {}) {
  return buildLowEtFastSellerPricingContext({
    inventoryTrendDoc: inventory(et),
    linksDataDoc: links(sales),
    baselineDoc: baseline,
    costDoc,
    reportDate,
  });
}

let checks = 0;
const baselineBefore = JSON.stringify(baseline);
function missingBaselineDecision({et, sales}) {
  const missingContext = buildLowEtFastSellerPricingContext({
    inventoryTrendDoc: inventory(et),
    linksDataDoc: links(sales),
    baselineDoc: {items: []},
    costDoc,
    reportDate,
  });
  return applyLowEtFastSellerPricePullback({
    row: {
      storeKey: 'DX',
      skc: 'top-1',
      canonical,
      finalTargetPrice: 95,
      targetPrice: 95,
    },
    context: missingContext,
    costDoc,
  });
}
const et11MissingBaseline = missingBaselineDecision({et: 11, sales: 31});
assert.equal(et11MissingBaseline.applied, false); checks += 1;
assert.equal(et11MissingBaseline.blocked, false); checks += 1;
const sales30MissingBaseline = missingBaselineDecision({et: 10, sales: 30});
assert.equal(sales30MissingBaseline.applied, false); checks += 1;
assert.equal(sales30MissingBaseline.blocked, false); checks += 1;
const hitMissingBaseline = missingBaselineDecision({et: 10, sales: 31});
assert.equal(hitMissingBaseline.applied, false); checks += 1;
assert.equal(hitMissingBaseline.blocked, true); checks += 1;
assert.equal(hitMissingBaseline.reason, 'top5_missing_canonical_ordinary_approved_price'); checks += 1;

const boundary10 = evaluateLowEtFastSellerCanonical(canonical, context({et: 10, sales: 31}));
assert.equal(boundary10.applies, true); checks += 1;
assert.equal(evaluateLowEtFastSellerCanonical(canonical, context({et: 11, sales: 31})).applies, false); checks += 1;
assert.equal(evaluateLowEtFastSellerCanonical(canonical, context({et: 10, sales: 30})).applies, false); checks += 1;
assert.equal(evaluateLowEtFastSellerCanonical(canonical, context({et: 10, sales: 31})).applies, true); checks += 1;
const descriptorCanonical = `${canonical}产品`;
const descriptorContext = buildLowEtFastSellerPricingContext({
  inventoryTrendDoc: {
    products: [{
      canonical,
      inventory_match_status: 'matched',
      operational_sellable_qty: 10,
      operational_snapshot_date: reportDate,
    }],
  },
  linksDataDoc: {
    storeLinks: links(31).storeLinks.map(row => ({...row, standard_goods_sn: descriptorCanonical})),
  },
  baselineDoc: {
    items: baseline.items.map(row => ({...row, canonical: descriptorCanonical})),
  },
  costDoc: {
    costMap: {[descriptorCanonical]: 70},
    trueCostMap: {[descriptorCanonical]: {unitCostSar: 70, storageUnitCostSar: 8}},
  },
  reportDate,
});
assert.equal(evaluateLowEtFastSellerCanonical(descriptorCanonical, descriptorContext).applies, true); checks += 1;

const top5 = applyLowEtFastSellerPricePullback({
  row: {...baseline.items[0], finalTargetPrice: 95, targetPrice: 95},
  context: context(),
  costDoc,
});
assert.equal(top5.applied, true); checks += 1;
assert.equal(top5.audit.mode, 'top5_restore_latest_approved_canonical_ordinary_price'); checks += 1;
assert.equal(top5.row.finalTargetPrice, 120); checks += 1;
const top5OtherStore = applyLowEtFastSellerPricePullback({
  row: {...baseline.items[1], finalTargetPrice: 96, targetPrice: 96},
  context: context(),
  costDoc,
});
assert.equal(top5OtherStore.applied, true); checks += 1;
assert.equal(top5OtherStore.row.finalTargetPrice, 120); checks += 1;
assert.equal(top5OtherStore.row.finalTargetPrice, top5.row.finalTargetPrice); checks += 1;
const missingExactLinkPriceUsesCanonicalPrice = applyLowEtFastSellerPricePullback({
  row: {
    ...baseline.items[1],
    ordinaryLinkApprovedPrice: null,
    ordinaryApprovedPrice: null,
    preExposureTargetPrice: null,
    baseTargetPrice: null,
    finalTargetPrice: 96,
    targetPrice: 96,
  },
  context: buildLowEtFastSellerPricingContext({
    inventoryTrendDoc: inventory(10),
    linksDataDoc: links(31),
    baselineDoc: {
      items: baseline.items.map((row, index) => index === 1
        ? {...row, ordinaryLinkApprovedPrice: null, isTopExposureLink: true}
        : row),
    },
    costDoc,
    reportDate,
  }),
  costDoc,
});
assert.equal(missingExactLinkPriceUsesCanonicalPrice.applied, true); checks += 1;
assert.equal(missingExactLinkPriceUsesCanonicalPrice.row.finalTargetPrice, 120); checks += 1;

const ordinary = applyLowEtFastSellerPricePullback({
  row: {...baseline.items[5], finalTargetPrice: 95, targetPrice: 95},
  context: context(),
  costDoc,
});
assert.equal(ordinary.applied, true); checks += 1;
assert.equal(ordinary.audit.mode, 'ordinary_link_target_margin_plus_5_points'); checks += 1;
assert.equal(ordinary.audit.targetMargin, 0.35); checks += 1;
assert.equal(ordinary.row.finalTargetPrice, 107.7); checks += 1;

const clipped = applyLowEtFastSellerPricePullback({
  row: {...baseline.items[5], finalTargetPrice: 95, targetPrice: 95, platformMaxAllowedSignupPrice: 105},
  context: context(),
  costDoc,
});
assert.equal(clipped.applied, true); checks += 1;
assert.equal(clipped.audit.platformClipped, true); checks += 1;
assert.equal(clipped.row.finalTargetPrice, 105); checks += 1;

const manual = applyLowEtFastSellerPricePullback({
  row: {...baseline.items[5], manualSpecialLimitedDiscount: true},
  context: context(),
  costDoc,
  manualSpecial: true,
});
assert.equal(manual.applied, false); checks += 1;
assert.equal(manual.manualReview, true); checks += 1;
assert.equal(manual.reason, 'active_manual_special_requires_user_review'); checks += 1;

const explicitCurrentPrice = applyLowEtFastSellerPricePullback({
  row: {
    ...baseline.items[5],
    activityId: 45589,
    targetPrice: 72,
    finalTargetPrice: 72,
    userExplicitCurrentPriceOverride: true,
  },
  context: context(),
  costDoc,
  currentLockedPriceKeys: new Set(['ZL:45589:normal-1']),
});
assert.equal(explicitCurrentPrice.applied, false); checks += 1;
assert.equal(explicitCurrentPrice.blocked, false); checks += 1;
assert.equal(explicitCurrentPrice.reason, 'user_explicit_current_price_override'); checks += 1;
assert.equal(explicitCurrentPrice.row.finalTargetPrice, 72); checks += 1;

const historicalDirtyMarker = applyLowEtFastSellerPricePullback({
  row: {
    ...baseline.items[5],
    activityId: 45589,
    targetPrice: 95,
    finalTargetPrice: 95,
    userExplicitCurrentPriceOverride: true,
  },
  context: context(),
  costDoc,
});
assert.equal(historicalDirtyMarker.applied, true); checks += 1;
assert.equal(historicalDirtyMarker.row.finalTargetPrice, 107.7); checks += 1;

const explicitPriceMismatch = applyLowEtFastSellerPricePullback({
  row: {
    ...baseline.items[5],
    activityId: 45589,
    targetPrice: 72,
    finalTargetPrice: 80,
    userExplicitCurrentPriceOverride: true,
  },
  context: context(),
  costDoc,
  currentLockedPriceKeys: new Set(['ZL:45589:normal-1']),
});
assert.equal(explicitPriceMismatch.applied, false); checks += 1;
assert.equal(explicitPriceMismatch.blocked, true); checks += 1;
assert.equal(explicitPriceMismatch.reason, 'user_explicit_current_price_override_invalid_target'); checks += 1;

const revalidated = revalidateLowEtFastSellerPricePullback({
  row: ordinary.row,
  context: context(),
  costDoc,
});
assert.equal(revalidated.ok, true); checks += 1;
const changedLinkBaseline = {
  items: baseline.items.map(row => ({...row, ordinaryLinkApprovedPrice: 121})),
};
const changedBaselineContext = buildLowEtFastSellerPricingContext({
  inventoryTrendDoc: inventory(10),
  linksDataDoc: links(31),
  baselineDoc: changedLinkBaseline,
  costDoc,
  reportDate,
});
const baselineDrifted = revalidateLowEtFastSellerPricePullback({
  row: top5.row,
  context: changedBaselineContext,
  costDoc,
});
assert.equal(baselineDrifted.ok, false); checks += 1;
assert.equal(baselineDrifted.reason, 'low_et_price_pullback_context_evidence_drift'); checks += 1;
assert.equal(baselineDrifted.current.row.finalTargetPrice, 121); checks += 1;
const drifted = revalidateLowEtFastSellerPricePullback({
  row: ordinary.row,
  context: context({et: 11}),
  costDoc,
});
assert.equal(drifted.ok, false); checks += 1;
assert.equal(drifted.reason, 'low_et_price_pullback_context_evidence_drift'); checks += 1;

// A second canonical must not become part of this row's execution lock.
function scopedContext({otherEt = 20, targetEt = 10, ...overrides} = {}) {
  return buildLowEtFastSellerPricingContext({
    inventoryTrendDoc: {
      products: [...inventory(targetEt).products, {
        canonical: 'SK-OTHER',
        inventory_match_status: 'matched',
        operational_sellable_qty: otherEt,
        operational_snapshot_date: reportDate,
      }],
    },
    linksDataDoc: links(),
    baselineDoc: baseline,
    costDoc,
    reportDate,
    ...overrides,
  });
}
const scopedBefore = scopedContext();
const scopedAfter = scopedContext({otherEt: 21});
const scopedPlan = applyLowEtFastSellerPricePullback({row: baseline.items[0], context: scopedBefore, costDoc});
const nonAppliedContext = scopedContext({targetEt: 20});
const nonAppliedPlan = applyLowEtFastSellerPricePullback({row: baseline.items[0], context: nonAppliedContext, costDoc});
assert.equal(nonAppliedPlan.applied, false); checks += 1;
assert.equal(nonAppliedPlan.audit.contextEvidenceScope, 'canonical-v2'); checks += 1;
for (const [options, expected] of [
  [{targetEt: 20}, true],
  [{targetEt: 20, otherEt: 21}, true],
  [{targetEt: 21}, false],
  [{targetEt: 10}, false],
]) {
  assert.equal(revalidateLowEtFastSellerPricePullback({
    row: nonAppliedPlan.row, context: scopedContext(options), costDoc,
  }).ok, expected, JSON.stringify(options)); checks += 1;
}
const refreshedOldApplied = applyLowEtFastSellerPricePullback({
  row: scopedPlan.row, context: nonAppliedContext, costDoc,
});
assert.equal(refreshedOldApplied.row.lowEtFastSellerPricePullback.applied, false); checks += 1;
assert.equal(revalidateLowEtFastSellerPricePullback({
  row: refreshedOldApplied.row, context: nonAppliedContext, costDoc,
}).ok, true); checks += 1;
const unannotated = {...nonAppliedPlan.row};
delete unannotated.lowEtFastSellerPricePullback;
assert.equal(revalidateLowEtFastSellerPricePullback({row: unannotated, context: nonAppliedContext, costDoc}).reason,
  'low_et_price_pullback_context_scope_requires_rebuild'); checks += 1;
assert.equal(revalidateLowEtFastSellerPricePullback({
  row: explicitCurrentPrice.row, context: scopedContext({targetEt: 21}), costDoc,
  currentLockedPriceKeys: new Set(['ZL:45589:normal-1']),
}).ok, true); checks += 1;
assert.equal(revalidateLowEtFastSellerPricePullback({
  row: explicitCurrentPrice.row, context: scopedBefore, costDoc,
}).ok, false); checks += 1;
const refreshedHistorical = applyLowEtFastSellerPricePullback({
  row: explicitCurrentPrice.row, context: scopedBefore, costDoc,
});
assert.equal(refreshedHistorical.applied, true); checks += 1;
assert.equal(refreshedHistorical.audit.contextEvidenceScope, 'canonical-v2'); checks += 1;
assert.notEqual(scopedBefore.evidenceHash, scopedAfter.evidenceHash); checks += 1;
assert.equal(scopedPlan.audit.contextEvidenceScope, 'canonical-v2'); checks += 1;
assert.equal(revalidateLowEtFastSellerPricePullback({row: scopedPlan.row, context: scopedAfter, costDoc}).ok, true); checks += 1;
const changedExposure = links();
changedExposure.storeLinks[0].c7_eps_uv += 1;
const missingSales = links();
delete missingSales.storeLinks[0].c30_valid_sale_cnt;
for (const [label, changedContext] of [
  ['target ET 10 to 11', scopedContext({targetEt: 11})],
  ['target ET within threshold', scopedContext({targetEt: 9})],
  ['target sales', scopedContext({linksDataDoc: links(32)})],
  ['target exposure', scopedContext({linksDataDoc: changedExposure})],
  ['target baseline', scopedContext({baselineDoc: changedLinkBaseline})],
  ['target cost', scopedContext({costDoc: {
    costMap: {[canonical]: 71},
    trueCostMap: {[canonical]: {unitCostSar: 71, storageUnitCostSar: 8}},
  }})],
  ['missing inventory', scopedContext({inventoryTrendDoc: {products: []}})],
  ['missing sales', scopedContext({linksDataDoc: missingSales})],
  ['missing baseline', scopedContext({baselineDoc: {items: []}})],
  ['stale inventory date', scopedContext({reportDate: '2026-08-03'})],
  ['policy without price change', scopedContext({marketingPolicy: {
    lowEtFastSellerPricePullback: {criteria: {matchedEtOperationalSaleableMaxInclusive: 12}},
  }})],
  ['disabled policy', scopedContext({marketingPolicy: {lowEtFastSellerPricePullback: {enabled: false}}})],
  ['exposure policy without rank change', scopedContext({marketingPolicy: {exposureTopLinks: {onShelfOnly: false}}})],
]) {
  assert.equal(revalidateLowEtFastSellerPricePullback({row: scopedPlan.row, context: changedContext, costDoc}).ok, false, label);
  checks += 1;
}
const missingPolicyContext = {...scopedBefore};
delete missingPolicyContext.policyEvidenceHash;
assert.equal(revalidateLowEtFastSellerPricePullback({row: scopedPlan.row, context: missingPolicyContext, costDoc}).ok, false); checks += 1;
const changedPriceRow = {...scopedPlan.row, finalTargetPrice: 121};
assert.equal(revalidateLowEtFastSellerPricePullback({row: changedPriceRow, context: scopedBefore, costDoc}).reason,
  'low_et_price_pullback_target_price_drift'); checks += 1;
for (const [scope, hash, expectedReason] of [
  [undefined, scopedBefore.evidenceHash, 'low_et_price_pullback_context_scope_requires_rebuild'],
  [undefined, undefined, 'low_et_price_pullback_context_scope_requires_rebuild'],
  ['canonical-v99', scopedPlan.audit.contextEvidenceHash, 'low_et_price_pullback_context_scope_requires_rebuild'],
  ['canonical-v2', undefined, 'low_et_price_pullback_context_evidence_drift'],
]) {
  const artifactRow = {...scopedPlan.row, lowEtFastSellerPricePullback: {
    ...scopedPlan.audit, contextEvidenceScope: scope, contextEvidenceHash: hash,
  }};
  const artifactBefore = JSON.stringify(artifactRow);
  const result = revalidateLowEtFastSellerPricePullback({row: artifactRow, context: scopedBefore, costDoc});
  assert.equal(result.ok, false); checks += 1;
  assert.equal(result.reason, expectedReason); checks += 1;
  assert.equal(JSON.stringify(artifactRow), artifactBefore); checks += 1;
}
assert.equal(JSON.stringify(baseline), baselineBefore); checks += 1;

console.log(JSON.stringify({
  ok: true,
  checks,
  boundaries: {et10: true, et11: false, sales30: false, sales31: true},
  top5Price: top5.row.finalTargetPrice,
  top5OtherStorePrice: top5OtherStore.row.finalTargetPrice,
  ordinaryPrice: ordinary.row.finalTargetPrice,
  clippedPrice: clipped.row.finalTargetPrice,
  baselineUnchanged: true,
}, null, 2));
