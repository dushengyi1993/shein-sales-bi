import crypto from 'node:crypto';
import fsSync from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

import {readRegularBoundedFile} from './source_release_attestation.mjs';
import {writeJsonFileAtomic} from './atomic_file_publish.mjs';

export const EMERGENCY_LOCAL_RELEASE_RECEIPT_SCHEMA_VERSION = 'shein-bi-emergency-local-release/v1';
export const DEFAULT_EMERGENCY_LOCAL_RELEASE_FILE = '/srv/shein-bi/runtime/emergency_local_release.json';
export const MAX_EMERGENCY_LOCAL_RELEASE_RECEIPT_BYTES = 16 * 1024;
export const DEFAULT_EMERGENCY_LOCAL_RELEASE_BUNDLE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_EMERGENCY_LOCAL_RELEASE_REASON_BYTES = 2 * 1024;

const RECEIPT_PAYLOAD_KEYS = Object.freeze([
  'schemaVersion',
  'commit',
  'baselineCommit',
  'bundleSha256',
  'createdAt',
  'reason',
]);
const RECEIPT_KEYS = Object.freeze([...RECEIPT_PAYLOAD_KEYS, 'receiptHash']);
const HEX_COMMIT = /^[0-9a-f]{40}$/u;
const HEX_SHA256 = /^[0-9a-f]{64}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SECRET_LIKE_REASON = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|cookie|authorization|bearer)\s*[:=]/iu;
const O_NOFOLLOW = Number(fsSync.constants?.O_NOFOLLOW) || 0;

export class EmergencyLocalReleaseReceiptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EmergencyLocalReleaseReceiptError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new EmergencyLocalReleaseReceiptError(code, message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function expectedReceiptKeys(value) {
  return isPlainObject(value)
    && Object.keys(value).sort().join('\n') === [...RECEIPT_KEYS].sort().join('\n');
}

function receiptPayload(value) {
  return Object.fromEntries(RECEIPT_PAYLOAD_KEYS.map(key => [key, value[key]]));
}

function canonicalReceiptPayload(value) {
  return canonicalJson(receiptPayload(value));
}

export function canonicalEmergencyLocalReleaseReceipt(value) {
  if (!isPlainObject(value)) fail('EMERGENCY_RECEIPT_NOT_OBJECT', 'Emergency release receipt must be an object');
  if (!expectedReceiptKeys(value)) fail('EMERGENCY_RECEIPT_KEYS_INVALID', 'Emergency release receipt keys are not exact');
  return canonicalReceiptPayload(value);
}

export function emergencyLocalReleaseReceiptHash(value) {
  return sha256Hex(Buffer.from(canonicalEmergencyLocalReleaseReceipt(value), 'utf8'));
}

function validIsoInstant(value) {
  if (!ISO_INSTANT.test(String(value || ''))) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function validReason(value) {
  if (typeof value !== 'string' || value.length < 1 || value !== value.trim()) return false;
  if (Buffer.byteLength(value, 'utf8') > MAX_EMERGENCY_LOCAL_RELEASE_REASON_BYTES) return false;
  if (/[\u0000-\u001f\u007f]/u.test(value)) return false;
  if (SECRET_LIKE_REASON.test(value) || /-----BEGIN [^-\r\n]+ PRIVATE KEY-----/u.test(value)) return false;
  return true;
}

function uniqueIssues(issues) {
  return [...new Set(issues)];
}

export function validateEmergencyLocalReleaseReceipt(value) {
  const issues = [];
  if (!isPlainObject(value)) return {ok: false, issues: ['receipt_not_object'], receipt: null};
  if (!expectedReceiptKeys(value)) issues.push('receipt_keys_invalid');
  if (value.schemaVersion !== EMERGENCY_LOCAL_RELEASE_RECEIPT_SCHEMA_VERSION) issues.push('schema_version_invalid');
  if (!HEX_COMMIT.test(String(value.commit || ''))) issues.push('commit_invalid');
  if (!HEX_COMMIT.test(String(value.baselineCommit || ''))) issues.push('baseline_commit_invalid');
  if (!HEX_SHA256.test(String(value.bundleSha256 || ''))) issues.push('bundle_sha256_invalid');
  if (!validIsoInstant(value.createdAt)) issues.push('created_at_invalid');
  if (!validReason(value.reason)) issues.push('reason_invalid');
  if (!HEX_SHA256.test(String(value.receiptHash || ''))) issues.push('receipt_hash_invalid');

  let expectedHash = '';
  if (!issues.includes('receipt_keys_invalid')
    && !issues.includes('schema_version_invalid')
    && !issues.includes('commit_invalid')
    && !issues.includes('baseline_commit_invalid')
    && !issues.includes('bundle_sha256_invalid')
    && !issues.includes('created_at_invalid')
    && !issues.includes('reason_invalid')) {
    expectedHash = emergencyLocalReleaseReceiptHash(value);
    const actualHash = String(value.receiptHash || '');
    if (!HEX_SHA256.test(actualHash)
      || !crypto.timingSafeEqual(Buffer.from(expectedHash, 'utf8'), Buffer.from(actualHash, 'utf8'))) {
      issues.push('receipt_hash_mismatch');
    }
  }
  const cleanIssues = uniqueIssues(issues);
  return {
    ok: cleanIssues.length === 0,
    issues: cleanIssues,
    receipt: cleanIssues.length === 0 ? Object.freeze({...value}) : null,
    expectedHash,
  };
}

function statSignature(stat) {
  return {
    dev: Number(stat?.dev || 0),
    ino: Number(stat?.ino || 0),
    mode: Number(stat?.mode || 0),
    size: Number(stat?.size || 0),
    mtimeMs: Number(stat?.mtimeMs || 0),
    ctimeMs: Number(stat?.ctimeMs || 0),
  };
}

function sameStat(left, right) {
  const a = statSignature(left);
  const b = statSignature(right);
  return Object.keys(a).every(key => a[key] === b[key]);
}

function assertBundleLimit(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_EMERGENCY_LOCAL_RELEASE_BUNDLE_MAX_BYTES) {
    fail('EMERGENCY_BUNDLE_LIMIT_INVALID', 'Emergency bundle byte limit is outside the allowed range');
  }
}

export function hashEmergencyLocalReleaseBundle(file, {maxBytes = DEFAULT_EMERGENCY_LOCAL_RELEASE_BUNDLE_MAX_BYTES} = {}) {
  assertBundleLimit(maxBytes);
  const target = path.resolve(String(file || ''));
  if (!file) fail('EMERGENCY_BUNDLE_PATH_REQUIRED', 'Emergency release bundle path is required');
  let before;
  try {
    before = fsSync.lstatSync(target);
  } catch (error) {
    fail(error?.code === 'ENOENT' ? 'EMERGENCY_BUNDLE_MISSING' : 'EMERGENCY_BUNDLE_STAT_FAILED', 'Emergency release bundle cannot be inspected');
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    fail('EMERGENCY_BUNDLE_TYPE_INVALID', 'Emergency release bundle must be a regular non-symlink file');
  }
  if (before.size < 1 || before.size > maxBytes) {
    fail('EMERGENCY_BUNDLE_SIZE_INVALID', 'Emergency release bundle size is outside the allowed range');
  }

  let fd;
  try {
    try {
      fd = fsSync.openSync(target, fsSync.constants.O_RDONLY | O_NOFOLLOW);
    } catch (error) {
      fail('EMERGENCY_BUNDLE_OPEN_FAILED', 'Emergency release bundle cannot be opened safely');
    }
    const opened = fsSync.fstatSync(fd);
    if (!opened.isFile() || opened.isSymbolicLink() || !sameStat(before, opened)) {
      fail('EMERGENCY_BUNDLE_CHANGED', 'Emergency release bundle changed before hashing');
    }
    if (opened.size < 1 || opened.size > maxBytes) {
      fail('EMERGENCY_BUNDLE_SIZE_INVALID', 'Emergency release bundle size is outside the allowed range');
    }
    const hash = crypto.createHash('sha256');
    const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, opened.size)));
    let position = 0;
    while (position < opened.size) {
      const wanted = Math.min(chunk.length, opened.size - position);
      const bytesRead = fsSync.readSync(fd, chunk, 0, wanted, position);
      if (!Number.isInteger(bytesRead) || bytesRead < 1) {
        fail('EMERGENCY_BUNDLE_READ_FAILED', 'Emergency release bundle ended before its bounded size was read');
      }
      hash.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    const afterFd = fsSync.fstatSync(fd);
    const afterPath = fsSync.lstatSync(target);
    if (!sameStat(opened, afterFd) || !sameStat(before, afterPath)) {
      fail('EMERGENCY_BUNDLE_CHANGED', 'Emergency release bundle changed while hashing');
    }
    return Object.freeze({file: target, size: opened.size, sha256: hash.digest('hex')});
  } finally {
    if (fd !== undefined) {
      try { fsSync.closeSync(fd); } catch {}
    }
  }
}

export function buildEmergencyLocalReleaseReceipt({
  commit,
  baselineCommit,
  bundleSha256,
  createdAt = new Date().toISOString(),
  reason,
} = {}) {
  const payload = {
    schemaVersion: EMERGENCY_LOCAL_RELEASE_RECEIPT_SCHEMA_VERSION,
    commit,
    baselineCommit,
    bundleSha256,
    createdAt,
    reason,
  };
  const candidate = {...payload, receiptHash: emergencyLocalReleaseReceiptHash({...payload, receiptHash: ''})};
  const validation = validateEmergencyLocalReleaseReceipt(candidate);
  if (!validation.ok) fail('EMERGENCY_RECEIPT_BUILD_INVALID', `Emergency release receipt is invalid: ${validation.issues.join(',')}`);
  return validation.receipt;
}

export function createEmergencyLocalReleaseReceipt({bundleFile, ...options} = {}) {
  const bundle = hashEmergencyLocalReleaseBundle(bundleFile, {maxBytes: options.maxBundleBytes});
  const receipt = buildEmergencyLocalReleaseReceipt({
    ...options,
    bundleSha256: bundle.sha256,
  });
  return Object.freeze({receipt, bundle});
}

export async function writeEmergencyLocalReleaseReceipt({
  receiptFile = process.env.SHEIN_BI_EMERGENCY_LOCAL_RELEASE_FILE || DEFAULT_EMERGENCY_LOCAL_RELEASE_FILE,
  ...options
} = {}) {
  const target = path.resolve(receiptFile);
  const created = createEmergencyLocalReleaseReceipt(options);
  await writeJsonFileAtomic(target, created.receipt, {mode: 0o640});
  const readback = readEmergencyLocalReleaseReceipt(target);
  if (!readback.ok) fail('EMERGENCY_RECEIPT_READBACK_FAILED', `Emergency release receipt readback failed: ${readback.issues.join(',')}`);
  return Object.freeze({receiptFile: target, ...created, readback});
}

export function readEmergencyLocalReleaseReceipt(
  receiptFile = process.env.SHEIN_BI_EMERGENCY_LOCAL_RELEASE_FILE || DEFAULT_EMERGENCY_LOCAL_RELEASE_FILE,
) {
  const target = path.resolve(receiptFile);
  let bytes;
  try {
    bytes = readRegularBoundedFile(target, MAX_EMERGENCY_LOCAL_RELEASE_RECEIPT_BYTES, 'emergency local release receipt');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return Object.freeze({ok: false, exists: false, file: target, issues: ['receipt_missing'], errorCode: 'EMERGENCY_RECEIPT_MISSING'});
    }
    return Object.freeze({
      ok: false,
      exists: true,
      file: target,
      issues: ['receipt_unreadable'],
      errorCode: String(error?.code || 'EMERGENCY_RECEIPT_READ_FAILED'),
    });
  }
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return Object.freeze({ok: false, exists: true, file: target, issues: ['receipt_json_invalid'], errorCode: 'EMERGENCY_RECEIPT_JSON_INVALID'});
  }
  const validation = validateEmergencyLocalReleaseReceipt(value);
  return Object.freeze({
    ...validation,
    exists: true,
    file: target,
    bytesSha256: sha256Hex(bytes),
  });
}

function git(cwd, args) {
  return execFileSync('git', ['-c', `safe.directory=${cwd}`, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
}

function splitNull(value) {
  return Buffer.isBuffer(value)
    ? value.toString('utf8').split('\0').filter(Boolean)
    : String(value || '').split('\0').filter(Boolean);
}

function gitBuffer(cwd, args) {
  return execFileSync('git', ['-c', `safe.directory=${cwd}`, ...args], {
    cwd,
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
}

export function inspectEmergencyLocalReleaseSource({cwd = process.cwd(), expectedCommit} = {}) {
  const root = path.resolve(cwd);
  const expected = String(expectedCommit || '').trim();
  try {
    const head = git(root, ['rev-parse', 'HEAD']).trim();
    let resolvedExpected = '';
    if (expected) resolvedExpected = git(root, ['rev-parse', '--verify', `${expected}^{commit}`]).trim();
    const dirtyEntries = splitNull(gitBuffer(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
    const indexEntries = splitNull(gitBuffer(root, ['ls-files', '-v', '-z']));
    const hiddenIndexEntries = indexEntries
      .filter(entry => entry.startsWith('S ') || /^[a-z] /.test(entry))
      .map(entry => entry.slice(2));
    const trackedFiles = splitNull(gitBuffer(root, ['ls-files', '-z']));
    const missingTrackedFiles = trackedFiles.filter(file => {
      try {
        fsSync.lstatSync(path.join(root, file));
        return false;
      } catch (error) {
        if (error?.code === 'ENOENT') return true;
        throw error;
      }
    });
    const commitMatches = Boolean(!resolvedExpected || head === resolvedExpected);
    return Object.freeze({
      ok: commitMatches
        && dirtyEntries.length === 0
        && hiddenIndexEntries.length === 0
        && missingTrackedFiles.length === 0,
      cwd: root,
      head,
      expectedCommit: resolvedExpected,
      commitMatches,
      dirtyEntries: Object.freeze(dirtyEntries),
      hiddenIndexEntries: Object.freeze(hiddenIndexEntries),
      missingTrackedFiles: Object.freeze(missingTrackedFiles),
      trackedFileCount: trackedFiles.length,
    });
  } catch (error) {
    return Object.freeze({
      ok: false,
      cwd: root,
      head: '',
      expectedCommit: '',
      commitMatches: false,
      dirtyEntries: Object.freeze([]),
      hiddenIndexEntries: Object.freeze([]),
      missingTrackedFiles: Object.freeze([]),
      trackedFileCount: 0,
      errorCode: String(error?.code || 'EMERGENCY_SOURCE_INSPECTION_FAILED'),
      error: String(error?.message || error).slice(0, 500),
    });
  }
}

export function verifyEmergencyLocalReleaseReceipt({
  receiptFile = process.env.SHEIN_BI_EMERGENCY_LOCAL_RELEASE_FILE || DEFAULT_EMERGENCY_LOCAL_RELEASE_FILE,
  bundleFile = '',
  maxBundleBytes,
  cwd = process.cwd(),
  verifySource = true,
} = {}) {
  const receiptResult = readEmergencyLocalReleaseReceipt(receiptFile);
  const issues = [...(receiptResult.issues || [])];
  let bundle = null;
  let source = null;
  if (receiptResult.ok && bundleFile) {
    try {
      bundle = hashEmergencyLocalReleaseBundle(bundleFile, {maxBytes: maxBundleBytes});
      if (bundle.sha256 !== receiptResult.receipt.bundleSha256) issues.push('bundle_hash_mismatch');
    } catch (error) {
      issues.push(String(error?.code || 'bundle_verification_failed').toLowerCase());
    }
  }
  if (receiptResult.ok && verifySource) {
    source = inspectEmergencyLocalReleaseSource({cwd, expectedCommit: receiptResult.receipt.commit});
    if (!source.ok) issues.push('source_integrity_invalid');
  }
  return Object.freeze({
    ok: receiptResult.ok && issues.length === 0,
    file: receiptResult.file,
    receipt: receiptResult.receipt,
    receiptResult,
    bundle,
    source,
    issues: uniqueIssues(issues),
  });
}
