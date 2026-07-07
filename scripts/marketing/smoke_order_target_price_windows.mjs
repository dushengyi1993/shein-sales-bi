#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'order-target-window-smoke-'));
const planPath = path.join(tmp, 'price-overrides.json');
const linksDataPath = path.join(tmp, 'linksData-empty.json');
const salesDir = path.join(tmp, 'shein_fetch', 'NM');
const outDir = path.join(tmp, 'out');
await fs.mkdir(salesDir, {recursive: true});
await fs.writeFile(linksDataPath, `${JSON.stringify({generatedAt: '2026-07-09T00:00:00+08:00', data: {storeLinks: []}}, null, 2)}\n`, 'utf8');

await fs.writeFile(planPath, `${JSON.stringify({
  items: [
    {
      storeKey: 'NM',
      skc: 'same-skc',
      canonical: 'SK-SAME',
      activityId: 1001,
      finalTargetPrice: 80,
      planStartTime: '2026-07-01 00:00:00',
      planEndTime: '2026-07-07 23:59:59',
      combo: 'new listing top-tier target',
    },
    {
      storeKey: 'NM',
      skc: 'same-skc',
      canonical: 'SK-SAME',
      activityId: 1002,
      finalTargetPrice: 100,
      planStartTime: '2026-07-08 00:00:00',
      planEndTime: '2026-07-31 23:59:59',
      combo: 'ordinary target after label window',
    },
  ],
}, null, 2)}\n`, 'utf8');

await fs.writeFile(path.join(salesDir, '2026-07-09.json'), `${JSON.stringify({
  storeKey: 'NM',
  goodsRows: [
    {
      orderNo: 'smoke-1',
      allocateTimeFull: '2026-07-09 12:00:00',
      goodsSn: 'SK-SAME',
      skcName: 'same-skc',
      number: 1,
      currencyPrice: 100,
    },
  ],
}, null, 2)}\n`, 'utf8');

const result = spawnSync(process.execPath, [
  'scripts/marketing/audit_order_prices_against_plan.mjs',
  '--plan', planPath,
  '--links-data', linksDataPath,
  '--sales-dir', salesDir,
  '--date', '2026-07-09',
  '--stores', 'NM',
  '--out-dir', outDir,
  '--include-matches',
], {encoding: 'utf8'});

assert.equal(result.status, 0, result.stderr || result.stdout);
const payload = JSON.parse(result.stdout);
assert.equal(payload.summary.statusCounts.match, 1);
assert.equal(payload.sample.length, 0);
const audit = JSON.parse(await fs.readFile(path.resolve(payload.json), 'utf8'));
assert.equal(audit.rows.length, 1);
assert.equal(audit.rows[0].activityId, 1002);
assert.equal(audit.rows[0].finalTargetPrice, 100);
assert.equal(audit.rows[0].planSelectionReason, 'active_plan_item_window');

console.log(JSON.stringify({ok: true, test: 'order_target_price_uses_store_skc_time_window'}));
