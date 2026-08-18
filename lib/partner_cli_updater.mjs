import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import {acquireCrossProcessTicketLock} from './cross_process_ticket_lock.mjs';
import {compareBiOpsCliVersions} from './partner_knowledge_cache.mjs';
import {buildPartnerCliRelease, normalizePartnerCliReleasePath, validatePartnerCliRelease} from './partner_cli_release.mjs';

const UPDATE_LOCK_TIMEOUT_MS = 120_000;
const UPDATE_LOCK_STALE_MS = 10 * 60_000;
const MAX_RELEASE_RESPONSE_BYTES = 24 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const VERIFIED_MARKER = '.verified.json';
const STAGING_SUFFIX = '.tmp';
const BACKUP_SUFFIX = '.bak';
const ATOMIC_REPLACE_RETRY_CODES = new Set(['EACCES', 'EBUSY', 'EEXIST', 'EPERM']);
const ATOMIC_REPLACE_RETRY_DELAYS_MS = [10, 25, 50, 100, 250, 500, 1_000];

/**
 * Deterministic crash injection used only by kill/resume tests. Production
 * callers never pass faultPoints; when a named point is set, the process is
 * killed with process.exit so the on-disk state is exactly what a power loss
 * at that publish step would leave behind.
 */
function crashAt(faultPoints, point) {
  if (faultPoints?.[point]) process.exit(Number(faultPoints.exitCode ?? 91));
}

function atomicReplaceErrorAt(faultPoints, point) {
  const configured = faultPoints?.[point];
  if (!configured) return;
  const error = new Error(`Injected atomic replace failure at ${point}`);
  error.code = typeof configured === 'object' && configured.code ? String(configured.code) : 'EPERM';
  throw error;
}

function intermediateDirFor(versionsRoot, version, suffix) {
  return path.join(versionsRoot, `.${version}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}${suffix}`);
}

/**
 * Remove leftover intermediate directories (.tmp staging and .bak swap
 * backups) for the exact version being installed. Runs under the update lock
 * only after the canonical root has passed complete verification, so recovery
 * evidence from an earlier crash is never deleted before a replacement is
 * known good. Published version directories are never touched here.
 */
async function gcStaleIntermediateReleaseDirs(versionsRoot, version) {
  let entries;
  try {
    entries = await fs.readdir(versionsRoot, {withFileTypes: true});
  } catch {
    return;
  }
  const prefix = `.${version}.`;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const name = entry.name;
    if (!name.startsWith(prefix)) continue;
    if (!name.endsWith(STAGING_SUFFIX) && !name.endsWith(BACKUP_SUFFIX)) continue;
    await fs.rm(path.join(versionsRoot, name), {recursive: true, force: true}).catch(() => {});
  }
}

/**
 * Best-effort attestation written inside a published version directory only
 * after the full manifest+SHA256 verification succeeded. It lets the stable
 * offline bootstrap re-verify older published versions when the current
 * pointer and update-state anchors no longer cover them (keeps the previous
 * bootable release available for recovery). Failure is non-fatal because the
 * pointer and update-state anchors still cover every crash window.
 */
async function writeVerifiedMarker(versionRoot, pointer, now) {
  await writeJsonAtomic(path.join(versionRoot, VERIFIED_MARKER), {
    schemaVersion: 2,
    version: String(pointer?.version || ''),
    bundleSha256: String(pointer?.bundleSha256 || ''),
    entrypoint: String(pointer?.entrypointRelative || pointer?.entrypoint || ''),
    verifiedAt: now.toISOString(),
  }).catch(() => {});
}

function normalizedBundleSha256(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return SHA256_PATTERN.test(normalized) ? normalized : '';
}

function pointerMatchesRelease(pointer, version, bundleSha256) {
  const expectedBundleSha256 = normalizedBundleSha256(bundleSha256);
  return expectedBundleSha256
    && compareBiOpsCliVersions(String(pointer?.version || ''), String(version || '')) === 0
    && normalizedBundleSha256(pointer?.bundleSha256) === expectedBundleSha256;
}

function partnerCliAuthError({expired = false} = {}) {
  const error = new Error(
    expired
      ? 'BI 登录已失效，CLI 尚未开始查数。请先运行“$HOME\\.shein-bi\\cli\\shein-bi-ops.cmd login --username <你的BI账号>”重新登录一次，再重试原命令。'
      : '尚未登录 BI，CLI 尚未开始查数。请先运行“$HOME\\.shein-bi\\cli\\shein-bi-ops.cmd login --username <你的BI账号>”完成登录，再重试原命令。',
  );
  error.code = expired ? 'BI_SESSION_EXPIRED' : 'BI_LOGIN_REQUIRED';
  if (expired) error.status = 401;
  return error;
}

async function readJson(file, fallback = null) {
  try { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); } catch { return fallback; }
}

async function writeJsonAtomic(file, value, {beforeRename = null, beforeRenameAttempt = null} = {}) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  let handle = null;
  try {
    handle = await fs.open(temp, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, {encoding: 'utf8'});
    await handle.sync();
    await handle.close();
    handle = null;
    if (beforeRename) await beforeRename(temp, file);
    // Never move the live pointer/marker out of the way. On Windows an
    // antivirus or another reader can transiently reject MoveFileEx-style
    // replacement; retry the same atomic replace and otherwise leave the old
    // target intact. A two-rename .bak fallback creates a power-loss window
    // where current.json (or the only verified marker) is absent.
    await replaceFileAtomically(temp, file, {beforeAttempt: beforeRenameAttempt});
    await syncDirectoryBestEffort(path.dirname(file));
    try { await fs.chmod(file, 0o600); } catch {}
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temp, {force: true}).catch(() => {});
  }
}

// The stable bootstrap/skill at its canonical path is the only thing a
// launcher can execute before the pointer moves. Its publication must
// therefore end with a hard verification: if the canonical file is missing,
// unreadable or divergent after the atomic replace, the install fails closed
// BEFORE current.json moves, and the marker-anchored verified tree plus the
// next updater run restore it. A crash or injected divergence at this step
// (label-stable-file-verify / label-stable-file-divergence) can therefore
// never leave the pointer switched to an install without its launcher.
async function assertStableFilePublished(target, expectedBytes, label, faultPoints) {
  crashAt(faultPoints, `${label}-stable-file-verify`);
  if (faultPoints?.[`${label}-stable-file-divergence`]) {
    await fs.writeFile(target, Buffer.from('CORRUPTED STABLE FILE'), {mode: 0o600}).catch(() => {});
  }
  let actual;
  try {
    const stat = await fs.lstat(target);
    if (!stat.isFile()) throw new Error('not a regular file');
    actual = await fs.readFile(target);
  } catch (error) {
    throw new Error(`Partner CLI ${label} stable file is missing or unreadable after atomic publish: ${target}: ${error?.message || error}`);
  }
  if (!actual.equals(expectedBytes)) {
    throw new Error(`Partner CLI ${label} stable file failed verification after atomic publish: ${target}`);
  }
}

// A previous crashed attempt may have left stale .tmp/.bak siblings next to
// the canonical bootstrap/skill (for example a move-away residue). They are
// inert for the launcher, but they are collected only after the canonical
// file has been atomically replaced and verified, mirroring the version-dir
// GC rule that recovery evidence is never deleted before a known-good
// replacement is in place.
async function gcStaleStableFileSiblings(target) {
  const dir = path.dirname(target);
  const prefix = `${path.basename(target)}.`;
  let entries;
  try { entries = await fs.readdir(dir); } catch { return; }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    if (!entry.endsWith(STAGING_SUFFIX) && !entry.endsWith(BACKUP_SUFFIX)) continue;
    await fs.rm(path.join(dir, entry), {force: true}).catch(() => {});
  }
}

async function syncDirectoryBestEffort(directory) {
  let handle;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch {
    // Windows commonly refuses directory handles. The file itself is synced
    // before publication; directory syncing is an extra durability barrier on
    // filesystems that expose it.
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function replaceFileAtomically(temp, file, {beforeAttempt = null} = {}) {
  if (path.dirname(path.resolve(temp)) !== path.dirname(path.resolve(file))) {
    throw new Error(`Atomic Partner CLI file replacement requires one directory: ${file}`);
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      if (beforeAttempt) await beforeAttempt(attempt, temp, file);
      // A same-directory rename is the only namespace mutation. In
      // particular, never rename the live target to .bak and never rm it:
      // either this replace succeeds, or the previous bootstrap/skill remains
      // at its stable path for the next CLI start.
      await fs.rename(temp, file);
      return;
    } catch (error) {
      const delayMs = ATOMIC_REPLACE_RETRY_DELAYS_MS[attempt];
      if (!ATOMIC_REPLACE_RETRY_CODES.has(error?.code) || delayMs === undefined) {
        const failure = new Error(
          `Atomic Partner CLI file replacement failed; previous target was left in place: ${file}: ${error?.message || error}`,
          {cause: error},
        );
        failure.code = error?.code || 'PARTNER_CLI_ATOMIC_REPLACE_FAILED';
        throw failure;
      }
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

async function writeFileAtomic(file, bytes, mode = 0o600, {
  beforeRename = null,
  beforeRenameAttempt = null,
  afterRename = null,
} = {}) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    const handle = await fs.open(temp, 'wx', mode);
    try {
      await handle.writeFile(bytes);
      await handle.chmod(mode).catch(() => {});
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (beforeRename) await beforeRename(temp, file);
    await replaceFileAtomically(temp, file, {beforeAttempt: beforeRenameAttempt});
    await syncDirectoryBestEffort(path.dirname(file));
    if (afterRename) await afterRename(file);
  } finally {
    await fs.rm(temp, {force: true}).catch(() => {});
  }
}

function inside(root, relativePath) {
  const target = path.resolve(root, normalizePartnerCliReleasePath(relativePath));
  const rel = path.relative(path.resolve(root), target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Partner CLI update path escapes install root: ${relativePath}`);
  return target;
}

function pathIsStrictlyInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return Boolean(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function sameResolvedPath(left, right) {
  return path.relative(path.resolve(left), path.resolve(right)) === '';
}

function invalidManagedInstallation(reason) {
  return {ok: false, entrypoint: '', reason};
}

async function inspectRegularFileInside(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!pathIsStrictlyInside(resolvedRoot, resolvedTarget)) return null;
  const [rootStat, fileStat] = await Promise.all([
    fs.lstat(resolvedRoot).catch(() => null),
    fs.lstat(resolvedTarget).catch(() => null),
  ]);
  if (!rootStat?.isDirectory() || !fileStat?.isFile()) return null;
  const [realRoot, realTarget] = await Promise.all([
    fs.realpath(resolvedRoot).catch(() => ''),
    fs.realpath(resolvedTarget).catch(() => ''),
  ]);
  if (!realRoot || !realTarget || !pathIsStrictlyInside(realRoot, realTarget)) return null;
  return {path: resolvedTarget, realPath: realTarget, stat: fileStat};
}

function normalizedManifestFiles(manifest) {
  if (!Array.isArray(manifest?.files) || manifest.files.length === 0) return null;
  const seen = new Set();
  const files = [];
  try {
    for (const file of manifest.files) {
      const relativePath = normalizePartnerCliReleasePath(file?.path);
      const size = Number(file?.size);
      const sha256 = String(file?.sha256 || '').trim().toLowerCase();
      if (seen.has(relativePath) || !Number.isSafeInteger(size) || size < 0 || !SHA256_PATTERN.test(sha256)) return null;
      seen.add(relativePath);
      files.push({path: relativePath, size, sha256});
    }
  } catch {
    return null;
  }
  return files;
}

async function verifyFilesAgainstManifest({versionRoot, entrypointInspection, pointer, manifest}) {
  const manifestVersion = String(manifest?.version || '').trim();
  const manifestBundleSha256 = normalizedBundleSha256(manifest?.bundleSha256);
  const pointerBundleSha256 = normalizedBundleSha256(pointer?.bundleSha256);
  if (!manifestVersion
    || compareBiOpsCliVersions(String(pointer?.version || ''), manifestVersion) !== 0
    || !manifestBundleSha256
    || pointerBundleSha256 !== manifestBundleSha256) {
    return invalidManagedInstallation('release-identity-mismatch');
  }

  let manifestEntrypoint;
  try {
    manifestEntrypoint = normalizePartnerCliReleasePath(manifest?.entrypoint);
  } catch {
    return invalidManagedInstallation('manifest-entrypoint-invalid');
  }
  const files = normalizedManifestFiles(manifest);
  if (!files?.some(file => file.path === manifestEntrypoint)) {
    return invalidManagedInstallation('manifest-files-invalid');
  }
  const expectedEntrypoint = await inspectRegularFileInside(versionRoot, inside(versionRoot, manifestEntrypoint));
  if (!expectedEntrypoint || !sameResolvedPath(expectedEntrypoint.realPath, entrypointInspection.realPath)) {
    return invalidManagedInstallation('entrypoint-does-not-match-release');
  }

  for (const file of files) {
    const target = inside(versionRoot, file.path);
    const inspected = await inspectRegularFileInside(versionRoot, target);
    if (!inspected || inspected.stat.size !== file.size) return invalidManagedInstallation(`release-file-invalid:${file.path}`);
    const bytes = await fs.readFile(target).catch(() => null);
    if (!bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      return invalidManagedInstallation(`release-file-hash-mismatch:${file.path}`);
    }
  }
  return {ok: true, entrypoint: entrypointInspection.path, verification: 'full-file-hashes'};
}

async function verifyManagedPartnerCliInstallation(managedRoot, pointer = {}, {
  expectedVersion = '',
  expectedBundleSha256 = '',
  manifest = null,
} = {}) {
  const pointerVersion = String(pointer?.version || '').trim();
  if (!pointerVersion) return invalidManagedInstallation('pointer-version-missing');
  if (expectedVersion && compareBiOpsCliVersions(pointerVersion, String(expectedVersion)) !== 0) {
    return invalidManagedInstallation('pointer-version-mismatch');
  }

  const versionsRoot = path.resolve(managedRoot, 'versions');
  const versionRoot = path.resolve(versionsRoot, pointerVersion);
  const versionRelative = path.relative(versionsRoot, versionRoot);
  if (!versionRelative
    || versionRelative === '..'
    || versionRelative.startsWith(`..${path.sep}`)
    || path.isAbsolute(versionRelative)
    || versionRelative.includes(path.sep)) {
    return invalidManagedInstallation('pointer-version-directory-invalid');
  }

  const rawEntrypoint = String(pointer?.entrypoint || '').trim();
  if (!rawEntrypoint || !path.isAbsolute(rawEntrypoint)) return invalidManagedInstallation('pointer-entrypoint-invalid');
  const entrypointInspection = await inspectRegularFileInside(versionRoot, rawEntrypoint);
  if (!entrypointInspection) return invalidManagedInstallation('pointer-entrypoint-missing-or-outside-version');

  const pointerEntrypointRelative = String(pointer?.entrypointRelative || '').trim();
  if (pointerEntrypointRelative) {
    let relativeEntrypoint;
    try {
      relativeEntrypoint = await inspectRegularFileInside(versionRoot, inside(versionRoot, pointerEntrypointRelative));
    } catch {
      return invalidManagedInstallation('pointer-relative-entrypoint-invalid');
    }
    if (!relativeEntrypoint || !sameResolvedPath(relativeEntrypoint.realPath, entrypointInspection.realPath)) {
      return invalidManagedInstallation('pointer-entrypoint-conflict');
    }
  }

  const expectedHash = expectedBundleSha256 ? normalizedBundleSha256(expectedBundleSha256) : '';
  if (expectedBundleSha256 && !expectedHash) return invalidManagedInstallation('expected-bundle-hash-invalid');
  const pointerHash = normalizedBundleSha256(pointer?.bundleSha256);
  if (expectedHash && pointerHash !== expectedHash) return invalidManagedInstallation('pointer-bundle-hash-mismatch');

  if (manifest) {
    const manifestVerification = await verifyFilesAgainstManifest({versionRoot, entrypointInspection, pointer, manifest});
    if (!manifestVerification.ok) return manifestVerification;
    let rebuilt;
    try {
      rebuilt = await buildPartnerCliRelease({sourceRoot: versionRoot});
    } catch {
      return invalidManagedInstallation('installed-bundle-cannot-be-rebuilt');
    }
    if (normalizedBundleSha256(rebuilt?.manifest?.bundleSha256) !== pointerHash) {
      return invalidManagedInstallation('installed-bundle-hash-mismatch');
    }
    return manifestVerification;
  }
  if (pointerHash) {
    let rebuilt;
    try {
      rebuilt = await buildPartnerCliRelease({sourceRoot: versionRoot});
    } catch {
      return invalidManagedInstallation('installed-bundle-cannot-be-rebuilt');
    }
    if (normalizedBundleSha256(rebuilt?.manifest?.bundleSha256) !== pointerHash) {
      return invalidManagedInstallation('installed-bundle-hash-mismatch');
    }
    return await verifyFilesAgainstManifest({versionRoot, entrypointInspection, pointer, manifest: rebuilt.manifest});
  }

  return {ok: true, entrypoint: entrypointInspection.path, verification: 'entrypoint-only'};
}

async function fetchReleaseJson(fetchImpl, url, {cookie = '', headers = {}, timeoutMs = 60_000} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, timeoutMs));
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      headers: {accept: 'application/json', ...(cookie ? {cookie} : {}), ...headers},
      signal: controller.signal,
    });
    if (response.status === 304) return {response, json: null};
    const length = Number(response.headers.get('content-length') || 0);
    if (length > MAX_RELEASE_RESPONSE_BYTES) throw new Error('Partner CLI release response is too large');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_RELEASE_RESPONSE_BYTES) throw new Error('Partner CLI release response is too large');
    if (response.status === 401) throw partnerCliAuthError({expired: true});
    let json = {};
    try { json = bytes.length ? JSON.parse(bytes.toString('utf8')) : {}; } catch { throw new Error(`Partner CLI release endpoint returned invalid JSON (HTTP ${response.status})`); }
    if (!response.ok || json?.ok === false) {
      const error = new Error(json?.error || `Partner CLI release HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return {response, json};
  } catch (error) {
    if (controller.signal.aborted) {
      const timeout = new Error('Partner CLI update request timed out');
      timeout.code = 'PARTNER_CLI_UPDATE_TIMEOUT';
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function findManagedPartnerCliInstallRoot({entryRoot = '', installRoot = ''} = {}) {
  if (installRoot) {
    const explicit = path.resolve(installRoot);
    return (await readJson(path.join(explicit, 'current.json'), null)) ? explicit : '';
  }
  if (process.env.SHEIN_BI_OPS_INSTALL_ROOT) {
    const fromEnv = path.resolve(process.env.SHEIN_BI_OPS_INSTALL_ROOT);
    if (await readJson(path.join(fromEnv, 'current.json'), null)) return fromEnv;
  }
  let cursor = path.resolve(entryRoot || process.cwd());
  for (let depth = 0; depth < 5; depth += 1) {
    if (await readJson(path.join(cursor, 'current.json'), null)) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return '';
}

async function installValidatedRelease({validated, installRoot, codexHome = '', now = new Date(), faultPoints = null} = {}) {
  const versionsRoot = path.resolve(installRoot, 'versions');
  const versionRoot = path.resolve(versionsRoot, validated.version);
  if (path.dirname(versionRoot) !== versionsRoot) throw new Error('Invalid Partner CLI release version directory: ' + validated.version);
  const tempRoot = intermediateDirFor(versionsRoot, validated.version, STAGING_SUFFIX);
  const entrypoint = inside(versionRoot, validated.entrypoint);
  const installPointer = {
    schemaVersion: 2,
    version: validated.version,
    entrypoint,
    entrypointRelative: validated.entrypoint,
    bundleSha256: validated.bundleSha256,
  };
  const installManifest = {
    version: validated.version,
    entrypoint: validated.entrypoint,
    bundleSha256: validated.bundleSha256,
    files: validated.files.map(file => ({path: file.path, size: file.size, sha256: file.sha256})),
  };
  await fs.mkdir(versionsRoot, {recursive: true});
  await fs.rm(tempRoot, {recursive: true, force: true});
  let swapBackupDir = '';
  try {
    for (const file of validated.files) {
      const target = inside(tempRoot, file.path);
      await fs.mkdir(path.dirname(target), {recursive: true});
      await fs.writeFile(target, file.bytes, {mode: 0o600});
    }
    // Crash-consistency: never mutate published state before the staging copy
    // itself passes the full manifest+SHA256 verification.
    const stagedEntrypoint = await inspectRegularFileInside(tempRoot, inside(tempRoot, validated.entrypoint));
    const stagedVerification = stagedEntrypoint
      ? await verifyFilesAgainstManifest({versionRoot: tempRoot, entrypointInspection: stagedEntrypoint, pointer: installPointer, manifest: installManifest})
      : invalidManagedInstallation('staged-entrypoint-invalid');
    if (!stagedVerification.ok) throw new Error('Partner CLI staged release verification failed: ' + stagedVerification.reason);
    let stagedRebuild;
    try {
      stagedRebuild = await buildPartnerCliRelease({sourceRoot: tempRoot});
    } catch {
      throw new Error('Partner CLI staged release cannot be rebuilt');
    }
    if (normalizedBundleSha256(stagedRebuild?.manifest?.bundleSha256) !== validated.bundleSha256) {
      throw new Error('Partner CLI staged release bundle hash mismatch');
    }

    crashAt(faultPoints, 'before-version-swap');
    const existing = await fs.lstat(versionRoot).catch(() => null);
    if (existing) {
      const existingVerification = await verifyManagedPartnerCliInstallation(installRoot, installPointer, {
        expectedVersion: validated.version,
        expectedBundleSha256: validated.bundleSha256,
        manifest: installManifest,
      });
      if (!existingVerification.ok) {
        // Crash-consistent swap: current.json never moves and versionRoot is
        // absent only between the two same-directory renames, when both the
        // verified staging copy and a backup still exist. The stable bootstrap
        // recovers by promoting the verified staging, so no crash point can
        // leave the pointer permanently dangling. Never rm+rename.
        const backupDir = intermediateDirFor(versionsRoot, validated.version, BACKUP_SUFFIX);
        await fs.rename(versionRoot, backupDir);
        swapBackupDir = backupDir;
        crashAt(faultPoints, 'after-version-swap-away');
        try {
          await fs.rename(tempRoot, versionRoot);
        } catch (error) {
          // A concurrent recovery bootstrap already promoted verified staging.
          if (error?.code !== 'ENOENT') {
            if (!(await fs.lstat(versionRoot).catch(() => null))) {
              await fs.rename(backupDir, versionRoot).catch(() => {});
              swapBackupDir = '';
            }
            throw error;
          }
        }
        crashAt(faultPoints, 'after-version-swap-in');
      }
    } else {
      try {
        await fs.rename(tempRoot, versionRoot);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  } finally {
    await fs.rm(tempRoot, {recursive: true, force: true}).catch(() => {});
  }

  const installedVerification = await verifyManagedPartnerCliInstallation(installRoot, installPointer, {
    expectedVersion: validated.version,
    expectedBundleSha256: validated.bundleSha256,
    manifest: installManifest,
  });
  if (!installedVerification.ok) {
    // The backup is disposable only after the republished root passes the
    // complete manifest/hash check. An older bootstrap may not participate in
    // the new lock protocol, so restore the preserved tree if such a race left
    // the canonical version path absent; otherwise retain both trees.
    if (swapBackupDir && !(await fs.lstat(versionRoot).catch(() => null))) {
      await fs.rename(swapBackupDir, versionRoot).catch(() => {});
      swapBackupDir = '';
    }
    throw new Error('Partner CLI installed release verification failed: ' + installedVerification.reason);
  }
  if (swapBackupDir) await fs.rm(swapBackupDir, {recursive: true, force: true}).catch(() => {});

  await writeVerifiedMarker(versionRoot, installPointer, now);

  const bootstrapSource = inside(versionRoot, validated.bootstrap);
  const bootstrapTarget = path.join(installRoot, 'bootstrap.mjs');
  const bootstrapBytes = await fs.readFile(bootstrapSource);
  await writeFileAtomic(bootstrapTarget, bootstrapBytes, 0o700, {
    beforeRename: () => crashAt(faultPoints, 'bootstrap-write-before-atomic-replace'),
    beforeRenameAttempt: () => atomicReplaceErrorAt(faultPoints, 'bootstrap-write-atomic-replace-error'),
    afterRename: () => crashAt(faultPoints, 'bootstrap-write-after-atomic-replace'),
  });
  await assertStableFilePublished(bootstrapTarget, bootstrapBytes, 'bootstrap', faultPoints);
  await gcStaleStableFileSiblings(bootstrapTarget);
  const skillSource = inside(versionRoot, validated.codexSkill);
  const skillRoot = path.resolve(codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const skillTarget = path.join(skillRoot, 'skills', 'shein-bi-ops', 'SKILL.md');
  const skillBytes = await fs.readFile(skillSource);
  await writeFileAtomic(skillTarget, skillBytes, 0o600, {
    beforeRename: () => crashAt(faultPoints, 'skill-write-before-atomic-replace'),
    beforeRenameAttempt: () => atomicReplaceErrorAt(faultPoints, 'skill-write-atomic-replace-error'),
    afterRename: () => crashAt(faultPoints, 'skill-write-after-atomic-replace'),
  });
  await assertStableFilePublished(skillTarget, skillBytes, 'skill', faultPoints);
  await gcStaleStableFileSiblings(skillTarget);

  // Recovery evidence from an earlier killed attempt is indispensable until
  // the canonical version root has passed its complete verification. Only
  // now may stale .tmp/.bak directories be collected; doing this at install
  // start creates a second-crash window with no verified copy left.
  await gcStaleIntermediateReleaseDirs(versionsRoot, validated.version);

  crashAt(faultPoints, 'before-pointer-write');
  await writeJsonAtomic(path.join(installRoot, 'current.json'), {
    ...installPointer,
    installedAt: now.toISOString(),
  }, {
    beforeRename: () => crashAt(faultPoints, 'pointer-write-before-rename'),
    beforeRenameAttempt: () => atomicReplaceErrorAt(faultPoints, 'pointer-write-atomic-replace-error'),
  });
  return {versionRoot, entrypoint, skillTarget};
}

export async function checkAndInstallPartnerCliUpdate({
  baseUrl,
  cookie,
  currentVersion,
  entryRoot = '',
  installRoot = '',
  codexHome = '',
  fetchImpl = globalThis.fetch,
  force = false,
  checkOnly = false,
  timeoutMs = 60_000,
  maxAgeMs = 0,
  faultPoints = null,
} = {}) {
  const managedRoot = await findManagedPartnerCliInstallRoot({entryRoot, installRoot});
  if (!managedRoot) return {ok: true, managed: false, updated: false, currentVersion};
  const managedPointer = await readJson(path.join(managedRoot, 'current.json'), {});
  const updateStateFile = path.join(managedRoot, 'update-state.json');
  const priorState = await readJson(updateStateFile, {});
  const priorLatestVersion = String(priorState.latestVersion || currentVersion);
  const priorBundleSha256 = normalizedBundleSha256(priorState.bundleSha256);
  if (compareBiOpsCliVersions(String(managedPointer.version || ''), currentVersion) > 0) {
    const pointerMatchesCachedRelease = compareBiOpsCliVersions(String(managedPointer.version || ''), priorLatestVersion) === 0;
    const pointerInstallation = await verifyManagedPartnerCliInstallation(managedRoot, managedPointer, {
      expectedVersion: String(managedPointer.version || ''),
      expectedBundleSha256: pointerMatchesCachedRelease ? priorBundleSha256 : '',
    });
    if (pointerInstallation.ok) {
      return {
        ok: true,
        managed: true,
        updated: true,
        currentVersion,
        latestVersion: String(managedPointer.version),
        entrypoint: pointerInstallation.entrypoint,
        source: 'current-pointer',
      };
    }
  }
  if (!cookie) throw partnerCliAuthError();
  const checkedAt = Date.parse(String(priorState.checkedAt || ''));
  const priorVersionComparison = compareBiOpsCliVersions(currentVersion, priorLatestVersion);
  const cachedSameVersionHashMatches = priorVersionComparison === 0
    && pointerMatchesRelease(managedPointer, priorLatestVersion, priorBundleSha256);
  const freshCheckCandidate = !force
    && Number(maxAgeMs) > 0
    && Number.isFinite(checkedAt)
    && Date.now() - checkedAt >= 0
    && Date.now() - checkedAt <= Number(maxAgeMs)
    && priorVersionComparison >= 0
    && Boolean(priorBundleSha256)
    && (priorVersionComparison > 0 || cachedSameVersionHashMatches);
  const freshInstallation = freshCheckCandidate
    ? await verifyManagedPartnerCliInstallation(managedRoot, managedPointer, {
      expectedVersion: priorVersionComparison === 0 ? priorLatestVersion : currentVersion,
      expectedBundleSha256: priorVersionComparison === 0 ? priorBundleSha256 : '',
    })
    : invalidManagedInstallation('fresh-check-not-eligible');
  if (freshCheckCandidate && freshInstallation.ok) {
    return {
      ok: true,
      managed: true,
      updated: false,
      currentVersion,
      latestVersion: priorState.latestVersion || currentVersion,
      source: 'fresh-check-cache',
      checkedAt: priorState.checkedAt,
    };
  }
  const base = String(baseUrl || '').replace(/\/+$/, '');
  let manifestResult;
  try {
    manifestResult = await fetchReleaseJson(fetchImpl, `${base}/api/partner-cli/manifest`, {
      cookie,
      timeoutMs,
      headers: !force && priorState.etag ? {'if-none-match': String(priorState.etag)} : {},
    });
  } catch (error) {
    if ([404, 501].includes(Number(error?.status || 0))) return {ok: true, managed: true, unsupported: true, updated: false, currentVersion};
    throw error;
  }
  if (manifestResult.response.status === 304) {
    const cachedLatestVersion = String(priorState.latestVersion || '').trim();
    const cachedComparison = compareBiOpsCliVersions(currentVersion, cachedLatestVersion);
    const cachedPointerMatches = cachedComparison === 0
      && pointerMatchesRelease(managedPointer, cachedLatestVersion, priorBundleSha256);
    const cachedIdentityUsable = Boolean(cachedLatestVersion)
      && Boolean(priorBundleSha256)
      && cachedComparison >= 0
      && (cachedComparison > 0 || cachedPointerMatches);
    const cachedInstallation = cachedIdentityUsable
      ? await verifyManagedPartnerCliInstallation(managedRoot, managedPointer, {
        expectedVersion: cachedComparison === 0 ? cachedLatestVersion : currentVersion,
        expectedBundleSha256: cachedComparison === 0 ? priorBundleSha256 : '',
      })
      : invalidManagedInstallation('etag-cache-not-usable');
    if (!cachedIdentityUsable || !cachedInstallation.ok) {
      manifestResult = await fetchReleaseJson(fetchImpl, `${base}/api/partner-cli/manifest`, {cookie, timeoutMs});
    } else {
      await writeJsonAtomic(updateStateFile, {...priorState, checkedAt: new Date().toISOString()});
      return {ok: true, managed: true, updated: false, currentVersion, latestVersion: priorState.latestVersion || currentVersion, source: 'etag-304'};
    }
  }
  const manifest = manifestResult.json?.data || manifestResult.json;
  const latestVersion = String(manifest?.version || '').trim();
  if (!latestVersion) throw new Error('云端 CLI 更新清单缺少版本号');
  const manifestBundleSha256 = normalizedBundleSha256(manifest?.bundleSha256);
  if (!manifestBundleSha256) throw new Error('云端 CLI 更新清单 bundleSha256 无效');
  const etag = manifestResult.response.headers.get('etag') || '';
  await writeJsonAtomic(updateStateFile, {checkedAt: new Date().toISOString(), etag, latestVersion, bundleSha256: manifestBundleSha256});
  const comparison = compareBiOpsCliVersions(currentVersion, latestVersion);
  let currentInstallation = invalidManagedInstallation('remote-release-is-newer');
  if (comparison > 0) {
    currentInstallation = await verifyManagedPartnerCliInstallation(managedRoot, managedPointer, {
      expectedVersion: currentVersion,
    });
    if (currentInstallation.ok) {
      return {ok: true, managed: true, updated: false, currentVersion, latestVersion, source: 'local-newer'};
    }
    const error = new Error(`CLI current installation is invalid and cannot be repaired from older server release ${latestVersion}: ${currentInstallation.reason}`);
    error.code = 'PARTNER_CLI_LOCAL_NEWER_INSTALL_INVALID';
    throw error;
  }
  if (comparison === 0) {
    currentInstallation = await verifyManagedPartnerCliInstallation(managedRoot, managedPointer, {
      expectedVersion: latestVersion,
      expectedBundleSha256: manifestBundleSha256,
      manifest,
    });
    if (currentInstallation.ok) {
      return {ok: true, managed: true, updated: false, currentVersion, latestVersion, source: 'current'};
    }
  }
  const sameVersionRepairRequired = comparison === 0 && !currentInstallation.ok;
  if (checkOnly) return {ok: true, managed: true, updateAvailable: true, updated: false, currentVersion, latestVersion, manifest};

  const lockFile = path.join(managedRoot, '.update.lock');
  const release = await acquireCrossProcessTicketLock(lockFile, {
    timeoutMs: UPDATE_LOCK_TIMEOUT_MS,
    staleMs: UPDATE_LOCK_STALE_MS,
    heartbeatMs: 30_000,
    timeoutMessage: '另一个 CLI 正在安装更新，请稍后重试',
    timeoutCode: 'PARTNER_CLI_UPDATE_LOCK_TIMEOUT',
  });
  try {
    const currentPointer = await readJson(path.join(managedRoot, 'current.json'), {});
    const pointerVersion = String(currentPointer.version || currentVersion);
    const pointerComparison = compareBiOpsCliVersions(pointerVersion, latestVersion);
    if (pointerComparison >= 0) {
      const peerInstallation = await verifyManagedPartnerCliInstallation(managedRoot, currentPointer, pointerComparison === 0
        ? {expectedVersion: latestVersion, expectedBundleSha256: manifestBundleSha256, manifest}
        : {expectedVersion: pointerVersion});
      if (peerInstallation.ok) {
        const peerAdvanced = compareBiOpsCliVersions(currentVersion, pointerVersion) < 0;
        const peerRepaired = pointerComparison === 0 && sameVersionRepairRequired;
        const updatedByPeer = peerAdvanced || peerRepaired;
        return {
          ok: true,
          managed: true,
          updated: updatedByPeer,
          currentVersion,
          latestVersion: pointerVersion,
          ...(updatedByPeer ? {entrypoint: peerInstallation.entrypoint} : {}),
          source: 'updated-by-peer',
        };
      }
      if (pointerComparison > 0) {
        throw new Error(`CLI current pointer is newer than the server release but its installation is invalid: ${peerInstallation.reason}`);
      }
    }
    const bundleResult = await fetchReleaseJson(fetchImpl, `${base}/api/partner-cli/bundle`, {cookie, timeoutMs});
    const bundle = bundleResult.json?.data || bundleResult.json;
    const validated = validatePartnerCliRelease({manifest, bundle});
    if (validated.version !== latestVersion) throw new Error('云端 CLI manifest 与 bundle 版本不一致');
    const installed = await installValidatedRelease({validated, installRoot: managedRoot, codexHome, faultPoints});
    return {
      ok: true,
      managed: true,
      updated: true,
      currentVersion,
      latestVersion,
      bundleSha256: validated.bundleSha256,
      ...installed,
    };
  } finally {
    await release();
  }
}

export async function relaunchPartnerCli({entrypoint, argv = process.argv.slice(2), env = process.env} = {}) {
  if (!entrypoint) throw new Error('Updated CLI entrypoint is missing');
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entrypoint, ...argv], {
      stdio: 'inherit',
      windowsHide: true,
      env: {...env, SHEIN_BI_OPS_UPDATE_RESTARTED: '1'},
    });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({code: Number.isInteger(code) ? code : 1, signal: signal || ''}));
  });
}
