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
const tmpRoot = await fs.mkdtemp(path.join(tmpBase, 'bi-ops-permission-smoke-'));
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

function countCapabilityRows(json) {
  const candidates = [
    json?.stores,
    json?.storeCapabilities,
    json?.rows,
    json?.data?.stores,
    json?.data?.storeCapabilities,
    json?.capabilities?.stores,
  ];
  for (const value of candidates) {
    if (Array.isArray(value)) return value.length;
  }
  if (json && typeof json === 'object') {
    for (const [key, value] of Object.entries(json)) {
      if (/stores?|capabilit/i.test(key) && Array.isArray(value)) return value.length;
    }
  }
  return null;
}

function extractMeUser(json) {
  return json?.user || json?.actor || json?.data?.user || json?.data?.actor || json || {};
}

const authFile = await writeJson('auth.json', {
  users: [
    {
      username: 'owner_smoke',
      password: 'owner-pass',
      displayName: 'Owner Smoke',
      role: 'owner',
      readStores: ['*'],
      writeStores: ['*'],
      ownerKey: 'OWNER',
    },
    {
      username: 'yanghuan_smoke',
      password: 'op-pass',
      displayName: '杨欢 Smoke',
      role: 'operator',
      readStores: ['*'],
      writeStores: ['DX', 'LQ', 'XC'],
      ownerKey: 'YANGHUAN',
    },
    {
      username: 'blocked_smoke',
      password: 'blocked-pass',
      displayName: 'Blocked Smoke',
      role: 'operator',
      readStores: ['*'],
      writeStores: ['DX'],
      ownerKey: 'BLOCKED',
    },
  ],
});
const accessRolesFile = await writeJson('access_roles.json', {
  defaults: {
    admin: {readStores: ['*'], writeStores: ['*']},
    owner: {readStores: ['*'], writeStores: ['*']},
    operator: {readStores: ['*'], writeStores: []},
  },
  users: {
    blocked_smoke: {displayName: 'Blocked Smoke', role: 'operator', readStores: ['*'], writeStores: []},
  },
});
const openapiConfigFile = await writeJson('openapi.json', {stores: {}});
const whitelistFile = await writeJson('whitelist.json', {enabled: false, rules: []});
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

function createBody(label, targets) {
  return {
    source: `permission_smoke:${label}`,
    command: `${label} 自动运营权限 smoke PA4-6L`,
    targets,
  };
}

const result = {ok: false, tmpRoot, port, summary: {}, checks: []};
function check(label, actual, expected) {
  const pass = typeof expected === 'function' ? expected(actual) : actual === expected;
  result.checks.push({label, actual, expected: typeof expected === 'function' ? expected.name || 'predicate' : expected, pass});
  return pass;
}

try {
  await waitReady();
  const ownerCookie = await login('owner_smoke', 'owner-pass');
  const opCookie = await login('yanghuan_smoke', 'op-pass');
  const blockedCookie = await login('blocked_smoke', 'blocked-pass');

  const me = await req('/api/auth/me', {cookie: opCookie});
  const meUser = extractMeUser(me.json);
  result.summary.operatorMeStatus = me.status;
  result.summary.operatorWriteStores = Array.isArray(meUser.writeStores) ? meUser.writeStores : [];
  check('operator me status', me.status, 200);
  check('operator auth writeStores preserved', result.summary.operatorWriteStores.join(','), 'DX,LQ,XC');

  const blockedMe = await req('/api/auth/me', {cookie: blockedCookie});
  const blockedMeUser = extractMeUser(blockedMe.json);
  result.summary.blockedMeStatus = blockedMe.status;
  result.summary.blockedWriteStores = Array.isArray(blockedMeUser.writeStores) ? blockedMeUser.writeStores : [];
  check('accessRoles explicit empty writeStores wins', result.summary.blockedWriteStores.join(','), '');

  const blockedDx = await req('/api/link-ops-tasks', {method: 'POST', cookie: blockedCookie, body: createBody('blocked create DX denied', {stores: ['DX'], productRefs: ['PA4-6L']})});
  result.summary.blockedDxDeniedStatus = blockedDx.status;
  result.summary.blockedDxDeniedError = blockedDx.json?.error || '';
  check('blocked byUser empty writeStores create DX denied', blockedDx.status, 403);

  const caps = await req('/api/openapi-capabilities', {cookie: opCookie});
  result.summary.capabilitiesStatus = caps.status;
  result.summary.capabilitiesRows = countCapabilityRows(caps.json);
  check('operator capabilities status', caps.status, 200);

  const opDx = await req('/api/link-ops-tasks', {method: 'POST', cookie: opCookie, body: createBody('operator create DX', {stores: ['DX'], productRefs: ['PA4-6L']})});
  result.summary.operatorDxStatus = opDx.status;
  result.summary.operatorDxTaskId = opDx.json?.task?.id || opDx.json?.data?.tasks?.[0]?.id || '';
  check('operator create own DX', opDx.status, s => s >= 200 && s < 300);

  const opHl = await req('/api/link-ops-tasks', {method: 'POST', cookie: opCookie, body: createBody('operator create HL denied', {stores: ['HL'], productRefs: ['PA4-6L']})});
  result.summary.operatorHlDeniedStatus = opHl.status;
  result.summary.operatorHlDeniedError = opHl.json?.error || '';
  check('operator create HL denied', opHl.status, 403);

  const opCopyAllowed = await req('/api/link-ops-tasks', {method: 'POST', cookie: opCookie, body: createBody('operator copy CX to DX allowed', {sourceStores: ['CX'], writeStores: ['DX'], productRefs: ['PA4-6L']})});
  result.summary.operatorCopyAllowedStatus = opCopyAllowed.status;
  result.summary.operatorCopyAllowedTaskId = opCopyAllowed.json?.task?.id || opCopyAllowed.json?.data?.tasks?.[0]?.id || '';
  check('operator copy source CX write DX allowed', opCopyAllowed.status, s => s >= 200 && s < 300);

  const opCopyDenied = await req('/api/link-ops-tasks', {method: 'POST', cookie: opCookie, body: createBody('operator copy CX to HL denied', {sourceStores: ['CX'], writeStores: ['HL'], productRefs: ['PA4-6L']})});
  result.summary.operatorCopyDeniedStatus = opCopyDenied.status;
  result.summary.operatorCopyDeniedError = opCopyDenied.json?.error || '';
  check('operator copy source CX write HL denied', opCopyDenied.status, 403);

  const ownerHl = await req('/api/link-ops-tasks', {method: 'POST', cookie: ownerCookie, body: createBody('owner create HL', {stores: ['HL'], productRefs: ['PA4-6L']})});
  result.summary.ownerHlStatus = ownerHl.status;
  result.summary.ownerHlTaskId = ownerHl.json?.task?.id || ownerHl.json?.data?.tasks?.[0]?.id || '';
  check('owner create HL allowed', ownerHl.status, s => s >= 200 && s < 300);

  const noAuth = await req('/api/link-ops-tasks', {method: 'POST', body: createBody('local-system no auth create denied', {stores: ['DX'], productRefs: ['PA4-6L']})});
  result.summary.localSystemDeniedStatus = noAuth.status;
  result.summary.localSystemDeniedError = noAuth.json?.error || '';
  check('local-system no-auth create denied', noAuth.status, 403);

  const tasks = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  const auditText = fssync.existsSync(auditFile) ? await fs.readFile(auditFile, 'utf8') : '';
  result.summary.taskCount = Array.isArray(tasks.tasks) ? tasks.tasks.length : 0;
  result.summary.auditLines = auditText.trim() ? auditText.trim().split(/\r?\n/).length : 0;
  check('created task count', result.summary.taskCount, 3);
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
  console.error(`permission smoke failed; temp files kept at ${tmpRoot}`);
}
if (!result.ok) process.exit(1);
