#!/usr/bin/env node
import assert from 'node:assert/strict';

process.env.SHEIN_LINK_OPS_EXECUTOR_SELF_TEST = '1';

const {__testHooks} = await import('./link_ops_hl_openapi_executor.mjs');
const {applySafeDefaults, resolvePreflightProductLock} = __testHooks;

const expectedHash = '2a08ba28b1819d9b4610fa1bbf5cb73e2a350944999a29f8c61c82b8935889dc';
const driftedHash = '2c31240bdd232598403e744f637318534c07beed54efb5bc147892bcc231e1f9';
const historySourceDetailLock = {
  source: 'openapi_product_detail_snapshot',
  matchedSpuName: 'v2508286965054030',
  matchedSkcName: 'sv25082869650540305',
  detailFetchedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  detailContentSha256: 'a'.repeat(64),
};

const task = {
  id: 'lot_preflight_lock_smoke',
  status: 'waiting_review',
  execution: {
    state: 'blocked',
    preflight: {ok: false},
    openApiProductExecutors: [{
      storeKey: 'TZ',
      state: 'blocked',
      payload: {
        payloadHash: driftedHash,
        payloadHashAlgorithm: 'sha256-stable-json-scope-v4',
        summary: {hopeOnSaleDate: '2036-07-12 10:00:00'},
        inferredSource: {sourceStore: 'YJ', sourceSkc: 'sv260211111931313305907'},
      },
    }],
  },
  history: [{
    at: '2026-07-11T11:02:03.466Z',
    event: 'openapi_product_preflight_ready',
    runId: 'lor_preflight_lock_smoke',
    writeAudit: {
      executorEvidence: [{
        storeKey: 'TZ',
        state: 'ready_for_submit',
        ok: true,
        payloadHash: expectedHash,
        payloadHashAlgorithm: 'sha256-stable-json-scope-v4',
        payloadSummary: {hopeOnSaleDate: '2036-07-11 10:00:00'},
        payload: {
          sourceDetailLock: historySourceDetailLock,
        },
        readbackFingerprint: {
          inferredSourceStore: 'QY',
          inferredSourceSkc: 'sv25082869650540305',
        },
      }],
    },
  }],
};

const lock = resolvePreflightProductLock(task, 'TZ', {expectedPayloadHash: expectedHash});
assert.ok(lock, 'expected preflight lock should be recoverable from successful history');
assert.equal(lock.sourceStore, 'QY');
assert.equal(lock.sourceSkc, 'sv25082869650540305');
assert.equal(lock.hopeOnSaleDate, '2036-07-11 10:00:00');
assert.equal(lock.payloadHash, expectedHash);
assert.equal(lock.payloadHashAlgorithm, 'sha256-stable-json-scope-v4');
assert.deepEqual(lock.sourceDetailLock, historySourceDetailLock);
assert.equal(resolvePreflightProductLock(task, 'TZ', {expectedPayloadHash: 'f'.repeat(64)}), null);

// A v3 row missing sourceDetailLock, a v2 row, or an algorithm-less row is not
// recoverable; execute must force a fresh dry-run.
const legacyTask = JSON.parse(JSON.stringify(task));
delete legacyTask.history[0].writeAudit.executorEvidence[0].payload;
const legacyLock = resolvePreflightProductLock(legacyTask, 'TZ', {expectedPayloadHash: expectedHash});
assert.equal(legacyLock, null);
const v2Task = JSON.parse(JSON.stringify(task));
v2Task.history[0].writeAudit.executorEvidence[0].payloadHashAlgorithm = 'sha256-stable-json-scope-v2';
assert.equal(resolvePreflightProductLock(v2Task, 'TZ', {expectedPayloadHash: expectedHash}), null);
const missingAlgorithmTask = JSON.parse(JSON.stringify(task));
delete missingAlgorithmTask.history[0].writeAudit.executorEvidence[0].payloadHashAlgorithm;
assert.equal(resolvePreflightProductLock(missingAlgorithmTask, 'TZ', {expectedPayloadHash: expectedHash}), null);

for (const [label, mutate] of [
  ['missing storeKey', row => { delete row.storeKey; }],
  ['sourceStore array', row => { row.readbackFingerprint.inferredSourceStore = ['QY']; }],
  ['sourceStore object', row => { row.readbackFingerprint.inferredSourceStore = {value: 'QY'}; }],
  ['sourceSkc array', row => { row.readbackFingerprint.inferredSourceSkc = ['sv25082869650540305']; }],
  ['sourceSkc object', row => { row.readbackFingerprint.inferredSourceSkc = {value: 'sv25082869650540305'}; }],
  ['lock source array', row => { row.payload.sourceDetailLock.source = ['openapi_product_detail_snapshot']; }],
  ['lock source object', row => { row.payload.sourceDetailLock.source = {value: 'openapi_product_detail_snapshot'}; }],
  ['lock SPU array', row => { row.payload.sourceDetailLock.matchedSpuName = ['v2508286965054030']; }],
  ['lock SPU object', row => { row.payload.sourceDetailLock.matchedSpuName = {value: 'v2508286965054030'}; }],
  ['lock SKC array', row => { row.payload.sourceDetailLock.matchedSkcName = ['sv25082869650540305']; }],
  ['lock SKC object', row => { row.payload.sourceDetailLock.matchedSkcName = {value: 'sv25082869650540305'}; }],
  ['lock SHA array', row => { row.payload.sourceDetailLock.detailContentSha256 = ['a'.repeat(64)]; }],
  ['lock SHA object', row => { row.payload.sourceDetailLock.detailContentSha256 = {value: 'a'.repeat(64)}; }],
  ['payloadHash array', row => { row.payloadHash = [expectedHash]; }],
  ['payloadHash object', row => { row.payloadHash = {value: expectedHash}; }],
  ['payloadHashAlgorithm array', row => { row.payloadHashAlgorithm = ['sha256-stable-json-scope-v4']; }],
  ['payloadHashAlgorithm object', row => { row.payloadHashAlgorithm = {value: 'sha256-stable-json-scope-v4'}; }],
  ['explicit inferred sourceStore null hides fingerprint fallback', row => { row.payload.inferredSource = {sourceStore: null}; }],
  ['explicit inferred sourceSkc false hides fingerprint fallback', row => { row.payload.inferredSource = {sourceSkc: false}; }],
  ['explicit payload hash null hides result fallback', row => { row.payload.payloadHash = null; }],
  ['explicit payload algorithm false hides result fallback', row => { row.payload.payloadHashAlgorithm = false; }],
  ['explicit result null hides row fallback', row => { row.result = null; }],
  ['explicit result false hides row fallback', row => { row.result = false; }],
  ['explicit inferredSource container null hides later fallback', row => { row.payload.inferredSource = null; }],
  ['explicit inferredSource container false hides later fallback', row => { row.payload.inferredSource = false; }],
  ['explicit inferredSource container array hides later fallback', row => { row.payload.inferredSource = []; }],
]) {
  const tamperedTask = JSON.parse(JSON.stringify(task));
  mutate(tamperedTask.history[0].writeAudit.executorEvidence[0]);
  assert.equal(resolvePreflightProductLock(tamperedTask, 'TZ', {expectedPayloadHash: expectedHash}), null, `${label} must not be recoverable`);
}

const payload = {
  source_system: 'OpenAPI',
  shelf_way: 2,
  hope_on_sale_date: '2036-07-12 10:00:00',
  product_attribute_list: [],
  multi_language_name_list: [],
  skc_list: [{
    shelf_way: 2,
    hope_on_sale_date: '2036-07-12 10:00:00',
    sku_list: [],
  }],
};
const normalized = applySafeDefaults(payload, {
  sites: [],
  brands: [],
  task,
  executionContext: {productDraftLock: lock},
});
assert.equal(normalized.payload.hope_on_sale_date, '2036-07-11 10:00:00');
assert.equal(normalized.payload.skc_list[0].hope_on_sale_date, '2036-07-11 10:00:00');
assert.ok(normalized.applied.includes('hope_on_sale_date=preflight_locked'));
assert.ok(normalized.applied.includes('skc_list.hope_on_sale_date.preflight_locked'));

console.log(JSON.stringify({
  ok: true,
  lockedSource: `${lock.sourceStore}/${lock.sourceSkc}`,
  lockedHopeOnSaleDate: lock.hopeOnSaleDate,
}, null, 2));
