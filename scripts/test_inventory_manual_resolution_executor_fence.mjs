#!/usr/bin/env node

import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

import {
  appendDurableJournalRecord,
  appendManualResolutionRecord,
  buildManualResolutionEntry,
  inventoryIntentHash,
  inventoryRecoveryScopeKey,
  inventoryWriteScopeKey,
  inventoryLogicalActionKey,
  readInventoryIntentJournals,
  validateManualResolutionEntry,
  INVENTORY_EXACT_WAREHOUSE_WRITE_PROFILE,
} from '../lib/durable_inventory_write.mjs';
import {
  buildDailyInventoryPlanHashPayload,
  computeInventoryOverwriteQuantity,
  INVENTORY_OVERWRITE_COMPUTATION_VERSION,
  INVENTORY_LEGACY_LOCKED_ONLY_COMPUTATION_VERSION,
  stableInventoryHash,
} from '../lib/inventory_replenishment_policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXECUTOR = path.join(ROOT, 'scripts', 'inventory', 'execute_daily_inventory_replenishment_plan.mjs');
const POLICY_FILE = path.join(ROOT, 'config', 'inventory_replenishment_policy.json');
const policy = JSON.parse(await fs.readFile(POLICY_FILE, 'utf8'));
const today = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date());
const now = new Date().toISOString();
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'inventory-manual-resolution-executor-fence-')));
const planFile = path.join(temp, 'plan.json');
const intentRunDate = '2026-08-17';
const resultFile = path.join(temp, `daily-inventory-replenishment-${intentRunDate}.json`);
const journalFile = `${resultFile}.journal.ndjson`;
const configFile = path.join(temp, 'config.json');
const biFile = path.join(temp, 'bi.json');
const linksFile = path.join(temp, 'links.json');
const lockDir = path.join(temp, 'locks');
const scope = {
  storeKey: 'XL',
  skc: 'sb260606205087254179320',
  skuCode: 'I0mq2cw2khzt47',
  warehouseCode: 'PS0916742261',
  invType: 'VI',
};
const canonical = 'SK-3065蒸汽熨烫机';
const authorizationId = 'owner-automatic-inventory-20260803-v1';

const row = {
  storeKey: scope.storeKey,
  spu: 'fixture-xl-spu',
  skc: scope.skc,
  skuCode: scope.skuCode,
  canonical,
  supplierCode: canonical,
  matchKey: 'SK-GT-3065蒸汽熨烫机',
  ruleClass: 'legacy_virtual_inventory_top_up',
  targetUsableInventory: 100,
  etSellableInventory: 200,
  shelfStatusCode: '1',
  shelfStatusName: '已上架',
  openApiShelfStatusCode: '1',
  c7SaleCount: 0,
  c7Exposure: 0,
  sameStoreOnShelfSkcs: [],
};
const planBody = {
  schemaVersion: 'daily-inventory-replenishment-plan/v1',
  date: today,
  policyVersion: policy.policyVersion,
  generatedAt: now,
  executable: true,
  blockers: [],
  actionable: [row],
  sourceEvidence: [],
  lowEtAllocations: [],
  detailRefreshTargets: [],
};
const planHash = stableInventoryHash(buildDailyInventoryPlanHashPayload(planBody));
const plan = {...planBody, payloadHash: planHash};
const writeJson = async (file, value) => {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};
const hashFile = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');

await writeJson(planFile, plan);
await writeJson(configFile, {
  apiBaseUrls: {prodSemiManaged: 'http://127.0.0.1:1'},
  stores: [{storeKey: scope.storeKey, enabled: true, openKeyId: 'focused-open-key', secretKey: 'focused-secret'}],
});
await writeJson(biFile, {
  generatedAt: now,
  inventoryDepletion: {
    products: [{
      standard_goods_sn: canonical,
      match_key: 'SK-GT-3065蒸汽熨烫机',
      current_sellable_quantity: 200,
      available_stock: 500,
      et_store_snapshot_date: today,
      inventory_match_status: 'matched',
      et_operational_stock_policy: '',
    }],
  },
});
await writeJson(linksFile, {
  generatedAt: now,
  links: [{
    store_key: scope.storeKey,
    skc: scope.skc,
    raw_goods_sn: canonical,
    standard_goods_sn: canonical,
    is_on_shelf: true,
    shelf_status_name: '已上架',
    visible_shelf_statuses: 'ON_SHELF',
    c7_sale_cnt: 0,
    c7_eps_uv: 0,
  }],
});

const logicalActionKey = stableInventoryHash({
  runDate: intentRunDate,
  store: scope.storeKey,
  skc: scope.skc,
  sku: scope.skuCode,
  target: 100,
  actionType: 'VI_OVERWRITE_TO_EXACT_USABLE_TARGET',
  policyVersion: policy.policyVersion,
  authorizationId,
});
const before = {
  totalInventoryQuantity: 74,
  totalUsableInventory: 49,
  totalLockedQuantity: 1,
  stockRowMissing: false,
};
const request = {
  pathname: '/open-api/stock/change-inventory/v2',
  method: 'POST',
  body: {
    updateSkuInventoryQuantityRequests: [{
      idempotencyKey: `bi-inv-${logicalActionKey.slice(0, 42)}`,
      skuCode: scope.skuCode,
      invType: 'VI',
      changeType: 'OVERWRITE',
      changeQuantity: computeInventoryOverwriteQuantity(100, before, INVENTORY_LEGACY_LOCKED_ONLY_COMPUTATION_VERSION),
      changeReason: 'Owner-authorized daily inventory target after current-day ET and sales/exposure guard',
    }],
  },
  headers: {language: 'en'},
};
const intent = {
  kind: 'intent',
  intentId: 'e07f999c-96b2-460c-bfa9-fa924f410ec3',
  logicalActionKey,
  recoveryScopeKey: inventoryRecoveryScopeKey(scope),
  planHash,
  runDate: intentRunDate,
  ...scope,
  targetUsableInventory: 100,
  policyVersion: policy.policyVersion,
  overwriteComputationVersion: INVENTORY_LEGACY_LOCKED_ONLY_COMPUTATION_VERSION,
  authorizationId,
  idempotencyKey: request.body.updateSkuInventoryQuantityRequests[0].idempotencyKey,
  requestPayloadHash: stableInventoryHash(request),
  request,
  before,
  recordedAt: '2026-08-17T08:00:00.000Z',
};
await appendDurableJournalRecord(journalFile, intent);
const initialJournalBytes = await fs.readFile(journalFile);
const initialJournalHash = createHash('sha256').update(initialJournalBytes).digest('hex');
const scopeKey = inventoryWriteScopeKey(scope);
const liveInventoryBaseline = {
  source: 'focused-executor-fence-live-baseline',
  capturedAt: now,
  scope: {...scope, scopeKey},
  totalInventoryQuantity: 50,
  totalUsableInventory: 49,
  totalLockedQuantity: 1,
  temporaryInventoryQuantity: 0,
};
const productionBaseline = {
  activationHash: '3'.repeat(64),
  activationReceiptHash: '4'.repeat(64),
  source: 'focused-executor-fence-production-baseline',
  capturedAt: now,
  deployedCommit: '5cc31c12476bceed5e670dc49a04e274c976f98e',
  trackedSourceClean: true,
  sourceFingerprint: '5'.repeat(64),
  releaseReceiptKind: 'emergency',
  releaseReceiptHash: '6'.repeat(64),
  bundleSha256: '7'.repeat(64),
  maintenanceGeneration: 10,
  maintenanceHash: '8'.repeat(64),
  maintenanceActive: true,
  maintenanceMode: 'all',
  writerServicesHash: '9'.repeat(64),
};
const artifact = (name, sha, payloadHash, traceId) => ({
  bytes: 1,
  capturedAt: now,
  code: '0',
  msg: 'OK',
  path: path.join(temp, name),
  payloadHash,
  scope: {...scope, scopeKey},
  sha256: sha,
  temporaryInventoryQuantity: 0,
  totalInventoryQuantity: 50,
  totalLockedQuantity: 1,
  totalUsableInventory: 49,
  traceId,
});
const event = buildManualResolutionEntry({
  resolutionId: randomUUID(),
  intent,
  journalFile,
  journalFileSha256: initialJournalHash,
  globalJournalSha256: stableInventoryHash([{file: journalFile, bytes: initialJournalBytes.length, sha256: initialJournalHash}]),
  planFile,
  planFileSha256: await hashFile(planFile),
  scope,
  ageSeconds: Math.floor((Date.parse(now) - Date.parse(intent.recordedAt)) / 1000),
  productionBaseline,
  liveInventoryBaseline,
  ownerConfirmation: {
    actor: 'owner-20260826',
    confirmed: true,
    statement: 'MANUAL_BASELINE_ADOPTED_EFFECT_UNKNOWN',
  },
  readbackArtifacts: [
    artifact('r1.json', '1'.repeat(64), '2'.repeat(64), 'r1-trace'),
    artifact('r2.json', '3'.repeat(64), '4'.repeat(64), 'r2-trace'),
  ],
  originalResponse: {code: '0', traceId: 'original-write-trace'},
  recordedAt: now,
});
validateManualResolutionEntry(event, intent, {journalFile, lineNumber: 2});
await appendManualResolutionRecord(journalFile, event);

let server;
const requests = [];
let liveStockUsable = 10;
let liveStockLocked = 1;
const postChangeRequests = [];

const port = await new Promise((resolve, reject) => {
  server = http.createServer((requestMessage, response) => {
    const chunks = [];
    requestMessage.on('data', chunk => chunks.push(chunk));
    requestMessage.on('end', () => {
      const pathname = new URL(requestMessage.url, 'http://127.0.0.1').pathname;
      requests.push({method: requestMessage.method, pathname});

      const sendJson = (status, data) => {
        response.writeHead(status, {'content-type': 'application/json'});
        response.end(JSON.stringify(data));
      };

      if (pathname === '/open-api/openapi-business-backend/query-store-info') {
        return sendJson(200, {code: '0', info: {accountNo: 'GS9307061', merchantId: '6716329', companyName: '夏莲', shopName: 'XL'}});
      }
      if (pathname === '/open-api/goods/spu-info') {
        return sendJson(200, {
          code: '0',
          info: {
            supplierCode: canonical,
            skcInfoList: [{
              skcName: scope.skc,
              shelfStatusInfoList: [{siteAbbr: 'shein-sa', shelfStatus: '1'}],
              skuInfoList: [{skuCode: scope.skuCode}],
            }],
          },
        });
      }
      if (pathname === '/open-api/stock/stock-query') {
        const total = liveStockUsable + liveStockLocked;
        return sendJson(200, {
          code: '0',
          info: [{
            goodsInventory: [{
              skuList: [{
                skuCode: scope.skuCode,
                totalInventoryQuantity: total,
                totalUsableInventory: liveStockUsable,
                totalLockedQuantity: liveStockLocked,
                temporaryInventoryQuantity: 0,
                warehouseInventoryList: [{
                  warehouseCode: scope.warehouseCode,
                  totalInventoryQuantity: total,
                  totalUsableInventory: liveStockUsable,
                  totalLockedQuantity: liveStockLocked,
                  temporaryInventoryQuantity: 0,
                }],
              }],
            }],
          }],
        });
      }
      if (pathname === '/open-api/stock/change-inventory/v2') {
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        postChangeRequests.push(body);
        liveStockUsable = 100; // updated after POST
        return sendJson(200, {code: '0', msg: 'OK', info: {}});
      }

      sendJson(200, {code: '0', info: {}});
    });
  });
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

const configured = JSON.parse(await fs.readFile(configFile, 'utf8'));
configured.apiBaseUrls.prodSemiManaged = `http://127.0.0.1:${port}`;
await writeJson(configFile, configured);

function runExecutor(args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      EXECUTOR,
      ...args,
    ], {
      cwd: ROOT,
      env: {
        ...process.env,
        SHEIN_BI_INVENTORY_AUTOMATION_CONTEXT: 'cloud_daily_inventory_replenishment_guard',
        SHEIN_BI_INVENTORY_AUTOMATION_AUTHORIZATION: authorizationId,
        SHEIN_BI_INVENTORY_JOURNAL_DIRS: '',
        SHEIN_BI_INVENTORY_SKU_LOCK_DIR: lockDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({code, stdout, stderr}));
  });
}

try {
  // ----------------------------------------------------
  // PHASE 1: Legacy Plan Without Command ID -> Blocked by Manual Fence
  // ----------------------------------------------------
  const run1 = await runExecutor([
    '--plan', planFile,
    '--policy', POLICY_FILE,
    '--config', configFile,
    '--bi-data', biFile,
    '--links-data', linksFile,
    '--out', resultFile,
    '--execute',
    '--execution-mode', 'automatic',
    '--confirm-hash', planHash,
    '--reconcile-pending-only',
  ]);
  assert.equal(run1.code, 1, `fenced reappearing plan must exit blocked: ${run1.stderr}`);
  assert.equal(requests.length, 0, `manual-resolution fence must prevent all OpenAPI calls: ${JSON.stringify(requests)}`);
  const result1 = JSON.parse(await fs.readFile(resultFile, 'utf8').catch(error => {
    throw new Error(`executor did not publish a result: ${error.message}; stdout=${run1.stdout}; stderr=${run1.stderr}`);
  }));
  assert.equal(result1.results.length, 1);
  assert.equal(result1.results[0].state, 'blocked_by_manual_resolution_fence');
  assert.equal(result1.manualResolutionFences.length, 1);
  assert.equal(result1.manualResolutionFences[0].intentId, intent.intentId);
  assert.equal(result1.manualResolutionTombstoneCount, 1);
  const lifecycle1 = await readInventoryIntentJournals([journalFile], {maxRunDate: today, allowMultiplePendingByScope: true});
  assert.equal(lifecycle1.manualResolutions.size, 1);
  assert.equal(lifecycle1.fences.size, 1);
  assert.equal(lifecycle1.tombstonedIdempotencyKeys.size, 1);
  assert.equal(lifecycle1.terminalOutcomes.size, 0);

  // ----------------------------------------------------
  // PHASE 2: New Command + Exact Warehouse Baseline Adoption -> Mock POST & Exact Readback
  // ----------------------------------------------------
  const newCommandId = 'cmd-daily-exact-20260905-001';
  const newPlanBody = {
    schemaVersion: 'daily-inventory-replenishment-plan/v1',
    commandId: newCommandId,
    date: today,
    policyVersion: policy.policyVersion,
    generatedAt: new Date().toISOString(),
    executable: true,
    blockers: [],
    actionable: [row],
    sourceEvidence: [],
    lowEtAllocations: [],
    detailRefreshTargets: [],
  };
  const newPlanHash = stableInventoryHash(buildDailyInventoryPlanHashPayload(newPlanBody));
  const newPlan = {...newPlanBody, payloadHash: newPlanHash};
  const newPlanFile = path.join(temp, 'new_plan.json');
  const newResultFile = path.join(temp, `daily-inventory-replenishment-${today}.json`);
  const newJournalFile = `${newResultFile}.journal.ndjson`;
  await writeJson(newPlanFile, newPlan);

  const run2 = await runExecutor([
    '--plan', newPlanFile,
    '--policy', POLICY_FILE,
    '--config', configFile,
    '--bi-data', biFile,
    '--links-data', linksFile,
    '--out', newResultFile,
    '--execute',
    '--execution-mode', 'automatic',
    '--confirm-hash', newPlanHash,
    '--command-id', newCommandId,
  ]);
  assert.equal(run2.code, 0, `new command execution must succeed: stderr=${run2.stderr} stdout=${run2.stdout}`);
  assert.equal(postChangeRequests.length, 1, 'exact warehouse execution must issue exactly one change-inventory POST');

  const postedRequest = postChangeRequests[0];
  const updateReq = postedRequest?.updateSkuInventoryQuantityRequests?.[0];
  assert.ok(updateReq, 'POST body must contain updateSkuInventoryQuantityRequests[0]');
  assert.equal(updateReq.skuCode, scope.skuCode);
  assert.equal(updateReq.invType, 'VI');
  assert.equal(updateReq.changeType, 'OVERWRITE');
  assert.equal(updateReq.warehouseCode, scope.warehouseCode);
  assert.equal(updateReq.changeQuantity, 101); // 100 target + 1 locked = 101

  const result2 = JSON.parse(await fs.readFile(newResultFile, 'utf8'));
  assert.equal(result2.commandId, newCommandId);
  assert.equal(result2.results.length, 1);
  assert.equal(result2.results[0].state, 'updated_readback_matched');
  assert.equal(result2.results[0].after?.totalUsableInventory, 100);

  // Verify journal records: baseline_adoption, active intent, write_outcome, and original tombstone
  const lifecycle2 = await readInventoryIntentJournals([journalFile, newJournalFile], {maxRunDate: today, allowMultiplePendingByScope: true});
  assert.ok(lifecycle2.baselineAdoptions?.size >= 1, 'baseline_adoption record must be registered');
  const adoption = [...lifecycle2.baselineAdoptions.values()][0];
  assert.equal(adoption.commandId, newCommandId);
  assert.equal(adoption.scope?.warehouseCode, scope.warehouseCode);

  const adoptedIntent = [...lifecycle2.intents.values()].find(i => i.commandId === newCommandId);
  assert.ok(adoptedIntent, 'new intent with commandId must be registered in journal');
  assert.equal(adoptedIntent.inventoryWriteProfile, INVENTORY_EXACT_WAREHOUSE_WRITE_PROFILE);
  assert.equal(adoptedIntent.warehouseCode, scope.warehouseCode);

  const outcome = [...lifecycle2.terminalOutcomes.values()].find(o => o.intentId === adoptedIntent.intentId);
  assert.ok(outcome, 'write_outcome must be registered for new intent');
  assert.equal(outcome.disposition, 'readback_matched');

  // Original intent stays tombstoned and effect unknown
  assert.ok(lifecycle2.tombstonedIdempotencyKeys.has(intent.idempotencyKey), 'original idempotencyKey must remain tombstoned');

  // ----------------------------------------------------
  // PHASE 3: Same Command Rerun -> 0 New POSTs
  // ----------------------------------------------------
  const run3 = await runExecutor([
    '--plan', newPlanFile,
    '--policy', POLICY_FILE,
    '--config', configFile,
    '--bi-data', biFile,
    '--links-data', linksFile,
    '--out', newResultFile,
    '--execute',
    '--execution-mode', 'automatic',
    '--confirm-hash', newPlanHash,
    '--command-id', newCommandId,
  ]);
  assert.equal(run3.code, 0, `rerun of same command must succeed: stderr=${run3.stderr}`);
  assert.equal(postChangeRequests.length, 1, 'same command rerun must not issue any additional POSTs (0 new POSTs)');
  const result3 = JSON.parse(await fs.readFile(newResultFile, 'utf8'));
  assert.equal(result3.results[0].state, 'skipped_target_already_matched');

  // ----------------------------------------------------
  // PHASE 4: Conflicting Outstanding Pending Intent -> Blocks Baseline Adoption
  // ----------------------------------------------------
  const conflictingCmdId = 'cmd-conflicting-20260905-002';
  const conflictingPlanBody = {
    ...newPlanBody,
    commandId: conflictingCmdId,
    actionable: [row],
  };
  const conflictingPlanHash = stableInventoryHash(buildDailyInventoryPlanHashPayload(conflictingPlanBody));
  const conflictingPlan = {...conflictingPlanBody, payloadHash: conflictingPlanHash};
  const conflictingPlanFile = path.join(temp, 'conflicting_plan.json');
  await writeJson(conflictingPlanFile, conflictingPlan);

  liveStockUsable = 10; // drop live stock below target to trigger pending readback fence
  // Append a valid unresolved pending intent for today to today's journal
  const pendingLogicalActionKey = inventoryLogicalActionKey({
    commandId: conflictingCmdId,
    runDate: today,
    storeKey: scope.storeKey,
    skc: scope.skc,
    skuCode: scope.skuCode,
    targetUsableInventory: 100,
    policyVersion: policy.policyVersion,
    authorizationId,
  });
  const pendingIdempotencyKey = `bi-inv-${pendingLogicalActionKey.slice(0, 42)}`;
  const pendingRequest = {
    pathname: '/open-api/stock/change-inventory/v2',
    method: 'POST',
    body: {
      updateSkuInventoryQuantityRequests: [{
        idempotencyKey: pendingIdempotencyKey,
        skuCode: scope.skuCode,
        invType: 'VI',
        changeType: 'OVERWRITE',
        changeQuantity: 101,
        changeReason: 'Owner-authorized daily inventory target after current-day ET and sales/exposure guard',
      }],
    },
    headers: {language: 'en'},
  };
  const pendingBefore = {
    totalInventoryQuantity: 50,
    totalUsableInventory: 49,
    totalLockedQuantity: 1,
    temporaryInventoryQuantity: 0,
    stockRowMissing: false,
  };
  const pendingIntent = {
    kind: 'intent',
    intentId: randomUUID(),
    commandId: conflictingCmdId,
    logicalActionKey: pendingLogicalActionKey,
    recoveryScopeKey: inventoryRecoveryScopeKey(scope),
    planHash: conflictingPlanHash,
    runDate: today,
    ...scope,
    targetUsableInventory: 100,
    policyVersion: policy.policyVersion,
    overwriteComputationVersion: INVENTORY_OVERWRITE_COMPUTATION_VERSION,
    authorizationId,
    idempotencyKey: pendingIdempotencyKey,
    requestPayloadHash: stableInventoryHash(pendingRequest),
    request: pendingRequest,
    before: pendingBefore,
    recordedAt: new Date().toISOString(),
  };
  await appendDurableJournalRecord(newJournalFile, pendingIntent);

  const run4 = await runExecutor([
    '--plan', conflictingPlanFile,
    '--policy', POLICY_FILE,
    '--config', configFile,
    '--bi-data', biFile,
    '--links-data', linksFile,
    '--out', newResultFile,
    '--execute',
    '--execution-mode', 'automatic',
    '--confirm-hash', conflictingPlanHash,
    '--command-id', conflictingCmdId,
  ]);
  assert.equal(run4.code, 1, 'executor must exit non-zero when conflicting pending intent exists on scope');
  const result4 = JSON.parse(await fs.readFile(newResultFile, 'utf8'));
  assert.equal(result4.results[0].state, 'submitted_but_readback_pending');
  assert.match(result4.results[0].error, /durable pre-submit intent exists and exact target is not visible/);

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'reappearing_xl_plan_is_blocked_by_permanent_fence',
      'executor_records_manual_resolution_fence_report',
      'reappearing_plan_makes_zero_openapi_calls',
      'manual_resolution_never_becomes_write_outcome',
      'new_command_with_exact_warehouse_adopts_baseline',
      'exact_warehouse_write_profile_executes_mock_post',
      'readback_matched_outcome_recorded_with_exact_stock',
      'same_command_rerun_issues_zero_new_posts',
      'outstanding_pending_intent_strictly_blocks_baseline_adoption',
    ],
  }, null, 2));
} finally {
  await new Promise(resolve => server.close(() => resolve()));
  await fs.rm(temp, {recursive: true, force: true});
}
