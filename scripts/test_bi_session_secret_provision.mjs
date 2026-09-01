#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

import {
  biSessionSecretFingerprint,
  loadBiSessionSecret,
  provisionBiSessionSecret,
  validateBiSessionSecretFileStat,
  validateBiSessionSecretParentStat,
} from './provision_bi_session_secret.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROVISION_SCRIPT = path.join(ROOT, 'scripts', 'provision_bi_session_secret.mjs');
const SERVER_SCRIPT = path.join(ROOT, 'scripts', 'serve_bi_portal.mjs');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'shein-bi-session-secret-'));
const SECRET = 'A'.repeat(64);
const fakeRegular = ({mode = 0o100600, uid = 1000, size = 65, nlink = 1} = {}) => ({
  mode, uid, size, nlink, isFile: () => true,
});
const fakeDirectory = ({mode = 0o40750, uid = 1000} = {}) => ({
  mode, uid, isDirectory: () => true,
});

try {
  const existingDir = path.join(temp, 'existing');
  const existingFile = path.join(existingDir, 'secret');
  await fs.mkdir(existingDir, {mode: 0o700});
  await fs.writeFile(existingFile, `${SECRET}\n`, {encoding: 'utf8', mode: 0o600});
  await fs.chmod(existingFile, 0o600);
  const existing = await provisionBiSessionSecret(existingFile);
  assert.equal(existing.created, false);
  assert.equal(existing.secret, SECRET);
  assert.equal(existing.fingerprint, biSessionSecretFingerprint(SECRET));
  assert.equal(await loadBiSessionSecret(existingFile), SECRET);

  const missingParent = path.join(temp, 'missing-parent', 'secret');
  await assert.rejects(() => provisionBiSessionSecret(missingParent), error => {
    assert.equal(error.code, 'BI_SESSION_SECRET_PARENT_UNSAFE');
    assert.equal(error.detail.reason, 'missing');
    return true;
  });
  await assert.rejects(() => fs.access(path.dirname(missingParent)));

  const invalidDir = path.join(temp, 'invalid');
  await fs.mkdir(invalidDir, {mode: 0o700});
  const shortFile = path.join(invalidDir, 'short');
  await fs.writeFile(shortFile, 'too-short\n', {encoding: 'utf8', mode: 0o600});
  await fs.chmod(shortFile, 0o600);
  await assert.rejects(() => provisionBiSessionSecret(shortFile), error => {
    assert.equal(error.code, 'BI_SESSION_SECRET_INVALID');
    assert.ok(['size', 'content'].includes(error.detail.reason));
    return true;
  });

  const directoryTarget = path.join(invalidDir, 'directory-target');
  await fs.mkdir(directoryTarget, {mode: 0o700});
  await assert.rejects(() => provisionBiSessionSecret(directoryTarget), error => {
    assert.equal(error.code, 'BI_SESSION_SECRET_FILE_UNSAFE');
    assert.equal(error.detail.reason, 'not-regular');
    return true;
  });

  assert.throws(
    () => validateBiSessionSecretFileStat(fakeRegular({mode: 0o100640}), {platform: 'linux', euid: 1000}),
    error => error.code === 'BI_SESSION_SECRET_PERMISSIONS_INVALID' && error.detail.reason === 'mode',
  );
  assert.throws(
    () => validateBiSessionSecretFileStat(fakeRegular({uid: 1001}), {platform: 'linux', euid: 1000}),
    error => error.code === 'BI_SESSION_SECRET_PERMISSIONS_INVALID' && error.detail.reason === 'owner',
  );
  assert.throws(
    () => validateBiSessionSecretFileStat(fakeRegular({nlink: 2}), {platform: 'linux', euid: 1000}),
    error => error.code === 'BI_SESSION_SECRET_FILE_UNSAFE' && error.detail.reason === 'link-count',
  );
  assert.throws(
    () => validateBiSessionSecretFileStat({isFile: () => false}, {platform: 'linux', euid: 1000}),
    error => error.code === 'BI_SESSION_SECRET_FILE_UNSAFE' && error.detail.reason === 'not-regular',
  );
  assert.throws(
    () => validateBiSessionSecretParentStat(fakeDirectory({mode: 0o40777}), {platform: 'linux', euid: 1000}),
    error => error.code === 'BI_SESSION_SECRET_PARENT_UNSAFE' && error.detail.reason === 'world-writable',
  );
  assert.throws(
    () => validateBiSessionSecretParentStat(fakeDirectory({uid: 1001}), {platform: 'linux', euid: 1000}),
    error => error.code === 'BI_SESSION_SECRET_PARENT_UNSAFE' && error.detail.reason === 'owner',
  );

  if (process.platform !== 'win32') {
    const badModeFile = path.join(invalidDir, 'bad-mode');
    await fs.writeFile(badModeFile, `${SECRET}\n`, {encoding: 'utf8', mode: 0o640});
    await fs.chmod(badModeFile, 0o640);
    await assert.rejects(() => loadBiSessionSecret(badModeFile), error => {
      assert.equal(error.code, 'BI_SESSION_SECRET_PERMISSIONS_INVALID');
      assert.equal(error.detail.reason, 'mode');
      return true;
    });
  }

  let symlinkTested = false;
  const symlinkBacking = path.join(invalidDir, 'symlink-backing');
  const symlinkTarget = path.join(invalidDir, 'symlink-target');
  await fs.writeFile(symlinkBacking, `${SECRET}\n`, {encoding: 'utf8', mode: 0o600});
  await fs.chmod(symlinkBacking, 0o600);
  try {
    await fs.symlink(symlinkBacking, symlinkTarget, 'file');
    symlinkTested = true;
    await assert.rejects(() => provisionBiSessionSecret(symlinkTarget), error => {
      assert.equal(error.code, 'BI_SESSION_SECRET_FILE_UNSAFE');
      assert.equal(error.detail.reason, 'not-regular');
      return true;
    });
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) throw error;
  }

  const concurrentDir = path.join(temp, 'concurrent');
  const concurrentFile = path.join(concurrentDir, 'shared-secret');
  await fs.mkdir(concurrentDir, {mode: 0o700});
  const concurrent = await Promise.all(Array.from({length: 16}, () => runProcess(
    process.execPath,
    [PROVISION_SCRIPT, '--file', concurrentFile],
    {cwd: ROOT, env: {...process.env, NODE_ENV: 'test'}},
  )));
  for (const result of concurrent) {
    assert.equal(result.code, 0, `concurrent provision failed: ${result.stderr}`);
    assert.equal(result.stderr, '');
  }
  const outputs = concurrent.map(result => JSON.parse(result.stdout.trim()));
  assert.equal(outputs.filter(result => result.created).length, 1,
    'O_EXCL provisioning must have exactly one creator');
  assert.equal(new Set(outputs.map(result => result.fingerprint)).size, 1,
    'all successful processes must read back the same persistent secret');
  assert.ok(outputs.every(result => result.length === 64 && result.permissions === '0600'));
  const concurrentSecret = await loadBiSessionSecret(concurrentFile);
  assert.equal(outputs[0].fingerprint, biSessionSecretFingerprint(concurrentSecret));
  for (const result of concurrent) {
    assert.equal(result.stdout.includes(concurrentSecret), false, 'CLI output must not disclose the secret');
    assert.equal(result.stderr.includes(concurrentSecret), false, 'CLI diagnostics must not disclose the secret');
  }
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(concurrentFile)).mode & 0o777, 0o600);
  }

  const serverSource = await fs.readFile(SERVER_SCRIPT, 'utf8');
  assert.equal((serverSource.match(/\bloadBiSessionSecret\(args\.sessionSecretFile\)/gu) || []).length, 2,
    'Portal and Query must both use the same load-only helper');
  assert.doesNotMatch(serverSource, /\bensureSessionSecret\b|\bprovisionBiSessionSecret\b/,
    'the production server must not retain any session secret creation path');

  const runtimeDir = path.join(temp, 'runtime');
  const portalDir = path.join(runtimeDir, 'portal');
  const stateDir = path.join(runtimeDir, 'state');
  const authFile = path.join(runtimeDir, 'users.json');
  const rolesFile = path.join(runtimeDir, 'roles.json');
  const missingRuntimeSecret = path.join(stateDir, 'missing-secret');
  await fs.mkdir(path.join(portalDir, 'sections'), {recursive: true, mode: 0o700});
  await fs.mkdir(stateDir, {mode: 0o700});
  await fs.writeFile(path.join(portalDir, 'index.html'), '<!doctype html><title>fixture</title>', 'utf8');
  await fs.writeFile(path.join(portalDir, 'data.json'), JSON.stringify({generatedAt: new Date().toISOString()}), 'utf8');
  await fs.writeFile(authFile, JSON.stringify({users: [{username: 'secret-test', password: 'test-password', role: 'admin'}]}), 'utf8');
  await fs.writeFile(rolesFile, JSON.stringify({roles: {admin: {readStores: ['*'], writeStores: ['*']}}}), 'utf8');
  const runtimeEnv = {
    ...process.env,
    NODE_ENV: 'test',
    SHEIN_LINK_OPS_STORE: 'json',
    SHEIN_WEBHOOK_REPOSITORY_ENABLED: '0',
    SHEIN_BI_CORE_WARMUP_DISABLED: '1',
    SHEIN_BI_INTENT_PLANNER_ENABLED: '0',
    SHEIN_BI_JOB_WORKER_ENABLED: '0',
    SHEIN_BI_EXTERNAL_SECTION_QUEUE_ENABLED: '0',
    SHEIN_OWNER_KNOWLEDGE_GIT_REPO_DIR: '',
  };
  const commonArgs = [
    '--host', '127.0.0.1',
    '--dir', portalDir,
    '--auth-file', authFile,
    '--access-roles-file', rolesFile,
    '--htpasswd-file', path.join(runtimeDir, 'missing.htpasswd'),
    '--session-secret-file', missingRuntimeSecret,
    '--state-file', path.join(stateDir, 'action.json'),
    '--link-ops-task-file', path.join(stateDir, 'tasks.json'),
    '--link-ops-chat-file', path.join(stateDir, 'chats.json'),
    '--link-ops-runtime-file', path.join(stateDir, 'runtime.json'),
  ];
  const queryPort = await freePort();
  const queryFailure = await runProcess(process.execPath, [
    SERVER_SCRIPT, '--surface', 'query', '--port', String(queryPort), ...commonArgs,
  ], {cwd: ROOT, env: runtimeEnv, timeoutMs: 15_000});
  assert.notEqual(queryFailure.code, 0, 'Query must fail startup when the provisioned secret is missing');
  assert.match(queryFailure.stderr, /BI session secret is missing/);
  await assert.rejects(() => fs.access(missingRuntimeSecret), undefined,
    'Query startup must not create the missing secret');

  const portalPort = await freePort();
  const portalFailure = await runProcess(process.execPath, [
    SERVER_SCRIPT, '--port', String(portalPort),
    '--manual-login-state-file', path.join(stateDir, 'manual-login.json'),
    '--audit-file', path.join(runtimeDir, 'audit.jsonl'),
    ...commonArgs,
  ], {cwd: ROOT, env: runtimeEnv, timeoutMs: 15_000});
  assert.notEqual(portalFailure.code, 0, 'Portal must fail startup when the provisioned secret is missing');
  assert.match(portalFailure.stderr, /BI session secret is missing/);
  await assert.rejects(() => fs.access(missingRuntimeSecret), undefined,
    'Portal startup must not create the missing secret');

  console.log(JSON.stringify({
    ok: true,
    atomicCreateProcesses: concurrent.length,
    uniqueCreator: true,
    exactReadback: true,
    loadOnlyRuntimeFailures: ['portal', 'query'],
    symlinkTested,
    secretDisclosed: false,
  }, null, 2));
} finally {
  await fs.rm(temp, {recursive: true, force: true});
}

function runProcess(command, args, {cwd, env, timeoutMs = 10_000}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd, env, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`process timed out: ${command} ${args.join(' ')}`));
      resolve({code, signal, stdout, stderr});
    });
  });
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise(resolve => server.close(resolve));
  return port;
}
