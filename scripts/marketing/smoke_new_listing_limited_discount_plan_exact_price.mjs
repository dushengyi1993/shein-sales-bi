#!/usr/bin/env node
import assert from 'node:assert/strict';
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
const linkHistoryDir = path.join(tmp, 'shein_links');
const storesConfigPath = path.join(tmp, 'stores.json');

await fs.writeFile(storesConfigPath, `${JSON.stringify({stores: [{storeKey: 'JY', enabled: true}]}, null, 2)}\n`, 'utf8');

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
      skc: 'covered-skc',
      standard_goods_sn: 'COVERED',
      raw_goods_sn: 'COVERED',
      is_on_shelf: true,
      shelf_status_name: '已上架',
      shelf_age_days: 2,
      c7_eps_uv: 8,
    },
  ],
}, null, 2)}\n`, 'utf8');

await fs.writeFile(liveScanPath, `${JSON.stringify({
  ok: true,
  rows: [
    {
      storeKey: 'JY',
      skc: 'covered-skc',
      marketing_limited_discount_price_sar: 88.88,
      marketing_limited_discount_name: '新上架7天高曝光兜底限时折扣20260704',
      marketing_limited_discount_is_current: true,
    },
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
      storeKey: 'DL',
      activityId: 47064,
      skc: 'raw-only-reference',
      canonical: 'RAW-ONLY',
      finalTargetPrice: 77.77,
      targetPrice: 77.77,
      isTopExposureLink: true,
      combo: '原始链接覆盖层同货号前五价',
    },
  ],
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
  '--out-dir', outDir,
  '--report-json', reportJson,
  '--report-md', reportMd,
  '--current-marketing-live-scan', liveScanPath,
  '--link-history-dir', linkHistoryDir,
  '--stores-config', storesConfigPath,
  '--no-supplemental-price-overrides',
], {encoding: 'utf8'});

assert.equal(result.status, 0, result.stderr || result.stdout);
const payload = JSON.parse(result.stdout);
assert.equal(payload.actionable, 3);

const report = JSON.parse(await fs.readFile(reportJson, 'utf8'));
assert.equal(report.rows.length, 3);
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
assert.equal(report.totals.liveCoveredIgnored, 1);
assert.equal(report.ignored.some(row => row.skc === 'covered-skc' && row.reason === 'live_new_listing_limited_discount_already_covered_at_target'), true);
const rescue = JSON.parse(await fs.readFile(path.resolve(report.rescueFiles[0].path), 'utf8'));
assert.equal(rescue.rows.some(row => row.limitedDiscountPrice === 96.17), true);
assert.equal(rescue.rows.some(row => row.limitedDiscountPrice === 51.73), true);
assert.equal(rescue.rows.some(row => row.skc === 'raw-only-skc' && row.limitedDiscountPrice === 77.77), true);

console.log(JSON.stringify({ok: true, test: 'new_listing_limited_discount_exact_derived_live_covered_and_raw_overlay'}));
