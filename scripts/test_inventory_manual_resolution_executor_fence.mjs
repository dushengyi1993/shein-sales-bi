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
  readInventoryIntentJournals,
  validateManualResolutionEntry,
} from '../lib/durable_inventory_write.mjs';
import {
  buildDailyInventoryPlanHashPayload,
  computeInventoryOverwriteQuantity,
  INVENTORY_OVERWRITE_COMPUTATION_VERSION,
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
const resultFile = path.join(temp, 'result.json');
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
const intentRunDate = '2026-08-17';

const row = {
  storeKey: scope.storeKey,
  spu: 'fixture-xl-spu',
  skc: scope.skc,
  skuCode: scope.skuCode,
  canonical,
  supplierCode: canonical,
  matchKey: canonical,
  ruleClass: 'legacy_virtual_inventory_top_up',
  targetUsableInventory: 100,
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
await writeJson(biFile, {});
await writeJson(linksFile, {});

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
      changeQuantity: computeInventoryOverwriteQuantity(100, before),
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
  overwriteComputationVersion: INVENTORY_OVERWRITE_COMPUTATION_VERSION,
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
const port = await new Promise((resolve, reject) => {
  server = http.createServer((requestMessage, response) => {
    requests.push({method: requestMessage.method, pathname: new URL(requestMessage.url, 'http://127.0.0.1').pathname});
    response.writeHead(200, {'content-type': 'application/json'});
    response.end('{"code":"0","info":{}}');
  });
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const configured = JSON.parse(await fs.readFile(configFile, 'utf8'));
configured.apiBaseUrls.prodSemiManaged = `http://127.0.0.1:${port}`;
await writeJson(configFile, configured);

function runExecutor() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      EXECUTOR,
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
  const run = await runExecutor();
  assert.equal(run.code, 1, `fenced reappearing plan must exit blocked: ${run.stderr}`);
  assert.equal(requests.length, 0, `manual-resolution fence must prevent all OpenAPI calls: ${JSON.stringify(requests)}`);
  const result = JSON.parse(await fs.readFile(resultFile, 'utf8').catch(error => {
    throw new Error(`executor did not publish a result: ${error.message}; stdout=${run.stdout}; stderr=${run.stderr}`);
  }));
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].state, 'blocked_by_manual_resolution_fence');
  assert.equal(result.manualResolutionFences.length, 1);
  assert.equal(result.manualResolutionFences[0].intentId, intent.intentId);
  assert.equal(result.manualResolutionTombstoneCount, 1);
  const lifecycle = await readInventoryIntentJournals([journalFile], {maxRunDate: today, allowMultiplePendingByScope: true});
  assert.equal(lifecycle.manualResolutions.size, 1);
  assert.equal(lifecycle.fences.size, 1);
  assert.equal(lifecycle.tombstonedIdempotencyKeys.size, 1);
  assert.equal(lifecycle.terminalOutcomes.size, 0);
  console.log(JSON.stringify({
    ok: true,
    checks: [
      'reappearing_xl_plan_is_blocked_by_permanent_fence',
      'executor_records_manual_resolution_fence_report',
      'reappearing_plan_makes_zero_openapi_calls',
      'manual_resolution_never_becomes_write_outcome',
    ],
  }, null, 2));
} finally {
  await new Promise(resolve => server.close(() => resolve()));
}
