#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  classifyRetireOutcome,
  isRetiredShelfReadback,
  summarizeRetireOutcomeRows,
} from './execute_retire_candidates_openapi.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptText = await fs.readFile(path.join(ROOT, 'scripts/execute_retire_candidates_openapi.mjs'), 'utf8');

assert.match(scriptText, /best_effort_supplier_code_not_changed/);
assert.match(scriptText, /supplierCodeChange: 'best_effort_non_blocking'/);
assert.match(scriptText, /hardGoal: 'retire_link'/);

assert.equal(isRetiredShelfReadback({shelfState: '0', shelfLabel: ''}), true);
assert.equal(isRetiredShelfReadback({shelfState: '1', shelfLabel: ''}), false);
assert.equal(isRetiredShelfReadback({shelfState: '2', shelfLabel: ''}), true);

assert.equal(classifyRetireOutcome({
  readback: {retired: true, supplierCodeMatchesWaste: true},
}), 'retiredWithSupplierCodeChangedOrReview');

assert.equal(classifyRetireOutcome({
  readback: {retired: true, supplierCodeMatchesWaste: false},
  supplierCodeEdit: {accepted: true},
}), 'retiredWithSupplierCodeChangedOrReview');

assert.equal(classifyRetireOutcome({
  readback: {retired: true, supplierCodeMatchesWaste: false},
  supplierCodeEdit: {accepted: false},
}), 'retiredWithSupplierCodeNotChangedAccepted');

assert.equal(classifyRetireOutcome({
  readback: {retired: false, supplierCodeMatchesWaste: true},
}), 'downFailed');

assert.deepEqual(summarizeRetireOutcomeRows([
  {readback: {retired: true, supplierCodeMatchesWaste: true}},
  {readback: {retired: true, supplierCodeMatchesWaste: false}, supplierCodeEdit: {accepted: true}},
  {readback: {retired: true, supplierCodeMatchesWaste: false}, supplierCodeEdit: {accepted: false}},
  {readback: {retired: false, supplierCodeMatchesWaste: false}},
]), {
  retiredWithSupplierCodeChangedOrReview: 2,
  retiredWithSupplierCodeNotChangedAccepted: 1,
  downFailed: 1,
});

console.log(JSON.stringify({
  ok: true,
  checks: ['retire_hard_goal', 'shelf_state_0_readback_retired', 'supplier_code_best_effort_non_blocking', 'three_bucket_summary'],
}, null, 2));
