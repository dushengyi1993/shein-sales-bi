#!/usr/bin/env node
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {writeJsonFileAtomic} from '../lib/atomic_file_publish.mjs';
import {acquireCrossProcessTicketLock} from '../lib/cross_process_ticket_lock.mjs';
import {parseSourceReleaseVersion} from '../lib/source_release_version.mjs';
import {
  buildDeployedReleaseMarker,
  DEPLOYED_RELEASE_SCHEMA_VERSION_V3,
  expectedAnnotatedTagMessage,
  repositoryNameFromGitRemote,
  sha256Hex,
  validateDeployedReleaseMarker,
  verifySourceReleaseAttestationFiles,
} from '../lib/source_release_attestation.mjs';
import {
  readRegularBoundedFile,
  readRegularBoundedFileAsync,
  statIdentity,
} from '../lib/source_release_attestation.mjs';
import {
  createGitHubEvidenceClient,
  stableJson,
  validateSourceReleaseTrustPolicy,
  verifyRemoteSourceReleaseEvidence,
} from '../lib/source_release_github_evidence.mjs';

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function git(cwd, args) {
  return execFileSync('git', ['-c', `safe.directory=${cwd}`, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function gitBuffer(cwd, args) {
  return execFileSync('git', ['-c', `safe.directory=${cwd}`, ...args], {
    cwd,
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function splitNull(value) {
  return Buffer.isBuffer(value)
    ? value.toString('utf8').split('\0').filter(Boolean)
    : String(value || '').split('\0').filter(Boolean);
}


function sameStat(left, right) {
  return stableJson(statIdentity(left)) === stableJson(statIdentity(right));
}

function hashTrackedWorktree(cwd, trackedFiles, indexBytes) {
  const hash = crypto.createHash('sha256');
  hash.update('shein-bi-release-source-fingerprint/v1\0');
  hash.update(indexBytes);
  for (const relative of trackedFiles) {
    const file = path.join(cwd, relative);
    let before;
    try {
      before = fsSync.lstatSync(file);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        hash.update(`missing\0${relative}\0`);
        continue;
      }
      throw error;
    }
    let bytes;
    if (before.isSymbolicLink()) bytes = Buffer.from(fsSync.readlinkSync(file), 'utf8');
    else if (before.isFile()) bytes = fsSync.readFileSync(file);
    else throw fail('SOURCE_RELEASE_TRACKED_TYPE_INVALID', `Tracked path is neither a file nor symlink: ${relative}`);
    const after = fsSync.lstatSync(file);
    if (!sameStat(before, after)) {
      throw fail('SOURCE_RELEASE_SOURCE_RACE', `Tracked source changed while fingerprinting: ${relative}`);
    }
    const identity = stableJson({path: relative, type: before.isSymbolicLink() ? 'symlink' : 'file', ...statIdentity(after)});
    hash.update(`${Buffer.byteLength(identity)}:${identity}\0`);
    hash.update(`${bytes.length}:`);
    hash.update(bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function inspectReleaseSourceState(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const expectedCommit = String(options.expectedCommit || '').trim();
  const head = git(cwd, ['rev-parse', 'HEAD']).trim();
  const resolvedExpected = expectedCommit
    ? git(cwd, ['rev-parse', '--verify', `${expectedCommit}^{commit}`]).trim()
    : '';
  const dirtyEntries = splitNull(gitBuffer(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
  const indexEntries = splitNull(gitBuffer(cwd, ['ls-files', '-v', '-z']));
  const hiddenIndexEntries = indexEntries
    .filter(entry => entry.startsWith('S ') || /^[a-z] /.test(entry))
    .map(entry => entry.slice(2));
  const trackedFiles = splitNull(gitBuffer(cwd, ['ls-files', '-z']));
  const indexBytes = gitBuffer(cwd, ['ls-files', '-s', '-z']);
  const missingTrackedFiles = trackedFiles.filter(file => {
    try {
      fsSync.lstatSync(path.join(cwd, file));
      return false;
    } catch (error) {
      if (error?.code === 'ENOENT') return true;
      throw error;
    }
  });
  const contentFingerprint = hashTrackedWorktree(cwd, trackedFiles, indexBytes);
  const commitMatches = !resolvedExpected || head === resolvedExpected;
  const sourceFingerprint = sha256Hex(`${stableJson({
    head,
    expectedCommit: resolvedExpected,
    dirtyEntries,
    hiddenIndexEntries,
    missingTrackedFiles,
    trackedFileCount: trackedFiles.length,
    contentFingerprint,
  })}\n`);
  return Object.freeze({
    ok: commitMatches
      && dirtyEntries.length === 0
      && hiddenIndexEntries.length === 0
      && missingTrackedFiles.length === 0,
    cwd,
    head,
    expectedCommit: resolvedExpected,
    commitMatches,
    dirtyEntries: Object.freeze(dirtyEntries),
    hiddenIndexEntries: Object.freeze(hiddenIndexEntries),
    missingTrackedFiles: Object.freeze(missingTrackedFiles),
    trackedFileCount: trackedFiles.length,
    contentFingerprint,
    sourceFingerprint,
  });
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

export function inspectDeploymentReleaseEvidence(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const tag = parseSourceReleaseVersion(options.tag).version;
  const commit = String(options.commit || '').trim();
  const policyEvidence = readPolicySync(cwd, options.trustPolicyFile);
  const remoteUrl = git(cwd, ['remote', 'get-url', 'origin']).trim();
  const repository = repositoryNameFromGitRemote(remoteUrl);
  if (repository !== policyEvidence.policy.repository.fullName) {
    throw fail('SOURCE_RELEASE_REPOSITORY_DRIFT', 'Git origin repository differs from tracked trust policy');
  }
  const verified = verifySourceReleaseAttestationFiles({
    attestationFile: options.attestationFile,
    checksumFile: options.checksumFile,
    expectedRepository: repository,
    expectedRepositoryId: policyEvidence.policy.repository.id,
    expectedTag: tag,
    expectedCommit: commit,
    expectedTrustPolicySha256: policyEvidence.sha256,
    expectedSourceWorkflowPath: policyEvidence.policy.sourceRelease.workflowPath,
  });
  const ref = `refs/tags/${tag}`;
  const tagType = git(cwd, ['cat-file', '-t', ref]).trim();
  if (tagType !== 'tag') throw fail('SOURCE_RELEASE_TAG_INVALID', `Deployment tag must be annotated: ${tag}`);
  const tagObject = git(cwd, ['rev-parse', '--verify', ref]).trim();
  const peeledCommit = git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  if (peeledCommit !== commit) throw fail('SOURCE_RELEASE_TAG_DRIFT', `Deployment tag commit mismatch: ${tag}`);
  const rawTagObject = git(cwd, ['cat-file', 'tag', ref]);
  const separator = rawTagObject.indexOf('\n\n');
  const actualMessage = separator >= 0 ? rawTagObject.slice(separator + 2) : '';
  const expectedMessage = expectedAnnotatedTagMessage({
    tag,
    commit,
    ci: verified.attestation.ci,
    attestationSha256: verified.attestationSha256,
  });
  if (actualMessage !== expectedMessage) {
    throw fail('SOURCE_RELEASE_TAG_DRIFT', `Deployment tag attestation message mismatch: ${tag}`);
  }
  return Object.freeze({
    repository,
    repositoryId: policyEvidence.policy.repository.id,
    tag,
    commit,
    tagObject,
    attestation: verified.attestation,
    attestationSha256: verified.attestationSha256,
    checksumSha256: verified.checksumSha256,
    attestationBytes: verified.attestationBytes,
    checksumBytes: verified.checksumBytes,
    trustPolicy: policyEvidence.policy,
    trustPolicySha256: policyEvidence.sha256,
  });
}

export function inspectRecordedDeploymentReleaseEvidence(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const marker = options.marker || {};
  const markerValidation = validateDeployedReleaseMarker(marker, {requireV3: true});
  if (!markerValidation.ok) return Object.freeze({ok: false, issues: markerValidation.issues, commit: ''});
  const attestationRoot = path.resolve(
    options.releaseAttestationRoot
      || process.env.SHEIN_BI_RELEASE_ATTESTATION_ROOT
      || '/srv/shein-bi/runtime/release-attestations',
  );
  const releaseDir = path.resolve(attestationRoot, marker.tag);
  if (path.dirname(releaseDir) !== attestationRoot) {
    return Object.freeze({ok: false, issues: ['release_attestation_path_unsafe'], commit: ''});
  }
  let verified;
  try {
    verified = inspectDeploymentReleaseEvidence({
      cwd,
      tag: marker.tag,
      commit: marker.commit,
      attestationFile: path.join(releaseDir, 'release-attestation.json'),
      checksumFile: path.join(releaseDir, 'release-attestation.json.sha256'),
      trustPolicyFile: options.trustPolicyFile,
    });
  } catch (error) {
    return Object.freeze({
      ok: false,
      issues: ['deployment_evidence_verification_failed'],
      errorCode: String(error?.code || 'SOURCE_RELEASE_ATTESTATION_INVALID'),
      error: String(error?.message || error).slice(0, 500),
      commit: '',
    });
  }
  const issues = [];
  for (const field of ['repository', 'tag', 'commit', 'tagObject']) {
    if (String(marker[field] || '') !== String(verified[field] || '')) issues.push(`${field}_evidence_mismatch`);
  }
  for (const field of ['sha256', 'checksumSha256', 'schemaVersion']) {
    const observed = field === 'sha256'
      ? verified.attestationSha256
      : field === 'checksumSha256' ? verified.checksumSha256 : verified.attestation.schemaVersion;
    if (marker.releaseAttestation?.[field] !== observed) issues.push(`release_attestation_${field}_evidence_mismatch`);
  }
  // Recorded deployment receipts are v3-only; the marker validation above
  // already rejects legacy schema versions before evidence is compared.
  const ciFields = ['workflow', 'event', 'branch', 'runId', 'runAttempt', 'url', 'completedAt', 'jobCount', 'jobsSha256'];
  if (ciFields.some(field => marker.ci?.[field] !== verified.attestation.ci?.[field])) issues.push('ci_evidence_mismatch');
  if (marker.sourceWorkflow?.path !== verified.attestation.sourceWorkflow?.path) issues.push('source_workflow_evidence_mismatch');
  if (marker.schemaVersion === DEPLOYED_RELEASE_SCHEMA_VERSION_V3) {
    if (marker.repositoryId !== verified.repositoryId) issues.push('repository_id_evidence_mismatch');
    if (marker.trustPolicy?.sha256 !== verified.trustPolicySha256) issues.push('trust_policy_sha_evidence_mismatch');
  }
  return Object.freeze({
    ok: issues.length === 0,
    issues: Object.freeze(issues),
    repository: verified.repository,
    tag: verified.tag,
    commit: issues.length === 0 ? verified.commit : '',
    tagObject: verified.tagObject,
    attestationSha256: verified.attestationSha256,
    checksumSha256: verified.checksumSha256,
    remoteEvidenceFresh: false,
    remoteEvidenceRole: 'cache-only',
  });
}

// The persisted deployment marker must be read under the same open-verified,
// bounded contract as every other marker read.  A plain pathname read here
// would follow a swapped-in symlink and would read an unbounded swapped file.
export const DEPLOYMENT_MARKER_MAX_BYTES = 1024 * 1024;

async function captureFileCas(file) {
  try {
    const read = await readRegularBoundedFileAsync(file, DEPLOYMENT_MARKER_MAX_BYTES, 'deployment marker');
    return Object.freeze({exists: true, identity: read.identity, sha256: sha256Hex(read.bytes)});
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({exists: false});
    throw error;
  }
}

function sameFileCas(left, right) {
  return stableJson(left) === stableJson(right);
}

function sameSourceSnapshot(left, right) {
  return left?.ok === true
    && right?.ok === true
    && left.head === right.head
    && left.expectedCommit === right.expectedCommit
    && left.sourceFingerprint === right.sourceFingerprint;
}

async function invalidateOwnedMarker(file, ownedSha256) {
  const current = await captureFileCas(file).catch(() => null);
  if (current?.exists && current.sha256 === ownedSha256) await fs.rm(file, {force: true});
}

function markerSiblingPath(file, label) {
  const nonce = crypto.randomBytes(12).toString('hex');
  return path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${nonce}.${label}`);
}

async function fsyncMarkerDirectory(file) {
  if (process.platform === 'win32') return;
  const handle = await fs.open(path.dirname(file), 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Node does not expose renameat2(RENAME_NOREPLACE), and a normal rename would
// overwrite a marker created after the final preflight. Publish through an
// atomic hard-link create instead. For a replacement, first atomically move
// the exact preflight inode to a private sibling, verify that displaced inode,
// then link the candidate into the now-empty pathname. A concurrent publisher
// wins with EEXIST and is never overwritten; the displaced marker is restored
// only when the public pathname is still empty.
async function publishDeploymentMarkerCas(file, marker, expectedCas, hooks = {}) {
  const target = path.resolve(file);
  const candidate = markerSiblingPath(target, 'candidate');
  const displaced = markerSiblingPath(target, 'displaced');
  let candidateCas;
  let displacedActive = false;
  let installed = false;
  let durable = false;
  let failure = null;

  await writeJsonFileAtomic(candidate, marker, {mode: 0o640});
  try {
    candidateCas = await captureFileCas(candidate);
    if (!candidateCas.exists) {
      throw fail('SOURCE_RELEASE_MARKER_WRITE_INVALID', 'Deployment marker candidate disappeared before publication');
    }

    if (expectedCas.exists) {
      try {
        await fs.rename(target, displaced);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          throw fail('SOURCE_RELEASE_MARKER_CAS_CONFLICT', 'Deployment marker disappeared before conditional publication');
        }
        throw error;
      }
      displacedActive = true;
      const displacedCas = await captureFileCas(displaced);
      if (!sameFileCas(expectedCas, displacedCas)) {
        throw fail('SOURCE_RELEASE_MARKER_CAS_CONFLICT', 'Deployment marker changed before conditional publication');
      }
    } else {
      const absentReadback = await captureFileCas(target);
      if (absentReadback.exists) {
        throw fail('SOURCE_RELEASE_MARKER_CAS_CONFLICT', 'Deployment marker appeared before conditional publication');
      }
    }

    await hooks.beforeMarkerPublish?.();
    try {
      await fs.link(candidate, target);
      installed = true;
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw fail('SOURCE_RELEASE_MARKER_CAS_CONFLICT', 'Concurrent deployment marker won conditional publication');
      }
      throw error;
    }
    await fsyncMarkerDirectory(target);
    durable = true;
  } catch (error) {
    failure = error;
    if (installed && !durable && candidateCas?.sha256) {
      await invalidateOwnedMarker(target, candidateCas.sha256).catch(() => {});
    }
  }

  let recoveryError = null;
  if (displacedActive) {
    if (!durable) {
      try {
        await fs.link(displaced, target);
      } catch (error) {
        // EEXIST means a concurrent publisher owns the public path. Preserve
        // it and retire only our displaced preflight snapshot.
        if (error?.code !== 'EEXIST') recoveryError = error;
      }
    }
    if (!recoveryError) await fs.rm(displaced, {force: true}).catch(error => { recoveryError = error; });
  }
  await fs.rm(candidate, {force: true}).catch(error => { recoveryError ||= error; });

  if (recoveryError) {
    throw fail('SOURCE_RELEASE_MARKER_RECOVERY_FAILED', 'Conditional marker publication could not restore its displaced state', {
      originalCode: failure?.code || '',
      displaced,
      recoveryError: String(recoveryError?.message || recoveryError),
    });
  }
  if (failure) throw failure;
  return Object.freeze({ownedSha256: candidateCas.sha256});
}

export async function recordDeploymentRelease(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const tag = parseSourceReleaseVersion(options.tag).version;
  const deploymentStateFile = path.resolve(options.deploymentStateFile);
  const lockPath = path.resolve(options.lockPath || `${deploymentStateFile}.record.lock`);
  let releaseLock;
  try {
    releaseLock = await acquireCrossProcessTicketLock(lockPath, {
      timeoutMs: Number(options.lockTimeoutMs ?? 30_000),
      staleMs: Number(options.lockStaleMs ?? 30 * 60_000),
      timeoutCode: 'SOURCE_RELEASE_DEPLOYMENT_LOCKED',
      timeoutMessage: `source release deployment transaction is already active: ${lockPath}`,
    });
    const initial = inspectReleaseSourceState({cwd, expectedCommit: options.expectedCommit || tag});
    if (!initial.ok) throw fail('SOURCE_RELEASE_SOURCE_NOT_CLEAN', 'Initial deployment source snapshot is not exact and clean');
    await options.hooks?.afterInitialSource?.(initial);

    const local = inspectDeploymentReleaseEvidence({
      cwd,
      tag,
      commit: initial.head,
      attestationFile: options.attestationFile,
      checksumFile: options.checksumFile,
      trustPolicyFile: options.trustPolicyFile,
    });
    const token = options.githubToken
      ?? process.env.SHEIN_BI_GITHUB_TOKEN
      ?? process.env.GH_TOKEN
      ?? process.env.GITHUB_TOKEN
      ?? '';
    if (!options.fetchImpl && !token) {
      throw fail('SOURCE_RELEASE_GITHUB_AUTH_MISSING', 'Live GitHub release verification requires a configured token');
    }
    const client = options.githubClient || createGitHubEvidenceClient({
      fetchImpl: options.fetchImpl || globalThis.fetch,
      token,
      apiBaseUrl: options.githubApiUrl || process.env.GITHUB_API_URL || 'https://api.github.com',
    });
    const remote = await verifyRemoteSourceReleaseEvidence({
      policy: local.trustPolicy,
      trustPolicySha256: local.trustPolicySha256,
      tag,
      commit: initial.head,
      attestationBytes: local.attestationBytes,
      checksumBytes: local.checksumBytes,
      client,
      now: options.now,
    });
    if (remote.tagObject !== local.tagObject) {
      throw fail('SOURCE_RELEASE_REMOTE_TAG_DRIFT', 'Local annotated tag object differs from GitHub remote tag object');
    }

    await options.hooks?.beforePreMarkerSource?.();
    const preMarker = inspectReleaseSourceState({cwd, expectedCommit: initial.head});
    if (!sameSourceSnapshot(initial, preMarker)) {
      throw fail('SOURCE_RELEASE_SOURCE_TOCTOU', 'Source changed before deployment marker preflight');
    }
    const markerCas = await captureFileCas(deploymentStateFile);
    await options.hooks?.beforeMarkerWrite?.();
    const writeGate = inspectReleaseSourceState({cwd, expectedCommit: initial.head});
    if (!sameSourceSnapshot(preMarker, writeGate)) {
      throw fail('SOURCE_RELEASE_SOURCE_TOCTOU', 'Source changed immediately before deployment marker write');
    }
    const markerCasReadback = await captureFileCas(deploymentStateFile);
    if (!sameFileCas(markerCas, markerCasReadback)) {
      throw fail('SOURCE_RELEASE_MARKER_CAS_CONFLICT', 'Deployment marker changed after transaction preflight');
    }

    const marker = buildDeployedReleaseMarker({
      repository: local.repository,
      tag,
      commit: initial.head,
      tagObject: local.tagObject,
      attestation: local.attestation,
      attestationSha256: local.attestationSha256,
      checksumSha256: local.checksumSha256,
      trustPolicy: local.trustPolicy,
      trustPolicySha256: local.trustPolicySha256,
      remoteEvidence: remote,
      sourceFingerprint: writeGate.sourceFingerprint,
      recordedAt: (options.now?.() || new Date()).toISOString(),
    });
    const validation = validateDeployedReleaseMarker(marker, {requireV3: true});
    if (!validation.ok) throw fail('SOURCE_RELEASE_MARKER_INVALID', `Generated marker v3 is invalid: ${validation.issues.join(',')}`);
    const publication = await publishDeploymentMarkerCas(
      deploymentStateFile,
      marker,
      markerCasReadback,
      options.hooks,
    );
    await options.hooks?.afterMarkerPersist?.();
    // First persisted readback reuses the same lstat-before, O_NOFOLLOW-open,
    // same-fd, size-bounded, path-identity-verified reader used by the CAS
    // snapshots.  Any symlink, path swap, non-regular, or over-limit marker at
    // this point fails closed instead of being trusted as owned bytes.
    const persistedRead = await readRegularBoundedFileAsync(
      deploymentStateFile,
      DEPLOYMENT_MARKER_MAX_BYTES,
      'deployment marker',
    );
    const ownedSha256 = sha256Hex(persistedRead.bytes);
    if (ownedSha256 !== publication.ownedSha256) {
      throw fail('SOURCE_RELEASE_MARKER_WRITE_INVALID', 'Persisted deployment marker bytes differ from the conditionally published candidate');
    }
    let parsed;
    try {
      parsed = JSON.parse(persistedRead.bytes.toString('utf8'));
    } catch (error) {
      throw fail('SOURCE_RELEASE_MARKER_WRITE_INVALID', `Persisted marker is invalid JSON: ${error.message}`);
    }
    if (stableJson(parsed) !== stableJson(marker)
      || !validateDeployedReleaseMarker(parsed, {requireV3: true}).ok) {
      await invalidateOwnedMarker(deploymentStateFile, ownedSha256);
      throw fail('SOURCE_RELEASE_MARKER_WRITE_INVALID', 'Persisted deployment marker does not match the intended v3 receipt');
    }

    await options.hooks?.afterMarkerWrite?.();
    const afterMarker = inspectReleaseSourceState({cwd, expectedCommit: initial.head});
    if (!sameSourceSnapshot(writeGate, afterMarker)) {
      await invalidateOwnedMarker(deploymentStateFile, ownedSha256);
      throw fail('SOURCE_RELEASE_SOURCE_TOCTOU', 'Source changed after deployment marker write; owned marker was invalidated');
    }
    const terminalCas = await captureFileCas(deploymentStateFile);
    if (!terminalCas.exists || terminalCas.sha256 !== ownedSha256) {
      throw fail('SOURCE_RELEASE_MARKER_CAS_CONFLICT', 'Deployment marker changed before terminal readback');
    }
    return Object.freeze({
      ok: true,
      source: afterMarker,
      deploymentMarker: marker,
      lockPath,
      remoteWarnings: remote.warnings,
    });
  } finally {
    await releaseLock?.();
  }
}

function parseArgs(argv) {
  const args = {
    cwd: process.cwd(),
    expectedCommit: process.env.SHEIN_BI_RELEASE_EXPECTED_COMMIT || '',
    recordDeployment: '',
    deploymentStateFile: process.env.SHEIN_BI_DEPLOYED_RELEASE_FILE
      || '/srv/shein-bi/runtime/deployed_release.json',
    releaseAttestationFile: process.env.SHEIN_BI_RELEASE_ATTESTATION_FILE || '',
    releaseAttestationChecksumFile: process.env.SHEIN_BI_RELEASE_ATTESTATION_CHECKSUM_FILE || '',
    releaseAttestationRoot: process.env.SHEIN_BI_RELEASE_ATTESTATION_ROOT
      || '/srv/shein-bi/runtime/release-attestations',
    trustPolicyFile: process.env.SHEIN_BI_SOURCE_RELEASE_TRUST_POLICY || '',
    deploymentLockFile: process.env.SHEIN_BI_DEPLOYMENT_TRANSACTION_LOCK || '',
    lockTimeoutMs: Number(process.env.SHEIN_BI_DEPLOYMENT_LOCK_TIMEOUT_MS || 30_000),
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--cwd') args.cwd = argv[++i];
    else if (argv[i] === '--expected-commit') args.expectedCommit = argv[++i];
    else if (argv[i] === '--record-deployment') args.recordDeployment = argv[++i];
    else if (argv[i] === '--deployment-state-file') args.deploymentStateFile = path.resolve(argv[++i]);
    else if (argv[i] === '--release-attestation') args.releaseAttestationFile = path.resolve(argv[++i]);
    else if (argv[i] === '--release-attestation-checksum') args.releaseAttestationChecksumFile = path.resolve(argv[++i]);
    else if (argv[i] === '--release-attestation-root') args.releaseAttestationRoot = path.resolve(argv[++i]);
    else if (argv[i] === '--trust-policy') args.trustPolicyFile = path.resolve(argv[++i]);
    else if (argv[i] === '--deployment-lock') args.deploymentLockFile = path.resolve(argv[++i]);
    else if (argv[i] === '--lock-timeout-ms') args.lockTimeoutMs = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (args.recordDeployment && !args.expectedCommit) args.expectedCommit = args.recordDeployment;
  if (!args.trustPolicyFile) args.trustPolicyFile = path.join(path.resolve(args.cwd), 'config', 'source_release_trust_policy.json');
  if (args.recordDeployment) {
    const version = parseSourceReleaseVersion(args.recordDeployment).version;
    const releaseDir = path.join(path.resolve(args.releaseAttestationRoot), version);
    if (!args.releaseAttestationFile) args.releaseAttestationFile = path.join(releaseDir, 'release-attestation.json');
    if (!args.releaseAttestationChecksumFile) {
      args.releaseAttestationChecksumFile = path.join(releaseDir, 'release-attestation.json.sha256');
    }
  }
  return args;
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.recordDeployment) {
      const recorded = await recordDeploymentRelease({
        cwd: args.cwd,
        tag: args.recordDeployment,
        expectedCommit: args.expectedCommit,
        deploymentStateFile: args.deploymentStateFile,
        attestationFile: args.releaseAttestationFile,
        checksumFile: args.releaseAttestationChecksumFile,
        trustPolicyFile: args.trustPolicyFile,
        lockPath: args.deploymentLockFile || undefined,
        lockTimeoutMs: args.lockTimeoutMs,
      });
      console.log(JSON.stringify({
        ok: true,
        head: recorded.source.head,
        sourceFingerprint: recorded.source.sourceFingerprint,
        deploymentMarker: {
          schemaVersion: recorded.deploymentMarker.schemaVersion,
          repository: recorded.deploymentMarker.repository,
          repositoryId: recorded.deploymentMarker.repositoryId,
          tag: recorded.deploymentMarker.tag,
          commit: recorded.deploymentMarker.commit,
          tagObject: recorded.deploymentMarker.tagObject,
          releaseId: recorded.deploymentMarker.remoteEvidence.releaseId,
          ciRunId: recorded.deploymentMarker.ci.runId,
          ciRunAttempt: recorded.deploymentMarker.ci.runAttempt,
          warningCount: recorded.remoteWarnings.length,
        },
      }, null, 2));
    } else {
      const result = inspectReleaseSourceState(args);
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
    }
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      code: String(error?.code || 'SOURCE_RELEASE_CHECK_FAILED'),
      error: String(error?.message || error).slice(0, 1000),
    }));
    process.exitCode = 1;
  }
}
