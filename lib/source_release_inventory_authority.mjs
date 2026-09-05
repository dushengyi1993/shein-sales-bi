/**
 * Formal inventory authority binding and source bundle verification.
 *
 * Establishes immutable, reproducible authority between:
 * 1. Exact verified source git bundle (bundleSha256)
 * 2. Immutable release-attestation.json (releaseReceiptHash & canonical receipt path)
 * 3. Exact clean source checkout (deployedCommit, sourceFingerprint, trackedSourceClean)
 */

import crypto from 'node:crypto';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

import {
  expectedAnnotatedTagMessage,
  readRegularBoundedFile,
  repositoryNameFromGitRemote,
  sha256Hex,
  verifySourceReleaseAttestationFiles,
} from './source_release_attestation.mjs';
import {validateSourceReleaseTrustPolicy} from './source_release_github_evidence.mjs';

export const INVENTORY_WRITER_AUTHORITY_SCHEMA_VERSION = 'shein-bi-inventory-writer-authority/v1';
export const DEFAULT_SOURCE_RELEASE_BUNDLE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_ATTESTATION_RECEIPT_BYTES = 64 * 1024;
export const DEFAULT_RELEASE_ATTESTATION_ROOT = '/srv/shein-bi/runtime/release-attestations';

const HASH_RE = /^[a-f0-9]{64}$/u;
const COMMIT_RE = /^[a-f0-9]{40}$/u;
const O_NOFOLLOW = Number(fsSync.constants?.O_NOFOLLOW) || 0;
const MAX_GIT_STDERR_SUMMARY_BYTES = 240;

export class InventoryAuthorityError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'InventoryAuthorityError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new InventoryAuthorityError(code, message, details);
}

function text(value) {
  return String(value ?? '').trim();
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

function summarizeGitStderr(error) {
  const stderr = Buffer.isBuffer(error?.stderr)
    ? error.stderr.toString('utf8')
    : String(error?.stderr || '');
  const firstLine = stderr
    .split(/[\r\n]+/u)
    .map(val => val.trim())
    .find(Boolean);
  if (!firstLine) return '';
  return firstLine.slice(0, MAX_GIT_STDERR_SUMMARY_BYTES);
}

function runGit(cwd, args, {encoding = 'utf8', maxBuffer = 16 * 1024 * 1024, timeout = 120_000} = {}) {
  try {
    return Object.freeze({
      ok: true,
      value: execFileSync('git', ['-c', `safe.directory=${cwd}`, ...args], {
        cwd,
        encoding,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer,
        timeout,
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

function readPolicySync(cwd, policyFile) {
  const file = path.resolve(policyFile || path.join(cwd, 'config', 'source_release_trust_policy.json'));
  const bytes = readRegularBoundedFile(file, 64 * 1024, 'source release trust policy');
  let policy;
  try {
    policy = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw fail('SOURCE_RELEASE_POLICY_INVALID', `Trust policy JSON is invalid: ${error.message}`);
  }
  return Object.freeze({file, bytes, sha256: sha256Hex(bytes), policy: validateSourceReleaseTrustPolicy(policy)});
}

/**
 * Verifies that a file is an ordinary non-symlink file and computes its SHA-256
 * under double-stat protection against concurrent modification or symlink swap.
 */
export function hashSourceReleaseBundle(file, {maxBytes = DEFAULT_SOURCE_RELEASE_BUNDLE_MAX_BYTES} = {}) {
  const target = path.resolve(text(file));
  if (!target) fail('SOURCE_RELEASE_BUNDLE_PATH_REQUIRED', 'Source release bundle path is required');
  let before;
  try {
    before = fsSync.lstatSync(target);
  } catch (error) {
    fail(error?.code === 'ENOENT' ? 'SOURCE_RELEASE_BUNDLE_MISSING' : 'SOURCE_RELEASE_BUNDLE_STAT_FAILED',
      `Source release bundle cannot be inspected: ${error.message}`);
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    fail('SOURCE_RELEASE_BUNDLE_TYPE_INVALID', 'Source release bundle must be a regular non-symlink file');
  }
  if (before.size < 1 || before.size > maxBytes) {
    fail('SOURCE_RELEASE_BUNDLE_SIZE_INVALID', 'Source release bundle size is outside the allowed range');
  }

  let fd;
  try {
    try {
      fd = fsSync.openSync(target, fsSync.constants.O_RDONLY | O_NOFOLLOW);
    } catch (error) {
      fail('SOURCE_RELEASE_BUNDLE_OPEN_FAILED', `Source release bundle cannot be opened safely: ${error.message}`);
    }
    const opened = fsSync.fstatSync(fd);
    if (!opened.isFile() || opened.isSymbolicLink() || !sameStat(before, opened)) {
      fail('SOURCE_RELEASE_BUNDLE_CHANGED', 'Source release bundle changed before hashing');
    }
    if (opened.size < 1 || opened.size > maxBytes) {
      fail('SOURCE_RELEASE_BUNDLE_SIZE_INVALID', 'Source release bundle size is outside the allowed range');
    }
    const hash = crypto.createHash('sha256');
    const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, opened.size)));
    let position = 0;
    while (position < opened.size) {
      const wanted = Math.min(chunk.length, opened.size - position);
      const bytesRead = fsSync.readSync(fd, chunk, 0, wanted, position);
      if (!Number.isInteger(bytesRead) || bytesRead < 1) {
        fail('SOURCE_RELEASE_BUNDLE_READ_FAILED', 'Source release bundle ended before its bounded size was read');
      }
      hash.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    const afterFd = fsSync.fstatSync(fd);
    const afterPath = fsSync.lstatSync(target);
    if (!sameStat(opened, afterFd) || !sameStat(before, afterPath)) {
      fail('SOURCE_RELEASE_BUNDLE_CHANGED', 'Source release bundle changed while hashing');
    }
    return Object.freeze({file: target, size: opened.size, sha256: hash.digest('hex').toLowerCase()});
  } finally {
    if (fd !== undefined) {
      try { fsSync.closeSync(fd); } catch {}
    }
  }
}

/**
 * Validates that bundleFile is a genuine git bundle, hashes it, and verifies in an
 * isolated temporary Git repository that the objects in the bundle unpack cleanly
 * and contain the exact target commit (and target tag peeled commit if provided).
 * Does NOT write any objects to the production or cwd repository.
 */
export function verifySourceReleaseBundle({
  bundleFile,
  cwd = process.cwd(),
  targetCommit,
  targetTag = '',
  expectedSha256 = '',
  maxBytes = DEFAULT_SOURCE_RELEASE_BUNDLE_MAX_BYTES,
} = {}) {
  const root = path.resolve(cwd);
  const normalizedTargetCommit = text(targetCommit).toLowerCase();
  if (!COMMIT_RE.test(normalizedTargetCommit)) {
    fail('SOURCE_RELEASE_BUNDLE_TARGET_COMMIT_INVALID', `Target commit must be 40-hex: ${targetCommit}`);
  }
  const normalizedExpectedSha256 = text(expectedSha256).toLowerCase();
  if (normalizedExpectedSha256 && !HASH_RE.test(normalizedExpectedSha256)) {
    fail('SOURCE_RELEASE_BUNDLE_EXPECTED_HASH_INVALID', `Expected bundle sha256 must be 64-hex: ${expectedSha256}`);
  }

  const initial = hashSourceReleaseBundle(bundleFile, {maxBytes});
  if (normalizedExpectedSha256 && initial.sha256 !== normalizedExpectedSha256) {
    fail('SOURCE_RELEASE_BUNDLE_HASH_MISMATCH',
      `Source bundle SHA-256 mismatch: expected ${normalizedExpectedSha256}, got ${initial.sha256}`,
      {expectedSha256: normalizedExpectedSha256, actualSha256: initial.sha256});
  }

  const verifyCommand = runGit(root, ['bundle', 'verify', '--', initial.file]);
  if (!verifyCommand.ok) {
    fail('SOURCE_RELEASE_BUNDLE_GIT_VERIFY_FAILED',
      `git bundle verify failed: ${verifyCommand.summary || 'unknown verification error'}`,
      {gitVerify: verifyCommand});
  }

  // Isolated temporary bare repository to unpack and verify the pack objects
  const isolatedDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'shein-bundle-verify-'));
  try {
    const initCmd = runGit(isolatedDir, ['init', '--bare']);
    if (!initCmd.ok) {
      fail('SOURCE_RELEASE_BUNDLE_VERIFY_INIT_FAILED', `Failed to initialize isolated verification repo: ${initCmd.summary}`);
    }
    // Unpack into an empty repository, independent of the checkout's objects.
    // A tag-only bundle is valid: it need not advertise the optional HEAD ref.
    const unpack = runGit(isolatedDir, ['bundle', 'unbundle', initial.file]);
    if (!unpack.ok) {
      fail('SOURCE_RELEASE_BUNDLE_OBJECTS_MISSING',
        `Source bundle pack cannot be restored independently: ${unpack.summary || 'unbundle failed'}`);
    }
    const advertised = new Map();
    for (const line of unpack.value.trim().split(/\r?\n/u)) {
      const match = /^([a-f0-9]{40}) ([^\s]+)$/u.exec(line);
      if (!match || advertised.has(match[2])) {
        fail('SOURCE_RELEASE_BUNDLE_OBJECTS_MISSING', 'Bundle advertised ref is malformed or duplicated');
      }
      const object = runGit(isolatedDir, ['cat-file', '-e', match[1]]);
      if (!object.ok) fail('SOURCE_RELEASE_BUNDLE_OBJECTS_MISSING', 'Bundle advertises an object absent from its pack');
      advertised.set(match[2], match[1]);
    }

    // Verify target commit object exists and resolves to exact commit in isolated pack
    const catCmd = runGit(isolatedDir, ['cat-file', '-e', `${normalizedTargetCommit}^{commit}`]);
    if (!catCmd.ok) {
      fail('SOURCE_RELEASE_BUNDLE_TARGET_NOT_IN_PACK',
        `Target commit ${normalizedTargetCommit} is not present in bundle objects`,
        {targetCommit: normalizedTargetCommit});
    }

    // If targetTag is provided, verify peeled commit matches targetCommit
    if (targetTag) {
      const tagRef = `refs/tags/${targetTag}`;
      const objectId = advertised.get(tagRef);
      const peelCmd = objectId ? runGit(isolatedDir, ['rev-parse', '--verify', `${objectId}^{commit}`]) : {ok:false};
      if (!peelCmd.ok || peelCmd.value.trim().toLowerCase() !== normalizedTargetCommit) {
        fail('SOURCE_RELEASE_BUNDLE_TAG_COMMIT_MISMATCH',
          `Target tag ${targetTag} in bundle does not peel to target commit ${normalizedTargetCommit}`,
          {targetTag, targetCommit: normalizedTargetCommit, peeled: peelCmd.value?.trim()});
      }
    }
  } finally {
    try {
      fsSync.rmSync(isolatedDir, {recursive: true, force: true});
    } catch {}
  }

  const final = hashSourceReleaseBundle(initial.file, {maxBytes});
  if (final.size !== initial.size || final.sha256 !== initial.sha256) {
    fail('SOURCE_RELEASE_BUNDLE_CHANGED', 'Source release bundle changed during verification');
  }

  return Object.freeze({
    ok: true,
    file: initial.file,
    size: final.size,
    sha256: final.sha256,
    targetCommit: normalizedTargetCommit,
  });
}

/**
 * Validates the inventoryWriterAuthority block on a deployment marker.
 */
export function validateInventoryWriterAuthority(authority, marker = {}) {
  const issues = [];
  if (!authority || typeof authority !== 'object' || Array.isArray(authority)) {
    return {ok: false, issues: ['authority_not_object']};
  }
  if (authority.schemaVersion !== INVENTORY_WRITER_AUTHORITY_SCHEMA_VERSION) {
    issues.push('authority_schema_version_invalid');
  }
  const bundleSha256 = text(authority.bundleSha256).toLowerCase();
  if (!HASH_RE.test(bundleSha256)) issues.push('authority_bundle_sha256_invalid');
  const receiptSha256 = text(authority.receiptSha256).toLowerCase();
  if (!HASH_RE.test(receiptSha256)) issues.push('authority_receipt_sha256_invalid');
  const receiptFile = text(authority.receiptFile);
  if (!receiptFile || typeof receiptFile !== 'string') issues.push('authority_receipt_file_invalid');

  if (marker.releaseAttestation?.sha256) {
    const expectedAttestationSha = text(marker.releaseAttestation.sha256).toLowerCase();
    if (receiptSha256 && receiptSha256 !== expectedAttestationSha) {
      issues.push('authority_receipt_sha256_mismatch_attestation');
    }
  }

  return {ok: issues.length === 0, issues: Object.freeze([...new Set(issues)])};
}

/**
 * Resolves the canonical formal inventory writer authority from a deployment marker,
 * verifying:
 * 1. Marker inventoryWriterAuthority schema and exact keys
 * 2. Exact canonical release attestation file path under releaseAttestationRoot
 * 3. Exact matching attestation file bytes SHA-256
 * 4. Genuine release attestation and checksum files verification via verifySourceReleaseAttestationFiles
 *    (commit, tag, repository, trust policy, checksum, CI workflow run/jobs)
 * 5. Local annotated git tag in cwd (exact tag object, peeled commit, expected tag message)
 */
export async function resolveFormalInventoryWriterAuthority({
  marker,
  cwd = process.cwd(),
  releaseAttestationRoot,
  trustPolicyFile,
} = {}) {
  if (!marker || !marker.inventoryWriterAuthority) {
    return {ok: false, reason: 'NO_FORMAL_AUTHORITY'};
  }
  const validation = validateInventoryWriterAuthority(marker.inventoryWriterAuthority, marker);
  if (!validation.ok) {
    fail('INVENTORY_WRITER_AUTHORITY_INVALID',
      `Deployed marker inventoryWriterAuthority is invalid: ${validation.issues.join(', ')}`,
      {issues: validation.issues});
  }
  const authority = marker.inventoryWriterAuthority;

  // 1. Verify exact canonical release attestation path
  const attestationRoot = path.resolve(
    releaseAttestationRoot
    || process.env.SHEIN_BI_RELEASE_ATTESTATION_ROOT
    || DEFAULT_RELEASE_ATTESTATION_ROOT
  );
  const canonicalReleaseDir = path.resolve(attestationRoot, marker.tag);
  if (path.dirname(canonicalReleaseDir) !== attestationRoot) {
    fail('INVENTORY_WRITER_AUTHORITY_PATH_UNSAFE', `Release attestation directory path is unsafe: ${canonicalReleaseDir}`);
  }
  const canonicalReceiptFile = path.resolve(canonicalReleaseDir, 'release-attestation.json');
  const canonicalChecksumFile = path.resolve(canonicalReleaseDir, 'release-attestation.json.sha256');

  if (path.resolve(authority.receiptFile) !== canonicalReceiptFile) {
    fail('INVENTORY_WRITER_AUTHORITY_PATH_MISMATCH',
      `inventoryWriterAuthority receiptFile (${authority.receiptFile}) must match exact canonical path (${canonicalReceiptFile})`,
      {receiptFile: authority.receiptFile, canonicalReceiptFile});
  }

  // 2. Load and validate trust policy
  const rootDir = path.resolve(cwd);
  const policyEvidence = readPolicySync(rootDir, trustPolicyFile);

  // 3. Verify repository binding
  let repository = policyEvidence.policy.repository.fullName;
  const remoteCheck = runGit(rootDir, ['remote', 'get-url', 'origin']);
  if (!remoteCheck.ok || !remoteCheck.value.trim()) {
    fail('SOURCE_RELEASE_REPOSITORY_DRIFT', `Git origin remote is missing or cannot be inspected: ${remoteCheck.summary || 'remote origin unavailable'}`);
  }
  const originRepo = repositoryNameFromGitRemote(remoteCheck.value.trim());
  if (originRepo !== policyEvidence.policy.repository.fullName) {
    fail('SOURCE_RELEASE_REPOSITORY_DRIFT', 'Git origin repository differs from tracked trust policy');
  }

  // 4. Verify release attestation and checksum files against expected target
  let verified;
  try {
    verified = verifySourceReleaseAttestationFiles({
      attestationFile: canonicalReceiptFile,
      checksumFile: canonicalChecksumFile,
      expectedRepository: repository,
      expectedRepositoryId: policyEvidence.policy.repository.id,
      expectedTag: marker.tag,
      expectedCommit: marker.commit,
      expectedTrustPolicySha256: policyEvidence.sha256,
      expectedSourceWorkflowPath: policyEvidence.policy.sourceRelease.workflowPath,
    });
  } catch (error) {
    fail('INVENTORY_WRITER_ATTESTATION_VERIFICATION_FAILED',
      `Formal release attestation verification failed: ${error.message}`,
      {error: String(error?.message || error)});
  }

  if (verified.attestationSha256.toLowerCase() !== authority.receiptSha256.toLowerCase()) {
    fail('INVENTORY_WRITER_RECEIPT_SHA_MISMATCH',
      `Formal release attestation file SHA mismatch: expected ${authority.receiptSha256}, got ${verified.attestationSha256}`,
      {file: canonicalReceiptFile, expected: authority.receiptSha256, actual: verified.attestationSha256});
  }

  // 5. Every formal authority requires the exact local annotated tag.
  {
    const ref = `refs/tags/${marker.tag}`;
    const tagTypeCheck = runGit(rootDir, ['cat-file', '-t', ref]);
    if (!tagTypeCheck.ok || tagTypeCheck.value.trim() !== 'tag') {
      fail('SOURCE_RELEASE_TAG_INVALID', `Deployment tag must be annotated: ${marker.tag}`);
    }
    const tagObjectCheck = runGit(rootDir, ['rev-parse', '--verify', ref]);
    if (!tagObjectCheck.ok || tagObjectCheck.value.trim() !== marker.tagObject) {
      fail('SOURCE_RELEASE_TAG_DRIFT', 'Deployment tagObject mismatch');
    }
    const peelCheck = runGit(rootDir, ['rev-parse', '--verify', `${ref}^{commit}`]);
    if (!peelCheck.ok || peelCheck.value.trim().toLowerCase() !== marker.commit.toLowerCase()) {
      fail('SOURCE_RELEASE_TAG_DRIFT', `Deployment tag peeled commit mismatch: ${marker.tag}`);
    }
    const rawTagCheck = runGit(rootDir, ['cat-file', 'tag', ref]);
    if (!rawTagCheck.ok || !rawTagCheck.value) {
      fail('SOURCE_RELEASE_TAG_INVALID', `Deployment tag object cannot be read: ${rawTagCheck.summary || 'cat-file failed'}`);
    }
    const rawTagObject = rawTagCheck.value;
    const separator = rawTagObject.indexOf('\n\n');
    const actualMessage = separator >= 0 ? rawTagObject.slice(separator + 2) : '';
    const expectedMessage = expectedAnnotatedTagMessage({
      tag: marker.tag,
      commit: marker.commit,
      ci: verified.attestation.ci,
      attestationSha256: verified.attestationSha256,
    });
    if (actualMessage !== expectedMessage) {
      fail('SOURCE_RELEASE_TAG_DRIFT', `Deployment tag attestation message mismatch: ${marker.tag}`);
    }
  }

  return Object.freeze({
    ok: true,
    schemaVersion: authority.schemaVersion,
    releaseReceiptKind: 'formal',
    releaseReceiptHash: verified.attestationSha256.toLowerCase(),
    releaseReceiptFile: canonicalReceiptFile,
    bundleSha256: authority.bundleSha256.toLowerCase(),
  });
}
