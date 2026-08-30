#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {stableInventoryHash} from '../lib/inventory_replenishment_policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP_BASE = path.join(ROOT, 'tmp');
await fs.mkdir(TMP_BASE, {recursive: true});
const tmp = await fs.mkdtemp(path.join(TMP_BASE, 'link-ops-maintenance-inventory-durable-'));
const pgLoaderFile = path.join(tmp, 'stub-pg-loader.mjs');
await fs.writeFile(pgLoaderFile, "export async function resolve(specifier, context, nextResolve) { if (specifier === 'pg') return {url: 'data:text/javascript,export class Pool { constructor() {} async connect() { throw new Error(\\\"pg stub is test-only\\\"); } async end() {} } export default {Pool};', shortCircuit: true}; return nextResolve(specifier, context); }\n", 'utf8');
const CONFIRM = 'SHEIN_OPENAPI_SUBMIT';
const calls = [];
let mode = 'success';
let liveUsable = 5;
let liveLocked = 0;
let postCount = 0;
let postOrder = [];

function sendJson(res, value, status = 200) { res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'}); res.end(JSON.stringify(value)); }
function readBody(req) { return new Promise((resolve, reject) => { const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = text ? JSON.parse(text) : null; } catch {} resolve({text, json}); }); req.on('error', reject); }); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
async function writeJson(file, value) { await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8'); return file; }
async function journalLines(outDir, taskId = 'durable-task') { const file = path.join(outDir, 'maintenance-inventory-ZL-' + taskId + '.json.journal.ndjson'); try { const text = await fs.readFile(file, 'utf8'); return text.trim() ? text.trim().split(/\r?\n/).map(line => JSON.parse(line)) : []; } catch (error) { if (error.code === 'ENOENT') return []; throw error; } }
function runNode(args, extraEnv = {}) { return new Promise(resolve => { const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, NODE_ENV: 'test', NODE_OPTIONS: (process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + ' ' : '') + '--experimental-loader=' + pathToFileURL(pgLoaderFile).href, SHEIN_BI_TEST_ALLOW_FAKE_WEBHOOK_GATE: '1', SHEIN_BI_MAINTENANCE_INVENTORY_JOURNAL_DIR: currentOutDir, SHEIN_BI_INVENTORY_JOURNAL_DIRS: '', ...extraEnv} }); let stdout = '', stderr = ''; child.stdout.on('data', d => { stdout += d.toString(); }); child.stderr.on('data', d => { stderr += d.toString(); }); child.on('close', code => { let json = null; try { json = stdout.trim() ? JSON.parse(stdout) : null; } catch {} resolve({code, stdout, stderr, json}); }); }); }

const server = http.createServer(async (req, res) => {
  const body = await readBody(req);
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  calls.push({method: req.method, path: pathname, body: body.json});
  if (pathname === '/open-api/openapi-business-backend/query-store-info') return sendJson(res, {code: '0', msg: 'OK', info: {merchantId: '12839379', accountNo: 'GS1428388'}});
  if (pathname === '/open-api/goods/spu-info') return sendJson(res, {code: '0', msg: 'OK', info: {spuName: 'spu-durable', skcInfoList: [{skcName: 'sb-durable', shelfStatusInfoList: [{siteAbbr: 'shein-sa', shelfStatus: 1}], skuInfoList: [{skuCode: 'sku-durable'}]}]}});
  if (pathname === '/open-api/msc/warehouse/list') return sendJson(res, {code: '0', msg: 'OK', info: {list: [{warehouseCode: 'PS299807325817', warehouseName: 'Saudi Arabia', saleCountryList: ['SA']}]}});
  if (pathname === '/open-api/stock/stock-query') {
    if (mode === 'missing-stock') return sendJson(res, {code: '0', msg: 'OK', info: [{goodsInventory: [{skcName: 'sb-durable', warehouseCode: 'PS299807325817', skuList: []}]}]});
    if (mode === 'missing-field') return sendJson(res, {code: '0', msg: 'OK', info: [{goodsInventory: [{skcName: 'sb-durable', skuList: [{skuCode: 'sku-durable', totalInventoryQuantity: liveUsable + liveLocked, totalUsableInventory: liveUsable, totalLockedQuantity: liveLocked, warehouseInventoryList: [{warehouseCode: 'PS299807325817', inventoryQuantity: liveUsable + liveLocked, usableInventory: liveUsable, lockedQuantity: liveLocked}]}]}]}]});
    if (mode === 'ambiguous-warehouse') return sendJson(res, {code: '0', msg: 'OK', info: [{goodsInventory: [{skcName: 'sb-durable', skuList: [{skuCode: 'sku-durable', totalInventoryQuantity: liveUsable, totalUsableInventory: liveUsable, totalLockedQuantity: liveLocked, totalTempLockQuantity: 0, warehouseInventoryList: [{warehouseCode: 'PS299807325817', inventoryQuantity: liveUsable, usableInventory: liveUsable, lockedQuantity: liveLocked, tempLockQuantity: 0}, {warehouseCode: 'PS299807325817', inventoryQuantity: liveUsable, usableInventory: liveUsable, lockedQuantity: liveLocked, tempLockQuantity: 0}]}]}]}]});
    return sendJson(res, {code: '0', msg: 'OK', info: [{goodsInventory: [{skcName: 'sb-durable', skuList: [{skuCode: 'sku-durable', totalInventoryQuantity: liveUsable + liveLocked, totalUsableInventory: liveUsable, totalLockedQuantity: liveLocked, totalTempLockQuantity: 0, warehouseInventoryList: [{warehouseCode: 'PS299807325817', inventoryQuantity: liveUsable + liveLocked, usableInventory: liveUsable, lockedQuantity: liveLocked, tempLockQuantity: 0}, {warehouseCode: 'PS-OTHER', inventoryQuantity: 999, usableInventory: 999, lockedQuantity: 0, tempLockQuantity: 0}]}]}]}]});
  }
  if (pathname === '/open-api/stock/change-inventory/v2') {
    postCount += 1;
    postOrder.push((await journalLines(currentOutDir, currentTaskId)).map(row => row.kind).join(','));
    if (mode === 'transport') { req.socket.destroy(); return; }
    const row = body.json?.updateSkuInventoryQuantityRequests?.[0] || {};
    if (row.skuCode !== 'sku-durable' || row.warehouseCode !== 'PS299807325817' || row.changeType !== 'OVERWRITE' || row.invType !== 'VI' || !String(row.idempotencyKey || '').startsWith('bi-inv-')) return sendJson(res, {code: '400', msg: 'bad inventory durable payload'});
    if (mode === 'business-reject') return sendJson(res, {code: '400', msg: 'business rejected', info: {success: false}});
    if (mode === 'pending') return sendJson(res, {code: '0', msg: 'OK', traceId: 'trace-pending'});
    liveUsable = Number(row.changeQuantity) - liveLocked;
    return sendJson(res, {code: '0', msg: 'OK', traceId: 'trace-inventory-durable'});
  }
  return sendJson(res, {code: '404', msg: pathname}, 404);
});
let currentOutDir = '';
let currentTaskId = '';
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

try {
  const configFile = await writeJson(path.join(tmp, 'openapi.json'), {apiBaseUrls: {prodSemiManaged: 'http://127.0.0.1:' + port}, stores: [{storeKey: 'ZL', enabled: true, openKeyId: 'dummy-open', secretKey: 'dummy-secret'}]});
  const biDir = path.join(tmp, 'bi-portal');
  await writeJson(path.join(biDir, 'sections', 'linksData.json'), {data: {storeLinks: [{store_key: 'ZL', skc: 'sb-durable', spu: 'spu-durable', standard_goods_sn: 'SK-7025A', is_on_shelf: true}]}});
  const productCacheDir = path.join(tmp, 'products');
  await writeJson(path.join(productCacheDir, 'ZL', 'latest.json'), {normalizedRows: [{storeKey: 'ZL', skc: 'sb-durable', spu: 'spu-durable', supplierCode: 'SK-7025A', skuCodes: '[\"sku-durable\"]', sheinUsableInventory: 5}]});
  const common = ['scripts/link_ops_maintenance_openapi_executor.mjs', '--config', configFile, '--store', 'ZL', '--dir', biDir, '--product-cache-dir', productCacheDir];
  const makeTask = (id = 'durable-task', inventory = 10, expected = 5) => ({id, status: 'waiting_review', command: '结构化库存维护任务', planning: {source: 'structured_cli', parameters: expected === null ? {inventory} : {inventory, expectedCurrentInventory: expected}}, targets: {stores: ['ZL'], productRefs: ['SK-7025A']}, intents: ['update_inventory']});
  async function dryRun(task, outDir, extraEnv = {}) { currentOutDir = outDir; currentTaskId = task.id; calls.length = 0; const file = await writeJson(path.join(tmp, task.id + '-dry.json'), {version: 1, tasks: [task]}); return runNode([...common, '--task-id', task.id, '--task-json', file, '--out-dir', outDir, '--dry-run'], extraEnv); }
  async function execute(task, outDir, payloadHash, extraEnv = {}) { currentOutDir = outDir; currentTaskId = task.id; const nonce = 'nonce-' + task.id + '-' + Math.random(); const file = await writeJson(path.join(tmp, task.id + '-execute-' + Date.now() + '-' + Math.random() + '.json'), {version: 1, executionContext: {expectedPayloadHash: payloadHash, writeClaim: {schemaVersion: 1, claimId: 'claim-' + task.id, nonce, taskId: task.id, storeKey: 'ZL', operations: ['update_inventory'], expectedPayloadHash: payloadHash, claimedAt: new Date().toISOString(), claimedBy: 'focused-test', state: 'claimed'}}, tasks: [task]}); return runNode([...common, '--task-id', task.id, '--task-json', file, '--out-dir', outDir, '--execute', '--confirm', CONFIRM, '--claim-nonce', nonce], extraEnv); }
  async function reconcile(task, outDir) { currentOutDir = outDir; currentTaskId = task.id; const file = await writeJson(path.join(tmp, task.id + '-reconcile-' + Date.now() + '-' + Math.random() + '.json'), {version: 1, tasks: [task]}); return runNode([...common, '--task-id', task.id, '--task-json', file, '--out-dir', outDir, '--reconcile-pending-only']); }

  const outDry = path.join(tmp, 'out-dry');
  const task = makeTask();
  const dry = await dryRun(task, outDry);
  assert.equal(dry.code, 0, dry.stderr || dry.stdout);
  assert.equal(postCount, 0, 'dry-run must not POST inventory');
  assert.equal((await journalLines(outDry)).length, 0, 'dry-run must not create journal');

  const outSuccess = path.join(tmp, 'out-success');
  liveUsable = 5; liveLocked = 2; postCount = 0; mode = 'success'; calls.length = 0; postOrder = [];
  const successDry = await dryRun(task, outSuccess);
  const hash = successDry.json.payload.payloadHash;
  const success = await execute(task, outSuccess, hash);
  assert.equal(success.code, 0, success.stderr || success.stdout);
  assert.equal(postCount, 1, 'execute success must POST exactly once: '+success.stdout+'\n'+success.stderr);
  assert.equal(postOrder[0], 'intent', 'durable intent must exist before POST');
  const successJournal = await journalLines(outSuccess);
  assert.deepEqual(successJournal.map(e => e.kind), ['intent', 'write_outcome']);
  assert.equal(successJournal[0].requestPayloadHash, stableInventoryHash(successJournal[0].request));
  assert.equal(successJournal[0].inventoryWriteProfile, 'link_ops_maintenance_inventory/v1');
  assert.equal(successJournal[0].before.totalUsableInventory, 5);
  assert.equal(successJournal[0].before.totalLockedQuantity, 2);
  assert.equal(successJournal[0].request.body.updateSkuInventoryQuantityRequests[0].changeQuantity, 12);
  assert.equal(successJournal[0].request.body.updateSkuInventoryQuantityRequests[0].warehouseCode, 'PS299807325817');
  assert.equal(successJournal[1].disposition, 'readback_matched');
  assert.equal(success.json.adapterEvidence.writeAttempted, true);
  assert.equal(success.json.adapterEvidence.realSubmit, true);
  assert.equal(success.json.readback.groups[0].ok, true, JSON.stringify(success.json.readback));

  const repeat = await execute(task, outSuccess, hash);
  assert.equal(repeat.json?.state, 'blocked', repeat.stdout);
  assert.equal(postCount, 1, 'duplicate execution must not send a second POST');
  assert.equal(repeat.json.adapterEvidence.writeAttempted, false);
  assert.equal(repeat.json.adapterEvidence.realSubmit, false);
  assert.match(JSON.stringify(repeat.json), /INVENTORY_WRITE_ALREADY_RECORDED/);

  liveLocked = 0;
  const taskB = makeTask('durable-task-b', 12, 10);
  const taskBDry = await dryRun(taskB, outSuccess);
  const taskBRun = await execute(taskB, outSuccess, taskBDry.json.payload.payloadHash);
  assert.equal(taskBRun.code, 0, taskBRun.stderr || taskBRun.stdout);
  assert.equal(postCount, 2, 'terminal task A must not permanently block task B on the same scope');
  const taskBJournal = await journalLines(outSuccess, 'durable-task-b');
  assert.deepEqual(taskBJournal.map(e => e.kind), ['intent', 'write_outcome']);
  assert.equal(taskBJournal[0].targetUsableInventory, 12);
  assert.equal(taskBJournal[1].disposition, 'readback_matched');
  assert.equal(taskBRun.json.readback.groups[0].ok, true);

  const outRejected = path.join(tmp, 'out-business-rejected');
  liveUsable = 5; liveLocked = 0; postCount = 0; mode = 'business-reject'; calls.length = 0; postOrder = [];
  const rejectedTask = makeTask('business-rejected-task', 10, 5);
  const rejectedDry = await dryRun(rejectedTask, outRejected);
  const rejectedRun = await execute(rejectedTask, outRejected, rejectedDry.json.payload.payloadHash);
  assert.equal(rejectedRun.json?.state, 'blocked', rejectedRun.stdout);
  assert.equal(postCount, 1, 'explicit nonzero business code is one terminal rejected POST');
  assert.equal(rejectedRun.json.adapterEvidence.realSubmit, false);
  assert.equal(rejectedRun.json.adapterEvidence.phaseResults[0].state, 'rejected');
  const rejectedJournal = await journalLines(outRejected, 'business-rejected-task');
  assert.deepEqual(rejectedJournal.map(entry => entry.kind), ['intent', 'write_outcome']);
  assert.equal(rejectedJournal[1].disposition, 'rejected');

  const outNoExpected = path.join(tmp, 'out-no-expected');
  liveUsable = 7; liveLocked = 3; postCount = 0; mode = 'success'; calls.length = 0; postOrder = [];
  const noExpectedTask = makeTask('no-expected-task', 10, null);
  const noExpectedDry = await dryRun(noExpectedTask, outNoExpected);
  const noExpectedRun = await execute(noExpectedTask, outNoExpected, noExpectedDry.json.payload.payloadHash);
  assert.equal(noExpectedRun.code, 0, noExpectedRun.stderr || noExpectedRun.stdout);
  assert.ok(calls.some(call => call.path === '/open-api/stock/stock-query'), 'execute without expectedCurrentInventory still performs fresh stock-query');
  const noExpectedJournal = await journalLines(outNoExpected, 'no-expected-task');
  assert.ok(noExpectedJournal[0], noExpectedRun.stdout);
  assert.equal(noExpectedJournal[0].before.totalUsableInventory, 7);
  assert.equal(noExpectedJournal[0].before.totalLockedQuantity, 3);
  assert.equal(noExpectedJournal[0].request.body.updateSkuInventoryQuantityRequests[0].changeQuantity, 13);
  assert.equal(postCount, 1, 'no expectedCurrentInventory path still posts once after live baseline');

  const outZero = path.join(tmp, 'out-zero-stock');
  liveUsable = 0; liveLocked = 0; postCount = 0; mode = 'success'; calls.length = 0; postOrder = [];
  const zeroTask = makeTask('zero-stock-task', 10, null);
  const zeroDry = await dryRun(zeroTask, outZero);
  const zeroRun = await execute(zeroTask, outZero, zeroDry.json.payload.payloadHash);
  assert.equal(zeroRun.code, 0, zeroRun.stderr || zeroRun.stdout);
  const zeroJournal = await journalLines(outZero, 'zero-stock-task');
  assert.equal(zeroJournal[0].before.totalInventoryQuantity, 0);
  assert.equal(zeroJournal[0].before.totalUsableInventory, 0);
  assert.equal(zeroJournal[0].before.totalLockedQuantity, 0);
  assert.equal(zeroJournal[0].before.temporaryInventoryQuantity, 0);
  assert.equal(zeroJournal[0].request.body.updateSkuInventoryQuantityRequests[0].changeQuantity, 10);
  assert.equal(zeroRun.json.readback.groups[0].expectedWarehouseCode, 'PS299807325817');
  assert.equal(postCount, 1, 'zero inventory production schema still posts once after exact warehouse row');

  const outFence = path.join(tmp, 'out-fence');
  liveUsable = 5; postCount = 0; mode = 'success'; calls.length = 0; postOrder = [];
  const fenceTask = makeTask('fence-task');
  const fenceDry = await dryRun(fenceTask, outFence);
  const fenceHash = fenceDry.json.payload.payloadHash;
  await fs.mkdir(outFence, {recursive: true});
  const fenceJournal = path.join(outFence, 'maintenance-inventory-ZL-fence-task.json.journal.ndjson');
  const badIntent = clone(successJournal[0]);
  badIntent.intentId = '11111111-1111-4111-8111-111111111111'; badIntent.maintenanceTaskId = 'fence-task'; badIntent.storeKey = 'ZL'; badIntent.skc = 'sb-durable'; badIntent.skuCode = 'sku-durable';
  await fs.writeFile(fenceJournal, JSON.stringify(badIntent) + '\n', 'utf8');
  const fenced = await execute(fenceTask, outFence, fenceHash);
  assert.equal(fenced.json?.state, 'blocked', fenced.stdout);
  assert.equal(postCount, 0, 'pre-network durable conflict must not POST');
  assert.equal(fenced.json.adapterEvidence.writeAttempted, false);
  assert.equal(fenced.json.adapterEvidence.realSubmit, false);
  assert.match(JSON.stringify(fenced.json), /INVENTORY_WRITE_ALREADY_RECORDED|INVENTORY_WRITE_HASH_OR_SCOPE_DRIFT|INVENTORY_WRITE_PENDING_CONFLICT/);

  const outMissing = path.join(tmp, 'out-missing-stock');
  liveUsable = 5; liveLocked = 0; postCount = 0; mode = 'missing-stock'; calls.length = 0; postOrder = [];
  const missingTask = makeTask('missing-stock-task', 10, null);
  const missingDry = await dryRun(missingTask, outMissing);
  const missingRun = await execute(missingTask, outMissing, missingDry.json.payload.payloadHash);
  assert.equal(missingRun.json?.state, 'blocked', missingRun.stdout);
  assert.equal(postCount, 0, 'missing stock-query SKU blocks before POST');
  assert.match(JSON.stringify(missingRun.json), /missingSkuCodes|库存写前库存快照不满足提交条件/);

  const outMissingField = path.join(tmp, 'out-missing-field');
  liveUsable = 5; liveLocked = 0; postCount = 0; mode = 'missing-field'; calls.length = 0; postOrder = [];
  const missingFieldTask = makeTask('missing-field-task', 10, null);
  const missingFieldDry = await dryRun(missingFieldTask, outMissingField);
  const missingFieldRun = await execute(missingFieldTask, outMissingField, missingFieldDry.json.payload.payloadHash);
  assert.equal(missingFieldRun.json?.state, 'blocked', missingFieldRun.stdout);
  assert.equal(postCount, 0, 'missing inventory field blocks before POST instead of coercing to zero');
  assert.match(JSON.stringify(missingFieldRun.json), /invalidInventorySkuCodes/);

  const outAmbiguous = path.join(tmp, 'out-ambiguous-warehouse');
  liveUsable = 5; liveLocked = 0; postCount = 0; mode = 'ambiguous-warehouse'; calls.length = 0; postOrder = [];
  const ambiguousTask = makeTask('ambiguous-warehouse-task', 10, null);
  const ambiguousDry = await dryRun(ambiguousTask, outAmbiguous);
  const ambiguousRun = await execute(ambiguousTask, outAmbiguous, ambiguousDry.json.payload.payloadHash);
  assert.equal(ambiguousRun.json?.state, 'blocked', ambiguousRun.stdout);
  assert.equal(postCount, 0, 'ambiguous warehouse stock rows block before POST');
  assert.match(JSON.stringify(ambiguousRun.json), /ambiguousSkuCodes|库存写前库存快照不满足提交条件/);

  const outDrift = path.join(tmp, 'out-expected-drift');
  liveUsable = 6; liveLocked = 0; postCount = 0; mode = 'success'; calls.length = 0; postOrder = [];
  const driftTask = makeTask('expected-drift-task', 10, 5);
  const driftDry = await dryRun(driftTask, outDrift);
  const driftRun = await execute(driftTask, outDrift, driftDry.json.payload.payloadHash);
  assert.equal(driftRun.json?.state, 'blocked', driftRun.stdout);
  assert.equal(postCount, 0, 'expectedCurrentInventory drift blocks before POST');
  assert.match(JSON.stringify(driftRun.json), /mismatchedSkuCodes|期望当前可用 5/);

  const outTransport = path.join(tmp, 'out-transport');
  liveUsable = 5; postCount = 0; mode = 'transport'; calls.length = 0; postOrder = [];
  const transportTask = makeTask('transport-task');
  const transportDry = await dryRun(transportTask, outTransport);
  const transport = await execute(transportTask, outTransport, transportDry.json.payload.payloadHash);
  assert.equal(transport.json?.state, 'suspicious_write_attempted', transport.stdout);
  assert.equal(postCount, 1, 'post-intent transport unknown must attempt one POST');
  assert.equal(postOrder[0], 'intent', 'transport POST also follows intent fsync');
  const transportJournal = await journalLines(outTransport, 'transport-task');
  assert.equal(transportJournal.filter(e => e.kind === 'intent').length, 1);
  assert.equal(transportJournal.filter(e => e.kind === 'write_outcome').length, 0);
  assert.equal(transport.json.state, 'suspicious_write_attempted');
  assert.equal(transport.json.adapterEvidence.writeAttempted, true);
  assert.equal(transport.json.adapterEvidence.sheinWriteAttempted, true);
  const transportRepeat = await execute(transportTask, outTransport, transportDry.json.payload.payloadHash);
  assert.equal(transportRepeat.json?.state, 'blocked', transportRepeat.stdout);
  assert.equal(postCount, 1, 'pending transport rerun must not POST again');
  const blockedByPendingTask = makeTask('blocked-by-pending-task', 12, 5);
  const blockedByPendingDry = await dryRun(blockedByPendingTask, outTransport);
  const blockedByPending = await execute(blockedByPendingTask, outTransport, blockedByPendingDry.json.payload.payloadHash);
  assert.equal(blockedByPending.json?.state, 'blocked', blockedByPending.stdout);
  assert.equal(postCount, 1, 'pending same-scope intent must block a new task before POST');
  assert.match(JSON.stringify(blockedByPending.json), /INVENTORY_WRITE_PENDING_CONFLICT/);

  const outPending = path.join(tmp, 'out-pending-reconcile');
  liveUsable = 5; liveLocked = 0; postCount = 0; mode = 'pending'; calls.length = 0; postOrder = [];
  const pendingTask = makeTask('pending-reconcile-task', 10, 5);
  const pendingDry = await dryRun(pendingTask, outPending);
  const pendingRun = await execute(pendingTask, outPending, pendingDry.json.payload.payloadHash);
  assert.equal(pendingRun.json?.outcome, 'unconfirmed', pendingRun.stdout);
  assert.equal(postCount, 1, 'pending response sends exactly one POST');
  assert.deepEqual((await journalLines(outPending, 'pending-reconcile-task')).map(entry => entry.kind), ['intent']);
  const stillPending = await reconcile(pendingTask, outPending);
  assert.equal(stillPending.json?.state, 'submitted_but_readback_pending', stillPending.stdout);
  assert.equal(postCount, 1, 'reconcile-only mismatch performs no POST');
  liveUsable = 10;
  const reconciled = await reconcile(pendingTask, outPending);
  assert.equal(reconciled.json?.state, 'readback_matched', reconciled.stdout);
  assert.equal(postCount, 1, 'reconcile-only exact match performs no POST');
  assert.deepEqual((await journalLines(outPending, 'pending-reconcile-task')).map(entry => entry.kind), ['intent', 'write_outcome']);

  const externalJournalDir = path.join(tmp, 'external-journals');
  await fs.mkdir(externalJournalDir, {recursive: true});
  await fs.writeFile(path.join(externalJournalDir, `daily-inventory-replenishment-${transportJournal[0].runDate}.json.journal.ndjson`), JSON.stringify(transportJournal[0]) + '\n', 'utf8');
  const outCrossDomain = path.join(tmp, 'out-cross-domain');
  liveUsable = 5; liveLocked = 0; postCount = 0; mode = 'success'; calls.length = 0; postOrder = [];
  const crossDomainTask = makeTask('cross-domain-task', 10, 5);
  const crossDomainEnv = {SHEIN_BI_INVENTORY_JOURNAL_DIRS: externalJournalDir};
  const crossDomainDry = await dryRun(crossDomainTask, outCrossDomain, crossDomainEnv);
  const crossDomainRun = await execute(crossDomainTask, outCrossDomain, crossDomainDry.json.payload.payloadHash, crossDomainEnv);
  assert.equal(crossDomainRun.json?.state, 'blocked', crossDomainRun.stdout);
  assert.equal(postCount, 0, 'pending intent in another configured journal domain blocks before POST');
  assert.match(JSON.stringify(crossDomainRun.json), /INVENTORY_WRITE_PENDING_CONFLICT/);

  console.log(JSON.stringify({ok: true, checks: ['dry-run zero journal and zero POST', 'production warehouseInventoryList schema is flattened by exact warehouse', 'execute without expected still stock-queries', 'live before row drives locked overwrite', 'zero stock row 0/0/0/0 remains valid baseline', 'intent precedes POST', 'inventoryScope-bound durable success readback', 'terminal same-scope history allows new task', 'explicit nonzero business code terminalizes rejected', 'missing stock row blocks pre-network', 'missing inventory field blocks pre-network', 'ambiguous warehouse blocks pre-network', 'expected inventory drift blocks pre-network', 'pre-network blocked zero POST', 'post-intent transport unknown retained pending', 'pending same-scope blocks new task', 'reconcile-only never re-POSTs', 'cross-domain pending blocks before POST', 'rerun never re-POSTs']}, null, 2));
} finally {
  await new Promise(resolve => server.close(resolve));
  await fs.rm(tmp, {recursive: true, force: true});
}
