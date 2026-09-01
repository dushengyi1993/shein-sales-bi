#!/usr/bin/env node
/**
 * Capability smoke for copy_product_draft across every SHEIN store.
 *
 * The service used to keep the real-submit product publish adapter effectively
 * HL-only through a static capability flag. This isolated test proves the
 * current owner model instead: any store that is authorized, has current read
 * evidence from either the dedicated probe or daily product reconciliation,
 * is inside safeWriteOperations and is covered by a user+store+operation
 * whitelist is globally confirmable for copy_product_draft. The test never
 * calls SHEIN.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {provisionBiSessionSecret} from './provision_bi_session_secret.mjs';

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
  generatedAt: new Date(Date.now() - (15 * 24 * 60 * 60 * 1000)).toISOString(),
  counts: {total: STORE_KEYS.length, ok: STORE_KEYS.length},
  results: STORE_KEYS.map(storeKey => ({
    storeKey,
    ok: true,
    status: 'read_probe_ok',
    calls: [],
  })),
});
const staleEvidenceGeneratedAt = new Date(Date.now() - (15 * 24 * 60 * 60 * 1000)).toISOString();
const salesReconciliationFile = await writeJson('sales-reconciliation.latest.json', {
  generatedAt: staleEvidenceGeneratedAt,
  results: [],
});
const returnReconciliationFile = await writeJson('return-reconciliation.latest.json', {
  generatedAt: staleEvidenceGeneratedAt,
  results: [],
});
function productReconciliationPayload({generatedAt = new Date().toISOString(), invalidStore = '', invalidMode = ''} = {}) {
  return {
    generatedAt,
    counts: {total: STORE_KEYS.length, succeeded: STORE_KEYS.length, failed: 0},
    results: STORE_KEYS.map(storeKey => ({
      storeKey,
      ok: !(storeKey === invalidStore && invalidMode === 'not-ok'),
      status: 'warning',
      load: {
        reconciliation: storeKey === invalidStore && invalidMode === 'empty-row' ? [] : [{
          status: 'warning',
          api_link_count: 10,
          browser_link_count: 9,
          matched_skc_count: 9,
          api_only_skc_count: 1,
        }],
      },
    })),
  };
}
const productReconciliationFile = await writeJson('product-reconciliation.latest.json', productReconciliationPayload());
const htpasswdFile = path.join(tmpRoot, 'empty.htpasswd');
await fs.writeFile(htpasswdFile, '', 'utf8');
const stateFile = path.join(tmpRoot, 'action_state.json');
const taskFile = path.join(tmpRoot, 'tasks.json');
const chatFile = path.join(tmpRoot, 'chats.json');
const auditFile = path.join(tmpRoot, 'audit.jsonl');
const sessionSecretFile = path.join(tmpRoot, 'session_secret');
await provisionBiSessionSecret(sessionSecretFile);
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
    SHEIN_OPENAPI_SALES_RECONCILIATION_SUMMARY_FILE: salesReconciliationFile,
    SHEIN_OPENAPI_RETURN_RECONCILIATION_SUMMARY_FILE: returnReconciliationFile,
    SHEIN_OPENAPI_PRODUCT_RECONCILIATION_SUMMARY_FILE: productReconciliationFile,
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
      actorCanSubmit: Boolean(row?.actorCanSubmit),
      state: action?.state || '',
      realSubmitSupported: Boolean(action?.realSubmitSupported),
      actorActionCanSubmit: Boolean(action?.actorCanSubmit),
      blockerCount: asArray(action?.realSubmitBlockers).length,
    };
  });
  const failedStores = copyRows.filter(row =>
    !row.rowFound
    || !row.authorized
    || !row.verifiedRead
    || !row.writePrecheckReady
    || !row.realSubmitSupported
    || !row.actorCanSubmit
    || !row.actorActionCanSubmit
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
  check('dedicated read probe is intentionally stale', Boolean(caps.json?.probeSummary?.fresh), false);
  check('daily product reconciliation is fresh for all stores', Number(caps.json?.counts?.productReconciliationReady || 0), STORE_KEYS.length);
  check('current owner is allowed into controlled submit flow for all stores', Number(caps.json?.counts?.actorControlledSubmitReady || 0), STORE_KEYS.length);
  check('every store copy_product_draft confirmable', failedStores.length, 0);

  await fs.writeFile(productReconciliationFile, `${JSON.stringify(productReconciliationPayload({invalidStore: 'TZ', invalidMode: 'empty-row'}), null, 2)}\n`, 'utf8');
  const emptyEvidenceCaps = await req('/api/openapi-capabilities', {cookie});
  const emptyEvidenceTz = asArray(emptyEvidenceCaps.json?.rows).find(row => row.storeKey === 'TZ') || {};
  check('empty reconciliation row is not read evidence', Boolean(emptyEvidenceTz.verifiedRead), false);
  check('empty reconciliation row cannot expose controlled submit', Boolean(emptyEvidenceTz.actorCanSubmit), false);

  await fs.writeFile(productReconciliationFile, `${JSON.stringify(productReconciliationPayload({invalidStore: 'TZ', invalidMode: 'not-ok'}), null, 2)}\n`, 'utf8');
  const failedEvidenceCaps = await req('/api/openapi-capabilities', {cookie});
  const failedEvidenceTz = asArray(failedEvidenceCaps.json?.rows).find(row => row.storeKey === 'TZ') || {};
  check('ok=false reconciliation is not read evidence', Boolean(failedEvidenceTz.verifiedRead), false);

  await fs.writeFile(productReconciliationFile, `${JSON.stringify(productReconciliationPayload({generatedAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()}), null, 2)}\n`, 'utf8');
  const futureEvidenceCaps = await req('/api/openapi-capabilities', {cookie});
  check('future-dated reconciliation is not fresh', Boolean(futureEvidenceCaps.json?.productReconciliationSummary?.fresh), false);
  check('future-dated reconciliation cannot expose controlled submit', Number(futureEvidenceCaps.json?.counts?.actorControlledSubmitReady || 0), 0);
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
