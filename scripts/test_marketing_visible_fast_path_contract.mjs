#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateOrdinaryActivityEnrollmentReadback} from '../lib/marketing_activity_inventory_integration.mjs';
import {
  scopeOrdinaryEnrollmentReadbackToApprovedRows,
  wrapOrdinaryEnrollmentReadbackForTransaction,
} from '../lib/marketing_ordinary_enrollment_scope.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deadlineFill = await fs.readFile(path.join(root, 'scripts', 'marketing', 'dsy_marketing_deadline_fill.mjs'), 'utf8');
const chunkRunner = await fs.readFile(path.join(root, 'scripts', 'marketing', 'run_ordinary_chunk_submission_batch.mjs'), 'utf8');
const storeRunner = await fs.readFile(path.join(root, 'scripts', 'marketing', 'run_ordinary_store_submission_batch.mjs'), 'utf8');
const enrollmentVerifier = await fs.readFile(path.join(root, 'scripts', 'marketing', 'verify_ordinary_activity_enrollment.mjs'), 'utf8');
const pricing = await fs.readFile(path.join(root, 'lib', 'marketing_low_et_fast_seller_pricing.mjs'), 'utf8');

const laterRowsPending = scopeOrdinaryEnrollmentReadbackToApprovedRows({
  ok: false,
  stores: ['JSH'],
  plannedRows: 20,
  checkedRows: 20,
  byStore: {
    JSH: {
      ok: false,
      identityOk: true,
      loginRecoveryOk: true,
      approvedRowsOk: true,
      plannedRows: 20,
      checkedRows: 20,
      missingRows: 0,
      priceMismatchRows: 0,
      badPacketActivities: 0,
    },
  },
  missingRows: 0,
  priceMismatchRows: 0,
  badPacketActivities: 0,
  extraAvailableRows: 7,
  activityListGapRows: 7,
});
assert.equal(laterRowsPending.ok, true, 'later approved rows must not fail the current submission readback');
assert.equal(laterRowsPending.observedExtraAvailableRows, 7);
assert.equal(laterRowsPending.observedActivityListGapRows, 7);
assert.equal(laterRowsPending.extraAvailableRows, 0);
assert.equal(laterRowsPending.activityListGapRows, 0);
assert.equal(validateOrdinaryActivityEnrollmentReadback(
  wrapOrdinaryEnrollmentReadbackForTransaction(laterRowsPending),
).ok, true, 'scoped readback must remain consumable by the inventory transaction validator');

const currentRowMissing = scopeOrdinaryEnrollmentReadbackToApprovedRows({
  stores: ['JSH'],
  plannedRows: 20,
  checkedRows: 20,
  byStore: {JSH: {ok: true, identityOk: true, loginRecoveryOk: true, approvedRowsOk: false, plannedRows: 20, checkedRows: 20, missingRows: 1, priceMismatchRows: 0, badPacketActivities: 0}},
  missingRows: 1,
  priceMismatchRows: 0,
  badPacketActivities: 0,
  extraAvailableRows: 0,
  activityListGapRows: 0,
});
assert.equal(currentRowMissing.ok, false, 'a missing current row must still fail closed');
assert.equal(validateOrdinaryActivityEnrollmentReadback(
  wrapOrdinaryEnrollmentReadbackForTransaction(currentRowMissing),
).ok, false, 'transaction validation must retain current-row failures');

const identityFailed = scopeOrdinaryEnrollmentReadbackToApprovedRows({
  stores: ['JSH'],
  plannedRows: 20,
  checkedRows: 20,
  byStore: {JSH: {ok: false, identityOk: false, loginRecoveryOk: true, approvedRowsOk: false, plannedRows: 20, checkedRows: 20, missingRows: 0, priceMismatchRows: 0, badPacketActivities: 0}},
  missingRows: 0,
  priceMismatchRows: 0,
  badPacketActivities: 0,
  extraAvailableRows: 0,
  activityListGapRows: 0,
});
assert.equal(identityFailed.ok, false, 'identity failure must not become a scoped success');

const emptyReadback = scopeOrdinaryEnrollmentReadbackToApprovedRows({
  stores: ['JSH'],
  plannedRows: 20,
  checkedRows: 0,
  byStore: {JSH: {ok: false, identityOk: true, loginRecoveryOk: true, approvedRowsOk: false, plannedRows: 0, checkedRows: 0, missingRows: 0, priceMismatchRows: 0, badPacketActivities: 0}},
  missingRows: 0,
  priceMismatchRows: 0,
  badPacketActivities: 0,
  extraAvailableRows: 0,
  activityListGapRows: 0,
});
assert.equal(emptyReadback.ok, false, 'an empty readback must not pass as zero issues');
assert.match(enrollmentVerifier, /unavailableButFillVerified: false,\s*priceUnavailableNoFillEvidence: true/,
  'missing fill evidence must not also be counted as verified fill evidence');

const openAt = deadlineFill.indexOf('const {targetId, sessionId} = await newPage(cdp, url);');
const forcedRefreshAt = deadlineFill.indexOf("await cdp.call('Page.reload', {ignoreCache: true}, sessionId)", openAt);
const initialReadinessAt = deadlineFill.indexOf('let firstState = await waitForActivityOrLogin', openAt);
assert(openAt >= 0 && forcedRefreshAt > openAt && initialReadinessAt > forcedRefreshAt,
  'each activity page must force-refresh once before readiness checks');

const fillStart = deadlineFill.indexOf('async function fillEditPage');
const editorReadyAt = deadlineFill.indexOf('let rowEditorReady = await waitFor', fillStart);
const editPageSizeAt = deadlineFill.indexOf('editPageSize = await setPageSize500', fillStart);
assert(fillStart >= 0 && editorReadyAt > fillStart && editPageSizeAt > editorReadyAt,
  'the edit table must render before switching it to 500 rows per page');
assert.match(deadlineFill, /selectAllGoodsAndNext\(cdp, sessionId, allowSkcs\)/,
  '500 visible rows must still use the approved SKC allowlist');
assert.match(deadlineFill, /outOfPlanRows\.set\(/,
  'rows outside the approved batch must remain observable and blocking');
assert.match(deadlineFill, /const evidenceBaselineDoc = EXECUTION_APPROVAL\?\.prices \|\| doc;/,
  'approved batches must share one low-ET evidence baseline across subsets');
assert.match(deadlineFill, /currentLockedPriceKeys/,
  'explicit prices must be gated by the current approved price key set');
assert.match(deadlineFill, /requiresTemporaryRaise === true[\s\S]*禁止直接提交/,
  'direct submit must stop when an inventory transaction is required');
const noCloseReuseAt = deadlineFill.indexOf('} else if (!(await isDebugPortOpen(store))) {');
const noCloseLaunchAt = deadlineFill.indexOf('launchVisible(store);', noCloseReuseAt);
const noClosePortWaitAt = deadlineFill.indexOf('await waitForDebugPort(store);', noCloseLaunchAt);
assert(noCloseReuseAt >= 0 && noCloseLaunchAt > noCloseReuseAt && noClosePortWaitAt > noCloseLaunchAt,
  '--no-close must reuse an open browser and launch one only when the debug port is absent');

assert.match(chunkRunner, /chunkSize: 500/,
  'ordinary activity chunks must default to one 500-row page');
assert.match(chunkRunner, /Invalid --chunk-size \(1-500\)/,
  'ordinary activity chunk size must support the visible 500-row page limit');
assert.match(chunkRunner, /final-verify[\s\S]*browser-cleanup/,
  'chunk batches must perform one final full-plan readback before browser cleanup');

for (const [name, source] of [['chunk runner', chunkRunner], ['store runner', storeRunner]]) {
  assert.match(source, /--bi/, name + ' must accept and forward current BI evidence');
  assert.match(source, /--inventory-trend/, name + ' must accept and forward current ET evidence');
  assert.match(source, /--no-close/, name + ' must reuse the same store browser across dry-run, submit, and readback');
  assert.match(source, /scopeOrdinaryEnrollmentReadbackToApprovedRows/, name + ' must scope readback to approved rows');
  assert.match(source, /wrapOrdinaryEnrollmentReadbackForTransaction/, name + ' must preserve the transaction validator readback shape');
  assert.match(source, /--fill-results-dir/, name + ' must verify against this run fill evidence');
  assert.match(source, /finally[\s\S]*cleanupStoreBrowser|finally[\s\S]*browser-cleanup/, name + ' must clean the store browser in finally');
}

assert.match(pricing, /currentLockedPriceKeys instanceof Set/,
  'explicit price overrides must require a current locked-plan key set');
assert.match(pricing, /user_explicit_current_price_override_invalid_target/,
  'explicit price override target mismatches must fail closed');

console.log('marketing visible fast-path contract: PASS');
