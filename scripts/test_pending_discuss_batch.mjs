#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  buildPreflightDocument,
  buildScanDocument,
  normalizePendingDiscussRow,
  sha256Json,
  stableStringify,
  verifyPreflightDocument,
} from '../lib/pending_discuss_batch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await fs.mkdir(path.join(ROOT, 'tmp'), {recursive: true});
const temp = await fs.mkdtemp(path.join(ROOT, 'tmp', 'pending-discuss-batch-'));

function sendJson(response, value, status = 200) {
  response.writeHead(status, {'Content-Type': 'application/json'});
  response.end(JSON.stringify(value));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (error) { reject(error); }
    });
    request.on('error', reject);
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function writeJson(name, value) {
  const file = path.join(temp, name);
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}

function runCli(args, extraEnv = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['scripts/pending_discuss_batch.mjs', ...args], {
      cwd: ROOT, env: {...process.env, ...extraEnv}, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => {
      let json = null;
      try { json = stdout.trim() ? JSON.parse(stdout) : null; } catch {}
      resolve({code, stdout, stderr, json});
    });
  });
}

function row({discussSn, supplierCode, status = 1, price = 10, currency = 'SAR', storeSuffix = ''}) {
  return {
    discussSn, discussStatus: status, discussType: 0, supplierCode,
    skcName: `SKC-${discussSn}${storeSuffix}`, spuName: `SPU-${discussSn}`,
    productTitle: `Product ${discussSn}`, appealReason: `reason-${discussSn}`,
    appealCount: 3, serialNumber: 1,
    skuCostPrices: [{
      skuCode: `SKU-${discussSn}`, suggestCostPrice: price, suggestCostCurrency: currency,
      latestCostPrice: price + 2,
      costPriceHistories: [{serialNumber: 1, costPrice: price + 2, currency}],
    }],
  };
}

async function hashFile(file) {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

async function assertManifest(outDir) {
  const manifest = JSON.parse(await fs.readFile(path.join(outDir, 'manifest.json'), 'utf8'));
  assert.ok(manifest.artifacts.length >= 1);
  for (const artifact of manifest.artifacts) {
    const file = path.join(outDir, artifact.name);
    assert.equal(await hashFile(file), artifact.sha256, `${artifact.name} sha256`);
    assert.equal((await fs.stat(file)).size, artifact.bytes, `${artifact.name} bytes`);
  }
  return manifest;
}

function commonArgs({config, storesConfig, truth}) {
  return [
    '--config', config, '--stores-config', storesConfig, '--store-truth', truth,
    '--expected-store-count', '2', '--page-size', '1', '--read-attempts', '3',
    '--read-delay-ms', '1', '--request-timeout-ms', '3000',
    '--terminal-attempts', '3', '--terminal-delay-ms', '1',
  ];
}

// Pure invariants: canonical JSON, (全) normalization, duplicate detection,
// decision exactness, expiry, and source drift.
assert.equal(stableStringify({b: 1, a: [2, {d: 4, c: 3}]}), stableStringify({a: [2, {c: 3, d: 4}], b: 1}));
assert.equal(sha256Json({b: 1, a: 2}), sha256Json({a: 2, b: 1}));
assert.throws(() => stableStringify({bad: undefined}), /rejects undefined/);
const normalized = normalizePendingDiscussRow('a', row({discussSn: 'N1', supplierCode: '(全)SK-7027绞肉机'}));
assert.equal(normalized.canonicalGoodsSn, 'SK-7027绞肉机');
const duplicateScan = buildScanDocument({
  businessDate: '2026-08-11', expectedStores: ['A'],
  storeResults: [{storeKey: 'A', ok: true, identity: {ok: true}, rows: [normalized, normalized]}],
});
assert.equal(duplicateScan.ok, false);
assert.deepEqual(duplicateScan.duplicateKeys, ['A::N1']);
const pureScan = buildScanDocument({
  businessDate: '2026-08-11', expectedStores: ['A'],
  storeResults: [{storeKey: 'A', ok: true, identity: {ok: true}, rows: [normalized]}],
});
assert.throws(() => buildPreflightDocument({
  scan: pureScan,
  decisions: {schemaVersion: 1, businessDate: '2026-08-11', decisions: [
    {canonicalGoodsSn: normalized.canonicalGoodsSn, action: 'accept'},
    {canonicalGoodsSn: normalized.canonicalGoodsSn, action: 'reject'},
  ]}, sourceHashes: {source: 'x'},
}), /duplicate or conflicting/);
assert.throws(() => buildPreflightDocument({
  scan: pureScan,
  decisions: {schemaVersion: 1, businessDate: '2026-08-11', decisions: [{canonicalGoodsSn: 'NO-SUCH-GOODS', action: 'reject'}]},
  sourceHashes: {source: 'x'},
}), /matched no current/);
const emptyPriceRow = normalizePendingDiscussRow('A', {...row({discussSn: 'EMPTY-PRICE', supplierCode: 'ZZ-EMPTY-PRICE测试'}), skuCostPrices: []});
const emptyPriceScan = buildScanDocument({
  businessDate: '2026-08-11', expectedStores: ['A'],
  storeResults: [{storeKey: 'A', ok: true, identity: {ok: true}, rows: [emptyPriceRow]}],
});
assert.throws(() => buildPreflightDocument({
  scan: emptyPriceScan,
  decisions: {schemaVersion: 1, businessDate: '2026-08-11', decisions: [{canonicalGoodsSn: emptyPriceRow.canonicalGoodsSn, action: 'accept'}]},
  sourceHashes: {source: 'x'},
}), /accept price evidence is empty/);
const purePreflight = buildPreflightDocument({
  scan: pureScan,
  decisions: {schemaVersion: 1, businessDate: '2026-08-11', decisions: [{canonicalGoodsSn: normalized.canonicalGoodsSn, action: 'accept'}]},
  sourceHashes: {source: 'x'}, generatedAt: '2026-08-11T00:00:00Z', expiresAt: '2026-08-11T00:15:00Z',
});
assert.equal(verifyPreflightDocument(purePreflight, {businessDate: '2026-08-11', now: '2026-08-11T00:16:00Z', sourceHashes: {source: 'x'}, batchHash: purePreflight.batchHash}).ok, false);
assert.ok(verifyPreflightDocument(purePreflight, {businessDate: '2026-08-11', now: '2026-08-11T00:01:00Z', sourceHashes: {source: 'drift'}, batchHash: purePreflight.batchHash}).blockers.some(item => item.code === 'SOURCE_HASH_DRIFT'));

const port = await freePort();
const state = {
  rows: {A: [], B: []},
  identityOverride: {},
  readFailures: new Map(),
  writes: [],
  processBehavior: new Map(),
  transitions: new Map(),
};
const keyByOpenId = {'DUMMY-OPEN-A': 'A', 'DUMMY-OPEN-B': 'B'};
const identityByStore = {
  A: {merchantId: 'merchant-a', accountNo: 'GS-A'},
  B: {merchantId: 'merchant-b', accountNo: 'GS-B'},
};

function applyTransitionsForStatus(store, status) {
  for (const [discussSn, transition] of [...state.transitions.entries()]) {
    if (transition.store !== store || transition.status !== status) continue;
    if (transition.remainingQueries > 0) {
      transition.remainingQueries -= 1;
      continue;
    }
    const target = state.rows[store].find(item => item.discussSn === discussSn);
    if (target) {
      target.discussStatus = transition.status;
      if (transition.status === 3) {
        target.skuCostPrices = target.skuCostPrices.map(sku => ({
          ...sku, latestCostPrice: sku.suggestCostPrice,
          costPriceHistories: [...(sku.costPriceHistories || []), {
            serialNumber: 2, costPrice: sku.suggestCostPrice, currency: sku.suggestCostCurrency,
          }],
        }));
      }
    }
    state.transitions.delete(discussSn);
  }
}

const server = http.createServer(async (request, response) => {
  const key = keyByOpenId[String(request.headers['x-lt-openkeyid'] || '')] || '';
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  const body = await readBody(request);
  if (url.pathname === '/open-api/openapi-business-backend/query-store-info') {
    const identity = state.identityOverride[key] || identityByStore[key];
    return sendJson(response, {code: '0', msg: 'OK', info: identity});
  }
  if (url.pathname === '/open-api/goods/discuss/query-discuss-list') {
    const failureKey = `${key}:${body.discussStatus}:${body.pageNum}`;
    const failures = state.readFailures.get(failureKey) || [];
    if (failures.length) {
      const status = failures.shift();
      return sendJson(response, {code: String(status), msg: status === 429 ? 'rate limit' : 'temporarily unavailable'}, status);
    }
    applyTransitionsForStatus(key, Number(body.discussStatus));
    const all = (state.rows[key] || []).filter(item => Number(item.discussStatus) === Number(body.discussStatus));
    const start = (Number(body.pageNum) - 1) * Number(body.pageSize);
    const page = all.slice(start, start + Number(body.pageSize));
    const info = key === 'A' ? {count: all.length, records: page} : {totalCount: all.length, data: page};
    return sendJson(response, {code: '0', msg: 'OK', info});
  }
  if (url.pathname === '/open-api/goods/discuss/process-discuss') {
    const confirm = body?.confirmInfos?.[0] || {};
    state.writes.push({store: key, discussSn: confirm.discussSn, type: confirm.discussAuditType});
    const behavior = state.processBehavior.get(confirm.discussSn) || {kind: 'normal'};
    if (behavior.kind === 'fail') return sendJson(response, {code: '50001', msg: 'rejected', info: {successCount: 0, failCount: 1}});
    if (behavior.kind !== 'no-terminal') {
      const targetStatus = confirm.discussAuditType === '1' ? 3 : 4;
      state.transitions.set(confirm.discussSn, {store: key, status: targetStatus, remainingQueries: behavior.delayQueries || 0});
    }
    return sendJson(response, {code: '0', msg: 'OK', info: {successCount: 1, failCount: 0}});
  }
  return sendJson(response, {code: '404', msg: 'unhandled'}, 404);
});
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));

try {
  const config = await writeJson('openapi.json', {
    apiBaseUrls: {prodSemiManaged: `http://127.0.0.1:${port}`},
    stores: [
      {storeKey: 'A', enabled: true, merchantId: 'merchant-a', accountNo: 'GS-A', openKeyId: 'DUMMY-OPEN-A', secretKey: 'DUMMY-SECRET-A-NEVER-LEAK'},
      {storeKey: 'B', enabled: true, merchantId: 'merchant-b', accountNo: 'GS-B', openKeyId: 'DUMMY-OPEN-B', secretKey: 'DUMMY-SECRET-B-NEVER-LEAK'},
    ],
    safeWriteOperations: {
      enabled: true,
      requireDryRun: true,
      allowedOperations: ['process_pending_discuss'],
      allowedStores: ['A', 'B'],
    },
  });
  const storesConfig = await writeJson('stores.json', {stores: [{storeKey: 'A', enabled: true}, {storeKey: 'B', enabled: true}]});
  const truth = await writeJson('truth.json', {stores: identityByStore});
  const common = commonArgs({config, storesConfig, truth});
  const businessDate = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date());

  // Explicit zero result is success only with complete 2/2 coverage.
  const zeroDir = path.join(temp, 'zero');
  const zero = await runCli(['scan', '--out-dir', zeroDir, ...common]);
  assert.equal(zero.code, 0, zero.stderr || zero.stdout);
  const zeroScan = JSON.parse(await fs.readFile(path.join(zeroDir, 'scan.json'), 'utf8'));
  assert.equal(zeroScan.ok, true);
  assert.equal(zeroScan.rowCount, 0);
  assert.equal(zeroScan.coverage.succeededCount, 2);
  await assertManifest(zeroDir);

  state.rows.A = [
    row({discussSn: 'D-7027', supplierCode: '(全)SK-7027绞肉机', price: 9}),
    row({discussSn: 'D-1713', supplierCode: '(全)SK-1713-4手持搅拌器', price: 11}),
  ];
  state.rows.B = [row({discussSn: 'D-03012', supplierCode: '(全)SK-03012台式榨汁机', price: 13})];
  state.readFailures.set('A:1:1', [429]);
  state.readFailures.set('B:1:1', [504]);
  const scanDir = path.join(temp, 'scan');
  const scanRun = await runCli(['scan', '--out-dir', scanDir, ...common]);
  assert.equal(scanRun.code, 0, scanRun.stderr || scanRun.stdout);
  const scanDoc = JSON.parse(await fs.readFile(path.join(scanDir, 'scan.json'), 'utf8'));
  assert.equal(scanDoc.rowCount, 3);
  assert.equal(scanDoc.coverage.succeededCount, 2);
  assert.equal(scanDoc.stores.find(item => item.storeKey === 'A').pages, 2);
  assert.ok(scanDoc.stores.find(item => item.storeKey === 'A').attempts >= 4, '429 must add a read attempt');
  assert.ok(scanDoc.stores.find(item => item.storeKey === 'B').attempts >= 3, '504 must add a read attempt');
  await assertManifest(scanDir);

  // Identity drift fails one store without turning the missing store into zero.
  state.identityOverride.B = {merchantId: 'wrong-merchant', accountNo: 'WRONG'};
  const driftDir = path.join(temp, 'identity-drift');
  const driftRun = await runCli(['scan', '--out-dir', driftDir, ...common]);
  assert.equal(driftRun.code, 3);
  const driftScan = JSON.parse(await fs.readFile(path.join(driftDir, 'scan.json'), 'utf8'));
  assert.equal(driftScan.ok, false);
  assert.deepEqual(driftScan.coverage.failedStores, ['B']);
  assert.equal(driftScan.rowCount, 2);
  assert.doesNotMatch(await fs.readFile(path.join(driftDir, 'scan.json'), 'utf8'), /wrong-merchant|DUMMY-SECRET|DUMMY-OPEN/);
  delete state.identityOverride.B;

  const decisions = await writeJson('decisions.json', {
    schemaVersion: 1, businessDate,
    decisions: [
      {canonicalGoodsSn: 'SK-7027绞肉机', action: 'reject'},
      {canonicalGoodsSn: 'SK-1713-4手持搅拌器', action: 'accept'},
      {canonicalGoodsSn: 'SK-03012台式榨汁机', action: 'reject'},
    ],
  });
  const preflightDir = path.join(temp, 'preflight');
  const preflightRun = await runCli(['preflight', '--decisions', decisions, '--out-dir', preflightDir, ...common]);
  assert.equal(preflightRun.code, 0, preflightRun.stderr || preflightRun.stdout);
  const preflight = JSON.parse(await fs.readFile(path.join(preflightDir, 'preflight.json'), 'utf8'));
  assert.equal(preflight.itemCount, 3);
  assert.equal(preflight.stores.length, 2);
  assert.ok(preflight.stores.every(store => /^[a-f0-9]{64}$/.test(store.payloadHash)));
  assert.match(preflight.batchHash, /^[a-f0-9]{64}$/);
  await assertManifest(preflightDir);

  // A preflight may be prepared while the physical write gate is closed, but
  // execute must refuse before any process-discuss call.
  const blockedConfig = await writeJson('openapi-blocked.json', {
    apiBaseUrls: {prodSemiManaged: `http://127.0.0.1:${port}`},
    stores: [
      {storeKey: 'A', enabled: true, merchantId: 'merchant-a', accountNo: 'GS-A', openKeyId: 'DUMMY-OPEN-A', secretKey: 'DUMMY-SECRET-A-NEVER-LEAK'},
      {storeKey: 'B', enabled: true, merchantId: 'merchant-b', accountNo: 'GS-B', openKeyId: 'DUMMY-OPEN-B', secretKey: 'DUMMY-SECRET-B-NEVER-LEAK'},
    ],
    safeWriteOperations: {enabled: false, requireDryRun: true, allowedOperations: [], allowedStores: []},
  });
  const blockedCommon = commonArgs({config: blockedConfig, storesConfig, truth});
  const blockedPreDir = path.join(temp, 'preflight-safe-gate-blocked');
  assert.equal((await runCli(['preflight', '--decisions', decisions, '--out-dir', blockedPreDir, ...blockedCommon])).code, 0);
  const blockedPreflight = JSON.parse(await fs.readFile(path.join(blockedPreDir, 'preflight.json'), 'utf8'));
  state.writes.length = 0;
  const blockedExecDir = path.join(temp, 'execute-safe-gate-blocked');
  const blockedExecute = await runCli([
    'execute', '--preflight', path.join(blockedPreDir, 'preflight.json'), '--batch-hash', blockedPreflight.batchHash,
    '--confirm', 'SHEIN_PENDING_DISCUSS_BATCH_EXECUTE', '--lock-path', path.join(temp, 'write-blocked.lock'),
    '--out-dir', blockedExecDir, ...blockedCommon,
  ], {SHEIN_PENDING_DISCUSS_WRITE_ENABLED: '1'});
  assert.equal(blockedExecute.code, 3);
  const blockedExecution = JSON.parse(await fs.readFile(path.join(blockedExecDir, 'execution.json'), 'utf8'));
  assert.ok(blockedExecution.blockers.some(item => item.code === 'SAFE_WRITE_GATE_DISABLED'));
  assert.equal(state.writes.length, 0);

  // Serial success: reject -> accept with one delayed terminal -> reject.
  state.writes.length = 0;
  state.processBehavior.clear();
  state.processBehavior.set('D-1713', {kind: 'normal', delayQueries: 1});
  const executeDir = path.join(temp, 'execute-success');
  const execute = await runCli([
    'execute', '--preflight', path.join(preflightDir, 'preflight.json'),
    '--batch-hash', preflight.batchHash, '--confirm', 'SHEIN_PENDING_DISCUSS_BATCH_EXECUTE',
    '--lock-path', path.join(temp, 'write-success.lock'), '--out-dir', executeDir, ...common,
  ], {SHEIN_PENDING_DISCUSS_WRITE_ENABLED: '1'});
  assert.equal(execute.code, 0, execute.stderr || execute.stdout);
  const execution = JSON.parse(await fs.readFile(path.join(executeDir, 'execution.json'), 'utf8'));
  assert.equal(execution.ok, true);
  assert.equal(execution.executed.length, 3);
  assert.equal(execution.finalScan.rowCount, 0);
  assert.deepEqual(state.writes.map(item => item.discussSn), ['D-1713', 'D-7027', 'D-03012']);
  const accepted = execution.executed.find(item => item.discussSn === 'D-1713');
  assert.equal(accepted.terminalStatus, 3);
  assert.equal(accepted.terminalPriceProven, true);
  assert.ok(accepted.polls.length >= 2, 'delayed terminal must be polled');
  assert.equal(execution.executed.find(item => item.discussSn === 'D-7027').terminalStatus, 4);
  await assertManifest(executeDir);

  // A write acknowledgement without terminal proof is uncertain and is never retried.
  state.rows.A = [row({discussSn: 'D-NO-TERMINAL', supplierCode: 'ZZ-NO-TERMINAL测试', price: 20})];
  state.rows.B = [];
  state.transitions.clear();
  state.writes.length = 0;
  state.processBehavior.clear();
  state.processBehavior.set('D-NO-TERMINAL', {kind: 'no-terminal'});
  const noTerminalCanonical = normalizePendingDiscussRow('A', state.rows.A[0]).canonicalGoodsSn;
  const noTerminalDecisions = await writeJson('decisions-no-terminal.json', {schemaVersion: 1, businessDate, decisions: [{canonicalGoodsSn: noTerminalCanonical, action: 'reject'}]});
  const noTerminalPreDir = path.join(temp, 'preflight-no-terminal');
  assert.equal((await runCli(['preflight', '--decisions', noTerminalDecisions, '--out-dir', noTerminalPreDir, ...common])).code, 0);
  const noTerminalPre = JSON.parse(await fs.readFile(path.join(noTerminalPreDir, 'preflight.json'), 'utf8'));
  const noTerminalDir = path.join(temp, 'execute-no-terminal');
  const noTerminalRun = await runCli([
    'execute', '--preflight', path.join(noTerminalPreDir, 'preflight.json'), '--batch-hash', noTerminalPre.batchHash,
    '--confirm', 'SHEIN_PENDING_DISCUSS_BATCH_EXECUTE', '--lock-path', path.join(temp, 'write-no-terminal.lock'),
    '--terminal-attempts', '2', '--out-dir', noTerminalDir, ...common,
  ], {SHEIN_PENDING_DISCUSS_WRITE_ENABLED: '1'});
  assert.equal(noTerminalRun.code, 3);
  const noTerminalExecution = JSON.parse(await fs.readFile(path.join(noTerminalDir, 'execution.json'), 'utf8'));
  assert.equal(noTerminalExecution.uncertain.length, 1);
  assert.equal(noTerminalExecution.uncertain[0].status, 'submitted_readback_pending');
  assert.equal(state.writes.filter(item => item.discussSn === 'D-NO-TERMINAL').length, 1);

  // A definitive first write failure stops all later stores and does not retry.
  state.rows.A = [row({discussSn: 'D-FAIL-FIRST', supplierCode: 'ZZ-FAIL-FIRST测试', price: 21})];
  state.rows.B = [row({discussSn: 'D-MUST-NOT-WRITE', supplierCode: 'ZZ-LATER测试', price: 22})];
  state.transitions.clear();
  state.writes.length = 0;
  state.processBehavior.clear();
  state.processBehavior.set('D-FAIL-FIRST', {kind: 'fail'});
  const failCanonical = normalizePendingDiscussRow('A', state.rows.A[0]).canonicalGoodsSn;
  const laterCanonical = normalizePendingDiscussRow('B', state.rows.B[0]).canonicalGoodsSn;
  const failDecisions = await writeJson('decisions-fail.json', {schemaVersion: 1, businessDate, decisions: [
    {canonicalGoodsSn: failCanonical, action: 'reject'}, {canonicalGoodsSn: laterCanonical, action: 'accept'},
  ]});
  const failPreDir = path.join(temp, 'preflight-fail');
  assert.equal((await runCli(['preflight', '--decisions', failDecisions, '--out-dir', failPreDir, ...common])).code, 0);
  const failPre = JSON.parse(await fs.readFile(path.join(failPreDir, 'preflight.json'), 'utf8'));
  const failExecDir = path.join(temp, 'execute-fail');
  const failRun = await runCli([
    'execute', '--preflight', path.join(failPreDir, 'preflight.json'), '--batch-hash', failPre.batchHash,
    '--confirm', 'SHEIN_PENDING_DISCUSS_BATCH_EXECUTE', '--lock-path', path.join(temp, 'write-fail.lock'),
    '--out-dir', failExecDir, ...common,
  ], {SHEIN_PENDING_DISCUSS_WRITE_ENABLED: '1'});
  assert.equal(failRun.code, 3);
  const failExecution = JSON.parse(await fs.readFile(path.join(failExecDir, 'execution.json'), 'utf8'));
  assert.equal(failExecution.failed.length, 1);
  assert.equal(failExecution.notAttempted.length, 1);
  assert.deepEqual(state.writes.map(item => item.discussSn), ['D-FAIL-FIRST']);

  // Every artifact is sanitized; config credentials never appear in evidence.
  const evidenceFiles = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.name.endsWith('.json') && path.dirname(file) !== temp) evidenceFiles.push(file);
    }
  }
  await walk(temp);
  const evidenceText = (await Promise.all(evidenceFiles.map(file => fs.readFile(file, 'utf8')))).join('\n');
  assert.doesNotMatch(evidenceText, /DUMMY-SECRET-A-NEVER-LEAK|DUMMY-SECRET-B-NEVER-LEAK|DUMMY-OPEN-A|DUMMY-OPEN-B/);

  console.log(JSON.stringify({
    ok: true,
    checks: {
      zeroCoverage: true, paginationAndReadRetry: true, normalization: true,
      duplicateAndIdentityDrift: true, preflightHashes: true, sourceAndExpiryDrift: true, safeWriteGate: true,
      acceptRejectTerminal: true, acceptWithoutPriceBlocked: true, delayedTerminal: true, uncertainWriteNoRetry: true,
      stopAfterWriteFailure: true, artifactHashesAndRedaction: true,
    },
  }, null, 2));
} finally {
  await new Promise(resolve => server.close(resolve));
  await fs.rm(temp, {recursive: true, force: true}).catch(() => {});
}
