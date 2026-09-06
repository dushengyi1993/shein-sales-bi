#!/usr/bin/env node
/**
 * End-to-end focused contract test for link ops uploaded asset binding recovery.
 *
 * Proves:
 *   1. CLI reaches /api/link-ops-recover-uploaded-asset-binding with valid params & confirm marker.
 *   2. Portal filters real contextless upload-pic audit rows by the caller's exact 6 tuple set.
 *   3. CAS updates task record exactly once (revision increments from N to N+1).
 *   4. Zero upload-pic or external API calls are made during recovery.
 *   5. Task write slots (submitted, actualWriteSubmitted, issuedExecuteToExecutor, sheinWriteAttempted) remain false.
 *   6. preflight is invalidated (needs_repreflight).
 *   7. Idempotent replay recomputes current identity/payload/fingerprint/6-tuples and rejects drift.
 *   8. Recovered binding can be reused by the real Portal prepare-publish dry-run path with 0.18A/304301999.
 *   9. Post-CAS audit failure reports bindingCommitted=true and committed_but_audit_or_readback_pending.
 *  10. Commit-then-throw is recovered only by exact authoritative revision/payloadHash/binding readback.
 *  11. Task drift while the recovery lock gate is held is rejected from a fresh authoritative read.
 *  12. Concurrent replay appends one recovery audit and performs no repeated CAS.
 *  13. Rejection if any write slot is not false or publishResult is not null.
 */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {
  LISTING_BIND_RECOVERY_AUDIT_TYPE,
  LISTING_IMAGE_UPLOAD_AUDIT_TYPE,
  RECOVER_UPLOADED_ASSET_BINDING_CONFIRM_TEXT,
  canonicalRecoveredPublishPayloadHash,
} from '../lib/link_ops_uploaded_asset_binding_recovery.mjs';
import {provisionBiSessionSecret} from './provision_bi_session_secret.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = process.platform === 'win32' ? path.join(ROOT, 'tmp') : '/tmp';
await fs.mkdir(tmpBase, {recursive: true});
const tmpRoot = await fs.mkdtemp(path.join(tmpBase, 'test-recover-e2e-'));
if (process.platform !== 'win32') await fs.chmod(tmpRoot, 0o700);
const auditFile = path.join(tmpRoot, 'audit.jsonl');
const taskFile = path.join(tmpRoot, 'tasks.json');
const sessionFile = path.join(tmpRoot, 'session.json');
const authFile = path.join(tmpRoot, 'auth.json');
const accessRolesFile = path.join(tmpRoot, 'access_roles.json');
const sessionSecretFile = path.join(tmpRoot, 'session_secret');
const recoveryAuditFailFile = path.join(tmpRoot, 'fail-recovery-audit');
const recoveryPostCommitFailFile = path.join(tmpRoot, 'fail-recovery-post-commit');
const recoveryLockGateDir = path.join(tmpRoot, 'recovery-lock-gates');
const portalDir = path.join(tmpRoot, 'portal');
const knowledgeCacheDir = path.join(tmpRoot, 'knowledge-cache');
const requireFromTest = createRequire(import.meta.url);
const sharedPgEntryPath = requireFromTest.resolve('pg');
const sharedPgEntryUrl = pathToFileURL(sharedPgEntryPath).href;
const pgLoaderFile = path.join(tmpRoot, 'pg-loader.mjs');

await fs.mkdir(portalDir, {recursive: true});
await fs.writeFile(pgLoaderFile, [
  'export async function resolve(specifier, context, nextResolve) {',
  '  if (specifier === \'pg\') {',
  '    return {url: ' + JSON.stringify(sharedPgEntryUrl) + ', shortCircuit: true};',
  '  }',
  '  return nextResolve(specifier, context);',
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

const TASK_ID = 'task-recover-e2e-001';
const STORE = 'HL';
const SOURCE_STORE = 'CX';
const SOURCE_SKC = 'sv25082902871830770';
const STANDARD_GOODS_SN = 'SM-961-E2E';
const RELEASE_ID = 'rel-e2e-v4-test';
const PREPARE_BATCH_ID = 'e2e'.padEnd(64, '0');

const initialTask = {
  id: TASK_ID,
  storeKey: STORE,
  sourceStore: SOURCE_STORE,
  sourceSkc: SOURCE_SKC,
  standardGoodsSn: STANDARD_GOODS_SN,
  repositoryRevision: 10,
  releaseId: RELEASE_ID,
  intents: ['copy_product_draft'],
  writeStores: [STORE],
  stores: [STORE],
  submitted: false,
  actualWriteSubmitted: false,
  issuedExecuteToExecutor: false,
  sheinWriteAttempted: false,
  publishResult: null,
  publishPreparation: {
    targetStore: STORE,
    standardGoodsSn: STANDARD_GOODS_SN,
    supplyPrice: '172.22',
    inventory: 100,
    titles: {},
    attributeOverrides: [],
  },
  assets: [],
  openapiPublishPayload: {
    product_type_id: 9851,
    skc_list: [
      {
        supplier_code: STANDARD_GOODS_SN,
        sku_list: [{}],
      },
    ],
  },
  lifecycle: {
    status: 'ready_for_submit',
  },
  execution: {
    state: 'waiting_review',
    submitted: false,
    actualWriteSubmitted: false,
    issuedExecuteToExecutor: false,
    sheinWriteAttempted: false,
    publishResult: null,
    writeAudit: {
      submitted: false,
      actualWriteSubmitted: false,
      issuedExecuteToExecutor: false,
      sheinWriteAttempted: false,
    },
  },
};

const dirtyTask = {
  ...initialTask,
  id: 'task-dirty-001',
  submitted: true,
};

const auditFailTask = {
  ...structuredClone(initialTask),
  id: 'task-audit-fail-001',
};

const postCommitFailTask = {
  ...structuredClone(initialTask),
  id: 'task-post-commit-fail-001',
};

const freshWriteDriftTask = {
  ...structuredClone(initialTask),
  id: 'task-fresh-write-drift-001',
};

await fs.mkdir(recoveryLockGateDir, {recursive: true});
await fs.writeFile(taskFile, JSON.stringify({version: 1, tasks: [initialTask, dirtyTask, auditFailTask, postCommitFailTask, freshWriteDriftTask]}, null, 2), 'utf8');

const uploadedFiles = [
  {imageType: 1, name: 'main.jpg'},
  {imageType: 2, name: 'detail-1.jpg'},
  {imageType: 1, name: 'second.jpg'},
  {imageType: 5, name: 'square.jpg'},
  {imageType: 2, name: 'detail-2.jpg'},
  {imageType: 2, name: 'detail-3.jpg'},
];

const audits = uploadedFiles.map((r, i) => {
  const sha256 = crypto.createHash('sha256').update('content-' + i).digest('hex');
  return {
    type: LISTING_IMAGE_UPLOAD_AUDIT_TYPE,
    storeKey: STORE,
    imageType: r.imageType,
    file: {
      name: r.name,
      sha256,
    },
    result: {
      imageUrl: 'https://img.ltwebstatic.com/item/e2e-' + (i + 1) + '.jpg',
    },
  };
});

const staleAudits = uploadedFiles.map((r, i) => ({
  type: LISTING_IMAGE_UPLOAD_AUDIT_TYPE,
  storeKey: STORE,
  imageType: r.imageType,
  file: {name: `stale-${r.name}`, sha256: crypto.createHash('sha256').update('stale-content-' + i).digest('hex')},
  result: {imageUrl: 'https://img.ltwebstatic.com/stale/e2e-' + (i + 1) + '.jpg'},
}));

function uploadedImageCliArgs(rows = audits) {
  const requestOrder = [4, 0, 5, 2, 1, 3];
  return requestOrder.flatMap(index => [
    '--uploaded-image',
    `${rows[index].file.name}|${rows[index].result.imageUrl}|${rows[index].file.sha256}`,
  ]);
}

await fs.writeFile(auditFile, [...staleAudits, ...audits].map(a => JSON.stringify(a)).join('\n') + '\n', 'utf8');

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
    SHEIN_BI_TEST_RECOVERY_AUDIT_FAIL_FILE: recoveryAuditFailFile,
    SHEIN_BI_TEST_RECOVERY_POST_COMMIT_FAIL_FILE: recoveryPostCommitFailFile,
    SHEIN_BI_TEST_RECOVERY_LOCK_GATE_DIR: recoveryLockGateDir,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --experimental-loader=${pathToFileURL(pgLoaderFile).href}`.trim(),
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

async function waitForFile(file, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(file);
      return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for file: ${file}`);
}

try {
  // Step 1: Login through CLI
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
  if (loginExit !== 0) console.error('Login output:', loginOut);
  check(loginExit === 0, 'CLI login succeeded');

  // Step 2: Recover uploaded asset binding via CLI
  const recoverProc = spawn(process.execPath, [
    'scripts/bi_ops_cli.mjs',
    'recover-uploaded-asset-binding',
    '--base-url', 'http://127.0.0.1:' + portalPort,
    '--session-file', sessionFile,
    '--task-id', TASK_ID,
    '--prepare-batch-id', PREPARE_BATCH_ID,
    ...uploadedImageCliArgs(),
    '--confirm', RECOVER_UPLOADED_ASSET_BINDING_CONFIRM_TEXT,
    '--expected-revision', '10',
  ], {cwd: ROOT, env: {...process.env, SHEIN_BI_KNOWLEDGE_CACHE_DIR: knowledgeCacheDir, SHEIN_BI_PARTNER_CHECK_TTL_MS: '0'}});

  let recoverOut = '';
  recoverProc.stdout.on('data', d => { recoverOut += d.toString(); });
  recoverProc.stderr.on('data', d => { recoverOut += d.toString(); });
  const recoverExit = await new Promise(r => recoverProc.on('exit', r));
  if (recoverExit !== 0) console.error('Recover output:', recoverOut);
  check(recoverExit === 0, 'CLI recover-uploaded-asset-binding succeeded');

  const recoverData = JSON.parse(recoverOut);
  check(recoverData.ok === true, 'Response ok is true');
  check(recoverData.persistedRevision === 11, 'Task revision incremented to 11');
  check(recoverData.imageCount === 6, 'Image count is 6');
  check(recoverData.roles.length === 6, 'Roles array has 6 entries');
  check(JSON.stringify(recoverData.roles) === JSON.stringify(['mainCover', 'detail', 'carouselSecondCover', 'squareImage', 'detail', 'detail']), 'Roles derive only from producer audit order and imageType');
  check(recoverData.safety.newUploadTriggered === false, 'Zero new uploads triggered');
  check(recoverData.safety.newTaskCreated === false, 'Zero new tasks created');
  check(recoverData.safety.preflightInvalidated === true, 'Preflight invalidated');

  // Verify task file state
  const updatedTaskData = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  const updatedTask = updatedTaskData.tasks.find(t => t.id === TASK_ID);
  check(updatedTask.repositoryRevision === 11, 'Persisted task revision is 11');
  check(updatedTask.publishAssetBinding?.authority === 'human_reviewed_source', 'Authority matches reuse-approved-binding contract');
  check(updatedTask.publishAssetBinding?.images?.length === 6, '6 images bound');
  check(updatedTask.execution.state === 'needs_repreflight', 'Execution state is needs_repreflight');
  check(updatedTask.execution.preflight?.ok === false, 'Preflight ok is false');
  check(updatedTask.submitted === false, 'submitted is false');
  check(updatedTask.actualWriteSubmitted === false, 'actualWriteSubmitted is false');
  check(updatedTask.issuedExecuteToExecutor === false, 'issuedExecuteToExecutor is false');
  check(updatedTask.sheinWriteAttempted === false, 'sheinWriteAttempted is false');
  check(updatedTask.publishAssetBinding?.evidence?.recoveredFromAudit === true, 'Real recovery records recovered provenance');
  check(updatedTask.publishAssetBinding?.evidence?.payloadHash === canonicalRecoveredPublishPayloadHash(updatedTask.openapiPublishPayload), 'Real recovery locks the exact current payload without fixture hash rewriting');

  // Negative controls alter only the unsafe input; the successful reuse below
  // still consumes the untouched result of the real recovery endpoint.
  const reuseSession = JSON.parse(await fs.readFile(sessionFile, 'utf8'));
  for (const [label, tamper, expectedCode] of [
    ['malformed neutral hash', task => { task.publishAssetBinding.evidence.payloadHash = 'not-a-sha256'; }, 'REUSE_APPROVED_BINDING_PAYLOAD_HASH_INVALID'],
    ['unknown write with matching hash', task => { task.execution.openApiProductExecutors = [{runId: 'unknown-recovered-write', mode: 'execute', state: 'unknown', publishResult: null}]; }, 'REUSE_APPROVED_BINDING_WRITE_EVIDENCE_UNSAFE'],
  ]) {
    const alteredStore = structuredClone(updatedTaskData);
    const alteredTask = alteredStore.tasks.find(task => task.id === TASK_ID);
    tamper(alteredTask);
    await fs.writeFile(taskFile, JSON.stringify(alteredStore, null, 2), 'utf8');
    try {
      const denied = await fetch('http://127.0.0.1:' + portalPort + '/api/link-ops-publish-assets', {
        method: 'POST', headers: {'content-type': 'application/json', cookie: reuseSession.cookie},
        body: JSON.stringify({taskId: TASK_ID, store: STORE, sourceApproved: true, reuseApprovedBinding: true, supplyPrice: 172.22, inventory: 100}),
      });
      const deniedBody = await denied.json();
      check(denied.status === 409 && deniedBody.code === expectedCode, `${label} is rejected by the exact guard`);
      const afterDenied = JSON.parse(await fs.readFile(taskFile, 'utf8'));
      check(JSON.stringify(afterDenied.tasks.find(task => task.id === TASK_ID)) === JSON.stringify(alteredTask), `${label} leaves the task unchanged`);
    } finally {
      await fs.writeFile(taskFile, JSON.stringify(updatedTaskData, null, 2), 'utf8');
    }
  }

  // Step 2b: Real Portal reuse-approved-binding path accepts the recovered
  // binding and reaches a dry-run with 0.18A/304301999 without uploads,
  // real execute, or a replacement task.
  const reuseProc = spawn(process.execPath, [
    'scripts/bi_ops_cli.mjs',
    'prepare-publish',
    '--base-url', 'http://127.0.0.1:' + portalPort,
    '--session-file', sessionFile,
    '--task-id', TASK_ID,
    '--store', STORE,
    '--reuse-approved-binding',
    '--supply-price', '172.22',
    '--inventory', '100',
    '--input-current-a', '0.18',
    '--input-current-value-id', '304301999',
  ], {cwd: ROOT, env: {...process.env, SHEIN_BI_KNOWLEDGE_CACHE_DIR: knowledgeCacheDir, SHEIN_BI_PARTNER_CHECK_TTL_MS: '0'}});
  let reuseOut = '';
  reuseProc.stdout.on('data', d => { reuseOut += d.toString(); });
  reuseProc.stderr.on('data', d => { reuseOut += d.toString(); });
  const reuseExit = await new Promise(r => reuseProc.on('exit', r));
  if (reuseExit !== 0) console.error('Reuse dry-run failed output:', reuseOut);
  check(reuseExit === 0, 'Recovered binding is accepted by real prepare-publish --reuse-approved-binding dry-run');
  const reuseData = JSON.parse(reuseOut);
  check(reuseData.ok === true, 'Reuse dry-run response ok is true');
  check(reuseData.reuseApprovedBinding === true, 'Reuse dry-run reports reuseApprovedBinding');
  check(reuseData.safety?.realPublishOccurred === false, 'Reuse dry-run did not execute a real publish');
  check(reuseData.safety?.uploadedImageCount === 0, 'Reuse dry-run triggered zero uploads');
  check(reuseData.binding?.payloadSource === 'task', 'Reuse dry-run uses existing task binding payload');

  const afterReuseTaskData = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  check(afterReuseTaskData.tasks.length === 5, 'Reuse dry-run created no new task');
  const afterReuseTask = afterReuseTaskData.tasks.find(t => t.id === TASK_ID);
  check(afterReuseTask.publishAssetBinding?.images?.every(img => !String(img.imageUrl || '').includes('/stale/')), 'Historical upload audit batch did not affect recovered binding');
  const auditLinesAfterReuse = (await fs.readFile(auditFile, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  check(auditLinesAfterReuse.filter(row => row.type === 'openapi-image-asset-upload-pic').length === 12, 'Reuse recovery did not append upload-pic audit rows');
  check(auditLinesAfterReuse.some(row => row.type === 'link-ops-recover-uploaded-asset-binding'), 'Recovery audit row was appended');
  check(auditLinesAfterReuse.some(row => row.type === 'link-ops-execute'), 'Reuse path reached controlled dry-run executor');
  const revisionBeforeReplay = Number(afterReuseTask.repositoryRevision);

  // Step 3: Idempotent replay: running same recovery again
  const replayProc = spawn(process.execPath, [
    'scripts/bi_ops_cli.mjs',
    'recover-uploaded-asset-binding',
    '--base-url', 'http://127.0.0.1:' + portalPort,
    '--session-file', sessionFile,
    '--task-id', TASK_ID,
    '--prepare-batch-id', PREPARE_BATCH_ID,
    ...uploadedImageCliArgs(),
    '--confirm', RECOVER_UPLOADED_ASSET_BINDING_CONFIRM_TEXT,
  ], {cwd: ROOT, env: {...process.env, SHEIN_BI_KNOWLEDGE_CACHE_DIR: knowledgeCacheDir, SHEIN_BI_PARTNER_CHECK_TTL_MS: '0'}});

  let replayOut = '';
  replayProc.stdout.on('data', d => { replayOut += d.toString(); });
  replayProc.stderr.on('data', d => { replayOut += d.toString(); });
  const replayExit = await new Promise(r => replayProc.on('exit', r));
  if (replayExit !== 0) console.error('Replay failed output:', replayOut);
  check(replayExit === 0, 'Replay CLI exit code is 0');
  const replayData = JSON.parse(replayOut);
  check(replayData.ok === true, 'Replay response ok is true');
  check(replayData.idempotentReplay === true, 'Replay flagged as idempotentReplay');
  check(replayData.persistedRevision === revisionBeforeReplay, 'Revision remained current (did not increment again)');

  // Step 3b: a replay after payload drift must fail closed rather than trust
  // the existing binding marker.
  const driftedTaskData = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  const driftedTask = driftedTaskData.tasks.find(t => t.id === TASK_ID);
  driftedTask.openapiPublishPayload.skc_list[0].image_info.image_info_list[0].image_url = 'https://img.ltwebstatic.com/item/drifted.jpg';
  await fs.writeFile(taskFile, JSON.stringify(driftedTaskData, null, 2), 'utf8');
  const driftReplayProc = spawn(process.execPath, [
    'scripts/bi_ops_cli.mjs',
    'recover-uploaded-asset-binding',
    '--base-url', 'http://127.0.0.1:' + portalPort,
    '--session-file', sessionFile,
    '--task-id', TASK_ID,
    '--prepare-batch-id', PREPARE_BATCH_ID,
    ...uploadedImageCliArgs(),
    '--confirm', RECOVER_UPLOADED_ASSET_BINDING_CONFIRM_TEXT,
  ], {cwd: ROOT, env: {...process.env, SHEIN_BI_KNOWLEDGE_CACHE_DIR: knowledgeCacheDir, SHEIN_BI_PARTNER_CHECK_TTL_MS: '0'}});
  let driftReplayOut = '';
  driftReplayProc.stdout.on('data', d => { driftReplayOut += d.toString(); });
  driftReplayProc.stderr.on('data', d => { driftReplayOut += d.toString(); });
  const driftReplayExit = await new Promise(r => driftReplayProc.on('exit', r));
  check(driftReplayExit === 1, 'Drifted idempotent replay exits 1');
  const driftReplayData = JSON.parse(driftReplayOut);
  check(driftReplayData.bindingCommitted === false, 'Drifted replay does not claim a new binding commit');
  check(driftReplayData.code === 'RECOVER_IDEMPOTENT_REPLAY_PAYLOAD_DRIFT', 'Drifted replay reports payload drift');

  // Step 3c: inject failure only at the final recovery audit, after CAS and
  // strict readback. The CLI must preserve the committed boundary exactly.
  await fs.writeFile(recoveryAuditFailFile, '1', 'utf8');
  const auditFailProc = spawn(process.execPath, [
    'scripts/bi_ops_cli.mjs',
    'recover-uploaded-asset-binding',
    '--base-url', 'http://127.0.0.1:' + portalPort,
    '--session-file', sessionFile,
    '--task-id', auditFailTask.id,
    '--prepare-batch-id', PREPARE_BATCH_ID,
    ...uploadedImageCliArgs(),
    '--confirm', RECOVER_UPLOADED_ASSET_BINDING_CONFIRM_TEXT,
    '--expected-revision', '10',
  ], {cwd: ROOT, env: {...process.env, SHEIN_BI_KNOWLEDGE_CACHE_DIR: knowledgeCacheDir, SHEIN_BI_PARTNER_CHECK_TTL_MS: '0'}});
  let auditFailOut = '';
  auditFailProc.stdout.on('data', d => { auditFailOut += d.toString(); });
  auditFailProc.stderr.on('data', d => { auditFailOut += d.toString(); });
  const auditFailExit = await new Promise(r => auditFailProc.on('exit', r));
  check(auditFailExit === 1, 'Post-CAS audit failure exits 1 without claiming complete success');
  const auditFailData = JSON.parse(auditFailOut);
  check(auditFailData.bindingCommitted === true, 'Post-CAS audit failure preserves bindingCommitted=true');
  check(auditFailData.readbackVerified === true, 'Post-CAS audit failure preserves successful strict readback');
  check(auditFailData.auditPending === true, 'Post-CAS audit failure marks auditPending=true');
  check(auditFailData.stage === 'committed_but_audit_or_readback_pending', 'Post-CAS audit failure stage is transmitted exactly');
  const afterAuditFailTaskData = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  const afterAuditFailTask = afterAuditFailTaskData.tasks.find(t => t.id === auditFailTask.id);
  check(afterAuditFailTask.repositoryRevision === 11, 'Post-CAS audit failure still persisted revision 11');
  check(afterAuditFailTask.publishAssetBinding?.images?.length === 6, 'Post-CAS audit failure still persisted all 6 bindings');
  await fs.rm(recoveryAuditFailFile, {force: true});

  const auditRecoveryReplayProc = spawn(process.execPath, [
    'scripts/bi_ops_cli.mjs',
    'recover-uploaded-asset-binding',
    '--base-url', 'http://127.0.0.1:' + portalPort,
    '--session-file', sessionFile,
    '--task-id', auditFailTask.id,
    '--prepare-batch-id', PREPARE_BATCH_ID,
    ...uploadedImageCliArgs(),
    '--confirm', RECOVER_UPLOADED_ASSET_BINDING_CONFIRM_TEXT,
  ], {cwd: ROOT, env: {...process.env, SHEIN_BI_KNOWLEDGE_CACHE_DIR: knowledgeCacheDir, SHEIN_BI_PARTNER_CHECK_TTL_MS: '0'}});
  let auditRecoveryReplayOut = '';
  auditRecoveryReplayProc.stdout.on('data', d => { auditRecoveryReplayOut += d.toString(); });
  auditRecoveryReplayProc.stderr.on('data', d => { auditRecoveryReplayOut += d.toString(); });
  const auditRecoveryReplayExit = await new Promise(r => auditRecoveryReplayProc.on('exit', r));
  check(auditRecoveryReplayExit === 0, 'Exact idempotent replay completes the previously pending audit');
  const auditRecoveryReplayData = JSON.parse(auditRecoveryReplayOut);
  check(auditRecoveryReplayData.idempotentReplay === true, 'Audit reconciliation remains an idempotent replay');
  check(auditRecoveryReplayData.persistedRevision === 11, 'Audit reconciliation does not increment revision');
  const reconciledAuditRows = (await fs.readFile(auditFile, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  check(reconciledAuditRows.some(row => row.type === LISTING_BIND_RECOVERY_AUDIT_TYPE && row.task?.id === auditFailTask.id && row.idempotentReplay === true), 'Pending recovery audit is appended exactly through validated replay');

  const replayDriftGateStem = path.join(recoveryLockGateDir, auditFailTask.id);
  await fs.writeFile(`${replayDriftGateStem}.arm`, '1', 'utf8');
  const replayDriftProc = spawn(process.execPath, [
    'scripts/bi_ops_cli.mjs',
    'recover-uploaded-asset-binding',
    '--base-url', 'http://127.0.0.1:' + portalPort,
    '--session-file', sessionFile,
    '--task-id', auditFailTask.id,
    '--prepare-batch-id', PREPARE_BATCH_ID,
    ...uploadedImageCliArgs(),
    '--confirm', RECOVER_UPLOADED_ASSET_BINDING_CONFIRM_TEXT,
    '--expected-revision', '11',
  ], {cwd: ROOT, env: {...process.env, SHEIN_BI_KNOWLEDGE_CACHE_DIR: knowledgeCacheDir, SHEIN_BI_PARTNER_CHECK_TTL_MS: '0'}});
  let replayDriftOut = '';
  replayDriftProc.stdout.on('data', data => { replayDriftOut += data.toString(); });
  replayDriftProc.stderr.on('data', data => { replayDriftOut += data.toString(); });
  await waitForFile(`${replayDriftGateStem}.ready`);
  const replayDriftStore = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  const replayDriftTask = replayDriftStore.tasks.find(task => task.id === auditFailTask.id);
  replayDriftTask.note = 'concurrent replay drift while recovery waits';
  replayDriftTask.repositoryRevision = 12;
  await fs.writeFile(taskFile, JSON.stringify(replayDriftStore, null, 2), 'utf8');
  await fs.writeFile(`${replayDriftGateStem}.release`, '1', 'utf8');
  const replayDriftExit = await new Promise(resolve => replayDriftProc.on('exit', resolve));
  check(replayDriftExit === 1, 'Replay drift while lock gate is held exits 1');
  const replayDriftData = JSON.parse(replayDriftOut);
  check(replayDriftData.code === 'RECOVER_CAS_REVISION_CONFLICT' && replayDriftData.bindingCommitted === false, 'Replay drift uses fresh locked revision and fails closed');

  // Step 3d: inject an exception after the repository has committed. The
  // endpoint may report a committed boundary only after authoritative exact
  // revision, repository payload hash, and binding replay all match.
  await fs.writeFile(recoveryPostCommitFailFile, '1', 'utf8');
  const postCommitFailProc = spawn(process.execPath, [
    'scripts/bi_ops_cli.mjs',
    'recover-uploaded-asset-binding',
    '--base-url', 'http://127.0.0.1:' + portalPort,
    '--session-file', sessionFile,
    '--task-id', postCommitFailTask.id,
    '--prepare-batch-id', PREPARE_BATCH_ID,
    ...uploadedImageCliArgs(),
    '--confirm', RECOVER_UPLOADED_ASSET_BINDING_CONFIRM_TEXT,
    '--expected-revision', '10',
  ], {cwd: ROOT, env: {...process.env, SHEIN_BI_KNOWLEDGE_CACHE_DIR: knowledgeCacheDir, SHEIN_BI_PARTNER_CHECK_TTL_MS: '0'}});
  let postCommitFailOut = '';
  postCommitFailProc.stdout.on('data', d => { postCommitFailOut += d.toString(); });
  postCommitFailProc.stderr.on('data', d => { postCommitFailOut += d.toString(); });
  const postCommitFailExit = await new Promise(r => postCommitFailProc.on('exit', r));
  check(postCommitFailExit === 1, 'Commit-then-throw exits 1 without claiming complete success');
  const postCommitFailData = JSON.parse(postCommitFailOut);
  check(postCommitFailData.bindingCommitted === true, 'Commit-then-throw preserves bindingCommitted=true after exact authoritative readback');
  check(postCommitFailData.readbackVerified === true, 'Commit-then-throw marks authoritative readback verified');
  check(postCommitFailData.auditPending === true, 'Commit-then-throw leaves final audit pending');
  check(postCommitFailData.stage === 'committed_but_audit_or_readback_pending', 'Commit-then-throw reports the exact pending stage');
  check(postCommitFailData.persistedRevision === 11, 'Commit-then-throw reports committed revision 11');
  const afterPostCommitFailTaskData = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  const afterPostCommitFailTask = afterPostCommitFailTaskData.tasks.find(t => t.id === postCommitFailTask.id);
  check(afterPostCommitFailTask.repositoryRevision === 11, 'Commit-then-throw repository record is committed exactly once');
  check(afterPostCommitFailTask.publishAssetBinding?.images?.length === 6, 'Commit-then-throw repository record has all 6 bindings');
  check(afterPostCommitFailTask.publishAssetBinding?.evidence?.recoveryIdentity?.taskId === postCommitFailTask.id, 'Commit-then-throw committed identity includes exact taskId');
  await fs.rm(recoveryPostCommitFailFile, {force: true});

  const postCommitReplayProc = spawn(process.execPath, [
    'scripts/bi_ops_cli.mjs',
    'recover-uploaded-asset-binding',
    '--base-url', 'http://127.0.0.1:' + portalPort,
    '--session-file', sessionFile,
    '--task-id', postCommitFailTask.id,
    '--prepare-batch-id', PREPARE_BATCH_ID,
    ...uploadedImageCliArgs(),
    '--confirm', RECOVER_UPLOADED_ASSET_BINDING_CONFIRM_TEXT,
  ], {cwd: ROOT, env: {...process.env, SHEIN_BI_KNOWLEDGE_CACHE_DIR: knowledgeCacheDir, SHEIN_BI_PARTNER_CHECK_TTL_MS: '0'}});
  let postCommitReplayOut = '';
  postCommitReplayProc.stdout.on('data', d => { postCommitReplayOut += d.toString(); });
  postCommitReplayProc.stderr.on('data', d => { postCommitReplayOut += d.toString(); });
  const postCommitReplayExit = await new Promise(r => postCommitReplayProc.on('exit', r));
  check(postCommitReplayExit === 0, 'Commit-then-throw pending audit is reconciled by exact idempotent replay');
  const postCommitReplayData = JSON.parse(postCommitReplayOut);
  check(postCommitReplayData.idempotentReplay === true && postCommitReplayData.persistedRevision === 11, 'Commit-then-throw replay does not repeat the repository write');

  // Step 3e: hold the same-task lock before the authoritative read, mutate the
  // repository while the request is gated, then release it. The locked path
  // must reject the caller's stale expected revision and perform no recovery CAS.
  const driftGateStem = path.join(recoveryLockGateDir, freshWriteDriftTask.id);
  await fs.writeFile(`${driftGateStem}.arm`, '1', 'utf8');
  const freshDriftProc = spawn(process.execPath, [
    'scripts/bi_ops_cli.mjs',
    'recover-uploaded-asset-binding',
    '--base-url', 'http://127.0.0.1:' + portalPort,
    '--session-file', sessionFile,
    '--task-id', freshWriteDriftTask.id,
    '--prepare-batch-id', PREPARE_BATCH_ID,
    ...uploadedImageCliArgs(),
    '--confirm', RECOVER_UPLOADED_ASSET_BINDING_CONFIRM_TEXT,
    '--expected-revision', '10',
  ], {cwd: ROOT, env: {...process.env, SHEIN_BI_KNOWLEDGE_CACHE_DIR: knowledgeCacheDir, SHEIN_BI_PARTNER_CHECK_TTL_MS: '0'}});
  let freshDriftOut = '';
  freshDriftProc.stdout.on('data', d => { freshDriftOut += d.toString(); });
  freshDriftProc.stderr.on('data', d => { freshDriftOut += d.toString(); });
  await waitForFile(`${driftGateStem}.ready`);
  const driftStore = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  const driftTask = driftStore.tasks.find(task => task.id === freshWriteDriftTask.id);
  driftTask.note = 'concurrent task drift while recovery waits';
  driftTask.repositoryRevision = 11;
  await fs.writeFile(taskFile, JSON.stringify(driftStore, null, 2), 'utf8');
  await fs.writeFile(`${driftGateStem}.release`, '1', 'utf8');
  const freshDriftExit = await new Promise(resolve => freshDriftProc.on('exit', resolve));
  check(freshDriftExit === 1, 'Lock-gated task drift exits 1');
  const freshDriftData = JSON.parse(freshDriftOut);
  check(freshDriftData.code === 'RECOVER_CAS_REVISION_CONFLICT', 'Lock-gated task drift is rejected from the fresh authoritative revision');
  check(freshDriftData.bindingCommitted === false, 'Lock-gated task drift does not claim recovery commit');
  const afterFreshDriftStore = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  const afterFreshDriftTask = afterFreshDriftStore.tasks.find(task => task.id === freshWriteDriftTask.id);
  check(afterFreshDriftTask.repositoryRevision === 11 && !afterFreshDriftTask.publishAssetBinding, 'Lock-gated task drift performs no recovery CAS');

  // Step 3f: remove the original recovery audit, then launch two exact replay
  // requests concurrently. Portal mutation admission serializes the requests;
  // each route entry must then fresh-read audit state under the same-task lock,
  // so only the first append occurs and neither replay performs a CAS.
  const auditBeforeConcurrentReplay = (await fs.readFile(auditFile, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const withoutTaskRecoveryAudit = auditBeforeConcurrentReplay.filter(row => !(row.type === LISTING_BIND_RECOVERY_AUDIT_TYPE && row.task?.id === postCommitFailTask.id));
  await fs.writeFile(auditFile, withoutTaskRecoveryAudit.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  const session = JSON.parse(await fs.readFile(sessionFile, 'utf8'));
  const replayRequest = () => fetch('http://127.0.0.1:' + portalPort + '/api/link-ops-recover-uploaded-asset-binding', {
    method: 'POST',
    headers: {'content-type': 'application/json', accept: 'application/json', cookie: session.cookie},
    body: JSON.stringify({
      taskId: postCommitFailTask.id,
      expectedPrepareBatchId: PREPARE_BATCH_ID,
      uploadedImages: [4, 0, 5, 2, 1, 3].map(index => ({
        name: audits[index].file.name,
        imageUrl: audits[index].result.imageUrl,
        sha256: audits[index].file.sha256,
      })),
      confirm: RECOVER_UPLOADED_ASSET_BINDING_CONFIRM_TEXT,
      expectedRevision: 11,
    }),
  });
  const concurrentReplayResponses = await Promise.all([replayRequest(), replayRequest()]);
  const concurrentReplayData = await Promise.all(concurrentReplayResponses.map(response => response.json()));
  check(concurrentReplayResponses.every(response => response.status === 200), 'Concurrent exact replay requests both complete through serialized admission');
  check(concurrentReplayData.every(data => data.ok === true && data.idempotentReplay === true), 'Concurrent replay responses are both validated idempotent readbacks');
  const afterConcurrentReplayStore = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  check(afterConcurrentReplayStore.tasks.find(task => task.id === postCommitFailTask.id).repositoryRevision === 11, 'Concurrent replay performs no repeated CAS');
  const afterConcurrentReplayAudit = (await fs.readFile(auditFile, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  check(afterConcurrentReplayAudit.filter(row => row.type === LISTING_BIND_RECOVERY_AUDIT_TYPE && row.task?.id === postCommitFailTask.id).length === 1, 'Concurrent replay appends exactly one recovery audit');

  // Step 4: Rejection if task has write slot true or publishResult not null
  const rejectProc = spawn(process.execPath, [
    'scripts/bi_ops_cli.mjs',
    'recover-uploaded-asset-binding',
    '--base-url', 'http://127.0.0.1:' + portalPort,
    '--session-file', sessionFile,
    '--task-id', 'task-dirty-001',
    '--prepare-batch-id', PREPARE_BATCH_ID,
    ...uploadedImageCliArgs(),
    '--confirm', RECOVER_UPLOADED_ASSET_BINDING_CONFIRM_TEXT,
  ], {cwd: ROOT, env: {...process.env, SHEIN_BI_KNOWLEDGE_CACHE_DIR: knowledgeCacheDir, SHEIN_BI_PARTNER_CHECK_TTL_MS: '0'}});

  let rejectOut = '';
  rejectProc.stdout.on('data', d => { rejectOut += d.toString(); });
  rejectProc.stderr.on('data', d => { rejectOut += d.toString(); });
  const rejectExit = await new Promise(r => rejectProc.on('exit', r));
  check(rejectExit === 1, 'Dirty task recovery rejected with exit code 1');
  const rejectData = JSON.parse(rejectOut);
  check(rejectData.ok === false, 'Dirty task recovery ok is false');

  console.log('All ' + checksPassed + ' end-to-end recovery contract assertions passed cleanly.');
} finally {
  portalProc.kill();
  await fs.rm(tmpRoot, {recursive: true, force: true}).catch(() => {});
}
