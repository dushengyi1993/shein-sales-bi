import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {writeJsonFileAtomic} from './atomic_file_publish.mjs';
import {MARKETING_IMMEDIATE_MAX_OUTER_WINDOW_SEC} from './cloud_marketing_deadline_contract.mjs';

export const IMMEDIATE_AUTHORIZATION_SCHEMA_VERSION = 1;
export const IMMEDIATE_AUTHORIZATION_MODE = 'cloud_marketing_immediate_once';
export const IMMEDIATE_CONFIRMATION_TOKEN = 'IMMEDIATE_CLOUD_MARKETING_REPAIR';
export const IMMEDIATE_MIN_GROUPS = 1;
export const IMMEDIATE_MAX_GROUPS = 32;
export const IMMEDIATE_MIN_REMAINING_SEC = 900;
export const IMMEDIATE_MIN_DEADLINE_SEPARATION_SEC = 900;
export const IMMEDIATE_DEFAULT_TTL_SEC = 3600;
export const IMMEDIATE_MAX_TTL_SEC = MARKETING_IMMEDIATE_MAX_OUTER_WINDOW_SEC;
export const DEFAULT_IMMEDIATE_AUTHORIZATION_FILE = '/srv/shein-bi/marketing-repair-immediate/authorization.json';

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA256_RE = /^[a-f0-9]{64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const O_NOFOLLOW = Number(fsSync.constants?.O_NOFOLLOW) || 0;

export class ImmediateAuthorizationError extends Error {
  constructor(message, code = 'IMMEDIATE_AUTHORIZATION_INVALID') {
    super(message);
    this.name = 'ImmediateAuthorizationError';
    this.code = code;
  }
}

function fail(message, code = 'IMMEDIATE_AUTHORIZATION_INVALID') {
  throw new ImmediateAuthorizationError(message, code);
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function normalizeAbsolutePath(value, label) {
  const raw = String(value ?? '').trim();
  if (!raw || /[\0\r\n]/.test(raw)) fail(`${label} must be a non-empty single-line path`);
  if (!path.isAbsolute(raw)) fail(`${label} must be absolute`);
  const resolved = path.resolve(raw);
  if (!path.isAbsolute(resolved)) fail(`${label} must be absolute`);
  return resolved;
}

function normalizeDate(value, label = 'date') {
  const date = String(value ?? '').trim();
  if (!DATE_RE.test(date)) fail(`${label} must be YYYY-MM-DD`);
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== date) {
    fail(`${label} is not a calendar date: ${date}`);
  }
  return date;
}

function normalizeTimeZone(value) {
  const timeZone = String(value || 'Asia/Shanghai').trim();
  try {
    new Intl.DateTimeFormat('en-CA', {timeZone}).format();
  } catch {
    fail(`invalid business time zone: ${timeZone}`);
  }
  return timeZone;
}

export function businessDateAtEpoch(epoch = Math.floor(Date.now() / 1000), timeZone = 'Asia/Shanghai') {
  const seconds = Number(epoch);
  if (!Number.isSafeInteger(seconds) || seconds < 0) fail(`invalid epoch: ${epoch}`);
  const zone = normalizeTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(seconds * 1000));
  const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function normalizeEpoch(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^[1-9][0-9]*$/.test(raw)) fail(`${label} must be a positive Unix epoch second`);
  const epoch = Number(raw);
  if (!Number.isSafeInteger(epoch)) fail(`${label} is outside the safe integer range`);
  return epoch;
}

function normalizeMaxGroups(value) {
  const raw = String(value ?? '').trim();
  if (!/^[1-9][0-9]*$/.test(raw)) fail('maxGroups must be an integer from 1 through 32');
  const maxGroups = Number(raw);
  if (!Number.isSafeInteger(maxGroups) || maxGroups < IMMEDIATE_MIN_GROUPS || maxGroups > IMMEDIATE_MAX_GROUPS) {
    fail('maxGroups must be an integer from 1 through 32');
  }
  return maxGroups;
}

function normalizeSha256(value, label) {
  const hash = String(value ?? '').trim().toLowerCase();
  if (!SHA256_RE.test(hash)) fail(`${label} must be a 64-hex SHA-256`);
  return hash;
}

function normalizeReason(value) {
  const reason = String(value ?? '').trim();
  if (!reason) fail('reason is required and must be non-secret human text');
  if (reason.length > 240 || /[\0\r\n]/.test(reason)) {
    fail('reason must be non-secret single-line text no longer than 240 characters');
  }
  if (/-----BEGIN|bearer\s+|password\s*=|cookie\s*=|secret\s*=|api[_-]?key\s*=/i.test(reason)) {
    fail('reason must not contain credential-like material');
  }
  return reason;
}

function normalizeConfirmationToken(value) {
  if (String(value ?? '') !== IMMEDIATE_CONFIRMATION_TOKEN) {
    fail(`issue requires the exact confirmation token: ${IMMEDIATE_CONFIRMATION_TOKEN}`, 'IMMEDIATE_AUTHORIZATION_CONFIRMATION_REQUIRED');
  }
  return IMMEDIATE_CONFIRMATION_TOKEN;
}

function normalizeAuthorizationId(value) {
  const authorizationId = String(value ?? '').trim();
  if (!UUID_RE.test(authorizationId)) fail('authorizationId must be a UUID');
  return authorizationId.toLowerCase();
}

function hashBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function readRegularFile(file, label) {
  const absolute = normalizeAbsolutePath(file, label);
  let pathStat;
  try {
    pathStat = await fs.lstat(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT') fail(`${label} does not exist: ${absolute}`, 'IMMEDIATE_AUTHORIZATION_MISSING');
    throw error;
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) fail(`${label} must be a regular non-symlink file: ${absolute}`);
  let handle;
  try {
    handle = await fs.open(absolute, fsSync.constants.O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    if (error?.code === 'ENOENT') fail(`${label} does not exist: ${absolute}`, 'IMMEDIATE_AUTHORIZATION_MISSING');
    fail(`${label} cannot be opened safely: ${error.message}`, 'IMMEDIATE_AUTHORIZATION_FILE_OPEN_FAILED');
  }
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || openedStat.isSymbolicLink()) {
      fail(`${label} must be a regular non-symlink file: ${absolute}`);
    }
    if (!sameFileIdentity(pathStat, openedStat)) {
      fail(`${label} path or descriptor identity changed between lstat and open`, 'IMMEDIATE_AUTHORIZATION_FILE_RACE');
    }
    const bytes = await handle.readFile();
    const afterRead = await handle.stat();
    if (!sameFileIdentity(openedStat, afterRead)) {
      fail(`${label} changed while reading`, 'IMMEDIATE_AUTHORIZATION_FILE_RACE');
    }
    const pathAfter = await fs.lstat(absolute);
    if (!sameFileIdentity(afterRead, pathAfter)) {
      fail(`${label} path no longer refers to the opened descriptor`, 'IMMEDIATE_AUTHORIZATION_FILE_PATH_SWAPPED');
    }
    return {file: absolute, bytes, sha256: hashBytes(bytes), stat: afterRead};
  } finally {
    await handle.close();
  }
}

function sameFileIdentity(left, right) {
  return Boolean(left && right)
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function readJsonFile(file, label) {
  const snapshot = await readRegularFile(file, label);
  let value;
  try {
    value = JSON.parse(snapshot.bytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
  return {...snapshot, value: assertObject(value, label)};
}

function sameDirectoryIdentity(left, right) {
  return Boolean(left && right)
    && left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.gid === right.gid
    && (left.mode & 0o7777) === (right.mode & 0o7777)
    && left.isDirectory()
    && right.isDirectory();
}

async function inspectDirectoryChain(directory) {
  const resolved = path.resolve(directory);
  const root = path.parse(resolved).root;
  const relative = path.relative(root, resolved);
  const components = relative ? relative.split(path.sep).filter(Boolean) : [];
  let current = root;
  const chain = [];
  let stat = await fs.lstat(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail(`authorization directory root must be a regular directory: ${root}`,
      'IMMEDIATE_AUTHORIZATION_DIRECTORY_INVALID');
  }
  chain.push({path: root, stat});
  for (const component of components) {
    current = path.join(current, component);
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        fail(`authorization directory ancestor must already exist: ${current}`,
          'IMMEDIATE_AUTHORIZATION_DIRECTORY_MISSING');
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      fail(`authorization directory ancestor must not be a symlink: ${current}`,
        'IMMEDIATE_AUTHORIZATION_DIRECTORY_ANCESTOR_SYMLINK');
    }
    if (!stat.isDirectory()) {
      fail(`authorization directory ancestor must be a directory: ${current}`,
        'IMMEDIATE_AUTHORIZATION_DIRECTORY_INVALID');
    }
    chain.push({path: current, stat});
  }
  return {directory: resolved, stat, chain};
}

function assertFixedAuthorizationAncestors(inspected) {
  if (process.platform === 'win32') return;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  for (const entry of inspected.chain.slice(0, -1)) {
    const mode = entry.stat.mode & 0o777;
    if (entry.stat.uid !== 0) {
      fail(`authorization directory ancestor must be root-owned: ${entry.path}`,
        'IMMEDIATE_AUTHORIZATION_DIRECTORY_ANCESTOR_OWNER_MISMATCH');
    }
    if ((mode & 0o022) !== 0) {
      fail(`authorization directory ancestor must not be group/other writable: ${entry.path}`,
        'IMMEDIATE_AUTHORIZATION_DIRECTORY_ANCESTOR_MODE_INVALID');
    }
    if (uid !== null && uid !== 0 && entry.stat.uid === uid) {
      fail(`authorization directory ancestor must not be owned by the current service uid: ${entry.path}`,
        'IMMEDIATE_AUTHORIZATION_DIRECTORY_ANCESTOR_OWNER_MISMATCH');
    }
  }
}

function sameDirectoryChain(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((entry, index) => entry.path === right[index]?.path
      && sameDirectoryIdentity(entry.stat, right[index]?.stat));
}

function assertCurrentUidOwner(stat, label, target) {
  if (process.platform === 'win32') return;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid === null || stat.uid !== uid) {
    fail(`${label} owner must be the current service uid: ${target}`,
      'IMMEDIATE_AUTHORIZATION_FILE_OWNER_MISMATCH');
  }
}

async function assertAuthorizationDirectory(file) {
  const target = normalizeAbsolutePath(file, 'authorizationFile');
  const directory = path.dirname(target);
  const inspected = await inspectDirectoryChain(directory);
  assertFixedAuthorizationAncestors(inspected);
  const stat = inspected.stat;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`authorization directory must be a regular non-symlink directory: ${directory}`,
      'IMMEDIATE_AUTHORIZATION_DIRECTORY_INVALID');
  }
  if (process.platform !== 'win32') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (uid === null || stat.uid !== uid) {
      fail(`authorization directory owner must be the current service uid: ${directory}`,
        'IMMEDIATE_AUTHORIZATION_DIRECTORY_OWNER_MISMATCH');
    }
    const mode = stat.mode & 0o777;
    if ((mode & 0o077) !== 0 || (mode & 0o700) !== 0o700) {
      fail(`authorization directory must be owner-writable/searchable and 0700 or stricter: ${directory}`,
        'IMMEDIATE_AUTHORIZATION_DIRECTORY_MODE_INVALID');
    }
  }
  return {target, directory, stat, chain: inspected.chain};
}

async function assertAuthorizationDirectoryUnchanged(expected, file, label) {
  const current = await assertAuthorizationDirectory(file);
  if (current.directory !== expected.directory
    || !sameDirectoryIdentity(expected.stat, current.stat)
    || !sameDirectoryChain(expected.chain, current.chain)) {
    fail(`${label} authorization directory identity changed: ${expected.directory}`,
      'IMMEDIATE_AUTHORIZATION_DIRECTORY_RACE');
  }
  return current;
}

async function assertRegularFileSnapshotCurrent(snapshot, label) {
  let current;
  try {
    current = await fs.lstat(snapshot.file);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      fail(`${label} disappeared after validation: ${snapshot.file}`,
        'IMMEDIATE_AUTHORIZATION_FILE_RACE');
    }
    throw error;
  }
  if (!current.isFile() || current.isSymbolicLink() || !sameFileIdentity(snapshot.stat, current)) {
    fail(`${label} changed after validation: ${snapshot.file}`,
      'IMMEDIATE_AUTHORIZATION_FILE_RACE');
  }
}

async function readAuthorizationJsonFile(file, label) {
  const {target, directory, stat: directoryStat, chain: directoryChain} = await assertAuthorizationDirectory(file);
  const snapshot = await readJsonFile(target, label);
  const directoryAfter = await assertAuthorizationDirectory(target);
  if (directoryAfter.directory !== directory
    || !sameDirectoryIdentity(directoryStat, directoryAfter.stat)
    || !sameDirectoryChain(directoryChain, directoryAfter.chain)) {
    fail(`${label} authorization directory changed while reading: ${directory}`,
      'IMMEDIATE_AUTHORIZATION_DIRECTORY_RACE');
  }
  if (process.platform !== 'win32') {
    if ((snapshot.stat.mode & 0o777) !== 0o600) {
      fail(`${label} must have mode 0600: ${target}`, 'IMMEDIATE_AUTHORIZATION_FILE_MODE_INVALID');
    }
    assertCurrentUidOwner(snapshot.stat, label, target);
  }
  return snapshot;
}

async function hasConsumedReceiptFor(authorizationFile, authorizationId) {
  const receipt = deriveConsumedAuthorizationFile(authorizationFile, authorizationId);
  try {
    const stat = await fs.lstat(receipt);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function hasAnyConsumedReceiptForMissingSource(authorizationFile) {
  const source = normalizeAbsolutePath(authorizationFile, 'authorizationFile');
  const prefix = `${path.basename(source)}.consumed.`;
  try {
    return (await fs.readdir(path.dirname(source)))
      .some(name => name.startsWith(prefix) && name.endsWith('.json'));
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function resolveSourceGuardPath(root, sourceGuard) {
  const rootPath = normalizeAbsolutePath(root || MODULE_ROOT, 'root');
  const raw = String(sourceGuard ?? '').trim();
  if (!raw || /[\0\r\n]/.test(raw)) fail('queue sourceGuard must be a non-empty single-line path');
  const guardPath = path.resolve(rootPath, raw);
  const relative = path.relative(rootPath, guardPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(`queue sourceGuard escapes root: ${raw}`);
  }
  return guardPath;
}

function assertQueuePair(queue) {
  return {
    queueFingerprint: normalizeSha256(queue?.queueFingerprint, 'queue.queueFingerprint'),
    sourceGuardHash: normalizeSha256(queue?.sourceGuardHash, 'queue.sourceGuardHash'),
  };
}

async function readQueueBinding({queueFile, root, date, sourceGuardFile}) {
  const snapshot = await readJsonFile(queueFile, 'queue file');
  const queueDate = normalizeDate(snapshot.value?.date, 'queue.date');
  if (date && queueDate !== date) {
    fail(`queue business date mismatch: expected=${date} actual=${queueDate}`,
      'IMMEDIATE_AUTHORIZATION_BINDING_MISMATCH');
  }
  const {queueFingerprint, sourceGuardHash} = assertQueuePair(snapshot.value);
  const sourceGuardPath = sourceGuardFile !== undefined
    ? normalizeAbsolutePath(sourceGuardFile, 'sourceGuardFile')
    : resolveSourceGuardPath(root, snapshot.value.sourceGuard);
  const sourceGuard = await readRegularFile(sourceGuardPath, sourceGuardFile !== undefined ? 'source guard file' : 'queue sourceGuard');
  if (sourceGuard.sha256 !== sourceGuardHash) {
    fail(`queue sourceGuardHash mismatch: queue=${sourceGuardHash} actual=${sourceGuard.sha256}`,
      'IMMEDIATE_AUTHORIZATION_BINDING_MISMATCH');
  }
  return {
    queueFile: snapshot.file,
    queueStateSha256: snapshot.sha256,
    queueFingerprint,
    sourceGuardHash,
    sourceGuardPath,
    date: queueDate,
  };
}

function normalizeRecord(record) {
  assertObject(record, 'authorization record');
  if (record.schemaVersion !== IMMEDIATE_AUTHORIZATION_SCHEMA_VERSION) {
    fail(`unsupported authorization schemaVersion: ${record.schemaVersion ?? 'missing'}`);
  }
  if (record.mode !== IMMEDIATE_AUTHORIZATION_MODE) fail(`unsupported authorization mode: ${record.mode || 'missing'}`);
  const status = String(record.status || '').trim();
  if (status !== 'issued' && status !== 'claimed' && status !== 'consumed') {
    fail(`authorization status must be issued, claimed, or consumed: ${status || 'missing'}`);
  }
  const authorizationId = normalizeAuthorizationId(record.authorizationId);
  const date = normalizeDate(record.date, 'authorization.date');
  const queueFile = normalizeAbsolutePath(record.queueFile, 'authorization.queueFile');
  const queueStateSha256 = normalizeSha256(record.queueStateSha256 || record.queueFileSha256, 'authorization.queueStateSha256');
  const queueFingerprint = normalizeSha256(record.queueFingerprint, 'authorization.queueFingerprint');
  const sourceGuardHash = normalizeSha256(record.sourceGuardHash, 'authorization.sourceGuardHash');
  const maxGroups = normalizeMaxGroups(record.maxGroups);
  const gracefulCutoffEpoch = normalizeEpoch(record.gracefulCutoffEpoch, 'authorization.gracefulCutoffEpoch');
  const outerHardDeadlineEpoch = normalizeEpoch(record.outerHardDeadlineEpoch, 'authorization.outerHardDeadlineEpoch');
  const issuedAtEpoch = normalizeEpoch(record.issuedAtEpoch, 'authorization.issuedAtEpoch');
  const reason = normalizeReason(record.reason);
  if (record.queueFileSha256 !== undefined && normalizeSha256(record.queueFileSha256, 'authorization.queueFileSha256') !== queueStateSha256) {
    fail('authorization queueStateSha256 and queueFileSha256 disagree');
  }
  if (record.gracefulCutoffAt !== undefined && String(record.gracefulCutoffAt) !== new Date(gracefulCutoffEpoch * 1000).toISOString()) {
    fail('authorization gracefulCutoffAt does not match gracefulCutoffEpoch');
  }
  if (record.outerHardDeadlineAt !== undefined && String(record.outerHardDeadlineAt) !== new Date(outerHardDeadlineEpoch * 1000).toISOString()) {
    fail('authorization outerHardDeadlineAt does not match outerHardDeadlineEpoch');
  }
  assertDeadlinePair(gracefulCutoffEpoch, outerHardDeadlineEpoch);
  if (record.deadlineEpoch !== undefined || record.deadlineAt !== undefined) {
    fail('authorization must bind gracefulCutoffEpoch and outerHardDeadlineEpoch separately');
  }
  if (status === 'claimed') {
    const claimedAtEpoch = normalizeEpoch(record.claimedAtEpoch, 'authorization.claimedAtEpoch');
    const claimedFrom = normalizeAbsolutePath(record.claimedFrom, 'authorization.claimedFrom');
    const claimedReceiptFile = normalizeAbsolutePath(record.claimedReceiptFile, 'authorization.claimedReceiptFile');
    if (claimedReceiptFile !== deriveConsumedAuthorizationFile(claimedFrom, authorizationId)) {
      fail('authorization claimedReceiptFile does not match claimedFrom and authorizationId');
    }
    return {
      ...record,
      status,
      authorizationId,
      date,
      queueFile,
      queueStateSha256,
      queueFileSha256: queueStateSha256,
      queueFingerprint,
      sourceGuardHash,
      maxGroups,
      gracefulCutoffEpoch,
      outerHardDeadlineEpoch,
      issuedAtEpoch,
      reason,
      claimedAtEpoch,
      claimedFrom,
      claimedReceiptFile,
    };
  }
  if (status === 'consumed') {
    const consumedAtEpoch = normalizeEpoch(record.consumedAtEpoch, 'authorization.consumedAtEpoch');
    const consumedFrom = normalizeAbsolutePath(record.consumedFrom, 'authorization.consumedFrom');
    const consumedReceiptFile = normalizeAbsolutePath(record.consumedReceiptFile, 'authorization.consumedReceiptFile');
    if (consumedReceiptFile !== deriveConsumedAuthorizationFile(consumedFrom, authorizationId)) {
      fail('authorization consumedReceiptFile does not match consumedFrom and authorizationId');
    }
    return {
      ...record,
      status,
      authorizationId,
      date,
      queueFile,
      queueStateSha256,
      queueFileSha256: queueStateSha256,
      queueFingerprint,
      sourceGuardHash,
      maxGroups,
      gracefulCutoffEpoch,
      outerHardDeadlineEpoch,
      issuedAtEpoch,
      reason,
      consumedAtEpoch,
      consumedFrom,
      consumedReceiptFile,
    };
  }
  return {
    ...record,
    status,
    authorizationId,
    date,
    queueFile,
    queueStateSha256,
    queueFileSha256: queueStateSha256,
    queueFingerprint,
    sourceGuardHash,
    maxGroups,
    gracefulCutoffEpoch,
    outerHardDeadlineEpoch,
    issuedAtEpoch,
    reason,
  };
}

function assertDeadlinePair(gracefulCutoffEpoch, outerHardDeadlineEpoch) {
  const minimumOuter = gracefulCutoffEpoch + IMMEDIATE_MIN_DEADLINE_SEPARATION_SEC;
  if (!Number.isSafeInteger(minimumOuter) || outerHardDeadlineEpoch < minimumOuter) {
    fail(`outerHardDeadlineEpoch must be at least ${IMMEDIATE_MIN_DEADLINE_SEPARATION_SEC}s after gracefulCutoffEpoch`);
  }
}

function assertRecordBinding(record, queue, {
  date,
  nowEpoch,
  timeZone,
  requireCurrentDate = true,
  continuation = false,
} = {}) {
  const expectedDate = date ? normalizeDate(date) : record.date;
  if (record.date !== expectedDate || queue.date !== expectedDate) {
    fail(`authorization business date mismatch: authorization=${record.date} queue=${queue.date} expected=${expectedDate}`,
      'IMMEDIATE_AUTHORIZATION_BINDING_MISMATCH');
  }
  if (requireCurrentDate && businessDateAtEpoch(nowEpoch, timeZone) !== expectedDate) {
    fail(`authorization is not for the current business date: authorization=${expectedDate} current=${businessDateAtEpoch(nowEpoch, timeZone)}`);
  }
  if (record.queueFile !== queue.queueFile) {
    fail(`authorization queue file mismatch: authorization=${record.queueFile} current=${queue.queueFile}`,
      'IMMEDIATE_AUTHORIZATION_BINDING_MISMATCH');
  }
  if (record.queueStateSha256 !== queue.queueStateSha256) {
    fail(`authorization queue file SHA-256 mismatch: authorization=${record.queueStateSha256} current=${queue.queueStateSha256}`,
      'IMMEDIATE_AUTHORIZATION_BINDING_MISMATCH');
  }
  if (record.queueFingerprint !== queue.queueFingerprint) {
    fail(`authorization queueFingerprint mismatch: authorization=${record.queueFingerprint} current=${queue.queueFingerprint}`,
      'IMMEDIATE_AUTHORIZATION_BINDING_MISMATCH');
  }
  if (record.sourceGuardHash !== queue.sourceGuardHash) {
    fail(`authorization sourceGuardHash mismatch: authorization=${record.sourceGuardHash} current=${queue.sourceGuardHash}`,
      'IMMEDIATE_AUTHORIZATION_BINDING_MISMATCH');
  }
  const currentEpoch = Number(nowEpoch);
  if (!Number.isSafeInteger(currentEpoch) || currentEpoch < 0) fail(`invalid current epoch: ${nowEpoch}`);
  if (businessDateAtEpoch(record.gracefulCutoffEpoch, timeZone) !== expectedDate) {
    fail(`authorization graceful cutoff leaves the business date: gracefulCutoff=${record.gracefulCutoffEpoch} date=${expectedDate}`);
  }
  if (businessDateAtEpoch(record.outerHardDeadlineEpoch, timeZone) !== expectedDate) {
    fail(`authorization outer hard deadline leaves the business date: outerHardDeadline=${record.outerHardDeadlineEpoch} date=${expectedDate}`);
  }
  const gracefulRemainingSec = record.gracefulCutoffEpoch - currentEpoch;
  const outerRemainingSec = record.outerHardDeadlineEpoch - currentEpoch;
  if (!continuation && gracefulRemainingSec < IMMEDIATE_MIN_REMAINING_SEC) {
    fail(`authorization graceful cutoff has insufficient remaining budget: ${gracefulRemainingSec}s < ${IMMEDIATE_MIN_REMAINING_SEC}s`, 'IMMEDIATE_AUTHORIZATION_EXPIRED');
  }
  if ((!continuation && outerRemainingSec < IMMEDIATE_MIN_REMAINING_SEC) || (continuation && outerRemainingSec <= 0)) {
    fail(`authorization outer hard deadline has insufficient remaining budget: ${outerRemainingSec}s < ${IMMEDIATE_MIN_REMAINING_SEC}s`, 'IMMEDIATE_AUTHORIZATION_EXPIRED');
  }
  if (record.maxGroups < IMMEDIATE_MIN_GROUPS || record.maxGroups > IMMEDIATE_MAX_GROUPS) {
    fail(`authorization maxGroups is outside 1 through 32: ${record.maxGroups}`);
  }
  return {remainingSec: gracefulRemainingSec, gracefulRemainingSec, outerRemainingSec, date: expectedDate};
}

function assertExpectedAuthorizationBinding(record, {
  expectedAuthorizationId,
  expectedQueueStateSha256,
  expectedQueueFingerprint,
  expectedSourceGuardHash,
  expectedMaxGroups,
  expectedGracefulCutoffEpoch,
  expectedOuterHardDeadlineEpoch,
  expectedReason,
} = {}) {
  const expected = [
    ['authorizationId', expectedAuthorizationId, record.authorizationId, normalizeAuthorizationId],
    ['queueStateSha256', expectedQueueStateSha256, record.queueStateSha256, value => normalizeSha256(value, 'expectedQueueStateSha256')],
    ['queueFingerprint', expectedQueueFingerprint, record.queueFingerprint, value => normalizeSha256(value, 'expectedQueueFingerprint')],
    ['sourceGuardHash', expectedSourceGuardHash, record.sourceGuardHash, value => normalizeSha256(value, 'expectedSourceGuardHash')],
    ['maxGroups', expectedMaxGroups, record.maxGroups, normalizeMaxGroups],
    ['gracefulCutoffEpoch', expectedGracefulCutoffEpoch, record.gracefulCutoffEpoch, value => normalizeEpoch(value, 'expectedGracefulCutoffEpoch')],
    ['outerHardDeadlineEpoch', expectedOuterHardDeadlineEpoch, record.outerHardDeadlineEpoch, value => normalizeEpoch(value, 'expectedOuterHardDeadlineEpoch')],
  ];
  for (const [label, expectedValue, actualValue, normalize] of expected) {
    if (expectedValue === undefined || expectedValue === null || String(expectedValue).trim() === '') continue;
    if (normalize(expectedValue) !== actualValue) {
      fail(`authorization ${label} differs from the locked admission binding`, 'IMMEDIATE_AUTHORIZATION_BINDING_MISMATCH');
    }
  }
  if (expectedReason !== undefined && String(expectedReason) !== record.reason) {
    fail('authorization reason differs from the locked admission binding', 'IMMEDIATE_AUTHORIZATION_BINDING_MISMATCH');
  }
}

function assertIssuedRecord(record, {nowEpoch, timeZone}) {
  if (record.status !== 'issued') fail(`authorization is not available for one-time consume: status=${record.status}`, 'IMMEDIATE_AUTHORIZATION_ALREADY_CONSUMED');
  if (record.issuedAtEpoch > nowEpoch) fail('authorization issuedAtEpoch is in the future');
  if (record.gracefulCutoffEpoch <= record.issuedAtEpoch) fail('authorization graceful cutoff must be after issuedAtEpoch');
  if (record.gracefulCutoffEpoch - record.issuedAtEpoch < IMMEDIATE_MIN_REMAINING_SEC) {
    fail(`authorization graceful cutoff must be at least ${IMMEDIATE_MIN_REMAINING_SEC}s after issuedAtEpoch`, 'IMMEDIATE_AUTHORIZATION_EXPIRED');
  }
  if (record.outerHardDeadlineEpoch - record.issuedAtEpoch > IMMEDIATE_MAX_TTL_SEC) {
    fail(`authorization outer deadline lifetime exceeds ${IMMEDIATE_MAX_TTL_SEC}s`, 'IMMEDIATE_AUTHORIZATION_TOO_LONG');
  }
  if (businessDateAtEpoch(record.issuedAtEpoch, timeZone) !== record.date) {
    fail('authorization issuedAtEpoch does not belong to authorization business date');
  }
  if (businessDateAtEpoch(record.gracefulCutoffEpoch, timeZone) !== record.date) {
    fail('authorization graceful cutoff must remain inside the authorization business date');
  }
  if (businessDateAtEpoch(record.outerHardDeadlineEpoch, timeZone) !== record.date) {
    fail('authorization outer hard deadline must remain inside the authorization business date');
  }
}

function assertConsumedRecord(record, {nowEpoch}) {
  if (record.status !== 'consumed') fail(`authorization receipt is not consumed: status=${record.status || 'missing'}`);
  if (record.consumedAtEpoch > nowEpoch) fail('authorization consumedAtEpoch is in the future');
  if (record.consumedAtEpoch < record.issuedAtEpoch) fail('authorization consumedAtEpoch precedes issuedAtEpoch');
}

function assertClaimedRecord(record, {nowEpoch}) {
  if (record.status !== 'claimed') fail(`authorization receipt is not claimed: status=${record.status || 'missing'}`);
  if (record.claimedAtEpoch > nowEpoch) fail('authorization claimedAtEpoch is in the future');
  if (record.claimedAtEpoch < record.issuedAtEpoch) fail('authorization claimedAtEpoch precedes issuedAtEpoch');
}

export function deriveConsumedAuthorizationFile(authorizationFile, authorizationId) {
  const source = normalizeAbsolutePath(authorizationFile, 'authorizationFile');
  const id = normalizeAuthorizationId(authorizationId);
  return `${source}.consumed.${id}.json`;
}

async function writeExclusiveJson(file, value, {
  existingCode = 'IMMEDIATE_AUTHORIZATION_ALREADY_ISSUED',
  existingMessage = 'authorization file already exists; refusing replacement',
} = {}) {
  const {target, directory, stat: directoryStat} = await assertAuthorizationDirectory(file);
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    // A hard-link publication is atomic and cannot replace an existing
    // authorization. Readers therefore see either no artifact or one complete
    // artifact, never a partially written JSON file.
    await fs.link(temporary, target);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      fail(`${existingMessage}: ${target}`, existingCode);
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, {force: true}).catch(() => {});
  }
  const directoryAfter = await assertAuthorizationDirectory(target);
  if (directoryAfter.directory !== directory || !sameDirectoryIdentity(directoryStat, directoryAfter.stat)) {
    fail(`authorization directory changed while publishing: ${directory}`,
      'IMMEDIATE_AUTHORIZATION_DIRECTORY_RACE');
  }
  if (process.platform !== 'win32') {
    await fs.chmod(target, 0o600);
    const published = await fs.lstat(target);
    if (!published.isFile() || published.isSymbolicLink() || (published.mode & 0o777) !== 0o600) {
      fail(`authorization file must be published with mode 0600: ${target}`, 'IMMEDIATE_AUTHORIZATION_FILE_MODE_INVALID');
    }
    assertCurrentUidOwner(published, 'authorization file', target);
  }
  return target;
}

export async function issueImmediateAuthorization({
  authorizationFile = process.env.SHEIN_BI_MARKETING_IMMEDIATE_AUTHORIZATION_FILE || DEFAULT_IMMEDIATE_AUTHORIZATION_FILE,
  queueFile,
  root = process.env.SHEIN_BI_ROOT || MODULE_ROOT,
  sourceGuardFile,
  date,
  maxGroups,
  confirmationToken,
  gracefulCutoffEpoch,
  outerHardDeadlineEpoch,
  // Kept as a narrow compatibility alias for callers of the pre-review API;
  // it always means the graceful cutoff, never the host hard deadline.
  deadlineEpoch,
  ttlSec = IMMEDIATE_DEFAULT_TTL_SEC,
  reason,
  nowEpoch = Math.floor(Date.now() / 1000),
  timeZone = process.env.SHEIN_BI_TZ || 'Asia/Shanghai',
} = {}) {
  normalizeConfirmationToken(confirmationToken);
  if (sourceGuardFile === undefined || sourceGuardFile === null || String(sourceGuardFile).trim() === '') {
    fail('issue requires an explicit --source-guard-file host physical path', 'IMMEDIATE_AUTHORIZATION_USAGE');
  }
  const normalizedDate = normalizeDate(date);
  await assertAuthorizationDirectory(authorizationFile);
  const now = normalizeEpoch(nowEpoch, 'nowEpoch');
  const zone = normalizeTimeZone(timeZone);
  if (businessDateAtEpoch(now, zone) !== normalizedDate) {
    fail(`authorization date must be the current business date: requested=${normalizedDate} current=${businessDateAtEpoch(now, zone)}`);
  }
  const groups = normalizeMaxGroups(maxGroups);
  if (gracefulCutoffEpoch !== undefined && deadlineEpoch !== undefined
    && String(gracefulCutoffEpoch).trim() !== String(deadlineEpoch).trim()) {
    fail('gracefulCutoffEpoch and legacy deadlineEpoch disagree');
  }
  const gracefulInput = gracefulCutoffEpoch !== undefined && gracefulCutoffEpoch !== null && String(gracefulCutoffEpoch).trim() !== ''
    ? gracefulCutoffEpoch
    : deadlineEpoch;
  let graceful;
  if (gracefulInput !== undefined && gracefulInput !== null && String(gracefulInput).trim() !== '') {
    graceful = normalizeEpoch(gracefulInput, 'gracefulCutoffEpoch');
  } else {
    const ttl = Number(String(ttlSec ?? '').trim());
    if (!Number.isSafeInteger(ttl) || ttl < IMMEDIATE_MIN_REMAINING_SEC) {
      fail(`ttlSec must be an integer of at least ${IMMEDIATE_MIN_REMAINING_SEC}s`);
    }
    graceful = now + ttl;
  }
  const outer = outerHardDeadlineEpoch !== undefined && outerHardDeadlineEpoch !== null
    && String(outerHardDeadlineEpoch).trim() !== ''
    ? normalizeEpoch(outerHardDeadlineEpoch, 'outerHardDeadlineEpoch')
    : graceful + IMMEDIATE_MIN_DEADLINE_SEPARATION_SEC;
  if (graceful - now < IMMEDIATE_MIN_REMAINING_SEC) {
    fail(`graceful cutoff must leave at least ${IMMEDIATE_MIN_REMAINING_SEC}s at issue time`, 'IMMEDIATE_AUTHORIZATION_EXPIRED');
  }
  assertDeadlinePair(graceful, outer);
  if (outer - now > IMMEDIATE_MAX_TTL_SEC) {
    fail(`outer hard deadline must be no more than ${IMMEDIATE_MAX_TTL_SEC}s from issue time`, 'IMMEDIATE_AUTHORIZATION_TOO_LONG');
  }
  if (businessDateAtEpoch(graceful, zone) !== normalizedDate) {
    fail(`graceful cutoff must remain inside the authorization business date: ${normalizedDate}`);
  }
  if (businessDateAtEpoch(outer, zone) !== normalizedDate) {
    fail(`outer hard deadline must remain inside the authorization business date: ${normalizedDate}`);
  }
  const queue = await readQueueBinding({queueFile, root, date: normalizedDate, sourceGuardFile});
  const authorizationId = crypto.randomUUID();
  const record = {
    schemaVersion: IMMEDIATE_AUTHORIZATION_SCHEMA_VERSION,
    mode: IMMEDIATE_AUTHORIZATION_MODE,
    status: 'issued',
    authorizationId,
    issuedAt: new Date(now * 1000).toISOString(),
    issuedAtEpoch: now,
    date: normalizedDate,
    queueFile: queue.queueFile,
    queueStateSha256: queue.queueStateSha256,
    queueFileSha256: queue.queueStateSha256,
    queueFingerprint: queue.queueFingerprint,
    sourceGuardHash: queue.sourceGuardHash,
    maxGroups: groups,
    gracefulCutoffAt: new Date(graceful * 1000).toISOString(),
    gracefulCutoffEpoch: graceful,
    outerHardDeadlineAt: new Date(outer * 1000).toISOString(),
    outerHardDeadlineEpoch: outer,
    reason: normalizeReason(reason),
  };
  await writeExclusiveJson(authorizationFile, record);
  return {
    ok: true,
    ...record,
    authorizationFile: normalizeAbsolutePath(authorizationFile, 'authorizationFile'),
    sourceGuardPath: queue.sourceGuardPath,
    remainingSecAtIssue: graceful - now,
    gracefulRemainingSecAtIssue: graceful - now,
    outerRemainingSecAtIssue: outer - now,
  };
}

export async function consumeImmediateAuthorization({
  authorizationFile = process.env.SHEIN_BI_MARKETING_IMMEDIATE_AUTHORIZATION_FILE || DEFAULT_IMMEDIATE_AUTHORIZATION_FILE,
  queueFile,
  root = process.env.SHEIN_BI_ROOT || MODULE_ROOT,
  date,
  nowEpoch = Math.floor(Date.now() / 1000),
  timeZone = process.env.SHEIN_BI_TZ || 'Asia/Shanghai',
  expectedAuthorizationId,
  expectedAuthorizationFileSha256,
  expectedQueueStateSha256,
  expectedQueueFingerprint,
  expectedSourceGuardHash,
  expectedMaxGroups,
  expectedGracefulCutoffEpoch,
  expectedOuterHardDeadlineEpoch,
  expectedReason,
  receiptWriter = writeJsonFileAtomic,
} = {}) {
  const now = normalizeEpoch(nowEpoch, 'nowEpoch');
  const zone = normalizeTimeZone(timeZone);
  const normalizedDate = normalizeDate(date);
  if (businessDateAtEpoch(now, zone) !== normalizedDate) {
    fail(`authorization consume date must be the current business date: requested=${normalizedDate} current=${businessDateAtEpoch(now, zone)}`);
  }
  const authorizationDirectory = await assertAuthorizationDirectory(authorizationFile);
  let auth;
  try {
    auth = await readAuthorizationJsonFile(authorizationFile, 'immediate authorization');
  } catch (error) {
    if (error?.code === 'IMMEDIATE_AUTHORIZATION_MISSING'
      && ((expectedAuthorizationId && await hasConsumedReceiptFor(authorizationFile, expectedAuthorizationId))
        || (!expectedAuthorizationId && await hasAnyConsumedReceiptForMissingSource(authorizationFile)))) {
      fail('authorization has already been consumed; replay is forbidden', 'IMMEDIATE_AUTHORIZATION_ALREADY_CONSUMED');
    }
    throw error;
  }
  const record = normalizeRecord(auth.value);
  if (await hasConsumedReceiptFor(authorizationFile, record.authorizationId)) {
    fail('authorization has already been claimed or consumed; replay is forbidden',
      'IMMEDIATE_AUTHORIZATION_ALREADY_CONSUMED');
  }
  if (expectedAuthorizationFileSha256 !== undefined && String(expectedAuthorizationFileSha256).trim() !== '') {
    if (normalizeSha256(expectedAuthorizationFileSha256, 'expectedAuthorizationFileSha256') !== auth.sha256) {
      fail('authorization file differs from the locked admission binding', 'IMMEDIATE_AUTHORIZATION_BINDING_MISMATCH');
    }
  }
  assertIssuedRecord(record, {nowEpoch: now, timeZone: zone});
  const queue = await readQueueBinding({queueFile, root, date: normalizedDate});
  const {remainingSec} = assertRecordBinding(record, queue, {
    date: normalizedDate,
    nowEpoch: now,
    timeZone: zone,
  });
  assertExpectedAuthorizationBinding(record, {
    expectedAuthorizationId,
    expectedQueueStateSha256,
    expectedQueueFingerprint,
    expectedSourceGuardHash,
    expectedMaxGroups,
    expectedGracefulCutoffEpoch,
    expectedOuterHardDeadlineEpoch,
    expectedReason,
  });
  if (typeof receiptWriter !== 'function') fail('receiptWriter must be a function');
  await assertAuthorizationDirectoryUnchanged(authorizationDirectory, authorizationFile, 'consume');
  await assertRegularFileSnapshotCurrent(auth, 'immediate authorization');
  const consumedFile = deriveConsumedAuthorizationFile(auth.file, record.authorizationId);
  const claimedAtEpoch = now;
  const claimedRecord = {
    ...record,
    status: 'claimed',
    claimedAt: new Date(claimedAtEpoch * 1000).toISOString(),
    claimedAtEpoch,
    claimedFrom: auth.file,
    claimedReceiptFile: consumedFile,
  };
  await writeExclusiveJson(consumedFile, claimedRecord, {
    existingCode: 'IMMEDIATE_AUTHORIZATION_ALREADY_CONSUMED',
    existingMessage: 'authorization has already been claimed or consumed',
  });
  const claimedReceipt = await readAuthorizationJsonFile(consumedFile, 'claimed authorization receipt');
  const normalizedClaim = normalizeRecord(claimedReceipt.value);
  assertClaimedRecord(normalizedClaim, {nowEpoch: now});
  await assertAuthorizationDirectoryUnchanged(authorizationDirectory, authorizationFile, 'claim');
  await assertRegularFileSnapshotCurrent(auth, 'immediate authorization');
  try {
    await fs.unlink(auth.file);
  } catch (error) {
    fail(`authorization is claimed but source unlink failed; replay remains forbidden: ${error.message}`,
      'IMMEDIATE_AUTHORIZATION_CLAIMED_SOURCE_UNLINK_FAILED');
  }

  const consumedAtEpoch = now;
  const consumedRecord = {
    ...record,
    status: 'consumed',
    consumedAt: new Date(consumedAtEpoch * 1000).toISOString(),
    consumedAtEpoch,
    consumedFrom: auth.file,
    consumedReceiptFile: consumedFile,
  };
  try {
    await receiptWriter(consumedFile, consumedRecord, {mode: 0o600});
  } catch (error) {
    let terminalStatus = 'claimed';
    try {
      const terminalReceipt = await readAuthorizationJsonFile(consumedFile, 'claimed authorization receipt');
      terminalStatus = String(normalizeRecord(terminalReceipt.value).status || 'claimed');
    } catch {}
    fail(`authorization token is irreversibly ${terminalStatus}, but consumed receipt finalization failed: ${error.message}`,
      'IMMEDIATE_AUTHORIZATION_CLAIMED_RECEIPT_FINALIZE_FAILED');
  }
  const receipt = await readAuthorizationJsonFile(consumedFile, 'consumed authorization receipt');
  await assertAuthorizationDirectoryUnchanged(authorizationDirectory, consumedFile, 'receipt finalization');
  const normalized = normalizeRecord(receipt.value);
  return {
    ok: true,
    ...normalized,
    authorizationFile: auth.file,
    authorizationFileSha256: auth.sha256,
    consumedReceiptFile: receipt.file,
    consumedReceiptSha256: receipt.sha256,
    remainingSecAtConsume: remainingSec,
  };
}

export async function verifyIssuedImmediateAuthorization({
  authorizationFile = process.env.SHEIN_BI_MARKETING_IMMEDIATE_AUTHORIZATION_FILE || DEFAULT_IMMEDIATE_AUTHORIZATION_FILE,
  queueFile,
  root = process.env.SHEIN_BI_ROOT || MODULE_ROOT,
  date,
  nowEpoch = Math.floor(Date.now() / 1000),
  timeZone = process.env.SHEIN_BI_TZ || 'Asia/Shanghai',
} = {}) {
  const now = normalizeEpoch(nowEpoch, 'nowEpoch');
  const zone = normalizeTimeZone(timeZone);
  const normalizedDate = normalizeDate(date);
  if (businessDateAtEpoch(now, zone) !== normalizedDate) {
    fail(`authorization verify date must be the current business date: requested=${normalizedDate} current=${businessDateAtEpoch(now, zone)}`);
  }
  await assertAuthorizationDirectory(authorizationFile);
  const auth = await readAuthorizationJsonFile(authorizationFile, 'immediate authorization');
  const record = normalizeRecord(auth.value);
  if (await hasConsumedReceiptFor(authorizationFile, record.authorizationId)) {
    fail('authorization has already been claimed or consumed; issued verification is forbidden',
      'IMMEDIATE_AUTHORIZATION_ALREADY_CONSUMED');
  }
  assertIssuedRecord(record, {nowEpoch: now, timeZone: zone});
  const queue = await readQueueBinding({queueFile, root, date: normalizedDate});
  const {remainingSec, gracefulRemainingSec, outerRemainingSec} = assertRecordBinding(record, queue, {
    date: normalizedDate,
    nowEpoch: now,
    timeZone: zone,
  });
  return {
    ok: true,
    ...record,
    authorizationFile: auth.file,
    authorizationFileSha256: auth.sha256,
    remainingSec,
    gracefulRemainingSec,
    outerRemainingSec,
    currentQueueStateSha256: queue.queueStateSha256,
    currentQueueFingerprint: queue.queueFingerprint,
    currentSourceGuardHash: queue.sourceGuardHash,
  };
}

export async function verifyConsumedImmediateAuthorization({
  receiptFile,
  queueFile,
  root = process.env.SHEIN_BI_ROOT || MODULE_ROOT,
  date,
  nowEpoch = Math.floor(Date.now() / 1000),
  timeZone = process.env.SHEIN_BI_TZ || 'Asia/Shanghai',
  expectedAuthorizationId,
  expectedQueueStateSha256,
  expectedQueueFingerprint,
  expectedSourceGuardHash,
  expectedMaxGroups,
  expectedGracefulCutoffEpoch,
  expectedOuterHardDeadlineEpoch,
  expectedReason,
  expectedReceiptSha256,
} = {}) {
  const now = normalizeEpoch(nowEpoch, 'nowEpoch');
  const normalizedDate = normalizeDate(date);
  const zone = normalizeTimeZone(timeZone);
  const receipt = await readAuthorizationJsonFile(receiptFile, 'consumed authorization receipt');
  if (expectedReceiptSha256 !== undefined && normalizeSha256(expectedReceiptSha256, 'expectedReceiptSha256') !== receipt.sha256) {
    fail(`consumed authorization receipt SHA-256 mismatch: expected=${String(expectedReceiptSha256).toLowerCase()} actual=${receipt.sha256}`);
  }
  const record = normalizeRecord(receipt.value);
  assertConsumedRecord(record, {nowEpoch: now});
  if (record.consumedReceiptFile !== receipt.file) fail('consumed authorization receipt path mismatch');
  const expectedReceiptFile = deriveConsumedAuthorizationFile(record.consumedFrom, record.authorizationId);
  if (expectedReceiptFile !== receipt.file) fail('consumed authorization receipt is not the canonical one-time receipt path');
  const sourceStillExists = await fs.lstat(record.consumedFrom).then(() => true).catch(error => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  if (sourceStillExists) fail('consumed authorization source still exists; one-time claim is not closed');
  const queue = await readQueueBinding({queueFile, root, date: normalizedDate});
  const {remainingSec} = assertRecordBinding(record, queue, {
    date: normalizedDate,
    nowEpoch: now,
    timeZone: zone,
  });
  const expected = [
    ['authorizationId', expectedAuthorizationId, record.authorizationId, normalizeAuthorizationId],
    ['queueStateSha256', expectedQueueStateSha256, record.queueStateSha256, value => normalizeSha256(value, 'expectedQueueStateSha256')],
    ['queueFingerprint', expectedQueueFingerprint, record.queueFingerprint, value => normalizeSha256(value, 'expectedQueueFingerprint')],
    ['sourceGuardHash', expectedSourceGuardHash, record.sourceGuardHash, value => normalizeSha256(value, 'expectedSourceGuardHash')],
    ['maxGroups', expectedMaxGroups, record.maxGroups, normalizeMaxGroups],
    ['gracefulCutoffEpoch', expectedGracefulCutoffEpoch, record.gracefulCutoffEpoch, value => normalizeEpoch(value, 'expectedGracefulCutoffEpoch')],
    ['outerHardDeadlineEpoch', expectedOuterHardDeadlineEpoch, record.outerHardDeadlineEpoch, value => normalizeEpoch(value, 'expectedOuterHardDeadlineEpoch')],
  ];
  for (const [label, expectedValue, actualValue, normalize] of expected) {
    if (expectedValue === undefined || expectedValue === null || String(expectedValue).trim() === '') continue;
    if (normalize(expectedValue) !== actualValue) fail(`consumed authorization ${label} differs from read-only environment`);
  }
  if (expectedReason !== undefined && String(expectedReason) !== record.reason) {
    fail('consumed authorization reason differs from read-only environment');
  }
  return {
    ok: true,
    ...record,
    receiptFile: receipt.file,
    receiptSha256: receipt.sha256,
    remainingSec,
    queueFile: queue.queueFile,
    currentQueueStateSha256: queue.queueStateSha256,
    currentQueueFingerprint: queue.queueFingerprint,
    currentSourceGuardHash: queue.sourceGuardHash,
  };
}

export async function verifyImmediateAuthorizationContinuation({
  receiptFile,
  queueFile,
  root = process.env.SHEIN_BI_ROOT || MODULE_ROOT,
  date,
  nowEpoch = Math.floor(Date.now() / 1000),
  timeZone = process.env.SHEIN_BI_TZ || 'Asia/Shanghai',
  expectedAuthorizationId,
  expectedQueueStateSha256,
  expectedQueueFingerprint,
  expectedSourceGuardHash,
  expectedMaxGroups,
  expectedGracefulCutoffEpoch,
  expectedOuterHardDeadlineEpoch,
  expectedReason,
  expectedReceiptSha256,
} = {}) {
  const now = normalizeEpoch(nowEpoch, 'nowEpoch');
  const normalizedDate = normalizeDate(date);
  const zone = normalizeTimeZone(timeZone);
  const receipt = await readAuthorizationJsonFile(receiptFile, 'continuation authorization receipt');
  if (expectedReceiptSha256 !== undefined
    && normalizeSha256(expectedReceiptSha256, 'expectedReceiptSha256') !== receipt.sha256) {
    fail(`continuation authorization receipt SHA-256 mismatch: expected=${String(expectedReceiptSha256).toLowerCase()} actual=${receipt.sha256}`,
      'IMMEDIATE_AUTHORIZATION_BINDING_MISMATCH');
  }
  const record = normalizeRecord(receipt.value);
  let sourceFile;
  if (record.status === 'claimed') {
    assertClaimedRecord(record, {nowEpoch: now});
    sourceFile = record.claimedFrom;
    if (record.claimedReceiptFile !== receipt.file) fail('claimed continuation receipt path mismatch');
  } else if (record.status === 'consumed') {
    assertConsumedRecord(record, {nowEpoch: now});
    sourceFile = record.consumedFrom;
    if (record.consumedReceiptFile !== receipt.file) fail('consumed continuation receipt path mismatch');
  } else {
    fail(`continuation receipt status is not immutable claimed/consumed: ${record.status}`,
      'IMMEDIATE_AUTHORIZATION_CONTINUATION_INVALID');
  }
  if (deriveConsumedAuthorizationFile(sourceFile, record.authorizationId) !== receipt.file) {
    fail('continuation receipt is not at its canonical authorizationId-bound path');
  }
  const sourceStillExists = await fs.lstat(sourceFile).then(() => true).catch(error => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  if (sourceStillExists) {
    fail('continuation authorization source still exists; fresh issued admission must win',
      'IMMEDIATE_AUTHORIZATION_CONTINUATION_INVALID');
  }
  const queue = await readQueueBinding({queueFile, root, date: normalizedDate});
  const {remainingSec, gracefulRemainingSec, outerRemainingSec} = assertRecordBinding(record, queue, {
    date: normalizedDate,
    nowEpoch: now,
    timeZone: zone,
    continuation: true,
  });
  assertExpectedAuthorizationBinding(record, {
    expectedAuthorizationId,
    expectedQueueStateSha256,
    expectedQueueFingerprint,
    expectedSourceGuardHash,
    expectedMaxGroups,
    expectedGracefulCutoffEpoch,
    expectedOuterHardDeadlineEpoch,
    expectedReason,
  });
  return {
    ok: true,
    continuation: true,
    ...record,
    authorizationFile: sourceFile,
    receiptFile: receipt.file,
    receiptSha256: receipt.sha256,
    remainingSec,
    gracefulRemainingSec,
    outerRemainingSec,
    currentQueueStateSha256: queue.queueStateSha256,
    currentQueueFingerprint: queue.queueFingerprint,
    currentSourceGuardHash: queue.sourceGuardHash,
  };
}

export async function findImmediateAuthorizationContinuation({
  authorizationFile = process.env.SHEIN_BI_MARKETING_IMMEDIATE_AUTHORIZATION_FILE || DEFAULT_IMMEDIATE_AUTHORIZATION_FILE,
  queueFile,
  root = process.env.SHEIN_BI_ROOT || MODULE_ROOT,
  date,
  nowEpoch = Math.floor(Date.now() / 1000),
  timeZone = process.env.SHEIN_BI_TZ || 'Asia/Shanghai',
  scheduledDiscovery = false,
} = {}) {
  const source = normalizeAbsolutePath(authorizationFile, 'authorizationFile');
  await assertAuthorizationDirectory(source);
  const prefix = `${path.basename(source)}.consumed.`;
  const names = (await fs.readdir(path.dirname(source)))
    .filter(name => name.startsWith(prefix) && name.endsWith('.json'));
  const relevant = [];
  for (const name of names) {
    const receiptFile = path.join(path.dirname(source), name);
    try {
      const snapshot = await readAuthorizationJsonFile(receiptFile, 'continuation authorization receipt');
      const record = normalizeRecord(snapshot.value);
      const recordSource = record.status === 'claimed' ? record.claimedFrom
        : record.status === 'consumed' ? record.consumedFrom : '';
      if (record.date === normalizeDate(date) && recordSource === source) {
        relevant.push({receiptFile, record, receiptSha256: snapshot.sha256});
      }
    } catch (error) {
      const stat = await fs.lstat(receiptFile).catch(() => null);
      if (stat && businessDateAtEpoch(Math.floor(stat.mtimeMs / 1000), timeZone) === normalizeDate(date)) {
        fail(`current-date continuation receipt is malformed; fail closed: ${receiptFile}`,
          'IMMEDIATE_AUTHORIZATION_CONTINUATION_INVALID');
      }
      if (!(error instanceof ImmediateAuthorizationError)) throw error;
    }
  }
  if (!relevant.length) return {ok: true, found: false, continuation: false};
  relevant.sort((a, b) => b.record.issuedAtEpoch - a.record.issuedAtEpoch
    || Number(b.record.consumedAtEpoch || b.record.claimedAtEpoch || 0)
      - Number(a.record.consumedAtEpoch || a.record.claimedAtEpoch || 0));
  if (relevant.length > 1
    && relevant[0].record.issuedAtEpoch === relevant[1].record.issuedAtEpoch
    && Number(relevant[0].record.consumedAtEpoch || relevant[0].record.claimedAtEpoch || 0)
      === Number(relevant[1].record.consumedAtEpoch || relevant[1].record.claimedAtEpoch || 0)) {
    fail('latest claimed/consumed receipt is ambiguous',
      'IMMEDIATE_AUTHORIZATION_CONTINUATION_AMBIGUOUS');
  }
  try {
    return await verifyImmediateAuthorizationContinuation({
      receiptFile: relevant[0].receiptFile,
      queueFile,
      root,
      date,
      nowEpoch,
      timeZone,
    });
  } catch (error) {
    const stale = error instanceof ImmediateAuthorizationError
      && (error.code === 'IMMEDIATE_AUTHORIZATION_BINDING_MISMATCH'
        || error.code === 'IMMEDIATE_AUTHORIZATION_EXPIRED');
    if (!scheduledDiscovery || !stale) throw error;
    return {
      ok: true,
      found: true,
      continuation: false,
      stale: true,
      noOp: true,
      reason: error.code === 'IMMEDIATE_AUTHORIZATION_EXPIRED'
        ? 'continuation_authorization_expired'
        : 'current_queue_binding_mismatch',
      errorCode: error.code,
      authorizationId: relevant[0].record.authorizationId,
      receiptFile: relevant[0].receiptFile,
      receiptSha256: relevant[0].receiptSha256,
    };
  }
}

export async function inspectImmediateAuthorization({authorizationFile} = {}) {
  const auth = await readAuthorizationJsonFile(authorizationFile, 'immediate authorization');
  const record = normalizeRecord(auth.value);
  return {ok: true, ...record, authorizationFile: auth.file, authorizationFileSha256: auth.sha256};
}

function parseArgs(argv) {
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'help';
  const args = {command};
  const start = command === argv[0] ? 1 : 0;
  for (let index = start; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) fail(`unexpected argument: ${arg}`, 'IMMEDIATE_AUTHORIZATION_USAGE');
    const [rawKey, inlineValue] = arg.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const value = inlineValue !== undefined
      ? inlineValue
      : (argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : 'true');
    args[key] = value;
  }
  return args;
}

function usage() {
  return [
    'Usage:',
    `  node scripts/manage_cloud_marketing_immediate_run.mjs issue --date YYYY-MM-DD --queue FILE --source-guard-file HOST_FILE --max-groups N --confirm-token ${IMMEDIATE_CONFIRMATION_TOKEN} --reason TEXT [--ttl-sec N|--graceful-cutoff-epoch E] [--outer-hard-deadline-epoch E] [--authorization-file FILE]`,
    '  node scripts/manage_cloud_marketing_immediate_run.mjs verify-issued --date YYYY-MM-DD --queue FILE [--authorization-file FILE]',
    '  node scripts/manage_cloud_marketing_immediate_run.mjs consume --date YYYY-MM-DD --queue FILE [--authorization-file FILE]',
    '  node scripts/manage_cloud_marketing_immediate_run.mjs verify-consumed --date YYYY-MM-DD --queue FILE --receipt-file FILE',
    '  node scripts/manage_cloud_marketing_immediate_run.mjs find-continuation --date YYYY-MM-DD --queue FILE [--authorization-file FILE]',
    '  node scripts/manage_cloud_marketing_immediate_run.mjs verify-continuation --date YYYY-MM-DD --queue FILE --receipt-file FILE',
    '  node scripts/manage_cloud_marketing_immediate_run.mjs inspect --authorization-file FILE',
    `  default authorization file: ${DEFAULT_IMMEDIATE_AUTHORIZATION_FILE}`,
    '  deployment prerequisite: root creates /srv/shein-bi/marketing-repair-immediate owned by sheinops:sheinops with mode 0700; the oneshot service never creates or chowns it',
  ].join('\n');
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function runImmediateAuthorizationCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.command === 'help' || args.command === '--help') {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const common = {
    root: args.root,
    timeZone: args.timeZone,
    nowEpoch: args.nowEpoch,
  };
  if (args.command === 'issue' || args.command === 'authorize') {
    printJson(await issueImmediateAuthorization({
      ...common,
      authorizationFile: args.authorizationFile || args.authFile,
      queueFile: args.queue,
      sourceGuardFile: args.sourceGuardFile,
      date: args.date,
      maxGroups: args.maxGroups,
      confirmationToken: args.confirmToken || args.confirmationToken,
      gracefulCutoffEpoch: args.gracefulCutoffEpoch,
      outerHardDeadlineEpoch: args.outerHardDeadlineEpoch,
      deadlineEpoch: args.deadlineEpoch,
      ttlSec: args.ttlSec,
      reason: args.reason,
    }));
    return;
  }
  if (args.command === 'consume') {
    printJson(await consumeImmediateAuthorization({
      ...common,
      authorizationFile: args.authorizationFile || args.authFile,
      queueFile: args.queue,
      date: args.date,
      expectedAuthorizationId: args.expectedAuthorizationId,
      expectedAuthorizationFileSha256: args.expectedAuthorizationFileSha256,
      expectedQueueStateSha256: args.expectedQueueStateSha256,
      expectedQueueFingerprint: args.expectedQueueFingerprint,
      expectedSourceGuardHash: args.expectedSourceGuardHash,
      expectedMaxGroups: args.expectedMaxGroups,
      expectedGracefulCutoffEpoch: args.expectedGracefulCutoffEpoch,
      expectedOuterHardDeadlineEpoch: args.expectedOuterHardDeadlineEpoch,
      expectedReason: args.expectedReason,
    }));
    return;
  }
  if (args.command === 'verify-issued') {
    printJson(await verifyIssuedImmediateAuthorization({
      ...common,
      authorizationFile: args.authorizationFile || args.authFile,
      queueFile: args.queue,
      date: args.date,
    }));
    return;
  }
  if (args.command === 'verify-consumed' || args.command === 'verify') {
    printJson(await verifyConsumedImmediateAuthorization({
      ...common,
      receiptFile: args.receiptFile,
      queueFile: args.queue,
      date: args.date,
      expectedAuthorizationId: args.expectedAuthorizationId,
      expectedQueueStateSha256: args.expectedQueueStateSha256,
      expectedQueueFingerprint: args.expectedQueueFingerprint,
      expectedSourceGuardHash: args.expectedSourceGuardHash,
      expectedMaxGroups: args.expectedMaxGroups,
      expectedGracefulCutoffEpoch: args.expectedGracefulCutoffEpoch,
      expectedOuterHardDeadlineEpoch: args.expectedOuterHardDeadlineEpoch,
      expectedReason: args.expectedReason,
      expectedReceiptSha256: args.expectedReceiptSha256,
    }));
    return;
  }
  if (args.command === 'find-continuation') {
    printJson(await findImmediateAuthorizationContinuation({
      ...common,
      authorizationFile: args.authorizationFile || args.authFile,
      queueFile: args.queue,
      date: args.date,
      scheduledDiscovery: args.scheduledDiscovery === true
        || args.scheduledDiscovery === 'true'
        || args.scheduled === true
        || args.scheduled === 'true',
    }));
    return;
  }
  if (args.command === 'verify-continuation') {
    printJson(await verifyImmediateAuthorizationContinuation({
      ...common,
      receiptFile: args.receiptFile,
      queueFile: args.queue,
      date: args.date,
      expectedAuthorizationId: args.expectedAuthorizationId,
      expectedQueueStateSha256: args.expectedQueueStateSha256,
      expectedQueueFingerprint: args.expectedQueueFingerprint,
      expectedSourceGuardHash: args.expectedSourceGuardHash,
      expectedMaxGroups: args.expectedMaxGroups,
      expectedGracefulCutoffEpoch: args.expectedGracefulCutoffEpoch,
      expectedOuterHardDeadlineEpoch: args.expectedOuterHardDeadlineEpoch,
      expectedReason: args.expectedReason,
      expectedReceiptSha256: args.expectedReceiptSha256,
    }));
    return;
  }
  if (args.command === 'inspect') {
    printJson(await inspectImmediateAuthorization({authorizationFile: args.authorizationFile || args.authFile}));
    return;
  }
  fail(`unknown command: ${args.command}`, 'IMMEDIATE_AUTHORIZATION_USAGE');
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath && import.meta.url === invokedPath) {
  runImmediateAuthorizationCli(process.argv.slice(2)).catch(error => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = error?.code === 'IMMEDIATE_AUTHORIZATION_USAGE'
      || String(error?.code || '').startsWith('IMMEDIATE_AUTHORIZATION_')
      ? 64
      : 75;
  });
}
