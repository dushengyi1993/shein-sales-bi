#!/usr/bin/env node
import assert from 'node:assert/strict';

process.env.SHEIN_LINK_OPS_EXECUTOR_SELF_TEST = '1';

const {__testHooks} = await import('./link_ops_hl_openapi_executor.mjs');
const {applySafeDefaults, resolvePreflightProductLock} = __testHooks;

const expectedHash = '2a08ba28b1819d9b4610fa1bbf5cb73e2a350944999a29f8c61c82b8935889dc';
const driftedHash = '2c31240bdd232598403e744f637318534c07beed54efb5bc147892bcc231e1f9';
const historySourceDetailLock = {
  source: 'openapi_product_detail_snapshot',
  matchedSpuName: 'v-smoke-copy-product',
  matchedSkcName: 'sv25082869650540305',
  detailFetchedAt: '2026-07-11T09:00:00.000Z',
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
        payloadHash: expectedHash,
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
assert.deepEqual(lock.sourceDetailLock, historySourceDetailLock);
assert.equal(resolvePreflightProductLock(task, 'TZ', {expectedPayloadHash: 'f'.repeat(64)}), null);

// Legacy cross-version history shape: a preflight that only locked the payload
// hash (no sourceDetailLock) is still recoverable as a lock, but with a null
// sourceDetailLock. The executor write gate then blocks it with
// SOURCE_DETAIL_LOCK_PREFLIGHT_MISSING and forces a fresh dry-run.
const legacyTask = JSON.parse(JSON.stringify(task));
delete legacyTask.history[0].writeAudit.executorEvidence[0].payload;
const legacyLock = resolvePreflightProductLock(legacyTask, 'TZ', {expectedPayloadHash: expectedHash});
assert.ok(legacyLock, 'legacy hash-only preflight lock should still be recoverable');
assert.equal(legacyLock.payloadHash, expectedHash);
assert.equal(legacyLock.sourceDetailLock, null);

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
