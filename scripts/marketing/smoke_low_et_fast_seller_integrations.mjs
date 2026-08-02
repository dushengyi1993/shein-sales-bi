#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildLowEtFastSellerPricingContext,
  revalidateLowEtFastSellerRescueArtifact,
} from '../../lib/marketing_low_et_fast_seller_pricing.mjs';
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
    ordinaryLinkApprovedPrice: 120 + index,
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

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'low-et-rescue-'));
try {
  const sources = {
    linksData: path.join(temp, 'links.json'),
    inventoryTrend: path.join(temp, 'inventory.json'),
    baseline: path.join(temp, 'baseline.json'),
    costMap: path.join(temp, 'cost.json'),
    pricingPolicy: path.join(temp, 'policy.json'),
  };
  await Promise.all([
    fs.writeFile(sources.linksData, JSON.stringify(linksDataDoc)),
    fs.writeFile(sources.inventoryTrend, JSON.stringify(inventoryTrendDoc)),
    fs.writeFile(sources.baseline, JSON.stringify(baselineDoc)),
    fs.writeFile(sources.costMap, JSON.stringify(costDoc)),
    fs.writeFile(sources.pricingPolicy, JSON.stringify(marketingPolicy)),
  ]);
  const rescue = {
    createdAt: `${reportDate}T00:00:00Z`,
    sourceLinksData: sources.linksData,
    sourceInventoryTrend: sources.inventoryTrend,
    sourcePriceOverrides: sources.baseline,
    sourceCostMap: sources.costMap,
    pricingPolicy: sources.pricingPolicy,
    rows: drift.groups[0].rows,
  };
  const current = await revalidateLowEtFastSellerRescueArtifact({root: temp, rescue, reportDate});
  assert.equal(current.ok, true); checks += 1;
  await fs.writeFile(sources.inventoryTrend, JSON.stringify({
    products: [{...inventoryTrendDoc.products[0], operational_sellable_qty: 11}],
  }));
  const stale = await revalidateLowEtFastSellerRescueArtifact({root: temp, rescue, reportDate});
  assert.equal(stale.ok, false); checks += 1;
  assert.equal(stale.rows[0].reason, 'low_et_price_pullback_context_evidence_drift'); checks += 1;
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

console.log(JSON.stringify({
  ok: true,
  checks,
  ordinaryIntegrated: true,
  limitedPaths: ['manual_special', 'target_price_drift', 'new_listing_relisted_missing', 'high_click_special'],
  highClickPriceUsesLowEtPriority: highClick.rows[0].specialPrice,
  staleEvidenceBlocked: true,
}, null, 2));
