import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {writeJsonFileAtomic} from './atomic_file_publish.mjs';

export const OPS_RUN_SCHEMA_VERSION = 'shein-ops-run/v1';
export const OPS_RUN_MANIFEST_SCHEMA_VERSION = 'shein-ops-run-manifest/v1';

export const OPS_EXIT_CODES = Object.freeze({
  succeeded: 0,
  failed: 1,
  blocked: 75,
  incomplete: 75,
  usage: 64,
});

const OUTCOMES = new Set(['succeeded', 'failed', 'blocked', 'incomplete']);
const SENSITIVE_KEYS = new Set([
  'authorization', 'cookie', 'password', 'passwd', 'secret', 'token', 'apikey', 'openkeyid', 'sessionmaterial',
  'accesstoken', 'refreshtoken', 'authtoken', 'sessiontoken', 'clientsecret', 'secretkey',
]);

function sensitiveKey(value) {
  const normalized = String(value || '').normalize('NFKC').replace(/[^a-z0-9]/giu, '').toLowerCase();
  return SENSITIVE_KEYS.has(normalized)
    || /^(?:xapi|api|private|client|access|refresh|auth|bearer|session).*(?:key|secret|token)$/u.test(normalized)
    || /^(?:set)?cookie$/u.test(normalized);
}

function text(value) {
  return String(value ?? '').trim();
}

function finiteNonNegative(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function assertNoSensitiveKeys(value, currentPath = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveKeys(item, `${currentPath}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (sensitiveKey(key)) throw new Error(`ops run contains a sensitive key at ${currentPath}.${key}`);
    assertNoSensitiveKeys(child, `${currentPath}.${key}`);
  }
}

function iso(value, label) {
  const normalized = text(value);
  if (!normalized || Number.isNaN(Date.parse(normalized))) throw new Error(`${label} must be an ISO timestamp`);
  return new Date(normalized).toISOString();
}

export function exitCodeForOutcome(outcome) {
  const normalized = text(outcome).toLowerCase();
  if (!OUTCOMES.has(normalized)) throw new Error(`unsupported ops outcome: ${outcome}`);
  return OPS_EXIT_CODES[normalized];
}

export function buildOpsRun(input = {}) {
  const operation = text(input.operation);
  const mode = text(input.mode || 'read');
  const outcome = text(input.outcome).toLowerCase();
  if (!operation) throw new Error('ops run operation is required');
  if (!OUTCOMES.has(outcome)) throw new Error(`unsupported ops outcome: ${input.outcome}`);
  const startedAt = iso(input.startedAt, 'startedAt');
  const finishedAt = iso(input.finishedAt, 'finishedAt');
  const derivedDurationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
  const run = {
    schemaVersion: OPS_RUN_SCHEMA_VERSION,
    runId: text(input.runId) || `${operation}-${finishedAt.replace(/[-:.TZ]/g, '')}`,
    operation,
    mode,
    readOnly: input.readOnly === true,
    outcome,
    ok: outcome === 'succeeded',
    exitCode: exitCodeForOutcome(outcome),
    startedAt,
    finishedAt,
    durationMs: Math.round(finiteNonNegative(input.durationMs, derivedDurationMs)),
    source: cloneJson(input.source || {}),
    scope: cloneJson(input.scope || {}),
    coverage: cloneJson(input.coverage || {}),
    summary: cloneJson(input.summary || {}),
    metrics: cloneJson(input.metrics || {}),
    blockers: cloneJson(Array.isArray(input.blockers) ? input.blockers : []),
    warnings: cloneJson(Array.isArray(input.warnings) ? input.warnings : []),
  };
  assertNoSensitiveKeys(run);
  return Object.freeze(run);
}

export async function sha256File(file) {
  const bytes = await fs.readFile(file);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function relativeArtifactPath(baseDir, file) {
  const relative = path.relative(baseDir, file);
  if (!relative || relative === '.' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`ops artifact must be a child of the manifest directory: ${file}`);
  }
  return relative.split(path.sep).join('/');
}

export async function describeOpsArtifact(manifestFile, artifact = {}) {
  const baseDir = path.dirname(path.resolve(manifestFile));
  const file = path.resolve(artifact.file || '');
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink()) throw new Error(`ops artifact must not be a symbolic link: ${file}`);
  if (!stat.isFile()) throw new Error(`ops artifact is not a regular file: ${file}`);
  const [realBase, realFile] = await Promise.all([fs.realpath(baseDir), fs.realpath(file)]);
  const relativePath = relativeArtifactPath(realBase, realFile);
  return {
    path: relativePath,
    role: text(artifact.role) || 'evidence',
    mediaType: text(artifact.mediaType) || 'application/json',
    bytes: stat.size,
    sha256: await sha256File(file),
  };
}

export async function writeOpsRunManifest({manifestFile, run, artifacts = []} = {}) {
  const target = path.resolve(manifestFile || '');
  if (!text(manifestFile)) throw new Error('manifestFile is required');
  if (run?.schemaVersion !== OPS_RUN_SCHEMA_VERSION) throw new Error('run must be built by buildOpsRun');
  if (!Array.isArray(artifacts) || artifacts.length === 0) throw new Error('ops run manifest requires at least one artifact');
  const described = [];
  for (const artifact of artifacts) described.push(await describeOpsArtifact(target, artifact));
  described.sort((left, right) => left.path.localeCompare(right.path));
  const manifest = {
    schemaVersion: OPS_RUN_MANIFEST_SCHEMA_VERSION,
    generatedAt: run.finishedAt,
    run,
    artifacts: described,
  };
  assertNoSensitiveKeys(manifest);
  await invalidateOpsRunManifest(target);
  await writeJsonFileAtomic(target, manifest, {mode: 0o600});
  try { await fs.chmod(target, 0o600); } catch {}
  return {
    manifest,
    manifestFile: target,
    manifestSha256: await sha256File(target),
  };
}

export async function invalidateOpsRunManifest(manifestFile) {
  const target = path.resolve(manifestFile);
  try {
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`existing ops manifest is not a regular file: ${target}`);
    }
    await fs.unlink(target);
    return {invalidated: true, manifestFile: target};
  } catch (error) {
    if (error?.code === 'ENOENT') return {invalidated: false, manifestFile: target};
    throw error;
  }
}

export async function verifyOpsRunManifest(manifestFile) {
  const target = path.resolve(manifestFile);
  const manifest = JSON.parse(await fs.readFile(target, 'utf8'));
  const issues = [];
  if (manifest?.schemaVersion !== OPS_RUN_MANIFEST_SCHEMA_VERSION) issues.push('unsupported_manifest_schema');
  if (manifest?.run?.schemaVersion !== OPS_RUN_SCHEMA_VERSION) issues.push('unsupported_run_schema');
  try { assertNoSensitiveKeys(manifest); } catch (error) { issues.push(text(error.message)); }
  const baseDir = path.dirname(target);
  const artifacts = Array.isArray(manifest?.artifacts) ? manifest.artifacts : [];
  if (!artifacts.length) issues.push('manifest_has_no_artifacts');
  const seenPaths = new Set();
  for (const artifact of artifacts) {
    const artifactPath = text(artifact.path);
    if (!artifactPath || seenPaths.has(artifactPath)) {
      issues.push(`artifact_path_invalid_or_duplicate:${artifactPath}`);
      continue;
    }
    seenPaths.add(artifactPath);
    if (!/^[a-f0-9]{64}$/.test(text(artifact.sha256))) issues.push(`artifact_sha256_invalid:${artifactPath}`);
    const file = path.resolve(baseDir, text(artifact.path));
    try {
      relativeArtifactPath(baseDir, file);
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) {
        issues.push(`artifact_symlink_rejected:${artifact.path}`);
        continue;
      }
      const [realBase, realFile] = await Promise.all([fs.realpath(baseDir), fs.realpath(file)]);
      relativeArtifactPath(realBase, realFile);
      const hash = await sha256File(file);
      if (!stat.isFile()) issues.push(`artifact_not_file:${artifact.path}`);
      if (stat.size !== Number(artifact.bytes)) issues.push(`artifact_size_mismatch:${artifact.path}`);
      if (hash !== text(artifact.sha256)) issues.push(`artifact_hash_mismatch:${artifact.path}`);
    } catch (error) {
      issues.push(`artifact_unreadable:${artifact.path}:${text(error.code || error.message)}`);
    }
  }
  return {
    ok: issues.length === 0,
    manifestFile: target,
    manifestSha256: await sha256File(target),
    run: manifest?.run || null,
    artifacts,
    issues,
  };
}

export function compactOpsRun(run, manifest = {}) {
  return {
    ok: run.ok,
    outcome: run.outcome,
    exitCode: run.exitCode,
    operation: run.operation,
    mode: run.mode,
    readOnly: run.readOnly,
    businessDate: run.source?.businessDate || null,
    asOf: run.source?.asOf || run.finishedAt,
    coverage: run.coverage,
    summary: run.summary,
    blockers: run.blockers,
    warnings: run.warnings,
    manifestFile: manifest.manifestFile || null,
    manifestSha256: manifest.manifestSha256 || null,
  };
}
