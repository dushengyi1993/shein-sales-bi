#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {
  DEFAULT_CLOUD_MAINTENANCE_FILE,
  maintenanceBlocksClass,
  readCloudMaintenanceStatus,
} from '../lib/cloud_maintenance_mode.mjs';
import {
  assessDailyLinkBusinessRecovery,
  assessDailyMarketingGuardHealth,
  assessDailyMarketingRepairHealth,
  assessDailyMarketingScanRecovery,
  assessDailyOpenapiSalesRecovery,
  assessDailyOpenapiProductRecovery,
  assessDailyProfitSectionRecovery,
  assessSystemdOneshotResult,
  resolveMarketingScanEvidencePath,
} from '../lib/cloud_watchdog_recovery.mjs';
import {
  collapseWatchdogRootCauseIssues,
  prepareWatchdogNotificationIssues,
} from '../lib/cloud_watchdog_issue_collapse.mjs';
import {assessSessionManagerManualRecovery} from '../lib/cloud_manual_login_recovery.mjs';
import {
  inspectRecordedDeploymentReleaseEvidence,
  inspectReleaseSourceState,
} from './check_release_source_state.mjs';
import {auditCloudMaintenanceGuards} from './manage_cloud_maintenance_mode.mjs';
import {validateDailyOperatingRefresh} from './validate_daily_operating_refresh.mjs';
import {
  CLOUD_ALWAYS_RUNNING_UNITS,
  CLOUD_AUXILIARY_UNITS,
  CLOUD_MAINTENANCE_POLICY_BY_SERVICE,
  CLOUD_RUNTIME_SNAPSHOT_UNITS,
  CLOUD_SERVICE_UNITS,
  CLOUD_TIMER_MAINTENANCE_POLICY,
  CLOUD_TIMER_UNITS,
} from '../lib/cloud_runtime_inventory.mjs';
import {collectSystemdUnitSnapshot} from '../lib/systemd_unit_snapshot.mjs';
import {validateCloudRuntimeEffectiveControls} from '../lib/cloud_runtime_snapshot.mjs';
import {validateDeployedReleaseMarker} from '../lib/source_release_attestation.mjs';
import {
  applyWatchdogAlertState,
  markWatchdogDispatchAttempt,
  markWatchdogDispatchSent,
  migrateLegacyWatchdogState,
  pendingWatchdogDispatches,
  prepareWatchdogDispatches,
} from '../lib/cloud_watchdog_alert_state.mjs';
import {acquireCrossProcessTicketLock} from '../lib/cross_process_ticket_lock.mjs';
import {writeJsonFileAtomic} from '../lib/atomic_file_publish.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_STATE_DIR = path.join(ROOT, 'state', 'cloud_ops_watchdog');
const DEFAULT_LOG_DIR = process.env.SHEIN_CLOUD_WATCHDOG_LOG_DIR || '/srv/shein-bi/logs/cloud-watchdog';
const UNIT_NAMES = CLOUD_SERVICE_UNITS;
const ALWAYS_RUNNING_UNITS = new Set(CLOUD_ALWAYS_RUNNING_UNITS);
const TIMER_NAMES = CLOUD_TIMER_UNITS;
const WATCHDOG_MAINTENANCE_STATE_SCHEMA = 'cloud-watchdog-maintenance-state/v1';
const VALID_MAINTENANCE_CLASSES = new Set(['scheduled', 'infrastructure', 'always']);

// Cross-process single-instance lock.  The ticket queue lives inside
// args.stateDir so concurrent duplicate runs cannot touch each other's
// maintenance state, alert state, legacy marker, or watchdog logs.  A
// duplicate that cannot acquire within the short timeout reports an explicit
// skipped/already-running success without doing any watchdog work.
const SINGLE_INSTANCE_LOCK_FILE = 'cloud-ops-watchdog.single-instance.lock';
const SINGLE_INSTANCE_LOCK_TIMEOUT_MS = 5_000;
const SINGLE_INSTANCE_ALREADY_RUNNING_CODE = 'WATCHDOG_ALREADY_RUNNING';

// Source-integrity verdict for the deployment provenance check. Any dirty
// tracked edit, hidden index entry (skip-worktree/assume-unchanged), missing
// tracked file, or commit drift must fail closed as an issue; a clean state
// returns null. The raw fields are checked independently so a stale truthy
// `ok` flag can never produce a false green. This verdict is intentionally
// NOT routed through maintenance suppression: infrastructure source drift
// must never become a silent ops-group note.
export function sourceIntegrityIssueFor(state = {}) {
  const dirty = Number.isInteger(state.dirtyEntries?.length) ? state.dirtyEntries.length : 0;
  const hidden = Number.isInteger(state.hiddenIndexEntries?.length) ? state.hiddenIndexEntries.length : 0;
  const missing = Number.isInteger(state.missingTrackedFiles?.length) ? state.missingTrackedFiles.length : 0;
  const commitClean = state.commitMatches === true;
  const broken = state.ok === false || !commitClean || dirty > 0 || hidden > 0 || missing > 0;
  if (!broken) return null;
  return `云端源码不一致：commitMatch=${state.commitMatches ?? 'unknown'} dirty=${dirty} hidden=${hidden} missing=${missing}`;
}

export function summarizeWatchdogMaintenanceStatus(status) {
  const valid = status?.ok === true;
  return {
    schemaVersion: String(status?.schemaVersion || 'cloud-maintenance-mode/v1'),
    ok: valid,
    valid,
    exists: status?.exists === true,
    active: valid ? status.active === true : null,
    mode: valid ? String(status.mode || 'none') : 'unknown',
    generation: valid && Number.isSafeInteger(status.generation) ? status.generation : null,
    hash: String(status?.hash || ''),
    markerFile: String(status?.markerFile || ''),
    errorCode: valid ? '' : String(status?.errorCode || 'MAINTENANCE_MARKER_INVALID'),
  };
}

export function watchdogMaintenanceBlocksClass(maintenance, unitClass) {
  const normalizedClass = String(unitClass || '').trim().toLowerCase();
  if (!VALID_MAINTENANCE_CLASSES.has(normalizedClass)) return null;
  const status = maintenance?.valid === undefined
    ? maintenance
    : {
        ok: maintenance.valid === true,
        active: maintenance.active,
        mode: maintenance.mode,
      };
  return maintenanceBlocksClass(status, normalizedClass);
}

export function partitionWatchdogMaintenanceChecks(maintenance, checks = []) {
  const runnable = [];
  const suppressed = [];
  const policyErrors = [];
  for (const rawCheck of checks) {
    const check = rawCheck && typeof rawCheck === 'object' ? rawCheck : {};
    const id = String(check.id || '').trim() || 'unnamed-check';
    const unitClass = String(check.unitClass || '').trim().toLowerCase();
    const blocked = watchdogMaintenanceBlocksClass(maintenance, unitClass);
    if (blocked === null) {
      policyErrors.push({id, unitClass: unitClass || 'missing'});
      suppressed.push({
        id,
        class: unitClass || 'missing',
        kind: String(check.kind || 'check'),
        unit: String(check.unit || ''),
        reason: 'maintenance_policy_invalid_fail_closed',
      });
    } else if (blocked) {
      suppressed.push({
        id,
        class: unitClass,
        kind: String(check.kind || 'check'),
        unit: String(check.unit || ''),
        reason: maintenance?.valid === false
          ? 'maintenance_marker_invalid_fail_closed'
          : `maintenance_${maintenance?.mode || 'unknown'}_blocked`,
      });
    } else {
      runnable.push(check);
    }
  }
  return {runnable, suppressed, policyErrors};
}

export function watchdogMaintenanceConfigurationIssue(maintenance, policyErrors = []) {
  if (maintenance?.valid !== false && !policyErrors.length) return '';
  const markerError = maintenance?.valid === false
    ? `marker=${maintenance.errorCode || 'invalid'} generation=${maintenance.generation ?? '-'} hash=${maintenance.hash || '-'}`
    : 'marker=valid';
  const policyDetail = policyErrors.length
    ? ` policy=${policyErrors.map(row => `${row.id}:${row.unitClass}`).join(',')}`
    : '';
  return `维护模式配置故障（高优先级）：${markerError}${policyDetail}；scheduled/infrastructure 检查已 fail closed，always 与源码完整性继续检查`;
}

function maintenanceEpisodeKey(maintenance) {
  return `generation=${maintenance.generation ?? '-'};hash=${maintenance.hash || '-'}`;
}

function emptyWatchdogMaintenanceState(nowIso) {
  return {
    schemaVersion: WATCHDOG_MAINTENANCE_STATE_SCHEMA,
    updatedAt: nowIso,
    lastObserved: null,
    activeEpisode: null,
    pendingRecovery: null,
    lastRecoveryKey: '',
  };
}

export function applyWatchdogMaintenanceTransition({previousState, maintenance, now = new Date()} = {}) {
  const nowIso = new Date(now).toISOString();
  const previous = previousState?.schemaVersion === WATCHDOG_MAINTENANCE_STATE_SCHEMA
    ? structuredClone(previousState)
    : emptyWatchdogMaintenanceState(nowIso);
  const nextState = {
    ...previous,
    schemaVersion: WATCHDOG_MAINTENANCE_STATE_SCHEMA,
    updatedAt: nowIso,
    lastObserved: {
      valid: maintenance?.valid === true,
      active: maintenance?.active ?? null,
      mode: String(maintenance?.mode || 'unknown'),
      generation: maintenance?.generation ?? null,
      hash: String(maintenance?.hash || ''),
      observedAt: nowIso,
    },
  };
  let recoveryCreated = null;
  if (maintenance?.valid === true && maintenance.active === true) {
    if (nextState.pendingRecovery) {
      nextState.lastRecoveryKey = nextState.pendingRecovery.key;
      nextState.lastRecoveryCancelledAt = nowIso;
      nextState.pendingRecovery = null;
    }
    const key = maintenanceEpisodeKey(maintenance);
    if (nextState.activeEpisode?.key !== key) {
      nextState.activeEpisode = {
        key,
        mode: maintenance.mode,
        generation: maintenance.generation,
        hash: maintenance.hash,
        firstObservedAt: nowIso,
      };
    }
  } else if (maintenance?.valid === true && maintenance.active === false) {
    const prior = nextState.activeEpisode;
    if (prior
      && nextState.lastRecoveryKey !== prior.key
      && nextState.pendingRecovery?.key !== prior.key) {
      recoveryCreated = {
        key: prior.key,
        idempotencyKey: `cloud-watchdog-maintenance-recovery-${prior.generation}-${prior.hash}`,
        status: 'pending',
        attemptCount: 0,
        createdAt: nowIso,
        from: {
          mode: prior.mode,
          generation: prior.generation,
          hash: prior.hash,
        },
        to: {
          mode: maintenance.mode,
          generation: maintenance.generation,
          hash: maintenance.hash,
        },
      };
      nextState.pendingRecovery = recoveryCreated;
    }
    nextState.activeEpisode = null;
  }
  return {
    nextState,
    recoveryCreated,
    pendingRecovery: nextState.pendingRecovery || null,
  };
}

export function markWatchdogMaintenanceRecoverySent(state, key, sentAt = new Date()) {
  const next = structuredClone(state);
  if (next.pendingRecovery?.key !== key) return next;
  next.lastRecoveryKey = key;
  next.lastRecoveryAt = new Date(sentAt).toISOString();
  next.pendingRecovery = null;
  next.updatedAt = next.lastRecoveryAt;
  return next;
}

export function markWatchdogMaintenanceRecoveryAttempt(state, key, attemptedAt = new Date()) {
  const next = structuredClone(state);
  if (next.pendingRecovery?.key !== key) return next;
  next.pendingRecovery.attemptCount = Number(next.pendingRecovery.attemptCount || 0) + 1;
  next.pendingRecovery.lastAttemptAt = new Date(attemptedAt).toISOString();
  next.updatedAt = next.pendingRecovery.lastAttemptAt;
  return next;
}

export function bindWatchdogMaintenanceRecoveryDelivery(state, key, idempotencyKey, boundAt = new Date()) {
  const next = structuredClone(state);
  if (next.pendingRecovery?.key !== key) return next;
  const deliveryKey = String(idempotencyKey || '').trim();
  if (!deliveryKey) throw new Error('maintenance recovery delivery idempotency key is required');
  const existing = String(next.pendingRecovery.deliveryIdempotencyKey || '').trim();
  if (existing && existing !== deliveryKey) {
    throw new Error('maintenance recovery delivery idempotency key drifted');
  }
  next.pendingRecovery.deliveryIdempotencyKey = deliveryKey;
  next.pendingRecovery.deliveryBoundAt ||= new Date(boundAt).toISOString();
  next.updatedAt = new Date(boundAt).toISOString();
  return next;
}

export function mergeMaintenanceRecoveryNotification(issues, maintenanceRecovery) {
  const rows = Array.isArray(issues) ? issues.map(value => String(value)).filter(Boolean) : [];
  if (!maintenanceRecovery) return {issues: rows, coalesced: false};
  return {
    issues: [
      ...rows,
      `云端维护模式已恢复：mode=${maintenanceRecovery.from.mode} generation=${maintenanceRecovery.from.generation} hash=${maintenanceRecovery.from.hash}`,
    ],
    coalesced: true,
  };
}

export function watchdogIssueMaintenanceClass(issue) {
  const raw = String(issue || '').trim();
  const service = /^(?:服务异常|常驻服务未运行)：(\S+)/.exec(raw)?.[1] || '';
  if (service) return CLOUD_MAINTENANCE_POLICY_BY_SERVICE[service] || 'unknown';
  const timer = /^定时器未运行：(\S+)/.exec(raw)?.[1] || '';
  if (timer) return CLOUD_TIMER_MAINTENANCE_POLICY[timer] || 'unknown';
  if (/^服务器硬盘(?:检查失败|即将写满|快满了|空间偏紧)/.test(raw)) return 'infrastructure';
  if (/^生产部署证明/.test(raw)) return 'infrastructure';
  if (/^(?:云端源码|维护模式配置故障|systemd 批量快照不完整|BI 数据文件不可读|BI 实时运行状态不可读|BI 实时更新通道未连接)/.test(raw)) return 'always';
  return 'scheduled';
}

export function detachMaintenanceHeldAlertState(state, maintenance) {
  const activeState = structuredClone(state);
  const held = {episodes: {}, outbox: {}};
  const heldFamilies = new Set();
  for (const [family, episode] of Object.entries(activeState.episodes || {})) {
    if (episode.status !== 'resolved'
      && watchdogMaintenanceBlocksClass(maintenance, watchdogIssueMaintenanceClass(episode.lastRaw)) === true) {
      heldFamilies.add(family);
      held.episodes[family] = episode;
      delete activeState.episodes[family];
    }
  }
  for (const [id, intent] of Object.entries(activeState.outbox || {})) {
    if (!heldFamilies.has(intent.family)) continue;
    const heldIntent = structuredClone(intent);
    delete heldIntent.dispatchId;
    held.outbox[id] = heldIntent;
    delete activeState.outbox[id];
  }
  for (const [id, dispatch] of Object.entries(activeState.dispatches || {})) {
    const intentIds = (dispatch.intentIds || []).filter(intentId => Object.hasOwn(activeState.outbox || {}, intentId));
    if (intentIds.length) activeState.dispatches[id] = {...dispatch, intentIds};
    else delete activeState.dispatches[id];
  }
  return {activeState, held, heldFamilies: [...heldFamilies]};
}

function mergeMaintenanceHeldAlertState(state, held) {
  const next = structuredClone(state);
  next.episodes = {...(next.episodes || {}), ...(held.episodes || {})};
  next.outbox = {...(next.outbox || {}), ...(held.outbox || {})};
  return next;
}

function parseArgs(argv) {
  const args = {
    stateDir: DEFAULT_STATE_DIR,
    logDir: DEFAULT_LOG_DIR,
    portalData: path.join(ROOT, 'outputs', 'bi-portal', 'data.json'),
    maintenanceFile: process.env.SHEIN_CLOUD_MAINTENANCE_FILE || DEFAULT_CLOUD_MAINTENANCE_FILE,
    dryRun: false,
    force: false,
    lockTimeoutMs: SINGLE_INSTANCE_LOCK_TIMEOUT_MS,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--state-dir') args.stateDir = path.resolve(argv[++i]);
    else if (a === '--log-dir') args.logDir = path.resolve(argv[++i]);
    else if (a === '--portal-data') args.portalData = path.resolve(argv[++i]);
    else if (a === '--maintenance-file') args.maintenanceFile = path.resolve(argv[++i]);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--force') args.force = true;
    else if (a === '--lock-timeout-ms') {
      const parsedTimeout = Number(argv[++i]);
      args.lockTimeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0
        ? parsedTimeout
        : SINGLE_INSTANCE_LOCK_TIMEOUT_MS;
    }
  }
  return args;
}

function run(command, args, options = {}) {
  return new Promise(resolve => {
    const {timeoutMs = 0, input = '', ...spawnOptions} = options;
    const child = spawn(command, args, {cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], ...spawnOptions});
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          stderr += `\nCommand timed out after ${timeoutMs}ms`;
          child.kill('SIGTERM');
        }, timeoutMs)
      : null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('error', err => {
      if (timer) clearTimeout(timer);
      resolve({ok: false, code: -1, stdout, stderr: String(err?.stack || err), timedOut});
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      resolve({ok: code === 0 && !timedOut, code: timedOut ? -2 : code, stdout, stderr, timedOut});
    });
  });
}

function parseDate(value) {
  if (!value) return null;
  const text = String(value).trim();
  const systemd = text.match(/^(?:[A-Za-z]{3}\s+)?(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})(?:\s+[A-Za-z]+)?$/);
  const raw = systemd ? `${systemd[1]}T${systemd[2]}+08:00` : text.replace(' ', 'T');
  const d = new Date(raw.includes('+') || raw.endsWith('Z') ? raw : `${raw}+08:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function hoursSince(value) {
  const d = parseDate(value);
  if (!d) return null;
  return (Date.now() - d.getTime()) / 36e5;
}

function bjDateKey(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

function previousBjDateKey(now = new Date()) {
  const parts = bjDateKey(now).split('-').map(Number);
  const previous = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12));
  previous.setUTCDate(previous.getUTCDate() - 1);
  return previous.toISOString().slice(0, 10);
}

function laterThanServiceExit(completedAt, status) {
  const completed = parseDate(completedAt)?.getTime();
  const exited = parseDate(status?.ExecMainExitTimestamp || status?.StateChangeTimestamp)?.getTime();
  return Number.isFinite(completed) && (!Number.isFinite(exited) || completed >= exited);
}

/**
 * A morning-chain run must converge to a terminal non-running latest state.
 * When the oneshot unit has already left the active set (failed/inactive/dead)
 * but its latest.json is still `running`, that is a stale-running failure that
 * must surface as an explicit blocker instead of being treated as normal.
 * `unknown`/`activating`/`active` never qualify so an unreadable systemd state
 * cannot create a false alert.
 */
export function isMorningChainStaleRunning(latestState, unitState) {
  if (!latestState || typeof latestState !== 'object') return false;
  if (String(latestState.status || '') !== 'running') return false;
  const activeState = String(unitState?.ActiveState || '');
  return ['failed', 'inactive', 'dead'].includes(activeState);
}

/**
 * A morning-chain run that converged to a terminal failure (wrapper or chain
 * recorded failed/deferred/partial for the CURRENT runDate) while the oneshot
 * unit has already left the active set is the deadline/terminal-failure state
 * the watchdog must surface.  `running`, `ok`, stale dates, in-between unit
 * states and unreadable payloads never qualify, so neither a live run nor an
 * old daily failure can create a false alert.
 */
export function isMorningChainTerminalFailure(latestState, unitState) {
  if (!latestState || typeof latestState !== 'object') return false;
  if (!['failed', 'deferred', 'partial'].includes(String(latestState.status || ''))) return false;
  if (String(latestState.date || '') !== bjDateKey()) return false;
  const activeState = String(unitState?.ActiveState || '');
  return ['failed', 'inactive', 'dead'].includes(activeState);
}

export function assessBusinessRecovery(unit, status, {morningMarker, morningMarkerEvidenceOk = false, orderRecheckState} = {}) {
  const morningUnits = new Set([
    'shein-bi-cloud-morning-chain.service',
  ]);
  // Only the final daily-operating-refresh marker with reverified immutable
  // evidence may resolve a failed service exit. Earlier links/supplement
  // markers are checkpoints, never proof that inventory completed.
  if (morningUnits.has(unit)
    && morningMarker?.runDate === bjDateKey()
    && morningMarker?.businessDate === previousBjDateKey()
    && morningMarker?.stage === 'daily-operating-refresh'
    && String(morningMarker?.status || '') === 'done'
    && morningMarker?.ok === true
    && morningMarkerEvidenceOk === true
    && laterThanServiceExit(morningMarker?.completedAt, status)) {
    return {recovered: true, reason: 'daily_operating_refresh_after_unit_exit', completedAt: morningMarker.completedAt};
  }
  if (unit === 'shein-bi-cloud-order-closure.service'
    && orderRecheckState?.ok === true
    && laterThanServiceExit(orderRecheckState?.finishedAt, status)) {
    return {recovered: true, reason: 'order_recheck_completed_after_unit_exit', completedAt: orderRecheckState.finishedAt};
  }
  return {recovered: false};
}

function fmtHours(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-';
  return `${Math.round(n * 10) / 10}h`;
}

function newerTimestamp(a, b) {
  const left = parseDate(a);
  const right = parseDate(b);
  if (left && right) return left >= right ? a : b;
  return left ? a : (right ? b : (a || b || ''));
}

async function readPortalRuntimeHealth() {
  try {
    const response = await fetch('http://127.0.0.1:8787/api/health', {
      signal: AbortSignal.timeout(5_000),
      headers: {'Accept': 'application/json'},
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}


async function readJsonIfExists(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    return {error: String(err?.message || err)};
  }
}

async function writeJsonAtomic(file, value) {
  await writeJsonFileAtomic(file, value);
}

export async function persistWatchdogMaintenanceState(file, state, {dryRun = false} = {}) {
  if (dryRun) return false;
  await writeJsonAtomic(file, state);
  return true;
}

async function readLatestWatchdogReport(logDir) {
  try {
    const names = (await fs.readdir(logDir))
      .filter(name => /^watchdog-\d{14}\.json$/.test(name))
      .sort()
      .reverse();
    return names.length ? await readJsonIfExists(path.join(logDir, names[0])) : null;
  } catch {
    return null;
  }
}

function normalizedStoreKey(value) {
  return String(value || '').trim().toUpperCase();
}

// Keep the watchdog aligned with the warehouse audit: browser/OpenAPI
// four-state differences are diagnostic only. The runner emits the actionable
// semantic result based on current OpenAPI, prior OpenAPI, and Webhook proof.
function assessOpenapiProductReport(report, expectedStoreKeys, nowMs = Date.now()) {
  const expected = [...new Set((expectedStoreKeys || []).map(normalizedStoreKey).filter(Boolean))].sort();
  if (!report || typeof report !== 'object') return {healthy: false, reason: 'report_missing', messages: ['OpenAPI 商品对账报告不存在；请运行完整 19 店对账。']};
  const reportAt = Date.parse(report.generatedAt || report.endedAt || '');
  if (!Number.isFinite(reportAt) || nowMs - reportAt > 48 * 3600_000) {
    return {healthy: false, reason: 'report_stale', messages: ['OpenAPI 商品对账报告超过 48 小时未更新；请运行完整 19 店对账。']};
  }
  const rows = Array.isArray(report.results) ? report.results : [];
  const byStore = new Map(rows.map(row => [normalizedStoreKey(row?.storeKey), row]).filter(([storeKey]) => storeKey));
  const messages = [];
  const missing = expected.filter(storeKey => !byStore.has(storeKey));
  if (missing.length) messages.push(`OpenAPI 商品对账缺少店铺：${missing.join('、')}。`);
  for (const storeKey of expected) {
    const row = byStore.get(storeKey);
    if (!row) continue;
    const semantic = row.semanticReconciliation;
    if (row.ok !== true) messages.push(`${storeKey} 店商品对账未完成：${row.status || 'unknown'}。`);
    else if (!semantic || !['openapi-current-webhook-previous/v1', 'openapi-current-webhook-previous/v2'].includes(semantic.policyVersion)) {
      messages.push(`${storeKey} 店商品对账仍是旧口径或缺少语义结果；请重跑。`);
    }
    else if (semantic.status === 'warning') messages.push(`${storeKey} 店商品对账需处理：${(semantic.warnings || []).join('；') || '存在可行动差异'}`);
  }
  return {healthy: messages.length === 0, reason: messages.length ? 'actionable_reconciliation_warning' : 'ok', messages};
}

function serviceExitAckKey(status) {
  return [
    status.name || '',
    status.ExecMainExitTimestamp || status.StateChangeTimestamp || '',
    status.ExecMainCode || '',
    status.ExecMainStatus || '',
  ].join('|');
}

async function readServiceExitAcks() {
  const file = path.join(ROOT, 'state', 'cloud_ops_alerts', 'service-exit-acks.json');
  const data = await readJsonIfExists(file);
  if (!data || data.error) return new Set();
  const raw = Array.isArray(data.acks) ? data.acks : [];
  return new Set(raw.map(entry => {
    if (typeof entry === 'string') return entry;
    return [
      entry.unit || entry.name || '',
      entry.execMainExitTimestamp || entry.ExecMainExitTimestamp || entry.stateChangeTimestamp || '',
      entry.execMainCode ?? entry.ExecMainCode ?? '',
      entry.execMainStatus ?? entry.ExecMainStatus ?? '',
    ].join('|');
  }).filter(Boolean));
}

async function readPortalDates(file) {
  try {
    const data = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
    return {
      generatedAt: data.generatedAt || '',
      dates: data.dates || {},
    };
  } catch (err) {
    return {error: String(err?.message || err), generatedAt: '', dates: {}};
  }
}

async function auditRecentCoverage() {
  const shanghaiParts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date()).map(part => [part.type, part.value]));
  const shanghaiMinuteOfDay = Number(shanghaiParts.hour || 0) * 60 + Number(shanghaiParts.minute || 0);
  const finalizedSalesSlaMinute = Number(process.env.SHEIN_CLOUD_WATCHDOG_FINALIZED_SALES_SLA_MINUTE || 220);
  // The canonical previous-day slice is finalized by the 03:00 job. Before
  // its 03:40 SLA, auditing two days would incorrectly flag legitimate
  // zero-sale stores that have not yet received their materialized zero row.
  const recentDays = shanghaiMinuteOfDay < finalizedSalesSlaMinute ? 1 : 2;
  const res = await run(process.execPath, [
    'scripts/audit_cloud_data_coverage.mjs',
    // Include yesterday only after the canonical 03:00 finalizer's SLA.
    // Today's webhook-driven sales rows are intentionally sparse for
    // zero-sale stores.
    '--recent-days', String(recentDays),
    '--tables', 'sales,linkPerformance,productStoreCoverage',
    '--expected-start', 'first-seen',
    '--json',
    '--max-rows', '20',
  ], {timeoutMs: Number(process.env.SHEIN_CLOUD_WATCHDOG_COVERAGE_TIMEOUT_MS || 30_000)});
  if (!res.ok) {
    return {
      ok: false,
      error: `coverage audit failed code=${res.code}: ${(res.stderr || res.stdout || '').slice(-1200)}`,
    };
  }
  try {
    return JSON.parse(res.stdout);
  } catch (err) {
    return {
      ok: false,
      error: `coverage audit JSON parse failed: ${String(err?.message || err)}; stdout=${String(res.stdout || '').slice(-1200)}`,
    };
  }
}

async function auditOrphanStoreBrowsers() {
  const maxAgeMin = Number(process.env.SHEIN_CLOUD_WATCHDOG_ORPHAN_CHROME_MAX_AGE_MIN || 90);
  const res = await run(process.execPath, [
    'scripts/cleanup_shein_store_browsers.mjs',
    '--all',
    '--only-headless',
    '--dry-run',
    '--json',
  ], {timeoutMs: Number(process.env.SHEIN_CLOUD_WATCHDOG_CHROME_AUDIT_TIMEOUT_MS || 20_000)});
  if (!res.ok) {
    return {
      ok: false,
      error: `store browser audit failed code=${res.code}: ${(res.stderr || res.stdout || '').slice(-1200)}`,
    };
  }
  let data;
  try {
    data = JSON.parse(res.stdout);
  } catch (err) {
    return {
      ok: false,
      error: `store browser audit JSON parse failed: ${String(err?.message || err)}; stdout=${String(res.stdout || '').slice(-1200)}`,
    };
  }
  if (process.platform === 'win32') return {ok: true, maxAgeMin, orphanCount: 0, processes: []};
  const nowTicks = Number((await fs.readFile('/proc/uptime', 'utf8')).split(/\s+/)[0] || 0);
  const ticksPerSecond = Number(process.env.CLK_TCK || 100);
  const processes = [];
  for (const proc of data.before || []) {
    const raw = await fs.readFile(`/proc/${proc.pid}/stat`, 'utf8').catch(() => '');
    const parts = raw ? raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/) : [];
    const startTicks = Number(parts[19] || 0);
    const ageMin = startTicks > 0 ? Math.max(0, (nowTicks - (startTicks / ticksPerSecond)) / 60) : null;
    const isOrphan = Number(proc.ppid || 0) === 1;
    if (isOrphan && (ageMin === null || ageMin >= maxAgeMin)) {
      processes.push({...proc, ageMin});
    }
  }
  return {
    ok: true,
    maxAgeMin,
    orphanCount: processes.length,
    processes,
  };
}

async function auditRootDisk() {
  const res = await run('df', ['-Pk', '/'], {timeoutMs: 5_000});
  if (!res.ok) return {ok: false, error: `disk audit failed code=${res.code}`};
  const line = String(res.stdout || '').trim().split(/\r?\n/).at(-1) || '';
  const parts = line.trim().split(/\s+/);
  if (parts.length < 6) return {ok: false, error: 'disk audit returned an unreadable result'};
  const totalKiB = Number(parts[1]);
  const usedKiB = Number(parts[2]);
  const availableKiB = Number(parts[3]);
  const usedPercent = Number(String(parts[4]).replace('%', ''));
  if (![totalKiB, usedKiB, availableKiB, usedPercent].every(Number.isFinite)) {
    return {ok: false, error: 'disk audit returned invalid numbers'};
  }
  return {
    ok: true,
    mount: parts[5],
    totalBytes: totalKiB * 1024,
    usedBytes: usedKiB * 1024,
    availableBytes: availableKiB * 1024,
    usedPercent,
  };
}

function rootDiskIssue(disk) {
  if (!disk?.ok) return `服务器硬盘检查失败：${disk?.error || '未知原因'}`;
  if (disk.usedPercent >= 93) return '服务器硬盘即将写满：根盘使用率已超过 93%，需要立即处理。';
  if (disk.usedPercent >= 88) return '服务器硬盘快满了：根盘使用率已超过 88%，请检查自动维护结果。';
  if (disk.usedPercent >= 80) return '服务器硬盘空间偏紧：根盘使用率已超过 80%，自动维护会在安全窗口清缓存并归档旧抓数。';
  return '';
}

async function psqlJson(sql, timeoutMs = Number(process.env.SHEIN_CLOUD_WATCHDOG_DB_TIMEOUT_MS || 30_000)) {
  const command = `${process.getuid?.() === 0 ? '' : 'sudo '}docker exec -i shein-warehouse-db psql -U shein -d shein_bi -v ON_ERROR_STOP=1 -A -t -q`;
  const res = await run('bash', ['-lc', command], {input: sql, timeoutMs});
  if (!res.ok) {
    return {ok: false, error: `psql failed code=${res.code}: ${(res.stderr || res.stdout || '').slice(-1200)}`};
  }
  try {
    return {ok: true, data: JSON.parse(String(res.stdout || '').trim() || '{}')};
  } catch (err) {
    return {ok: false, error: `psql JSON parse failed: ${String(err?.message || err)}; stdout=${String(res.stdout || '').slice(-1200)}`};
  }
}

async function auditOrderClosure(args) {
  const state = await readJsonIfExists(path.join(ROOT, 'state', 'order_status_recheck_last.json'));
  const sql = `
WITH effective AS (
  SELECT
    oi.order_item_key,
    oi.created_date,
    oi.store_key,
    rs.order_item_key IS NOT NULL AS has_recheck,
    coalesce(rs.is_terminal,false) AS is_terminal,
    rs.last_checked_at,
    coalesce(rs.lifecycle_status_group,
      CASE
        WHEN coalesce(oi.goods_performance_status_desc,'') ~ '(未妥投|退回|拒收)' THEN 'returning'
        WHEN coalesce(oi.goods_performance_status_desc,'') ~ '(取消|关闭)' THEN 'cancelled'
        WHEN coalesce(oi.goods_performance_status_desc,'') ~ '(已签收|已完成|妥投)' THEN 'done'
        WHEN coalesce(oi.goods_performance_status_desc,'') ~ '(异常|失败|超时|风控|拦截|派件异常)' THEN 'abnormal'
        WHEN coalesce(oi.goods_performance_status_desc,'') ~ '(尾程已发货|已发货|运输|揽收|包裹已揽收)' THEN 'shipped'
        WHEN coalesce(oi.goods_performance_status_desc,'') ~ '(待处理|待发货|待揽收|待出库|待|下单成功|已打印面单)' THEN 'pending'
        ELSE 'other'
      END
    ) AS status_group
  FROM fact.order_item oi
  LEFT JOIN ops.order_status_recheck_effective rs
    ON rs.fact_order_item_key = oi.order_item_key
  WHERE oi.created_date < current_date - interval '10 days'
), summary AS (
  SELECT
    count(*) FILTER (WHERE NOT is_terminal AND status_group NOT IN ('done','cancelled','returning')) AS aged_open_items,
    count(*) FILTER (WHERE NOT is_terminal AND status_group NOT IN ('done','cancelled','returning') AND NOT has_recheck) AS pending_recheck_items,
    count(*) FILTER (WHERE NOT is_terminal AND status_group NOT IN ('done','cancelled','returning') AND has_recheck) AS platform_unclosed_items,
    count(DISTINCT store_key || ':' || created_date::text) FILTER (WHERE NOT is_terminal AND status_group NOT IN ('done','cancelled','returning')) AS aged_open_pairs,
    min(created_date) FILTER (WHERE NOT is_terminal AND status_group NOT IN ('done','cancelled','returning')) AS oldest_open_date,
    max(last_checked_at) AS last_checked_at
  FROM effective
)
SELECT json_build_object(
  'agedOpenItems', coalesce(aged_open_items,0),
  'pendingRecheckItems', coalesce(pending_recheck_items,0),
  'platformUnclosedItems', coalesce(platform_unclosed_items,0),
  'agedOpenPairs', coalesce(aged_open_pairs,0),
  'oldestOpenDate', oldest_open_date,
  'lastCheckedAt', last_checked_at
)::text FROM summary;
`;
  const db = await psqlJson(sql);
  return {state, db};
}

async function notify(args, message, logFile, {kind = 'cloud-watchdog', idempotencyKey = ''} = {}) {
  const argv = [
    'scripts/notify_sync_issue.mjs',
    '--kind', kind,
    '--mode', 'watchdog',
    '--message', message,
    '--log-file', logFile,
    '--force',
  ];
  if (idempotencyKey) argv.push('--idempotency-key', idempotencyKey);
  return await run(process.execPath, argv);
}

async function acquireWatchdogSingleInstance(args, {lockTimeoutMs = SINGLE_INSTANCE_LOCK_TIMEOUT_MS} = {}) {
  const stateDir = String(args?.stateDir || '').trim();
  if (!stateDir) throw new TypeError('watchdog single-instance lock requires args.stateDir');
  await fs.mkdir(stateDir, {recursive: true});
  const lockPath = path.join(stateDir, SINGLE_INSTANCE_LOCK_FILE);
  const deadlineMs = Number.isFinite(lockTimeoutMs) && lockTimeoutMs > 0
    ? lockTimeoutMs
    : SINGLE_INSTANCE_LOCK_TIMEOUT_MS;
  try {
    const release = await acquireCrossProcessTicketLock(lockPath, {
      timeoutMs: deadlineMs,
      timeoutCode: SINGLE_INSTANCE_ALREADY_RUNNING_CODE,
    });
    return {skipped: false, lockPath, release};
  } catch (error) {
    if (error?.code === SINGLE_INSTANCE_ALREADY_RUNNING_CODE) {
      return {skipped: true, lockPath};
    }
    throw error;
  }
}

export async function withWatchdogSingleInstance(args, body, options = {}) {
  const handle = await acquireWatchdogSingleInstance(args, options);
  if (handle.skipped) return {skipped: true, lockPath: handle.lockPath};
  try {
    const result = await body();
    return {skipped: false, result};
  } finally {
    await handle.release();
  }
}

async function runWatchdog(args) {
  if (!args.dryRun) await fs.mkdir(args.logDir, {recursive: true});
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const logFile = path.join(args.logDir, `watchdog-${stamp}.json`);

  const issues = [];
  const maintenanceNotes = [];
  const recoveries = [];
  const maintenanceStatus = await readCloudMaintenanceStatus(args.maintenanceFile);
  const maintenance = summarizeWatchdogMaintenanceStatus(maintenanceStatus);
  const maintenanceStateFile = path.join(args.stateDir, 'maintenance-state.json');
  const previousMaintenanceState = await readJsonIfExists(maintenanceStateFile);
  const maintenanceTransition = applyWatchdogMaintenanceTransition({
    previousState: previousMaintenanceState?.error ? null : previousMaintenanceState,
    maintenance,
  });
  let maintenanceState = maintenanceTransition.nextState;
  const maintenanceGuardAudit = await auditCloudMaintenanceGuards().catch(error => ({
    ok: false,
    policyCount: 0,
    unchanged: 0,
    issues: [{code: String(error?.code || 'MAINTENANCE_GUARD_AUDIT_FAILED'), message: String(error?.message || error).slice(0, 500)}],
  }));
  if (!maintenanceGuardAudit.ok) {
    issues.push(`维护总闸安装漂移：${JSON.stringify(maintenanceGuardAudit.issues || []).slice(0, 1200)}；本轮不抑制任何运行态检查`);
  }
  const suppressedById = new Map();
  const maintenancePolicyErrorsById = new Map();
  const suppressCheck = (id, unitClass, detail = {}) => {
    if (!maintenanceGuardAudit.ok) return false;
    const decision = partitionWatchdogMaintenanceChecks(maintenance, [{id, unitClass, ...detail}]);
    for (const row of decision.suppressed) suppressedById.set(row.id, row);
    for (const row of decision.policyErrors) maintenancePolicyErrorsById.set(row.id, row);
    return decision.suppressed.length > 0;
  };
  const classIsSuppressed = unitClass => maintenanceGuardAudit.ok
    && watchdogMaintenanceBlocksClass(maintenance, unitClass) === true;
  if (maintenanceTransition.recoveryCreated) {
    const from = maintenanceTransition.recoveryCreated.from;
    maintenanceNotes.push(
      `云端维护模式已恢复：mode=${from.mode} generation=${from.generation} hash=${from.hash}；本次恢复记录仅生成一次`,
    );
  }
  const deployedRelease = await readJsonIfExists(
    process.env.SHEIN_BI_DEPLOYED_RELEASE_FILE || '/srv/shein-bi/runtime/deployed_release.json',
  );
  const deployedReleaseValidation = validateDeployedReleaseMarker(deployedRelease, {requireV3: true});
  if (!deployedReleaseValidation.ok) {
    issues.push(`生产部署证明无效（生产健康必须绑定 source release v3 回执）：${deployedReleaseValidation.issues.join(',') || 'marker_missing'}`);
  }
  const deploymentEvidence = inspectRecordedDeploymentReleaseEvidence({
    cwd: ROOT,
    marker: deployedRelease,
    releaseAttestationRoot: process.env.SHEIN_BI_RELEASE_ATTESTATION_ROOT
      || '/srv/shein-bi/runtime/release-attestations',
  });
  if (!deploymentEvidence.ok) {
    issues.push(`生产部署证明缺少 attestation/tag 实证：${deploymentEvidence.issues.join(',') || deploymentEvidence.errorCode || 'evidence_missing'}`);
  }
  let releaseSourceState;
  try {
    releaseSourceState = inspectReleaseSourceState({
      cwd: ROOT,
      expectedCommit: deploymentEvidence.commit || '',
    });
    const sourceIntegrityIssue = sourceIntegrityIssueFor(releaseSourceState);
    if (sourceIntegrityIssue) issues.push(sourceIntegrityIssue);
  } catch (error) {
    releaseSourceState = {ok: false, error: String(error?.message || error)};
    issues.push(`云端源码一致性检查失败：${releaseSourceState.error}`);
  }
  let expectedStoreKeys = [];
  let productReport = {suppressed: true, class: 'scheduled'};
  let productReconciliationHealth = {suppressed: true, class: 'scheduled'};
  if (!suppressCheck('business:openapi-product-reconciliation', 'scheduled', {kind: 'business'})) {
    const storeConfig = await readJsonIfExists(path.join(ROOT, 'config', 'stores.json'));
    expectedStoreKeys = (Array.isArray(storeConfig?.stores) ? storeConfig.stores : [])
      .filter(store => store?.enabled !== false)
      .map(store => store?.storeKey);
    productReport = await readJsonIfExists(path.join(ROOT, 'state', 'openapi-probes', 'product-reconciliation.latest.json'));
    productReconciliationHealth = assessOpenapiProductReport(productReport, expectedStoreKeys);
    if (!productReconciliationHealth.healthy) {
      for (const message of productReconciliationHealth.messages) issues.push(`商品 OpenAPI 对账需处理：${message}`);
    }
  }
  const serviceExitAcks = await readServiceExitAcks();
  const today = bjDateKey();
  const expectedBusinessDate = previousBjDateKey();
  let morningReadyMarker = {suppressed: true, class: 'scheduled'};
  let morningReadyEvidenceOk = false;
  let morningChainLatest = {suppressed: true, class: 'scheduled'};
  let orderRecheckStateForServices = null;
  let sessionManagerReport = null;
  let manualLoginState = null;
  if (!suppressCheck('business:daily-markers-and-recovery-evidence', 'scheduled', {kind: 'business'})) {
    morningReadyMarker = await readJsonIfExists(path.join(ROOT, 'state', 'pipeline-markers', today, 'daily-operating-refresh.json'));
    if (morningReadyMarker?.runDate === today
      && morningReadyMarker?.businessDate === expectedBusinessDate
      && morningReadyMarker?.stage === 'daily-operating-refresh'
      && morningReadyMarker?.status === 'done') {
      try {
        await validateDailyOperatingRefresh({
          root: ROOT,
          markerRoot: path.join(ROOT, 'state', 'pipeline-markers'),
          stateDir: process.env.SHEIN_BI_MORNING_CHAIN_STATE_DIR || path.join(ROOT, 'state', 'cloud_morning_chain'),
          inventoryRuntimeRoot: process.env.SHEIN_BI_INVENTORY_RUNTIME_ROOT || '/srv/shein-bi/runtime/daily-inventory-replenishment',
          runDate: today,
          businessDate: expectedBusinessDate,
        });
        morningReadyEvidenceOk = true;
      } catch {
        morningReadyEvidenceOk = false;
      }
    }
    if (morningReadyMarker?.runDate === bjDateKey()
      && morningReadyMarker?.stage === 'daily-operating-refresh'
      && morningReadyMarker?.status === 'done'
      && morningReadyEvidenceOk !== true) {
      issues.push('晨链最终证据失效：daily-operating-refresh 标记为 done，但受管 evidence 的文件/大小/SHA-256 回验不一致');
    }
    morningChainLatest = await readJsonIfExists(path.join(ROOT, 'state', 'cloud_morning_chain', 'latest.json'));
    orderRecheckStateForServices = await readJsonIfExists(path.join(ROOT, 'state', 'order_status_recheck_last.json'));
    sessionManagerReport = await readJsonIfExists(path.join(ROOT, 'outputs', 'reports', 'cloud-session-manager-latest.json'));
    manualLoginState = await readJsonIfExists(
      process.env.SHEIN_MANUAL_LOGIN_STATE_FILE || '/srv/shein-bi/runtime/cloud_manual_login_sessions.json',
    );
  }
  let sessionManagerManualRecovery = classIsSuppressed('scheduled')
    ? {suppressed: true, class: 'scheduled'}
    : {recovered: false, reason: 'session_manager_unit_not_checked'};
  const systemdSnapshot = await collectSystemdUnitSnapshot(CLOUD_RUNTIME_SNAPSHOT_UNITS);
  const effectiveControls = validateCloudRuntimeEffectiveControls(systemdSnapshot.units);
  if (!effectiveControls.ok) {
    const pathIssues = effectiveControls.issues.filter(issue => issue.kind === 'runtime-path' || issue.kind === 'snapshot');
    const guardIssues = effectiveControls.issues.filter(issue => issue.kind === 'maintenance-guard');
    if (pathIssues.length) issues.push(`运行态 namespace 有效属性漂移：${JSON.stringify(pathIssues).slice(0, 1600)}`);
    if (guardIssues.length) issues.push(`维护总闸 ExecCondition 有效属性漂移：${JSON.stringify(guardIssues).slice(0, 1600)}`);
  }
  if (!systemdSnapshot.ok) {
    const incompleteUnits = systemdSnapshot.requested.filter(name => {
      const unitClass = CLOUD_MAINTENANCE_POLICY_BY_SERVICE[name]
        || CLOUD_TIMER_MAINTENANCE_POLICY[name]
        || '';
      if (!VALID_MAINTENANCE_CLASSES.has(unitClass)) {
        suppressCheck(`systemd:${name}`, unitClass, {kind: 'systemd', unit: name});
        return false;
      }
      return !classIsSuppressed(unitClass) && systemdSnapshot.units[name]?.complete !== true;
    });
    if (incompleteUnits.length) {
      issues.push(`systemd 批量快照不完整：units=${incompleteUnits.join(',')}；停止按缺失字段判断运行态`);
    }
  }
  const systemctlShow = name => systemdSnapshot.units[name] || {
    name, ok: false, code: 1, LoadState: 'unknown', ActiveState: 'unknown', Result: 'unknown',
  };
  const units = [];
  for (const unit of UNIT_NAMES) {
    const status = systemctlShow(unit);
    units.push(status);
    const unitClass = CLOUD_MAINTENANCE_POLICY_BY_SERVICE[unit] || '';
    if (suppressCheck(`service:${unit}`, unitClass, {kind: 'service', unit})) {
      status.maintenanceSuppressed = true;
      status.maintenanceClass = unitClass || 'missing';
      continue;
    }
    if (status.LoadState === 'not-found') {
      if (ALWAYS_RUNNING_UNITS.has(unit)) {
        issues.push(`常驻服务未运行：${unit} state=not-found result=${status.Result || '-'}`);
      }
      continue;
    }
    if (unit === 'shein-bi-cloud-morning-chain.service'
      && isMorningChainStaleRunning(morningChainLatest, status)) {
      issues.push(`晨链终态未收敛：${unit} 已退出但 latest.json 仍为 running state=${status.ActiveState || '-'} result=${status.Result || '-'} exit=${status.ExecMainStatus || '-'} latestGeneratedAt=${morningChainLatest?.generatedAt || '-'}；该 service 已配置 Restart=on-failure 恢复同一 active run context（runDate/businessDate），wrapper 会在重启时重写 latest.json；若持续未修复需人工确认当日任务`);
      continue;
    }
    if (unit === 'shein-bi-cloud-morning-chain.service'
      && isMorningChainTerminalFailure(morningChainLatest, status)) {
      issues.push(`晨链当日失败：${unit} 已退出且 latest.json 为终态失败 date=${morningChainLatest?.date || '-'} status=${morningChainLatest?.status || '-'} state=${status.ActiveState || '-'} result=${status.Result || '-'} exit=${status.ExecMainStatus || '-'} message=${morningChainLatest?.message || '-'}；wrapper 已在 first-start 绝对 deadline 后收敛终态并停止自动重启，需人工确认当日任务`);
      continue;
    }
    const {
      exitStatus,
      expectedConditionSkip,
      resultOk,
      abnormalExit,
      abnormalState,
    } = assessSystemdOneshotResult(status);
    const acknowledgedExit = abnormalExit && !abnormalState && serviceExitAcks.has(serviceExitAckKey(status));
    status.serviceExitAcknowledged = acknowledgedExit;
    status.expectedConditionSkip = expectedConditionSkip;
    const isSessionManager = unit === 'shein-bi-cloud-session-manager.service';
    const businessRecovery = assessBusinessRecovery(unit, status, {
      morningMarker: morningReadyMarker,
      morningMarkerEvidenceOk: morningReadyEvidenceOk,
      orderRecheckState: orderRecheckStateForServices,
    });
    status.businessRecovery = businessRecovery;
    if (isSessionManager) {
      sessionManagerManualRecovery = assessSessionManagerManualRecovery({
        sessionReport: sessionManagerReport,
        manualLoginState,
        unitStatus: status,
      });
      status.manualRecoveryVerified = sessionManagerManualRecovery.recovered === true;
    }
    if (ALWAYS_RUNNING_UNITS.has(unit) && status.ActiveState !== 'active') {
      issues.push(`常驻服务未运行：${unit} state=${status.ActiveState || '-'} result=${status.Result || '-'}`);
    } else if (abnormalState || (abnormalExit && !acknowledgedExit)) {
      if (isSessionManager && sessionManagerManualRecovery.recovered) {
        maintenanceNotes.push(
          `店铺登录异常已在人工登录后验证恢复：${sessionManagerManualRecovery.recoveredStores?.join('、') || '最新会话'}；不再重复报警旧 service 退出状态。`,
        );
        recoveries.push({
          type: 'manual_login_session_recovery',
          ...sessionManagerManualRecovery,
        });
      } else if (businessRecovery.recovered) {
        maintenanceNotes.push(`${unit} 的旧退出状态已被后续业务完成标记覆盖，不再向运营群重复报警。`);
        recoveries.push({type: 'business_stage_recovery', unit, ...businessRecovery});
      } else {
        issues.push(`服务异常：${unit} state=${status.ActiveState || '-'} result=${status.Result || '-'} exit=${status.ExecMainStatus || '-'} code=${status.ExecMainCode || '-'}`);
      }
    }
  }
  const timers = [];
  for (const timer of TIMER_NAMES) {
    const status = systemctlShow(timer);
    timers.push(status);
    const unitClass = CLOUD_TIMER_MAINTENANCE_POLICY[timer] || '';
    if (suppressCheck(`timer:${timer}`, unitClass, {kind: 'timer', unit: timer})) {
      status.maintenanceSuppressed = true;
      status.maintenanceClass = unitClass || 'missing';
      continue;
    }
    if (status.LoadState === 'not-found') continue;
    if (status.ActiveState !== 'active') {
      issues.push(`定时器未运行：${timer} state=${status.ActiveState || '-'} result=${status.Result || '-'}`);
    }
  }

  let marketingGuardState = {suppressed: true, class: 'scheduled'};
  let marketingGuardLastOkState = {suppressed: true, class: 'scheduled'};
  let marketingGuardService = {suppressed: true, class: 'scheduled'};
  let marketingGuardHealth = {suppressed: true, class: 'scheduled'};
  let marketingRepairQueue = {suppressed: true, class: 'scheduled'};
  let marketingRepairState = {suppressed: true, class: 'scheduled'};
  let marketingRepairService = {suppressed: true, class: 'scheduled'};
  let marketingRepairHealth = {suppressed: true, class: 'scheduled'};
  if (!suppressCheck('business:marketing-guard-and-repair-queue', 'scheduled', {kind: 'business'})) {
    marketingGuardState = await readJsonIfExists(path.join(ROOT, 'state', 'cloud_ops_alerts', 'marketing-live-guard-last.json'));
    marketingGuardLastOkState = await readJsonIfExists(path.join(ROOT, 'state', 'cloud_ops_alerts', 'marketing-live-guard-last-ok.json'));
    marketingGuardService = systemctlShow(CLOUD_AUXILIARY_UNITS[0]);
    marketingGuardHealth = assessDailyMarketingGuardHealth({
      guardState: marketingGuardState,
      lastOkState: marketingGuardLastOkState,
      guardRunning: ['active', 'activating', 'reloading'].includes(marketingGuardService.ActiveState),
      guardStartedAt: marketingGuardService.ExecMainStartTimestamp || marketingGuardService.ActiveEnterTimestamp,
    });
    if (!marketingGuardHealth.healthy) {
      issues.push(`营销无人值守守卫未完成：date=${marketingGuardHealth.today} reason=${marketingGuardHealth.reason} lastStatus=${marketingGuardState?.status || '-'} lastDate=${marketingGuardState?.date || '-'} message=${marketingGuardState?.message || '-'}`);
    }
    marketingRepairQueue = await readJsonIfExists(path.join(ROOT, 'state', 'cloud_marketing_live_guard', 'repair-queues', `marketing-repair-${marketingGuardHealth.today}.json`));
    marketingRepairState = await readJsonIfExists(path.join(ROOT, 'state', 'cloud_ops_alerts', 'marketing-repair-last.json'));
    marketingRepairService = systemctlShow(CLOUD_AUXILIARY_UNITS[1]);
    marketingRepairHealth = assessDailyMarketingRepairHealth({
      queueState: marketingRepairQueue,
      repairState: marketingRepairState,
      repairRunning: ['active', 'activating', 'reloading'].includes(marketingRepairService.ActiveState),
      repairStartedAt: marketingRepairService.ExecMainStartTimestamp || marketingRepairService.ActiveEnterTimestamp,
    });
    if (!marketingRepairHealth.healthy) {
      issues.push(`营销修复队列未闭环：date=${marketingRepairHealth.today} reason=${marketingRepairHealth.reason} queueStatus=${marketingRepairQueue?.status || '-'} rows=${marketingRepairQueue?.counts?.totalRows ?? '-'} groups=${marketingRepairQueue?.counts?.totalGroups ?? '-'} workerStatus=${marketingRepairState?.status || '-'}`);
    } else if (marketingRepairHealth.reason === 'today_repair_queue_deferred_to_local') {
      maintenanceNotes.push(
        `营销修复队列已移交本地受控执行：date=${marketingRepairHealth.today} rows=${marketingRepairQueue?.counts?.totalRows ?? '-'} groups=${marketingRepairQueue?.counts?.totalGroups ?? '-'}`,
      );
    }
  }

  let dailyRefresh = {suppressed: true, class: 'scheduled'};
  let linkBusinessSuccess = {suppressed: true, class: 'scheduled'};
  let dailyRefreshRecovery = null;
  if (!suppressCheck('business:daily-refresh-link-queue-and-freshness', 'scheduled', {kind: 'business'})) {
    const partialLinkBusiness = await readJsonIfExists(path.join(ROOT, 'state', 'cloud_ops_alerts', 'link-business-last-partial.json'));
    if (partialLinkBusiness?.error) {
      issues.push(`链接/业务域部分失败状态不可读：${partialLinkBusiness.error}`);
    } else if (partialLinkBusiness?.failedStores) {
      issues.push(`链接/业务域日更部分店铺失败：date=${partialLinkBusiness.date || '-'} failed=${partialLinkBusiness.failedStores || '-'} log=${partialLinkBusiness.logFile || '-'}`);
    }
    dailyRefresh = await readJsonIfExists(path.join(ROOT, 'state', 'cloud_ops_alerts', 'daily-refresh-last.json'));
    linkBusinessSuccess = await readJsonIfExists(path.join(ROOT, 'state', 'cloud_ops_alerts', 'link-business-last-success.json'));
    if (dailyRefresh?.error) {
    issues.push(`日更补采状态不可读：${dailyRefresh.error}`);
  } else if (dailyRefresh?.status && dailyRefresh.status !== 'ok' && !String(dailyRefresh.status).startsWith('skipped')) {
    const linkRecovery = assessDailyLinkBusinessRecovery({
      dailyRefresh,
      linkSuccess: linkBusinessSuccess,
      expectedStoreKeys,
    });
    const openapiSalesReport = await readJsonIfExists(path.join(ROOT, 'state', 'openapi-probes', 'sales-reconciliation.latest.json'));
    const openapiSalesRecovery = assessDailyOpenapiSalesRecovery({
      dailyRefresh,
      salesReport: openapiSalesReport,
      expectedStoreKeys,
    });
    const combinedLinkOpenapiMatch = /^(link-business (?:failed|partial|metrics not ready)(?: link-business (?:failed|partial|metrics not ready))*) openapi reconciliation failed$/
      .exec(String(dailyRefresh.message || '').trim());
    let combinedLinkOpenapiRecovery = {recovered: false, reason: 'daily_warning_not_combined_link_openapi_sales'};
    if (combinedLinkOpenapiMatch) {
      const linkPartRecovery = assessDailyLinkBusinessRecovery({
        dailyRefresh: {...dailyRefresh, message: combinedLinkOpenapiMatch[1]},
        linkSuccess: linkBusinessSuccess,
        expectedStoreKeys,
      });
      const salesPartRecovery = assessDailyOpenapiSalesRecovery({
        dailyRefresh: {...dailyRefresh, message: 'openapi reconciliation failed'},
        salesReport: openapiSalesReport,
        expectedStoreKeys,
      });
      if (linkPartRecovery.recovered && salesPartRecovery.recovered) {
        combinedLinkOpenapiRecovery = {
          recovered: true,
          reason: 'newer_complete_link_and_openapi_sales_recovery',
          evidence: {
            type: 'daily_link_openapi_sales_recovery',
            dailyDate: dailyRefresh.date || null,
            dailyGeneratedAt: dailyRefresh.generatedAt,
            linkBusiness: linkPartRecovery.evidence,
            openapiSales: salesPartRecovery.evidence,
          },
        };
      } else {
        combinedLinkOpenapiRecovery = {
          recovered: false,
          reason: 'combined_link_openapi_sales_recovery_incomplete',
          attempts: {
            linkBusiness: linkPartRecovery.reason,
            openapiSales: salesPartRecovery.reason,
          },
        };
      }
    }
    const scanFile = resolveMarketingScanEvidencePath(ROOT, marketingGuardState?.scanFile);
    const scanSnapshot = scanFile ? await readJsonIfExists(scanFile) : null;
    const marketingRecovery = scanFile
      ? assessDailyMarketingScanRecovery({
          dailyRefresh,
          guardState: marketingGuardState,
          scanSnapshot,
          expectedStoreKeys,
        })
      : {recovered: false, reason: 'recovery_scan_path_invalid'};
    const rawProductRecovery = assessDailyOpenapiProductRecovery({
      dailyRefresh,
      productReport,
      expectedStoreKeys,
    });
    const productRecovery = productReconciliationHealth.healthy
      ? rawProductRecovery
      : {
          recovered: false,
          reason: `openapi_product_${productReconciliationHealth.reason}`,
          evidence: {type: 'daily_openapi_product_recovery_blocked_by_actionable_warning'},
        };
    const profitSection = await readJsonIfExists(path.join(ROOT, 'outputs', 'bi-portal', 'sections', 'profit.json'));
    const profitRecovery = assessDailyProfitSectionRecovery({dailyRefresh, profitSection});
    dailyRefreshRecovery = profitRecovery.recovered
      ? profitRecovery
      : linkRecovery.recovered
      ? linkRecovery
      : openapiSalesRecovery.recovered
        ? openapiSalesRecovery
        : combinedLinkOpenapiRecovery.recovered
          ? combinedLinkOpenapiRecovery
      : marketingRecovery.recovered
        ? marketingRecovery
        : productRecovery.recovered
          ? productRecovery
          : {
              recovered: false,
              reason: 'no_verified_daily_recovery',
              attempts: {
                linkBusiness: linkRecovery.reason,
                openapiSales: openapiSalesRecovery.reason,
                combinedLinkOpenapiSales: combinedLinkOpenapiRecovery.reason,
                marketingScan: marketingRecovery.reason,
                openapiProduct: productRecovery.reason,
                profitSection: profitRecovery.reason,
              },
            };
    if (dailyRefreshRecovery.recovered) {
      recoveries.push(dailyRefreshRecovery.evidence);
    } else {
      issues.push(`日更补采异常：date=${dailyRefresh.date || '-'} status=${dailyRefresh.status} message=${dailyRefresh.message || '-'} log=${dailyRefresh.logFile || '-'}`);
    }
    }
  }

  const portalData = await readPortalDates(args.portalData);
  const portalRuntime = await readPortalRuntimeHealth();
  const portalFreshnessSuppressed = suppressCheck(
    'business:portal-data-freshness',
    'scheduled',
    {kind: 'freshness'},
  );
  let portal = portalData;
  if (portalData.error) {
    issues.push(`BI 数据文件不可读：${portalData.error}`);
  }
  if (!portalRuntime) {
    issues.push('BI 实时运行状态不可读：Portal /api/health 无响应');
  }
  if (portalRuntime?.liveUpdates?.enabled === true && portalRuntime.liveUpdates.connected !== true) {
    issues.push(`BI 实时更新通道未连接：channel=${portalRuntime.liveUpdates.channel || '-'} error=${portalRuntime.liveUpdates.lastError || '-'}`);
  }
  if (!portalData.error && !portalFreshnessSuppressed) {
    const generatedAge = hoursSince(portalData.generatedAt);
    const salesTimestamp = newerTimestamp(
      portalData.dates?.salesUpdatedAt,
      portalRuntime?.liveUpdates?.lastOrderAt,
    );
    const salesAge = hoursSince(salesTimestamp);
    const businessAge = hoursSince(portalData.dates?.businessUpdatedAt);
    const linkAge = hoursSince(portalData.dates?.linkUpdatedAt);
    const etAge = hoursSince(portalData.dates?.etUpdatedAt);
    if (generatedAge === null || generatedAge > 30) issues.push(`BI 页面底稿过期：${portalData.generatedAt || '-'} age=${fmtHours(generatedAge)}，阈值=30h`);
    if (salesAge === null || salesAge > 30) issues.push(`SHEIN 销售数据过期：${salesTimestamp || '-'} age=${fmtHours(salesAge)}，阈值=30h`);
    // 业务域/链接表现是低频日更，不按销售高频阈值判断。
    if (businessAge === null || businessAge > 48) issues.push(`SHEIN 业务域日更过期：${portalData.dates?.businessUpdatedAt || '-'} age=${fmtHours(businessAge)}，阈值=48h`);
    if (linkAge === null || linkAge > 48) issues.push(`SHEIN 链接表现日更过期：${portalData.dates?.linkUpdatedAt || '-'} age=${fmtHours(linkAge)}，阈值=48h`);
    if (etAge === null || etAge > 36) issues.push(`ET 货代仓过期：${portalData.dates?.etUpdatedAt || '-'} age=${fmtHours(etAge)}，阈值=36h`);
  } else if (!portalData.error) {
    portal = {
      suppressed: true,
      class: 'scheduled',
      dataReadable: true,
      portalRuntimeChecked: true,
    };
  }

  let coverage = {suppressed: true, class: 'scheduled'};
  if (!suppressCheck('business:data-coverage', 'scheduled', {kind: 'business'})) {
    coverage = await auditRecentCoverage();
    if (coverage.error) {
      issues.push(`BI 日期×店铺覆盖审计失败：${coverage.error}`);
    } else {
      for (const check of coverage.checks || []) {
        for (const issue of check.issues || []) {
          issues.push(`BI 覆盖不足：${issue}`);
        }
      }
    }
  }

  let orphanStoreBrowsers = {suppressed: true, class: 'scheduled'};
  if (!suppressCheck('business:orphan-store-browsers', 'scheduled', {kind: 'business'})) {
    orphanStoreBrowsers = await auditOrphanStoreBrowsers();
    if (orphanStoreBrowsers.error) {
      issues.push(`SHEIN 店铺浏览器残留审计失败：${orphanStoreBrowsers.error}`);
    } else if (Number(orphanStoreBrowsers.orphanCount || 0) > 0) {
      const sample = (orphanStoreBrowsers.processes || [])
        .slice(0, 6)
        .map(p => `${p.storeKey}:pid=${p.pid},age=${fmtHours((p.ageMin || 0) / 60)},rss=${Math.round((p.rssKb || 0) / 1024)}MiB`)
        .join('; ');
      issues.push(`SHEIN 店铺浏览器残留：count=${orphanStoreBrowsers.orphanCount} threshold=${orphanStoreBrowsers.maxAgeMin}min ${sample}`);
    }
  }

  let rootDisk = {suppressed: true, class: 'infrastructure'};
  if (!suppressCheck('infrastructure:root-disk', 'infrastructure', {kind: 'infrastructure'})) {
    rootDisk = await auditRootDisk();
    const diskIssue = rootDiskIssue(rootDisk);
    if (diskIssue) issues.push(diskIssue);
  }

  let orderClosure = {suppressed: true, class: 'scheduled'};
  if (!suppressCheck('business:order-closure', 'scheduled', {kind: 'business'})) {
    orderClosure = await auditOrderClosure(args);
    if (orderClosure.state?.error) {
      issues.push(`订单状态复查状态不可读：${orderClosure.state.error}`);
    }
    const stateFinishedAge = hoursSince(orderClosure.state?.finishedAt);
    if (!orderClosure.state?.finishedAt) {
      issues.push('订单状态复查尚未成功运行：state/order_status_recheck_last.json 缺少 finishedAt');
    } else if (orderClosure.state?.dryRun === true) {
      issues.push('订单状态复查最近一次只是 dry-run，尚未真正写入复查层');
    } else if (stateFinishedAge !== null && stateFinishedAge > 26) {
      issues.push(`订单状态复查过期：${orderClosure.state.finishedAt} age=${fmtHours(stateFinishedAge)}，阈值=26h`);
    }
    if (orderClosure.state && orderClosure.state.ok === false) {
      issues.push(`订单状态复查最近一次失败：failedPairs=${orderClosure.state?.totals?.failedPairs ?? '-'} run=${orderClosure.state?.runId || '-'}`);
    } else if (orderClosure.state?.qualityStatus === 'partial') {
      maintenanceNotes.push(`订单状态复查已完成主体数据，少量接口失败保留定向重试：failedPairs=${orderClosure.state?.totals?.failedPairs ?? 0}。`);
    }
    if (!orderClosure.db?.ok) {
      issues.push(`订单闭环 DB 审计失败：${orderClosure.db?.error || 'unknown'}`);
    } else {
      const d = orderClosure.db.data || {};
      if (Number(d.pendingRecheckItems || 0) > 0) {
        issues.push(`订单闭环待复查：items=${d.pendingRecheckItems} pairs=${d.agedOpenPairs || 0} oldest=${d.oldestOpenDate || '-'}`);
      }
      // platformUnclosedItems remains report-only when this scheduled check runs.
    }
  }

  const intentionalSuppressed = [...suppressedById.values()]
    .sort((left, right) => left.id.localeCompare(right.id));
  const maintenancePolicyErrors = [...maintenancePolicyErrorsById.values()]
    .sort((left, right) => left.id.localeCompare(right.id));
  const maintenanceConfigurationIssue = watchdogMaintenanceConfigurationIssue(
    maintenance,
    maintenancePolicyErrors,
  );
  if (maintenanceConfigurationIssue) issues.unshift(maintenanceConfigurationIssue);
  if (maintenance.valid && maintenance.active) {
    maintenanceNotes.push(
      `云端维护模式生效：mode=${maintenance.mode} generation=${maintenance.generation} hash=${maintenance.hash || '-'} intentionalSuppressed=${intentionalSuppressed.length}`,
    );
  } else if (!maintenance.valid) {
    maintenanceNotes.push(
      `云端维护 marker 无效：mode=unknown generation=- hash=${maintenance.hash || '-'} intentionalSuppressed=${intentionalSuppressed.length}`,
    );
  }

  for (const row of Array.isArray(sessionManagerReport?.results) ? sessionManagerReport.results : []) {
    const relativeProbe = String(row?.probe?.reportFile || '').trim();
    const probePath = relativeProbe ? path.resolve(ROOT, relativeProbe) : '';
    const allowedRoot = path.join(ROOT, 'outputs', 'reports') + path.sep;
    if (probePath.startsWith(allowedRoot)) row.probeEvidence = await readJsonIfExists(probePath);
  }
  const issueCollapse = collapseWatchdogRootCauseIssues({issues, sessionReport: sessionManagerReport});
  if (issueCollapse.collapsed) {
    issues.splice(0, issues.length, ...issueCollapse.issues);
    maintenanceNotes.push(`已合并同一登录根因产生的 ${issueCollapse.removedCount} 条重复技术告警。`);
  }
  const notificationSelection = prepareWatchdogNotificationIssues({issues, limit: 12});

  const alertStateFile = path.join(args.stateDir, 'alert-state.json');
  const previousWatchdogReport = await readLatestWatchdogReport(args.logDir);
  let alertState = await readJsonIfExists(alertStateFile);
  let alertStateMigration = null;
  if (!alertState || alertState.error || alertState.schemaVersion !== 'cloud-watchdog-alert-state/v1') {
    const legacyStateFile = path.join(args.stateDir, 'last-issue-key.txt');
    let legacyKey = '';
    try { legacyKey = (await fs.readFile(legacyStateFile, 'utf8')).trim(); } catch {}
    alertState = migrateLegacyWatchdogState({
      legacyKey,
      previousIssues: Array.isArray(previousWatchdogReport?.issues) ? previousWatchdogReport.issues : [],
    });
    alertStateMigration = {
      legacyKeyPresent: Boolean(legacyKey),
      previousIssueCount: Array.isArray(previousWatchdogReport?.issues) ? previousWatchdogReport.issues.length : 0,
      migratedEpisodeCount: Object.keys(alertState.episodes || {}).length,
    };
  }
  const maintenanceAlertHold = detachMaintenanceHeldAlertState(alertState, maintenance);
  const maintenanceConfigurationFirstObservation = Boolean(maintenanceConfigurationIssue)
    && !Object.values(maintenanceAlertHold.activeState.episodes || {}).some(episode =>
      episode.status !== 'resolved'
      && String(episode.lastRaw || '').startsWith('维护模式配置故障（高优先级）'));
  const alertTransition = applyWatchdogAlertState({
    previousState: maintenanceAlertHold.activeState,
    issues,
    force: maintenanceConfigurationFirstObservation
      || (args.force && !(alertStateMigration?.migratedEpisodeCount > 0 && issues.length === 0)),
  });
  const activeAlertState = prepareWatchdogDispatches(alertTransition.nextState);
  const dispatches = pendingWatchdogDispatches(activeAlertState);
  alertState = mergeMaintenanceHeldAlertState(activeAlertState, maintenanceAlertHold.held);
  const alertStateSummary = {
    schemaVersion: alertState.schemaVersion,
    episodeCount: Object.keys(alertState.episodes || {}).length,
    pendingIssueCount: alertTransition.pendingIssues.length,
    activeIssueCount: alertTransition.activeIssues.length,
    pendingDispatchCount: dispatches.length,
    maintenanceHeldIssueCount: maintenanceAlertHold.heldFamilies.length,
    maintenanceHeldFamilies: maintenanceAlertHold.heldFamilies,
    migration: alertStateMigration,
  };

  const report = {
    ok: issues.length === 0,
    generatedAt: new Date().toISOString(),
    issues,
    maintenanceNotes,
    maintenance: {
      schemaVersion: maintenance.schemaVersion,
      status: maintenance.valid ? (maintenance.active ? 'active' : 'inactive') : 'invalid',
      valid: maintenance.valid,
      active: maintenance.active,
      mode: maintenance.mode,
      generation: maintenance.generation,
      hash: maintenance.hash,
      markerFile: maintenance.markerFile,
      errorCode: maintenance.errorCode,
      configurationFault: Boolean(maintenanceConfigurationIssue),
      intentionalSuppressed,
      recoveryCreated: maintenanceTransition.recoveryCreated
        ? {
            key: maintenanceTransition.recoveryCreated.key,
            from: maintenanceTransition.recoveryCreated.from,
            to: maintenanceTransition.recoveryCreated.to,
          }
        : null,
      recoveryPending: maintenanceState.pendingRecovery
        ? {
            key: maintenanceState.pendingRecovery.key,
            createdAt: maintenanceState.pendingRecovery.createdAt,
            attemptCount: maintenanceState.pendingRecovery.attemptCount,
          }
        : null,
      dryRunStateWriteSuppressed: args.dryRun,
    },
    maintenanceGuardAudit,
    recoveries,
    deployedRelease,
    deployedReleaseValidation,
    deploymentEvidence,
    releaseSourceState,
    dailyRefresh,
    linkBusinessSuccess,
    dailyRefreshRecovery,
    sessionManagerManualRecovery,
    productReconciliationHealth,
    issueCollapse,
    notificationSelection,
    alertStateSummary,
    pendingIssues: alertTransition.pendingIssues,
    alertNotifications: dispatches.filter(row => row.kind === 'alert').map(row => ({
      id: row.id, kind: row.kind, intentCount: row.intentIds.length, createdAt: row.createdAt, status: row.status,
    })),
    recoveryNotifications: dispatches.filter(row => row.kind === 'recovery').map(row => ({
      id: row.id, kind: row.kind, intentCount: row.intentIds.length, createdAt: row.createdAt, status: row.status,
    })),
    marketingGuardState,
    marketingGuardLastOkState,
    marketingGuardService,
    marketingGuardHealth,
    marketingRepairQueue,
    marketingRepairState,
    marketingRepairService,
    marketingRepairHealth,
    morningChainLatest,
    portal,
    coverage,
    orphanStoreBrowsers,
    rootDisk,
    orderClosure,
    units,
    timers,
    runtimeProbe: {
      systemctlCommandCount: systemdSnapshot.commandCount,
      requestedUnitCount: systemdSnapshot.requested.length,
      effectiveControls,
    },
  };
  if (!args.dryRun) await fs.writeFile(logFile, JSON.stringify(report, null, 2), 'utf8');

  const notificationOutcomes = [];
  if (!args.dryRun) {
    await persistWatchdogMaintenanceState(maintenanceStateFile, maintenanceState);
    await writeJsonAtomic(alertStateFile, alertState);
    let maintenanceRecovery = maintenance.valid === true && maintenance.active === false
      ? maintenanceState.pendingRecovery
      : null;
    let maintenanceRecoveryCoalesced = false;
    for (const dispatch of dispatches) {
      const raws = dispatch.intentIds.map(id => alertState.outbox?.[id]?.raw).filter(Boolean);
      const selected = prepareWatchdogNotificationIssues({issues: raws, limit: 12});
      const merged = dispatch.kind === 'recovery' && !maintenanceRecoveryCoalesced
        ? mergeMaintenanceRecoveryNotification(selected.issues, maintenanceRecovery)
        : {issues: selected.issues, coalesced: false};
      if (merged.coalesced) {
        maintenanceState = bindWatchdogMaintenanceRecoveryDelivery(
          maintenanceState,
          maintenanceRecovery.key,
          dispatch.idempotencyKey,
        );
        maintenanceRecovery = maintenanceState.pendingRecovery;
        // Persist the shared delivery key before the external send. If the
        // process crashes after delivery, every retry path reuses this key.
        await persistWatchdogMaintenanceState(maintenanceStateFile, maintenanceState);
      }
      const result = await notify(args, merged.issues.join('\n'), logFile, {
        kind: dispatch.kind === 'recovery' ? 'cloud-watchdog-recovery' : 'cloud-watchdog',
        idempotencyKey: dispatch.idempotencyKey,
      });
      if (result.ok) alertState = markWatchdogDispatchSent(alertState, dispatch.id);
      else alertState = markWatchdogDispatchAttempt(alertState, dispatch.id);
      await writeJsonAtomic(alertStateFile, alertState);
      if (merged.coalesced) {
        maintenanceState = result.ok
          ? markWatchdogMaintenanceRecoverySent(maintenanceState, maintenanceRecovery.key)
          : markWatchdogMaintenanceRecoveryAttempt(maintenanceState, maintenanceRecovery.key);
        await persistWatchdogMaintenanceState(maintenanceStateFile, maintenanceState);
        maintenanceRecoveryCoalesced = true;
      }
      notificationOutcomes.push({
        dispatchId: dispatch.id,
        kind: dispatch.kind,
        ok: result.ok,
        code: result.code,
        maintenanceRecoveryCoalesced: merged.coalesced,
      });
    }
    if (maintenanceRecovery && !maintenanceRecoveryCoalesced) {
      const result = await notify(
        args,
        `云端维护模式已恢复：mode=${maintenanceRecovery.from.mode} generation=${maintenanceRecovery.from.generation} hash=${maintenanceRecovery.from.hash}`,
        logFile,
        {
          kind: 'cloud-watchdog-recovery',
          idempotencyKey: maintenanceRecovery.deliveryIdempotencyKey || maintenanceRecovery.idempotencyKey,
        },
      );
      maintenanceState = result.ok
        ? markWatchdogMaintenanceRecoverySent(maintenanceState, maintenanceRecovery.key)
        : markWatchdogMaintenanceRecoveryAttempt(maintenanceState, maintenanceRecovery.key);
      await persistWatchdogMaintenanceState(maintenanceStateFile, maintenanceState);
      notificationOutcomes.push({
        dispatchId: maintenanceRecovery.key,
        kind: 'maintenance-recovery',
        ok: result.ok,
        code: result.code,
      });
    }
    // The legacy file is retained only as a readable compatibility marker.
    await fs.writeFile(path.join(args.stateDir, 'last-issue-key.txt'), issues.length ? 'STATE_V1' : 'OK', 'utf8');
  }
  const finalReport = {
    ...report,
    maintenance: {
      ...report.maintenance,
      recoveryPending: maintenanceState.pendingRecovery
        ? {
            key: maintenanceState.pendingRecovery.key,
            createdAt: maintenanceState.pendingRecovery.createdAt,
            attemptCount: maintenanceState.pendingRecovery.attemptCount,
          }
        : null,
      lastRecoveryKey: maintenanceState.lastRecoveryKey || '',
      lastRecoveryAt: maintenanceState.lastRecoveryAt || null,
    },
    notificationOutcomes,
    notified: notificationOutcomes.some(row => row.ok),
    notifyCode: notificationOutcomes.find(row => !row.ok)?.code ?? (notificationOutcomes.length ? 0 : null),
  };
  if (!args.dryRun) await fs.writeFile(logFile, JSON.stringify(finalReport, null, 2), 'utf8');
  console.log(JSON.stringify({...finalReport, logFile}, null, 2));
  if (issues.length) process.exitCode = args.dryRun ? 0 : 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.dryRun) {
    // A dry-run is a strictly zero-write inspection: it must never create the
    // single-instance lock, its ticket directory, state markers, caches, or
    // logs. Taking the cross-process lock would write the lock ticket queue,
    // so a dry-run bypasses the lock entirely and only reads.
    await runWatchdog(args);
    return;
  }
  const outcome = await withWatchdogSingleInstance(
    args,
    () => runWatchdog(args),
    {lockTimeoutMs: args.lockTimeoutMs},
  );
  if (outcome.skipped) {
    console.log(JSON.stringify({
      ok: true,
      skipped: true,
      alreadyRunning: true,
      reason: 'another cloud_ops_watchdog instance is already running',
      lockPath: outcome.lockPath,
    }));
    return;
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch(err => {
    console.error(err?.stack || String(err));
    process.exitCode = 1;
  });
}
