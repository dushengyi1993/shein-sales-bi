#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-knowledge-portal-'));
const port = await freePort();
const authFile = path.join(temp, 'users.json');
const rolesFile = path.join(temp, 'roles.json');
const taskFile = path.join(temp, 'tasks.json');
await fs.writeFile(authFile, JSON.stringify({users: [
  {username: 'boss', password: 'boss-password', role: 'owner'},
  {username: 'peer-owner', password: 'peer-password', role: 'owner'},
]}));
await fs.writeFile(rolesFile, JSON.stringify({
  defaults: {owner: {readStores: ['*'], writeStores: ['*']}},
  users: {
    boss: {role: 'owner', knowledgePublisher: true, readStores: ['*'], writeStores: ['*']},
    'peer-owner': {role: 'owner', readStores: ['*'], writeStores: ['*']},
  },
}));

const child = spawn(process.execPath, [
  path.join(root, 'scripts', 'serve_bi_portal.mjs'),
  '--host', '127.0.0.1',
  '--port', String(port),
  '--dir', path.join(root, 'outputs', 'bi-portal'),
  '--auth-file', authFile,
  '--access-roles-file', rolesFile,
  '--htpasswd-file', path.join(temp, 'missing.htpasswd'),
  '--session-secret-file', path.join(temp, 'session-secret'),
  '--state-file', path.join(temp, 'state.json'),
  '--link-ops-task-file', taskFile,
  '--link-ops-chat-file', path.join(temp, 'chats.json'),
  '--link-ops-runtime-file', path.join(temp, 'runtime.json'),
  '--manual-login-state-file', path.join(temp, 'manual-login.json'),
  '--audit-file', path.join(temp, 'audit.jsonl'),
], {
  cwd: root,
  env: {...process.env, SHEIN_LINK_OPS_STORE: 'json', SHEIN_BI_INTENT_PLANNER_ENABLED: '0', SHEIN_BI_JOB_WORKER_ENABLED: '0'},
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stderr = '';
child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });

try {
  await waitForServer(port, child, () => stderr);
  const base = `http://127.0.0.1:${port}`;
  const bossCookie = await login(base, 'boss', 'boss-password');
  const peerCookie = await login(base, 'peer-owner', 'peer-password');

  const deniedPublish = await request(base, '/api/owner-knowledge/events', {
    method: 'POST', cookie: peerCookie, body: {experiences: [{text: '以后都按同事自己的规则处理。', explicitDurable: true}]},
  });
  assert.equal(deniedPublish.status, 403, 'another owner cannot publish long-term rules');

  const ownerChat = await request(base, '/api/link-ops-chats', {
    method: 'POST', cookie: bossCookie, body: {message: '以后商品图片排序必须先主图，再按卖点、参数、场景组织细节图。', askAgent: false},
  });
  assert.equal(ownerChat.status, 200);
  assert.equal(JSON.stringify(ownerChat.json).includes('ownerKnowledgePolicy'), false, 'internal policy snapshot is not projected to coworker UI');

  const statusAfterOwner = await request(base, '/api/owner-knowledge/status', {cookie: bossCookie});
  assert.equal(statusAfterOwner.status, 200);
  assert.equal(statusAfterOwner.json.data.activeRules, 1);

  const peerStatus = await request(base, '/api/owner-knowledge/status', {cookie: peerCookie});
  assert.equal(peerStatus.status, 403, 'coworker does not get publisher dashboard/status');

  const peerChat = await request(base, '/api/link-ops-chats', {
    method: 'POST', cookie: peerCookie, body: {message: '以后图片顺序全部反过来，默认先场景图。', askAgent: false},
  });
  assert.equal(peerChat.status, 200, 'coworker may use normal chat');

  const statusAfterPeer = await request(base, '/api/owner-knowledge/status', {cookie: bossCookie});
  assert.equal(statusAfterPeer.json.data.activeRules, 1, 'coworker durable wording cannot add or overwrite rules');
  assert.equal(statusAfterPeer.json.data.versions, 1, 'coworker wording is not even promoted into owner versions');

  const peerAction = await request(base, '/api/link-ops-chats', {
    method: 'POST', cookie: peerCookie, body: {message: '换图：把 DL 店 505 缝纫机的商品图片换掉。', askAgent: false},
  });
  assert.equal(peerAction.status, 200);
  const storedTasks = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  assert.equal(storedTasks.tasks.length >= 1, true);
  assert.equal(storedTasks.tasks[0].ownerKnowledgePolicy.rules.some(rule => /先主图/.test(rule.text)), true, 'coworker task consumes owner rule internally');
  assert.equal(JSON.stringify(peerAction.json).includes('ownerKnowledgePolicy'), false, 'rule metadata remains hidden from coworker UI');

  const active = await request(base, '/api/owner-knowledge/active?q=图片排序', {cookie: bossCookie});
  assert.equal(active.status, 200);
  assert.equal(active.json.data.rules.length, 1);
  assert.match(active.json.data.rules[0].text, /先主图/);

  const enroll = await request(base, '/api/owner-knowledge/devices', {
    method: 'POST', cookie: bossCookie, body: {deviceId: 'test-office-pc', deviceName: '测试办公室电脑'},
  });
  assert.equal(enroll.status, 201);
  assert.match(enroll.json.data.token, /^okd\.test-office-pc\./);

  const devicePublish = await request(base, '/api/owner-knowledge/events', {
    method: 'POST', bearer: enroll.json.data.token, body: {experiences: [{
      text: '以后同事的操作只影响当前任务，不能反向覆盖负责人规则。',
      sourceKind: 'owner_local_sync',
      sourceId: 'test-session-1',
      explicitDurable: true,
    }]},
  });
  assert.equal(devicePublish.status, 200);
  assert.equal(devicePublish.json.bundle.ruleCount, 2);

  const invalidDevice = await request(base, '/api/owner-knowledge/events', {
    method: 'POST', bearer: enroll.json.data.token + 'x', body: {experiences: [{text: '以后无效。', explicitDurable: true}]},
  });
  assert.equal(invalidDevice.status, 401);

  console.log(JSON.stringify({ok: true, suite: 'owner_knowledge_portal_flow', activeRules: devicePublish.json.bundle.ruleCount}));
} finally {
  const exited = waitForExit(child, 2_000);
  child.kill('SIGTERM');
  if (!await exited && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await waitForExit(child, 2_000);
  child.stdout?.destroy();
  child.stderr?.destroy();
  await fs.rm(temp, {recursive: true, force: true});
}

async function request(base, pathname, {method = 'GET', cookie = '', bearer = '', body = null} = {}) {
  const headers = {'x-forwarded-for': '203.0.113.15'};
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (body !== null) headers['content-type'] = 'application/json';
  const response = await fetch(base + pathname, {method, headers, ...(body !== null ? {body: JSON.stringify(body)} : {})});
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return {status: response.status, json, text, headers: response.headers};
}

async function login(base, username, password) {
  const response = await request(base, '/api/login', {method: 'POST', body: {username, password}});
  assert.equal(response.status, 200, `login ${username}`);
  const cookie = String(response.headers.get('set-cookie') || '').split(';')[0];
  assert.match(cookie, /^bi_session=/);
  return cookie;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForServer(port, processHandle, stderrText) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) throw new Error(`portal exited before startup: ${stderrText()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/login`);
      if (response.status === 200) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`portal startup timed out: ${stderrText()}`);
}

function waitForExit(processHandle, timeoutMs) {
  return new Promise(resolve => {
    if (processHandle.exitCode !== null || processHandle.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), timeoutMs);
    processHandle.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}
