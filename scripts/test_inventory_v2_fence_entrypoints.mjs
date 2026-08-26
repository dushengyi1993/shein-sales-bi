#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  assertInventoryWriteAllowed,
  inventoryWriteScopeKey,
} from '../lib/durable_inventory_write.mjs';
import {createMarketingActivityInventoryOpenApiAdapter} from '../lib/marketing_activity_inventory_openapi.mjs';
import {stableInventoryHash} from '../lib/inventory_replenishment_policy.mjs';
import {SheinOpenApiClient} from '../lib/shein_openapi_client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'inventory-v2-entrypoints-'));
const exactScope = {
  storeKey: 'XL',
  skc: 'sb260606205087254179320',
  skuCode: 'I0mq2cw2khzt47',
  warehouseCode: 'PS0916742261',
  invType: 'VI',
};
const fenceEvent = {
  resolutionId: 'fence-resolution-1',
  intentId: 'e07f999c-96b2-460c-bfa9-fa924f410ec3',
  disposition: 'manual_baseline_adopted_effect_unknown',
  idempotencyKey: 'bi-inv-old-tombstone',
  scope: {...exactScope, scopeKey: inventoryWriteScopeKey(exactScope)},
};
const fencedBundle = {
  fences: new Map([[fenceEvent.scope.scopeKey, {event: fenceEvent, reason: 'scope_permanent_manual_resolution'}]]),
  tombstonedIdempotencyKeys: new Map([[fenceEvent.idempotencyKey, {event: fenceEvent}]]),
};

const entrypointFiles = [
  'lib/marketing_activity_inventory_openapi.mjs',
  'scripts/link_ops_maintenance_openapi_executor.mjs',
  'scripts/marketing/manage_manual_limited_discount_inventory.mjs',
  'scripts/inventory/execute_daily_inventory_replenishment_plan.mjs',
];
for (const relative of entrypointFiles) {
  const source = await fs.readFile(path.join(ROOT, relative), 'utf8');
  assert.match(source, /SheinOpenApiClient/, `${relative} must use the shared OpenAPI client`);
  assert.match(source, /change-inventory\/v2/, `${relative} must retain the inventory v2 route contract`);
  assert.doesNotMatch(source, /fetch\s*\([^\n]*change-inventory\/v2/, `${relative} must not bypass the shared client with direct fetch`);
}

// A new key cannot reopen the exact scope; the old key is separately a
// permanent tombstone.  The lower layer must make both decisions before any
// signing or transport work.
assert.throws(() => assertInventoryWriteAllowed(fencedBundle, {
  scope: exactScope,
  idempotencyKey: 'new-key',
}), /INVENTORY_WRITE_FENCED/);
assert.throws(() => assertInventoryWriteAllowed(fencedBundle, {
  scope: {...exactScope, warehouseCode: ''},
  idempotencyKey: fenceEvent.idempotencyKey,
}), /INVENTORY_WRITE_FENCED/);
assert.doesNotThrow(() => assertInventoryWriteAllowed(fencedBundle, {
  scope: {...exactScope, warehouseCode: 'OTHER-WAREHOUSE'},
  idempotencyKey: 'new-key',
}));

let fetchCalls = 0;
const client = new SheinOpenApiClient({
  baseUrl: 'http://127.0.0.1:9',
  openKeyId: 'focused-test-open-key',
  secretKey: 'focused-test-secret',
  inventoryStoreKey: exactScope.storeKey,
  inventoryFenceReader: async () => fencedBundle,
  inventoryCutoverLock: path.join(temp, 'fenced.lock'),
  fetchImpl: async () => {
    fetchCalls += 1;
    return {ok: true, status: 200, statusText: 'OK', text: async () => '{"code":"0"}'};
  },
});
const body = {
  updateSkuInventoryQuantityRequests: [{
    idempotencyKey: 'new-key',
    skuCode: exactScope.skuCode,
    warehouseCode: exactScope.warehouseCode,
    invType: exactScope.invType,
    changeType: 'OVERWRITE',
    changeQuantity: 50,
  }],
};
assert.equal(typeof client.requestUnlocked, 'undefined', 'the old public transport bypass must not exist');
await assert.rejects(async () => client.requestUnlocked('/open-api/stock/change-inventory/v2', {
  method: 'POST', body,
}), TypeError);
assert.equal(fetchCalls, 0, 'attempting the former public bypass must not reach transport');
await assert.rejects(client.request('/open-api/stock/change-inventory/v2', {method: 'POST', body}), /INVENTORY_WRITE_FENCED/);
assert.equal(fetchCalls, 0, 'fenced v2 requests must stop before transport');
await client.request('/open-api/stock/change-inventory/v2', {
  method: 'POST',
  body: {...body, updateSkuInventoryQuantityRequests: [{...body.updateSkuInventoryQuantityRequests[0], warehouseCode: 'OTHER-WAREHOUSE'}]},
});
assert.equal(fetchCalls, 1, 'a different explicit warehouse is outside the exact fence');

const boundRequest = {
  pathname: '/open-api/stock/change-inventory/v2',
  method: 'POST',
  body: {updateSkuInventoryQuantityRequests: [{
    idempotencyKey: 'bound-idempotency-key',
    skuCode: 'BOUND-SKU',
    warehouseCode: 'BOUND-WAREHOUSE',
    invType: 'VI',
    changeType: 'OVERWRITE',
    changeQuantity: 69,
  }]},
  headers: {language: 'en'},
};
const boundIntent = {
  intentId: 'bound-intent',
  logicalActionKey: 'a'.repeat(64),
  idempotencyKey: boundRequest.body.updateSkuInventoryQuantityRequests[0].idempotencyKey,
  requestPayloadHash: stableInventoryHash(boundRequest),
  request: boundRequest,
  storeKey: 'DL',
  skc: 'BOUND-SKC',
  skuCode: 'BOUND-SKU',
  warehouseCode: 'BOUND-WAREHOUSE',
  invType: 'VI',
};
let boundFetchCalls = 0;
const boundClient = new SheinOpenApiClient({
  baseUrl: 'http://127.0.0.1:9',
  openKeyId: 'focused-test-open-key',
  secretKey: 'focused-test-secret',
  inventoryStoreKey: 'DL',
  inventoryFenceReader: async () => ({
    bundle: {
      pending: new Map([[boundIntent.intentId, boundIntent]]),
      fences: new Map(),
      tombstonedIdempotencyKeys: new Map(),
    },
    files: [],
  }),
  inventoryCutoverReader: async () => ({activated: false}),
  inventoryCutoverLock: path.join(temp, 'bound-request.lock'),
  fetchImpl: async () => {
    boundFetchCalls += 1;
    return {ok: true, status: 200, statusText: 'OK', text: async () => '{"code":"0"}'};
  },
});
const boundScope = {
  storeKey: boundIntent.storeKey,
  skc: boundIntent.skc,
  skuCode: boundIntent.skuCode,
  warehouseCode: boundIntent.warehouseCode,
  invType: boundIntent.invType,
  requestPayloadHash: boundIntent.requestPayloadHash,
  intentId: boundIntent.intentId,
  logicalActionKey: boundIntent.logicalActionKey,
};
for (const [label, mutate] of [
  ['quantity', request => ({...request, body: {updateSkuInventoryQuantityRequests: [{...request.body.updateSkuInventoryQuantityRequests[0], changeQuantity: 569}]}})],
  ['warehouse', request => ({...request, body: {updateSkuInventoryQuantityRequests: [{...request.body.updateSkuInventoryQuantityRequests[0], warehouseCode: 'OTHER-WAREHOUSE'}]}})],
  ['request-array', request => ({...request, body: {updateSkuInventoryQuantityRequests: [...request.body.updateSkuInventoryQuantityRequests, {...request.body.updateSkuInventoryQuantityRequests[0], skuCode: 'SECOND-SKU'}]}})],
  ['headers', request => ({...request, headers: {language: 'ar'}})],
]) {
  const changed = mutate(boundRequest);
  await assert.rejects(boundClient.request(changed.pathname, {
    method: changed.method,
    body: changed.body,
    headers: changed.headers,
    inventoryScope: boundScope,
  }), /INVENTORY_WRITE_FENCE_REQUEST_HASH_MISMATCH/, label);
}
assert.equal(boundFetchCalls, 0, 'mutated request payload or business headers must fail before transport');
await boundClient.request(boundRequest.pathname, {
  method: boundRequest.method,
  body: boundRequest.body,
  headers: boundRequest.headers,
  inventoryScope: boundScope,
});
assert.equal(boundFetchCalls, 1, 'the exact durable request may pass its own pending intent binding once');
const boundFetchCallsBeforeIdentityDrift = boundFetchCalls;
await assert.rejects(boundClient.request(boundRequest.pathname, {
  method: boundRequest.method,
  body: boundRequest.body,
  headers: boundRequest.headers,
  inventoryScope: {...boundScope, storeKey: 'DX'},
}), /INVENTORY_WRITE_FENCE_STORE_IDENTITY_MISMATCH/);
await assert.rejects(boundClient.request(boundRequest.pathname, {
  method: boundRequest.method,
  body: boundRequest.body,
  headers: boundRequest.headers,
  inventoryScope: boundScope,
  openKeyId: 'DX-OPEN-KEY',
  secretKey: 'DX-SECRET',
}), /INVENTORY_WRITE_FENCE_CREDENTIAL_OVERRIDE_FORBIDDEN/);
assert.equal(boundFetchCalls, boundFetchCallsBeforeIdentityDrift, 'cross-store scope and credential override must fail before transport');
await assert.rejects(boundClient.request(boundRequest.pathname, {
  method: boundRequest.method,
  body: boundRequest.body,
  headers: {...boundRequest.headers, 'X-LT-openKeyId': 'DX-OPEN-KEY'},
  inventoryScope: boundScope,
}), /INVENTORY_WRITE_FENCE_CREDENTIAL_HEADER_FORBIDDEN/);
const crossStoreClient = new SheinOpenApiClient({
  baseUrl: 'http://127.0.0.1:9',
  openKeyId: 'DX-OPEN-KEY',
  secretKey: 'DX-SECRET',
  inventoryStoreKey: 'DX',
  inventoryFenceReader: async () => ({
    bundle: {
      pending: new Map([[boundIntent.intentId, boundIntent]]),
      fences: new Map(),
      tombstonedIdempotencyKeys: new Map(),
    },
    files: [],
  }),
  inventoryCutoverReader: async () => ({activated: false}),
  inventoryCutoverLock: path.join(temp, 'cross-store-bound-request.lock'),
  fetchImpl: async () => {
    boundFetchCalls += 1;
    return {ok: true, status: 200, statusText: 'OK', text: async () => '{"code":"0"}'};
  },
});
const {storeKey: _omittedStoreKey, ...scopeWithoutStore} = boundScope;
await assert.rejects(crossStoreClient.request(boundRequest.pathname, {
  method: boundRequest.method,
  body: boundRequest.body,
  headers: boundRequest.headers,
  inventoryScope: scopeWithoutStore,
}), /INVENTORY_WRITE_PENDING_CONFLICT/);
assert.equal(boundFetchCalls, boundFetchCallsBeforeIdentityDrift, 'omitted scope store cannot reuse a pending intent through another store client');

let releaseCutoverRead;
const cutoverReadGate = new Promise(resolve => { releaseCutoverRead = resolve; });
let cutoverReadStarted;
const cutoverReadStartedPromise = new Promise(resolve => { cutoverReadStarted = resolve; });
let toctouTransport = null;
const toctouClient = new SheinOpenApiClient({
  baseUrl: 'http://127.0.0.1:9',
  openKeyId: 'DL-OPEN-KEY',
  secretKey: 'DL-SECRET',
  inventoryStoreKey: 'DL',
  inventoryCutoverReader: async () => {
    cutoverReadStarted();
    await cutoverReadGate;
    return {activated: false};
  },
  inventoryFenceReader: async () => ({bundle: null, files: []}),
  inventoryCutoverLock: path.join(temp, 'request-snapshot.lock'),
  fetchImpl: async (_url, init) => {
    toctouTransport = {body: JSON.parse(init.body), headers: {...init.headers}};
    return {ok: true, status: 200, statusText: 'OK', text: async () => '{"code":"0"}'};
  },
});
const mutableBody = JSON.parse(JSON.stringify(boundRequest.body));
const mutableHeaders = {...boundRequest.headers};
const mutableScope = {
  storeKey: 'DL', skc: 'BOUND-SKC', skuCode: 'BOUND-SKU', warehouseCode: 'BOUND-WAREHOUSE', invType: 'VI',
};
const snapshotRequest = toctouClient.request(boundRequest.pathname, {
  method: boundRequest.method,
  body: mutableBody,
  headers: mutableHeaders,
  inventoryScope: mutableScope,
});
await cutoverReadStartedPromise;
mutableBody.updateSkuInventoryQuantityRequests[0].changeQuantity = 569;
mutableHeaders['x-lt-openKeyId'] = 'DX-OPEN-KEY';
mutableHeaders['x-lt-signature'] = 'DX-SIGNATURE';
mutableScope.storeKey = 'DX';
releaseCutoverRead();
await snapshotRequest;
assert.equal(toctouTransport.body.updateSkuInventoryQuantityRequests[0].changeQuantity, 69, 'transport uses the pre-await body snapshot');
assert.equal(toctouTransport.headers['x-lt-openKeyId'], 'DL-OPEN-KEY', 'transport authentication cannot be mutated after the boundary snapshot');
assert.notEqual(toctouTransport.headers['x-lt-signature'], 'DX-SIGNATURE');

const emptyBundleClient = new SheinOpenApiClient({
  baseUrl: 'http://127.0.0.1:9',
  openKeyId: 'focused-test-open-key',
  secretKey: 'focused-test-secret',
  inventoryStoreKey: exactScope.storeKey,
  inventoryFenceReader: async () => ({bundle: null, files: []}),
  inventoryCutoverReader: async () => ({
    activated: true,
    activation: {
      requiredManualResolution: {
        intentId: fenceEvent.intentId,
        scopeKey: fenceEvent.scope.scopeKey,
        journalFile: path.join(temp, 'missing-target.journal.ndjson'),
        receiptFile: path.join(temp, 'missing-target.receipt.json'),
      },
    },
  }),
  inventoryCutoverLock: path.join(temp, 'empty.lock'),
  fetchImpl: async () => {
    fetchCalls += 1;
    return {ok: true, status: 200, statusText: 'OK', text: async () => '{"code":"0"}'};
  },
});
const fetchCallsBeforeUnavailable = fetchCalls;
await assert.rejects(emptyBundleClient.request('/open-api/stock/change-inventory/v2', {method: 'POST', body}), /INVENTORY_WRITE_FENCE_DOMAIN_EMPTY/);
assert.equal(fetchCalls, fetchCallsBeforeUnavailable, 'activated empty aggregate must fail closed before transport');

const missingReceiptJournal = path.join(temp, 'target.journal.ndjson');
await fs.writeFile(missingReceiptJournal, '{"kind":"fixture"}\n');
const missingReceiptClient = new SheinOpenApiClient({
  baseUrl: 'http://127.0.0.1:9',
  openKeyId: 'focused-test-open-key',
  secretKey: 'focused-test-secret',
  inventoryStoreKey: exactScope.storeKey,
  inventoryFenceReader: async () => ({
    bundle: {...fencedBundle, manualResolutions: new Map([['intent', fenceEvent]])},
    files: [missingReceiptJournal],
  }),
  inventoryCutoverReader: async () => ({
    activated: true,
    activation: {requiredManualResolution: {
      intentId: fenceEvent.intentId,
      scopeKey: fenceEvent.scope.scopeKey,
      journalFile: missingReceiptJournal,
      receiptFile: path.join(temp, 'absent-manual-receipt.json'),
    }},
  }),
  inventoryCutoverLock: path.join(temp, 'missing-receipt.lock'),
  fetchImpl: async () => { fetchCalls += 1; throw new Error('transport must not run'); },
});
await assert.rejects(missingReceiptClient.request('/open-api/stock/change-inventory/v2', {method: 'POST', body}), /INVENTORY_WRITE_FENCE_REQUIRED_RECEIPT_MISSING/);
assert.equal(fetchCalls, fetchCallsBeforeUnavailable, 'missing target receipt must fail before transport');

const permissionFailureClient = new SheinOpenApiClient({
  baseUrl: 'http://127.0.0.1:9',
  openKeyId: 'focused-test-open-key',
  secretKey: 'focused-test-secret',
  inventoryStoreKey: exactScope.storeKey,
  inventoryFenceReader: async () => { const error = new Error('permission denied'); error.code = 'EACCES'; throw error; },
  inventoryCutoverReader: async () => ({activated: true}),
  inventoryCutoverLock: path.join(temp, 'permission.lock'),
  fetchImpl: async () => { fetchCalls += 1; throw new Error('transport must not run'); },
});
await assert.rejects(permissionFailureClient.request('/open-api/stock/change-inventory/v2', {method: 'POST', body}), /permission denied/);
assert.equal(fetchCalls, fetchCallsBeforeUnavailable, 'journal permission failure must fail before transport');

const preActivationClient = new SheinOpenApiClient({
  baseUrl: 'http://127.0.0.1:9',
  openKeyId: 'focused-test-open-key',
  secretKey: 'focused-test-secret',
  inventoryStoreKey: exactScope.storeKey,
  inventoryFenceReader: async () => ({bundle: null, files: []}),
  inventoryCutoverReader: async () => ({activated: false}),
  inventoryCutoverLock: path.join(temp, 'pre-activation.lock'),
  fetchImpl: async () => {
    fetchCalls += 1;
    return {ok: true, status: 200, statusText: 'OK', text: async () => '{"code":"0"}'};
  },
});
await preActivationClient.request('/open-api/stock/change-inventory/v2', {method: 'POST', body});
assert.equal(fetchCalls, fetchCallsBeforeUnavailable + 1, 'reader-first pre-activation remains legacy compatible');
await assert.rejects(client.request('/open-api/stock/change-inventory/v2', {method: 'POST', body: {}}), /INVENTORY_WRITE_FENCE_REQUEST_INVALID/);
assert.equal(fetchCalls, fetchCallsBeforeUnavailable + 1, 'malformed v2 request must fail closed before transport');

// Exercise the real marketing OpenAPI adapter, not just a source-text route
// assertion.  A malformed durable-domain member must stop writeStock before
// the shared client invokes its transport.  Identity and product discovery
// are served by the local fetch stub and are deliberately counted first.
const adapterRoot = path.join(temp, 'marketing-adapter-root');
const adapterJournalDir = path.join(adapterRoot, 'journals');
const adapterConfigFile = path.join(adapterRoot, 'config', 'openapi.json');
await fs.mkdir(path.dirname(adapterConfigFile), {recursive: true});
await fs.mkdir(adapterJournalDir, {recursive: true});
await fs.writeFile(adapterConfigFile, JSON.stringify({
  apiBaseUrls: {prodSemiManaged: 'http://127.0.0.1:9'},
  stores: [{
    storeKey: 'XL',
    openKeyId: 'focused-adapter-open-key',
    secretKey: 'focused-adapter-secret',
    accountNo: 'GS9307061',
    merchantId: '6716329',
  }],
}));
await fs.writeFile(path.join(adapterRoot, 'config', 'store_account_truth.json'), JSON.stringify({
  stores: {XL: {accountNo: 'GS9307061', merchantId: '6716329'}},
}));
await fs.writeFile(
  path.join(adapterJournalDir, 'malformed-manual-resolution.journal.ndjson'),
  '{"kind":"manual_resolution"}\n',
);
const previousFetch = globalThis.fetch;
const previousJournalDirs = process.env.SHEIN_BI_INVENTORY_JOURNAL_DIRS;
let adapterTransportCalls = 0;
globalThis.fetch = async url => {
  adapterTransportCalls += 1;
  const pathname = new URL(url).pathname;
  const data = pathname.endsWith('/query-store-info')
    ? {code: '0', info: {accountNo: 'GS9307061', merchantId: '6716329'}}
    : pathname.endsWith('/product/query')
      ? {code: '0', info: {data: [{skcName: exactScope.skc, skuCodeList: [exactScope.skuCode]}]}}
      : {code: '0', info: {success: true}};
  return {ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(data)};
};
process.env.SHEIN_BI_INVENTORY_JOURNAL_DIRS = adapterJournalDir;
try {
  const adapter = await createMarketingActivityInventoryOpenApiAdapter({
    root: adapterRoot,
    storeKey: 'XL',
    configPath: adapterConfigFile,
  });
  const callsBeforeAdapterWrite = adapterTransportCalls;
  await assert.rejects(adapter.writeStock({
    target: {storeKey: 'XL', skc: exactScope.skc, skuCode: exactScope.skuCode},
    overwriteQuantity: 50,
    idempotencyKey: 'adapter-new-key',
    phase: 'temporary_raise',
  }), /INVENTORY_WRITE_FENCE_DOMAIN_INVALID/);
  assert.equal(adapterTransportCalls, callsBeforeAdapterWrite, 'real marketing adapter must fail before inventory transport');
} finally {
  globalThis.fetch = previousFetch;
  if (previousJournalDirs === undefined) delete process.env.SHEIN_BI_INVENTORY_JOURNAL_DIRS;
  else process.env.SHEIN_BI_INVENTORY_JOURNAL_DIRS = previousJournalDirs;
}

console.log(JSON.stringify({
  ok: true,
  checks: [
    'daily_et_bi_maintenance_marketing_entrypoints_use_shared_client',
    'exact_scope_manual_fence_blocks_new_key',
    'old_idempotency_key_tombstone_blocks',
    'warehouse_scope_is_conservative_at_lower_layer',
    'activated_empty_domain_fails_closed_and_pre_activation_is_compatible',
    'activated_missing_target_receipt_and_permission_failure_fail_closed',
    'real_marketing_openapi_adapter_fails_before_inventory_transport',
    'malformed_v2_request_fails_closed',
    'zero_transport_calls_for_blocked_v2',
    'actual_request_hash_blocks_quantity_warehouse_array_and_header_drift',
    'client_store_identity_and_credentials_are_bound_before_own_intent_release',
    'pre_await_private_snapshot_closes_body_header_and_scope_toctou',
    'former_public_request_unlocked_bypass_is_inaccessible_with_zero_fetch',
  ],
}, null, 2));
