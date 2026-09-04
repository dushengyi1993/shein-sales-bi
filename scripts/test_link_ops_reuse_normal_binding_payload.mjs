#!/usr/bin/env node
/**
 * Focused contract test for link ops reuse-approved-binding on normal 14-asset binding.
 *
 * Proves:
 *   1. Normal 14-asset binding (sourceApproved=true, authority=human_reviewed_source,
 *      14 roles: mainCover/carouselSecondCover/10 detail/squareImage/skuImage,
 *      bindingFingerprint correct, evidence without recoveredFromAudit).
 *   2. Complete openapiPublishPayload and preparation present.
 *   3. Lifecycle publish_pre_valid_failed with one strict, attributable execute rejection:
 *      submitted/actualWriteSubmitted=false and issuedExecuteToExecutor/sheinWriteAttempted=true.
 *   4. POST /api/link-ops-publish-assets with reuseApprovedBinding=true, bindings=[],
 *      sourceApproved=true, and supplierSku correction value:
 *      - returns HTTP 200 / ok: true
 *      - binding still has all 14 images
 *      - new supplierSku projection takes effect in openapiPublishPayload
 *      - old preflight is invalidated (needs_repreflight)
 *      - CAS revision increments
 *      - zero OpenAPI capture executor, upload-pic, or execute calls are made
 *      - zero new tasks are created
 *   5. Metadata, payload/bodyHash, actual-write, unknown-result, and stored payloadHash drift fail closed.
 *   6. A clean historical binding without payloadHash retains the old capture/fail-closed path.
 */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {provisionBiSessionSecret} from './provision_bi_session_secret.mjs';
import {normalizePublishPreparationOverrides} from '../lib/link_ops_publish_asset_binding.mjs';
import {canonicalRecoveredPublishPayloadHash} from '../lib/link_ops_uploaded_asset_binding_recovery.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = process.platform === 'win32' ? path.join(ROOT, 'tmp') : '/tmp';
await fs.mkdir(tmpBase, {recursive: true});
const tmpRoot = await fs.mkdtemp(path.join(tmpBase, 'test-reuse-normal-'));
if (process.platform !== 'win32') await fs.chmod(tmpRoot, 0o700);

const auditFile = path.join(tmpRoot, 'audit.jsonl');
const taskFile = path.join(tmpRoot, 'tasks.json');
const sessionFile = path.join(tmpRoot, 'session.json');
const authFile = path.join(tmpRoot, 'auth.json');
const accessRolesFile = path.join(tmpRoot, 'access_roles.json');
const sessionSecretFile = path.join(tmpRoot, 'session_secret');
const portalDir = path.join(tmpRoot, 'portal');
const knowledgeCacheDir = path.join(tmpRoot, 'knowledge-cache');
const requireFromTest = createRequire(import.meta.url);
const sharedPgEntryPath = requireFromTest.resolve('pg');
const sharedPgEntryUrl = pathToFileURL(sharedPgEntryPath).href;
const pgLoaderFile = path.join(tmpRoot, 'pg-loader.mjs');
const executorProbeFile = path.join(tmpRoot, 'executor-probe.log');

await fs.mkdir(portalDir, {recursive: true});
await fs.writeFile(pgLoaderFile, [
  'import fs from \'node:fs\';',
  'const executorProbeFile = ' + JSON.stringify(executorProbeFile) + ';',
  'export async function resolve(specifier, context, nextResolve) {',
  '  if (specifier === \'pg\') {',
  '    return {url: ' + JSON.stringify(sharedPgEntryUrl) + ', shortCircuit: true};',
  '  }',
  '  return nextResolve(specifier, context);',
  '}',
  'export async function load(url, context, nextLoad) {',
  '  if (url.includes(\'/scripts/link_ops_hl_openapi_executor.mjs\')) {',
  '    fs.appendFileSync(executorProbeFile, url + \'\\n\');',
  '  }',
  '  return nextLoad(url, context);',
  '}',
  '',
].join('\n'), 'utf8');
await fs.writeFile(path.join(portalDir, 'index.html'), '<!doctype html><html><body>test</body></html>', 'utf8');

await provisionBiSessionSecret(sessionSecretFile);

await fs.writeFile(authFile, JSON.stringify({
  users: [{
    username: 'operator_test',
    password: 'test-password',
    displayName: 'Operator Test',
    role: 'owner',
    readStores: ['*'],
    writeStores: ['*'],
    ownerKey: 'OWNER_TEST',
  }],
}, null, 2), 'utf8');

await fs.writeFile(accessRolesFile, JSON.stringify({
  defaults: {
    owner: {readStores: ['*'], writeStores: ['*']},
    operator: {readStores: ['*'], writeStores: ['*']},
  },
}, null, 2), 'utf8');

function sha256StableJson(obj) {
  function normalize(val) {
    if (val === null || typeof val !== 'object') return val;
    if (Array.isArray(val)) return val.map(normalize);
    const keys = Object.keys(val).sort();
    const res = {};
    for (const k of keys) res[k] = normalize(val[k]);
    return res;
  }
  return crypto.createHash('sha256').update(JSON.stringify(normalize(obj))).digest('hex');
}

function canonicalPublishAssetBindingImages(images) {
  return (images || []).map(row => ({
    name: String(row?.name || '').normalize('NFKC').trim(),
    role: String(row?.role || '').normalize('NFKC').trim(),
    imageType: Number(row?.imageType ?? row?.image_type ?? 0),
    imageUrl: String(row?.imageUrl || row?.image_url || '').trim(),
    sha256: String(row?.sha256 || '').trim().toLowerCase(),
  }));
}

function canonicalPublishAssetBindingFingerprint(task, {
  binding = task?.publishAssetBinding,
  images = binding?.images,
  targetStore = binding?.targetStore,
  publishPreparation = task?.publishPreparation || task?.targets?.publishPreparation || {},
} = {}) {
  const canonical = {
    targetStore: String(targetStore || '').trim().toUpperCase(),
    bindings: canonicalPublishAssetBindingImages(images),
    publishPreparation: normalizePublishPreparationOverrides(publishPreparation),
  };
  return sha256StableJson(canonical);
}

const STORE = 'HL';
const SOURCE_STORE = 'CX';
const SOURCE_SKC = 'sv25082902871830770';
const STANDARD_GOODS_SN = 'SM-961-REUSE-NORMAL';
const RELEASE_ID = 'rel-reuse-v4-normal-test';

const images14 = [
  {name: '01-main.jpg', role: 'mainCover', imageType: 1, imageUrl: 'https://img.shein.com/1.jpg', sha256: 'a'.repeat(64), width: 900, height: 1200},
  {name: '02-carousel.jpg', role: 'carouselSecondCover', imageType: 1, imageUrl: 'https://img.shein.com/2.jpg', sha256: 'b'.repeat(64), width: 900, height: 1200},
  ...Array.from({length: 10}, (_, i) => ({
    name: 'detail-' + (i + 1) + '.jpg',
    role: 'detail',
    imageType: 2,
    imageUrl: 'https://img.shein.com/d' + (i + 1) + '.jpg',
    sha256: crypto.createHash('sha256').update('detail-14-' + i).digest('hex'),
    width: 900,
    height: 1200,
  })),
  {name: '13-square.jpg', role: 'squareImage', imageType: 5, imageUrl: 'https://img.shein.com/sq.jpg', sha256: 'c'.repeat(64), width: 1200, height: 1200},
  {name: '14-sku.jpg', role: 'skuImage', imageType: 1, imageUrl: 'https://img.shein.com/sku.jpg', sha256: 'd'.repeat(64), width: 900, height: 1200},
];

const initialPreparation = {
  targetStore: STORE,
  standardGoodsSn: STANDARD_GOODS_SN,
  supplierSku: 'OLD-SUPPLIER-SKU-ORIGINAL',
  supplyPrice: '172.22',
  inventory: 100,
  titles: {ar: 'old ar title', en: 'old en title'},
  attributeOverrides: [],
};

const initialBindingFingerprint = canonicalPublishAssetBindingFingerprint(null, {
  targetStore: STORE,
  images: images14,
  publishPreparation: initialPreparation,
});

const openapiPayload14 = {
  product_type_id: 9851,
  category_id: 1,
  multi_language_name_list: [{language: 'ar', name: 'old ar title'}, {language: 'en', name: 'old en title'}],
  skc_list: [
    {
      supplier_code: STANDARD_GOODS_SN,
      image_info: {
        image_info_list: [
          {image_type: 1, image_url: 'https://img.shein.com/1.jpg'},
          ...Array.from({length: 10}, (_, i) => ({
            image_type: 2,
            image_url: 'https://img.shein.com/d' + (i + 1) + '.jpg',
          })),
          {image_type: 5, image_url: 'https://img.shein.com/sq.jpg'},
        ],
      },
      sku_list: [
        {
          supplier_sku: 'OLD-SUPPLIER-SKU-ORIGINAL',
          image_info: {
            image_info_list: [{image_type: 1, image_url: 'https://img.shein.com/sku.jpg'}],
          },
          cost_info: {currency: 'SAR', cost_price: '172.22'},
          stock_info_list: [{warehouse_id: 'WH-1', stock: 100}],
        },
      ],
    },
  ],
};

const initialPayloadHash = canonicalRecoveredPublishPayloadHash(openapiPayload14);
const REJECTED_RUN_ID = 'run-hl-explicit-prevalid-rejection-001';
const rejectedReadback = {
  status: 'planned_not_run',
  pendingReview: false,
  ok: false,
  matchedCount: 0,
  scannedRows: 0,
  calls: [],
};
const rejectedExecutorRun = {
  runId: REJECTED_RUN_ID,
  storeKey: STORE,
  mode: 'execute',
  state: 'publish_pre_valid_failed',
  submitted: false,
  actualWriteSubmitted: false,
  issuedExecuteToExecutor: true,
  sheinWriteAttempted: true,
  payload: {bodyHash: initialPayloadHash},
  publishResult: {
    code: 0,
    info: {
      success: false,
      pre_valid_result: [{error_code: 'PRE_VALID_REJECTED', error_msg: 'fixture rejection'}],
    },
  },
  readback: structuredClone(rejectedReadback),
};
const rejectedExecutorProjection = {
  runId: REJECTED_RUN_ID,
  storeKey: STORE,
  mode: 'execute',
  state: 'publish_pre_valid_failed',
  submitted: false,
  actualWriteSubmitted: false,
  issuedExecuteToExecutor: true,
  sheinWriteAttempted: true,
  payload: {bodyHash: initialPayloadHash},
  publishResult: {code: 0, explicitSuccess: false},
  readback: structuredClone(rejectedReadback),
};

const normalReuseTask = {
  id: 'task-normal-reuse-001',
  storeKey: STORE,
  sourceStore: SOURCE_STORE,
  sourceSkc: SOURCE_SKC,
  standardGoodsSn: STANDARD_GOODS_SN,
  repositoryRevision: 20,
  releaseId: RELEASE_ID,
  intents: ['copy_product_draft'],
  writeStores: [STORE],
  stores: [STORE],
  submitted: false,
  actualWriteSubmitted: false,
  issuedExecuteToExecutor: true,
  sheinWriteAttempted: true,
  publishResult: null,
  publishPreparation: structuredClone(initialPreparation),
  targets: {
    publishPreparation: structuredClone(initialPreparation),
  },
  assets: [],
  publishAssetBinding: {
    schemaVersion: 1,
    sourceApproved: true,
    authority: 'human_reviewed_source',
    targetStore: STORE,
    boundAt: '2026-09-02T00:00:00.000Z',
    boundByUser: 'operator_test',
    bindingFingerprint: initialBindingFingerprint,
    imageCount: 14,
    images: structuredClone(images14),
    evidence: {
      sourceApproved: true,
      boundImageCount: 14,
      // Historical ordinary binding: intentionally no payloadHash/recoveredFromAudit.
    },
    publishPreparation: structuredClone(initialPreparation),
  },
  openapiPublishPayload: structuredClone(openapiPayload14),
  lifecycle: {
    status: 'publish_pre_valid_failed',
  },
  execution: {
    state: 'publish_pre_valid_failed',
    submitted: false,
    actualWriteSubmitted: false,
    issuedExecuteToExecutor: true,
    sheinWriteAttempted: true,
    publishResult: null,
    openApiProductExecutors: [structuredClone(rejectedExecutorRun)],
    hlOpenApiExecutor: structuredClone(rejectedExecutorProjection),
    preflight: {
      ok: false,
      blockers: ['Previous preflight failed on attribute check'],
      warnings: [],
    },
    writeAudit: {
      submitted: false,
      actualWriteSubmitted: false,
      issuedExecuteToExecutor: true,
      sheinWriteAttempted: true,
      executorEvidence: [structuredClone(rejectedExecutorProjection)],
    },
  },
};

const metadataDriftTask = {
  ...structuredClone(normalReuseTask),
  id: 'task-metadata-drift-001',
  publishAssetBinding: {
    ...structuredClone(normalReuseTask.publishAssetBinding),
    bindingFingerprint: 'drifted-fingerprint-000000000000000000000000000000000000000000000000',
  },
};

const payloadBodyHashDriftTask = {
  ...structuredClone(normalReuseTask),
  id: 'task-payload-bodyhash-drift-001',
};
payloadBodyHashDriftTask.openapiPublishPayload.skc_list[0].supplier_code = 'SM-961-PAYLOAD-DRIFT';

const actualWriteSubmittedTask = {
  ...structuredClone(normalReuseTask),
  id: 'task-actual-write-submitted-001',
};
actualWriteSubmittedTask.actualWriteSubmitted = true;
actualWriteSubmittedTask.execution.actualWriteSubmitted = true;
actualWriteSubmittedTask.execution.writeAudit.actualWriteSubmitted = true;

const unknownWriteResultTask = {
  ...structuredClone(normalReuseTask),
  id: 'task-unknown-write-result-001',
};
unknownWriteResultTask.execution.openApiProductExecutors[0].publishResult = {
  code: 0,
  info: {pre_valid_result: [{error_code: 'PRE_VALID_REJECTED'}]},
};
unknownWriteResultTask.execution.hlOpenApiExecutor.publishResult = {code: 0};
unknownWriteResultTask.execution.writeAudit.executorEvidence[0].publishResult = {code: 0};

const unknownWriteResultWithPayloadHashTask = {
  ...structuredClone(unknownWriteResultTask),
  id: 'task-unknown-write-result-with-payloadhash-001',
};
unknownWriteResultWithPayloadHashTask.publishAssetBinding.evidence.payloadHash = initialPayloadHash;

const cleanMissingPayloadTask = {
  ...structuredClone(normalReuseTask),
  id: 'task-clean-missing-payload-001',
  issuedExecuteToExecutor: false,
  sheinWriteAttempted: false,
  openapiPublishPayload: null,
  lifecycle: {status: 'waiting_review'},
  execution: {
    state: 'waiting_review',
    submitted: false,
    actualWriteSubmitted: false,
    issuedExecuteToExecutor: false,
    sheinWriteAttempted: false,
    publishResult: null,
    preflight: {ok: false, blockers: [], warnings: []},
    writeAudit: {
      submitted: false,
      actualWriteSubmitted: false,
      issuedExecuteToExecutor: false,
      sheinWriteAttempted: false,
      executorEvidence: [],
    },
  },
};

const storedPayloadHashMismatchTask = {
  ...structuredClone(normalReuseTask),
  id: 'task-stored-payloadhash-mismatch-001',
};
storedPayloadHashMismatchTask.publishAssetBinding.evidence.payloadHash = 'f'.repeat(64);

const fixtureTasks = [
  normalReuseTask,
  metadataDriftTask,
  payloadBodyHashDriftTask,
  actualWriteSubmittedTask,
  unknownWriteResultTask,
  unknownWriteResultWithPayloadHashTask,
  cleanMissingPayloadTask,
  storedPayloadHashMismatchTask,
];
await fs.writeFile(taskFile, JSON.stringify({version: 1, tasks: fixtureTasks}, null, 2), 'utf8');

await fs.writeFile(auditFile, '', 'utf8');

const portalPort = await new Promise((resolve) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => {
    const port = srv.address().port;
    srv.close(() => resolve(port));
  });
});

const portalProc = spawn(process.execPath, [
  'scripts/serve_bi_portal.mjs',
  '--host', '127.0.0.1',
  '--port', String(portalPort),
  '--dir', portalDir,
  '--auth-file', authFile,
  '--access-roles-file', accessRolesFile,
  '--session-secret-file', sessionSecretFile,
  '--link-ops-task-file', taskFile,
  '--audit-file', auditFile,
], {
  cwd: ROOT,
  env: {
    ...process.env,
    NODE_ENV: 'test',
    SHEIN_BI_ALLOW_LOCAL_OPENAPI_EXECUTOR: '1',
    NODE_OPTIONS: [(process.env.NODE_OPTIONS || ''), '--experimental-loader=' + pathToFileURL(pgLoaderFile).href].filter(Boolean).join(' '),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let portalStdout = '';
let portalStderr = '';
portalProc.stdout.on('data', d => { portalStdout += d.toString(); });
portalProc.stderr.on('data', d => { portalStderr += d.toString(); });

let portalReady = false;
for (let i = 0; i < 50; i++) {
  try {
    const res = await fetch('http://127.0.0.1:' + portalPort + '/api/health');
    if (res.ok) {
      portalReady = true;
      break;
    }
  } catch {}
  await new Promise(r => setTimeout(r, 100));
}
if (!portalReady) {
  console.error('Portal failed to become ready. stdout:', portalStdout);
  console.error('Portal failed to become ready. stderr:', portalStderr);
}

let checksPassed = 0;
function check(cond, msg) {
  assert.ok(cond, msg);
  checksPassed++;
}

try {
  // Login through CLI
  const loginProc = spawn(process.execPath, [
    'scripts/bi_ops_cli.mjs',
    'login',
    '--base-url', 'http://127.0.0.1:' + portalPort,
    '--session-file', sessionFile,
    '--username', 'operator_test',
    '--password', 'test-password',
  ], {cwd: ROOT, env: {...process.env, SHEIN_BI_KNOWLEDGE_CACHE_DIR: knowledgeCacheDir, SHEIN_BI_PARTNER_CHECK_TTL_MS: '0'}});

  let loginOut = '';
  loginProc.stdout.on('data', d => { loginOut += d.toString(); });
  loginProc.stderr.on('data', d => { loginOut += d.toString(); });
  const loginExit = await new Promise(r => loginProc.on('exit', r));
  check(loginExit === 0, 'CLI login succeeded');

  const session = JSON.parse(await fs.readFile(sessionFile, 'utf8'));

  // Case 1: Normal 14-asset binding reuse with updated supplierSku
  const normalReuseRes = await fetch('http://127.0.0.1:' + portalPort + '/api/link-ops-publish-assets', {
    method: 'POST',
    headers: {'content-type': 'application/json', accept: 'application/json', cookie: session.cookie},
    body: JSON.stringify({
      taskId: normalReuseTask.id,
      store: STORE,
      reuseApprovedBinding: true,
      bindings: [],
      sourceApproved: true,
      supplierSku: 'NEW-SUPPLIER-SKU-CORRECTED',
    }),
  });

  check(normalReuseRes.status === 200, 'Normal reuse returns HTTP 200');
  const normalReuseData = await normalReuseRes.json();
  check(normalReuseData.ok === true, 'Response ok is true');
  check(normalReuseData.task?.id === normalReuseTask.id, 'Response task id matches');
  check(normalReuseData.binding?.imageCount === 14, 'Binding imageCount is 14');
  check(normalReuseData.binding?.boundNames?.length === 14, 'Binding boundNames array has 14 entries');
  check(normalReuseData.persistedRevision === 21, 'persistedRevision in response is 21');
  check(normalReuseData.binding?.publishPreparation?.supplierSku === 'NEW-SUPPLIER-SKU-CORRECTED', 'New supplierSku projection took effect in binding response publishPreparation');
  check(normalReuseData.task?.execution?.state === 'needs_repreflight', 'Execution state reset to needs_repreflight');
  check(normalReuseData.task?.execution?.preflight?.ok === false, 'Previous preflight invalidated');
  check(normalReuseData.task?.repositoryRevision === 21, 'CAS revision incremented from 20 to 21');

  // Verify task file on disk
  const afterNormalTaskStore = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  check(afterNormalTaskStore.tasks.length === fixtureTasks.length, 'Zero new tasks created in store');
  const persistedNormalTask = afterNormalTaskStore.tasks.find(t => t.id === normalReuseTask.id);
  check(persistedNormalTask.repositoryRevision === 21, 'Persisted task revision is 21');
  check(persistedNormalTask.publishAssetBinding?.images?.length === 14, 'Persisted task binding has 14 images');
  check(persistedNormalTask.openapiPublishPayload?.skc_list?.[0]?.sku_list?.[0]?.supplier_sku === 'NEW-SUPPLIER-SKU-CORRECTED', 'Persisted openapiPublishPayload has updated supplierSku');
  check(persistedNormalTask.publishAssetBinding?.evidence?.recoveredFromAudit !== true, 'Normal reuse evidence does not contain recoveredFromAudit: true');
  check(persistedNormalTask.publishAssetBinding?.evidence?.payloadHash === canonicalRecoveredPublishPayloadHash(persistedNormalTask.openapiPublishPayload), 'Successful binding stores the canonical prepared payload hash');
  check(persistedNormalTask.submitted === false && persistedNormalTask.actualWriteSubmitted === false, 'Top-level submitted write slots remain false');
  check(persistedNormalTask.execution?.submitted === false && persistedNormalTask.execution?.actualWriteSubmitted === false, 'Execution submitted write slots remain false');
  check(persistedNormalTask.execution?.openApiProductExecutors?.some(run => run.runId === REJECTED_RUN_ID), 'Historical full rejected executor run remains readable');
  check(persistedNormalTask.execution?.writeAudit?.executorEvidence?.some(run => run.runId === REJECTED_RUN_ID), 'Historical writeAudit rejection projection remains readable');

  // Verify audit log: zero upload-pic, zero executor capture, zero execute
  const auditLines = (await fs.readFile(auditFile, 'utf8')).split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
  check(!auditLines.some(r => r.type === 'openapi-image-asset-upload-pic'), 'Zero upload-pic calls occurred');
  check(!auditLines.some(r => r.type === 'link-ops-execute'), 'Zero execute calls occurred');
  await assert.rejects(fs.access(executorProbeFile), 'Normal reuse does not launch the OpenAPI capture executor');
  check(auditLines.some(r => r.type === 'link-ops-publish-assets-bound' && r.task?.id === normalReuseTask.id), 'link-ops-publish-assets audit row appended');

  // Case 2: Metadata fingerprint drift returns 409 Conflict
  const driftRes = await fetch('http://127.0.0.1:' + portalPort + '/api/link-ops-publish-assets', {
    method: 'POST',
    headers: {'content-type': 'application/json', accept: 'application/json', cookie: session.cookie},
    body: JSON.stringify({
      taskId: metadataDriftTask.id,
      store: STORE,
      reuseApprovedBinding: true,
      bindings: [],
      sourceApproved: true,
      supplierSku: 'NEW-SUPPLIER-SKU-DRIFT',
    }),
  });
  check(driftRes.status === 409, 'Metadata fingerprint drift returns HTTP 409 Conflict');
  const driftData = await driftRes.json();
  check(driftData.ok === false, 'Drift response ok is false');
  check(driftData.code === 'REUSE_APPROVED_BINDING_METADATA_INVALID' || driftData.error?.includes('approved image binding validation failed'), 'Drift response reports binding validation failure');
  await assert.rejects(fs.access(executorProbeFile), 'Fingerprint drift is rejected before launching the capture executor');

  // Case 3: The strict rejected run's bodyHash must match the current payload.
  const payloadDriftRes = await fetch('http://127.0.0.1:' + portalPort + '/api/link-ops-publish-assets', {
    method: 'POST',
    headers: {'content-type': 'application/json', accept: 'application/json', cookie: session.cookie},
    body: JSON.stringify({
      taskId: payloadBodyHashDriftTask.id,
      store: STORE,
      reuseApprovedBinding: true,
      bindings: [],
      sourceApproved: true,
      supplierSku: 'NEW-SUPPLIER-SKU-PAYLOAD-DRIFT',
    }),
  });
  check(payloadDriftRes.status === 409, 'Payload/bodyHash drift returns HTTP 409');
  const payloadDriftData = await payloadDriftRes.json();
  check(payloadDriftData.code === 'REUSE_APPROVED_BINDING_REJECTION_HASH_MISMATCH', 'Payload/bodyHash drift reports exact mismatch code');

  // Case 4: taskCannotRepeatRealExecution rejects actualWriteSubmitted first.
  const actualWriteRes = await fetch('http://127.0.0.1:' + portalPort + '/api/link-ops-publish-assets', {
    method: 'POST',
    headers: {'content-type': 'application/json', accept: 'application/json', cookie: session.cookie},
    body: JSON.stringify({
      taskId: actualWriteSubmittedTask.id,
      store: STORE,
      reuseApprovedBinding: true,
      bindings: [],
      sourceApproved: true,
      supplierSku: 'NEW-SUPPLIER-SKU-ACTUAL-WRITE',
    }),
  });
  check(actualWriteRes.status === 409, 'actualWriteSubmitted=true returns HTTP 409');
  const actualWriteData = await actualWriteRes.json();
  check(actualWriteData.code === 'REUSE_APPROVED_BINDING_REPEAT_EXECUTION_FORBIDDEN', 'actualWriteSubmitted uses the repeat-execution gate');

  // Case 5: A write attempt without its own explicit success=false cannot capture or reuse.
  const unknownWriteRes = await fetch('http://127.0.0.1:' + portalPort + '/api/link-ops-publish-assets', {
    method: 'POST',
    headers: {'content-type': 'application/json', accept: 'application/json', cookie: session.cookie},
    body: JSON.stringify({
      taskId: unknownWriteResultTask.id,
      store: STORE,
      reuseApprovedBinding: true,
      bindings: [],
      sourceApproved: true,
      supplierSku: 'NEW-SUPPLIER-SKU-UNKNOWN',
    }),
  });
  check(unknownWriteRes.status === 409, 'Unknown write result returns HTTP 409');
  const unknownWriteData = await unknownWriteRes.json();
  check(unknownWriteData.code === 'REUSE_APPROVED_BINDING_WRITE_EVIDENCE_UNSAFE', 'Unknown write result fails the strict rejection gate');

  // Case 6: A matching payloadHash cannot bypass unsafe write evidence.
  const unknownWriteWithHashRes = await fetch('http://127.0.0.1:' + portalPort + '/api/link-ops-publish-assets', {
    method: 'POST',
    headers: {'content-type': 'application/json', accept: 'application/json', cookie: session.cookie},
    body: JSON.stringify({
      taskId: unknownWriteResultWithPayloadHashTask.id,
      store: STORE,
      reuseApprovedBinding: true,
      bindings: [],
      sourceApproved: true,
      supplierSku: 'NEW-SUPPLIER-SKU-UNKNOWN-WITH-HASH',
    }),
  });
  check(unknownWriteWithHashRes.status === 409, 'Unknown write result with matching payloadHash returns HTTP 409');
  const unknownWriteWithHashData = await unknownWriteWithHashRes.json();
  check(unknownWriteWithHashData.code === 'REUSE_APPROVED_BINDING_WRITE_EVIDENCE_UNSAFE', 'Matching payloadHash does not bypass the strict write-evidence gate');
  const afterUnknownWriteWithHashStore = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  check(afterUnknownWriteWithHashStore.tasks.find(task => task.id === unknownWriteResultWithPayloadHashTask.id)?.repositoryRevision === 20, 'Unsafe write task revision remains unchanged');

  // Case 7: A stored valid evidence.payloadHash must match the current payload exactly.
  const storedHashMismatchRes = await fetch('http://127.0.0.1:' + portalPort + '/api/link-ops-publish-assets', {
    method: 'POST',
    headers: {'content-type': 'application/json', accept: 'application/json', cookie: session.cookie},
    body: JSON.stringify({
      taskId: storedPayloadHashMismatchTask.id,
      store: STORE,
      reuseApprovedBinding: true,
      bindings: [],
      sourceApproved: true,
      supplierSku: 'NEW-SUPPLIER-SKU-STORED-HASH',
    }),
  });
  check(storedHashMismatchRes.status === 409, 'Stored payloadHash mismatch returns HTTP 409');
  const storedHashMismatchData = await storedHashMismatchRes.json();
  check(storedHashMismatchData.code === 'REUSE_APPROVED_BINDING_PAYLOAD_HASH_MISMATCH', 'Stored payloadHash mismatch reports exact code');
  await assert.rejects(fs.access(executorProbeFile), 'All unsafe or drifted write-evidence cases reject before capture');

  // Case 8: A genuinely clean historical binding without payloadHash retains
  // the old capture path and fails closed when capture cannot produce a payload.
  const cleanMissingPayloadRes = await fetch('http://127.0.0.1:' + portalPort + '/api/link-ops-publish-assets', {
    method: 'POST',
    headers: {'content-type': 'application/json', accept: 'application/json', cookie: session.cookie},
    body: JSON.stringify({
      taskId: cleanMissingPayloadTask.id,
      store: STORE,
      reuseApprovedBinding: true,
      bindings: [],
      sourceApproved: true,
      supplierSku: 'NEW-SUPPLIER-SKU-CLEAN-MISSING',
    }),
  });
  check(cleanMissingPayloadRes.status === 409, 'Clean missing openapiPublishPayload fails closed with HTTP 409');
  const cleanMissingPayloadData = await cleanMissingPayloadRes.json();
  check(cleanMissingPayloadData.ok === false, 'Clean missing payload response ok is false');
  const executorProbe = await fs.readFile(executorProbeFile, 'utf8');
  check(executorProbe.includes('/scripts/link_ops_hl_openapi_executor.mjs'), 'Clean missing payload retains the legacy capture/fail-closed path');

  const finalTaskStore = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  check(finalTaskStore.tasks.length === fixtureTasks.length, 'All focused cases create zero new tasks');
  const finalAuditLines = (await fs.readFile(auditFile, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  check(!finalAuditLines.some(row => row.type === 'openapi-image-asset-upload-pic'), 'All focused cases trigger zero upload-pic calls');
  check(!finalAuditLines.some(row => row.type === 'link-ops-execute'), 'All focused cases trigger zero real execute calls');

  console.log('All ' + checksPassed + ' normal reuse contract assertions passed cleanly.');
} finally {
  portalProc.kill();
  await fs.rm(tmpRoot, {recursive: true, force: true}).catch(() => {});
}
