#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {SheinOpenApiClient} from '../lib/shein_openapi_client.mjs';
import {acquireCrossProcessTicketLock} from '../lib/cross_process_ticket_lock.mjs';
import {inventoryWriteScopeKey} from '../lib/durable_inventory_write.mjs';
import {stableInventoryHash} from '../lib/inventory_replenishment_policy.mjs';
import {
  activateInventoryCutover,
  readInventoryCutoverActivation,
  requireCurrentInventoryCutoverActivation,
} from '../lib/inventory_write_cutover.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'inventory-cutover-activation-'));
const activationFile = path.join(temp, 'activation.ndjson');
const activationReceiptFile = path.join(temp, 'activation.receipt.json');
const lockFile = path.join(temp, 'cutover.lock');
const journalFile = path.join(temp, 'daily-inventory-replenishment-2026-08-17.json.journal.ndjson');
const manualReceiptFile = path.join(temp, 'manual-resolution.receipt.json');
const exactScope = {
  storeKey: 'XL',
  skc: 'sb260606205087254179320',
  skuCode: 'I0mq2cw2khzt47',
  warehouseCode: 'PS0916742261',
  invType: 'VI',
};
const scopeKey = inventoryWriteScopeKey(exactScope);
const authority = {
  deployedCommit: 'a'.repeat(40),
  sourceFingerprint: 'b'.repeat(64),
  bundleSha256: 'c'.repeat(64),
  trackedSourceClean: true,
  releaseReceiptKind: 'emergency',
  releaseReceiptHash: 'd'.repeat(64),
  releaseReceiptFile: path.join(temp, 'emergency-receipt.json'),
  writerServices: [{unit: 'shein-bi-portal.service', generationHash: 'e'.repeat(64)}],
  capturedAt: '2026-08-26T15:00:00.000Z',
};
const maintenanceAll = {ok: true, active: true, mode: 'all', generation: 12, hash: 'f'.repeat(64)};
const requiredManualResolution = {
  intentId: 'e07f999c-96b2-460c-bfa9-fa924f410ec3',
  scopeKey,
  journalFile,
  receiptFile: manualReceiptFile,
};

const inactiveFile = path.join(temp, 'inactive.ndjson');
await assert.rejects(activateInventoryCutover({
  activationFile: inactiveFile,
  activationReceiptFile: path.join(temp, 'inactive.receipt.json'),
  requiredManualResolution,
  authorityReader: async () => authority,
  maintenanceReader: async () => ({...maintenanceAll, active: false, mode: 'none'}),
  lockFile: path.join(temp, 'inactive.lock'),
}), /INVENTORY_CUTOVER_MAINTENANCE_REQUIRED/);
await assert.rejects(fs.lstat(inactiveFile), {code: 'ENOENT'});

const recoveryActivationFile = path.join(temp, 'recovery.ndjson');
const recoveryReceiptFile = path.join(temp, 'recovery.receipt.json');
const recoveryOptions = {
  activationFile: recoveryActivationFile,
  activationReceiptFile: recoveryReceiptFile,
  requiredManualResolution,
  authorityReader: async () => authority,
  maintenanceReader: async () => maintenanceAll,
  now: () => new Date('2026-08-26T15:00:30.000Z'),
  lockFile: path.join(temp, 'recovery.lock'),
};
await activateInventoryCutover(recoveryOptions);
await fs.unlink(recoveryReceiptFile);
const recoveredActivation = await activateInventoryCutover(recoveryOptions);
assert.equal(recoveredActivation.state, 'activation_receipt_recovered');
assert.match(recoveredActivation.receipt.receiptHash, /^[a-f0-9]{64}$/);

const activated = await activateInventoryCutover({
  activationFile,
  activationReceiptFile,
  requiredManualResolution,
  authorityReader: async () => authority,
  maintenanceReader: async () => maintenanceAll,
  now: () => new Date('2026-08-26T15:01:00.000Z'),
  lockFile,
});
assert.equal(activated.state, 'activated');
assert.equal(activated.activation.authority.deployedCommit, authority.deployedCommit);
assert.match(activated.receipt.receiptHash, /^[a-f0-9]{64}$/);
assert.equal((await fs.readFile(activationFile, 'utf8')).trim().split(/\r?\n/u).length, 1, 'activation registry is append-only single generation');

const current = await requireCurrentInventoryCutoverActivation({
  activationFile,
  activationReceiptFile,
  authorityReader: async () => authority,
});
assert.equal(current.activated, true);
await assert.rejects(requireCurrentInventoryCutoverActivation({
  activationFile,
  activationReceiptFile,
  authorityReader: async () => ({...authority, deployedCommit: '1'.repeat(40)}),
}), /INVENTORY_CUTOVER_ROLLBACK_OR_DEPLOYMENT_DRIFT/);
const restartedSameCommit = await requireCurrentInventoryCutoverActivation({
  activationFile,
  activationReceiptFile,
  authorityReader: async () => ({...authority, writerServices: [{unit: 'shein-bi-portal.service', generationHash: '2'.repeat(64)}]}),
});
assert.equal(restartedSameCommit.activated, true, 'same compatible commit remains valid across Portal restart generation changes');

const emptyRegistry = path.join(temp, 'empty.ndjson');
await fs.writeFile(emptyRegistry, '');
await assert.rejects(readInventoryCutoverActivation({
  activationFile: emptyRegistry,
  activationReceiptFile: path.join(temp, 'missing.receipt.json'),
}), /INVENTORY_CUTOVER_ACTIVATION_INVALID/);

const receiptOnlyFile = path.join(temp, 'receipt-only.json');
await fs.writeFile(receiptOnlyFile, '{}\n');
await assert.rejects(readInventoryCutoverActivation({
  activationFile: path.join(temp, 'missing-registry.ndjson'),
  activationReceiptFile: receiptOnlyFile,
}), /INVENTORY_CUTOVER_ACTIVATION_INCONSISTENT/);

const event = {
  kind: 'manual_resolution',
  intentId: requiredManualResolution.intentId,
  disposition: 'manual_baseline_adopted_effect_unknown',
  scope: {...exactScope, scopeKey},
  idempotencyKey: 'old-key',
};
const receiptCore = {
  schemaVersion: 'inventory-manual-resolution-receipt/v1',
  kind: 'manual_resolution_receipt',
  intentId: event.intentId,
  scopeKey,
  eventHash: stableInventoryHash(event),
  sideEffects: {sheinPostCount: 0, historicalLinesModified: 0},
};
await fs.writeFile(journalFile, `${JSON.stringify({kind: 'intent'})}\n${JSON.stringify(event)}\n`);
await fs.writeFile(manualReceiptFile, `${JSON.stringify({...receiptCore, receiptHash: stableInventoryHash(receiptCore)})}\n`);
const fencedBundle = {
  manualResolutions: new Map([['journal::intent', event]]),
  fences: new Map([[scopeKey, {event, reason: 'scope_permanent_manual_resolution'}]]),
  tombstonedIdempotencyKeys: new Map([['old-key', {event}]]),
};
let activeDomain = {bundle: null, files: []};
let fetchCalls = 0;
const client = new SheinOpenApiClient({
  baseUrl: 'http://127.0.0.1:9',
  openKeyId: 'test-open',
  secretKey: 'test-secret',
  inventoryStoreKey: 'XL',
  inventoryCutoverLock: lockFile,
  inventoryCutoverReader: async () => current,
  inventoryFenceReader: async () => activeDomain,
  fetchImpl: async () => {
    fetchCalls += 1;
    return {ok: true, status: 200, statusText: 'OK', text: async () => '{"code":"0"}'};
  },
});
const releaseResolverLock = await acquireCrossProcessTicketLock(lockFile, {timeoutMs: 1000, staleMs: 60_000});
const requestPromise = client.request('/open-api/stock/change-inventory/v2', {
  method: 'POST',
  body: {updateSkuInventoryQuantityRequests: [{
    idempotencyKey: 'new-key',
    skuCode: exactScope.skuCode,
    warehouseCode: exactScope.warehouseCode,
    invType: 'VI',
  }]},
});
await new Promise(resolve => setTimeout(resolve, 25));
activeDomain = {bundle: fencedBundle, files: [journalFile]};
await releaseResolverLock();
await assert.rejects(requestPromise, /INVENTORY_WRITE_FENCED/);
assert.equal(fetchCalls, 0, 'writer waiting across resolver cutover must re-probe under lock and never POST');

console.log(JSON.stringify({
  ok: true,
  checks: [
    'activation_requires_fresh_real_maintenance_all',
    'activation_registry_and_independent_receipt_are_immutable_and_hashed',
    'activation_receipt_crash_gap_recovers_under_lock_without_registry_rewrite',
    'rollback_commit_rejected_but_same_commit_writer_restart_remains_compatible',
    'existing_empty_activation_registry_fails_closed',
    'receipt_without_activation_registry_fails_closed',
    'shared_cutover_lock_forces_writer_reprobe_and_zero_post',
  ],
}, null, 2));
