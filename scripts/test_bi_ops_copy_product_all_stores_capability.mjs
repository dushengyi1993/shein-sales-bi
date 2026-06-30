#!/usr/bin/env node
/**
 * Capability smoke for copy_product_draft across every SHEIN store.
 *
 * The service used to keep the real-submit product publish adapter effectively
 * HL-only through a static capability flag. This isolated test proves the
 * current owner model instead: any store that is authorized, read-probe-ready,
 * inside safeWriteOperations and covered by a user+store+operation whitelist is
 * globally confirmable for copy_product_draft. The test never calls SHEIN.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP_TEMP = process.argv.includes('--keep-temp');
const STORE_KEYS = ['DL', 'DX', 'FY', 'LQ', 'NM', 'HL', 'JY', 'ZL', 'TS', 'MZ', 'CX', 'YJ', 'XL', 'QY', 'QH', 'TZ', 'JSH', 'TZZ', 'XC'];
const tmpBase = path.join(ROOT, 'tmp');
await fs.mkdir(tmpBase, {recursive: true});
const tmpRoot = await fs.mkdtemp(path.join(tmpBase, 'bi-ops-copy-all-stores-capability-'));
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
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function actionFor(row, key) {
  return asArray(row?.actionCapabilities).find(action => String(action?.key || '') === key) || null;
}

const authFile = await writeJson('auth.json', {
  users: [{
    username: 'owner_copy_all_stores',
    password: 'owner-pass',
    displayName: 'Owner Copy All Stores',
    role: 'owner',
    readStores: ['*'],
    writeStores: ['*'],
    ownerKey: 'OWNER_COPY_ALL_STORES',
  }],
});
const accessRolesFile = await writeJson('access_roles.json', {
  defaults: {
    owner: {readStores: ['*'], writeStores: ['*']},
    operator: {readStores: ['*'], writeStores: []},
  },
});
const openapiConfigFile = await writeJson('openapi.json', {
  environment: 'copy-all-stores-capability-smoke',
  cooperationMode: '半托管',
  market: 'SA',
  apiBaseUrls: {
    prodSemiManaged: 'http://127.0.0.1:9',
  },
  stores: STORE_KEYS.map(storeKey => ({
    storeKey,
    shopName: `Capability Smoke ${storeKey}`,
    enabled: true,
    openKeyId: `dummy-open-key-${storeKey.toLowerCase()}`,
    secretKey: `dummy-secret-${storeKey.toLowerCase()}`,
    authorizedAt: '2026-06-27T00:00:00.000+08:00',
  })),
  safeWriteOperations: {
    enabled: true,
    requireDryRun: true,
    allowedOperations: ['copy_product_draft'],
    allowedStores: STORE_KEYS,
  },
});
const whitelistFile = await writeJson('whitelist.json', {
  enabled: true,
  rules: [{
    id: 'owner-all-stores-copy-smoke',
    enabled: true,
    realSubmit: true,
    stores: STORE_KEYS,
    operations: ['copy_product_draft'],
    allowedUsers: ['owner_copy_all_stores'],
    allowedOwnerKeys: ['OWNER_COPY_ALL_STORES'],
    allowedRoles: ['owner'],
    note: 'isolated smoke only; proves all configured stores can expose copy_product_draft confirmability',
  }],
});
const readProbeFile = await writeJson('read-probes.latest.json', {
  generatedAt: new Date().toISOString(),
  counts: {total: STORE_KEYS.length, ok: STORE_KEYS.length},
  results: STORE_KEYS.map(storeKey => ({
    storeKey,
    ok: true,
    status: 'read_probe_ok',
    calls: [],
  })),
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
    SHEIN_OPENAPI_READ_PROBE_SUMMARY_FILE: readProbeFile,
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
    if (child.exitCode !== null) throw new Error(`portal exited code=${child.exitCode}\nstdout=${stdout}\nstderr=${stderr}`);
    try {
      const r = await fetch(`${base}/login`, {redirect: 'manual'});
      if (r.status >= 200 && r.status < 500) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`portal not ready\nstdout=${stdout}\nstderr=${stderr}`);
}

async function login(username, password) {
  const r = await req('/api/login', {method: 'POST', body: {username, password}});
  const setCookie = r.headers.get('set-cookie') || '';
  const cookie = (setCookie.match(/bi_session=[^;]+/) || [''])[0];
  if (r.status !== 200 || !cookie) throw new Error(`login failed ${username}: status=${r.status} body=${r.text}`);
  return cookie;
}

const result = {ok: false, tmpRoot, port, summary: {}, checks: []};
function check(label, actual, expected) {
  const pass = typeof expected === 'function' ? expected(actual) : actual === expected;
  result.checks.push({label, actual, expected: typeof expected === 'function' ? expected.name || 'predicate' : expected, pass});
  return pass;
}

try {
  await waitReady();
  const cookie = await login('owner_copy_all_stores', 'owner-pass');
  const caps = await req('/api/openapi-capabilities', {cookie});
  const rows = asArray(caps.json?.rows);
  const byStore = new Map(rows.map(row => [String(row?.storeKey || '').toUpperCase(), row]));
  const copyRows = STORE_KEYS.map(storeKey => {
    const row = byStore.get(storeKey);
    const action = actionFor(row, 'copy_product_draft');
    return {
      storeKey,
      rowFound: Boolean(row),
      authorized: Boolean(row?.authorized),
      verifiedRead: Boolean(row?.verifiedRead),
      writePrecheckReady: Boolean(row?.writePrecheckReady),
      writeConfirmable: Boolean(row?.writeConfirmable),
      state: action?.state || '',
      realSubmitSupported: Boolean(action?.realSubmitSupported),
      blockerCount: asArray(action?.realSubmitBlockers).length,
    };
  });
  const failedStores = copyRows.filter(row =>
    !row.rowFound
    || !row.authorized
    || !row.verifiedRead
    || !row.writePrecheckReady
    || !row.realSubmitSupported
    || row.state !== 'ready'
    || row.blockerCount !== 0
  );
  result.summary = {
    capsStatus: caps.status,
    rowCount: rows.length,
    safety: caps.json?.safety || null,
    failedStores,
    copyRows,
  };
  check('capabilities status', caps.status, 200);
  check('all 19 store rows present', STORE_KEYS.every(storeKey => byStore.has(storeKey)), true);
  check('safeWrite enabled in isolated config', Boolean(caps.json?.safety?.safeWriteOperations?.enabled), true);
  check('whitelist enabled in isolated config', Boolean(caps.json?.safety?.realSubmitWhitelist?.enabled), true);
  check('canSilentWrite remains false', Boolean(caps.json?.safety?.canSilentWrite), false);
  check('every store copy_product_draft confirmable', failedStores.length, 0);
  result.ok = result.checks.every(x => x.pass);
} finally {
  child.kill();
  await sleep(300);
}

console.log(JSON.stringify(result, null, 2));
if (result.ok && !KEEP_TEMP) {
  await fs.rm(tmpRoot, {recursive: true, force: true});
} else if (!result.ok) {
  console.error(`copy all-stores capability smoke failed; temp files kept at ${tmpRoot}`);
}
if (!result.ok) process.exit(1);
