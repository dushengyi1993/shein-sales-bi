#!/usr/bin/env node
// Stable SHEIN BI Ops CLI bootstrap. Standalone by design: it is copied
// verbatim next to current.json at install time and must not import any
// project module (the packaged bootstrap is a single file).
//
// Crash-consistency contract:
// - The normal path starts only from a fully verified local release
//   (rebuild of the manifest bundle hash + per-file SHA256, anchored by
//   current.json/update-state.json, plus realpath containment checks).
// - If the current pointer is missing, dangling, or fails verification, the
//   bootstrap scans versions/ for a verified candidate: the pointer-version
//   root, staging/backup directories left by a crashed swap (anchored by
//   current.json or update-state.json), or older published versions carrying
//   a .verified.json marker. The best candidate is promoted and the pointer
//   is atomically rewritten before launch.
// - Unverified staging is never executed and never promoted; without a
//   trusted candidate the bootstrap fails closed with an actionable error.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const POINTER_SCHEMA_VERSION = 2;
const VERIFIED_MARKER = '.verified.json';
const STAGING_SUFFIX = '.tmp';
const BACKUP_SUFFIX = '.bak';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ANCHOR_POINTER = 1;
const ANCHOR_UPDATE = 2;
const ANCHOR_MARKER = 4;
const UPDATE_LOCK_TIMEOUT_MS = 120_000;
const UPDATE_LOCK_STALE_MS = 10 * 60_000;
const ATOMIC_REPLACE_RETRY_CODES = new Set(['EACCES', 'EBUSY', 'EEXIST', 'EPERM']);
const ATOMIC_REPLACE_RETRY_DELAYS_MS = [10, 25, 50, 100, 250, 500, 1_000];

function versionParts(value) {
  return String(value || '').split(/[^0-9]+/).filter(Boolean).map(Number);
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const av = a[index] || 0;
    const bv = b[index] || 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

function normalizedBundleSha256(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return SHA256_PATTERN.test(normalized) ? normalized : '';
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
}

async function readJson(file) {
  try { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); } catch { return null; }
}

function processAppearsAlive(pid) {
  const value = Number(pid || 0);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function processStartIdentity(pid) {
  if (process.platform !== 'linux') return '';
  try {
    const raw = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    const close = raw.lastIndexOf(')');
    if (close < 0) return '';
    const fields = raw.slice(close + 1).trim().split(/\s+/u);
    const startTicks = fields[19] || '';
    return /^\d+$/.test(startTicks) ? startTicks : '';
  } catch {
    return '';
  }
}

async function ticketOwnerAppearsAlive(holder) {
  const pid = Number(holder?.pid || 0);
  if (!processAppearsAlive(pid)) return false;
  const expectedStart = String(holder?.processStart || '');
  if (!expectedStart) return true;
  const observedStart = await processStartIdentity(pid);
  return !observedStart || observedStart === expectedStart;
}

function sameFileIdentity(left, right) {
  if (!left || !right) return false;
  if (Number(left.ino || 0) > 0 || Number(right.ino || 0) > 0) {
    return Number(left.dev || 0) === Number(right.dev || 0) && Number(left.ino || 0) === Number(right.ino || 0);
  }
  return Number(left.birthtimeMs || 0) === Number(right.birthtimeMs || 0)
    && Number(left.size || 0) === Number(right.size || 0);
}

async function removeDeadBootstrapTicket(ticketFile, staleMs) {
  const firstStat = await fs.stat(ticketFile).catch(() => null);
  if (!firstStat) return false;
  const firstHolder = await readJson(ticketFile);
  const firstPid = Number(firstHolder?.pid || 0);
  const hasTrustedOwner = Number.isInteger(firstPid) && firstPid > 0 && Boolean(firstHolder?.nonce);
  const firstIsStale = Date.now() - firstStat.mtimeMs > staleMs;
  // A ticket held by a trusted owner whose process is still alive must never
  // be reclaimed merely because its mtime looks stale (parity with
  // lib/cross_process_ticket_lock.mjs). A stalled heartbeat, clock skew, or
  // coarse filesystem timestamps must not fracture the mutual exclusion that
  // the ticket queue provides.
  const trustedOwnerIsAlive = hasTrustedOwner && await ticketOwnerAppearsAlive(firstHolder);
  if (trustedOwnerIsAlive) return false;
  // Stale age may only reclaim tickets without a trusted live owner: legacy
  // or malformed tickets (no trusted holder) require a stale mtime, while a
  // trusted owner that is verifiably dead (or whose PID was recycled) is
  // reclaimed regardless of age.
  if (!hasTrustedOwner && !firstIsStale) return false;

  const [currentStat, currentHolder] = await Promise.all([
    fs.stat(ticketFile).catch(() => null),
    readJson(ticketFile),
  ]);
  if (!currentStat || !sameFileIdentity(firstStat, currentStat)) return false;
  const currentPid = Number(currentHolder?.pid || 0);
  const currentHasTrustedOwner = Number.isInteger(currentPid) && currentPid > 0 && Boolean(currentHolder?.nonce);
  if (currentHasTrustedOwner !== hasTrustedOwner
    || currentHolder?.nonce !== firstHolder?.nonce
    || currentPid !== firstPid
    || String(currentHolder?.processStart || '') !== String(firstHolder?.processStart || '')) return false;
  const currentIsStale = Date.now() - currentStat.mtimeMs > staleMs;
  const currentTrustedOwnerIsAlive = currentHasTrustedOwner && await ticketOwnerAppearsAlive(currentHolder);
  if (currentTrustedOwnerIsAlive) return false;
  if (!currentHasTrustedOwner && !currentIsStale) return false;
  await fs.rm(ticketFile, {force: true});
  return true;
}

function ticketOrder(holder) {
  const value = String(holder?.orderNs || '');
  return /^\d+$/.test(value) ? BigInt(value) : null;
}

function compareTickets(left, right) {
  if (left.order === null && right.order !== null) return -1;
  if (left.order !== null && right.order === null) return 1;
  if (left.order !== null && right.order !== null && left.order !== right.order) return left.order < right.order ? -1 : 1;
  return left.name.localeCompare(right.name);
}

// This standalone copy intentionally speaks the same on-disk ticket protocol
// as lib/cross_process_ticket_lock.mjs. Recovery and installation therefore
// cannot rename the same release tree concurrently, even when the updater was
// killed and left its ticket behind.
async function acquireBootstrapUpdateLock(lockPath, {
  timeoutMs = UPDATE_LOCK_TIMEOUT_MS,
  staleMs = UPDATE_LOCK_STALE_MS,
  pollMs = 100,
} = {}) {
  const queueDir = path.resolve(lockPath) + '.tickets';
  await fs.mkdir(queueDir, {recursive: true});
  const nonce = crypto.randomBytes(16).toString('hex');
  const ticketName = nonce + '.json';
  const ticketFile = path.join(queueDir, ticketName);
  let handle;
  let heartbeat;
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    if (heartbeat) clearInterval(heartbeat);
    try { await handle?.close(); } catch {}
    const current = await readJson(ticketFile);
    if (current?.nonce === nonce) await fs.rm(ticketFile, {force: true}).catch(() => {});
  };
  try {
    handle = await fs.open(ticketFile, 'wx', 0o600);
    const processStart = await processStartIdentity(process.pid);
    await handle.writeFile(JSON.stringify({
      pid: process.pid,
      nonce,
      processStart,
      orderNs: process.hrtime.bigint().toString(),
      at: new Date().toISOString(),
    }));
    await handle.sync();
    heartbeat = setInterval(() => {
      const now = new Date();
      handle.utimes(now, now).catch(() => {});
    }, 30_000);
    heartbeat.unref?.();
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const active = [];
      for (const name of (await fs.readdir(queueDir).catch(() => [])).filter(value => value.endsWith('.json')).sort()) {
        const file = path.join(queueDir, name);
        if (await removeDeadBootstrapTicket(file, staleMs)) continue;
        if (await fs.stat(file).catch(() => null)) active.push({name, order: ticketOrder(await readJson(file))});
      }
      active.sort(compareTickets);
      if (!active.some(ticket => ticket.name === ticketName)) throw new Error('CLI update lock ticket disappeared');
      if (active[0]?.name === ticketName) return release;
      if (Date.now() >= deadline) throw new Error('CLI update/recovery lock timed out');
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
  } catch (error) {
    await release();
    throw error;
  }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const temp = file + '.' + process.pid + '.' + Date.now() + '.' + Math.random().toString(16).slice(2) + '.tmp';
  let handle = null;
  try {
    handle = await fs.open(temp, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n', {encoding: 'utf8'});
    await handle.sync();
    await handle.close();
    handle = null;
    for (let attempt = 0; ; attempt += 1) {
      try {
        // Keep the old target at its canonical path until one same-directory
        // replacement succeeds. Never use a move-away .bak fallback: a second
        // crash in that gap could remove the only remaining trust anchor.
        await fs.rename(temp, file);
        break;
      } catch (error) {
        const delayMs = ATOMIC_REPLACE_RETRY_DELAYS_MS[attempt];
        if (!ATOMIC_REPLACE_RETRY_CODES.has(error?.code) || delayMs === undefined) {
          throw new Error(`Atomic Partner CLI JSON replacement failed; previous target was left in place: ${file}: ${error?.message || error}`, {cause: error});
        }
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    try { await fs.chmod(file, 0o600); } catch {}
    if (process.platform !== 'win32') {
      const directory = await fs.open(path.dirname(file), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temp, {force: true}).catch(() => {});
  }
}

function normalizeReleasePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error('Unsafe partner CLI release path: ' + value);
  }
  const segments = normalized.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error('Unsafe partner CLI release path: ' + value);
  }
  return normalized;
}

function inside(root, relativePath) {
  const target = path.resolve(root, normalizeReleasePath(relativePath));
  const rel = path.relative(path.resolve(root), target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Partner CLI path escapes release root: ' + relativePath);
  return target;
}

function pathIsStrictlyInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return Boolean(relative)
    && relative !== '..'
    && !relative.startsWith('..' + path.sep)
    && !path.isAbsolute(relative);
}

async function inspectRegularFileInside(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!pathIsStrictlyInside(resolvedRoot, resolvedTarget)) return null;
  const [rootStat, fileStat] = await Promise.all([
    fs.lstat(resolvedRoot).catch(() => null),
    fs.lstat(resolvedTarget).catch(() => null),
  ]);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink() || !fileStat?.isFile() || fileStat.isSymbolicLink()) return null;
  const [realRoot, realTarget] = await Promise.all([
    fs.realpath(resolvedRoot).catch(() => ''),
    fs.realpath(resolvedTarget).catch(() => ''),
  ]);
  if (!realRoot || !realTarget || !pathIsStrictlyInside(realRoot, realTarget)) return null;
  return {path: resolvedTarget, realPath: realTarget};
}

async function inspectRealDirectoryInside(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!pathIsStrictlyInside(resolvedRoot, resolvedTarget)) return null;
  const [rootStat, dirStat] = await Promise.all([
    fs.lstat(resolvedRoot).catch(() => null),
    fs.lstat(resolvedTarget).catch(() => null),
  ]);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink() || !dirStat?.isDirectory() || dirStat.isSymbolicLink()) return null;
  const [realRoot, realTarget] = await Promise.all([
    fs.realpath(resolvedRoot).catch(() => ''),
    fs.realpath(resolvedTarget).catch(() => ''),
  ]);
  if (!realRoot || !realTarget || !pathIsStrictlyInside(realRoot, realTarget)) return null;
  return {path: resolvedTarget, realPath: realTarget};
}

function releaseDescriptor(value) {
  return {
    schemaVersion: 1,
    version: String(value.version || '').trim(),
    entrypoint: normalizeReleasePath(value.entrypoint),
    bootstrap: normalizeReleasePath(value.bootstrap),
    codexSkill: normalizeReleasePath(value.codexSkill),
  };
}

// Rebuild the deterministic release bundle hash from the installed files
// (mirrors buildPartnerCliRelease in lib/partner_cli_release.mjs). The hash
// input covers the descriptor and every file's bytes, so bundle-hash
// equality with a trusted anchor pins the full release content.
async function rebuildCandidateRelease(versionRoot) {
  const configFile = path.join(versionRoot, 'config', 'partner_cli_package.json');
  if (!(await inspectRegularFileInside(versionRoot, configFile))) return null;
  const packageManifest = await readJson(configFile);
  if (!packageManifest || typeof packageManifest !== 'object') return null;
  let descriptor;
  try {
    descriptor = releaseDescriptor({...packageManifest, schemaVersion: 1});
  } catch {
    return null;
  }
  if (!descriptor.version) return null;
  let relativeFiles;
  try {
    relativeFiles = [
      ...(Array.isArray(packageManifest.files) ? packageManifest.files : []),
      normalizeReleasePath(path.relative(versionRoot, configFile)),
    ].map(normalizeReleasePath);
  } catch {
    return null;
  }
  const uniqueFiles = [...new Set(relativeFiles)];
  for (const required of [descriptor.entrypoint, descriptor.bootstrap, descriptor.codexSkill]) {
    if (!uniqueFiles.includes(required)) return null;
  }
  const files = [];
  for (const relativePath of uniqueFiles) {
    const absolute = inside(versionRoot, relativePath);
    if (!(await inspectRegularFileInside(versionRoot, absolute))) return null;
    const bytes = await fs.readFile(absolute).catch(() => null);
    if (!bytes) return null;
    files.push({
      path: relativePath,
      size: bytes.length,
      sha256: sha256Hex(bytes),
      dataBase64: bytes.toString('base64'),
    });
  }
  const bundleBody = {...descriptor, files};
  const bundleSha256 = sha256Hex(Buffer.from(stableJson(bundleBody), 'utf8'));
  return {descriptor, files, bundleSha256};
}

// Full manifest+SHA256 verification of one candidate plus trusted-anchor
// matching. Returns null unless the candidate is complete, its entrypoint
// is a regular file inside the directory, and its rebuilt bundle hash
// matches at least one anchor (current pointer, update-state, or an
// in-directory .verified.json marker for published non-dot directories).
async function verifyCandidateRelease({versionRoot, pointer, updateState, allowDotDir}) {
  const rebuilt = await rebuildCandidateRelease(versionRoot);
  if (!rebuilt) return null;
  const bundleSha256 = rebuilt.bundleSha256;
  const candidateVersion = rebuilt.descriptor.version;
  let entrypointPath;
  try {
    entrypointPath = inside(versionRoot, rebuilt.descriptor.entrypoint);
  } catch {
    return null;
  }
  if (!(await inspectRegularFileInside(versionRoot, entrypointPath))) return null;
  let anchors = 0;
  const pointerVersion = String(pointer?.version || '').trim();
  const pointerHash = normalizedBundleSha256(pointer?.bundleSha256);
  if (pointerHash && compareVersions(pointerVersion, candidateVersion) === 0 && pointerHash === bundleSha256) anchors |= ANCHOR_POINTER;
  const updateVersion = String(updateState?.latestVersion || '').trim();
  const updateHash = normalizedBundleSha256(updateState?.bundleSha256);
  if (updateHash && compareVersions(updateVersion, candidateVersion) === 0 && updateHash === bundleSha256) anchors |= ANCHOR_UPDATE;
  if (!allowDotDir) {
    const markerPath = path.join(versionRoot, VERIFIED_MARKER);
    if (await inspectRegularFileInside(versionRoot, markerPath)) {
      const marker = await readJson(markerPath);
      if (marker
        && String(marker.version || '') === candidateVersion
        && normalizedBundleSha256(marker.bundleSha256) === bundleSha256) {
        anchors |= ANCHOR_MARKER;
      }
    }
  }
  if (!anchors) return null;
  return {version: candidateVersion, bundleSha256, entrypointRelative: rebuilt.descriptor.entrypoint, entrypointPath, anchors};
}

// Verify what current.json points to. With a bundle hash the verification
// is the full manifest+SHA256 rebuild; legacy pointers without a hash keep
// the entrypoint-only compatibility path used by older installers.
async function verifyPointerLaunch({installRoot, pointer}) {
  const pointerVersion = String(pointer?.version || '').trim();
  if (!pointerVersion) return null;
  const versionsRoot = path.resolve(installRoot, 'versions');
  const versionRoot = path.resolve(versionsRoot, pointerVersion);
  const versionRelative = path.relative(versionsRoot, versionRoot);
  if (!versionRelative
    || versionRelative === '..'
    || versionRelative.startsWith('..' + path.sep)
    || path.isAbsolute(versionRelative)
    || versionRelative.includes(path.sep)) {
    return null;
  }
  if (!(await inspectRealDirectoryInside(versionsRoot, versionRoot))) return null;
  const rawEntrypoint = String(pointer?.entrypoint || '').trim();
  if (!rawEntrypoint || !path.isAbsolute(rawEntrypoint)) return null;
  const entrypointInspection = await inspectRegularFileInside(versionRoot, rawEntrypoint);
  if (!entrypointInspection) return null;
  const pointerEntrypointRelative = String(pointer?.entrypointRelative || '').trim();
  if (pointerEntrypointRelative) {
    let relativeEntrypoint;
    try {
      relativeEntrypoint = await inspectRegularFileInside(versionRoot, inside(versionRoot, pointerEntrypointRelative));
    } catch {
      return null;
    }
    if (!relativeEntrypoint || path.relative(relativeEntrypoint.realPath, entrypointInspection.realPath) !== '') return null;
  }
  const pointerHash = normalizedBundleSha256(pointer?.bundleSha256);
  if (pointerHash) {
    const rebuilt = await rebuildCandidateRelease(versionRoot);
    if (!rebuilt || compareVersions(rebuilt.descriptor.version, pointerVersion) !== 0 || rebuilt.bundleSha256 !== pointerHash) return null;
  }
  return {entrypoint: entrypointInspection.path, version: pointerVersion};
}

async function findRecoveryCandidate({installRoot, pointer, updateState}) {
  const versionsRoot = path.resolve(installRoot, 'versions');
  if (!(await inspectRealDirectoryInside(installRoot, versionsRoot))) return null;
  let entries;
  try {
    entries = await fs.readdir(versionsRoot, {withFileTypes: true});
  } catch {
    return null;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const name = entry.name;
    const isDot = name.startsWith('.');
    if (isDot && !name.endsWith(STAGING_SUFFIX) && !name.endsWith(BACKUP_SUFFIX)) continue;
    const dirPath = path.join(versionsRoot, name);
    if (!(await inspectRealDirectoryInside(versionsRoot, dirPath))) continue;
    const verified = await verifyCandidateRelease({versionRoot: dirPath, pointer, updateState, allowDotDir: isDot});
    if (!verified) continue;
    candidates.push({...verified, dirPath, isDot, name});
  }
  if (!candidates.length) return null;
  candidates.sort((left, right) => {
    const pointerLeft = compareVersions(String(pointer?.version || ''), left.version) === 0 ? 0 : 1;
    const pointerRight = compareVersions(String(pointer?.version || ''), right.version) === 0 ? 0 : 1;
    if (pointerLeft !== pointerRight) return pointerLeft - pointerRight;
    const anchorLeft = (left.anchors & (ANCHOR_POINTER | ANCHOR_UPDATE)) ? 0 : 1;
    const anchorRight = (right.anchors & (ANCHOR_POINTER | ANCHOR_UPDATE)) ? 0 : 1;
    if (anchorLeft !== anchorRight) return anchorLeft - anchorRight;
    if (left.isDot !== right.isDot) return left.isDot ? 1 : -1;
    const versionOrder = compareVersions(right.version, left.version);
    if (versionOrder !== 0) return versionOrder;
    return left.name.localeCompare(right.name);
  });
  return candidates[0];
}

async function gcVerifiedRecoveryDirs(versionsRoot, version) {
  const prefix = '.' + version + '.';
  for (const entry of await fs.readdir(versionsRoot, {withFileTypes: true}).catch(() => [])) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (!entry.name.startsWith(prefix)) continue;
    if (!entry.name.endsWith(STAGING_SUFFIX) && !entry.name.endsWith(BACKUP_SUFFIX)) continue;
    const target = path.join(versionsRoot, entry.name);
    if (!(await inspectRealDirectoryInside(versionsRoot, target))) continue;
    await fs.rm(target, {recursive: true, force: true}).catch(() => {});
  }
}

async function promoteCandidate({installRoot, candidate, pointer, updateState}) {
  const rechecked = await verifyPointerLaunch({installRoot, pointer});
  if (rechecked) return pointer;
  const versionsRoot = path.resolve(installRoot, 'versions');
  const versionRoot = path.resolve(versionsRoot, candidate.version);
  if (path.dirname(versionRoot) !== versionsRoot) throw new Error('Invalid candidate version directory: ' + candidate.version);
  if (path.resolve(candidate.dirPath) !== path.resolve(versionRoot)) {
    const existingRoot = await inspectRealDirectoryInside(versionsRoot, versionRoot);
    if (existingRoot) {
      const backup = path.join(versionsRoot, '.' + candidate.version + '.recover.' + Date.now() + '.' + Math.random().toString(16).slice(2) + BACKUP_SUFFIX);
      await fs.rename(versionRoot, backup);
      try {
        await fs.rename(candidate.dirPath, versionRoot);
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          if (!(await inspectRealDirectoryInside(versionsRoot, versionRoot))) await fs.rename(backup, versionRoot).catch(() => {});
          throw error;
        }
      }
      const racedPublication = await verifyCandidateRelease({versionRoot, pointer, updateState, allowDotDir: false});
      if (!racedPublication) {
        const failedRoot = path.join(versionsRoot, '.' + candidate.version + '.failed.' + Date.now() + '.' + Math.random().toString(16).slice(2) + STAGING_SUFFIX);
        if (await inspectRealDirectoryInside(versionsRoot, versionRoot)) await fs.rename(versionRoot, failedRoot).catch(() => {});
        if (!(await inspectRealDirectoryInside(versionsRoot, versionRoot))) await fs.rename(backup, versionRoot).catch(() => {});
        throw new Error('Recovered release failed verification during atomic promotion; original tree was preserved');
      }
      await fs.rm(backup, {recursive: true, force: true}).catch(() => {});
    } else {
      await fs.rename(candidate.dirPath, versionRoot).catch(error => {
        if (error?.code !== 'ENOENT') throw error;
      });
    }
  }
  const republished = await verifyCandidateRelease({versionRoot, pointer, updateState, allowDotDir: false});
  if (!republished) throw new Error('Recovered release failed verification after promotion');
  await writeJsonAtomic(path.join(versionRoot, VERIFIED_MARKER), {
    schemaVersion: POINTER_SCHEMA_VERSION,
    version: republished.version,
    bundleSha256: republished.bundleSha256,
    entrypoint: republished.entrypointRelative,
    verifiedAt: new Date().toISOString(),
  }).catch(() => {});
  const promotedPointer = {
    schemaVersion: POINTER_SCHEMA_VERSION,
    version: republished.version,
    entrypoint: inside(versionRoot, republished.entrypointRelative),
    entrypointRelative: republished.entrypointRelative,
    bundleSha256: republished.bundleSha256,
    installedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(path.join(installRoot, 'current.json'), promotedPointer);
  return promotedPointer;
}

function failClosed(message) {
  process.stderr.write('SHEIN BI Ops CLI 无法启动：' + message + '\n');
  process.stderr.write('本地 CLI 安装已损坏，且没有通过 manifest+SHA256 完整验证的可用本地版本。\n');
  process.stderr.write('请在已登录的终端重新运行 shein-bi-ops 命令触发在线修复，或重新运行安装脚本。\n');
  process.exit(1);
}

function findInstallRoot() {
  if (process.env.SHEIN_BI_OPS_INSTALL_ROOT) return path.resolve(process.env.SHEIN_BI_OPS_INSTALL_ROOT);
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  return path.basename(scriptDir).toLowerCase() === 'scripts'
    ? path.resolve(scriptDir, '..', '..', '..')
    : scriptDir;
}

const installRoot = findInstallRoot();
let pointer = await readJson(path.join(installRoot, 'current.json'));
let updateState = await readJson(path.join(installRoot, 'update-state.json'));

let launch = await verifyPointerLaunch({installRoot, pointer});
if (!launch) {
  let releaseUpdateLock = null;
  let recoveryError = '';
  let recovered = false;
  try {
    releaseUpdateLock = await acquireBootstrapUpdateLock(path.join(installRoot, '.update.lock'));
    pointer = await readJson(path.join(installRoot, 'current.json'));
    updateState = await readJson(path.join(installRoot, 'update-state.json'));
    launch = await verifyPointerLaunch({installRoot, pointer});
    if (!launch) {
      const candidate = await findRecoveryCandidate({installRoot, pointer, updateState});
      if (!candidate) {
        recoveryError = 'SHEIN BI Ops CLI current entrypoint is missing or failed validation, and no verified local candidate exists';
      } else {
        const promoted = await promoteCandidate({installRoot, candidate, pointer, updateState});
        launch = await verifyPointerLaunch({installRoot, pointer: promoted});
        if (!launch) recoveryError = 'recovered candidate failed final verification before launch';
        else {
          recovered = true;
          await gcVerifiedRecoveryDirs(path.resolve(installRoot, 'versions'), launch.version);
        }
      }
    }
  } catch (error) {
    recoveryError = error?.message || String(error);
  } finally {
    await releaseUpdateLock?.();
  }
  if (!launch) failClosed(recoveryError || 'local recovery failed without a verified launch target');
  if (recovered) process.stderr.write('SHEIN BI Ops CLI 已从本地已验证版本恢复启动：' + launch.version + '\n');
}

const result = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [launch.entrypoint, ...process.argv.slice(2)], {
    stdio: 'inherit',
    windowsHide: true,
    env: {...process.env, SHEIN_BI_OPS_INSTALL_ROOT: installRoot},
  });
  child.on('error', reject);
  child.on('close', (code, signal) => resolve({code: Number.isInteger(code) ? code : 1, signal}));
});
if (result.signal) process.kill(process.pid, result.signal);
else process.exitCode = result.code;
