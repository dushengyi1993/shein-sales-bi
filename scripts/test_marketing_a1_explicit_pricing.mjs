import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import cp from 'node:child_process';
import os from 'node:os';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-a1-builder-'));
const dateTag = '2026-09-05';

// 1. Prepare minimal fixtures with standard catalog SKU 'SK-13065吸尘器'
const reportPath = path.join(tmpDir, 'marketing-stack-review-' + dateTag + '.json');
const biPath = path.join(tmpDir, 'cloud-bi-portal-data-' + dateTag + '.json');
const costPath = path.join(tmpDir, 'cloud-marketing-cost-map-' + dateTag + '.json');
const remarksPath = path.join(tmpDir, 'user-remarks.json');
const baselinePath = path.join(tmpDir, 'baseline-overrides.json');
const outDir = path.join(tmpDir, 'outputs');
await fs.mkdir(outDir, {recursive: true});

// Activities: 2 stores (FY, DL) for SKU 'SK-13065吸尘器'
// FY current price 40, platform min discount 25% -> platform cap is 30 SAR!
// User specifies FY 37 SAR. Baseline was 45 SAR (not 37).
// Platform cap is 30 SAR, but A1 requires preserving user instruction 37 SAR!
//
// DL has KNOWN cost (productUnitCost: 60 SAR), current price 80 SAR, target price 65 SAR -> margin is (65 - 60)/65 = 7.7% < 15% (below floor).
// DL must NOT be exempted by FY's explicit price! DL must be excluded by row_full_cost_including_storage_margin_below_floor.
const activityDoc = {
  detailRows: [
    {
      '活动ID': 1001,
      '店铺': 'FY',
      'SKC': 'skc-fy-1',
      '标准货号': 'SK-13065吸尘器',
      '供方货号': 'SK-13065吸尘器',
      '当前售价SAR': 40,
      '平台最低降幅%': 25,
      '本次建议普通活动价SAR': 30,
      _cloudCost: { productUnitCostSar: null, storageUnitCostSar: null, fullUnitCostSar: null },
    },
    {
      '活动ID': 1001,
      '店铺': 'DL',
      'SKC': 'skc-dl-1',
      '标准货号': 'SK-13065吸尘器',
      '供方货号': 'SK-13065吸尘器',
      '当前售价SAR': 80,
      '平台最低降幅%': 10,
      '本次建议普通活动价SAR': 65,
      _cloudCost: { productUnitCostSar: 60, storageUnitCostSar: 0, fullUnitCostSar: 60 },
    },
  ],
};

const biDoc = {
  storeLinks: [
    { storeKey: 'FY', skc: 'skc-fy-1', standard_goods_sn: 'SK-13065吸尘器', c7_eps_uv: 50, is_on_shelf: true },
    { storeKey: 'DL', skc: 'skc-dl-1', standard_goods_sn: 'SK-13065吸尘器', c7_eps_uv: 20, is_on_shelf: true },
  ],
};

const costDoc = {
  trueCostMap: {
    'SK-13065吸尘器': { productUnitCostSar: 60, storageUnitCostSar: 0, fullUnitCostSar: 60 },
  },
  costMap: {
    'SK-13065吸尘器': { productUnitCostSar: 60, storageUnitCostSar: 0, fullUnitCostSar: 60 },
  },
};

// User remark explicitly states 'FY 37 SAR' for standard SKU 'SK-13065吸尘器'
const remarksDoc = {
  rows: [
    { canonical: 'SK-13065吸尘器', remark: 'FY 37 SAR' },
  ],
};

// Baseline originally had FY at 45 (not 37) and DL at 65
const baselineDoc = {
  baselineForNextOrdinaryActivity: true,
  items: [
    { canonical: 'SK-13065吸尘器', storeKey: 'FY', targetPrice: 45, finalTargetPrice: 45, isTopExposureLink: true },
    { canonical: 'SK-13065吸尘器', storeKey: 'DL', targetPrice: 65, finalTargetPrice: 65, isTopExposureLink: false },
  ],
};

await fs.writeFile(reportPath, JSON.stringify(activityDoc, null, 2), 'utf8');
await fs.writeFile(biPath, JSON.stringify(biDoc, null, 2), 'utf8');
await fs.writeFile(costPath, JSON.stringify(costDoc, null, 2), 'utf8');
await fs.writeFile(remarksPath, JSON.stringify(remarksDoc, null, 2), 'utf8');
await fs.writeFile(baselinePath, JSON.stringify(baselineDoc, null, 2), 'utf8');

// 2. Run the actual builder script
const args = [
  'scripts/marketing/build_marketing_sku_approval.mjs',
  '--date', dateTag,
  '--report', reportPath,
  '--bi', biPath,
  '--cost', costPath,
  '--baseline-price-overrides', baselinePath,
  '--baseline-user-remarks', remarksPath,
  '--output-dir', outDir,
  '--execution-output-dir', path.join(outDir, 'exec'),
];

cp.execFileSync(process.execPath, args, { encoding: 'utf8' });

// 3. Inspect generated execution payload
const overridesFile = path.join(outDir, 'exec', 'price-overrides-' + dateTag + '-v7-all-safe.json');
const selectionFile = path.join(outDir, 'exec', 'selection-plan-' + dateTag + '-v7-all-safe.json');

assert.ok(await fs.stat(overridesFile).catch(() => false), 'price-overrides file must exist');
assert.ok(await fs.stat(selectionFile).catch(() => false), 'selection-plan file must exist');

const overrides = JSON.parse(await fs.readFile(overridesFile, 'utf8'));
const selection = JSON.parse(await fs.readFile(selectionFile, 'utf8'));

const fyPriceItem = overrides.items.find(i => i.storeKey === 'FY');
const dlPriceItem = overrides.items.find(i => i.storeKey === 'DL');
const dlExcluded = overrides.excluded.find(i => i.storeKey === 'DL');

// A1 Verification 1: FY price is preserved as 37 SAR without being clamped to platform cap (30) or jittered, overriding baseline 45
assert.ok(fyPriceItem, 'FY item must be in price-overrides items');
assert.equal(fyPriceItem.targetPrice, 37, 'FY targetPrice must be 37 SAR');
assert.equal(fyPriceItem.finalTargetPrice, 37, 'FY finalTargetPrice must be 37 SAR');
assert.equal(fyPriceItem.intendedFinalTargetPrice, 37, 'FY intendedFinalTargetPrice must be 37 SAR');

// A1 Verification 2: Even with unknown cost, FY is selected and not excluded
const fySelection = selection.items.find(i => i.storeKey === 'FY');
assert.ok(fySelection, 'FY must be in selection plan items');
assert.equal(fySelection.selected, true, 'FY must be selected');

// A1 Verification 3: DL was NOT specified by user -> DL has known cost, but margin (7.7%) is below 15% floor.
// DL must NOT be contaminated by FY's allowBelowFloorLinkKey! DL must be excluded.
assert.equal(dlPriceItem, undefined, 'DL without explicit price and margin below floor must NOT be in selected items');
assert.ok(dlExcluded, 'DL must be in excluded list');
assert.match(dlExcluded.excludeReason, /margin_below_floor/, 'DL must be excluded specifically due to margin below floor');

// A1 Verification 4: Downstream policy resolution and price-stack guard validation
// Verify that downstream consumers (e.g. build_new_listing_limited_discount_plan or submit_coupon_activity_goods price-stack target guard)
// read finalTargetPrice / targetPrice directly from price-overrides and do NOT re-clamp to platform cap or re-block on floor.
import {classifyLimitedDiscountCouponStack} from '../lib/marketing_coupon_policy.mjs';

const expectedDownstreamPrice = fyPriceItem.finalTargetPrice ?? fyPriceItem.targetPrice;
assert.equal(expectedDownstreamPrice, 37, 'Downstream resolved target price must be strictly 37 SAR');

// Price-stack guard simulation:
// When limited discount price matches finalTargetPrice (37 SAR), with 15% coupon factor = 1 (no coupon allowed on explicit price row)
// or couponFactor = 0.85, test that price stack guard checks against the user's explicit 37 SAR without re-blocking on arbitrary floors.
const stackCheck = classifyLimitedDiscountCouponStack(
  { skc: fyPriceItem.skc, limitedDiscountPrice: 37 },
  fyPriceItem,
  { fallbackDiscountPct: 0 }
);
assert.equal(stackCheck.allowSubmit, true, 'Price-stack guard must allow submit when price matches explicit finalTargetPrice (37 SAR)');
assert.equal(stackCheck.finalTargetPrice, 37, 'Price-stack guard must recognize finalTargetPrice as 37 SAR');
assert.equal(stackCheck.diff, 0, 'Zero diff against explicit target price');

// Clean up temporary files
await fs.rm(tmpDir, { recursive: true, force: true });

console.log(JSON.stringify({ ok: true, tests: 'A1 end-to-end payload execution verified with real builder and anti-contamination assertion' }, null, 2));
