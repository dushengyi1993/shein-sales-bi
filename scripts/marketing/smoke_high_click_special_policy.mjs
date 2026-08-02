#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  buildHighClickLowConversionSpecialAudit,
  buildHighClickSpecialEffectAudit,
  deriveHighClickSpecialPricing,
  evaluateHighClickLowConversionRow,
  getHighClickSpecialPolicy,
  revalidateHighClickSpecialCandidate,
} from '../../lib/marketing_high_click_special_policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureDir = path.join(root, 'tmp', `high-click-special-smoke-${process.pid}`);
const now = new Date('2026-07-26T08:00:00.000Z');
const marketingPolicy = {
  targetFloorMarginPct: 15,
  topTreatmentCostFallback: {enabled: true, defaultBaseMarginPct: 30},
  exposureTopLinks: {marginDeltaPct: 5, floorMarginPct: 15},
  highClickLowConversionSpecial: {
    enabled: true,
    criteria: {
      c7ExposureMinExclusive: 3000,
      c7ClickRateMinExclusive: 0.04,
      cartVisitorRouteEnabled: true,
      c7CartExposureMinInclusive: 3000,
      c7CartVisitorsMinInclusive: 20,
      c7SaleCountEquals: 0,
      onShelfOnly: true,
    },
    execution: {
      cartVisitorRouteAutoExecute: false,
      cartVisitorRouteApprovalStatus: 'pending_initial_user_confirmation',
    },
    pricing: {top5MarginDeltaPct: 2, floorMarginPct: 15},
    limitedDiscount: {activityStock: 10, durationDays: 7},
  },
};
const policy = getHighClickSpecialPolicy(marketingPolicy);
const priceOverridesDoc = {
  items: [{
    storeKey: 'DL',
    skc: 'top',
    canonical: 'SK-3378杆式吸尘器',
    finalTargetPrice: 143.3,
    isTopExposureLink: true,
  }],
};
const costDoc = {
  costMap: {'SK-3378杆式吸尘器': 101.7692},
  trueCostMap: {'SK-3378杆式吸尘器': {unitCostSar: 101.7692}},
};
const qualifying = {
  store_key: 'CX',
  skc: 'sv-qualified',
  standard_goods_sn: 'SK-3378杆式吸尘器',
  product_display_name: 'SK-3378杆式吸尘器',
  is_on_shelf: true,
  c7_eps_uv: 5000,
  c7_goods_uv: 250,
  c7_cart_uv: 5,
  c7_sale_cnt: 0,
  c30_valid_sale_cnt: 0,
};
const cartQualifying = {
  ...qualifying,
  skc: 'sv-cart-qualified',
  c7_eps_uv: 3000,
  c7_goods_uv: 30,
  c7_cart_uv: 20,
};
const inventoryTrendDoc = {
  products: [{
    canonical: 'SK-3378杆式吸尘器',
    inventory_match_status: 'matched',
    operational_sellable_qty: 11,
    operational_snapshot_date: '2026-07-26',
  }],
};

try {
  await fs.mkdir(fixtureDir, {recursive: true});
  assert.equal(evaluateHighClickLowConversionRow(qualifying, policy).qualifies, true);
  assert.equal(evaluateHighClickLowConversionRow({...qualifying, c7_eps_uv: 3000, c7_goods_uv: 150}, policy).qualifies, false, 'exposure threshold is strict >');
  assert.equal(evaluateHighClickLowConversionRow({...qualifying, c7_goods_uv: 200}, policy).qualifies, false, 'CTR threshold is strict >');
  assert.equal(evaluateHighClickLowConversionRow({...qualifying, c7_sale_cnt: undefined}, policy).qualifies, false, 'missing sales must not be treated as zero');
  assert.equal(evaluateHighClickLowConversionRow({...qualifying, c7_sale_cnt: 1}, policy).qualifies, false, 'a converted link is not eligible');
  assert.deepEqual(
    evaluateHighClickLowConversionRow(cartQualifying, policy).qualificationRoutes,
    ['cart_visitors'],
    'cart visitor route uses inclusive exposure and visitor thresholds',
  );
  assert.equal(
    evaluateHighClickLowConversionRow({...cartQualifying, c7_cart_uv: 19}, policy).qualifies,
    false,
    'cart visitor threshold is inclusive at 20',
  );
  assert.equal(
    evaluateHighClickLowConversionRow({...cartQualifying, c7_eps_uv: 2999}, policy).qualifies,
    false,
    'cart route exposure threshold is inclusive at 3000',
  );
  assert.equal(
    evaluateHighClickLowConversionRow({...qualifying, is_on_shelf: undefined, shelf_status_name: ''}, policy).qualifies,
    false,
    'missing on-shelf evidence must fail closed',
  );

  const pricing = deriveHighClickSpecialPricing({
    canonical: qualifying.standard_goods_sn,
    priceOverridesDoc,
    costDoc,
    marketingPolicy,
    highClickPolicy: policy,
  });
  assert.equal(pricing.available, true);
  assert.equal(pricing.top5Margin, 0.2898);
  assert.equal(pricing.specialMargin, 0.2698);
  assert.equal(pricing.specialPrice, 139.38);

  const emptyRegistry = {entries: []};
  const actionAudit = buildHighClickLowConversionSpecialAudit({
    linksDataDoc: {data: {links: [qualifying]}},
    inventoryTrendDoc,
    priceOverridesDoc,
    costDoc,
    manualRegistry: emptyRegistry,
    marketingPolicy,
    reportDate: '2026-07-26',
    now,
  });
  assert.equal(actionAudit.actionCount, 1);
  assert.equal(actionAudit.rows[0].specialPrice, 139.38);
  assert.equal(actionAudit.rows[0].activityStock, 10);
  assert.equal(actionAudit.rows[0].validTo, '2026-08-02 23:59:59');

  const cartPendingAudit = buildHighClickLowConversionSpecialAudit({
    linksDataDoc: {data: {links: [cartQualifying]}},
    inventoryTrendDoc,
    priceOverridesDoc,
    costDoc,
    manualRegistry: emptyRegistry,
    marketingPolicy,
    reportDate: '2026-07-26',
    now,
  });
  assert.equal(cartPendingAudit.actionCount, 0, 'unapproved first cart batch must not enter the execution queue');
  assert.equal(cartPendingAudit.pendingApprovalCount, 1);
  assert.equal(cartPendingAudit.pendingApprovalRows[0].specialPrice, 139.38);

  const cartApprovedAudit = buildHighClickLowConversionSpecialAudit({
    linksDataDoc: {data: {links: [cartQualifying]}},
    inventoryTrendDoc,
    priceOverridesDoc,
    costDoc,
    manualRegistry: emptyRegistry,
    marketingPolicy: {
      ...marketingPolicy,
      highClickLowConversionSpecial: {
        ...marketingPolicy.highClickLowConversionSpecial,
        execution: {cartVisitorRouteAutoExecute: true, cartVisitorRouteApprovalStatus: 'approved'},
      },
    },
    reportDate: '2026-07-26',
    now,
  });
  assert.equal(cartApprovedAudit.actionCount, 1, 'approved cart route enters the normal protected execution path');
  assert.equal(cartApprovedAudit.pendingApprovalCount, 0);

  const activeRegistry = {
    entries: [{
      storeKey: 'CX',
      skc: 'sv-qualified',
      canonical: qualifying.standard_goods_sn,
      specialPrice: 137.25,
      validFrom: '2026-07-25 00:00:00',
      validTo: '2026-07-30 23:59:59',
      activityStock: 10,
      reason: 'user_high_click_special',
      sourceThreadId: 'thread',
      sourceArtifact: 'artifact.json',
      currentActivityId: 123,
      status: 'active',
    }],
  };
  const protectedAudit = buildHighClickLowConversionSpecialAudit({
    linksDataDoc: {data: {links: [qualifying]}},
    inventoryTrendDoc,
    priceOverridesDoc,
    costDoc,
    manualRegistry: activeRegistry,
    marketingPolicy,
    reportDate: '2026-07-26',
    now,
  });
  assert.equal(protectedAudit.actionCount, 0);
  assert.equal(protectedAudit.protectedCount, 1);

  const expiredRegistry = {
    entries: [{...activeRegistry.entries[0], validTo: '2026-07-25 23:59:59'}],
  };
  const renewedAudit = buildHighClickLowConversionSpecialAudit({
    linksDataDoc: {data: {links: [qualifying]}},
    inventoryTrendDoc,
    priceOverridesDoc,
    costDoc,
    manualRegistry: expiredRegistry,
    marketingPolicy,
    reportDate: '2026-07-26',
    now,
  });
  assert.equal(renewedAudit.actionCount, 1);
  assert.equal(renewedAudit.rows[0].replacesExpiredRegistryEntry, true);

  const stale = revalidateHighClickSpecialCandidate(actionAudit.rows[0], {...qualifying, c7_sale_cnt: 1}, policy);
  assert.equal(stale.ok, false, 'stale plans cannot enroll a link that has already converted');

  const artifactPath = path.join(fixtureDir, 'baseline.json');
  await fs.writeFile(artifactPath, `${JSON.stringify({
    createdAt: '2026-07-22 15:05:00',
    rows: [{
      storeKey: 'CX',
      skc: 'sv-qualified',
      c7Exposure: 5000,
      c7ClickRate: 0.05,
      c7SaleCount: 0,
    }],
  })}\n`);
  const effectRegistry = {
    entries: [{
      ...activeRegistry.entries[0],
      sourceArtifact: path.relative(root, artifactPath).replaceAll(path.sep, '/'),
      reason: 'automated_high_click_zero_sales_top5_minus_2_margin_points',
    }],
  };
  const effects = buildHighClickSpecialEffectAudit({
    linksDataDoc: {data: {links: [{...qualifying, c7_eps_uv: 5200, c7_goods_uv: 260, c7_sale_cnt: 2}]}},
    manualRegistry: effectRegistry,
    root,
    now,
    policy,
  });
  assert.equal(effects.total, 1);
  assert.equal(effects.convertedCount, 1);
  assert.equal(effects.rows[0].baseline.c7SaleCount, 0);
  assert.equal(effects.rows[0].current.c7SaleCount, 2);

  console.log(JSON.stringify({
    ok: true,
    strictCriteria: true,
    cartVisitorRoutePendingApproval: true,
    missingSalesNotZero: true,
    missingShelfEvidenceFailsClosed: true,
    exactSpecialPrice: 139.38,
    activeProtectionWins: true,
    expiredProtectionRequalifies: true,
    stalePlanCannotEnrollConvertedLink: true,
    effectTracking: true,
  }));
} finally {
  await fs.rm(fixtureDir, {recursive: true, force: true});
}
