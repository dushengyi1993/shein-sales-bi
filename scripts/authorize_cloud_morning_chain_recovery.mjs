#!/usr/bin/env node

/**
 * Authorize one explicit, same-day recovery of an expired morning-chain
 * active context.  This command only publishes a receipt and updates the
 * existing active context.  The existing morning-chain service remains the
 * sole executor; this script never starts the service or its child chain.
 */

import crypto from 'node:crypto';
import {execFile, spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

import {writeJsonFileAtomic as publishJsonFileAtomic} from '../lib/atomic_file_publish.mjs';
import {
  DEFAULT_CLOUD_MAINTENANCE_FILE,
  readCloudMaintenanceStatus,
} from '../lib/cloud_maintenance_mode.mjs';

const execFileAsync = promisify(execFile);

export const MORNING_CHAIN_RECOVERY_CONFIRMATION = 'AUTHORIZE_MORNING_CHAIN_RECOVERY';
export const MORNING_CHAIN_RECOVERY_SCHEMA_VERSION = 'morning-chain-recovery/v1';
export const MORNING_CHAIN_RECOVERY_SERVICE = 'shein-bi-cloud-morning-chain.service';
export const MORNING_CHAIN_RECOVERY_TIMER = 'shein-bi-cloud-morning-chain.timer';
export const MORNING_CHAIN_RECOVERY_MAX_BUDGET_SEC = 3 * 60 * 60;
const CST_OFFSET_HOURS = 8;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ACTIVE_RUNNING_STATES = new Set(['active', 'activating', 'deactivating', 'reloading']);
const SECRET_LIKE_REASON = /(?:-----BEGIN [^-]*PRIVATE KEY-----|\b(?:authorization|cookie|password|passwd|secret|token|api[-_ ]?key)\s*[:=]\s*\S+|\bbearer\s+[a-z0-9._~+/-]{12,})/iu;
const LOCK_READY_LINE = 'MORNING_CHAIN_RECOVERY_LOCK_ACQUIRED';

export class MorningChainRecoveryError extends Error {
  constructor(message, {code = 'MORNING_CHAIN_RECOVERY_BLOCKED', exitCode = 64, detail = {}} = {}) {
    super(message);
    this.name = 'MorningChainRecoveryError';
    this.code = code;
    this.exitCode = exitCode;
    this.detail = detail;
  }
}
function fail(message, options = {}) {
  throw new MorningChainRecoveryError(message, options);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(stableValue(value));
}

function isValidDate(value) {
  if (!DATE_PATTERN.test(String(value || ''))) return false;
  const [year, month, day] = String(value).split('-').map(Number);
  const epoch = Date.UTC(year, month - 1, day);
  return Number.isFinite(epoch) && new Date(epoch).toISOString().slice(0, 10) === value;
}

function normalizeDate(value, label) {
  const date = String(value || '').trim();
  if (!isValidDate(date)) fail(`${label} must be a valid YYYY-MM-DD date`, {code: 'MORNING_CHAIN_RECOVERY_DATE_INVALID'});
  return date;
}

function previousDate(date) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

function cstDateParts(epochSeconds) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(epochSeconds * 1_000));
  const values = Object.fromEntries(parts
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  };
}

function cstDateKey(epochSeconds) {
  const parts = cstDateParts(epochSeconds);
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function cstEpoch(date, hour, minute) {
  const [year, month, day] = date.split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day, hour - CST_OFFSET_HOURS, minute, 0) / 1_000);
}

function normalizeEpoch(value, label) {
  const number = typeof value === 'number' ? value : Number(String(value || '').trim());
  if (!Number.isSafeInteger(number) || number <= 0) {
    fail(`${label} must be a positive integer epoch`, {code: 'MORNING_CHAIN_RECOVERY_EPOCH_INVALID'});
  }
  return number;
}

function resolveNow(now) {
  const value = typeof now === 'function' ? now() : now;
  return normalizeEpoch(value, 'now');
}

function normalizeReason(value) {
  const reason = String(value || '').trim();
  if (!reason) fail('reason is required', {code: 'MORNING_CHAIN_RECOVERY_REASON_INVALID'});
  if (reason.length > 500) fail('reason exceeds 500 characters', {code: 'MORNING_CHAIN_RECOVERY_REASON_INVALID'});
  if (/[\u0000-\u001f\u007f]/u.test(reason) || SECRET_LIKE_REASON.test(reason)) {
    fail('reason contains control characters or secret-like material', {code: 'MORNING_CHAIN_RECOVERY_REASON_SENSITIVE'});
  }
  return reason;
}

function normalizeStateRoot(value) {
  const resolved = path.resolve(String(value || '').trim());
  if (!value || resolved === path.parse(resolved).root) {
    fail('state root must be a non-root directory', {code: 'MORNING_CHAIN_RECOVERY_STATE_ROOT_INVALID'});
  }
  return resolved;
}

function defaultStateRoot() {
  return process.env.SHEIN_BI_STATE_ROOT || '/data/shein-bi/state';
}

function defaultInventoryRuntimeRoot() {
  return process.env.SHEIN_BI_INVENTORY_RUNTIME_ROOT || '/srv/shein-bi/runtime/daily-inventory-replenishment';
}

function pathsFor({stateRoot, inventoryRuntimeRoot, runDate}) {
  const cloudState = path.join(stateRoot, 'cloud_morning_chain');
  const markerDirectory = path.join(stateRoot, 'pipeline-markers', runDate);
  const resultFile = path.join(inventoryRuntimeRoot, 'results', `daily-inventory-replenishment-${runDate}.json`);
  return {
    activeFile: path.join(cloudState, 'active.json'),
    latestFile: path.join(cloudState, 'latest.json'),
    terminalDeadlineAlertFile: path.join(stateRoot, 'cloud_ops_alerts', 'morning-chain-last.json'),
    metricRefetchStateFile: path.join(stateRoot, 'cloud_ops_alerts', 'link-business-metric-refetch.json'),
    morningAllMarkerFile: path.join(markerDirectory, 'morning-all.json'),
    receiptFile: path.join(cloudState, 'recovery', `${runDate}.json`),
    dailyOperatingRefreshMarker: path.join(markerDirectory, 'daily-operating-refresh.json'),
    inventoryStartedMarker: path.join(markerDirectory, 'inventory-started.json'),
    stockRefreshMarkerFile: path.join(markerDirectory, 'stock-refresh.json'),
    dailyInventoryGuardMarker: path.join(markerDirectory, 'daily-inventory-guard.json'),
    inventoryPlanFile: path.join(inventoryRuntimeRoot, 'plans', `daily-inventory-replenishment-${runDate}.json`),
    inventoryResultFile: resultFile,
    inventoryJournalFile: `${resultFile}.journal.ndjson`,
  };
}

async function readRegularFile(file, label, {required = true} = {}) {
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT' && !required) return null;
    fail(`${label} is missing or unreadable: ${error?.code || error?.message || error}`, {
      code: 'MORNING_CHAIN_RECOVERY_EVIDENCE_UNREADABLE',
      detail: {file, label},
    });
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`${label} must be a regular non-symlink file`, {
      code: 'MORNING_CHAIN_RECOVERY_EVIDENCE_UNSAFE',
      detail: {file, label},
    });
  }
  try {
    return {bytes: await fs.readFile(file), stat};
  } catch (error) {
    fail(`${label} could not be read: ${error?.code || error?.message || error}`, {
      code: 'MORNING_CHAIN_RECOVERY_EVIDENCE_UNREADABLE',
      detail: {file, label},
    });
  }
}

async function readJson(file, label, {required = true} = {}) {
  const artifact = await readRegularFile(file, label, {required});
  if (artifact === null) return null;
  const {bytes, stat} = artifact;
  try {
    return {
      value: JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, '')),
      bytes,
      hash: sha256(bytes),
      stat,
    };
  } catch (error) {
    fail(`${label} is not valid JSON: ${error?.message || error}`, {
      code: 'MORNING_CHAIN_RECOVERY_EVIDENCE_INVALID_JSON',
      detail: {file, label},
    });
  }
}

function publishMetadataFromEvidence(evidence, label) {
  const stat = evidence?.stat;
  if (!stat || !Number.isSafeInteger(stat.mode)) {
    fail(`${label} metadata is unavailable`, {
      code: 'MORNING_CHAIN_RECOVERY_EVIDENCE_UNREADABLE',
      detail: {label},
    });
  }
  const mode = stat.mode & 0o777;
  const writeOptions = {mode};
  const expected = {mode};
  if (process.platform !== 'win32') {
    if (!Number.isSafeInteger(stat.uid) || stat.uid < 0
      || !Number.isSafeInteger(stat.gid) || stat.gid < 0) {
      fail(`${label} owner metadata is invalid`, {
        code: 'MORNING_CHAIN_RECOVERY_EVIDENCE_UNREADABLE',
        detail: {label},
      });
    }
    expected.uid = stat.uid;
    expected.gid = stat.gid;
    const effectiveUid = process.getuid?.();
    if (effectiveUid === 0) {
      writeOptions.uid = stat.uid;
      writeOptions.gid = stat.gid;
    } else if (Number.isSafeInteger(effectiveUid) && effectiveUid !== stat.uid) {
      fail(`${label} is not owned by the recovery authorizer`, {
        code: 'MORNING_CHAIN_RECOVERY_OWNER_MISMATCH',
        detail: {label, ownerUid: stat.uid, effectiveUid},
      });
    }
  }
  return {writeOptions, expected};
}

function assertPublishedMetadata(evidence, expected, label) {
  if ((evidence.stat.mode & 0o777) !== expected.mode) {
    fail(`${label} mode changed during atomic publication`, {
      code: 'MORNING_CHAIN_RECOVERY_READBACK_DRIFT',
      detail: {label, actualMode: evidence.stat.mode & 0o777, expectedMode: expected.mode},
    });
  }
  if (process.platform !== 'win32'
    && (evidence.stat.uid !== expected.uid || evidence.stat.gid !== expected.gid)) {
    fail(`${label} owner changed during atomic publication`, {
      code: 'MORNING_CHAIN_RECOVERY_READBACK_DRIFT',
      detail: {
        label,
        actualUid: evidence.stat.uid,
        actualGid: evidence.stat.gid,
        expectedUid: expected.uid,
        expectedGid: expected.gid,
      },
    });
  }
}

async function assertAbsent(file, label) {
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    fail(`${label} could not be checked: ${error?.code || error?.message || error}`, {
      code: 'MORNING_CHAIN_RECOVERY_EVIDENCE_UNREADABLE',
      detail: {file, label},
    });
  }
  fail(`${label} already exists; recovery refuses to overwrite or delete it`, {
    code: 'MORNING_CHAIN_RECOVERY_EVIDENCE_EXISTS',
    detail: {file, label, kind: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file'},
  });
}

function parseAssignments(stdout) {
  const result = {};
  for (const line of String(stdout || '').split(/\r?\n/u)) {
    const index = line.indexOf('=');
    if (index <= 0) continue;
    result[line.slice(0, index)] = line.slice(index + 1).trim();
  }
  return result;
}

async function defaultSystemctlRunner({bin, args}) {
  try {
    const result = await execFileAsync(bin, args, {encoding: 'utf8', maxBuffer: 256 * 1024});
    return {code: 0, stdout: result.stdout, stderr: result.stderr};
  } catch (error) {
    return {
      code: Number.isInteger(error?.code) ? error.code : 1,
      stdout: String(error?.stdout || ''),
      stderr: String(error?.stderr || error?.message || error),
    };
  }
}

async function checkSystemdUnit(unit, {systemctlBin, systemctlRunner}) {
  const args = [
    'show',
    '--no-pager',
    '--plain',
    '--property=LoadState',
    '--property=ActiveState',
    '--property=SubState',
    ...(unit.endsWith('.service')
      ? ['--property=Result', '--property=ExecMainCode', '--property=ExecMainStatus', '--property=MainPID']
      : []),
    '--property=Job',
    unit,
  ];
  const result = await systemctlRunner({bin: systemctlBin, args, unit});
  if (Number(result?.code) !== 0) {
    fail(`systemctl show failed for ${unit}`, {
      code: 'MORNING_CHAIN_RECOVERY_SYSTEMCTL_FAILED',
      detail: {unit, code: result?.code, stderr: String(result?.stderr || '').slice(0, 500)},
    });
  }
  const values = parseAssignments(result?.stdout);
  for (const property of ['LoadState', 'ActiveState', 'SubState', 'Job']) {
    if (!Object.hasOwn(values, property)) {
      fail(`systemctl show omitted ${property} for ${unit}`, {
        code: 'MORNING_CHAIN_RECOVERY_SYSTEMCTL_INCOMPLETE',
        detail: {unit, property},
      });
    }
  }
  if (values.LoadState !== 'loaded') {
    fail(`${unit} is not loaded`, {
      code: 'MORNING_CHAIN_RECOVERY_SYSTEMCTL_NOT_LOADED',
      detail: {unit, loadState: values.LoadState},
    });
  }
  if (!values.SubState) {
    fail(`${unit} has no SubState proof`, {
      code: 'MORNING_CHAIN_RECOVERY_SYSTEMCTL_INCOMPLETE',
      detail: {unit},
    });
  }
  const activeStateBlocks = unit.endsWith('.service')
    ? ACTIVE_RUNNING_STATES.has(values.ActiveState)
    : new Set(['activating', 'deactivating', 'reloading']).has(values.ActiveState);
  if (activeStateBlocks) {
    fail(`${unit} has an active or transitional job state`, {
      code: 'MORNING_CHAIN_RECOVERY_SERVICE_ACTIVE',
      detail: {unit, activeState: values.ActiveState, subState: values.SubState},
    });
  }
  if (values.Job !== '') {
    fail(`${unit} has an active systemd job`, {
      code: 'MORNING_CHAIN_RECOVERY_SYSTEMD_JOB_ACTIVE',
      detail: {unit, job: values.Job},
    });
  }
  return {
    unit,
    loadState: values.LoadState,
    activeState: values.ActiveState,
    subState: values.SubState,
    result: values.Result || '',
    execMainCode: values.ExecMainCode || '',
    execMainStatus: values.ExecMainStatus || '',
    mainPid: values.MainPID || '',
    job: values.Job,
  };
}

function isInterruptedMorningService(service) {
  return service?.unit === MORNING_CHAIN_RECOVERY_SERVICE
    && service.activeState === 'failed'
    && service.subState === 'failed'
    && service.result === 'signal'
    && service.execMainCode === '2'
    && service.execMainStatus === '15'
    && (service.mainPid === '' || service.mainPid === '0');
}

function validateReceiptShape(receipt, file) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    fail('recovery receipt must be a JSON object', {code: 'MORNING_CHAIN_RECOVERY_RECEIPT_INVALID', detail: {file}});
  }
  const canonicalHash = String(receipt.canonicalHash || '');
  const body = {...receipt};
  delete body.canonicalHash;
  if (!SHA256_PATTERN.test(canonicalHash) || sha256(canonicalJson(body)) !== canonicalHash) {
    fail('recovery receipt canonical hash is invalid', {
      code: 'MORNING_CHAIN_RECOVERY_RECEIPT_HASH_INVALID',
      detail: {file},
    });
  }
  if (receipt.schemaVersion !== MORNING_CHAIN_RECOVERY_SCHEMA_VERSION
    || !isValidDate(String(receipt.runDate || ''))
    || !isValidDate(String(receipt.businessDate || ''))
    || !SHA256_PATTERN.test(String(receipt.beforeHash || ''))
    || !Number.isSafeInteger(receipt.oldDeadlineEpoch) || receipt.oldDeadlineEpoch <= 0
    || !Number.isSafeInteger(receipt.newDeadlineEpoch) || receipt.newDeadlineEpoch <= 0
    || receipt.recoveryGeneration !== 1
    || Number.isNaN(Date.parse(String(receipt.createdAt || '')))
    || normalizeReason(receipt.reason) !== String(receipt.reason)) {
    fail('recovery receipt fields are invalid', {
      code: 'MORNING_CHAIN_RECOVERY_RECEIPT_INVALID',
      detail: {file},
    });
  }
  return receipt;
}

function validateActiveObject(active, file) {
  if (!active || typeof active !== 'object' || Array.isArray(active)) {
    fail('active context must be a JSON object', {code: 'MORNING_CHAIN_RECOVERY_ACTIVE_INVALID', detail: {file}});
  }
  const deadline = active.deadlineEpoch;
  if (!isValidDate(String(active.runDate || '')) || !isValidDate(String(active.businessDate || ''))
    || !Number.isSafeInteger(deadline) || deadline <= 0) {
    fail('active context has invalid run dates or deadline', {
      code: 'MORNING_CHAIN_RECOVERY_ACTIVE_INVALID',
      detail: {file},
    });
  }
  return active;
}

function phaseProofIsAfterInventory(latest) {
  const explicitPhase = latest?.errorPhase ?? latest?.failurePhase ?? latest?.phase ?? '';
  const phase = String(explicitPhase).trim().toLowerCase().replace(/[_\s]+/gu, '-');
  if (phase && (phase.includes('plan') || phase.includes('result') || phase.includes('journal')
    || phase === 'inventory' || phase.startsWith('inventory-'))) return true;
  if (latest?.inventoryPlanStarted === true || latest?.inventoryResultStarted === true
    || latest?.inventoryPlanCreated === true || latest?.inventoryResultCreated === true) return true;
  return false;
}

function assertLatestIsPreInventoryFailure(latest, runDate, businessDate, {allowWaiting = false, interruptedService = null} = {}) {
  const interruptedWaiting = latest?.status === 'waiting' && isInterruptedMorningService(interruptedService);
  if (latest?.status !== 'failed' && !(allowWaiting && latest?.status === 'waiting') && !interruptedWaiting) {
    fail('latest.json must be failed before recovery authorization', {
      code: latest?.status === 'done'
        ? 'MORNING_CHAIN_RECOVERY_COMPLETION_DONE'
        : 'MORNING_CHAIN_RECOVERY_LATEST_NOT_FAILED',
      detail: {status: latest?.status || 'missing', interruptedService: interruptedService || null},
    });
  }
  if (String(latest?.date || '') !== runDate || String(latest?.businessDate || '') !== businessDate) {
    fail('latest.json date pair does not match the requested same-day run', {
      code: 'MORNING_CHAIN_RECOVERY_LATEST_DATE_MISMATCH',
      detail: {latestDate: latest?.date, latestBusinessDate: latest?.businessDate, runDate, businessDate},
    });
  }
  if (latest?.status === 'waiting' && latest?.stage !== 'all') {
    fail('waiting latest state must be the exact morning chain all-stage state', {
      code: 'MORNING_CHAIN_RECOVERY_LATEST_STAGE_MISMATCH',
      detail: {stage: latest?.stage || null, runDate, businessDate},
    });
  }
  if (phaseProofIsAfterInventory(latest)) {
    fail('latest.json indicates failure after inventory plan/result began', {
      code: 'MORNING_CHAIN_RECOVERY_FAILURE_AFTER_INVENTORY',
      detail: {
        errorPhase: latest?.errorPhase,
        failurePhase: latest?.failurePhase,
        phase: latest?.phase,
      },
    });
  }
}

function assertMarkerNotDone(marker, label) {
  if (marker?.value?.status === 'done') {
    fail(`${label} is already done; recovery cannot replay the run`, {
      code: 'MORNING_CHAIN_RECOVERY_COMPLETION_DONE',
      detail: {status: marker.value.status, file: marker.file},
    });
  }
}

async function publishMetadataForCreatedActive(directory) {
  let stat;
  try {
    stat = await fs.lstat(directory);
  } catch (error) {
    fail(`active context parent directory is missing or unreadable: ${error?.code || error?.message || error}`, {
      code: 'MORNING_CHAIN_RECOVERY_ACTIVE_DIRECTORY_UNAVAILABLE',
      detail: {directory},
    });
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail('active context parent directory must be a real directory', {
      code: 'MORNING_CHAIN_RECOVERY_ACTIVE_DIRECTORY_UNSAFE',
      detail: {directory},
    });
  }
  const mode = process.platform === 'win32' ? 0o666 : 0o660;
  const writeOptions = {mode};
  const expected = {mode};
  if (process.platform !== 'win32') {
    writeOptions.uid = stat.uid;
    writeOptions.gid = stat.gid;
    expected.uid = stat.uid;
    expected.gid = stat.gid;
  }
  return {writeOptions, expected};
}

function assertSameDayTerminalRebuildEvidence({
  terminalDeadlineAlert, morningAllMarker, runDate, businessDate,
}) {
  const alert = terminalDeadlineAlert?.value;
  if (!alert || typeof alert !== 'object' || Array.isArray(alert)
    || alert.status !== 'failed' || alert.stage !== 'all'
    || alert.date !== runDate || alert.businessDate !== businessDate
    || !Number.isSafeInteger(alert.deadlineEpoch) || alert.deadlineEpoch <= 0) {
    fail('active context can be rebuilt only from an exact same-day structured terminal deadline alert', {
      code: 'MORNING_CHAIN_RECOVERY_REBUILD_EVIDENCE_MISMATCH',
      detail: {file: terminalDeadlineAlert?.file, runDate, businessDate},
    });
  }
  const marker = morningAllMarker?.value;
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)
    || marker.stage !== 'morning-all' || marker.status !== 'failed'
    || marker.runDate !== runDate || marker.businessDate !== businessDate) {
    fail('active context can be rebuilt only with the exact same-day failed morning-all marker', {
      code: 'MORNING_CHAIN_RECOVERY_REBUILD_EVIDENCE_MISMATCH',
      detail: {file: morningAllMarker?.file, runDate, businessDate},
    });
  }
  const message = String(marker.message || '');
  const match = message.match(/^first-start absolute deadline expired deadlineEpoch=(\d+) runDate=([^\s]+) businessDate=([^\s]+); no further automatic attempts in this window$/u);
  if (!match || Number(match[1]) !== alert.deadlineEpoch
    || match[2] !== runDate || match[3] !== businessDate) {
    fail('morning-all marker deadline binding does not match the structured terminal alert', {
      code: 'MORNING_CHAIN_RECOVERY_REBUILD_DEADLINE_MISMATCH',
      detail: {deadlineEpoch: alert.deadlineEpoch, markerMessage: message.slice(0, 500)},
    });
  }
  return {oldDeadlineEpoch: alert.deadlineEpoch};
}

function rebuildEvidenceHash({terminalDeadlineAlert, morningAllMarker, latest}) {
  return sha256(canonicalJson({
    latest: latest.value,
    morningAllMarker: morningAllMarker.value,
    terminalDeadlineAlert: terminalDeadlineAlert.value,
  }));
}

function assertDoneMarker(marker, {stage, runDate, businessDate, label}) {
  if (!marker?.value || marker.value.ok !== true || marker.value.stage !== stage
    || marker.value.status !== 'done' || marker.value.runDate !== runDate
    || marker.value.businessDate !== businessDate) {
    fail(`${label} must be an exact same-day done marker`, {
      code: 'MORNING_CHAIN_RECOVERY_MARKER_MISSING',
      detail: {file: marker?.file, stage, runDate, businessDate},
    });
  }
}

function assertRecoveryCheckpoint({inventoryStarted, stockRefresh, runDate, businessDate}) {
  if (inventoryStarted) {
    assertDoneMarker(inventoryStarted, {
      stage: 'inventory-started',
      runDate,
      businessDate,
      label: 'inventory-started marker',
    });
    return 'inventory-started';
  }
  assertDoneMarker(stockRefresh, {
    stage: 'stock-refresh',
    runDate,
    businessDate: runDate,
    label: 'stock-refresh checkpoint marker',
  });
  return 'stock-refresh';
}

const METRIC_REFETCH_SCHEMA = 'cloud-link-business-metric-refetch/v2';
const METRIC_REFETCH_RECEIPT_HASH_PATTERN = /^[a-f0-9]{64}$/u;

function assertNestedMetricRefetchBase(state, {runDate, businessDate}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)
    || state.schemaVersion !== METRIC_REFETCH_SCHEMA
    || state.date !== businessDate || state.runKey !== `${runDate}:${businessDate}`
    || !Number.isSafeInteger(state.attempts) || state.attempts < 0
    || !Number.isSafeInteger(state.maxAttempts) || state.maxAttempts <= 0
    || state.attempts >= state.maxAttempts
    || !Number.isSafeInteger(state.deadlineEpoch) || state.deadlineEpoch <= 0
    || !Array.isArray(state.targetStores)
    || !['replacedStores', 'failedStores', 'deferredStores'].every(key => Array.isArray(state[key]) && state[key].length === 0)
    || !state.source || typeof state.source !== 'object' || Array.isArray(state.source)
    || state.source.status !== 'rolled_back'
    || state.source.fingerprint !== '' || state.source.transactionRoot !== ''
    || !state.phases || typeof state.phases !== 'object' || Array.isArray(state.phases)
    || Object.keys(state.phases).length !== 0) {
    fail('nested metric refetch state is not an exact recoverable same-run deadline state', {
      code: 'MORNING_CHAIN_RECOVERY_NESTED_METRIC_STATE_INVALID',
      detail: {runDate, businessDate, expectedDate: businessDate, runKey: `${runDate}:${businessDate}`},
    });
  }
}

async function assertMetricCandidateTransactionRoot(root, label) {
  const resolved = path.resolve(String(root || ''));
  if (!resolved || !path.isAbsolute(resolved)
    || !/^\.link-business-metric-refetch\.[^/\\]+$/u.test(path.basename(resolved))) {
    fail(`${label} must be one absolute link-business-metric-refetch candidate root`, {
      code: 'MORNING_CHAIN_RECOVERY_NESTED_METRIC_TRANSACTION_ROOT_INVALID',
      detail: {transactionRoot: resolved},
    });
  }
  let stat;
  try {
    stat = await fs.lstat(resolved);
  } catch (error) {
    fail(`${label} is missing or unreadable: ${error?.code || error?.message || error}`, {
      code: 'MORNING_CHAIN_RECOVERY_NESTED_METRIC_TRANSACTION_ROOT_UNREADABLE',
      detail: {transactionRoot: resolved},
    });
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail(`${label} must be a real non-symlink directory`, {
      code: 'MORNING_CHAIN_RECOVERY_NESTED_METRIC_TRANSACTION_ROOT_UNSAFE',
      detail: {transactionRoot: resolved},
    });
  }
  await assertAbsent(path.join(resolved, 'manifest.json'), `${label} manifest`);
  const journalFile = path.join(resolved, 'journal.ndjson');
  const journal = await readRegularFile(journalFile, `${label} journal`);
  const events = journal.bytes.toString('utf8').split(/\r?\n/u).filter(line => line.trim() !== '');
  if (events.length !== 1) {
    fail(`${label} journal must contain exactly one transaction_created event`, {
      code: 'MORNING_CHAIN_RECOVERY_NESTED_METRIC_JOURNAL_UNSAFE',
      detail: {journalFile, eventCount: events.length},
    });
  }
  let event;
  try { event = JSON.parse(events[0]); } catch (error) {
    fail(`${label} journal is not valid NDJSON: ${error?.message || error}`, {
      code: 'MORNING_CHAIN_RECOVERY_NESTED_METRIC_JOURNAL_UNSAFE',
      detail: {journalFile},
    });
  }
  if (!event || typeof event !== 'object' || Array.isArray(event) || event.event !== 'transaction_created') {
    fail(`${label} journal contains a forbidden post-creation event`, {
      code: 'MORNING_CHAIN_RECOVERY_NESTED_METRIC_JOURNAL_UNSAFE',
      detail: {journalFile, event: event?.event || null},
    });
  }
}

async function inspectNestedMetricRefetchState({metricRefetch, runDate, businessDate, nowEpoch, newDeadlineEpoch}) {
  if (!metricRefetch) return null;
  const state = metricRefetch.value;
  // The consumer starts a new transaction across runs. Historical evidence
  // stays untouched; only an unambiguous, well-formed older identity is ignored.
  const priorRunDate = typeof state?.runKey === 'string' ? state.runKey.split(':')[0] : '';
  if (state?.schemaVersion === METRIC_REFETCH_SCHEMA
    && isValidDate(state.date) && isValidDate(priorRunDate)
    && state.runKey === `${priorRunDate}:${state.date}`
    && state.date === previousDate(priorRunDate)
    && state.date < businessDate && priorRunDate < runDate
    && typeof state.status === 'string' && state.status.length > 0
    && Number.isSafeInteger(state.attempts) && state.attempts >= 0
    && Number.isSafeInteger(state.maxAttempts) && state.maxAttempts > 0
    && state.attempts <= state.maxAttempts
    && Number.isSafeInteger(state.deadlineEpoch) && state.deadlineEpoch > 0
    && ['targetStores', 'replacedStores', 'failedStores', 'deferredStores'].every(key => Array.isArray(state[key]))
    && state.source && typeof state.source === 'object' && !Array.isArray(state.source)
    && state.phases && typeof state.phases === 'object' && !Array.isArray(state.phases)) return null;
  assertNestedMetricRefetchBase(state, {runDate, businessDate});
  if (state.status === 'deadline') {
    if (state.deadlineEpoch >= nowEpoch || state.deadlineEpoch >= newDeadlineEpoch) {
      fail('nested metric refetch deadline is not an expired earlier deadline', {
        code: 'MORNING_CHAIN_RECOVERY_NESTED_METRIC_DEADLINE_MISMATCH',
        detail: {deadlineEpoch: state.deadlineEpoch, nowEpoch, newDeadlineEpoch},
      });
    }
    if (!state.transactionRoot || typeof state.transactionRoot !== 'string') {
      fail('nested metric deadline state must retain its candidate transaction root', {
        code: 'MORNING_CHAIN_RECOVERY_NESTED_METRIC_TRANSACTION_ROOT_INVALID',
        detail: {transactionRoot: state.transactionRoot || ''},
      });
    }
    await assertMetricCandidateTransactionRoot(state.transactionRoot, 'nested metric candidate transaction root');
    return {state, mode: 'deadline'};
  }
  if (state.status === 'recovery_authorized') {
    if (state.transactionRoot !== '' || state.source.transactionRoot !== ''
      || !Number.isSafeInteger(state.previousDeadlineEpoch) || state.previousDeadlineEpoch <= 0
      || !METRIC_REFETCH_RECEIPT_HASH_PATTERN.test(String(state.morningRecoveryReceiptHash || ''))) {
      fail('nested metric recovery-authorized state is malformed', {
        code: 'MORNING_CHAIN_RECOVERY_NESTED_METRIC_STATE_INVALID',
        detail: {runDate, businessDate},
      });
    }
    return {state, mode: 'authorized'};
  }
  fail(`nested metric refetch status is not recoverable: ${String(state.status || '')}`, {
    code: 'MORNING_CHAIN_RECOVERY_NESTED_METRIC_STATE_INVALID',
    detail: {status: state.status || null, runDate, businessDate},
  });
}

function assertNestedMetricRefetchBound(state, receipt, file, {previousDeadlineEpoch} = {}) {
  if (!state || state.status !== 'recovery_authorized'
    || (previousDeadlineEpoch !== undefined && state.previousDeadlineEpoch !== previousDeadlineEpoch)
    || state.deadlineEpoch !== receipt.newDeadlineEpoch
    || state.morningRecoveryReceiptHash !== receipt.canonicalHash
    || state.transactionRoot !== '' || state.source?.transactionRoot !== '') {
    fail('nested metric state is not bound to the exact morning recovery receipt', {
      code: 'MORNING_CHAIN_RECOVERY_NESTED_METRIC_RECEIPT_MISMATCH',
      detail: {file},
    });
  }
}

async function applyOrVerifyNestedMetricRefetch({
  nestedMetric, receipt, paths, writeJsonFileAtomic, writeOptions = {},
}) {
  if (!nestedMetric) return;
  if (nestedMetric.mode === 'deadline') {
    const updatedMetricState = {
      ...nestedMetric.state,
      previousDeadlineEpoch: nestedMetric.state.deadlineEpoch,
      deadlineEpoch: receipt.newDeadlineEpoch,
      status: 'recovery_authorized',
      morningRecoveryReceiptHash: receipt.canonicalHash,
      transactionRoot: '',
      source: {
        ...nestedMetric.state.source,
        transactionRoot: '',
      },
      updatedAt: receipt.createdAt,
    };
    await writeJsonFileAtomic(
      paths.metricRefetchStateFile,
      updatedMetricState,
      {...writeOptions, mode: 0o660},
    );
    const committedMetricEvidence = await readJson(
      paths.metricRefetchStateFile,
      'published nested metric state',
    );
    assertNestedMetricRefetchBound(
      committedMetricEvidence.value,
      receipt,
      paths.metricRefetchStateFile,
      {previousDeadlineEpoch: nestedMetric.state.deadlineEpoch},
    );
    return;
  }
  assertNestedMetricRefetchBound(
    nestedMetric.state,
    receipt,
    paths.metricRefetchStateFile,
  );
}

function receiptMatchesRequest(receipt, {runDate, businessDate, newDeadlineEpoch, reason}) {
  return receipt.runDate === runDate
    && receipt.businessDate === businessDate
    && receipt.newDeadlineEpoch === newDeadlineEpoch
    && receipt.reason === reason;
}

function assertActiveBoundToReceipt(active, receipt, file) {
  if (active.recoveryGeneration !== receipt.recoveryGeneration
    || active.receiptHash !== receipt.canonicalHash
    || active.previousDeadline !== receipt.oldDeadlineEpoch
    || active.deadlineEpoch !== receipt.newDeadlineEpoch
    || active.runDate !== receipt.runDate
    || active.businessDate !== receipt.businessDate) {
    fail('active context and recovery receipt binding drifted', {
      code: 'MORNING_CHAIN_RECOVERY_DRIFT',
      detail: {file, receiptHash: receipt.canonicalHash},
    });
  }
}

async function ensureFlockFile(lockFile) {
  const directory = path.dirname(lockFile);
  await fs.mkdir(directory, {recursive: true});
  const directoryStat = await fs.lstat(directory).catch(error => {
    fail(`morning-chain lock directory is unreadable: ${error?.code || error?.message || error}`, {
      code: 'MORNING_CHAIN_RECOVERY_LOCK_UNSAFE',
      detail: {directory},
    });
  });
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    fail('morning-chain lock directory must be a real directory', {
      code: 'MORNING_CHAIN_RECOVERY_LOCK_UNSAFE',
      detail: {directory},
    });
  }
  let stat;
  try {
    stat = await fs.lstat(lockFile);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      fail(`morning-chain lock is unreadable: ${error?.code || error?.message || error}`, {
        code: 'MORNING_CHAIN_RECOVERY_LOCK_UNSAFE',
        detail: {lockFile},
      });
    }
  }
  if (!stat) {
    const handle = await fs.open(lockFile, 'a', 0o660);
    await handle.close();
    stat = await fs.lstat(lockFile);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail('morning-chain lock must be a regular non-symlink file', {
      code: 'MORNING_CHAIN_RECOVERY_LOCK_UNSAFE',
      detail: {lockFile},
    });
  }
}

async function withFlock(lockFile, callback) {
  const resolvedLockFile = path.resolve(lockFile);
  if (resolvedLockFile === path.parse(resolvedLockFile).root) {
    fail('morning-chain lock path must not be the filesystem root', {code: 'MORNING_CHAIN_RECOVERY_LOCK_UNSAFE'});
  }
  await ensureFlockFile(resolvedLockFile);
  const sharedLockHelper = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib', 'shared_lock.sh');
  const holder = spawn('bash', [
    '-c',
    [
      'set -Eeuo pipefail',
      'source "$1"',
      'prepare_shared_lock_file "$2"',
      'exec 8>"$2"',
      'flock -n 8',
      `printf '%s\\n' '${LOCK_READY_LINE}'`,
      'IFS= read -r _',
    ].join('\n'),
    'bash',
    sharedLockHelper,
    resolvedLockFile,
  ], {stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
  let stdout = '';
  let stderr = '';
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const readyTimer = setTimeout(() => readyReject(new MorningChainRecoveryError(
    'timed out acquiring the morning-chain lock',
    {code: 'MORNING_CHAIN_RECOVERY_LOCK_TIMEOUT', exitCode: 75, detail: {lockFile: resolvedLockFile}},
  )), 5_000);
  readyTimer.unref?.();
  holder.stdout.on('data', chunk => {
    stdout += String(chunk);
    if (stdout.includes(LOCK_READY_LINE)) readyResolve();
  });
  holder.stderr.on('data', chunk => { stderr += String(chunk); });
  holder.once('error', error => readyReject(new MorningChainRecoveryError(
    `could not run flock for the morning-chain lock: ${error?.message || error}`,
    {code: 'MORNING_CHAIN_RECOVERY_LOCK_UNAVAILABLE', exitCode: 75, detail: {lockFile: resolvedLockFile}},
  )));
  holder.once('exit', (code, signal) => {
    if (!stdout.includes(LOCK_READY_LINE)) {
      readyReject(new MorningChainRecoveryError(
        'another coordinator owns the morning-chain lock',
        {code: 'MORNING_CHAIN_RECOVERY_LOCK_CONFLICT', exitCode: 75, detail: {lockFile: resolvedLockFile, code, signal, stderr: stderr.slice(0, 500)}},
      ));
    }
  });
  try {
    await ready;
    return await callback();
  } finally {
    clearTimeout(readyTimer);
    try { holder.stdin.write('\n'); } catch {}
    try { holder.stdin.end(); } catch {}
    await new Promise(resolve => {
      if (holder.exitCode !== null || holder.signalCode !== null) return resolve();
      holder.once('exit', resolve);
      setTimeout(() => {
        try { holder.kill('SIGTERM'); } catch {}
        resolve();
      }, 2_000).unref?.();
    });
  }
}

function defaultLockPath(stateRoot) {
  return process.env.SHEIN_BI_MORNING_WRAPPER_LOCK_FILE
    || path.join(stateRoot, 'locks', 'shein-bi-cloud-morning-chain.lock');
}

async function readFreshEvidence(paths) {
  const active = await readJson(paths.activeFile, 'active context', {required: false});
  const latest = await readJson(paths.latestFile, 'morning latest state');
  const terminalDeadlineAlert = await readJson(paths.terminalDeadlineAlertFile, 'terminal deadline alert', {required: false});
  const morningAllMarker = await readJson(paths.morningAllMarkerFile, 'morning-all marker', {required: false});
  const dailyOperatingRefresh = await readJson(paths.dailyOperatingRefreshMarker, 'daily-operating-refresh marker', {required: false});
  const inventoryStarted = await readJson(paths.inventoryStartedMarker, 'inventory-started marker', {required: false});
  const stockRefresh = await readJson(paths.stockRefreshMarkerFile, 'stock-refresh marker', {required: false});
  const metricRefetch = await readJson(paths.metricRefetchStateFile, 'nested metric refetch state', {required: false});
  const dailyInventoryGuard = await readJson(paths.dailyInventoryGuardMarker, 'daily-inventory-guard marker', {required: false});
  const receipt = await readJson(paths.receiptFile, 'recovery receipt', {required: false});
  return {active, latest, terminalDeadlineAlert, morningAllMarker, dailyOperatingRefresh, inventoryStarted, stockRefresh, metricRefetch, dailyInventoryGuard, receipt};
}

function assertRequestedDeadline({runDate, nowEpoch, oldDeadlineEpoch, newDeadlineEpoch}) {
  if (oldDeadlineEpoch >= nowEpoch) {
    fail('active context deadline has not expired', {
      code: 'MORNING_CHAIN_RECOVERY_DEADLINE_NOT_EXPIRED',
      detail: {oldDeadlineEpoch, nowEpoch},
    });
  }
  if (newDeadlineEpoch <= nowEpoch) {
    fail('new deadline must be in the future', {
      code: 'MORNING_CHAIN_RECOVERY_DEADLINE_NOT_FUTURE',
      detail: {newDeadlineEpoch, nowEpoch},
    });
  }
  const dayEnd = cstEpoch(runDate, 23, 30);
  if (newDeadlineEpoch > dayEnd) {
    fail('new deadline must not exceed 23:30 CST on runDate', {
      code: 'MORNING_CHAIN_RECOVERY_DEADLINE_OUT_OF_DAY',
      detail: {newDeadlineEpoch, dayEnd, runDate},
    });
  }
  if (newDeadlineEpoch - nowEpoch > MORNING_CHAIN_RECOVERY_MAX_BUDGET_SEC) {
    fail('new deadline exceeds the three-hour recovery budget', {
      code: 'MORNING_CHAIN_RECOVERY_DEADLINE_BUDGET_EXCEEDED',
      detail: {newDeadlineEpoch, nowEpoch, maxBudgetSec: MORNING_CHAIN_RECOVERY_MAX_BUDGET_SEC},
    });
  }
}

function buildReceipt({runDate, businessDate, oldDeadlineEpoch, newDeadlineEpoch, beforeHash, createdAt, reason}) {
  const body = {
    schemaVersion: MORNING_CHAIN_RECOVERY_SCHEMA_VERSION,
    recoveryGeneration: 1,
    runDate,
    businessDate,
    beforeHash,
    oldDeadlineEpoch,
    newDeadlineEpoch,
    createdAt,
    reason,
  };
  return {...body, canonicalHash: sha256(canonicalJson(body))};
}

function publicResult({status, paths, receipt, oldDeadlineEpoch, newDeadlineEpoch, beforeHash}) {
  return {
    ok: true,
    status,
    runDate: receipt.runDate,
    businessDate: receipt.businessDate,
    oldDeadlineEpoch,
    newDeadlineEpoch,
    beforeHash,
    canonicalHash: receipt.canonicalHash,
    recoveryGeneration: receipt.recoveryGeneration,
    receiptFile: paths.receiptFile,
    activeFile: paths.activeFile,
  };
}

export async function authorizeCloudMorningChainRecovery({
  runDate,
  newDeadlineEpoch,
  reason,
  confirm,
  stateRoot = defaultStateRoot(),
  inventoryRuntimeRoot = defaultInventoryRuntimeRoot(),
  maintenanceFile = process.env.SHEIN_BI_MAINTENANCE_FILE || DEFAULT_CLOUD_MAINTENANCE_FILE,
  lockPath,
  systemctlBin = process.env.SHEIN_BI_SYSTEMCTL_BIN || 'systemctl',
  now = () => Math.floor(Date.now() / 1_000),
  systemctlRunner = defaultSystemctlRunner,
  maintenanceStatusReader = readCloudMaintenanceStatus,
  withExclusiveLock = withFlock,
  writeJsonFileAtomic = publishJsonFileAtomic,
} = {}) {
  if (String(confirm || '') !== MORNING_CHAIN_RECOVERY_CONFIRMATION) {
    fail(`exact --confirm ${MORNING_CHAIN_RECOVERY_CONFIRMATION} is required`, {
      code: 'MORNING_CHAIN_RECOVERY_CONFIRMATION_REQUIRED',
    });
  }
  const normalizedRunDate = normalizeDate(runDate, 'runDate');
  const normalizedDeadline = normalizeEpoch(newDeadlineEpoch, 'new-deadline-epoch');
  const normalizedReason = normalizeReason(reason);
  const normalizedStateRoot = normalizeStateRoot(stateRoot);
  const normalizedRuntimeRoot = path.resolve(String(inventoryRuntimeRoot || '').trim());
  const normalizedLockPath = path.resolve(lockPath || defaultLockPath(normalizedStateRoot));
  const paths = pathsFor({
    stateRoot: normalizedStateRoot,
    inventoryRuntimeRoot: normalizedRuntimeRoot,
    runDate: normalizedRunDate,
  });

  return withExclusiveLock(normalizedLockPath, async () => {
    const nowEpoch = resolveNow(now);
    const today = cstDateKey(nowEpoch);
    const expectedBusinessDate = previousDate(normalizedRunDate);
    if (normalizedRunDate !== today) {
      fail('runDate must equal today in Asia/Shanghai', {
        code: 'MORNING_CHAIN_RECOVERY_RUN_DATE_NOT_TODAY',
        detail: {runDate: normalizedRunDate, today},
      });
    }

    const maintenance = await maintenanceStatusReader(maintenanceFile);
    if (!maintenance || maintenance.ok !== true || maintenance.active !== false) {
      fail('cloud maintenance must be valid and inactive', {
        code: 'MORNING_CHAIN_RECOVERY_MAINTENANCE_ACTIVE',
        detail: {
          ok: maintenance?.ok,
          active: maintenance?.active,
          mode: maintenance?.mode,
          errorCode: maintenance?.errorCode,
        },
      });
    }

    const morningService = await checkSystemdUnit(MORNING_CHAIN_RECOVERY_SERVICE, {systemctlBin, systemctlRunner});
    await checkSystemdUnit(MORNING_CHAIN_RECOVERY_TIMER, {systemctlBin, systemctlRunner});

    // All state below is read only after the exclusive lock is held.  No
    // pre-lock snapshot is trusted for either the preflight or the write.
    const evidence = await readFreshEvidence(paths);
    let active = null;
    let oldDeadlineEpoch;
    let activeBeforeHash;
    let publishMetadata;
    let businessDate;
    if (evidence.active) {
      active = validateActiveObject(evidence.active.value, paths.activeFile);
      activeBeforeHash = evidence.active.hash;
      publishMetadata = publishMetadataFromEvidence(evidence.active, 'active context');
      businessDate = String(active.businessDate);
      oldDeadlineEpoch = active.deadlineEpoch;
      if (active.runDate !== normalizedRunDate) {
        fail('active context runDate does not match today/request', {
          code: 'MORNING_CHAIN_RECOVERY_RUN_DATE_MISMATCH',
          detail: {activeRunDate: active.runDate, runDate: normalizedRunDate},
        });
      }
    } else {
      const rebuild = assertSameDayTerminalRebuildEvidence({
        terminalDeadlineAlert: evidence.terminalDeadlineAlert,
        morningAllMarker: evidence.morningAllMarker,
        runDate: normalizedRunDate,
        businessDate: expectedBusinessDate,
      });
      businessDate = expectedBusinessDate;
      oldDeadlineEpoch = rebuild.oldDeadlineEpoch;
      activeBeforeHash = rebuildEvidenceHash(evidence);
      publishMetadata = await publishMetadataForCreatedActive(path.dirname(paths.activeFile));
    }
    if (businessDate !== expectedBusinessDate) {
      fail('active context businessDate must equal runDate minus one day', {
        code: 'MORNING_CHAIN_RECOVERY_BUSINESS_DATE_MISMATCH',
        detail: {activeBusinessDate: businessDate, expectedBusinessDate},
      });
    }

    const nestedMetric = await inspectNestedMetricRefetchState({
      metricRefetch: evidence.metricRefetch,
      runDate: normalizedRunDate,
      businessDate,
      nowEpoch,
      newDeadlineEpoch: normalizedDeadline,
    });

    const existingReceipt = evidence.receipt
      ? validateReceiptShape(evidence.receipt.value, paths.receiptFile)
      : null;
    if (existingReceipt && !receiptMatchesRequest(existingReceipt, {
      runDate: normalizedRunDate,
      businessDate,
      newDeadlineEpoch: normalizedDeadline,
      reason: normalizedReason,
    })) {
      fail('an existing recovery receipt binds a different exact authorization; deadline/reason cannot be changed', {
        code: 'MORNING_CHAIN_RECOVERY_RECEIPT_CONFLICT',
        detail: {
          existingRunDate: existingReceipt.runDate,
          existingBusinessDate: existingReceipt.businessDate,
          existingNewDeadlineEpoch: existingReceipt.newDeadlineEpoch,
          requestedNewDeadlineEpoch: normalizedDeadline,
        },
      });
    }

    const alreadyBound = Boolean(active && (active.receiptHash || active.recoveryGeneration || active.previousDeadline !== undefined));
    if (active && existingReceipt && active.receiptHash === existingReceipt.canonicalHash) {
      assertActiveBoundToReceipt(active, existingReceipt, paths.activeFile);
      assertRequestedDeadline({
        runDate: normalizedRunDate,
        nowEpoch: Math.min(nowEpoch, existingReceipt.newDeadlineEpoch - 1),
        oldDeadlineEpoch: existingReceipt.oldDeadlineEpoch,
        newDeadlineEpoch: existingReceipt.newDeadlineEpoch,
      });
      assertLatestIsPreInventoryFailure(evidence.latest.value, normalizedRunDate, businessDate, {
        allowWaiting: Boolean(nestedMetric),
        interruptedService: morningService,
      });
      assertMarkerNotDone(evidence.dailyOperatingRefresh, 'daily-operating-refresh marker');
      assertRecoveryCheckpoint({
        inventoryStarted: evidence.inventoryStarted,
        stockRefresh: evidence.stockRefresh,
        runDate: normalizedRunDate,
        businessDate,
      });
      if (evidence.dailyInventoryGuard) {
        fail('daily-inventory-guard marker already exists; recovery refuses replay', {
          code: 'MORNING_CHAIN_RECOVERY_EVIDENCE_EXISTS',
          detail: {file: paths.dailyInventoryGuardMarker},
        });
      }
      await assertAbsent(paths.inventoryPlanFile, 'same-day inventory plan');
      await assertAbsent(paths.inventoryResultFile, 'same-day inventory result');
      await assertAbsent(paths.inventoryJournalFile, 'same-day current inventory journal');
      if (nestedMetric) {
        await applyOrVerifyNestedMetricRefetch({
          nestedMetric,
          receipt: existingReceipt,
          paths,
          writeJsonFileAtomic,
          writeOptions: publishMetadata.writeOptions,
        });
      }
      return publicResult({
        status: 'already-authorized',
        paths,
        receipt: existingReceipt,
        oldDeadlineEpoch: existingReceipt.oldDeadlineEpoch,
        newDeadlineEpoch: existingReceipt.newDeadlineEpoch,
        beforeHash: existingReceipt.beforeHash,
      });
    }
    if (!active && existingReceipt) {
      if (!existingReceipt || existingReceipt.oldDeadlineEpoch !== oldDeadlineEpoch
        || existingReceipt.beforeHash !== activeBeforeHash) {
        fail('recovery receipt is missing or does not bind the exact structured terminal evidence', {
          code: 'MORNING_CHAIN_RECOVERY_DRIFT',
          detail: {receiptFile: paths.receiptFile},
        });
      }
      assertRequestedDeadline({
        runDate: normalizedRunDate,
        nowEpoch: Math.min(nowEpoch, existingReceipt.newDeadlineEpoch - 1),
        oldDeadlineEpoch: existingReceipt.oldDeadlineEpoch,
        newDeadlineEpoch: existingReceipt.newDeadlineEpoch,
      });
      assertLatestIsPreInventoryFailure(evidence.latest.value, normalizedRunDate, businessDate, {
        interruptedService: morningService,
      });
      assertMarkerNotDone(evidence.dailyOperatingRefresh, 'daily-operating-refresh marker');
      assertRecoveryCheckpoint({
        inventoryStarted: evidence.inventoryStarted,
        stockRefresh: evidence.stockRefresh,
        runDate: normalizedRunDate,
        businessDate,
      });
      if (evidence.dailyInventoryGuard) {
        fail('daily-inventory-guard marker already exists; recovery refuses replay', {
          code: 'MORNING_CHAIN_RECOVERY_EVIDENCE_EXISTS',
          detail: {file: paths.dailyInventoryGuardMarker},
        });
      }
      await assertAbsent(paths.inventoryPlanFile, 'same-day inventory plan');
      await assertAbsent(paths.inventoryResultFile, 'same-day inventory result');
      await assertAbsent(paths.inventoryJournalFile, 'same-day current inventory journal');
      if (nestedMetric) {
        await applyOrVerifyNestedMetricRefetch({
          nestedMetric,
          receipt: existingReceipt,
          paths,
          writeJsonFileAtomic,
          writeOptions: publishMetadata.writeOptions,
        });
      }
      const rebuiltActive = {
        runDate: normalizedRunDate,
        businessDate,
        deadlineEpoch: existingReceipt.newDeadlineEpoch,
        previousDeadline: existingReceipt.oldDeadlineEpoch,
        recoveryGeneration: existingReceipt.recoveryGeneration,
        receiptHash: existingReceipt.canonicalHash,
        updatedAt: existingReceipt.createdAt,
      };
      await writeJsonFileAtomic(paths.activeFile, rebuiltActive, publishMetadata.writeOptions);
      const committedActiveEvidence = await readJson(paths.activeFile, 'published active context');
      assertPublishedMetadata(committedActiveEvidence, publishMetadata.expected, 'published active context');
      const committedActive = validateActiveObject(committedActiveEvidence.value, paths.activeFile);
      assertActiveBoundToReceipt(committedActive, existingReceipt, paths.activeFile);
      return publicResult({
        status: 'already-authorized',
        paths,
        receipt: existingReceipt,
        oldDeadlineEpoch: existingReceipt.oldDeadlineEpoch,
        newDeadlineEpoch: existingReceipt.newDeadlineEpoch,
        beforeHash: existingReceipt.beforeHash,
      });
    }
    if (alreadyBound || (existingReceipt && activeBeforeHash !== existingReceipt.beforeHash)) {
      fail('active context or recovery receipt drifted; refusing to overwrite it', {
        code: 'MORNING_CHAIN_RECOVERY_DRIFT',
        detail: {activeFile: paths.activeFile, receiptFile: paths.receiptFile},
      });
    }

    assertRequestedDeadline({
      runDate: normalizedRunDate,
      nowEpoch,
      oldDeadlineEpoch,
      newDeadlineEpoch: normalizedDeadline,
    });
    assertLatestIsPreInventoryFailure(evidence.latest.value, normalizedRunDate, businessDate, {
      interruptedService: morningService,
    });
    assertMarkerNotDone(evidence.dailyOperatingRefresh, 'daily-operating-refresh marker');
    assertRecoveryCheckpoint({
      inventoryStarted: evidence.inventoryStarted,
      stockRefresh: evidence.stockRefresh,
      runDate: normalizedRunDate,
      businessDate,
    });
    if (evidence.dailyInventoryGuard) {
      fail('daily-inventory-guard marker already exists; recovery refuses replay', {
        code: 'MORNING_CHAIN_RECOVERY_EVIDENCE_EXISTS',
        detail: {file: paths.dailyInventoryGuardMarker},
      });
    }
    await assertAbsent(paths.inventoryPlanFile, 'same-day inventory plan');
    await assertAbsent(paths.inventoryResultFile, 'same-day inventory result');
    await assertAbsent(paths.inventoryJournalFile, 'same-day current inventory journal');

    let createdAt = new Date(nowEpoch * 1_000).toISOString();
    if (nestedMetric) {
      createdAt = String(nestedMetric.state.updatedAt || '');
      if (!createdAt || Number.isNaN(Date.parse(createdAt))) {
        fail('nested metric state has no deterministic recovery timestamp', {
          code: 'MORNING_CHAIN_RECOVERY_NESTED_METRIC_STATE_INVALID',
          detail: {file: paths.metricRefetchStateFile},
        });
      }
    }
    const receipt = existingReceipt || buildReceipt({
      runDate: normalizedRunDate,
      businessDate,
      oldDeadlineEpoch,
      newDeadlineEpoch: normalizedDeadline,
      beforeHash: activeBeforeHash,
      createdAt,
      reason: normalizedReason,
    });
    validateReceiptShape(receipt, paths.receiptFile);
    if (receipt.oldDeadlineEpoch !== oldDeadlineEpoch || receipt.beforeHash !== activeBeforeHash) {
      fail('recovery receipt does not match the freshly locked active context', {
        code: 'MORNING_CHAIN_RECOVERY_DRIFT',
        detail: {activeBeforeHash, receiptBeforeHash: receipt.beforeHash},
      });
    }

    // With nested metric state, publish it first so a crash before receipt
    // is a deterministic retry bound to the same receipt timestamp.  Without
    // it, preserve the original receipt-first crash-continuation order.
    await applyOrVerifyNestedMetricRefetch({
      nestedMetric,
      receipt,
      paths,
      writeJsonFileAtomic,
      writeOptions: publishMetadata.writeOptions,
    });
    if (!existingReceipt) {
      await writeJsonFileAtomic(paths.receiptFile, receipt, publishMetadata.writeOptions);
    }
    const updatedActive = {
      ...(active || {runDate: normalizedRunDate, businessDate}),
      deadlineEpoch: receipt.newDeadlineEpoch,
      previousDeadline: receipt.oldDeadlineEpoch,
      recoveryGeneration: receipt.recoveryGeneration,
      receiptHash: receipt.canonicalHash,
      updatedAt: receipt.createdAt,
    };
    await writeJsonFileAtomic(paths.activeFile, updatedActive, publishMetadata.writeOptions);

    const committedReceiptEvidence = await readJson(paths.receiptFile, 'published recovery receipt');
    const committedActiveEvidence = await readJson(paths.activeFile, 'published active context');
    assertPublishedMetadata(committedReceiptEvidence, publishMetadata.expected, 'published recovery receipt');
    assertPublishedMetadata(committedActiveEvidence, publishMetadata.expected, 'published active context');
    const committedReceipt = validateReceiptShape(
      committedReceiptEvidence.value,
      paths.receiptFile,
    );
    const committedActive = validateActiveObject(
      committedActiveEvidence.value,
      paths.activeFile,
    );
    assertActiveBoundToReceipt(committedActive, committedReceipt, paths.activeFile);
    if (nestedMetric) {
      const committedMetricEvidence = await readJson(paths.metricRefetchStateFile, 'published nested metric state');
      assertNestedMetricRefetchBound(committedMetricEvidence.value, committedReceipt, paths.metricRefetchStateFile);
    }
    if (committedReceipt.canonicalHash !== receipt.canonicalHash
      || committedReceipt.beforeHash !== activeBeforeHash) {
      fail('published recovery receipt readback drifted', {
        code: 'MORNING_CHAIN_RECOVERY_READBACK_DRIFT',
        detail: {receiptFile: paths.receiptFile},
      });
    }
    return publicResult({
      status: 'authorized',
      paths,
      receipt: committedReceipt,
      oldDeadlineEpoch: committedReceipt.oldDeadlineEpoch,
      newDeadlineEpoch: committedReceipt.newDeadlineEpoch,
      beforeHash: committedReceipt.beforeHash,
    });
  });
}

function usage() {
  return ['Usage:', '  node scripts/authorize_cloud_morning_chain_recovery.mjs', '    --run-date YYYY-MM-DD', '    --new-deadline-epoch EPOCH', '    --reason TEXT', `    --confirm ${MORNING_CHAIN_RECOVERY_CONFIRMATION}`].join('\n');
}

function parseArgs(argv) {
  const args = {runDate: '', newDeadlineEpoch: '', reason: '', confirm: ''};
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!['--run-date', '--new-deadline-epoch', '--reason', '--confirm'].includes(option)) {
      fail(`${usage()}\nunknown argument: ${option}`, {code: 'MORNING_CHAIN_RECOVERY_USAGE'});
    }
    if (seen.has(option)) fail(`duplicate argument: ${option}`, {code: 'MORNING_CHAIN_RECOVERY_USAGE'});
    seen.add(option);
    index += 1;
    if (index >= argv.length) fail(`${option} requires a value`, {code: 'MORNING_CHAIN_RECOVERY_USAGE'});
    const value = argv[index];
    if (option === '--run-date') args.runDate = value;
    else if (option === '--new-deadline-epoch') args.newDeadlineEpoch = value;
    else if (option === '--reason') args.reason = value;
    else args.confirm = value;
  }
  for (const key of ['runDate', 'newDeadlineEpoch', 'reason', 'confirm']) {
    if (!String(args[key] || '').trim()) fail(`${usage()}\nmissing ${key}`, {code: 'MORNING_CHAIN_RECOVERY_USAGE'});
  }
  return args;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const result = await authorizeCloudMorningChainRecovery(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: String(error?.code || 'MORNING_CHAIN_RECOVERY_FAILED'),
      error: String(error?.message || error),
      detail: error?.detail || {},
    })}\n`);
    process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
  }
}
