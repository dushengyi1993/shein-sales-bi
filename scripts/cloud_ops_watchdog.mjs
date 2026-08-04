#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import {
  assessDailyLinkBusinessRecovery,
  assessDailyMarketingGuardHealth,
  assessDailyMarketingRepairHealth,
  assessDailyMarketingScanRecovery,
  assessDailyOpenapiSalesRecovery,
  assessDailyOpenapiProductRecovery,
  resolveMarketingScanEvidencePath,
} from '../lib/cloud_watchdog_recovery.mjs';
import {collapseWatchdogRootCauseIssues} from '../lib/cloud_watchdog_issue_collapse.mjs';
import {assessSessionManagerManualRecovery} from '../lib/cloud_manual_login_recovery.mjs';
import {inspectReleaseSourceState} from './check_release_source_state.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_STATE_DIR = path.join(ROOT, 'state', 'cloud_ops_watchdog');
const DEFAULT_LOG_DIR = process.env.SHEIN_CLOUD_WATCHDOG_LOG_DIR || '/srv/shein-bi/logs/cloud-watchdog';
const UNIT_NAMES = [
  'shein-bi-portal.service',
  'shein-bi-webhook.service',
  'shein-bi-cloud-yesterday.service',
  'shein-bi-db-backup.service',
  'shein-bi-cloud-et-forwarder.service',
  'shein-bi-cloud-daily-refresh.service',
  'shein-bi-cloud-session-manager.service',
  'shein-bi-cloud-openapi-stock-refresh.service',
  'shein-bi-cloud-today-sales-reconcile.service',
  'shein-bi-cloud-manual-login-recovery.service',
  'shein-bi-cloud-morning-chain.service',
  'shein-bi-cloud-morning-link-chunk-2.service',
  'shein-bi-cloud-morning-supplements.service',
  'shein-bi-cloud-rtv-verify.service',
  'shein-bi-cloud-order-closure.service',
  'shein-bi-daily-inventory-replenishment-guard.service',
  'shein-bi-cloud-portal-section-queue.service',
  'shein-bi-cloud-et-storage-fee.service',
  'shein-bi-cloud-disk-maintenance.service',
];
const ALWAYS_RUNNING_UNITS = new Set(['shein-bi-portal.service', 'shein-bi-webhook.service']);
const TIMER_NAMES = [
  'shein-bi-cloud-yesterday.timer',
  'shein-bi-db-backup.timer',
  'shein-bi-cloud-et-forwarder.timer',
  'shein-bi-cloud-morning-chain.timer',
  'shein-bi-cloud-session-manager.timer',
  'shein-bi-cloud-openapi-stock-refresh.timer',
  'shein-bi-cloud-today-sales-reconcile.timer',
  'shein-bi-cloud-manual-login-recovery.timer',
  'shein-bi-cloud-morning-link-chunk-2.timer',
  'shein-bi-cloud-morning-supplements.timer',
  'shein-bi-cloud-rtv-verify.timer',
  'shein-bi-cloud-order-closure.timer',
  'shein-bi-daily-inventory-replenishment-guard.timer',
  'shein-bi-cloud-portal-section-queue.timer',
  'shein-bi-cloud-et-storage-fee.timer',
  'shein-bi-cloud-marketing-live-guard.timer',
  'shein-bi-cloud-marketing-repair.timer',
  'shein-bi-cloud-browser-cleanup.timer',
  'shein-bi-cloud-disk-maintenance.timer',
  'shein-bi-cloud-watchdog.timer',
];

function parseArgs(argv) {
  const args = {
    stateDir: DEFAULT_STATE_DIR,
    logDir: DEFAULT_LOG_DIR,
    portalData: path.join(ROOT, 'outputs', 'bi-portal', 'data.json'),
    dryRun: false,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--state-dir') args.stateDir = path.resolve(argv[++i]);
    else if (a === '--log-dir') args.logDir = path.resolve(argv[++i]);
    else if (a === '--portal-data') args.portalData = path.resolve(argv[++i]);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--force') args.force = true;
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

async function systemctlShow(name) {
  const res = await run('systemctl', ['show', name, '--no-pager', '--property=LoadState,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus,StateChangeTimestamp,ActiveEnterTimestamp,ExecMainStartTimestamp,ExecMainExitTimestamp']);
  const data = {};
  for (const line of String(res.stdout || '').split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx > 0) data[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return {name, ok: res.ok, code: res.code, ...data, stderr: res.stderr};
}

function parseDate(value) {
  if (!value) return null;
  const raw = String(value).replace(' ', 'T');
  const d = new Date(raw.includes('+') || raw.endsWith('Z') ? raw : `${raw}+08:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function hoursSince(value) {
  const d = parseDate(value);
  if (!d) return null;
  return (Date.now() - d.getTime()) / 36e5;
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
    else if (!semantic || semantic.policyVersion !== 'openapi-current-webhook-previous/v1') messages.push(`${storeKey} 店商品对账仍是旧口径或缺少语义结果；请重跑。`);
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

function makeIssueKey(issues) {
  return crypto.createHash('sha1').update(JSON.stringify(issues)).digest('hex').slice(0, 24);
}

async function notify(args, message, logFile) {
  return await run(process.execPath, [
    'scripts/notify_sync_issue.mjs',
    '--kind', 'cloud-watchdog',
    '--mode', 'watchdog',
    '--message', message,
    '--log-file', logFile,
    '--force',
  ]);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await fs.mkdir(args.stateDir, {recursive: true});
  await fs.mkdir(args.logDir, {recursive: true});
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const logFile = path.join(args.logDir, `watchdog-${stamp}.json`);

  const issues = [];
  const maintenanceNotes = [];
  const recoveries = [];
  const deployedRelease = await readJsonIfExists(
    process.env.SHEIN_BI_DEPLOYED_RELEASE_FILE || '/srv/shein-bi/runtime/deployed_release.json',
  );
  let releaseSourceState;
  try {
    releaseSourceState = inspectReleaseSourceState({
      cwd: ROOT,
      expectedCommit: deployedRelease?.commit || '',
    });
    const sourceIntegrityBroken = releaseSourceState.commitMatches !== true
      || releaseSourceState.missingTrackedFiles.length > 0;
    if (sourceIntegrityBroken) {
      issues.push(
        `云端源码不一致：commitMatch=${releaseSourceState.commitMatches} dirty=${releaseSourceState.dirtyEntries.length} `
        + `hidden=${releaseSourceState.hiddenIndexEntries.length} missing=${releaseSourceState.missingTrackedFiles.length}`,
      );
    } else if (releaseSourceState.dirtyEntries.length || releaseSourceState.hiddenIndexEntries.length) {
      maintenanceNotes.push(
        `服务器运行目录有未发布改动：dirty=${releaseSourceState.dirtyEntries.length} `
        + `hidden=${releaseSourceState.hiddenIndexEntries.length}；版本号一致且正式文件完整，不向运营群报警`,
      );
    }
  } catch (error) {
    releaseSourceState = {ok: false, error: String(error?.message || error)};
    issues.push(`云端源码一致性检查失败：${releaseSourceState.error}`);
  }
  const storeConfig = await readJsonIfExists(path.join(ROOT, 'config', 'stores.json'));
  const expectedStoreKeys = (Array.isArray(storeConfig?.stores) ? storeConfig.stores : [])
    .filter(store => store?.enabled !== false)
    .map(store => store?.storeKey);
  const productReport = await readJsonIfExists(path.join(ROOT, 'state', 'openapi-probes', 'product-reconciliation.latest.json'));
  const productReconciliationHealth = assessOpenapiProductReport(productReport, expectedStoreKeys);
  if (!productReconciliationHealth.healthy) {
    for (const message of productReconciliationHealth.messages) issues.push(`商品 OpenAPI 对账需处理：${message}`);
  }
  const serviceExitAcks = await readServiceExitAcks();
  const sessionManagerReport = await readJsonIfExists(path.join(ROOT, 'outputs', 'reports', 'cloud-session-manager-latest.json'));
  const manualLoginState = await readJsonIfExists(
    process.env.SHEIN_MANUAL_LOGIN_STATE_FILE || '/srv/shein-bi/runtime/cloud_manual_login_sessions.json',
  );
  let sessionManagerManualRecovery = {recovered: false, reason: 'session_manager_unit_not_checked'};
  const units = [];
  for (const unit of UNIT_NAMES) {
    const status = await systemctlShow(unit);
    units.push(status);
    if (status.LoadState === 'not-found') continue;
    const exitStatus = String(status.ExecMainStatus || '');
    const resultOk = !status.Result || status.Result === 'success';
    const abnormalExit = status.ActiveState !== 'active' && !resultOk && exitStatus && exitStatus !== '0';
    const abnormalState = status.ActiveState === 'failed' || !resultOk;
    const acknowledgedExit = abnormalExit && !abnormalState && serviceExitAcks.has(serviceExitAckKey(status));
    status.serviceExitAcknowledged = acknowledgedExit;
    const isSessionManager = unit === 'shein-bi-cloud-session-manager.service';
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
      } else {
        issues.push(`服务异常：${unit} state=${status.ActiveState || '-'} result=${status.Result || '-'} exit=${status.ExecMainStatus || '-'} code=${status.ExecMainCode || '-'}`);
      }
    }
  }
  const timers = [];
  for (const timer of TIMER_NAMES) {
    const status = await systemctlShow(timer);
    timers.push(status);
    if (status.LoadState === 'not-found') continue;
    if (status.ActiveState !== 'active') {
      issues.push(`定时器未运行：${timer} state=${status.ActiveState || '-'} result=${status.Result || '-'}`);
    }
  }

  const marketingGuardState = await readJsonIfExists(path.join(ROOT, 'state', 'cloud_ops_alerts', 'marketing-live-guard-last.json'));
  const marketingGuardLastOkState = await readJsonIfExists(path.join(ROOT, 'state', 'cloud_ops_alerts', 'marketing-live-guard-last-ok.json'));
  const marketingGuardService = await systemctlShow('shein-bi-cloud-marketing-live-guard.service');
  const marketingGuardHealth = assessDailyMarketingGuardHealth({
    guardState: marketingGuardState,
    lastOkState: marketingGuardLastOkState,
    guardRunning: ['active', 'activating', 'reloading'].includes(marketingGuardService.ActiveState),
    guardStartedAt: marketingGuardService.ExecMainStartTimestamp || marketingGuardService.ActiveEnterTimestamp,
  });
  if (!marketingGuardHealth.healthy) {
    issues.push(`营销无人值守守卫未完成：date=${marketingGuardHealth.today} reason=${marketingGuardHealth.reason} lastStatus=${marketingGuardState?.status || '-'} lastDate=${marketingGuardState?.date || '-'} message=${marketingGuardState?.message || '-'}`);
  }
  const marketingRepairQueue = await readJsonIfExists(path.join(ROOT, 'state', 'cloud_marketing_live_guard', 'repair-queues', `marketing-repair-${marketingGuardHealth.today}.json`));
  const marketingRepairState = await readJsonIfExists(path.join(ROOT, 'state', 'cloud_ops_alerts', 'marketing-repair-last.json'));
  const marketingRepairService = await systemctlShow('shein-bi-cloud-marketing-repair.service');
  const marketingRepairHealth = assessDailyMarketingRepairHealth({
    queueState: marketingRepairQueue,
    repairState: marketingRepairState,
    repairRunning: ['active', 'activating', 'reloading'].includes(marketingRepairService.ActiveState),
    repairStartedAt: marketingRepairService.ExecMainStartTimestamp || marketingRepairService.ActiveEnterTimestamp,
  });
  if (!marketingRepairHealth.healthy) {
    issues.push(`营销修复队列未闭环：date=${marketingRepairHealth.today} reason=${marketingRepairHealth.reason} queueStatus=${marketingRepairQueue?.status || '-'} rows=${marketingRepairQueue?.counts?.totalRows ?? '-'} groups=${marketingRepairQueue?.counts?.totalGroups ?? '-'} workerStatus=${marketingRepairState?.status || '-'}`);
  }

  const partialLinkBusiness = await readJsonIfExists(path.join(ROOT, 'state', 'cloud_ops_alerts', 'link-business-last-partial.json'));
  if (partialLinkBusiness?.error) {
    issues.push(`链接/业务域部分失败状态不可读：${partialLinkBusiness.error}`);
  } else if (partialLinkBusiness?.failedStores) {
    issues.push(`链接/业务域日更部分店铺失败：date=${partialLinkBusiness.date || '-'} failed=${partialLinkBusiness.failedStores || '-'} log=${partialLinkBusiness.logFile || '-'}`);
  }
  const dailyRefresh = await readJsonIfExists(path.join(ROOT, 'state', 'cloud_ops_alerts', 'daily-refresh-last.json'));
  const linkBusinessSuccess = await readJsonIfExists(path.join(ROOT, 'state', 'cloud_ops_alerts', 'link-business-last-success.json'));
  let dailyRefreshRecovery = null;
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
    dailyRefreshRecovery = linkRecovery.recovered
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
              },
            };
    if (dailyRefreshRecovery.recovered) {
      recoveries.push(dailyRefreshRecovery.evidence);
    } else {
      issues.push(`日更补采异常：date=${dailyRefresh.date || '-'} status=${dailyRefresh.status} message=${dailyRefresh.message || '-'} log=${dailyRefresh.logFile || '-'}`);
    }
  }

  const portal = await readPortalDates(args.portalData);
  const portalRuntime = await readPortalRuntimeHealth();
  if (portal.error) {
    issues.push(`BI 数据文件不可读：${portal.error}`);
  } else {
    const generatedAge = hoursSince(portal.generatedAt);
    const salesTimestamp = newerTimestamp(
      portal.dates?.salesUpdatedAt,
      portalRuntime?.liveUpdates?.lastOrderAt,
    );
    const salesAge = hoursSince(salesTimestamp);
    const businessAge = hoursSince(portal.dates?.businessUpdatedAt);
    const linkAge = hoursSince(portal.dates?.linkUpdatedAt);
    const etAge = hoursSince(portal.dates?.etUpdatedAt);
    if (generatedAge === null || generatedAge > 30) issues.push(`BI 页面底稿过期：${portal.generatedAt || '-'} age=${fmtHours(generatedAge)}，阈值=30h`);
    if (salesAge === null || salesAge > 30) issues.push(`SHEIN 销售数据过期：${salesTimestamp || '-'} age=${fmtHours(salesAge)}，阈值=30h`);
    if (!portalRuntime) {
      issues.push('BI 实时运行状态不可读：Portal /api/health 无响应');
    }
    if (portalRuntime?.liveUpdates?.enabled === true && portalRuntime.liveUpdates.connected !== true) {
      issues.push(`BI 实时更新通道未连接：channel=${portalRuntime.liveUpdates.channel || '-'} error=${portalRuntime.liveUpdates.lastError || '-'}`);
    }
    // 业务域/链接表现是低频日更，不按销售高频阈值判断。
    if (businessAge === null || businessAge > 48) issues.push(`SHEIN 业务域日更过期：${portal.dates?.businessUpdatedAt || '-'} age=${fmtHours(businessAge)}，阈值=48h`);
    if (linkAge === null || linkAge > 48) issues.push(`SHEIN 链接表现日更过期：${portal.dates?.linkUpdatedAt || '-'} age=${fmtHours(linkAge)}，阈值=48h`);
    if (etAge === null || etAge > 36) issues.push(`ET 货代仓过期：${portal.dates?.etUpdatedAt || '-'} age=${fmtHours(etAge)}，阈值=36h`);
  }

  const coverage = await auditRecentCoverage();
  if (coverage.error) {
    issues.push(`BI 日期×店铺覆盖审计失败：${coverage.error}`);
  } else {
    for (const check of coverage.checks || []) {
      for (const issue of check.issues || []) {
        issues.push(`BI 覆盖不足：${issue}`);
      }
    }
  }

  const orphanStoreBrowsers = await auditOrphanStoreBrowsers();
  if (orphanStoreBrowsers.error) {
    issues.push(`SHEIN 店铺浏览器残留审计失败：${orphanStoreBrowsers.error}`);
  } else if (Number(orphanStoreBrowsers.orphanCount || 0) > 0) {
    const sample = (orphanStoreBrowsers.processes || [])
      .slice(0, 6)
      .map(p => `${p.storeKey}:pid=${p.pid},age=${fmtHours((p.ageMin || 0) / 60)},rss=${Math.round((p.rssKb || 0) / 1024)}MiB`)
      .join('; ');
    issues.push(`SHEIN 店铺浏览器残留：count=${orphanStoreBrowsers.orphanCount} threshold=${orphanStoreBrowsers.maxAgeMin}min ${sample}`);
  }

  const rootDisk = await auditRootDisk();
  const diskIssue = rootDiskIssue(rootDisk);
  if (diskIssue) issues.push(diskIssue);

  const orderClosure = await auditOrderClosure(args);
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
  }
  if (!orderClosure.db?.ok) {
    issues.push(`订单闭环 DB 审计失败：${orderClosure.db?.error || 'unknown'}`);
  } else {
    const d = orderClosure.db.data || {};
    if (Number(d.pendingRecheckItems || 0) > 0) {
      issues.push(`订单闭环待复查：items=${d.pendingRecheckItems} pairs=${d.agedOpenPairs || 0} oldest=${d.oldestOpenDate || '-'}`);
    }
    // platformUnclosedItems means the recheck layer has fresh evidence, but SHEIN still returns
    // a non-terminal status or no longer returns the historical order. Keep it in the JSON report
    // for operations follow-up, but do not page Feishu unless pending/stale/failed checks above fire.
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

  const report = {
    ok: issues.length === 0,
    generatedAt: new Date().toISOString(),
    issues,
    maintenanceNotes,
    recoveries,
    deployedRelease,
    releaseSourceState,
    dailyRefresh,
    linkBusinessSuccess,
    dailyRefreshRecovery,
    sessionManagerManualRecovery,
    productReconciliationHealth,
    issueCollapse,
    marketingGuardState,
    marketingGuardLastOkState,
    marketingGuardService,
    marketingGuardHealth,
    marketingRepairQueue,
    marketingRepairState,
    marketingRepairService,
    marketingRepairHealth,
    portal,
    coverage,
    orphanStoreBrowsers,
    rootDisk,
    orderClosure,
    units,
    timers,
  };
  await fs.writeFile(logFile, JSON.stringify(report, null, 2), 'utf8');

  const issueKey = makeIssueKey(issues);
  const stateFile = path.join(args.stateDir, 'last-issue-key.txt');
  let previous = '';
  try { previous = (await fs.readFile(stateFile, 'utf8')).trim(); } catch {}
  let notified = false;
  let notifyResult = null;
  if (!args.dryRun && issues.length && (args.force || issueKey !== previous)) {
    const text = issues.slice(0, 12).join('\n');
    notifyResult = await notify(args, text, logFile);
    notified = notifyResult.ok;
    if (notifyResult.ok) await fs.writeFile(stateFile, issueKey, 'utf8');
  } else if (!args.dryRun && !issues.length) {
    await fs.writeFile(stateFile, 'OK', 'utf8');
  }

  console.log(JSON.stringify({...report, logFile, notified, notifyCode: notifyResult?.code ?? null}, null, 2));
  if (issues.length) process.exitCode = args.dryRun ? 0 : 1;
}

main().catch(err => {
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});
