#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'limited-drift-rescue-files-'));
const guardPath = path.join(tmp, 'marketing-daily-guard-2026-07-11.json');
const outDir = path.join(tmp, 'plan');
await fs.mkdir(outDir, {recursive: true});
await fs.writeFile(path.join(outDir, 'limited-drift-rescue-TS-stale.json'), '{}\n', 'utf8');

const row = (storeKey, skc, limitedDiscountName, limitedDiscountEnd) => ({
  storeKey,
  skc,
  canonical: skc,
  limitedDiscountPrice: 90,
  finalTargetPrice: 100,
  deltaSar: -10,
  limitedDiscountName,
  limitedDiscountEnd,
});

await fs.writeFile(guardPath, `${JSON.stringify({
  reportDate: '2026-07-11',
  limitedDiscountTargetPriceDrift: {
    source: 'live.json',
    planSourcePath: 'price.json',
    belowRows: [
      row('HL', 'hl-a', '限时折扣目标价漂移修复20260706', '2026-07-21 23:59:59'),
      row('HL', 'hl-b', '限时折扣必报兜底20260621', '2026-07-21 23:59:59'),
      row('FY', 'fy-a', 'FY限时折扣价格修正20260706', '2026-07-21 23:59:59'),
      row('FY', 'fy-b', '限时折扣目标价漂移修复20260706', '2026-07-21 23:59:59'),
    ],
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
