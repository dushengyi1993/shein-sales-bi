#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  buildDailyInventoryPlanHashPayload,
  computeInventoryOverwriteQuantity,
  INVENTORY_OVERWRITE_COMPUTATION_VERSION,
  stableInventoryHash,
} from '../lib/inventory_replenishment_policy.mjs';
import {
  appendDurableJournalRecord,
  INVENTORY_OWNER_CONFIRMED_SAME_TARGET_SUPERSEDE_DISPOSITION,
  inventoryIntentScopeKey,
  inventoryLogicalActionKey,
  inventoryRecoveryScopeKey,
  readInventoryIntentJournals,
} from '../lib/durable_inventory_write.mjs';
import {evaluateResultBatchStatus} from './inventory/daily_inventory_version_publisher.mjs';
import {validateInventoryArtifacts} from './validate_daily_operating_refresh.mjs';

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testId = crypto.randomBytes(4).toString('hex');
const tempRoot = path.resolve(SCRIPT_ROOT, 'tmp', 'v6-owner-resume-validation-' + testId);

const runDate = '2026-08-30';
const businessDate = '2026-08-29';
const oldDate = '2026-08-15';
const authorizationId = 'owner-automatic-inventory-20260803-v1';
const storeKeys = ['CX', 'DL', 'DX', 'FY', 'HL', 'JSH', 'JY', 'LQ', 'MZ', 'NM', 'QH', 'QY', 'TS', 'TZ', 'TZZ', 'XC', 'XL', 'YJ', 'ZL'];

const writeJson = async (file, value) => {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
};
const fileHash = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');

console.log('[test_inventory_v6_owner_resume_validation] Starting test suite in ' + tempRoot);
try {
  // Part 1: Publisher evaluateResultBatchStatus tests
  {
    const baseResult = {
      planHash: 'a'.repeat(64),
      execute: true,
      executionMode: 'automatic',
      results: [
        {
          storeKey: 'DL',
          skc: 'skc-1',
          skuCode: 'sku-1',
          ruleClass: 'recent_sale_scarcity',
          targetUsableInventory: 10,
          state: 'skipped_owner_confirmed_same_target_above_target',
          before: {totalUsableInventory: 15},
          writes: [],
        },
      ],
    };

    assert.equal(evaluateResultBatchStatus(baseResult, 1), 'done', 'publisher must accept valid skipped_owner_confirmed_same_target_above_target as done');

    const equalBefore = {
      ...baseResult,
      results: [{
        ...baseResult.results[0],
        before: {totalUsableInventory: 10},
      }],
    };
    assert.equal(evaluateResultBatchStatus(equalBefore, 1), 'failed', 'publisher must reject when before == target');

    const lowerBefore = {
      ...baseResult,
      results: [{
        ...baseResult.results[0],
        before: {totalUsableInventory: 8},
      }],
    };
    assert.equal(evaluateResultBatchStatus(lowerBefore, 1), 'failed', 'publisher must reject when before < target');

    const withWrites = {
      ...baseResult,
      results: [{
        ...baseResult.results[0],
        writes: [{idempotencyKey: 'test'}],
      }],
    };
    assert.equal(evaluateResultBatchStatus(withWrites, 1), 'failed', 'publisher must reject when writes are non-empty');
  }

  // Part 2: Guard JQ filter test
  {
    const guardSource = await fs.readFile(path.join(SCRIPT_ROOT, 'scripts/cloud_daily_inventory_replenishment_guard.sh'), 'utf8');
    assert.ok(
      guardSource.includes('skipped_owner_confirmed_same_target_above_target'),
      'guard jq script must contain skipped_owner_confirmed_same_target_above_target branch'
    );
    assert.ok(
      guardSource.includes('.before.totalUsableInventory > .targetUsableInventory'),
      'guard jq script must check before > target'
    );
    assert.ok(
      guardSource.includes('((.writes // []) | length) == 0'),
      'guard jq script must check writes is empty'
    );
  }
  // Part 3: Validator validateInventoryArtifacts with real fixture environment
  await fs.mkdir(path.join(tempRoot, 'config'), {recursive: true});
  await writeJson(path.join(tempRoot, 'config', 'stores.json'), {stores: storeKeys.map(storeKey => ({storeKey, enabled: true}))});
  await fs.copyFile(
    path.join(SCRIPT_ROOT, 'config', 'inventory_replenishment_policy.json'),
    path.join(tempRoot, 'config', 'inventory_replenishment_policy.json')
  );
  const policy = JSON.parse(await fs.readFile(path.join(tempRoot, 'config', 'inventory_replenishment_policy.json'), 'utf8'));

  const markerRoot = path.join(tempRoot, 'markers');
  const runtimeRoot = path.join(tempRoot, 'runtime');
  const planFile = path.join(runtimeRoot, 'plans', 'daily-inventory-replenishment-' + runDate + '.json');
  const resultFile = path.join(runtimeRoot, 'results', 'daily-inventory-replenishment-' + runDate + '.json');
  const currentJournal = resultFile + '.journal.ndjson';
  const oldJournal = path.join(runtimeRoot, 'results', 'daily-inventory-replenishment-' + oldDate + '.json.journal.ndjson');
  await fs.mkdir(path.dirname(currentJournal), {recursive: true});

  // Source evidence for plan
  const openApiEvidence = [];
  for (const store of storeKeys) {
    const relative = 'outputs/shein_openapi_products/' + store + '/latest.json';
    const file = path.join(tempRoot, relative);
    await writeJson(file, {storeKey: store, fetchedAt: new Date().toISOString(), summary: {stockFailedChunkCount: 0}});
    openApiEvidence.push({
      store,
      file: relative,
      sha256: await fileHash(file),
      fetchedAt: new Date().toISOString(),
      stockFailedChunkCount: 0,
    });
  }

  const actionableRow = {
    storeKey: 'DL',
    skc: 'skc-target-1',
    skuCode: 'sku-target-1',
    ruleClass: 'recent_sale_scarcity',
    targetUsableInventory: 10,
    etSellableInventory: 12,
  };

  const planBody = {
    schemaVersion: 'daily-inventory-replenishment-plan/v1',
    date: runDate,
    policyVersion: policy.policyVersion,
    executable: true,
    blockers: [],
    actionable: [actionableRow],
    lowEtAllocations: [],
    detailRefreshTargets: [],
    executionConstraints: {decreaseOnly: false},
    counts: {enabledStores: 19},
    sourceEvidence: [
      {store: 'ET', file: 'outputs/bi-portal/sections/inventoryTrend.json', fetchedAt: new Date().toISOString(), totalEtRows: 1, matchedCurrentDayEtRows: 1},
      {store: 'BI_LINKS', file: 'outputs/bi-portal/sections/linksData.json', fetchedAt: new Date().toISOString()},
      ...openApiEvidence,
    ],
  };
  const planPayloadHash = stableInventoryHash(buildDailyInventoryPlanHashPayload(planBody));
  const plan = {...planBody, payloadHash: planPayloadHash};
  await writeJson(planFile, plan);
  function actionKey(date, row, target = 10) {
    return stableInventoryHash({
      runDate: date,
      store: row.storeKey,
      skc: row.skc,
      sku: row.skuCode,
      target,
      actionType: 'VI_OVERWRITE_TO_EXACT_USABLE_TARGET',
      policyVersion: policy.policyVersion,
      authorizationId,
    });
  }

  function makeIntent(date, row, intentId, target = 10) {
    const logicalActionKey = actionKey(date, row, target);
    const before = {skuCode: row.skuCode, totalInventoryQuantity: 2, totalUsableInventory: 2, totalLockedQuantity: 0, temporaryInventoryQuantity: 0, stockRowMissing: false, warehouseCodes: []};
    const request = {
      pathname: '/open-api/stock/change-inventory/v2',
      method: 'POST',
      body: {
        updateSkuInventoryQuantityRequests: [{
          idempotencyKey: 'bi-inv-' + logicalActionKey.slice(0, 42),
          skuCode: row.skuCode,
          invType: 'VI',
          changeType: 'OVERWRITE',
          changeQuantity: computeInventoryOverwriteQuantity(target, before),
          changeReason: 'Owner-authorized daily inventory target after current-day ET and sales/exposure guard',
        }],
      },
      headers: {language: 'en'},
    };
    return {
      kind: 'intent',
      intentId,
      logicalActionKey,
      recoveryScopeKey: inventoryRecoveryScopeKey({runDate: date, storeKey: row.storeKey, skc: row.skc, skuCode: row.skuCode}),
      planHash: 'd'.repeat(64),
      runDate: date,
      storeKey: row.storeKey,
      skc: row.skc,
      skuCode: row.skuCode,
      targetUsableInventory: target,
      policyVersion: policy.policyVersion,
      overwriteComputationVersion: INVENTORY_OVERWRITE_COMPUTATION_VERSION,
      authorizationId,
      idempotencyKey: request.body.updateSkuInventoryQuantityRequests[0].idempotencyKey,
      requestPayloadHash: stableInventoryHash(request),
      request,
      before,
      recordedAt: date + 'T01:00:00.000Z',
    };
  }

  function makeOwnerConfirmedOutcome(intent, {newRunDate = runDate, target = 10, freshUsableInventory = 9} = {}) {
    return {
      kind: 'write_outcome',
      intentId: intent.intentId,
      logicalActionKey: intent.logicalActionKey,
      disposition: INVENTORY_OWNER_CONFIRMED_SAME_TARGET_SUPERSEDE_DISPOSITION,
      oldRunDate: intent.runDate,
      newRunDate,
      targetUsableInventory: target,
      freshUsableInventory,
      originalEffectUnknown: true,
      ownerConfirmationText: '\u8865\u523010',
      recordedAt: new Date().toISOString(),
    };
  }

  const oldIntent = makeIntent(oldDate, actionableRow, 'intent-old-1', 10);
  const oldOutcome = makeOwnerConfirmedOutcome(oldIntent, {newRunDate: runDate, target: 10, freshUsableInventory: 8});

  await fs.writeFile(oldJournal, JSON.stringify(oldIntent) + '\n' + JSON.stringify(oldOutcome) + '\n', 'utf8');
  await fs.writeFile(currentJournal, '', 'utf8');

  // Result row helper
  const makeResult = (rowOverrides = {}, resultOverrides = {}) => ({
    schemaVersion: 'daily-inventory-replenishment-result/v1',
    planHash: resultOverrides?.planHash || planPayloadHash,
    policyVersion: plan.policyVersion,
    execute: true,
    executionMode: 'automatic',
    authorizationContext: 'cloud_daily_inventory_replenishment_guard',
    authorizationId,
    generatedAt: runDate + 'T08:00:00.000Z',
    unresolvedIntents: [],
    manualResolutionFences: [],
    manualResolutionTombstoneCount: resultOverrides?.manualResolutionTombstoneCount !== undefined ? resultOverrides.manualResolutionTombstoneCount : 1,
    results: [
      {
        storeKey: actionableRow.storeKey,
        skc: actionableRow.skc,
        skuCode: actionableRow.skuCode,
        ruleClass: actionableRow.ruleClass,
        targetUsableInventory: 10,
        state: 'skipped_owner_confirmed_same_target_above_target',
        before: {totalUsableInventory: 15},
        writes: [],
        ...rowOverrides,
      },
    ],
  });

  const baseValidationArgs = {
    root: tempRoot,
    markerRoot,
    inventoryRuntimeRoot: runtimeRoot,
    runDate,
    businessDate,
    enabledStores: storeKeys,
    requireMarker: false,
    preWarningAudit: false,
  };
  // 3.1 Positive Test: Valid skipped_owner_confirmed_same_target_above_target
  {
    await writeJson(resultFile, makeResult());
    const validationResult = await validateInventoryArtifacts(baseValidationArgs);
    assert.equal(validationResult.ok, true, 'valid owner-confirmed same-target above target row must pass validation');
    assert.equal(validationResult.resultCount, 1);
  }

  // 3.2 Negative: Forged state with no predecessor in journal
  {
    const unrelatedIntent = makeIntent(oldDate, {storeKey: 'JY', skc: 'other-skc', skuCode: 'other-sku'}, 'unrelated', 10);
    const unrelatedOutcome = makeOwnerConfirmedOutcome(unrelatedIntent, {newRunDate: runDate, target: 10});
    await fs.writeFile(oldJournal, JSON.stringify(unrelatedIntent) + '\n' + JSON.stringify(unrelatedOutcome) + '\n', 'utf8');
    await writeJson(resultFile, makeResult());
    await assert.rejects(
      async () => validateInventoryArtifacts(baseValidationArgs),
      /inventory result lacks exact terminal readback/,
      'forged skipped_owner_confirmed_same_target_above_target with no predecessor must fail validation'
    );
    await fs.writeFile(oldJournal, JSON.stringify(oldIntent) + '\n' + JSON.stringify(oldOutcome) + '\n', 'utf8');
  }

    /* 3.3 Negative: Target drift */
  {
    const driftPlanRow = {...actionableRow, targetUsableInventory: 12};
    const driftPlanBody = {...planBody, actionable: [driftPlanRow]};
    const driftPlanHash = stableInventoryHash(buildDailyInventoryPlanHashPayload(driftPlanBody));
    await writeJson(planFile, {...driftPlanBody, payloadHash: driftPlanHash});
    await writeJson(resultFile, makeResult({targetUsableInventory: 12}, {planHash: driftPlanHash}));
    await assert.rejects(
      async () => validateInventoryArtifacts(baseValidationArgs),
      /inventory result lacks exact terminal readback/,
      'target drift between predecessor outcome and current plan must fail validation'
    );
    await writeJson(planFile, plan);
    await writeJson(resultFile, makeResult());
  }

// 3.4 Negative: Scope drift (predecessor skuCode does not match plan skuCode)
  {
    const driftIntent = makeIntent(oldDate, {...actionableRow, skuCode: 'sku-drift-wrong'}, 'intent-drift-1', 10);
    const driftOutcome = makeOwnerConfirmedOutcome(driftIntent, {newRunDate: runDate, target: 10});
    await fs.writeFile(oldJournal, JSON.stringify(driftIntent) + '\n' + JSON.stringify(driftOutcome) + '\n', 'utf8');
    await writeJson(resultFile, makeResult());
    await assert.rejects(
      async () => validateInventoryArtifacts(baseValidationArgs),
      /inventory result lacks exact terminal readback/,
      'scope drift in predecessor must fail validation'
    );
    await fs.writeFile(oldJournal, JSON.stringify(oldIntent) + '\n' + JSON.stringify(oldOutcome) + '\n', 'utf8');
  }

  // 3.5 Negative: Date drift (outcome newRunDate != plan.date)
  {
    const olderDate = '2026-08-10';
    const olderIntent = makeIntent(olderDate, actionableRow, 'intent-old-1', 10);
    const dateDriftOutcome = makeOwnerConfirmedOutcome(olderIntent, {newRunDate: '2026-08-29', target: 10});
    const olderJournal = path.join(runtimeRoot, 'results', 'daily-inventory-replenishment-' + olderDate + '.json.journal.ndjson');
    await fs.unlink(oldJournal).catch(() => {});
    await fs.writeFile(olderJournal, JSON.stringify(olderIntent) + '\n' + JSON.stringify(dateDriftOutcome) + '\n', 'utf8');
    await writeJson(resultFile, makeResult());
    await assert.rejects(
      async () => validateInventoryArtifacts(baseValidationArgs),
      /inventory result lacks exact terminal readback/,
      'date drift (newRunDate mismatch) must fail validation'
    );
    await fs.unlink(olderJournal).catch(() => {});
    await fs.writeFile(oldJournal, JSON.stringify(oldIntent) + '\n' + JSON.stringify(oldOutcome) + '\n', 'utf8');
  }

  // 3.6 Negative: Predecessor date drift (predecessor runDate >= plan.date)
  {
    const futureIntent = makeIntent(runDate, actionableRow, 'intent-future-1', 10);
    const futureOutcome = makeOwnerConfirmedOutcome(futureIntent, {newRunDate: runDate, target: 10});
    futureOutcome.oldRunDate = runDate;
    await fs.writeFile(oldJournal, JSON.stringify(futureIntent) + '\n' + JSON.stringify(futureOutcome) + '\n', 'utf8');
    await writeJson(resultFile, makeResult());
    await assert.rejects(
      async () => validateInventoryArtifacts(baseValidationArgs),
      /inventory result lacks exact terminal readback|INVENTORY_JOURNAL_OUTCOME_INVALID|INVENTORY_JOURNAL_SCOPE_CONFLICT/,
      'predecessor runDate >= plan.date must fail validation'
    );
    await fs.writeFile(oldJournal, JSON.stringify(oldIntent) + '\n' + JSON.stringify(oldOutcome) + '\n', 'utf8');
  }
  // 3.7 Negative: Multiple candidate predecessors in same recovery scope
  {
    const olderDate = '2026-08-10';
    const olderJournal = path.join(runtimeRoot, 'results', 'daily-inventory-replenishment-' + olderDate + '.json.journal.ndjson');
    const olderIntent = makeIntent(olderDate, actionableRow, 'intent-older-1', 10);
    const olderOutcome = makeOwnerConfirmedOutcome(olderIntent, {newRunDate: runDate, target: 10});
    await fs.writeFile(
      olderJournal,
      JSON.stringify(olderIntent) + '\n' + JSON.stringify(olderOutcome) + '\n',
      'utf8'
    );
    await writeJson(resultFile, makeResult({}, {manualResolutionTombstoneCount: 2}));
    await assert.rejects(
      async () => validateInventoryArtifacts(baseValidationArgs),
      /inventory result lacks exact terminal readback/,
      'multiple candidate predecessors in recovery scope must fail validation'
    );
    await fs.unlink(olderJournal).catch(() => {});
    await writeJson(resultFile, makeResult());
  }

  // 3.8 Negative: before <= target
  {
    await writeJson(resultFile, makeResult({before: {totalUsableInventory: 10}}));
    await assert.rejects(
      async () => validateInventoryArtifacts(baseValidationArgs),
      /inventory result lacks exact terminal readback/,
      'before == target must fail validation under skipped_owner_confirmed_same_target_above_target'
    );

    await writeJson(resultFile, makeResult({before: {totalUsableInventory: 8}}));
    await assert.rejects(
      async () => validateInventoryArtifacts(baseValidationArgs),
      /inventory result lacks exact terminal readback/,
      'before < target must fail validation under skipped_owner_confirmed_same_target_above_target'
    );
  }

  // 3.9 Negative: Non-empty writes
  {
    await writeJson(resultFile, makeResult({writes: [{idempotencyKey: 'fake'}]}));
    await assert.rejects(
      async () => validateInventoryArtifacts(baseValidationArgs),
      /inventory result lacks exact terminal readback/,
      'non-empty writes must fail validation under skipped_owner_confirmed_same_target_above_target'
    );
  }

  // 3.10 Negative: Missing tombstone
  {
    const intentWithoutIdempotency = {...oldIntent, idempotencyKey: ''};
    await fs.writeFile(oldJournal, JSON.stringify(intentWithoutIdempotency) + '\n' + JSON.stringify(oldOutcome) + '\n', 'utf8');
    await writeJson(resultFile, makeResult({manualResolutionTombstoneCount: 0}));
    await assert.rejects(
      async () => validateInventoryArtifacts(baseValidationArgs),
      /inventory result lacks exact terminal readback|INVENTORY_JOURNAL_IMMUTABLE_INVALID/,
      'predecessor without tombstoned idempotency key must fail validation'
    );
    await fs.writeFile(oldJournal, JSON.stringify(oldIntent) + '\n' + JSON.stringify(oldOutcome) + '\n', 'utf8');
  }

  // =========================================================================
  // Part 4: Problem 2 - readInventoryValidationLifecycle Unified Aggregation
  // =========================================================================
  {
    // Test 4.1: Historical journal has dangling supersede referencing non-existent intent
    // Should be quarantined into item pending, NOT crash with unhandled exception
    const danglingSupersedeJournal = path.join(runtimeRoot, 'results', 'daily-inventory-replenishment-2026-08-10.json.journal.ndjson');
    const danglingIntent = makeIntent('2026-08-10', {storeKey: 'JY', skc: 'skc-dang', skuCode: 'sku-dang'}, 'intent-dangling-1', 10);
    const danglingSupersedeOutcome = {
      kind: 'write_outcome',
      intentId: danglingIntent.intentId,
      logicalActionKey: danglingIntent.logicalActionKey,
      disposition: 'superseded_by_later_readback',
      supersededByIntentId: 'non-existent-intent-id-12345',
      supersededByRunDate: runDate,
      supersededByRecordedAt: '2026-08-10T02:00:00.000Z',
      recordedAt: '2026-08-10T02:00:00.000Z',
    };
    await fs.writeFile(
      danglingSupersedeJournal,
      JSON.stringify(danglingIntent) + '\n' + JSON.stringify(danglingSupersedeOutcome) + '\n',
      'utf8'
    );

    const journalFiles = [path.resolve(oldJournal), path.resolve(currentJournal), path.resolve(danglingSupersedeJournal)];
    const bundle = await readInventoryIntentJournals(journalFiles, {
      maxRunDate: runDate,
      currentJournalFile: path.resolve(currentJournal),
      quarantineHistoricalDanglingSupersedes: true,
    });

    assert.ok(bundle, 'unified lifecycle aggregation must return bundle');
    const danglingKey = path.resolve(danglingSupersedeJournal) + '\u0000' + danglingIntent.intentId;
    assert.ok(bundle.pending.has(danglingKey), 'historical dangling supersede must be quarantined to item pending');
    assert.ok(!bundle.terminalOutcomes.has(danglingKey), 'historical dangling supersede must not be counted as terminal');

    // Test 4.2: Current journal has dangling supersede referencing non-existent intent
    // Must fail closed with INVENTORY_JOURNAL_SUPERSEDE_INVALID!
    const badCurrentJournal = path.join(runtimeRoot, 'results', 'daily-inventory-replenishment-current-bad.json.journal.ndjson');
    const badCurrentIntent = makeIntent(runDate, {storeKey: 'DL', skc: 'skc-b', skuCode: 'sku-b'}, 'intent-current-bad-1', 10);
    const badCurrentOutcome = {
      kind: 'write_outcome',
      intentId: badCurrentIntent.intentId,
      logicalActionKey: badCurrentIntent.logicalActionKey,
      disposition: 'superseded_by_later_readback',
      supersededByIntentId: 'non-existent-intent-id-99999',
      supersededByRunDate: runDate,
      supersededByRecordedAt: runDate + 'T02:00:00.000Z',
      recordedAt: runDate + 'T02:00:00.000Z',
    };
    await fs.writeFile(
      badCurrentJournal,
      JSON.stringify(badCurrentIntent) + '\n' + JSON.stringify(badCurrentOutcome) + '\n',
      'utf8'
    );

    await assert.rejects(
      async () => readInventoryIntentJournals([path.resolve(badCurrentJournal)], {
        maxRunDate: runDate,
        currentJournalFile: path.resolve(badCurrentJournal),
        quarantineHistoricalDanglingSupersedes: true,
      }),
      /INVENTORY_JOURNAL_SUPERSEDE_INVALID/,
      'current journal dangling supersede must strictly fail closed'
    );

    // Test 4.3: Global duplicate intentId strictly rejected
    const dupIntent = {...danglingIntent};
    const dupJournal = path.join(runtimeRoot, 'results', 'daily-inventory-replenishment-dup.json.journal.ndjson');
    await fs.writeFile(dupJournal, JSON.stringify(dupIntent) + '\n', 'utf8');
    await assert.rejects(
      async () => readInventoryIntentJournals([path.resolve(currentJournal), path.resolve(danglingSupersedeJournal), path.resolve(dupJournal)], {
        maxRunDate: runDate,
        currentJournalFile: path.resolve(currentJournal),
        quarantineHistoricalDanglingSupersedes: true,
      }),
      /INVENTORY_JOURNAL_CONFLICT/,
      'duplicate global intentId across journals must strictly fail closed'
    );
  }

  console.log(JSON.stringify({
    ok: true,
    suite: 'test_inventory_v6_owner_resume_validation',
    checks: [
      'publisher_evaluate_result_batch_status_owner_confirmed_above_target_accepted',
      'publisher_evaluate_result_batch_status_negative_before_not_above_target_rejected',
      'publisher_evaluate_result_batch_status_negative_non_empty_writes_rejected',
      'guard_jq_branch_contract_verified',
      'validator_positive_owner_confirmed_same_target_above_target_passes',
      'validator_negative_forged_state_without_predecessor_rejected',
      'validator_negative_target_drift_rejected',
      'validator_negative_scope_drift_rejected',
      'validator_negative_date_drift_rejected',
      'validator_negative_predecessor_date_drift_rejected',
      'validator_negative_multiple_candidates_rejected',
      'validator_negative_before_less_or_equal_target_rejected',
      'validator_negative_non_empty_writes_rejected',
      'validator_negative_missing_tombstone_rejected',
      'lifecycle_quarantine_historical_dangling_supersede_item_pending',
      'lifecycle_current_journal_dangling_supersede_fails_closed',
      'lifecycle_duplicate_global_intent_id_fails_closed',
    ],
  }, null, 2));
} finally {
  await fs.rm(tempRoot, {recursive: true, force: true}).catch(() => {});
}
