#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  applyLowEtFastSellerPricePullback,
  buildLowEtFastSellerPricingContext,
  revalidateLowEtFastSellerRescueArtifact,
} from '../../lib/marketing_low_et_fast_seller_pricing.mjs';
import {loadMarketingPricingPolicy} from '../../lib/marketing_pricing_policy.mjs';
import {buildHighClickLowConversionSpecialAudit} from '../../lib/marketing_high_click_special_policy.mjs';
import {buildLimitedDiscountDriftRescuePlan} from './build_limited_discount_drift_rescue_plan.mjs';

const reportDate = '2026-08-02';
const canonical = 'SK-FAST';
const stores = ['DX', 'HL', 'LQ', 'TS', 'YJ', 'ZL'];
const baselineDoc = {
  items: stores.map((storeKey, index) => ({
    storeKey,
    skc: `link-${index + 1}`,
    canonical,
    finalTargetPrice: index < 5 ? 100 + index : 110,
    ordinaryLinkApprovedPrice: 120,
    ordinaryTargetMargin: 0.30,
    isTopExposureLink: index < 5,
  })),
};
const linksDataDoc = {
  storeLinks: stores.map((storeKey, index) => ({
    store_key: storeKey,
    skc: `link-${index + 1}`,
    standard_goods_sn: canonical,
    product_display_name: canonical,
    is_on_shelf: true,
    c7_eps_uv: 10_000 - index * 500,
    c7_goods_uv: index === 0 ? 500 : 10,
    c7_cart_uv: index === 0 ? 30 : 0,
    c7_sale_cnt: 0,
    c30_valid_sale_cnt: index === 0 ? 31 : 0,
  })),
};
const inventoryTrendDoc = {
  products: [{
    canonical,
    inventory_match_status: 'matched',
    operational_sellable_qty: 10,
    operational_snapshot_date: reportDate,
  }, {
    canonical: 'SK-OTHER',
    inventory_match_status: 'matched',
    operational_sellable_qty: 20,
    operational_snapshot_date: reportDate,
  }],
};
const costDoc = {
  costMap: {[canonical]: 70},
  trueCostMap: {[canonical]: {unitCostSar: 70, storageUnitCostSar: 8}},
};
const marketingPolicy = {
  targetFloorMarginPct: 15,
  topTreatmentCostFallback: {enabled: true, defaultBaseMarginPct: 30},
  exposureTopLinks: {topN: 5, marginDeltaPct: 5, floorMarginPct: 15},
  lowEtFastSellerPricePullback: {enabled: true},
  highClickLowConversionSpecial: {
    enabled: true,
    criteria: {
      c7ExposureMinExclusive: 3000,
      c7ClickRateMinExclusive: 0.04,
      c7SaleCountEquals: 0,
      onShelfOnly: true,
    },
    execution: {cartVisitorRouteAutoExecute: true},
    pricing: {top5MarginDeltaPct: 2, floorMarginPct: 15},
    limitedDiscount: {activityStock: 10, durationDays: 7},
  },
};
const context = buildLowEtFastSellerPricingContext({
  inventoryTrendDoc,
  linksDataDoc,
  baselineDoc,
  costDoc,
  marketingPolicy,
  reportDate,
});

let checks = 0;
const highClick = buildHighClickLowConversionSpecialAudit({
  linksDataDoc,
  inventoryTrendDoc,
  priceOverridesDoc: baselineDoc,
  costDoc,
  manualRegistry: {entries: []},
  marketingPolicy,
  reportDate,
  now: new Date('2026-08-02T04:00:00Z'),
  sourceLinksDataStatus: 'ok',
});
assert.equal(highClick.actionCount, 1); checks += 1;
assert.equal(highClick.rows[0].storeKey, 'DX'); checks += 1;
assert.equal(highClick.rows[0].lowEtFastSellerPricePullback.applied, true); checks += 1;
assert.equal(highClick.rows[0].specialPrice, 120); checks += 1;

const ordinaryHighClickLinks = {
  storeLinks: linksDataDoc.storeLinks.map((row, index) => ({
    ...row,
    c7_goods_uv: index === 5 ? 500 : 10,
    c7_cart_uv: 0,
  })),
};
const ordinaryHighClickBaseline = {
  items: baselineDoc.items.map((row, index) => ({
    ...row,
    ordinaryTargetMargin: index === 5 ? 0.42 : row.ordinaryTargetMargin,
  })),
};
const ordinaryHighClick = buildHighClickLowConversionSpecialAudit({
  linksDataDoc: ordinaryHighClickLinks,
  inventoryTrendDoc,
  priceOverridesDoc: ordinaryHighClickBaseline,
  costDoc,
  manualRegistry: {entries: []},
  marketingPolicy,
  reportDate,
  now: new Date('2026-08-02T04:00:00Z'),
  sourceLinksDataStatus: 'ok',
});
assert.equal(ordinaryHighClick.actionCount, 1); checks += 1;
assert.equal(ordinaryHighClick.rows[0].storeKey, 'ZL'); checks += 1;
assert.equal(ordinaryHighClick.rows[0].lowEtFastSellerPricePullback.mode, 'ordinary_link_target_margin_plus_5_points'); checks += 1;
assert.equal(ordinaryHighClick.rows[0].lowEtFastSellerPricePullback.ordinaryTargetMargin, 0.30); checks += 1;
assert.equal(ordinaryHighClick.rows[0].lowEtFastSellerPricePullback.targetMargin, 0.35); checks += 1;
assert.equal(ordinaryHighClick.rows[0].specialPrice, 107.7); checks += 1;

const protectedHighClick = buildHighClickLowConversionSpecialAudit({
  linksDataDoc,
  inventoryTrendDoc,
  priceOverridesDoc: baselineDoc,
  costDoc,
  manualRegistry: {
    entries: [{
      storeKey: 'DX',
      skc: 'link-1',
      canonical,
      specialPrice: 90,
      validFrom: '2026-08-01 00:00:00',
      validTo: '2026-08-08 23:59:59',
      activityStock: 10,
      status: 'active',
    }],
  },
  marketingPolicy,
  reportDate,
  now: new Date('2026-08-02T04:00:00Z'),
  sourceLinksDataStatus: 'ok',
});
assert.equal(protectedHighClick.actionCount, 0); checks += 1;
assert.equal(protectedHighClick.protectedCount, 1); checks += 1;

const drift = buildLimitedDiscountDriftRescuePlan({
  reportDate,
  limitedDiscountTargetPriceDrift: {
    belowRows: [{
      storeKey: 'DX',
      skc: 'link-1',
      canonical,
      finalTargetPrice: 100,
      limitedDiscountPrice: 90,
      limitedDiscountName: '旧活动',
      limitedDiscountEnd: '2026-08-04 23:59:59',
    }],
  },
}, {
  lowEtContext: context,
  costDoc,
  manualRegistry: {entries: []},
  now: new Date('2026-08-02T04:00:00Z'),
});
assert.equal(drift.totals.selected, 1); checks += 1;
assert.equal(drift.groups[0].rows[0].lowEtFastSellerPricePullback.applied, true); checks += 1;
assert.equal(drift.groups[0].rows[0].finalTargetPrice, 120); checks += 1;

const nonAppliedInventory = {
  products: inventoryTrendDoc.products.map(row => ({...row, operational_sellable_qty: 20})),
};
const nonAppliedContext = buildLowEtFastSellerPricingContext({
  inventoryTrendDoc: nonAppliedInventory, linksDataDoc, baselineDoc, costDoc, marketingPolicy, reportDate,
});
const realPolicyPath = path.resolve('config/marketing_pricing_policy.json');
const realRawPolicy = JSON.parse(await fs.readFile(realPolicyPath, 'utf8'));
const realLoadedPolicy = await loadMarketingPricingPolicy(realPolicyPath);
const realRawContext = buildLowEtFastSellerPricingContext({
  inventoryTrendDoc: nonAppliedInventory, linksDataDoc, baselineDoc, costDoc,
  marketingPolicy: realRawPolicy, reportDate,
});
const realLoadedContext = buildLowEtFastSellerPricingContext({
  inventoryTrendDoc: nonAppliedInventory, linksDataDoc, baselineDoc, costDoc,
  marketingPolicy: realLoadedPolicy, reportDate,
});
assert.equal(realRawContext.policyEvidenceHash, realLoadedContext.policyEvidenceHash); checks += 1;
const realPolicyRow = {storeKey: 'DX', skc: 'link-1', canonical, finalTargetPrice: 100, targetPrice: 100};
const realRawDecision = applyLowEtFastSellerPricePullback({row: realPolicyRow, context: realRawContext, costDoc});
const realLoadedDecision = applyLowEtFastSellerPricePullback({row: realPolicyRow, context: realLoadedContext, costDoc});
assert.equal(realRawDecision.audit.contextEvidenceHash, realLoadedDecision.audit.contextEvidenceHash); checks += 1;
const nonAppliedDrift = buildLimitedDiscountDriftRescuePlan({
  reportDate,
  limitedDiscountTargetPriceDrift: {belowRows: [{
    storeKey: 'DX', skc: 'link-1', canonical, finalTargetPrice: 100, limitedDiscountPrice: 90,
  }]},
}, {lowEtContext: nonAppliedContext, costDoc, manualRegistry: {entries: []}});
assert.equal(nonAppliedDrift.totals.selected, 1); checks += 1;
assert.equal(nonAppliedDrift.groups[0].rows[0].lowEtFastSellerPricePullback.applied, false); checks += 1;
assert.equal(nonAppliedDrift.groups[0].rows[0].lowEtFastSellerPricePullback.contextEvidenceScope, 'canonical-v2'); checks += 1;
const nonAppliedHighClick = buildHighClickLowConversionSpecialAudit({
  linksDataDoc, inventoryTrendDoc: nonAppliedInventory, priceOverridesDoc: baselineDoc,
  costDoc, manualRegistry: {entries: []}, marketingPolicy, reportDate,
  now: new Date('2026-08-02T04:00:00Z'), sourceLinksDataStatus: 'ok',
});
assert.equal(nonAppliedHighClick.actionCount, 1); checks += 1;
assert.equal(nonAppliedHighClick.rows[0].lowEtFastSellerPricePullback.applied, false); checks += 1;
assert.equal(nonAppliedHighClick.rows[0].lowEtFastSellerPricePullback.contextEvidenceScope, 'canonical-v2'); checks += 1;

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'low-et-rescue-'));
try {
  const sources = {
    linksData: path.join(temp, 'links.json'),
    inventoryTrend: path.join(temp, 'inventory.json'),
    baseline: path.join(temp, 'baseline.json'),
    costMap: path.join(temp, 'cost.json'),
    pricingPolicy: path.join(temp, 'policy.json'),
    rawLinkHistory: path.join(temp, 'raw-links'),
    storesConfig: path.join(temp, 'stores.json'),
  };
  await Promise.all(stores.map(async storeKey => {
    const storeDir = path.join(sources.rawLinkHistory, storeKey);
    await fs.mkdir(storeDir, {recursive: true});
    await fs.writeFile(path.join(storeDir, `${reportDate}.json`), JSON.stringify({
      ok: true,
      date: reportDate,
      fetchTime: `${reportDate} 10:00:00`,
      store: {storeKey},
      linkRows: [],
    }));
  }));
  await Promise.all([
    fs.writeFile(sources.linksData, JSON.stringify(linksDataDoc)),
    fs.writeFile(sources.inventoryTrend, JSON.stringify(inventoryTrendDoc)),
    fs.writeFile(sources.baseline, JSON.stringify(baselineDoc)),
    fs.writeFile(sources.costMap, JSON.stringify(costDoc)),
    fs.writeFile(sources.pricingPolicy, JSON.stringify(marketingPolicy)),
    fs.writeFile(sources.storesConfig, JSON.stringify({
      stores: stores.map(storeKey => ({storeKey, enabled: true})),
    })),
  ]);
  const rescue = {
    createdAt: `${reportDate}T00:00:00Z`,
    sourceLinksData: sources.linksData,
    sourceInventoryTrend: sources.inventoryTrend,
    sourcePriceOverrides: sources.baseline,
    sourceCostMap: sources.costMap,
    pricingPolicy: sources.pricingPolicy,
    sourceRawLinkHistory: sources.rawLinkHistory,
    sourceStoresConfig: sources.storesConfig,
    rows: drift.groups[0].rows,
  };
  const realPolicySource = path.join(temp, 'real-marketing-pricing-policy.json');
  const realInventorySource = path.join(temp, 'real-inventory.json');
  await Promise.all([
    fs.writeFile(realPolicySource, JSON.stringify(realRawPolicy)),
    fs.writeFile(realInventorySource, JSON.stringify(nonAppliedInventory)),
  ]);
  const realPolicyRescue = {
    ...rescue,
    sourceInventoryTrend: realInventorySource,
    pricingPolicy: realPolicySource,
    rows: [realLoadedDecision.row],
  };
  const normalizedPolicyCurrent = await revalidateLowEtFastSellerRescueArtifact({
    root: temp, rescue: realPolicyRescue, reportDate,
  });
  assert.equal(normalizedPolicyCurrent.ok, true); checks += 1;
  await fs.writeFile(realPolicySource, JSON.stringify({
    ...realRawPolicy,
    lowEtFastSellerPricePullback: {
      ...(realRawPolicy.lowEtFastSellerPricePullback || {}),
      criteria: {
        ...(realRawPolicy.lowEtFastSellerPricePullback?.criteria || {}),
        matchedEtOperationalSaleableMaxInclusive: 12,
      },
    },
  }));
  const realPolicyDrift = await revalidateLowEtFastSellerRescueArtifact({
    root: temp, rescue: realPolicyRescue, reportDate,
  });
  assert.equal(realPolicyDrift.ok, false); checks += 1;
  assert.equal(realPolicyDrift.rows[0].reason, 'low_et_price_pullback_context_evidence_drift'); checks += 1;
  const current = await revalidateLowEtFastSellerRescueArtifact({root: temp, rescue, reportDate});
  assert.equal(current.ok, true); checks += 1;
  assert.equal(current.rawLinkOverlay.complete, true); checks += 1;
  await fs.writeFile(sources.inventoryTrend, JSON.stringify({
    products: inventoryTrendDoc.products.map(row => row.canonical === 'SK-OTHER'
      ? {...row, operational_sellable_qty: 21} : row),
  }));
  const unrelatedDrift = await revalidateLowEtFastSellerRescueArtifact({root: temp, rescue, reportDate});
  assert.notEqual(unrelatedDrift.evidenceHash, current.evidenceHash); checks += 1;
  assert.equal(unrelatedDrift.ok, true); checks += 1;
  const legacyRescue = {...rescue, rows: rescue.rows.map(row => {
    const audit = {...row.lowEtFastSellerPricePullback, contextEvidenceHash: current.evidenceHash};
    delete audit.contextEvidenceScope;
    return {...row, lowEtFastSellerPricePullback: audit};
  })};
  const legacy = await revalidateLowEtFastSellerRescueArtifact({root: temp, rescue: legacyRescue, reportDate});
  assert.equal(legacy.ok, false); checks += 1;
  assert.equal(legacy.rows[0].reason, 'low_et_price_pullback_context_scope_requires_rebuild'); checks += 1;
  await fs.writeFile(sources.pricingPolicy, JSON.stringify({
    ...marketingPolicy,
    lowEtFastSellerPricePullback: {enabled: true, criteria: {matchedEtOperationalSaleableMaxInclusive: 12}},
  }));
  const policyDrift = await revalidateLowEtFastSellerRescueArtifact({root: temp, rescue, reportDate});
  assert.equal(policyDrift.ok, false); checks += 1;
  assert.equal(policyDrift.rows[0].reason, 'low_et_price_pullback_context_evidence_drift'); checks += 1;
  await fs.writeFile(sources.pricingPolicy, JSON.stringify(marketingPolicy));
  await fs.writeFile(sources.inventoryTrend, JSON.stringify({
    products: [{...inventoryTrendDoc.products[0], operational_sellable_qty: 11}],
  }));
  const stale = await revalidateLowEtFastSellerRescueArtifact({root: temp, rescue, reportDate});
  assert.equal(stale.ok, false); checks += 1;
  assert.equal(stale.rows[0].reason, 'low_et_price_pullback_context_evidence_drift'); checks += 1;
  const refreshedRescue = {...rescue, rows: nonAppliedDrift.groups[0].rows};
  for (const [targetEt, otherEt, expected] of [[20, 20, true], [20, 21, true], [21, 20, false], [10, 20, false]]) {
    await fs.writeFile(sources.inventoryTrend, JSON.stringify({
      products: inventoryTrendDoc.products.map(row => ({
        ...row, operational_sellable_qty: row.canonical === canonical ? targetEt : otherEt,
      })),
    }));
    const revalidated = await revalidateLowEtFastSellerRescueArtifact({root: temp, rescue: refreshedRescue, reportDate});
    assert.equal(revalidated.ok, expected, `non-applied rescue ET ${targetEt}/${otherEt}`); checks += 1;
    assert.notEqual(revalidated.rows[0].reason, 'low_et_price_pullback_context_scope_requires_rebuild'); checks += 1;
  }
} finally {
  await fs.rm(temp, {recursive: true, force: true});
}

const sourceFiles = [
  'scripts/marketing/dsy_marketing_deadline_fill.mjs',
  'scripts/marketing/build_new_listing_limited_discount_plan.mjs',
  'scripts/marketing/build_limited_discount_drift_rescue_plan.mjs',
  'scripts/marketing/batch_apply_high_click_special_discounts.mjs',
  'scripts/marketing/batch_apply_new_listing_limited_discount.mjs',
  'scripts/marketing/batch_fix_limited_discount_drift.mjs',
  'scripts/marketing/batch_restore_manual_limited_discounts.mjs',
];
for (const file of sourceFiles) {
  const text = await fs.readFile(path.resolve(file), 'utf8');
  assert.match(text, /LowEtFastSeller|lowEtFastSeller|low_et_/i, `${file} must integrate low ET pricing`);
  checks += 1;
}

const approvalBuilder = await fs.readFile(
  path.resolve('scripts/marketing/build_marketing_sku_approval.mjs'),
  'utf8',
);
assert.match(approvalBuilder, /selectionBlockedReasons:\s*retainedExcludeReasons/); checks += 1;
assert.match(approvalBuilder, /if \(!decision\.blocked && decision\.audit\)\s*\{\s*executionRows\[index\] = \{\.\.\.current, lowEtFastSellerPricePullback: decision\.audit\}/); checks += 1;
assert.doesNotMatch(
  approvalBuilder,
  /\.\.\.adjusted,\s*selected:\s*true,\s*excludeReason:\s*''/,
  'low ET repricing must not clear unrelated hard blockers',
); checks += 1;

console.log(JSON.stringify({
  ok: true,
  checks,
  ordinaryIntegrated: true,
  limitedPaths: ['manual_special', 'target_price_drift', 'new_listing_relisted_missing', 'high_click_special'],
  highClickPriceUsesLowEtPriority: highClick.rows[0].specialPrice,
  staleEvidenceBlocked: true,
}, null, 2));
