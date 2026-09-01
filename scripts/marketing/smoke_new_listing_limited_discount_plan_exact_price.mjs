#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'new-listing-limited-exact-price-'));
const linksDataPath = path.join(tmp, 'linksData.json');
const priceOverridesPath = path.join(tmp, 'price-overrides.json');
const outDir = path.join(tmp, 'out');
const reportJson = path.join(tmp, 'report.json');
const reportMd = path.join(tmp, 'report.md');
const liveScanPath = path.join(tmp, 'live.json');
const sourceGuardPath = path.join(tmp, 'guard.json');
const linkHistoryDir = path.join(tmp, 'shein_links');
const storesConfigPath = path.join(tmp, 'stores.json');
const inventoryTrendPath = path.join(tmp, 'inventoryTrend.json');

await fs.writeFile(storesConfigPath, `${JSON.stringify({stores: [{storeKey: 'JY', enabled: true}]}, null, 2)}\n`, 'utf8');
await fs.writeFile(inventoryTrendPath, `${JSON.stringify({
  products: [
    'KF-JN-02便携咖啡机',
    'SK-JFB-794卷发钳和卷发棒',
    'HIGH-CLICK-OVERLAP',
    'COVERED',
    'COVERED-HIGHER',
    'COVERED-LOWER',
    'OLD-CANONICAL',
    'RAW-ONLY',
  ].map(canonical => ({
    canonical,
    inventory_match_status: 'matched',
    operational_sellable_qty: 11,
    operational_snapshot_date: '2026-07-04',
  })),
}, null, 2)}\n`, 'utf8');

await fs.writeFile(linksDataPath, `${JSON.stringify({
  generatedAt: '2026-07-04T10:00:00+08:00',
  storeLinks: [
    {
      store_key: 'JY',
      skc: 'new-skc',
      standard_goods_sn: 'KF-JN-02便携咖啡机',
      raw_goods_sn: 'KF-JN-02便携咖啡机',
      is_on_shelf: true,
      shelf_status_name: '已上架',
      shelf_age_days: 2,
      c7_eps_uv: 10,
    },
    {
      store_key: 'JY',
      skc: 'derived-skc',
      standard_goods_sn: 'SK-JFB-794卷发钳和卷发棒',
      raw_goods_sn: 'SK-JFB-794卷发钳和卷发棒',
      is_on_shelf: true,
      shelf_status_name: '已上架',
      shelf_age_days: 2,
      c7_eps_uv: 9,
    },
    {
      store_key: 'JY',
      skc: 'high-click-overlap-skc',
      standard_goods_sn: 'HIGH-CLICK-OVERLAP',
      raw_goods_sn: 'HIGH-CLICK-OVERLAP',
      is_on_shelf: true,
      shelf_status_name: '已上架',
      shelf_age_days: 2,
      c7_eps_uv: 5000,
      c7_goods_uv: 250,
      c7_sale_cnt: 0,
    },
    {
      store_key: 'JY',
      skc: 'covered-skc',
      standard_goods_sn: 'COVERED',
      raw_goods_sn: 'COVERED',
      is_on_shelf: true,
      shelf_status_name: '已上架',
      shelf_age_days: 2,
      c7_eps_uv: 8,
    },
    {
      store_key: 'JY',
      skc: 'covered-higher-skc',
      standard_goods_sn: 'COVERED-HIGHER',
      raw_goods_sn: 'COVERED-HIGHER',
      is_on_shelf: true,
      shelf_status_name: '已上架',
      shelf_age_days: 2,
      c7_eps_uv: 7,
    },
    {
      store_key: 'JY',
      skc: 'covered-lower-skc',
      standard_goods_sn: 'COVERED-LOWER',
      raw_goods_sn: 'COVERED-LOWER',
      is_on_shelf: true,
      shelf_status_name: '已上架',
      shelf_age_days: 2,
      c7_eps_uv: 6,
    },
    ...[100, 90, 80, 70, 60].map((c7, index) => ({
      store_key: 'JY',
      skc: `old-peer-${index + 1}`,
      standard_goods_sn: 'OLD-CANONICAL',
      raw_goods_sn: 'OLD-CANONICAL',
      is_on_shelf: true,
      shelf_status_name: '已上架',
      shelf_age_days: 180,
      c7_eps_uv: c7,
    })),
    {
      store_key: 'JY',
      skc: 'old-missing-limited',
      standard_goods_sn: 'OLD-CANONICAL',
      raw_goods_sn: 'OLD-CANONICAL',
      is_on_shelf: true,
      shelf_status_name: '已上架',
      shelf_age_days: 180,
      c7_eps_uv: 10,
    },
  ],
}, null, 2)}\n`, 'utf8');

await fs.writeFile(liveScanPath, `${JSON.stringify({
  ok: true,
  stores: [{storeKey: 'JY', ok: true}],
  rows: [
    {
      storeKey: 'JY',
      skc: 'covered-skc',
      marketing_limited_discount_price_sar: 88.88,
      marketing_limited_discount_name: '新上架7天高曝光兜底限时折扣20260704',
      marketing_limited_discount_is_current: true,
    },
    {
      storeKey: 'JY',
      skc: 'covered-higher-skc',
      marketing_limited_discount_price_sar: 90,
      marketing_limited_discount_name: '新上架7天高曝光兜底限时折扣20260704',
      marketing_limited_discount_is_current: true,
    },
    {
      storeKey: 'JY',
      skc: 'covered-lower-skc',
      marketing_limited_discount_price_sar: 80,
      marketing_limited_discount_name: '新上架7天高曝光兜底限时折扣20260704',
      marketing_limited_discount_is_current: true,
    },
    ...[1, 2, 3, 4, 5].map(index => ({
      storeKey: 'JY',
      skc: `old-peer-${index}`,
      marketing_limited_discount_price_sar: 94.68,
      marketing_limited_discount_name: '在售老链接漏限时折扣兜底20260704',
      marketing_limited_discount_is_current: true,
    })),
  ],
}, null, 2)}\n`, 'utf8');

await fs.writeFile(priceOverridesPath, `${JSON.stringify({
  items: [
    {
      storeKey: 'JY',
      activityId: 47064,
      skc: 'new-skc',
      canonical: 'KF-JN-02便携咖啡机',
      finalTargetPrice: 96.17,
      targetPrice: 96.17,
      combo: '新上架精确链接价',
    },
    {
      storeKey: 'DL',
      activityId: 47064,
      skc: 'other-top-skc',
      canonical: 'KF-JN-02便携咖啡机',
      finalTargetPrice: 109.99,
      targetPrice: 109.99,
      isTopExposureLink: true,
      combo: '同货号曝光前五代表价',
    },
    {
      storeKey: 'DL',
      activityId: 47064,
      skc: 'non-top',
      canonical: 'SK-JFB-794卷发钳和卷发棒',
      finalTargetPrice: 55.72,
      targetPrice: 55.72,
      combo: '普通活动价',
    },
    {
      storeKey: 'JY',
      activityId: 47064,
      skc: 'high-click-overlap-skc',
      canonical: 'HIGH-CLICK-OVERLAP',
      finalTargetPrice: 66.66,
      targetPrice: 66.66,
      combo: '高点击阶段优先',
    },
    {
      storeKey: 'FY',
      activityId: 47064,
      skc: 'low-approved',
      canonical: 'SK-JFB-794卷发钳和卷发棒',
      finalTargetPrice: 51.73,
      targetPrice: 51.73,
      combo: '已批准最低前五力度价',
    },
    {
      storeKey: 'JY',
      activityId: 47064,
      skc: 'covered-skc',
      canonical: 'COVERED',
      finalTargetPrice: 88.88,
      targetPrice: 88.88,
      combo: '已覆盖',
    },
    {
      storeKey: 'JY',
      activityId: 47064,
      skc: 'covered-higher-skc',
      canonical: 'COVERED-HIGHER',
      finalTargetPrice: 88,
      targetPrice: 88,
      combo: '现有兜底价高于目标，不自动降价',
    },
    {
      storeKey: 'JY',
      activityId: 47064,
      skc: 'covered-lower-skc',
      canonical: 'COVERED-LOWER',
      finalTargetPrice: 88,
      targetPrice: 88,
      combo: '现有兜底价低于目标，仍需修复',
    },
    {
      storeKey: 'DL',
      activityId: 47064,
      skc: 'raw-only-reference',
      canonical: 'RAW-ONLY',
      finalTargetPrice: 77.77,
      targetPrice: 77.77,
      isTopExposureLink: true,
      combo: '原始链接覆盖层同货号前五价',
    },
    ...[1, 2, 3, 4, 5].map(index => ({
      storeKey: 'JY',
      activityId: 47064,
      skc: `old-peer-${index}`,
      canonical: 'OLD-CANONICAL',
      finalTargetPrice: 94.68,
      targetPrice: 94.68,
      isTopExposureLink: true,
      combo: '当前全局曝光前五',
    })),
    {
      storeKey: 'DL',
      activityId: 47064,
      skc: 'old-other-reference',
      canonical: 'OLD-CANONICAL',
      finalTargetPrice: 99.87,
      targetPrice: 99.87,
      isTopExposureLink: false,
      combo: '非曝光前五基准',
    },
  ],
}, null, 2)}\n`, 'utf8');
const priceOverridesSha256 = crypto.createHash('sha256').update(await fs.readFile(priceOverridesPath)).digest('hex');

await fs.writeFile(sourceGuardPath, `${JSON.stringify({
  reportDate: '2026-07-04',
  highClickLowConversionSpecial: {
    actionCount: 1,
    rows: [{storeKey: 'JY', skc: 'high-click-overlap-skc'}],
  },
  limitedDiscountTargetPriceDrift: {belowRows: []},
}, null, 2)}\n`, 'utf8');

await fs.mkdir(path.join(linkHistoryDir, 'JY'), {recursive: true});
await fs.writeFile(path.join(linkHistoryDir, 'JY', '2026-07-04.json'), `${JSON.stringify({
  ok: true,
  date: '2026-07-04',
  fetchTime: '2026-07-04 10:10:00',
  store: {storeKey: 'JY'},
  linkRows: [{
    storeKey: 'JY',
    skc: 'raw-only-skc',
    standardGoodsSn: 'RAW-ONLY',
    isOnShelf: true,
    shelfStatusName: '已上架',
    firstShelfTime: '2026-07-03 12:00:00',
    hasActivity: false,
  }],
}, null, 2)}\n`, 'utf8');

const result = spawnSync(process.execPath, [
  'scripts/marketing/build_new_listing_limited_discount_plan.mjs',
  '--date', '2026-07-04',
  '--links-data', linksDataPath,
  '--price-overrides', priceOverridesPath,
  '--expected-price-overrides-sha256', priceOverridesSha256,
  '--out-dir', outDir,
  '--report-json', reportJson,
  '--report-md', reportMd,
  '--current-marketing-live-scan', liveScanPath,
  '--source-guard', sourceGuardPath,
  '--link-history-dir', linkHistoryDir,
  '--stores-config', storesConfigPath,
  '--inventory-trend', inventoryTrendPath,
  '--no-supplemental-price-overrides',
], {encoding: 'utf8'});

assert.equal(result.status, 0, result.stderr || result.stdout);
const payload = JSON.parse(result.stdout);
assert.equal(payload.actionable, 5);

const report = JSON.parse(await fs.readFile(reportJson, 'utf8'));
assert.equal(report.rows.length, 5);
assert.equal(report.rows[0].storeKey, 'JY');
assert.equal(report.rows[0].skc, 'new-skc');
assert.equal(report.rows[0].limitedDiscountPrice, 96.17);
assert.equal(report.rows[0].targetPriceEvidenceScope, 'exact_store_skc');

const exactRow = report.rows.find(row => row.skc === 'new-skc');
assert.equal(exactRow.limitedDiscountPrice, 96.17);
assert.equal(exactRow.targetPriceEvidenceScope, 'exact_store_skc');
const derivedRow = report.rows.find(row => row.skc === 'derived-skc');
assert.equal(derivedRow.limitedDiscountPrice, 51.73);
assert.equal(derivedRow.topTierPriceSource, 'derived_from_lowest_approved_same_canonical_target_price');
const rawOnlyRow = report.rows.find(row => row.skc === 'raw-only-skc');
assert.equal(rawOnlyRow.limitedDiscountPrice, 77.77);
assert.equal(rawOnlyRow.topTierPriceSource, 'explicit_top_tier_price');
assert.equal(report.latestRawLinkOverlay.addedRowCount, 1);
assert.equal(report.latestRawLinkOverlay.addedRows[0].skc, 'raw-only-skc');
assert.equal(report.latestRawLinkOverlay.updatedRowCount, 0);
assert.equal(report.totals.liveCoveredIgnored, 2);
const oldMissingRow = report.rows.find(row => row.skc === 'old-missing-limited');
assert.equal(oldMissingRow.treatmentType, 'existing_on_shelf_missing_limited_discount');
assert.equal(oldMissingRow.currentExposureIsTop5, false);
assert.equal(oldMissingRow.limitedDiscountPrice, 99.87);
assert.equal(oldMissingRow.topTierPriceSource, 'canonical_current_non_top5_tier_price');
assert.equal(oldMissingRow.endTime, '2026-08-03 23:59:59', 'persistent on-shelf fallback uses a 30-day window');
assert.equal(exactRow.endTime, '2026-07-11 23:59:59', 'new-listing top treatment remains a 7-day window');
assert.equal(report.rule.mandatoryOnShelfDurationDays, 30);
assert.equal(report.totals.existingOnShelfMissingLimitedDiscount, 1);
assert.equal(report.totals.highClickSpecialStageExcluded, 1);
assert.equal(report.rows.some(row => row.skc === 'high-click-overlap-skc'), false);
assert.equal(report.ignored.some(row => row.skc === 'high-click-overlap-skc' && row.reason === 'handled_by_high_click_special_stage'), true);
assert.equal(report.rule.liveLimitedEvidenceComplete, true);
assert.equal(report.ignored.some(row => row.skc === 'covered-skc' && row.reason === 'live_new_listing_limited_discount_already_covered_at_target'), true);
assert.equal(report.ignored.some(row => row.skc === 'covered-higher-skc' && row.reason === 'live_new_listing_limited_discount_already_covered_at_target'), true);
const coveredLowerRow = report.rows.find(row => row.skc === 'covered-lower-skc');
assert.equal(coveredLowerRow.action, 'replace_existing_limited_discount');
assert.equal(coveredLowerRow.currentLimitedPrice, 80);
assert.equal(coveredLowerRow.limitedDiscountPrice, 88);
const rescueRows = (await Promise.all(report.rescueFiles.map(async file => {
  const rescue = JSON.parse(await fs.readFile(path.resolve(file.path), 'utf8'));
  return rescue.rows || [];
}))).flat();
assert.equal(rescueRows.some(row => row.limitedDiscountPrice === 96.17), true);
assert.equal(rescueRows.some(row => row.limitedDiscountPrice === 51.73), true);
assert.equal(rescueRows.some(row => row.skc === 'raw-only-skc' && row.limitedDiscountPrice === 77.77), true);
assert.equal(rescueRows.some(row => row.skc === 'old-missing-limited' && row.limitedDiscountPrice === 99.87), true);

const incompleteLiveScanPath = path.join(tmp, 'live-incomplete.json');
const incompleteReportJson = path.join(tmp, 'report-incomplete.json');
const liveDoc = JSON.parse(await fs.readFile(liveScanPath, 'utf8'));
await fs.writeFile(incompleteLiveScanPath, `${JSON.stringify({...liveDoc, stores: []}, null, 2)}\n`, 'utf8');
const incompleteResult = spawnSync(process.execPath, [
  'scripts/marketing/build_new_listing_limited_discount_plan.mjs',
  '--date', '2026-07-04',
  '--links-data', linksDataPath,
  '--price-overrides', priceOverridesPath,
  '--expected-price-overrides-sha256', priceOverridesSha256,
  '--out-dir', path.join(tmp, 'out-incomplete'),
  '--report-json', incompleteReportJson,
  '--report-md', path.join(tmp, 'report-incomplete.md'),
  '--current-marketing-live-scan', incompleteLiveScanPath,
  '--link-history-dir', linkHistoryDir,
  '--stores-config', storesConfigPath,
  '--inventory-trend', inventoryTrendPath,
  '--no-supplemental-price-overrides',
], {encoding: 'utf8'});
assert.equal(incompleteResult.status, 0, incompleteResult.stderr || incompleteResult.stdout);
const incompleteReport = JSON.parse(await fs.readFile(incompleteReportJson, 'utf8'));
assert.equal(incompleteReport.rule.liveLimitedEvidenceComplete, false);
assert.equal(incompleteReport.rows.some(row => row.skc === 'old-missing-limited'), false);

console.log(JSON.stringify({ok: true, test: 'new_listing_limited_discount_exact_derived_live_covered_and_raw_overlay'}));
