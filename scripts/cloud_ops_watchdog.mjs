#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import {
  assessDailyMarketingScanRecovery,
  resolveMarketingScanEvidencePath,
} from '../lib/cloud_watchdog_recovery.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_STATE_DIR = path.join(ROOT, 'state', 'cloud_ops_watchdog');
const DEFAULT_LOG_DIR = process.env.SHEIN_CLOUD_WATCHDOG_LOG_DIR || '/srv/shein-bi/logs/cloud-watchdog';
const UNIT_NAMES = [
  'shein-bi-cloud-today.service',
  'shein-bi-cloud-yesterday.service',
  'shein-bi-db-backup.service',
  'shein-bi-cloud-et-forwarder.service',
  'shein-bi-cloud-daily-refresh.service',
  'shein-bi-cloud-session-manager.service',
  'shein-bi-cloud-morning-chain.service',
  'shein-bi-cloud-order-closure.service',
];
const TIMER_NAMES = [
  'shein-bi-cloud-today.timer',
  'shein-bi-cloud-yesterday.timer',
  'shein-bi-db-backup.timer',
  'shein-bi-cloud-et-forwarder.timer',
  'shein-bi-cloud-morning-chain.timer',
  'shein-bi-cloud-session-manager.timer',
  'shein-bi-cloud-order-closure.timer',
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
  const res = await run('systemctl', ['show', name, '--no-pager', '--property=LoadState,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus,StateChangeTimestamp,ExecMainStartTimestamp,ExecMainExitTimestamp']);
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


async function readJsonIfExists(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    return {error: String(err?.message || err)};
  }
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
  const res = await run(process.execPath, [
    'scripts/audit_cloud_data_coverage.mjs',
    '--recent-days', '1',
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
  LEFT JOIN ops.order_status_recheck_state rs
    ON rs.order_item_key = oi.order_item_key
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
  const recoveries = [];
  const serviceExitAcks = await readServiceExitAcks();
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
    if (abnormalState || (abnormalExit && !acknowledgedExit)) {
      issues.push(`服务异常：${unit} state=${status.ActiveState || '-'} result=${status.Result || '-'} exit=${status.ExecMainStatus || '-'} code=${status.ExecMainCode || '-'}`);
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

  const partialLinkBusiness = await readJsonIfExists(path.join(ROOT, 'state', 'cloud_ops_alerts', 'link-business-last-partial.json'));
  if (partialLinkBusiness?.error) {
    issues.push(`链接/业务域部分失败状态不可读：${partialLinkBusiness.error}`);
  } else if (partialLinkBusiness?.failedStores) {
    issues.push(`链接/业务域日更部分店铺失败：date=${partialLinkBusiness.date || '-'} failed=${partialLinkBusiness.failedStores || '-'} log=${partialLinkBusiness.logFile || '-'}`);
  }
  const dailyRefresh = await readJsonIfExists(path.join(ROOT, 'state', 'cloud_ops_alerts', 'daily-refresh-last.json'));
  let dailyRefreshRecovery = null;
  if (dailyRefresh?.error) {
    issues.push(`日更补采状态不可读：${dailyRefresh.error}`);
  } else if (dailyRefresh?.status && dailyRefresh.status !== 'ok' && !String(dailyRefresh.status).startsWith('skipped')) {
    const guardState = await readJsonIfExists(path.join(ROOT, 'state', 'cloud_ops_alerts', 'marketing-live-guard-last.json'));
    const storeConfig = await readJsonIfExists(path.join(ROOT, 'config', 'stores.json'));
    const scanFile = resolveMarketingScanEvidencePath(ROOT, guardState?.scanFile);
    const scanSnapshot = scanFile ? await readJsonIfExists(scanFile) : null;
    const configuredStores = Array.isArray(storeConfig?.stores) ? storeConfig.stores : [];
    dailyRefreshRecovery = scanFile
      ? assessDailyMarketingScanRecovery({
          dailyRefresh,
          guardState,
          scanSnapshot,
          expectedStoreKeys: configuredStores.filter(store => store?.enabled !== false).map(store => store?.storeKey),
        })
      : {recovered: false, reason: 'recovery_scan_path_invalid'};
    if (dailyRefreshRecovery.recovered) {
      recoveries.push(dailyRefreshRecovery.evidence);
    } else {
      issues.push(`日更补采异常：date=${dailyRefresh.date || '-'} status=${dailyRefresh.status} message=${dailyRefresh.message || '-'} log=${dailyRefresh.logFile || '-'}`);
    }
  }

  const portal = await readPortalDates(args.portalData);
  if (portal.error) {
    issues.push(`BI 数据文件不可读：${portal.error}`);
  } else {
    const generatedAge = hoursSince(portal.generatedAt);
    const salesAge = hoursSince(portal.dates?.salesUpdatedAt);
    const businessAge = hoursSince(portal.dates?.businessUpdatedAt);
    const linkAge = hoursSince(portal.dates?.linkUpdatedAt);
    const etAge = hoursSince(portal.dates?.etUpdatedAt);
    if (generatedAge === null || generatedAge > 4.5) issues.push(`BI 页面生成过期：${portal.generatedAt || '-'} age=${fmtHours(generatedAge)}，阈值=4.5h`);
    if (salesAge === null || salesAge > 4.5) issues.push(`SHEIN 销售源过期：${portal.dates?.salesUpdatedAt || '-'} age=${fmtHours(salesAge)}，阈值=4.5h`);
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

  const report = {
    ok: issues.length === 0,
    generatedAt: new Date().toISOString(),
    issues,
    recoveries,
    dailyRefresh,
    dailyRefreshRecovery,
    portal,
    coverage,
    orphanStoreBrowsers,
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
