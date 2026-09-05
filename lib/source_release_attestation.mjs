import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromise from 'node:fs/promises';

// Keep the legacy export for callers that still need to read an already-recorded
// v2 marker during the migration. New deployment receipts are always v3.
export const DEPLOYED_RELEASE_SCHEMA_VERSION = 'shein-bi-deployed-release/v2';
export const DEPLOYED_RELEASE_SCHEMA_VERSION_V3 = 'shein-bi-deployed-release/v3';
export const INVENTORY_WRITER_AUTHORITY_SCHEMA_VERSION = 'shein-bi-inventory-writer-authority/v1';
export const SOURCE_RELEASE_ATTESTATION_SCHEMA_VERSION = 3;

function fail(message, code = 'SOURCE_RELEASE_ATTESTATION_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw fail(`${label} keys are not exact`);
  }
}

// Reads a file through one already-open descriptor: lstat reject -> open with
// O_NOFOLLOW where available -> fstat -> bounded exact-size read -> fstat ->
// final path lstat.  The final path lstat must match the descriptor identity,
// otherwise a path/descriptor swap (including symlink following on platforms
// without O_NOFOLLOW) fails closed.  Sizes are strictly bounded and any
// deviation while reading is a race, not a retry.
export function readRegularBoundedFile(file, maxBytes, label) {
  const lstatBefore = fs.lstatSync(file);
  const statBefore = boundRegularStat(lstatBefore, label);
  if (statBefore.size > maxBytes) {
    throw fail(`${label} size is outside the allowed range`, 'SOURCE_RELEASE_FILE_SIZE_INVALID');
  }
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    throw fail(`${label} cannot be opened safely: ${error.message}`, 'SOURCE_RELEASE_FILE_OPEN_FAILED');
  }
  try {
    const fdStat = boundRegularStat(fs.fstatSync(fd), label);
    if (fdStat.size > maxBytes) {
      throw fail(`${label} size is outside the allowed range`, 'SOURCE_RELEASE_FILE_SIZE_INVALID');
    }
    if (fdStat.dev !== lstatBefore.dev || fdStat.ino !== lstatBefore.ino) {
      throw fail(`${label} path or descriptor identity changed between lstat and open`, 'SOURCE_RELEASE_FILE_RACE');
    }
    const bytes = Buffer.allocUnsafe(fdStat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const chunk = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (chunk <= 0 || offset + chunk > bytes.length) {
        throw fail(`${label} was truncated while reading`, 'SOURCE_RELEASE_FILE_RACE');
      }
      offset += chunk;
    }
    const afterRead = fs.fstatSync(fd);
    if (!sameFileIdentity(fdStat, afterRead)) {
      throw fail(`${label} changed while reading`, 'SOURCE_RELEASE_FILE_RACE');
    }
    const pathAfter = fs.lstatSync(file);
    if (!sameFileIdentity(fdStat, pathAfter)) {
      throw fail(`${label} path no longer refers to the opened descriptor`, 'SOURCE_RELEASE_FILE_PATH_SWAPPED');
    }
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

// Async counterpart with the same open-verified read contract.
export async function readRegularBoundedFileAsync(file, maxBytes, label) {
  const lstatBefore = await fsPromise.lstat(file);
  const statBefore = boundRegularStat(lstatBefore, label);
  if (statBefore.size > maxBytes) {
    throw fail(`${label} size is outside the allowed range`, 'SOURCE_RELEASE_FILE_SIZE_INVALID');
  }
  let handle;
  try {
    handle = await fsPromise.open(file, fs.constants.O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    throw fail(`${label} cannot be opened safely: ${error.message}`, 'SOURCE_RELEASE_FILE_OPEN_FAILED');
  }
  try {
    const fdStat = boundRegularStat(await handle.stat(), label);
    if (fdStat.size > maxBytes) {
      throw fail(`${label} size is outside the allowed range`, 'SOURCE_RELEASE_FILE_SIZE_INVALID');
    }
    if (fdStat.dev !== lstatBefore.dev || fdStat.ino !== lstatBefore.ino) {
      throw fail(`${label} path or descriptor identity changed between lstat and open`, 'SOURCE_RELEASE_FILE_RACE');
    }
    const bytes = Buffer.allocUnsafe(fdStat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const {bytesRead} = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead <= 0 || offset + bytesRead > bytes.length) {
        throw fail(`${label} was truncated while reading`, 'SOURCE_RELEASE_FILE_RACE');
      }
      offset += bytesRead;
    }
    const afterRead = await handle.stat();
    if (!sameFileIdentity(fdStat, afterRead)) {
      throw fail(`${label} changed while reading`, 'SOURCE_RELEASE_FILE_RACE');
    }
    const pathAfter = await fsPromise.lstat(file);
    if (!sameFileIdentity(fdStat, pathAfter)) {
      throw fail(`${label} path no longer refers to the opened descriptor`, 'SOURCE_RELEASE_FILE_PATH_SWAPPED');
    }
    return Object.freeze({bytes, identity: statIdentity(afterRead)});
  } finally {
    await handle.close();
  }
}

function validIso(value) {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function validSha(value, length) {
  return new RegExp(`^[0-9a-f]{${length}}$`).test(String(value || ''));
}

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function statIdentity(stat) {
  return Object.freeze({
    dev: Number(stat?.dev || 0),
    ino: Number(stat?.ino || 0),
    mode: Number(stat?.mode || 0),
    size: Number(stat?.size || 0),
    mtimeMs: Number(stat?.mtimeMs || 0),
  });
}

const O_NOFOLLOW = Number(fs.constants?.O_NOFOLLOW) || 0;

function sameFileIdentity(left, right) {
  // This comparison is for two observations of the same open/path-bound file,
  // where ctime drift proves an in-place mutation even if size and mtime were
  // restored. Do not add ctime to statIdentity()/marker CAS snapshots: a
  // legitimate same-filesystem rename changes ctime on some platforms.
  return Boolean(left && right)
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

const MAX_BOUNDED_READ = 64 * 1024 * 1024;

function boundRegularStat(stat, label) {
  if (!stat?.isFile() || stat.isSymbolicLink() || (Number(stat.mode || 0) & 0o170000) !== 0o100000) {
    throw fail(`${label} must be a regular non-symlink file`, 'SOURCE_RELEASE_FILE_TYPE_INVALID');
  }
  if (stat.size < 1 || stat.size > MAX_BOUNDED_READ || stat.size !== Math.trunc(stat.size)) {
    throw fail(`${label} size is outside the allowed range`, 'SOURCE_RELEASE_FILE_SIZE_INVALID');
  }
  return stat;
}

export function repositoryNameFromGitRemote(remoteUrl) {
  const value = String(remoteUrl || '').trim();
  const match = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(value);
  if (!match) throw fail(`Unsupported GitHub origin URL: ${value || '<empty>'}`, 'SOURCE_RELEASE_REPOSITORY_INVALID');
  return `${match[1]}/${match[2]}`;
}

function verifyCiV2(ci, expectedRepository) {
  exactKeys(ci, ['workflow', 'event', 'branch', 'runId', 'runAttempt', 'url', 'completedAt'], 'release attestation CI');
  if (ci.workflow !== '.github/workflows/ci.yml'
    || ci.event !== 'push'
    || ci.branch !== 'main'
    || !Number.isInteger(ci.runId) || ci.runId < 1
    || !Number.isInteger(ci.runAttempt) || ci.runAttempt < 1
    || ci.url !== `https://github.com/${expectedRepository}/actions/runs/${ci.runId}`
    || !validIso(ci.completedAt)) {
    throw fail('Release attestation CI binding is invalid');
  }
}

function verifyCiV3(ci, expectedRepository) {
  exactKeys(
    ci,
    ['workflow', 'event', 'branch', 'runId', 'runAttempt', 'url', 'completedAt', 'jobCount', 'jobsSha256'],
    'release attestation CI',
  );
  if (ci.workflow !== '.github/workflows/ci.yml'
    || ci.event !== 'push'
    || ci.branch !== 'main'
    || !Number.isInteger(ci.runId) || ci.runId < 1
    || !Number.isInteger(ci.runAttempt) || ci.runAttempt < 1
    || ci.url !== `https://github.com/${expectedRepository}/actions/runs/${ci.runId}`
    || !validIso(ci.completedAt)
    || !Number.isInteger(ci.jobCount) || ci.jobCount < 1
    || !validSha(ci.jobsSha256, 64)) {
    throw fail('Release attestation CI jobs binding is invalid');
  }
}

export function verifySourceReleaseAttestationBuffers({
  attestationBytes,
  checksumBytes,
  expectedRepository,
  expectedRepositoryId,
  expectedTag,
  expectedCommit,
  expectedTrustPolicySha256,
  expectedSourceWorkflowPath = '.github/workflows/source-release.yml',
} = {}) {
  const attestationBuffer = Buffer.isBuffer(attestationBytes) ? attestationBytes : Buffer.from(attestationBytes || '');
  const checksumBuffer = Buffer.isBuffer(checksumBytes) ? checksumBytes : Buffer.from(checksumBytes || '');
  if (attestationBuffer.length < 1 || attestationBuffer.length > 64 * 1024) {
    throw fail('Release attestation size is outside the allowed range');
  }
  if (checksumBuffer.length < 1 || checksumBuffer.length > 1024) {
    throw fail('Release attestation checksum size is outside the allowed range');
  }
  const attestationSha256 = sha256Hex(attestationBuffer);
  const checksumSha256 = sha256Hex(checksumBuffer);
  const checksumMatch = /^([0-9a-f]{64})  release-attestation\.json\n$/.exec(checksumBuffer.toString('utf8'));
  if (!checksumMatch || checksumMatch[1] !== attestationSha256) {
    throw fail('Release attestation checksum file does not exactly bind release-attestation.json');
  }

  let attestation;
  try {
    attestation = JSON.parse(attestationBuffer.toString('utf8'));
  } catch (error) {
    throw fail(`Release attestation JSON is invalid: ${error.message}`);
  }
  if (attestation?.schemaVersion === 2) {
    exactKeys(attestation, ['schemaVersion', 'repository', 'version', 'tag', 'commit', 'ci', 'sourceWorkflow'], 'release attestation');
    exactKeys(attestation.sourceWorkflow, ['path'], 'release attestation source workflow');
    if (typeof attestation.repository !== 'string'
      || attestation.repository !== expectedRepository
      || attestation.version !== expectedTag
      || attestation.tag !== expectedTag
      || attestation.commit !== expectedCommit) {
      throw fail('Release attestation repository, tag, or commit does not match the deployment target');
    }
    verifyCiV2(attestation.ci, expectedRepository);
    if (attestation.sourceWorkflow.path !== expectedSourceWorkflowPath) {
      throw fail('Release attestation source workflow path is invalid');
    }
  } else if (attestation?.schemaVersion === SOURCE_RELEASE_ATTESTATION_SCHEMA_VERSION) {
    exactKeys(
      attestation,
      ['schemaVersion', 'repository', 'version', 'tag', 'commit', 'trustPolicySha256', 'ci', 'sourceWorkflow'],
      'release attestation',
    );
    exactKeys(attestation.repository, ['id', 'fullName'], 'release attestation repository');
    exactKeys(attestation.sourceWorkflow, ['path'], 'release attestation source workflow');
    if (!Number.isInteger(attestation.repository.id) || attestation.repository.id < 1
      || attestation.repository.id !== expectedRepositoryId
      || attestation.repository.fullName !== expectedRepository
      || attestation.version !== expectedTag
      || attestation.tag !== expectedTag
      || attestation.commit !== expectedCommit
      || !validSha(attestation.trustPolicySha256, 64)
      || attestation.trustPolicySha256 !== expectedTrustPolicySha256) {
      throw fail('Release attestation v3 repository, policy, tag, or commit binding is invalid');
    }
    verifyCiV3(attestation.ci, expectedRepository);
    if (attestation.sourceWorkflow.path !== expectedSourceWorkflowPath) {
      throw fail('Release attestation source workflow path is invalid');
    }
  } else {
    throw fail(`Unsupported release attestation schema: ${attestation?.schemaVersion ?? '<missing>'}`);
  }
  return Object.freeze({
    attestation,
    attestationSha256,
    checksumSha256,
    attestationBytes: attestationBuffer,
    checksumBytes: checksumBuffer,
  });
}

export function verifySourceReleaseAttestationFiles(options = {}) {
  const attestationBytes = readRegularBoundedFile(options.attestationFile, 64 * 1024, 'release attestation');
  const checksumBytes = readRegularBoundedFile(options.checksumFile, 1024, 'release attestation checksum');
  return verifySourceReleaseAttestationBuffers({...options, attestationBytes, checksumBytes});
}

export function expectedAnnotatedTagMessage({tag, commit, ci, attestationSha256}) {
  return [
    `Source release ${tag}`,
    `commit: ${commit}`,
    `ci-run-id: ${ci.runId}`,
    `ci-run-attempt: ${ci.runAttempt}`,
    `release-attestation-sha256: ${attestationSha256}`,
    '',
  ].join('\n');
}

export function buildDeployedReleaseMarker({
  repository,
  tag,
  commit,
  tagObject,
  attestation,
  attestationSha256,
  checksumSha256,
  trustPolicy,
  trustPolicySha256,
  remoteEvidence,
  sourceFingerprint,
  recordedAt = new Date().toISOString(),
  inventoryWriterAuthority,
} = {}) {
  const required = {
    repository,
    tag,
    commit,
    tagObject,
    attestation,
    attestationSha256,
    checksumSha256,
    trustPolicy,
    trustPolicySha256,
    remoteEvidence,
    sourceFingerprint,
  };
  const missing = Object.entries(required)
    .filter(([, value]) => value === undefined || value === null || value === '')
    .map(([key]) => key);
  if (missing.length) {
    throw fail(
      `Deployment marker v3 requires trust policy, remote release evidence, and the exact source fingerprint; missing: ${missing.join(', ')}`,
      'SOURCE_RELEASE_MARKER_V3_REQUIRED',
    );
  }
  return Object.freeze({
    schemaVersion: DEPLOYED_RELEASE_SCHEMA_VERSION_V3,
    repository,
    repositoryId: trustPolicy.repository.id,
    tag,
    commit,
    tagObject,
    trustPolicy: {
      schemaVersion: trustPolicy.schemaVersion,
      sha256: trustPolicySha256,
      ciWorkflowPath: trustPolicy.ci.workflowPath,
      sourceWorkflowPath: trustPolicy.sourceRelease.workflowPath,
    },
    releaseAttestation: {sha256: attestationSha256, checksumSha256, schemaVersion: attestation.schemaVersion},
    ci: {...attestation.ci},
    sourceWorkflow: {...attestation.sourceWorkflow},
    remoteEvidence: {
      verifiedAt: remoteEvidence.verifiedAt,
      releaseId: remoteEvidence.releaseId,
      releaseUrl: remoteEvidence.releaseUrl,
      publishedAt: remoteEvidence.publishedAt,
      immutable: remoteEvidence.immutable,
      assets: remoteEvidence.assets.map(asset => ({...asset})),
      warnings: [...(remoteEvidence.warnings || [])],
    },
    sourceFingerprint,
    recordedAt,
    ...(inventoryWriterAuthority ? {
      inventoryWriterAuthority: {
        schemaVersion: INVENTORY_WRITER_AUTHORITY_SCHEMA_VERSION,
        receiptFile: inventoryWriterAuthority.receiptFile,
        receiptSha256: inventoryWriterAuthority.receiptSha256,
        bundleSha256: inventoryWriterAuthority.bundleSha256,
      },
    } : {}),
  });
}

function validateLegacyMarker(marker, issues) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(String(marker.repository || ''))) issues.push('repository_invalid');
  if (!/^\d{4}\.\d{2}\.\d{2}\.[1-9]\d*$/.test(String(marker.tag || ''))) issues.push('tag_invalid');
  if (!validSha(marker.commit, 40)) issues.push('commit_invalid');
  if (!validSha(marker.tagObject, 40)) issues.push('tag_object_invalid');
  if (!validSha(marker.releaseAttestation?.sha256, 64)) issues.push('attestation_sha_invalid');
  if (!validSha(marker.releaseAttestation?.checksumSha256, 64)) issues.push('checksum_sha_invalid');
  if (![2, 3].includes(marker.releaseAttestation?.schemaVersion)) issues.push('attestation_schema_invalid');
  if (marker.ci?.workflow !== '.github/workflows/ci.yml'
    || marker.ci?.event !== 'push'
    || marker.ci?.branch !== 'main'
    || !Number.isInteger(marker.ci?.runId) || marker.ci.runId < 1
    || !Number.isInteger(marker.ci?.runAttempt) || marker.ci.runAttempt < 1
    || !validIso(marker.ci?.completedAt)) issues.push('ci_binding_invalid');
  if (marker.ci?.url !== `https://github.com/${marker.repository}/actions/runs/${marker.ci?.runId}`) issues.push('ci_url_invalid');
  if (marker.sourceWorkflow?.path !== '.github/workflows/source-release.yml') issues.push('source_workflow_invalid');
  if (!validIso(marker.recordedAt)) issues.push('recorded_at_invalid');
}

export function validateDeployedReleaseMarker(marker, {requireV3 = false} = {}) {
  const issues = [];
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
    return {ok: false, issues: ['marker_not_object']};
  }
  const isV3 = marker.schemaVersion === DEPLOYED_RELEASE_SCHEMA_VERSION_V3;
  const isV2 = marker.schemaVersion === DEPLOYED_RELEASE_SCHEMA_VERSION;
  if (!isV3 && !(isV2 && !requireV3)) issues.push('schema_version_invalid');
  validateLegacyMarker(marker, issues);
  if (isV3) {
    if (!Number.isInteger(marker.repositoryId) || marker.repositoryId < 1) issues.push('repository_id_invalid');
    if (marker.trustPolicy?.schemaVersion !== 'shein-bi-source-release-trust-policy/v1'
      || !validSha(marker.trustPolicy?.sha256, 64)
      || marker.trustPolicy?.ciWorkflowPath !== '.github/workflows/ci.yml'
      || marker.trustPolicy?.sourceWorkflowPath !== '.github/workflows/source-release.yml') {
      issues.push('trust_policy_binding_invalid');
    }
    if (!validSha(marker.ci?.jobsSha256, 64)
      || !Number.isInteger(marker.ci?.jobCount) || marker.ci.jobCount < 1) issues.push('ci_jobs_binding_invalid');
    const remote = marker.remoteEvidence;
    if (!validIso(remote?.verifiedAt)
      || !Number.isInteger(remote?.releaseId) || remote.releaseId < 1
      || typeof remote?.releaseUrl !== 'string' || remote.releaseUrl.length < 1
      || !validIso(remote?.publishedAt)
      || remote?.immutable !== true
      || !Array.isArray(remote?.warnings)
      || !Array.isArray(remote?.assets) || remote.assets.length !== 2) issues.push('remote_evidence_invalid');
    if (Array.isArray(remote?.assets)) {
      const names = remote.assets.map(asset => asset?.name).sort();
      if (names.join('\n') !== 'release-attestation.json\nrelease-attestation.json.sha256'
        || remote.assets.some(asset => !Number.isInteger(asset?.id) || asset.id < 1
          || !Number.isInteger(asset?.size) || asset.size < 1
          || !/^sha256:[0-9a-f]{64}$/.test(String(asset?.digest || ''))
          || !validSha(asset?.bytesSha256, 64))) issues.push('remote_asset_evidence_invalid');
    }
    if (!validSha(marker.sourceFingerprint, 64)) issues.push('source_fingerprint_invalid');
    if (marker.inventoryWriterAuthority !== undefined) {
      const auth = marker.inventoryWriterAuthority;
      if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
        issues.push('inventory_writer_authority_not_object');
      } else {
        if (auth.schemaVersion !== INVENTORY_WRITER_AUTHORITY_SCHEMA_VERSION) issues.push('inventory_writer_authority_schema_version_invalid');
        if (!validSha(auth.bundleSha256, 64)) issues.push('inventory_writer_authority_bundle_sha_invalid');
        if (!validSha(auth.receiptSha256, 64)) issues.push('inventory_writer_authority_receipt_sha_invalid');
        if (typeof auth.receiptFile !== 'string' || !auth.receiptFile.trim()) issues.push('inventory_writer_authority_receipt_file_invalid');
        if (validSha(marker.releaseAttestation?.sha256, 64) && validSha(auth.receiptSha256, 64) && auth.receiptSha256 !== marker.releaseAttestation.sha256) {
          issues.push('inventory_writer_authority_receipt_sha_mismatch');
        }
      }
    }
  }
  return {ok: issues.length === 0, issues: [...new Set(issues)]};
}
