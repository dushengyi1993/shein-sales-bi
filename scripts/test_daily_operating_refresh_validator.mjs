#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  buildDailyInventoryPlanHashPayload,
  computeInventoryOverwriteQuantity,
  stableInventoryHash,
} from '../lib/inventory_replenishment_policy.mjs';
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
      ...storeKeys.map(store => ({store, file: `outputs/shein_openapi_products/${store}/latest.json`, fetchedAt: new Date().toISOString(), stockFailedChunkCount: 0})),
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
  await fs.writeFile(`${resultFile}.journal.ndjson`, `${JSON.stringify(terminalIntent)}\n${JSON.stringify(terminalOutcome)}\n`);
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
  await assert.rejects(validateInventoryArtifacts({...options, enabledStores: storeKeys.slice().sort(), requireMarker:false}), /sourceEvidence is stale/, 'write-time validation must still reject the same evidence now');
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

  await writeJson(resultFile, {...goodResult, unresolvedIntents: [{intentId:'orphan-1',recoveryScopeKey:'scope-1',state:'needs_manual_resolve'}]});
  await writeMarkers();
  await assert.rejects(validateDailyOperatingRefresh(options), /contains unresolved durable intents/);

  await writeJson(resultFile, goodResult);
  await writeMarkers();
  await fs.appendFile(path.join(tempRoot, 'outputs', 'shein_links', 'DL', `${businessDate}.json`), ' ');
  await assert.rejects(validateDailyOperatingRefresh(options), /artifact size mismatch|artifact hash mismatch/);

  console.log(JSON.stringify({ok: true, checks: ['exact_four_evidence_paths', 'nineteen_store_artifacts', 'plan_hash', 'automatic_authorization', 'row_identity_and_readback', 'closed_terminal_drift_requires_exact_journal_audit', 'final_freshness_anchored_to_completion', 'write_time_freshness_uses_now', 'zero_rows_require_complete_sources', 'arbitrary_marker_rejected', 'pending_write_rejected', 'orphan_intent_rejected', 'artifact_drift_rejected']}, null, 2));
} finally {
  await fs.rm(tempRoot, {recursive: true, force: true});
}
