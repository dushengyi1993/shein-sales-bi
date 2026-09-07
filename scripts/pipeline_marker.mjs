#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const DEFAULT_ROOT = process.env.SHEIN_BI_PIPELINE_MARKER_ROOT
  || path.join(process.cwd(), 'state', 'pipeline-markers');
const VALID_STATUS = new Set(['done', 'warning', 'failed', 'deferred', 'partial']);
const MARKER_DIRECTORY_MODE = 0o2770;
export const PIPELINE_MARKER_SCHEMA = 4;
export const ORDER_CLOSURE_MARKER_SEMANTIC_VERSION = 'order-closure/v5-zero-zero-done-candidates-v1-portal-queue-v1';
const WORK_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/i;

function usage(message = '') {
  if (message) console.error(message);
  console.error(`Usage:
  pipeline_marker.mjs write --stage NAME --date YYYY-MM-DD [--business-date YYYY-MM-DD]
    [--status done|warning|failed|deferred|partial] [--message TEXT]
    [--evidence PATH] [--snapshot-evidence] [--work-fingerprint HEX] [--work-fingerprint-scope NAME]
    [--work-semantic-version VERSION] [--work-parameter KEY=VALUE]
    [--workset-digest HEX] [--workset-candidate-count N] [--workset-pair-count N]
    [--source-commit COMMIT] [--root PATH]
  pipeline_marker.mjs require --stage NAME --date YYYY-MM-DD
    [--business-date YYYY-MM-DD] [--status done,warning]
    [--work-fingerprint HEX] [--work-fingerprint-scope NAME] [--require-ok]
    [--work-semantic-version VERSION] [--work-parameter KEY=VALUE]
    [--workset-digest HEX] [--workset-candidate-count N] [--workset-pair-count N]
    [--not-before ISO] [--require-evidence] [--root PATH]
  pipeline_marker.mjs read --stage NAME --date YYYY-MM-DD [--root PATH]
  pipeline_marker.mjs outcome --stage NAME --date YYYY-MM-DD --business-date YYYY-MM-DD
    --work-fingerprint-scope NAME --work-semantic-version VERSION
    [--work-parameter KEY=VALUE] [--root PATH]
  pipeline_marker.mjs fingerprint --scope NAME --semantic-version VERSION
    --workset-digest HEX [--parameter KEY=VALUE]
  Evidence: --evidence paths must exist as regular files; write records deduplicated
  {path,bytes,sha256} entries. require --require-evidence re-verifies existence,
  regular-file type, size and sha256 of every recorded entry.`);
  return 64;
}

function validateStage(value) {
  const stage = String(value || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(stage)) {
    throw new TypeError('PIPELINE_MARKER_STAGE_INVALID');
  }
  return stage;
}

function validateDate(value) {
  const date = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new TypeError('PIPELINE_MARKER_DATE_INVALID');
  }
  return date;
}

function validateFingerprint(value) {
  const fingerprint = String(value || '').trim().toLowerCase();
  if (!WORK_FINGERPRINT_PATTERN.test(fingerprint)) {
    throw new TypeError('PIPELINE_MARKER_WORK_FINGERPRINT_INVALID');
  }
  return fingerprint;
}

function validateSemanticVersion(value) {
  const version = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(version)) {
    throw new TypeError('PIPELINE_MARKER_WORK_SEMANTIC_VERSION_INVALID');
  }
  return version;
}

function parseParameters(entries = []) {
  const parameters = {};
  for (const entry of entries) {
    const text = String(entry || '');
    const separator = text.indexOf('=');
    if (separator <= 0) throw new TypeError('PIPELINE_MARKER_FINGERPRINT_PARAMETER_INVALID');
    const key = text.slice(0, separator).trim();
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(key) || Object.hasOwn(parameters, key)) {
      throw new TypeError('PIPELINE_MARKER_FINGERPRINT_PARAMETER_INVALID');
    }
    parameters[key] = text.slice(separator + 1);
  }
  return parameters;
}

function parseCount(value, code) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) throw new TypeError(code);
  const count = Number(text);
  if (!Number.isSafeInteger(count) || count < 0) throw new TypeError(code);
  return count;
}

function parseIso(value, code) {
  const text = String(value || '').trim();
  const millis = Date.parse(text);
  if (!text || Number.isNaN(millis)) throw new TypeError(code);
  return {text, millis};
}

function parseArgs(argv) {
  const [command, ...tokens] = argv;
  if (!['write', 'require', 'read', 'outcome', 'fingerprint'].includes(command)) {
    throw new TypeError('PIPELINE_MARKER_COMMAND_INVALID');
  }
  const options = {
    command,
    root: DEFAULT_ROOT,
    stage: '',
    scope: '',
    date: '',
    businessDate: '',
    status: command === 'write' ? 'done' : 'done',
    message: '',
    evidence: [],
    workFingerprint: '',
    workFingerprintScope: '',
    workSemanticVersion: '',
    worksetDigest: '',
    worksetCandidateCount: null,
    worksetPairCount: null,
    sourceCommit: '',
    requireOk: false,
    parameterEntries: [],
    notBefore: '',
    requireEvidence: false,
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = () => {
      index += 1;
      if (index >= tokens.length) throw new TypeError(`PIPELINE_MARKER_VALUE_MISSING_${token}`);
      return tokens[index];
    };
    if (token === '--root') options.root = path.resolve(next());
    else if (token === '--stage') options.stage = next();
    else if (token === '--scope') options.scope = next();
    else if (token === '--date') options.date = next();
    else if (token === '--business-date') options.businessDate = next();
    else if (token === '--status') options.status = next();
    else if (token === '--message') options.message = next();
    else if (token === '--evidence') options.evidence.push(next());
    else if (token === '--snapshot-evidence' && command === 'write') options.snapshotEvidence = true;
    else if (token === '--work-fingerprint') options.workFingerprint = next();
    else if (token === '--work-fingerprint-scope') options.workFingerprintScope = next();
    else if (token === '--work-semantic-version' || token === '--semantic-version') options.workSemanticVersion = next();
    else if (token === '--workset-digest') options.worksetDigest = next();
    else if (token === '--workset-candidate-count') options.worksetCandidateCount = parseCount(next(), 'PIPELINE_MARKER_WORKSET_CANDIDATE_COUNT_INVALID');
    else if (token === '--workset-pair-count') options.worksetPairCount = parseCount(next(), 'PIPELINE_MARKER_WORKSET_PAIR_COUNT_INVALID');
    else if (token === '--source-commit') options.sourceCommit = next();
    else if (token === '--require-ok') {
      if (command !== 'require') throw new TypeError(`PIPELINE_MARKER_ARGUMENT_UNKNOWN_${token}`);
      options.requireOk = true;
    }
    else if (token === '--parameter' || token === '--work-parameter') {
      if (token === '--parameter' && command !== 'fingerprint') throw new TypeError(`PIPELINE_MARKER_ARGUMENT_UNKNOWN_${token}`);
      options.parameterEntries.push(next());
    }
    else if (token === '--not-before') options.notBefore = next();
    else if (token === '--require-evidence') {
      if (command !== 'require') throw new TypeError(`PIPELINE_MARKER_ARGUMENT_UNKNOWN_${token}`);
      options.requireEvidence = true;
    }
    else throw new TypeError(`PIPELINE_MARKER_ARGUMENT_UNKNOWN_${token}`);
  }
  if (command === 'fingerprint') {
    options.scope = validateStage(options.scope);
    options.workSemanticVersion = validateSemanticVersion(options.workSemanticVersion);
    options.worksetDigest = validateFingerprint(options.worksetDigest);
    options.parameters = parseParameters(options.parameterEntries);
    return options;
  }
  options.stage = validateStage(options.stage);
  options.date = validateDate(options.date);
  if (options.businessDate) options.businessDate = validateDate(options.businessDate);
  if (options.workFingerprint) options.workFingerprint = validateFingerprint(options.workFingerprint);
  if (options.workFingerprintScope) options.workFingerprintScope = validateStage(options.workFingerprintScope);
  if (options.workSemanticVersion) options.workSemanticVersion = validateSemanticVersion(options.workSemanticVersion);
  if (options.worksetDigest) options.worksetDigest = validateFingerprint(options.worksetDigest);
  options.workParameters = parseParameters(options.parameterEntries);
  if (command === 'outcome') {
    if (!options.businessDate) throw new TypeError('PIPELINE_MARKER_BUSINESS_DATE_REQUIRED');
    if (!options.workFingerprintScope || !options.workSemanticVersion) {
      throw new TypeError('PIPELINE_MARKER_OUTCOME_IDENTITY_INCOMPLETE');
    }
    return options;
  }
  const hasStructuredIdentity = Boolean(
    options.workSemanticVersion
    || options.worksetDigest
    || options.worksetCandidateCount !== null
    || options.worksetPairCount !== null
    || Object.keys(options.workParameters).length,
  );
  if (hasStructuredIdentity) {
    if (
      !options.workFingerprintScope || !options.workSemanticVersion || !options.worksetDigest
      || options.worksetCandidateCount === null || options.worksetPairCount === null
    ) {
      throw new TypeError('PIPELINE_MARKER_STRUCTURED_WORK_IDENTITY_INCOMPLETE');
    }
    const derivedFingerprint = computeWorkFingerprint({
      scope: options.workFingerprintScope,
      semanticVersion: options.workSemanticVersion,
      parameters: options.workParameters,
      worksetDigest: options.worksetDigest,
    });
    if (options.workFingerprint && options.workFingerprint !== derivedFingerprint) {
      throw new TypeError('PIPELINE_MARKER_WORK_FINGERPRINT_MISMATCH');
    }
    options.workFingerprint = derivedFingerprint;
  }
  if (options.workFingerprint && !options.workFingerprintScope) {
    throw new TypeError('PIPELINE_MARKER_WORK_FINGERPRINT_SCOPE_REQUIRED');
  }
  if (options.workFingerprintScope && !options.workFingerprint) {
    throw new TypeError('PIPELINE_MARKER_WORK_FINGERPRINT_REQUIRED');
  }
  if (command === 'write' && !VALID_STATUS.has(options.status)) {
    throw new TypeError('PIPELINE_MARKER_STATUS_INVALID');
  }
  if (command === 'require') {
    const statuses = String(options.status || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean);
    if (!statuses.length || statuses.some(status => !VALID_STATUS.has(status))) {
      throw new TypeError('PIPELINE_MARKER_REQUIRED_STATUS_INVALID');
    }
    options.requiredStatuses = statuses;
  }
  if (options.notBefore) parseIso(options.notBefore, 'PIPELINE_MARKER_NOT_BEFORE_INVALID');
  return options;
}

export function markerPath(root, date, stage) {
  return path.join(path.resolve(root), validateDate(date), `${validateStage(stage)}.json`);
}

function markerDirectoryError(code, label, directory, cause = '') {
  const suffix = cause ? ` cause=${cause}` : '';
  return new Error(`${code} label=${label} path=${directory}${suffix}`);
}

function ensureMarkerDirectory(directory, label) {
  const resolved = path.resolve(directory);
  try {
    if (!fs.existsSync(resolved)) {
      // Request only ordinary permission bits. The provisioned setgid parent
      // supplies group inheritance, including under RestrictSUIDSGID=true.
      // mkdir is synchronous: restore umask before any other JS work can run.
      const priorUmask = process.umask();
      try {
        process.umask(priorUmask & ~0o070);
        fs.mkdirSync(resolved, {recursive: true, mode: 0o770});
      } finally { process.umask(priorUmask); }
    }
  } catch (error) {
    throw markerDirectoryError(
      'PIPELINE_MARKER_DIRECTORY_CREATE_FAILED',
      label,
      resolved,
      error?.code || error?.message || 'unknown',
    );
  }
  let stats;
  try {
    stats = fs.lstatSync(resolved);
  } catch (error) {
    throw markerDirectoryError(
      'PIPELINE_MARKER_DIRECTORY_STAT_FAILED',
      label,
      resolved,
      error?.code || error?.message || 'unknown',
    );
  }
  if (!stats.isDirectory()) {
    throw markerDirectoryError('PIPELINE_MARKER_DIRECTORY_NOT_DIRECTORY', label, resolved);
  }
  // Windows has no POSIX setgid/group-write mode bits. Production runs on
  // Linux; keep local Windows tests useful without pretending ACLs are modes.
  if (process.platform === 'win32') return;
  const actual = stats.mode & 0o7777;
  if (actual === MARKER_DIRECTORY_MODE) return;
  try {
    fs.chmodSync(resolved, MARKER_DIRECTORY_MODE);
  } catch (error) {
    throw markerDirectoryError(
      'PIPELINE_MARKER_DIRECTORY_MODE_FIX_FAILED',
      label,
      resolved,
      error?.code || error?.message || 'unknown',
    );
  }
  let repaired;
  try {
    repaired = fs.lstatSync(resolved);
  } catch (error) {
    throw markerDirectoryError(
      'PIPELINE_MARKER_DIRECTORY_MODE_VERIFY_FAILED',
      label,
      resolved,
      error?.code || error?.message || 'unknown',
    );
  }
  const repairedMode = repaired.mode & 0o7777;
  if (repairedMode !== MARKER_DIRECTORY_MODE) {
    throw markerDirectoryError(
      'PIPELINE_MARKER_DIRECTORY_MODE_INVALID',
      label,
      resolved,
      `expected=${MARKER_DIRECTORY_MODE.toString(8)} actual=${repairedMode.toString(8)}`,
    );
  }
}

function atomicWriteJson(file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o660,
  });
  fs.renameSync(temporary, file);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function computeWorkFingerprint({
  scope,
  semanticVersion,
  parameters = {},
  worksetDigest,
} = {}) {
  const normalizedScope = validateStage(scope);
  const normalizedSemanticVersion = validateSemanticVersion(semanticVersion);
  const normalizedWorksetDigest = validateFingerprint(worksetDigest);
  const payload = {
    algorithm: 'sha256',
    schema: 2,
    scope: normalizedScope,
    semanticVersion: normalizedSemanticVersion,
    parameters: canonicalize(parameters),
    worksetDigest: normalizedWorksetDigest,
  };
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

function isStructuredMarker(marker, requestedStage) {
  if (requestedStage === 'order-closure' || marker?.stage === 'order-closure') return true;
  return [
    'workSemanticVersion',
    'workParameters',
    'worksetDigest',
    'worksetCandidateCount',
    'worksetPairCount',
  ].some(key => Object.hasOwn(marker || {}, key));
}

function intrinsicStructuredMarkerFailure(marker, {stage, date}) {
  if (!isStructuredMarker(marker, stage)) return null;
  if (marker.schema !== PIPELINE_MARKER_SCHEMA || marker.schemaVersion !== PIPELINE_MARKER_SCHEMA) {
    return 'marker_structured_schema_invalid';
  }
  if (marker.stage !== stage) return 'marker_stage_mismatch';
  if (marker.runDate !== date) return 'marker_run_date_mismatch';
  try {
    validateDate(marker.businessDate);
    validateSemanticVersion(marker.workSemanticVersion);
    validateFingerprint(marker.workFingerprint);
    validateFingerprint(marker.worksetDigest);
    validateStage(marker.workFingerprintScope);
  } catch {
    return 'marker_structured_identity_invalid';
  }
  if (marker.workFingerprintScope !== stage) return 'marker_work_fingerprint_scope_mismatch';
  if (
    stage === 'order-closure'
    && marker.workSemanticVersion !== ORDER_CLOSURE_MARKER_SEMANTIC_VERSION
  ) {
    return 'marker_order_semantic_version_stale';
  }
  if (
    !marker.workParameters
    || typeof marker.workParameters !== 'object'
    || Array.isArray(marker.workParameters)
  ) {
    return 'marker_work_parameters_invalid';
  }
  for (const [key, value] of Object.entries(marker.workParameters)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(key) || typeof value !== 'string') {
      return 'marker_work_parameters_invalid';
    }
  }
  let derivedFingerprint;
  try {
    derivedFingerprint = computeWorkFingerprint({
      scope: marker.workFingerprintScope,
      semanticVersion: marker.workSemanticVersion,
      parameters: marker.workParameters,
      worksetDigest: marker.worksetDigest,
    });
  } catch {
    return 'marker_structured_identity_invalid';
  }
  if (marker.workFingerprint !== derivedFingerprint) return 'marker_work_fingerprint_mismatch';
  if (!Number.isSafeInteger(marker.worksetCandidateCount) || marker.worksetCandidateCount < 0) {
    return 'marker_workset_candidate_count_invalid';
  }
  if (!Number.isSafeInteger(marker.worksetPairCount) || marker.worksetPairCount < 0) {
    return 'marker_workset_pair_count_invalid';
  }
  if (!VALID_STATUS.has(marker.status)) return 'marker_status_invalid';
  if (marker.ok !== ['done', 'warning'].includes(marker.status)) return 'marker_ok_invalid';
  if (
    marker.status === 'done'
    && (marker.worksetCandidateCount !== 0 || marker.worksetPairCount !== 0)
  ) {
    return 'marker_done_workset_not_empty';
  }
  if (
    marker.status === 'partial'
    && marker.worksetCandidateCount === 0 && marker.worksetPairCount === 0
  ) {
    return 'marker_partial_workset_empty';
  }
  return null;
}

function evidenceError(code, evidencePath) {
  const error = new TypeError(code);
  error.evidencePath = evidencePath;
  return error;
}

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function resolveEvidenceRecords(evidence = [], snapshotDirectory = '', captureDependencies = true) {
  const records = [];
  const seen = new Set();
  for (const value of evidence || []) {
    const candidate = String(value || '').trim();
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    let stats;
    try {
      stats = fs.lstatSync(candidate);
    } catch (error) {
      if (error?.code === 'ENOENT') throw evidenceError('PIPELINE_MARKER_EVIDENCE_MISSING', candidate);
      throw error;
    }
    if (!stats.isFile()) throw evidenceError('PIPELINE_MARKER_EVIDENCE_NOT_FILE', candidate);
    const raw = await fs.promises.readFile(candidate);
    const record = {path: candidate, bytes: raw.length, sha256: createHash('sha256').update(raw).digest('hex')};
    if (snapshotDirectory) {
      ensureMarkerDirectory(snapshotDirectory, 'evidence-snapshot');
      record.snapshotPath = path.join(snapshotDirectory, record.sha256);
      let handle;
      try {
        handle = await fs.promises.open(record.snapshotPath, 'wx', 0o660);
        await handle.writeFile(raw);
        await handle.sync();
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = await fs.promises.lstat(record.snapshotPath);
        if (!existing.isFile() || existing.isSymbolicLink() || !(await fs.promises.readFile(record.snapshotPath)).equals(raw)) {
          throw evidenceError('PIPELINE_MARKER_SNAPSHOT_CONFLICT', candidate);
        }
      } finally { await handle?.close(); }
      if (process.platform !== 'win32') {
        const directory = await fs.promises.open(snapshotDirectory, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
      // The morning manifest refers to 38 mutable store/domain files. Capture
      // their exact bytes too; a snapshot of the manifest alone is incomplete.
      let document;
      try { document = JSON.parse(raw); } catch {}
      if (captureDependencies && document?.schemaVersion === 'shein-morning-resume-evidence/v1') {
        record.dependencies = [];
        for (const artifact of document.artifacts || []) {
          const [saved] = await resolveEvidenceRecords([artifact.path], snapshotDirectory, false);
          if (!saved || saved.sha256 !== artifact.sha256 || saved.bytes !== artifact.bytes) {
            throw evidenceError('PIPELINE_MARKER_DEPENDENCY_DRIFT', artifact.path);
          }
          record.dependencies.push(saved);
        }
      }
    }
    records.push(record);
  }
  return records;
}

export async function writeMarker({
  root = DEFAULT_ROOT,
  stage,
  date,
  businessDate = '',
  status = 'done',
  message = '',
  evidence = [],
  snapshotEvidence = false,
  workFingerprint = '',
  workFingerprintScope = '',
  workSemanticVersion = '',
  workParameters = {},
  worksetDigest = '',
  worksetCandidateCount = null,
  worksetPairCount = null,
  sourceCommit = '',
  completedAt = new Date().toISOString(),
} = {}) {
  const normalizedStage = validateStage(stage);
  const normalizedDate = validateDate(date);
  const normalizedBusinessDate = businessDate ? validateDate(businessDate) : '';
  if (!VALID_STATUS.has(status)) throw new TypeError('PIPELINE_MARKER_STATUS_INVALID');
  const normalizedFingerprint = workFingerprint ? validateFingerprint(workFingerprint) : '';
  const normalizedFingerprintScope = workFingerprintScope ? validateStage(workFingerprintScope) : '';
  const normalizedSemanticVersion = workSemanticVersion ? validateSemanticVersion(workSemanticVersion) : '';
  const normalizedWorksetDigest = worksetDigest ? validateFingerprint(worksetDigest) : '';
  const normalizedCandidateCount = worksetCandidateCount === null
    ? null
    : parseCount(worksetCandidateCount, 'PIPELINE_MARKER_WORKSET_CANDIDATE_COUNT_INVALID');
  const normalizedPairCount = worksetPairCount === null
    ? null
    : parseCount(worksetPairCount, 'PIPELINE_MARKER_WORKSET_PAIR_COUNT_INVALID');
  if (normalizedFingerprint && !normalizedFingerprintScope) {
    throw new TypeError('PIPELINE_MARKER_WORK_FINGERPRINT_SCOPE_REQUIRED');
  }
  if (normalizedFingerprintScope && !normalizedFingerprint) {
    throw new TypeError('PIPELINE_MARKER_WORK_FINGERPRINT_REQUIRED');
  }
  if (
    normalizedSemanticVersion || normalizedWorksetDigest
    || normalizedCandidateCount !== null || normalizedPairCount !== null
    || Object.keys(workParameters || {}).length
  ) {
    if (
      !normalizedFingerprint || !normalizedFingerprintScope || !normalizedSemanticVersion || !normalizedWorksetDigest
      || normalizedCandidateCount === null || normalizedPairCount === null
    ) {
      throw new TypeError('PIPELINE_MARKER_STRUCTURED_WORK_IDENTITY_INCOMPLETE');
    }
    if (status === 'done' && (normalizedCandidateCount !== 0 || normalizedPairCount !== 0)) {
      throw new TypeError('PIPELINE_MARKER_DONE_WORKSET_NOT_EMPTY');
    }
    if (status === 'partial' && normalizedCandidateCount === 0 && normalizedPairCount === 0) {
      throw new TypeError('PIPELINE_MARKER_PARTIAL_WORKSET_EMPTY');
    }
  }
  const completed = parseIso(completedAt, 'PIPELINE_MARKER_COMPLETED_AT_INVALID').text;
  ensureMarkerDirectory(path.resolve(root), 'root');
  const evidenceRecords = await resolveEvidenceRecords(evidence, snapshotEvidence
    ? path.resolve(root, 'evidence', normalizedDate, normalizedStage) : '');
  const payload = {
    schema: PIPELINE_MARKER_SCHEMA,
    schemaVersion: PIPELINE_MARKER_SCHEMA,
    ok: ['done', 'warning'].includes(status),
    stage: normalizedStage,
    status,
    runDate: normalizedDate,
    businessDate: normalizedBusinessDate || normalizedDate,
    completedAt: completed,
    message: String(message || '').slice(0, 1_000),
    evidence: evidenceRecords,
  };
  if (normalizedFingerprint) {
    payload.workFingerprint = normalizedFingerprint;
    payload.workFingerprintScope = normalizedFingerprintScope;
  }
  if (normalizedSemanticVersion) {
    payload.workSemanticVersion = normalizedSemanticVersion;
    payload.workParameters = canonicalize(workParameters || {});
    payload.worksetDigest = normalizedWorksetDigest;
    payload.worksetCandidateCount = normalizedCandidateCount;
    payload.worksetPairCount = normalizedPairCount;
  }
  if (String(sourceCommit || '').trim()) payload.sourceCommit = String(sourceCommit).trim().slice(0, 200);
  const intrinsicFailure = intrinsicStructuredMarkerFailure(payload, {
    stage: normalizedStage,
    date: normalizedDate,
  });
  if (intrinsicFailure) throw new TypeError(`PIPELINE_MARKER_INTRINSIC_${intrinsicFailure.toUpperCase()}`);
  const markerRoot = path.resolve(root);
  const markerDateDirectory = path.join(markerRoot, normalizedDate);
  ensureMarkerDirectory(markerRoot, 'root');
  ensureMarkerDirectory(markerDateDirectory, 'date');
  const file = markerPath(root, normalizedDate, normalizedStage);
  atomicWriteJson(file, payload);
  atomicWriteJson(path.join(markerRoot, `${normalizedStage}.latest.json`), payload);
  return {...payload, file};
}

export function readMarker({root = DEFAULT_ROOT, stage, date} = {}) {
  const file = markerPath(root, date, stage);
  try {
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {...payload, file};
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export function classifyMarkerOutcome({
  root = DEFAULT_ROOT,
  stage,
  date,
  businessDate,
  workFingerprintScope,
  workSemanticVersion,
  workParameters = {},
} = {}) {
  const normalizedStage = validateStage(stage);
  const normalizedDate = validateDate(date);
  const normalizedBusinessDate = validateDate(businessDate);
  const normalizedFingerprintScope = validateStage(workFingerprintScope);
  const normalizedSemanticVersion = validateSemanticVersion(workSemanticVersion);
  const normalizedWorkParameters = canonicalize(workParameters || {});
  const marker = readMarker({root, stage: normalizedStage, date: normalizedDate});
  if (!marker) {
    return {ok: false, reason: 'marker_missing', stage: normalizedStage, date: normalizedDate, marker: null};
  }
  const intrinsicFailure = intrinsicStructuredMarkerFailure(marker, {
    stage: normalizedStage,
    date: normalizedDate,
  });
  if (intrinsicFailure) {
    return {ok: false, reason: intrinsicFailure, stage: normalizedStage, date: normalizedDate, marker};
  }
  if (marker.businessDate !== normalizedBusinessDate) {
    return {ok: false, reason: 'marker_business_date_mismatch', stage: normalizedStage, date: normalizedDate, marker};
  }
  if (marker.workFingerprintScope !== normalizedFingerprintScope) {
    return {ok: false, reason: 'marker_work_fingerprint_scope_mismatch', stage: normalizedStage, date: normalizedDate, marker};
  }
  if (marker.workSemanticVersion !== normalizedSemanticVersion) {
    return {ok: false, reason: 'marker_work_semantic_version_mismatch', stage: normalizedStage, date: normalizedDate, marker};
  }
  if (canonicalJson(marker.workParameters) !== canonicalJson(normalizedWorkParameters)) {
    return {ok: false, reason: 'marker_work_parameters_mismatch', stage: normalizedStage, date: normalizedDate, marker};
  }
  if (!['done', 'partial'].includes(marker.status)) {
    return {ok: false, reason: 'marker_outcome_status_not_supported', stage: normalizedStage, date: normalizedDate, marker};
  }
  return {
    ok: true,
    reason: 'validated_outcome',
    outcome: marker.status,
    stage: normalizedStage,
    date: normalizedDate,
    businessDate: normalizedBusinessDate,
    worksetCandidateCount: marker.worksetCandidateCount,
    worksetPairCount: marker.worksetPairCount,
  };
}

export async function requireMarker({
  root = DEFAULT_ROOT,
  stage,
  date,
  businessDate = '',
  statuses = ['done'],
  workFingerprint = '',
  workFingerprintScope = '',
  workSemanticVersion = '',
  workParameters = {},
  worksetDigest = '',
  worksetCandidateCount = null,
  worksetPairCount = null,
  requireOk = false,
  notBefore = '',
  requireEvidence = false,
} = {}) {
  const normalizedStage = validateStage(stage);
  const normalizedDate = validateDate(date);
  const normalizedBusinessDate = businessDate ? validateDate(businessDate) : '';
  const normalizedFingerprint = workFingerprint ? validateFingerprint(workFingerprint) : '';
  const normalizedFingerprintScope = workFingerprintScope ? validateStage(workFingerprintScope) : '';
  const normalizedSemanticVersion = workSemanticVersion ? validateSemanticVersion(workSemanticVersion) : '';
  const normalizedWorksetDigest = worksetDigest ? validateFingerprint(worksetDigest) : '';
  const normalizedCandidateCount = worksetCandidateCount === null
    ? null
    : parseCount(worksetCandidateCount, 'PIPELINE_MARKER_WORKSET_CANDIDATE_COUNT_INVALID');
  const normalizedPairCount = worksetPairCount === null
    ? null
    : parseCount(worksetPairCount, 'PIPELINE_MARKER_WORKSET_PAIR_COUNT_INVALID');
  if (normalizedFingerprint && !normalizedFingerprintScope) {
    throw new TypeError('PIPELINE_MARKER_WORK_FINGERPRINT_SCOPE_REQUIRED');
  }
  if (normalizedFingerprintScope && !normalizedFingerprint) {
    throw new TypeError('PIPELINE_MARKER_WORK_FINGERPRINT_REQUIRED');
  }
  if (
    normalizedSemanticVersion || normalizedWorksetDigest
    || normalizedCandidateCount !== null || normalizedPairCount !== null
    || Object.keys(workParameters || {}).length
  ) {
    if (
      !normalizedFingerprint || !normalizedFingerprintScope || !normalizedSemanticVersion || !normalizedWorksetDigest
      || normalizedCandidateCount === null || normalizedPairCount === null
    ) {
      throw new TypeError('PIPELINE_MARKER_STRUCTURED_WORK_IDENTITY_INCOMPLETE');
    }
  }
  const marker = readMarker({root, stage: normalizedStage, date: normalizedDate});
  if (!marker) {
    return {ok: false, reason: 'marker_missing', stage: normalizedStage, date: normalizedDate, marker: null};
  }
  const intrinsicFailure = intrinsicStructuredMarkerFailure(marker, {
    stage: normalizedStage,
    date: normalizedDate,
  });
  if (intrinsicFailure) {
    return {ok: false, reason: intrinsicFailure, stage: normalizedStage, date: normalizedDate, marker};
  }
  if (!statuses.includes(marker.status)) {
    return {ok: false, reason: 'marker_status_not_ready', stage: normalizedStage, date: normalizedDate, marker};
  }
  const strictIdentity = requireOk || Boolean(normalizedBusinessDate) || Boolean(normalizedFingerprint);
  if (strictIdentity) {
    if (marker.ok !== true) {
      return {ok: false, reason: 'marker_ok_not_true', stage: normalizedStage, date: normalizedDate, marker};
    }
    if (marker.stage !== normalizedStage) {
      return {ok: false, reason: 'marker_stage_mismatch', stage: normalizedStage, date: normalizedDate, marker};
    }
    if (marker.runDate !== normalizedDate) {
      return {ok: false, reason: 'marker_run_date_mismatch', stage: normalizedStage, date: normalizedDate, marker};
    }
    if (normalizedBusinessDate && marker.businessDate !== normalizedBusinessDate) {
      return {ok: false, reason: 'marker_business_date_mismatch', stage: normalizedStage, date: normalizedDate, marker};
    }
  }
  if (normalizedFingerprint) {
    if (marker.schema !== PIPELINE_MARKER_SCHEMA) {
      return {ok: false, reason: 'marker_schema_missing', stage: normalizedStage, date: normalizedDate, marker};
    }
    if (!marker.workFingerprint) {
      return {ok: false, reason: 'marker_work_fingerprint_missing', stage: normalizedStage, date: normalizedDate, marker};
    }
    if (marker.workFingerprintScope !== normalizedFingerprintScope) {
      return {ok: false, reason: 'marker_work_fingerprint_scope_mismatch', stage: normalizedStage, date: normalizedDate, marker};
    }
    if (marker.workFingerprint !== normalizedFingerprint) {
      return {ok: false, reason: 'marker_work_fingerprint_mismatch', stage: normalizedStage, date: normalizedDate, marker};
    }
    if (normalizedSemanticVersion && marker.workSemanticVersion !== normalizedSemanticVersion) {
      return {ok: false, reason: 'marker_work_semantic_version_mismatch', stage: normalizedStage, date: normalizedDate, marker};
    }
    if (normalizedSemanticVersion && canonicalJson(marker.workParameters || {}) !== canonicalJson(workParameters || {})) {
      return {ok: false, reason: 'marker_work_parameters_mismatch', stage: normalizedStage, date: normalizedDate, marker};
    }
    if (normalizedWorksetDigest && marker.worksetDigest !== normalizedWorksetDigest) {
      return {ok: false, reason: 'marker_workset_digest_mismatch', stage: normalizedStage, date: normalizedDate, marker};
    }
    if (normalizedCandidateCount !== null && marker.worksetCandidateCount !== normalizedCandidateCount) {
      return {ok: false, reason: 'marker_workset_candidate_count_mismatch', stage: normalizedStage, date: normalizedDate, marker};
    }
    if (normalizedPairCount !== null && marker.worksetPairCount !== normalizedPairCount) {
      return {ok: false, reason: 'marker_workset_pair_count_mismatch', stage: normalizedStage, date: normalizedDate, marker};
    }
    if (
      normalizedSemanticVersion && marker.status === 'done'
      && (marker.worksetCandidateCount !== 0 || marker.worksetPairCount !== 0)
    ) {
      return {ok: false, reason: 'marker_done_workset_not_empty', stage: normalizedStage, date: normalizedDate, marker};
    }
  }
  if (notBefore) {
    const threshold = parseIso(notBefore, 'PIPELINE_MARKER_NOT_BEFORE_INVALID');
    const completed = parseIso(marker.completedAt, 'PIPELINE_MARKER_COMPLETED_AT_INVALID');
    if (completed.millis < threshold.millis) {
      return {ok: false, reason: 'marker_too_old', stage: normalizedStage, date: normalizedDate, marker, notBefore: threshold.text};
    }
  }
  if (requireEvidence) {
    const failure = await verifyEvidenceRecords(marker.evidence);
    if (failure) {
      return {ok: false, reason: failure.reason, stage: normalizedStage, date: normalizedDate, marker, evidencePath: failure.path};
    }
  }
  return {ok: true, reason: 'ready', stage: normalizedStage, date: normalizedDate, marker};
}

async function verifyEvidenceRecords(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return {reason: 'evidence_missing', path: null};
  }
  for (const entry of entries) {
    const candidate = entry?.snapshotPath || entry?.path;
    const expectedBytes = entry?.bytes;
    const expectedSha256 = entry?.sha256;
    if (
      typeof candidate !== 'string' || !candidate
      || typeof expectedBytes !== 'number' || !Number.isSafeInteger(expectedBytes)
      || typeof expectedSha256 !== 'string' || !expectedSha256
    ) {
      return {reason: 'evidence_missing', path: typeof candidate === 'string' ? candidate : null};
    }
    let stats;
    try {
      stats = fs.lstatSync(candidate);
    } catch (error) {
      if (error?.code === 'ENOENT') return {reason: 'evidence_missing', path: candidate};
      throw error;
    }
    if (!stats.isFile()) return {reason: 'evidence_not_file', path: candidate};
    if (stats.size !== expectedBytes) return {reason: 'evidence_size_mismatch', path: candidate};
    const digest = await sha256File(candidate);
    if (digest !== expectedSha256) return {reason: 'evidence_hash_mismatch', path: candidate};
    if (entry.dependencies) {
      const failure = await verifyEvidenceRecords(entry.dependencies);
      if (failure) return failure;
    }
  }
  return null;
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(JSON.stringify({ok: false, errorCode: error?.message || 'PIPELINE_MARKER_ARGUMENT_INVALID'}));
    return usage();
  }
  if (options.command === 'write') {
    let result;
    try {
      result = await writeMarker(options);
    } catch (error) {
      if (['PIPELINE_MARKER_EVIDENCE_MISSING', 'PIPELINE_MARKER_EVIDENCE_NOT_FILE'].includes(error?.message)) {
        console.error(JSON.stringify({ok: false, errorCode: error.message, evidencePath: error.evidencePath ?? null}));
        return 1;
      }
      throw error;
    }
    console.log(JSON.stringify(result));
    return 0;
  }
  if (options.command === 'fingerprint') {
    try {
      console.log(computeWorkFingerprint({
        scope: options.scope,
        semanticVersion: options.workSemanticVersion,
        parameters: options.parameters,
        worksetDigest: options.worksetDigest,
      }));
      return 0;
    } catch (error) {
      console.error(JSON.stringify({ok: false, errorCode: error?.message || 'PIPELINE_MARKER_FINGERPRINT_FAILED'}));
      return 1;
    }
  }
  if (options.command === 'read') {
    const result = readMarker(options);
    console.log(JSON.stringify(result || {
      ok: false,
      reason: 'marker_missing',
      stage: options.stage,
      date: options.date,
    }));
    return result ? 0 : 75;
  }
  if (options.command === 'outcome') {
    const result = classifyMarkerOutcome(options);
    console.log(JSON.stringify(result));
    return result.ok ? 0 : 1;
  }
  const result = await requireMarker({
    ...options,
    statuses: options.requiredStatuses,
  });
  console.log(JSON.stringify(result));
  return result.ok ? 0 : 75;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then(code => {
    process.exitCode = code;
  }).catch(error => {
    console.error(String(error?.stack || error));
    process.exitCode = 1;
  });
}
