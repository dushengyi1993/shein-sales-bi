#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'shein-bi-http-security-'));
const port = await freePort();
const authFile = path.join(temp, 'users.json');
await fs.writeFile(authFile, JSON.stringify({users: [{username: 'security-test', password: 'correct-password', role: 'admin'}]}));

const child = spawn(process.execPath, [
  path.join(root, 'scripts', 'serve_bi_portal.mjs'),
  '--host', '127.0.0.1',
  '--port', String(port),
  '--dir', path.join(root, 'outputs', 'bi-portal'),
  '--auth-file', authFile,
  '--htpasswd-file', path.join(temp, 'missing.htpasswd'),
  '--session-secret-file', path.join(temp, 'session-secret'),
  '--state-file', path.join(temp, 'state.json'),
  '--link-ops-task-file', path.join(temp, 'tasks.json'),
  '--link-ops-chat-file', path.join(temp, 'chats.json'),
  '--manual-login-state-file', path.join(temp, 'manual-login.json'),
  '--audit-file', path.join(temp, 'audit.jsonl'),
], {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});

let stderr = '';
child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });

try {
  await waitForServer(port, child, () => stderr);
  const base = `http://127.0.0.1:${port}`;
  const publicHeaders = {'x-forwarded-for': '203.0.113.9'};

  const loginPage = await fetch(`${base}/login`, {headers: publicHeaders});
  assert.equal(loginPage.status, 200);
  assert.match(loginPage.headers.get('content-security-policy') || '', /frame-ancestors 'self'/);
  assert.equal(loginPage.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(loginPage.headers.get('strict-transport-security'), 'max-age=31536000');

  const crossOrigin = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: {...publicHeaders, 'content-type': 'application/json', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site'},
    body: JSON.stringify({username: 'security-test', password: 'wrong'}),
  });
  assert.equal(crossOrigin.status, 403);

  const secureLogin = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: {...publicHeaders, 'x-forwarded-proto': 'https', 'content-type': 'application/json', origin: `https://127.0.0.1:${port}`},
    body: JSON.stringify({username: 'security-test', password: 'correct-password'}),
  });
  assert.equal(secureLogin.status, 200);
  assert.match(secureLogin.headers.get('set-cookie') || '', /HttpOnly/);
  assert.match(secureLogin.headers.get('set-cookie') || '', /SameSite=Lax/);
  assert.match(secureLogin.headers.get('set-cookie') || '', /Secure/);
  const sessionCookie = String(secureLogin.headers.get('set-cookie') || '').split(';')[0];

  const sameOriginHeaders = {...publicHeaders, 'content-type': 'application/json', origin: base};
  const statuses = [];
  for (let index = 0; index < 8; index += 1) {
    const response = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: sameOriginHeaders,
      body: JSON.stringify({username: 'security-test', password: 'wrong'}),
    });
    statuses.push(response.status);
  }
  assert.deepEqual(statuses.slice(0, 7), Array(7).fill(401));
  assert.equal(statuses[7], 429);

  const logoutGet = await fetch(`${base}/api/logout`, {headers: {...publicHeaders, cookie: sessionCookie}});
  assert.equal(logoutGet.status, 405, 'logout is POST-only');
} finally {
  const waitForExit = timeoutMs => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  child.kill('SIGTERM');
  const exitedGracefully = await waitForExit(2_000);
  if (!exitedGracefully && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await waitForExit(2_000);
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
  await fs.rm(temp, {recursive: true, force: true});
}

console.log('portal_http_security: live headers, origin guard, secure cookie, and login throttling passed');

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
