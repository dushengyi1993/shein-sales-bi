import crypto from 'node:crypto';
import {constants as fsConstants} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import {writeJsonFileAtomic} from './atomic_file_publish.mjs';
import {
  CLOUD_MAINTENANCE_CLASSES,
  CLOUD_MAINTENANCE_POLICY_BY_SERVICE,
} from './cloud_runtime_inventory.mjs';

export const CLOUD_MAINTENANCE_SCHEMA_VERSION = 'cloud-maintenance-mode/v1';
export const CLOUD_MAINTENANCE_CONTROL_DIR = '/var/lib/shein-bi-control';
export const CANONICAL_CLOUD_MAINTENANCE_FILE = `${CLOUD_MAINTENANCE_CONTROL_DIR}/cloud-maintenance.json`;
export const DEFAULT_CLOUD_MAINTENANCE_FILE = CANONICAL_CLOUD_MAINTENANCE_FILE;
export const CLOUD_MAINTENANCE_CONTROL_MODE = 0o755;
export const CLOUD_MAINTENANCE_MARKER_MODE = 0o644;
const CANONICAL_ANCESTOR_DIRS = Object.freeze(['/', '/var', '/var/lib']);
export const CLOUD_MAINTENANCE_ABSENT_HASH = crypto
  .createHash('sha256')
  .update(`${CLOUD_MAINTENANCE_SCHEMA_VERSION}:absent\n`, 'utf8')
  .digest('hex');

export const CLOUD_MAINTENANCE_EXIT_CODES = Object.freeze({
  allowed: 0,
  skipped: 1,
  configuration: 64,
  conflict: 75,
  systemdConfiguration: 255,
});

const ACTIVE_MODES = new Set(['business', 'all']);
const VALID_CLASSES = new Set(CLOUD_MAINTENANCE_CLASSES);
const MARKER_KEYS = new Set([
  'schemaVersion',
  'generation',
  'active',
  'mode',
  'reason',
  'requestedBy',
  'startedAt',
  'updatedAt',
  'endedAt',
]);
const MAX_MARKER_BYTES = 64 * 1024;
const MAX_LOCK_BYTES = 4 * 1024;
const SECRET_LIKE_TEXT = /(?:-----BEGIN [^-]*PRIVATE KEY-----|\b(?:authorization|cookie|password|passwd|secret|token|api[-_ ]?key)\s*[:=]\s*\S+|\bbearer\s+[a-z0-9._~+/-]{12,})/iu;

export class CloudMaintenanceConfigurationError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'CloudMaintenanceConfigurationError';
    this.code = 'CLOUD_MAINTENANCE_CONFIGURATION_ERROR';
    this.exitCode = CLOUD_MAINTENANCE_EXIT_CODES.configuration;
    this.detail = detail;
  }
}

export class CloudMaintenanceCasConflictError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'CloudMaintenanceCasConflictError';
    this.code = 'CLOUD_MAINTENANCE_CAS_CONFLICT';
    this.exitCode = CLOUD_MAINTENANCE_EXIT_CODES.conflict;
    this.detail = detail;
  }
}

export class CloudMaintenanceLockCleanupError extends CloudMaintenanceConfigurationError {
  constructor(message, detail = {}) {
    super(message, detail);
    this.name = 'CloudMaintenanceLockCleanupError';
    this.code = 'CLOUD_MAINTENANCE_LOCK_CLEANUP_UNCONFIRMED';
  }
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function markerFilePath(file) {
  const value = String(file || DEFAULT_CLOUD_MAINTENANCE_FILE).trim();
  if (!value) throw new CloudMaintenanceConfigurationError('maintenance marker file is required');
  return path.resolve(value);
}

export function isCanonicalCloudMaintenanceFile(file = DEFAULT_CLOUD_MAINTENANCE_FILE) {
  return markerFilePath(file) === path.resolve(CANONICAL_CLOUD_MAINTENANCE_FILE);
}

export function cloudMaintenanceStaleLockRecoveryMode(
  file = DEFAULT_CLOUD_MAINTENANCE_FILE,
  {platform = process.platform} = {},
) {
  return platform === 'linux' && isCanonicalCloudMaintenanceFile(file) ? 'manual' : 'automatic';
}

function isoTimestamp(value, label, {nullable = false} = {}) {
  if (nullable && value === null) return null;
  const normalized = String(value || '').trim();
  if (!normalized || Number.isNaN(Date.parse(normalized))) return {error: `${label} must be an ISO timestamp`};
  return new Date(normalized).toISOString();
}

function safeText(value, label, maxLength) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new CloudMaintenanceConfigurationError(`${label} is required`);
  if (normalized.length > maxLength) {
    throw new CloudMaintenanceConfigurationError(`${label} exceeds ${maxLength} characters`);
  }
  if (/\p{Cc}/u.test(normalized)) {
    throw new CloudMaintenanceConfigurationError(`${label} contains control characters`);
  }
  if (SECRET_LIKE_TEXT.test(normalized)) {
    throw new CloudMaintenanceConfigurationError(`${label} appears to contain secret material`);
  }
  return normalized;
}

function validateMarkerObject(value) {
  const issues = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {ok: false, issues: ['marker must be a JSON object']};
  }
  for (const key of Object.keys(value)) {
    if (!MARKER_KEYS.has(key)) issues.push(`unsupported marker field: ${key}`);
  }
  if (value.schemaVersion !== CLOUD_MAINTENANCE_SCHEMA_VERSION) issues.push('unsupported schemaVersion');
  if (!Number.isSafeInteger(value.generation) || value.generation < 1) issues.push('generation must be a positive integer');
  if (typeof value.active !== 'boolean') issues.push('active must be boolean');
  if (value.active === true && !ACTIVE_MODES.has(value.mode)) issues.push('active marker mode must be business or all');
  if (value.active === false && value.mode !== 'none') issues.push('inactive marker mode must be none');

  let reason;
  let requestedBy;
  try {
    reason = safeText(value.reason, 'reason', 500);
    requestedBy = safeText(value.requestedBy, 'requestedBy', 200);
  } catch (error) {
    issues.push(error.message);
  }

  const startedAt = isoTimestamp(value.startedAt, 'startedAt', {nullable: value.active === false});
  const updatedAt = isoTimestamp(value.updatedAt, 'updatedAt');
  const endedAt = isoTimestamp(value.endedAt, 'endedAt', {nullable: value.active === true});
  if (startedAt && typeof startedAt === 'object') issues.push(startedAt.error);
  if (updatedAt && typeof updatedAt === 'object') issues.push(updatedAt.error);
  if (endedAt && typeof endedAt === 'object') issues.push(endedAt.error);
  if (value.active === true && value.endedAt !== null) issues.push('active marker endedAt must be null');
  if (value.active === false && (value.endedAt === null || endedAt?.error)) issues.push('inactive marker endedAt is required');

  if (issues.length) return {ok: false, issues};
  return {
    ok: true,
    marker: {
      schemaVersion: CLOUD_MAINTENANCE_SCHEMA_VERSION,
      generation: value.generation,
      active: value.active,
      mode: value.mode,
      reason,
      requestedBy,
      startedAt,
      updatedAt,
      endedAt,
    },
  };
}

function absentStatus(file) {
  return {
    schemaVersion: CLOUD_MAINTENANCE_SCHEMA_VERSION,
    ok: true,
    exists: false,
    active: false,
    mode: 'none',
    generation: 0,
    hash: CLOUD_MAINTENANCE_ABSENT_HASH,
    reason: '',
    requestedBy: '',
    startedAt: null,
    updatedAt: null,
    endedAt: null,
    markerFile: file,
    errorCode: '',
    issues: [],
  };
}

function invalidStatus(file, {hash = '', errorCode, issues = []} = {}) {
  return {
    schemaVersion: CLOUD_MAINTENANCE_SCHEMA_VERSION,
    ok: false,
    exists: true,
    active: null,
    mode: 'unknown',
    generation: null,
    hash,
    reason: '',
    requestedBy: '',
    startedAt: null,
    updatedAt: null,
    endedAt: null,
    markerFile: file,
    errorCode,
    issues: issues.map(issue => String(issue || '')).filter(Boolean).slice(0, 20),
  };
}

function classifyMarkerBytes(target, bytes) {
  const hash = sha256(bytes);
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return invalidStatus(target, {
      hash,
      errorCode: 'MAINTENANCE_MARKER_INVALID_JSON',
      issues: ['marker is not valid JSON'],
    });
  }
  const validated = validateMarkerObject(parsed);
  if (!validated.ok) {
    return invalidStatus(target, {
      hash,
      errorCode: 'MAINTENANCE_MARKER_INVALID_SCHEMA',
      issues: validated.issues,
    });
  }
  return {
    ...validated.marker,
    ok: true,
    exists: true,
    hash,
    markerFile: target,
    errorCode: '',
    issues: [],
  };
}

function statPredicate(stat, name) {
  const value = stat?.[name];
  return typeof value === 'function' ? value.call(stat) : value;
}

export function cloudMaintenanceCanonicalMarkerSafety(stat) {
  const issues = [];
  if (!stat || typeof stat !== 'object') return ['marker stat is unavailable'];
  const isSymbolicLink = statPredicate(stat, 'isSymbolicLink');
  const isFile = statPredicate(stat, 'isFile');
  if (isSymbolicLink !== false) {
    issues.push(isSymbolicLink === true
      ? 'marker must not be a symbolic link'
      : 'marker symbolic-link state is unavailable');
  }
  if (isFile !== true) issues.push('marker must be a regular file');
  if (!Number.isSafeInteger(stat.nlink) || stat.nlink !== 1) {
    issues.push(`marker hard-link count must be 1 (got ${String(stat.nlink)})`);
  }
  if (!Number.isSafeInteger(stat.uid) || stat.uid !== 0) {
    issues.push(`marker uid must be root (got ${String(stat.uid)})`);
  }
  if (!Number.isSafeInteger(stat.gid) || stat.gid !== 0) {
    issues.push(`marker gid must be root (got ${String(stat.gid)})`);
  }
  if (!Number.isSafeInteger(stat.mode)) {
    issues.push('marker mode is unavailable');
  } else {
    const perms = stat.mode & 0o777;
    if (perms !== CLOUD_MAINTENANCE_MARKER_MODE) {
      issues.push(`marker mode must be exactly 0644 (got ${perms.toString(8)})`);
    }
  }
  return issues;
}

export function cloudMaintenanceCanonicalLockSafety(stat) {
  const issues = [];
  if (!stat || typeof stat !== 'object') return ['lock stat is unavailable'];
  const isSymbolicLink = statPredicate(stat, 'isSymbolicLink');
  const isFile = statPredicate(stat, 'isFile');
  if (isSymbolicLink !== false) {
    issues.push(isSymbolicLink === true
      ? 'lock must not be a symbolic link'
      : 'lock symbolic-link state is unavailable');
  }
  if (isFile !== true) issues.push('lock must be a regular file');
  if (!Number.isSafeInteger(stat.nlink) || stat.nlink !== 1) {
    issues.push(`lock hard-link count must be 1 (got ${String(stat.nlink)})`);
  }
  if (!Number.isSafeInteger(stat.uid) || stat.uid !== 0) {
    issues.push(`lock uid must be root (got ${String(stat.uid)})`);
  }
  if (!Number.isSafeInteger(stat.gid) || stat.gid !== 0) {
    issues.push(`lock gid must be root (got ${String(stat.gid)})`);
  }
  if (!Number.isSafeInteger(stat.mode)) {
    issues.push('lock mode is unavailable');
  } else {
    const perms = stat.mode & 0o777;
    if (perms !== 0o600) issues.push(`lock mode must be exactly 0600 (got ${perms.toString(8)})`);
  }
  return issues;
}

export function cloudMaintenanceAncestorDirectorySafety(stat, {name = 'ancestor', exactMode = null} = {}) {
  const issues = [];
  if (!stat || typeof stat !== 'object') return [`${name} stat is unavailable`];
  const isSymbolicLink = statPredicate(stat, 'isSymbolicLink');
  const isDirectory = statPredicate(stat, 'isDirectory');
  if (isSymbolicLink !== false) {
    issues.push(isSymbolicLink === true
      ? `${name} must not be a symbolic link`
      : `${name} symbolic-link state is unavailable`);
  }
  if (isDirectory !== true) issues.push(`${name} must be a directory`);
  if (!Number.isSafeInteger(stat.uid) || stat.uid !== 0) {
    issues.push(`${name} uid must be root (got ${String(stat.uid)})`);
  }
  if (!Number.isSafeInteger(stat.gid) || stat.gid !== 0) {
    issues.push(`${name} gid must be root (got ${String(stat.gid)})`);
  }
  if (!Number.isSafeInteger(stat.mode)) {
    issues.push(`${name} mode is unavailable`);
  } else {
    const perms = stat.mode & 0o777;
    if ((perms & 0o022) !== 0) {
      issues.push(`${name} must not be group/world writable (got ${perms.toString(8)})`);
    }
    if (exactMode !== null && perms !== exactMode) {
      issues.push(`${name} mode must be exactly ${exactMode.toString(8)} (got ${perms.toString(8)})`);
    }
  }
  return issues;
}

async function lstatOrNull(file) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function readCanonicalBaseAncestorIssues() {
  const issues = [];
  for (const dir of CANONICAL_ANCESTOR_DIRS) {
    const stat = await lstatOrNull(dir);
    if (!stat) {
      issues.push(`${dir} does not exist`);
      continue;
    }
    issues.push(...cloudMaintenanceAncestorDirectorySafety(stat, {name: dir}));
  }
  return issues;
}

async function readCanonicalAncestorIssues() {
  const issues = await readCanonicalBaseAncestorIssues();
  const controlStat = await lstatOrNull(CLOUD_MAINTENANCE_CONTROL_DIR);
  if (controlStat) {
    issues.push(...cloudMaintenanceAncestorDirectorySafety(controlStat, {
      name: CLOUD_MAINTENANCE_CONTROL_DIR,
      exactMode: CLOUD_MAINTENANCE_CONTROL_MODE,
    }));
  }
  return issues;
}

function canonicalOpenFlags() {
  return fsConstants.O_RDONLY
    | (fsConstants.O_NOFOLLOW || 0)
    | (fsConstants.O_NONBLOCK || 0);
}

function canonicalDirectoryOpenFlags() {
  return canonicalOpenFlags() | (fsConstants.O_DIRECTORY || 0);
}

async function readCanonicalSpecies(target) {
  const ancestorIssues = await readCanonicalAncestorIssues();
  if (ancestorIssues.length) {
    return invalidStatus(target, {
      errorCode: 'MAINTENANCE_MARKER_UNSAFE_PATH',
      issues: ancestorIssues,
    });
  }
  let handle;
  try {
    handle = await fs.open(target, canonicalOpenFlags());
  } catch (error) {
    if (error?.code === 'ENOENT') return absentStatus(target);
    return invalidStatus(target, {
      errorCode: 'MAINTENANCE_MARKER_UNSAFE_PATH',
      issues: [String(error?.code || error?.message || error)],
    });
  }
  try {
    let stat;
    try {
      stat = await handle.stat();
    } catch (error) {
      return invalidStatus(target, {
        errorCode: 'MAINTENANCE_MARKER_UNREADABLE',
        issues: [String(error?.code || error?.message || error)],
      });
    }
    const markerIssues = cloudMaintenanceCanonicalMarkerSafety(stat);
    if (markerIssues.length) {
      return invalidStatus(target, {
        errorCode: 'MAINTENANCE_MARKER_UNSAFE_PATH',
        issues: markerIssues,
      });
    }
    if (stat.size > MAX_MARKER_BYTES) {
      return invalidStatus(target, {
        errorCode: 'MAINTENANCE_MARKER_TOO_LARGE',
        issues: [`marker exceeds ${MAX_MARKER_BYTES} bytes`],
      });
    }
    let bytes;
    try {
      bytes = await handle.readFile();
    } catch (error) {
      return invalidStatus(target, {
        errorCode: 'MAINTENANCE_MARKER_UNREADABLE',
        issues: [String(error?.code || error?.message || error)],
      });
    }
    return classifyMarkerBytes(target, bytes);
  } finally {
    await handle?.close().catch(() => {});
  }
}

function assertCanonicalWriterPrivilege(target) {
  if (!isCanonicalCloudMaintenanceFile(target)) return;
  if (process.platform !== 'linux') return;
  if (typeof process.getuid !== 'function') return;
  if (process.getuid() !== 0) {
    throw new CloudMaintenanceConfigurationError('canonical maintenance pause/resume requires uid 0');
  }
}

async function prepareCanonicalMaintenancePath(target) {
  if (!isCanonicalCloudMaintenanceFile(target)) return;
  if (process.platform !== 'linux') return;
  const dir = path.dirname(target);
  const baseIssues = await readCanonicalBaseAncestorIssues();
  if (baseIssues.length) {
    throw new CloudMaintenanceConfigurationError(
      'refusing to publish canonical maintenance marker with unsafe ancestor path',
      {issues: baseIssues},
    );
  }
  try {
    // Create privately first; the already-open directory handle is changed to
    // the final service-readable mode only after its identity is verified.
    await fs.mkdir(dir, {recursive: false, mode: 0o700});
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }

  let handle;
  try {
    handle = await fs.open(dir, canonicalDirectoryOpenFlags());
    const before = await handle.stat();
    const beforeIssues = [];
    if (statPredicate(before, 'isDirectory') !== true) beforeIssues.push(`${dir} must be a directory`);
    if (statPredicate(before, 'isSymbolicLink') !== false) beforeIssues.push(`${dir} must not be a symbolic link`);
    if (!Number.isSafeInteger(before.uid) || before.uid !== 0) {
      beforeIssues.push(`${dir} uid must be root before metadata repair (got ${String(before.uid)})`);
    }
    if (!Number.isSafeInteger(before.mode) || ((before.mode & 0o777) & 0o022) !== 0) {
      beforeIssues.push(`${dir} must not be group/world writable before metadata repair`);
    }
    if (beforeIssues.length) {
      throw new CloudMaintenanceConfigurationError(
        'refusing to repair unsafe canonical maintenance control directory',
        {issues: beforeIssues},
      );
    }
    await handle.chown(0, 0);
    await handle.chmod(CLOUD_MAINTENANCE_CONTROL_MODE);
    const after = await handle.stat();
    const afterIssues = cloudMaintenanceAncestorDirectorySafety(after, {
      name: dir,
      exactMode: CLOUD_MAINTENANCE_CONTROL_MODE,
    });
    if (afterIssues.length) {
      throw new CloudMaintenanceConfigurationError(
        'canonical maintenance control directory metadata readback failed',
        {issues: afterIssues},
      );
    }
    await handle.sync();
  } catch (error) {
    if (error instanceof CloudMaintenanceConfigurationError) throw error;
    throw new CloudMaintenanceConfigurationError(
      'cannot safely prepare canonical maintenance control directory',
      {cause: String(error?.code || error?.message || error)},
    );
  } finally {
    await handle?.close().catch(() => {});
  }

  const issues = await readCanonicalAncestorIssues();
  if (issues.length) {
    throw new CloudMaintenanceConfigurationError(
      'refusing to publish canonical maintenance marker with unsafe control path',
      {issues},
    );
  }
}


export async function readCloudMaintenanceStatus(file = DEFAULT_CLOUD_MAINTENANCE_FILE) {
  const target = markerFilePath(file);
  if (isCanonicalCloudMaintenanceFile(target) && process.platform === 'linux') {
    return readCanonicalSpecies(target);
  }
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return absentStatus(target);
    return invalidStatus(target, {
      errorCode: 'MAINTENANCE_MARKER_UNREADABLE',
      issues: [String(error?.code || error?.message || error)],
    });
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return invalidStatus(target, {
      errorCode: 'MAINTENANCE_MARKER_NOT_REGULAR_FILE',
      issues: [stat.isSymbolicLink() ? 'symbolic links are not allowed' : 'marker is not a regular file'],
    });
  }
  if (stat.size > MAX_MARKER_BYTES) {
    return invalidStatus(target, {
      errorCode: 'MAINTENANCE_MARKER_TOO_LARGE',
      issues: [`marker exceeds ${MAX_MARKER_BYTES} bytes`],
    });
  }

  let bytes;
  try {
    bytes = await fs.readFile(target);
  } catch (error) {
    return invalidStatus(target, {
      errorCode: 'MAINTENANCE_MARKER_UNREADABLE',
      issues: [String(error?.code || error?.message || error)],
    });
  }
  return classifyMarkerBytes(target, bytes);
}

function normalizeExpectedGeneration(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new CloudMaintenanceConfigurationError('expected generation is required');
  }
  if (String(value).trim().toLowerCase() === 'invalid') return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new CloudMaintenanceConfigurationError('expected generation must be a non-negative integer or invalid');
  }
  return parsed;
}

function normalizeExpectedHash(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new CloudMaintenanceConfigurationError('expected hash must be a 64-character SHA-256 value');
  }
  return normalized;
}

function assertCas(status, expectedGeneration, expectedHash) {
  const generation = normalizeExpectedGeneration(expectedGeneration);
  const hash = normalizeExpectedHash(expectedHash);
  if (status.generation !== generation || status.hash !== hash) {
    throw new CloudMaintenanceCasConflictError('maintenance marker changed since status read', {
      expectedGeneration: generation,
      actualGeneration: status.generation,
      expectedHash: hash,
      actualHash: status.hash,
    });
  }
}

function currentIso(options = {}) {
  const candidate = typeof options.now === 'function' ? options.now() : options.now || new Date();
  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.valueOf())) throw new CloudMaintenanceConfigurationError('now must be a valid timestamp');
  return parsed.toISOString();
}

async function processStartIdentity(pid) {
  if (process.platform !== 'linux') return '';
  try {
    const raw = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    const close = raw.lastIndexOf(')');
    if (close < 0) return '';
    const fields = raw.slice(close + 1).trim().split(/\s+/);
    const startTicks = fields[19] || '';
    return /^\d+$/.test(startTicks) ? startTicks : '';
  } catch {
    return '';
  }
}

function processAppearsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    // EPERM proves that a process occupies the PID even if this caller cannot
    // signal it. Unknown platform errors fail closed as alive.
    return true;
  }
}

async function readMarkerLock(lockFile) {
  const canonical = process.platform === 'linux'
    && path.resolve(lockFile) === `${path.resolve(CANONICAL_CLOUD_MAINTENANCE_FILE)}.lock`;
  let stat;
  let raw;
  if (canonical) {
    let handle;
    try {
      handle = await fs.open(lockFile, canonicalOpenFlags());
    } catch (error) {
      if (error?.code === 'ENOENT') return {exists: false};
      throw new CloudMaintenanceConfigurationError('canonical maintenance marker lock is unsafe', {
        lockFile,
        cause: String(error?.code || error?.message || error),
      });
    }
    try {
      stat = await handle.stat();
      const issues = cloudMaintenanceCanonicalLockSafety(stat);
      if (issues.length || stat.size < 1 || stat.size > MAX_LOCK_BYTES) {
        throw new CloudMaintenanceConfigurationError('canonical maintenance marker lock is unsafe', {
          lockFile,
          issues: [
            ...issues,
            ...(stat.size < 1 || stat.size > MAX_LOCK_BYTES
              ? [`lock size must be between 1 and ${MAX_LOCK_BYTES} bytes`]
              : []),
          ],
        });
      }
      raw = await handle.readFile('utf8');
    } finally {
      await handle?.close().catch(() => {});
    }
  } else {
    try {
      stat = await fs.lstat(lockFile);
    } catch (error) {
      if (error?.code === 'ENOENT') return {exists: false};
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1 || stat.size > MAX_LOCK_BYTES) {
      throw new CloudMaintenanceConfigurationError('maintenance marker lock is unsafe', {lockFile});
    }
    raw = await fs.readFile(lockFile, 'utf8');
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    const legacyPid = Number(raw.trim());
    if (!Number.isSafeInteger(legacyPid) || legacyPid < 1) {
      throw new CloudMaintenanceConfigurationError('maintenance marker lock is malformed', {lockFile});
    }
    value = {pid: legacyPid, nonce: '', processStart: '', createdAt: new Date(stat.mtimeMs).toISOString()};
  }
  const pid = Number(value?.pid);
  const nonce = String(value?.nonce || '');
  const processStart = String(value?.processStart || '');
  if (!Number.isSafeInteger(pid) || pid < 1
    || (nonce && !/^[a-f0-9-]{36}$/.test(nonce))
    || (processStart && !/^\d+$/.test(processStart))) {
    throw new CloudMaintenanceConfigurationError('maintenance marker lock fields are invalid', {lockFile});
  }
  return {exists: true, stat, pid, nonce, processStart, raw};
}

async function markerLockOwnerIsAlive(lock) {
  if (!processAppearsAlive(lock.pid)) return false;
  if (!lock.processStart) return true;
  const observedStart = await processStartIdentity(lock.pid);
  return !observedStart || observedStart === lock.processStart;
}

async function acquireMarkerLock(file) {
  const lockFile = `${file}.lock`;
  const canonical = process.platform === 'linux' && isCanonicalCloudMaintenanceFile(file);
  if (canonical) {
    const issues = await readCanonicalAncestorIssues();
    if (issues.length) {
      throw new CloudMaintenanceConfigurationError('canonical maintenance marker directory is unsafe', {issues});
    }
  } else {
    await fs.mkdir(path.dirname(file), {recursive: true, mode: 0o750});
    const parentStat = await fs.lstat(path.dirname(file));
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
      throw new CloudMaintenanceConfigurationError('maintenance marker directory is unsafe', {directory: path.dirname(file)});
    }
  }
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const nonce = crypto.randomUUID();
    let handle;
    try {
      handle = await fs.open(lockFile, 'wx', 0o600);
      if (canonical) {
        await handle.chown(0, 0);
        await handle.chmod(0o600);
        const lockStat = await handle.stat();
        const lockIssues = cloudMaintenanceCanonicalLockSafety(lockStat);
        if (lockIssues.length) {
          throw new CloudMaintenanceConfigurationError(
            'canonical maintenance marker lock metadata readback failed',
            {issues: lockIssues},
          );
        }
      }
      const payload = {
        pid: process.pid,
        nonce,
        processStart: await processStartIdentity(process.pid),
        createdAt: new Date().toISOString(),
      };
      await handle.writeFile(`${JSON.stringify(payload)}\n`, 'utf8');
      await handle.sync();
      return {lockFile, handle, nonce};
    } catch (error) {
      const ownsLock = Boolean(handle);
      await handle?.close().catch(() => {});
      if (ownsLock) await fs.unlink(lockFile).catch(() => {});
      if (error?.code !== 'EEXIST') throw error;
    }

    const observed = await readMarkerLock(lockFile);
    if (!observed.exists) continue;
    if (await markerLockOwnerIsAlive(observed)) {
      throw new CloudMaintenanceCasConflictError('maintenance marker is locked by another transition', {
        lockFile,
        ownerPid: observed.pid,
      });
    }
    if (cloudMaintenanceStaleLockRecoveryMode(file) === 'manual') {
      throw new CloudMaintenanceCasConflictError(
        'canonical maintenance marker has an orphaned lock; automatic recovery is disabled',
        {
          lockFile,
          ownerPid: observed.pid,
          ownerProcessStart: observed.processStart,
          recovery: 'manual_after_marker_and_process_identity_verification',
        },
      );
    }
    const quarantine = `${lockFile}.stale-${process.pid}-${nonce}`;
    try {
      await fs.rename(lockFile, quarantine);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    await fs.unlink(quarantine);
  }
  throw new CloudMaintenanceCasConflictError('maintenance marker lock could not be acquired after stale-lock recovery', {lockFile});
}

async function withMarkerLock(file, callback) {
  const owned = await acquireMarkerLock(file);
  const assertOwnership = async () => {
    const observed = await readMarkerLock(owned.lockFile);
    if (!observed.exists || observed.nonce !== owned.nonce || observed.pid !== process.pid) {
      throw new CloudMaintenanceCasConflictError('maintenance marker lock ownership changed during transition', {
        lockFile: owned.lockFile,
      });
    }
  };
  let result;
  let callbackError = null;
  let callbackCompleted = false;
  try {
    result = await callback({assertOwnership, lockFile: owned.lockFile});
    callbackCompleted = true;
  } catch (error) {
    callbackError = error;
  }

  let cleanupError = null;
  try {
    await owned.handle.close();
  } catch (error) {
    cleanupError = error;
  }
  try {
    const observed = await readMarkerLock(owned.lockFile);
    if (!observed.exists || observed.nonce !== owned.nonce || observed.pid !== process.pid) {
      throw new CloudMaintenanceCasConflictError('maintenance marker lock ownership changed before cleanup', {
        lockFile: owned.lockFile,
        lockExists: observed.exists,
        ownerPid: observed.exists ? observed.pid : null,
      });
    }
    await fs.unlink(owned.lockFile);
  } catch (error) {
    cleanupError ||= error;
  }

  if (cleanupError) {
    const cleanupDetail = {
      lockFile: owned.lockFile,
      transitionCommitted: callbackCompleted,
      cleanupErrorCode: String(cleanupError?.code || ''),
      cleanupError: String(cleanupError?.message || cleanupError),
    };
    if (callbackError) {
      callbackError.detail = {
        ...(callbackError?.detail && typeof callbackError.detail === 'object' ? callbackError.detail : {}),
        lockCleanup: cleanupDetail,
      };
      throw callbackError;
    }
    throw new CloudMaintenanceLockCleanupError(
      'maintenance marker transition committed but lock cleanup was not confirmed',
      cleanupDetail,
    );
  }
  if (callbackError) throw callbackError;
  return result;
}

async function writeTransition({
  markerFile,
  expectedGeneration,
  expectedHash,
  buildMarker,
  now,
  beforeCommit,
  afterPublish,
}) {
  const target = markerFilePath(markerFile);
  assertCanonicalWriterPrivilege(target);
  await prepareCanonicalMaintenancePath(target);
  return withMarkerLock(target, async ({assertOwnership, lockFile}) => {
    const current = await readCloudMaintenanceStatus(target);
    assertCas(current, expectedGeneration, expectedHash);
    const timestamp = currentIso({now});
    const marker = buildMarker(current, timestamp);
    const validated = validateMarkerObject(marker);
    if (!validated.ok) {
      throw new CloudMaintenanceConfigurationError('refusing to write invalid maintenance marker', {
        issues: validated.issues,
      });
    }
    if (typeof beforeCommit === 'function') await beforeCommit({current, marker: validated.marker, markerFile: target});
    await assertOwnership();
    const latest = await readCloudMaintenanceStatus(target);
    if (latest.hash !== current.hash || latest.generation !== current.generation) {
      throw new CloudMaintenanceCasConflictError('maintenance marker changed during transition', {
        expectedGeneration: current.generation,
        actualGeneration: latest.generation,
        expectedHash: current.hash,
        actualHash: latest.hash,
      });
    }
    await assertOwnership();
    const canonicalMarker = isCanonicalCloudMaintenanceFile(target);
    const atomicOptions = canonicalMarker && process.platform === 'linux'
      ? {mode: CLOUD_MAINTENANCE_MARKER_MODE, uid: 0, gid: 0}
      : {mode: 0o600};
    const expectedBytes = Buffer.from(`${JSON.stringify(validated.marker, null, 2)}\n`, 'utf8');
    const expectedReadbackHash = sha256(expectedBytes);
    await writeJsonFileAtomic(target, validated.marker, atomicOptions);
    if (typeof afterPublish === 'function') {
      await afterPublish({marker: validated.marker, markerFile: target, lockFile});
    }
    const readback = await readCloudMaintenanceStatus(target);
    if (!readback.ok || readback.hash !== expectedReadbackHash) {
      throw new CloudMaintenanceConfigurationError(
        'maintenance marker atomic readback did not match committed bytes',
        {
          expectedGeneration: validated.marker.generation,
          actualGeneration: readback.generation,
          expectedHash: expectedReadbackHash,
          actualHash: readback.hash,
          readbackErrorCode: readback.errorCode,
          readbackIssues: readback.issues,
        },
      );
    }
    return readback;
  });
}

export async function pauseCloudMaintenance({
  markerFile = DEFAULT_CLOUD_MAINTENANCE_FILE,
  mode,
  reason,
  requestedBy,
  expectedGeneration,
  expectedHash,
  now,
  beforeCommit,
  afterPublish,
} = {}) {
  const normalizedMode = String(mode || '').trim().toLowerCase();
  if (!ACTIVE_MODES.has(normalizedMode)) {
    throw new CloudMaintenanceConfigurationError('pause mode must be business or all');
  }
  const normalizedReason = safeText(reason, 'reason', 500);
  const normalizedRequestedBy = safeText(requestedBy, 'requestedBy', 200);
  return writeTransition({
    markerFile,
    expectedGeneration,
    expectedHash,
    now,
    beforeCommit,
    afterPublish,
    buildMarker(current, timestamp) {
      return {
        schemaVersion: CLOUD_MAINTENANCE_SCHEMA_VERSION,
        generation: Number.isSafeInteger(current.generation) ? current.generation + 1 : 1,
        active: true,
        mode: normalizedMode,
        reason: normalizedReason,
        requestedBy: normalizedRequestedBy,
        startedAt: current.ok && current.active ? current.startedAt : timestamp,
        updatedAt: timestamp,
        endedAt: null,
      };
    },
  });
}

export async function resumeCloudMaintenance({
  markerFile = DEFAULT_CLOUD_MAINTENANCE_FILE,
  reason,
  requestedBy,
  expectedGeneration,
  expectedHash,
  now,
  beforeCommit,
  afterPublish,
} = {}) {
  const normalizedReason = safeText(reason, 'reason', 500);
  const normalizedRequestedBy = safeText(requestedBy, 'requestedBy', 200);
  return writeTransition({
    markerFile,
    expectedGeneration,
    expectedHash,
    now,
    beforeCommit,
    afterPublish,
    buildMarker(current, timestamp) {
      return {
        schemaVersion: CLOUD_MAINTENANCE_SCHEMA_VERSION,
        generation: Number.isSafeInteger(current.generation) ? current.generation + 1 : 1,
        active: false,
        mode: 'none',
        reason: normalizedReason,
        requestedBy: normalizedRequestedBy,
        startedAt: current.ok ? current.startedAt : null,
        updatedAt: timestamp,
        endedAt: timestamp,
      };
    },
  });
}

export function maintenanceBlocksClass(status, unitClass) {
  const normalizedClass = String(unitClass || '').trim().toLowerCase();
  if (!VALID_CLASSES.has(normalizedClass)) return null;
  if (normalizedClass === 'always') return false;
  if (status?.ok !== true) return true;
  if (status.active !== true) return false;
  if (status.mode === 'all') return normalizedClass === 'scheduled' || normalizedClass === 'infrastructure';
  if (status.mode === 'business') return normalizedClass === 'scheduled';
  return true;
}

export function evaluateCloudMaintenanceCheck({
  status,
  unitClass,
  unit,
  policyByService = CLOUD_MAINTENANCE_POLICY_BY_SERVICE,
} = {}) {
  const normalizedClass = String(unitClass || '').trim().toLowerCase();
  const normalizedUnit = String(unit || '').trim();
  if (!VALID_CLASSES.has(normalizedClass)) {
    return {allowed: false, exitCode: CLOUD_MAINTENANCE_EXIT_CODES.configuration, reason: 'invalid_class'};
  }
  if (!normalizedUnit || !normalizedUnit.endsWith('.service')) {
    return {allowed: false, exitCode: CLOUD_MAINTENANCE_EXIT_CODES.configuration, reason: 'invalid_unit'};
  }
  const expectedClass = policyByService?.[normalizedUnit];
  if (!expectedClass) {
    return {
      allowed: false,
      exitCode: CLOUD_MAINTENANCE_EXIT_CODES.configuration,
      reason: 'unit_policy_missing',
      unit: normalizedUnit,
    };
  }
  if (expectedClass !== normalizedClass) {
    return {
      allowed: false,
      exitCode: CLOUD_MAINTENANCE_EXIT_CODES.configuration,
      reason: 'unit_policy_mismatch',
      unit: normalizedUnit,
      unitClass: normalizedClass,
      expectedClass,
    };
  }
  if (normalizedClass === 'always') {
    return {allowed: true, exitCode: CLOUD_MAINTENANCE_EXIT_CODES.allowed, reason: 'always_allowed', unit: normalizedUnit};
  }
  if (status?.ok !== true) {
    return {
      allowed: false,
      exitCode: CLOUD_MAINTENANCE_EXIT_CODES.configuration,
      reason: 'marker_invalid_fail_closed',
      unit: normalizedUnit,
      markerErrorCode: status?.errorCode || 'MAINTENANCE_MARKER_STATUS_MISSING',
    };
  }
  const blocked = maintenanceBlocksClass(status, normalizedClass);
  if (blocked) {
    return {
      allowed: false,
      exitCode: CLOUD_MAINTENANCE_EXIT_CODES.skipped,
      reason: `maintenance_${status.mode}`,
      unit: normalizedUnit,
      mode: status.mode,
      generation: status.generation,
      hash: status.hash,
    };
  }
  return {
    allowed: true,
    exitCode: CLOUD_MAINTENANCE_EXIT_CODES.allowed,
    reason: status.active ? `maintenance_${status.mode}_allows_class` : 'maintenance_inactive',
    unit: normalizedUnit,
    mode: status.mode,
    generation: status.generation,
    hash: status.hash,
  };
}

export async function checkCloudMaintenance({
  markerFile = DEFAULT_CLOUD_MAINTENANCE_FILE,
  unitClass,
  unit,
  policyByService,
} = {}) {
  const status = await readCloudMaintenanceStatus(markerFile);
  return {
    schemaVersion: CLOUD_MAINTENANCE_SCHEMA_VERSION,
    command: 'check',
    markerFile: status.markerFile,
    markerOk: status.ok,
    markerActive: status.active,
    markerMode: status.mode,
    markerGeneration: status.generation,
    markerHash: status.hash,
    ...evaluateCloudMaintenanceCheck({status, unitClass, unit, policyByService}),
  };
}
