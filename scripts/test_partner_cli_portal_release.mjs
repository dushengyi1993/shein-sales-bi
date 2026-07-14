#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {validatePartnerCliRelease} from '../lib/partner_cli_release.mjs';
import {BI_OPS_CLI_VERSION} from '../lib/partner_knowledge_cache.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'partner-cli-portal-release-'));
const auditFile = path.join(temp, 'audit.jsonl');
const authFile = path.join(temp, 'auth.json');
const packageFile = path.join(temp, `shein-bi-ops-cli-${BI_OPS_CLI_VERSION}.zip`);
const packageBytes = Buffer.from('504b030414000000000000000000000000000000000000000000', 'hex');
const packageSha256 = crypto.createHash('sha256').update(packageBytes).digest('hex');
await fs.writeFile(packageFile, packageBytes);
await fs.writeFile(`${packageFile}.sha256`, `${packageSha256}  ${path.basename(packageFile)}\n`, 'ascii');
await fs.writeFile(authFile, `${JSON.stringify({
  users: [{
    username: 'partner_release_owner',
    password: 'release-test-password',
    displayName: 'Partner Release Owner',
    role: 'owner',
    readStores: ['*'],
    writeStores: ['*'],
  }],
}, null, 2)}\n`, 'utf8');

const port = await freePort();
const child = spawn(process.execPath, [
  path.join(ROOT, 'scripts', 'serve_bi_portal.mjs'),
  '--host', '127.0.0.1',
  '--port', String(port),
  '--dir', path.join(ROOT, 'outputs', 'bi-portal'),
  '--auth-file', authFile,
  '--htpasswd-file', path.join(temp, 'missing.htpasswd'),
  '--session-secret-file', path.join(temp, 'session-secret'),
  '--state-file', path.join(temp, 'state.json'),
  '--link-ops-task-file', path.join(temp, 'tasks.json'),
  '--link-ops-chat-file', path.join(temp, 'chats.json'),
  '--manual-login-state-file', path.join(temp, 'manual-login.json'),
  '--audit-file', auditFile,
], {
  cwd: ROOT,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {...process.env, SHEIN_PARTNER_CLI_PACKAGE_FILE: packageFile},
});

let stderr = '';
child.stderr.on('data', chunk => { stderr += chunk.toString(); });

try {
  await waitForServer(port, child, () => stderr);
  const baseUrl = `http://127.0.0.1:${port}`;
  const externalHeaders = {'x-forwarded-for': '203.0.113.20'};
  const unauthenticated = await fetch(`${baseUrl}/api/partner-cli/manifest`, {headers: externalHeaders});
  assert.equal(unauthenticated.status, 401);
  const unauthenticatedPackage = await fetch(`${baseUrl}/api/partner-cli/package`, {headers: externalHeaders});
  assert.equal(unauthenticatedPackage.status, 401);

  const login = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: {...externalHeaders, 'content-type': 'application/json'},
    body: JSON.stringify({username: 'partner_release_owner', password: 'release-test-password'}),
  });
  assert.equal(login.status, 200);
  const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
  assert.match(cookie, /^bi_session=/);

  const manifestResponse = await fetch(`${baseUrl}/api/partner-cli/manifest`, {headers: {...externalHeaders, cookie}});
  assert.equal(manifestResponse.status, 200);
  assert.match(manifestResponse.headers.get('cache-control') || '', /private/);
  const etag = manifestResponse.headers.get('etag') || '';
  assert.match(etag, /^"pcli-[a-f0-9]{64}"$/);
  const manifestBody = await manifestResponse.json();
  assert.equal(manifestBody.ok, true);
  assert.equal(manifestBody.data?.version, BI_OPS_CLI_VERSION);

  const notModified = await fetch(`${baseUrl}/api/partner-cli/manifest`, {
    headers: {...externalHeaders, cookie, 'if-none-match': etag},
  });
  assert.equal(notModified.status, 304);

  const bundleResponse = await fetch(`${baseUrl}/api/partner-cli/bundle`, {headers: {...externalHeaders, cookie}});
  assert.equal(bundleResponse.status, 200);
  const bundleBody = await bundleResponse.json();
  const validated = validatePartnerCliRelease({manifest: manifestBody.data, bundle: bundleBody.data});
  assert.equal(validated.ok, true);
  assert.equal(validated.version, BI_OPS_CLI_VERSION);

  const packageResponse = await fetch(`${baseUrl}/api/partner-cli/package`, {headers: {...externalHeaders, cookie}});
  assert.equal(packageResponse.status, 200);
  assert.equal(packageResponse.headers.get('content-type'), 'application/zip');
  assert.match(packageResponse.headers.get('content-disposition') || '', new RegExp(`shein-bi-ops-cli-${BI_OPS_CLI_VERSION.replaceAll('.', '\\.')}`));
  assert.equal(packageResponse.headers.get('x-checksum-sha256'), packageSha256);
  const packageEtag = packageResponse.headers.get('etag') || '';
  assert.equal(packageEtag, `"pcli-zip-${packageSha256}"`);
  assert.deepEqual(Buffer.from(await packageResponse.arrayBuffer()), packageBytes);

  const packageNotModified = await fetch(`${baseUrl}/api/partner-cli/package`, {
    headers: {...externalHeaders, cookie, 'if-none-match': packageEtag},
  });
  assert.equal(packageNotModified.status, 304);

  const packageMethodDenied = await fetch(`${baseUrl}/api/partner-cli/package`, {method: 'POST', headers: {...externalHeaders, cookie}});
  assert.equal(packageMethodDenied.status, 405);

  const methodDenied = await fetch(`${baseUrl}/api/partner-cli/bundle`, {method: 'POST', headers: {...externalHeaders, cookie}});
  assert.equal(methodDenied.status, 405);

  const audit = await fs.readFile(auditFile, 'utf8');
  assert.match(audit, /partner-cli-bundle-download/);
  assert.match(audit, /partner-cli-package-download/);
  assert.doesNotMatch(audit, /dataBase64|release-test-password|bi_session=/);
  console.log(JSON.stringify({
    ok: true,
    version: validated.version,
    fileCount: validated.files.length,
    etag,
    authRequired: true,
    bundleValidated: true,
    packageDownloadValidated: true,
    packageSha256,
  }));
} finally {
  child.kill('SIGTERM');
  await waitForExit(child, 2_000);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await waitForExit(child, 2_000);
  }
  if (!process.exitCode) await fs.rm(temp, {recursive: true, force: true});
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const value = server.address().port;
      server.close(() => resolve(value));
    });
  });
}

async function waitForServer(portNumber, processHandle, stderrText) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (processHandle.exitCode !== null) throw new Error(`portal exited before startup: ${stderrText()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${portNumber}/login`);
      if (response.status === 200) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`portal startup timed out: ${stderrText()}`);
}

async function waitForExit(processHandle, timeoutMs) {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) return true;
  return await new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    processHandle.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
