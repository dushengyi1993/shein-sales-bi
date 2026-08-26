import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {AsyncLocalStorage} from 'node:async_hooks';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

import {acquireCrossProcessTicketLock} from './cross_process_ticket_lock.mjs';
import {readCloudMaintenanceStatus} from './cloud_maintenance_mode.mjs';
import {
  DEFAULT_EMERGENCY_LOCAL_RELEASE_FILE,
  readEmergencyLocalReleaseReceipt,
} from './emergency_local_release_receipt.mjs';
import {readRegularBoundedFileAsync, validateDeployedReleaseMarker} from './source_release_attestation.mjs';
import {stableInventoryHash} from './inventory_replenishment_policy.mjs';
import {inspectReleaseSourceState} from '../scripts/check_release_source_state.mjs';

export const INVENTORY_CUTOVER_ACTIVATION_SCHEMA_VERSION = 'inventory-v2-reader-first-activation/v1';
export const INVENTORY_CUTOVER_RECEIPT_SCHEMA_VERSION = 'inventory-v2-reader-first-activation-receipt/v1';
export const INVENTORY_CUTOVER_COMPATIBILITY_SCHEMA_VERSION = 'inventory-v2-reader-first-compatible-release/v1';
export const INVENTORY_CUTOVER_COMPATIBILITY_RECORD_SCHEMA_VERSION = 'inventory-v2-compatibility-record/v1';
export const INVENTORY_CUTOVER_COMPATIBILITY_RECEIPT_SCHEMA_VERSION = 'inventory-v2-compatibility-receipt/v1';
export const INVENTORY_CUTOVER_PREFLIGHT_ARTIFACT_SCHEMA_VERSION = 'inventory-v2-compatibility-preflight-artifact/v2';
export const INVENTORY_CUTOVER_MINIMUM_READER_SCHEMA = 'inventory-manual-resolution/v1';
export const DEFAULT_INVENTORY_CUTOVER_ACTIVATION_FILE = '/var/lib/shein-bi-control/inventory-writer-compatibility/activation.ndjson';
export const DEFAULT_INVENTORY_CUTOVER_ACTIVATION_RECEIPT_FILE = '/var/lib/shein-bi-control/inventory-writer-compatibility/activation.receipt.json';
export const DEFAULT_INVENTORY_CUTOVER_COMPATIBILITY_FILE = '/var/lib/shein-bi-control/inventory-writer-compatibility/compatibility.ndjson';
export const DEFAULT_INVENTORY_CUTOVER_COMPATIBILITY_RECEIPT_FILE = '/var/lib/shein-bi-control/inventory-writer-compatibility/compatibility.receipt.json';
export const DEFAULT_INVENTORY_CUTOVER_LOCK_FILE = '/srv/shein-bi/runtime/locks/inventory-v2-cutover.lock';
export const DEFAULT_INVENTORY_CUTOVER_WRITER_SERVICES = Object.freeze(['shein-bi-portal.service']);

const execFileAsync = promisify(execFile);
const lockContext = new AsyncLocalStorage();
const HASH_RE = /^[a-f0-9]{64}$/u;
const COMMIT_RE = /^[a-f0-9]{40}$/u;
const MAX_REGISTRY_BYTES = 1024 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_PREFLIGHT_ARTIFACT_BYTES = 256 * 1024;
const PREFLIGHT_COMMANDS = new Set(['activate', 'rotation-stage', 'rotation-finalize']);

function fail(code, message, details = {}) {
  const error = new Error(`${code}:${message}`);
  error.code = code;
  error.details = details;
  throw error;
}

function text(value) {
  return String(value ?? '').trim();
}

function hashBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function validIso(value) {
  const parsed = new Date(String(value || '')).getTime();
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

async function readBoundedJson(file, maxBytes, label) {
  const target = path.resolve(file);
  let read;
  try {
    read = await readRegularBoundedFileAsync(target, maxBytes, label);
  } catch (error) {
    if (error?.code === 'ENOENT') return {exists: false, file: target};
    fail('INVENTORY_CUTOVER_AUTHORITY_UNREADABLE', `${label}:${error?.code || error?.message || error}`, {file: target});
  }
  let json;
  try {
    json = JSON.parse(read.bytes.toString('utf8'));
  } catch (error) {
    fail('INVENTORY_CUTOVER_AUTHORITY_INVALID', `${label}:invalid-json`, {file: target, error: error.message});
  }
  return {exists: true, file: target, bytes: read.bytes, sha256: hashBytes(read.bytes), json};
}

function normalizeServiceState(unit, raw = {}) {
  const state = {
    unit,
    loadState: text(raw.LoadState),
    activeState: text(raw.ActiveState),
    subState: text(raw.SubState),
    mainPid: text(raw.MainPID),
    execMainStartTimestamp: text(raw.ExecMainStartTimestamp),
    nRestarts: text(raw.NRestarts),
  };
  if (state.loadState !== 'loaded' || state.activeState !== 'active'
    || !/^\d+$/u.test(state.mainPid) || Number(state.mainPid) < 1
    || !state.execMainStartTimestamp || !/^\d+$/u.test(state.nRestarts)) {
    fail('INVENTORY_CUTOVER_SERVICE_STATE_INVALID', `writer service is not a loaded active generation:${unit}`, state);
  }
  return {...state, generationHash: stableInventoryHash(state)};
}

export async function readInventoryWriterServiceStates(
  units = DEFAULT_INVENTORY_CUTOVER_WRITER_SERVICES,
  {execFileImpl = execFileAsync} = {},
) {
  const names = [...new Set((units || []).map(text).filter(Boolean))].sort();
  if (!names.length) fail('INVENTORY_CUTOVER_SERVICE_STATE_INVALID', 'writer service set is empty');
  const output = [];
  for (const unit of names) {
    let stdout;
    try {
      ({stdout} = await execFileImpl('systemctl', [
        'show', '--no-pager',
        '--property=LoadState,ActiveState,SubState,MainPID,ExecMainStartTimestamp,NRestarts',
        unit,
      ], {encoding: 'utf8', maxBuffer: 64 * 1024}));
    } catch (error) {
      fail('INVENTORY_CUTOVER_SERVICE_STATE_UNAVAILABLE', `systemctl show failed:${unit}`, {code: error?.code || ''});
    }
    const raw = {};
    for (const line of String(stdout || '').split(/\r?\n/u)) {
      const separator = line.indexOf('=');
      if (separator > 0) raw[line.slice(0, separator)] = line.slice(separator + 1);
    }
    output.push(normalizeServiceState(unit, raw));
  }
  return output;
}

function normalizeAuthority(authority = {}) {
  const normalized = {
    deployedCommit: text(authority.deployedCommit).toLowerCase(),
    sourceFingerprint: text(authority.sourceFingerprint).toLowerCase(),
    bundleSha256: text(authority.bundleSha256).toLowerCase(),
    trackedSourceClean: authority.trackedSourceClean === true,
    releaseReceiptKind: text(authority.releaseReceiptKind),
    releaseReceiptHash: text(authority.releaseReceiptHash).toLowerCase(),
    releaseReceiptFile: path.resolve(text(authority.releaseReceiptFile)),
    writerServices: Array.isArray(authority.writerServices)
      ? authority.writerServices.map(row => ({...row})).sort((a, b) => a.unit.localeCompare(b.unit))
      : [],
    capturedAt: text(authority.capturedAt),
  };
  if (!COMMIT_RE.test(normalized.deployedCommit)
    || !HASH_RE.test(normalized.sourceFingerprint)
    || !HASH_RE.test(normalized.bundleSha256)
    || normalized.trackedSourceClean !== true
    || !['formal', 'emergency'].includes(normalized.releaseReceiptKind)
    || !HASH_RE.test(normalized.releaseReceiptHash)
    || !text(authority.releaseReceiptFile)
    || !normalized.writerServices.length
    || normalized.writerServices.some(row => !HASH_RE.test(text(row?.generationHash)))
    || !validIso(normalized.capturedAt)) {
    fail('INVENTORY_CUTOVER_DEPLOYMENT_AUTHORITY_INVALID', 'deployment authority is incomplete or self-reported');
  }
  return normalized;
}

const COMPATIBILITY_AUTHORITY_KEYS = Object.freeze([
  'deployedCommit', 'sourceFingerprint', 'bundleSha256', 'trackedSourceClean',
  'releaseReceiptKind', 'releaseReceiptHash', 'releaseReceiptFile',
]);

export function inventoryCompatibilityAuthority(authority = {}) {
  const normalized = {
    deployedCommit: text(authority.deployedCommit).toLowerCase(),
    sourceFingerprint: text(authority.sourceFingerprint).toLowerCase(),
    bundleSha256: text(authority.bundleSha256).toLowerCase(),
    trackedSourceClean: authority.trackedSourceClean === true,
    releaseReceiptKind: text(authority.releaseReceiptKind),
    releaseReceiptHash: text(authority.releaseReceiptHash).toLowerCase(),
    releaseReceiptFile: path.resolve(text(authority.releaseReceiptFile)),
  };
  if (!COMMIT_RE.test(normalized.deployedCommit)
    || !HASH_RE.test(normalized.sourceFingerprint)
    || !HASH_RE.test(normalized.bundleSha256)
    || normalized.trackedSourceClean !== true
    || !['formal', 'emergency'].includes(normalized.releaseReceiptKind)
    || !HASH_RE.test(normalized.releaseReceiptHash)
    || !text(authority.releaseReceiptFile)) {
    fail('INVENTORY_CUTOVER_COMPATIBILITY_AUTHORITY_INVALID', 'candidate compatibility authority is incomplete');
  }
  return normalized;
}

function sameCompatibilityAuthority(left, right) {
  const a = inventoryCompatibilityAuthority(left);
  const b = inventoryCompatibilityAuthority(right);
  return COMPATIBILITY_AUTHORITY_KEYS.every(key => a[key] === b[key]);
}

function compatibilityPaths({
  activationFile = process.env.SHEIN_BI_INVENTORY_CUTOVER_ACTIVATION_FILE || DEFAULT_INVENTORY_CUTOVER_ACTIVATION_FILE,
  activationReceiptFile = process.env.SHEIN_BI_INVENTORY_CUTOVER_ACTIVATION_RECEIPT_FILE || DEFAULT_INVENTORY_CUTOVER_ACTIVATION_RECEIPT_FILE,
  compatibilityFile = '',
  compatibilityReceiptFile = '',
} = {}) {
  const activation = path.resolve(activationFile);
  const control = path.dirname(activation);
  const canonicalActivationName = path.basename(activation) === 'activation.ndjson';
  return {
    activationFile: activation,
    activationReceiptFile: path.resolve(activationReceiptFile),
    compatibilityFile: path.resolve(compatibilityFile || (canonicalActivationName
      ? path.join(control, 'compatibility.ndjson') : `${activation}.compatibility.ndjson`)),
    compatibilityReceiptFile: path.resolve(compatibilityReceiptFile || (canonicalActivationName
      ? path.join(control, 'compatibility.receipt.json') : `${activation}.compatibility.receipt.json`)),
  };
}

export async function captureInventoryCutoverDeploymentAuthority({
  cwd = process.cwd(),
  deploymentStateFile = process.env.SHEIN_BI_DEPLOYED_RELEASE_FILE || '/srv/shein-bi/runtime/deployed_release.json',
  emergencyReceiptFile = process.env.SHEIN_BI_EMERGENCY_LOCAL_RELEASE_FILE || DEFAULT_EMERGENCY_LOCAL_RELEASE_FILE,
  writerServices = DEFAULT_INVENTORY_CUTOVER_WRITER_SERVICES,
  serviceStateReader = readInventoryWriterServiceStates,
  now = () => new Date(),
} = {}) {
  const deployment = await readBoundedJson(deploymentStateFile, MAX_RECEIPT_BYTES, 'deployed release marker');
  const formalValid = deployment.exists && validateDeployedReleaseMarker(deployment.json, {requireV3: true}).ok;
  const emergency = readEmergencyLocalReleaseReceipt(emergencyReceiptFile);
  const emergencyValid = emergency.ok === true;
  const expectedCommit = emergencyValid ? emergency.receipt.commit : formalValid ? deployment.json.commit : '';
  if (!expectedCommit) fail('INVENTORY_CUTOVER_RELEASE_RECEIPT_INVALID', 'neither formal nor emergency deployed release receipt is valid');
  const source = inspectReleaseSourceState({cwd, expectedCommit});
  if (!source.ok || source.head !== expectedCommit) {
    fail('INVENTORY_CUTOVER_SOURCE_STATE_INVALID', 'deployed source is not exact and clean', {
      head: source.head,
      expectedCommit,
      dirtyCount: source.dirtyEntries?.length,
    });
  }
  let releaseReceiptKind;
  let releaseReceiptHash;
  let releaseReceiptFile;
  let bundleSha256;
  if (emergencyValid && emergency.receipt.commit === source.head) {
    releaseReceiptKind = 'emergency';
    releaseReceiptHash = emergency.receipt.receiptHash;
    releaseReceiptFile = emergency.file;
    bundleSha256 = emergency.receipt.bundleSha256;
  } else {
    bundleSha256 = text(deployment.json?.bundleSha256).toLowerCase();
    if (!HASH_RE.test(bundleSha256)) {
      fail('INVENTORY_CUTOVER_RELEASE_BUNDLE_UNBOUND', 'formal deployment marker does not bind a bundle SHA-256');
    }
    releaseReceiptKind = 'formal';
    releaseReceiptHash = deployment.sha256;
    releaseReceiptFile = deployment.file;
  }
  const services = await serviceStateReader(writerServices);
  return normalizeAuthority({
    deployedCommit: source.head,
    sourceFingerprint: source.sourceFingerprint,
    bundleSha256,
    trackedSourceClean: true,
    releaseReceiptKind,
    releaseReceiptHash,
    releaseReceiptFile,
    writerServices: services,
    capturedAt: now().toISOString(),
  });
}

function activationCore({authority, requiredManualResolution, activatedAt}) {
  const scopeKey = text(requiredManualResolution?.scopeKey).toLowerCase();
  const intentId = text(requiredManualResolution?.intentId);
  const journalFile = path.resolve(text(requiredManualResolution?.journalFile));
  const manualReceiptFile = path.resolve(text(requiredManualResolution?.receiptFile));
  if (!HASH_RE.test(scopeKey) || !intentId || !text(requiredManualResolution?.journalFile)
    || !text(requiredManualResolution?.receiptFile)) {
    fail('INVENTORY_CUTOVER_REQUIRED_FENCE_INVALID', 'required manual resolution binding is incomplete');
  }
  return {
    schemaVersion: INVENTORY_CUTOVER_ACTIVATION_SCHEMA_VERSION,
    kind: 'reader_first_activation',
    readerSchemaVersion: INVENTORY_CUTOVER_MINIMUM_READER_SCHEMA,
    authority: normalizeAuthority(authority),
    requiredManualResolution: {intentId, scopeKey, journalFile, receiptFile: manualReceiptFile},
    activatedAt,
  };
}

export function buildInventoryCutoverActivationRecord(input = {}) {
  const core = activationCore(input);
  if (!validIso(core.activatedAt)) fail('INVENTORY_CUTOVER_ACTIVATION_INVALID', 'activatedAt');
  return {...core, activationHash: stableInventoryHash(core)};
}

export function validateInventoryCutoverActivationRecord(record) {
  if (!exactKeys(record, ['schemaVersion', 'kind', 'readerSchemaVersion', 'authority', 'requiredManualResolution', 'activatedAt', 'activationHash'])) {
    fail('INVENTORY_CUTOVER_ACTIVATION_INVALID', 'record shape');
  }
  const rebuilt = buildInventoryCutoverActivationRecord(record);
  if (record.activationHash !== rebuilt.activationHash) fail('INVENTORY_CUTOVER_ACTIVATION_INVALID', 'activation hash');
  return rebuilt;
}

function receiptCore({activationFile, activationFileSha256, activationHash, recordedAt}) {
  return {
    schemaVersion: INVENTORY_CUTOVER_RECEIPT_SCHEMA_VERSION,
    kind: 'reader_first_activation_receipt',
    activationFile: path.resolve(activationFile),
    activationFileSha256,
    activationHash,
    recordedAt,
  };
}

export function buildInventoryCutoverActivationReceipt(input = {}) {
  const core = receiptCore(input);
  if (!HASH_RE.test(core.activationFileSha256) || !HASH_RE.test(core.activationHash) || !validIso(core.recordedAt)) {
    fail('INVENTORY_CUTOVER_ACTIVATION_RECEIPT_INVALID', 'receipt binding');
  }
  return {...core, receiptHash: stableInventoryHash(core)};
}

function validateActivationReceipt(receipt, {activationFile, activationFileSha256, activationHash}) {
  if (!exactKeys(receipt, ['schemaVersion', 'kind', 'activationFile', 'activationFileSha256', 'activationHash', 'recordedAt', 'receiptHash'])) {
    fail('INVENTORY_CUTOVER_ACTIVATION_RECEIPT_INVALID', 'receipt shape');
  }
  const rebuilt = buildInventoryCutoverActivationReceipt(receipt);
  if (receipt.receiptHash !== rebuilt.receiptHash
    || path.resolve(receipt.activationFile) !== path.resolve(activationFile)
    || receipt.activationFileSha256 !== activationFileSha256
    || receipt.activationHash !== activationHash) {
    fail('INVENTORY_CUTOVER_ACTIVATION_RECEIPT_INVALID', 'receipt hash or registry binding');
  }
  return rebuilt;
}

async function fsyncDirectory(file) {
  if (process.platform === 'win32') return;
  const handle = await fs.open(path.dirname(file), 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeJsonExclusive(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const handle = await fs.open(file, 'wx', 0o640);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsyncDirectory(file);
}

async function writeJsonLineExclusive(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const handle = await fs.open(file, 'wx', 0o640);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsyncDirectory(file);
}

async function writeJsonAtomicDurable(file, value, {afterRenameHook} = {}) {
  const target = path.resolve(file);
  await fs.mkdir(path.dirname(target), {recursive: true});
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const handle = await fs.open(temporary, 'wx', 0o640);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, target);
  if (afterRenameHook) await afterRenameHook({file: target, temporary});
  await fsyncDirectory(target);
}

async function appendJsonLineDurable(file, value, expectedSha256, {afterAppendHook} = {}) {
  const target = path.resolve(file);
  const before = await readRegularBoundedFileAsync(target, MAX_REGISTRY_BYTES, 'inventory compatibility registry CAS');
  if (expectedSha256 && hashBytes(before.bytes) !== expectedSha256) {
    fail('INVENTORY_CUTOVER_COMPATIBILITY_CAS_CONFLICT', 'compatibility registry hash drifted before append');
  }
  const handle = await fs.open(target, 'a', 0o640);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsyncDirectory(target);
  if (afterAppendHook) await afterAppendHook({file: target, record: value});
}

async function readActivationRegistryRecord(activationFile) {
  const target = path.resolve(activationFile);
  let bytes;
  try {
    const read = await readRegularBoundedFileAsync(target, MAX_REGISTRY_BYTES, 'inventory cutover activation registry');
    bytes = read.bytes;
  } catch (error) {
    if (error?.code === 'ENOENT') return {exists: false, activationFile: target};
    if (error?.code === 'SOURCE_RELEASE_FILE_SIZE_INVALID') {
      fail('INVENTORY_CUTOVER_ACTIVATION_INVALID', 'activation registry exists but is empty or invalid-sized');
    }
    fail('INVENTORY_CUTOVER_ACTIVATION_UNREADABLE', error?.code || error?.message || 'registry read failed', {file: target});
  }
  if (!bytes.length || !bytes.toString('utf8').trim()) {
    fail('INVENTORY_CUTOVER_ACTIVATION_INVALID', 'activation registry exists but is empty');
  }
  const lines = bytes.toString('utf8').split(/\r?\n/u).filter(line => line.trim());
  if (lines.length !== 1) fail('INVENTORY_CUTOVER_ACTIVATION_INVALID', 'activation registry must contain exactly one immutable activation');
  let record;
  try { record = JSON.parse(lines[0]); } catch { fail('INVENTORY_CUTOVER_ACTIVATION_INVALID', 'activation registry JSON'); }
  const activation = validateInventoryCutoverActivationRecord(record);
  return {
    exists: true,
    activationFile: target,
    bytes,
    registrySha256: hashBytes(bytes),
    activation,
  };
}

function maintenanceEvidence(status) {
  return {generation: status.generation, hash: text(status.hash).toLowerCase()};
}

function exactAuthorityExceptCapture(left, right) {
  const a = normalizeAuthority(left);
  const b = normalizeAuthority(right);
  return stableInventoryHash({...a, capturedAt: ''}) === stableInventoryHash({...b, capturedAt: ''});
}

function normalizePreflightInvocation(command, invocation) {
  const commonKeys = [
    'cwd', 'activationFile', 'activationReceiptFile', 'compatibilityFile',
    'compatibilityReceiptFile', 'maintenanceFile', 'lockFile',
  ];
  const commandKey = command === 'activate'
    ? 'requiredManualResolution'
    : command === 'rotation-stage' ? 'candidateAuthority' : '';
  const expectedKeys = commandKey ? [...commonKeys, commandKey] : commonKeys;
  if (!exactKeys(invocation, expectedKeys)) {
    fail('INVENTORY_CUTOVER_PREFLIGHT_ARTIFACT_INVALID', 'preflight invocation shape');
  }
  const normalized = {};
  for (const key of commonKeys) {
    if (!text(invocation[key]) || !path.isAbsolute(invocation[key])) {
      fail('INVENTORY_CUTOVER_PREFLIGHT_ARTIFACT_INVALID', `preflight invocation absolute path:${key}`);
    }
    normalized[key] = path.resolve(invocation[key]);
  }
  if (command === 'activate') {
    const binding = invocation.requiredManualResolution;
    if (!exactKeys(binding, ['intentId', 'scopeKey', 'journalFile', 'receiptFile'])
      || !text(binding.intentId) || !HASH_RE.test(text(binding.scopeKey).toLowerCase())
      || !text(binding.journalFile) || !path.isAbsolute(binding.journalFile)
      || !text(binding.receiptFile) || !path.isAbsolute(binding.receiptFile)) {
      fail('INVENTORY_CUTOVER_PREFLIGHT_ARTIFACT_INVALID', 'preflight manual-resolution binding');
    }
    normalized.requiredManualResolution = {
      intentId: text(binding.intentId),
      scopeKey: text(binding.scopeKey).toLowerCase(),
      journalFile: path.resolve(binding.journalFile),
      receiptFile: path.resolve(binding.receiptFile),
    };
  } else if (command === 'rotation-stage') {
    if (!exactKeys(invocation.candidateAuthority, COMPATIBILITY_AUTHORITY_KEYS)) {
      fail('INVENTORY_CUTOVER_PREFLIGHT_ARTIFACT_INVALID', 'preflight candidate authority shape');
    }
    normalized.candidateAuthority = inventoryCompatibilityAuthority(invocation.candidateAuthority);
  }
  return normalized;
}

export function buildInventoryCompatibilityPreflightArtifact({
  command,
  invocation,
  authority,
  maintenance,
  currentStateHash,
  preflightHash,
  proposedRecord,
  recordedAt,
  createdAt = new Date().toISOString(),
  expiresAt = new Date(new Date(createdAt).getTime() + 30 * 60_000).toISOString(),
  nonce = crypto.randomBytes(24).toString('hex'),
} = {}) {
  const selectedCommand = text(command);
  const normalizedAuthority = normalizeAuthority(authority);
  const maintenanceSnapshot = {
    ok: maintenance?.ok === true,
    active: maintenance?.active === true,
    mode: text(maintenance?.mode),
    ...maintenanceEvidence(maintenance || {}),
  };
  const core = {
    schemaVersion: INVENTORY_CUTOVER_PREFLIGHT_ARTIFACT_SCHEMA_VERSION,
    kind: 'inventory_writer_compatibility_preflight',
    command: selectedCommand,
    nonce: text(nonce).toLowerCase(),
    createdAt: text(createdAt),
    expiresAt: text(expiresAt),
    recordedAt: text(recordedAt),
    invocation: normalizePreflightInvocation(selectedCommand, invocation),
    authority: normalizedAuthority,
    maintenance: maintenanceSnapshot,
    currentStateHash: text(currentStateHash).toLowerCase(),
    controllerPreflightHash: text(preflightHash).toLowerCase(),
    proposedRecord,
  };
  if (!PREFLIGHT_COMMANDS.has(selectedCommand)
    || !/^[a-f0-9]{48}$/u.test(core.nonce)
    || !validIso(core.createdAt) || !validIso(core.expiresAt) || !validIso(core.recordedAt)
    || new Date(core.expiresAt).getTime() <= new Date(core.createdAt).getTime()
    || maintenanceSnapshot.ok !== true || maintenanceSnapshot.active !== true || maintenanceSnapshot.mode !== 'all'
    || !Number.isSafeInteger(maintenanceSnapshot.generation) || maintenanceSnapshot.generation < 1
    || !HASH_RE.test(maintenanceSnapshot.hash) || !HASH_RE.test(core.currentStateHash)
    || !HASH_RE.test(core.controllerPreflightHash) || !core.proposedRecord || typeof core.proposedRecord !== 'object') {
    fail('INVENTORY_CUTOVER_PREFLIGHT_ARTIFACT_INVALID', 'preflight artifact fields are incomplete');
  }
  const approved = {...core, preflightHash: stableInventoryHash(core)};
  return {...approved, artifactHash: stableInventoryHash(approved)};
}

export function validateInventoryCompatibilityPreflightArtifact(artifact, {
  command = '',
  now = new Date(),
} = {}) {
  if (!exactKeys(artifact, [
    'schemaVersion', 'kind', 'command', 'nonce', 'createdAt', 'expiresAt', 'recordedAt',
    'invocation', 'authority', 'maintenance', 'currentStateHash', 'controllerPreflightHash', 'preflightHash',
    'proposedRecord', 'artifactHash',
  ])) fail('INVENTORY_CUTOVER_PREFLIGHT_ARTIFACT_INVALID', 'preflight artifact shape');
  const {artifactHash, preflightHash, controllerPreflightHash, ...input} = artifact;
  const rebuilt = buildInventoryCompatibilityPreflightArtifact({
    ...input,
    nonce: input.nonce,
    preflightHash: controllerPreflightHash,
  });
  if (preflightHash !== rebuilt.preflightHash) fail('INVENTORY_CUTOVER_PREFLIGHT_ARTIFACT_INVALID', 'preflight approval hash');
  if (artifactHash !== rebuilt.artifactHash) fail('INVENTORY_CUTOVER_PREFLIGHT_ARTIFACT_INVALID', 'preflight artifact hash');
  if (command && rebuilt.command !== command) fail('INVENTORY_CUTOVER_PREFLIGHT_COMMAND_MISMATCH', 'artifact command mismatch');
  if (new Date(rebuilt.expiresAt).getTime() < new Date(now).getTime()) {
    fail('INVENTORY_CUTOVER_PREFLIGHT_ARTIFACT_EXPIRED', 'preflight artifact is stale');
  }
  return rebuilt;
}

export async function writeInventoryCompatibilityPreflightArtifact(file, artifact) {
  const validated = validateInventoryCompatibilityPreflightArtifact(artifact, {now: new Date(artifact.createdAt)});
  await writeJsonExclusive(path.resolve(file), validated);
  const readback = await readRegularBoundedFileAsync(path.resolve(file), MAX_PREFLIGHT_ARTIFACT_BYTES, 'inventory compatibility preflight artifact readback');
  return {file: path.resolve(file), fileSha256: hashBytes(readback.bytes), artifact: validated};
}

export async function readInventoryCompatibilityPreflightArtifact(file, {
  expectedFileSha256,
  expectedPreflightHash,
  command,
  now = new Date(),
} = {}) {
  const source = await readBoundedJson(path.resolve(file), MAX_PREFLIGHT_ARTIFACT_BYTES, 'inventory compatibility preflight artifact');
  if (!source.exists) fail('INVENTORY_CUTOVER_PREFLIGHT_ARTIFACT_MISSING', 'preflight artifact is missing');
  const expectedFile = text(expectedFileSha256).toLowerCase();
  if (!HASH_RE.test(expectedFile) || source.sha256 !== expectedFile) {
    fail('INVENTORY_CUTOVER_PREFLIGHT_ARTIFACT_SHA_MISMATCH', 'preflight artifact file SHA-256 mismatch');
  }
  const artifact = validateInventoryCompatibilityPreflightArtifact(source.json, {command, now});
  if (!HASH_RE.test(text(expectedPreflightHash).toLowerCase())
    || artifact.preflightHash !== text(expectedPreflightHash).toLowerCase()) {
    fail('INVENTORY_CUTOVER_EXPECTED_PREFLIGHT_HASH_MISMATCH', 'artifact preflight hash mismatch');
  }
  return {file: source.file, fileSha256: source.sha256, artifact};
}

export function assertInventoryCompatibilityPreflightFreshFacts(artifact, {authority, maintenance} = {}) {
  const validated = validateInventoryCompatibilityPreflightArtifact(artifact);
  const freshAuthority = normalizeAuthority(authority);
  if (!exactAuthorityExceptCapture(validated.authority, freshAuthority)) {
    fail('INVENTORY_CUTOVER_PREFLIGHT_AUTHORITY_DRIFT', 'source/release/service authority changed after dry-run');
  }
  const freshMaintenance = {
    ok: maintenance?.ok === true,
    active: maintenance?.active === true,
    mode: text(maintenance?.mode),
    ...maintenanceEvidence(maintenance || {}),
  };
  if (stableInventoryHash(validated.maintenance) !== stableInventoryHash(freshMaintenance)) {
    fail('INVENTORY_CUTOVER_PREFLIGHT_MAINTENANCE_DRIFT', 'maintenance generation/hash/mode changed after dry-run');
  }
  return {authority: validated.authority, maintenance: validated.maintenance};
}

function withRecordHash(core) {
  return {...core, recordHash: stableInventoryHash(core)};
}

function compatibilityInitialRecord({activation, recordedAt}) {
  return withRecordHash({
    schemaVersion: INVENTORY_CUTOVER_COMPATIBILITY_RECORD_SCHEMA_VERSION,
    kind: 'compatibility_initial',
    generation: 1,
    activationHash: activation.activationHash,
    authority: normalizeAuthority(activation.authority),
    requiredManualResolutionHash: stableInventoryHash(activation.requiredManualResolution),
    recordedAt,
  });
}

function compatibilityStageRecord({state, candidateAuthority, maintenance, recordedAt}) {
  return withRecordHash({
    schemaVersion: INVENTORY_CUTOVER_COMPATIBILITY_RECORD_SCHEMA_VERSION,
    kind: 'compatibility_rotation_staged',
    generation: state.activeGeneration + 1,
    previousGeneration: state.activeGeneration,
    previousFinalizedHash: state.activeRecord.recordHash,
    candidateAuthority: inventoryCompatibilityAuthority(candidateAuthority),
    currentStateHash: inventoryCompatibilityStateHash(state),
    maintenance: maintenanceEvidence(maintenance),
    recordedAt,
  });
}

function compatibilityFinalizeRecord({state, authority, maintenance, recordedAt}) {
  return withRecordHash({
    schemaVersion: INVENTORY_CUTOVER_COMPATIBILITY_RECORD_SCHEMA_VERSION,
    kind: 'compatibility_rotation_finalized',
    generation: state.pendingStage.generation,
    previousGeneration: state.activeGeneration,
    previousFinalizedHash: state.activeRecord.recordHash,
    stageHash: state.pendingStage.recordHash,
    currentStateHash: inventoryCompatibilityStateHash(state),
    authority: normalizeAuthority(authority),
    maintenance: maintenanceEvidence(maintenance),
    recordedAt,
  });
}

function validateRecordHash(record) {
  const {recordHash, ...core} = record || {};
  if (!HASH_RE.test(text(recordHash)) || stableInventoryHash(core) !== recordHash) {
    fail('INVENTORY_CUTOVER_COMPATIBILITY_RECORD_INVALID', 'record hash');
  }
}

function validateMaintenanceEvidence(value) {
  if (!exactKeys(value, ['generation', 'hash']) || !Number.isSafeInteger(value.generation)
    || value.generation < 1 || !HASH_RE.test(text(value.hash))) {
    fail('INVENTORY_CUTOVER_COMPATIBILITY_RECORD_INVALID', 'maintenance evidence');
  }
}

function parseCompatibilityRecords(bytes, activation) {
  const lines = bytes.toString('utf8').split(/\r?\n/u).filter(line => line.trim());
  if (!lines.length) fail('INVENTORY_CUTOVER_COMPATIBILITY_REGISTRY_INVALID', 'registry is empty');
  const records = lines.map((line, index) => {
    try { return JSON.parse(line); } catch { fail('INVENTORY_CUTOVER_COMPATIBILITY_REGISTRY_INVALID', `line=${index + 1}`); }
  });
  let activeRecord = null;
  let pendingStage = null;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    validateRecordHash(record);
    if (record.schemaVersion !== INVENTORY_CUTOVER_COMPATIBILITY_RECORD_SCHEMA_VERSION || !validIso(record.recordedAt)) {
      fail('INVENTORY_CUTOVER_COMPATIBILITY_RECORD_INVALID', `line=${index + 1}:schema-or-time`);
    }
    if (record.kind === 'compatibility_initial') {
      if (index !== 0 || activeRecord || !exactKeys(record, [
        'schemaVersion', 'kind', 'generation', 'activationHash', 'authority',
        'requiredManualResolutionHash', 'recordedAt', 'recordHash',
      ]) || record.generation !== 1 || record.activationHash !== activation.activationHash
        || record.requiredManualResolutionHash !== stableInventoryHash(activation.requiredManualResolution)
        || !sameCompatibilityAuthority(record.authority, activation.authority)) {
        fail('INVENTORY_CUTOVER_COMPATIBILITY_RECORD_INVALID', 'initial binding');
      }
      normalizeAuthority(record.authority);
      activeRecord = record;
      continue;
    }
    if (record.kind === 'compatibility_rotation_staged') {
      if (!activeRecord || pendingStage || !exactKeys(record, [
        'schemaVersion', 'kind', 'generation', 'previousGeneration', 'previousFinalizedHash',
        'candidateAuthority', 'currentStateHash', 'maintenance', 'recordedAt', 'recordHash',
      ]) || record.generation !== activeRecord.generation + 1
        || record.previousGeneration !== activeRecord.generation
        || record.previousFinalizedHash !== activeRecord.recordHash) {
        fail('INVENTORY_CUTOVER_COMPATIBILITY_RECORD_INVALID', 'stage chain');
      }
      inventoryCompatibilityAuthority(record.candidateAuthority);
      validateMaintenanceEvidence(record.maintenance);
      pendingStage = record;
      continue;
    }
    if (record.kind === 'compatibility_rotation_finalized') {
      if (!activeRecord || !pendingStage || !exactKeys(record, [
        'schemaVersion', 'kind', 'generation', 'previousGeneration', 'previousFinalizedHash',
        'stageHash', 'currentStateHash', 'authority', 'maintenance', 'recordedAt', 'recordHash',
      ]) || record.generation !== pendingStage.generation
        || record.previousGeneration !== activeRecord.generation
        || record.previousFinalizedHash !== activeRecord.recordHash
        || record.stageHash !== pendingStage.recordHash
        || !sameCompatibilityAuthority(record.authority, pendingStage.candidateAuthority)) {
        fail('INVENTORY_CUTOVER_COMPATIBILITY_RECORD_INVALID', 'finalize chain');
      }
      normalizeAuthority(record.authority);
      validateMaintenanceEvidence(record.maintenance);
      activeRecord = record;
      pendingStage = null;
      continue;
    }
    fail('INVENTORY_CUTOVER_COMPATIBILITY_RECORD_INVALID', `unknown kind:${record.kind}`);
  }
  return {records, activeRecord, activeGeneration: activeRecord.generation, pendingStage};
}

async function readCompatibilityRegistry(file, activation, {required = true} = {}) {
  const target = path.resolve(file);
  let read;
  try {
    read = await readRegularBoundedFileAsync(target, MAX_REGISTRY_BYTES, 'inventory compatibility registry');
  } catch (error) {
    if (error?.code === 'ENOENT' && !required) return {exists: false, file: target};
    fail('INVENTORY_CUTOVER_COMPATIBILITY_REGISTRY_UNREADABLE', error?.code || error?.message || 'registry read failed');
  }
  return {
    exists: true,
    file: target,
    bytes: read.bytes,
    registrySha256: hashBytes(read.bytes),
    ...parseCompatibilityRecords(read.bytes, activation),
  };
}

function compatibilityReceiptCore({registry, compatibilityFile, recordedAt}) {
  return {
    schemaVersion: INVENTORY_CUTOVER_COMPATIBILITY_RECEIPT_SCHEMA_VERSION,
    kind: 'inventory_compatibility_receipt',
    compatibilityFile: path.resolve(compatibilityFile),
    compatibilityFileSha256: registry.registrySha256,
    lastRecordHash: registry.records.at(-1).recordHash,
    activeGeneration: registry.activeGeneration,
    activeRecordHash: registry.activeRecord.recordHash,
    pendingStageHash: registry.pendingStage?.recordHash || '',
    recordedAt,
  };
}

function buildCompatibilityReceipt(input) {
  const core = compatibilityReceiptCore(input);
  return {...core, receiptHash: stableInventoryHash(core)};
}

function validateCompatibilityReceipt(receipt, registry, compatibilityFile) {
  if (!exactKeys(receipt, [
    'schemaVersion', 'kind', 'compatibilityFile', 'compatibilityFileSha256', 'lastRecordHash',
    'activeGeneration', 'activeRecordHash', 'pendingStageHash', 'recordedAt', 'receiptHash',
  ]) || receipt.schemaVersion !== INVENTORY_CUTOVER_COMPATIBILITY_RECEIPT_SCHEMA_VERSION
    || receipt.kind !== 'inventory_compatibility_receipt' || !validIso(receipt.recordedAt)) {
    fail('INVENTORY_CUTOVER_COMPATIBILITY_RECEIPT_INVALID', 'receipt schema');
  }
  const rebuilt = buildCompatibilityReceipt({registry, compatibilityFile, recordedAt: receipt.recordedAt});
  if (stableInventoryHash(receipt) !== stableInventoryHash(rebuilt)
    || receipt.receiptHash !== rebuilt.receiptHash) {
    fail('INVENTORY_CUTOVER_COMPATIBILITY_RECEIPT_INVALID', 'receipt registry binding');
  }
  return rebuilt;
}

async function readCompatibilityReceipt(file, registry, compatibilityFile, {required = true} = {}) {
  const source = await readBoundedJson(file, MAX_RECEIPT_BYTES, 'inventory compatibility receipt');
  if (!source.exists) {
    if (!required) return {exists: false, file: source.file};
    fail('INVENTORY_CUTOVER_COMPATIBILITY_RECEIPT_MISSING', 'compatibility receipt is missing');
  }
  return {exists: true, file: source.file, receipt: validateCompatibilityReceipt(source.json, registry, compatibilityFile)};
}

export function inventoryCompatibilityStateHash(state) {
  return stableInventoryHash({
    registrySha256: state.registrySha256,
    activeGeneration: state.activeGeneration,
    activeRecordHash: state.activeRecord.recordHash,
    pendingStageHash: state.pendingStage?.recordHash || '',
    receiptHash: state.receipt?.receiptHash || '',
  });
}

async function readActivationBase({
  activationFile = process.env.SHEIN_BI_INVENTORY_CUTOVER_ACTIVATION_FILE || DEFAULT_INVENTORY_CUTOVER_ACTIVATION_FILE,
  activationReceiptFile = process.env.SHEIN_BI_INVENTORY_CUTOVER_ACTIVATION_RECEIPT_FILE || DEFAULT_INVENTORY_CUTOVER_ACTIVATION_RECEIPT_FILE,
} = {}) {
  const registry = await readActivationRegistryRecord(activationFile);
  if (!registry.exists) {
      const receiptOnly = await readBoundedJson(
        activationReceiptFile,
        MAX_RECEIPT_BYTES,
        'inventory cutover activation receipt without registry',
      );
      if (receiptOnly.exists) {
        fail(
          'INVENTORY_CUTOVER_ACTIVATION_INCONSISTENT',
          'activation receipt exists but activation registry is missing',
          {activationFile: registry.activationFile, activationReceiptFile: receiptOnly.file},
        );
      }
      return {activated: false, activationFile: registry.activationFile};
  }
  const receiptSource = await readBoundedJson(activationReceiptFile, MAX_RECEIPT_BYTES, 'inventory cutover activation receipt');
  if (!receiptSource.exists) fail('INVENTORY_CUTOVER_ACTIVATION_RECEIPT_MISSING', 'activation receipt is missing');
  const receipt = validateActivationReceipt(receiptSource.json, {
    activationFile: registry.activationFile,
    activationFileSha256: registry.registrySha256,
    activationHash: registry.activation.activationHash,
  });
  return {
    activated: true,
    activationFile: registry.activationFile,
    activationReceiptFile: receiptSource.file,
    registrySha256: registry.registrySha256,
    activation: registry.activation,
    receipt,
  };
}

export async function readInventoryCutoverActivation(options = {}) {
  const paths = compatibilityPaths(options);
  const base = await readActivationBase(paths);
  if (!base.activated) {
    const compatibility = await readCompatibilityRegistry(paths.compatibilityFile, {}, {required: false});
    const receipt = await readBoundedJson(paths.compatibilityReceiptFile, MAX_RECEIPT_BYTES, 'pre-activation compatibility receipt');
    if (compatibility.exists || receipt.exists) {
      fail('INVENTORY_CUTOVER_COMPATIBILITY_INCONSISTENT', 'compatibility state exists without activation');
    }
    return base;
  }
  const registry = await readCompatibilityRegistry(paths.compatibilityFile, base.activation);
  const receiptSource = await readCompatibilityReceipt(paths.compatibilityReceiptFile, registry, paths.compatibilityFile);
  const compatibility = {...registry, receipt: receiptSource.receipt, receiptFile: receiptSource.file};
  return {...base, compatibility, activeAuthority: registry.activeRecord.authority};
}

export async function requireCurrentInventoryCutoverActivation(options = {}) {
  const state = await readInventoryCutoverActivation(options);
  if (!state.activated) return state;
  const authority = normalizeAuthority(await (options.authorityReader || captureInventoryCutoverDeploymentAuthority)(options.authorityOptions || {}));
  if (!sameCompatibilityAuthority(state.activeAuthority, authority)) {
    if (state.compatibility.pendingStage
      && sameCompatibilityAuthority(state.compatibility.pendingStage.candidateAuthority, authority)) {
      fail('INVENTORY_CUTOVER_ROTATION_NOT_FINALIZED', 'candidate deployment is staged but not finalized', {
        activeGeneration: state.compatibility.activeGeneration,
        stagedGeneration: state.compatibility.pendingStage.generation,
      });
    }
    fail('INVENTORY_CUTOVER_ROLLBACK_OR_DEPLOYMENT_DRIFT', 'current deployment is not the activated fence-capable generation', {
      activatedCommit: state.activeAuthority.deployedCommit,
      currentCommit: authority.deployedCommit,
    });
  }
  return {...state, authority};
}

export async function requireInventoryCutoverMaintenanceAll({
  maintenanceFile = process.env.SHEIN_BI_MAINTENANCE_FILE,
  maintenanceReader = readCloudMaintenanceStatus,
} = {}) {
  const status = await maintenanceReader(maintenanceFile);
  if (!status || status.ok !== true || status.active !== true || status.mode !== 'all'
    || !Number.isSafeInteger(status.generation) || status.generation < 1 || !HASH_RE.test(String(status.hash || ''))) {
    fail('INVENTORY_CUTOVER_MAINTENANCE_REQUIRED', 'fresh canonical maintenance must be active in all mode', {
      ok: status?.ok,
      active: status?.active,
      mode: status?.mode,
      generation: status?.generation,
    });
  }
  return status;
}

async function ensureInitialCompatibility({base, paths, authority, recordedAt, receiptWriteOptions}) {
  let registry = await readCompatibilityRegistry(paths.compatibilityFile, base.activation, {required: false});
  if (!registry.exists) {
    if (!sameCompatibilityAuthority(base.activation.authority, authority)) {
      fail('INVENTORY_CUTOVER_COMPATIBILITY_INITIAL_DRIFT', 'initial compatibility authority differs from activation');
    }
    const initial = compatibilityInitialRecord({activation: base.activation, recordedAt});
    await writeJsonLineExclusive(paths.compatibilityFile, initial);
    registry = await readCompatibilityRegistry(paths.compatibilityFile, base.activation);
  }
  if (registry.records[0]?.kind !== 'compatibility_initial'
    || !sameCompatibilityAuthority(registry.records[0].authority, base.activation.authority)) {
    fail('INVENTORY_CUTOVER_COMPATIBILITY_INITIAL_DRIFT', 'compatibility initial record binding');
  }
  let receipt;
  try {
    receipt = await readCompatibilityReceipt(paths.compatibilityReceiptFile, registry, paths.compatibilityFile);
  } catch (error) {
    if (!['INVENTORY_CUTOVER_COMPATIBILITY_RECEIPT_MISSING', 'INVENTORY_CUTOVER_COMPATIBILITY_RECEIPT_INVALID'].includes(error?.code)) throw error;
    const rebuilt = buildCompatibilityReceipt({registry, compatibilityFile: paths.compatibilityFile, recordedAt});
    await writeJsonAtomicDurable(paths.compatibilityReceiptFile, rebuilt, receiptWriteOptions);
    receipt = await readCompatibilityReceipt(paths.compatibilityReceiptFile, registry, paths.compatibilityFile);
  }
  return {...registry, receipt: receipt.receipt, receiptFile: receipt.file};
}

export async function controlInventoryCutoverActivation({
  mode = 'dry-run',
  expectedPreflightHash = '',
  requiredManualResolution,
  authorityReader = captureInventoryCutoverDeploymentAuthority,
  authorityOptions = {},
  maintenanceReader = readCloudMaintenanceStatus,
  maintenanceFile = process.env.SHEIN_BI_MAINTENANCE_FILE,
  now = () => new Date(),
  lockFile = inventoryCutoverLockFile(),
  receiptWriteOptions,
  ...pathOptions
} = {}) {
  const {selected, expected} = assertModeAndHash(mode, expectedPreflightHash);
  return withInventoryCutoverLock(async () => {
    const paths = compatibilityPaths(pathOptions);
    const maintenance = await requireInventoryCutoverMaintenanceAll({maintenanceFile, maintenanceReader});
    const authority = normalizeAuthority(await authorityReader(authorityOptions));
    const existing = await readActivationRegistryRecord(paths.activationFile);
    const recordedAt = now().toISOString();
    const activation = existing.exists
      ? existing.activation
      : buildInventoryCutoverActivationRecord({authority, requiredManualResolution, activatedAt: recordedAt});
    if (!sameCompatibilityAuthority(activation.authority, authority)
      || stableInventoryHash(activation.requiredManualResolution) !== stableInventoryHash(activationCore({
        authority, requiredManualResolution, activatedAt: activation.activatedAt,
      }).requiredManualResolution)) {
      fail('INVENTORY_CUTOVER_ACTIVATION_RECOVERY_DRIFT', 'activation target or deployment authority drift');
    }
    const preflightHash = activation.activationHash;
    const currentStateHash = stableInventoryHash({
      activationExists: existing.exists,
      activationRegistrySha256: existing.registrySha256 || '',
    });
    if (selected === 'dry-run') {
      return {
        state: existing.exists ? 'activation_existing_dry_run' : 'activation_dry_run',
        mode: selected, preflightHash, activation, authority, maintenance, currentStateHash,
        paths, recordedAt: activation.activatedAt,
      };
    }
    if (expected !== preflightHash) fail('INVENTORY_CUTOVER_EXPECTED_PREFLIGHT_HASH_MISMATCH', 'activation preflight drift');
    const result = await activateInventoryCutover({
      ...paths,
      requiredManualResolution,
      authorityReader: async () => authority,
      maintenanceReader: async () => maintenance,
      now: () => new Date(recordedAt),
      lockFile,
      receiptWriteOptions,
    });
    const readback = await requireCurrentInventoryCutoverActivation({
      ...paths,
      authorityReader: async () => authority,
    });
    return {...result, state: result.state, mode: selected, preflightHash, authority, maintenance, currentStateHash, paths, recordedAt: activation.activatedAt, readback};
  }, {lockFile, timeoutCode: 'INVENTORY_CUTOVER_ACTIVATION_LOCK_TIMEOUT'});
}

export async function activateInventoryCutover({
  activationFile = process.env.SHEIN_BI_INVENTORY_CUTOVER_ACTIVATION_FILE || DEFAULT_INVENTORY_CUTOVER_ACTIVATION_FILE,
  activationReceiptFile = process.env.SHEIN_BI_INVENTORY_CUTOVER_ACTIVATION_RECEIPT_FILE || DEFAULT_INVENTORY_CUTOVER_ACTIVATION_RECEIPT_FILE,
  compatibilityFile = '',
  compatibilityReceiptFile = '',
  requiredManualResolution,
  authorityReader = captureInventoryCutoverDeploymentAuthority,
  authorityOptions = {},
  maintenanceReader = readCloudMaintenanceStatus,
  maintenanceFile = process.env.SHEIN_BI_MAINTENANCE_FILE,
  now = () => new Date(),
  lockFile = inventoryCutoverLockFile(),
  _underLock = false,
  receiptWriteOptions,
} = {}) {
  if (!_underLock) {
    return withInventoryCutoverLock(() => activateInventoryCutover({
      activationFile,
      activationReceiptFile,
      compatibilityFile,
      compatibilityReceiptFile,
      requiredManualResolution,
      authorityReader,
      authorityOptions,
      maintenanceReader,
      maintenanceFile,
      now,
      lockFile,
      _underLock: true,
      receiptWriteOptions,
    }), {lockFile});
  }
  const paths = compatibilityPaths({activationFile, activationReceiptFile, compatibilityFile, compatibilityReceiptFile});
  let existing;
  try {
    existing = await readActivationBase(paths);
  } catch (error) {
    if (error?.code !== 'INVENTORY_CUTOVER_ACTIVATION_RECEIPT_MISSING') throw error;
    const registry = await readActivationRegistryRecord(paths.activationFile);
    if (!registry.exists) throw error;
    await requireInventoryCutoverMaintenanceAll({maintenanceFile, maintenanceReader});
    const currentAuthority = await authorityReader(authorityOptions);
    const expected = buildInventoryCutoverActivationRecord({
      authority: currentAuthority,
      requiredManualResolution,
      activatedAt: registry.activation.activatedAt,
    });
    if (expected.activationHash !== registry.activation.activationHash) {
      fail('INVENTORY_CUTOVER_ACTIVATION_RECOVERY_DRIFT', 'cannot recover receipt for a different deployment or target binding');
    }
    const recoveredReceipt = buildInventoryCutoverActivationReceipt({
      activationFile: registry.activationFile,
      activationFileSha256: registry.registrySha256,
      activationHash: registry.activation.activationHash,
      recordedAt: now().toISOString(),
    });
    await writeJsonExclusive(paths.activationReceiptFile, recoveredReceipt);
    existing = await readActivationBase(paths);
    const compatibility = await ensureInitialCompatibility({
      base: existing, paths, authority: currentAuthority, recordedAt: now().toISOString(), receiptWriteOptions,
    });
    return {...existing, compatibility, activeAuthority: compatibility.activeRecord.authority, state: 'activation_receipt_recovered'};
  }
  if (existing.activated) {
    let complete;
    try { complete = await readInventoryCutoverActivation(paths); } catch (error) {
      if (!String(error?.code || '').startsWith('INVENTORY_CUTOVER_COMPATIBILITY_')) throw error;
    }
    if (complete) return {...complete, state: 'already_activated'};
    await requireInventoryCutoverMaintenanceAll({maintenanceFile, maintenanceReader});
    const currentAuthority = normalizeAuthority(await authorityReader(authorityOptions));
    const compatibility = await ensureInitialCompatibility({
      base: existing, paths, authority: currentAuthority, recordedAt: now().toISOString(), receiptWriteOptions,
    });
    return {...existing, compatibility, activeAuthority: compatibility.activeRecord.authority, state: 'compatibility_initial_recovered'};
  }
  await requireInventoryCutoverMaintenanceAll({maintenanceFile, maintenanceReader});
  const authority = await authorityReader(authorityOptions);
  const activatedAt = now().toISOString();
  const activation = buildInventoryCutoverActivationRecord({authority, requiredManualResolution, activatedAt});
  const target = paths.activationFile;
  await fs.mkdir(path.dirname(target), {recursive: true});
  const handle = await fs.open(target, 'wx', 0o640);
  try {
    await handle.writeFile(`${JSON.stringify(activation)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsyncDirectory(target);
  const readback = await readRegularBoundedFileAsync(target, MAX_REGISTRY_BYTES, 'inventory cutover activation registry readback');
  const registrySha256 = hashBytes(readback.bytes);
  const receipt = buildInventoryCutoverActivationReceipt({
    activationFile: target,
    activationFileSha256: registrySha256,
    activationHash: activation.activationHash,
    recordedAt: activatedAt,
  });
  await writeJsonExclusive(paths.activationReceiptFile, receipt);
  const base = await readActivationBase(paths);
  await ensureInitialCompatibility({base, paths, authority, recordedAt: activatedAt, receiptWriteOptions});
  const terminal = await readInventoryCutoverActivation(paths);
  return {...terminal, state: 'activated'};
}

async function readCompatibilityForMutation(options = {}) {
  const paths = compatibilityPaths(options);
  const base = await readActivationBase(paths);
  if (!base.activated) fail('INVENTORY_CUTOVER_ACTIVATION_REQUIRED', 'reader-first activation is absent');
  const registry = await readCompatibilityRegistry(paths.compatibilityFile, base.activation);
  let receipt = null;
  let receiptError = null;
  try {
    receipt = (await readCompatibilityReceipt(paths.compatibilityReceiptFile, registry, paths.compatibilityFile)).receipt;
  } catch (error) {
    if (!['INVENTORY_CUTOVER_COMPATIBILITY_RECEIPT_MISSING', 'INVENTORY_CUTOVER_COMPATIBILITY_RECEIPT_INVALID'].includes(error?.code)) throw error;
    receiptError = error;
  }
  return {paths, base, ...registry, receipt, receiptError};
}

async function publishCompatibilityReceipt(state, recordedAt, receiptWriteOptions) {
  const receipt = buildCompatibilityReceipt({
    registry: state,
    compatibilityFile: state.paths.compatibilityFile,
    recordedAt,
  });
  await writeJsonAtomicDurable(state.paths.compatibilityReceiptFile, receipt, receiptWriteOptions);
  return (await readCompatibilityReceipt(
    state.paths.compatibilityReceiptFile,
    state,
    state.paths.compatibilityFile,
  )).receipt;
}

function assertModeAndHash(mode, expectedPreflightHash) {
  const selected = text(mode || 'dry-run').toLowerCase();
  if (!['dry-run', 'execute'].includes(selected)) fail('INVENTORY_CUTOVER_MODE_INVALID', `mode=${selected}`);
  const expected = text(expectedPreflightHash).toLowerCase();
  if (selected === 'execute' && !HASH_RE.test(expected)) {
    fail('INVENTORY_CUTOVER_EXPECTED_PREFLIGHT_HASH_REQUIRED', 'execute requires exact preflight hash');
  }
  return {selected, expected};
}

export async function inventoryCompatibilityStatus(options = {}) {
  const state = await readCompatibilityForMutation(options);
  return {
    ok: !state.receiptError,
    activated: true,
    activeGeneration: state.activeGeneration,
    activeAuthority: inventoryCompatibilityAuthority(state.activeRecord.authority),
    activeRecordHash: state.activeRecord.recordHash,
    pendingStage: state.pendingStage || null,
    compatibilityFile: state.paths.compatibilityFile,
    compatibilityReceiptFile: state.paths.compatibilityReceiptFile,
    registrySha256: state.registrySha256,
    receiptHash: state.receipt?.receiptHash || '',
    receiptError: state.receiptError?.code || '',
  };
}

export async function stageInventoryCompatibilityRotation({
  mode = 'dry-run',
  expectedPreflightHash = '',
  candidateAuthority,
  authorityReader = captureInventoryCutoverDeploymentAuthority,
  authorityOptions = {},
  maintenanceReader = readCloudMaintenanceStatus,
  maintenanceFile = process.env.SHEIN_BI_MAINTENANCE_FILE,
  now = () => new Date(),
  lockFile = inventoryCutoverLockFile(),
  afterAppendHook,
  receiptWriteOptions,
  ...pathOptions
} = {}) {
  const {selected, expected} = assertModeAndHash(mode, expectedPreflightHash);
  const candidate = inventoryCompatibilityAuthority(candidateAuthority);
  return withInventoryCutoverLock(async () => {
    let state = await readCompatibilityForMutation(pathOptions);
    const maintenance = await requireInventoryCutoverMaintenanceAll({maintenanceFile, maintenanceReader});
    const current = normalizeAuthority(await authorityReader(authorityOptions));
    const currentIsActive = sameCompatibilityAuthority(current, state.activeRecord.authority);
    const currentIsCandidate = state.pendingStage
      && sameCompatibilityAuthority(current, state.pendingStage.candidateAuthority);
    if (!currentIsActive && !currentIsCandidate) {
      fail('INVENTORY_CUTOVER_ROTATION_CURRENT_AUTHORITY_INVALID', 'current checkout is neither active nor exact staged candidate');
    }
    if (state.pendingStage) {
      if (!sameCompatibilityAuthority(state.pendingStage.candidateAuthority, candidate)) {
        fail('INVENTORY_CUTOVER_ROTATION_ALREADY_STAGED', 'a different candidate is already staged');
      }
      const preflightHash = state.pendingStage.recordHash;
      if (selected === 'execute' && expected !== preflightHash) {
        fail('INVENTORY_CUTOVER_EXPECTED_PREFLIGHT_HASH_MISMATCH', 'staged record hash mismatch');
      }
      if (selected === 'execute' && state.receiptError) {
        const receipt = await publishCompatibilityReceipt(state, now().toISOString(), receiptWriteOptions);
        state = {...state, receipt, receiptError: null};
      } else if (selected === 'execute' && !state.receipt) {
        fail('INVENTORY_CUTOVER_COMPATIBILITY_RECEIPT_MISSING', 'staged state receipt is missing');
      }
      return {
        state: selected === 'execute' ? 'rotation_stage_recovered' : 'rotation_already_staged',
        mode: selected, preflightHash, record: state.pendingStage, authority: current, maintenance,
        currentStateHash: state.pendingStage.currentStateHash, paths: state.paths,
        recordedAt: state.pendingStage.recordedAt,
      };
    }
    if (state.receiptError || !state.receipt) throw state.receiptError;
    if (!currentIsActive) fail('INVENTORY_CUTOVER_ROTATION_CURRENT_AUTHORITY_INVALID', 'stage requires active generation');
    const recordedAt = now().toISOString();
    const record = compatibilityStageRecord({state, candidateAuthority: candidate, maintenance, recordedAt});
    const preflightHash = record.recordHash;
    if (selected === 'dry-run') return {
      state: 'rotation_stage_dry_run', mode: selected, preflightHash, record,
      authority: current, maintenance, currentStateHash: record.currentStateHash,
      paths: state.paths, recordedAt,
    };
    if (expected !== preflightHash) fail('INVENTORY_CUTOVER_EXPECTED_PREFLIGHT_HASH_MISMATCH', 'rotation stage preflight drift');
    await appendJsonLineDurable(state.paths.compatibilityFile, record, state.registrySha256, {afterAppendHook});
    state = await readCompatibilityForMutation(pathOptions);
    const receipt = await publishCompatibilityReceipt(state, recordedAt, receiptWriteOptions);
    return {
      state: 'rotation_staged', mode: selected, preflightHash, record: state.pendingStage, receipt,
      authority: current, maintenance, currentStateHash: record.currentStateHash,
      paths: state.paths, recordedAt,
    };
  }, {lockFile, timeoutCode: 'INVENTORY_CUTOVER_ROTATION_LOCK_TIMEOUT'});
}

export async function finalizeInventoryCompatibilityRotation({
  mode = 'dry-run',
  expectedPreflightHash = '',
  authorityReader = captureInventoryCutoverDeploymentAuthority,
  authorityOptions = {},
  maintenanceReader = readCloudMaintenanceStatus,
  maintenanceFile = process.env.SHEIN_BI_MAINTENANCE_FILE,
  now = () => new Date(),
  lockFile = inventoryCutoverLockFile(),
  afterAppendHook,
  receiptWriteOptions,
  ...pathOptions
} = {}) {
  const {selected, expected} = assertModeAndHash(mode, expectedPreflightHash);
  return withInventoryCutoverLock(async () => {
    let state = await readCompatibilityForMutation(pathOptions);
    const maintenance = await requireInventoryCutoverMaintenanceAll({maintenanceFile, maintenanceReader});
    const current = normalizeAuthority(await authorityReader(authorityOptions));
    if (!state.pendingStage) {
      if (!sameCompatibilityAuthority(current, state.activeRecord.authority)) {
        fail('INVENTORY_CUTOVER_ROTATION_CURRENT_AUTHORITY_INVALID', 'no pending stage and current checkout is not active');
      }
      const preflightHash = state.activeRecord.kind === 'compatibility_rotation_finalized'
        ? state.activeRecord.recordHash : '';
      if (!preflightHash) fail('INVENTORY_CUTOVER_ROTATION_STAGE_REQUIRED', 'no staged rotation');
      if (selected === 'execute' && expected !== preflightHash) {
        fail('INVENTORY_CUTOVER_EXPECTED_PREFLIGHT_HASH_MISMATCH', 'finalized record hash mismatch');
      }
      if (selected === 'execute' && state.receiptError) {
        const receipt = await publishCompatibilityReceipt(state, now().toISOString(), receiptWriteOptions);
        return {
          state: 'rotation_finalize_receipt_recovered', mode: selected, preflightHash,
          record: state.activeRecord, receipt, authority: current, maintenance,
          currentStateHash: state.activeRecord.currentStateHash, paths: state.paths,
          recordedAt: state.activeRecord.recordedAt,
        };
      }
      return {
        state: 'rotation_already_finalized', mode: selected, preflightHash,
        record: state.activeRecord, receipt: state.receipt, authority: current, maintenance,
        currentStateHash: state.activeRecord.currentStateHash, paths: state.paths,
        recordedAt: state.activeRecord.recordedAt,
      };
    }
    if (!sameCompatibilityAuthority(current, state.pendingStage.candidateAuthority)) {
      fail('INVENTORY_CUTOVER_ROTATION_CANDIDATE_NOT_DEPLOYED', 'current checkout does not match staged candidate');
    }
    const recordedAt = now().toISOString();
    const record = compatibilityFinalizeRecord({state, authority: current, maintenance, recordedAt});
    const preflightHash = record.recordHash;
    if (selected === 'dry-run') return {
      state: 'rotation_finalize_dry_run', mode: selected, preflightHash, record,
      authority: current, maintenance, currentStateHash: record.currentStateHash,
      paths: state.paths, recordedAt,
    };
    if (expected !== preflightHash) fail('INVENTORY_CUTOVER_EXPECTED_PREFLIGHT_HASH_MISMATCH', 'rotation finalize preflight drift');
    await appendJsonLineDurable(state.paths.compatibilityFile, record, state.registrySha256, {afterAppendHook});
    state = await readCompatibilityForMutation(pathOptions);
    const receipt = await publishCompatibilityReceipt(state, recordedAt, receiptWriteOptions);
    return {
      state: 'rotation_finalized', mode: selected, preflightHash, record: state.activeRecord, receipt,
      authority: current, maintenance, currentStateHash: record.currentStateHash,
      paths: state.paths, recordedAt,
    };
  }, {lockFile, timeoutCode: 'INVENTORY_CUTOVER_ROTATION_LOCK_TIMEOUT'});
}

export function inventoryCutoverLockFile() {
  return path.resolve(process.env.SHEIN_BI_INVENTORY_GLOBAL_LOCK_FILE
    || DEFAULT_INVENTORY_CUTOVER_LOCK_FILE);
}

export async function withInventoryCutoverLock(callback, {
  lockFile = inventoryCutoverLockFile(),
  timeoutMs = 60_000,
  staleMs = 20 * 60_000,
  timeoutCode = 'INVENTORY_CUTOVER_LOCK_TIMEOUT',
} = {}) {
  const resolved = path.resolve(lockFile);
  const current = lockContext.getStore();
  if (current?.lockFile === resolved) return callback({lockFile: resolved, reentrant: true});
  const release = await acquireCrossProcessTicketLock(resolved, {timeoutMs, staleMs, timeoutCode});
  try {
    return await lockContext.run({lockFile: resolved}, () => callback({lockFile: resolved, reentrant: false}));
  } finally {
    await release();
  }
}
