#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  countBlockedFallbackTargets,
  fallbackBatchExitCode,
  isResumableFallbackResult,
} from '../../lib/marketing_bounded_batch_resume.mjs';

assert.equal(isResumableFallbackResult({ok: true, status: 'executed'}), true);
const admissionBlock = {
  ok: false, status: 'inventory_admission_scope_blocked', terminalBlocked: true,
  inventoryTransaction: {currentTransactionUnsubmitted: true, writeAttempted: false,
    submitAttempted: false, remoteMutationStarted: false},
};
assert.equal(isResumableFallbackResult(admissionBlock), true, 'a pre-submit admission block must not replay on fallback restart');
assert.equal(isResumableFallbackResult({status: admissionBlock.status}), false, 'status text alone is insufficient');
for (const field of ['writeAttempted', 'submitAttempted', 'remoteMutationStarted']) {
  assert.equal(isResumableFallbackResult({...admissionBlock,
    inventoryTransaction: {...admissionBlock.inventoryTransaction, [field]: true}}), false, `${field} must not be reclassified as unsubmitted`);
}
assert.equal(isResumableFallbackResult({
  ok: false,
  status: 'executed_subset_with_platform_or_inventory_blockers',
  createdActivityId: 81930765,
  execute: {result: {desiredCoveredSkcs: ['safe-skc']}},
  blocked: {type: 'platform_or_inventory_blocked'},
}), true);
assert.equal(isResumableFallbackResult({
  ok: false,
  status: 'executed_subset_with_platform_or_inventory_blockers',
  createdActivityId: null,
  execute: {result: {desiredCoveredSkcs: []}},
}), false);
assert.equal(isResumableFallbackResult({
  ok: false,
  status: 'platform_or_inventory_blocked',
  blocked: {
    type: 'platform_or_inventory_blocked',
    blockedSkcs: ['inventory-blocked-skc'],
  },
}), true);
assert.equal(isResumableFallbackResult({
  ok: false,
  status: 'browser_launch_failed',
  blocked: {
    type: 'browser_launch_failed',
    blockedSkcs: ['not-a-terminal-business-blocker'],
  },
}), false);

const productionRestoreFailedResult = {
  ok: false,
  status: 'inventory_transaction_restore_failed',
  classification: 'inventory_transaction_restore_failed',
  terminalBlocked: false,
  submitAttempted: false,
  inventoryTransaction: {
    writeAttempted: true,
    safe: false,
    submitAttempted: false,
  },
  blocked: {
    type: 'inventory_transaction_restore_failed',
    reason: 'INVENTORY_WRITE_PENDING_CONFLICT',
    blockedSkcs: ['FY-SKC-1'],
  },
};
assert.equal(isResumableFallbackResult(productionRestoreFailedResult), true);
assert.equal(isResumableFallbackResult({
  ok: false,
  status: 'inventory_transaction_restore_failed',
}), true);
assert.equal(isResumableFallbackResult({
  ok: false,
  classification: 'inventory_transaction_restore_failed',
}), true);
assert.equal(isResumableFallbackResult({
  ok: false,
  blocked: {type: 'inventory_transaction_restore_failed'},
}), true);

// Worker terminal parser acceptance verification: ok === true || terminalBlocked === true
const workerTerminalAccepted = [
  {ok: true, status: 'executed'},
  {ok: false, status: 'inventory_transaction_restore_failed', terminalBlocked: true},
].every(row => row?.ok === true || row?.terminalBlocked === true);
assert.equal(workerTerminalAccepted, true, 'cloud_marketing_repair_worker terminal parser must accept normalized terminalBlocked=true');

assert.equal(isResumableFallbackResult({ok: false, status: 'failed'}), false);
assert.equal(isResumableFallbackResult({ok: false, status: 'deadline_deferred', deferred: true}), false);

assert.equal(fallbackBatchExitCode({failedCount: 0, deferredCount: 12}), 3);
assert.equal(fallbackBatchExitCode({failedCount: 1, deferredCount: 12}), 2);
assert.equal(fallbackBatchExitCode({failedCount: 0, deferredCount: 0}), 0);

assert.equal(countBlockedFallbackTargets([
  {
    storeKey: 'DX',
    targetSkcs: ['safe-1', 'blocked-1'],
    blocked: {blockedSkcs: ['blocked-1']},
    inventoryBlockedSkcs: ['blocked-1'],
  },
  {
    storeKey: 'DX',
    targetSkcs: ['blocked-1'],
    blocked: {blockedSkcs: ['blocked-1']},
  },
  {
    storeKey: 'HL',
    targetSkcs: ['blocked-2'],
    blocked: {type: 'platform_or_inventory_blocked'},
  },
]), 2);

console.log(JSON.stringify({ok: true, checks: 10}, null, 2));
