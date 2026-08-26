#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  appendDurableJournalRecord,
  assertInventoryWriteAllowed,
  classifyRecoveredInventoryIntent,
  inventoryRecoveryScopeKey,
  readInventoryIntentLifecycle,
  readInventoryIntentJournals,
  readPendingInventoryIntents,
  recoveredInventoryIntentMismatch,
  submitDurableInventoryWriteOnce,
} from '../lib/durable_inventory_write.mjs';
import {withInventoryCutoverLock} from '../lib/inventory_write_cutover.mjs';
import {
  INVENTORY_OVERWRITE_COMPUTATION_VERSION,
  stableInventoryHash,
} from '../lib/inventory_replenishment_policy.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'durable-inventory-write-'));
const journal = path.join(temp, 'result.journal.ndjson');
const intent = {
  kind: 'intent',
  intentId: 'intent-1',
  logicalActionKey: 'a'.repeat(64),
  runDate: '2026-08-16',
  storeKey: 'DL',
  skc: 'skc-1',
  skuCode: 'sku-1',
  targetUsableInventory: 100,
  idempotencyKey: `bi-inv-${'a'.repeat(42)}`,
  requestPayloadHash: 'b'.repeat(64),
  request: {body: {updateSkuInventoryQuantityRequests: [{changeQuantity: 100}]}},
};

function buildStrictIntent({
  runDate,
  policyVersion,
  changeQuantity,
  overwriteComputationVersion,
  intentId,
} = {}) {
  const target = 69;
  const before = {
    totalInventoryQuantity: 9,
    totalUsableInventory: 8,
    totalLockedQuantity: 0,
    stockRowMissing: false,
  };
  const storeKey = 'DL';
  const skc = 'OLD-EXACT-USABLE-SKC';
  const skuCode = 'OLD-EXACT-USABLE-SKU';
  const authorizationId = 'owner-legacy-test';
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
      changeQuantity,
      changeReason: 'Owner-authorized daily inventory target after current-day ET and sales/exposure guard',
    }]},
    headers: {language: 'en'},
  };
  return {
    kind: 'intent',
    intentId,
    logicalActionKey,
    recoveryScopeKey: inventoryRecoveryScopeKey({runDate, storeKey, skc, skuCode}),
    planHash: 'c'.repeat(64),
    runDate,
    storeKey,
    skc,
    skuCode,
    targetUsableInventory: target,
    policyVersion,
    ...(overwriteComputationVersion === undefined ? {} : {overwriteComputationVersion}),
    authorizationId,
    idempotencyKey: request.body.updateSkuInventoryQuantityRequests[0].idempotencyKey,
    requestPayloadHash: stableInventoryHash(request),
    request,
    before,
    recordedAt: '2026-08-17T08:00:00.000Z',
  };
}

try {
  const mixedEtJournal = path.join(temp, 'mixed-et-run-and-inventory.journal.ndjson');
  const mixedEtIntent = buildStrictIntent({
    runDate: '2026-08-23',
    policyVersion: '2026-08-23.1',
    changeQuantity: 69,
    overwriteComputationVersion: INVENTORY_OVERWRITE_COMPUTATION_VERSION,
    intentId: 'mixed-et-inventory-intent',
  });
  await appendDurableJournalRecord(mixedEtJournal, {
    kind: 'executor_run_intent',
    intentId: 'mixed-et-run-intent',
    phase: 'executing',
    attemptId: 'attempt-1',
    runDate: '2026-08-23',
    batchId: 'batch-1',
    manifestHash: 'd'.repeat(64),
    planHash: mixedEtIntent.planHash,
    actionCount: 1,
    resultAttempt: '/tmp/result-attempt.json',
    recordedAt: new Date().toISOString(),
  });
  await appendDurableJournalRecord(mixedEtJournal, mixedEtIntent);
  const mixedEtLifecycle = await readInventoryIntentLifecycle(mixedEtJournal, {strict: true, maxRunDate: '2026-08-23'});
  assert.equal(mixedEtLifecycle.intents.size, 1, 'outer ET run records must not become inventory intents');
  assert.equal(mixedEtLifecycle.pending.has(mixedEtIntent.intentId), true, 'the co-located inventory intent must remain recoverable');

  let submitCalls = 0;
  let readbackCalls = 0;
  const admitInventoryWrite = async () => ({allowed: true});
  const delayed = await submitDurableInventoryWriteOnce({
    journalFile: journal,
    intent,
    assertInventoryAdmission: admitInventoryWrite,
    submit: async () => {
      submitCalls += 1;
      return {ok: true, status: 200, data: {code: '0', info: {success: true}}};
    },
    readback: async () => {
      readbackCalls += 1;
      return {totalUsableInventory: 20};
    },
    maxReadbackAttempts: 10,
  });
  assert.equal(submitCalls, 1, 'ten delayed readbacks must never cause a second POST');
  assert.equal(readbackCalls, 10);
  assert.equal(delayed.state, 'submitted_but_readback_pending');
  let pending = await readPendingInventoryIntents(journal);
  assert.equal(pending.has(intent.intentId), true, 'pending submission remains durably locked');
  assert.equal(classifyRecoveredInventoryIntent(pending.get(intent.intentId), 20), 'submitted_but_readback_pending');
  assert.equal(classifyRecoveredInventoryIntent(pending.get(intent.intentId), 100), 'readback_matched');

  const releaseJournal = path.join(temp, 'post-response-lock-release.journal.ndjson');
  const releaseLock = path.join(temp, 'post-response-lock-release.lock');
  const releaseIntent = buildStrictIntent({
    runDate: '2026-08-23',
    policyVersion: '2026-08-23.1',
    changeQuantity: 69,
    overwriteComputationVersion: INVENTORY_OVERWRITE_COMPUTATION_VERSION,
    intentId: 'post-response-lock-release-intent',
  });
  let releaseReadback;
  const readbackStarted = new Promise(resolve => { releaseReadback = resolve; });
  let unblockReadback;
  const readbackGate = new Promise(resolve => { unblockReadback = resolve; });
  let releasePostCalls = 0;
  const pendingSubmission = submitDurableInventoryWriteOnce({
    journalFile: releaseJournal,
    intent: releaseIntent,
    inventoryCutoverLock: releaseLock,
    readFenceBundle: async () => readInventoryIntentJournals([releaseJournal], {allowMultiplePendingByScope: true}),
    assertInventoryAdmission: async () => {
      const bundle = await readInventoryIntentJournals([releaseJournal], {allowMultiplePendingByScope: true});
      return assertInventoryWriteAllowed(bundle, {
        scope: releaseIntent,
        idempotencyKey: releaseIntent.idempotencyKey,
        requestPayloadHash: releaseIntent.requestPayloadHash,
        intentId: releaseIntent.intentId,
        logicalActionKey: releaseIntent.logicalActionKey,
      });
    },
    submit: async () => {
      releasePostCalls += 1;
      return {ok: true, status: 200, data: {code: '0', info: {success: true}}};
    },
    readback: async () => {
      releaseReadback();
      await readbackGate;
      return {totalUsableInventory: releaseIntent.targetUsableInventory};
    },
    maxReadbackAttempts: 1,
  });
  await readbackStarted;
  let competingLockAcquired = false;
  await withInventoryCutoverLock(async () => { competingLockAcquired = true; }, {
    lockFile: releaseLock,
    timeoutMs: 2_000,
    timeoutCode: 'TEST_POST_RESPONSE_LOCK_STILL_HELD',
  });
  assert.equal(competingLockAcquired, true, 'cutover lock must release before readback completes');
  assert.equal(releasePostCalls, 1, 'lock release must not cause a duplicate POST');
  const duplicateIntent = {...releaseIntent, intentId: 'post-response-lock-release-duplicate'};
  let duplicatePostCalls = 0;
  await assert.rejects(submitDurableInventoryWriteOnce({
    journalFile: releaseJournal,
    intent: duplicateIntent,
    inventoryCutoverLock: releaseLock,
    readFenceBundle: async () => readInventoryIntentJournals([releaseJournal], {allowMultiplePendingByScope: true}),
    assertInventoryAdmission: async () => {
      const bundle = await readInventoryIntentJournals([releaseJournal], {allowMultiplePendingByScope: true});
      return assertInventoryWriteAllowed(bundle, {
        scope: duplicateIntent,
        idempotencyKey: duplicateIntent.idempotencyKey,
        requestPayloadHash: duplicateIntent.requestPayloadHash,
        intentId: duplicateIntent.intentId,
        logicalActionKey: duplicateIntent.logicalActionKey,
      });
    },
    submit: async () => {
      duplicatePostCalls += 1;
      return {ok: true, status: 200, data: {code: '0', info: {success: true}}};
    },
    readback: async () => ({totalUsableInventory: duplicateIntent.targetUsableInventory}),
    maxReadbackAttempts: 1,
  }), /INVENTORY_WRITE_PENDING_CONFLICT/);
  assert.equal(duplicatePostCalls, 0, 'a second writer is blocked before transport while first readback is pending');
  assert.equal((await readInventoryIntentLifecycle(releaseJournal)).intents.size, 1, 'journal keeps exactly one intent');
  unblockReadback();
  assert.equal((await pendingSubmission).state, 'readback_matched');

  const expected = {
    logicalActionKey: intent.logicalActionKey,
    plan: {payloadHash: '1'.repeat(64), date: intent.runDate, policyVersion: 'policy-v1'},
    row: {storeKey: intent.storeKey, skc: intent.skc, skuCode: intent.skuCode},
    approvedTarget: intent.targetUsableInventory,
    authorizationId: 'auth-v1',
  };
  const exactRequest = {
    pathname: '/open-api/stock/change-inventory/v2',
    method: 'POST',
    body: {updateSkuInventoryQuantityRequests: [{
      idempotencyKey: intent.idempotencyKey,
      skuCode: intent.skuCode,
      invType: 'VI',
      changeType: 'OVERWRITE',
      changeQuantity: 100,
      changeReason: 'Owner-authorized daily inventory target after current-day ET and sales/exposure guard',
    }]},
    headers: {language: 'en'},
  };
  const exactIntent = {...intent, recoveryScopeKey: inventoryRecoveryScopeKey({runDate:intent.runDate,storeKey:intent.storeKey,skc:intent.skc,skuCode:intent.skuCode}), planHash: expected.plan.payloadHash, policyVersion: expected.plan.policyVersion, overwriteComputationVersion: INVENTORY_OVERWRITE_COMPUTATION_VERSION, authorizationId: expected.authorizationId, before: {totalInventoryQuantity: 20, totalUsableInventory: 20, totalLockedQuantity: 0, stockRowMissing:false}, request: exactRequest, requestPayloadHash: stableInventoryHash(exactRequest)};
  assert.equal(recoveredInventoryIntentMismatch(exactIntent, expected), '');
  assert.equal(recoveredInventoryIntentMismatch({...exactIntent, planHash: '2'.repeat(64)}, expected), 'planHash', 'cross-planHash intent must never upgrade to current success');
  assert.equal(recoveredInventoryIntentMismatch({...exactIntent, authorizationId: 'other'}, expected), 'authorizationId');
  assert.equal(recoveredInventoryIntentMismatch({...exactIntent, requestPayloadHash: '0'.repeat(64)}, expected), 'requestPayloadHash');
  const missingOverwriteVersion = {...exactIntent};
  delete missingOverwriteVersion.overwriteComputationVersion;
  assert.equal(recoveredInventoryIntentMismatch(missingOverwriteVersion, expected), 'overwriteComputationVersion');
  assert.equal(recoveredInventoryIntentMismatch({...exactIntent, overwriteComputationVersion: 'unknown/v9'}, expected), 'overwriteComputationVersion');
  const changedAuthorizationLogicalKey = stableInventoryHash({runDate:intent.runDate,store:intent.storeKey,skc:intent.skc,sku:intent.skuCode,target:80,actionType:'VI_OVERWRITE_TO_EXACT_USABLE_TARGET',policyVersion:'policy-v2',authorizationId:'auth-v2'});
  assert.notEqual(changedAuthorizationLogicalKey, intent.logicalActionKey);
  assert.equal(
    inventoryRecoveryScopeKey({runDate:intent.runDate,storeKey:intent.storeKey,skc:intent.skc,skuCode:intent.skuCode}),
    exactIntent.recoveryScopeKey,
    'target/policy/authorization drift must still hit the old intent recovery scope',
  );

  // Exact-usable overwrite changed on 2026-08-22. A historical intent without
  // a version may use either the current locked-only formula or the known
  // legacy max-gap formula, but any other quantity must fail closed.
  const historicalLegacyIntent = buildStrictIntent({
    runDate: '2026-08-17',
    policyVersion: '2026-08-12.2',
    changeQuantity: 70,
    intentId: 'historical-legacy-gap-1',
  });
  const historicalLegacyJournal = path.join(temp, 'daily-inventory-replenishment-2026-08-17.json.journal.ndjson');
  await appendDurableJournalRecord(historicalLegacyJournal, historicalLegacyIntent);
  const historicalLifecycle = await readInventoryIntentLifecycle(historicalLegacyJournal, {strict: true, maxRunDate: '2026-08-23'});
  assert.equal(historicalLifecycle.pending.has(historicalLegacyIntent.intentId), true, 'old unversioned max-gap intent must remain strictly readable');
  const historicalPlan = {
    payloadHash: historicalLegacyIntent.planHash,
    date: historicalLegacyIntent.runDate,
    policyVersion: historicalLegacyIntent.policyVersion,
  };
  assert.equal(
    recoveredInventoryIntentMismatch(historicalLegacyIntent, {
      logicalActionKey: historicalLegacyIntent.logicalActionKey,
      plan: historicalPlan,
      row: {
        storeKey: historicalLegacyIntent.storeKey,
        skc: historicalLegacyIntent.skc,
        skuCode: historicalLegacyIntent.skuCode,
      },
      approvedTarget: historicalLegacyIntent.targetUsableInventory,
      authorizationId: historicalLegacyIntent.authorizationId,
      requireCurrentOverwriteComputationVersion: false,
    }),
    '',
    'historical reconcile-only must accept the unversioned legacy max-gap formula',
  );
  const historicalCurrentIntent = buildStrictIntent({
    runDate: '2026-08-17',
    policyVersion: '2026-08-12.2',
    changeQuantity: 69,
    intentId: 'historical-current-locked-only-1',
  });
  assert.equal(
    recoveredInventoryIntentMismatch(historicalCurrentIntent, {
      logicalActionKey: historicalCurrentIntent.logicalActionKey,
      plan: {...historicalPlan, payloadHash: historicalCurrentIntent.planHash},
      row: {
        storeKey: historicalCurrentIntent.storeKey,
        skc: historicalCurrentIntent.skc,
        skuCode: historicalCurrentIntent.skuCode,
      },
      approvedTarget: historicalCurrentIntent.targetUsableInventory,
      authorizationId: historicalCurrentIntent.authorizationId,
      requireCurrentOverwriteComputationVersion: false,
    }),
    '',
    'historical reconcile-only must also accept the unversioned current locked-only formula',
  );

  const invalidHistoricalJournal = path.join(temp, 'daily-inventory-replenishment-2026-08-17-invalid.json.journal.ndjson');
  await appendDurableJournalRecord(invalidHistoricalJournal, {...historicalLegacyIntent, intentId: 'historical-invalid-quantity-1', request: {
    ...historicalLegacyIntent.request,
    body: {updateSkuInventoryQuantityRequests: [{
      ...historicalLegacyIntent.request.body.updateSkuInventoryQuantityRequests[0],
      changeQuantity: 71,
    }]},
  }, requestPayloadHash: stableInventoryHash({
    ...historicalLegacyIntent.request,
    body: {updateSkuInventoryQuantityRequests: [{
      ...historicalLegacyIntent.request.body.updateSkuInventoryQuantityRequests[0],
      changeQuantity: 71,
    }]},
  })});
  await assert.rejects(
    readInventoryIntentLifecycle(invalidHistoricalJournal, {strict: true, maxRunDate: '2026-08-23'}),
    /INVENTORY_JOURNAL_IMMUTABLE_INVALID:.*:request\.changeQuantity/,
    'unversioned quantities outside current or known legacy formulas must fail closed',
  );

  const currentVersionIntent = buildStrictIntent({
    runDate: '2026-08-23',
    policyVersion: '2026-08-23.1',
    changeQuantity: 69,
    overwriteComputationVersion: INVENTORY_OVERWRITE_COMPUTATION_VERSION,
    intentId: 'current-locked-only-1',
  });
  const currentVersionJournal = path.join(temp, 'daily-inventory-replenishment-2026-08-23.json.journal.ndjson');
  await appendDurableJournalRecord(currentVersionJournal, currentVersionIntent);
  const currentVersionLifecycle = await readInventoryIntentLifecycle(currentVersionJournal, {strict: true, maxRunDate: '2026-08-23'});
  assert.equal(currentVersionLifecycle.pending.has(currentVersionIntent.intentId), true, 'current version with locked-only quantity must pass strict read');

  const currentUnversionedJournal = path.join(temp, 'daily-inventory-replenishment-2026-08-23-unversioned.journal.ndjson');
  const currentUnversionedIntent = {...currentVersionIntent, intentId: 'current-unversioned-1'};
  delete currentUnversionedIntent.overwriteComputationVersion;
  await appendDurableJournalRecord(currentUnversionedJournal, currentUnversionedIntent);
  await assert.rejects(
    readInventoryIntentLifecycle(currentUnversionedJournal, {strict: true, maxRunDate: '2026-08-23'}),
    /INVENTORY_JOURNAL_IMMUTABLE_INVALID:.*:overwriteComputationVersion/,
    'an unversioned current-day intent must fail even when its quantity matches locked-only',
  );

  const invalidRecordedAtJournal = path.join(temp, 'daily-inventory-replenishment-2026-08-23-invalid-recorded-at.journal.ndjson');
  await appendDurableJournalRecord(invalidRecordedAtJournal, {...currentVersionIntent, intentId: 'current-invalid-recorded-at-1', recordedAt: 'not-a-timestamp'});
  await assert.rejects(
    readInventoryIntentLifecycle(invalidRecordedAtJournal, {strict: true, maxRunDate: '2026-08-23'}),
    /INVENTORY_JOURNAL_IMMUTABLE_INVALID:.*:recordedAt/,
    'strict intents must carry a valid recordedAt for terminal outcome ordering',
  );

  const currentWrongQuantityJournal = path.join(temp, 'daily-inventory-replenishment-2026-08-23-wrong-quantity.json.journal.ndjson');
  await appendDurableJournalRecord(currentWrongQuantityJournal, {...currentVersionIntent, intentId: 'current-locked-only-wrong-quantity-1', request: {
    ...currentVersionIntent.request,
    body: {updateSkuInventoryQuantityRequests: [{
      ...currentVersionIntent.request.body.updateSkuInventoryQuantityRequests[0],
      changeQuantity: 70,
    }]},
  }, requestPayloadHash: stableInventoryHash({
    ...currentVersionIntent.request,
    body: {updateSkuInventoryQuantityRequests: [{
      ...currentVersionIntent.request.body.updateSkuInventoryQuantityRequests[0],
      changeQuantity: 70,
    }]},
  })});
  await assert.rejects(
    readInventoryIntentLifecycle(currentWrongQuantityJournal, {strict: true, maxRunDate: '2026-08-23'}),
    /INVENTORY_JOURNAL_IMMUTABLE_INVALID:.*:request\.changeQuantity/,
    'current locked-only version must reject the legacy max-gap quantity',
  );

  const unknownVersionJournal = path.join(temp, 'daily-inventory-replenishment-2026-08-23-unknown-version.json.journal.ndjson');
  await appendDurableJournalRecord(unknownVersionJournal, {...currentVersionIntent, intentId: 'current-unknown-version-1', overwriteComputationVersion: 'unknown/v9'});
  await assert.rejects(
    readInventoryIntentLifecycle(unknownVersionJournal, {strict: true, maxRunDate: '2026-08-23'}),
    /INVENTORY_JOURNAL_IMMUTABLE_INVALID:.*:overwriteComputationVersion/,
    'unknown explicit overwrite computation versions must fail closed',
  );

  const explicitLegacyVersionJournal = path.join(temp, 'daily-inventory-replenishment-2026-08-23-explicit-legacy-version.json.journal.ndjson');
  await appendDurableJournalRecord(explicitLegacyVersionJournal, {
    ...historicalLegacyIntent,
    intentId: 'explicit-legacy-version-1',
    overwriteComputationVersion: 'max-gap/v1',
  });
  await assert.rejects(
    readInventoryIntentLifecycle(explicitLegacyVersionJournal, {strict: true, maxRunDate: '2026-08-23'}),
    /INVENTORY_JOURNAL_IMMUTABLE_INVALID:.*:overwriteComputationVersion/,
    'legacy max-gap is compatible only for unversioned historical records and must not be explicitly selectable',
  );
  const duplicateJournal = path.join(temp, 'duplicate-intents.journal.ndjson');
  await appendDurableJournalRecord(duplicateJournal, {...exactIntent, intentId:'duplicate-1'});
  await appendDurableJournalRecord(duplicateJournal, {...exactIntent, intentId:'duplicate-2'});
  const duplicateIntents = [...(await readPendingInventoryIntents(duplicateJournal)).values()];
  assert.equal(duplicateIntents.length, 2, 'same logical key intents must never overwrite each other');
  assert.equal(new Set(duplicateIntents.map(row => row.recoveryScopeKey)).size, 1, 'both duplicate intents remain visible in the same recovery scope');

  const crashJournal = path.join(temp, 'crash.journal.ndjson');
  let crashSubmitCalls = 0;
  await assert.rejects(submitDurableInventoryWriteOnce({
    journalFile: crashJournal,
    intent,
    assertInventoryAdmission: admitInventoryWrite,
    submit: async () => {
      crashSubmitCalls += 1;
      throw new Error('simulated connection loss after platform acceptance');
    },
    readback: async () => ({totalUsableInventory: 20}),
  }), error => error.inventoryIntentDurable === true);
  assert.equal(crashSubmitCalls, 1);
  pending = await readPendingInventoryIntents(crashJournal);
  assert.equal(pending.has(intent.intentId), true, 'crash after submit preserves the pre-submit intent');

  const rejectedJournal = path.join(temp, 'rejected.journal.ndjson');
  const rejected = await submitDurableInventoryWriteOnce({
    journalFile: rejectedJournal,
    intent,
    assertInventoryAdmission: admitInventoryWrite,
    submit: async () => ({ok: true, status: 200, data: {code: '400', info: {success: false}}}),
    readback: async () => ({totalUsableInventory: 20}),
  });
  assert.equal(rejected.state, 'rejected');
  assert.equal((await readPendingInventoryIntents(rejectedJournal)).has(intent.intentId), false, 'definitive rejection releases the durable intent');

  const strictRejectedIntent = buildStrictIntent({
    runDate: '2026-08-17',
    policyVersion: '2026-08-12.2',
    changeQuantity: 70,
    intentId: 'strict-rejected-1',
  });
  const strictRejectedJournal = path.join(temp, 'strict-rejected.journal.ndjson');
  const strictRejected = await submitDurableInventoryWriteOnce({
    journalFile: strictRejectedJournal,
    intent: strictRejectedIntent,
    assertInventoryAdmission: admitInventoryWrite,
    submit: async () => ({ok: true, status: 200, data: {code: '400', info: {success: false}}}),
    readback: async () => ({totalUsableInventory: 69}),
  });
  assert.equal(strictRejected.state, 'rejected');
  const strictRejectedEntries = (await fs.readFile(strictRejectedJournal, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
  const strictRejectedOutcome = strictRejectedEntries.find(entry => entry.kind === 'write_outcome');
  assert.deepEqual(Object.keys(strictRejectedOutcome).sort(), ['code', 'disposition', 'httpOk', 'httpStatus', 'intentId', 'kind', 'logicalActionKey', 'recordedAt', 'success']);
  assert.equal(strictRejectedOutcome.httpOk, true);
  assert.equal(strictRejectedOutcome.httpStatus, 200);
  assert.equal(strictRejectedOutcome.success, false);
  const strictRejectedLifecycle = await readInventoryIntentLifecycle(strictRejectedJournal, {strict: true, maxRunDate: '2026-08-23'});
  assert.equal(strictRejectedLifecycle.pending.has(strictRejectedIntent.intentId), false, 'the exact definitive rejection shape must release pending');

  const rejectedOutcomeBase = {
    kind: 'write_outcome',
    intentId: strictRejectedIntent.intentId,
    logicalActionKey: strictRejectedIntent.logicalActionKey,
    disposition: 'rejected',
    recordedAt: new Date().toISOString(),
    code: '400',
    httpOk: true,
    httpStatus: 200,
    success: false,
  };
  for (const [label, code] of [['plain', '0'], ['whitespace', ' 0 ']]) {
    const strictCodeZeroJournal = path.join(temp, `strict-rejected-code-zero-${label}.journal.ndjson`);
    const strictCodeZeroIntent = {...strictRejectedIntent, intentId: `strict-rejected-code-zero-${label}`};
    await appendDurableJournalRecord(strictCodeZeroJournal, strictCodeZeroIntent);
    await appendDurableJournalRecord(strictCodeZeroJournal, {...rejectedOutcomeBase, intentId: strictCodeZeroIntent.intentId, code});
    await assert.rejects(
      readInventoryIntentLifecycle(strictCodeZeroJournal, {strict: true, maxRunDate: '2026-08-23'}),
      /INVENTORY_JOURNAL_OUTCOME_INVALID:.*:code/,
      `strict rejected outcomes must reject ${label} code 0`,
    );
  }

  for (const [missingField, mutate] of [
    ['logicalActionKey', outcome => { delete outcome.logicalActionKey; }],
    ['recordedAt', outcome => { delete outcome.recordedAt; }],
    ['code', outcome => { delete outcome.code; }],
    ['httpOk', outcome => { delete outcome.httpOk; }],
    ['httpStatus', outcome => { delete outcome.httpStatus; }],
    ['success', outcome => { delete outcome.success; }],
  ]) {
    const malformedRejectedJournal = path.join(temp, `strict-rejected-missing-${missingField}.journal.ndjson`);
    const malformedRejectedIntent = {...strictRejectedIntent, intentId: `strict-rejected-missing-${missingField}`};
    await appendDurableJournalRecord(malformedRejectedJournal, malformedRejectedIntent);
    const malformedOutcome = {...rejectedOutcomeBase, intentId: malformedRejectedIntent.intentId};
    mutate(malformedOutcome);
    await appendDurableJournalRecord(malformedRejectedJournal, malformedOutcome);
    await assert.rejects(
      readInventoryIntentLifecycle(malformedRejectedJournal, {strict: true, maxRunDate: '2026-08-23'}),
      new RegExp(`INVENTORY_JOURNAL_(?:OUTCOME|CONFLICT).*${missingField}`),
      `strict rejected outcome missing ${missingField} must fail closed`,
    );
  }

  const outOfOrderOutcomeJournal = path.join(temp, 'strict-rejected-out-of-order.journal.ndjson');
  const outOfOrderIntent = {...strictRejectedIntent, intentId: 'strict-rejected-out-of-order'};
  await appendDurableJournalRecord(outOfOrderOutcomeJournal, outOfOrderIntent);
  await appendDurableJournalRecord(outOfOrderOutcomeJournal, {
    ...rejectedOutcomeBase,
    intentId: outOfOrderIntent.intentId,
    recordedAt: new Date(new Date(outOfOrderIntent.recordedAt).getTime() - 1).toISOString(),
  });
  await assert.rejects(
    readInventoryIntentLifecycle(outOfOrderOutcomeJournal, {strict: true, maxRunDate: '2026-08-23'}),
    /INVENTORY_JOURNAL_OUTCOME_INVALID:.*:recordedAtOrder/,
    'terminal outcomes recorded before their intent must fail closed',
  );

  for (const [label, recordedAt] of [
    ['timezone_missing', '2026-08-23T08:00:00'],
    ['date_only', '2026-08-23'],
    ['invalid_calendar_date', '2026-02-30T08:00:00Z'],
    ['too_far_future', new Date(Date.now() + 10 * 60 * 1000).toISOString()],
  ]) {
    const invalidTimeJournal = path.join(temp, `strict-rejected-invalid-time-${label}.journal.ndjson`);
    const invalidTimeIntent = {...strictRejectedIntent, intentId: `strict-rejected-invalid-time-${label}`};
    await appendDurableJournalRecord(invalidTimeJournal, invalidTimeIntent);
    await appendDurableJournalRecord(invalidTimeJournal, {
      ...rejectedOutcomeBase,
      intentId: invalidTimeIntent.intentId,
      recordedAt,
    });
    await assert.rejects(
      readInventoryIntentLifecycle(invalidTimeJournal, {strict: true, maxRunDate: '2026-08-23'}),
      /INVENTORY_JOURNAL_OUTCOME_INVALID:.*:recordedAt/,
      `terminal outcome timestamp ${label} must fail closed`,
    );
  }

  const malformedCodeJournal = path.join(temp, 'malformed-response-code.journal.ndjson');
  const malformedCode = await submitDurableInventoryWriteOnce({
    journalFile: malformedCodeJournal,
    intent: {...intent, intentId: 'intent-malformed-code'},
    assertInventoryAdmission: admitInventoryWrite,
    submit: async () => ({ok: true, status: 200, data: {code: {unexpected: true}, info: {success: false}}}),
    readback: async () => ({totalUsableInventory: 100}),
  });
  assert.equal(malformedCode.state, 'ambiguous_response');
  assert.equal((await readPendingInventoryIntents(malformedCodeJournal)).has('intent-malformed-code'), true, 'non-scalar response codes must retain the intent');

  for (const [label, code] of [['plain', '0'], ['whitespace', ' 0 ']]) {
    const codeZeroFailureJournal = path.join(temp, `ambiguous-code-zero-business-failure-${label}.journal.ndjson`);
    const codeZeroFailureIntentId = `intent-code-zero-business-failure-${label}`;
    const codeZeroFailure = await submitDurableInventoryWriteOnce({
      journalFile: codeZeroFailureJournal,
      intent: {...intent, intentId: codeZeroFailureIntentId},
      assertInventoryAdmission: admitInventoryWrite,
      submit: async () => ({ok: true, status: 200, data: {code, info: {success: false}}}),
      readback: async () => ({totalUsableInventory: 100}),
    });
    assert.equal(codeZeroFailure.state, 'ambiguous_response');
    assert.equal((await readPendingInventoryIntents(codeZeroFailureJournal)).has(codeZeroFailureIntentId), true, `${label} code 0 with success=false must retain the intent`);
    const codeZeroFailureEntries = (await fs.readFile(codeZeroFailureJournal, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(codeZeroFailureEntries.some(entry => entry.kind === 'write_outcome'), false, `${label} code 0 with success=false must not write a terminal outcome`);
  }

  for (const [label, response] of [
    ['http_502', {ok: false, status: 502, data: {code: '502', info: {success: false}}}],
    ['business_conflict', {ok: true, status: 200, data: {code: '400', info: {success: true}}}],
    ['business_failure_missing', {ok: true, status: 200, data: {code: '400', info: {}}}],
  ]) {
    const ambiguousRejectionJournal = path.join(temp, `ambiguous-rejection-${label}.journal.ndjson`);
    const ambiguousIntentId = `intent-ambiguous-rejection-${label}`;
    const outcome = await submitDurableInventoryWriteOnce({
      journalFile: ambiguousRejectionJournal,
      intent: {...intent, intentId: ambiguousIntentId},
      assertInventoryAdmission: admitInventoryWrite,
      submit: async () => response,
      readback: async () => ({totalUsableInventory: 100}),
    });
    assert.equal(outcome.state, 'ambiguous_response');
    assert.equal((await readPendingInventoryIntents(ambiguousRejectionJournal)).has(ambiguousIntentId), true, `${label} must retain the intent and forbid a second POST`);
  }

  const codeZeroMissingSuccessJournal = path.join(temp, 'code-zero-missing-success.journal.ndjson');
  let codeZeroMissingSuccessReadbacks = 0;
  const codeZeroMissingSuccess = await submitDurableInventoryWriteOnce({
    journalFile: codeZeroMissingSuccessJournal,
    intent: {...intent, intentId: 'intent-code-zero-missing-success'},
    assertInventoryAdmission: admitInventoryWrite,
    submit: async () => ({ok: true, status: 200, data: {code: '0'}}),
    readback: async () => {
      codeZeroMissingSuccessReadbacks += 1;
      return {totalUsableInventory: 100};
    },
  });
  assert.equal(codeZeroMissingSuccess.state, 'readback_matched');
  assert.equal(codeZeroMissingSuccessReadbacks, 1, 'HTTP 2xx code=0 without info.success must perform authoritative readback');
  assert.equal((await readPendingInventoryIntents(codeZeroMissingSuccessJournal)).has('intent-code-zero-missing-success'), false, 'an exact readback must terminalize code=0 without info.success');
  const codeZeroMissingSuccessEntries = (await fs.readFile(codeZeroMissingSuccessJournal, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
  assert.deepEqual(
    codeZeroMissingSuccessEntries.filter(entry => entry.kind === 'write_outcome').map(entry => entry.disposition),
    ['readback_matched'],
    'code=0 without info.success must write only the exact-match terminal outcome',
  );
  const missingCodeJournal = path.join(temp, 'missing-code.journal.ndjson');
  const missingCode = await submitDurableInventoryWriteOnce({
    journalFile: missingCodeJournal,
    intent: {...intent, intentId: 'intent-missing-code'},
    assertInventoryAdmission: admitInventoryWrite,
    submit: async () => ({ok: true, status: 200, data: {info: {success: true}}}),
    readback: async () => ({totalUsableInventory: 100}),
  });
  assert.equal(missingCode.state, 'ambiguous_response');
  assert.equal((await readPendingInventoryIntents(missingCodeJournal)).has('intent-missing-code'), true, 'missing response code must never release the intent');

  const tornJournal = path.join(temp, 'torn.journal.ndjson');
  await appendDurableJournalRecord(tornJournal, intent);
  await fs.appendFile(tornJournal, '{torn');
  await assert.rejects(readPendingInventoryIntents(tornJournal), /INVENTORY_JOURNAL_TORN_TAIL/);
  let postAfterTorn = 0;
  await assert.rejects(submitDurableInventoryWriteOnce({
    journalFile: tornJournal,
    intent: {...intent, intentId: 'intent-after-torn'},
    assertInventoryAdmission: admitInventoryWrite,
    submit: async () => { postAfterTorn += 1; return {data:{code:'0',info:{success:true}}}; },
    readback: async () => ({totalUsableInventory:100}),
  }), /INVENTORY_JOURNAL_TORN_TAIL/);
  assert.equal(postAfterTorn, 0, 'a torn tail must block append before any later POST');

  console.log(JSON.stringify({ok: true, checks: [
    'one_post_only',
    'mixed_et_executor_run_records_are_ignored_by_inventory_lifecycle',
    'ten_readbacks_then_pending',
    'global_cutover_lock_released_after_post_and_second_writer_blocked_before_duplicate_post',
    'pre_submit_intent_survives_unknown_submit',
    'recovery_never_resubmits',
    'stable_scope_catches_target_policy_authorization_drift',
    'current_recovery_requires_overwrite_computation_version',
    'historical_unversioned_legacy_quantity_is_strictly_readable',
    'historical_reconcile_accepts_current_and_legacy_formulas',
    'historical_unversioned_invalid_quantity_fails_closed',
    'current_locked_only_quantity_is_strictly_readable',
    'current_unversioned_quantity_fails_closed',
    'invalid_intent_recorded_at_fails_closed',
    'current_version_rejects_legacy_quantity',
    'unknown_overwrite_computation_version_fails_closed',
    'explicit_legacy_overwrite_version_fails_closed',
    'duplicate_intents_preserved_by_intent_id',
    'cross_plan_intent_rejected',
    'authorization_and_request_hash_bound',
    'definitive_rejection_releases_intent',
    'strict_rejected_shape_releases_intent',
    'strict_rejected_code_zero_fails_closed',
    'malformed_rejected_outcomes_fail_closed',
    'terminal_outcome_ordering_required',
    'terminal_outcome_requires_zoned_nonfuture_timestamp',
    'malformed_response_code_retains_intent',
    'code_zero_business_failure_retains_intent_without_terminal_outcome',
    'transport_and_business_conflicts_retain_intent',
    'code_zero_missing_success_readback_matches_and_terminalizes',
    'missing_code_retains_intent',
    'torn_tail_blocks_future_post',
  ]}, null, 2));
} finally {
  await fs.rm(temp, {recursive: true, force: true});
}
