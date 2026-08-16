#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  appendDurableJournalRecord,
  classifyRecoveredInventoryIntent,
  inventoryRecoveryScopeKey,
  readPendingInventoryIntents,
  recoveredInventoryIntentMismatch,
  submitDurableInventoryWriteOnce,
} from '../lib/durable_inventory_write.mjs';
import {stableInventoryHash} from '../lib/inventory_replenishment_policy.mjs';

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

try {
  let submitCalls = 0;
  let readbackCalls = 0;
  const delayed = await submitDurableInventoryWriteOnce({
    journalFile: journal,
    intent,
    submit: async () => {
      submitCalls += 1;
      return {data: {code: '0', info: {success: true}}};
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
  const exactIntent = {...intent, recoveryScopeKey: inventoryRecoveryScopeKey({runDate:intent.runDate,storeKey:intent.storeKey,skc:intent.skc,skuCode:intent.skuCode}), planHash: expected.plan.payloadHash, policyVersion: expected.plan.policyVersion, authorizationId: expected.authorizationId, before: {totalInventoryQuantity: 20, totalUsableInventory: 20, totalLockedQuantity: 0, stockRowMissing:false}, request: exactRequest, requestPayloadHash: stableInventoryHash(exactRequest)};
  assert.equal(recoveredInventoryIntentMismatch(exactIntent, expected), '');
  assert.equal(recoveredInventoryIntentMismatch({...exactIntent, planHash: '2'.repeat(64)}, expected), 'planHash', 'cross-planHash intent must never upgrade to current success');
  assert.equal(recoveredInventoryIntentMismatch({...exactIntent, authorizationId: 'other'}, expected), 'authorizationId');
  assert.equal(recoveredInventoryIntentMismatch({...exactIntent, requestPayloadHash: '0'.repeat(64)}, expected), 'requestPayloadHash');
  const changedAuthorizationLogicalKey = stableInventoryHash({runDate:intent.runDate,store:intent.storeKey,skc:intent.skc,sku:intent.skuCode,target:80,actionType:'VI_OVERWRITE_TO_EXACT_USABLE_TARGET',policyVersion:'policy-v2',authorizationId:'auth-v2'});
  assert.notEqual(changedAuthorizationLogicalKey, intent.logicalActionKey);
  assert.equal(
    inventoryRecoveryScopeKey({runDate:intent.runDate,storeKey:intent.storeKey,skc:intent.skc,skuCode:intent.skuCode}),
    exactIntent.recoveryScopeKey,
    'target/policy/authorization drift must still hit the old intent recovery scope',
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
    submit: async () => ({data: {code: '400', info: {success: false}}}),
    readback: async () => ({totalUsableInventory: 20}),
  });
  assert.equal(rejected.state, 'rejected');
  assert.equal((await readPendingInventoryIntents(rejectedJournal)).has(intent.intentId), false, 'definitive rejection releases the durable intent');

  const ambiguousJournal = path.join(temp, 'ambiguous.journal.ndjson');
  const ambiguous = await submitDurableInventoryWriteOnce({
    journalFile: ambiguousJournal,
    intent: {...intent, intentId: 'intent-ambiguous'},
    submit: async () => ({data: {code: '0'}}),
    readback: async () => ({totalUsableInventory: 100}),
  });
  assert.equal(ambiguous.state, 'ambiguous_response');
  assert.equal((await readPendingInventoryIntents(ambiguousJournal)).has('intent-ambiguous'), true, 'missing explicit success=true must retain the intent');
  const missingCodeJournal = path.join(temp, 'missing-code.journal.ndjson');
  const missingCode = await submitDurableInventoryWriteOnce({
    journalFile: missingCodeJournal,
    intent: {...intent, intentId: 'intent-missing-code'},
    submit: async () => ({data: {info: {success: true}}}),
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
    submit: async () => { postAfterTorn += 1; return {data:{code:'0',info:{success:true}}}; },
    readback: async () => ({totalUsableInventory:100}),
  }), /INVENTORY_JOURNAL_TORN_TAIL/);
  assert.equal(postAfterTorn, 0, 'a torn tail must block append before any later POST');

  console.log(JSON.stringify({ok: true, checks: ['one_post_only', 'ten_readbacks_then_pending', 'pre_submit_intent_survives_unknown_submit', 'recovery_never_resubmits', 'stable_scope_catches_target_policy_authorization_drift', 'duplicate_intents_preserved_by_intent_id', 'cross_plan_intent_rejected', 'authorization_and_request_hash_bound', 'definitive_rejection_releases_intent', 'ambiguous_success_retains_intent', 'missing_code_retains_intent', 'torn_tail_blocks_future_post']}, null, 2));
} finally {
  await fs.rm(temp, {recursive: true, force: true});
}
