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
}), 12);
assert.equal(computeActivityStockOverwriteQuantity(0, {
  totalInventoryQuantity: 2,
  totalUsableInventory: 0,
  totalLockedQuantity: 2,
}), 2);

const dryState = stock(9, 7, 1);
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
    state.totalInventoryQuantity = state.totalUsableInventory + 4;
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
assert.match(restoreFailure.result.blockers.map(row => row.reason).join(','), /restore_failed_or_original_usable_not_exact/);

const invalidAfterRestore = await scenario({invalidAfterRestore: true});
assert.equal(invalidAfterRestore.result.ok, false);
assert.equal(invalidAfterRestore.result.safe, false);
assert.match(invalidAfterRestore.result.blockers.map(row => row.reason).join(','), /activity_invalid_or_withdrawn_after_inventory_restore/);

const zeroUsableRestore = await scenario({initialState: stock(0, 0, 0)});
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

console.log(JSON.stringify({
  ok: true,
  checks: 35,
  scenarios: [
    'dry_run_zero_write',
    'submit_success_restore',
    'submit_failure_restore',
    'locked_quantity_change_restore_mismatch',
    'restore_write_failure',
    'activity_invalid_after_restore',
    'zero_usable_inventory_restore',
    'eventually_consistent_stock_readback',
  ],
}, null, 2));

async function scenario({
  submitFails = false,
  afterSubmit = null,
  forceRestoreUsable = null,
  restoreWriteFails = false,
  invalidAfterRestore = false,
  initialState = stock(9, 7, 1),
  staleReadbacksAfterWrite = 0,
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
      if (phase === 'restore' && restoreWriteFails) return {ok: false, error: 'forced restore failure'};
      staleSnapshot = {...state};
      const unavailable = Math.max(state.totalLockedQuantity, state.totalInventoryQuantity - state.totalUsableInventory);
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
  assert.equal(enrollmentReads, submitFails ? 1 : 2);
  return {result, state, writeCalls};
}

function stock(totalInventoryQuantity, totalUsableInventory, totalLockedQuantity) {
  return {
    skuCode: 'sku-test',
    totalInventoryQuantity,
    totalUsableInventory,
    totalLockedQuantity,
  };
}
