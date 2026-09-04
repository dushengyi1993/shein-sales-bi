#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  buildDailyInventoryPlanHashPayload,
  computeInventoryOverwriteQuantity,
  stableInventoryHash,
} from '../lib/inventory_replenishment_policy.mjs';
import {
  INVENTORY_OWNER_CONFIRMED_SAME_TARGET_SUPERSEDE_DISPOSITION,
} from '../lib/durable_inventory_write.mjs';
import {writeMorningResumeEvidence} from '../lib/morning_resume_evidence.mjs';
import {writeMarker} from './pipeline_marker.mjs';
import {validateDailyOperatingRefresh, validateInventoryArtifacts} from './validate_daily_operating_refresh.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-operating-validator-'));
const runDate = '2026-08-16';
const businessDate = '2026-08-15';
const storeKeys = ['CX', 'DL', 'DX', 'FY', 'HL', 'JSH', 'JY', 'LQ', 'MZ', 'NM', 'QH', 'QY', 'TS', 'TZ', 'TZZ', 'XC', 'XL', 'YJ', 'ZL'];
const markerRoot = path.join(tempRoot, 'state', 'pipeline-markers');
const stateDir = path.join(tempRoot, 'state', 'cloud_morning_chain');
const runtimeRoot = path.join(tempRoot, 'runtime');
const planFile = path.join(runtimeRoot, 'plans', `daily-inventory-replenishment-${runDate}.json`);
const resultFile = path.join(runtimeRoot, 'results', `daily-inventory-replenishment-${runDate}.json`);
const inventoryMarkerFile = path.join(markerRoot, runDate, 'daily-inventory-guard.json');
const morningFile = path.join(stateDir, `${runDate}-all.json`);

const writeJson = async (file, value) => {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};
const fileHash = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');

try {
  await fs.mkdir(path.join(tempRoot, 'config'), {recursive: true});
  await writeJson(path.join(tempRoot, 'config', 'stores.json'), {stores: storeKeys.map(storeKey => ({storeKey, enabled: true}))});
  await fs.copyFile(path.join(sourceRoot, 'config', 'inventory_replenishment_policy.json'), path.join(tempRoot, 'config', 'inventory_replenishment_policy.json'));
  const policy = JSON.parse(await fs.readFile(path.join(tempRoot, 'config', 'inventory_replenishment_policy.json'), 'utf8'));
  for (const storeKey of storeKeys) {
    for (const domain of ['shein_links', 'shein_business_domains']) {
      await writeJson(path.join(tempRoot, 'outputs', domain, storeKey, `${businessDate}.json`), {
        ok: true,
        date: businessDate,
        store: {storeKey},
      });
    }
  }
  await writeMorningResumeEvidence({root: tempRoot, date: businessDate, outputFile: morningFile});

  const actionable = [{
    storeKey: 'DL',
    skc: 'skc-1',
    skuCode: 'sku-1',
    ruleClass: 'legacy_virtual_inventory_top_up',
    targetUsableInventory: 100,
  }];
  const openApiEvidence = [];
  for (const store of storeKeys) {
    const relative = `outputs/shein_openapi_products/${store}/latest.json`;
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
  const plan = {
    schemaVersion: 'daily-inventory-replenishment-plan/v1',
    date: runDate,
    policyVersion: policy.policyVersion,
    executable: true,
    blockers: [],
    actionable,
    lowEtAllocations: [],
    detailRefreshTargets: [],
    etFactSource: {kind: 'portal_projection', fixture: 'validator-hash-contract'},
    sourceEvidence: [
      {store: 'ET', file: 'outputs/bi-portal/sections/inventoryTrend.json', fetchedAt: new Date().toISOString(), totalEtRows: 1, matchedCurrentDayEtRows: 1},
      {store: 'BI_LINKS', file: 'outputs/bi-portal/sections/linksData.json', fetchedAt: new Date().toISOString()},
      ...openApiEvidence,
    ],
    counts: {enabledStores: 19},
  };
  plan.payloadHash = stableInventoryHash(buildDailyInventoryPlanHashPayload(plan));
  await writeJson(planFile, plan);
  const goodResult = {
    schemaVersion: 'daily-inventory-replenishment-result/v1',
    generatedAt: '2026-08-16T08:00:00.000Z',
    planHash: plan.payloadHash,
    policyVersion: plan.policyVersion,
    execute: true,
    executionMode: 'automatic',
    authorizationId: policy.execution.automaticExecution.authorizationId,
    authorizationContext: policy.execution.automaticExecution.allowedContext,
    unresolvedIntents: [],
    manualResolutionFences: [],
    manualResolutionTombstoneCount: 0,
    results: [{...actionable[0], state: 'skipped_target_already_matched', before: {totalUsableInventory: 100}}],
  };
  await writeJson(resultFile, goodResult);
  const writeMarkers = async (completedAt = new Date().toISOString()) => {
    await writeMarker({root: markerRoot, stage: 'daily-inventory-guard', date: runDate, businessDate, status: 'done', evidence: [planFile, resultFile], completedAt});
    await writeMarker({root: markerRoot, stage: 'daily-operating-refresh', date: runDate, businessDate, status: 'done', evidence: [morningFile, inventoryMarkerFile, planFile, resultFile], completedAt});
  };
  await writeMarkers();
  const options = {root: tempRoot, markerRoot, stateDir, inventoryRuntimeRoot: runtimeRoot, runDate, businessDate};
  const valid = await validateDailyOperatingRefresh(options);
  assert.equal(valid.ok, true);

  await writeJson(resultFile, {...goodResult, manualResolutionTombstoneCount: 1});
  await writeMarkers();
  await assert.rejects(
    validateDailyOperatingRefresh(options),
    /manual-resolution idempotency tombstone report mismatch/,
    'validator must compare the report tombstone count with the aggregate lifecycle',
  );
  await writeJson(resultFile, goodResult);
  await writeMarkers();
  assert.equal(valid.storeCount, 19);
  assert.equal(valid.artifactCount, 38);

  const volatileAgePlan = {
    ...plan,
    sourceEvidence: plan.sourceEvidence.map((row, index) => index === 0
      ? {
          ...row,
          ageHours: 99,
          manifestAgeSeconds: 999,
          endpointAgeSeconds: {store_stock: 888, box_stock: 777},
        }
      : row),
  };
  assert.equal(
    stableInventoryHash(buildDailyInventoryPlanHashPayload(volatileAgePlan)),
    plan.payloadHash,
    'all volatile sourceEvidence age fields must stay outside the canonical hash',
  );
  await writeJson(planFile, volatileAgePlan);
  await writeJson(resultFile, goodResult);
  await writeMarkers();
  assert.equal((await validateDailyOperatingRefresh(options)).ok, true);

  const etFactSourceDriftPlan = {
    ...plan,
    etFactSource: {...plan.etFactSource, fixture: 'validator-hash-drift'},
  };
  await writeJson(planFile, etFactSourceDriftPlan);
  await writeJson(resultFile, {...goodResult, planHash: plan.payloadHash});
  await writeMarkers();
  await assert.rejects(validateDailyOperatingRefresh(options), /inventory plan payloadHash mismatch/);
  await writeJson(planFile, plan);
  await writeJson(resultFile, goodResult);
  await writeMarkers();

  const terminalBefore = {
    totalInventoryQuantity: 20,
    totalUsableInventory: 20,
    totalLockedQuantity: 0,
    stockRowMissing: false,
  };
  const terminalLogicalActionKey = stableInventoryHash({
    runDate,
    store: actionable[0].storeKey,
    skc: actionable[0].skc,
    sku: actionable[0].skuCode,
    target: actionable[0].targetUsableInventory,
    actionType: 'VI_OVERWRITE_TO_EXACT_USABLE_TARGET',
    policyVersion: plan.policyVersion,
    authorizationId: goodResult.authorizationId,
  });
  const terminalRequest = {
    pathname: '/open-api/stock/change-inventory/v2',
    method: 'POST',
    body: {updateSkuInventoryQuantityRequests: [{
      idempotencyKey: `bi-inv-${terminalLogicalActionKey.slice(0, 42)}`,
      skuCode: actionable[0].skuCode,
      invType: 'VI',
      changeType: 'OVERWRITE',
      changeQuantity: computeInventoryOverwriteQuantity(actionable[0].targetUsableInventory, terminalBefore),
      changeReason: 'Owner-authorized daily inventory target after current-day ET and sales/exposure guard',
    }]},
    headers: {language: 'en'},
  };
  const terminalIntent = {
    kind: 'intent',
    intentId: 'validator-terminal-intent-1',
    logicalActionKey: terminalLogicalActionKey,
    planHash: plan.payloadHash,
    runDate,
    storeKey: actionable[0].storeKey,
    skc: actionable[0].skc,
    skuCode: actionable[0].skuCode,
    targetUsableInventory: actionable[0].targetUsableInventory,
    policyVersion: plan.policyVersion,
    authorizationId: goodResult.authorizationId,
    idempotencyKey: terminalRequest.body.updateSkuInventoryQuantityRequests[0].idempotencyKey,
    requestPayloadHash: stableInventoryHash(terminalRequest),
    request: terminalRequest,
    before: terminalBefore,
    recordedAt: '2026-08-16T07:55:00.000Z',
  };
  const terminalOutcome = {
    kind: 'write_outcome',
    intentId: terminalIntent.intentId,
    logicalActionKey: terminalIntent.logicalActionKey,
    disposition: 'readback_matched',
    recordedAt: '2026-08-16T08:00:00.000Z',
  };
  const currentJournalFile = `${resultFile}.journal.ndjson`;
  await fs.writeFile(currentJournalFile, `${JSON.stringify(terminalIntent)}\n${JSON.stringify(terminalOutcome)}\n`);
  const terminalDriftResult = {
    ...goodResult,
    reconcilePendingOnly: true,
    results: [{
      ...actionable[0],
      logicalActionKey: terminalIntent.logicalActionKey,
      state: 'skipped_terminal_readback_recorded',
      terminalIntentId: terminalIntent.intentId,
      terminalRunDate: terminalIntent.runDate,
      terminalDisposition: terminalOutcome.disposition,
      terminalRecordedAt: terminalOutcome.recordedAt,
      currentLiveUsableInventory: 99,
      before: {totalUsableInventory: 99},
    }],
  };
  await writeJson(resultFile, terminalDriftResult);
  assert.equal((await validateInventoryArtifacts({...options, enabledStores: storeKeys.slice().sort(), requireMarker:false})).resultCount, 1, 'closed intent natural drift must be journal-proven and safe');
  const driftedLegacyOpenApiFile = path.join(tempRoot, 'outputs', 'shein_openapi_products', 'DL', 'latest.json');
  const originalLegacyOpenApiBytes = await fs.readFile(driftedLegacyOpenApiFile);
  await writeJson(driftedLegacyOpenApiFile, {storeKey: 'DL', fetchedAt: new Date().toISOString(), summary: {stockFailedChunkCount: 0}, drift: true});
  assert.equal((await validateInventoryArtifacts({...options, enabledStores: storeKeys.slice().sort(), requireMarker:false})).resultCount, 1,
    'reconcile-only terminal validation must not depend on mutable external OpenAPI source files after the terminal journal is proven');
  await writeJson(resultFile, goodResult);
  await assert.rejects(
    validateInventoryArtifacts({...options, enabledStores: storeKeys.slice().sort(), requireMarker:false}),
    /OpenAPI source hash drifted: DL/,
    'normal execution validation must still fail closed when legacy OpenAPI source evidence drifts',
  );
  await fs.writeFile(driftedLegacyOpenApiFile, originalLegacyOpenApiBytes);
  await writeJson(resultFile, terminalDriftResult);
  await writeJson(resultFile, {
    ...terminalDriftResult,
    results: terminalDriftResult.results.map(row => ({...row, terminalRecordedAt: '2026-08-16T08:01:00.000Z'})),
  });
  await assert.rejects(
    validateInventoryArtifacts({...options, enabledStores: storeKeys.slice().sort(), requireMarker:false}),
    /lacks exact terminal readback/,
    'result metadata must not forge a terminal journal timestamp',
  );
  await writeJson(resultFile, goodResult);

  // An updated readback is terminal only when the current journal proves the
  // exact intent, request/before binding, and one readback_matched outcome.
  const updatedWrite = {
    attempt: 1,
    overwrite: terminalRequest.body.updateSkuInventoryQuantityRequests[0].changeQuantity,
    idempotencyKey: terminalIntent.idempotencyKey,
    requestPayloadHash: terminalIntent.requestPayloadHash,
    request: terminalIntent.request,
    code: '0',
    success: true,
  };
  const updatedResult = {
    ...goodResult,
    results: [{
      ...actionable[0],
      logicalActionKey: terminalIntent.logicalActionKey,
      state: 'updated_readback_matched',
      before: terminalBefore,
      after: {...terminalBefore, totalUsableInventory: actionable[0].targetUsableInventory},
      writes: [updatedWrite],
    }],
  };
  await writeJson(resultFile, updatedResult);
  await writeMarkers();
  assert.equal((await validateDailyOperatingRefresh(options)).ok, true,
    'updated readback must require and accept one exact current-journal intent/outcome binding');

  await fs.writeFile(currentJournalFile, `${JSON.stringify(terminalIntent)}\n`, 'utf8');
  await writeJson(resultFile, updatedResult);
  await writeMarkers();
  await assert.rejects(
    validateInventoryArtifacts({...options, enabledStores: storeKeys.slice().sort(), requireMarker:false}),
    /updated readback lacks a unique readback_matched terminal outcome/,
    'updated readback without a terminal journal outcome must reject',
  );

  await fs.writeFile(currentJournalFile, `${JSON.stringify(terminalIntent)}\n${JSON.stringify(terminalIntent)}\n${JSON.stringify(terminalOutcome)}\n`, 'utf8');
  await writeMarkers();
  await assert.rejects(
    validateInventoryArtifacts({...options, enabledStores: storeKeys.slice().sort(), requireMarker:false}),
    /duplicate_intentId/,
    'duplicate current journal intents must reject',
  );

  await fs.writeFile(currentJournalFile, `${JSON.stringify(terminalIntent)}\n${JSON.stringify(terminalOutcome)}\n${JSON.stringify(terminalOutcome)}\n`, 'utf8');
  await writeMarkers();
  await assert.rejects(
    validateInventoryArtifacts({...options, enabledStores: storeKeys.slice().sort(), requireMarker:false}),
    /duplicate_terminal_outcome/,
    'duplicate current journal terminal outcomes must reject',
  );

  await fs.writeFile(currentJournalFile, `${JSON.stringify(terminalIntent)}\n${JSON.stringify(terminalOutcome)}\n`, 'utf8');
  await writeJson(resultFile, goodResult);
  await writeMarkers();

  const emptyPlan = {...plan, actionable: [], sourceEvidence: [], counts: {enabledStores: 19}};
  emptyPlan.payloadHash = stableInventoryHash(buildDailyInventoryPlanHashPayload(emptyPlan));
  await writeJson(planFile, emptyPlan);
  await writeJson(resultFile, {...goodResult, planHash: emptyPlan.payloadHash, results: []});
  await writeMarkers();
  await assert.rejects(validateDailyOperatingRefresh(options), /sourceEvidence must contain ET, BI_LINKS and 19 unique OpenAPI stores/);
  await writeJson(planFile, plan);
  await writeJson(resultFile, goodResult);
  await writeMarkers();

  const oldFetchedAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
  const completionAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
  const historicalPlan = {
    ...plan,
    sourceEvidence: plan.sourceEvidence.map(row => ({...row, fetchedAt: oldFetchedAt})),
  };
  historicalPlan.payloadHash = stableInventoryHash(buildDailyInventoryPlanHashPayload(historicalPlan));
  await writeJson(planFile, historicalPlan);
  await writeJson(resultFile, {...goodResult, planHash: historicalPlan.payloadHash});
  await writeMarkers(completionAt);
  assert.equal((await validateDailyOperatingRefresh(options)).ok, true, 'immutable final evidence must remain valid hours after completion');
  assert.equal((await validateInventoryArtifacts({...options, enabledStores: storeKeys.slice().sort(), requireMarker: false})).ok, true, 'post-audit with valid marker present must remain valid hours after completion');
  await fs.rm(inventoryMarkerFile, {force: true});
  await assert.rejects(validateInventoryArtifacts({...options, enabledStores: storeKeys.slice().sort(), requireMarker: false}), /sourceEvidence is stale/, 'write-time validation without marker must still reject stale evidence now');
  await writeJson(planFile, plan);
  await writeJson(resultFile, goodResult);
  await writeMarkers();

  const arbitrary = path.join(tempRoot, 'arbitrary.json');
  await writeJson(arbitrary, {ok: true});
  await writeMarker({root: markerRoot, stage: 'daily-operating-refresh', date: runDate, businessDate, status: 'done', evidence: [arbitrary]});
  await assert.rejects(validateDailyOperatingRefresh(options), /evidence path set mismatch/);

  await writeJson(resultFile, {...goodResult, results: [{...actionable[0], state: 'submitted_but_readback_pending', before: {totalUsableInventory: 20}}]});
  await writeMarkers();
  await assert.rejects(validateDailyOperatingRefresh(options), /lacks exact terminal readback/);

  const historicalPendingResult = {
    ...goodResult,
    results: [{
      ...actionable[0],
      state: 'submitted_but_readback_pending',
      disposition: 'skipped',
      historicalPending: true,
      historicalIntentId: 'historical-intent-1',
      historicalRunDate: '2026-08-15',
      historicalTargetUsableInventory: 10,
      before: {totalUsableInventory: 9},
    }],
  };
  await writeJson(resultFile, historicalPendingResult);
  await writeMarkers();
  assert.equal((await validateDailyOperatingRefresh(options)).ok, true, 'a strictly identified historical unknown must not fail unrelated daily work');
  await writeJson(resultFile, {...historicalPendingResult, results: historicalPendingResult.results.map(row => ({...row, historicalPending: false}))});
  await writeMarkers();
  await assert.rejects(validateDailyOperatingRefresh(options), /lacks exact terminal readback/);

  const fencedResult = {
    ...goodResult,
    results: [{
      ...actionable[0],
      state: 'blocked_by_manual_resolution_fence',
      manualResolutionFence: {
        resolutionId: 'resolution-1',
        intentId: 'historical-intent-1',
        disposition: 'manual_baseline_adopted_effect_unknown',
        reason: 'exact_scope_manual_resolution_fence',
        scope: {
          storeKey: actionable[0].storeKey,
          skc: actionable[0].skc,
          skuCode: actionable[0].skuCode,
          warehouseCode: 'warehouse-1',
          invType: 'VI',
          scopeKey: 'f'.repeat(64),
        },
      },
    }],
  };
  await writeJson(resultFile, fencedResult);
  await writeMarkers();
  assert.equal((await validateDailyOperatingRefresh(options)).ok, true, 'an exact permanent fence must remain visible without failing unrelated daily work');
  await writeJson(resultFile, {...fencedResult, results: fencedResult.results.map(row => ({...row, manualResolutionFence: {...row.manualResolutionFence, scope: {...row.manualResolutionFence.scope, skuCode: 'wrong-sku'}}}))});
  await writeMarkers();
  await assert.rejects(validateDailyOperatingRefresh(options), /lacks exact terminal readback/);

  const danglingRunDate = '2026-08-15';
  const danglingLogicalActionKey = stableInventoryHash({
    runDate: danglingRunDate,
    store: actionable[0].storeKey,
    skc: actionable[0].skc,
    sku: actionable[0].skuCode,
    target: actionable[0].targetUsableInventory,
    actionType: 'VI_OVERWRITE_TO_EXACT_USABLE_TARGET',
    policyVersion: plan.policyVersion,
    authorizationId: goodResult.authorizationId,
  });
  const danglingRequest = {
    ...terminalRequest,
    body: {updateSkuInventoryQuantityRequests: [{
      ...terminalRequest.body.updateSkuInventoryQuantityRequests[0],
      idempotencyKey: `bi-inv-${danglingLogicalActionKey.slice(0, 42)}`,
    }]},
  };
  const danglingIntent = {
    ...terminalIntent,
    intentId: 'validator-dangling-intent-1',
    logicalActionKey: danglingLogicalActionKey,
    runDate: danglingRunDate,
    idempotencyKey: danglingRequest.body.updateSkuInventoryQuantityRequests[0].idempotencyKey,
    requestPayloadHash: stableInventoryHash(danglingRequest),
    request: danglingRequest,
    recordedAt: '2026-08-15T07:55:00.000Z',
  };
  const danglingOutcome = {
    kind: 'write_outcome',
    intentId: danglingIntent.intentId,
    logicalActionKey: danglingIntent.logicalActionKey,
    disposition: 'superseded_by_later_readback',
    supersededByIntentId: 'missing-later-intent',
    supersededByRunDate: runDate,
    supersededByRecordedAt: '2026-08-16T07:59:00.000Z',
    recordedAt: '2026-08-16T08:00:00.000Z',
  };
  await fs.writeFile(
    path.join(path.dirname(resultFile), `daily-inventory-replenishment-${danglingRunDate}.json.journal.ndjson`),
    `${JSON.stringify(danglingIntent)}\n${JSON.stringify(danglingOutcome)}\n`,
  );
  await writeJson(resultFile, goodResult);
  await writeMarkers();
  assert.equal((await validateDailyOperatingRefresh(options)).ok, true, 'a legacy dangling supersede must be quarantined from later-day completion validation');

  const ownerSupersedeRunDate = '2026-08-01';
  const ownerSupersedeLogicalActionKey = stableInventoryHash({
    runDate: ownerSupersedeRunDate,
    store: actionable[0].storeKey,
    skc: actionable[0].skc,
    sku: actionable[0].skuCode,
    target: 10,
    actionType: 'VI_OVERWRITE_TO_EXACT_USABLE_TARGET',
    policyVersion: plan.policyVersion,
    authorizationId: goodResult.authorizationId,
  });
  const ownerSupersedeRequest = {
    ...terminalRequest,
    body: {updateSkuInventoryQuantityRequests: [{
      ...terminalRequest.body.updateSkuInventoryQuantityRequests[0],
      skuCode: actionable[0].skuCode,
      changeQuantity: computeInventoryOverwriteQuantity(10, terminalBefore),
      idempotencyKey: `bi-inv-${ownerSupersedeLogicalActionKey.slice(0, 42)}`,
    }]},
  };
  const ownerSupersedeIntent = {
    ...terminalIntent,
    intentId: 'validator-owner-supersede-intent-1',
    logicalActionKey: ownerSupersedeLogicalActionKey,
    runDate: ownerSupersedeRunDate,
    storeKey: actionable[0].storeKey,
    skc: actionable[0].skc,
    skuCode: actionable[0].skuCode,
    targetUsableInventory: 10,
    idempotencyKey: ownerSupersedeRequest.body.updateSkuInventoryQuantityRequests[0].idempotencyKey,
    requestPayloadHash: stableInventoryHash(ownerSupersedeRequest),
    request: ownerSupersedeRequest,
    recordedAt: '2026-08-01T07:55:00.000Z',
  };
  const ownerSupersedeOutcome = {
    kind: 'write_outcome',
    intentId: ownerSupersedeIntent.intentId,
    logicalActionKey: ownerSupersedeIntent.logicalActionKey,
    disposition: INVENTORY_OWNER_CONFIRMED_SAME_TARGET_SUPERSEDE_DISPOSITION,
    oldRunDate: ownerSupersedeRunDate,
    newRunDate: runDate,
    targetUsableInventory: 10,
    freshUsableInventory: 9,
    originalEffectUnknown: true,
    ownerConfirmationText: '补到10',
    recordedAt: '2026-08-14T08:00:00.000Z',
  };
  const ownerSupersedeJournalFile = path.join(path.dirname(resultFile), `daily-inventory-replenishment-${ownerSupersedeRunDate}.json.journal.ndjson`);
  await fs.writeFile(
    ownerSupersedeJournalFile,
    `${JSON.stringify(ownerSupersedeIntent)}\n${JSON.stringify(ownerSupersedeOutcome)}\n`,
  );
  await writeJson(resultFile, {...goodResult, manualResolutionTombstoneCount: 1});
  await writeMarkers();
  assert.equal(
    (await validateDailyOperatingRefresh(options)).ok,
    true,
    'fallback validation must count owner-confirmed supersede tombstones',
  );
  await fs.unlink(ownerSupersedeJournalFile);
  await writeJson(resultFile, goodResult);
  await writeMarkers();

  await writeJson(resultFile, {...goodResult, unresolvedIntents: [{intentId:'orphan-1',recoveryScopeKey:'scope-1',state:'needs_manual_resolve'}]});
  await writeMarkers();
  await assert.rejects(validateDailyOperatingRefresh(options), /contains unresolved durable intents/);

  await writeJson(resultFile, goodResult);
  await writeMarkers();
  await fs.appendFile(path.join(tempRoot, 'outputs', 'shein_links', 'DL', `${businessDate}.json`), ' ');
  await assert.rejects(validateDailyOperatingRefresh(options), /artifact size mismatch|artifact hash mismatch/);

  // Restore modified artifact to keep clean baseline
  await writeJson(path.join(tempRoot, 'outputs', 'shein_links', 'DL', `${businessDate}.json`), {
    ok: true,
    date: businessDate,
    store: {storeKey: 'DL'},
  });

  // Coverage for warning status acceptance and rejections
  const writeWarningMarkers = async ({
    inventoryStatus = 'warning',
    operatingStatus = 'warning',
    inventoryOk = true,
    operatingOk = true,
    completedAt = new Date().toISOString(),
  } = {}) => {
    await writeMarker({
      root: markerRoot,
      stage: 'daily-inventory-guard',
      date: runDate,
      businessDate,
      status: inventoryStatus,
      ok: inventoryOk,
      evidence: [planFile, resultFile],
      completedAt,
    });
    await writeMarker({
      root: markerRoot,
      stage: 'daily-operating-refresh',
      date: runDate,
      businessDate,
      status: operatingStatus,
      ok: operatingOk,
      evidence: [morningFile, inventoryMarkerFile, planFile, resultFile],
      completedAt,
    });
  };

  // Same-day pending is only warning-auditable when the single POST response
  // is code=0 with success still unknown and the immutable intent remains
  // pending in this run's journal.  Keep the original terminal fixture so the
  // existing closed-intent checks below can be restored after this section.
  const originalCurrentJournal = await fs.readFile(currentJournalFile, 'utf8');
  const pendingIntent = {
    ...terminalIntent,
    intentId: 'validator-same-day-pending-intent-1',
    recordedAt: '2026-08-16T08:05:00.000Z',
  };
  const pendingWrite = {
    attempt: 1,
    overwrite: terminalRequest.body.updateSkuInventoryQuantityRequests[0].changeQuantity,
    idempotencyKey: pendingIntent.idempotencyKey,
    requestPayloadHash: pendingIntent.requestPayloadHash,
    request: pendingIntent.request,
    code: '0',
    msg: 'accepted; readback remains unconfirmed',
    traceId: 'pending-trace-1',
    success: null,
  };
  const pendingResult = {
    ...goodResult,
    results: [{
      ...actionable[0],
      logicalActionKey: pendingIntent.logicalActionKey,
      state: 'submitted_but_readback_pending',
      before: pendingIntent.before,
      after: {...pendingIntent.before, totalUsableInventory: 20},
      writes: [pendingWrite],
    }],
  };
  const pendingResultWithoutUnresolved = {...pendingResult};
  delete pendingResultWithoutUnresolved.unresolvedIntents;
  await fs.writeFile(currentJournalFile, `${JSON.stringify(pendingIntent)}\n`, 'utf8');

  // 11. A valid same-day warning + pending row requires the exact journal
  // binding, but does not require unresolvedIntents=[] as its proof.
  await writeJson(resultFile, pendingResult);
  await writeWarningMarkers({inventoryStatus: 'warning', operatingStatus: 'warning'});
  await assert.rejects(
    validateDailyOperatingRefresh(options),
    /lacks exact terminal readback.*strict mode/,
    'default strict validation must reject same-day pending even with warning markers',
  );
  await writeJson(resultFile, pendingResultWithoutUnresolved);
  await writeWarningMarkers({inventoryStatus: 'warning', operatingStatus: 'warning'});
  const pendingWarningValid = await validateDailyOperatingRefresh({...options, allowItemFencedWarning: true});
  assert.equal(pendingWarningValid.ok, true, 'exact same-day pending warning must pass in explicit item-fenced mode');
  assert.equal(pendingWarningValid.pendingWarningCount, 1);
  assert.equal(pendingWarningValid.pendingReadbackCount, 1);
  assert.equal(pendingWarningValid.warningCount, 1);

  // An unfinished executor envelope may explicitly report null or false.  Both
  // remain pending and are eligible only for the controlled warning path.
  for (const unfinishedOk of [null, false]) {
    await writeJson(resultFile, {...pendingResultWithoutUnresolved, ok: unfinishedOk});
    await writeWarningMarkers({inventoryStatus: 'warning', operatingStatus: 'warning'});
    const unfinishedWarning = await validateDailyOperatingRefresh({...options, allowItemFencedWarning: true});
    assert.equal(unfinishedWarning.ok, true, `result.ok=${unfinishedOk} must remain an auditable pending warning`);
  }
  await writeJson(resultFile, pendingResultWithoutUnresolved);

  // An explicit result.ok=true is a completion claim and cannot pass through
  // the pending-warning allowance.
  await writeJson(resultFile, {...pendingResultWithoutUnresolved, ok: true});
  await writeWarningMarkers({inventoryStatus: 'warning', operatingStatus: 'warning'});
  await assert.rejects(
    validateDailyOperatingRefresh({...options, allowItemFencedWarning: true}),
    /pending result claims successful completion/,
    'result.ok=true must reject the same-day pending warning path',
  );
  await writeJson(resultFile, pendingResultWithoutUnresolved);

  // The narrow pre-warning audit accepts a valid inventory warning with no
  // operating marker yet, but the normal strict path still needs the final
  // marker after it is written.
  await writeMarker({
    root: markerRoot,
    stage: 'daily-inventory-guard',
    date: runDate,
    businessDate,
    status: 'warning',
    ok: true,
    evidence: [planFile, resultFile],
  });
  await fs.rm(path.join(markerRoot, runDate, 'daily-operating-refresh.json'), {force: true});
  await writeJson(resultFile, goodResult);
  await writeMarker({
    root: markerRoot,
    stage: 'daily-inventory-guard',
    date: runDate,
    businessDate,
    status: 'warning',
    ok: true,
    evidence: [planFile, resultFile],
  });
  await assert.rejects(
    validateDailyOperatingRefresh(options),
    /ENOENT|daily operating marker/,
    'strict validation must not accept a missing operating marker',
  );
  await writeJson(resultFile, pendingResultWithoutUnresolved);
  await writeMarker({
    root: markerRoot,
    stage: 'daily-inventory-guard',
    date: runDate,
    businessDate,
    status: 'warning',
    ok: true,
    evidence: [planFile, resultFile],
  });
  const preWarningValid = await validateDailyOperatingRefresh({...options, preWarningAudit: true});
  assert.equal(preWarningValid.ok, true, 'pre-warning audit must accept valid same-day pending evidence without operating marker');
  await writeWarningMarkers({inventoryStatus: 'warning', operatingStatus: 'warning'});

  // The allowance is a warning-pair contract, not an inventory-only or
  // operating-only escape hatch.
  await writeWarningMarkers({inventoryStatus: 'warning', operatingStatus: 'done'});
  await assert.rejects(
    validateDailyOperatingRefresh({...options, allowItemFencedWarning: true}),
    /requires same-day warning markers/,
    'same-day pending requires both inventory and operating warning markers',
  );
  await writeWarningMarkers({inventoryStatus: 'warning', operatingStatus: 'warning'});

  // 12. The result cannot borrow a same-day warning allowance without the
  // corresponding current journal intent.
  await fs.rm(currentJournalFile, {force: true});
  await writeJson(resultFile, pendingResultWithoutUnresolved);
  await writeWarningMarkers({inventoryStatus: 'warning', operatingStatus: 'warning'});
  await assert.rejects(
    validateDailyOperatingRefresh({...options, allowItemFencedWarning: true}),
    /durable journal intent is missing/,
    'same-day pending without its journal must reject',
  );
  await fs.writeFile(currentJournalFile, `${JSON.stringify(pendingIntent)}\n`, 'utf8');

  const retriedPendingResult = {
    ...pendingResultWithoutUnresolved,
    results: pendingResultWithoutUnresolved.results.map(row => ({
      ...row,
      writes: [row.writes[0], {...row.writes[0], attempt: 2}],
    })),
  };
  await writeJson(resultFile, retriedPendingResult);
  await writeWarningMarkers({inventoryStatus: 'warning', operatingStatus: 'warning'});
  await assert.rejects(
    validateDailyOperatingRefresh({...options, allowItemFencedWarning: true}),
    /requires exactly one write attempt|retry or duplicate attempt detected/,
    'same-day pending retry evidence must reject',
  );
  await writeJson(resultFile, pendingResultWithoutUnresolved);

  // 13. Both result-side and journal-side immutable bindings must remain exact.
  const driftedPendingResult = {
    ...pendingResultWithoutUnresolved,
    results: pendingResultWithoutUnresolved.results.map(row => ({
      ...row,
      writes: [{...row.writes[0], requestPayloadHash: 'a'.repeat(64)}],
    })),
  };
  await writeJson(resultFile, driftedPendingResult);
  await writeWarningMarkers({inventoryStatus: 'warning', operatingStatus: 'warning'});
  await assert.rejects(
    validateDailyOperatingRefresh({...options, allowItemFencedWarning: true}),
    /write request hash drift/,
    'same-day pending request hash drift must reject',
  );
  await writeJson(resultFile, pendingResultWithoutUnresolved);
  const driftedPendingIntent = {...pendingIntent, planHash: 'b'.repeat(64)};
  await fs.writeFile(currentJournalFile, `${JSON.stringify(driftedPendingIntent)}\n`, 'utf8');
  await writeWarningMarkers({inventoryStatus: 'warning', operatingStatus: 'warning'});
  await assert.rejects(
    validateDailyOperatingRefresh({...options, allowItemFencedWarning: true}),
    /durable journal planHash drift/,
    'same-day pending journal plan hash drift must reject',
  );
  await fs.writeFile(currentJournalFile, `${JSON.stringify(pendingIntent)}\n`, 'utf8');

  const scopeDriftPendingResult = {
    ...pendingResultWithoutUnresolved,
    results: pendingResultWithoutUnresolved.results.map(row => ({...row, skc: 'scope-drift'})),
  };
  await writeJson(resultFile, scopeDriftPendingResult);
  await writeWarningMarkers({inventoryStatus: 'warning', operatingStatus: 'warning'});
  await assert.rejects(
    validateDailyOperatingRefresh({...options, allowItemFencedWarning: true}),
    /result row identity is not bound to the current plan/,
    'same-day pending scope drift must reject',
  );
  await writeJson(resultFile, pendingResultWithoutUnresolved);

  // 14. A code=0 response with success=true is not an unresolved warning; it
  // must have a terminal journal outcome before it can be accepted.
  const falselySuccessfulPendingResult = {
    ...pendingResultWithoutUnresolved,
    results: pendingResultWithoutUnresolved.results.map(row => ({
      ...row,
      writes: [{...row.writes[0], success: true}],
    })),
  };
  await writeJson(resultFile, falselySuccessfulPendingResult);
  await writeWarningMarkers({inventoryStatus: 'warning', operatingStatus: 'warning'});
  await assert.rejects(
    validateDailyOperatingRefresh({...options, allowItemFencedWarning: true}),
    /response success is confirmed or missing/,
    'success=true without a terminal outcome must reject',
  );
  await writeJson(resultFile, pendingResultWithoutUnresolved);

  // 15. A terminal outcome closes the intent and therefore conflicts with a
  // submitted_but_readback_pending result row.
  const pendingTerminalOutcome = {
    kind: 'write_outcome',
    intentId: pendingIntent.intentId,
    logicalActionKey: pendingIntent.logicalActionKey,
    disposition: 'readback_matched',
    recordedAt: '2026-08-16T08:10:00.000Z',
  };
  await fs.writeFile(currentJournalFile, `${JSON.stringify(pendingIntent)}\n${JSON.stringify(pendingTerminalOutcome)}\n`, 'utf8');
  await writeWarningMarkers({inventoryStatus: 'warning', operatingStatus: 'warning'});
  await assert.rejects(
    validateDailyOperatingRefresh({...options, allowItemFencedWarning: true}),
    /durable journal has a terminal outcome/,
    'same-day pending with a terminal journal outcome must reject',
  );

  await fs.writeFile(currentJournalFile, originalCurrentJournal, 'utf8');
  await writeJson(resultFile, goodResult);
  await writeMarkers();

  // 1. Valid warning markers with ok=true and full safe evidence must pass
  await writeWarningMarkers({inventoryStatus: 'warning', operatingStatus: 'warning'});
  assert.equal((await validateDailyOperatingRefresh(options)).ok, true, 'valid warning markers must be accepted');

  // 2. Mixed: inventory warning, operating done
  await writeWarningMarkers({inventoryStatus: 'warning', operatingStatus: 'done'});
  assert.equal((await validateDailyOperatingRefresh(options)).ok, true, 'inventory warning with operating done must be accepted');

  // 3. Mixed: inventory done, operating warning
  await writeWarningMarkers({inventoryStatus: 'done', operatingStatus: 'warning'});
  assert.equal((await validateDailyOperatingRefresh(options)).ok, true, 'inventory done with operating warning must be accepted');

  // 4. Warning marker with evidence drift must reject
  const originalPlanContent = await fs.readFile(planFile, 'utf8');
  await fs.appendFile(planFile, ' ');
  await assert.rejects(
    validateDailyOperatingRefresh(options),
    /inventory marker evidence size mismatch|inventory marker evidence hash mismatch|evidence hash mismatch/,
    'warning marker with drifted evidence must reject',
  );
  await fs.writeFile(planFile, originalPlanContent, 'utf8');

  // 5. Failed marker must reject (both inventory and operating)
  await writeWarningMarkers({inventoryStatus: 'failed', operatingStatus: 'warning'});
  await assert.rejects(
    validateDailyOperatingRefresh(options),
    /inventory marker is not done or warning/,
    'failed inventory marker must reject',
  );

  await writeWarningMarkers({inventoryStatus: 'warning', operatingStatus: 'failed'});
  await assert.rejects(
    validateDailyOperatingRefresh(options),
    /daily operating marker is not done or warning/,
    'failed daily operating marker must reject',
  );

  // 6. Non-executable plan or missing plan/result must still reject under warning marker
  const nonExecutablePlan = {...plan, executable: false, blockers: ['simulated_blocker']};
  await writeJson(planFile, nonExecutablePlan);
  await writeWarningMarkers({inventoryStatus: 'warning', operatingStatus: 'warning'});
  await assert.rejects(
    validateDailyOperatingRefresh(options),
    /inventory plan is not executable|inventory plan payloadHash mismatch/,
    'non-executable plan must reject even with warning marker',
  );
  await writeJson(planFile, plan);

  // 7. Unsafe result row must reject under warning marker
  await writeJson(resultFile, {...goodResult, results: [{...actionable[0], state: 'unrecognized_state'}]});
  await writeWarningMarkers({inventoryStatus: 'warning', operatingStatus: 'warning'});
  await assert.rejects(
    validateDailyOperatingRefresh(options),
    /lacks exact terminal readback/,
    'unsafe result row must reject even with warning marker',
  );
  await writeJson(resultFile, goodResult);
  await writeMarkers();

  // 8. requireMarker=false with valid terminal warning marker freezes sourceReferenceTime to marker.completedAt
  const planOldFetchedAt = "2026-08-16T07:00:00.000Z";
  const markerCompletedAt = "2026-08-16T07:05:00.000Z";
  const planWithHistoricalFreshness = {
    ...plan,
    sourceEvidence: plan.sourceEvidence.map(ev => ({...ev, fetchedAt: planOldFetchedAt})),
  };
  planWithHistoricalFreshness.payloadHash = stableInventoryHash(buildDailyInventoryPlanHashPayload(planWithHistoricalFreshness));
  await writeJson(planFile, planWithHistoricalFreshness);
  const resultMatchingHistoricalPlan = {
    ...goodResult,
    planHash: planWithHistoricalFreshness.payloadHash,
  };
  await writeJson(resultFile, resultMatchingHistoricalPlan);

  // Write valid inventory warning marker completed at 07:05:00Z (within maxMinutesAgo of planOldFetchedAt)
  await writeMarker({
    root: markerRoot,
    stage: "daily-inventory-guard",
    date: runDate,
    businessDate,
    status: "warning",
    ok: true,
    evidence: [planFile, resultFile],
    completedAt: markerCompletedAt,
  });

  const inventoryOptions = {
    root: tempRoot,
    markerRoot,
    inventoryRuntimeRoot: runtimeRoot,
    runDate,
    businessDate,
    enabledStores: storeKeys,
    requireMarker: false,
  };

  // With valid warning marker present, requireMarker=false uses marker.completedAt and passes freshness
  assert.equal((await validateInventoryArtifacts(inventoryOptions)).ok, true, "valid inventory warning marker freezes freshness in requireMarker=false");

  // 9. requireMarker=false with drifted/invalid marker evidence does not freeze, falls back to Date.now() and fails freshness
  await writeMarker({
    root: markerRoot,
    stage: "daily-inventory-guard",
    date: runDate,
    businessDate,
    status: "failed",
    ok: false,
    evidence: [planFile, resultFile],
    completedAt: markerCompletedAt,
  });
  await assert.rejects(
    validateInventoryArtifacts(inventoryOptions),
    /inventory plan sourceEvidence is stale/,
    "bad marker status does not freeze freshness and fails closed to Date.now()",
  );

  // 10. requireMarker=false without any marker falls back to Date.now() (stale source evidence rejected)
  await fs.rm(inventoryMarkerFile, {force: true});
  await assert.rejects(
    validateInventoryArtifacts(inventoryOptions),
    /inventory plan sourceEvidence is stale/,
    "missing marker falls back to Date.now() and rejects stale evidence",
  );

  // Restore clean plan/result baseline for final marker check
  await writeJson(planFile, plan);
  await writeJson(resultFile, goodResult);
  await writeMarkers();

  console.log(JSON.stringify({ok: true, checks: ['exact_four_evidence_paths', 'nineteen_store_artifacts', 'plan_hash', 'automatic_authorization', 'row_identity_and_readback', 'closed_terminal_drift_requires_exact_journal_audit', 'final_freshness_anchored_to_completion', 'write_time_freshness_uses_now', 'zero_rows_require_complete_sources', 'arbitrary_marker_rejected', 'pending_write_rejected', 'orphan_intent_rejected', 'artifact_drift_rejected', 'same_day_pending_warning_accepted_with_exact_journal', 'same_day_pending_warning_strict_rejected', 'same_day_pending_warning_requires_both_warning_markers', 'same_day_pending_warning_journal_missing_rejected', 'same_day_pending_warning_retry_rejected', 'same_day_pending_warning_scope_drift_rejected', 'same_day_pending_warning_binding_drift_rejected', 'same_day_pending_warning_success_confirmed_rejected', 'same_day_pending_warning_terminal_conflict_rejected', 'warning_markers_accepted', 'warning_evidence_drift_rejected', 'failed_marker_rejected', 'warning_non_executable_plan_rejected', 'warning_unsafe_row_rejected', 'inventory_only_warning_marker_freezes_freshness', 'inventory_only_corrupted_marker_uses_now', 'inventory_only_no_marker_uses_now']}, null, 2));
} finally {
  await fs.rm(tempRoot, {recursive: true, force: true});
}
