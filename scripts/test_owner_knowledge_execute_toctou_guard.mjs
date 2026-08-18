import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {provisionBiSessionSecret} from './provision_bi_session_secret.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-knowledge-execute-toctou-'));
await provisionBiSessionSecret(path.join(temp, 'session-secret'));
const port = await freePort();
const authFile = path.join(temp, 'users.json');
const rolesFile = path.join(temp, 'roles.json');
const preExecuteMarkerFile = path.join(temp, 'pre-execute-marker.json');
await fs.writeFile(authFile, JSON.stringify({users: [{username: 'owner', password: 'owner-password', role: 'owner'}]}));
await fs.writeFile(rolesFile, JSON.stringify({
  defaults: {owner: {readStores: ['*'], writeStores: ['*'], knowledgePublisher: true}},
  users: {owner: {role: 'owner', readStores: ['*'], writeStores: ['*'], knowledgePublisher: true}},
}));

const child = spawn(process.execPath, [
  'scripts/serve_bi_portal.mjs', '--host', '127.0.0.1', '--port', String(port),
  '--auth-file', authFile, '--access-roles-file', rolesFile,
  '--htpasswd-file', path.join(temp, 'missing.htpasswd'), '--session-secret-file', path.join(temp, 'session-secret'),
  '--state-file', path.join(temp, 'state.json'), '--link-ops-task-file', path.join(temp, 'tasks.json'),
  '--link-ops-chat-file', path.join(temp, 'chats.json'), '--link-ops-runtime-file', path.join(temp, 'runtime.json'),
  '--manual-login-state-file', path.join(temp, 'manual-login.json'), '--audit-file', path.join(temp, 'audit.jsonl'),
], {
  cwd: ROOT,
  env: {
    ...process.env,
    SHEIN_LINK_OPS_STORE: 'json',
    SHEIN_BI_INTENT_PLANNER_ENABLED: '0',
    SHEIN_BI_JOB_WORKER_ENABLED: '0',
    SHEIN_OWNER_KNOWLEDGE_GIT_REPO_DIR: '',
    SHEIN_OWNER_KNOWLEDGE_TEST_PRE_EXECUTE_DELAY_MS: '500',
    SHEIN_OWNER_KNOWLEDGE_TEST_PRE_EXECUTE_MARKER_FILE: preExecuteMarkerFile,
    SHEIN_OWNER_KNOWLEDGE_TEST_BUMP_DURING_EXECUTE_MS: '100',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', chunk => { stderr += chunk.toString(); });

try {
  await waitReady(port, child, () => stderr);
  const base = `http://127.0.0.1:${port}`;
  const login = await fetch(`${base}/api/login`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({username: 'owner', password: 'owner-password'})});
  assert.equal(login.status, 200);
  const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
  const create = await request(base, '/api/link-ops-tasks', {cookie, body: {command: '把 DL 的 PA4-6L 下架', targets: {stores: ['DL'], productRefs: ['PA4-6L']}}});
  assert.equal(create.status, 200);
  const taskId = create.json.task.id;

  const executePromise = request(base, '/api/link-ops-execute', {
    cookie,
    body: {id: taskId, mode: 'execute', confirm: 'SHEIN_OPENAPI_SUBMIT'},
  });
  await waitFile(`${preExecuteMarkerFile}.ready`);
  const execute = await executePromise;
  const initialMarker = JSON.parse(await fs.readFile(preExecuteMarkerFile, 'utf8'));
  const finalMarker = JSON.parse(await fs.readFile(`${preExecuteMarkerFile}.final`, 'utf8'));
  assert.match(initialMarker.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(finalMarker.ok, false, JSON.stringify(finalMarker));
  assert.equal(finalMarker.expectedGeneration, 0);
  assert.equal(finalMarker.latestGeneration, 1, 'a generation change between initial and final checks must be observed');
  assert.equal(execute.status, 200, execute.text);
  assert.match(JSON.stringify(execute.json), /执行准备期间发生变化/, 'a concurrent owner-rule update must invalidate the pre-execute snapshot');
  assert.equal(Boolean(execute.json?.execution?.writeAudit?.submitted), false);
  assert.equal(Boolean(execute.json?.execution?.writeAudit?.issuedExecuteToExecutor), false);
  console.log(JSON.stringify({ok: true, taskId, expectedGeneration: finalMarker.expectedGeneration, latestGeneration: finalMarker.latestGeneration}));
} finally {
  const exited = waitForExit(child, 2_000);
  child.kill('SIGTERM');
  if (!await exited && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await waitForExit(child, 2_000);
  child.stdout?.destroy();
  child.stderr?.destroy();
  await fs.rm(temp, {recursive: true, force: true});
}

async function request(base, pathname, {cookie = '', body = null} = {}) {
  const target = new URL(pathname, base);
  const payload = JSON.stringify(body || {});
  const headers = {'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), connection: 'close'};
  if (cookie) headers.cookie = cookie;
  return await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: target.hostname,
      port: Number(target.port),
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers,
      agent: false,
    }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({status: Number(response.statusCode || 0), json, text});
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const selected = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return selected;
}

async function waitReady(portNumber, processHandle, stderrText) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) throw new Error(`portal exited: ${stderrText()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${portNumber}/login`);
      if (response.status === 200) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`portal startup timed out: ${stderrText()}`);
}

async function waitFile(file) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await fs.stat(file).catch(() => null)) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for pre-execute marker: ${file}`);
}

async function waitForExit(processHandle, timeoutMs) {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) return true;
  return await Promise.race([
    new Promise(resolve => processHandle.once('exit', () => resolve(true))),
    new Promise(resolve => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}
