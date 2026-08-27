#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  appendDurableJournalRecord,
  assertInventoryWriteAllowed,
  findInventoryWriteFence,
  INVENTORY_MANUAL_RESOLUTION_DISPOSITION,
  INVENTORY_MANUAL_RESOLUTION_INTENT_ID,
  inventoryRecoveryScopeKey,
  inventoryWriteScopeKey,
  readInventoryIntentJournals,
  readInventoryIntentLifecycle,
} from '../lib/durable_inventory_write.mjs';
import {SheinOpenApiClient} from '../lib/shein_openapi_client.mjs';
import {INVENTORY_OVERWRITE_COMPUTATION_VERSION, stableInventoryHash} from '../lib/inventory_replenishment_policy.mjs';
import {
  MANUAL_READBACK_EVIDENCE_CONTRACT,
  parseArgs,
  resolveManualInventoryIntent,
  validateManualResolutionReceipt,
} from './inventory/resolve_manual_inventory_intent.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'inventory-manual-resolution-'));
const journal = path.join(temp, 'daily-inventory-replenishment-2026-08-17.json.journal.ndjson');
const otherDir = path.join(temp, 'other-journals');
const otherJournal = path.join(otherDir, 'et-low-inventory-batch-2026-08-17.json.journal.ndjson');
const planFile = path.join(temp, 'daily-plan.json');
const receiptFile = path.join(temp, 'manual-resolution.receipt.json');
const scope = {
  storeKey: 'XL',
  skc: 'sb260606205087254179320',
  skuCode: 'I0mq2cw2khzt47',
  warehouseCode: 'PS0916742261',
  invType: 'VI',
};
const now = new Date().toISOString();
const planHash = 'c'.repeat(64);
const policyVersion = '2026-08-26-test';
const authorizationId = 'owner-manual-resolution-test';

function buildIntent({
  intentId,
  storeKey = 'XL',
  skc = `skc-${intentId}`,
  skuCode = `sku-${intentId}`,
  plan = planHash,
  target = 100,
  runDate = '2026-08-17',
} = {}) {
  const logicalActionKey = stableInventoryHash({
    runDate,
    store: storeKey,
    skc,
    sku: skuCode,
    target,
    actionType: 'VI_OVERWRITE_TO_EXACT_USABLE_TARGET',
    policyVersion,
    authorizationId,
  });
  const request = {
    pathname: '/open-api/stock/change-inventory/v2',
    method: 'POST',
    body: {updateSkuInventoryQuantityRequests: [{
      idempotencyKey: `bi-inv-${logicalActionKey.slice(0, 42)}`,
      skuCode,
      invType: 'VI',
      changeType: 'OVERWRITE',
      changeQuantity: target + 1,
      changeReason: 'Owner-authorized daily inventory target after current-day ET and sales/exposure guard',
    }]},
    headers: {language: 'en'},
  };
  return {
    kind: 'intent',
    intentId,
    logicalActionKey,
    recoveryScopeKey: inventoryRecoveryScopeKey({runDate, storeKey, skc, skuCode}),
    planHash: plan,
    runDate,
    storeKey,
    skc,
    skuCode,
    targetUsableInventory: target,
    policyVersion,
    overwriteComputationVersion: INVENTORY_OVERWRITE_COMPUTATION_VERSION,
    authorizationId,
    idempotencyKey: request.body.updateSkuInventoryQuantityRequests[0].idempotencyKey,
    requestPayloadHash: stableInventoryHash(request),
    request,
    before: {
      totalInventoryQuantity: 74,
      totalUsableInventory: 49,
      totalLockedQuantity: 1,
      stockRowMissing: false,
    },
    recordedAt: '2026-08-17T08:00:00.000Z',
  };
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

await fs.mkdir(otherDir, {recursive: true});
const exactIntent = buildIntent({intentId: INVENTORY_MANUAL_RESOLUTION_INTENT_ID, skc: scope.skc, skuCode: scope.skuCode});
await appendDurableJournalRecord(journal, exactIntent);
for (let index = 0; index < 27; index += 1) {
  await appendDurableJournalRecord(otherJournal, buildIntent({
    intentId: `deferred-${index + 1}`,
    storeKey: 'DL',
    skc: `deferred-skc-${index + 1}`,
    skuCode: `deferred-sku-${index + 1}`,
    plan: `${String(index + 1).padStart(2, '0')}`.repeat(32),
    target: 50,
  }));
}
await writeJson(planFile, {schemaVersion: 'daily-inventory-replenishment-plan/v1', date: '2026-08-26', executable: false, payloadHash: planHash, blockers: ['missing CX SPU']});

const r1 = path.join(temp, 'r1.json');
const r2 = path.join(temp, 'r2.json');
const r1Document = {
  storeKey: 'XL',
  startedAt: '2026-08-26T04:33:05.549Z',
  endedAt: '2026-08-26T04:33:06.692Z',
  response: {
    code: 0,
    msg: 'OK',
    traceId: 'a79e7c6fe9e7127e',
    info: [{goodsInventory: [{
      skcName: scope.skc,
      skuList: [{
        skuCode: scope.skuCode,
        totalInventoryQuantity: 50,
        totalUsableInventory: 49,
        totalLockedQuantity: 1,
        totalTempLockQuantity: 0,
        warehouseInventoryList: [{warehouseCode: 'OTHER-WAREHOUSE'}, {warehouseCode: scope.warehouseCode}],
      }],
    }]}],
  },
};
await writeJson(r1, r1Document);
const wrongStoreR1 = path.join(temp, 'r1-wrong-store.json');
await writeJson(wrongStoreR1, {...r1Document, storeKey: 'DL'});
const r1NestedResponseFailure = path.join(temp, 'r1-nested-response-failure.json');
await writeJson(r1NestedResponseFailure, {
  ...r1Document,
  code: 0,
  msg: 'OK',
  traceId: 'root-success-must-not-be-used',
  response: {...r1Document.response, code: 1, msg: 'FAILED', traceId: 'nested-failure-trace'},
});
const r1NestedTraceDifferent = path.join(temp, 'r1-nested-trace-different.json');
await writeJson(r1NestedTraceDifferent, {
  ...r1Document,
  code: 0,
  msg: 'OK',
  traceId: 'root-trace-must-not-be-used',
  response: {...r1Document.response, traceId: 'nested-authoritative-trace'},
});
const r1NestedTraceMissing = path.join(temp, 'r1-nested-trace-missing.json');
await writeJson(r1NestedTraceMissing, {
  ...r1Document,
  code: 0,
  msg: 'OK',
  traceId: 'root-trace-must-not-be-used',
  response: {...r1Document.response, traceId: ''},
});
await writeJson(r2, {
  schemaVersion: 'shein-openapi-product-basics/v1',
  ok: true,
  storeKey: 'XL',
  generatedAt: '2026-08-26T13:18:40.224Z',
  code: 0,
  msg: 'OK',
  traceId: '8119d3992e8f3c7c',
  productList: [{skcName: scope.skc, skuCodeList: [scope.skuCode]}],
  stockResponses: [{
    chunkIndex: 3,
    data: {
      code: 0,
      msg: 'OK',
      traceId: '8119d3992e8f3c7c',
      info: [{goodsInventory: [{skuList: [{
        skuCode: scope.skuCode,
        totalInventoryQuantity: 50,
        totalUsableInventory: 49,
        totalLockedQuantity: 1,
        totalTempLockQuantity: 0,
        warehouseInventoryList: [{warehouseCode: scope.warehouseCode}],
      }]}]}],
    },
  }],
  normalizedRows: [{storeKey: 'XL', skc: scope.skc, skuCodes: [scope.skuCode], sheinInventoryQuantity: 50, sheinUsableInventory: 49, sheinLockedQuantity: 1}],
});
const liveInventoryBaseline = {
  source: 'R2:/srv/shein-bi/runtime/openapi-product-cache/XL/20260826T131840Z.json',
  capturedAt: now,
  scope: {...scope, scopeKey: inventoryWriteScopeKey(scope)},
  totalInventoryQuantity: 50,
  totalUsableInventory: 49,
  totalLockedQuantity: 1,
  temporaryInventoryQuantity: 0,
};
const authority = {
  capturedAt: now,
  deployedCommit: '5cc31c12476bceed5e670dc49a04e274c976f98e',
  trackedSourceClean: true,
  sourceFingerprint: '1'.repeat(64),
  releaseReceiptKind: 'emergency',
  releaseReceiptHash: '2'.repeat(64),
  releaseReceiptFile: path.join(temp, 'emergency-release-receipt.json'),
  bundleSha256: '3'.repeat(64),
  writerServices: [{unit: 'shein-bi-portal.service', generationHash: '4'.repeat(64)}],
};
const maintenance = {ok: true, active: true, mode: 'all', generation: 9, hash: '5'.repeat(64)};
const liveInventoryBaselineFile = path.join(temp, 'live-inventory-baseline.json');
const resolverLockFile = path.join(temp, 'manual-resolution.lock');
await writeJson(liveInventoryBaselineFile, liveInventoryBaseline);
const otherBefore = await fs.readFile(otherJournal, 'utf8');

const cliRequiredArgs = [
  '--journal', journal,
  '--plan', planFile,
  '--readback-artifact', r1,
  '--readback-artifact', r2,
  '--live-inventory-baseline', liveInventoryBaselineFile,
  '--owner-actor', 'owner-20260826',
  '--owner-confirmation', 'MANUAL_BASELINE_ADOPTED_EFFECT_UNKNOWN',
  '--original-trace-id', 'original-post-trace',
];
assert.equal(parseArgs(cliRequiredArgs).mode, 'dry-run', 'CLI defaults to dry-run');
assert.equal(parseArgs([...cliRequiredArgs, '--dry-run']).mode, 'dry-run');
assert.equal(parseArgs([...cliRequiredArgs, '--execute', '--expected-preflight-hash', 'a'.repeat(64)]).mode, 'execute');
assert.throws(() => parseArgs([...cliRequiredArgs, '--dry-run', '--execute']), /mutually exclusive/);

await assert.rejects(
  appendDurableJournalRecord(journal, {kind: 'manual_resolution'}),
  /INVENTORY_MANUAL_RESOLUTION_REQUIRES_CONTROLLED_RESOLVER/,
  'old producers cannot append the new schema through the generic writer',
);

const resolverInputs = (overrides = {}) => {
  const inputs = {
  journalFile: journal,
  planFile,
  readbackArtifacts: [r1, r2],
  liveInventoryBaseline: liveInventoryBaselineFile,
  ownerActor: 'owner-20260826',
  ownerConfirmation: 'MANUAL_BASELINE_ADOPTED_EFFECT_UNKNOWN',
  originalResponse: {code: '0', traceId: 'original-post-trace'},
  receiptFile,
  lockFile: resolverLockFile,
  additionalJournalDirectories: [otherDir],
  now,
  requireKnownEvidence: false,
  evidenceContract: [],
  ...overrides,
  };
  const authorityOverride = inputs.authorityOverride || {};
  const maintenanceOverride = inputs.maintenanceOverride || {};
  inputs.cutoverReader ||= async () => ({
    activated: true,
    authority: {...authority, ...authorityOverride},
    activation: {
      activationHash: '6'.repeat(64),
      authority: {...authority, ...authorityOverride},
      requiredManualResolution: {
        intentId: INVENTORY_MANUAL_RESOLUTION_INTENT_ID,
        scopeKey: inventoryWriteScopeKey(scope),
        journalFile: inputs.journalFile,
        receiptFile: inputs.receiptFile,
      },
    },
    receipt: {receiptHash: '7'.repeat(64)},
  });
  inputs.maintenanceReader ||= async () => ({...maintenance, ...maintenanceOverride});
  delete inputs.authorityOverride;
  delete inputs.maintenanceOverride;
  return inputs;
};

const initialJournalBytes = await fs.readFile(journal);
const defaultDryRun = await resolveManualInventoryIntent(resolverInputs());
assert.equal(defaultDryRun.state, 'dry_run', 'resolver defaults to dry-run');
assert.equal(defaultDryRun.mode, 'dry-run');
assert.match(defaultDryRun.preflightHash, /^[a-f0-9]{64}$/);
assert.deepEqual(await fs.readFile(journal), initialJournalBytes, 'default dry-run must not write journal');
await assert.rejects(fs.lstat(receiptFile), {code: 'ENOENT'}, 'default dry-run must not write receipt');
await assert.rejects(fs.lstat(resolverLockFile), {code: 'ENOENT'}, 'default dry-run must not acquire/write lock');

const dryRun = await resolveManualInventoryIntent(resolverInputs({mode: 'dry-run'}));
assert.equal(dryRun.state, 'dry_run');
assert.equal(dryRun.mode, 'dry-run');
assert.equal(dryRun.preflightHash, defaultDryRun.preflightHash, 'dry-run preflight hash is stable');
assert.equal(dryRun.event.liveInventoryBaseline.totalInventoryQuantity, 50);
assert.equal(dryRun.event.liveInventoryBaseline.totalUsableInventory, 49);
assert.equal(dryRun.event.productionBaseline.deployedCommit, authority.deployedCommit);
assert.equal(dryRun.event.readbackArtifacts[0].scope.storeKey, scope.storeKey);
assert.equal(dryRun.event.readbackArtifacts[0].scope.skc, scope.skc);
assert.equal(dryRun.event.readbackArtifacts[0].scope.skuCode, scope.skuCode);
assert.equal(dryRun.event.readbackArtifacts[0].scope.warehouseCode, scope.warehouseCode);
assert.equal(dryRun.event.readbackArtifacts[0].scope.invType, scope.invType);
assert.equal(dryRun.event.readbackArtifacts[0].totalInventoryQuantity, 50);
assert.equal(dryRun.event.readbackArtifacts[0].totalUsableInventory, 49);
assert.equal(dryRun.event.readbackArtifacts[0].totalLockedQuantity, 1);
assert.equal(dryRun.event.readbackArtifacts[0].temporaryInventoryQuantity, 0);
await assert.rejects(resolveManualInventoryIntent(resolverInputs({
  readbackArtifacts: [wrongStoreR1, r2],
})), /INVENTORY_MANUAL_RESOLUTION_EVIDENCE_SCOPE_MISSING/,
  'catalog artifact with wrong top-level store must fail closed');
await assert.rejects(resolveManualInventoryIntent(resolverInputs({
  readbackArtifacts: [r1NestedResponseFailure, r2],
})), /INVENTORY_MANUAL_RESOLUTION_EVIDENCE_RESPONSE_INVALID/,
  'catalog nested response failure must not be masked by root success fields');
const nestedTraceDryRun = await resolveManualInventoryIntent(resolverInputs({
  readbackArtifacts: [r1NestedTraceDifferent, r2],
}));
assert.equal(nestedTraceDryRun.event.readbackArtifacts[0].traceId, 'nested-authoritative-trace',
  'catalog extraction must bind traceId to nested response rather than root trace');
await assert.rejects(resolveManualInventoryIntent(resolverInputs({
  readbackArtifacts: [r1NestedTraceMissing, r2],
})), /INVENTORY_MANUAL_RESOLUTION_EVIDENCE_RESPONSE_INVALID/,
  'catalog missing nested trace must fail closed rather than use root trace');
const rawR2BaselineDryRun = await resolveManualInventoryIntent(resolverInputs({
  mode: 'dry-run',
  liveInventoryBaseline: r2,
}));
assert.ok(rawR2BaselineDryRun.event.liveInventoryBaseline.source.startsWith(`authoritative_readback:${r2}#sha256=`)
  && /[a-f0-9]{64}$/u.test(rawR2BaselineDryRun.event.liveInventoryBaseline.source),
  'resolver must independently extract and hash-bind the raw R2 cache as the live exact baseline');
assert.equal(rawR2BaselineDryRun.event.liveInventoryBaseline.totalUsableInventory, 49);
assert.deepEqual(await fs.readFile(journal), initialJournalBytes, 'explicit dry-run must not write journal');
await assert.rejects(fs.lstat(receiptFile), {code: 'ENOENT'}, 'explicit dry-run must not write receipt');

await assert.rejects(
  resolveManualInventoryIntent(resolverInputs({mode: 'execute'})),
  /INVENTORY_MANUAL_RESOLUTION_EXPECTED_PREFLIGHT_HASH_REQUIRED/,
  'execute requires an exact expected preflight hash',
);
await assert.rejects(
  resolveManualInventoryIntent(resolverInputs({
    mode: 'execute',
    expectedPreflightHash: 'f'.repeat(64),
  })),
  /INVENTORY_MANUAL_RESOLUTION_PREFLIGHT_HASH_MISMATCH/,
  'wrong expected preflight hash must reject without append',
);
assert.deepEqual(await fs.readFile(journal), initialJournalBytes, 'hash mismatch must not write journal');

const resolved = await resolveManualInventoryIntent(resolverInputs({
  mode: 'execute',
  expectedPreflightHash: dryRun.preflightHash,
}));
assert.equal(resolved.state, 'resolved');
assert.equal(resolved.mode, 'execute');
assert.equal(resolved.sheinPostCount, 0);
assert.equal(resolved.event.kind, 'manual_resolution');
assert.equal(resolved.event.disposition, INVENTORY_MANUAL_RESOLUTION_DISPOSITION);
assert.notEqual(resolved.event.disposition, 'readback_matched');
assert.notEqual(resolved.event.disposition, 'rejected');
assert.equal(resolved.event.scope.scopeKey, inventoryWriteScopeKey(scope));
assert.equal(resolved.event.preflightHash, dryRun.preflightHash);
assert.equal(resolved.receipt.preflightHash, dryRun.preflightHash);
assert.equal(resolved.receipt.productionBaselineHash, stableInventoryHash(resolved.event.productionBaseline));
assert.equal(resolved.receipt.liveInventoryBaselineHash, stableInventoryHash(resolved.event.liveInventoryBaseline));
validateManualResolutionReceipt(resolved.receipt, {
  eventHash: stableInventoryHash(resolved.event),
  intentId: exactIntent.intentId,
  journalFile: journal,
  event: resolved.event,
});

await fs.rm(receiptFile);
const recovered = await resolveManualInventoryIntent(resolverInputs({
  mode: 'execute',
  expectedPreflightHash: dryRun.preflightHash,
}));
assert.equal(recovered.state, 'receipt_recovered', 'same hash recovers a missing receipt');
const idempotent = await resolveManualInventoryIntent(resolverInputs({
  mode: 'execute',
  expectedPreflightHash: dryRun.preflightHash,
}));
assert.equal(idempotent.state, 'already_resolved', 'same hash is idempotent after receipt recovery');

const receiptCrashDir = path.join(temp, 'receipt-rename-crash');
const receiptCrashJournal = path.join(receiptCrashDir, 'daily-inventory-replenishment-2026-08-17.json.journal.ndjson');
const receiptCrashPlan = path.join(receiptCrashDir, 'plan.json');
const receiptCrashReceipt = path.join(receiptCrashDir, 'manual-resolution.receipt.json');
await fs.mkdir(receiptCrashDir, {recursive: true});
await appendDurableJournalRecord(receiptCrashJournal, buildIntent({
  intentId: INVENTORY_MANUAL_RESOLUTION_INTENT_ID,
  skc: scope.skc,
  skuCode: scope.skuCode,
}));
await writeJson(receiptCrashPlan, {payloadHash: planHash});
const receiptCrashInputs = resolverInputs({
  journalFile: receiptCrashJournal,
  planFile: receiptCrashPlan,
  receiptFile: receiptCrashReceipt,
  additionalJournalDirectories: [],
});
const receiptCrashDryRun = await resolveManualInventoryIntent({...receiptCrashInputs, mode: 'dry-run'});
await assert.rejects(resolveManualInventoryIntent({
  ...receiptCrashInputs,
  mode: 'execute',
  expectedPreflightHash: receiptCrashDryRun.preflightHash,
  receiptWriteOptions: {
    afterRenameHook: async ({file}) => {
      await fs.rm(file);
      throw new Error('SIMULATED_RECEIPT_RENAME_BEFORE_PARENT_FSYNC_CRASH');
    },
  },
}), /SIMULATED_RECEIPT_RENAME_BEFORE_PARENT_FSYNC_CRASH/);
await assert.rejects(fs.lstat(receiptCrashReceipt), {code: 'ENOENT'});
const receiptCrashRecovered = await resolveManualInventoryIntent({
  ...receiptCrashInputs,
  mode: 'execute',
  expectedPreflightHash: receiptCrashDryRun.preflightHash,
});
assert.equal(receiptCrashRecovered.state, 'receipt_recovered');
assert.equal(receiptCrashRecovered.sheinPostCount, 0);
const receiptCrashLines = (await fs.readFile(receiptCrashJournal, 'utf8')).trim().split(/\r?\n/u).map(JSON.parse);
assert.equal(receiptCrashLines.filter(entry => entry.kind === 'manual_resolution').length, 1,
  'rename interruption recovery must not append the terminal event twice');

const lifecycle = await readInventoryIntentLifecycle(journal, {strict: true});
assert.equal(lifecycle.manualResolutions.size, 1);
assert.equal(lifecycle.fences.size, 1);
assert.equal(lifecycle.tombstonedIdempotencyKeys.size, 1);
assert.equal(lifecycle.pending.size, 0);
assert.equal(lifecycle.terminalOutcomes.size, 0, 'manual resolution must never masquerade as write_outcome');
const bundle = await readInventoryIntentJournals([journal, otherJournal], {allowMultiplePendingByScope: true});
assert.equal(bundle.manualResolutions.size, 1);
assert.equal(bundle.fences.size, 1);
assert.equal(bundle.tombstonedIdempotencyKeys.size, 1);
assert.equal(bundle.pending.size, 27, 'only the exact XL intent is resolved; all 27 deferred historical intents remain pending');
assert.equal(await fs.readFile(otherJournal, 'utf8'), otherBefore, 'deferred historical journal is byte-for-byte untouched');

const oldKeyFence = findInventoryWriteFence(bundle, {scope, idempotencyKey: exactIntent.idempotencyKey});
assert.equal(oldKeyFence.reason, 'idempotency_key_tombstoned');
assert.throws(() => assertInventoryWriteAllowed(bundle, {scope, idempotencyKey: exactIntent.idempotencyKey}), /INVENTORY_WRITE_FENCED/);
assert.doesNotThrow(() => assertInventoryWriteAllowed(bundle, {scope: {...scope, warehouseCode: 'OTHER-WAREHOUSE'}, idempotencyKey: 'new-key'}));

let fetchCalls = 0;
const fencedClient = new SheinOpenApiClient({
  baseUrl: 'http://127.0.0.1:9',
  openKeyId: 'test-open',
  secretKey: 'test-secret',
  inventoryStoreKey: scope.storeKey,
  inventoryFenceReader: async () => bundle,
  fetchImpl: async () => {
    fetchCalls += 1;
    return {ok: true, status: 200, statusText: 'OK', text: async () => '{"code":"0"}'};
  },
});
await assert.rejects(fencedClient.request('/open-api/stock/change-inventory/v2', {
  method: 'POST',
  body: {updateSkuInventoryQuantityRequests: [{idempotencyKey: 'new-key', skuCode: scope.skuCode, invType: 'VI', warehouseCode: scope.warehouseCode}]},
}), /INVENTORY_WRITE_FENCED/);
assert.equal(fetchCalls, 0, 'public v2 lower layer must fail before signing/fetching');
await fencedClient.request('/open-api/stock/change-inventory/v2', {
  method: 'POST',
  body: {updateSkuInventoryQuantityRequests: [{idempotencyKey: 'new-key', skuCode: scope.skuCode, invType: 'VI', warehouseCode: 'OTHER-WAREHOUSE'}]},
});
assert.equal(fetchCalls, 1, 'different exact warehouse scope is not falsely fenced');

const unknownSchemaDir = path.join(temp, 'unknown-schema');
const unknownSchemaJournal = path.join(unknownSchemaDir, 'daily-inventory-replenishment-2026-08-17.json.journal.ndjson');
await fs.mkdir(unknownSchemaDir, {recursive: true});
const validEventLine = JSON.parse((await fs.readFile(journal, 'utf8')).trim().split(/\r?\n/)[1]);
await appendDurableJournalRecord(unknownSchemaJournal, exactIntent);
await fs.appendFile(unknownSchemaJournal, `${JSON.stringify({...validEventLine, schemaVersion: 'inventory-manual-resolution/v99', journalFile: unknownSchemaJournal})}\n`);
await assert.rejects(readInventoryIntentLifecycle(unknownSchemaJournal, {strict: true}), /INVENTORY_JOURNAL_SCHEMA_UNSUPPORTED/);

const malformedKnownSchemaJournal = path.join(unknownSchemaDir, 'daily-inventory-replenishment-2026-08-18.json.journal.ndjson');
await appendDurableJournalRecord(malformedKnownSchemaJournal, {...exactIntent, runDate: '2026-08-18'});
await fs.appendFile(malformedKnownSchemaJournal, `${JSON.stringify({
  ...validEventLine,
  intentId: exactIntent.intentId,
  runDate: '2026-08-18',
  journalFile: malformedKnownSchemaJournal,
  ownerConfirmation: {...validEventLine.ownerConfirmation, statement: 'tampered'},
})}\n`);
await assert.rejects(
  readInventoryIntentLifecycle(malformedKnownSchemaJournal),
  /INVENTORY_JOURNAL_MANUAL_RESOLUTION_INVALID/,
  'known manual-resolution schema must fail closed even for the legacy non-strict reader',
);

const casDir = path.join(temp, 'cas');
const casJournal = path.join(casDir, 'daily-inventory-replenishment-2026-08-17.json.journal.ndjson');
await fs.mkdir(casDir, {recursive: true});
const casIntent = buildIntent({intentId: INVENTORY_MANUAL_RESOLUTION_INTENT_ID, skc: scope.skc, skuCode: scope.skuCode});
await appendDurableJournalRecord(casJournal, casIntent);
const casPlan = path.join(temp, 'cas-plan.json');
await writeJson(casPlan, {payloadHash: planHash});
const casArtifact1 = path.join(temp, 'cas-r1.json');
const casArtifact2 = path.join(temp, 'cas-r2.json');
await writeJson(casArtifact1, {code: 0, msg: 'OK', traceId: 'cas-r1', generatedAt: now, rows: [{...scope, totalInventoryQuantity: 50, totalUsableInventory: 49, totalLockedQuantity: 1, temporaryInventoryQuantity: 0}]});
await writeJson(casArtifact2, {code: 0, msg: 'OK', traceId: 'cas-r2', generatedAt: now, rows: [{...scope, totalInventoryQuantity: 50, totalUsableInventory: 49, totalLockedQuantity: 1, temporaryInventoryQuantity: 0}]});
const casLiveBaseline = {...liveInventoryBaseline, source: 'cas-live-baseline'};
const casReceipt = path.join(casDir, 'receipt.json');
const casInputs = resolverInputs({
  journalFile: casJournal,
  planFile: casPlan,
  readbackArtifacts: [casArtifact1, casArtifact2],
  liveInventoryBaseline: casLiveBaseline,
  receiptFile: casReceipt,
  additionalJournalDirectories: [],
});
const casDryRun = await resolveManualInventoryIntent({...casInputs, mode: 'dry-run'});
await assert.rejects(resolveManualInventoryIntent({...casInputs,
  mode: 'execute',
  expectedPreflightHash: casDryRun.preflightHash,
  beforeAppendHook: async ({event}) => {
    await fs.appendFile(casJournal, `${JSON.stringify({kind: 'result', planHash: event.planHash, recordedAt: now, row: {state: 'audit-only'}})}\n`);
  },
}), /INVENTORY_MANUAL_RESOLUTION_CAS_CONFLICT/);
const casLifecycle = await readInventoryIntentLifecycle(casJournal, {strict: true});
assert.equal(casLifecycle.manualResolutions.size, 0);
assert.equal(casLifecycle.pending.size, 1);

const planDriftDir = path.join(temp, 'plan-drift');
const planDriftJournal = path.join(planDriftDir, 'daily-inventory-replenishment-2026-08-17.json.journal.ndjson');
const planDriftFile = path.join(planDriftDir, 'plan.json');
await fs.mkdir(planDriftDir, {recursive: true});
await appendDurableJournalRecord(planDriftJournal, buildIntent({intentId: INVENTORY_MANUAL_RESOLUTION_INTENT_ID, skc: scope.skc, skuCode: scope.skuCode}));
await writeJson(planDriftFile, {payloadHash: planHash});
const planDriftInputs = resolverInputs({
  journalFile: planDriftJournal,
  planFile: planDriftFile,
  readbackArtifacts: [casArtifact1, casArtifact2],
  liveInventoryBaseline: casLiveBaseline,
  receiptFile: path.join(planDriftDir, 'receipt.json'),
  additionalJournalDirectories: [],
});
const planDriftDryRun = await resolveManualInventoryIntent({...planDriftInputs, mode: 'dry-run'});
await assert.rejects(resolveManualInventoryIntent({...planDriftInputs,
  mode: 'execute',
  expectedPreflightHash: planDriftDryRun.preflightHash,
  beforeAppendHook: async () => {
    await writeJson(planDriftFile, {payloadHash: 'd'.repeat(64)});
  },
}), /INVENTORY_MANUAL_RESOLUTION_CAS_CONFLICT/, 'plan payload hash drift after lock must abort before append');
const planDriftLifecycle = await readInventoryIntentLifecycle(planDriftJournal, {strict: true});
assert.equal(planDriftLifecycle.manualResolutions.size, 0);
assert.equal(planDriftLifecycle.pending.size, 1);

const artifactDriftDir = path.join(temp, 'artifact-drift');
const artifactDriftJournal = path.join(artifactDriftDir, 'daily-inventory-replenishment-2026-08-17.json.journal.ndjson');
const artifactDriftPlan = path.join(artifactDriftDir, 'plan.json');
const artifactDriftFile = path.join(artifactDriftDir, 'r1.json');
const artifactDriftOther = path.join(artifactDriftDir, 'r2.json');
await fs.mkdir(artifactDriftDir, {recursive: true});
await appendDurableJournalRecord(artifactDriftJournal, buildIntent({intentId: INVENTORY_MANUAL_RESOLUTION_INTENT_ID, skc: scope.skc, skuCode: scope.skuCode}));
await writeJson(artifactDriftPlan, {payloadHash: planHash});
await fs.copyFile(casArtifact1, artifactDriftFile);
await fs.copyFile(casArtifact2, artifactDriftOther);
const artifactDriftInputs = resolverInputs({
  journalFile: artifactDriftJournal,
  planFile: artifactDriftPlan,
  readbackArtifacts: [artifactDriftFile, artifactDriftOther],
  liveInventoryBaseline: casLiveBaseline,
  receiptFile: path.join(artifactDriftDir, 'receipt.json'),
  additionalJournalDirectories: [],
});
const artifactDriftDryRun = await resolveManualInventoryIntent({...artifactDriftInputs, mode: 'dry-run'});
await assert.rejects(resolveManualInventoryIntent({...artifactDriftInputs,
  mode: 'execute',
  expectedPreflightHash: artifactDriftDryRun.preflightHash,
  beforeAppendHook: async () => {
    await writeJson(artifactDriftFile, {
      code: 0,
      msg: 'OK',
      traceId: 'artifact-drift-mutated',
      generatedAt: now,
      rows: [{...scope, totalInventoryQuantity: 50, totalUsableInventory: 48, totalLockedQuantity: 2, temporaryInventoryQuantity: 0}],
    });
  },
}), /INVENTORY_MANUAL_RESOLUTION_CAS_CONFLICT/, 'raw readback artifact hash drift after lock must abort before append');
const artifactDriftLifecycle = await readInventoryIntentLifecycle(artifactDriftJournal, {strict: true});
assert.equal(artifactDriftLifecycle.manualResolutions.size, 0);
assert.equal(artifactDriftLifecycle.pending.size, 1);

const baselineDriftDir = path.join(temp, 'baseline-drift');
const baselineDriftJournal = path.join(baselineDriftDir, 'daily-inventory-replenishment-2026-08-17.json.journal.ndjson');
const baselineDriftPlan = path.join(baselineDriftDir, 'plan.json');
const baselineDriftLiveFile = path.join(baselineDriftDir, 'live-inventory-baseline.json');
await fs.mkdir(baselineDriftDir, {recursive: true});
await appendDurableJournalRecord(baselineDriftJournal, buildIntent({intentId: INVENTORY_MANUAL_RESOLUTION_INTENT_ID, skc: scope.skc, skuCode: scope.skuCode}));
await writeJson(baselineDriftPlan, {payloadHash: planHash});
await fs.copyFile(casArtifact1, path.join(baselineDriftDir, 'r1.json'));
await fs.copyFile(casArtifact2, path.join(baselineDriftDir, 'r2.json'));
await writeJson(baselineDriftLiveFile, liveInventoryBaseline);
const baselineDriftBase = {
  journalFile: baselineDriftJournal,
  planFile: baselineDriftPlan,
  readbackArtifacts: [path.join(baselineDriftDir, 'r1.json'), path.join(baselineDriftDir, 'r2.json')],
  liveInventoryBaseline: baselineDriftLiveFile,
  receiptFile: path.join(baselineDriftDir, 'receipt.json'),
  additionalJournalDirectories: [],
};
const baselineDriftInputs = resolverInputs(baselineDriftBase);

const commitDryRun = await resolveManualInventoryIntent({...baselineDriftInputs, mode: 'dry-run'});
await assert.rejects(resolveManualInventoryIntent({...resolverInputs({...baselineDriftBase, authorityOverride: {deployedCommit: 'a'.repeat(40)}}),
  mode: 'execute',
  expectedPreflightHash: commitDryRun.preflightHash,
}), /INVENTORY_MANUAL_RESOLUTION_PREFLIGHT_HASH_MISMATCH/, 'deployed commit drift invalidates dry-run hash');

const receiptDryRun = await resolveManualInventoryIntent({...baselineDriftInputs, mode: 'dry-run'});
await assert.rejects(resolveManualInventoryIntent({...resolverInputs({...baselineDriftBase, authorityOverride: {releaseReceiptHash: 'b'.repeat(64)}}),
  mode: 'execute',
  expectedPreflightHash: receiptDryRun.preflightHash,
}), /INVENTORY_MANUAL_RESOLUTION_PREFLIGHT_HASH_MISMATCH/, 'release receipt drift invalidates dry-run hash');

const maintenanceDryRun = await resolveManualInventoryIntent({...baselineDriftInputs, mode: 'dry-run'});
await assert.rejects(resolveManualInventoryIntent({...resolverInputs({...baselineDriftBase, maintenanceOverride: {hash: 'e'.repeat(64)}}),
  mode: 'execute',
  expectedPreflightHash: maintenanceDryRun.preflightHash,
}), /INVENTORY_MANUAL_RESOLUTION_PREFLIGHT_HASH_MISMATCH/, 'maintenance drift invalidates dry-run hash');
const baselineDriftLifecycle = await readInventoryIntentLifecycle(baselineDriftJournal, {strict: true});
assert.equal(baselineDriftLifecycle.manualResolutions.size, 0);
assert.equal(baselineDriftLifecycle.pending.size, 1);

const tamperedReceipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
tamperedReceipt.scopeKey = '0'.repeat(64);
await writeJson(receiptFile, tamperedReceipt);
await assert.rejects(
  resolveManualInventoryIntent(resolverInputs({
    mode: 'execute',
    expectedPreflightHash: dryRun.preflightHash,
  })),
  /INVENTORY_MANUAL_RESOLUTION_RECEIPT_INVALID/,
  'receipt hash/binding drift must fail closed without appending a second event',
);
const finalLines = (await fs.readFile(journal, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
assert.equal(finalLines.filter(entry => entry.kind === 'manual_resolution').length, 1);
assert.equal(finalLines.filter(entry => entry.kind === 'write_outcome').length, 0);
assert.equal(MANUAL_READBACK_EVIDENCE_CONTRACT[0].sha256, 'd44b066ee35a622ede45ec4bd36bc633a853f2d6f869be88571da85579998c04');
assert.equal(MANUAL_READBACK_EVIDENCE_CONTRACT[1].sha256, '944d4251b28d6bcec399cbf4111f1cd8573dd16ce1f29d67270ebd717b8603c0');
assert.equal(MANUAL_READBACK_EVIDENCE_CONTRACT[1].path, '/srv/shein-bi/runtime/ops-snapshots/inventory-manual-completion-xl-20260827/xl-latest-readback.json');
assert.equal(MANUAL_READBACK_EVIDENCE_CONTRACT[1].bytes, 4685630);
assert.equal(MANUAL_READBACK_EVIDENCE_CONTRACT[1].generatedAt, '2026-08-27T09:48:38.825Z');
assert.equal(MANUAL_READBACK_EVIDENCE_CONTRACT[1].traceId, 'ddf78ae095f862ab');

console.log(JSON.stringify({
  ok: true,
  checks: [
    'manual_resolution_schema_is_append_only_and_not_write_outcome',
    'manual_resolution_defaults_and_explicit_dry_run_are_zero_write',
    'expected_preflight_hash_and_reader_first_execute_gate',
    'reader_aggregate_fence_and_old_key_tombstone',
    'exact_scope_warehouse_boundary',
    'public_v2_fence_precedes_fetch',
    'unknown_schema_fails_closed',
    'cas_global_journal_drift',
    'plan_and_readback_hash_drift',
    'commit_receipt_maintenance_baseline_drift',
    'receipt_hash_drift',
    'same_hash_receipt_recovery_and_idempotence',
    'receipt_rename_before_parent_fsync_crash_recovers_without_duplicate_append',
    '27_deferred_historical_intents_untouched',
    'known_r1_r2_evidence_contract_bound',
    'raw_r2_cache_independently_extracts_hash_bound_live_baseline',
  ],
}, null, 2));
