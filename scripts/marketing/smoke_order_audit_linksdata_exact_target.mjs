#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'order-audit-linksdata-target-'));
const planPath = path.join(tmp, 'price-overrides.json');
const linksDataPath = path.join(tmp, 'linksData.json');
const salesDir = path.join(tmp, 'shein_fetch', 'NM');
const outDir = path.join(tmp, 'out');
await fs.mkdir(salesDir, {recursive: true});

await fs.writeFile(planPath, `${JSON.stringify({
  items: [{
    storeKey: 'NM',
    skc: 'same-skc',
    canonical: 'SK-SAME',
    activityId: 1001,
    finalTargetPrice: 110,
    planStartTime: '2026-07-01 00:00:00',
    planEndTime: '2026-07-31 23:59:59',
  }],
}, null, 2)}\n`, 'utf8');

await fs.writeFile(linksDataPath, `${JSON.stringify({
  generatedAt: '2026-07-04T12:00:00+08:00',
  data: {
    storeLinks: [{
      store_key: 'NM',
      skc: 'same-skc',
      standard_goods_sn: 'SK-SAME',
      marketing_final_target_price_sar: 96,
      marketing_suggested_ordinary_price_sar: 96,
      marketing_price_note: 'linksData exact high exposure/new listing target',
    }],
  },
}, null, 2)}\n`, 'utf8');

await fs.writeFile(path.join(salesDir, '2026-07-09.json'), `${JSON.stringify({
  storeKey: 'NM',
  goodsRows: [{
    orderNo: 'smoke-linksdata',
    allocateTimeFull: '2026-07-09 12:00:00',
    goodsSn: 'SK-SAME',
    skcName: 'same-skc',
    number: 1,
    currencyPrice: 96,
  }],
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
assert.equal(payload.summary.linkTargetRows, 1);
const audit = JSON.parse(await fs.readFile(path.resolve(payload.json), 'utf8'));
assert.equal(audit.rows[0].finalTargetPrice, 96);
assert.equal(audit.rows[0].activityId, 1001);
assert.equal(audit.rows[0].planSelectionReason, 'active_plan_item_window');

console.log(JSON.stringify({ok: true, test: 'order_audit_prefers_linksdata_exact_store_skc_target'}));
