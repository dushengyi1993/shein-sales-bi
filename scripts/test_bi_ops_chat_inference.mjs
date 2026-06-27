#!/usr/bin/env node
/**
 * Isolated smoke for the BI automation chat command parser.
 *
 * The user-facing workflow is one chat input:
 * - read-only questions should answer in chat;
 * - explicit write actions should create a current-session task;
 * - copy/fill-link commands must infer source/target/product context instead of
 *   immediately claiming that an OpenAPI payload is missing.
 *
 * This test starts a local temporary portal, logs in with a temporary owner
 * account, sends a same-store copy command with askAgent=false, and checks only
 * service-side inference. It never calls SHEIN or an external LLM.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = path.join(ROOT, 'tmp');
await fs.mkdir(tmpBase, {recursive: true});
const tmpRoot = await fs.mkdtemp(path.join(tmpBase, 'bi-ops-chat-inference-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

async function req(baseUrl, urlPath, {method = 'GET', cookie = '', body = null} = {}) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      ...(cookie ? {cookie} : {}),
      ...(body ? {'content-type': 'application/json'} : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return {status: res.status, headers: res.headers, text, json};
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function includesStore(xs, store) {
  return asArray(xs).map(x => String(x).toUpperCase()).includes(store);
}

const authFile = await writeJson('auth.json', {
  users: [{
    username: 'owner_chat_inference',
    password: 'owner-chat-pass',
    displayName: 'Owner Chat Inference',
    role: 'owner',
    readStores: ['*'],
    writeStores: ['*'],
    ownerKey: 'OWNER',
  }],
});
const accessRolesFile = await writeJson('access_roles.json', {
  defaults: {
    owner: {readStores: ['*'], writeStores: ['*']},
    operator: {readStores: ['*'], writeStores: []},
  },
  users: {},
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
const baseUrl = `http://127.0.0.1:${port}`;
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

const result = {ok: false, tmpRoot, baseUrl, checks: [], summary: {}};
function check(label, actual, expected) {
  const pass = typeof expected === 'function' ? expected(actual) : actual === expected;
  result.checks.push({label, actual, expected: typeof expected === 'function' ? expected.name || 'predicate' : expected, pass});
  return pass;
}

async function waitReady() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited code=${child.exitCode}\nstdout=${stdout}\nstderr=${stderr}`);
    try {
      const res = await fetch(`${baseUrl}/login`, {redirect: 'manual'});
      if (res.status >= 200 && res.status < 500) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`server not ready\nstdout=${stdout}\nstderr=${stderr}`);
}

try {
  await waitReady();
  const login = await req(baseUrl, '/api/login', {
    method: 'POST',
    body: {username: 'owner_chat_inference', password: 'owner-chat-pass'},
  });
  const cookie = (login.headers.get('set-cookie') || '').match(/bi_session=[^;]+/)?.[0] || '';
  check('login status', login.status, 200);
  check('login cookie present', Boolean(cookie), true);

  const command = '帮我把DL的505缝纫机再补一个链接，直接复制DL现有的曝光最高的那条链接';
  const chat = await req(baseUrl, '/api/link-ops-chats', {
    method: 'POST',
    cookie,
    body: {message: command, askAgent: false},
  });
  const autoTask = chat.json?.autoTask || {};
  const targets = autoTask.targets || {};
  result.summary = {
    chatStatus: chat.status,
    taskId: autoTask.id || '',
    taskStatus: autoTask.status || '',
    intents: autoTask.intents || [],
    targets,
    sessionId: chat.json?.session?.id || '',
    autoTaskMessageId: asArray(chat.json?.session?.messages).find(m => m?.role === 'assistant')?.meta?.autoTaskId || '',
  };

  check('chat status', chat.status, 200);
  check('auto task created', Boolean(autoTask.id), true);
  check('auto task status confirmed', autoTask.status, 'confirmed');
  check('auto task is current-session task', autoTask.chatSessionId, chat.json?.session?.id || '');
  check('copy intent inferred', asArray(autoTask.intents), xs => xs.includes('copy_product_draft'));
  check('target store inferred', targets.stores, xs => includesStore(xs, 'DL'));
  check('write store inferred', targets.writeStores, xs => includesStore(xs, 'DL'));
  check('same-store source inferred', targets.sourceStores, xs => includesStore(xs, 'DL'));
  check('numeric product ref inferred', targets.productRefs, xs => asArray(xs).some(x => /^505\b/i.test(String(x))));
  check('assistant message points to auto task', result.summary.autoTaskMessageId, autoTask.id);

  const tasks = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  check('task file has one task', asArray(tasks.tasks).length, 1);
  result.ok = result.checks.every(x => x.pass);
} finally {
  child.kill('SIGTERM');
  await sleep(200);
}

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);
