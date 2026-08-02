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
assert.equal(hitMissingBaseline.reason, 'top5_missing_exact_link_ordinary_approved_price'); checks += 1;

const boundary10 = evaluateLowEtFastSellerCanonical(canonical, context({et: 10, sales: 31}));
assert.equal(boundary10.applies, true); checks += 1;
assert.equal(evaluateLowEtFastSellerCanonical(canonical, context({et: 11, sales: 31})).applies, false); checks += 1;
assert.equal(evaluateLowEtFastSellerCanonical(canonical, context({et: 10, sales: 30})).applies, false); checks += 1;
assert.equal(evaluateLowEtFastSellerCanonical(canonical, context({et: 10, sales: 31})).applies, true); checks += 1;

const top5 = applyLowEtFastSellerPricePullback({
  row: {...baseline.items[0], finalTargetPrice: 95, targetPrice: 95},
  context: context(),
  costDoc,
});
assert.equal(top5.applied, true); checks += 1;
assert.equal(top5.audit.mode, 'top5_restore_latest_approved_ordinary_link_price'); checks += 1;
assert.equal(top5.row.finalTargetPrice, 120); checks += 1;
const top5OtherStore = applyLowEtFastSellerPricePullback({
  row: {...baseline.items[1], finalTargetPrice: 96, targetPrice: 96},
  context: context(),
  costDoc,
});
assert.equal(top5OtherStore.applied, true); checks += 1;
assert.equal(top5OtherStore.row.finalTargetPrice, 125); checks += 1;
assert.notEqual(top5OtherStore.row.finalTargetPrice, top5.row.finalTargetPrice); checks += 1;
const missingExactLinkPrice = applyLowEtFastSellerPricePullback({
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
assert.equal(missingExactLinkPrice.applied, false); checks += 1;
assert.equal(missingExactLinkPrice.reason, 'top5_missing_exact_link_ordinary_approved_price'); checks += 1;

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

const revalidated = revalidateLowEtFastSellerPricePullback({
  row: ordinary.row,
  context: context(),
  costDoc,
});
assert.equal(revalidated.ok, true); checks += 1;
const changedLinkBaseline = {
  items: baseline.items.map((row, index) => index === 0
    ? {...row, ordinaryLinkApprovedPrice: 121}
    : row),
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
