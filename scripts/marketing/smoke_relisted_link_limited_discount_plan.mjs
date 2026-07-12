#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'relisted-link-limited-discount-'));
const linksDataPath = path.join(tmp, 'linksData.json');
const priceOverridesPath = path.join(tmp, 'price-overrides.json');
const liveScanPath = path.join(tmp, 'live.json');
const historyDir = path.join(tmp, 'shein_links');
const storeHistoryDir = path.join(historyDir, 'DL');
const outDir = path.join(tmp, 'out');
const reportJson = path.join(tmp, 'report.json');
const reportMd = path.join(tmp, 'report.md');
await fs.mkdir(storeHistoryDir, {recursive: true});

const skc = 'sv260208174499165647929';
const canonical = 'SK-03038制冰机';
await fs.writeFile(linksDataPath, `${JSON.stringify({
  generatedAt: '2026-07-11T14:00:00+08:00',
  storeLinks: [{
    store_key: 'DL',
    skc,
    standard_goods_sn: canonical,
    raw_goods_sn: canonical,
    is_on_shelf: true,
    is_sold_out: false,
    is_out_shelf: false,
    shelf_status_name: '已上架',
    shelf_age_days: 79,
    c7_eps_uv: 48,
    activity_label: '即将开始',
    performance_activity_names: '',
  }],
}, null, 2)}\n`, 'utf8');

const historyRow = (date, status, hasActivity = false) => ({
  date,
  storeKey: 'DL',
  skc,
  standardGoodsSn: canonical,
  shelfStatus: status,
  shelfStatusName: status === 'ON_SHELF' ? '已上架' : '已售罄',
  isOnShelf: status === 'ON_SHELF',
  isSoldOut: status === 'SOLD_OUT',
  isOutShelf: false,
  hasActivity,
});
await fs.writeFile(path.join(storeHistoryDir, '2026-07-08.json'), `${JSON.stringify({linkRows: [historyRow('2026-07-08', 'SOLD_OUT')]}, null, 2)}\n`, 'utf8');
await fs.writeFile(path.join(storeHistoryDir, '2026-07-09.json'), `${JSON.stringify({linkRows: [historyRow('2026-07-09', 'ON_SHELF')]}, null, 2)}\n`, 'utf8');
await fs.writeFile(path.join(storeHistoryDir, '2026-07-10.json'), `${JSON.stringify({linkRows: [historyRow('2026-07-10', 'ON_SHELF')]}, null, 2)}\n`, 'utf8');

await fs.writeFile(liveScanPath, `${JSON.stringify({
  ok: true,
  partial: false,
  storeStatus: [{storeKey: 'DL', ok: true}],
  rows: [{
    store_key: 'DL',
    skc,
    marketing_limited_discount_price_sar: 335.13,
    marketing_limited_discount_name: '明日待生效限时折扣',
    marketing_price_evidence_type: 'future_limited_discount_live_scan',
  }],
}, null, 2)}\n`, 'utf8');
await fs.writeFile(priceOverridesPath, `${JSON.stringify({
  items: [{
    storeKey: 'FY',
    skc: 'top-skc',
    canonical,
    finalTargetPrice: 335.13,
    targetPrice: 335.13,
    isTopExposureLink: true,
  }],
}, null, 2)}\n`, 'utf8');

const result = spawnSync(process.execPath, [
  'scripts/marketing/build_new_listing_limited_discount_plan.mjs',
  '--date', '2026-07-11',
  '--links-data', linksDataPath,
  '--price-overrides', priceOverridesPath,
  '--current-marketing-live-scan', liveScanPath,
  '--link-history-dir', historyDir,
  '--out-dir', outDir,
  '--report-json', reportJson,
  '--report-md', reportMd,
], {encoding: 'utf8'});

assert.equal(result.status, 0, result.stderr || result.stdout);
const payload = JSON.parse(result.stdout);
assert.equal(payload.actionable, 1);
const report = JSON.parse(await fs.readFile(reportJson, 'utf8'));
assert.equal(report.rows.length, 1);
assert.equal(report.rows[0].skc, skc);
assert.equal(report.rows[0].treatmentType, 'relisted_without_active_marketing');
assert.equal(report.rows[0].lastInactiveDate, '2026-07-08');
assert.equal(report.rows[0].relistedAt, '2026-07-09');
assert.equal(report.rows[0].limitedDiscountPrice, 335.13);
assert.equal(report.rows[0].sourceRule, 'relisted_without_active_marketing_same_as_global_exposure_top5');
assert.equal(report.totals.relistedWithoutActiveMarketing, 1);

const currentReportJson = path.join(tmp, 'current-report.json');
const currentReportMd = path.join(tmp, 'current-report.md');
await fs.writeFile(liveScanPath, `${JSON.stringify({
  ok: true,
  partial: false,
  storeStatus: [{storeKey: 'DL', ok: true}],
  rows: [{
    store_key: 'DL',
    skc,
    marketing_limited_discount_price_sar: 335.13,
    marketing_limited_discount_is_current: true,
    marketing_limited_discount_name: '当前生效限时折扣',
    marketing_price_evidence_type: 'current_limited_discount_live_scan',
  }],
}, null, 2)}\n`, 'utf8');
const currentResult = spawnSync(process.execPath, [
  'scripts/marketing/build_new_listing_limited_discount_plan.mjs',
  '--date', '2026-07-11',
  '--links-data', linksDataPath,
  '--price-overrides', priceOverridesPath,
  '--current-marketing-live-scan', liveScanPath,
  '--link-history-dir', historyDir,
  '--out-dir', path.join(tmp, 'current-out'),
  '--report-json', currentReportJson,
  '--report-md', currentReportMd,
], {encoding: 'utf8'});
assert.equal(currentResult.status, 0, currentResult.stderr || currentResult.stdout);
assert.equal(JSON.parse(currentResult.stdout).actionable, 0);
assert.equal(JSON.parse(await fs.readFile(currentReportJson, 'utf8')).rows.length, 0);

console.log(JSON.stringify({ok: true, test: 'relisted_without_active_marketing_gets_top5_limited_discount'}));
