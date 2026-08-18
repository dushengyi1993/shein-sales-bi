#!/usr/bin/env node
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {buildPartnerCliRelease} from '../lib/partner_cli_release.mjs';
import {checkAndInstallPartnerCliUpdate} from '../lib/partner_cli_updater.mjs';
import {acquireCrossProcessTicketLock} from '../lib/cross_process_ticket_lock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = await buildPartnerCliRelease({sourceRoot: ROOT});
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'partner-cli-updater-'));
const installRoot = path.join(temp, 'cli');
const codexHome = path.join(temp, 'codex');
const oldVersion = '2026.07.12.1';
const oldEntrypoint = path.join(installRoot, 'versions', oldVersion, 'scripts', 'bi_ops_cli.mjs');
await fs.mkdir(path.dirname(oldEntrypoint), {recursive: true});
await fs.writeFile(oldEntrypoint, 'console.log("old")\n', 'utf8');
await fs.writeFile(path.join(installRoot, 'current.json'), `${JSON.stringify({version: oldVersion, entrypoint: oldEntrypoint})}\n`, 'utf8');

const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const value = probe.address().port;
    probe.close(() => resolve(value));
  });
});
let manifestCalls = 0;
let bundleCalls = 0;
let servedManifest = release.manifest;
let return304ForConditionalManifest = false;
const server = http.createServer((req, res) => {
  if (!String(req.headers.cookie || '').includes('bi_session=test')) {
    res.writeHead(401, {'content-type': 'text/plain; charset=utf-8'});
    res.end('Unauthorized');
    return;
  }
  if (req.url === '/api/partner-cli/manifest') {
    manifestCalls += 1;
    if (return304ForConditionalManifest && req.headers['if-none-match']) {
      res.writeHead(304, {etag: `"pcli-${release.manifest.bundleSha256}"`});
      res.end();
      return;
    }
    res.writeHead(200, {'content-type': 'application/json', etag: `"pcli-${release.manifest.bundleSha256}"`});
    res.end(JSON.stringify({ok: true, data: servedManifest}));
    return;
  }
  if (req.url === '/api/partner-cli/bundle') {
    bundleCalls += 1;
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({ok: true, data: release.bundle}));
    return;
  }
  res.writeHead(404, {'content-type': 'application/json'});
  res.end(JSON.stringify({ok: false, error: 'not found'}));
});

const checks = [];
function check(label, actual, expected) {
  const pass = typeof expected === 'function' ? expected(actual) : actual === expected;
  checks.push({label, actual, expected: typeof expected === 'function' ? 'predicate' : expected, pass});
}

async function writeCurrent(pointer) {
  await fs.writeFile(path.join(installRoot, 'current.json'), `${JSON.stringify(pointer)}\n`, 'utf8');
}

function installedReleaseFile(relativePath) {
  return path.join(installRoot, 'versions', release.manifest.version, ...String(relativePath).split('/'));
}

async function restoreReleaseFile(relativePath) {
  const bundled = release.bundle.files.find(file => file.path === relativePath);
  if (!bundled) throw new Error(`Missing release test fixture: ${relativePath}`);
  const target = installedReleaseFile(relativePath);
  await fs.mkdir(path.dirname(target), {recursive: true});
  await fs.writeFile(target, Buffer.from(bundled.dataBase64, 'base64'));
}

async function corruptReleaseFileWithoutChangingSize(relativePath) {
  const target = installedReleaseFile(relativePath);
  const bytes = await fs.readFile(target);
  if (bytes.length === 0) throw new Error(`Cannot corrupt empty release test fixture: ${relativePath}`);
  const corrupted = Buffer.from(bytes);
  const index = Math.floor(corrupted.length / 2);
  corrupted[index] ^= 0x01;
  await fs.writeFile(target, corrupted);
}

async function waitFor(predicate, {timeoutMs = 5_000, intervalMs = 20} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return false;
}

async function expectedBundleBytes(relativePath) {
  const file = release.bundle.files.find(entry => entry.path === relativePath);
  if (!file) throw new Error(`Missing release test fixture: ${relativePath}`);
  return Buffer.from(file.dataBase64, 'base64');
}

async function flipByteInFile(target) {
  const bytes = await fs.readFile(target);
  const corrupted = Buffer.from(bytes);
  const index = Math.floor(corrupted.length / 2);
  corrupted[index] ^= 0x01;
  await fs.writeFile(target, corrupted);
}

async function copyBundleFilesTo(targetRoot) {
  for (const file of release.bundle.files) {
    const target = path.join(targetRoot, ...String(file.path).split('/'));
    await fs.mkdir(path.dirname(target), {recursive: true});
    await fs.writeFile(target, Buffer.from(file.dataBase64, 'base64'));
  }
}

async function versionsDirEntries(root = installRoot) {
  return (await fs.readdir(path.join(root, 'versions')).catch(() => []));
}

async function refreshInstalledBootstrap() {
  await fs.copyFile(path.join(ROOT, 'scripts', 'partner_cli_bootstrap.mjs'), path.join(installRoot, 'bootstrap.mjs'));
}

async function runBootstrap({args = ['version'], root = installRoot, timeoutMs = 0} = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'bootstrap.mjs'), ...args], {
      windowsHide: true,
      env: {...process.env, SHEIN_BI_OPS_INSTALL_ROOT: root},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs) : null;
    timeout?.unref?.();
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (timeout) clearTimeout(timeout);
      resolve({code, stdout, stderr, timedOut});
    });
  });
}

function parseBootstrapJson(result, label) {
  if (result.code !== 0 || !result.stdout.trim()) {
    throw new Error(`${label} failed: code=${result.code} stderr=${result.stderr.slice(0, 800)}`);
  }
  return JSON.parse(result.stdout);
}

// Deterministic kill: a child process runs the real updater with faultPoints
// set, and process.exit(91) fires at the named publish step. The test then
// inspects the exact on-disk crash state and resumes through the stable
// bootstrap, exactly like a killed process restarted later.
async function runCrashKill({faultPoints, currentVersion, root = installRoot, codexHome: targetCodexHome = codexHome, options = {}}) {
  const runner = path.join(temp, 'crash-runner.mjs');
  await fs.writeFile(runner, `import {checkAndInstallPartnerCliUpdate} from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'lib', 'partner_cli_updater.mjs')).href)};\n`
    + `const config = JSON.parse(process.env.CRASH_RUNNER_CONFIG);\n`
    + `const result = await checkAndInstallPartnerCliUpdate({...config.options, faultPoints: config.faultPoints});\n`
    + `if (result) {}\n`
    + `process.exit(0);\n`, 'utf8');
  const config = JSON.stringify({
    options: {
      baseUrl: `http://127.0.0.1:${port}`,
      cookie: 'bi_session=test',
      currentVersion,
      installRoot: root,
      codexHome: targetCodexHome,
      force: true,
      ...options,
    },
    faultPoints,
  });
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner], {
      windowsHide: true,
      env: {...process.env, CRASH_RUNNER_CONFIG: config},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => resolve({code, stdout, stderr}));
  });
}

async function createLegacyStableInstall({root, targetCodexHome, output}) {
  const entrypoint = path.join(root, 'versions', oldVersion, 'scripts', 'bi_ops_cli.mjs');
  const bootstrap = path.join(root, 'bootstrap.mjs');
  const skill = path.join(targetCodexHome, 'skills', 'shein-bi-ops', 'SKILL.md');
  await fs.mkdir(path.dirname(entrypoint), {recursive: true});
  await fs.mkdir(path.dirname(skill), {recursive: true});
  await fs.writeFile(entrypoint, `console.log(${JSON.stringify(output)})\n`, 'utf8');
  const bootstrapBytes = Buffer.concat([
    await fs.readFile(path.join(ROOT, 'scripts', 'partner_cli_bootstrap.mjs')),
    Buffer.from('\n// legacy stable bootstrap fixture\n', 'utf8'),
  ]);
  const skillBytes = Buffer.from('legacy stable skill fixture\n', 'utf8');
  await fs.writeFile(bootstrap, bootstrapBytes);
  await fs.writeFile(skill, skillBytes);
  await fs.writeFile(path.join(root, 'current.json'), `${JSON.stringify({version: oldVersion, entrypoint})}\n`, 'utf8');
  return {bootstrap, bootstrapBytes, entrypoint, skill, skillBytes};
}

async function installedVersionRootExists(root = installRoot) {
  return Boolean(await fs.lstat(path.join(root, 'versions', release.manifest.version)).catch(() => null));
}

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  let expiredError = null;
  try {
    await checkAndInstallPartnerCliUpdate({
      baseUrl: `http://127.0.0.1:${port}`,
      cookie: 'bi_session=expired',
      currentVersion: oldVersion,
      installRoot,
      codexHome,
    });
  } catch (error) {
    expiredError = error;
  }
  check('plain-text 401 has stable error code', expiredError?.code, 'BI_SESSION_EXPIRED');
  check('plain-text 401 keeps HTTP status', expiredError?.status, 401);
  check('plain-text 401 asks for BI login', expiredError?.message, text => text.includes('BI 登录已失效') && text.includes('login --username'));
  check('plain-text 401 is not mislabeled invalid JSON', expiredError?.message, text => !text.includes('invalid JSON'));

  const updated = await checkAndInstallPartnerCliUpdate({
    baseUrl: `http://127.0.0.1:${port}`,
    cookie: 'bi_session=test',
    currentVersion: oldVersion,
    installRoot,
    codexHome,
  });
  check('update installed', updated.updated, true);
  check('latest version selected', updated.latestVersion, release.manifest.version);
  check('manifest requested once', manifestCalls, 1);
  check('bundle requested once', bundleCalls, 1);
  const current = JSON.parse(await fs.readFile(path.join(installRoot, 'current.json'), 'utf8'));
  check('current pointer switched', current.version, release.manifest.version);
  check('current pointer has bundle hash', current.bundleSha256, release.manifest.bundleSha256);
  check('new entrypoint exists', Boolean(await fs.stat(current.entrypoint)), true);
  check('stable bootstrap installed', Boolean(await fs.stat(path.join(installRoot, 'bootstrap.mjs'))), true);
  const skill = await fs.readFile(path.join(codexHome, 'skills', 'shein-bi-ops', 'SKILL.md'), 'utf8');
  check('Codex skill installed', skill, text => text.includes('已审可用') && text.includes('prepare-publish'));

  const freshCachedCheck = await checkAndInstallPartnerCliUpdate({
    baseUrl: `http://127.0.0.1:${port}`,
    cookie: 'bi_session=test',
    currentVersion: release.manifest.version,
    installRoot,
    codexHome,
    maxAgeMs: 5 * 60_000,
  });
  check('fresh update check uses local TTL cache', freshCachedCheck.source, 'fresh-check-cache');
  check('fresh update check makes no manifest request', manifestCalls, 1);

  const currentCheck = await checkAndInstallPartnerCliUpdate({
    baseUrl: `http://127.0.0.1:${port}`,
    cookie: 'bi_session=test',
    currentVersion: release.manifest.version,
    installRoot,
    codexHome,
    force: true,
  });
  check('current release is not reinstalled', currentCheck.updated, false);
  check('bundle not downloaded twice', bundleCalls, 1);

  let manifestCallsBefore = manifestCalls;
  let bundleCallsBefore = bundleCalls;
  return304ForConditionalManifest = true;
  const validEtagCheck = await checkAndInstallPartnerCliUpdate({
    baseUrl: `http://127.0.0.1:${port}`,
    cookie: 'bi_session=test',
    currentVersion: release.manifest.version,
    installRoot,
    codexHome,
  });
  return304ForConditionalManifest = false;
  check('valid 304 cache reuses verified installation', validEtagCheck.source, 'etag-304');
  check('valid 304 cache makes one conditional manifest request', manifestCalls, manifestCallsBefore + 1);
  check('valid 304 cache does not download bundle', bundleCalls, bundleCallsBefore);

  manifestCallsBefore = manifestCalls;
  bundleCallsBefore = bundleCalls;
  const currentPointerReuse = await checkAndInstallPartnerCliUpdate({
    baseUrl: `http://127.0.0.1:${port}`,
    currentVersion: oldVersion,
    installRoot,
    codexHome,
  });
  check('newer current pointer reuses a fully verified installation', currentPointerReuse.source, 'current-pointer');
  check('newer current pointer returns its version entrypoint', currentPointerReuse.entrypoint, current.entrypoint);
  check('newer current pointer needs no manifest request', manifestCalls, manifestCallsBefore);
  check('newer current pointer needs no bundle request', bundleCalls, bundleCallsBefore);

  manifestCallsBefore = manifestCalls;
  bundleCallsBefore = bundleCalls;
  await writeCurrent({...current, entrypoint: oldEntrypoint});
  const wrongVersionDirectoryRepair = await checkAndInstallPartnerCliUpdate({
    baseUrl: `http://127.0.0.1:${port}`,
    cookie: 'bi_session=test',
    currentVersion: oldVersion,
    installRoot,
    codexHome,
    force: true,
  });
  const repairedVersionDirectoryPointer = JSON.parse(await fs.readFile(path.join(installRoot, 'current.json'), 'utf8'));
  check('current pointer entrypoint outside its version directory cannot short-circuit', wrongVersionDirectoryRepair.source, source => source !== 'current-pointer');
  check('wrong version-directory entrypoint downloads manifest', manifestCalls, manifestCallsBefore + 1);
  check('wrong version-directory entrypoint downloads bundle', bundleCalls, bundleCallsBefore + 1);
  check('wrong version-directory entrypoint is repaired', repairedVersionDirectoryPointer.entrypoint, current.entrypoint);

  manifestCallsBefore = manifestCalls;
  bundleCallsBefore = bundleCalls;
  await fs.rm(current.entrypoint, {force: true});
  await writeCurrent(current);
  const missingEntrypointRepair = await checkAndInstallPartnerCliUpdate({
    baseUrl: `http://127.0.0.1:${port}`,
    cookie: 'bi_session=test',
    currentVersion: release.manifest.version,
    installRoot,
    codexHome,
    force: true,
  });
  const repairedEntrypointStat = await fs.lstat(current.entrypoint).catch(() => null);
  check('same-version correct bundle hash does not hide a missing entrypoint', missingEntrypointRepair.updated, true);
  check('missing entrypoint downloads manifest', manifestCalls, manifestCallsBefore + 1);
  check('missing entrypoint downloads bundle', bundleCalls, bundleCallsBefore + 1);
  check('missing entrypoint is restored as a regular file', repairedEntrypointStat?.isFile(), true);

  const damagedReleasePath = 'lib/partner_knowledge_cache.mjs';
  manifestCallsBefore = manifestCalls;
  bundleCallsBefore = bundleCalls;
  await corruptReleaseFileWithoutChangingSize(damagedReleasePath);
  const damagedFileRepair = await checkAndInstallPartnerCliUpdate({
    baseUrl: `http://127.0.0.1:${port}`,
    cookie: 'bi_session=test',
    currentVersion: release.manifest.version,
    installRoot,
    codexHome,
    force: true,
  });
  const restoredDamagedFile = await fs.readFile(installedReleaseFile(damagedReleasePath));
  const expectedDamagedFile = Buffer.from(release.bundle.files.find(file => file.path === damagedReleasePath).dataBase64, 'base64');
  check('same-version installed file corruption is repaired', damagedFileRepair.updated, true);
  check('installed file corruption downloads manifest', manifestCalls, manifestCallsBefore + 1);
  check('installed file corruption downloads bundle', bundleCalls, bundleCallsBefore + 1);
  check('installed file corruption restores exact bundle bytes', restoredDamagedFile.equals(expectedDamagedFile), true);

  manifestCallsBefore = manifestCalls;
  bundleCallsBefore = bundleCalls;
  await writeCurrent({...current, bundleSha256: '0'.repeat(64)});
  const wrongHashRepair = await checkAndInstallPartnerCliUpdate({
    baseUrl: `http://127.0.0.1:${port}`,
    cookie: 'bi_session=test',
    currentVersion: release.manifest.version,
    installRoot,
    codexHome,
    force: true,
  });
  const repairedWrongHashPointer = JSON.parse(await fs.readFile(path.join(installRoot, 'current.json'), 'utf8'));
  check('same-version wrong hash is repaired', wrongHashRepair.updated, true);
  check('same-version wrong hash returns restart entrypoint', wrongHashRepair.entrypoint, current.entrypoint);
  check('same-version wrong hash downloads manifest', manifestCalls, manifestCallsBefore + 1);
  check('same-version wrong hash downloads bundle', bundleCalls, bundleCallsBefore + 1);
  check('same-version wrong hash pointer is corrected', repairedWrongHashPointer.bundleSha256, release.manifest.bundleSha256);

  manifestCallsBefore = manifestCalls;
  bundleCallsBefore = bundleCalls;
  const {bundleSha256: omittedBundleSha256, ...missingHashPointer} = current;
  check('same-version missing hash fixture omits hash', omittedBundleSha256, release.manifest.bundleSha256);
  await writeCurrent(missingHashPointer);
  const missingHashRepair = await checkAndInstallPartnerCliUpdate({
    baseUrl: `http://127.0.0.1:${port}`,
    cookie: 'bi_session=test',
    currentVersion: release.manifest.version,
    installRoot,
    codexHome,
    force: true,
  });
  const repairedMissingHashPointer = JSON.parse(await fs.readFile(path.join(installRoot, 'current.json'), 'utf8'));
  check('same-version missing hash is repaired', missingHashRepair.updated, true);
  check('same-version missing hash returns restart entrypoint', missingHashRepair.entrypoint, current.entrypoint);
  check('same-version missing hash downloads manifest', manifestCalls, manifestCallsBefore + 1);
  check('same-version missing hash downloads bundle', bundleCalls, bundleCallsBefore + 1);
  check('same-version missing hash pointer is corrected', repairedMissingHashPointer.bundleSha256, release.manifest.bundleSha256);

  manifestCallsBefore = manifestCalls;
  bundleCallsBefore = bundleCalls;
  await writeCurrent({...current, bundleSha256: '1'.repeat(64)});
  const ttlMismatchRepair = await checkAndInstallPartnerCliUpdate({
    baseUrl: `http://127.0.0.1:${port}`,
    cookie: 'bi_session=test',
    currentVersion: release.manifest.version,
    installRoot,
    codexHome,
    maxAgeMs: 5 * 60_000,
  });
  check('TTL cache does not hide same-version hash mismatch', ttlMismatchRepair.source, source => source !== 'fresh-check-cache');
  check('TTL hash mismatch fetches manifest', manifestCalls, manifestCallsBefore + 1);
  check('TTL hash mismatch fetches bundle', bundleCalls, bundleCallsBefore + 1);
  check('TTL hash mismatch is repaired', ttlMismatchRepair.updated, true);

  manifestCallsBefore = manifestCalls;
  bundleCallsBefore = bundleCalls;
  await writeCurrent(current);
  await corruptReleaseFileWithoutChangingSize(damagedReleasePath);
  const ttlContentRepair = await checkAndInstallPartnerCliUpdate({
    baseUrl: `http://127.0.0.1:${port}`,
    cookie: 'bi_session=test',
    currentVersion: release.manifest.version,
    installRoot,
    codexHome,
    maxAgeMs: 5 * 60_000,
  });
  check('TTL cache does not hide installed file corruption', ttlContentRepair.source, source => source !== 'fresh-check-cache');
  check('TTL content corruption fetches manifest', manifestCalls, manifestCallsBefore + 1);
  check('TTL content corruption fetches bundle', bundleCalls, bundleCallsBefore + 1);
  check('TTL content corruption is repaired', ttlContentRepair.updated, true);

  manifestCallsBefore = manifestCalls;
  bundleCallsBefore = bundleCalls;
  await fs.rm(current.entrypoint, {force: true});
  await writeCurrent(current);
  return304ForConditionalManifest = true;
  const etagMissingEntrypointRepair = await checkAndInstallPartnerCliUpdate({
    baseUrl: `http://127.0.0.1:${port}`,
    cookie: 'bi_session=test',
    currentVersion: release.manifest.version,
    installRoot,
    codexHome,
  });
  return304ForConditionalManifest = false;
  check('304 cache does not hide a missing entrypoint', etagMissingEntrypointRepair.updated, true);
  check('304 missing entrypoint triggers conditional and unconditional manifests', manifestCalls, manifestCallsBefore + 2);
  check('304 missing entrypoint fetches bundle', bundleCalls, bundleCallsBefore + 1);
  check('304 missing entrypoint restores a regular file', (await fs.lstat(current.entrypoint).catch(() => null))?.isFile(), true);

  manifestCallsBefore = manifestCalls;
  bundleCallsBefore = bundleCalls;
  await writeCurrent({...current, bundleSha256: '2'.repeat(64)});
  return304ForConditionalManifest = true;
  const etagMismatchRepair = await checkAndInstallPartnerCliUpdate({
    baseUrl: `http://127.0.0.1:${port}`,
    cookie: 'bi_session=test',
    currentVersion: release.manifest.version,
    installRoot,
    codexHome,
  });
  return304ForConditionalManifest = false;
  check('304 hash mismatch triggers conditional and unconditional manifests', manifestCalls, manifestCallsBefore + 2);
  check('304 hash mismatch fetches bundle', bundleCalls, bundleCallsBefore + 1);
  check('304 hash mismatch is repaired', etagMismatchRepair.updated, true);

  manifestCallsBefore = manifestCalls;
  bundleCallsBefore = bundleCalls;
  await writeCurrent(current);
  await corruptReleaseFileWithoutChangingSize(damagedReleasePath);
  const updateLockFile = path.join(installRoot, '.update.lock');
  const releaseRepairingPeerLock = await acquireCrossProcessTicketLock(updateLockFile, {
    timeoutMs: 5_000,
    staleMs: 30_000,
    heartbeatMs: 1_000,
    pollMs: 20,
  });
  let repairingPeerManifestFetched = false;
  const repairingPeerFetch = async (url, options) => {
    const response = await fetch(url, options);
    if (String(url).endsWith('/api/partner-cli/manifest')) repairingPeerManifestFetched = true;
    return response;
  };
  const repairingPeerPending = checkAndInstallPartnerCliUpdate({
    baseUrl: `http://127.0.0.1:${port}`,
    cookie: 'bi_session=test',
    currentVersion: release.manifest.version,
    installRoot,
    codexHome,
    force: true,
    fetchImpl: repairingPeerFetch,
  }).then(value => ({value}), error => ({error}));
  const repairingPeerReachedManifest = await waitFor(() => repairingPeerManifestFetched);
  const repairingPeerCallerQueued = await waitFor(async () => (
    await fs.readdir(`${updateLockFile}.tickets`).catch(() => [])
  ).filter(name => name.endsWith('.json')).length >= 2);
  await restoreReleaseFile(damagedReleasePath);
  await writeCurrent({...current, installedAt: new Date().toISOString()});
  await releaseRepairingPeerLock();
  const repairingPeerOutcome = await repairingPeerPending;
  if (repairingPeerOutcome.error) throw repairingPeerOutcome.error;
  const repairedByPeer = repairingPeerOutcome.value;
  check('same-version repairing peer is observed after manifest', repairingPeerReachedManifest, true);
  check('same-version caller waits behind repairing peer lock', repairingPeerCallerQueued, true);
  check('same-version peer repair is reused', repairedByPeer.source, 'updated-by-peer');
  check('same-version peer repair relaunches caller', repairedByPeer.updated, true);
  check('same-version peer repair returns entrypoint', repairedByPeer.entrypoint, current.entrypoint);
  check('same-version peer repair fetches one manifest', manifestCalls, manifestCallsBefore + 1);
  check('same-version peer repair avoids caller bundle download', bundleCalls, bundleCallsBefore);

  manifestCallsBefore = manifestCalls;
  bundleCallsBefore = bundleCalls;
  await writeCurrent(current);
  await corruptReleaseFileWithoutChangingSize(damagedReleasePath);
  const releaseIncorrectPeerLock = await acquireCrossProcessTicketLock(updateLockFile, {
    timeoutMs: 5_000,
    staleMs: 30_000,
    heartbeatMs: 1_000,
    pollMs: 20,
  });
  let incorrectPeerManifestFetched = false;
  const incorrectPeerFetch = async (url, options) => {
    const response = await fetch(url, options);
    if (String(url).endsWith('/api/partner-cli/manifest')) incorrectPeerManifestFetched = true;
    return response;
  };
  const incorrectPeerPending = checkAndInstallPartnerCliUpdate({
    baseUrl: `http://127.0.0.1:${port}`,
    cookie: 'bi_session=test',
    currentVersion: release.manifest.version,
    installRoot,
    codexHome,
    force: true,
    fetchImpl: incorrectPeerFetch,
  }).then(value => ({value}), error => ({error}));
  const incorrectPeerReachedManifest = await waitFor(() => incorrectPeerManifestFetched);
  const incorrectPeerCallerQueued = await waitFor(async () => (
    await fs.readdir(`${updateLockFile}.tickets`).catch(() => [])
  ).filter(name => name.endsWith('.json')).length >= 2);
  await writeCurrent({...current, installedAt: new Date().toISOString()});
  await releaseIncorrectPeerLock();
  const incorrectPeerOutcome = await incorrectPeerPending;
  if (incorrectPeerOutcome.error) throw incorrectPeerOutcome.error;
  const incorrectPeerRepair = incorrectPeerOutcome.value;
  check('incorrect peer is observed after manifest', incorrectPeerReachedManifest, true);
  check('caller waits behind incorrect peer lock', incorrectPeerCallerQueued, true);
  check('incorrect peer cannot short-circuit caller repair', incorrectPeerRepair.source, source => source !== 'updated-by-peer');
  check('incorrect peer triggers caller bundle download', bundleCalls, bundleCallsBefore + 1);
  check('incorrect peer damage is repaired by caller', incorrectPeerRepair.updated, true);
  check('incorrect peer path fetches one manifest', manifestCalls, manifestCallsBefore + 1);

  manifestCallsBefore = manifestCalls;
  bundleCallsBefore = bundleCalls;
  const peerWrongHash = {...current, bundleSha256: '3'.repeat(64)};
  await writeCurrent(peerWrongHash);
  const wrongHashPeerFetch = async (url, options) => {
    const response = await fetch(url, options);
    if (String(url).endsWith('/api/partner-cli/manifest')) await writeCurrent(peerWrongHash);
    return response;
  };
  const peerWrongHashRepair = await checkAndInstallPartnerCliUpdate({
    baseUrl: `http://127.0.0.1:${port}`,
    cookie: 'bi_session=test',
    currentVersion: release.manifest.version,
    installRoot,
    codexHome,
    force: true,
    fetchImpl: wrongHashPeerFetch,
  });
  check('peer same-version wrong hash cannot short-circuit', peerWrongHashRepair.source, source => source !== 'updated-by-peer');
  check('peer same-version wrong hash downloads bundle', bundleCalls, bundleCallsBefore + 1);
  check('peer same-version wrong hash is repaired', peerWrongHashRepair.updated, true);
  check('peer same-version wrong hash fetched manifest', manifestCalls, manifestCallsBefore + 1);

  for (const invalidBundleSha256 of ['', 'not-a-sha256']) {
    manifestCallsBefore = manifestCalls;
    bundleCallsBefore = bundleCalls;
    servedManifest = {...release.manifest, bundleSha256: invalidBundleSha256};
    await writeCurrent(current);
    let invalidManifestError = null;
    try {
      await checkAndInstallPartnerCliUpdate({
        baseUrl: `http://127.0.0.1:${port}`,
        cookie: 'bi_session=test',
        currentVersion: release.manifest.version,
        installRoot,
        codexHome,
        force: true,
      });
    } catch (error) {
      invalidManifestError = error;
    }
    check(`same-version manifest hash ${invalidBundleSha256 ? 'invalid' : 'missing'} fails closed`, invalidManifestError?.message, message => message?.includes('bundleSha256'));
    check(`same-version manifest hash ${invalidBundleSha256 ? 'invalid' : 'missing'} fetches manifest`, manifestCalls, manifestCallsBefore + 1);
    check(`same-version manifest hash ${invalidBundleSha256 ? 'invalid' : 'missing'} does not fetch bundle`, bundleCalls, bundleCallsBefore);
  }
  servedManifest = release.manifest;

  await writeCurrent({version: oldVersion, entrypoint: oldEntrypoint});
  const peerFetch = async (url, options) => {
    const response = await fetch(url, options);
    if (String(url).endsWith('/api/partner-cli/manifest')) {
      await fs.writeFile(path.join(installRoot, 'current.json'), `${JSON.stringify(current)}\n`, 'utf8');
    }
    return response;
  };
  const peerAdvanced = await checkAndInstallPartnerCliUpdate({
    baseUrl: `http://127.0.0.1:${port}`,
    cookie: 'bi_session=test',
    currentVersion: oldVersion,
    installRoot,
    codexHome,
    force: true,
    fetchImpl: peerFetch,
  });
  check('peer-installed release relaunches old process', peerAdvanced.updated, true);
  check('peer-installed release reports peer source', peerAdvanced.source, 'updated-by-peer');
  check('peer-installed release returns current entrypoint', peerAdvanced.entrypoint, current.entrypoint);
  check('peer-installed release does not redownload bundle', bundleCalls, bundleCallsBefore);
  await refreshInstalledBootstrap();

  // Stable bootstrap/SKILL publication must have no "move old target to .bak,
  // then publish temp" phase. The two deterministic kill points bracket the
  // one same-directory atomic replace: before it the exact old file must still
  // launch, and after it the exact new file must launch the old pointer. The
  // same invariant applies to the skill even though bootstrap availability is
  // the higher-priority recovery gate.
  const stableBeforeRoot = path.join(temp, 'stable-before-cli');
  const stableBeforeCodex = path.join(temp, 'stable-before-codex');
  const stableBeforeFixture = await createLegacyStableInstall({
    root: stableBeforeRoot,
    targetCodexHome: stableBeforeCodex,
    output: 'old-before-bootstrap-replace',
  });
  const stableBefore = await runCrashKill({
    faultPoints: {'bootstrap-write-before-atomic-replace': true, exitCode: 91},
    currentVersion: oldVersion,
    root: stableBeforeRoot,
    codexHome: stableBeforeCodex,
  });
  check('kill fires before stable bootstrap atomic replace', stableBefore.code, 91);
  check('pre-replace kill preserves exact old bootstrap bytes',
    (await fs.readFile(stableBeforeFixture.bootstrap)).equals(stableBeforeFixture.bootstrapBytes), true);
  check('pre-replace kill creates no bootstrap backup gap artifact',
    (await fs.readdir(stableBeforeRoot)).filter(name => name.startsWith('bootstrap.mjs.') && name.endsWith('.bak')).length, 0);
  const stableBeforeBoot = await runBootstrap({root: stableBeforeRoot, args: []});
  check('next bootstrap run after pre-replace kill launches old version',
    stableBeforeBoot.code === 0 && stableBeforeBoot.stdout.trim() === 'old-before-bootstrap-replace', true);

  const stableErrorRoot = path.join(temp, 'stable-error-cli');
  const stableErrorCodex = path.join(temp, 'stable-error-codex');
  const stableErrorFixture = await createLegacyStableInstall({
    root: stableErrorRoot,
    targetCodexHome: stableErrorCodex,
    output: 'old-after-bootstrap-replace-error',
  });
  const stableError = await runCrashKill({
    faultPoints: {'bootstrap-write-atomic-replace-error': {code: 'EPERM'}},
    currentVersion: oldVersion,
    root: stableErrorRoot,
    codexHome: stableErrorCodex,
  });
  check('exhausted Windows atomic replace retries fail the update', stableError.code !== 0, true);
  check('atomic replace failure preserves exact old bootstrap bytes',
    (await fs.readFile(stableErrorFixture.bootstrap)).equals(stableErrorFixture.bootstrapBytes), true);
  check('atomic replace failure never moves bootstrap to backup',
    (await fs.readdir(stableErrorRoot)).filter(name => name.startsWith('bootstrap.mjs.') && name.endsWith('.bak')).length, 0);
  const stableErrorBoot = await runBootstrap({root: stableErrorRoot, args: []});
  check('next bootstrap run after atomic replace failure launches old version',
    stableErrorBoot.code === 0 && stableErrorBoot.stdout.trim() === 'old-after-bootstrap-replace-error', true);

  const stableAfterRoot = path.join(temp, 'stable-after-cli');
  const stableAfterCodex = path.join(temp, 'stable-after-codex');
  const stableAfterFixture = await createLegacyStableInstall({
    root: stableAfterRoot,
    targetCodexHome: stableAfterCodex,
    output: 'old-after-bootstrap-replace',
  });
  const stableAfter = await runCrashKill({
    faultPoints: {'bootstrap-write-after-atomic-replace': true, exitCode: 91},
    currentVersion: oldVersion,
    root: stableAfterRoot,
    codexHome: stableAfterCodex,
  });
  check('kill fires after stable bootstrap atomic replace', stableAfter.code, 91);
  check('post-replace kill leaves exact new bootstrap bytes',
    (await fs.readFile(stableAfterFixture.bootstrap)).equals(await expectedBundleBytes(release.manifest.bootstrap)), true);
  check('post-replace kill creates no bootstrap backup gap artifact',
    (await fs.readdir(stableAfterRoot)).filter(name => name.startsWith('bootstrap.mjs.') && name.endsWith('.bak')).length, 0);
  const stableAfterBoot = await runBootstrap({root: stableAfterRoot, args: []});
  check('next bootstrap run after post-replace kill launches old version',
    stableAfterBoot.code === 0 && stableAfterBoot.stdout.trim() === 'old-after-bootstrap-replace', true);

  const skillBeforeRoot = path.join(temp, 'skill-before-cli');
  const skillBeforeCodex = path.join(temp, 'skill-before-codex');
  const skillBeforeFixture = await createLegacyStableInstall({
    root: skillBeforeRoot,
    targetCodexHome: skillBeforeCodex,
    output: 'old-before-skill-replace',
  });
  const skillBefore = await runCrashKill({
    faultPoints: {'skill-write-before-atomic-replace': true, exitCode: 91},
    currentVersion: oldVersion,
    root: skillBeforeRoot,
    codexHome: skillBeforeCodex,
  });
  check('kill fires before stable skill atomic replace', skillBefore.code, 91);
  check('pre-replace kill preserves exact old skill bytes',
    (await fs.readFile(skillBeforeFixture.skill)).equals(skillBeforeFixture.skillBytes), true);
  check('pre-replace kill creates no skill backup gap artifact',
    (await fs.readdir(path.dirname(skillBeforeFixture.skill))).filter(name => name.startsWith('SKILL.md.') && name.endsWith('.bak')).length, 0);
  const skillBeforeBoot = await runBootstrap({root: skillBeforeRoot, args: []});
  check('bootstrap still launches old version after pre-skill-replace kill',
    skillBeforeBoot.code === 0 && skillBeforeBoot.stdout.trim() === 'old-before-skill-replace', true);

  const skillAfterRoot = path.join(temp, 'skill-after-cli');
  const skillAfterCodex = path.join(temp, 'skill-after-codex');
  const skillAfterFixture = await createLegacyStableInstall({
    root: skillAfterRoot,
    targetCodexHome: skillAfterCodex,
    output: 'old-after-skill-replace',
  });
  const skillAfter = await runCrashKill({
    faultPoints: {'skill-write-after-atomic-replace': true, exitCode: 91},
    currentVersion: oldVersion,
    root: skillAfterRoot,
    codexHome: skillAfterCodex,
  });
  check('kill fires after stable skill atomic replace', skillAfter.code, 91);
  check('post-replace kill leaves exact new skill bytes',
    (await fs.readFile(skillAfterFixture.skill)).equals(await expectedBundleBytes(release.manifest.codexSkill)), true);
  check('post-replace kill creates no skill backup gap artifact',
    (await fs.readdir(path.dirname(skillAfterFixture.skill))).filter(name => name.startsWith('SKILL.md.') && name.endsWith('.bak')).length, 0);
  const skillAfterBoot = await runBootstrap({root: skillAfterRoot, args: []});
  check('bootstrap still launches old version after post-skill-replace kill',
    skillAfterBoot.code === 0 && skillAfterBoot.stdout.trim() === 'old-after-skill-replace', true);

 const ticketQueue = `${updateLockFile}.tickets`;
 await fs.mkdir(ticketQueue, {recursive: true});
  // A "gone owner" ticket simulates the original lock owner no longer being
  // alive even though its slot may still matter: on Linux, a mismatched
  // processStart proves the live PID was recycled by a different process; on
  // platforms without /proc identity, a dead PID is the only observable
  // signal that the original owner is gone.
  async function writeGoneOwnerTicket(name) {
    const file = path.join(ticketQueue, name);
    const goneOwner = process.platform === 'linux'
      ? {pid: process.pid, processStart: '0'}
      : {pid: 2_147_483_647, processStart: ''};
    await fs.writeFile(file, JSON.stringify({
      pid: goneOwner.pid,
      nonce: name.replace(/\.json$/u, ''),
      processStart: goneOwner.processStart,
      orderNs: '0',
      at: new Date(Date.now() - 20 * 60_000).toISOString(),
    }));
    const stale = new Date(Date.now() - 20 * 60_000);
    await fs.utimes(file, stale, stale);
    return file;
  }

  const staleLibraryTicket = await writeGoneOwnerTicket('00000000000000000000000000000001.json');
  const releaseAfterPidReuse = await acquireCrossProcessTicketLock(updateLockFile, {
    timeoutMs: 2_000,
    staleMs: 100,
    heartbeatMs: 25,
    pollMs: 25,
  });
  await releaseAfterPidReuse();
  check('stale ticket whose original owner is gone is reclaimed (reused PID or dead)',
    Boolean(await fs.lstat(staleLibraryTicket).catch(() => null)), false);

  const staleBootstrapTicket = await writeGoneOwnerTicket('00000000000000000000000000000002.json');
  await fs.rm(path.join(installRoot, 'current.json'), {force: true});
  const reusedPidBootstrap = await runBootstrap({args: ['version'], timeoutMs: 5_000});
  const reusedPidBootstrapOut = parseBootstrapJson(reusedPidBootstrap, 'gone-owner ticket bootstrap recovery');
  check('bootstrap does not remain blocked behind a stale ticket whose original owner is gone',
    !reusedPidBootstrap.timedOut && reusedPidBootstrapOut.version === release.manifest.version, true);
  check('bootstrap removes the stale gone-owner ticket',
    Boolean(await fs.lstat(staleBootstrapTicket).catch(() => null)), false);

  // Bootstrap-path counterexample: the bootstrap's own ticket reaper must
  // treat a trusted owner whose process is still alive exactly like the lib
  // does — never reclaim it merely because its mtime was aged past the stale
  // threshold. Fabricate a live-owner ticket owned by this very process (with
  // a verifiable identity where /proc exists), age it 20 minutes, remove the
  // pointer so a real bootstrap child enters recovery and races the same
  // lock queue, and prove the child queues behind the live owner instead of
  // stealing the lock.
  const bootstrapCounterQueue = `${updateLockFile}.tickets`;
  await fs.mkdir(bootstrapCounterQueue, {recursive: true});
  const bootstrapSavedPointer = await fs.readFile(path.join(installRoot, 'current.json'), 'utf8');
  const bootstrapOwnerTicket = path.join(bootstrapCounterQueue, `${'b'.repeat(32)}.json`);
  const ownProcStat = await fs.readFile(`/proc/${process.pid}/stat`, 'utf8').catch(() => '');
  const ownStartClose = ownProcStat.lastIndexOf(')');
  const ownStartTicks = process.platform === 'linux' && ownStartClose >= 0
    ? (ownProcStat.slice(ownStartClose + 1).trim().split(/\s+/u)[19] || '')
    : '';
  await fs.writeFile(bootstrapOwnerTicket, JSON.stringify({
    pid: process.pid,
    nonce: 'b'.repeat(32),
    processStart: ownStartTicks,
    orderNs: '1',
    at: new Date(Date.now() - 20 * 60_000).toISOString(),
  }), 'utf8');
  const bootstrapOwnerPast = new Date(Date.now() - 20 * 60_000);
  await fs.utimes(bootstrapOwnerTicket, bootstrapOwnerPast, bootstrapOwnerPast);
  try {
    await fs.rm(path.join(installRoot, 'current.json'), {force: true});
    const blockedBootstrap = await runBootstrap({args: ['version'], timeoutMs: 8_000});
    check('bootstrap queues behind a stale-mtime live owner instead of stealing the lock',
      blockedBootstrap.timedOut === true, true);
    check('bootstrap-path live owner ticket survives the stale-mtime race',
      Boolean(await fs.lstat(bootstrapOwnerTicket).catch(() => null)), true);
  } finally {
    for (const name of await fs.readdir(bootstrapCounterQueue).catch(() => [])) {
      if (!name.endsWith('.json')) continue;
      await fs.rm(path.join(bootstrapCounterQueue, name), {force: true}).catch(() => {});
    }
    await fs.writeFile(path.join(installRoot, 'current.json'), bootstrapSavedPointer, 'utf8').catch(() => {});
  }
  const afterCounter = await runBootstrap({args: ['version'], timeoutMs: 8_000});
  const afterCounterOut = parseBootstrapJson(afterCounter, 'bootstrap live-owner counterexample cleanup recovery');
  check('bootstrap install remains launchable after the live-owner race cleanup',
    afterCounterOut.version === release.manifest.version, true);

  // Legacy/malformed tickets carry no trusted owner, so stale age is the only
  // reclaim path for them: an unreadable or ownerless ticket whose age crossed
  // the stale threshold must not keep a queue blocked, while a fresh one must
  // not be prematurely reclaimed before its stale age.
  const legacyMalformedLock = path.join(temp, 'legacy-malformed-age.lock');
  const legacyMalformedQueue = `${legacyMalformedLock}.tickets`;
  await fs.mkdir(legacyMalformedQueue, {recursive: true});
  const stale = new Date(Date.now() - 20 * 60_000);
  const staleMalformed = path.join(legacyMalformedQueue, `${'f'.repeat(32)}.json`);
  await fs.writeFile(staleMalformed, 'not-json', 'utf8');
  await fs.utimes(staleMalformed, stale, stale);
  const staleLegacy = path.join(legacyMalformedQueue, `${'e'.repeat(32)}.json`);
  await fs.writeFile(staleLegacy, JSON.stringify({orderNs: '0', at: new Date().toISOString()}), 'utf8');
  await fs.utimes(staleLegacy, stale, stale);
  const ageGateRelease = await acquireCrossProcessTicketLock(legacyMalformedLock, {
    timeoutMs: 2_000,
    staleMs: 60_000,
    heartbeatMs: 25,
    pollMs: 25,
  });
  await ageGateRelease();
  check('stale malformed ticket is reclaimed by age',
    Boolean(await fs.lstat(staleMalformed).catch(() => null)), false);
  check('stale ownerless legacy ticket is reclaimed by age',
    Boolean(await fs.lstat(staleLegacy).catch(() => null)), false);
  const freshMalformed = path.join(legacyMalformedQueue, `${'a'.repeat(32)}.json`);
  await fs.writeFile(freshMalformed, 'not-json', 'utf8');
  const freshNotReaped = await new Promise(resolve => {
    acquireCrossProcessTicketLock(legacyMalformedLock, {
      timeoutMs: 800,
      staleMs: 60_000,
      heartbeatMs: 25,
      pollMs: 25,
      timeoutCode: 'FRESH_MALFORMED_NOT_REAPED',
    }).then(async release => { await release(); resolve(false); }, error => {
      resolve(error?.code === 'FRESH_MALFORMED_NOT_REAPED');
    });
  });
  check('fresh malformed ticket is not prematurely reclaimed before its stale age', freshNotReaped, true);

  // A trusted owner whose process is still alive must never be stolen by a
  // stale-mtime reaper: a stalled heartbeat, clock skew, or coarse filesystem
  // timestamps must not fracture the mutual exclusion. Hold the real lock,
  // force the live owner ticket mtime into the past, stop the heartbeat from
  // refreshing it, and prove a competing acquirer with an aggressive stale
  // threshold cannot take over while the owner lives.
  const liveOwnerStaleMtimeLock = path.join(temp, 'live-owner-stale-mtime.lock');
  const liveOwnerRelease = await acquireCrossProcessTicketLock(liveOwnerStaleMtimeLock, {
    timeoutMs: 30_000,
    staleMs: 24 * 60 * 60_000,
    heartbeatMs: 30_000,
    pollMs: 50,
  });
  try {
    const ownerEnqueued = await waitFor(async () => (
      await fs.readdir(`${liveOwnerStaleMtimeLock}.tickets`).catch(() => [])
    ).filter(name => name.endsWith('.json')).length >= 1);
    check('live lock owner has a ticket on disk', ownerEnqueued, true);
    const ownerTicketName = (await fs.readdir(`${liveOwnerStaleMtimeLock}.tickets`))
      .filter(name => name.endsWith('.json'))[0];
    const ownerTicket = path.join(`${liveOwnerStaleMtimeLock}.tickets`, ownerTicketName);
    const forcedPast = new Date(Date.now() - 10 * 60_000);
    await fs.utimes(ownerTicket, forcedPast, forcedPast);
    const stolen = await new Promise((resolve, reject) => {
      acquireCrossProcessTicketLock(liveOwnerStaleMtimeLock, {
        timeoutMs: 1_200,
        staleMs: 50,
        heartbeatMs: 25,
        pollMs: 25,
        timeoutCode: 'LIVE_OWNER_STALE_MTIME_PRESERVED',
      }).then(async release => {
        try { await release(); } finally { resolve(true); }
      }, error => resolve(error?.code === 'LIVE_OWNER_STALE_MTIME_PRESERVED' ? false : error));
    });
    check('stale-mtime recurring live owner is never stolen by a competing acquirer', stolen, false);
    check('live owner ticket survives the stale-mtime competitor attempt',
      Boolean(await fs.lstat(ownerTicket).catch(() => null)), true);
  } finally {
    await liveOwnerRelease();
  }
  let reacquiredAfterRelease = false;
  const afterRelease = await acquireCrossProcessTicketLock(liveOwnerStaleMtimeLock, {
    timeoutMs: 5_000,
    staleMs: 60_000,
  });
  await afterRelease();
  reacquiredAfterRelease = true;
  check('lock is acquirable again after the live owner releases', reacquiredAfterRelease, true);

 // The standalone bootstrap and updater must serialize the same mutable
  // release tree. Hold the updater ticket, start recovery, and prove recovery
  // queues without touching the corrupted root until the live owner releases.
  await writeCurrent(current);
  await corruptReleaseFileWithoutChangingSize(damagedReleasePath);
  const lockedRecoveryStaging = path.join(installRoot, 'versions', `.${release.manifest.version}.live-lock.tmp`);
  await copyBundleFilesTo(lockedRecoveryStaging);
  const liveUpdaterLock = await acquireCrossProcessTicketLock(updateLockFile, {
    timeoutMs: 5_000,
    staleMs: 30_000,
    heartbeatMs: 1_000,
    pollMs: 20,
  });
  let lockedBootstrapPending;
  try {
    lockedBootstrapPending = runBootstrap({args: ['version']});
    const bootstrapQueued = await waitFor(async () => (
      await fs.readdir(`${updateLockFile}.tickets`).catch(() => [])
    ).filter(name => name.endsWith('.json')).length >= 2);
    check('bootstrap recovery waits behind live updater lock', bootstrapQueued, true);
    check('queued bootstrap leaves corrupted root untouched',
      (await fs.readFile(installedReleaseFile(damagedReleasePath))).equals(await expectedBundleBytes(damagedReleasePath)), false);
    check('queued bootstrap leaves verified staging in place', Boolean(await fs.lstat(lockedRecoveryStaging).catch(() => null)), true);
  } finally {
    await liveUpdaterLock();
  }
  const lockedBootstrap = await lockedBootstrapPending;
  const lockedBootstrapOut = parseBootstrapJson(lockedBootstrap, 'live-lock bootstrap recovery');
  check('bootstrap recovery resumes after updater lock release', lockedBootstrapOut.version, release.manifest.version);
  check('serialized bootstrap restores exact bundle bytes',
    (await fs.readFile(installedReleaseFile(damagedReleasePath))).equals(await expectedBundleBytes(damagedReleasePath)), true);

  await writeCurrent(current);
  await corruptReleaseFileWithoutChangingSize(damagedReleasePath);
  const k1 = await runCrashKill({faultPoints: {'before-version-swap': true, exitCode: 91}, currentVersion: release.manifest.version});
  check('kill fires at before-version-swap', k1.code, 91);
  check('before-swap kill leaves verified staging', (await versionsDirEntries()).filter(name => name.endsWith('.tmp')).length, 1);
  check('before-swap kill leaves corrupted root in place', await installedVersionRootExists(), true);
  const k1Repeat = await runCrashKill({faultPoints: {'before-version-swap': true, exitCode: 91}, currentVersion: release.manifest.version});
  check('second consecutive kill also fires before-version-swap', k1Repeat.code, 91);
  check('second attempt preserves prior verified staging until its own staging is verified',
    (await versionsDirEntries()).filter(name => name.endsWith('.tmp')).length, 2);
  check('second consecutive kill still leaves corrupted root in place', await installedVersionRootExists(), true);
  const k1Boot = await runBootstrap({args: ['version']});
  const k1Out = parseBootstrapJson(k1Boot, 'before-swap bootstrap recovery');
  check('bootstrap recovers from before-swap kill', k1Boot.code === 0 && k1Out.version === release.manifest.version, true);
  check('before-swap recovery restores exact bundle bytes', (await fs.readFile(installedReleaseFile(damagedReleasePath))).equals(await expectedBundleBytes(damagedReleasePath)), true);
  check('before-swap recovery promotes one staging and GCs the other verified recovery copy',
    (await versionsDirEntries()).filter(name => name.endsWith('.tmp')).length, 0);

  await writeCurrent(current);
  await corruptReleaseFileWithoutChangingSize(damagedReleasePath);
  const k2 = await runCrashKill({faultPoints: {'after-version-swap-away': true, exitCode: 91}, currentVersion: release.manifest.version});
  check('kill fires at after-version-swap-away', k2.code, 91);
  const k2Entries = await versionsDirEntries();
  check('swap-away kill leaves backup and staging', k2Entries.filter(name => name.endsWith('.tmp')).length === 1 && k2Entries.filter(name => name.endsWith('.bak')).length === 1, true);
  check('swap-away kill leaves version root absent', await installedVersionRootExists(), false);
  const k2Boot = await runBootstrap({args: ['version']});
  const k2Out = parseBootstrapJson(k2Boot, 'swap-away bootstrap recovery');
  check('bootstrap recovers from swap-away kill (original crash window)', k2Boot.code === 0 && k2Out.version === release.manifest.version, true);
  check('swap-away recovery restores exact bundle bytes', (await fs.readFile(installedReleaseFile(damagedReleasePath))).equals(await expectedBundleBytes(damagedReleasePath)), true);
  check('swap-away recovery removes staging dot dir', (await versionsDirEntries()).filter(name => name.endsWith('.tmp')).length, 0);

  await writeCurrent(current);
  await corruptReleaseFileWithoutChangingSize(damagedReleasePath);
  const k3 = await runCrashKill({faultPoints: {'after-version-swap-in': true, exitCode: 91}, currentVersion: release.manifest.version});
  check('kill fires at after-version-swap-in', k3.code, 91);
  const k3Boot = await runBootstrap({args: ['version']});
  const k3Out = parseBootstrapJson(k3Boot, 'swap-in bootstrap recovery');
  check('bootstrap launches repaired root after swap-in kill', k3Boot.code === 0 && k3Out.version === release.manifest.version, true);
  check('swap-in kill leaves one backup for later GC', (await versionsDirEntries()).filter(name => name.endsWith('.bak')).length, 1);

  const upgradeRoot = path.join(temp, 'upgrade-cli');
  const upgradeCodex = path.join(temp, 'upgrade-codex');
  const oldUpgradeEntrypoint = path.join(upgradeRoot, 'versions', oldVersion, 'scripts', 'bi_ops_cli.mjs');
  await fs.mkdir(path.dirname(oldUpgradeEntrypoint), {recursive: true});
  await fs.writeFile(oldUpgradeEntrypoint, 'console.log("old")\n', 'utf8');
  await fs.writeFile(path.join(upgradeRoot, 'current.json'), `${JSON.stringify({version: oldVersion, entrypoint: oldUpgradeEntrypoint})}\n`, 'utf8');
  const k4 = await runCrashKill({faultPoints: {'before-pointer-write': true, exitCode: 91}, currentVersion: oldVersion, root: upgradeRoot, codexHome: upgradeCodex});
  check('kill fires at before-pointer-write during upgrade', k4.code, 91);
  check('upgrade kill keeps the old pointer', JSON.parse(await fs.readFile(path.join(upgradeRoot, 'current.json'), 'utf8')).version, oldVersion);
  check('upgrade kill publishes the new version root', Boolean(await fs.lstat(path.join(upgradeRoot, 'versions', release.manifest.version)).catch(() => null)), true);
  const k4Boot = await runBootstrap({root: upgradeRoot, args: []});
  check('bootstrap keeps launching the old bootable version', k4Boot.stdout.trim(), 'old');
  const k4Complete = await checkAndInstallPartnerCliUpdate({
    baseUrl: `http://127.0.0.1:${port}`,
    cookie: 'bi_session=test',
    currentVersion: oldVersion,
    installRoot: upgradeRoot,
    codexHome: upgradeCodex,
    force: true,
  });
  check('upgrade completes after before-pointer-write kill', k4Complete.updated, true);
  const k4Final = await runBootstrap({root: upgradeRoot, args: ['version']});
  check('upgrade completes to the new version', JSON.parse(k4Final.stdout).version, release.manifest.version);

  await writeCurrent(current);
  await corruptReleaseFileWithoutChangingSize(damagedReleasePath);
  const k5 = await runCrashKill({faultPoints: {'pointer-write-before-rename': true, exitCode: 91}, currentVersion: release.manifest.version});
  check('kill fires at pointer-write-before-rename', k5.code, 91);
  check('pointer-write kill leaves previous pointer intact', JSON.parse(await fs.readFile(path.join(installRoot, 'current.json'), 'utf8')).version, release.manifest.version);
  const k5Boot = await runBootstrap({args: ['version']});
  const k5Out = JSON.parse(k5Boot.stdout);
  check('bootstrap launches repaired root after pointer-write kill', k5Boot.code === 0 && k5Out.version === release.manifest.version, true);
  check('pointer-write kill run GCs stale intermediate dirs', (await versionsDirEntries()).filter(name => name.startsWith('.')).length, 0);

  // A persistent Windows MoveFileEx-style error must fail with the prior
  // pointer still present. The updater and bootstrap may retry a same-path
  // atomic replacement, but must never move current.json to a .bak first.
  const atomicPointerRoot = path.join(temp, 'atomic-pointer-cli');
  const atomicPointerCodex = path.join(temp, 'atomic-pointer-codex');
  await createLegacyStableInstall({
    root: atomicPointerRoot,
    targetCodexHome: atomicPointerCodex,
    output: 'old-atomic-pointer',
  });
  const atomicPointerFile = path.join(atomicPointerRoot, 'current.json');
  const atomicPointerBefore = await fs.readFile(atomicPointerFile);
  const atomicPointerFailure = await runCrashKill({
    faultPoints: {'pointer-write-atomic-replace-error': {code: 'EPERM'}},
    currentVersion: oldVersion,
    root: atomicPointerRoot,
    codexHome: atomicPointerCodex,
  });
  check('persistent pointer atomic-replace error fails the updater', atomicPointerFailure.code !== 0, true);
  check('persistent pointer atomic-replace error leaves prior pointer byte-exact',
    (await fs.readFile(atomicPointerFile)).equals(atomicPointerBefore), true);
  check('persistent pointer atomic-replace error leaves no moved-away pointer backup',
    (await fs.readdir(atomicPointerRoot)).some(name => name.startsWith('current.json.') && name.endsWith('.bak')), false);
  const atomicPointerOldBoot = await runBootstrap({root: atomicPointerRoot, args: []});
  check('prior pointer remains bootable after persistent atomic-replace error',
    atomicPointerOldBoot.code === 0 && atomicPointerOldBoot.stdout.trim() === 'old-atomic-pointer', true);
  const atomicPointerRecovery = await runCrashKill({
    faultPoints: {},
    currentVersion: oldVersion,
    root: atomicPointerRoot,
    codexHome: atomicPointerCodex,
  });
  check('next updater completes after persistent pointer atomic-replace error', atomicPointerRecovery.code, 0);
  const atomicPointerNewBoot = await runBootstrap({root: atomicPointerRoot, args: ['version']});
  check('recovered pointer launches the new verified release',
    atomicPointerNewBoot.code === 0 && JSON.parse(atomicPointerNewBoot.stdout).version === release.manifest.version, true);

  await writeCurrent(current);
  await fs.rm(path.join(installRoot, 'current.json'), {force: true});
  const k6Boot = await runBootstrap({args: ['version']});
  const k6Out = JSON.parse(k6Boot.stdout);
  check('bootstrap recovers from missing pointer via marker anchor', k6Boot.code === 0 && k6Out.version === release.manifest.version, true);
  const restoredPointer = JSON.parse(await fs.readFile(path.join(installRoot, 'current.json'), 'utf8'));
  check('missing-pointer recovery restores pointer version', restoredPointer.version, release.manifest.version);
  check('missing-pointer recovery restores pointer hash', restoredPointer.bundleSha256, release.manifest.bundleSha256);
  check('missing-pointer recovery restores entrypoint', restoredPointer.entrypoint, current.entrypoint);

  await writeCurrent(current);
  const pointerBytesBefore = await fs.readFile(path.join(installRoot, 'current.json'));
  await corruptReleaseFileWithoutChangingSize(damagedReleasePath);
  const k7Boot = await runBootstrap({args: ['version']});
  check('offline bootstrap fails closed on corrupted same version', k7Boot.code !== 0, true);
  check('fail-closed bootstrap executes nothing', k7Boot.stdout, '');
  check('fail-closed bootstrap explains recovery', k7Boot.stderr, text => text.includes('无法启动') && text.includes('重新运行'));
  check('fail-closed bootstrap leaves pointer untouched', (await fs.readFile(path.join(installRoot, 'current.json'))).equals(pointerBytesBefore), true);
  const k7Repair = await checkAndInstallPartnerCliUpdate({
    baseUrl: `http://127.0.0.1:${port}`,
    cookie: 'bi_session=test',
    currentVersion: release.manifest.version,
    installRoot,
    codexHome,
    force: true,
  });
  check('corrupted same version is repaired online', k7Repair.updated, true);
  const k7Boot2 = await runBootstrap({args: ['version']});
  check('bootstrap launches after online repair', JSON.parse(k7Boot2.stdout).version, release.manifest.version);

  await writeCurrent(current);
  await fs.rm(path.join(installRoot, 'versions', release.manifest.version), {recursive: true, force: true});
  await fs.rm(path.join(installRoot, 'update-state.json'), {force: true});
  await writeCurrent({...current, bundleSha256: '0'.repeat(64)});
  const stagingA = path.join(installRoot, 'versions', `.${release.manifest.version}.fake.1.tmp`);
  const stagingB = path.join(installRoot, 'versions', `.${release.manifest.version}.fake.2.tmp`);
  await copyBundleFilesTo(stagingA);
  await flipByteInFile(path.join(stagingA, damagedReleasePath));
  await copyBundleFilesTo(stagingB);
  const k8Boot = await runBootstrap({args: ['version']});
  check('bootstrap fails closed with only unverified staging', k8Boot.code !== 0, true);
  check('unverified staging is never executed', k8Boot.stdout, '');
  const k8Entries = await versionsDirEntries();
  check('corrupted staging is not promoted', k8Entries.includes(`.${release.manifest.version}.fake.1.tmp`), true);
  check('unanchored valid staging is not promoted', k8Entries.includes(`.${release.manifest.version}.fake.2.tmp`), true);
  check('unverified staging does not recreate the version root', await installedVersionRootExists(), false);
  check('unverified staging does not rewrite the pointer', JSON.parse(await fs.readFile(path.join(installRoot, 'current.json'), 'utf8')).bundleSha256, '0'.repeat(64));
  await fs.rm(stagingA, {recursive: true, force: true});
  await fs.rm(stagingB, {recursive: true, force: true});
  await writeCurrent(current);
  const k8Restore = await checkAndInstallPartnerCliUpdate({
    baseUrl: `http://127.0.0.1:${port}`,
    cookie: 'bi_session=test',
    currentVersion: release.manifest.version,
    installRoot,
    codexHome,
    force: true,
  });
  check('state restored after unverified-staging test', k8Restore.updated, true);

  const junctionRoot = path.join(temp, 'junction-cli');
  const junctionVersions = path.join(junctionRoot, 'versions');
  await fs.mkdir(junctionVersions, {recursive: true});
  const outsideDir = path.join(temp, 'outside-target');
  await fs.mkdir(path.join(outsideDir, 'scripts'), {recursive: true});
  await fs.writeFile(path.join(outsideDir, 'scripts', 'bi_ops_cli.mjs'), 'console.log("outside")\n', 'utf8');
  const junctionLink = path.join(junctionVersions, release.manifest.version);
  let junctionCreated = false;
  try {
    await fs.symlink(outsideDir, junctionLink, 'junction');
    junctionCreated = true;
  } catch (error) {
    process.stderr.write(`junction creation unsupported (` + error.code + `), skipping junction test\n`);
  }
  if (junctionCreated) {
    await fs.copyFile(path.join(ROOT, 'scripts', 'partner_cli_bootstrap.mjs'), path.join(junctionRoot, 'bootstrap.mjs'));
    await fs.writeFile(path.join(junctionRoot, 'current.json'), `${JSON.stringify({version: release.manifest.version, entrypoint: path.join(junctionLink, 'scripts', 'bi_ops_cli.mjs')})}\n`, 'utf8');
    const junctionBoot = await runBootstrap({root: junctionRoot, args: []});
    check('junction version root is rejected by bootstrap', junctionBoot.code !== 0, true);
    check('junction escape does not execute outside code', junctionBoot.stdout, '');
    check('junction rejection is explained', junctionBoot.stderr, text => text.includes('无法启动'));
  }

  const legacyRoot = path.join(temp, 'legacy-cli');
  const legacyVersionRoot = path.join(legacyRoot, 'versions', release.manifest.version);
  await copyBundleFilesTo(legacyVersionRoot);
  await fs.copyFile(path.join(ROOT, 'scripts', 'partner_cli_bootstrap.mjs'), path.join(legacyRoot, 'bootstrap.mjs'));
  await fs.writeFile(path.join(legacyRoot, 'current.json'), `${JSON.stringify({version: release.manifest.version, entrypoint: path.join(legacyVersionRoot, release.manifest.entrypoint)})}\n`, 'utf8');
  const legacyBoot = await runBootstrap({root: legacyRoot, args: ['version']});
  check('legacy pointer without hash launches', legacyBoot.code === 0 && JSON.parse(legacyBoot.stdout).version === release.manifest.version, true);
  await fs.rm(path.join(legacyVersionRoot, release.manifest.entrypoint), {force: true});
 const legacyBroken = await runBootstrap({root: legacyRoot, args: ['version']});
 check('legacy pointer with missing entrypoint fails closed', legacyBroken.code !== 0 && legacyBroken.stdout === '', true);
  // Stable bootstrap/skill publication must self-heal a "moved away then
  // crashed" residue. If an older Windows-style fallback had renamed the
  // canonical launcher to a .bak sibling and the process died between the two
  // renames, the canonical file is absent. The next updater run must restore
  // it byte-exact from the verified tree and clean the stale .bak/.tmp
  // siblings, and the next bootstrap must start and recover. A divergence
  // after publish must fail the update BEFORE the pointer moves.
  const stableResidueRoot = path.join(temp, 'stable-residue-cli');
  const stableResidueCodex = path.join(temp, 'stable-residue-codex');
  const stableResidueFixture = await createLegacyStableInstall({
    root: stableResidueRoot,
    targetCodexHome: stableResidueCodex,
    output: 'old-stable-residue',
  });
  const residueBootstrap = stableResidueFixture.bootstrap;
  const residueBootstrapBackup = `${residueBootstrap}.${process.pid}.${Date.now()}.deadbeef.bak`;
  const residueSkill = stableResidueFixture.skill;
  const residueSkillBackup = `${residueSkill}.${process.pid}.${Date.now()}.deadbeef.bak`;
  await fs.rename(residueBootstrap, residueBootstrapBackup);
  await fs.rename(residueSkill, residueSkillBackup);
  check('moved-away residue leaves the canonical bootstrap absent', !(await fs.access(residueBootstrap).then(() => true).catch(() => false)), true);
  check('moved-away residue leaves the canonical skill absent', !(await fs.access(residueSkill).then(() => true).catch(() => false)), true);
  const residueEntryBoot = await runBootstrap({root: stableResidueRoot, args: []}).catch(() => null);
  check('launcher cannot start while the canonical bootstrap is absent',
    residueEntryBoot === null || residueEntryBoot.code !== 0, true);
  const residueRecover = await runCrashKill({
    faultPoints: {},
    currentVersion: oldVersion,
    root: stableResidueRoot,
    codexHome: stableResidueCodex,
  });
  check('next updater run restores the canonical launcher', residueRecover.code === 0, true);
  check('canonical bootstrap restored byte-exact',
    (await fs.readFile(residueBootstrap)).equals(await expectedBundleBytes(release.manifest.bootstrap)), true);
  check('canonical skill restored byte-exact',
    (await fs.readFile(residueSkill)).equals(await expectedBundleBytes(release.manifest.codexSkill)), true);
  check('stale bootstrap .bak/.tmp siblings are cleaned after recovery',
    (await fs.readdir(stableResidueRoot)).filter(name => name.startsWith('bootstrap.mjs.') && (name.endsWith('.bak') || name.endsWith('.tmp'))).length, 0);
  check('stale skill .bak/.tmp siblings are cleaned after recovery',
    (await fs.readdir(path.dirname(residueSkill))).filter(name => name.startsWith('SKILL.md.') && (name.endsWith('.bak') || name.endsWith('.tmp'))).length, 0);
  const residueBoot = await runBootstrap({root: stableResidueRoot, args: ['version']});
  check('next bootstrap run starts the recovered CLI',
    residueBoot.code === 0 && JSON.parse(residueBoot.stdout).version === release.manifest.version, true);

  const stableVerifyRoot = path.join(temp, 'stable-verify-cli');
  const stableVerifyCodex = path.join(temp, 'stable-verify-codex');
  await createLegacyStableInstall({
    root: stableVerifyRoot,
    targetCodexHome: stableVerifyCodex,
    output: 'old-stable-verify',
  });
  const stableVerify = await runCrashKill({
    faultPoints: {'bootstrap-stable-file-divergence': true},
    currentVersion: oldVersion,
    root: stableVerifyRoot,
    codexHome: stableVerifyCodex,
  });
  check('divergence after publish fails the update', stableVerify.code !== 0, true);
  check('divergence failure keeps the old pointer',
    JSON.parse(await fs.readFile(path.join(stableVerifyRoot, 'current.json'), 'utf8')).version, oldVersion);
  const stableVerifyRecover = await runCrashKill({
    faultPoints: {},
    currentVersion: oldVersion,
    root: stableVerifyRoot,
    codexHome: stableVerifyCodex,
  });
  check('next updater run after divergence failure recovers the canonical bootstrap', stableVerifyRecover.code === 0, true);
  check('recovered canonical bootstrap is byte-exact',
    (await fs.readFile(path.join(stableVerifyRoot, 'bootstrap.mjs'))).equals(await expectedBundleBytes(release.manifest.bootstrap)), true);
  const stableVerifyBoot = await runBootstrap({root: stableVerifyRoot, args: ['version']});
  check('bootstrap launches the recovered CLI after divergence failure',
    stableVerifyBoot.code === 0 && JSON.parse(stableVerifyBoot.stdout).version === release.manifest.version, true);
} finally {
  await new Promise(resolve => server.close(resolve));
  const ok = checks.every(row => row.pass);
  console.log(JSON.stringify({ok, checks}, null, 2));
  await fs.rm(temp, {recursive: true, force: true});
  if (!ok) process.exitCode = 1;
}
