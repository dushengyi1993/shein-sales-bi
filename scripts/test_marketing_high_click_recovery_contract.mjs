#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  classifyHighClickRestoreResult,
  highClickItemKey,
  isHighClickResultSettled,
  planHighClickStageResume,
} from '../lib/marketing_high_click_stage_resume.mjs';

const entries = [
  ['TZZ', 'sv-success-1'],
  ['JY', 'sv-success-2'],
  ['TZZ', 'sv-success-3'],
  ['YJ', 'sv-low-stock'],
  ['DX', 'sv-login'],
].map(([storeKey, skc]) => ({storeKey, skc}));
const runId = 'repair-run-20260825';
const previous = [
  ...entries.slice(0, 3).map(row => ({...row, ok: true, status: 'restored'})),
  {...entries[3], ok: false, terminal: true, classification: 'prewrite_blocked', writeAttempted: false},
  {...entries[4], ok: false, terminal: false, classification: 'recoverable_pending', attemptRunId: runId},
];

const first = planHighClickStageResume({entries, previousResults: previous, currentRunId: runId});
assert.equal(first.settledByKey.size, 3, 'three exact successes remain settled and cannot replay');
assert.deepEqual(first.eligible.map(highClickItemKey), [highClickItemKey(entries[3])]);
assert.equal(first.pending.length, 2);
assert.equal(first.deferredSameRun, false);
assert.equal(isHighClickResultSettled(previous[3]), false, 'legacy generic prewrite blocker is recoverable, not terminal');

const bothAttempted = previous.map(row => highClickItemKey(row) === highClickItemKey(entries[3])
  ? {...row, terminal: false, classification: 'recoverable_pending', attemptRunId: runId}
  : row);
const deferred = planHighClickStageResume({entries, previousResults: bothAttempted, currentRunId: runId});
assert.equal(deferred.eligible.length, 0);
assert.equal(deferred.pending.length, 2);
assert.equal(deferred.deferredSameRun, true, 'recoverable items defer only after each was attempted once in this run');

const nextRun = planHighClickStageResume({entries, previousResults: bothAttempted, currentRunId: 'repair-run-next'});
assert.equal(nextRun.eligible.length, 2, 'a later fresh service run may re-evaluate recoverable items');

assert.deepEqual(classifyHighClickRestoreResult({
  ok: false,
  status: 'recoverable_login_pending',
  classification: 'recoverable_pending',
  writeAttempted: false,
}), {settled: false, terminal: false, classification: 'recoverable_pending', writeAttempted: false});
assert.equal(classifyHighClickRestoreResult({
  ok: false,
  status: 'inventory_transaction_or_enrollment_blocked',
  inventoryTransaction: {writeAttempted: false, submitAttempted: false},
}).settled, false);
assert.equal(classifyHighClickRestoreResult({
  ok: false,
  status: 'inventory_transaction_restore_failed',
  inventoryTransaction: {writeAttempted: true},
}).classification, 'inventory_transaction_restore_failed');
assert.equal(classifyHighClickRestoreResult({
  ok: false,
  inventoryTransaction: {submitAttempted: true, writeAttempted: false},
}).classification, 'submitted_without_exact_readback');
assert.equal(isHighClickResultSettled({
  ok: false,
  terminal: true,
  classification: 'login_terminal_blocker',
}), true);

console.log(JSON.stringify({ok: true, checks: 15}, null, 2));
