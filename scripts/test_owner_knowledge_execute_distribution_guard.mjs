import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-knowledge-execute-guard-'));
const port = await freePort();
const activationToken = ['test', 'owner', 'knowledge', 'activation', 'token', '1234567890'].join('-');
const authFile = path.join(temp, 'users.json');
const rolesFile = path.join(temp, 'roles.json');
await fs.writeFile(authFile, JSON.stringify({users: [{username: 'owner', password: 'owner-password', role: 'owner'}]}));
await fs.writeFile(rolesFile, JSON.stringify({defaults: {owner: {readStores: ['*'], writeStores: ['*']}}, users: {owner: {role: 'owner', readStores: ['*'], writeStores: ['*']}}}));

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
    SHEIN_OWNER_KNOWLEDGE_GIT_REPO_DIR: path.join(temp, 'missing-git-repo'),
    SHEIN_OWNER_KNOWLEDGE_GITHUB_ACTIVATION_TOKEN: activationToken,
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
  const execute = await request(base, '/api/link-ops-execute', {
    cookie,
    body: {id: taskId, mode: 'execute', confirm: 'SHEIN_OPENAPI_SUBMIT'},
  });
  assert.equal(execute.status, 200);
  assert.match(JSON.stringify(execute.json), /GitHub 校验并同步到当前版本/, 'server blocks execute independently of CLI checks');
  assert.equal(Boolean(execute.json?.execution?.writeAudit?.submitted), false);

  const invalidActivation = await request(base, '/api/owner-knowledge/distribution/activate', {
    bearer: activationToken + 'x',
    body: {sourceCommit: 'a'.repeat(40), fingerprint: 'b'.repeat(64), bundleSha256: 'c'.repeat(64)},
  });
  assert.equal(invalidActivation.status, 401);
  const noPendingActivation = await request(base, '/api/owner-knowledge/distribution/activate', {
    bearer: activationToken,
    body: {sourceCommit: 'a'.repeat(40), fingerprint: 'b'.repeat(64), bundleSha256: 'c'.repeat(64)},
  });
  assert.equal(noPendingActivation.status, 404);
  console.log(JSON.stringify({ok: true, taskId, executeState: execute.json?.execution?.state || ''}));
} finally {
  const exited = waitForExit(child, 2_000);
  child.kill('SIGTERM');
  if (!await exited && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await waitForExit(child, 2_000);
  child.stdout?.destroy();
  child.stderr?.destroy();
  await fs.rm(temp, {recursive: true, force: true});
}

async function request(base, pathname, {cookie = '', bearer = '', body = null} = {}) {
  const headers = {'content-type': 'application/json'};
  if (cookie) headers.cookie = cookie;
  if (bearer) {
    headers.authorization = `Bearer ${bearer}`;
    headers['x-forwarded-for'] = '203.0.113.10';
    headers['x-forwarded-proto'] = 'https';
  }
  const response = await fetch(base + pathname, {method: 'POST', headers, body: JSON.stringify(body || {})});
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return {status: response.status, json, text};
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitReady(port, processHandle, stderrText) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) throw new Error(`portal exited: ${stderrText()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/login`);
      if (response.status === 200) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`portal startup timed out: ${stderrText()}`);
}

async function waitForExit(processHandle, timeoutMs) {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) return true;
  return await Promise.race([
    new Promise(resolve => processHandle.once('exit', () => resolve(true))),
    new Promise(resolve => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}
