#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  computeActivityStockOverwriteQuantity,
  planActivityInventoryTransaction,
  runActivityInventoryTransaction,
} from '../../lib/marketing_activity_inventory_transaction.mjs';

const hash = crypto.createHash('sha256').update('activity-inventory-smoke').digest('hex');
const target = {
  storeKey: 'LQ',
  skc: 'sv-test',
  skuCode: 'sku-test',
  minimumUsableInventory: 10,
  minimumSource: 'dry_run',
  minimumEvidence: {activityStock: 10},
};

assert.equal(computeActivityStockOverwriteQuantity(10, {
  totalInventoryQuantity: 9,
  totalUsableInventory: 7,
  totalLockedQuantity: 1,
  temporaryInventoryQuantity: 1,
}), 12);
assert.equal(computeActivityStockOverwriteQuantity(0, {
  totalInventoryQuantity: 2,
  totalUsableInventory: 0,
  totalLockedQuantity: 2,
  temporaryInventoryQuantity: 0,
}), 2);

const dryState = stock(9, 7, 1, 1);
let dryWrites = 0;
const dryPlan = await planActivityInventoryTransaction({
  targets: [target],
  transactionHash: hash,
  readStock: async () => dryState,
});
assert.equal(dryPlan.ok, true);
assert.equal(dryPlan.rows[0].temporaryOverwriteQuantity, 12);
assert.equal(dryPlan.writeAttempted, false);
assert.equal(dryWrites, 0);

const success = await scenario();
assert.equal(success.result.ok, true);
assert.equal(success.result.safe, true);
assert.equal(success.state.totalUsableInventory, 7);
assert.equal(success.result.rows[0].temporaryRaise.after.totalUsableInventory, 10);
assert.equal(success.result.rows[0].afterRestore.totalUsableInventory, 7);
assert.equal(success.result.enrollmentReadback.ok, true);
assert.equal(success.result.enrollmentAfterRestore.ok, true);

const submitFailure = await scenario({submitFails: true});
assert.equal(submitFailure.result.ok, false);
assert.equal(submitFailure.result.safe, true);
assert.equal(submitFailure.state.totalUsableInventory, 7);
assert.equal(submitFailure.result.rows[0].restoreOk, true);
assert.match(submitFailure.result.blockers.map(row => row.reason).join(','), /submit_or_pre_submit_failed/);

const lockedChangeFailure = await scenario({
  afterSubmit(state) {
    state.totalLockedQuantity = 4;
    state.temporaryInventoryQuantity = 1;
    state.totalInventoryQuantity = state.totalUsableInventory + state.totalLockedQuantity + state.temporaryInventoryQuantity;
  },
  forceRestoreUsable: 6,
});
assert.equal(lockedChangeFailure.result.ok, false);
assert.equal(lockedChangeFailure.result.safe, false);
assert.equal(lockedChangeFailure.result.rows[0].restoreAttempt.lockedQuantityChanged, true);
assert.match(lockedChangeFailure.result.blockers.map(row => row.reason).join(','), /restore_failed_or_original_usable_not_exact/);

const restoreFailure = await scenario({restoreWriteFails: true});
assert.equal(restoreFailure.result.ok, false);
assert.equal(restoreFailure.result.safe, false);
assert.equal(restoreFailure.writeCalls, 2, 'one temporary raise plus exactly one restore write');
assert.equal(restoreFailure.result.rows[0].restoreAttempt.attempts.length, 1);
assert.match(restoreFailure.result.blockers.map(row => row.reason).join(','), /restore_failed_or_original_usable_not_exact/);

const invalidAfterRestore = await scenario({invalidAfterRestore: true});
assert.equal(invalidAfterRestore.result.ok, false);
assert.equal(invalidAfterRestore.result.safe, false);
assert.match(invalidAfterRestore.result.blockers.map(row => row.reason).join(','), /activity_invalid_or_withdrawn_after_inventory_restore/);

const zeroUsableRestore = await scenario({initialState: stock(0, 0, 0, 0)});
assert.equal(zeroUsableRestore.result.ok, true);
assert.equal(zeroUsableRestore.result.safe, true);
assert.equal(zeroUsableRestore.state.totalInventoryQuantity, 0);
assert.equal(zeroUsableRestore.state.totalUsableInventory, 0);
assert.equal(zeroUsableRestore.result.rows[0].restoreAttempt.overwriteQuantity, 0);
assert.equal(zeroUsableRestore.result.rows[0].afterRestore.totalUsableInventory, 0);

const eventuallyConsistentRestore = await scenario({staleReadbacksAfterWrite: 2});
assert.equal(eventuallyConsistentRestore.result.ok, true);
assert.equal(eventuallyConsistentRestore.result.safe, true);
assert.equal(eventuallyConsistentRestore.writeCalls, 2);
assert.equal(eventuallyConsistentRestore.state.totalUsableInventory, 7);

const pendingConflict = await scenario({preDurablePendingConflict: true});
assert.equal(pendingConflict.result.ok, false);
assert.equal(pendingConflict.result.safe, true);
assert.equal(pendingConflict.result.writeAttempted, false);
assert.equal(pendingConflict.result.currentTransactionUnsubmitted, true);
assert.equal(pendingConflict.result.submitAttempted, false);
assert.equal(pendingConflict.result.callbackEntered, false);
assert.equal(pendingConflict.result.remoteMutationStarted, false);
assert.equal(pendingConflict.result.inventoryAdmissionRejections[0].conflict.intentId, 'old-pending-intent');
assert.equal(pendingConflict.result.rows[0].temporaryRaise.currentWriteUnsubmitted, true);
assert.equal(pendingConflict.writeCalls, 1, 'admission rejection enters the adapter once but sends no inventory POST');

const fakePendingConflict = await scenario({fakePendingConflictMessage: true});
assert.equal(fakePendingConflict.result.currentTransactionUnsubmitted, false);
assert.equal(fakePendingConflict.result.safe, false);
assert.equal(fakePendingConflict.result.writeAttempted, true);

const durableRejection = await scenario({durableRejection: true});
assert.equal(durableRejection.result.currentTransactionUnsubmitted, false);
assert.equal(durableRejection.result.safe, false);
assert.equal(durableRejection.result.rows[0].temporaryRaise.durableIntentCreated, true);
assert.equal(durableRejection.result.rows[0].temporaryRaise.inventoryPostAttempted, true);

const transportUnknown = await scenario({transportUnknown: true});
assert.equal(transportUnknown.result.currentTransactionUnsubmitted, false);
assert.equal(transportUnknown.result.safe, false);
assert.equal(transportUnknown.result.rows[0].temporaryRaise.durableIntentCreated, true);
assert.equal(transportUnknown.result.rows[0].temporaryRaise.inventoryPostAttempted, true);

const priorSkuWritten = await multiTargetPendingConflictAfterWrite();
assert.equal(priorSkuWritten.result.currentTransactionUnsubmitted, false);
assert.equal(priorSkuWritten.result.safe, false);
assert.equal(priorSkuWritten.result.writeAttempted, true);
assert.equal(priorSkuWritten.inventoryPosts, 2, 'the first SKU raise and restore are durable writes');
assert.equal(priorSkuWritten.submitCalls, 0, 'activity submit is never entered after the second SKU admission conflict');

console.log(JSON.stringify({
  ok: true,
  scenarios: [
    'dry_run_zero_write',
    'submit_success_restore',
    'submit_failure_restore',
    'locked_quantity_change_restore_mismatch',
    'restore_write_failure',
    'activity_invalid_after_restore',
    'zero_usable_inventory_restore',
    'eventually_consistent_stock_readback',
    'typed_pre_durable_pending_conflict',
    'untyped_pending_conflict_message_fails_closed',
    'durable_rejection_fails_closed',
    'transport_unknown_fails_closed',
    'prior_sku_written_then_pending_conflict_fails_closed',
  ],
}, null, 2));

async function scenario({
  submitFails = false,
  afterSubmit = null,
  forceRestoreUsable = null,
  restoreWriteFails = false,
  invalidAfterRestore = false,
  initialState = stock(9, 7, 1, 1),
  staleReadbacksAfterWrite = 0,
  preDurablePendingConflict = false,
  fakePendingConflictMessage = false,
  durableRejection = false,
  transportUnknown = false,
} = {}) {
  const state = {...initialState};
  let enrollmentReads = 0;
  let pendingStaleReads = 0;
  let staleSnapshot = null;
  let writeCalls = 0;
  const result = await runActivityInventoryTransaction({
    targets: [target],
    transactionHash: hash,
    acquireLock: async () => async () => {},
    readStock: async () => {
      if (pendingStaleReads > 0) {
        pendingStaleReads -= 1;
        return {...staleSnapshot};
      }
      return {...state};
    },
    writeStock: async ({overwriteQuantity, desiredUsableInventory, phase}) => {
      writeCalls += 1;
      if (phase === 'temporary_raise' && preDurablePendingConflict) {
        const error = new Error('pending conflict');
        error.code = 'INVENTORY_WRITE_PENDING_CONFLICT';
        error.inventoryIntentDurable = false;
        error.inventoryTransportAttempted = false;
        error.inventoryAdmissionRejection = admissionRejection(target);
        throw error;
      }
      if (phase === 'temporary_raise' && fakePendingConflictMessage) {
        throw new Error('INVENTORY_WRITE_PENDING_CONFLICT: fake text only');
      }
      if (phase === 'temporary_raise' && durableRejection) {
        return {ok: false, state: 'rejected', message: 'platform rejected durable request'};
      }
      if (phase === 'temporary_raise' && transportUnknown) {
        const error = new Error('transport result unknown');
        error.inventoryIntentDurable = true;
        error.inventoryTransportAttempted = true;
        throw error;
      }
      if (phase === 'restore' && restoreWriteFails) return {ok: false, error: 'forced restore failure'};
      staleSnapshot = {...state};
      const unavailable = state.totalLockedQuantity + (state.temporaryInventoryQuantity || 0);
      state.totalInventoryQuantity = overwriteQuantity;
      state.totalUsableInventory = phase === 'restore' && forceRestoreUsable !== null
        ? forceRestoreUsable
        : overwriteQuantity - unavailable;
      pendingStaleReads = staleReadbacksAfterWrite;
      return {ok: true, desiredUsableInventory};
    },
    submit: async () => {
      afterSubmit?.(state);
      if (submitFails) throw new Error('forced submit failure');
      return {ok: true, submitted: true};
    },
    readEnrollment: async ({phase}) => {
      enrollmentReads += 1;
      return {
        ok: !(invalidAfterRestore && phase === 'after_restore'),
        phase,
        enrolled: !(invalidAfterRestore && phase === 'after_restore'),
      };
    },
    validateEnrollment: value => ({
      ok: value?.ok === true && value?.enrolled === true,
      reason: value?.ok ? '' : 'forced activity invalid after restore',
    }),
    sleep: async () => {},
    readbackDelayMs: 0,
  });
  assert.equal(enrollmentReads, preDurablePendingConflict || fakePendingConflictMessage
    || durableRejection || transportUnknown ? 0 : submitFails ? 1 : 2);
  return {result, state, writeCalls};
}

async function multiTargetPendingConflictAfterWrite() {
  const targets = [
    {...target, skc: 'sv-a-written', skuCode: 'sku-a'},
    {...target, skc: 'sv-b-conflict', skuCode: 'sku-b'},
  ];
  const states = new Map(targets.map(value => [value.skuCode, stock(9, 7, 1, 1)]));
  let inventoryPosts = 0;
  let submitCalls = 0;
  const result = await runActivityInventoryTransaction({
    targets,
    transactionHash: hash,
    acquireLock: async () => async () => {},
    readStock: async value => ({...states.get(value.skuCode), skuCode: value.skuCode}),
    writeStock: async ({target: value, overwriteQuantity, phase}) => {
      if (value.skuCode === 'sku-b' && phase === 'temporary_raise') {
        const error = new Error('pending conflict after prior SKU write');
        error.code = 'INVENTORY_WRITE_PENDING_CONFLICT';
        error.inventoryIntentDurable = false;
        error.inventoryTransportAttempted = false;
        error.inventoryAdmissionRejection = admissionRejection(value);
        throw error;
      }
      inventoryPosts += 1;
      const state = states.get(value.skuCode);
      const unavailable = state.totalLockedQuantity + state.temporaryInventoryQuantity;
      state.totalInventoryQuantity = overwriteQuantity;
      state.totalUsableInventory = overwriteQuantity - unavailable;
      return {ok: true, state: 'readback_matched'};
    },
    submit: async () => { submitCalls += 1; return {ok: true}; },
    readEnrollment: async () => ({ok: true}),
    validateEnrollment: value => ({ok: value?.ok === true}),
    sleep: async () => {},
    readbackDelayMs: 0,
  });
  return {result, inventoryPosts, submitCalls};
}

function admissionRejection(value) {
  return {
    schemaVersion: 'inventory-write-admission-rejection/v1',
    decision: 'rejected',
    stage: 'before_durable_intent',
    reasonCode: 'pending_scope_conflict',
    currentIntentDurable: false,
    inventoryPostAttempted: false,
    conflict: {
      intentId: 'old-pending-intent',
      logicalActionKey: 'f'.repeat(64),
      scope: {storeKey: value.storeKey, skc: value.skc, skuCode: value.skuCode, warehouseCode: '', invType: 'VI'},
    },
  };
}

function stock(totalInventoryQuantity, totalUsableInventory, totalLockedQuantity, temporaryInventoryQuantity = 0) {
  return {
    skuCode: 'sku-test',
    totalInventoryQuantity,
    totalUsableInventory,
    totalLockedQuantity,
    temporaryInventoryQuantity,
  };
}
