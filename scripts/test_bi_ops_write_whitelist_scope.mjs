#!/usr/bin/env node
/**
 * Real-write whitelist scope smoke for the SHEIN BI automation workbench.
 *
 * This starts an isolated local portal with temporary auth/task/audit/openapi
 * files. It deliberately enables safeWriteOperations and a one-rule real-submit
 * whitelist only inside that temporary process, then proves the service still
 * scopes real-write permission by user + store + operation and does not issue a
 * real SHEIN write when the other execution gates are not satisfied.
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP_TEMP = process.argv.includes('--keep-temp');
const tmpBase = path.join(ROOT, 'tmp');
await fs.mkdir(tmpBase, {recursive: true});
const tmpRoot = await fs.mkdtemp(path.join(tmpBase, 'bi-ops-whitelist-smoke-'));
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const CONFIRM_TEXT = 'SHEIN_OPENAPI_SUBMIT';

async function getFreePort() {
  return await new Promise((resolve, reject) => {
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

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function countCapabilityRows(json) {
  const rows = capabilityRows(json);
  return rows.length || null;
}

function capabilityRows(json) {
  const candidates = [
    json?.rows,
    json?.stores,
    json?.storeCapabilities,
    json?.data?.rows,
    json?.data?.stores,
    json?.data?.storeCapabilities,
    json?.capabilities?.stores,
  ];
  for (const value of candidates) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function findStoreRow(json, storeKey) {
  const key = String(storeKey || '').trim().toUpperCase();
  return capabilityRows(json).find(row => String(row?.storeKey || row?.store || '').trim().toUpperCase() === key) || null;
}

function actionFor(row, actionKey) {
  return asArray(row?.actionCapabilities).find(action => String(action?.key || '') === actionKey) || null;
}

function extractTaskId(json) {
  return json?.task?.id || json?.data?.tasks?.[0]?.id || '';
}

async function rawTaskById(id) {
  const data = JSON.parse(await fs.readFile(taskFile, 'utf8').catch(() => '{"tasks":[]}'));
  return asArray(data?.tasks).find(task => String(task?.id || '') === String(id || '')) || null;
}

function writeAuditFromExecute(json) {
  return json?.execution?.writeAudit || json?.task?.execution?.writeAudit || json?.task?.writeAudit || null;
}

function whitelistCheckFor(writeAudit, storeKey, operation = '') {
  const key = String(storeKey || '').trim().toUpperCase();
  const op = String(operation || '').trim().toLowerCase();
  return asArray(writeAudit?.realSubmitWhitelistChecks).find(check => {
    const storeMatches = String(check?.storeKey || '').trim().toUpperCase() === key;
    const opMatches = !op || String(check?.operation || '').trim().toLowerCase() === op;
    return storeMatches && opMatches;
  }) || null;
}

function executionBlockersFromJson(json) {
  return asArray(json?.execution?.preflight?.blockers || json?.task?.execution?.preflight?.blockers);
}

function blockerTextFromJson(json) {
  return executionBlockersFromJson(json).join('；');
}

const authFile = await writeJson('auth.json', {
  users: [
    {
      username: 'owner_whitelist_smoke',
      password: 'owner-pass',
      displayName: 'Owner Whitelist Smoke',
      role: 'owner',
      readStores: ['*'],
      writeStores: ['*'],
      ownerKey: 'OWNER_WHITELIST',
    },
    {
      username: 'operator_hl_smoke',
      password: 'operator-pass',
      displayName: 'Operator HL Smoke',
      role: 'operator',
      readStores: ['*'],
      writeStores: ['HL'],
      ownerKey: 'OPERATOR_HL',
    },
  ],
});
const accessRolesFile = await writeJson('access_roles.json', {
  defaults: {
    owner: {readStores: ['*'], writeStores: ['*']},
    operator: {readStores: ['*'], writeStores: []},
  },
});
const openapiConfigFile = await writeJson('openapi.json', {
  environment: 'whitelist-smoke',
  cooperationMode: '半托管',
  market: 'SA',
  apiBaseUrls: {
    prodSemiManaged: 'http://127.0.0.1:9',
  },
  stores: [
    {
      storeKey: 'HL',
      shopName: 'Whitelist Smoke HL',
      enabled: true,
      openKeyId: 'dummy-open-key-hl',
      secretKey: 'dummy-secret-hl',
      authorizedAt: '2026-06-27T00:00:00.000+08:00',
    },
    {
      storeKey: 'DX',
      shopName: 'Whitelist Smoke DX',
      enabled: true,
      openKeyId: 'dummy-open-key-dx',
      secretKey: 'dummy-secret-dx',
      authorizedAt: '2026-06-27T00:00:00.000+08:00',
    },
  ],
  safeWriteOperations: {
    enabled: true,
    requireDryRun: true,
    allowedOperations: ['copy_product_draft'],
    allowedStores: ['HL'],
  },
});
const whitelistFile = await writeJson('whitelist.json', {
  enabled: true,
  rules: [
    {
      id: 'hl-owner-copy-smoke',
      enabled: true,
      realSubmit: true,
      stores: ['HL'],
      operations: ['copy_product_draft'],
      allowedUsers: ['owner_whitelist_smoke'],
      allowedOwnerKeys: ['OWNER_WHITELIST'],
      allowedRoles: ['owner'],
      note: 'isolated smoke only; not production',
    },
  ],
});
const readProbeSummaryFile = await writeJson('read-probes.latest.json', {
  generatedAt: new Date().toISOString(),
  counts: {total: 2, readProbeOk: 2, pending: 0, failed: 0},
  results: ['HL', 'DX'].map(storeKey => ({storeKey, ok: true, status: 'read_probe_ok'})),
});
const htpasswdFile = path.join(tmpRoot, 'empty.htpasswd');
await fs.writeFile(htpasswdFile, '', 'utf8');
const stateFile = path.join(tmpRoot, 'action_state.json');
const taskFile = path.join(tmpRoot, 'tasks.json');
const chatFile = path.join(tmpRoot, 'chats.json');
const auditFile = path.join(tmpRoot, 'audit.jsonl');
const sessionSecretFile = path.join(tmpRoot, 'session_secret');
const manualLoginStateFile = path.join(tmpRoot, 'manual_login.json');

const port = await getFreePort();
const child = spawn(process.execPath, [
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
], {
  cwd: ROOT,
  env: {
    ...process.env,
    SHEIN_BI_CORE_WARMUP_DISABLED: '1',
    SHEIN_OPENAPI_CONFIG_FILE: openapiConfigFile,
    SHEIN_BI_OPS_WRITE_WHITELIST_FILE: whitelistFile,
    SHEIN_OPENAPI_READ_PROBE_SUMMARY_FILE: readProbeSummaryFile,
    SHEIN_LINK_OPS_OPENAPI_EXECUTOR_TIMEOUT_MS: '750',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '';
let stderr = '';
child.stdout.on('data', d => { stdout += d.toString(); });
child.stderr.on('data', d => { stderr += d.toString(); });

const base = `http://127.0.0.1:${port}`;
async function req(pathname, {method = 'GET', cookie = '', body = undefined} = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(body !== undefined ? {'Content-Type': 'application/json'} : {}),
      ...(cookie ? {Cookie: cookie} : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return {status: res.status, headers: res.headers, text, json};
}

async function waitReady() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited code=${child.exitCode}\nstdout=${stdout}\nstderr=${stderr}`);
    try {
      const r = await fetch(`${base}/login`, {redirect: 'manual'});
      if (r.status >= 200 && r.status < 500) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`server not ready\nstdout=${stdout}\nstderr=${stderr}`);
}

async function login(username, password) {
  const r = await req('/api/login', {method: 'POST', body: {username, password}});
  const setCookie = r.headers.get('set-cookie') || '';
  const cookie = (setCookie.match(/bi_session=[^;]+/) || [''])[0];
  if (r.status !== 200 || !cookie) throw new Error(`login failed ${username}: status=${r.status} body=${r.text}`);
  return cookie;
}

function createCopyBody(label, targets) {
  return {
    source: `whitelist_scope_smoke:${label}`,
    command: `${label} 复制上品/补链接 PA4-6L`,
    targets,
  };
}

function createTitleBody(label, targets) {
  return {
    source: `whitelist_scope_smoke:${label}`,
    command: `${label} 改标题 PA4-6L`,
    targets,
  };
}

async function createTask(cookie, body) {
  const created = await req('/api/link-ops-tasks', {method: 'POST', cookie, body});
  const id = extractTaskId(created.json);
  if (created.status < 200 || created.status >= 300 || !id) {
    throw new Error(`create task failed status=${created.status} body=${created.text}`);
  }
  return {created, id};
}

async function executeTask(cookie, id, extra = {}) {
  return await req('/api/link-ops-execute', {
    method: 'POST',
    cookie,
    body: {id, mode: 'execute', confirm: CONFIRM_TEXT, ...extra},
  });
}

const result = {ok: false, tmpRoot, port, summary: {}, checks: []};
function check(label, actual, expected) {
  const pass = typeof expected === 'function' ? expected(actual) : actual === expected;
  result.checks.push({label, actual, expected: typeof expected === 'function' ? expected.name || 'predicate' : expected, pass});
  return pass;
}

try {
  await waitReady();
  const ownerCookie = await login('owner_whitelist_smoke', 'owner-pass');
  const operatorCookie = await login('operator_hl_smoke', 'operator-pass');

  const caps = await req('/api/openapi-capabilities', {cookie: ownerCookie});
  const hlRow = findStoreRow(caps.json, 'HL');
  const dxRow = findStoreRow(caps.json, 'DX');
  const hlCopy = actionFor(hlRow, 'copy_product_draft');
  const hlTitle = actionFor(hlRow, 'update_title');
  const operatorCaps = await req('/api/openapi-capabilities', {cookie: operatorCookie});
  const operatorHlRow = findStoreRow(operatorCaps.json, 'HL');
  const operatorHlCopy = actionFor(operatorHlRow, 'copy_product_draft');
  result.summary.capabilitiesStatus = caps.status;
  result.summary.capabilitiesRows = countCapabilityRows(caps.json);
  result.summary.safeWriteOperations = caps.json?.safety?.safeWriteOperations || null;
  result.summary.realSubmitWhitelist = caps.json?.safety?.realSubmitWhitelist || null;
  result.summary.hlWriteConfirmable = Boolean(hlRow?.writeConfirmable);
  result.summary.hlCopyRealSubmitSupported = Boolean(hlCopy?.realSubmitSupported);
  result.summary.ownerHlActorCanSubmit = Boolean(hlCopy?.actorCanSubmit);
  result.summary.operatorHlActorCanSubmit = Boolean(operatorHlCopy?.actorCanSubmit);
  result.summary.hlTitleRealSubmitSupported = Boolean(hlTitle?.realSubmitSupported);
  result.summary.dxSafeStoreAllowed = Boolean(dxRow?.safeWrite?.storeAllowed);
  check('capabilities status', caps.status, 200);
  check('capabilities rows include configured stores', result.summary.capabilitiesRows, n => Number(n) >= 2);
  check('isolated safeWrite enabled', Boolean(caps.json?.safety?.safeWriteOperations?.enabled), true);
  check('isolated safeWrite allowed operation is copy only', asArray(caps.json?.safety?.safeWriteOperations?.allowedOperations).join(','), 'copy_product_draft');
  check('isolated safeWrite allowed store is HL only', asArray(caps.json?.safety?.safeWriteOperations?.allowedStores).join(','), 'HL');
  check('isolated whitelist enabled', Boolean(caps.json?.safety?.realSubmitWhitelist?.enabled), true);
  check('HL copy globally confirmable when scoped gates configured', result.summary.hlCopyRealSubmitSupported, true);
  check('owner HL copy is actor-confirmable', result.summary.ownerHlActorCanSubmit, true);
  check('operator HL copy is not actor-confirmable without account whitelist', result.summary.operatorHlActorCanSubmit, false);
  check('HL title remains non-confirmable operation', result.summary.hlTitleRealSubmitSupported, false);
  check('DX is outside safeWrite store scope', result.summary.dxSafeStoreAllowed, false);

  const ownerHl = await createTask(ownerCookie, createCopyBody('owner HL copy', {stores: ['HL'], productRefs: ['PA4-6L']}));
  const ownerExec = await executeTask(ownerCookie, ownerHl.id);
  const ownerRawTask = await rawTaskById(ownerHl.id);
  const ownerAudit = ownerRawTask?.execution?.writeAudit || writeAuditFromExecute(ownerExec.json) || null;
  const ownerHlCheck = whitelistCheckFor(ownerRawTask?.execution?.writeAudit || ownerAudit, 'HL', 'copy_product_draft');
  result.summary.ownerExecuteStatus = ownerExec.status;
  result.summary.ownerWhitelistCheck = ownerHlCheck;
  result.summary.ownerWriteAudit = {
    requestedRealSubmit: Boolean(ownerAudit?.requestedRealSubmit),
    executeAllowed: Boolean(ownerAudit?.executeAllowed),
    issuedExecuteToExecutor: Boolean(ownerAudit?.issuedExecuteToExecutor),
    sheinWriteAttempted: Boolean(ownerAudit?.sheinWriteAttempted),
    actualWriteSubmitted: Boolean(ownerAudit?.actualWriteSubmitted),
    blockerCount: Number(ownerAudit?.blockerCount || 0),
    blockers: asArray(ownerRawTask?.execution?.preflight?.blockers || executionBlockersFromJson(ownerExec.json)),
  };
  check('owner execute request returns task update', ownerExec.status, 200);
  check('owner HL whitelist allowed', Boolean(ownerHlCheck?.allowed), true);
  check('owner whitelist rule id', ownerHlCheck?.ruleId || '', 'hl-owner-copy-smoke');
  check('owner requested real submit recorded', Boolean(ownerAudit?.requestedRealSubmit), true);
  check('owner still blocked by other execution gates', Boolean(ownerAudit?.executeAllowed), false);
  check('owner did not issue execute to child executor', Boolean(ownerAudit?.issuedExecuteToExecutor), false);
  check('owner did not attempt SHEIN write', Boolean(ownerAudit?.sheinWriteAttempted || ownerAudit?.actualWriteSubmitted), false);
  check('owner blocker mentions not waiting_review', asArray(ownerRawTask?.execution?.preflight?.blockers || executionBlockersFromJson(ownerExec.json)).join('；'), text => /待复核|waiting_review|dry-run|payload hash/.test(String(text || '')));

  const operatorHl = await createTask(operatorCookie, createCopyBody('operator HL copy denied by whitelist', {stores: ['HL'], productRefs: ['PA4-6L']}));
  const operatorExec = await executeTask(operatorCookie, operatorHl.id);
  const operatorRawTask = await rawTaskById(operatorHl.id);
  const operatorAudit = operatorRawTask?.execution?.writeAudit || writeAuditFromExecute(operatorExec.json) || null;
  const operatorHlCheck = whitelistCheckFor(operatorRawTask?.execution?.writeAudit || operatorAudit, 'HL', 'copy_product_draft');
  result.summary.operatorExecuteStatus = operatorExec.status;
  result.summary.operatorWhitelistCheck = operatorHlCheck;
  result.summary.operatorWriteAudit = {
    requestedRealSubmit: Boolean(operatorAudit?.requestedRealSubmit),
    executeAllowed: Boolean(operatorAudit?.executeAllowed),
    issuedExecuteToExecutor: Boolean(operatorAudit?.issuedExecuteToExecutor),
    sheinWriteAttempted: Boolean(operatorAudit?.sheinWriteAttempted),
    actualWriteSubmitted: Boolean(operatorAudit?.actualWriteSubmitted),
    blockerCount: Number(operatorAudit?.blockerCount || 0),
    blockers: asArray(operatorRawTask?.execution?.preflight?.blockers || executionBlockersFromJson(operatorExec.json)),
  };
  check('operator execute request returns task update', operatorExec.status, 200);
  check('operator HL whitelist denied despite store write permission', Boolean(operatorHlCheck?.allowed), false);
  check('operator whitelist reason mentions account', String(operatorHlCheck?.reason || ''), text => /账号|白名单/.test(text));
  check('operator not execute allowed', Boolean(operatorAudit?.executeAllowed), false);
  check('operator did not issue execute to child executor', Boolean(operatorAudit?.issuedExecuteToExecutor), false);
  check('operator did not attempt SHEIN write', Boolean(operatorAudit?.sheinWriteAttempted || operatorAudit?.actualWriteSubmitted), false);
  check('operator blockers mention whitelist', asArray(operatorRawTask?.execution?.preflight?.blockers || executionBlockersFromJson(operatorExec.json)).join('；'), text => /白名单/.test(String(text || '')));

  const ownerDx = await createTask(ownerCookie, createCopyBody('owner DX copy outside safe scope', {stores: ['DX'], productRefs: ['PA4-6L']}));
  const ownerDxExec = await executeTask(ownerCookie, ownerDx.id);
  const ownerDxRawTask = await rawTaskById(ownerDx.id);
  const ownerDxAudit = ownerDxRawTask?.execution?.writeAudit || writeAuditFromExecute(ownerDxExec.json) || null;
  const ownerDxCheck = whitelistCheckFor(ownerDxRawTask?.execution?.writeAudit || ownerDxAudit, 'DX', 'copy_product_draft');
  result.summary.ownerDxExecuteStatus = ownerDxExec.status;
  result.summary.ownerDxWhitelistCheck = ownerDxCheck;
  result.summary.ownerDxWriteAudit = {
    executeAllowed: Boolean(ownerDxAudit?.executeAllowed),
    issuedExecuteToExecutor: Boolean(ownerDxAudit?.issuedExecuteToExecutor),
    sheinWriteAttempted: Boolean(ownerDxAudit?.sheinWriteAttempted),
    actualWriteSubmitted: Boolean(ownerDxAudit?.actualWriteSubmitted),
    blockerCount: Number(ownerDxAudit?.blockerCount || 0),
    blockers: asArray(ownerDxRawTask?.execution?.preflight?.blockers || executionBlockersFromJson(ownerDxExec.json)),
  };
  check('owner DX execute request returns task update', ownerDxExec.status, 200);
  check('owner DX whitelist denied because store/action not matched', Boolean(ownerDxCheck?.allowed), false);
  check('owner DX not execute allowed', Boolean(ownerDxAudit?.executeAllowed), false);
  check('owner DX did not issue execute', Boolean(ownerDxAudit?.issuedExecuteToExecutor), false);
  check('owner DX did not attempt SHEIN write', Boolean(ownerDxAudit?.sheinWriteAttempted || ownerDxAudit?.actualWriteSubmitted), false);
  check('owner DX blockers mention gate or whitelist', asArray(ownerDxRawTask?.execution?.preflight?.blockers || executionBlockersFromJson(ownerDxExec.json)).join('；'), text => /总闸门|白名单|真实提交/.test(String(text || '')));

  const ownerTitle = await createTask(ownerCookie, createTitleBody('owner HL title unsupported op', {stores: ['HL'], productRefs: ['PA4-6L']}));
  const ownerTitleExec = await executeTask(ownerCookie, ownerTitle.id);
  const ownerTitleRawTask = await rawTaskById(ownerTitle.id);
  const ownerTitleAudit = ownerTitleRawTask?.execution?.writeAudit || writeAuditFromExecute(ownerTitleExec.json) || null;
  result.summary.ownerTitleExecuteStatus = ownerTitleExec.status;
  result.summary.ownerTitleWriteAudit = {
    executeAllowed: Boolean(ownerTitleAudit?.executeAllowed),
    issuedExecuteToExecutor: Boolean(ownerTitleAudit?.issuedExecuteToExecutor),
    sheinWriteAttempted: Boolean(ownerTitleAudit?.sheinWriteAttempted),
    actualWriteSubmitted: Boolean(ownerTitleAudit?.actualWriteSubmitted),
    whitelistChecks: asArray(ownerTitleRawTask?.execution?.writeAudit?.realSubmitWhitelistChecks || ownerTitleAudit?.realSubmitWhitelistChecks),
    blockerCount: Number(ownerTitleAudit?.blockerCount || 0),
    blockers: asArray(ownerTitleRawTask?.execution?.preflight?.blockers || executionBlockersFromJson(ownerTitleExec.json)),
  };
  check('owner title execute request returns task update', ownerTitleExec.status, 200);
  const ownerTitleCheck = whitelistCheckFor(ownerTitleRawTask?.execution?.writeAudit || ownerTitleAudit, 'HL', 'update_title');
  check('owner title has update_title whitelist check', Boolean(ownerTitleCheck), true);
  check('owner title update_title whitelist denied', Boolean(ownerTitleCheck?.allowed), false);
  check('owner title not execute allowed', Boolean(ownerTitleAudit?.executeAllowed), false);
  check('owner title did not issue execute', Boolean(ownerTitleAudit?.issuedExecuteToExecutor), false);
  check('owner title did not attempt SHEIN write', Boolean(ownerTitleAudit?.sheinWriteAttempted || ownerTitleAudit?.actualWriteSubmitted), false);
  check('owner title blockers mention action gate or whitelist', asArray(ownerTitleRawTask?.execution?.preflight?.blockers || executionBlockersFromJson(ownerTitleExec.json)).join('；'), text => /总闸门|allowedOperations|白名单|payload hash|维护预检/.test(String(text || '')));

  const auditText = fssync.existsSync(auditFile) ? await fs.readFile(auditFile, 'utf8') : '';
  result.summary.taskCount = JSON.parse(await fs.readFile(taskFile, 'utf8')).tasks.length;
  result.summary.auditLines = auditText.trim() ? auditText.trim().split(/\r?\n/).length : 0;
  check('created task count', result.summary.taskCount, 4);
  check('audit lines >= 8', result.summary.auditLines, n => n >= 8);

  result.ok = result.checks.every(x => x.pass);
} finally {
  child.kill();
  await sleep(300);
}

console.log(JSON.stringify(result, null, 2));
if (result.ok && !KEEP_TEMP) {
  await fs.rm(tmpRoot, {recursive: true, force: true});
} else if (!result.ok) {
  console.error(`whitelist scope smoke failed; temp files kept at ${tmpRoot}`);
}
if (!result.ok) process.exit(1);
