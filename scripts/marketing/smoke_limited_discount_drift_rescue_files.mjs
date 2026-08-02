#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'limited-drift-rescue-files-'));
const guardPath = path.join(tmp, 'marketing-daily-guard-2026-07-11.json');
const outDir = path.join(tmp, 'plan');
const linksPath = path.join(tmp, 'links.json');
const inventoryPath = path.join(tmp, 'inventory.json');
const pricePath = path.join(tmp, 'price.json');
const costPath = path.join(tmp, 'cost.json');
await fs.mkdir(outDir, {recursive: true});
await fs.writeFile(path.join(outDir, 'limited-drift-rescue-TS-stale.json'), '{}\n', 'utf8');

const row = (storeKey, skc, limitedDiscountName, limitedDiscountEnd) => ({
  storeKey,
  skc,
  canonical: {
    'hl-a': 'SK-1001',
    'hl-b': 'SK-1002',
    'fy-a': 'SK-1003',
    'fy-b': 'SK-1004',
  }[skc],
  limitedDiscountPrice: 90,
  finalTargetPrice: 100,
  deltaSar: -10,
  limitedDiscountName,
  limitedDiscountEnd,
});
const fixtureRows = [
  row('HL', 'hl-a', '限时折扣目标价漂移修复20260706', '2026-07-21 23:59:59'),
  row('HL', 'hl-b', '限时折扣必报兜底20260621', '2026-07-21 23:59:59'),
  row('FY', 'fy-a', 'FY限时折扣价格修正20260706', '2026-07-21 23:59:59'),
  row('FY', 'fy-b', '限时折扣目标价漂移修复20260706', '2026-07-21 23:59:59'),
];
await fs.writeFile(linksPath, JSON.stringify({storeLinks: fixtureRows.map(item => ({
  store_key: item.storeKey,
  skc: item.skc,
  standard_goods_sn: item.canonical,
  c7_eps_uv: 100,
  c30_valid_sale_cnt: 0,
}))}));
await fs.writeFile(inventoryPath, JSON.stringify({products: fixtureRows.map(item => ({
  canonical: item.canonical,
  inventory_match_status: 'matched',
  operational_sellable_qty: 11,
  operational_snapshot_date: '2026-07-11',
}))}));
await fs.writeFile(pricePath, JSON.stringify({items: fixtureRows.map(item => ({
  storeKey: item.storeKey,
  skc: item.skc,
  canonical: item.canonical,
  finalTargetPrice: 100,
}))}));
await fs.writeFile(costPath, JSON.stringify({costMap: {}}));

await fs.writeFile(guardPath, `${JSON.stringify({
  reportDate: '2026-07-11',
  limitedDiscountTargetPriceDrift: {
    source: 'live.json',
    planSourcePath: pricePath,
    belowRows: fixtureRows,
  },
  highClickLowConversionSpecial: {
    sourceLinksData: linksPath,
    sourceInventoryTrend: inventoryPath,
    sourceCostMap: costPath,
  },
}, null, 2)}\n`, 'utf8');

const result = spawnSync(process.execPath, [
  'scripts/marketing/build_limited_discount_drift_rescue_plan.mjs',
  '--guard', guardPath,
  '--out-dir', outDir,
  '--end-time', '2026-07-21 23:59:59',
], {encoding: 'utf8'});

assert.equal(result.status, 0, result.stderr || result.stdout);
const summary = JSON.parse(result.stdout);
assert.equal(summary.rescueFiles, 4);
assert.equal(summary.rows, 4);
assert.equal(summary.clearedStaleRescueFiles, 1);

const files = (await fs.readdir(outDir)).filter(name => /^limited-drift-rescue-.*\.json$/i.test(name));
assert.equal(files.length, 4);
assert.equal(files.filter(name => name.startsWith('limited-drift-rescue-HL-')).length, 2);
assert.equal(files.filter(name => name.startsWith('limited-drift-rescue-FY-')).length, 2);
assert.equal(files.some(name => name.includes('-TS-')), false);

let writtenRows = 0;
for (const file of files) {
  const rescue = JSON.parse(await fs.readFile(path.join(outDir, file), 'utf8'));
  writtenRows += rescue.rows.length;
}
assert.equal(writtenRows, 4);

console.log(JSON.stringify({ok: true, test: 'limited_drift_rescue_files_are_unique_and_stale_safe'}));
