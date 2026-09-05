#!/usr/bin/env node
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  appendDurableJournalRecord,
  INVENTORY_MANUAL_RESOLUTION_INTENT_ID,
  inventoryRecoveryScopeKey,
  inventoryWriteScopeKey,
  readInventoryIntentJournals,
  submitDurableInventoryWriteOnce,
} from '../lib/durable_inventory_write.mjs';
import {inventoryCutoverLockFile} from '../lib/inventory_write_cutover.mjs';
import {INVENTORY_LEGACY_LOCKED_ONLY_COMPUTATION_VERSION, stableInventoryHash} from '../lib/inventory_replenishment_policy.mjs';
import {SheinOpenApiClient} from '../lib/shein_openapi_client.mjs';
import {resolveManualInventoryIntent} from './inventory/resolve_manual_inventory_intent.mjs';

const SELF = fileURLToPath(import.meta.url);
// This regression verifies a production Linux absolute lock across cwd
// changes. Run the complete test in Linux instead of interpreting /srv as
// a drive-relative Windows path or weakening that lock-domain assertion.
if (process.platform === 'win32') {
  const linuxSelf = SELF.replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`).replaceAll('\\', '/');
  const result = spawnSync('wsl', ['--exec', '/usr/bin/node', linuxSelf, ...process.argv.slice(2)],
    {stdio: 'inherit', timeout: 60_000, windowsHide: true});
  if (result.error) console.error(result.error.message);
  process.exit(Number.isInteger(result.status) ? result.status : 1);
}
const DEFAULT_LOCK = '/srv/shein-bi/runtime/locks/inventory-v2-cutover.lock';
const scope = {
  storeKey: 'XL', skc: 'sb260606205087254179320', skuCode: 'I0mq2cw2khzt47',
  warehouseCode: 'PS0916742261', invType: 'VI',
};
const now = new Date(Date.now() - 1_000).toISOString();

function cutoverState(journalFile, receiptFile) {
  const authority = {
    capturedAt: now,
    deployedCommit: '5cc31c12476bceed5e670dc49a04e274c976f98e',
    trackedSourceClean: true,
    sourceFingerprint: '1'.repeat(64),
    releaseReceiptKind: 'emergency',
    releaseReceiptHash: '2'.repeat(64),
    releaseReceiptFile: '/var/lib/release.json',
    bundleSha256: '3'.repeat(64),
    writerServices: [{unit: 'shein-bi-portal.service', generationHash: '4'.repeat(64)}],
  };
  return {
    activated: true,
    authority,
    activation: {
      activationHash: '6'.repeat(64), authority,
      requiredManualResolution: {
        intentId: INVENTORY_MANUAL_RESOLUTION_INTENT_ID,
        scopeKey: inventoryWriteScopeKey(scope), journalFile, receiptFile,
      },
    },
    receipt: {receiptHash: '7'.repeat(64)},
  };
}

async function writerChild() {
  const journalFile = process.env.TEST_JOURNAL;
  const receiptFile = process.env.TEST_RECEIPT;
  const resultFile = process.env.TEST_WRITER_RESULT;
  const fetchFile = process.env.TEST_FETCH_CALLS;
  const writerIntent = JSON.parse(await fs.readFile(process.env.TEST_WRITER_INTENT, 'utf8'));
  let fetchCalls = 0;
  const client = new SheinOpenApiClient({
    baseUrl: 'http://127.0.0.1:9', openKeyId: 'test-open', secretKey: 'test-secret',
    inventoryStoreKey: scope.storeKey,
    inventoryJournalFile: journalFile,
    inventoryJournalFiles: [journalFile],
    inventoryJournalDirectories: [path.dirname(journalFile)],
    inventoryCutoverReader: async () => cutoverState(journalFile, receiptFile),
    fetchImpl: async () => {
      fetchCalls += 1;
      await fs.writeFile(fetchFile, String(fetchCalls));
      throw new Error('transport must never run');
    },
  });
  let rejection = '';
  try {
    await submitDurableInventoryWriteOnce({
      journalFile,
      intent: writerIntent,
      inventoryScope: scope,
      assertInventoryAdmission: () => client.assertInventoryFence(
        writerIntent.request.pathname,
        writerIntent.request.method,
        writerIntent.request.body,
        {...scope, requestPayloadHash: writerIntent.requestPayloadHash},
      ),
      submit: () => client.request(writerIntent.request.pathname, {
        method: writerIntent.request.method,
        body: writerIntent.request.body,
        inventoryScope: {...scope, requestPayloadHash: writerIntent.requestPayloadHash},
      }),
      readback: async () => ({totalUsableInventory: 50}),
    });
  } catch (error) {
    rejection = String(error?.message || error);
  }
  await fs.writeFile(resultFile, JSON.stringify({fetchCalls, rejection}));
  if (!/INVENTORY_WRITE_(?:FENCED|FENCE_REQUIRED_EVENT_MISSING)/u.test(rejection) || fetchCalls !== 0) process.exitCode = 1;
}

async function waitFor(file, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fs.stat(file).catch(() => null)) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${file}`);
}

async function parent() {
  delete process.env.SHEIN_BI_INVENTORY_GLOBAL_LOCK_FILE;
  assert.equal(inventoryCutoverLockFile(), DEFAULT_LOCK);
  const originalCwd = process.cwd();
  process.env.SHEIN_BI_RUNTIME_ROOT = '/tmp/runtime-root-must-not-affect-cutover-lock';
  process.chdir(os.tmpdir());
  assert.equal(inventoryCutoverLockFile(), DEFAULT_LOCK,
    'SHEIN_BI_RUNTIME_ROOT and cwd must not fork the inventory cutover lock domain');
  process.chdir(originalCwd);

  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'inventory-default-cutover-lock-'));
  const testLock = path.join(temp, 'inventory-v2-cutover.lock');
  process.env.SHEIN_BI_INVENTORY_GLOBAL_LOCK_FILE = testLock;
  assert.equal(inventoryCutoverLockFile(), testLock,
    'the shared lock remains overridable for an isolated non-root runtime');
  try {
    const journalFile = path.join(temp, 'daily-inventory-replenishment-2026-08-17.json.journal.ndjson');
    const planFile = path.join(temp, 'plan.json');
    const receiptFile = path.join(temp, 'manual.receipt.json');
    const r1 = path.join(temp, 'r1.json');
    const r2 = path.join(temp, 'r2.json');
    const live = path.join(temp, 'live.json');
    const heldFile = path.join(temp, 'resolver-held');
    const writerResult = path.join(temp, 'writer-result.json');
    const fetchFile = path.join(temp, 'fetch-calls');
    const writerIntentFile = path.join(temp, 'writer-intent.json');
    const planHash = 'c'.repeat(64);
    const logicalActionKey = stableInventoryHash({
      runDate: '2026-08-17', store: scope.storeKey, skc: scope.skc, sku: scope.skuCode, target: 100,
      actionType: 'VI_OVERWRITE_TO_EXACT_USABLE_TARGET', policyVersion: '2026-08-26-test',
      authorizationId: 'owner-manual-resolution-test',
    });
    const request = {
      pathname: '/open-api/stock/change-inventory/v2', method: 'POST',
      body: {updateSkuInventoryQuantityRequests: [{
        idempotencyKey: `bi-inv-${logicalActionKey.slice(0, 42)}`, skuCode: scope.skuCode,
        invType: 'VI', changeType: 'OVERWRITE', changeQuantity: 101,
        changeReason: 'Owner-authorized daily inventory target after current-day ET and sales/exposure guard',
      }]}, headers: {language: 'en'},
    };
    const historicalIntent = {
      kind: 'intent', intentId: INVENTORY_MANUAL_RESOLUTION_INTENT_ID, logicalActionKey,
      recoveryScopeKey: inventoryRecoveryScopeKey({runDate: '2026-08-17', storeKey: scope.storeKey, skc: scope.skc, skuCode: scope.skuCode}),
      planHash, runDate: '2026-08-17', storeKey: scope.storeKey, skc: scope.skc, skuCode: scope.skuCode,
      targetUsableInventory: 100, policyVersion: '2026-08-26-test',
      overwriteComputationVersion: INVENTORY_LEGACY_LOCKED_ONLY_COMPUTATION_VERSION,
      authorizationId: 'owner-manual-resolution-test',
      idempotencyKey: request.body.updateSkuInventoryQuantityRequests[0].idempotencyKey,
      requestPayloadHash: stableInventoryHash(request), request,
      before: {totalInventoryQuantity: 74, totalUsableInventory: 49, totalLockedQuantity: 1, stockRowMissing: false},
      recordedAt: '2026-08-17T08:00:00.000Z',
    };
    await appendDurableJournalRecord(journalFile, historicalIntent);
    const deferredIds = [];
    for (let index = 0; index < 27; index += 1) {
      const deferredSku = `deferred-sku-${String(index + 1).padStart(2, '0')}`;
      const deferredStore = `D${String(index + 1).padStart(2, '0')}`;
      const deferredSkc = `deferred-skc-${index + 1}`;
      const deferredLogical = stableInventoryHash({
        runDate: '2026-08-17', store: deferredStore, skc: deferredSkc, sku: deferredSku, target: 100,
        actionType: 'VI_OVERWRITE_TO_EXACT_USABLE_TARGET', policyVersion: '2026-08-26-test',
        authorizationId: 'owner-manual-resolution-test',
      });
      const deferredRequest = {
        pathname: request.pathname, method: request.method, headers: request.headers,
        body: {updateSkuInventoryQuantityRequests: [{
          ...request.body.updateSkuInventoryQuantityRequests[0],
          idempotencyKey: `bi-inv-${deferredLogical.slice(0, 42)}`,
          skuCode: deferredSku,
        }]},
      };
      const deferredId = `deferred-historical-${String(index + 1).padStart(2, '0')}`;
      deferredIds.push(deferredId);
      await appendDurableJournalRecord(journalFile, {
        ...historicalIntent,
        intentId: deferredId,
        logicalActionKey: deferredLogical,
        recoveryScopeKey: inventoryRecoveryScopeKey({
          runDate: '2026-08-17', storeKey: deferredStore,
          skc: deferredSkc, skuCode: deferredSku,
        }),
        storeKey: deferredStore,
        skc: deferredSkc,
        skuCode: deferredSku,
        idempotencyKey: deferredRequest.body.updateSkuInventoryQuantityRequests[0].idempotencyKey,
        requestPayloadHash: stableInventoryHash(deferredRequest),
        request: deferredRequest,
      });
    }
    const deferredBefore = new Map([...(await readInventoryIntentJournals([journalFile], {allowMultiplePendingByScope: true})).pending
      .values()].filter(rowValue => deferredIds.includes(rowValue.intentId))
      .map(rowValue => [rowValue.intentId, stableInventoryHash(rowValue)]));
    assert.equal(deferredBefore.size, 27);

    const writerRequest = {
      pathname: request.pathname, method: request.method, headers: request.headers,
      body: {updateSkuInventoryQuantityRequests: [{
        ...request.body.updateSkuInventoryQuantityRequests[0],
        idempotencyKey: `bi-inv-${stableInventoryHash({
          runDate: '2026-08-17', store: scope.storeKey, skc: scope.skc, sku: scope.skuCode, target: 90,
          actionType: 'VI_OVERWRITE_TO_EXACT_USABLE_TARGET', policyVersion: '2026-08-26-test',
          authorizationId: 'owner-manual-resolution-test',
        }).slice(0, 42)}`,
        changeQuantity: 91,
      }]},
    };
    const writerIntent = {
      ...historicalIntent,
      intentId: 'new-writer-intent-must-never-append',
      logicalActionKey: stableInventoryHash({
        runDate: '2026-08-17', store: scope.storeKey, skc: scope.skc, sku: scope.skuCode, target: 90,
        actionType: 'VI_OVERWRITE_TO_EXACT_USABLE_TARGET', policyVersion: '2026-08-26-test',
        authorizationId: 'owner-manual-resolution-test',
      }),
      targetUsableInventory: 90,
      idempotencyKey: writerRequest.body.updateSkuInventoryQuantityRequests[0].idempotencyKey,
      requestPayloadHash: stableInventoryHash(writerRequest),
      request: writerRequest,
      recordedAt: new Date().toISOString(),
    };
    await fs.writeFile(writerIntentFile, JSON.stringify(writerIntent));
    await fs.writeFile(planFile, JSON.stringify({payloadHash: planHash}));
    const row = {...scope, totalInventoryQuantity: 50, totalUsableInventory: 49, totalLockedQuantity: 1, temporaryInventoryQuantity: 0};
    await fs.writeFile(r1, JSON.stringify({code: 0, msg: 'OK', traceId: 'r1', generatedAt: now, rows: [row]}));
    await fs.writeFile(r2, JSON.stringify({code: 0, msg: 'OK', traceId: 'r2', generatedAt: now, rows: [row]}));
    await fs.writeFile(live, JSON.stringify({source: 'default-lock-test', capturedAt: now, scope: {...scope, scopeKey: inventoryWriteScopeKey(scope)}, ...row}));
    const inputs = {
      journalFile, planFile, receiptFile, readbackArtifacts: [r1, r2], liveInventoryBaseline: live,
      ownerActor: 'owner-20260827', ownerConfirmation: 'MANUAL_BASELINE_ADOPTED_EFFECT_UNKNOWN',
      originalResponse: {code: '0', traceId: 'original'}, additionalJournalDirectories: [], now,
      requireKnownEvidence: false, evidenceContract: [],
      cutoverReader: async () => cutoverState(journalFile, receiptFile),
      maintenanceReader: async () => ({ok: true, active: true, mode: 'all', generation: 9, hash: '5'.repeat(64)}),
    };
    const dryRun = await resolveManualInventoryIntent({...inputs, mode: 'dry-run'});

    const spawnWriter = async (resultFile, extraEnv = {}) => {
      const child = spawn(process.execPath, [SELF, '--writer-child'], {
        env: {
          ...process.env, ...extraEnv,
          TEST_JOURNAL: journalFile, TEST_RECEIPT: receiptFile,
          TEST_WRITER_RESULT: resultFile, TEST_FETCH_CALLS: fetchFile,
          TEST_WRITER_INTENT: writerIntentFile,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return {child, done: new Promise((resolve, reject) => {
        let stderr = '';
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve(code) : reject(new Error(`writer child exit=${code}:${stderr}`)));
      })};
    };

    const writerFirstResult = path.join(temp, 'writer-first-result.json');
    const writerFirst = await spawnWriter(writerFirstResult);
    await writerFirst.done;
    const writerFirstReadback = JSON.parse(await fs.readFile(writerFirstResult, 'utf8'));
    assert.equal(writerFirstReadback.fetchCalls, 0);
    assert.match(writerFirstReadback.rejection, /INVENTORY_WRITE_FENCE_REQUIRED_EVENT_MISSING/);
    let beforeResolutionBundle = await readInventoryIntentJournals([journalFile], {allowMultiplePendingByScope: true});
    assert.equal(beforeResolutionBundle.pending.size, 28, 'pre-resolution writer must not append a 29th pending intent');
    assert.equal([...beforeResolutionBundle.pending.values()].some(rowValue => rowValue.intentId === writerIntent.intentId), false);

    let releaseHook;
    const gate = new Promise(resolve => { releaseHook = resolve; });
    const resolver = resolveManualInventoryIntent({
      ...inputs, mode: 'execute', expectedPreflightHash: dryRun.preflightHash,
      beforeAppendHook: async () => { await fs.writeFile(heldFile, 'held'); await gate; },
    });
    await waitFor(heldFile);
    const {child, done: childDone} = await spawnWriter(writerResult);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(await fs.stat(writerResult).catch(() => null), null,
      'writer must remain blocked behind the resolver cutover lock');
    assert.equal(await fs.stat(fetchFile).catch(() => null), null,
      'writer transport must not run while resolver owns the lock');
    releaseHook();
    const resolved = await resolver;
    const childExit = await childDone;
    assert.equal(childExit, 0);
    assert.equal(resolved.sheinPostCount, 0);
    const writer = JSON.parse(await fs.readFile(writerResult, 'utf8'));
    assert.equal(writer.fetchCalls, 0);
    assert.match(writer.rejection, /INVENTORY_WRITE_FENCED/u);
    const lines = (await fs.readFile(journalFile, 'utf8')).trim().split(/\r?\n/u).map(JSON.parse);
    assert.equal(lines.filter(rowValue => rowValue.kind === 'manual_resolution').length, 1);
    const terminalBundle = await readInventoryIntentJournals([journalFile], {allowMultiplePendingByScope: true});
    assert.equal(terminalBundle.pending.size, 27, 'resolver terminalizes only XL and writer never adds pending');
    assert.equal([...terminalBundle.pending.values()].some(rowValue => rowValue.intentId === writerIntent.intentId), false);
    const deferredAfter = new Map([...terminalBundle.pending.values()]
      .filter(rowValue => deferredIds.includes(rowValue.intentId))
      .map(rowValue => [rowValue.intentId, stableInventoryHash(rowValue)]));
    assert.deepEqual(deferredAfter, deferredBefore, 'all 27 deferred historical intents remain byte-semantic unchanged');
    console.log(JSON.stringify({
      ok: true,
      defaultLock: DEFAULT_LOCK,
      checks: [
        'runtime_root_and_cwd_do_not_change_default_lock',
        'resolver_and_writer_use_one_global_lock_without_explicit_lock_argument',
        'cross_process_writer_waits_until_resolver_append_and_receipt',
        'writer_first_is_rejected_before_append_when_required_resolution_is_missing',
        'resolver_first_holds_lock_through_terminal_append_then_writer_is_fenced_before_append',
        'pending_set_never_increases_and_exactly_27_deferred_intents_remain_unchanged',
        'fresh_writer_read_sees_permanent_fence',
        'fetch_calls_zero',
      ],
    }, null, 2));
  } finally {
    await fs.rm(temp, {recursive: true, force: true});
  }
}

if (process.argv.includes('--writer-child')) await writerChild();
else await parent();
