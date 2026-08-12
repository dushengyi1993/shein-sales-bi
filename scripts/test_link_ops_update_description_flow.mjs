#!/usr/bin/env node
/**
 * Phase B integration smoke for historical update_description backfill.
 *
 * Spins up an isolated fake SHEIN OpenAPI server and an isolated BI portal
 * (json store gateway) and proves the complete closed loop:
 *   - legacy unique section#s9 (exactly 3 code blocks mapped uniquely to
 *     en/ar/zh-cn) is verified server-side and bound to an independent
 *     update_description task; the historical publish task is only source
 *     evidence and is never modified;
 *   - the partialEdit body is minimal (spu_name + multi_language_desc_list),
 *     and any persisted executor output / task record / audit carries only
 *     hashes/counts, never description text (real body is in-memory only);
 *   - dry-run locks the exact payload hash and records the live preflight
 *     baseline (spu-info identity + current description hash,
 *     query-document-state, check-edit-permission);
 *   - execute requires the durable CAS write-claim (nonce/taskId/hash/op),
 *     re-runs the live gates (audit in progress / drift / not editable
 *     stop), and success requires code=0 AND info.success===true AND a
 *     non-empty info.version;
 *   - readback requires spu-info description hash byte-exact match;
 *     mismatch/missing -> submitted_readback_pending (manual resolve),
 *     missing version -> update_description_submitted_unconfirmed, and an
 *     active claim blocks repeated partialEdit.
 */
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  verifyDescriptionMaterialAgainstHtml,
  extractTrilingualCoreSellingPointsAuto,
} from '../lib/link_ops_description_material_extract.mjs';
import {
  describeDescriptionMaterial,
  sha256Utf8,
  sha256StableJson,
} from '../lib/link_ops_product_descriptions.mjs';
import {stripLinkOpsRepositoryMetadata} from '../lib/link_ops_repository.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = path.join(ROOT, 'tmp');
await fs.mkdir(tmpBase, {recursive: true});
const tmpRoot = await fs.mkdtemp(path.join(tmpBase, 'bi-ops-update-description-'));
const CONFIRM_TEXT = 'SHEIN_OPENAPI_SUBMIT';

const enLines = ['EN selling point one', 'EN selling point two', 'EN selling point three', 'EN selling point four', 'EN selling point five'];
const arLines = ['سطر أول', 'سطر ثانٍ', 'سطر ثالث', 'سطر رابع', 'سطر خامس'];
const zhLines = ['中文卖点一', '中文卖点二', '中文卖点三', '中文卖点四', '中文卖点五'];
const oldEnLines = ['OLD EN one', 'OLD EN two', 'OLD EN three', 'OLD EN four', 'OLD EN five'];
const oldArLines = ['سطر قديم أول', 'سطر قديم ثانٍ', 'سطر قديم ثالث', 'سطر قديم رابع', 'سطر قديم خامس'];
const code = lines => `<code>${lines.join('\n')}</code>`;
const legacyHtmlMaterial = `<!doctype html><html><body>
<section id="s9">
  <h3>三语核心卖点（英文、阿文、中文）</h3>
  ${code(enLines)}
  ${code(arLines)}
  ${code(zhLines)}
</section>
</body></html>`;
const newHtmlMaterial = `<!doctype html><html><body>
<section id="s09">
  <article class="card"><h3>英文</h3>${code(enLines)}</article>
  <article class="card"><h3>阿文</h3>${code(arLines)}</article>
  <div class="displaybox">${zhLines.map(line => `<div>${line}</div>`).join('')}</div>
</section>
</body></html>`;
const legacySourceBytes = Buffer.from(legacyHtmlMaterial, 'utf8');
const material = verifyDescriptionMaterialAgainstHtml(legacyHtmlMaterial, legacySourceBytes, {
  sourceFileBasename: 'SK-13015-legacy-review.html',
  sourceFileSha256: '',
  section: 's9',
}).material;
const materialSummary = describeDescriptionMaterial(material);
const autoDetected = extractTrilingualCoreSellingPointsAuto(legacyHtmlMaterial);

const SPU = 'r24152505587';

const checks = [];
const ownedTaskIds = new Set();
let fatalError = null;
function check(label, actual, expected) {
  const pass = typeof expected === 'function' ? expected(actual) : actual === expected;
  checks.push({label, actual, expected: typeof expected === 'function' ? (expected.name || 'predicate') : expected, pass});
  return pass;
}
function asArray(value) { return Array.isArray(value) ? value : []; }

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}
async function writeJson(name, value) {
  const file = path.join(tmpRoot, name);
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
  return file;
}
function sendJson(res, value, status = 200) {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'});
  res.end(JSON.stringify(value));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch {}
      resolve({text, json});
    });
    req.on('error', reject);
  });
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// --- fake OpenAPI server ---
const fakeOpenApiCalls = [];
const partialEditMode = {mode: 'success'};
const partialEditDelayMs = {value: 0};
const docStateMode = {state: 2, version: 'V1'};
const editPermissionMode = {editable: true};
const liveDescriptions = new Map();
const partialEditBodies = [];

function liveDescFor(spu) {
  if (!liveDescriptions.has(spu)) {
    liveDescriptions.set(spu, {ar: oldArLines.join('\n'), en: oldEnLines.join('\n')});
  }
  return liveDescriptions.get(spu);
}

const fakeOpenApiPort = await getFreePort();
const fakeOpenApi = http.createServer(async (req, res) => {
  const body = await readBody(req);
  fakeOpenApiCalls.push({path: req.url.split('?')[0], method: req.method, body: body.json || body.text});
  const pathname = req.url.split('?')[0];
  if (pathname === '/open-api/openapi-business-backend/query-store-info') {
    return sendJson(res, {code: '0', msg: 'OK', info: {accountNo: 'GS5159206', merchantId: '6745755', companyName: '南墨', shopName: 'Desc Backfill NM'}});
  }
  if (pathname === '/open-api/goods/query-site-list') {
    return sendJson(res, {code: '0', msg: 'OK', info: [{main_site: 'shein', main_site_name: 'SHEIN', sub_site_list: [{site_abbr: 'shein-sa', site_name: 'SHEIN Saudi Arabia', currency: 'SAR', site_status: 1}]}]});
  }
  if (pathname === '/open-api/goods/searchProduct') {
    const requested = [
      ...asArray(body.json?.spuNameList),
      ...asArray(body.json?.skcNameList),
      ...asArray(body.json?.skuCodeList),
      ...asArray(body.json?.supplierSkuList),
    ].map(String);
    if (requested.some(value => value === SPU || value.toLowerCase() === SPU)) {
      return sendJson(res, {code: '0', msg: 'OK', info: {list: [{spuName: SPU, skcList: [{skcName: 's' + SPU, skuList: [{skuCode: `${SPU}-SKU`}]}]}], count: 1}});
    }
    return sendJson(res, {code: '0', msg: 'OK', info: null});
  }
  if (pathname === '/open-api/goods/spu-info') {
    const spuName = String(body.json?.spuName || '');
    const live = liveDescFor(spuName);
    return sendJson(res, {code: '0', msg: 'OK', info: {
      spuName,
      productMultiDescList: [
        {language: 'ar', productDesc: live.ar},
        {language: 'en', productDesc: live.en},
      ],
      skcInfoList: [{skcName: 's' + spuName, skuInfoList: [{skuCode: `${spuName}-SKU`}]}],
    }});
  }
  if (pathname === '/open-api/goods/query-document-state') {
    const spuName = String(body.json?.spuList?.[0]?.spuName || '');
    const docVersion = String(docStateMode.version || '').trim();
    return sendJson(res, {code: '0', msg: 'OK', info: {data: [{
      spuName,
      ...(docVersion ? {version: docVersion} : {}),
      skcList: [{skcName: 's' + spuName, documentState: docStateMode.state, ...(docVersion ? {version: docVersion} : {})}],
    }], meta: {count: 1}}});
  }
  if (pathname === '/open-api/goods/product/check-edit-permission') {
    return sendJson(res, {
      code: '0',
      msg: 'OK',
      info: editPermissionMode.editable
        ? {editable: true}
        : {editable: false, reason: 'SPU下存在审核中的SKC，请在审核完成后再进行编辑。'},
    });
  }
  if (pathname === '/open-api/goods/product/partialEdit') {
    const payload = body.json || {};
    partialEditBodies.push(payload);
    const spuName = String(payload.spu_name || '');
    const rows = asArray(payload.multi_language_desc_list);
    if (partialEditDelayMs.value > 0) await sleep(partialEditDelayMs.value);
    if (partialEditMode.mode === 'success_false') {
      return sendJson(res, {code: '0', msg: 'OK', info: {success: false, pre_valid_result: [{form: 'desc', messages: ['校验不通过']}]}});
    }
    if (partialEditMode.mode === 'no_version') {
      return sendJson(res, {code: '0', msg: 'OK', info: {success: true}});
    }
    if (partialEditMode.mode === 'missing_success') {
      return sendJson(res, {code: '0', msg: 'OK', info: {}});
    }
    if (partialEditMode.mode === 'readback_drift') {
      liveDescriptions.set(spuName, {ar: arLines.join('\n'), en: ['drifted first line', ...enLines.slice(1)].join('\n')});
      docStateMode.state = 1;
      docStateMode.version = 'SPMP-BACKFILL-V1';
      return sendJson(res, {code: '0', msg: 'OK', info: {success: true, version: 'SPMP-BACKFILL-V1'}});
    }
    if (partialEditMode.mode === 'success_no_doc_version') {
      liveDescriptions.set(spuName, {
        ar: String(rows.find(row => row.language === 'ar')?.name || ''),
        en: String(rows.find(row => row.language === 'en')?.name || ''),
      });
      // Post-write the document moves to audit (state 1) but exposes NO
      // version field: the state change alone must not be attributed to this
      // submission.
      docStateMode.state = 1;
      docStateMode.version = '';
      return sendJson(res, {code: '0', msg: 'OK', info: {success: true, version: 'SPMP-BACKFILL-V1'}});
    }
    liveDescriptions.set(spuName, {
      ar: String(rows.find(row => row.language === 'ar')?.name || ''),
      en: String(rows.find(row => row.language === 'en')?.name || ''),
    });
    docStateMode.state = 1;
    docStateMode.version = 'SPMP-BACKFILL-V1';
    return sendJson(res, {code: '0', msg: 'OK', info: {success: true, version: 'SPMP-BACKFILL-V1'}});
  }
  if (pathname === '/open-api/openapi-business-backend/product/query') {
    return sendJson(res, {code: '0', msg: 'OK', info: {data: [{spuName: SPU, skcName: 's' + SPU, skuCodeList: [`${SPU}-SKU`]}]}});
  }
  return sendJson(res, {code: '0', msg: 'OK', info: null});
});
await new Promise(resolve => fakeOpenApi.listen(fakeOpenApiPort, '127.0.0.1', resolve));

// --- portal config ---
const authFile = await writeJson('auth.json', {
  users: [{
    username: 'owner_desc_backfill',
    password: 'owner-pass',
    displayName: 'Owner Desc Backfill',
    role: 'owner',
    readStores: ['*'],
    writeStores: ['*'],
    ownerKey: 'OWNER_DESC_BACKFILL',
  }],
});
const accessRolesFile = await writeJson('access_roles.json', {
  defaults: {owner: {readStores: ['*'], writeStores: ['*']}, operator: {readStores: ['*'], writeStores: []}},
});
const openapiConfigFile = await writeJson('openapi.json', {
  environment: 'update-description-smoke',
  cooperationMode: '半托管',
  market: 'SA',
  apiBaseUrls: {prodSemiManaged: `http://127.0.0.1:${fakeOpenApiPort}`},
  stores: [{
    storeKey: 'NM',
    shopName: 'Desc Backfill NM',
    enabled: true,
    openKeyId: 'dummy-open-key-nm',
    secretKey: 'dummy-secret-nm',
    authorizedAt: '2026-06-27T00:00:00.000+08:00',
  }],
  safeWriteOperations: {
    enabled: true,
    requireDryRun: true,
    allowedOperations: ['update_description'],
    allowedStores: ['NM'],
  },
});
const whitelistFile = await writeJson('whitelist.json', {
  enabled: true,
  rules: [{
    id: 'owner-nm-update-description',
    enabled: true,
    realSubmit: true,
    stores: ['NM'],
    operations: ['update_description'],
    allowedUsers: ['owner_desc_backfill'],
    allowedOwnerKeys: ['OWNER_DESC_BACKFILL'],
    allowedRoles: ['owner'],
  }],
});
const readProbeSummaryFile = await writeJson('read-probes.latest.json', {
  generatedAt: new Date().toISOString(),
  counts: {total: 1, readProbeOk: 1, pending: 0, failed: 0},
  results: [{storeKey: 'NM', ok: true, status: 'read_probe_ok'}],
});
const htpasswdFile = path.join(tmpRoot, 'empty.htpasswd');
await fs.writeFile(htpasswdFile, '', 'utf8');
const stateFile = path.join(tmpRoot, 'action_state.json');
const taskFile = path.join(tmpRoot, 'tasks.json');
const chatFile = path.join(tmpRoot, 'chats.json');
const auditFile = path.join(tmpRoot, 'audit.jsonl');
const sessionSecretFile = path.join(tmpRoot, 'session_secret');
const manualLoginStateFile = path.join(tmpRoot, 'manual_login.json');
const portalDir = path.join(tmpRoot, 'portal');
await fs.mkdir(portalDir, {recursive: true});
await fs.writeFile(path.join(portalDir, 'index.html'), '<!doctype html><html><body>update-description-test-portal</body></html>', 'utf8');

const PORTAL_BASE_ENV = {
  NODE_ENV: 'test',
  SHEIN_LINK_OPS_STORE: 'json',
  SHEIN_WEBHOOK_REPOSITORY_ENABLED: '0',
  SHEIN_BI_LIVE_UPDATES_ENABLED: '0',
  SHEIN_BI_LIVE_ACCOUNTING_ENABLED: '0',
  SHEIN_BI_EXTERNAL_SECTION_QUEUE_ENABLED: '0',
  SHEIN_BI_TEST_ALLOW_FAKE_WEBHOOK_GATE: '1',
  SHEIN_BI_CORE_WARMUP_DISABLED: '1',
  SHEIN_BI_INTENT_PLANNER_ENABLED: '0',
  SHEIN_BI_JOB_WORKER_ENABLED: '0',
  SHEIN_OWNER_KNOWLEDGE_GIT_REPO_DIR: '',
  SHEIN_OPENAPI_CONFIG_FILE: openapiConfigFile,
  SHEIN_BI_OPS_WRITE_WHITELIST_FILE: whitelistFile,
  SHEIN_OPENAPI_READ_PROBE_SUMMARY_FILE: readProbeSummaryFile,
  SHEIN_LINK_OPS_OPENAPI_EXECUTOR_TIMEOUT_MS: '30000',
  SHEIN_LINK_OPS_MAINTENANCE_OUT_DIR: path.join(tmpRoot, 'executor-output'),
  // Windows has no POSIX mode bits; the test channel explicitly opts into the
  // unverified permission model. POSIX runs still enforce 0700/0600 + stat.
  SHEIN_LINK_OPS_TEST_ALLOW_UNVERIFIED_MATERIAL_PERMS: '1',
};

async function startPortalInstance(extraEnv = {}) {
  const port = await getFreePort();
  const instance = spawn(process.execPath, [
    'scripts/serve_bi_portal.mjs',
    '--host', '127.0.0.1',
    '--port', String(port),
    '--auth-file', authFile,
    '--access-roles-file', accessRolesFile,
    '--htpasswd-file', htpasswdFile,
    '--session-secret-file', sessionSecretFile,
    '--state-file', stateFile,
    '--link-ops-task-file', taskFile,
    '--link-ops-chat-file', chatFile,
    '--manual-login-state-file', manualLoginStateFile,
    '--audit-file', auditFile,
    '--dir', portalDir,
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...PORTAL_BASE_ENV,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = {value: ''};
  const stderr = {value: ''};
  instance.stdout.on('data', d => { stdout.value += d.toString(); });
  instance.stderr.on('data', d => { stderr.value += d.toString(); });
  spawnedPortals.push({portal: instance, base: `http://127.0.0.1:${port}`, stdout, stderr});
  const instanceBase = `http://127.0.0.1:${port}`;
  await waitReadyAt(instanceBase);
  return {portal: instance, base: instanceBase, port, stdout, stderr};
}

async function waitForProcessExit(child, timeoutMs = 3000) {
  if (!child || child.exitCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

async function reqAt(baseUrl, pathname, {method = 'GET', cookie = '', body = undefined} = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(body !== undefined ? {'Content-Type': 'application/json'} : {}),
      ...(cookie ? {Cookie: cookie} : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return {status: res.status, headers: res.headers, text, json};
}
async function req(pathname, options = {}) {
  return reqAt(base, pathname, options);
}
async function waitReadyAt(baseUrl) {
  for (let i = 0; i < 120; i += 1) {
    try {
      const r = await reqAt(baseUrl, '/api/health');
      if (r.status === 200) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`portal not ready: ${baseUrl}`);
}
async function waitReady() {
  return waitReadyAt(base);
}
async function loginAt(baseUrl) {
  const r = await reqAt(baseUrl, '/api/login', {method: 'POST', body: {username: 'owner_desc_backfill', password: 'owner-pass'}});
  const setCookie = r.headers.get('set-cookie') || '';
  const cookie = (setCookie.match(/bi_session=[^;]+/) || [''])[0];
  if (r.status !== 200 || !cookie) throw new Error(`login failed: status=${r.status}`);
  return cookie;
}
async function login() {
  return loginAt(base);
}
async function rawTaskById(id) {
  const data = JSON.parse(await fs.readFile(taskFile, 'utf8').catch(() => '{"tasks":[]}'));
  return asArray(data?.tasks).find(task => String(task?.id || '') === String(id || '')) || null;
}
async function rawStore() {
  return JSON.parse(await fs.readFile(taskFile, 'utf8').catch(() => '{"tasks":[]}'));
}
async function attachPayload(taskId, payload) {
  const data = await rawStore();
  const tasks = asArray(data.tasks);
  const index = tasks.findIndex(task => String(task?.id || '') === String(taskId || ''));
  if (index < 0) throw new Error(`task not found for attach: ${taskId}`);
  tasks[index] = {...tasks[index], openapiPublishPayload: JSON.parse(JSON.stringify(payload))};
  await fs.writeFile(taskFile, JSON.stringify({...data, tasks}, null, 2), 'utf8');
}
async function updateRawTaskById(taskId, update) {
  const data = await rawStore();
  const tasks = asArray(data.tasks);
  const index = tasks.findIndex(task => String(task?.id || '') === String(taskId || ''));
  if (index < 0) throw new Error(`task not found for update: ${taskId}`);
  tasks[index] = update(tasks[index]);
  await fs.writeFile(taskFile, JSON.stringify({...data, tasks}, null, 2), 'utf8');
  return tasks[index];
}
async function createSourceTask(cookie, {baseUrl = base} = {}) {
  const r = await reqAt(baseUrl, '/api/link-ops-tasks', {
    method: 'POST',
    cookie,
    body: {
      command: `复制上品/补链接 SK-13015 到 NM（历史来源 ${SPU}）`,
      source: 'codex_desktop_cli_structured',
      intents: ['copy_product_draft'],
      targets: {stores: ['NM'], writeStores: ['NM'], productRefs: ['SK-13015']},
    },
  });
  if (r.status !== 200) throw new Error(`create source task failed: ${r.status} ${r.text}`);
  const id = r.json?.task?.id || r.json?.data?.tasks?.[0]?.id || '';
  if (id) ownedTaskIds.add(id);
  await attachPayload(id, {
    spu_name: SPU,
    multi_language_name_list: [{language: 'en', product_name: 'Historical source product'}],
    skc_list: [{supplier_code: 'SK-13015', skc_name: 'SK-13015'}],
  });
  return id;
}
async function createUpdateDescriptionTask(cookie, {sourceTaskId, spu = SPU, baseUrl = base} = {}) {
  const r = await reqAt(baseUrl, '/api/link-ops-tasks', {
    method: 'POST',
    cookie,
    body: {
      command: `历史商品描述回填：NM 店 SPU ${spu}（来源 ${sourceTaskId}）`,
      source: 'codex_desktop_cli_structured_update_description',
      intents: ['update_description'],
      targets: {stores: ['NM'], writeStores: ['NM'], productRefs: [spu]},
      parameters: {sourceTaskId, spuName: spu},
    },
  });
  if (r.status !== 200) throw new Error(`create update-description task failed: ${r.status} ${r.text}`);
  const id = r.json?.task?.id || r.json?.data?.tasks?.[0]?.id || '';
  if (id) ownedTaskIds.add(id);
  return id;
}
async function bindUpdateDescription(cookie, taskId, {
  sourceFileBytes = legacySourceBytes,
  sourceFileName = 'SK-13015-legacy-review.html',
  section = 's9',
  expectedRevision = null,
  sourceApproved = true,
  baseUrl = base,
} = {}) {
  const task = await rawTaskById(taskId);
  const revision = expectedRevision ?? Number(task?.repositoryRevision || 0);
  return reqAt(baseUrl, '/api/link-ops-prepare-update-description', {
    method: 'POST',
    cookie,
    body: {
      taskId,
      store: 'NM',
      sourceApproved,
      sourceFile: {name: sourceFileName, dataBase64: Buffer.from(sourceFileBytes).toString('base64')},
      section,
      expectedRevision: revision,
    },
  });
}
async function dryRunTask(cookie, taskId) {
  return req('/api/link-ops-execute', {method: 'POST', cookie, body: {id: taskId, mode: 'dry-run', source: 'test'}});
}
async function executeTask(cookie, taskId) {
  return req('/api/link-ops-execute', {
    method: 'POST',
    cookie,
    body: {id: taskId, mode: 'execute', confirm: CONFIRM_TEXT, source: 'test'},
  });
}
async function executorDirectRun(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      'scripts/link_ops_maintenance_openapi_executor.mjs',
      '--out-dir', path.join(tmpRoot, 'executor-output'),
      ...args,
    ], {
      cwd: ROOT,
      env: {...process.env, NODE_ENV: 'test'},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('executor timeout')); }, 40_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      let json = null;
      try { json = stdout.trim() ? JSON.parse(stdout) : null; } catch {}
      resolve({code, stdout, stderr, json});
    });
  });
}
async function snapshotTask(taskId, executionContext = {}) {
  const task = await rawTaskById(taskId);
  const file = path.join(tmpRoot, `snapshot-${taskId}.json`);
  await fs.writeFile(file, JSON.stringify({version: 1, updatedAt: new Date().toISOString(), executionContext, tasks: [task]}, null, 2), 'utf8');
  return file;
}
async function storedPayloadFor(taskId) {
  const task = await rawTaskById(taskId);
  const ref = task?.descriptionUpdatePayloadRef;
  if (!ref || !ref.relativePath) return null;
  const file = path.join(ROOT, String(ref.relativePath).replace(/\\/g, '/'));
  const bytes = await fs.readFile(file, 'utf8').catch(() => '');
  if (!bytes) return null;
  return JSON.parse(bytes);
}

let portal = null;
let base = '';
let portalPort = 0;
let portalStdout = '';
let portalStderr = '';
const spawnedPortals = [];
const materialDir = path.join(ROOT, 'state/description-material');
try {
  const mainPortal = await startPortalInstance({});
  portal = mainPortal.portal;
  base = mainPortal.base;
  portalPort = mainPortal.port;
  portalStdout = mainPortal.stdout.value;
  portalStderr = mainPortal.stderr.value;
  await waitReady();
  const cookie = await login();

  check('legacy s9 auto detection', autoDetected.sectionUsed, 's9');
  check('legacy s9 material has 3 languages', Object.keys(material.rows).sort().join(','), 'ar,en,zh-cn');
  check('legacy s9 en lines', material.rows.en.lines.length, 5);

  // ---------- bind path ----------
  const sourceTaskId = await createSourceTask(cookie);
  const sourceRawBefore = await rawTaskById(sourceTaskId);
  const sourceBusinessBefore = JSON.stringify(stripLinkOpsRepositoryMetadata(sourceRawBefore));

  const taskId = await createUpdateDescriptionTask(cookie, {sourceTaskId});
  const bind = await bindUpdateDescription(cookie, taskId);
  check('update-description bind 200', bind.status, 200);
  check('update-description bind committed + readback verified', bind.json?.bindingCommitted === true && bind.json?.readbackVerified === true, true);
  check('update-description bind stage verified', bind.json?.stage, 'binding_committed_verified');
  check('bind targetSpu', String(bind.json?.binding?.targetSpu || '').toLowerCase(), SPU);
  check('bind sourceTaskId', String(bind.json?.binding?.sourceTaskId || ''), sourceTaskId);
  check('bind sourceProof legacy s9', bind.json?.binding?.sourceProof, 'server_verified_html_section_s9');
  check('bind newPayloadHash 64', String(bind.json?.binding?.newPayloadHash || '').length, 64);

  const raw = await rawTaskById(taskId);
  const payload = await storedPayloadFor(taskId);
  check('bound payload material file exists', payload !== null, true);
  check('task record stores ref pointer only', raw.descriptionUpdatePayloadRef?.relativePath.startsWith('state/description-material/'), true);
  check('task record has no plaintext description payload', Object.prototype.hasOwnProperty.call(raw, 'descriptionUpdatePayload'), false);
  check('bound payload is minimal', Object.keys(payload).sort().join(','), 'multi_language_desc_list,spu_name');
  check('bound payload spu_name', payload.spu_name.toLowerCase(), SPU);
  check('bound payload rows ar/en', payload.multi_language_desc_list.map(row => row.language).join(','), 'ar,en');
  check('bound payload en name joins 5 lines', payload.multi_language_desc_list[1].name, enLines.join('\n'));
  check('bound payload has no title/image/attribute keys', JSON.stringify(payload), text => !/title|image|attribute/i.test(text));
  check('bind records source task evidence', raw.descriptionSourceTaskEvidence?.sourceTaskId, sourceTaskId);
  check('bind resets execution state', raw.execution?.state, 'needs_repreflight');
  check('bind clears maintenance executors', asArray(raw.execution?.linkMaintenanceExecutors).length, 0);
  check('bind clears write claim', raw.execution?.writeClaim, null);
  check('binding exact key set', Object.keys(raw.descriptionMaterialBinding).sort().join(','), [
    'authority', 'baseTaskRevision', 'bindingRequestKey', 'boundAt', 'boundByUser', 'contentSha256',
    'hashes', 'kind', 'lineCounts', 'newPayloadHash', 'payloadHashAlgorithm', 'publishLanguages',
    'schemaVersion', 'sourceApproved', 'sourceByteLength', 'sourceFileSha256', 'sourceLabel',
    'sourceProof', 'targetSpu', 'targetStore',
  ].sort().join(','));
  check('source task business content untouched after bind', JSON.stringify(stripLinkOpsRepositoryMetadata(await rawTaskById(sourceTaskId))), sourceBusinessBefore);

  const auditText = await fs.readFile(auditFile, 'utf8');
  const boundAudit = auditText.split('\n').filter(line => line.includes('link-ops-prepare-update-description-bound') && line.includes(taskId));
  check('audit has bound entry', boundAudit.length, 1);
  check('audit never stores description text', boundAudit.join(''), text => !text.includes('selling point') && !text.includes('سطر') && !text.includes('中文卖点'));

  // bind gates
  const noApproval = await bindUpdateDescription(cookie, taskId, {sourceApproved: false});
  check('bind without sourceApproved rejected', noApproval.status, 400);
  const staleBind = await bindUpdateDescription(cookie, taskId, {expectedRevision: 999});
  check('bind stale revision -> 409', staleBind.status, 409);
  check('bind stale revision code', staleBind.json?.code, 'LINK_OPS_REVISION_CONFLICT');
  const missingSource = await createUpdateDescriptionTask(cookie, {sourceTaskId: 'lot_missing_source'});
  const missingSourceBind = await bindUpdateDescription(cookie, missingSource);
  check('bind missing source task -> 404', missingSourceBind.status, 404);
  const wrongIntentTask = await createUpdateDescriptionTask(cookie, {sourceTaskId});
  await updateRawTaskById(wrongIntentTask, task => ({...task, intents: ['update_description', 'update_title']}));
  const wrongIntentBind = await bindUpdateDescription(cookie, wrongIntentTask);
  check('bind mixed intents -> 409', wrongIntentBind.status, 409);

  // ---------- dry-run: locked hash + live preflight + sanitized persistence ----------
  const dry = await dryRunTask(cookie, taskId);
  const dryExec = dry.json?.task?.execution || {};
  check('dry-run state ready', dryExec.state, 'link_maintenance_preflight_ready');
  check('dry-run preflight ok', dryExec.preflight?.ok, true);
  const dryRaw = await rawTaskById(taskId);
  const dryRunRecord = asArray(dryRaw.execution?.linkMaintenanceExecutors || [])[0] || {};
  check('dry-run payload hash locked', String(dryRunRecord.payload?.payloadHash || '').length, 64);
  check('dry-run records description preflight', dryRunRecord.adapterEvidence?.descriptionPreflight?.spu, SPU);
  check('dry-run preflight identity ok', dryRunRecord.adapterEvidence?.descriptionPreflight?.spuInfoIdentity, SPU);
  check('dry-run preflight document state', dryRunRecord.adapterEvidence?.descriptionPreflight?.documentState, '2');
  check('dry-run preflight editable', dryRunRecord.adapterEvidence?.descriptionPreflight?.editable, true);
  check('dry-run preflight current hashes recorded', String(dryRunRecord.adapterEvidence?.descriptionPreflight?.currentDescriptionHashes?.en || '').length, 64);
  const rawTaskText = await fs.readFile(taskFile, 'utf8');
  check('task record never contains description text', rawTaskText, text => !text.includes('selling point one') && !text.includes('سطر أول') && !text.includes('中文卖点一'));
  const executorOutDir = PORTAL_BASE_ENV.SHEIN_LINK_OPS_MAINTENANCE_OUT_DIR;
  const executorOutFiles = (await fs.readdir(executorOutDir).catch(() => []))
    .filter(name => name.endsWith('.local.json'))
    .map(name => path.join(executorOutDir, name));
  const executorOutTexts = [];
  for (const file of executorOutFiles) {
    executorOutTexts.push(await fs.readFile(file, 'utf8'));
  }
  const executorOutText = executorOutTexts.join('\n');
  check('executor output files written this run', executorOutTexts.length >= 1, true);
  check('executor output never contains description text', executorOutText, text => !text.includes('selling point one') && !text.includes('سطر أول') && !text.includes('中文卖点一'));
  const persistedSubmitPlans = executorOutTexts.map(text => JSON.parse(text).payload?.submitPlan).filter(Boolean);
  check('persisted submitPlan payload sanitized', persistedSubmitPlans.some(plan => plan.payloads?.[0]?.body?.sanitized === 'hash-count-only'), true);
  check('persisted submitPlan body hash only', persistedSubmitPlans.some(plan => String(plan.payloads?.[0]?.body?.bodyHash || '').length === 64), true);

  // ---------- direct executor without claim is blocked ----------
  partialEditBodies.length = 0;
  const directSnapshot = await snapshotTask(taskId, {
    expectedPayloadHash: dryRunRecord.payload?.payloadHash || '',
    writeClaim: null,
  });
  const direct = await executorDirectRun([
    '--config', openapiConfigFile,
    '--task-json', directSnapshot,
    '--task-id', taskId,
    '--store', 'NM',
    '--execute',
    '--confirm', CONFIRM_TEXT,
  ]);
  check('direct execute without claim blocked', direct.json?.state, 'blocked');
  check('direct execute blocker mentions write-claim', JSON.stringify(direct.json?.blockers || []), text => text.includes('write-claim'));
  check('direct execute never called partialEdit', partialEditBodies.length, 0);

  // ---------- execute with portal claim: success + exact readback ----------
  partialEditMode.mode = 'success';
  partialEditBodies.length = 0;
  const exec = await executeTask(cookie, taskId);
  check('execute http 200', exec.status, 200);
  const execTask = exec.json?.task || {};
  check('execute lifecycle matched', execTask.lifecycle?.lifecycleStatus, 'submitted_readback_matched');
  const execRaw = await rawTaskById(taskId);
  const execRun = asArray(execRaw.execution?.linkMaintenanceExecutors || []).find(run => String(run?.mode || '').includes('execute')) || asArray(execRaw.execution?.linkMaintenanceExecutors || [])[0] || {};
  check('execute write claim completed', execRaw.execution?.writeClaim?.state, 'completed');
  check('execute write claim nonce persisted', String(execRaw.execution?.writeClaim?.nonce || '').length, 32);
  check('execute partialEdit called once', partialEditBodies.length, 1);
  check('execute partialEdit body minimal', Object.keys(partialEditBodies[0] || {}).sort().join(','), 'multi_language_desc_list,spu_name');
  check('execute preserves exact lowercase platform SPU', partialEditBodies[0]?.spu_name, SPU);
  check('execute readback matched status', String(execRun.readback?.status || ''), 'description_readback_matched');
  const readbackFingerprint = execRun.readback?.groups?.[0]?.fingerprint || {};
  check('readback before/after fingerprint hashes', String(readbackFingerprint.beforeHashes?.en || '').length === 64 && String(readbackFingerprint.afterHashes?.en || '').length === 64, true);
  check('readback after hash equals binding en hash', readbackFingerprint.afterHashes?.en, materialSummary.hashes.en);
  check('readback carries partialEdit version', readbackFingerprint.submittedVersion, 'SPMP-BACKFILL-V1');
  check('readback version causal', readbackFingerprint.versionCausal, true);
  check('readback doc-state transition verified', readbackFingerprint.documentStateTransitionVerified, true);
  check('readback doc-state after is audit', readbackFingerprint.documentStateAfter, '1');
  check('readback doc-state version correlates', execRun.readback?.groups?.[0]?.documentStateEvidence?.versionMatched, true);
  docStateMode.state = 2;
  docStateMode.version = 'V1';

  // pre-equal no-op: live content already equals target -> dry-run marks
  // already_matched, execute skips the write entirely and can never use the
  // readback to prove submission.
  const taskAlreadyMatched = await createUpdateDescriptionTask(cookie, {sourceTaskId});
  await bindUpdateDescription(cookie, taskAlreadyMatched);
  const alreadyMatchedDry = await dryRunTask(cookie, taskAlreadyMatched);
  check('already-matched dry-run state', alreadyMatchedDry.json?.task?.execution?.state, 'update_description_already_matched');
  check('already-matched dry-run lifecycle', alreadyMatchedDry.json?.task?.lifecycle?.lifecycleStatus, 'description_already_matched');
  const alreadyMatchedRaw = await rawTaskById(taskAlreadyMatched);
  check('already-matched dry-run executor state recorded', asArray(alreadyMatchedRaw.execution?.linkMaintenanceExecutors || [])[0]?.state, 'update_description_already_matched');
  partialEditBodies.length = 0;
  const alreadyMatchedExec = await executeTask(cookie, taskAlreadyMatched);
  check('already-matched execute lifecycle', alreadyMatchedExec.json?.task?.lifecycle?.lifecycleStatus, 'description_already_matched');
  check('already-matched execute never called partialEdit', partialEditBodies.length, 0);
  check('already-matched execute not submitted', alreadyMatchedExec.json?.task?.execution?.writeAudit?.actualWriteSubmitted, false);
  const alreadyMatchedExecRaw = await rawTaskById(taskAlreadyMatched);
  check('already-matched claim released', alreadyMatchedExecRaw.execution?.writeClaim?.state, 'released');
  check('already-matched execution state', alreadyMatchedExecRaw.execution?.state, 'update_description_already_matched');
  liveDescriptions.delete(SPU);

  // query-document-state WITHOUT any version field can never produce matched:
  // a status transition alone cannot be attributed to this submission.
  const taskNoDocVersion = await createUpdateDescriptionTask(cookie, {sourceTaskId});
  await bindUpdateDescription(cookie, taskNoDocVersion);
  await dryRunTask(cookie, taskNoDocVersion);
  partialEditMode.mode = 'success_no_doc_version';
  partialEditBodies.length = 0;
  const execNoDocVersion = await executeTask(cookie, taskNoDocVersion);
  check('doc-state no-version lifecycle not matched', execNoDocVersion.json?.task?.lifecycle?.lifecycleStatus, 'submitted_readback_failed');
  const execNoDocVersionRaw = await rawTaskById(taskNoDocVersion);
  const execNoDocVersionRun = asArray(execNoDocVersionRaw.execution?.linkMaintenanceExecutors || []).find(run => String(run?.mode || '').includes('execute')) || asArray(execNoDocVersionRaw.execution?.linkMaintenanceExecutors || [])[0] || {};
  check('doc-state no-version readback status', String(execNoDocVersionRun.readback?.status || ''), 'description_readback_document_state_unverified');
  check('doc-state no-version state transition observed', execNoDocVersionRun.readback?.groups?.[0]?.documentStateEvidence?.afterStateSet, '1');
  check('doc-state no-version versionMatched false', execNoDocVersionRun.readback?.groups?.[0]?.documentStateEvidence?.versionMatched, false);
  check('doc-state no-version evidence not ok without version', execNoDocVersionRun.readback?.groups?.[0]?.documentStateEvidence?.ok, false);
  check('doc-state no-version claim unconfirmed', execNoDocVersionRaw.execution?.writeClaim?.state, 'unconfirmed');
  check('doc-state no-version manual resolve', execNoDocVersionRaw.lifecycle?.needsManualResolve, true);
  check('doc-state no-version partialEdit was attempted', partialEditBodies.length, 1);
  docStateMode.version = 'V1';
  docStateMode.state = 2;
  partialEditMode.mode = 'success';
  liveDescriptions.delete(SPU);

  // active claim blocks a second execute before any write
  partialEditBodies.length = 0;
  const taskB = await createUpdateDescriptionTask(cookie, {sourceTaskId});
  const bindB = await bindUpdateDescription(cookie, taskB);
  check('second task bind ok', bindB.status, 200);
  await dryRunTask(cookie, taskB);
  await updateRawTaskById(taskB, task => ({
    ...task,
    execution: {...(task.execution || {}), writeClaim: {schemaVersion: 1, claimId: 'wc_active', nonce: 'f'.repeat(32), taskId: taskB, storeKey: 'NM', operations: ['update_description'], expectedPayloadHash: 'e'.repeat(64), claimedAt: new Date().toISOString(), claimedBy: 'owner_desc_backfill', state: 'claimed'}},
  }));
  const execB = await executeTask(cookie, taskB);
  check('active claim blocks execute', JSON.stringify(execB.json?.task?.execution?.preflight?.blockers || []), text => text.includes('写 claim'));
  check('active claim blocks before partialEdit', partialEditBodies.length, 0);

  // current-description drift between dry-run and execute stops submission
  const taskC = await createUpdateDescriptionTask(cookie, {sourceTaskId});
  await bindUpdateDescription(cookie, taskC);
  await dryRunTask(cookie, taskC);
  liveDescriptions.set(SPU, {ar: oldArLines.join('\n'), en: ['drifted current line', ...oldEnLines.slice(1)].join('\n')});
  partialEditBodies.length = 0;
  const execC = await executeTask(cookie, taskC);
  check('drift execute blocked', execC.json?.task?.execution?.state, 'blocked');
  check('drift blocker mentions drift', JSON.stringify(execC.json?.task?.execution?.preflight?.blockers || []), text => text.includes('漂移'));
  check('drift never called partialEdit', partialEditBodies.length, 0);
  liveDescriptions.delete(SPU);

  // readback mismatch -> submitted_readback_pending (manual resolve)
  const taskD = await createUpdateDescriptionTask(cookie, {sourceTaskId});
  await bindUpdateDescription(cookie, taskD);
  await dryRunTask(cookie, taskD);
  partialEditMode.mode = 'readback_drift';
  const execD = await executeTask(cookie, taskD);
  check('readback mismatch lifecycle manual resolve', execD.json?.task?.lifecycle?.lifecycleStatus, 'submitted_readback_failed');
  const execDRaw = await rawTaskById(taskD);
  const execDRun = asArray(execDRaw.execution?.linkMaintenanceExecutors || [])[0] || {};
  check('readback mismatch status', String(execDRun.readback?.status || ''), 'description_readback_mismatch');
  check('readback mismatch needs manual resolve raw', execDRaw.lifecycle?.needsManualResolve, true);
  check('readback mismatch write claim unconfirmed', execDRaw.execution?.writeClaim?.state, 'unconfirmed');
  partialEditMode.mode = 'success';
  docStateMode.state = 2;
  docStateMode.version = 'V1';

  // missing info.version -> submitted_unconfirmed, no auto readback, no retry
  const taskE = await createUpdateDescriptionTask(cookie, {sourceTaskId});
  await bindUpdateDescription(cookie, taskE);
  await dryRunTask(cookie, taskE);
  partialEditMode.mode = 'no_version';
  partialEditBodies.length = 0;
  const execE = await executeTask(cookie, taskE);
  check('no-version lifecycle locked manual resolve', execE.json?.task?.lifecycle?.lifecycleStatus, 'suspicious_write_attempted');
  const execERaw = await rawTaskById(taskE);
  const execERun = asArray(execERaw.execution?.linkMaintenanceExecutors || [])[0] || {};
  check('no-version state unconfirmed', execERun.state, 'update_description_submitted_unconfirmed');
  check('no-version descriptionLifecycle pending', execERun.descriptionLifecycle?.lifecycleStatus, 'submitted_readback_pending');
  check('no-version needs manual resolve raw', execERaw.lifecycle?.needsManualResolve, true);
  check('no-version write claim unconfirmed', execERaw.execution?.writeClaim?.state, 'unconfirmed');
  check('no-version partialEdit called once', partialEditBodies.length, 1);
  partialEditMode.mode = 'success';

  // missing info.success (undefined) is ambiguous: no readback, claim
  // unconfirmed, write-possibly-accepted locked for manual resolve.
  const taskE2 = await createUpdateDescriptionTask(cookie, {sourceTaskId});
  await bindUpdateDescription(cookie, taskE2);
  await dryRunTask(cookie, taskE2);
  partialEditMode.mode = 'missing_success';
  partialEditBodies.length = 0;
  const execE2 = await executeTask(cookie, taskE2);
  check('missing-success lifecycle locked manual resolve', execE2.json?.task?.lifecycle?.lifecycleStatus, 'suspicious_write_attempted');
  const execE2Raw = await rawTaskById(taskE2);
  const execE2Run = asArray(execE2Raw.execution?.linkMaintenanceExecutors || [])[0] || {};
  check('missing-success state unconfirmed', execE2Run.state, 'update_description_submitted_unconfirmed');
  check('missing-success descriptionLifecycle pending', execE2Run.descriptionLifecycle?.lifecycleStatus, 'submitted_readback_pending');
  check('missing-success never submitted', execE2Raw.execution?.writeAudit?.actualWriteSubmitted, false);
  check('missing-success write claim unconfirmed', execE2Raw.execution?.writeClaim?.state, 'unconfirmed');
  check('missing-success partialEdit called once', partialEditBodies.length, 1);
  check('missing-success readback never ran', String(execE2Run.readback?.status || ''), 'not_run');
  partialEditMode.mode = 'success';

  // success=false is a blocker
  const taskF = await createUpdateDescriptionTask(cookie, {sourceTaskId});
  await bindUpdateDescription(cookie, taskF);
  await dryRunTask(cookie, taskF);
  partialEditMode.mode = 'success_false';
  partialEditBodies.length = 0;
  const execF = await executeTask(cookie, taskF);
  check('success=false blocked', execF.json?.task?.execution?.state, 'blocked');
  check('success=false never submitted', execF.json?.task?.execution?.writeAudit?.actualWriteSubmitted, false);
  partialEditMode.mode = 'success';

  // audit-in-progress document state stops dry-run
  const taskG = await createUpdateDescriptionTask(cookie, {sourceTaskId});
  await bindUpdateDescription(cookie, taskG);
  docStateMode.state = 1;
  const dryG = await dryRunTask(cookie, taskG);
  check('audit in progress blocked', dryG.json?.task?.execution?.state, 'blocked');
  check('audit blocker mentions 审核中', JSON.stringify(dryG.json?.task?.execution?.preflight?.blockers || []), text => text.includes('审核中'));
  docStateMode.state = 2;

  // not editable stops dry-run
  const taskH = await createUpdateDescriptionTask(cookie, {sourceTaskId});
  await bindUpdateDescription(cookie, taskH);
  editPermissionMode.editable = false;
  const dryH = await dryRunTask(cookie, taskH);
  check('not editable blocked', dryH.json?.task?.execution?.state, 'blocked');
  check('editable blocker mentions editable=false', JSON.stringify(dryH.json?.task?.execution?.preflight?.blockers || []), text => text.includes('editable=false'));
  editPermissionMode.editable = true;

  // new-format s09 HTML binds through the same endpoint with sourceProof s09
  const newSourceBytes = Buffer.from(newHtmlMaterial, 'utf8');
  const taskI = await createUpdateDescriptionTask(cookie, {sourceTaskId});
  const bindI = await bindUpdateDescription(cookie, taskI, {
    sourceFileBytes: newSourceBytes,
    sourceFileName: 'SK-11004-new-review.html',
    section: 'auto',
  });
  check('s09 bind via auto detection', bindI.status, 200);
  check('s09 bind sourceProof', bindI.json?.binding?.sourceProof, 'server_verified_html_section_s09');

  // CLI end-to-end: creates its own task, binds and dry-runs; stdout hashes only
  const cliHtmlFile = path.join(tmpRoot, 'legacy-review.html');
  await fs.writeFile(cliHtmlFile, legacyHtmlMaterial, 'utf8');
  const cliLogin = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      'scripts/bi_ops_cli.mjs',
      '--base-url', base,
      '--session-file', path.join(tmpRoot, 'cli-session.json'),
      '--knowledge-cache-dir', path.join(tmpRoot, 'knowledge-cache'),
      'login', '--username', 'owner_desc_backfill', '--password', 'owner-pass',
    ], {
      cwd: ROOT,
      env: {...process.env, NODE_ENV: 'test'},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI login timeout')); }, 30_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({code, stdout}); });
  });
  check('CLI login ok', cliLogin.code, 0);
  const cli = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      'scripts/bi_ops_cli.mjs',
      '--base-url', base,
      '--session-file', path.join(tmpRoot, 'cli-session.json'),
      '--knowledge-cache-dir', path.join(tmpRoot, 'knowledge-cache'),
      'update-description',
      '--source-task-id', sourceTaskId,
      '--store', 'NM',
      '--spu', SPU,
      '--source-file', cliHtmlFile,
      '--section', 's9',
    ], {
      cwd: ROOT,
      env: {...process.env, NODE_ENV: 'test'},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI timeout')); }, 60_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      let json = null;
      try { json = stdout.trim() ? JSON.parse(stdout) : null; } catch {}
      resolve({code, stdout, stderr, json});
    });
  });
  check('CLI update-description ok', cli.json?.ok === true && cli.code === 0, true);
  if (cli.json?.taskId) ownedTaskIds.add(String(cli.json.taskId));
  check('CLI output material hashes', String(cli.json?.material?.sourceFileSha256 || '').length, 64);
  check('CLI output sectionUsed s9', cli.json?.material?.sectionUsed, 's9');
  check('CLI output bound sourceTaskId', cli.json?.bound?.sourceTaskId, sourceTaskId);
  check('CLI dry-run locked', cli.json?.dryRun?.descriptionBindingLocked, true);
  check('CLI stdout has no description text', cli.stdout, text => !text.includes('selling point one') && !text.includes('سطر أول') && !text.includes('中文卖点一'));
  check('CLI safety flags', JSON.stringify(cli.json?.safety || {}), text => text.includes('minimalPartialEditOnly') && text.includes('oldPublishTaskUntouched'));

  // ---------- material file permissions + symlink/reparse escape ----------
  const boundMaterialFiles = (await fs.readdir(materialDir).catch(() => []))
    .filter(name => name.startsWith(`${taskId}-`) && name.endsWith('.json'));
  const boundMaterialFile = boundMaterialFiles[0] ? path.join(materialDir, boundMaterialFiles[0]) : null;
  check('bound material file exists', Boolean(boundMaterialFile), true);
  if (process.platform === 'win32') {
    check('material dir mode 0700 (posix check skipped on win32)', true, true);
    check('material file mode 0600 (posix check skipped on win32)', true, true);
  } else if (boundMaterialFile) {
    const dirStat = await fs.stat(materialDir);
    const fileStat = await fs.stat(boundMaterialFile);
    check('material dir mode 0700', dirStat.mode & 0o777, 0o700);
    check('material file mode 0600', fileStat.mode & 0o777, 0o600);
  }

  // Crafted refs that escape the controlled dir are rejected by the executor:
  // (a) realpath escape through a junction/symlink, (b) parent traversal.
  const escapeOutsideDir = path.join(tmpRoot, 'escape-outside');
  await fs.mkdir(escapeOutsideDir, {recursive: true});
  const escapePayload = {
    spu_name: SPU,
    multi_language_desc_list: [
      {language: 'ar', name: arLines.join('\n')},
      {language: 'en', name: enLines.join('\n')},
    ],
  };
  const escapeBytes = Buffer.from(`${JSON.stringify(escapePayload)}\n`, 'utf8');
  await fs.writeFile(path.join(escapeOutsideDir, 'x.json'), escapeBytes, 'utf8');
  const escapeFileSha = crypto.createHash('sha256').update(escapeBytes).digest('hex');
  const escapePayloadHash = sha256StableJson(escapePayload);
  const taskEscape = await createUpdateDescriptionTask(cookie, {sourceTaskId});
  const junctionName = `escape-${taskEscape}`;
  const junctionPath = path.join(materialDir, junctionName);
  let junctionCreated = false;
  try {
    await fs.symlink(escapeOutsideDir, junctionPath, 'junction');
    junctionCreated = true;
  } catch {}
  await updateRawTaskById(taskEscape, task => ({
    ...task,
    descriptionUpdatePayloadRef: {
      schemaVersion: 1,
      relativePath: `state/description-material/${junctionName}/x.json`,
      fileSha256: escapeFileSha,
      payloadHash: escapePayloadHash,
      storedAt: new Date().toISOString(),
    },
  }));
  const escapeDry = await dryRunTask(cookie, taskEscape);
  if (junctionCreated) {
    check('symlink/junction escape dry-run blocked', escapeDry.json?.task?.execution?.state, 'blocked');
    check('symlink/junction escape blocker mentions material file', JSON.stringify(escapeDry.json?.task?.execution?.preflight?.blockers || []), text => text.includes('描述材料文件'));
  } else {
    check('symlink/junction escape dry-run blocked (link creation unsupported)', true, true);
  }
  await fs.rmdir(junctionPath).catch(() => {});
  const taskTraversal = await createUpdateDescriptionTask(cookie, {sourceTaskId});
  await updateRawTaskById(taskTraversal, task => ({
    ...task,
    descriptionUpdatePayloadRef: {
      schemaVersion: 1,
      relativePath: `../logs/escape-${taskTraversal}.json`,
      fileSha256: escapeFileSha,
      payloadHash: escapePayloadHash,
      storedAt: new Date().toISOString(),
    },
  }));
  const traversalDry = await dryRunTask(cookie, taskTraversal);
  check('parent traversal ref dry-run blocked', traversalDry.json?.task?.execution?.state, 'blocked');
  check('parent traversal blocker mentions material file', JSON.stringify(traversalDry.json?.task?.execution?.preflight?.blockers || []), text => text.includes('描述材料文件'));

  // ---------- claim finalization: dual-portal CAS conflict ----------
  const taskCAS = await createUpdateDescriptionTask(cookie, {sourceTaskId});
  await bindUpdateDescription(cookie, taskCAS);
  await dryRunTask(cookie, taskCAS);
  const portalB = await startPortalInstance({});
  const cookieB = await loginAt(portalB.base);
  partialEditMode.mode = 'success';
  partialEditDelayMs.value = 1500;
  partialEditBodies.length = 0;
  fakeOpenApiCalls.length = 0;
  const execCASPromise = executeTask(cookie, taskCAS);
  let partialEditHit = false;
  for (let i = 0; i < 120 && !partialEditHit; i += 1) {
    partialEditHit = fakeOpenApiCalls.some(call => call.path === '/open-api/goods/product/partialEdit');
    if (!partialEditHit) await sleep(50);
  }
  check('dual-portal: partialEdit reached fake server', partialEditHit, true);
  const concurrentPatch = await reqAt(portalB.base, '/api/link-ops-tasks', {
    method: 'PATCH',
    cookie: cookieB,
    body: {id: taskCAS, note: 'concurrent-manual-edit'},
  });
  check('dual-portal: concurrent manual edit patched', concurrentPatch.status, 200);
  const execCAS = await execCASPromise;
  check('dual-portal: final CAS conflict -> 409', execCAS.status, 409);
  check('dual-portal: conflict code', execCAS.json?.code, 'LINK_OPS_REVISION_CONFLICT');
  const casRaw = await rawTaskById(taskCAS);
  check('dual-portal: concurrent manual field preserved', casRaw.note, 'concurrent-manual-edit');
  check('dual-portal: claim stays locked after conflict', casRaw.execution?.writeClaim?.state, 'claimed');
  check('dual-portal: write was attempted once', partialEditBodies.length, 1);
  portalB.portal.kill();
  partialEditDelayMs.value = 0;
  docStateMode.state = 2;
  docStateMode.version = 'V1';

  // ---------- CAS failure after material write cleans only the new orphan ----------
  const portalC = await startPortalInstance({SHEIN_LINK_OPS_TEST_FAIL_BIND_CAS_AFTER_MATERIAL: '1'});
  const cookieC = await loginAt(portalC.base);
  const taskOrphan = await createUpdateDescriptionTask(cookieC, {sourceTaskId, baseUrl: portalC.base});
  const orphanBind = await bindUpdateDescription(cookieC, taskOrphan, {baseUrl: portalC.base});
  check('orphan bind CAS failure -> 409', orphanBind.status, 409);
  check('orphan bind conflict code', orphanBind.json?.code, 'LINK_OPS_REVISION_CONFLICT');
  const orphanFiles = (await fs.readdir(materialDir).catch(() => []))
    .filter(name => name.startsWith(`${taskOrphan}-`) && name.endsWith('.json'));
  check('orphan material file retained for offline GC after CAS failure', orphanFiles.length, 1);
  const orphanTask = await rawTaskById(taskOrphan);
  check('orphan task record keeps no material ref', orphanTask?.descriptionUpdatePayloadRef ?? null, null);
  portalC.portal.kill();

  // ---------- deterministic interleave: online failure handling never
  // deletes material, so a concurrent successful bind cannot lose its file ----------
  const interleaveMarker = path.join(tmpRoot, 'orphan-cleanup-marker');
  const portalD = await startPortalInstance({
    SHEIN_LINK_OPS_TEST_FAIL_BIND_CAS_AFTER_MATERIAL: '1',
    SHEIN_LINK_OPS_TEST_ORPHAN_CLEANUP_MARKER: interleaveMarker,
  });
  const cookieD = await loginAt(portalD.base);
  const taskInterleave = await createUpdateDescriptionTask(cookieD, {sourceTaskId, baseUrl: portalD.base});
  const interleaveBindPromise = bindUpdateDescription(cookieD, taskInterleave, {baseUrl: portalD.base});
  let cleanupPaused = false;
  for (let i = 0; i < 200 && !cleanupPaused; i += 1) {
    try { await fs.access(`${interleaveMarker}.ready`); cleanupPaused = true; } catch {}
    if (!cleanupPaused) await sleep(50);
  }
  check('interleave: failed creator paused before cleanup', cleanupPaused, true);
  const concurrentBind = await bindUpdateDescription(cookie, taskInterleave);
  check('interleave: concurrent successful bind on same task+payload', concurrentBind.status, 200);
  await fs.writeFile(`${interleaveMarker}.go`, 'go\n', 'utf8');
  const interleaveBind = await interleaveBindPromise;
  check('interleave: failed creator still returns 409', interleaveBind.status, 409);
  const interleaveFiles = (await fs.readdir(materialDir).catch(() => []))
    .filter(name => name.startsWith(`${taskInterleave}-`) && name.endsWith('.json'));
  check('interleave: shared material file preserved', interleaveFiles.length, 1);
  const interleaveTask = await rawTaskById(taskInterleave);
  const interleaveRef = interleaveTask?.descriptionUpdatePayloadRef;
  check('interleave: successful bind references the file', String(interleaveRef?.relativePath || '').startsWith('state/description-material/'), true);
  const interleaveRefPath = interleaveRef ? path.join(ROOT, String(interleaveRef.relativePath).replace(/\\/g, '/')) : null;
  const interleaveRefBytes = interleaveRefPath ? await fs.readFile(interleaveRefPath, 'utf8').catch(() => '') : '';
  check('interleave: referenced file still readable and consistent', interleaveRefBytes.length > 0 && interleaveRef.fileSha256 === crypto.createHash('sha256').update(interleaveRefBytes, 'utf8').digest('hex'), true);
  portalD.portal.kill();

  // ---------- Windows without the explicit override refuses private material ----------
  if (process.platform === 'win32') {
    const portalNoPerm = await startPortalInstance({SHEIN_LINK_OPS_TEST_ALLOW_UNVERIFIED_MATERIAL_PERMS: '0'});
    const cookieNoPerm = await loginAt(portalNoPerm.base);
    const taskNoPerm = await createUpdateDescriptionTask(cookieNoPerm, {sourceTaskId, baseUrl: portalNoPerm.base});
    const bindNoPerm = await bindUpdateDescription(cookieNoPerm, taskNoPerm, {baseUrl: portalNoPerm.base});
    check('win32 no-override bind refused', bindNoPerm.status, 403);
    check('win32 no-override permission code', bindNoPerm.json?.code, 'DESCRIPTION_MATERIAL_PERMISSION_UNSUPPORTED');
    const noPermFiles = (await fs.readdir(materialDir).catch(() => []))
      .filter(name => name.startsWith(`${taskNoPerm}-`) && name.endsWith('.json'));
    check('win32 no-override wrote no material file', noPermFiles.length, 0);
    portalNoPerm.portal.kill();
  } else {
    check('win32 no-override refused (posix platform skips)', true, true);
  }

  // ---------- CLI requires exactly one store ----------
  const runCliUpdateDescription = (extraArgs = []) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      'scripts/bi_ops_cli.mjs',
      '--base-url', base,
      '--session-file', path.join(tmpRoot, 'cli-session.json'),
      '--knowledge-cache-dir', path.join(tmpRoot, 'knowledge-cache'),
      'update-description',
      '--source-task-id', sourceTaskId,
      '--spu', SPU,
      '--source-file', cliHtmlFile,
      ...extraArgs,
    ], {
      cwd: ROOT,
      env: {...process.env, NODE_ENV: 'test'},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI timeout')); }, 60_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({code, stdout, stderr}); });
  });
  const cliMultiStore = await runCliUpdateDescription(['--store', 'NM', '--store', 'DX']);
  check('CLI multi-store rejected', cliMultiStore.code !== 0, true);
  check('CLI multi-store error mentions unique store', JSON.stringify(`${cliMultiStore.stdout}\n${cliMultiStore.stderr}`), text => text.includes('必须精确单个'));
  const cliZeroStore = await runCliUpdateDescription([]);
  check('CLI zero-store rejected', cliZeroStore.code !== 0, true);
  check('CLI zero-store error mentions unique store', JSON.stringify(`${cliZeroStore.stdout}\n${cliZeroStore.stderr}`), text => text.includes('必须精确单个'));

  // old publish task still untouched after the whole lifecycle
  check('source task business content untouched at the end', JSON.stringify(stripLinkOpsRepositoryMetadata(await rawTaskById(sourceTaskId))), sourceBusinessBefore);
} catch (error) {
  fatalError = error;
  console.error(`\nFATAL: ${error?.stack || error}`);
  console.error(`portal stdout tail:\n${portalStdout.slice(-4000)}`);
  console.error(`portal stderr tail:\n${portalStderr.slice(-4000)}`);
} finally {
  for (const inst of spawnedPortals) {
    try { inst.portal.kill(); } catch {}
  }
  await Promise.all(spawnedPortals.map(inst => waitForProcessExit(inst.portal)));
  fakeOpenApi.close();
  // Cleanup runs on success AND failure. Material ownership is determined by
  // task ids created by this process, never by a directory-wide before/after
  // diff, so parallel isolated runs cannot delete one another's files.
  const materialDirReal = await fs.realpath(materialDir).catch(() => null);
  const materialNow = await fs.readdir(materialDir).catch(() => []);
  for (const name of materialNow) {
    const ownedMaterial = [...ownedTaskIds].some(taskId => (
      name.startsWith(`${taskId}-`) && name.endsWith('.json')
    ));
    const ownedEscape = [...ownedTaskIds].some(taskId => name === `escape-${taskId}`);
    if (!ownedMaterial && !ownedEscape) continue;
    const abs = path.join(materialDir, name);
    try {
      const real = await fs.realpath(abs).catch(() => null);
      if (!materialDirReal || !real || !real.toLowerCase().startsWith(materialDirReal.toLowerCase() + path.sep.toLowerCase())) continue;
      if (ownedMaterial && /^lot_[0-9A-Za-z_-]+-[0-9a-f]{64}\.json$/.test(name)) {
        await fs.rm(abs, {force: true});
      } else if (ownedEscape) {
        await fs.rmdir(abs);
      }
    } catch {}
  }
  await fs.rm(tmpRoot, {recursive: true, force: true}).catch(() => {});
}

const failed = checks.filter(row => !row.pass);
console.log(`link_ops_update_description_flow: ${checks.length - failed.length}/${checks.length} passed`);
for (const row of failed) {
  console.error(`FAIL ${row.label}\n  expected: ${JSON.stringify(row.expected)}\n  actual:   ${JSON.stringify(row.actual)}`);
}
if (fatalError || failed.length) process.exit(1);
