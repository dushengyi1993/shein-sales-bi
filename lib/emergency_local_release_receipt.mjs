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
const MAX_GIT_STDERR_SUMMARY_BYTES = 240;

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

export function createEmergencyLocalReleaseReceipt({bundleFile, cwd = process.cwd(), ...options} = {}) {
  const source = inspectEmergencyLocalReleaseSource({
    cwd,
    expectedCommit: options.commit,
    baselineCommit: options.baselineCommit,
  });
  if (!source.ok) {
    fail('EMERGENCY_SOURCE_INTEGRITY_INVALID', `Emergency source checkout is not an exact clean target: ${source.issues.join(',') || 'source_invalid'}`);
  }
  const bundle = verifyEmergencyLocalReleaseBundle({
    bundleFile,
    cwd,
    targetCommit: source.targetCommit,
    baselineCommit: source.baselineCommit,
    maxBytes: options.maxBundleBytes,
  });
  if (!bundle.ok) {
    fail('EMERGENCY_BUNDLE_VERIFICATION_FAILED', `Emergency release bundle verification failed: ${bundle.issues.join(',') || 'bundle_invalid'}`);
  }
  const receipt = buildEmergencyLocalReleaseReceipt({
    ...options,
    bundleSha256: bundle.sha256,
  });
  return Object.freeze({receipt, bundle, source});
}

function receiptAtomicWriteOptions(target) {
  const options = {mode: 0o640};
  if (process.platform === 'win32') return options;

  const dir = path.dirname(target);
  fsSync.mkdirSync(dir, {recursive: true});
  const parent = fsSync.statSync(dir);
  if (!parent.isDirectory()) {
    fail('EMERGENCY_RECEIPT_PARENT_INVALID', 'Emergency release receipt parent must be a directory');
  }

  let uid;
  try {
    uid = fsSync.lstatSync(target).uid;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      fail('EMERGENCY_RECEIPT_STAT_FAILED', 'Emergency release receipt target owner cannot be inspected');
    }
    uid = typeof process.geteuid === 'function' ? process.geteuid() : process.getuid?.();
  }
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(parent.gid) || parent.gid < 0) {
    fail('EMERGENCY_RECEIPT_OWNER_UNAVAILABLE', 'Emergency release receipt POSIX owner cannot be determined');
  }
  return {...options, uid, gid: parent.gid};
}

export async function writeEmergencyLocalReleaseReceipt({
  receiptFile = process.env.SHEIN_BI_EMERGENCY_LOCAL_RELEASE_FILE || DEFAULT_EMERGENCY_LOCAL_RELEASE_FILE,
  ...options
} = {}) {
  const target = path.resolve(receiptFile);
  const created = createEmergencyLocalReleaseReceipt(options);
  await writeJsonFileAtomic(target, created.receipt, receiptAtomicWriteOptions(target));
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

function limitUtf8(value, maxBytes) {
  let output = '';
  for (const character of String(value || '')) {
    if (Buffer.byteLength(`${output}${character}`, 'utf8') > maxBytes) break;
    output += character;
  }
  return output;
}

function summarizeGitStderr(error) {
  const stderr = Buffer.isBuffer(error?.stderr)
    ? error.stderr.toString('utf8')
    : String(error?.stderr || '');
  const firstLine = stderr
    .split(/[\r\n]+/u)
    .map(value => value.trim())
    .find(Boolean);
  if (!firstLine) return '';
  const sanitized = firstLine
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|cookie|authorization|bearer)\s*[:=]\s*\S+/giu, '$1=<redacted>')
    .replace(/\b(?:Bearer|Basic)\s+\S+/giu, '$1 <redacted>')
    .replace(/[A-Za-z]:[\\/][^\s'"<>]*/gu, '<path>')
    .replace(/(?<![\w])\/(?:[^\s'"<>]+\/)*[^\s'"<>]+/gu, '<path>')
    .replace(/\s+/gu, ' ')
    .trim();
  return limitUtf8(sanitized, MAX_GIT_STDERR_SUMMARY_BYTES);
}

function runGit(cwd, args, {encoding = 'utf8', maxBuffer = 16 * 1024 * 1024} = {}) {
  try {
    return Object.freeze({
      ok: true,
      value: execFileSync('git', ['-c', `safe.directory=${cwd}`, ...args], {
        cwd,
        encoding,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer,
      }),
      status: 0,
      summary: '',
    });
  } catch (error) {
    return Object.freeze({
      ok: false,
      value: error?.stdout,
      status: Number.isInteger(error?.status) ? error.status : null,
      summary: summarizeGitStderr(error),
    });
  }
}

function gitFailure(result, code, label) {
  const suffix = result?.summary ? `: ${result.summary}` : '';
  const failure = new EmergencyLocalReleaseReceiptError(code, `${label} failed${suffix}`);
  failure.exitCode = result?.status ?? null;
  failure.gitErrorSummary = result?.summary || '';
  return failure;
}

function git(cwd, args, options = {}) {
  const result = runGit(cwd, args, options);
  if (!result.ok) throw gitFailure(result, options.code || 'EMERGENCY_GIT_COMMAND_FAILED', options.label || 'Git command');
  return result.value;
}

function splitNull(value) {
  return Buffer.isBuffer(value)
    ? value.toString('utf8').split('\0').filter(Boolean)
    : String(value || '').split('\0').filter(Boolean);
}

function gitBuffer(cwd, args) {
  return git(cwd, args, {encoding: 'buffer', maxBuffer: 32 * 1024 * 1024});
}

function resolveGitCommit(cwd, value, {field = 'commit', requireHex = true} = {}) {
  const candidate = String(value || '').trim();
  const fieldCode = field === 'baselineCommit' ? 'BASELINE_COMMIT' : field.toUpperCase();
  if (requireHex && !HEX_COMMIT.test(candidate)) {
    fail(`EMERGENCY_${fieldCode}_INVALID`, `Emergency ${field} must be an exact 40-hex commit`);
  }
  const resolved = String(git(cwd, [
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    `${candidate}^{commit}`,
  ], {
    code: 'EMERGENCY_GIT_COMMIT_RESOLUTION_FAILED',
    label: `Git ${field} resolution`,
  })).trim();
  if (!HEX_COMMIT.test(resolved)) {
    fail(`EMERGENCY_${fieldCode}_UNRESOLVED`, `Emergency ${field} did not resolve to an exact commit`);
  }
  return resolved;
}

function resolveGitCommitAttempt(cwd, value, options) {
  try {
    return {commit: resolveGitCommit(cwd, value, options), error: null};
  } catch (error) {
    return {commit: '', error};
  }
}

function sourceIssueFromError(error, fallback) {
  if (error?.code === 'EMERGENCY_COMMIT_INVALID') return 'target_commit_invalid';
  if (error?.code === 'EMERGENCY_BASELINE_COMMIT_INVALID') return 'baseline_commit_invalid';
  if (error?.code === 'EMERGENCY_GIT_COMMIT_RESOLUTION_FAILED') return 'commit_resolution_failed';
  if (error?.code === 'EMERGENCY_BASELINE_COMMIT_UNRESOLVED') return 'baseline_commit_unresolved';
  if (error?.code === 'EMERGENCY_COMMIT_UNRESOLVED') return 'target_commit_unresolved';
  return fallback;
}

function inspectAncestorRelation(cwd, baselineCommit, targetCommit) {
  if (baselineCommit === targetCommit) {
    return Object.freeze({isAncestor: true, relation: 'equal'});
  }
  const result = runGit(cwd, ['merge-base', '--is-ancestor', baselineCommit, targetCommit]);
  if (result.ok) return Object.freeze({isAncestor: true, relation: 'ancestor'});
  if (result.status === 1) return Object.freeze({isAncestor: false, relation: 'not-ancestor'});
  throw gitFailure(result, 'EMERGENCY_GIT_ANCESTOR_CHECK_FAILED', 'Git ancestor check');
}

export function inspectEmergencyLocalReleaseSource({
  cwd = process.cwd(),
  expectedCommit,
  baselineCommit,
  checkCheckout = true,
} = {}) {
  const root = path.resolve(cwd);
  const expected = String(expectedCommit || '').trim();
  const expectedBaseline = String(baselineCommit || '').trim();
  const empty = Object.freeze([]);
  try {
    const headAttempt = resolveGitCommitAttempt(root, 'HEAD', {field: 'head', requireHex: false});
    const targetAttempt = expected
      ? resolveGitCommitAttempt(root, expected, {field: 'commit'})
      : {commit: '', error: null};
    const baselineAttempt = expectedBaseline
      ? resolveGitCommitAttempt(root, expectedBaseline, {field: 'baselineCommit'})
      : {commit: '', error: null};
    const issues = [];
    if (!headAttempt.commit) issues.push('source_head_unresolved');
    if (expected && !targetAttempt.commit) issues.push(sourceIssueFromError(targetAttempt.error, 'target_commit_unresolved'));
    if (expectedBaseline && !baselineAttempt.commit) issues.push(sourceIssueFromError(baselineAttempt.error, 'baseline_commit_unresolved'));

    let baselineIsAncestor = null;
    let baselineRelation = 'not-checked';
    let baselineEqualTarget = false;
    if (baselineAttempt.commit && targetAttempt.commit) {
      const relation = inspectAncestorRelation(root, baselineAttempt.commit, targetAttempt.commit);
      baselineIsAncestor = relation.isAncestor;
      baselineRelation = relation.relation;
      baselineEqualTarget = relation.relation === 'equal';
      if (!relation.isAncestor) issues.push('baseline_not_ancestor');
    }

    let dirtyEntries = empty;
    let hiddenIndexEntries = empty;
    let missingTrackedFiles = empty;
    let trackedFileCount = 0;
    if (checkCheckout) {
      dirtyEntries = splitNull(gitBuffer(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
      const indexEntries = splitNull(gitBuffer(root, ['ls-files', '-v', '-z']));
      hiddenIndexEntries = indexEntries
        .filter(entry => entry.startsWith('S ') || /^[a-z] /.test(entry))
        .map(entry => entry.slice(2));
      const trackedFiles = splitNull(gitBuffer(root, ['ls-files', '-z']));
      trackedFileCount = trackedFiles.length;
      missingTrackedFiles = trackedFiles.filter(file => {
        try {
          fsSync.lstatSync(path.join(root, file));
          return false;
        } catch (error) {
          if (error?.code === 'ENOENT') return true;
          throw error;
        }
      });
      if (dirtyEntries.length) issues.push('source_dirty');
      if (hiddenIndexEntries.length) issues.push('source_hidden_index');
      if (missingTrackedFiles.length) issues.push('source_missing_tracked');
    }

    const head = headAttempt.commit;
    const resolvedExpected = targetAttempt.commit;
    const resolvedBaseline = baselineAttempt.commit;
    const commitMatches = Boolean(!resolvedExpected || head === resolvedExpected);
    if (resolvedExpected && !commitMatches) issues.push('source_head_mismatch');
    const targetResolved = Boolean(!expected || resolvedExpected);
    const baselineResolved = Boolean(!expectedBaseline || resolvedBaseline);
    return Object.freeze({
      ok: targetResolved
        && baselineResolved
        && (!expected || commitMatches)
        && (!expectedBaseline || baselineIsAncestor === true)
        && (!checkCheckout || (
          dirtyEntries.length === 0
          && hiddenIndexEntries.length === 0
          && missingTrackedFiles.length === 0
        )),
      cwd: root,
      head,
      expectedCommit: resolvedExpected,
      targetCommit: resolvedExpected,
      baselineCommit: resolvedBaseline,
      commitMatches,
      baselineIsAncestor,
      baselineRelation,
      baselineEqualTarget,
      checkoutChecked: checkCheckout,
      dirtyEntries: Object.freeze(dirtyEntries),
      hiddenIndexEntries: Object.freeze(hiddenIndexEntries),
      missingTrackedFiles: Object.freeze(missingTrackedFiles),
      trackedFileCount,
      issues: Object.freeze(uniqueIssues(issues)),
    });
  } catch (error) {
    const summary = error?.gitErrorSummary ? `: ${error.gitErrorSummary}` : '';
    return Object.freeze({
      ok: false,
      cwd: root,
      head: '',
      expectedCommit: '',
      targetCommit: '',
      baselineCommit: '',
      commitMatches: false,
      baselineIsAncestor: null,
      baselineRelation: 'unknown',
      baselineEqualTarget: false,
      checkoutChecked: checkCheckout,
      dirtyEntries: empty,
      hiddenIndexEntries: empty,
      missingTrackedFiles: empty,
      trackedFileCount: 0,
      issues: Object.freeze([sourceIssueFromError(error, 'source_inspection_failed')]),
      errorCode: String(error?.code || 'EMERGENCY_SOURCE_INSPECTION_FAILED'),
      error: limitUtf8(`Git source inspection failed${summary}`, MAX_GIT_STDERR_SUMMARY_BYTES),
    });
  }
}

function parseBundleHeadCommits(output) {
  return [...new Set(String(output || '')
    .split(/[\r\n]+/u)
    .map(line => line.trim().split(/\s+/u)[0])
    .filter(value => HEX_COMMIT.test(value)))];
}

export function verifyEmergencyLocalReleaseBundle({
  bundleFile,
  cwd = process.cwd(),
  targetCommit,
  baselineCommit,
  expectedSha256 = '',
  maxBytes,
} = {}) {
  const root = path.resolve(cwd);
  const target = resolveGitCommit(root, targetCommit, {field: 'commit'});
  const baseline = resolveGitCommit(root, baselineCommit, {field: 'baselineCommit'});
  const relation = inspectAncestorRelation(root, baseline, target);
  const initial = hashEmergencyLocalReleaseBundle(bundleFile, {maxBytes});
  const issues = [];
  const verifyCommand = runGit(root, ['bundle', 'verify', '--', initial.file]);
  const listHeadsCommand = runGit(root, ['bundle', 'list-heads', '--', initial.file]);
  const headCommits = listHeadsCommand.ok ? parseBundleHeadCommits(listHeadsCommand.value) : [];
  const targetInHeads = headCommits.includes(target);
  let final = null;
  let finalError = null;
  try {
    final = hashEmergencyLocalReleaseBundle(initial.file, {maxBytes});
  } catch (error) {
    finalError = error;
  }

  if (!verifyCommand.ok) issues.push('bundle_git_verify_failed');
  if (!listHeadsCommand.ok) issues.push('bundle_list_heads_failed');
  if (listHeadsCommand.ok && !targetInHeads) issues.push('bundle_target_not_head');
  if (!relation.isAncestor) issues.push('baseline_not_ancestor');
  if (!final) {
    issues.push(String(finalError?.code || 'EMERGENCY_BUNDLE_REHASH_FAILED').toLowerCase());
  } else if (final.size !== initial.size || final.sha256 !== initial.sha256) {
    issues.push('bundle_changed_during_verification');
  }
  const observed = final || initial;
  if (expectedSha256 && observed.sha256 !== expectedSha256) issues.push('bundle_hash_mismatch');

  return Object.freeze({
    ok: issues.length === 0,
    file: initial.file,
    size: observed.size,
    sha256: observed.sha256,
    initialSize: initial.size,
    initialSha256: initial.sha256,
    finalSize: final?.size ?? null,
    finalSha256: final?.sha256 || '',
    bindingStable: Boolean(final && final.size === initial.size && final.sha256 === initial.sha256),
    gitBundleVerified: verifyCommand.ok,
    gitBundleVerify: Object.freeze({
      ok: verifyCommand.ok,
      exitCode: verifyCommand.status,
      stderrSummary: verifyCommand.summary,
    }),
    listHeadsVerified: listHeadsCommand.ok,
    listHeads: Object.freeze(headCommits),
    targetCommit: target,
    baselineCommit: baseline,
    baselineIsAncestor: relation.isAncestor,
    baselineRelation: relation.relation,
    baselineEqualTarget: relation.relation === 'equal',
    targetInHeads,
    issues: Object.freeze(uniqueIssues(issues)),
  });
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
  let bundleVerified = false;
  const bundleVerification = bundleFile ? 'not-verified' : 'not-run';
  if (receiptResult.ok && (verifySource || bundleFile)) {
    source = inspectEmergencyLocalReleaseSource({
      cwd,
      expectedCommit: receiptResult.receipt.commit,
      baselineCommit: receiptResult.receipt.baselineCommit,
      checkCheckout: verifySource,
    });
    if (verifySource && !source.ok) issues.push('source_integrity_invalid');
  }
  if (receiptResult.ok && bundleFile && source?.targetCommit && source?.baselineCommit) {
    try {
      bundle = verifyEmergencyLocalReleaseBundle({
        bundleFile,
        cwd,
        targetCommit: source.targetCommit,
        baselineCommit: source.baselineCommit,
        expectedSha256: receiptResult.receipt.bundleSha256,
        maxBytes: maxBundleBytes,
      });
      if (bundle.ok) bundleVerified = true;
      else issues.push(...bundle.issues);
    } catch (error) {
      issues.push(String(error?.code || 'bundle_verification_failed').toLowerCase());
    }
  } else if (receiptResult.ok && bundleFile) {
    issues.push('source_commit_binding_invalid');
  }
  return Object.freeze({
    ok: receiptResult.ok && issues.length === 0,
    file: receiptResult.file,
    receipt: receiptResult.receipt,
    receiptResult,
    bundle,
    bundleVerified,
    bundleVerification: bundleVerified ? 'verified' : bundleVerification,
    source,
    issues: uniqueIssues(issues),
  });
}
