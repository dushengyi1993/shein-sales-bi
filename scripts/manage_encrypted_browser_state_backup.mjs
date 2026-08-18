#!/usr/bin/env node
/**
 * Stream an authenticated backup of persistent browser profiles and session
 * state without ever writing a plaintext archive to disk.
 *
 * The archive is intentionally repository-independent.  It contains a small
 * authenticated JSON header followed by AES-256-GCM encrypted, length-framed
 * directory/file records.  Restore is restricted to a brand-new staging
 * directory; replacing live profiles is a separate, reviewed cutover step.
 */
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {once} from 'node:events';
import {Transform, Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';
import {createGunzip, createGzip} from 'node:zlib';

const MAGIC = Buffer.from('SHEIN-BI-STATE\0\0', 'ascii');
const FORMAT = 'shein-bi-encrypted-browser-state/v2';
const INNER_FORMAT = 'shein-bi-browser-state-records/v2';
const CIPHER = 'aes-256-gcm';
const COMPRESSION = 'gzip';
const AUTH_TAG_BYTES = 16;
const IV_BYTES = 12;
const MAX_HEADER_BYTES = 1024 * 1024;
const RESTORE_CONFIRMATION = 'RESTORE_ENCRYPTED_BROWSER_STATE_TO_EMPTY_STAGING';
const MAX_HOST_ID_BYTES = 128;
const DEFAULT_LIMITS = Object.freeze({
  maxEntries: 200000,
  maxTotalBytes: 2 * 1024 ** 3,
  maxFileBytes: 512 * 1024 ** 2,
  maxCompressionRatio: 1000,
  freeMarginBytes: 64 * 1024 ** 2,
});

// Streaming plaintext is the sum of authenticated record bytes plus frame
// overhead.  Keep the backstop above the strict bounds so legitimate gzip
// expansion and small record headers can never trip it.
const STREAM_OVERHEAD_SLACK = 64 * 1024 * 1024;
const LINUX_PYTHON3 = '/usr/bin/python3';
const LINUX_RENAME_NOREPLACE_HELPER = fileURLToPath(
  new URL('./rename_restore_directory_noreplace_linux.py', import.meta.url),
);
const PUBLICATION_HELPER_OUTPUT_LIMIT = 64 * 1024;

const EXCLUDED_DIRECTORY_NAMES = new Set([
  'cache',
  'code cache',
  'gpucache',
  'grshadercache',
  'shadercache',
  'dawncache',
  'crashpad',
  'browsermetrics',
  'component_crx_cache',
  'optimization_guide_model_store',
  'optimization_guide_prediction_model_downloads',
  'safe browsing',
  'segmentation_platform',
]);

const EXCLUDED_FILE_NAMES = new Set([
  'devtoolsactiveport',
  'singletoncookie',
  'singletonlock',
  'singletonsocket',
]);

function usage() {
  return `Usage:
  node scripts/manage_encrypted_browser_state_backup.mjs create \\
    --key-file FILE --output FILE \\
    --source profiles=/data/shein-bi/profiles \\
    [--optional-source state/shein_webapi_sessions=/data/shein-bi/state/shein_webapi_sessions]

  node scripts/manage_encrypted_browser_state_backup.mjs verify \\
    --key-file FILE --archive FILE

 node scripts/manage_encrypted_browser_state_backup.mjs restore \\
   --key-file FILE --archive FILE --destination NEW_EMPTY_PATH \\
   --confirm ${RESTORE_CONFIRMATION}

Restore identity policy (mandatory on non-Windows):
  The archive stores numeric uid/gid from the source host.  Restoring with
  bare foreign uid/gid is forbidden: every distinct uid:gid pair inside the
  archive must either be mapped explicitly with --identity-map (repeatable),
  or proven to originate from this host with --same-host-identity.  An
  unmapped identity fails closed before any staging directory is created.


Resource limits (optional, applied to create/verify/restore; defaults in parentheses):
  --limit-entries N              maximum records in one archive (200000)
  --limit-total-bytes N          maximum plaintext bytes in one archive (2147483648)
  --limit-file-bytes N           maximum plaintext bytes in one file (536870912)
  --limit-ratio N                maximum plaintext/ciphertext expansion (1000)
  --free-margin-bytes N          free bytes required above declared size before restore (67108864)
Byte sizes accept k/m/g suffixes, for example 2g or 512m.

The key file must contain either exactly 32 raw random bytes or 64 hexadecimal
characters and must not be group/world accessible on Linux.  Generate it out
of band, for example: umask 077; openssl rand -out /srv/shein-bi/secrets/browser-state-backup.key 32`;
}

function parseStrictInteger(value, flag, {allowSuffix = false} = {}) {
  const raw = String(value || '');
  let parsed;
  if (allowSuffix) {
    const match = /^(\d+)([kKmMgGtT]?)$/.exec(raw);
    if (!match) throw new Error(`${flag} requires a positive size such as 4096, 64k, 512m or 2g`);
    const multiplier = {k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4}[match[2].toLowerCase()] || 1;
    parsed = Number(match[1]) * multiplier;
  } else {
    parsed = Number(raw);
  }
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${flag} requires an integer >= 1`);
  return parsed;
}

function parseArgs(argv) {
  const [command = '', ...rest] = argv;
  const args = {
    command,
    keyFile: '',
    output: '',
    archive: '',
    destination: '',
   confirmation: '',
   sources: [],
    identityMaps: [],
    sameHostIdentity: false,
   limits: {...DEFAULT_LIMITS},
  };
  const take = (flag, index) => {
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    return value;
  };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === '--key-file') args.keyFile = path.resolve(take(flag, i++));
    else if (flag === '--output') args.output = path.resolve(take(flag, i++));
    else if (flag === '--archive') args.archive = path.resolve(take(flag, i++));
    else if (flag === '--destination') args.destination = path.resolve(take(flag, i++));
    else if (flag === '--confirm') args.confirmation = take(flag, i++);
   else if (flag === '--source') args.sources.push(parseSourceSpec(take(flag, i++), false));
   else if (flag === '--optional-source') args.sources.push(parseSourceSpec(take(flag, i++), true));
    else if (flag === '--identity-map') args.identityMaps.push(parseIdentityMapSpec(take(flag, i++)));
    else if (flag === '--same-host-identity') args.sameHostIdentity = true;
   else if (flag === '--limit-entries') args.limits.maxEntries = parseStrictInteger(take(flag, i++), flag);
    else if (flag === '--limit-total-bytes') args.limits.maxTotalBytes = parseStrictInteger(take(flag, i++), flag, {allowSuffix: true});
    else if (flag === '--limit-file-bytes') args.limits.maxFileBytes = parseStrictInteger(take(flag, i++), flag, {allowSuffix: true});
    else if (flag === '--limit-ratio') args.limits.maxCompressionRatio = parseStrictInteger(take(flag, i++), flag);
    else if (flag === '--free-margin-bytes') args.limits.freeMarginBytes = parseStrictInteger(take(flag, i++), flag, {allowSuffix: true});
    else if (flag === '--help' || flag === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return args;
}

function validateLogicalPath(value, label = 'logical path') {
  const raw = String(value || '').replaceAll('\\', '/');
  if (!raw || raw.startsWith('/') || raw.includes('\0')) throw new Error(`${label} is unsafe: ${value}`);
  const segments = raw.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error(`${label} is unsafe: ${value}`);
  }
  const normalized = path.posix.normalize(raw);
  if (normalized !== raw) throw new Error(`${label} is not normalized: ${value}`);
  return raw;
}

function parseSourceSpec(spec, optional) {
  const splitAt = String(spec || '').indexOf('=');
  if (splitAt <= 0 || splitAt === String(spec).length - 1) {
    throw new Error(`Invalid source specification: ${spec}`);
  }
  const logical = validateLogicalPath(String(spec).slice(0, splitAt), 'source logical path');
  const absolutePath = path.resolve(String(spec).slice(splitAt + 1));
  return {logical, absolutePath, optional};
}

function parseIdentityMapSpec(spec) {
  const match = /^(\d{1,10}):(\d{1,10})=(\d{1,10}):(\d{1,10})$/.exec(String(spec || ''));
  if (!match) throw new Error(`Invalid identity map: ${spec} (expected SRC_UID:SRC_GID=DST_UID:DST_GID)`);
  const values = match.slice(1).map(Number);
  if (values.some(value => value < 0 || value > 0xffff_fffe)) {
    throw new Error(`Identity map value out of range: ${spec}`);
  }
  const [srcUid, srcGid, dstUid, dstGid] = values;
  return {source: `${srcUid}:${srcGid}`, target: [dstUid, dstGid]};
}

function expectedKeyOwnerUid() {
  // Production keys are always root-owned.  A non-root caller can still
  // prove that fact with fstat and must fail closed when it is false; only
  // Windows lacks a meaningful POSIX uid.
  if (process.platform === 'win32') return undefined;
  return 0;
}

function keyReadOptions(diagnostics) {
  // Programmatic tests can inject the owner of an isolated fixture.  The CLI
  // never supplies diagnostics, so production always uses uid 0 above.
  return diagnostics && Object.hasOwn(diagnostics, 'expectedKeyOwnerUid')
    ? {expectedOwnerUid: diagnostics.expectedKeyOwnerUid}
    : {};
}

async function openNoFollow(file) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  let handle;
  try {
    handle = await fsp.open(file, flags);
  } catch (error) {
    // O_NOFOLLOW surfaces ELOOP when the final path component is a symlink.
    throw new Error(`Cannot open ${path.basename(file)} without following links (${error?.code || error?.message || error})`);
  }
  return handle;
}

function validateHostId(hostId) {
  if (hostId === undefined || hostId === null || hostId === '') return undefined;
  const value = String(hostId);
  if (value.length > MAX_HOST_ID_BYTES || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new Error('Archive host identity is invalid');
  }
  return value;
}

async function currentHostId() {
  if (process.env.SHEIN_BI_BACKUP_HOST_ID) return validateHostId(process.env.SHEIN_BI_BACKUP_HOST_ID);
  if (process.platform !== 'win32') {
    for (const candidate of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try {
        const value = String(await fsp.readFile(candidate, 'utf8')).trim();
        if (/^[0-9a-f]{1,128}$/i.test(value)) return value;
      } catch {
        // keep looking for a stable machine identity
      }
    }
  }
 return validateHostId(`${process.platform}:${os.hostname()}`);
}


async function readKeyFile(keyFile, options = {}) {
  if (!keyFile) throw new Error('--key-file is required');
  const expectedOwnerUid = options.expectedOwnerUid !== undefined ? options.expectedOwnerUid : expectedKeyOwnerUid();
  const lstat = await fsp.lstat(keyFile);
  if (!lstat.isFile() || lstat.isSymbolicLink()) throw new Error('Backup key must be a regular non-symlink file');
  const handle = await openNoFollow(keyFile);
  try {
    const before = await handle.stat({bigint: true});
    if (!before.isFile()) throw new Error('Backup key must be a regular file');
    if (process.platform !== 'win32' && before.nlink !== 1n) {
      throw new Error('Backup key must not be a hard link (nlink must be 1)');
    }
    if (process.platform !== 'win32') {
      if (Number(before.mode & 0o77n) !== 0) {
        throw new Error(`Backup key permissions must deny group/world access: mode=${(Number(before.mode) & 0o777).toString(8)}`);
      }
      const parentStat = await fsp.stat(path.dirname(path.resolve(keyFile)), {bigint: true});
      if (Number(parentStat.mode & 0o22n) !== 0) {
        throw new Error('Backup key parent directory must not be group/world writable');
      }
    }
    if (expectedOwnerUid !== undefined && before.uid !== BigInt(expectedOwnerUid)) {
      throw new Error(`Backup key must be owned by uid ${expectedOwnerUid} (found ${before.uid})`);
    }
    if (before.size < 32n || before.size > 1024n) throw new Error('Backup key file has an invalid size');
    if (typeof options.beforeRead === 'function') await options.beforeRead(handle);
    const raw = await handle.readFile();
    const after = await handle.stat({bigint: true});
    // Path binding first: an atomic replacement of the key path must be
    // the first signal, before the same-fd before/after consistency check.
    const pathStat = await fsp.lstat(keyFile, {bigint: true});
    if (pathStat.ino !== before.ino || pathStat.dev !== before.dev) {
      throw new Error('Backup key path was replaced while it was being read');
    }
    const sizeStable = before.size === after.size && before.ino === after.ino && before.dev === after.dev;
    const timeStable = process.platform === 'win32' || (before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs);
    if (!sizeStable || !timeStable) {
      throw new Error('Backup key changed while it was being read');
    }
    const ascii = raw.toString('ascii').trim();
    const key = /^[0-9a-fA-F]{64}$/.test(ascii) ? Buffer.from(ascii, 'hex') : raw;
    if (key.length !== 32) throw new Error('Backup key must contain exactly 32 raw bytes or 64 hexadecimal characters');
    return key;
  } finally {
    await handle.close().catch(() => {});
  }
}

function keyId(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function excluded(relativePath, directory) {
  const base = path.basename(relativePath).toLowerCase();
  if (directory) return EXCLUDED_DIRECTORY_NAMES.has(base);
  return EXCLUDED_FILE_NAMES.has(base) || base.endsWith('.log');
}

function statSnapshot(stat) {
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: Number(stat.size),
    mode: typeof stat.mode === 'bigint' ? Number(stat.mode & 0o777n) : Number(stat.mode & 0o777),
    uid: Number(stat.uid),
    gid: Number(stat.gid),
    mtimeNs: typeof stat.mtimeNs === 'bigint' ? stat.mtimeNs.toString() : String(Math.trunc(Number(stat.mtimeMs) * 1e6)),
    ctimeNs: typeof stat.ctimeNs === 'bigint' ? stat.ctimeNs.toString() : String(Math.trunc(Number(stat.ctimeMs) * 1e6)),
    mtimeMs: Number(stat.mtimeMs),
  };
}

async function inspectSourceEntry(absolutePath) {
  return fsp.lstat(absolutePath, {bigint: true});
}

async function walkSource(source) {
  const rootStat = await inspectSourceEntry(source.absolutePath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Source must be a real directory: ${source.absolutePath}`);
  }
  const entries = [];
  const visit = async (absolute, logical) => {
    const stat = await inspectSourceEntry(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Symlinks are forbidden in browser-state backup sources: ${logical}`);
    if (stat.isDirectory()) {
      entries.push({type: 'directory', logical, absolute, ...statSnapshot(stat)});
      const children = await fsp.readdir(absolute, {withFileTypes: true});
      children.sort((a, b) => a.name.localeCompare(b.name, 'en'));
      for (const child of children) {
        const childLogical = `${logical}/${child.name}`.replaceAll('\\', '/');
        if (excluded(child.name, child.isDirectory())) continue;
        await visit(path.join(absolute, child.name), validateLogicalPath(childLogical));
      }
      return;
    }
    if (!stat.isFile()) throw new Error(`Special files are forbidden in browser-state backups: ${logical}`);
    entries.push({type: 'file', logical, absolute, ...statSnapshot(stat)});
  };
  await visit(source.absolutePath, source.logical);
  return entries;
}


const CHROME_EXECUTABLE_RE = /^(?:chrome|chrome\.exe|google-chrome|google-chrome-stable|chromium|chromium-browser|headless_shell|chrome-headless-shell)$/i;
const CHROME_USER_DATA_DIR_FLAG = '--user-data-dir';

function isChromeExecutable(argv0) {
  return CHROME_EXECUTABLE_RE.test(path.basename(String(argv0 || '').replaceAll('\\', '/')));
}

function extractChromeUserDataDir(argv) {
  const prefix = `${CHROME_USER_DATA_DIR_FLAG}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index] || '');
    if (argument.startsWith(prefix)) {
      const value = argument.slice(prefix.length);
      if (value) return value;
    }
    if (argument === CHROME_USER_DATA_DIR_FLAG && argv[index + 1]) return String(argv[index + 1]);
  }
  return '';
}

function statIdentityKey(stat) {
  return `${stat.dev.toString()}:${stat.ino.toString()}`;
}

async function identityChain(candidatePath) {
  const chain = [];
  let current = path.resolve(String(candidatePath || ''));
  for (let depth = 0; depth < 64 && current; depth += 1) {
    try {
      const stat = await fsp.stat(current, {bigint: true});
      chain.push({path: current, key: statIdentityKey(stat)});
    } catch (error) {
      // Missing path segments are fine: the deepest existing ancestor is
      // still compared so a not-yet-created or deleted profile directory
      // cannot bypass the overlap check.  Permission and I/O failures are
      // different: swallowing those would turn an unprovable Chrome path
      // into a false negative.
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
        throw new Error(`Cannot audit Chrome path ${current} (${error?.code || error?.message || error})`);
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return chain;
}

function procProcessVanished(error) {
  return error?.code === 'ENOENT' || error?.code === 'ESRCH';
}

function procAuditBlocker(pid, operation, error) {
  return new Error(
    `Refusing browser-state backup: cannot ${operation} for pid ${pid}; `
    + `source access is unprovable (${error?.code || error?.message || error})`,
  );
}

function pathIsWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function activeBrowserProcessesFromProc(procRoot, sourceRoots, {procFs = fsp} = {}) {
  const sourceKeys = new Set();
  const sourceChains = [];
  for (const root of sourceRoots) {
    let stat;
    try {
      stat = await fsp.stat(root, {bigint: true});
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    sourceKeys.add(statIdentityKey(stat));
    sourceChains.push(await identityChain(root));
  }
  if (!sourceKeys.size) return [];
  let procEntries;
  try {
    procEntries = await procFs.readdir(procRoot, {withFileTypes: true});
  } catch (error) {
    throw new Error(`Refusing browser-state backup: cannot audit ${procRoot} processes (${error?.code || error?.message || error})`);
  }
  const matches = [];
  for (const entry of procEntries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    let command;
    try {
      command = await procFs.readFile(path.join(procRoot, entry.name, 'cmdline'));
    } catch (error) {
      // A vanished process is re-checked by the pre-publish audit.  Any
      // other failure (hidepid, permissions, IO) means we cannot prove the
      // process is not using a source, so the backup must fail closed.
      if (error?.code === 'ENOENT' || error?.code === 'ESRCH') continue;
      throw new Error(`Refusing browser-state backup: cannot read cmdline for pid ${entry.name} (${error?.code || error?.message || error})`);
    }
    const argv = command.toString('utf8').split('\0').filter(Boolean);
    if (!argv.length) continue;
    if (!isChromeExecutable(argv[0])) continue;
    let userDataDir = extractChromeUserDataDir(argv);
    let chain = null;
    if (userDataDir) {
      if (!path.isAbsolute(userDataDir)) {
        let cwd;
        try {
          cwd = await procFs.readlink(path.join(procRoot, entry.name, 'cwd'));
        } catch (error) {
          if (procProcessVanished(error)) continue;
          throw procAuditBlocker(entry.name, 'read cwd', error);
        }
        if (cwd) userDataDir = path.resolve(cwd, userDataDir);
      }
      chain = await identityChain(userDataDir);
    }
    // Identity equality (dev:inode) resolves symlinks and bind mounts, so a
    // process launched through the app bind (/opt/shein-bi/app/profiles) is
    // recognized as using the canonical host source (/data/shein-bi/profiles).
    // Unrelated Chrome roots are not conflicts; a source nested inside a
    // process root is still covered by comparing the deepest existing key.
    const insideSource = chain ? chain.some(item => sourceKeys.has(item.key)) : false;
    const userDataKey = chain?.[0]?.key;
    const sourceNestedInProcess = Boolean(userDataKey) && sourceChains.some(sourceChain =>
      sourceChain.some(item => item.key === userDataKey));
    if (insideSource || sourceNestedInProcess) {
      matches.push({pid: Number(entry.name)});
      continue;
    }
    // A source can also be reached through open descriptors, cwd or mapped
    // files even when --user-data-dir is absent, unrelated or unrecognised.
    const pathAudit = await chromePathTouchesSource(procRoot, entry.name, sourceRoots, {procFs});
    if (pathAudit.vanished) continue;
    if (pathAudit.touches) matches.push({pid: Number(entry.name)});
  }
  return matches;
}

// A single ps-style scan is never treated as a lock: the host/project/domain
// exclusion is owned by run_host_heavy_job.sh, and create re-audits right
// before publication.  This helper closes the residual gap where a Chrome
// process reaches a source through descriptors/cwd/maps rather than the
// --user-data-dir flag.
async function chromePathTouchesSource(procRoot, pid, sourceRoots, {procFs = fsp} = {}) {
  const fdDir = path.join(procRoot, pid, 'fd');
  const cwdLink = path.join(procRoot, pid, 'cwd');
  const mapsPath = path.join(procRoot, pid, 'maps');
  const sourceReal = [];
  for (const root of sourceRoots) {
    try {
      // Keep both the caller's canonical spelling and the filesystem's
      // resolved spelling.  They can differ on case-insensitive filesystems
      // and through symlinks, while either may appear in /proc text.
      sourceReal.push(path.resolve(root), await fsp.realpath(root));
    } catch (error) {
      throw new Error(
        `Refusing browser-state backup: cannot resolve audited source ${root} `
        + `(${error?.code || error?.message || error})`,
      );
    }
  }

  const touchesResolvedPath = value => {
    if (!value || !path.isAbsolute(value)) return false;
    const normalized = path.resolve(value.replace(/ \(deleted\)$/, ''));
    return sourceReal.some(root => pathIsWithin(normalized, root));
  };

  let fdEntries;
  try {
    fdEntries = await procFs.readdir(fdDir);
  } catch (error) {
    // Once cmdline was read, ENOENT/ESRCH has a single explicit meaning: the
    // PID raced away.  The create path performs the full audit again before
    // publication.  EACCES, EPERM and I/O errors are never treated as absence.
    if (procProcessVanished(error)) return {touches: false, vanished: true, channel: 'fd'};
    throw procAuditBlocker(pid, 'read fd directory', error);
  }
  for (const entry of fdEntries) {
    const fdLink = path.join(fdDir, String(entry));
    let rawTarget;
    try {
      rawTarget = await procFs.readlink(fdLink);
    } catch (error) {
      // A descriptor may close between readdir and readlink.  That local race
      // does not hide the remaining descriptors/maps/cwd audit.
      if (error?.code === 'ENOENT') continue;
      if (error?.code === 'ESRCH') return {touches: false, vanished: true, channel: 'fd-link'};
      throw procAuditBlocker(pid, `read fd ${entry}`, error);
    }
    if (touchesResolvedPath(rawTarget)) return {touches: true, vanished: false, channel: 'fd'};
    try {
      if (touchesResolvedPath(await procFs.realpath(fdLink))) {
        return {touches: true, vanished: false, channel: 'fd'};
      }
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      if (error?.code === 'ESRCH') return {touches: false, vanished: true, channel: 'fd-link'};
      throw procAuditBlocker(pid, `resolve fd ${entry}`, error);
    }
  }

  let mapsText;
  try {
    mapsText = await procFs.readFile(mapsPath, 'utf8');
  } catch (error) {
    if (procProcessVanished(error)) return {touches: false, vanished: true, channel: 'maps'};
    throw procAuditBlocker(pid, 'read maps', error);
  }
  const mappedLine = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\/.+)$/;
  for (const line of mapsText.split('\n')) {
    const match = mappedLine.exec(line.trim());
    if (!match) continue;
    const mappedTarget = match[1].replace(/ \(deleted\)$/, '');
    if (touchesResolvedPath(mappedTarget)) return {touches: true, vanished: false, channel: 'maps'};
    try {
      if (touchesResolvedPath(await procFs.realpath(mappedTarget))) {
        return {touches: true, vanished: false, channel: 'maps'};
      }
    } catch (error) {
      // The maps row was successfully read from a live PID, so a target that
      // cannot be resolved is not equivalent to the PID disappearing.
      throw procAuditBlocker(pid, 'resolve maps target', error);
    }
  }

  let cwdTarget;
  try {
    cwdTarget = await procFs.readlink(cwdLink);
  } catch (error) {
    if (procProcessVanished(error)) return {touches: false, vanished: true, channel: 'cwd'};
    throw procAuditBlocker(pid, 'read cwd', error);
  }
  if (touchesResolvedPath(cwdTarget)) return {touches: true, vanished: false, channel: 'cwd'};
  try {
    if (touchesResolvedPath(await procFs.realpath(cwdLink))) {
      return {touches: true, vanished: false, channel: 'cwd'};
    }
  } catch (error) {
    if (procProcessVanished(error)) return {touches: false, vanished: true, channel: 'cwd'};
    throw procAuditBlocker(pid, 'resolve cwd', error);
  }
  return {touches: false, vanished: false};
}

async function activeBrowserProcesses(sourcePaths) {
  if (process.platform !== 'linux') return [];
  return activeBrowserProcessesFromProc('/proc', sourcePaths);
}

async function inventorySources(sources) {
  if (!Array.isArray(sources) || !sources.length) throw new Error('At least one --source is required');
  const seenLogical = new Set();
  const selected = [];
  const skippedOptional = [];
  for (const source of sources) {
    if (seenLogical.has(source.logical)) throw new Error(`Duplicate source logical path: ${source.logical}`);
    seenLogical.add(source.logical);
    let stat;
    try {
      stat = await fsp.lstat(source.absolutePath);
    } catch (error) {
      if (source.optional && error?.code === 'ENOENT') {
        skippedOptional.push(source.logical);
        continue;
      }
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Source must be a real directory: ${source.absolutePath}`);
    selected.push(source);
  }
  if (!selected.length) throw new Error('No backup source exists');
  const active = await activeBrowserProcesses(selected.map(source => source.absolutePath));
  if (active.length) {
    throw new Error(`Refusing browser-state backup while Chrome uses a source (pids=${active.map(row => row.pid).join(',')})`);
  }
  const nested = await Promise.all(selected.map(walkSource));
  const entries = nested.flat();
  entries.sort((a, b) => a.logical.localeCompare(b.logical, 'en'));
  const duplicate = entries.find((entry, index) => index > 0 && entry.logical === entries[index - 1].logical);
  if (duplicate) throw new Error(`Duplicate archive path: ${duplicate.logical}`);
  return {selected, skippedOptional, entries};
}

function frame(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length > MAX_HEADER_BYTES) throw new Error('Archive record header exceeds the safety limit');
  const size = Buffer.allocUnsafe(4);
  size.writeUInt32BE(body.length, 0);
  return Buffer.concat([size, body]);
}

async function writeFileHandleFully(handle, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const {bytesWritten} = await handle.write(buffer, offset, buffer.length - offset, position + offset);
    if (!bytesWritten) throw new Error('Archive output made no write progress');
    offset += bytesWritten;
  }
  return position + offset;
}

async function writeWithBackpressure(stream, buffer) {
  if (stream.write(buffer)) return;
  await once(stream, 'drain');
}


function sameEntrySnapshot(before, after) {
  const snapshot = statSnapshot(after);
  return before.dev === snapshot.dev
    && before.ino === snapshot.ino
    && before.size === snapshot.size
    && before.mode === snapshot.mode
    && before.uid === snapshot.uid
    && before.gid === snapshot.gid
    && before.mtimeNs === snapshot.mtimeNs
    && before.ctimeNs === snapshot.ctimeNs;
}

function sameInventoryEntry(before, after) {
  return before.logical === after.logical
    && before.type === after.type
    && before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mode === after.mode
    && before.uid === after.uid
    && before.gid === after.gid
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}

function sameFileIdentity(left, right) {
  if (!left || !right) return false;
  if (Number(left.ino || 0) > 0 || Number(right.ino || 0) > 0) {
    return Number(left.dev || 0) === Number(right.dev || 0)
      && Number(left.ino || 0) === Number(right.ino || 0);
  }
  return Number(left.birthtimeMs || 0) === Number(right.birthtimeMs || 0)
    && Number(left.size || 0) === Number(right.size || 0);
}

export async function createEncryptedBrowserStateBackup({
  keyFile,
  output,
  sources,
  limits = DEFAULT_LIMITS,
  afterPublish = null,
  diagnostics = null,
}) {
  if (!output) throw new Error('--output is required');
  const key = await readKeyFile(keyFile, keyReadOptions(diagnostics));
  const {selected, skippedOptional, entries} = await inventorySources(sources);
  const activeLimits = {...DEFAULT_LIMITS, ...(limits || {})};
  const totalBytes = entries.filter(entry => entry.type === 'file').reduce((sum, entry) => sum + entry.size, 0);
  if (entries.length > activeLimits.maxEntries) {
    throw new Error(`Backup source exceeds the entry limit (${entries.length} > ${activeLimits.maxEntries})`);
  }
  if (!Number.isSafeInteger(totalBytes) || totalBytes > activeLimits.maxTotalBytes) {
    throw new Error(`Backup source exceeds the total byte limit (${totalBytes} > ${activeLimits.maxTotalBytes})`);
  }
  const oversizedFile = entries.find(entry => entry.type === 'file' && entry.size > activeLimits.maxFileBytes);
  if (oversizedFile) {
    throw new Error(`Backup source file exceeds the size limit (${oversizedFile.size} > ${activeLimits.maxFileBytes}): ${oversizedFile.logical}`);
  }
  const createdAt = new Date().toISOString();
  const iv = crypto.randomBytes(IV_BYTES);
  const outerHeader = {
    format: FORMAT,
    cipher: CIPHER,
    compression: COMPRESSION,
    createdAt,
    keyId: keyId(key),
    iv: iv.toString('base64'),
    entryCount: entries.length,
    totalBytes,
    hostId: await currentHostId(),
  };
  const outerBody = Buffer.from(JSON.stringify(outerHeader), 'utf8');
  const outerSize = Buffer.allocUnsafe(4);
  outerSize.writeUInt32BE(outerBody.length, 0);
  const prefix = Buffer.concat([MAGIC, outerSize, outerBody]);
  const partial = `${output}.partial-${process.pid}-${Date.now()}`;
  await fsp.mkdir(path.dirname(output), {recursive: true, mode: 0o700});
  const handle = await fsp.open(partial, 'wx', 0o600);
  let outputPublished = false;
  let publishedIdentity = null;
  let position = 0;
  const archiveHash = crypto.createHash('sha256');
  const cipher = crypto.createCipheriv(CIPHER, key, iv, {authTagLength: AUTH_TAG_BYTES});
  cipher.setAAD(prefix);
  const compressor = createGzip({level: 6});
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      writeFileHandleFully(handle, chunk, position).then(next => {
        position = next;
        archiveHash.update(chunk);
        callback();
      }, callback);
    },
    final(callback) {
      let tag;
      try {
        tag = cipher.getAuthTag();
        archiveHash.update(tag);
      } catch (error) {
        callback(error);
        return;
      }
      writeFileHandleFully(handle, tag, position).then(next => {
        position = next;
        callback();
      }, callback);
    },
  });
  let sinkPromise = null;

  try {
    position = await writeFileHandleFully(handle, prefix, position);
    archiveHash.update(prefix);
    sinkPromise = pipeline(compressor, cipher, sink);
    await writeWithBackpressure(compressor, frame({
      type: 'archiveStart',
      format: INNER_FORMAT,
      createdAt,
      roots: selected.map(source => source.logical),
      entryCount: entries.length,
      totalBytes,
    }));
    let fileCount = 0;
    let directoryCount = 0;
    const manifestHash = crypto.createHash('sha256');
    for (const entry of entries) {
      const common = {
        path: entry.logical,
        mode: entry.mode,
        uid: entry.uid,
        gid: entry.gid,
        mtimeMs: entry.mtimeMs,
        mtimeNs: entry.mtimeNs,
      };
      if (entry.type === 'directory') {
        directoryCount += 1;
        manifestHash.update(`${entry.logical}\0directory\0${entry.mode}\0${entry.uid}\0${entry.gid}\0${entry.mtimeNs}\n`);
        await writeWithBackpressure(compressor, frame({type: 'directory', ...common}));
        continue;
      }
      fileCount += 1;
      // Inventory metadata alone is not an authorization to reopen a path:
      // bind every read to one O_NOFOLLOW descriptor and prove that descriptor
      // is the inventoried dev:ino before and after streaming.  The terminal
      // lstat then proves the pathname still names that same non-symlink inode.
      if (typeof diagnostics?.beforeSourceFileOpen === 'function') {
        await diagnostics.beforeSourceFileOpen({entry: {...entry}});
      }
      const sourceHandle = await openNoFollow(entry.absolute);
      const hash = crypto.createHash('sha256');
      let copied = 0;
      let afterFd;
      try {
        const beforeFd = await sourceHandle.stat({bigint: true});
        if (!beforeFd.isFile() || !sameEntrySnapshot(entry, beforeFd)) {
          throw new Error(`Source path no longer matches inventory before read: ${entry.logical}`);
        }
        await writeWithBackpressure(compressor, frame({type: 'file', ...common, size: entry.size}));
        const sourceStream = fs.createReadStream('', {
          fd: sourceHandle.fd,
          start: 0,
          end: entry.size > 0 ? entry.size - 1 : 0,
          autoClose: false,
        });
        for await (const chunk of sourceStream) {
          copied += chunk.length;
          hash.update(chunk);
          await writeWithBackpressure(compressor, chunk);
        }
        if (copied !== entry.size) throw new Error(`Source size changed during backup: ${entry.logical}`);
        afterFd = await sourceHandle.stat({bigint: true});
        if (!afterFd.isFile() || !sameEntrySnapshot(entry, afterFd)) {
          throw new Error(`Source inode changed while it was being read: ${entry.logical}`);
        }
      } finally {
        await sourceHandle.close().catch(() => {});
      }
      // Windows does not permit renaming a path while this descriptor is open.
      // Close only after the second fstat has bound the complete read, then
      // require the terminal pathname to resolve to that same non-symlink
      // inventory inode.  The final whole-tree inventory below repeats this
      // binding after every entry has been consumed.
      if (typeof diagnostics?.afterSourceFileRead === 'function') {
        await diagnostics.afterSourceFileRead({entry: {...entry}, fdStat: statSnapshot(afterFd)});
      }
      let pathStat;
      try {
        pathStat = await inspectSourceEntry(entry.absolute);
      } catch (error) {
        throw new Error(`Source path binding unavailable after read: ${entry.logical} (${error?.code || error?.message || error})`);
      }
      if (!pathStat.isFile() || pathStat.isSymbolicLink() || !sameEntrySnapshot(entry, pathStat)) {
        throw new Error(`Source path changed after read: ${entry.logical}`);
      }
      const digest = hash.digest('hex');
      manifestHash.update(`${entry.logical}\0file\0${entry.mode}\0${entry.uid}\0${entry.gid}\0${entry.mtimeNs}\0${entry.size}\0${digest}\n`);
      await writeWithBackpressure(compressor, frame({type: 'fileEnd', path: entry.logical, sha256: digest}));
    }
    const finalInventory = await Promise.all(selected.map(walkSource));
    const finalEntries = finalInventory.flat().sort((a, b) => a.logical.localeCompare(b.logical, 'en'));
    if (finalEntries.length !== entries.length || finalEntries.some((entry, index) => !sameInventoryEntry(entries[index], entry))) {
      throw new Error('Backup source inventory changed during capture');
    }
    const manifestSha256 = manifestHash.digest('hex');
    await writeWithBackpressure(compressor, frame({
      type: 'archiveEnd',
      entryCount: entries.length,
      fileCount,
      directoryCount,
      totalBytes,
      manifestSha256,
    }));
    compressor.end();
    await sinkPromise;
    await handle.sync();
    await handle.close();
    const ciphertextLength = position - prefix.length - AUTH_TAG_BYTES;
    if (ciphertextLength <= 0 || (totalBytes > 0 && totalBytes / ciphertextLength > activeLimits.maxCompressionRatio)) {
      throw new Error(`Backup source exceeds the compression ratio limit (${totalBytes} bytes plaintext from ${ciphertextLength} ciphertext bytes)`);
    }
    if (process.platform !== 'win32') await fsp.chmod(partial, 0o600);
    const archiveSha256 = archiveHash.digest('hex');
    // A second, pre-publish process audit catches a Chrome instance started
    // after the initial inventory scan.  The authoritative exclusion remains
    // the outer host/project/domain lock held by run_host_heavy_job.sh; this
    // audit is the in-script fail-closed backstop before the atomic publish.
    const auditActive = typeof diagnostics?.activeBrowserProcesses === 'function'
      ? diagnostics.activeBrowserProcesses : activeBrowserProcesses;
    const activeAfter = await auditActive(selected.map(source => source.absolutePath));
    if (activeAfter.length) {
      throw new Error(`Chrome started using a backup source after capture (pids=${activeAfter.map(row => row.pid).join(',')})`);
    }
    await fsp.link(partial, output);
    outputPublished = true;
    publishedIdentity = await fsp.lstat(output);
    if (typeof afterPublish === 'function') await afterPublish({output, partial});
    await fsp.unlink(partial);
    return {
      ok: true,
      action: 'create',
      format: FORMAT,
      output,
      createdAt,
      keyId: outerHeader.keyId,
      entryCount: entries.length,
      fileCount,
      directoryCount,
      totalBytes,
      manifestSha256,
      archiveSha256,
      includedRoots: selected.map(source => source.logical),
      skippedOptionalRoots: skippedOptional,
    };
  } catch (error) {
    compressor.destroy();
    cipher.destroy();
    if (sinkPromise) await sinkPromise.catch(() => {});
    await handle.close().catch(() => {});
    if (outputPublished) {
      const [outputStat, partialStat] = await Promise.all([
        fsp.lstat(output).catch(() => null),
        fsp.lstat(partial).catch(() => null),
      ]);
      if (outputStat && (sameFileIdentity(outputStat, partialStat) || sameFileIdentity(outputStat, publishedIdentity))) {
        await fsp.rm(output, {force: true}).catch(cleanupError => {
          error.message = `${error.message}; failed to remove the incompletely published archive: ${cleanupError.message}`;
        });
      }
    }
    await fsp.rm(partial, {force: true}).catch(() => {});
    throw error;
  }
}

async function openArchiveBound(archive) {
  const lstat = await fsp.lstat(archive, {bigint: true});
  if (!lstat.isFile() || lstat.isSymbolicLink()) throw new Error('Archive must be a regular non-symlink file');
  const handle = await openNoFollow(archive);
  try {
    const stat = await handle.stat({bigint: true});
    if (!stat.isFile()) throw new Error('Archive must be a regular file');
    if (stat.ino !== lstat.ino || stat.dev !== lstat.dev) {
      throw new Error('Archive path was replaced before it was opened');
    }
    return {handle, stat};
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

// Forward only the authenticated ciphertext range to the decipher while
// hashing every byte of the archive.  The envelope, decryption authentication
// and the full-file SHA-256 therefore all bind to the same O_NOFOLLOW fd.
class CiphertextRangeTransform extends Transform {
  constructor(start, end, hash) {
    super();
    // 'end' is the readable/writable stream method here, so the range
    // boundary must not shadow it.
    this.rangeStart = start;
    this.rangeEnd = end;
    this.pos = 0;
    this.hash = hash;
  }
  _transform(chunk, _encoding, callback) {
    this.hash.update(chunk);
    const begin = this.pos;
    const finish = this.pos + chunk.length;
    this.pos = finish;
    if (finish <= this.rangeStart || begin > this.rangeEnd) { callback(); return; }
    const overlapStart = Math.max(begin, this.rangeStart);
    const overlapEnd = Math.min(finish - 1, this.rangeEnd);
    if (overlapStart <= overlapEnd) {
      this.push(chunk.subarray(overlapStart - begin, overlapEnd - begin + 1));
    }
    callback();
  }
}

async function readArchiveEnvelopeFromHandle(handle, stat, key) {
  const size = Number(stat.size);
  if (size < MAGIC.length + 4 + AUTH_TAG_BYTES + 2) throw new Error('Encrypted archive is truncated');
  const prefixStart = Buffer.alloc(MAGIC.length + 4);
  const firstRead = await handle.read(prefixStart, 0, prefixStart.length, 0);
  if (firstRead.bytesRead !== prefixStart.length || !prefixStart.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Encrypted archive magic does not match');
  }
  const headerLength = prefixStart.readUInt32BE(MAGIC.length);
  if (headerLength < 2 || headerLength > MAX_HEADER_BYTES) throw new Error('Encrypted archive header length is invalid');
  const body = Buffer.alloc(headerLength);
  const headerRead = await handle.read(body, 0, body.length, prefixStart.length);
  if (headerRead.bytesRead !== body.length) throw new Error('Encrypted archive header is truncated');
  let header;
  try {
    header = JSON.parse(body.toString('utf8'));
  } catch {
    throw new Error('Encrypted archive header is invalid JSON');
  }
  if (header?.format !== FORMAT || header?.cipher !== CIPHER || header?.compression !== COMPRESSION) {
    throw new Error('Encrypted archive format is unsupported');
  }
  if (header?.keyId !== keyId(key)) throw new Error('Backup key does not match archive key id');
  validateHostId(header?.hostId);
  const iv = Buffer.from(String(header.iv || ''), 'base64');
  if (iv.length !== IV_BYTES) throw new Error('Encrypted archive IV is invalid');
  const prefix = Buffer.concat([prefixStart, body]);
  const ciphertextStart = prefix.length;
  const ciphertextEnd = size - AUTH_TAG_BYTES - 1;
  if (ciphertextEnd < ciphertextStart) throw new Error('Encrypted archive has no ciphertext');
  const tag = Buffer.alloc(AUTH_TAG_BYTES);
  const tagRead = await handle.read(tag, 0, tag.length, size - AUTH_TAG_BYTES);
  if (tagRead.bytesRead !== tag.length) throw new Error('Encrypted archive authentication tag is truncated');
  return {header, prefix, iv, tag, ciphertextStart, ciphertextEnd};
}

class AsyncByteReader {
  constructor(readable, options = {}) {
    this.iterator = readable[Symbol.asyncIterator]();
    this.chunk = Buffer.alloc(0);
    this.offset = 0;
    this.done = false;
    this.bytesRead = 0;
    this.maxPlaintextBytes = Number(options.maxPlaintextBytes) || 0;
  }

  async nextChunk() {
    while (this.offset >= this.chunk.length && !this.done) {
      const next = await this.iterator.next();
      this.done = Boolean(next.done);
      this.chunk = next.done ? Buffer.alloc(0) : Buffer.from(next.value);
      this.offset = 0;
      this.bytesRead += this.chunk.length;
      if (this.maxPlaintextBytes > 0 && this.bytesRead > this.maxPlaintextBytes) {
        throw new Error(`Encrypted archive plaintext exceeds the compression bound (${this.bytesRead} bytes)`);
      }
    }
    return !this.done || this.offset < this.chunk.length;
  }

  async readExactly(size) {
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_HEADER_BYTES) throw new Error('Unsafe framed read length');
    const pieces = [];
    let remaining = size;
    while (remaining > 0) {
      if (!await this.nextChunk()) throw new Error('Encrypted archive plaintext is truncated');
      const count = Math.min(remaining, this.chunk.length - this.offset);
      pieces.push(this.chunk.subarray(this.offset, this.offset + count));
      this.offset += count;
      remaining -= count;
    }
    return pieces.length === 1 ? pieces[0] : Buffer.concat(pieces, size);
  }

  async consume(size, consumer) {
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Unsafe file payload length');
    let remaining = size;
    while (remaining > 0) {
      if (!await this.nextChunk()) throw new Error('Encrypted archive file payload is truncated');
      const count = Math.min(remaining, this.chunk.length - this.offset);
      const piece = this.chunk.subarray(this.offset, this.offset + count);
      await consumer(piece);
      this.offset += count;
      remaining -= count;
    }
  }

  async frame() {
    const sizeBuffer = await this.readExactly(4);
    const size = sizeBuffer.readUInt32BE(0);
    if (size < 2 || size > MAX_HEADER_BYTES) throw new Error('Encrypted archive record length is invalid');
    let value;
    try {
      value = JSON.parse((await this.readExactly(size)).toString('utf8'));
    } catch {
      throw new Error('Encrypted archive record is invalid JSON');
    }
    return value;
  }

  async assertEof() {
    if (this.offset < this.chunk.length || await this.nextChunk()) throw new Error('Encrypted archive has trailing plaintext records');
  }
}

function safeDestinationPath(destination, logical) {
  const validated = validateLogicalPath(logical, 'archive path');
  const resolved = path.resolve(destination, ...validated.split('/'));
  const rootPrefix = `${path.resolve(destination)}${path.sep}`;
  if (!resolved.startsWith(rootPrefix)) throw new Error(`Archive path escapes destination: ${logical}`);
  return resolved;
}

function validateRecordMode(mode) {
  const value = Number(mode);
  if (!Number.isInteger(value) || value < 0 || value > 0o777) throw new Error('Archive record mode is invalid');
  return value;
}

export function validateRecordIdentity(value, label) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > 0xffff_fffe) {
    throw new Error(`Archive record ${label} is invalid`);
  }
  return numeric;
}

export async function restoreRecordIdentity(target, uid, gid, operations = {}) {
  const platform = operations.platform || process.platform;
  if (platform === 'win32') return;
  const lstat = operations.lstat || (value => fsp.lstat(value));
  const chown = operations.chown || ((value, owner, group) => fsp.chown(value, owner, group));
  const current = await lstat(target);
  if (Number(current.uid) !== uid || Number(current.gid) !== gid) await chown(target, uid, gid);
  const readback = await lstat(target);
  if (Number(readback.uid) !== uid || Number(readback.gid) !== gid) {
    throw new Error(`Restored identity readback mismatch: ${target}`);
  }
}

function validateRecordMtime(mtimeMs) {
  const value = Number(mtimeMs);
  if (!Number.isFinite(value) || value < 0) throw new Error('Archive record mtime is invalid');
  return value;
}

function validateRecordMtimeNs(mtimeNs) {
  const value = String(mtimeNs || '');
  if (!/^\d{1,30}$/.test(value)) throw new Error('Archive record mtimeNs is invalid');
  return value;
}

function validateEnvelopeLimits(header, limits, ciphertextLength) {
  const declaredEntries = Number(header?.entryCount);
  const declaredTotal = Number(header?.totalBytes);
  if (!Number.isSafeInteger(declaredEntries) || declaredEntries < 0) throw new Error('Encrypted archive declares an invalid entry count');
  if (!Number.isSafeInteger(declaredTotal) || declaredTotal < 0) throw new Error('Encrypted archive declares invalid total bytes');
  if (declaredEntries > limits.maxEntries) throw new Error(`Encrypted archive declares too many entries (${declaredEntries} > ${limits.maxEntries})`);
  if (declaredTotal > limits.maxTotalBytes) throw new Error(`Encrypted archive declares too many total bytes (${declaredTotal} > ${limits.maxTotalBytes})`);
  if (ciphertextLength > 0 && declaredTotal / ciphertextLength > limits.maxCompressionRatio) {
    throw new Error(`Encrypted archive declares an unsafe compression ratio (${declaredTotal} bytes plaintext from ${ciphertextLength} ciphertext bytes)`);
  }
}


// Pure capacity decision so the byte/block/inode budgets can be tested
// deterministically with synthetic statfs values.
export function checkRestoreCapacity(statfs, requiredBytes, entryCount, limits) {
  const active = {...DEFAULT_LIMITS, ...(limits || {})};
  const bsize = Number(statfs.bsize) || 4096;
  const availBytes = Number(statfs.bavail) * bsize;
  const needed = requiredBytes + active.freeMarginBytes;
  if (!Number.isSafeInteger(needed) || needed > availBytes) {
    throw new Error(`Insufficient free space for restore: need ${needed} bytes, available ${availBytes}`);
  }
  const availBlocks = Number(statfs.bavail);
  const neededBlocks = Math.ceil(needed / bsize);
  if (neededBlocks > availBlocks) {
    throw new Error(`Insufficient free blocks for restore: need ${neededBlocks} blocks, available ${availBlocks}`);
  }
  const availInodes = Number(statfs.favail);
  const neededInodes = entryCount + 16;
  if (availInodes >= 0 && neededInodes > availInodes) {
    throw new Error(`Insufficient free inodes for restore: need ${neededInodes} inodes, available ${availInodes}`);
  }
  return {needed, availableBytes: availBytes, neededBlocks, availBlocks, neededInodes, availInodes};
}

async function ensureRestoreDiskSpace(destination, requiredBytes, entryCount, limits) {
  const parent = path.dirname(path.resolve(destination));
  let statfs;
  try {
    statfs = await fsp.statfs(parent);
  } catch (error) {
    throw new Error(`Cannot determine free space before restore (${error?.code || error?.message || error})`);
  }
  return checkRestoreCapacity(statfs, requiredBytes, entryCount, limits);
}

async function processArchive({archive, keyFile, destination = '', limits = DEFAULT_LIMITS, identityMapper = null, diagnostics = null}) {
  const key = await readKeyFile(keyFile, keyReadOptions(diagnostics));
  const {handle, stat} = await openArchiveBound(archive);
  try {
    const envelope = await readArchiveEnvelopeFromHandle(handle, stat, key);
    const activeLimits = {...DEFAULT_LIMITS, ...(limits || {})};
    const ciphertextLength = envelope.ciphertextEnd - envelope.ciphertextStart + 1;
    validateEnvelopeLimits(envelope.header, activeLimits, ciphertextLength);
    const decipher = crypto.createDecipheriv(CIPHER, key, envelope.iv, {authTagLength: AUTH_TAG_BYTES});
    decipher.setAAD(envelope.prefix);
    decipher.setAuthTag(envelope.tag);
    const fullHash = crypto.createHash('sha256');
    const sourceStream = fs.createReadStream('', {
      fd: handle.fd,
      start: 0,
      end: Number(stat.size) - 1,
      autoClose: false,
    });
    const forwarder = new CiphertextRangeTransform(envelope.ciphertextStart, envelope.ciphertextEnd, fullHash);
    const plaintext = createGunzip();
    // Convert the pipeline rejection into a value immediately so an
    // authentication failure can never surface as an unhandled stream error
    // while the framed reader is still consuming plaintext.
    const decryptResult = pipeline(sourceStream, forwarder, decipher, plaintext).then(() => null, error => error);
    // Keep a streaming backstop so a highly compressed archive can never
    // materialize more plaintext than the configured bound while records are
    // still being read; the record-level guards cover the declared totals.
    const reader = new AsyncByteReader(plaintext, {
      maxPlaintextBytes: Math.min(activeLimits.maxTotalBytes, ciphertextLength * activeLimits.maxCompressionRatio) + STREAM_OVERHEAD_SLACK,
    });
    try {
      const start = await reader.frame();
      if (start?.type !== 'archiveStart' || start?.format !== INNER_FORMAT) throw new Error('Encrypted archive inner format is unsupported');
      const roots = Array.isArray(start.roots) ? start.roots.map(root => validateLogicalPath(root, 'archive root')) : [];
      if (!roots.length || new Set(roots).size !== roots.length) throw new Error('Encrypted archive roots are invalid');
      const seen = new Set();
      const directoryMtimes = [];
      const manifestHash = crypto.createHash('sha256');
      const identityPairs = new Set();
      let entryCount = 0;
      let fileCount = 0;
      let directoryCount = 0;
      let totalBytes = 0;
      let previousPath = '';
      let end;
      while (true) {
        const record = await reader.frame();
        if (record?.type === 'archiveEnd') { end = record; break; }
        if (!['directory', 'file'].includes(record?.type)) throw new Error(`Unexpected archive record type: ${record?.type || 'missing'}`);
        const logical = validateLogicalPath(record.path, 'archive entry path');
        if (!roots.some(root => logical === root || logical.startsWith(`${root}/`))) {
          throw new Error(`Archive entry is outside declared roots: ${logical}`);
        }
        if (seen.has(logical) || (previousPath && logical.localeCompare(previousPath, 'en') <= 0)) {
          throw new Error(`Archive entries are duplicate or unsorted: ${logical}`);
        }
        seen.add(logical);
        previousPath = logical;
        entryCount += 1;
        if (entryCount > activeLimits.maxEntries) throw new Error(`Encrypted archive exceeds the entry limit (${entryCount} > ${activeLimits.maxEntries})`);
        const mode = validateRecordMode(record.mode);
        const recordUid = validateRecordIdentity(record.uid, 'uid');
        const recordGid = validateRecordIdentity(record.gid, 'gid');
        identityPairs.add(`${recordUid}:${recordGid}`);
        const mtimeMs = validateRecordMtime(record.mtimeMs);
        const mtimeNs = validateRecordMtimeNs(record.mtimeNs);
        let uid = recordUid;
        let gid = recordGid;
        if (identityMapper) {
          const mapped = identityMapper(`${recordUid}:${recordGid}`);
          if (!mapped) throw new Error(`Archive identity ${recordUid}:${recordGid} has no mapping`);
          uid = validateRecordIdentity(mapped[0], 'mapped uid');
          gid = validateRecordIdentity(mapped[1], 'mapped gid');
        }
        const target = destination ? safeDestinationPath(destination, logical) : '';
        if (record.type === 'directory') {
          directoryCount += 1;
          manifestHash.update(`${logical}\0directory\0${mode}\0${recordUid}\0${recordGid}\0${mtimeNs}\n`);
          if (destination) {
            await fsp.mkdir(target, {recursive: true, mode: 0o700});
            directoryMtimes.push({target, mtimeMs, mode, uid, gid});
          }
          continue;
        }
        const size = Number(record.size);
        if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Archive file size is invalid: ${logical}`);
        if (size > activeLimits.maxFileBytes) throw new Error(`Encrypted archive file exceeds the size limit (${size} > ${activeLimits.maxFileBytes}): ${logical}`);
        fileCount += 1;
        totalBytes += size;
        if (totalBytes > activeLimits.maxTotalBytes) throw new Error(`Encrypted archive exceeds the total byte limit (${totalBytes} > ${activeLimits.maxTotalBytes})`);
        const hash = crypto.createHash('sha256');
        let targetHandle = null;
        let targetPosition = 0;
        if (destination) targetHandle = await fsp.open(target, 'wx', 0o600);
        try {
          await reader.consume(size, async chunk => {
            hash.update(chunk);
            if (targetHandle) targetPosition = await writeFileHandleFully(targetHandle, chunk, targetPosition);
          });
          if (targetHandle) await targetHandle.sync();
        } finally {
          if (targetHandle) await targetHandle.close().catch(() => {});
        }
        const fileEnd = await reader.frame();
        const digest = hash.digest('hex');
        if (fileEnd?.type !== 'fileEnd' || fileEnd.path !== logical || fileEnd.sha256 !== digest) {
          throw new Error(`Archive file digest mismatch: ${logical}`);
        }
        manifestHash.update(`${logical}\0file\0${mode}\0${recordUid}\0${recordGid}\0${mtimeNs}\0${size}\0${digest}\n`);
        if (destination) {
          await restoreRecordIdentity(target, uid, gid);
          if (process.platform !== 'win32') await fsp.chmod(target, mode);
          const timestamp = new Date(mtimeMs);
          await fsp.utimes(target, timestamp, timestamp);
        }
      }
      await reader.assertEof();
      const decryptError = await decryptResult;
      if (decryptError) throw decryptError;
      if (ciphertextLength > 0 && totalBytes / ciphertextLength > activeLimits.maxCompressionRatio) {
        throw new Error(`Encrypted archive compression ratio exceeds the safety limit (${totalBytes} bytes plaintext from ${ciphertextLength} ciphertext bytes)`);
      }
      const manifestSha256 = manifestHash.digest('hex');
      const expected = {
        entryCount: Number(end?.entryCount),
        fileCount: Number(end?.fileCount),
        directoryCount: Number(end?.directoryCount),
        totalBytes: Number(end?.totalBytes),
      };
      const actual = {entryCount, fileCount, directoryCount, totalBytes};
      for (const [name, value] of Object.entries(actual)) {
        if (!Number.isSafeInteger(expected[name]) || expected[name] !== value) throw new Error(`Archive ${name} summary mismatch`);
      }
      if (end?.manifestSha256 !== manifestSha256) throw new Error('Archive manifest digest mismatch');
      if (Number(start.entryCount) !== entryCount || Number(start.totalBytes) !== totalBytes) {
        throw new Error('Archive start/end summaries do not match');
      }
      if (Number(envelope.header.entryCount) !== entryCount || Number(envelope.header.totalBytes) !== totalBytes) {
        throw new Error('Encrypted envelope and archive summaries do not match');
      }
      if (destination) {
        for (const entry of directoryMtimes.reverse()) {
          await restoreRecordIdentity(entry.target, entry.uid, entry.gid);
          if (process.platform !== 'win32') await fsp.chmod(entry.target, entry.mode);
          const timestamp = new Date(entry.mtimeMs);
          await fsp.utimes(entry.target, timestamp, timestamp);
        }
      }
      // Test seam: let a harness swap the path before the terminal binding
      // checks so an atomic replacement during verification is proven to fail.
      if (typeof diagnostics?.afterAuthCheck === 'function') {
        await diagnostics.afterAuthCheck({archive, fdStat: stat});
      }
      const finalStat = await handle.stat({bigint: true});
      const sizeStable = finalStat.ino === stat.ino && finalStat.dev === stat.dev && finalStat.size === stat.size;
      const timeStable = process.platform === 'win32' || (finalStat.mtimeNs === stat.mtimeNs && finalStat.ctimeNs === stat.ctimeNs);
      if (!sizeStable || !timeStable) {
        throw new Error('Archive changed while it was being verified');
      }
      const pathStat = await fsp.lstat(archive, {bigint: true});
      if (pathStat.ino !== stat.ino || pathStat.dev !== stat.dev) {
        throw new Error('Archive path was replaced during verification');
      }
      return {
        ok: true,
        format: FORMAT,
        archive,
        createdAt: envelope.header.createdAt,
        keyId: envelope.header.keyId,
        hostId: envelope.header.hostId,
        roots,
        ...actual,
        identityPairs: [...identityPairs],
        manifestSha256,
        archiveSha256: fullHash.digest('hex'),
      };
    } catch (error) {
      // Stop every stream and await the already-handled pipeline promise so a
      // large or corrupt archive cannot keep decrypting in the background.
      sourceStream.destroy();
      forwarder.destroy();
      decipher.destroy();
      plaintext.destroy();
      await decryptResult;
      throw error;
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

export async function verifyEncryptedBrowserStateBackup({archive, keyFile, limits, diagnostics = null}) {
  if (!archive) throw new Error('--archive is required');
  return {action: 'verify', ...await processArchive({archive, keyFile, limits, diagnostics})};
}

function identityComponent(value, label) {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new Error(`${label} is invalid`);
    return value.toString();
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
    return String(value);
  }
  const text = String(value ?? '');
  if (!/^\d+$/.test(text)) throw new Error(`${label} is invalid`);
  return BigInt(text).toString();
}

function restoreDirectoryIdentity(stat, label = 'directory identity') {
  if (!stat) throw new Error(`${label} is unavailable`);
  return {
    dev: identityComponent(stat.dev, `${label} dev`),
    ino: identityComponent(stat.ino, `${label} ino`),
  };
}

function sameRestoreDirectoryIdentity(stat, expected) {
  if (!stat || !expected) return false;
  try {
    const actual = restoreDirectoryIdentity(stat);
    return actual.dev === identityComponent(expected.dev, 'expected directory dev')
      && actual.ino === identityComponent(expected.ino, 'expected directory ino');
  } catch {
    return false;
  }
}

function currentEffectiveUid() {
  if (process.platform !== 'linux' || typeof process.geteuid !== 'function') {
    throw new Error('Atomic restore publication requires Linux process.geteuid support');
  }
  return process.geteuid();
}

export function validateRestorePublicationParent(stat, {platform = process.platform, euid} = {}) {
  if (platform !== 'linux') {
    throw new Error(
      `Atomic no-replace restore publication is supported only on Linux (current platform: ${platform}); `
      + 'no ordinary rename fallback is permitted',
    );
  }
  if (!stat || typeof stat.isDirectory !== 'function' || typeof stat.isSymbolicLink !== 'function'
      || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Restore destination parent must be a real non-symlink directory');
  }
  const effectiveUid = euid === undefined ? currentEffectiveUid() : Number(euid);
  if (!Number.isSafeInteger(effectiveUid) || effectiveUid < 0) {
    throw new Error('Restore destination parent validation requires a valid effective uid');
  }
  const owner = BigInt(stat.uid);
  if (owner !== 0n && owner !== BigInt(effectiveUid)) {
    throw new Error(`Restore destination parent must be owned by euid ${effectiveUid} or root (found uid ${owner})`);
  }
  const mode = BigInt(stat.mode);
  if ((mode & 0o22n) !== 0n) {
    throw new Error(`Restore destination parent must not be group/world writable (mode=${(mode & 0o777n).toString(8)})`);
  }
  return {
    ...restoreDirectoryIdentity(stat, 'restore destination parent'),
    uid: owner.toString(),
    mode: Number(mode & 0o777n),
  };
}

function validateOwnedRestoreStaging(stat, parentIdentity, euid = currentEffectiveUid()) {
  if (!stat || typeof stat.isDirectory !== 'function' || typeof stat.isSymbolicLink !== 'function'
      || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Restore staging path must remain a real non-symlink directory');
  }
  if (BigInt(stat.uid) !== BigInt(euid)) {
    throw new Error(`Restore staging directory must remain owned by euid ${euid}`);
  }
  const mode = BigInt(stat.mode);
  if ((mode & 0o22n) !== 0n) {
    throw new Error('Restore staging directory must not be group/world writable');
  }
  const identity = restoreDirectoryIdentity(stat, 'restore staging directory');
  if (identity.dev !== identityComponent(parentIdentity.dev, 'restore parent dev')) {
    throw new Error('Restore staging directory must be on the destination parent filesystem');
  }
  return identity;
}

export function classifyRestorePublicationPaths({
  stagingStat = null,
  destinationStat = null,
  expectedStaging,
} = {}) {
  const ownedStaging = sameRestoreDirectoryIdentity(stagingStat, expectedStaging);
  const publishedDestination = sameRestoreDirectoryIdentity(destinationStat, expectedStaging);
  const stagingPathReplaced = Boolean(stagingStat) && !ownedStaging;
  const competingDestination = Boolean(destinationStat) && !publishedDestination;
  const manualInspectionRequired = publishedDestination
    || stagingPathReplaced
    || !ownedStaging;
  return {
    ownedStaging,
    publishedDestination,
    stagingPathReplaced,
    competingDestination,
    manualInspectionRequired,
  };
}

async function validateAtomicRestorePublicationRuntime() {
  if (process.platform !== 'linux') {
    throw new Error(
      `Atomic no-replace restore publication is supported only on Linux (current platform: ${process.platform}); `
      + 'no ordinary rename fallback is permitted',
    );
  }
  if (!Number.isInteger(fs.constants.O_DIRECTORY) || !Number.isInteger(fs.constants.O_NOFOLLOW)
      || fs.constants.O_NOFOLLOW === 0) {
    throw new Error('Atomic restore publication requires O_DIRECTORY and O_NOFOLLOW support from Node on Linux');
  }
  try {
    await fsp.access(LINUX_PYTHON3, fs.constants.X_OK);
  } catch (error) {
    throw new Error(
      `Atomic restore publication requires executable ${LINUX_PYTHON3} (${error?.code || error?.message || error}); `
      + 'install Python 3 at that path; no rename fallback was attempted',
    );
  }
  let helperStat;
  try {
    helperStat = await fsp.lstat(LINUX_RENAME_NOREPLACE_HELPER);
  } catch (error) {
    throw new Error(
      `Atomic restore publication helper is unavailable at ${LINUX_RENAME_NOREPLACE_HELPER} `
      + `(${error?.code || error?.message || error}); no rename fallback was attempted`,
    );
  }
  if (!helperStat.isFile() || helperStat.isSymbolicLink()) {
    throw new Error('Atomic restore publication helper must be a regular non-symlink file; no rename fallback was attempted');
  }
}

async function assertRestoreParentBinding(binding, label) {
  const [pathStat, descriptorStat] = await Promise.all([
    fsp.lstat(binding.parent, {bigint: true}),
    binding.handle.stat({bigint: true}),
  ]);
  const pathIdentity = validateRestorePublicationParent(pathStat);
  const descriptorIdentity = validateRestorePublicationParent(descriptorStat);
  if (!sameRestoreDirectoryIdentity(pathIdentity, binding.identity)
      || !sameRestoreDirectoryIdentity(descriptorIdentity, binding.identity)) {
    throw new Error(`Restore destination parent dev:ino changed ${label}`);
  }
}

async function openRestoreParentBinding(destination) {
  await validateAtomicRestorePublicationRuntime();
  const parent = path.dirname(destination);
  const parentPathStat = await fsp.lstat(parent, {bigint: true});
  const identity = validateRestorePublicationParent(parentPathStat);
  const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  let handle;
  try {
    handle = await fsp.open(parent, flags);
  } catch (error) {
    throw new Error(
      `Cannot open restore destination parent without following links (${error?.code || error?.message || error})`,
    );
  }
  const binding = {parent, handle, identity};
  try {
    await assertRestoreParentBinding(binding, 'while it was opened');
    return binding;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

function boundedChildOutput(chunks) {
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function invokeLinuxRenameNoReplace({parent, source, destination, parentIdentity, stagingIdentity}) {
  const args = [
    '-I', '-S', '-B', LINUX_RENAME_NOREPLACE_HELPER,
    '--parent', parent,
    '--source', source,
    '--destination', destination,
    '--expected-parent-dev', parentIdentity.dev,
    '--expected-parent-ino', parentIdentity.ino,
    '--expected-staging-dev', stagingIdentity.dev,
    '--expected-staging-ino', stagingIdentity.ino,
  ];
  return new Promise(resolve => {
    const child = spawn(LINUX_PYTHON3, args, {
      cwd: path.dirname(LINUX_RENAME_NOREPLACE_HELPER),
      env: {
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        PATH: '/usr/bin:/bin',
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONIOENCODING: 'utf-8',
        PYTHONNOUSERSITE: '1',
      },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let outputOverflow = false;
    let spawnError = null;
    const collect = target => chunk => {
      outputBytes += chunk.length;
      if (outputBytes > PUBLICATION_HELPER_OUTPUT_LIMIT) {
        outputOverflow = true;
        child.kill('SIGKILL');
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', error => { spawnError = error; });
    child.once('close', (exitCode, signal) => {
      resolve({
        exitCode,
        signal,
        spawnError,
        outputOverflow,
        stdout: boundedChildOutput(stdout),
        stderr: boundedChildOutput(stderr),
      });
    });
  });
}

function publicationFailure(message, fields = {}) {
  return Object.assign(new Error(message), fields);
}

async function publishRestoreStagingNoReplace(binding, staging, destination, stagingIdentity) {
  await assertRestoreParentBinding(binding, 'immediately before atomic publication');
  const currentStaging = await fsp.lstat(staging, {bigint: true});
  validateOwnedRestoreStaging(currentStaging, binding.identity);
  if (!sameRestoreDirectoryIdentity(currentStaging, stagingIdentity)) {
    throw new Error('Restore staging dev:ino changed before atomic publication');
  }
  const invocation = await invokeLinuxRenameNoReplace({
    parent: binding.parent,
    source: path.basename(staging),
    destination: path.basename(destination),
    parentIdentity: binding.identity,
    stagingIdentity,
  });
  if (invocation.spawnError) {
    throw publicationFailure(
      `Atomic restore publication helper could not start (${invocation.spawnError.code || invocation.spawnError.message}); `
      + `verify ${LINUX_PYTHON3} and ${LINUX_RENAME_NOREPLACE_HELPER}; no rename fallback was attempted`,
    );
  }
  if (invocation.outputOverflow) {
    throw publicationFailure(
      'Atomic restore publication helper exceeded its output limit; publication outcome is uncertain and requires manual inspection',
    );
  }
 let result;
 try {
   result = JSON.parse(invocation.stdout);
 } catch {
   const detail = invocation.stderr ? `; helper stderr: ${invocation.stderr.slice(0, 2000)}` : '';
   throw publicationFailure(
     `Atomic restore publication helper returned no valid result (exit=${invocation.exitCode}, signal=${invocation.signal || 'none'})${detail}; `
     + 'publication outcome is uncertain and requires manual inspection',
   );
 }
  const reportedPublished = result?.publicationSucceeded === true;
  if (result?.ok !== true || invocation.exitCode !== 0 || invocation.signal) {
    if (!reportedPublished && ['EEXIST', 'ENOTEMPTY'].includes(result?.errorCode)) {
      throw publicationFailure(
        'Restore destination appeared during atomic publication; RENAME_NOREPLACE left it untouched',
        {publicationSucceeded: false},
      );
    }
    if (reportedPublished && result?.fsync && result.fsync !== 'ok') {
      throw publicationFailure(
        `Atomic restore publication renamed the staging directory but the parent directory fsync `
        + `did not confirm durability (${result.fsync}); the destination is published with `
        + 'unconfirmed durability and manual inspection is required',
        {publicationSucceeded: true},
      );
    }
    throw publicationFailure(
      `Atomic restore publication failed: ${result?.error || `helper exit ${invocation.exitCode}`}; `
      + (reportedPublished
        ? 'publication succeeded but terminal helper readback failed; manual inspection is required'
        : 'no rename fallback was attempted'),
      {
        publicationSucceeded: reportedPublished,
      },
    );
  }
  if (result.method !== 'renameat2(RENAME_NOREPLACE)'
      || !sameRestoreDirectoryIdentity(result.parent, binding.identity)
      || !sameRestoreDirectoryIdentity(result.destination, stagingIdentity)) {
    throw publicationFailure(
      'Atomic restore publication helper returned an invalid terminal readback; manual inspection is required',
      {publicationSucceeded: true},
    );
  }
  if (result.fsync !== 'ok') {
    // Defense in depth: a helper that still reports ok must not let a
    // non-ok parent fsync count as a durable restore.
    throw publicationFailure(
      `Atomic restore publication did not confirm parent directory durability (fsync=${result.fsync}); `
      + 'the destination is published with unconfirmed durability and manual inspection is required',
      {publicationSucceeded: true},
    );
  }
  return result;
}

async function observeRestorePath(target) {
  try {
    return {stat: await fsp.lstat(target, {bigint: true}), error: null};
  } catch (error) {
    if (error?.code === 'ENOENT') return {stat: null, error: null};
    return {stat: null, error};
  }
}

async function terminalRestorePublicationReadback(binding, staging, destination, stagingIdentity) {
  await assertRestoreParentBinding(binding, 'during terminal publication readback');
  const destinationStat = await fsp.lstat(destination, {bigint: true});
  if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()
      || !sameRestoreDirectoryIdentity(destinationStat, stagingIdentity)) {
    throw new Error('Published restore destination does not match the captured staging directory inode');
  }
  const stagingObservation = await observeRestorePath(staging);
  if (stagingObservation.error) throw stagingObservation.error;
  if (stagingObservation.stat) {
    throw new Error('Restore staging path unexpectedly exists after atomic publication');
  }
  await assertRestoreParentBinding(binding, 'after terminal publication readback');
}

export async function restoreEncryptedBrowserStateBackup({
  archive, keyFile, destination, confirmation, limits,
  identityMaps = [], sameHostIdentity = false,
  diagnostics = null,
}) {
  if (!archive) throw new Error('--archive is required');
  if (!destination) throw new Error('--destination is required');
  if (confirmation !== RESTORE_CONFIRMATION) throw new Error(`Restore requires --confirm ${RESTORE_CONFIRMATION}`);
  if (identityMaps.length === 0 && !sameHostIdentity) {
    throw new Error('Restore requires --identity-map or --same-host-identity before applying any uid/gid');
  }
  const identityMap = new Map();
  for (const entry of identityMaps) {
    if (identityMap.has(entry.source)) throw new Error(`Duplicate identity map for ${entry.source}`);
    identityMap.set(entry.source, entry.target);
  }
  const resolved = path.resolve(destination);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) throw new Error('Restore destination cannot be a filesystem root');
  try {
    await fsp.lstat(resolved);
    throw new Error('Restore destination must not already exist');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const activeRestoreLimits = {...DEFAULT_LIMITS, ...(limits || {})};
  const verified = await processArchive({archive, keyFile, limits, diagnostics});
  const hostIdNow = await currentHostId();
  if (sameHostIdentity) {
    if (!verified.hostId || verified.hostId !== hostIdNow) {
      throw new Error('--same-host-identity requires an archive created on this host');
    }
  } else {
    const missing = verified.identityPairs.find(pair => !identityMap.has(pair));
    if (missing !== undefined) {
      throw new Error(`Archive identity ${missing} has no --identity-map entry; refusing to restore`);
    }
  }
  await ensureRestoreDiskSpace(resolved, verified.totalBytes, verified.entryCount, activeRestoreLimits);
  const identityMapper = sameHostIdentity
    ? pair => {
        const [uidValue, gidValue] = pair.split(':').map(Number);
        return [uidValue, gidValue];
      }
    : pair => identityMap.get(pair);
  const parentBinding = await openRestoreParentBinding(resolved);
  const staging = `${resolved}.partial-${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
  try {
    await assertRestoreParentBinding(parentBinding, 'before staging creation');
    await fsp.mkdir(staging, {recursive: false, mode: 0o700});
    const stagingIdentity = validateOwnedRestoreStaging(
      await fsp.lstat(staging, {bigint: true}),
      parentBinding.identity,
    );
    let publicationSucceeded = false;
    try {
      await assertRestoreParentBinding(parentBinding, 'after staging creation');
      const restored = await processArchive({archive, keyFile, destination: staging, limits, identityMapper, diagnostics});
      for (const field of ['archiveSha256', 'manifestSha256', 'entryCount', 'fileCount', 'directoryCount', 'totalBytes']) {
        if (restored[field] !== verified[field]) throw new Error(`Archive changed between verify and restore: ${field}`);
      }
      if (typeof diagnostics?.beforeRestorePublish === 'function') {
        await diagnostics.beforeRestorePublish({destination: resolved, staging});
      }
      const publication = await publishRestoreStagingNoReplace(
        parentBinding,
        staging,
        resolved,
        stagingIdentity,
      );
      publicationSucceeded = true;
      if (typeof diagnostics?.beforeRestoreTerminalReadback === 'function') {
        await diagnostics.beforeRestoreTerminalReadback({
          destination: resolved,
          staging,
          publication: {...publication},
        });
      }
      await terminalRestorePublicationReadback(parentBinding, staging, resolved, stagingIdentity);
      return {
        action: 'restore',
        destination: resolved,
        ...restored,
        publicationMethod: publication.method,
        parentFsync: publication.fsync,
      };
    } catch (error) {
      const [stagingObservation, destinationObservation] = await Promise.all([
        observeRestorePath(staging),
        observeRestorePath(resolved),
      ]);
      const classification = classifyRestorePublicationPaths({
        stagingStat: stagingObservation.stat,
        destinationStat: destinationObservation.stat,
        expectedStaging: stagingIdentity,
      });
      // Any restore failure preserves the captured staging tree intact for
      // manual inspection.  A recursive clean of the staging path after an
      // lstat would race a concurrent pathname replacement and could delete
      // an unowned directory, so it is never attempted.  Once the no-replace
      // rename succeeds the captured staging path no longer exists and the
      // published destination is never rolled back.
      const stagingExists = Boolean(stagingObservation.stat);
      const manualInspectionRequired = publicationSucceeded
        || error?.publicationSucceeded === true
        || classification.publishedDestination
        || classification.competingDestination
        || classification.stagingPathReplaced
        || stagingExists
        || Boolean(stagingObservation.error || destinationObservation.error);
      const notes = [];
      if (stagingObservation.error) {
        notes.push(`staging inspection failed: ${stagingObservation.error.code || stagingObservation.error.message}`);
      } else if (stagingExists) {
        notes.push(`restore staging preserved for manual inspection (recursive cleanup is never attempted): ${staging}`);
      } else {
        notes.push(`captured staging path is absent: ${staging}`);
      }
      if (classification.publishedDestination) {
        notes.push('the published destination is left intact and is never rolled back');
      } else if (classification.competingDestination) {
        notes.push('competing destination left untouched');
      }
      if (classification.stagingPathReplaced) {
        notes.push('replacement staging path left untouched; displaced staging preserved for manual inspection');
      }
      if (manualInspectionRequired) {
        notes.push('manual inspection required; no destination or unowned path was deleted');
      }
      if (notes.length) error.message = `${error.message}; ${notes.join('; ')}`;
      throw error;
    }
  } finally {
    await parentBinding.handle.close().catch(() => {});
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  let result;
  if (args.command === 'create') {
    result = await createEncryptedBrowserStateBackup({
      keyFile: args.keyFile,
      output: args.output,
      sources: args.sources,
      limits: args.limits,
    });
  } else if (args.command === 'verify') {
    result = await verifyEncryptedBrowserStateBackup({archive: args.archive, keyFile: args.keyFile, limits: args.limits});
  } else if (args.command === 'restore') {
    result = await restoreEncryptedBrowserStateBackup({
      archive: args.archive,
      keyFile: args.keyFile,
      destination: args.destination,
      confirmation: args.confirmation,
      limits: args.limits,
      identityMaps: args.identityMaps,
      sameHostIdentity: args.sameHostIdentity,
    });
  } else {
    throw new Error(`Unknown command: ${args.command || '(missing)'}\n${usage()}`);
  }
  console.log(JSON.stringify(result));
}

const invokedAsScript = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  main().catch(error => {
    console.error(`[browser-state-backup] ${error?.message || error}`);
    process.exitCode = 1;
  });
}

export {
  FORMAT,
  RESTORE_CONFIRMATION,
  parseArgs,
  activeBrowserProcessesFromProc,
  CiphertextRangeTransform,
  readKeyFile,
};
