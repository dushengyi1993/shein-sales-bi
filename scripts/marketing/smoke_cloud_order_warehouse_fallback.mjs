#!/usr/bin/env node
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-order-fallback-'));
const helper = path.resolve('scripts/cloud_read_order_files.py');
const python = process.platform === 'win32' ? 'python' : 'python3';
const fixturePath = path.join(root, 'warehouse.json');
const existingDir = path.join(root, 'outputs', 'shein_fetch', 'DL');
await fs.mkdir(existingDir, {recursive: true});
await fs.writeFile(path.join(existingDir, '2026-08-04.json'), JSON.stringify({
  storeKey: 'DL',
  start: '2026-08-04 00:00:00',
  end: '2026-08-04 23:59:59',
  fetchTime: '2026-08-04T02:00:00Z',
  goodsRows: [{skc: 'sv-file', number: 1, currencyPrice: 12.34, currencyCode: 'SAR'}],
}), 'utf8');
await fs.writeFile(fixturePath, JSON.stringify({
  ok: true,
  queriedAt: '2026-08-04T03:00:00Z',
  rows: [{
    storeKey: 'DX',
    date: '2026-08-04',
    orderNo: 'ORDER-1',
    skc: 'sv-warehouse',
    goodsSn: 'SK-TEST',
    number: 1,
    currencyPrice: 56.78,
    currencyCode: 'SAR',
    isValidSale: true,
  }],
}), 'utf8');

const run = spawnSync(python, [
  helper,
  root,
  'DL,DX,QY',
  '2026-08-04',
  fixturePath,
], {encoding: 'utf8'});
assert.equal(run.status, 0, run.stderr);
const result = JSON.parse(run.stdout);
assert.equal(result.files.length, 3);
const dl = result.files.find(row => row.storeKey === 'DL');
const dx = result.files.find(row => row.storeKey === 'DX');
const qy = result.files.find(row => row.storeKey === 'QY');
assert.equal(dl.sourceType, 'shein_fetch_file');
assert.equal(dl.rows[0].skc, 'sv-file');
assert.equal(dx.sourceType, 'warehouse_webhook_order_item');
assert.equal(dx.remotePath, 'warehouse://fact.order_item/DX/2026-08-04');
assert.equal(dx.rows[0].currencyPrice, 56.78);
assert.equal(qy.sourceType, 'warehouse_webhook_order_item');
assert.equal(qy.exists, true);
assert.equal(qy.ok, true);
assert.equal(qy.rowCount, 0);
assert.deepEqual(result.warehouseFallback, {
  used: true,
  queriedAt: '2026-08-04T03:00:00Z',
  fileCount: 2,
  rowCount: 1,
  source: 'fact.order_item',
});

const disabled = spawnSync(python, [
  helper,
  root,
  'DX',
  '2026-08-03',
], {
  encoding: 'utf8',
  env: {...process.env, SHEIN_BI_ORDER_WAREHOUSE_FALLBACK: '0'},
});
assert.equal(disabled.status, 0, disabled.stderr);
const disabledResult = JSON.parse(disabled.stdout);
assert.equal(disabledResult.files[0].exists, false);
assert.equal(disabledResult.warehouseFallback, undefined);

console.log(JSON.stringify({ok: true, checks: 18}));
