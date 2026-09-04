#!/usr/bin/env node
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildEtLowInventorySafetyPlan} from './inventory/build_et_low_inventory_safety_plan.mjs';
import {assertDailyInventoryExecutionAuthorization, stableInventoryHash} from '../lib/inventory_replenishment_policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const sourcePlan = {
  schemaVersion: 'daily-inventory-replenishment-plan/v1',
  date: '2026-08-06',
  policyVersion: '2026-08-06.1',
  payloadHash: 'a'.repeat(64),
  sourceEvidence: [{store: 'ET', fetchedAt: '2026-08-06T05:20:00.000Z', ageHours: 0.1}],
  blockers: [],
  actionable: [
    {storeKey: 'A', skc: 'down', matchKey: 'LOW1', ruleClass: 'low_et_top_exposure_allocation', platformUsableInventory: 10, targetUsableInventory: 2, inventoryAction: 'decrease', replenishmentQuantity: 0},
    {storeKey: 'B', skc: 'up', matchKey: 'LOW1', ruleClass: 'low_et_top_exposure_allocation', platformUsableInventory: 0, targetUsableInventory: 2, inventoryAction: 'increase', replenishmentQuantity: 2},
    {storeKey: 'C', skc: 'ordinary', matchKey: 'HIGH1', ruleClass: 'legacy_virtual_inventory_top_up', platformUsableInventory: 0, targetUsableInventory: 100, inventoryAction: 'increase', replenishmentQuantity: 100},
  ],
  lowEtAllocations: [
    {storeKey: 'A', skc: 'down', matchKey: 'LOW1', etSellableInventory: 4, platformUsableInventory: 10, targetUsableInventory: 2},
    {storeKey: 'B', skc: 'up', matchKey: 'LOW1', etSellableInventory: 4, platformUsableInventory: 0, targetUsableInventory: 2},
  ],
  counts: {enabledStores: 2, scannedLinks: 3, inventoryRelevantLinks: 3, lowEtBlockedCanonicalCount: 0},
};

const plan = buildEtLowInventorySafetyPlan(sourcePlan, {batchId: 'et-daily-2026-08-06-test'});
assert.equal(plan.schemaVersion, 'et-low-inventory-safety-plan/v1');
assert.equal(plan.executionConstraints.decreaseOnly, true);
assert.equal(plan.actionable.length, 1);
assert.equal(plan.actionable[0].skc, 'down');
assert.equal(plan.counts.inventoryIncreases, 0);
assert.equal(plan.counts.filteredOutIncreaseActions, 1);
assert.equal(plan.watch.active, true);
assert.match(plan.payloadHash, /^[a-f0-9]{64}$/);

const boundManifestHash = 'b'.repeat(64);
const boundNow = new Date().toISOString();
const boundDate = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date());
const boundFiles = {
  store_stock: {
    path: 'outputs/et-forwarder/test/store_stock.json', hash: 'd'.repeat(64),
    rowCount: 2, count: 2, rawRowCount: 2, pageCount: 1,
    fetchedAt: boundNow, complete: true,
  },
  box_stock: {
    path: 'outputs/et-forwarder/test/box_stock.json', hash: 'e'.repeat(64),
    rowCount: 0, count: 0, rawRowCount: 0, pageCount: 1,
    fetchedAt: boundNow, complete: true,
  },
};
const boundBatchId = `et-daily-${boundDate}-bound`;
const boundInventoryEvidenceHash = stableInventoryHash({
  schemaVersion: 'et-low-inventory-evidence/v1',
  manifestHash: boundManifestHash,
  batchId: boundBatchId,
  targetDate: boundDate,
  endpoints: ['store_stock', 'box_stock'].map(endpoint => {
    const file = boundFiles[endpoint];
    return {
      endpoint,
      path: file.path,
      hash: file.hash,
      rowCount: file.rowCount,
      count: file.count,
      rawRowCount: file.rawRowCount,
      pageCount: file.pageCount,
      fetchedAt: file.fetchedAt,
      complete: true,
    };
  }),
});
const boundSourcePlan = {
  ...sourcePlan,
  date: boundDate,
  etFactSource: {
    schemaVersion: 'et-low-inventory-fact-source/v1',
    kind: 'et_forwarder_manifest',
    batchId: boundBatchId,
    targetDate: boundDate,
    manifestHash: boundManifestHash,
    createdAt: boundNow,
    maxAgeSeconds: 1800,
    files: boundFiles,
    endpointRows: {store_stock: 2, box_stock: 0},
    invalidRows: 0,
    completeInventoryEvidence: true,
    inventoryEvidenceHash: boundInventoryEvidenceHash,
  },
};
const boundPlan = buildEtLowInventorySafetyPlan(boundSourcePlan, {
  batchId: boundBatchId,
  manifestHash: boundManifestHash,
});
assert.equal(boundPlan.executable, true);
assert.equal(boundPlan.executionConstraints.triggerManifestHash, boundManifestHash);
const driftedBoundPlan = buildEtLowInventorySafetyPlan(boundSourcePlan, {
  batchId: `${boundBatchId}-drift`,
  manifestHash: boundManifestHash,
});
assert.equal(driftedBoundPlan.executable, false);
assert.ok(driftedBoundPlan.blockers.some(text => text.startsWith('ET safety source batch binding mismatch:')));
const wrongHashBoundPlan = buildEtLowInventorySafetyPlan(boundSourcePlan, {
  batchId: boundBatchId,
  manifestHash: 'c'.repeat(64),
});
assert.equal(wrongHashBoundPlan.executable, false);
assert.ok(wrongHashBoundPlan.blockers.some(text => text.startsWith('ET safety source manifest hash mismatch:')));
const missingHashBoundPlan = buildEtLowInventorySafetyPlan(boundSourcePlan, {
  batchId: boundBatchId,
});
assert.equal(missingHashBoundPlan.executable, false);
assert.ok(missingHashBoundPlan.blockers.includes('ET safety trigger manifest hash is missing'));
const incompleteBoundPlan = buildEtLowInventorySafetyPlan({
  ...boundSourcePlan,
  etFactSource: {
    ...boundSourcePlan.etFactSource,
    completeInventoryEvidence: false,
    files: {...boundFiles, store_stock: {...boundFiles.store_stock, complete: false}},
  },
}, {batchId: boundBatchId, manifestHash: boundManifestHash});
assert.equal(incompleteBoundPlan.executable, false);
assert.ok(incompleteBoundPlan.blockers.includes('ET safety source complete inventory evidence is missing'));
assert.ok(incompleteBoundPlan.blockers.includes('ET safety source store_stock completeness binding is invalid'));
const driftedEndpointHashPlan = buildEtLowInventorySafetyPlan({
  ...boundSourcePlan,
  etFactSource: {
    ...boundSourcePlan.etFactSource,
    files: {...boundFiles, store_stock: {...boundFiles.store_stock, hash: '1'.repeat(64)}},
  },
}, {batchId: boundBatchId, manifestHash: boundManifestHash});
assert.equal(driftedEndpointHashPlan.executable, false);
assert.ok(driftedEndpointHashPlan.blockers.includes('ET safety source inventory evidence hash mismatch'));

const policy = JSON.parse(fs.readFileSync(new URL('../config/inventory_replenishment_policy.json', import.meta.url), 'utf8'));
const auth = assertDailyInventoryExecutionAuthorization({
  policy,
  mode: 'automatic',
  context: 'cloud_et_low_inventory_guard',
  authorizationId: 'owner-automatic-et-low-inventory-20260806-v1',
  payloadHash: plan.payloadHash,
  confirmHash: plan.payloadHash,
});
assert.equal(auth.context, 'cloud_et_low_inventory_guard');
assert.throws(() => assertDailyInventoryExecutionAuthorization({
  policy,
  mode: 'automatic',
  context: 'cloud_et_low_inventory_guard',
  authorizationId: 'owner-automatic-inventory-20260803-v1',
  payloadHash: plan.payloadHash,
  confirmHash: plan.payloadHash,
}), /authorization id mismatch/);

// Executor regression: a production-shaped direct manifest (pointerPath ===
// manifestPath) is authoritative even when the Portal ET projection is old.
// The zero-action plan must complete before any OpenAPI client can be created.
const executorFixtureRoot = path.join(ROOT, 'outputs', 'et-forwarder', `executor-regression-${process.pid}-${Date.now()}`);
const executorReportRoot = path.join(ROOT, 'outputs', 'reports', `executor-regression-${process.pid}-${Date.now()}`);
const executorConfig = path.join(executorReportRoot, 'no-credentials.json');
const executorLinks = path.join(executorReportRoot, 'links.json');
const executorOldPortal = path.join(executorReportRoot, 'old-inventoryTrend.json');
const executorPlanFile = path.join(executorReportRoot, 'plan.json');
const executorResultFile = path.join(executorReportRoot, 'result.json');
fs.mkdirSync(executorFixtureRoot, {recursive: true});
fs.mkdirSync(executorReportRoot, {recursive: true});
const endpointFiles = {};
for (const [endpoint, rows] of [['store_stock', [{id: 'current-et-row'}]], ['box_stock', []]]) {
  const document = {endpoint, fetchedAt: boundNow, count: rows.length, rawRowCount: rows.length, rows, pages: [{page: 1, count: rows.length, rows: rows.length}]};
  const file = path.join(executorFixtureRoot, `${endpoint}.json`);
  fs.writeFileSync(file, JSON.stringify(document));
  endpointFiles[endpoint] = {
    path: path.relative(ROOT, file).replaceAll(path.sep, '/'),
    hash: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    rowCount: rows.length, count: rows.length, rawRowCount: rows.length, pageCount: 1,
    fetchedAt: boundNow, complete: true,
  };
}
const executorManifest = {
  ok: true, mode: 'daily', batchId: boundBatchId, targetDate: boundDate, createdAt: boundNow,
  files: {store_stock: 'store_stock.json', box_stock: 'box_stock.json'},
  endpoints: Object.fromEntries(['store_stock', 'box_stock'].map(endpoint => [endpoint, {
    kind: 'snapshot', count: endpointFiles[endpoint].count, rawRowCount: endpointFiles[endpoint].rawRowCount,
    rowCount: endpointFiles[endpoint].rowCount, pages: 1, stoppedByOverlap: false, stoppedByDailyInitialCap: false,
  }])),
};
const executorManifestFile = path.join(executorFixtureRoot, 'manifest.json');
fs.writeFileSync(executorManifestFile, JSON.stringify(executorManifest));
const executorManifestRelative = path.relative(ROOT, executorManifestFile).replaceAll(path.sep, '/');
const executorManifestHash = createHash('sha256').update(fs.readFileSync(executorManifestFile)).digest('hex');
const executorFact = {
  schemaVersion: 'et-low-inventory-fact-source/v1', kind: 'et_forwarder_manifest',
  manifestPath: executorManifestRelative, pointerPath: executorManifestRelative,
  manifestHash: executorManifestHash, batchId: boundBatchId, targetDate: boundDate, createdAt: boundNow,
  maxAgeSeconds: 1800, files: endpointFiles,
  endpointRows: {store_stock: 1, box_stock: 0}, invalidRows: 0, completeInventoryEvidence: true,
};
executorFact.inventoryEvidenceHash = stableInventoryHash({
  schemaVersion: 'et-low-inventory-evidence/v1', manifestHash: executorManifestHash,
  batchId: boundBatchId, targetDate: boundDate,
  endpoints: ['store_stock', 'box_stock'].map(endpoint => ({endpoint, ...endpointFiles[endpoint]})),
});
const executorSourcePlan = {
  schemaVersion: 'daily-inventory-replenishment-plan/v1', date: boundDate,
  policyVersion: policy.policyVersion, payloadHash: 'f'.repeat(64), blockers: [], actionable: [], lowEtAllocations: [],
  etFactSource: executorFact,
  sourceEvidence: [
    {store: 'ET', source: 'et_forwarder_manifest', authoritative: true, file: executorManifestRelative,
      fetchedAt: boundNow, batchId: boundBatchId, targetDate: boundDate, manifestHash: executorManifestHash,
      maxAgeSeconds: 1800, completeInventoryEvidence: true, inventoryEvidenceHash: executorFact.inventoryEvidenceHash,
      sourceFiles: endpointFiles, endpointRows: executorFact.endpointRows},
    {store: 'ET_PORTAL_PROJECTION_DIAGNOSTIC', source: 'portal_projection_diagnostic_only', authoritative: false,
      file: 'outputs/bi-portal/sections/inventoryTrend.json', fetchedAt: '2026-08-01T00:00:00.000Z'},
    {store: 'BI_LINKS', file: 'fixture-links.json', fetchedAt: boundNow},
  ],
  counts: {},
};
const executorSafetyPlan = buildEtLowInventorySafetyPlan(executorSourcePlan, {batchId: boundBatchId, manifestHash: executorManifestHash});
assert.equal(executorSafetyPlan.executable, true);
fs.writeFileSync(executorPlanFile, JSON.stringify(executorSafetyPlan));
fs.writeFileSync(executorConfig, JSON.stringify({stores: []}));
fs.writeFileSync(executorLinks, JSON.stringify({cachedAt: boundNow, data: {storeLinks: []}}));
fs.writeFileSync(executorOldPortal, JSON.stringify({cachedAt: '2026-08-01T00:00:00.000Z', data: {inventoryDepletion: {products: []}}}));
const runExecutorFixture = () => spawnSync(process.execPath, [
  path.join(ROOT, 'scripts', 'inventory', 'execute_daily_inventory_replenishment_plan.mjs'),
  '--plan', executorPlanFile, '--policy', path.join(ROOT, 'config', 'inventory_replenishment_policy.json'),
  '--config', executorConfig, '--bi-data', executorOldPortal, '--links-data', executorLinks,
  '--out', executorResultFile, '--execute', '--execution-mode', 'automatic', '--confirm-hash', executorSafetyPlan.payloadHash,
], {cwd: ROOT, encoding: 'utf8', env: {...process.env,
  SHEIN_BI_INVENTORY_AUTOMATION_CONTEXT: 'cloud_et_low_inventory_guard',
  SHEIN_BI_INVENTORY_AUTOMATION_AUTHORIZATION: 'owner-automatic-et-low-inventory-20260806-v1'}});
try {
  const directManifestRun = runExecutorFixture();
  assert.equal(directManifestRun.status, 0, `${directManifestRun.stdout}\n${directManifestRun.stderr}`);
  assert.deepEqual(JSON.parse(directManifestRun.stdout).counts, {total: 0, updated: 0, dryRunReady: 0, skipped: 0, deferredHistorical: 0, blocked: 0});
  assert.deepEqual(JSON.parse(fs.readFileSync(executorResultFile)).results, []);
  fs.appendFileSync(executorManifestFile, '\n');
  const tamperedManifestRun = runExecutorFixture();
  assert.notEqual(tamperedManifestRun.status, 0);
  assert.match(tamperedManifestRun.stderr, /ET manifest hash changed after plan/);
} finally {
  fs.rmSync(executorFixtureRoot, {recursive: true, force: true});
  fs.rmSync(executorReportRoot, {recursive: true, force: true});
}

const executor = fs.readFileSync(new URL('./inventory/execute_daily_inventory_replenishment_plan.mjs', import.meta.url), 'utf8');
const forwarder = fs.readFileSync(new URL('./cloud_et_forwarder_sync.sh', import.meta.url), 'utf8');
const guard = fs.readFileSync(new URL('./cloud_et_low_inventory_guard.sh', import.meta.url), 'utf8');
const recheck = fs.readFileSync(new URL('./cloud_et_low_inventory_recheck.sh', import.meta.url), 'utf8');
const heavyWrapper = fs.readFileSync(new URL('./run_host_heavy_job.sh', import.meta.url), 'utf8');
const forwarderService = fs.readFileSync(new URL('../infra/systemd/shein-bi-cloud-et-forwarder.service', import.meta.url), 'utf8');
const guardService = fs.readFileSync(new URL('../infra/systemd/shein-bi-et-low-inventory-guard.service', import.meta.url), 'utf8');
const recheckTimer = fs.readFileSync(new URL('../infra/systemd/shein-bi-et-low-inventory-recheck.timer', import.meta.url), 'utf8');
const recheckService = fs.readFileSync(new URL('../infra/systemd/shein-bi-et-low-inventory-recheck.service', import.meta.url), 'utf8');
assert.match(executor, /skipped_safety_no_increase/);
assert.match(executor, /Decrease-only safety plan contains a non-decrease action/);
assert.match(executor, /etRowsFromSafetyAllocations\(plan\)/);
assert.match(executor, /ET actionable does not match its exact lowEtAllocation/);
assert.match(executor, /const fields = \['matchKey', 'canonical', 'etSellableInventory', 'etSnapshotDate', 'plannedAllocationTotal', 'targetUsableInventory'\]/,
  'nonzero ET safety rows must be reconstructed only after exact allocation evidence matching');
assert.doesNotMatch(executor, /aggregateEtStockRows|normalizeEtManifestProduct/,
  'the executor must not duplicate the builder ET normalization/aggregation loader');
assert.match(forwarder, /orders,waybills,afterSales,inventoryTrend/);
assert.doesNotMatch(forwarderService, /^OnSuccess=shein-bi-et-low-inventory-guard\.service$/m,
  'a deferred ET forwarder must not trigger the guard through systemd OnSuccess');
assert.match(forwarderService, /^Environment=SHEIN_ET_TRIGGER_LOW_INVENTORY_GUARD=1$/m,
  'the ET guard must be triggered only by a completed forwarder child');
assert.match(forwarder, /SHEIN_ET_TRIGGER_LOW_INVENTORY_GUARD_DISABLED/,
  'the forwarder trigger must remain explicitly disableable for controlled recovery');
assert.match(forwarder, /systemctl start --no-block shein-bi-et-low-inventory-guard\.service/,
  'the ET guard must start only after the forwarder has produced its manifest');
assert.match(guardService, /SHEIN_BI_INVENTORY_AUTOMATION_CONTEXT=cloud_et_low_inventory_guard/);
assert.match(guard, /--operation-mode et_low_inventory_safety/);
assert.match(guard, /--et-manifest "\$ET_MANIFEST_FILE"/);
assert.match(guard, /--et-manifest-hash "\$ET_MANIFEST_HASH"/);
assert.match(guard, /--et-max-age-seconds "\$ET_FACT_MAX_AGE_SECONDS"/);
assert.match(guard, /ET_FACT_MAX_AGE_HARD_LIMIT_SECONDS=21600/);
assert.match(guard, /etManifestHash/);
assert.match(guard, /\$entry\.kind == "manual_resolution"[\s\S]*del\(\.\[\$entry\.intentId\]\)/,
  'ET durable-journal parsing must recognize manual_resolution without treating it as an ordinary write outcome');
assert.match(guard, /\{ok:\(\$blocked==0\),businessState:/);
assert.match(guard, /pendingCanonical:\$blockedCanonical/);
assert.doesNotMatch(guard, /BLOCKED > 0 \|\| BLOCKED_CANONICAL > 0/);
assert.match(recheck, /SHEIN_ET_ENDPOINTS="store_stock,box_stock"/);
assert.match(recheck, /SHEIN_ET_TRANSPORT="\$\{SHEIN_ET_TRANSPORT:-http\}"/);
assert.match(recheck, /SHEIN_ET_EXPECTED_BATCH_ID="?\$POST_BATCH_ID"?/);
assert.match(recheck, /SHEIN_ET_EXPECTED_MANIFEST_HASH="?\$POST_MANIFEST_HASH"?/);
assert.match(
  recheck,
  /(?:^|\n)\s*(?:\/usr\/sbin\/)?runuser\s+(?:-u|--user)\s+sheinops\s+--[\s\S]*?bash\s+"\$ROOT\/scripts\/cloud_et_low_inventory_guard\.sh"/,
  'the recheck entrypoint must invoke the guard through runuser as sheinops',
);
assert.match(
  recheck,
  /SHEIN_BI_INVENTORY_SKU_LOCK_DIR=\$\{SHEIN_BI_INVENTORY_SKU_LOCK_DIR:-\/data\/shein-bi\/state\/locks\}/,
  'the root recheck wrapper must pass the writable canonical SKU lock directory to sheinops',
);
assert.match(recheck, /forwarder produced no new ET batch/);
assert.match(recheckService, /^Environment=SHEIN_ET_TRANSPORT=http$/m);
assert.doesNotMatch(recheckService, /run_host_browser_read_job\.sh|--class browser/);
assert.match(recheckTimer, /^OnCalendar=\*-\*-\* 00,02,05,06,08,09,11,12,15,16,18,19,22:20:00$/m);
assert.match(recheckTimer, /^Persistent=false$/m);

// systemd exit semantics:
// - a current nonzero planner/filter status fails closed before downstream use;
//   a pre-existing executable artifact is never eligible for the current run.
// - a completed batch with zero row-level blockers (pure no-action, or
//   observation-only watchlists) exits 0 and is healthy; only real row-level
//   blockers exit 1.
// - manifest/lock/defer gaps exit 75, which the unit declares as success so
//   systemd does not crash-loop on availability windows.
assert.match(guard, /\(\.result != null\) and \(\.counts\.blocked \/\/ 0\) == 0 and \.ok != true/,
  'only a genuinely completed run may be normalized to watching');
assert.match(guard, /state:"batch_already_processed"[\s\S]*exit 0/,
  'a completed batch with no pending work exits 0');
assert.match(guard, /lastProcessedBatchId[\s\S]*jq -e '\.result != null'/,
  'same-batch idempotent success requires a terminal result artifact');
assert.match(guard, /retry incomplete batch=\$BATCH_ID/,
  'a same-batch incomplete state must re-enter evidence refresh instead of returning false success');
assert.match(guard, /SOURCE_PLAN_ATTEMPT="\$SOURCE_PLAN\.attempt-\$ATTEMPT_ID"/,
  'source plans must be written to a per-attempt path');
assert.match(guard, /PLAN_ATTEMPT="\$PLAN\.attempt-\$ATTEMPT_ID"/,
  'safety plans must be written to a per-attempt path');
assert.match(guard, /RESULT_ATTEMPT="\$RESULT\.attempt-\$ATTEMPT_ID"/,
  'executor results must be written to a per-attempt path');
assert.match(guard, /if \(\( BUILD_STATUS != 0 \)\); then[\s\S]*stale source plan is not eligible[\s\S]*exit "\$BUILD_STATUS"/,
  'the current source planner must exit zero before safety filtering');
assert.match(guard, /if \(\( FILTER_STATUS != 0 \)\); then[\s\S]*stale safety plan is not eligible[\s\S]*exit "\$FILTER_STATUS"/,
  'the current safety filter must exit zero before execution');
assert.match(guard, /if \(\( EXECUTOR_STATUS != 0 \)\); then[\s\S]*stale stable result is not eligible[\s\S]*exit "\$EXECUTOR_STATUS"/,
  'the current executor must exit zero before any result can become completion evidence');
assert.match(guard, /result_is_complete_and_safe[\s\S]*after\.totalUsableInventory == \.targetUsableInventory/,
  'current executor evidence requires exact live readback, not a matching status string alone');
assert.match(guard, /mv "\$result_attempt" "\$RESULT"/,
  'only a validated current executor result may atomically replace the stable audit result');
assert.match(guard, /ln "\$RESULT_JOURNAL" "\$RESULT_ATTEMPT_JOURNAL"[\s\S]*rm -f "\$RESULT_ATTEMPT_JOURNAL"/,
  'per-attempt result isolation must preserve the stable durable intent journal');
assert.match(guard, /kind:"executor_run_intent"[\s\S]*phase:\$phase[\s\S]*attemptId:\$attemptId[\s\S]*runDate:\$runDate[\s\S]*batchId:\$batchId[\s\S]*manifestHash:\$manifestHash[\s\S]*planHash:\$planHash/,
  'the stable pre-write intent binds attempt, run date, batch, manifest, and exact plan hash');
assert.match(guard, /RETAIN_RESULT_ATTEMPT=1[\s\S]*append_executor_run_phase "\$RUN_INTENT_ID" prepared/,
  'attempt-result retention is armed before the prepared intent can become durable');
assert.match(guard, /trap cleanup_attempt_outputs EXIT[\s\S]*trap 'exit 143' TERM[\s\S]*trap 'exit 130' INT[\s\S]*trap 'exit 129' HUP/,
  'EXIT, TERM, INT, and HUP all converge through retention-aware cleanup');
assert.match(guard, /append_executor_run_phase "\$RUN_INTENT_ID" prepared[\s\S]*append_executor_run_phase "\$RUN_INTENT_ID" executing[\s\S]*node scripts\/inventory\/execute_daily_inventory_replenishment_plan\.mjs/,
  'prepared and executing phases must be durable before the executor can POST');
assert.match(guard, /sync_durable_path "\$RESULT_JOURNAL"/,
  'stable journal phase appends are fsynced');
assert.match(guard, /NONTERMINAL_RUN_INTENTS=.*prepared.*executing.*ambiguous.*promoting/,
  'every nonterminal guard intent phase participates in replay suppression');
assert.match(guard, /UNKNOWN_RUN_PHASE_COUNT[\s\S]*unknown run phase; reconcile-required\/incomplete/,
  'unknown journal phases fail closed instead of releasing write ownership');
assert.ok(guard.indexOf('if (( NONTERMINAL_RUN_COUNT == 1 ))') < guard.indexOf('run_source_plan_attempt'),
  'nonterminal intent recovery must happen before any new planner/executor attempt');
assert.match(guard, /reconcile-required\/incomplete; executor replay forbidden/,
  'unknown or SIGKILL windows retain the intent and require read-only reconciliation');
assert.match(guard, /CURRENT_RUN_DISPOSITION=[\s\S]*not_submitted[\s\S]*rejected[\s\S]*ambiguous/,
  'only observed not-submitted or definitive rejection can release a failed current attempt');
assert.match(guard, /append_executor_run_phase "\$intent_id" promoting[\s\S]*mv "\$result_attempt" "\$RESULT"[\s\S]*append_executor_run_phase "\$intent_id" completed/,
  'promotion durably records exact evidence before atomic move and only then records completed');
assert.match(guard, /stableResult:\$stableResult[\s\S]*resultHash:\$resultHash[\s\S]*readbackIdentity:\$readbackIdentity/,
  'promoting/completed journal records bind stable path, exact result bytes, and readback identity');
assert.match(guard, /RECOVERY_PHASE.*promoting[\s\S]*ATTEMPT_PRESENT[\s\S]*STABLE_PRESENT[\s\S]*result_matches_promotion_evidence/,
  'promoting recovery inspects both bound attempt and stable result under exact journal evidence');
assert.match(guard, /SHEIN_OPENAPI_PRODUCT_RECONCILE_PRIORITY_DETAILS_ONLY=1 \\\n+\s*bash "\$ROOT\/scripts\/cloud_openapi_product_reconciliation\.sh"/,
  'the guard must launch reconciliation through bash because the tracked wrapper is intentionally not executable');
assert.match(guard, /all\(\.blockers\[\]; startswith\("low-ET OpenAPI product canonical evidence is not from current detail:"\)\)/,
  'automatic evidence recovery must run only when every blocker is an exact current-detail blocker');
assert.match(guard, /persist_completed_state "\$RESULT"[\s\S]*state:"completed"/,
  'a strictly validated result persists the terminal state and falls through with exit zero');
assert.match(guard, /exit 75/,
  'manifest/lock/defer gaps use exit 75');
assert.match(guardService, /SuccessExitStatus=75/,
  'systemd treats availability defers as success and does not crash-loop on them');
assert.match(heavyWrapper, /exit "\$STATUS"/,
  'the host-heavy wrapper propagates the guard exit code unchanged to systemd');
assert.match(recheck, /no active ET 1-10 watchlist; skip ET HTTP refresh/,
  'a recheck with no active watchlist is a pure no-action path');
assert.match(recheck, /skip ET HTTP refresh[\s\S]*exit 0/,
  'a recheck with no active watchlist exits 0 and is healthy');

// Execute the guard against a fake root. A stale executable source/safety plan
// is pre-seeded for the same batch, while the current source-planner attempt is
// forced to fail without producing output. Neither the safety filter nor the
// executor may be called.
const harnessRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'et-low-inventory-stale-plan-'));
const bashKernel = spawnSync('bash', ['-lc', 'uname -s'], {encoding: 'utf8'}).stdout.trim().toLowerCase();
const toBashPath = value => {
  if (process.platform !== 'win32') return value;
  const normalized = path.resolve(value).replaceAll('\\', '/');
  const match = normalized.match(/^([A-Za-z]):\/(.*)$/);
  assert.ok(match, `cannot convert Windows path for bash: ${value}`);
  return bashKernel.includes('linux')
    ? `/mnt/${match[1].toLowerCase()}/${match[2]}`
    : `/${match[1].toLowerCase()}/${match[2]}`;
};
try {
  const harnessRuntime = path.join(harnessRoot, 'runtime');
  const harnessBin = path.join(harnessRoot, 'bin');
  const harnessManifest = path.join(harnessRoot, 'outputs', 'et-forwarder', 'manifest.json');
  const harnessLog = path.join(harnessRoot, 'node-calls.log');
  const harnessBatch = `et-daily-${boundDate}-stale-plan-regression`;
  const safeHarnessBatch = harnessBatch.replace(/[^A-Za-z0-9._-]/g, '_');
  fs.mkdirSync(path.join(harnessRoot, 'scripts', 'lib'), {recursive: true});
  fs.mkdirSync(path.dirname(harnessManifest), {recursive: true});
  fs.mkdirSync(path.join(harnessRoot, 'state', 'locks'), {recursive: true});
  fs.mkdirSync(path.join(harnessRuntime, 'source-plans'), {recursive: true});
  fs.mkdirSync(path.join(harnessRuntime, 'plans'), {recursive: true});
  fs.mkdirSync(path.join(harnessRuntime, 'results'), {recursive: true});
  fs.mkdirSync(harnessBin, {recursive: true});
  fs.writeFileSync(path.join(harnessRoot, 'scripts', 'lib', 'shared_lock.sh'), [
    'prepare_shared_lock_file() {',
    '  mkdir -p "$(dirname "$1")"',
    '  : > "$1"',
    '}',
    '',
  ].join('\n'));
  fs.writeFileSync(harnessManifest, JSON.stringify({
    batchId: harnessBatch,
    mode: 'daily',
    targetDate: boundDate,
    createdAt: boundNow,
    ok: true,
  }));
  const harnessManifestHash = createHash('sha256').update(fs.readFileSync(harnessManifest)).digest('hex');
  const preseedSource = path.join(harnessRuntime, 'source-plans', `et-low-inventory-source-${safeHarnessBatch}.json`);
  const preseedPlan = path.join(harnessRuntime, 'plans', `et-low-inventory-${safeHarnessBatch}.json`);
  const preseedResult = path.join(harnessRuntime, 'results', `et-low-inventory-${safeHarnessBatch}.json`);
  const journalFile = `${preseedResult}.journal.ndjson`;
  const staleExecutable = {schemaVersion: 'stale-preseed/v1', executable: true, blockers: [], payloadHash: 'f'.repeat(64)};
  fs.writeFileSync(preseedSource, JSON.stringify(staleExecutable));
  fs.writeFileSync(preseedPlan, JSON.stringify(staleExecutable));
  const executorPlanHash = 'c'.repeat(64);
  const staleStableResult = {
    schemaVersion: 'daily-inventory-replenishment-result/v1',
    generatedAt: 'stale-preseed-result',
    planHash: executorPlanHash,
    execute: true,
    executionMode: 'automatic',
    executionConstraints: {decreaseOnly: true},
    unresolvedIntents: [],
    results: [{
      state: 'updated_readback_matched',
      targetUsableInventory: 2,
      after: {totalUsableInventory: 2},
      writes: [{success: true}],
    }],
  };
  const exactExecutorResult = {
    ...staleStableResult,
    generatedAt: 'current-attempt-result',
    results: [{
      storeKey: 'A',
      skc: 'skc-current',
      skuCode: 'sku-current',
      state: 'updated_readback_matched',
      targetUsableInventory: 2,
      after: {totalUsableInventory: 2},
      writes: [{success: true, idempotencyKey: 'current-idempotency', requestPayloadHash: '9'.repeat(64)}],
    }],
  };
  const exactExecutorResultJson = JSON.stringify(exactExecutorResult);
  fs.writeFileSync(preseedResult, JSON.stringify(staleStableResult));
  const fakeNode = path.join(harnessBin, 'node');
  fs.writeFileSync(fakeNode, [
    '#!/usr/bin/env bash',
    'script="$1"',
    'shift',
    'out=""',
    'while (( $# > 0 )); do',
    '  if [[ "$1" == "--out" && $# -ge 2 ]]; then out="$2"; shift 2; else shift; fi',
    'done',
    'printf "%s\\n" "$script" >> "$HARNESS_NODE_LOG"',
    'case "$script" in',
    '  *build_daily_inventory_replenishment_plan.mjs)',
    '    if [[ "$HARNESS_SCENARIO" == "filter_fail" || "$HARNESS_SCENARIO" == "executor_fail" || "$HARNESS_SCENARIO" == "executor_rejected" || "$HARNESS_SCENARIO" == "executor_transport" || "$HARNESS_SCENARIO" == "sigkill_window" || "$HARNESS_SCENARIO" == "crash_result_before_return" || "$HARNESS_SCENARIO" == "executor_success" ]]; then',
    '      printf "%s\\n" \'{"schemaVersion":"daily-inventory-replenishment-plan/v1","executable":true,"blockers":[],"payloadHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}\' > "$out"',
    '      exit 0',
    '    fi',
    '    exit 1',
    '    ;;',
    '  *build_et_low_inventory_safety_plan.mjs)',
    '    : > "$HARNESS_SAFETY_CALLED"',
    '    if [[ "$HARNESS_SCENARIO" == "executor_fail" || "$HARNESS_SCENARIO" == "executor_rejected" || "$HARNESS_SCENARIO" == "executor_transport" || "$HARNESS_SCENARIO" == "sigkill_window" || "$HARNESS_SCENARIO" == "crash_result_before_return" || "$HARNESS_SCENARIO" == "executor_success" ]]; then',
    `      printf "%s\\n" '{"schemaVersion":"et-low-inventory-safety-plan/v1","date":"${boundDate}","executable":true,"blockers":[],"payloadHash":"${executorPlanHash}","actionable":[{"targetUsableInventory":2}],"watch":{"active":true,"blockedLowEtCanonicalCount":0},"executionConstraints":{"decreaseOnly":true,"triggerBatchId":"${harnessBatch}","triggerManifestHash":"${harnessManifestHash}"}}' > "$out"`,
    '      exit 0',
    '    fi',
    '    exit 1',
    '    ;;',
    '  *execute_daily_inventory_replenishment_plan.mjs)',
    '    printf "called\\n" >> "$HARNESS_EXECUTOR_CALLED"',
    '    if [[ "$HARNESS_SCENARIO" == "crash_result_before_return" ]]; then',
    `      printf '%s\\n' '${exactExecutorResultJson}' > "$out"`,
    '      kill -TERM "$PPID"',
    '      exit 143',
    '    fi',
    '    if [[ "$HARNESS_SCENARIO" == "executor_success" ]]; then',
    `      printf '%s\\n' '${exactExecutorResultJson}' > "$out"`,
    '      exit 0',
    '    fi',
    '    if [[ "$HARNESS_SCENARIO" == "executor_rejected" ]]; then',
    `      printf '%s\\n' '{"kind":"intent","intentId":"definitive-reject","logicalActionKey":"reject-key","planHash":"${executorPlanHash}"}' >> "$out.journal.ndjson"`,
    '      printf \'%s\\n\' \'{"kind":"write_outcome","intentId":"definitive-reject","logicalActionKey":"reject-key","disposition":"rejected"}\' >> "$out.journal.ndjson"',
    '      exit 7',
    '    fi',
    '    if [[ "$HARNESS_SCENARIO" == "executor_transport" ]]; then',
    `      printf '%s\\n' '{"kind":"intent","intentId":"transport-unknown","logicalActionKey":"transport-key","planHash":"${executorPlanHash}"}' >> "$out.journal.ndjson"`,
    '      exit 7',
    '    fi',
    '    if [[ "$HARNESS_SCENARIO" == "sigkill_window" ]]; then kill -KILL "$PPID"; exit 137; fi',
    '    if [[ "$HARNESS_SCENARIO" == "executor_fail" ]]; then exit 7; fi',
    '    exit 1',
    '    ;;',
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n'));
  const fakeFlock = path.join(harnessBin, 'flock');
  fs.writeFileSync(fakeFlock, '#!/usr/bin/env bash\nexit 0\n');
  const fakeMv = path.join(harnessBin, 'mv');
  fs.writeFileSync(fakeMv, [
    '#!/usr/bin/env bash',
    'set -e',
    'src="$1"',
    'dst="$2"',
    'is_result_promotion=0',
    'if [[ "$src" == *"/results/"*".json.attempt-"* && "$src" != *.journal.ndjson && "$dst" == *"/results/"*".json" ]]; then is_result_promotion=1; fi',
    'if [[ "$is_result_promotion" == "1" && "$HARNESS_CRASH_POINT" == "before_result_move" ]]; then',
    '  kill -TERM "$PPID"',
    '  exit 143',
    'fi',
    '/usr/bin/mv "$@"',
    'if [[ "$is_result_promotion" == "1" && "$HARNESS_CRASH_POINT" == "after_result_move" ]]; then',
    '  kill -TERM "$PPID"',
    '  exit 143',
    'fi',
    '',
  ].join('\n'));
  fs.chmodSync(fakeNode, 0o755);
  fs.chmodSync(fakeFlock, 0o755);
  fs.chmodSync(fakeMv, 0o755);
  const harnessRootBash = toBashPath(harnessRoot);
  const harnessRuntimeBash = toBashPath(harnessRuntime);
  const harnessManifestBash = toBashPath(harnessManifest);
  const harnessBinBash = toBashPath(harnessBin);
  const harnessLogBash = toBashPath(harnessLog);
  const safetyMarker = path.join(harnessRoot, 'safety-called');
  const executorMarker = path.join(harnessRoot, 'executor-called');
  const guardPathBash = toBashPath(path.join(ROOT, 'scripts', 'cloud_et_low_inventory_guard.sh'));
  const wslEnvNames = [
    'SHEIN_BI_ROOT',
    'SHEIN_BI_ET_LOW_INVENTORY_RUNTIME_ROOT',
    'SHEIN_BI_ET_LOW_INVENTORY_RUN_DATE',
    'SHEIN_ET_LATEST_MANIFEST',
    'SHEIN_BI_ET_LOW_INVENTORY_MAX_AGE_SECONDS',
    'HARNESS_NODE_LOG',
    'HARNESS_SAFETY_CALLED',
    'HARNESS_EXECUTOR_CALLED',
    'HARNESS_FAKE_BIN',
    'HARNESS_GUARD_PATH',
    'HARNESS_SCENARIO',
    'HARNESS_CRASH_POINT',
  ];
  const runGuardHarness = (scenario, crashPoint = '') => spawnSync('bash', [
      '-lc',
      'export PATH="$HARNESS_FAKE_BIN:$PATH"; exec bash "$HARNESS_GUARD_PATH"',
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        SHEIN_BI_ROOT: harnessRootBash,
        SHEIN_BI_ET_LOW_INVENTORY_RUNTIME_ROOT: harnessRuntimeBash,
        SHEIN_BI_ET_LOW_INVENTORY_RUN_DATE: boundDate,
        SHEIN_ET_LATEST_MANIFEST: harnessManifestBash,
        SHEIN_BI_ET_LOW_INVENTORY_MAX_AGE_SECONDS: '1800',
        HARNESS_NODE_LOG: harnessLogBash,
        HARNESS_SAFETY_CALLED: toBashPath(safetyMarker),
        HARNESS_EXECUTOR_CALLED: toBashPath(executorMarker),
        HARNESS_FAKE_BIN: harnessBinBash,
        HARNESS_GUARD_PATH: guardPathBash,
        HARNESS_SCENARIO: scenario,
        HARNESS_CRASH_POINT: crashPoint,
        WSLENV: [process.env.WSLENV || '', ...wslEnvNames].filter(Boolean).join(':'),
      },
    });
  const run = runGuardHarness('source_fail');
  assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /current source planner attempt did not produce a valid plan status=1/);
  assert.equal(fs.existsSync(safetyMarker), false, 'stale pre-seeded source plan must not reach the safety filter');
  assert.equal(fs.existsSync(executorMarker), false, 'stale pre-seeded safety plan must not reach the executor');
  assert.equal(JSON.parse(fs.readFileSync(preseedPlan, 'utf8')).schemaVersion, 'stale-preseed/v1');

  fs.rmSync(safetyMarker, {force: true});
  fs.rmSync(executorMarker, {force: true});
  const filterFailureRun = runGuardHarness('filter_fail');
  assert.equal(filterFailureRun.status, 1, `${filterFailureRun.stdout}\n${filterFailureRun.stderr}`);
  assert.match(filterFailureRun.stderr, /current safety planner attempt did not produce a valid plan status=1/);
  assert.equal(fs.existsSync(safetyMarker), true, 'the current source plan should reach the injected safety-filter failure');
  assert.equal(fs.existsSync(executorMarker), false, 'a stale pre-seeded safety plan must not reach the executor after current filter failure');
  assert.equal(JSON.parse(fs.readFileSync(preseedPlan, 'utf8')).schemaVersion, 'stale-preseed/v1');

  fs.rmSync(safetyMarker, {force: true});
  fs.rmSync(executorMarker, {force: true});
  const executorFailureRun = runGuardHarness('executor_fail');
  assert.equal(executorFailureRun.status, 7, `${executorFailureRun.stdout}\n${executorFailureRun.stderr}`);
  assert.match(executorFailureRun.stderr, /current executor attempt failed status=7; stale stable result is not eligible/);
  const latestState = path.join(harnessRuntime, 'state', 'latest.json');
  assert.equal(fs.existsSync(latestState), false, 'a failed current executor attempt must not persist completed state');
  assert.equal(JSON.parse(fs.readFileSync(preseedResult, 'utf8')).generatedAt, 'stale-preseed-result',
    'the matching stale stable result must remain audit-only and must not be promoted as current evidence');

  const retryAfterExecutorFailure = runGuardHarness('executor_fail');
  assert.equal(retryAfterExecutorFailure.status, 7, `${retryAfterExecutorFailure.stdout}\n${retryAfterExecutorFailure.stderr}`);
  assert.equal(fs.readFileSync(executorMarker, 'utf8').trim().split(/\r?\n/).length, 2,
    'without completed state, the same batch must retry the executor instead of being suppressed by the stale result');
  assert.equal(fs.existsSync(latestState), false, 'the retry must also remain incomplete after the injected executor failure');

  const notSubmittedRows = fs.readFileSync(journalFile, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
    .filter(row => row.kind === 'executor_run_intent' && row.phase === 'not_submitted');
  assert.equal(notSubmittedRows.length, 2, 'an observed nonzero executor with no row intent is terminal not_submitted and may retry');

  const rejectedRun = runGuardHarness('executor_rejected');
  assert.equal(rejectedRun.status, 7, `${rejectedRun.stdout}\n${rejectedRun.stderr}`);
  let lifecycleRows = fs.readFileSync(journalFile, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(lifecycleRows.filter(row => row.kind === 'executor_run_intent').at(-1)?.phase, 'rejected',
    'a nonzero executor whose every durable row intent is definitively rejected may release the run intent');
  const executorCallsAfterRejected = fs.readFileSync(executorMarker, 'utf8').trim().split(/\r?\n/).length;
  const retryAfterRejected = runGuardHarness('executor_rejected');
  assert.equal(retryAfterRejected.status, 7, `${retryAfterRejected.stdout}\n${retryAfterRejected.stderr}`);
  assert.equal(fs.readFileSync(executorMarker, 'utf8').trim().split(/\r?\n/).length, executorCallsAfterRejected + 1,
    'definitive rejection releases the guard-level intent for a fresh attempt');

  const transportRun = runGuardHarness('executor_transport');
  assert.equal(transportRun.status, 7, `${transportRun.stdout}\n${transportRun.stderr}`);
  lifecycleRows = fs.readFileSync(journalFile, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(lifecycleRows.filter(row => row.kind === 'executor_run_intent').at(-1)?.phase, 'ambiguous',
    'transport/unknown outcome retains an ambiguous guard-level intent');
  const executorCallsAfterTransport = fs.readFileSync(executorMarker, 'utf8').trim().split(/\r?\n/).length;
  const retryAfterTransport = runGuardHarness('executor_transport');
  assert.equal(retryAfterTransport.status, 2, `${retryAfterTransport.stdout}\n${retryAfterTransport.stderr}`);
  assert.match(retryAfterTransport.stderr, /reconcile-required\/incomplete; executor replay forbidden/);
  assert.equal(fs.readFileSync(executorMarker, 'utf8').trim().split(/\r?\n/).length, executorCallsAfterTransport,
    'ambiguous transport outcome suppresses blind executor replay');

  fs.rmSync(journalFile, {force: true});

  const executorCallsBeforeSigkill = fs.readFileSync(executorMarker, 'utf8').trim().split(/\r?\n/).length;
  const sigkillRun = runGuardHarness('sigkill_window');
  assert.notEqual(sigkillRun.status, 0, 'the injected SIGKILL window must interrupt the guard');
  assert.equal(fs.existsSync(journalFile), true, 'the stable pre-write journal must exist before the SIGKILL window');
  const journalRows = fs.readFileSync(journalFile, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  const sigkillIntent = journalRows.findLast(row => row.kind === 'executor_run_intent' && ['prepared', 'executing'].includes(row.phase));
  assert.ok(sigkillIntent, 'SIGKILL must leave a nonterminal stable executor run intent');
  assert.equal(sigkillIntent.planHash, executorPlanHash);
  assert.equal(sigkillIntent.batchId, harnessBatch);
  assert.equal(sigkillIntent.runDate, boundDate);
  const sigkillResultAttempt = path.join(path.dirname(preseedResult), path.basename(sigkillIntent.resultAttempt));
  assert.equal(fs.existsSync(sigkillResultAttempt), false, 'SIGKILL window has no current attempt result evidence');

  const retryAfterSigkill = runGuardHarness('sigkill_window');
  assert.equal(retryAfterSigkill.status, 2, `${retryAfterSigkill.stdout}\n${retryAfterSigkill.stderr}`);
  assert.match(retryAfterSigkill.stderr, /reconcile-required\/incomplete; executor replay forbidden/);
  assert.match(retryAfterSigkill.stderr, /hasStableResult=true stablePlanReadbackExactWithoutJournalHash=true/,
    'an executing intent must inspect but reject even a matching stable result when no exact journal result hash exists');
  assert.equal(fs.readFileSync(executorMarker, 'utf8').trim().split(/\r?\n/).length, executorCallsBeforeSigkill + 1,
    'the first SIGKILL activation calls the executor once, but recovery must never call it again');
  assert.equal(fs.existsSync(latestState), false, 'SIGKILL recovery must not persist completed state');

  fs.writeFileSync(sigkillResultAttempt, JSON.stringify({
    schemaVersion: 'daily-inventory-replenishment-result/v1',
    generatedAt: new Date().toISOString(),
    planHash: executorPlanHash,
    execute: true,
    executionMode: 'automatic',
    executionConstraints: {decreaseOnly: true},
    unresolvedIntents: [],
    results: [{
      state: 'updated_readback_matched',
      targetUsableInventory: 2,
      after: {totalUsableInventory: 2},
      writes: [{success: true, recoveredFromIntent: true}],
    }],
  }));
  const readOnlyRecovery = runGuardHarness('sigkill_window');
  assert.equal(readOnlyRecovery.status, 0, `${readOnlyRecovery.stdout}\n${readOnlyRecovery.stderr}`);
  assert.match(readOnlyRecovery.stdout, /completed_after_readonly_reconcile/);
  assert.equal(fs.readFileSync(executorMarker, 'utf8').trim().split(/\r?\n/).length, executorCallsBeforeSigkill + 1,
    'exact attempt result/readback recovery must not call the executor');
  assert.equal(JSON.parse(fs.readFileSync(latestState, 'utf8')).planHash, executorPlanHash);
  const recoveredJournalRows = fs.readFileSync(journalFile, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(recoveredJournalRows.findLast(row => row.intentId === sigkillIntent.intentId)?.phase, 'completed',
    'successful read-only result recovery advances the same stable journal intent to completed');

  fs.rmSync(latestState, {force: true});
  const completedJournalRecovery = runGuardHarness('sigkill_window');
  assert.equal(completedJournalRecovery.status, 0, `${completedJournalRecovery.stdout}\n${completedJournalRecovery.stderr}`);
  assert.match(completedJournalRecovery.stdout, /completed_after_journal_reconcile/);
  assert.equal(fs.readFileSync(executorMarker, 'utf8').trim().split(/\r?\n/).length, executorCallsBeforeSigkill + 1,
    'a completed journal plus exact stable result restores state without replay');
  assert.equal(fs.existsSync(latestState), true, 'completed journal recovery restores the missing terminal state');

  const executorCallCount = () => fs.existsSync(executorMarker)
    ? fs.readFileSync(executorMarker, 'utf8').trim().split(/\r?\n/).filter(Boolean).length
    : 0;
  const resetLifecycleHarness = () => {
    fs.rmSync(journalFile, {force: true});
    fs.rmSync(latestState, {force: true});
    for (const name of fs.readdirSync(path.dirname(preseedResult))) {
      if (name.startsWith(`${path.basename(preseedResult)}.attempt-`)) {
        fs.rmSync(path.join(path.dirname(preseedResult), name), {force: true});
      }
    }
    fs.writeFileSync(preseedResult, JSON.stringify(staleStableResult));
  };
  const latestRunIntent = () => fs.readFileSync(journalFile, 'utf8').trim().split(/\r?\n/)
    .map(line => JSON.parse(line))
    .filter(row => row.kind === 'executor_run_intent')
    .at(-1);
  const localAttemptPath = intent => path.join(path.dirname(preseedResult), path.basename(intent.resultAttempt));

  resetLifecycleHarness();
  let callsBeforeCrash = executorCallCount();
  const resultBeforeReturnCrash = runGuardHarness('crash_result_before_return');
  assert.notEqual(resultBeforeReturnCrash.status, 0, 'TERM after result creation must interrupt the current guard');
  let interruptedIntent = latestRunIntent();
  assert.equal(interruptedIntent.phase, 'executing');
  assert.equal(fs.existsSync(localAttemptPath(interruptedIntent)), true,
    'EXIT/TERM cleanup retains the bound result created before executor return');
  const recoverResultBeforeReturn = runGuardHarness('executor_success');
  assert.equal(recoverResultBeforeReturn.status, 0, `${recoverResultBeforeReturn.stdout}\n${recoverResultBeforeReturn.stderr}`);
  assert.match(recoverResultBeforeReturn.stdout, /completed_after_readonly_reconcile/);
  assert.equal(executorCallCount(), callsBeforeCrash + 1,
    'executing-result recovery converges without a second executor call');
  assert.equal(latestRunIntent().phase, 'completed');

  resetLifecycleHarness();
  callsBeforeCrash = executorCallCount();
  const beforeMoveCrash = runGuardHarness('executor_success', 'before_result_move');
  assert.notEqual(beforeMoveCrash.status, 0, 'TERM after promoting journal and before move must interrupt the guard');
  interruptedIntent = latestRunIntent();
  assert.equal(interruptedIntent.phase, 'promoting');
  assert.match(interruptedIntent.resultHash, /^[a-f0-9]{64}$/);
  assert.match(interruptedIntent.readbackIdentity, /^[a-f0-9]{64}$/);
  assert.equal(interruptedIntent.stableResult, toBashPath(preseedResult));
  assert.equal(fs.existsSync(localAttemptPath(interruptedIntent)), true,
    'promoting-before-move cleanup retains the exact attempt result');
  assert.equal(JSON.parse(fs.readFileSync(preseedResult, 'utf8')).generatedAt, 'stale-preseed-result',
    'stable result remains stale when the promoting move has not happened');
  const recoverBeforeMove = runGuardHarness('executor_success');
  assert.equal(recoverBeforeMove.status, 0, `${recoverBeforeMove.stdout}\n${recoverBeforeMove.stderr}`);
  assert.match(recoverBeforeMove.stdout, /completed_after_attempt_promotion_reconcile/);
  assert.equal(executorCallCount(), callsBeforeCrash + 1,
    'promoting attempt recovery resumes promotion without executor replay');
  assert.equal(latestRunIntent().phase, 'completed');

  resetLifecycleHarness();
  callsBeforeCrash = executorCallCount();
  const afterMoveCrash = runGuardHarness('executor_success', 'after_result_move');
  assert.notEqual(afterMoveCrash.status, 0, 'TERM after move and before completed must interrupt the guard');
  interruptedIntent = latestRunIntent();
  assert.equal(interruptedIntent.phase, 'promoting');
  assert.equal(fs.existsSync(localAttemptPath(interruptedIntent)), false,
    'attempt path is absent after the atomic move');
  assert.equal(JSON.parse(fs.readFileSync(preseedResult, 'utf8')).generatedAt, 'current-attempt-result',
    'stable result contains the exact promoted attempt before completed is journaled');
  const recoverAfterMove = runGuardHarness('executor_success');
  assert.equal(recoverAfterMove.status, 0, `${recoverAfterMove.stdout}\n${recoverAfterMove.stderr}`);
  assert.match(recoverAfterMove.stdout, /completed_after_stable_promotion_reconcile/);
  assert.equal(executorCallCount(), callsBeforeCrash + 1,
    'stable promotion recovery completes journal/state without executor replay');
  assert.equal(latestRunIntent().phase, 'completed');
} finally {
  fs.rmSync(harnessRoot, {recursive: true, force: true});
}

console.log(JSON.stringify({ok: true, checks: 155}, null, 2));
