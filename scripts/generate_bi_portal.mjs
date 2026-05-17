#!/usr/bin/env node
/**
 * Generate the local SHEIN BI operating portal from PostgreSQL warehouse marts.
 *
 * Metabase is the deep BI layer. This portal is the daily operating entrance:
 * one page to understand risk, switch between store/product/SKC perspectives,
 * and decide what to do today.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORTAL_GENERATE_TIMEOUT_MS = Number(process.env.SHEIN_BI_PORTAL_TIMEOUT_MS || 900_000);
const portalGenerateStartedAt = Date.now();
let portalGenerateStage = 'bootstrap';
const portalGenerateTimer = setTimeout(() => {
  console.error(`[generate_bi_portal] TIMEOUT after ${Math.round((Date.now() - portalGenerateStartedAt) / 1000)}s stage=${portalGenerateStage}`);
  process.exit(124);
}, PORTAL_GENERATE_TIMEOUT_MS);
portalGenerateTimer.unref?.();

function markStage(stage) {
  portalGenerateStage = stage;
  console.error(`[generate_bi_portal] ${new Date().toISOString()} ${stage}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function writeFileWithRetry(file, data, encoding = 'utf8', attempts = 8) {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      await fs.writeFile(file, data, encoding);
      return;
    } catch (err) {
      const code = String(err?.code || '');
      const retryable = ['UNKNOWN', 'EBUSY', 'EPERM', 'EACCES'].includes(code);
      if (!retryable || i === attempts) throw err;
      markStage(`write:retry:${path.basename(file)}:${i}`);
      await sleep(Math.min(5000, 300 * i));
    }
  }
}

function parseArgs(argv) {
  const args = {
    distro: 'Ubuntu-24.04',
    container: 'shein-warehouse-db',
    database: 'shein_bi',
    user: 'shein',
    outDir: path.join(ROOT, 'outputs', 'bi-portal'),
    metabaseUrl: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--distro') args.distro = argv[++i];
    else if (a === '--container') args.container = argv[++i];
    else if (a === '--database') args.database = argv[++i];
    else if (a === '--user') args.user = argv[++i];
    else if (a === '--out-dir') args.outDir = path.resolve(argv[++i]);
    else if (a === '--metabase-url') args.metabaseUrl = argv[++i];
  }
  return args;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function dockerPrefix() {
  if (process.platform === 'win32') return 'sudo ';
  if (typeof process.getuid === 'function' && process.getuid() === 0) return '';
  return 'sudo ';
}

function psqlSpawnCommand(args, extraFlags = '') {
  const psql = `${dockerPrefix()}docker exec -i ${shellQuote(args.container)} psql -U ${shellQuote(args.user)} -d ${shellQuote(args.database)} -v ON_ERROR_STOP=1${extraFlags}`;
  if (process.platform === 'win32') {
    return {
      command: 'wsl',
      args: ['-d', args.distro, '--', 'bash', '-lc', psql],
    };
  }
  return {
    command: 'bash',
    args: ['-lc', psql],
  };
}

async function readMetabaseUrl() {
  const file = path.join(ROOT, 'infra', 'metabase', '.session.local.json');
  try {
    const j = JSON.parse(await fs.readFile(file, 'utf8'));
    return (j.metabaseUrl || '').replace(/\/$/, '');
  } catch {
    return '';
  }
}

async function readLatestAuditSummary() {
  const dir = path.join(ROOT, 'outputs', 'bi_audit');
  try {
    const files = (await fs.readdir(dir))
      .filter(name => /^bi-audit-.*\.json$/i.test(name))
      .sort()
      .reverse();
    if (!files.length) return null;
    const j = JSON.parse(await fs.readFile(path.join(dir, files[0]), 'utf8'));
    const warnings = Array.isArray(j.warnings) ? j.warnings : (Array.isArray(j.evaluation?.warnings) ? j.evaluation.warnings : []);
    const errors = Array.isArray(j.errors) ? j.errors : (Array.isArray(j.evaluation?.errors) ? j.evaluation.errors : []);
    return {
      file: files[0],
      ok: Boolean(j.ok),
      warnings: warnings.length,
      errors: errors.length,
      warningMessages: warnings,
      errorMessages: errors,
      generatedAt: j.generatedAt || j.createdAt || null,
    };
  } catch {
    return null;
  }
}

async function runWindowsCommand(command, args = [], options = {}) {
  const timeoutMs = Number(options.timeoutMs || 15_000);
  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: ROOT,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({code: -1, stdout: '', stderr: String(err.message || err), timedOut: false, spawnError: true});
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: result.code,
        stdout: stdout.trim(),
        stderr: (result.stderr || stderr).trim(),
        timedOut,
        spawnError: Boolean(result.spawnError),
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch {}
    }, timeoutMs);

    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => finish({code: -1, stderr: String(err.message || err), spawnError: true}));
    child.on('close', code => finish({code}));
  });
}

function parseLogTimes(text) {
  const matches = [...String(text || '').matchAll(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/g)].map(m => m[1]);
  return {startedAt: matches[0] || '', endedAt: matches[matches.length - 1] || ''};
}

async function readTextAuto(file) {
  const buf = await fs.readFile(file);
  if (buf.length >= 2) {
    if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le');
    if (buf[0] === 0xfe && buf[1] === 0xff) return buf.swap16().toString('utf16le');
  }
  const sample = buf.subarray(0, Math.min(buf.length, 200));
  let zeros = 0;
  for (const b of sample) if (b === 0) zeros++;
  if (zeros > sample.length * 0.2) return buf.toString('utf16le');
  return buf.toString('utf8');
}

async function readScheduledTaskStatus() {
  if (process.platform !== 'win32') {
    return {
      exists: false,
      platform: process.platform,
      error: '当前运行环境不是 Windows，已跳过 Windows 计划任务读取；云端定时状态将在 Linux systemd/cron 接入后显示。',
    };
  }
  const ps = [
    '$ErrorActionPreference="Stop"',
    '$name="SHEIN-BI-Daily-Pipeline-0700"',
    '$t=Get-ScheduledTask -TaskName $name',
    '$i=Get-ScheduledTaskInfo -TaskName $name',
    '$next=if($i.NextRunTime){$i.NextRunTime.ToString("yyyy-MM-dd HH:mm:ss")}else{""}',
    '$last=if($i.LastRunTime){$i.LastRunTime.ToString("yyyy-MM-dd HH:mm:ss")}else{""}',
    '$nextMs=if($i.NextRunTime){([DateTimeOffset]$i.NextRunTime).ToUnixTimeMilliseconds()}else{$null}',
    '$lastMs=if($i.LastRunTime){([DateTimeOffset]$i.LastRunTime).ToUnixTimeMilliseconds()}else{$null}',
    '$o=[pscustomobject]@{TaskName=$t.TaskName;State=([string]$t.State);NextRunTime=$next;NextRunEpochMs=$nextMs;LastRunTime=$last;LastRunEpochMs=$lastMs;LastTaskResult=$i.LastTaskResult;Enabled=([string]$t.State -ne "Disabled")}',
    '$o | ConvertTo-Json -Compress',
  ].join(';');
  try {
    const res = await runWindowsCommand('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {timeoutMs: 8_000});
    if (res.timedOut) return await readScheduledTaskStatusViaSchtasks('PowerShell 读取 Windows 计划任务超时');
    if (res.code !== 0 || !res.stdout) return {exists: false, error: res.stderr || `exit ${res.code}`};
    return {exists: true, ...JSON.parse(res.stdout)};
  } catch (err) {
    return await readScheduledTaskStatusViaSchtasks(String(err.message || err));
  }
}

function parseCsvPrefix(line, maxColumns = 8) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < String(line || '').length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === ',' && !quoted) {
      out.push(cur);
      cur = '';
      if (out.length >= maxColumns) return out;
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function normalizeSchtasksDate(text) {
  const m = String(text || '').match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})/);
  if (!m) return text || '';
  return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')} ${String(m[4]).padStart(2, '0')}:${m[5]}:${m[6]}`;
}

function normalizeTaskState(text) {
  const s = String(text || '').trim();
  if (!s || /[\uFFFD锟]/.test(s)) return '';
  return s;
}
function inferTaskState(state, nextRun, lastResult) {
  if (state) return state;
  if (Number(lastResult) === 267009) return 'Running';
  if (nextRun) return 'Ready';
  return '';
}

function epochMsFromLocalText(text) {
  const normalized = normalizeSchtasksDate(text);
  const m = String(normalized || '').match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

async function readScheduledTaskStatusViaSchtasks(reason = '') {
  try {
    const res = await runWindowsCommand('cmd.exe', ['/c', 'schtasks /query /tn SHEIN-BI-Daily-Pipeline-0700 /v /fo csv'], {timeoutMs: 8_000});
    if (res.code !== 0 || !res.stdout) return {exists: false, error: reason || res.stderr || `schtasks exit ${res.code}`};
    const lines = res.stdout.split(/\r?\n/).filter(Boolean);
    const row = lines[1] || '';
    const cols = parseCsvPrefix(row, 8);
    const taskName = String(cols[1] || '').replace(/^\\+/, '') || 'SHEIN-BI-Daily-Pipeline-0700';
    const nextRun = normalizeSchtasksDate(cols[2] || '');
    const lastRun = normalizeSchtasksDate(cols[5] || '');
    const lastResult = Number(cols[6]);
    const state = inferTaskState(normalizeTaskState(cols[3] || ''), nextRun, lastResult);
    return {
      exists: true,
      fallback: 'schtasks',
      fallbackReason: reason || '',
      TaskName: taskName,
      State: state,
      NextRunTime: nextRun,
      NextRunEpochMs: epochMsFromLocalText(nextRun),
      LastRunTime: lastRun,
      LastRunEpochMs: epochMsFromLocalText(lastRun),
      LastTaskResult: Number.isFinite(lastResult) ? lastResult : null,
      Enabled: true,
    };
  } catch (err) {
    return {exists: false, error: reason || String(err.message || err)};
  }
}

function parsePipelineLogSummary(file, text, stat) {
  const times = parseLogTimes(text);
  const effective = text.match(/effective dates salesDate=(\d{4}-\d{2}-\d{2}) linkDate=(\d{4}-\d{2}-\d{2}) businessDate=(\d{4}-\d{2}-\d{2})/);
  const ok = /DONE BI daily pipeline/.test(text) && !/FAIL /.test(text);
  const failed = /FAIL /.test(text);
  const startedMs = times.startedAt ? Date.parse(times.startedAt.replace(' ', 'T')) : NaN;
  const endedMs = times.endedAt ? Date.parse(times.endedAt.replace(' ', 'T')) : NaN;
  const durationSeconds = Number.isFinite(startedMs) && Number.isFinite(endedMs) && endedMs >= startedMs
    ? Math.round((endedMs - startedMs) / 1000)
    : null;
  const warnings = text.split(/\r?\n/).filter(x => /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]\s+WARN\b/.test(x));
  return {
    file,
    ok,
    status: ok ? 'success' : (failed ? 'failed' : 'running_or_incomplete'),
    startedAt: times.startedAt,
    endedAt: times.endedAt,
    durationSeconds,
    effectiveDates: effective ? {salesDate: effective[1], linkDate: effective[2], businessDate: effective[3]} : {},
    warningCount: warnings.length,
    latestWarning: warnings[warnings.length - 1] || '',
    modifiedAt: stat?.mtime ? stat.mtime.toISOString() : '',
    bytes: stat?.size || 0,
    tail: text.split(/\r?\n/).slice(-10).join('\n'),
  };
}

async function readPipelineStatus() {
  const dir = path.join(ROOT, 'logs');
  let latestLog = null;
  let files = [];
  try {
    files = (await fs.readdir(dir))
      .filter(name => /^bi-daily-pipeline-.*\.log$/i.test(name))
      .sort()
      .reverse();
    if (files.length) latestLog = files[0];
  } catch {}

  let log = {
    file: latestLog || '',
    ok: false,
    status: latestLog ? 'unknown' : 'missing',
    startedAt: '',
    endedAt: '',
    effectiveDates: {},
    warnings: [],
    tail: '',
  };
  if (latestLog) {
    const full = path.join(dir, latestLog);
    const text = await readTextAuto(full);
    const summary = parsePipelineLogSummary(latestLog, text, await fs.stat(full).catch(() => null));
    log = {
      ...log,
      ok: summary.ok,
      status: summary.status,
      startedAt: summary.startedAt,
      endedAt: summary.endedAt,
      durationSeconds: summary.durationSeconds,
      effectiveDates: summary.effectiveDates,
      warnings: text.split(/\r?\n/).filter(x => /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]\s+WARN\b/.test(x)).slice(-8),
      tail: summary.tail,
    };
  }
  const recentLogs = [];
  for (const file of files.slice(0, 8)) {
    try {
      const full = path.join(dir, file);
      const stat = await fs.stat(full);
      const text = await readTextAuto(full);
      recentLogs.push(parsePipelineLogSummary(file, text, stat));
    } catch {}
  }
  return {
    latestLog: log,
    recentLogs,
    task: await readScheduledTaskStatus(),
  };
}

async function readLatestBriefingSummary() {
  const rel = path.join('outputs', 'bi-briefings', 'latest.md');
  const file = path.join(ROOT, rel);
  try {
    const st = await fs.stat(file);
    const content = await fs.readFile(file, 'utf8');
    return {
      exists: true,
      file: rel,
      fullPath: file,
      updatedAt: st.mtime.toISOString(),
      bytes: st.size,
      content,
      preview: content.split(/\r?\n/).slice(0, 80).join('\n'),
    };
  } catch {
    return {
      exists: false,
      file: rel,
      fullPath: file,
      updatedAt: '',
      bytes: 0,
      content: '',
      preview: '',
    };
  }
}

async function readLatestFirstRunCheckSummary() {
  const mdRel = path.join('outputs', 'bi_first_run_check', 'latest.md');
  const jsonRel = path.join('outputs', 'bi_first_run_check', 'latest.json');
  const mdFile = path.join(ROOT, mdRel);
  const jsonFile = path.join(ROOT, jsonRel);
  try {
    const [mdStat, jsonStat, content, raw] = await Promise.all([
      fs.stat(mdFile),
      fs.stat(jsonFile),
      fs.readFile(mdFile, 'utf8'),
      fs.readFile(jsonFile, 'utf8'),
    ]);
    const j = JSON.parse(raw);
    return {
      exists: true,
      file: mdRel,
      jsonFile: jsonRel,
      fullPath: mdFile,
      updatedAt: mdStat.mtime.toISOString(),
      jsonUpdatedAt: jsonStat.mtime.toISOString(),
      bytes: mdStat.size,
      status: j.verdict?.status || '',
      errors: Array.isArray(j.verdict?.errors) ? j.verdict.errors.length : 0,
      warnings: Array.isArray(j.verdict?.warnings) ? j.verdict.warnings.length : 0,
      recovery: j.recovery || null,
      scheduledDryRun: j.scheduledDryRun || null,
      scheduledRunLog: j.scheduledRunLog || null,
      latestLog: j.latestLog || null,
      latestLogRelation: j.latestLogRelation || null,
      content,
      preview: content.split(/\r?\n/).slice(0, 80).join('\n'),
    };
  } catch {
    return {
      exists: false,
      file: mdRel,
      jsonFile: jsonRel,
      fullPath: mdFile,
      updatedAt: '',
      jsonUpdatedAt: '',
      bytes: 0,
      status: '',
      errors: 0,
      warnings: 0,
      recovery: null,
      scheduledDryRun: null,
      scheduledRunLog: null,
      latestLog: null,
      latestLogRelation: null,
      content: '',
      preview: '',
    };
  }
}

async function runPsql(args, sql) {
  markStage('psql:start');
  const psql = psqlSpawnCommand(args, ' -t -A');
  const child = spawn(psql.command, psql.args, {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on('data', d => { stdoutChunks.push(Buffer.from(d)); });
  child.stderr.on('data', d => { stderrChunks.push(Buffer.from(d)); });
  child.stdin.write(sql);
  child.stdin.end();
  const timer = setTimeout(() => {
    stderrChunks.push(Buffer.from(`\npsql timeout after ${Math.round(PORTAL_GENERATE_TIMEOUT_MS / 1000)}s stage=${portalGenerateStage}`));
    child.kill();
  }, Math.max(30_000, PORTAL_GENERATE_TIMEOUT_MS - 20_000));
  const code = await new Promise(resolve => child.on('close', resolve));
  clearTimeout(timer);
  const stdout = Buffer.concat(stdoutChunks).toString('utf8');
  const stderr = Buffer.concat(stderrChunks).toString('utf8');
  if (code !== 0) {
    throw new Error(`psql failed (${code})\n${stderr.slice(-4000)}\n${stdout.slice(-2000)}`);
  }
  markStage('psql:done');
  return stdout.trim();
}

async function readOpenApiReconciliation(args) {
  const sql = `
SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY date DESC, store_key), '[]'::jsonb)::text
FROM (
  SELECT
    date,
    store_key,
    status,
    browser_source_file,
    api_source_file,
    browser_order_count,
    api_order_count,
    browser_positive_order_count,
    api_positive_order_count,
    browser_goods_line_count,
    api_goods_line_count,
    round(coalesce(browser_sales_sar,0)::numeric, 2) AS browser_sales_sar,
    round(coalesce(api_sales_sar,0)::numeric, 2) AS api_sales_sar,
    order_count_delta,
    positive_order_count_delta,
    goods_line_count_delta,
    round(coalesce(quantity_positive_delta,0)::numeric, 2) AS quantity_positive_delta,
    round(coalesce(sales_sar_delta,0)::numeric, 2) AS sales_sar_delta,
    browser_only_order_count,
    api_only_order_count,
    browser_only_goods_count,
    api_only_goods_count,
    generated_at
  FROM mart.openapi_sales_reconciliation
  ORDER BY date DESC, store_key
  LIMIT 60
) t;
`;
  try {
    const raw = await runPsql(args, sql);
    return JSON.parse(raw || '[]');
  } catch (err) {
    const message = String(err?.message || err || '');
    if (message.includes('openapi_sales_reconciliation') || message.includes('does not exist') || message.includes('relation')) {
      return [];
    }
    throw err;
  }
}

function htmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sanitizeTextValue(s) {
  return String(s ?? '')
    .replace(/\uFFFD+/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function deepSanitize(value) {
  if (typeof value === 'string') return sanitizeTextValue(value);
  if (Array.isArray(value)) return value.map(deepSanitize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepSanitize(v)]));
  }
  return value;
}

function splitLabelString(value) {
  if (Array.isArray(value)) return value.flatMap(splitLabelString);
  return String(value ?? '')
    .split(/[,;\uFF0C\uFF1B\u3001|/]+/g)
    .map(x => sanitizeTextValue(x))
    .filter(Boolean);
}

function uniqueNonEmpty(values) {
  const out = [];
  const seen = new Set();
  for (const value of values.flatMap(splitLabelString)) {
    if (!value || seen.has(value)) continue;
    if (/^\d+$/.test(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function saleTrendLabelFromRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  if (n > 0.05) return '销量上涨';
  if (n < -0.05) return '销量下滑';
  return '';
}

async function readLatestLinkInventoryMeta(linkDate) {
  const baseDir = path.join(ROOT, 'outputs', 'shein_links');
  const meta = new Map();
  let storeDirs = [];
  try {
    storeDirs = (await fs.readdir(baseDir, {withFileTypes: true})).filter(d => d.isDirectory()).map(d => d.name);
  } catch {
    return meta;
  }
  for (const storeKey of storeDirs) {
    const storeDir = path.join(baseDir, storeKey);
    let file = linkDate ? path.join(storeDir, `${linkDate}.json`) : '';
    try {
      if (!file || !(await fs.stat(file).catch(() => null))) {
        const files = (await fs.readdir(storeDir)).filter(x => /^\d{4}-\d{2}-\d{2}\.json$/i.test(x)).sort().reverse();
        if (!files.length) continue;
        file = path.join(storeDir, files[0]);
      }
      const payload = JSON.parse(await fs.readFile(file, 'utf8'));
      for (const row of payload.inventoryRows || []) {
        if (!row?.skc) continue;
        const key = `${row.storeKey || storeKey}__${row.skc}`;
        const old = meta.get(key) || {};
        meta.set(key, {
          ...old,
          inventory_goods_level: sanitizeTextValue(row.goodsLevel),
          inventory_goods_labels: uniqueNonEmpty([row.goodsLabels]).join(' / '),
          inventory_operate_labels: uniqueNonEmpty([row.operateLabels]).join(' / '),
          inventory_rights_labels: uniqueNonEmpty([row.rightsLabels]).join(' / '),
          inventory_stock_warn_status: sanitizeTextValue(row.stockWarnStatus),
          supply_status: sanitizeTextValue(row.supplyStatus),
          sale_model: sanitizeTextValue(row.saleModel),
          inventory_quality_grade: sanitizeTextValue(row.qualityGrade),
          shelf_days: row.shelfDays ?? old.shelf_days ?? null,
          platform_display_stock: row.platformDisplayStock ?? old.platform_display_stock ?? null,
          platform_saleable_stock: row.platformSaleableStock ?? old.platform_saleable_stock ?? null,
        });
      }
      for (const row of payload.performanceRows || []) {
        if (!row?.skc) continue;
        const key = `${row.storeKey || storeKey}__${row.skc}`;
        const old = meta.get(key) || {};
        meta.set(key, {
          ...old,
          performance_layer_name: sanitizeTextValue(row.layerName),
          performance_new_goods_tag: sanitizeTextValue(row.newGoodsTag),
          performance_activity_tag: sanitizeTextValue(row.activityTag),
          performance_activity_names: uniqueNonEmpty([row.activityNames]).join(' / '),
          performance_total_quality_level: sanitizeTextValue(row.totalQualityLevel),
          performance_sale_trend_label: saleTrendLabelFromRate(row.sale7ChangeRate),
          performance_flow_diagnose_tabs: sanitizeTextValue(row.flowDiagnoseTabs),
          performance_official_operate_buttons: sanitizeTextValue(row.officialOperateButtons),
          performance_sale7_change_rate: row.sale7ChangeRate ?? old.performance_sale7_change_rate ?? null,
          performance_exposure7_change_rate: row.exposure7ChangeRate ?? old.performance_exposure7_change_rate ?? null,
        });
      }
    } catch {
      continue;
    }
  }
  return meta;
}

function enrichLinkRecordWithInventoryMeta(record, meta) {
  if (!record?.skc) return record;
  const extra = meta.get(`${record.store_key || record.storeKey || ''}__${record.skc}`);
  if (!extra) return record;
  const tags = uniqueNonEmpty([
    record.skc_label,
    extra.inventory_goods_level,
    extra.inventory_goods_labels,
    extra.inventory_operate_labels,
    extra.inventory_rights_labels,
    extra.performance_new_goods_tag,
    extra.performance_sale_trend_label,
    extra.performance_total_quality_level,
    extra.performance_flow_diagnose_tabs,
    record.activity_label,
    extra.performance_activity_tag,
    extra.performance_activity_names,
    extra.performance_official_operate_buttons,
  ]);
  return {
    ...record,
    ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined && v !== null && v !== '')),
    skc_label: record.skc_label || extra.inventory_goods_level || extra.performance_layer_name || extra.performance_new_goods_tag || '',
    activity_label: record.activity_label || extra.performance_activity_tag || extra.performance_activity_names || '',
    quality_grade: record.quality_grade || extra.performance_total_quality_level || extra.inventory_quality_grade || '',
    skc_tags: tags,
  };
}

async function enrichPortalDataWithLocalLinkLabels(data) {
  const linkDate = data?.dates?.linkDate || '';
  const businessDate = data?.dates?.businessDate || '';
  const readSourceFetchTimes = async (subdir, date) => {
    if (!date) return [];
    const fetchTimes = [];
    try {
      const baseDir = path.join(ROOT, 'outputs', subdir);
      const dirs = (await fs.readdir(baseDir, {withFileTypes: true})).filter(d => d.isDirectory()).map(d => d.name);
      for (const storeKey of dirs) {
        const file = path.join(baseDir, storeKey, `${date}.json`);
        try {
          const payload = JSON.parse(await fs.readFile(file, 'utf8'));
          if (payload?.fetchTime) fetchTimes.push(String(payload.fetchTime));
        } catch {}
      }
    } catch {}
    return fetchTimes;
  };

  const sourceDatePatch = {};
  const businessFetchTimes = await readSourceFetchTimes('shein_business_domains', businessDate);
  if (businessFetchTimes.length) {
    sourceDatePatch.businessUpdatedAt = businessFetchTimes.sort().at(-1);
    sourceDatePatch.businessWarehouseUpdatedAt = data?.dates?.businessUpdatedAt || '';
  }
  const linkFetchTimes = await readSourceFetchTimes('shein_links', linkDate);
  if (linkFetchTimes.length) {
    sourceDatePatch.linkUpdatedAt = linkFetchTimes.sort().at(-1);
    sourceDatePatch.linkWarehouseUpdatedAt = data?.dates?.linkUpdatedAt || '';
  }

  const meta = await readLatestLinkInventoryMeta(linkDate);
  if (!meta.size) {
    return {
      ...data,
      dates: {
        ...(data.dates || {}),
        ...sourceDatePatch,
      },
    };
  }
  const enrichArray = rows => Array.isArray(rows) ? rows.map(row => enrichLinkRecordWithInventoryMeta(row, meta)) : rows;
  return {
    ...data,
    dates: {
      ...(data.dates || {}),
      ...sourceDatePatch,
    },
    links: enrichArray(data.links),
    storeLinks: enrichArray(data.storeLinks),
    duplicateLinks: enrichArray(data.duplicateLinks),
  };
}

async function readManualCostFileMeta() {
  const dir = path.join(ROOT, 'inputs', 'costs');
  const files = [];
  try {
    const entries = await fs.readdir(dir, {withFileTypes: true});
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      if (!/\.(xlsx|xls|csv)$/i.test(name)) continue;
      if (/模板|readme/i.test(name)) continue;
      const fullPath = path.join(dir, name);
      try {
        const stat = await fs.stat(fullPath);
        files.push({
          file: path.relative(ROOT, fullPath).replace(/\\/g, '/'),
          updatedAt: stat.mtime.toISOString(),
          size: stat.size,
        });
      } catch {}
    }
  } catch {}
  files.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return {
    latestUpdatedAt: files[0]?.updatedAt || '',
    files,
  };
}

async function attachManualCostFileMeta(data) {
  const meta = await readManualCostFileMeta();
  return {
    ...data,
    dates: {
      ...(data?.dates || {}),
      manualCostFileUpdatedAt: meta.latestUpdatedAt,
      manualCostFiles: meta.files,
    },
  };
}

function buildSql() {
  return `
WITH
kpi AS (
  SELECT jsonb_build_object(
    'salesSar', (
      SELECT coalesce(sum(net_revenue_sar),0)
      FROM mart.profit_order_item
      WHERE created_date = (SELECT max(sales_date) FROM mart.bi_business_store_current)
    ),
    'orders', (
      SELECT count(DISTINCT order_no)
      FROM mart.profit_order_item
      WHERE created_date = (SELECT max(sales_date) FROM mart.bi_business_store_current)
        AND coalesce(net_revenue_sar,0) > 0
    ),
    'quantity', (
      SELECT coalesce(sum(quantity),0)
      FROM mart.profit_order_item
      WHERE created_date = (SELECT max(sales_date) FROM mart.bi_business_store_current)
        AND coalesce(net_revenue_sar,0) > 0
    ),
    'pendingSettlementSar', coalesce(sum(pending_settlement_income_sar),0),
    'inTransitSar', coalesce(sum(in_transit_order_amount_sar),0),
    'payedIncomeSar', coalesce(sum(payed_income_sar),0),
    'financeNoFinishOrders', coalesce(sum(finance_no_finish_order_count),0),
    'financeNoFinishIncomeSar', coalesce(sum(finance_no_finish_order_income_sar),0),
    'afterSalesCases', coalesce(sum(after_sales_case_count),0),
    'lowStockProducts', coalesce(sum(low_display_stock_count),0),
    'lowStarComments', coalesce(sum(low_star_comment_count),0),
    'waybillExceptions', coalesce(sum(waybill_exception_count),0),
    'costProductCount', (SELECT count(*) FROM mart.product_unit_cost_current WHERE unit_cost_sar IS NOT NULL),
    'costMissingProductCount', (
      SELECT count(DISTINCT oi.standard_goods_sn)
      FROM fact.order_item oi
      LEFT JOIN mart.product_unit_cost_by_match_key c
        ON c.match_key <> ''
       AND c.match_key = dim.product_match_key(oi.standard_goods_sn)
      WHERE coalesce(oi.standard_goods_sn,'') <> ''
        AND c.unit_cost_sar IS NULL
    ),
    'riskScore', coalesce(sum(risk_score),0)
  ) AS data
  FROM mart.bi_business_store_current
),
dates AS (
  SELECT jsonb_build_object(
    'salesDate', max(sales_date),
    'linkDate', max(link_date),
    'businessDate', max(business_snapshot_date),
    'salesUpdatedAt', (
      SELECT max(fetch_time)
      FROM fact.store_daily_sales
      WHERE date = (SELECT max(sales_date) FROM mart.bi_business_store_current)
    ),
    'businessUpdatedAt', (
      SELECT max(updated_at)
      FROM fact.home_finance_snapshot
      WHERE snapshot_date = (SELECT max(business_snapshot_date) FROM mart.bi_business_store_current)
    ),
    'linkUpdatedAt', (
      SELECT max(updated_at)
      FROM fact.link_performance_daily
      WHERE date = (SELECT max(link_date) FROM mart.bi_business_store_current)
    ),
    'manualCostUpdatedAt', (
      SELECT max(coalesce(updated_at, imported_at))
      FROM fact.product_cost_batch
    ),
    'manualStorageUpdatedAt', (
      SELECT max(updated_at)
      FROM fact.monthly_storage_fee
    ),
    'etUpdatedAt', (
      SELECT max(fetched_at)
      FROM raw.et_fetch_batch
      WHERE ok AND coalesce(mode,'') <> 'smoke'
    ),
    'etLatestBatchId', (
      SELECT batch_id
      FROM raw.et_fetch_batch
      WHERE ok AND coalesce(mode,'') <> 'smoke'
      ORDER BY fetched_at DESC NULLS LAST
      LIMIT 1
    )
  ) AS data
  FROM mart.bi_business_store_current
),
after_sales_event_daily AS (
  SELECT
    request_time::date AS date,
    count(*) AS case_count,
    round(sum(coalesce(price_amount_total, price_amount,0))::numeric, 2) AS amount_sar
  FROM fact.after_sales_item
  WHERE request_time IS NOT NULL
    AND coalesce(order_sub_status_name,'') <> '已取消'
  GROUP BY request_time::date
),
after_sales_event_group_daily AS (
  SELECT
    request_time::date AS date,
    coalesce(group_key,'') AS group_key,
    count(*) AS case_count,
    round(sum(coalesce(price_amount_total, price_amount,0))::numeric, 2) AS amount_sar
  FROM fact.after_sales_item
  WHERE request_time IS NOT NULL
    AND coalesce(order_sub_status_name,'') <> '已取消'
  GROUP BY request_time::date, coalesce(group_key,'')
),
stores AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS data
  FROM (
    SELECT
      store_key, group_key, shop_name, sales_date, business_snapshot_date,
      round(sales_sar::numeric, 2) AS sales_sar,
      valid_order_count, quantity,
      round(pending_settlement_income_sar::numeric, 2) AS pending_settlement_income_sar,
      round(in_transit_order_amount_sar::numeric, 2) AS in_transit_order_amount_sar,
      round(payed_income_sar::numeric, 2) AS payed_income_sar,
      finance_no_finish_order_count,
      round(finance_no_finish_order_income_sar::numeric, 2) AS finance_no_finish_order_income_sar,
      account_period_days,
      on_shelf_links, missing_product_count, link_action_count, retire_action_count,
      after_sales_case_count, round(after_sales_item_amount_sar::numeric, 2) AS after_sales_item_amount_sar,
      low_display_stock_count, quality_after_sales_item_count, low_star_comment_count,
      waybill_exception_count, campaign_count,
      round(risk_score::numeric, 1) AS risk_score
    FROM mart.bi_business_store_current
    ORDER BY risk_score DESC, sales_sar DESC, store_key
  ) t
),
products AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS data
  FROM (
    SELECT
      standard_goods_sn,
      round(sales_sar::numeric, 2) AS sales_sar,
      quantity, order_count, sale_store_count,
      on_shelf_store_count, missing_store_count, on_shelf_link_count,
      round(display_inventory::numeric, 0) AS display_inventory,
      low_display_stock_count,
      return_volume, quality_return_volume,
      round(avg_quality_return_rate::numeric, 4) AS avg_quality_return_rate,
      after_sales_case_count, round(after_sales_amount_sar::numeric, 2) AS after_sales_amount_sar,
      comment_count, low_star_comment_count,
      round(risk_score::numeric, 1) AS risk_score
    FROM mart.bi_product_360_current
    ORDER BY risk_score DESC, sales_sar DESC, standard_goods_sn
    LIMIT 180
  ) t
),
actions AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS data
  FROM (
    SELECT
      action_domain, date, store_key, group_key, standard_goods_sn, skc,
      category, priority, round(score::numeric, 1) AS score,
      title, reason, evidence, next_step
    FROM mart.bi_guided_action_current
    ORDER BY score DESC, store_key, action_domain, standard_goods_sn, skc
    LIMIT 260
  ) t
),
store_latest_link AS (
  SELECT store_key, max(snapshot_date) AS link_date
  FROM fact.link_master_snapshot
  GROUP BY store_key
),
store_latest_perf AS (
  SELECT store_key, max(date) AS perf_date
  FROM fact.link_performance_daily
  GROUP BY store_key
),
link_health_base AS (
  SELECT
    l.snapshot_date AS link_date,
    l.group_key,
    l.store_key,
    l.shop_name,
    l.standard_goods_sn,
    l.raw_goods_sn,
    l.spu,
    l.skc,
    l.sale_name,
    l.product_name_cn,
    l.image_url,
    l.shelf_status,
    l.shelf_status_name,
    l.is_on_shelf,
    l.is_wait_shelf,
    l.is_sold_out,
    l.is_out_shelf,
    l.wait_shelf_blocked,
    l.wait_shelf_block_reason,
    CASE
      WHEN l.first_shelf_time IS NULL THEN NULL
      ELSE (l.snapshot_date - l.first_shelf_time::date)
    END AS shelf_age_days,
    coalesce(p.sale_cnt, 0) AS sale_cnt,
    coalesce(p.c7_sale_cnt, 0) AS c7_sale_cnt,
    coalesce(p.prev7_sale_cnt, 0) AS prev7_sale_cnt,
    coalesce(p.c30_sale_cnt, 0) AS c30_sale_cnt,
    coalesce(p.eps_uv, 0) AS eps_uv,
    coalesce(p.goods_uv, 0) AS goods_uv,
    coalesce(p.click_rate, 0) AS click_rate,
    coalesce(p.cart_uv, 0) AS cart_uv,
    coalesce(p.cart_rate, 0) AS cart_rate,
    coalesce(p.pay_uv, 0) AS pay_uv,
    coalesce(p.pay_rate, 0) AS pay_rate,
    p.quality_grade,
    coalesce(p.comment_count, 0) AS comment_count,
    coalesce(p.bad_comment_rate, 0) AS bad_comment_rate,
    coalesce(p.return_order_count, 0) AS return_order_count,
    coalesce(p.return_item_count, 0) AS return_item_count,
    coalesce(sp.on_shelf_count, 0) AS same_product_on_shelf_count,
    (
      l.is_on_shelf
      AND coalesce(p.c30_sale_cnt, 0) = 0
      AND l.first_shelf_time IS NOT NULL
      AND l.first_shelf_time::date <= l.snapshot_date - interval '30 days'
    ) AS retire_candidate,
    (
      l.is_on_shelf
      AND coalesce(p.eps_uv,0) >= 100
      AND coalesce(p.click_rate,0) < 0.02
    ) AS high_exposure_low_click,
    (
      l.is_on_shelf
      AND coalesce(p.goods_uv,0) >= 30
      AND coalesce(p.pay_rate,0) < 0.01
    ) AS high_visit_low_pay,
    (
      l.is_wait_shelf
      AND coalesce(l.wait_shelf_blocked,false)
    ) AS wait_shelf_block_candidate,
    CASE
      WHEN l.is_wait_shelf AND coalesce(l.wait_shelf_blocked,false) THEN '待上架卡点'
      WHEN l.is_on_shelf
        AND coalesce(p.c30_sale_cnt, 0) = 0
        AND l.first_shelf_time IS NOT NULL
        AND l.first_shelf_time::date <= l.snapshot_date - interval '30 days' THEN '下架候选'
      WHEN l.is_on_shelf AND coalesce(p.eps_uv,0) >= 100 AND coalesce(p.click_rate,0) < 0.02 THEN '优化：高曝光低点击'
      WHEN l.is_on_shelf AND coalesce(p.goods_uv,0) >= 30 AND coalesce(p.pay_rate,0) < 0.01 THEN '优化：高访客低支付'
      WHEN l.is_on_shelf THEN '正常在售'
      WHEN l.is_sold_out THEN '已售罄'
      ELSE coalesce(l.shelf_status_name, '未知')
    END AS health_bucket
  FROM fact.link_master_snapshot l
  JOIN store_latest_link sl
    ON sl.store_key = l.store_key AND sl.link_date = l.snapshot_date
  LEFT JOIN store_latest_perf pl
    ON pl.store_key = l.store_key
  LEFT JOIN fact.link_performance_daily p
    ON p.date = pl.perf_date AND p.store_key = l.store_key AND p.skc = l.skc
  LEFT JOIN (
    SELECT l2.store_key, l2.standard_goods_sn, count(*) FILTER (WHERE l2.is_on_shelf) AS on_shelf_count
    FROM fact.link_master_snapshot l2
    JOIN store_latest_link sl2
      ON sl2.store_key = l2.store_key AND sl2.link_date = l2.snapshot_date
    WHERE coalesce(l2.is_hard_dead,false) = false
    GROUP BY l2.store_key, l2.standard_goods_sn
  ) sp
    ON sp.store_key = l.store_key AND sp.standard_goods_sn = l.standard_goods_sn
  WHERE coalesce(l.is_hard_dead,false) = false
),
link_health_enriched AS (
  SELECT
    h.*,
    coalesce(
      nullif(p.raw_summary->>'layerName',''),
      nullif(p.raw_summary#>>'{c30,layerNm}',''),
      nullif(p.raw_summary#>>'{c7,layerNm}',''),
      nullif(m.raw_summary->>'skcTags',''),
      nullif(m.raw_summary->>'productTags','')
    ) AS skc_label,
    coalesce(
      nullif(p.raw_summary#>>'{c30,promCampaign,promTag}',''),
      nullif(p.raw_summary#>>'{c7,promCampaign,promTag}',''),
      nullif(p.activity_tag,'')
    ) AS activity_label,
    coalesce(
      nullif(p.raw_summary->>'newGoodsTag',''),
      nullif(p.raw_summary#>>'{c30,newGoodsTag}',''),
      nullif(p.raw_summary#>>'{c7,newGoodsTag}','')
    ) AS shein_tag_code,
    coalesce(
      nullif(p.raw_summary#>>'{c30,newCate4Nm}',''),
      nullif(p.raw_summary#>>'{c7,newCate4Nm}',''),
      nullif(p.raw_summary->>'category4','')
    ) AS category4_name,
    CASE WHEN coalesce(p.raw_summary->>'c30EpsUv','') ~ '^-?[0-9]+(\\.[0-9]+)?$'
      THEN (p.raw_summary->>'c30EpsUv')::numeric ELSE NULL END AS c30_eps_uv,
    CASE WHEN coalesce(p.raw_summary->>'c30GoodsUv','') ~ '^-?[0-9]+(\\.[0-9]+)?$'
      THEN (p.raw_summary->>'c30GoodsUv')::numeric ELSE NULL END AS c30_goods_uv,
    CASE WHEN coalesce(p.raw_summary->>'c30PayRate','') ~ '^-?[0-9]+(\\.[0-9]+)?$'
      THEN (p.raw_summary->>'c30PayRate')::numeric ELSE NULL END AS c30_pay_rate,
    CASE WHEN coalesce(p.raw_summary->>'c7EpsUv','') ~ '^-?[0-9]+(\\.[0-9]+)?$'
      THEN (p.raw_summary->>'c7EpsUv')::numeric ELSE NULL END AS c7_eps_uv,
    CASE WHEN coalesce(p.raw_summary->>'c7GoodsUv','') ~ '^-?[0-9]+(\\.[0-9]+)?$'
      THEN (p.raw_summary->>'c7GoodsUv')::numeric ELSE NULL END AS c7_goods_uv,
    CASE WHEN coalesce(p.raw_summary->>'c7PayRate','') ~ '^-?[0-9]+(\\.[0-9]+)?$'
      THEN (p.raw_summary->>'c7PayRate')::numeric ELSE NULL END AS c7_pay_rate
  FROM link_health_base h
  LEFT JOIN store_latest_perf pl
    ON pl.store_key = h.store_key
  LEFT JOIN fact.link_performance_daily p
    ON p.date = pl.perf_date AND p.store_key = h.store_key AND p.skc = h.skc
  LEFT JOIN fact.link_master_snapshot m
    ON m.snapshot_date = h.link_date AND m.store_key = h.store_key AND m.skc = h.skc
),
links AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS data
  FROM (
    SELECT
      link_date, store_key, group_key, standard_goods_sn, skc, product_name_cn,
      shelf_status_name, shelf_age_days,
      sale_cnt, c7_sale_cnt, c30_sale_cnt,
      eps_uv, goods_uv, click_rate, pay_rate,
      c7_eps_uv, c7_goods_uv, c7_pay_rate, c30_eps_uv, c30_goods_uv, c30_pay_rate,
      quality_grade, comment_count, bad_comment_rate, return_order_count,
      same_product_on_shelf_count, retire_candidate,
      high_exposure_low_click, high_visit_low_pay, wait_shelf_block_candidate,
      health_bucket, skc_label, activity_label, shein_tag_code, category4_name,
      is_on_shelf, is_wait_shelf
    FROM link_health_enriched
    WHERE retire_candidate
       OR high_exposure_low_click
       OR high_visit_low_pay
       OR wait_shelf_block_candidate
       OR coalesce(c30_sale_cnt,0) > 0
    ORDER BY
      retire_candidate DESC,
      high_visit_low_pay DESC,
      high_exposure_low_click DESC,
      coalesce(c30_sale_cnt,0) DESC,
      coalesce(eps_uv,0) DESC
    LIMIT 240
  ) t
),
duplicate_links AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS data
  FROM (
    SELECT
      link_date, store_key, group_key, standard_goods_sn, skc, product_name_cn,
      shelf_status_name, shelf_age_days,
      sale_cnt, c7_sale_cnt, c30_sale_cnt,
      eps_uv, goods_uv, click_rate, pay_rate,
      c7_eps_uv, c7_goods_uv, c7_pay_rate, c30_eps_uv, c30_goods_uv, c30_pay_rate,
      quality_grade, comment_count, bad_comment_rate, return_order_count,
      same_product_on_shelf_count, retire_candidate,
      high_exposure_low_click, high_visit_low_pay, wait_shelf_block_candidate,
      health_bucket, skc_label, activity_label, shein_tag_code, category4_name,
      is_on_shelf, is_wait_shelf,
      max(coalesce(c30_sale_cnt,0)) OVER (PARTITION BY store_key, standard_goods_sn) AS group_best_c30,
      row_number() OVER (
        PARTITION BY store_key, standard_goods_sn
        ORDER BY coalesce(c30_sale_cnt,0) DESC, coalesce(goods_uv,0) DESC, coalesce(eps_uv,0) DESC, skc
      ) AS group_rank
    FROM link_health_enriched
    WHERE same_product_on_shelf_count > 1
      AND shelf_status_name = '已上架'
    ORDER BY store_key, standard_goods_sn, group_rank
    LIMIT 900
  ) t
),
store_links AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS data
  FROM (
    SELECT
      link_date, store_key, group_key, standard_goods_sn, skc, product_name_cn,
      shelf_status_name, shelf_age_days,
      sale_cnt, c7_sale_cnt, c30_sale_cnt,
      eps_uv, goods_uv, click_rate, pay_rate,
      c7_eps_uv, c7_goods_uv, c7_pay_rate, c30_eps_uv, c30_goods_uv, c30_pay_rate,
      quality_grade, comment_count, bad_comment_rate, return_order_count,
      same_product_on_shelf_count, retire_candidate,
      high_exposure_low_click, high_visit_low_pay, wait_shelf_block_candidate,
      health_bucket, skc_label, activity_label, shein_tag_code, category4_name,
      is_on_shelf, is_wait_shelf
    FROM link_health_enriched
    WHERE coalesce(skc,'') <> ''
    ORDER BY store_key, coalesce(c30_sale_cnt,0) DESC, coalesce(c30_goods_uv, goods_uv, 0) DESC, skc
    LIMIT 2200
  ) t
),
matrix AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS data
  FROM (
    SELECT
      store_key, group_key, standard_goods_sn, coverage_status,
      link_date,
      has_on_shelf_link, need_supplement_link, link_count, on_shelf_count,
      wait_shelf_count, sold_out_count, duplicate_on_shelf,
      best_skc, best_link_c30_sale,
      round(sales_sar::numeric, 2) AS sales_sar,
      quantity, action_count, focus_action_count, round(max_action_score::numeric, 1) AS max_action_score
    FROM mart.bi_store_product_matrix_current
    WHERE need_supplement_link
       OR has_on_shelf_link
       OR link_count > 0
       OR action_count > 0
       OR sales_sar > 0
    ORDER BY coalesce(max_action_score,0) DESC, sales_sar DESC, store_key, standard_goods_sn
    LIMIT 2400
  ) t
),
comments AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS data
  FROM (
    SELECT
      comment_date, comment_time, order_time,
      store_key, group_key, standard_goods_sn, raw_goods_sn,
      skc, sku, goods_title, goods_attribute,
      goods_comment_star, goods_comment_star_name,
      nullif(goods_comment_content,'') AS goods_comment_content,
      nullif(bad_comment_labels,'') AS bad_comment_labels,
      logistic_comment_star,
      nullif(goods_comment_content_zh,'') AS goods_comment_content_zh,
      nullif(translation_provider,'') AS translation_provider,
      translated_at,
      is_quality_label, is_quality_complaint,
      source_file
    FROM fact.product_comment
    ORDER BY comment_date DESC, comment_time DESC NULLS LAST, store_key, standard_goods_sn
    LIMIT 2200
  ) t
),
comment_summary AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS data
  FROM (
    SELECT
      standard_goods_sn,
      count(*) AS comment_count,
      count(*) FILTER (WHERE coalesce(goods_comment_star,5) <= 3) AS low_star_count,
      round(avg(goods_comment_star)::numeric, 2) AS avg_star,
      max(comment_date) AS latest_comment_date,
      count(DISTINCT store_key) AS store_count
    FROM fact.product_comment
    GROUP BY standard_goods_sn
    ORDER BY low_star_count DESC, comment_count DESC, latest_comment_date DESC
    LIMIT 220
  ) t
),
action_domain AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS data
  FROM (
    SELECT action_domain, count(*) AS count, max(score) AS max_score
    FROM mart.bi_guided_action_current
    GROUP BY action_domain
    ORDER BY count DESC, action_domain
  ) t
),
sales_anchor AS (
  SELECT min(date) AS min_date, max(date) AS max_date FROM fact.store_daily_sales
),
sales_calendar AS (
  SELECT DISTINCT date::date AS date
  FROM fact.store_daily_sales
  UNION
  SELECT DISTINCT created_date::date AS date
  FROM mart.profit_order_item
),
net_order_item AS (
  SELECT
    created_date::date AS date,
    store_key,
    group_key,
    standard_goods_sn,
    raw_goods_sn,
    skc,
    goods_title,
    order_no,
    order_key,
    CASE WHEN coalesce(gross_revenue_sar,0) > 0 THEN coalesce(quantity,0) ELSE 0 END AS gross_quantity,
    CASE WHEN coalesce(net_revenue_sar,0) > 0 THEN coalesce(quantity,0) ELSE 0 END AS quantity,
    coalesce(net_revenue_sar,0) AS sales_sar,
    coalesce(gross_revenue_sar,0) AS gross_sales_sar,
    coalesce(revenue_reversal,false) AS revenue_reversal
  FROM mart.profit_order_item
  WHERE coalesce(standard_goods_sn,'') <> ''
),
net_daily_store_sales AS (
  SELECT
    date,
    store_key,
    max(coalesce(n.group_key,'')) AS group_key,
    max(coalesce(s.shop_name,'')) AS shop_name,
    round(sum(coalesce(n.sales_sar,0))::numeric, 2) AS sales_sar,
    round(sum(coalesce(n.gross_sales_sar,0))::numeric, 2) AS gross_sales_sar,
    count(DISTINCT order_no) FILTER (WHERE coalesce(n.sales_sar,0) > 0) AS orders,
    count(DISTINCT order_no) FILTER (WHERE coalesce(n.gross_sales_sar,0) > 0) AS gross_orders,
    round(sum(coalesce(n.quantity,0))::numeric, 0) AS quantity,
    round(sum(coalesce(n.gross_quantity,0))::numeric, 0) AS gross_quantity
  FROM net_order_item n
  LEFT JOIN dim.store s USING (store_key)
  GROUP BY date, store_key
),
period_defs AS (
  SELECT
    'day'::text AS period_key,
    '日'::text AS period_label,
    to_char(date, 'YYYY-MM-DD') AS period_id,
    date AS start_date,
    date AS end_date
  FROM sales_calendar
  UNION ALL
  SELECT
    'week'::text AS period_key,
    '周'::text AS period_label,
    to_char(date_trunc('week', date)::date, 'YYYY-MM-DD') AS period_id,
    min(date)::date AS start_date,
    max(date)::date AS end_date
  FROM sales_calendar
  GROUP BY date_trunc('week', date)::date
  UNION ALL
  SELECT
    'month'::text AS period_key,
    '月'::text AS period_label,
    to_char(date_trunc('month', date)::date, 'YYYY-MM') AS period_id,
    min(date)::date AS start_date,
    max(date)::date AS end_date
  FROM sales_calendar
  GROUP BY date_trunc('month', date)::date
  UNION ALL
  SELECT
    'year'::text AS period_key,
    '年'::text AS period_label,
    to_char(date_trunc('year', date)::date, 'YYYY') AS period_id,
    min(date)::date AS start_date,
    max(date)::date AS end_date
  FROM sales_calendar
  GROUP BY date_trunc('year', date)::date
),
store_period_rank AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY period_key, sales_sar DESC, store_key), '[]'::jsonb) AS data
  FROM (
    SELECT
      p.period_key,
      p.period_label,
      p.period_id,
      p.start_date,
      p.end_date,
      s.store_key,
      max(coalesce(s.group_key,'')) AS group_key,
      max(coalesce(s.shop_name,'')) AS shop_name,
      round(sum(coalesce(s.sales_sar,0))::numeric, 2) AS sales_sar,
      round(sum(coalesce(s.gross_sales_sar,0))::numeric, 2) AS gross_sales_sar,
      sum(coalesce(s.orders,0)) AS orders,
      sum(coalesce(s.gross_orders,0)) AS gross_orders,
      round(sum(coalesce(s.quantity,0))::numeric, 0) AS quantity,
      round(sum(coalesce(s.gross_quantity,0))::numeric, 0) AS gross_quantity,
      count(DISTINCT s.date) AS days
    FROM period_defs p
    JOIN net_daily_store_sales s
      ON s.date BETWEEN p.start_date AND p.end_date
    GROUP BY p.period_key, p.period_label, p.period_id, p.start_date, p.end_date, s.store_key
    ORDER BY p.period_key, sales_sar DESC, s.store_key
  ) t
),
product_period_rank AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY period_key, sales_sar DESC, standard_goods_sn), '[]'::jsonb) AS data
  FROM (
    SELECT
      p.period_key,
      p.period_label,
      p.period_id,
      p.start_date,
      p.end_date,
      oi.standard_goods_sn,
      max(coalesce(oi.goods_title,'')) AS goods_title,
      round(sum(coalesce(oi.sales_sar,0))::numeric, 2) AS sales_sar,
      round(sum(coalesce(oi.gross_sales_sar,0))::numeric, 2) AS gross_sales_sar,
      round(sum(coalesce(oi.quantity,0))::numeric, 0) AS quantity,
      round(sum(coalesce(oi.gross_quantity,0))::numeric, 0) AS gross_quantity,
      count(DISTINCT oi.order_no) FILTER (WHERE coalesce(oi.sales_sar,0) > 0) AS orders,
      count(DISTINCT oi.order_no) FILTER (WHERE coalesce(oi.gross_sales_sar,0) > 0) AS gross_orders,
      count(DISTINCT oi.store_key) FILTER (WHERE coalesce(oi.sales_sar,0) > 0) AS store_count,
      count(DISTINCT oi.date) AS days
    FROM period_defs p
    JOIN net_order_item oi
      ON oi.date BETWEEN p.start_date AND p.end_date
    WHERE coalesce(oi.standard_goods_sn,'') <> ''
    GROUP BY p.period_key, p.period_label, p.period_id, p.start_date, p.end_date, oi.standard_goods_sn
    ORDER BY p.period_key, sales_sar DESC, oi.standard_goods_sn
    LIMIT 1000
  ) t
),
sales_period_summary AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY period_key), '[]'::jsonb) AS data
  FROM (
    SELECT
      p.period_key,
      p.period_label,
      p.period_id,
      p.start_date,
      p.end_date,
      round(sum(coalesce(s.sales_sar,0))::numeric, 2) AS sales_sar,
      round(sum(coalesce(s.gross_sales_sar,0))::numeric, 2) AS gross_sales_sar,
      sum(coalesce(s.orders,0)) AS orders,
      sum(coalesce(s.gross_orders,0)) AS gross_orders,
      round(sum(coalesce(s.quantity,0))::numeric, 0) AS quantity,
      round(sum(coalesce(s.gross_quantity,0))::numeric, 0) AS gross_quantity,
      count(DISTINCT s.date) AS days
    FROM period_defs p
    LEFT JOIN net_daily_store_sales s
      ON s.date BETWEEN p.start_date AND p.end_date
    GROUP BY p.period_key, p.period_label, p.period_id, p.start_date, p.end_date
  ) t
),
daily_store_sales AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY date, store_key), '[]'::jsonb) AS data
  FROM (
    SELECT
      date::date AS date,
      store_key,
      max(coalesce(group_key,'')) AS group_key,
      max(coalesce(shop_name,'')) AS shop_name,
      round(sum(coalesce(sales_sar,0))::numeric, 2) AS sales_sar,
      round(sum(coalesce(gross_sales_sar,0))::numeric, 2) AS gross_sales_sar,
      sum(coalesce(orders,0)) AS orders,
      sum(coalesce(gross_orders,0)) AS gross_orders,
      round(sum(coalesce(quantity,0))::numeric, 0) AS quantity,
      round(sum(coalesce(gross_quantity,0))::numeric, 0) AS gross_quantity
    FROM net_daily_store_sales
    GROUP BY date, store_key
    ORDER BY date, store_key
  ) t
),
daily_product_sales AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY date, standard_goods_sn), '[]'::jsonb) AS data
  FROM (
    SELECT
      oi.date::date AS date,
      oi.standard_goods_sn,
      max(coalesce(oi.goods_title,'')) AS goods_title,
      string_agg(DISTINCT nullif(oi.skc,''), ' ') FILTER (WHERE nullif(oi.skc,'') IS NOT NULL) AS skc_list,
      round(sum(coalesce(oi.sales_sar,0))::numeric, 2) AS sales_sar,
      round(sum(coalesce(oi.gross_sales_sar,0))::numeric, 2) AS gross_sales_sar,
      round(sum(coalesce(oi.quantity,0))::numeric, 0) AS quantity,
      round(sum(coalesce(oi.gross_quantity,0))::numeric, 0) AS gross_quantity,
      count(DISTINCT oi.order_no) FILTER (WHERE coalesce(oi.sales_sar,0) > 0) AS orders,
      count(DISTINCT oi.order_no) FILTER (WHERE coalesce(oi.gross_sales_sar,0) > 0) AS gross_orders,
      count(DISTINCT oi.store_key) FILTER (WHERE coalesce(oi.sales_sar,0) > 0) AS store_count
    FROM net_order_item oi
    WHERE coalesce(oi.standard_goods_sn,'') <> ''
    GROUP BY oi.date, oi.standard_goods_sn
    ORDER BY oi.date, oi.standard_goods_sn
  ) t
),
daily_product_group_sales AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY date, group_key, standard_goods_sn), '[]'::jsonb) AS data
  FROM (
    SELECT
      oi.date::date AS date,
      coalesce(oi.group_key,'') AS group_key,
      oi.standard_goods_sn,
      string_agg(DISTINCT nullif(oi.skc,''), ' ') FILTER (WHERE nullif(oi.skc,'') IS NOT NULL) AS skc_list,
      round(sum(coalesce(oi.sales_sar,0))::numeric, 2) AS sales_sar,
      round(sum(coalesce(oi.gross_sales_sar,0))::numeric, 2) AS gross_sales_sar,
      round(sum(coalesce(oi.quantity,0))::numeric, 0) AS quantity,
      round(sum(coalesce(oi.gross_quantity,0))::numeric, 0) AS gross_quantity,
      count(DISTINCT oi.order_no) FILTER (WHERE coalesce(oi.sales_sar,0) > 0) AS orders,
      count(DISTINCT oi.order_no) FILTER (WHERE coalesce(oi.gross_sales_sar,0) > 0) AS gross_orders,
      count(DISTINCT oi.store_key) FILTER (WHERE coalesce(oi.sales_sar,0) > 0) AS store_count
    FROM net_order_item oi
    WHERE coalesce(oi.standard_goods_sn,'') <> ''
    GROUP BY oi.date, coalesce(oi.group_key,''), oi.standard_goods_sn
    ORDER BY oi.date, coalesce(oi.group_key,''), oi.standard_goods_sn
  ) t
),
daily_store_product_sales AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY date, store_key, standard_goods_sn), '[]'::jsonb) AS data
  FROM (
    SELECT
      oi.date::date AS date,
      oi.store_key,
      max(coalesce(oi.group_key,'')) AS group_key,
      oi.standard_goods_sn,
      max(coalesce(oi.goods_title,'')) AS goods_title,
      string_agg(DISTINCT nullif(oi.skc,''), ' ') FILTER (WHERE nullif(oi.skc,'') IS NOT NULL) AS skc_list,
      round(sum(coalesce(oi.sales_sar,0))::numeric, 2) AS sales_sar,
      round(sum(coalesce(oi.gross_sales_sar,0))::numeric, 2) AS gross_sales_sar,
      round(sum(coalesce(oi.quantity,0))::numeric, 0) AS quantity,
      round(sum(coalesce(oi.gross_quantity,0))::numeric, 0) AS gross_quantity,
      count(DISTINCT oi.order_no) FILTER (WHERE coalesce(oi.sales_sar,0) > 0) AS orders,
      count(DISTINCT oi.order_no) FILTER (WHERE coalesce(oi.gross_sales_sar,0) > 0) AS gross_orders
    FROM net_order_item oi
    WHERE coalesce(oi.standard_goods_sn,'') <> ''
      AND coalesce(oi.store_key,'') <> ''
    GROUP BY oi.date, oi.store_key, oi.standard_goods_sn
    ORDER BY oi.date, oi.store_key, oi.standard_goods_sn
  ) t
),
profit_daily_store_product AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY date, store_key, standard_goods_sn), '[]'::jsonb) AS data
  FROM (
    SELECT
      date::date AS date,
      store_key,
      group_key,
      standard_goods_sn,
      round(sum(coalesce(gross_revenue_sar,0))::numeric, 2) AS gross_revenue_sar,
      round(sum(coalesce(net_revenue_sar,0))::numeric, 2) AS net_revenue_sar,
      round(sum(coalesce(quantity,0))::numeric, 0) AS quantity,
      sum(coalesce(order_lines,0)) AS order_lines,
      sum(coalesce(orders,0)) AS orders,
      round(sum(coalesce(product_cost_sar,0))::numeric, 2) AS product_cost_sar,
      round(sum(coalesce(return_delivery_fee_sar,0))::numeric, 2) AS return_delivery_fee_sar,
      round(sum(coalesce(rtv_recoverable_cost_sar,0))::numeric, 2) AS rtv_recoverable_cost_sar,
      round(sum(coalesce(rtv_09_recoverable_cost_sar,0))::numeric, 2) AS rtv_09_recoverable_cost_sar,
      round(sum(coalesce(rtv_received_quantity,0))::numeric, 0) AS rtv_received_quantity,
      round(sum(coalesce(rtv_received_to_09_quantity,0))::numeric, 0) AS rtv_received_to_09_quantity,
      round(sum(coalesce(profit_before_storage_sar,0))::numeric, 2) AS profit_before_storage_sar,
      round(sum(coalesce(profit_if_rtv_received_resellable_sar,0))::numeric, 2) AS profit_if_rtv_received_resellable_sar,
      round(sum(coalesce(profit_if_rtv_09_resellable_sar,0))::numeric, 2) AS profit_if_rtv_09_resellable_sar,
      round(sum(coalesce(known_net_revenue_sar,0))::numeric, 2) AS known_net_revenue_sar,
      round(sum(coalesce(known_gross_revenue_sar,0))::numeric, 2) AS known_gross_revenue_sar,
      round(sum(coalesce(missing_cost_revenue_sar,0))::numeric, 2) AS missing_cost_revenue_sar,
      round(sum(coalesce(missing_cost_quantity,0))::numeric, 0) AS missing_cost_quantity,
      sum(coalesce(missing_cost_lines,0)) AS missing_cost_lines,
      sum(coalesce(reversal_lines,0)) AS reversal_lines,
      CASE WHEN sum(coalesce(net_revenue_sar,0)) FILTER (WHERE missing_cost_lines = 0) > 0
        THEN round((sum(coalesce(profit_before_storage_sar,0)) / nullif(sum(coalesce(known_net_revenue_sar,0)),0))::numeric, 4)
        ELSE NULL END AS profit_margin_before_storage,
      CASE WHEN sum(coalesce(net_revenue_sar,0)) > 0
        THEN round((sum(coalesce(known_net_revenue_sar,0)) / nullif(sum(coalesce(net_revenue_sar,0)),0))::numeric, 4)
        ELSE NULL END AS cost_coverage_revenue_rate
    FROM mart.profit_daily_store_product
    WHERE coalesce(standard_goods_sn,'') <> ''
    GROUP BY date, store_key, group_key, standard_goods_sn
    ORDER BY date, store_key, standard_goods_sn
  ) t
),
profit_month_group AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY month_start, group_key), '[]'::jsonb) AS data
  FROM (
    SELECT
      month_start,
      group_key,
      round(gross_revenue_sar::numeric, 2) AS gross_revenue_sar,
      round(net_revenue_sar::numeric, 2) AS net_revenue_sar,
      round(product_cost_sar::numeric, 2) AS product_cost_sar,
      round(return_delivery_fee_sar::numeric, 2) AS return_delivery_fee_sar,
      round(rtv_recoverable_cost_sar::numeric, 2) AS rtv_recoverable_cost_sar,
      round(rtv_09_recoverable_cost_sar::numeric, 2) AS rtv_09_recoverable_cost_sar,
      round(rtv_received_quantity::numeric, 0) AS rtv_received_quantity,
      round(rtv_received_to_09_quantity::numeric, 0) AS rtv_received_to_09_quantity,
      round(profit_before_storage_sar::numeric, 2) AS profit_before_storage_sar,
      round(profit_if_rtv_received_resellable_sar::numeric, 2) AS profit_if_rtv_received_resellable_sar,
      round(profit_if_rtv_09_resellable_sar::numeric, 2) AS profit_if_rtv_09_resellable_sar,
      round(month_storage_fee_sar::numeric, 2) AS month_storage_fee_sar,
      round(allocated_storage_fee_sar::numeric, 2) AS allocated_storage_fee_sar,
      round(profit_after_storage_sar::numeric, 2) AS profit_after_storage_sar,
      round(profit_if_rtv_received_resellable_after_storage_sar::numeric, 2) AS profit_if_rtv_received_resellable_after_storage_sar,
      round(profit_if_rtv_09_resellable_after_storage_sar::numeric, 2) AS profit_if_rtv_09_resellable_after_storage_sar,
      round(profit_margin_after_storage::numeric, 4) AS profit_margin_after_storage,
      round(cost_coverage_revenue_rate::numeric, 4) AS cost_coverage_revenue_rate,
      round(missing_cost_revenue_sar::numeric, 2) AS missing_cost_revenue_sar,
      missing_cost_lines,
      reversal_lines
    FROM mart.profit_month_group
    ORDER BY month_start, group_key
  ) t
),
profit_product_summary AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY profit_before_storage_sar DESC NULLS LAST, gross_revenue_sar DESC, standard_goods_sn), '[]'::jsonb) AS data
  FROM (
    SELECT
      standard_goods_sn,
      round(gross_revenue_sar::numeric, 2) AS gross_revenue_sar,
      round(net_revenue_sar::numeric, 2) AS net_revenue_sar,
      round(quantity::numeric, 0) AS quantity,
      round(product_cost_sar::numeric, 2) AS product_cost_sar,
      round(return_delivery_fee_sar::numeric, 2) AS return_delivery_fee_sar,
      round(rtv_recoverable_cost_sar::numeric, 2) AS rtv_recoverable_cost_sar,
      round(rtv_09_recoverable_cost_sar::numeric, 2) AS rtv_09_recoverable_cost_sar,
      round(rtv_received_quantity::numeric, 0) AS rtv_received_quantity,
      round(rtv_received_to_09_quantity::numeric, 0) AS rtv_received_to_09_quantity,
      round(profit_before_storage_sar::numeric, 2) AS profit_before_storage_sar,
      round(profit_if_rtv_received_resellable_sar::numeric, 2) AS profit_if_rtv_received_resellable_sar,
      round(profit_if_rtv_09_resellable_sar::numeric, 2) AS profit_if_rtv_09_resellable_sar,
      round(profit_margin_before_storage::numeric, 4) AS profit_margin_before_storage,
      round(missing_cost_revenue_sar::numeric, 2) AS missing_cost_revenue_sar,
      round(missing_cost_quantity::numeric, 0) AS missing_cost_quantity,
      missing_cost_lines,
      reversal_lines,
      round(unit_cost_sar::numeric, 2) AS unit_cost_sar,
      complete_batch_count,
      ignored_batch_count,
      round(costed_quantity::numeric, 0) AS costed_quantity,
      round(avg_purchase_unit_price::numeric, 2) AS avg_purchase_unit_price,
      round(avg_volume_l::numeric, 2) AS avg_volume_l,
      round(avg_weight_kg::numeric, 2) AS avg_weight_kg,
      (
        SELECT round((sum(coalesce(b.first_leg_freight_amount,0)) / nullif(sum(coalesce(b.shipped_quantity,0)),0))::numeric, 2)
        FROM fact.product_cost_batch b
        WHERE b.complete_batch
          AND dim.product_match_key(b.standard_goods_sn) = dim.product_match_key(mart.profit_product_summary.standard_goods_sn)
      ) AS historical_first_leg_unit_cny,
      (
        SELECT round(((sum(coalesce(b.first_leg_freight_amount,0)) / nullif(sum(coalesce(b.shipped_quantity,0)),0)) / 1600.0 * 1000)::numeric, 2)
        FROM fact.product_cost_batch b
        WHERE b.complete_batch
          AND dim.product_match_key(b.standard_goods_sn) = dim.product_match_key(mart.profit_product_summary.standard_goods_sn)
      ) AS inferred_volume_l_1600,
      (
        SELECT round(((sum(coalesce(b.first_leg_freight_amount,0)) / nullif(sum(coalesce(b.shipped_quantity,0)),0)) * (2000.0 / 1600.0))::numeric, 2)
        FROM fact.product_cost_batch b
        WHERE b.complete_batch
          AND dim.product_match_key(b.standard_goods_sn) = dim.product_match_key(mart.profit_product_summary.standard_goods_sn)
      ) AS future_first_leg_unit_cny_at_2000,
      last_cost_imported_at,
      round(cost_coverage_revenue_rate::numeric, 4) AS cost_coverage_revenue_rate
    FROM mart.profit_product_summary
    ORDER BY profit_before_storage_sar DESC NULLS LAST, gross_revenue_sar DESC, standard_goods_sn
    LIMIT 500
  ) t
),
inventory_depletion_products AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY
    CASE risk_level WHEN 'high' THEN 0 WHEN 'mid' THEN 1 ELSE 2 END,
    days_of_supply_on_hand ASC NULLS LAST,
    weighted_daily_gross_sales DESC,
    standard_goods_sn
  ), '[]'::jsonb) AS data
  FROM (
    SELECT
      standard_goods_sn,
      match_key,
      standard_goods_sn_list,
      raw_goods_sn_list,
      goods_title,
      batch_count,
      arrived_batch_count,
      incoming_batch_count,
      not_shipped_batch_count,
      round(arrived_quantity::numeric, 0) AS arrived_quantity,
      round(incoming_quantity::numeric, 0) AS incoming_quantity,
      round(not_shipped_quantity::numeric, 0) AS not_shipped_quantity,
      round(gross_sold_quantity::numeric, 0) AS gross_sold_quantity,
      round(net_sold_quantity::numeric, 0) AS net_sold_quantity,
      round(reversal_quantity::numeric, 0) AS reversal_quantity,
      reversal_lines,
      round(estimated_on_hand_quantity::numeric, 0) AS estimated_on_hand_quantity,
      round(estimated_total_supply_quantity::numeric, 0) AS estimated_total_supply_quantity,
      round(oversold_or_missing_batch_quantity::numeric, 0) AS oversold_or_missing_batch_quantity,
      round(depletion_rate::numeric, 4) AS depletion_rate,
      round(gross_sold_7d::numeric, 0) AS gross_sold_7d,
      round(gross_sold_14d::numeric, 0) AS gross_sold_14d,
      round(gross_sold_30d::numeric, 0) AS gross_sold_30d,
      round(weighted_daily_gross_sales::numeric, 2) AS weighted_daily_gross_sales,
      round(days_of_supply_on_hand::numeric, 1) AS days_of_supply_on_hand,
      round(days_of_supply_with_incoming::numeric, 1) AS days_of_supply_with_incoming,
      last_sale_date,
      first_sale_date,
      first_shipped_date,
      latest_shipped_date,
      first_arrived_date,
      latest_arrived_date,
      round(arrived_cost_sar::numeric, 2) AS arrived_cost_sar,
      round(unit_cost_sar::numeric, 2) AS unit_cost_sar,
      round(avg_purchase_unit_price::numeric, 2) AS avg_purchase_unit_price,
      round(avg_volume_l::numeric, 2) AS avg_volume_l,
      round(avg_weight_kg::numeric, 2) AS avg_weight_kg,
      ignored_reasons,
      stock_status,
      risk_level,
      (et_estimated_available_qty IS NOT NULL) AS has_et_inventory,
      round(coalesce(et_loose_sellable_qty,0)::numeric, 0) AS et_loose_sellable_qty,
      round(coalesce(et_full_carton_qty,0)::numeric, 0) AS et_full_carton_qty,
      round(coalesce(et_rtv_qty,0)::numeric, 0) AS et_rtv_qty,
      round(coalesce(et_damaged_qty,0)::numeric, 0) AS et_damaged_qty,
      round(coalesce(et_scrap_qty,0)::numeric, 0) AS et_scrap_qty,
      round(coalesce(et_estimated_available_qty,0)::numeric, 0) AS et_estimated_available_qty,
      round(coalesce(et_pending_process_qty,0)::numeric, 0) AS et_pending_process_qty,
      round(coalesce(et_box_count,0)::numeric, 0) AS et_box_count,
      et_loose_warehouses,
      et_box_warehouses,
      et_store_snapshot_date,
      et_box_snapshot_date
    FROM (
      SELECT
        p.*,
        et.loose_sellable_qty AS et_loose_sellable_qty,
        et.full_carton_qty AS et_full_carton_qty,
        et.rtv_qty AS et_rtv_qty,
        et.damaged_qty AS et_damaged_qty,
        et.scrap_qty AS et_scrap_qty,
        et.estimated_available_qty AS et_estimated_available_qty,
        et.pending_process_qty AS et_pending_process_qty,
        et.box_count AS et_box_count,
        et.loose_warehouses AS et_loose_warehouses,
        et.box_warehouses AS et_box_warehouses,
        et.store_snapshot_date AS et_store_snapshot_date,
        et.box_snapshot_date AS et_box_snapshot_date
      FROM mart.inventory_depletion_product_current p
      LEFT JOIN mart.et_product_inventory_current et
        ON et.match_key = p.match_key
    ) inv
    ORDER BY
      CASE risk_level WHEN 'high' THEN 0 WHEN 'mid' THEN 1 ELSE 2 END,
      days_of_supply_on_hand ASC NULLS LAST,
      weighted_daily_gross_sales DESC,
      standard_goods_sn
    LIMIT 800
  ) t
),
inventory_depletion_batches AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY standard_goods_sn, batch_sort, batch_no), '[]'::jsonb) AS data
  FROM (
    WITH src AS (
      SELECT
        b.*,
        dim.product_match_key(b.standard_goods_sn) AS match_key,
        coalesce(p.gross_sold_quantity,0) AS product_gross_sold_quantity,
        CASE
          WHEN coalesce(b.shipped_quantity,0) > 0 AND b.arrived_date IS NOT NULL AND b.first_leg_freight_amount IS NOT NULL THEN '已到仓'
          WHEN coalesce(b.shipped_quantity,0) > 0 AND b.shipped_date IS NOT NULL THEN '在途/待录头程'
          WHEN coalesce(b.shipped_quantity,0) > 0 THEN '未发/待确认'
          ELSE '忽略'
        END AS batch_status,
        CASE
          WHEN coalesce(b.shipped_quantity,0) > 0 AND b.arrived_date IS NOT NULL AND b.first_leg_freight_amount IS NOT NULL THEN 0
          WHEN coalesce(b.shipped_quantity,0) > 0 AND b.shipped_date IS NOT NULL THEN 1
          WHEN coalesce(b.shipped_quantity,0) > 0 THEN 2
          ELSE 9
        END AS batch_sort
      FROM fact.product_cost_batch b
      LEFT JOIN mart.inventory_depletion_product_current p
        ON p.match_key = dim.product_match_key(b.standard_goods_sn)
      WHERE coalesce(dim.product_match_key(b.standard_goods_sn),'') <> ''
        AND coalesce(b.shipped_quantity,0) > 0
    ),
    calc AS (
      SELECT
        src.*,
        sum(CASE WHEN batch_status = '已到仓' THEN coalesce(shipped_quantity,0) ELSE 0 END)
          OVER (PARTITION BY match_key ORDER BY arrived_date NULLS LAST, shipped_date NULLS LAST, batch_no, source_row_no ROWS UNBOUNDED PRECEDING) AS arrived_cum_quantity
      FROM src
    )
    SELECT
      standard_goods_sn,
      match_key,
      nullif(raw_summary->>'希音标准名','') AS goods_title,
      batch_no,
      shipped_date,
      arrived_date,
      batch_status,
      batch_sort,
      round(coalesce(shipped_quantity,0)::numeric, 0) AS shipped_quantity,
      round(CASE
        WHEN batch_status = '已到仓' THEN greatest(coalesce(arrived_cum_quantity,0) - coalesce(product_gross_sold_quantity,0), 0)
          - greatest(coalesce(arrived_cum_quantity,0) - coalesce(shipped_quantity,0) - coalesce(product_gross_sold_quantity,0), 0)
        ELSE coalesce(shipped_quantity,0)
      END::numeric, 0) AS estimated_remaining_quantity,
      round(coalesce(goods_cost_amount,0)::numeric, 2) AS goods_cost_amount,
      round(coalesce(first_leg_freight_amount,0)::numeric, 2) AS first_leg_freight_amount,
      round(coalesce(cost_sar,0)::numeric, 2) AS cost_sar,
      round(coalesce(unit_cost_sar,0)::numeric, 2) AS unit_cost_sar,
      complete_batch,
      ignored_reason,
      source_file,
      source_row_no
    FROM calc
    ORDER BY standard_goods_sn, batch_sort, arrived_date NULLS LAST, shipped_date NULLS LAST, batch_no
    LIMIT 1500
  ) t
),
finance AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS data
  FROM (
    SELECT
      business_snapshot_date AS snapshot_date,
      store_key,
      group_key,
      round(realtime_trade_amount_sar::numeric, 2) AS trade_amount_sar,
      realtime_pay_user_count AS pay_user_count,
      realtime_goods_uv AS goods_uv,
      quantity AS sale_count,
      round(in_transit_order_amount_sar::numeric, 2) AS in_transit_order_amount_sar,
      round(pending_settlement_income_sar::numeric, 2) AS pending_settlement_income_sar,
      round(payed_income_sar::numeric, 2) AS payed_income_sar,
      finance_no_finish_order_count,
      round(finance_no_finish_order_income_sar::numeric, 2) AS finance_no_finish_order_income_sar,
      account_period_days,
      privilege_config_type_desc,
      allow_view_report,
      round(settlement_abnormal_sar::numeric, 2) AS settlement_abnormal_sar,
      round(withdrawable_amount_sar::numeric, 2) AS withdrawable_amount_sar
    FROM mart.bi_business_store_current
    ORDER BY pending_settlement_income_sar DESC NULLS LAST, store_key
  ) t
),
finance_orders AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS data
  FROM (
    SELECT
      snapshot_date,
      store_key,
      group_key,
      order_delivery_time,
      order_no,
      finance_row_id,
      big_category_name,
      second_order_type_name,
      seller_currency_code,
      round(estimate_income_money_total::numeric, 2) AS estimate_income_money_total,
      goods_detail_count,
      finance_detail_count,
      check_status
    FROM fact.finance_no_finish_order
    ORDER BY coalesce(order_delivery_time::date, snapshot_date) DESC NULLS LAST, estimate_income_money_total DESC NULLS LAST, store_key
    LIMIT 5000
  ) t
),
finance_goods_rows AS (
  SELECT
    f.snapshot_date,
    f.store_key,
    f.group_key,
    f.order_no,
    fo.order_delivery_time,
    coalesce(nullif(f.standard_goods_sn,''), nullif(oi.standard_goods_sn,'')) AS standard_goods_sn,
    coalesce(nullif(f.raw_goods_sn,''), nullif(oi.raw_goods_sn,'')) AS raw_goods_sn,
    nullif(f.spu,'') AS spu,
    coalesce(nullif(f.skc,''), nullif(oi.skc,'')) AS skc,
    coalesce(nullif(f.sku_code,''), nullif(oi.sku_code,'')) AS sku_code,
    coalesce(nullif(f.goods_id,''), nullif(oi.goods_id,'')) AS goods_id,
    coalesce(nullif(f.entity_id,''), nullif(oi.entity_id,'')) AS entity_id,
    coalesce(nullif(f.goods_title,''), nullif(oi.goods_title,'')) AS goods_title,
    coalesce(f.quantity, oi.quantity, CASE WHEN coalesce(fo.goods_detail_count,0) > 0 THEN 1 ELSE NULL END) AS quantity,
    round(coalesce(
      f.amount,
      oi.sales_sar,
      fo.estimate_income_money_total / nullif(greatest(coalesce(fo.goods_detail_count,1),1),0)
    )::numeric, 2) AS amount,
    coalesce(nullif(f.currency_code,''), nullif(oi.currency_code,''), 'SAR') AS currency_code
  FROM fact.finance_no_finish_order_goods f
  LEFT JOIN LATERAL (
    SELECT oi.*
    FROM fact.order_item oi
    WHERE oi.store_key = f.store_key
      AND (
        (coalesce(f.entity_id,'') <> '' AND oi.entity_id = f.entity_id)
        OR (coalesce(f.order_no,'') <> '' AND oi.order_no = f.order_no)
      )
    ORDER BY oi.created_date DESC NULLS LAST
    LIMIT 1
  ) oi ON true
  LEFT JOIN fact.finance_no_finish_order fo
    ON fo.snapshot_date = f.snapshot_date
   AND fo.store_key = f.store_key
   AND fo.order_no = f.order_no
  WHERE f.snapshot_date = (SELECT max(snapshot_date) FROM fact.finance_no_finish_order_goods)
),
finance_goods AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS data
  FROM (
    SELECT *
    FROM finance_goods_rows
    ORDER BY amount DESC NULLS LAST, store_key, standard_goods_sn, skc
    LIMIT 180
  ) t
),
inventory_alerts AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY store_key, usable_inventory, inventory_quantity, standard_goods_sn, skc), '[]'::jsonb) AS data
  FROM (
    SELECT
      snapshot_date,
      store_key,
      group_key,
      standard_goods_sn,
      nullif(skc_list,'') AS skc,
      nullif(shelf_statuses,'') AS shelf_statuses,
      round(coalesce(inventory_quantity,0)::numeric, 0) AS inventory_quantity,
      round(coalesce(usable_inventory,0)::numeric, 0) AS usable_inventory,
      round(coalesce(order_locked_quantity,0)::numeric, 0) AS order_locked_quantity,
      round(coalesce(pay_locked_quantity,0)::numeric, 0) AS pay_locked_quantity,
      display_stock_low,
      source_file
    FROM fact.visible_inventory_snapshot
    WHERE snapshot_date = (SELECT max(snapshot_date) FROM fact.visible_inventory_snapshot)
      AND coalesce(display_stock_low,false)
      AND coalesce(shelf_statuses,'') LIKE '%ON_SHELF%'
      AND coalesce(standard_goods_sn,'') <> ''
    ORDER BY store_key, coalesce(usable_inventory, inventory_quantity, 999999), standard_goods_sn, skc_list
    LIMIT 600
  ) t
),
orders AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS data
  FROM (
    SELECT
      created_date, store_key, group_key, order_no, bill_no, order_create_time,
      standard_goods_sn, skc, goods_title,
      quantity, round(sales_sar::numeric, 2) AS sales_sar,
      goods_performance_status_desc
    FROM fact.order_item
    ORDER BY created_date DESC NULLS LAST, order_create_time DESC NULLS LAST, sales_sar DESC NULLS LAST
    LIMIT 12000
  ) t
),
after_sales_order_map AS (
  SELECT
    store_key,
    order_no,
    min(created_date)::date AS order_created_date,
    min(order_create_time) AS order_create_time,
    round(sum(coalesce(sales_sar,0))::numeric, 2) AS order_sales_sar
  FROM fact.order_item
  WHERE coalesce(order_no,'') <> ''
  GROUP BY store_key, order_no
),
after_sales AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS data
  FROM (
    SELECT
      a.snapshot_date, a.store_key, a.group_key, a.request_time,
      om.order_created_date, om.order_create_time, om.order_sales_sar,
      a.aftersales_order_no, a.return_order_no, a.order_no,
      a.standard_goods_sn, a.skc, a.goods_title,
      a.quantity,
      round(coalesce(om.order_sales_sar, a.estimated_income_amount, a.price_amount_total, a.price_amount, 0)::numeric, 2) AS price_amount_total,
      round(coalesce(om.order_sales_sar, a.estimated_income_amount, a.price_amount_total, a.price_amount, 0)::numeric, 2) AS amount_sar,
      a.resolution_plan_name, a.order_sub_status_name, a.return_package_status_name,
      a.reason_names, a.appeal_status
    FROM fact.after_sales_item a
    LEFT JOIN after_sales_order_map om
      ON om.store_key = a.store_key AND om.order_no = a.order_no
    WHERE a.request_time IS NOT NULL
      AND coalesce(a.order_sub_status_name,'') <> '已取消'
    ORDER BY a.request_time DESC NULLS LAST, coalesce(om.order_sales_sar, a.estimated_income_amount, a.price_amount_total, a.price_amount, 0) DESC NULLS LAST
    LIMIT 8000
  ) t
),
after_sales_review AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS data
  FROM (
    SELECT
      a.snapshot_date, a.store_key, a.group_key, a.request_time,
      om.order_created_date, om.order_create_time, om.order_sales_sar,
      a.aftersales_order_no, a.return_order_no, a.order_no,
      a.standard_goods_sn, a.skc, a.goods_title,
      a.quantity,
      round(coalesce(om.order_sales_sar, a.estimated_income_amount, a.price_amount_total, a.price_amount, 0)::numeric, 2) AS price_amount_total,
      round(coalesce(om.order_sales_sar, a.estimated_income_amount, a.price_amount_total, a.price_amount, 0)::numeric, 2) AS amount_sar,
      a.resolution_plan_name, a.order_sub_status_name, a.return_package_status_name,
      a.reason_names, a.appeal_status,
      greatest(0, (current_date - a.request_time::date))::int AS open_days,
      CASE
        WHEN coalesce(a.order_sub_status_name,'') = '已取消' THEN '已取消忽略'
        WHEN coalesce(a.order_sub_status_name,'') LIKE '%同意退款%' OR coalesce(a.return_package_status_name,'') LIKE '%已签收%' THEN '已落定'
        ELSE '待复核'
      END AS review_status,
      CASE
        WHEN coalesce(a.order_sub_status_name,'') LIKE '%待%' OR coalesce(a.return_package_status_name,'') LIKE '%待%' THEN '等待平台/买家/仓库推进'
        WHEN coalesce(a.return_package_status_name,'') LIKE '%运输%' OR coalesce(a.return_package_status_name,'') LIKE '%揽收%' THEN '物流途中，需持续追踪'
        ELSE '已按未取消售后计入退货；若后续取消，会在下次同步自动冲回'
      END AS review_reason
    FROM fact.after_sales_item a
    LEFT JOIN after_sales_order_map om
      ON om.store_key = a.store_key AND om.order_no = a.order_no
    WHERE a.request_time IS NOT NULL
      AND coalesce(a.order_sub_status_name,'') <> '已取消'
      AND NOT (coalesce(a.order_sub_status_name,'') LIKE '%同意退款%' OR coalesce(a.return_package_status_name,'') LIKE '%已签收%')
    ORDER BY a.request_time DESC NULLS LAST, open_days DESC, coalesce(om.order_sales_sar, a.estimated_income_amount, a.price_amount_total, a.price_amount, 0) DESC NULLS LAST
    LIMIT 1000
  ) t
),
rtv_review AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS data
  FROM (
    SELECT
      return_order_id, rtv,
      et_shipment_number_raw, et_shipment_number, suspected_emile_handoff,
      status_name, store_name_in, to_instock_name, in_quantity, create_time,
      standard_goods_sn, sku_code, store_key_guess, barcode, goods_title,
      received_quantity, exact_match_count, candidate_case_count,
      candidate_cases, review_reason, review_priority
    FROM mart.rtv_manual_review_candidates
    ORDER BY
      CASE review_priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
      create_time DESC NULLS LAST,
      return_order_id DESC
    LIMIT 1000
  ) t
),
rtv_trace AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS data
  FROM (
    SELECT
      store_key, group_key, order_no, return_order_no, aftersales_order_no,
      request_time, standard_goods_sn, skc,
      resolution_plan_name, order_sub_status_name, return_package_status_name,
      quantity, shein_return_express_numbers,
      rtv_received_quantity, rtv_received_to_09_quantity, rtv_received_to_rtv_quantity,
      rtv_recovery_status, rtv_express_numbers, et_return_order_ids,
      rtv_warehouses, rtv_latest_received_time,
      final_09_quantity, still_03_quantity, final_damaged_quantity,
      final_scrap_quantity, final_other_quantity,
      destination_summary, trace_status
    FROM mart.shein_return_rtv_trace
    ORDER BY
      CASE trace_status
        WHEN '未匹配到ET收件' THEN 0
        WHEN '已收-其它/未知去向' THEN 1
        WHEN '已收-未解析去向' THEN 2
        WHEN '已收-仍在03_RTV' THEN 3
        WHEN '已收-破损04' THEN 4
        WHEN '已收-报废06' THEN 5
        WHEN '已收-可售09' THEN 6
        ELSE 7
      END,
      request_time DESC NULLS LAST,
      rtv_latest_received_time DESC NULLS LAST
    LIMIT 8000
  ) t
),
waybills AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS data
  FROM (
    SELECT
      snapshot_date, store_key, group_key, place_order_package_id,
      express_code, express_no, warehouse_name, provider_name,
      show_status_desc, tag_desc, collect_time, print_time,
      goods_sn_list, skc_list, goods_quantity,
      round(estimate_performance_price::numeric, 2) AS estimate_performance_price
    FROM fact.waybill_package
    ORDER BY
      CASE WHEN coalesce(show_status_desc,'') ~ '(异常|失败|超时|取消)' THEN 0 ELSE 1 END,
      coalesce(collect_time, print_time, snapshot_date::timestamp) DESC NULLS LAST
    LIMIT 8000
  ) t
),
campaigns AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS data
  FROM (
    SELECT
      snapshot_date, store_key, group_key, business_activity_type,
      activity_name, active_status, start_date, end_date,
      active_product_cnt, avg_product_sale, round(avg_product_amt::numeric, 2) AS avg_product_amt,
      goods_uv, cart_uv, round(sale_amt::numeric, 2) AS sale_amt
    FROM fact.marketing_campaign_snapshot
    WHERE snapshot_date = (SELECT max(snapshot_date) FROM fact.marketing_campaign_snapshot)
    ORDER BY sale_amt DESC NULLS LAST, goods_uv DESC NULLS LAST, store_key
    LIMIT 120
  ) t
),
insights AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS data
  FROM (
    SELECT * FROM (
      SELECT
        'store' AS insight_domain,
        'business' AS action_domain,
        store_key,
        group_key,
        '' AS standard_goods_sn,
        '' AS skc,
        '店铺风险集中' AS title,
        '高' AS priority,
        least(180, round(risk_score::numeric, 1)) AS score,
        concat('综合风险分 ', round(risk_score::numeric,1), '；售后 ', after_sales_case_count, ' 单；低星评价 ', low_star_comment_count, ' 条；链接动作 ', link_action_count, ' 条。') AS evidence,
        '先进入店铺视角，判断风险主要来自售后、质量、链接还是履约，再决定当天分工。' AS next_step
      FROM mart.bi_business_store_current
      WHERE coalesce(risk_score,0) >= 90
      ORDER BY risk_score DESC
      LIMIT 6
    ) s
    UNION ALL
    SELECT * FROM (
      SELECT
        'product' AS insight_domain,
        'business' AS action_domain,
        '' AS store_key,
        '' AS group_key,
        standard_goods_sn,
        '' AS skc,
        '货号综合风险高' AS title,
        CASE WHEN coalesce(risk_score,0) >= 120 THEN '高' ELSE '中' END AS priority,
        least(190, round(risk_score::numeric, 1)) AS score,
        concat('销售 ', round(coalesce(sales_sar,0)::numeric,2), ' SAR；上架店 ', on_shelf_store_count, '/', (SELECT count(*) FROM dim.store WHERE enabled IS DISTINCT FROM false), '；缺店 ', missing_store_count, '；售后 ', after_sales_case_count, '；低星 ', low_star_comment_count, '。') AS evidence,
        '从货号 360 进入，优先判断是覆盖不足、质量售后集中，还是链接承接问题。' AS next_step
      FROM mart.bi_product_360_current
      WHERE coalesce(risk_score,0) >= 90
      ORDER BY risk_score DESC, sales_sar DESC
      LIMIT 8
    ) p
    UNION ALL
    SELECT * FROM (
      SELECT
        'link' AS insight_domain,
        'link' AS action_domain,
        store_key,
        group_key,
        standard_goods_sn,
        skc,
        '下架候选链接' AS title,
        '高' AS priority,
        least(150, (80 + coalesce(eps_uv,0) / 20.0 + coalesce(goods_uv,0) * 2 + coalesce(shelf_age_days,0) / 10.0))::numeric AS score,
        concat('已上架约 ', coalesce(shelf_age_days,0), ' 天；30天销量 ', coalesce(c30_sale_cnt,0), '；曝光 ', coalesce(eps_uv,0), '；商详访客 ', coalesce(goods_uv,0), '。') AS evidence,
        '如果同货号同店已有更好链接，可复核后下架；如果是唯一承接，先补新链接再淘汰。' AS next_step
      FROM mart.bi_link_health_current
      WHERE retire_candidate
      ORDER BY eps_uv DESC NULLS LAST, goods_uv DESC NULLS LAST
      LIMIT 8
    ) l
    UNION ALL
    SELECT * FROM (
      SELECT
        'inventory' AS insight_domain,
        'inventory' AS action_domain,
        store_key,
        group_key,
        standard_goods_sn,
        skc,
        '已上架展示库存偏低' AS title,
        priority,
        score,
        evidence,
        next_step
      FROM mart.bi_guided_action_current
      WHERE action_domain = 'inventory'
      ORDER BY score DESC
      LIMIT 6
    ) i
    UNION ALL
    SELECT * FROM (
      SELECT
        'after_sales' AS insight_domain,
        'after_sales' AS action_domain,
        store_key,
        group_key,
        standard_goods_sn,
        skc,
        '售后集中货号' AS title,
        priority,
        score,
        evidence,
        next_step
      FROM mart.bi_guided_action_current
      WHERE action_domain = 'after_sales'
      ORDER BY score DESC
      LIMIT 8
    ) a
    UNION ALL
    SELECT * FROM (
      SELECT
        'fulfillment' AS insight_domain,
        'business' AS action_domain,
        store_key,
        '' AS group_key,
        '' AS standard_goods_sn,
        '' AS skc,
        '履约异常/取消包裹集中' AS title,
        CASE WHEN n >= 10 THEN '高' ELSE '中' END AS priority,
        (70 + n * 3)::numeric AS score,
        concat(show_status_desc, ' 包裹 ', n, ' 个。') AS evidence,
        '进入订单/售后页查看面单与物流商，确认是否为取消、仓库或承运商问题。' AS next_step
      FROM (
        SELECT
          store_key,
          coalesce(nullif(show_status_desc,''),'未知状态') AS show_status_desc,
          count(*) AS n
        FROM fact.waybill_package
        WHERE snapshot_date = (SELECT max(snapshot_date) FROM fact.waybill_package)
          AND coalesce(show_status_desc,'') ~ '(异常|失败|超时|取消|已取消)'
        GROUP BY store_key, coalesce(nullif(show_status_desc,''),'未知状态')
        ORDER BY n DESC
        LIMIT 6
      ) w
    ) f
    UNION ALL
    SELECT * FROM (
      SELECT
        'finance' AS insight_domain,
        'finance' AS action_domain,
        store_key,
        group_key,
        '' AS standard_goods_sn,
        '' AS skc,
        '财务关注' AS title,
        CASE
          WHEN coalesce(settlement_abnormal_sar,0) > 0 THEN '高'
          WHEN coalesce(finance_no_finish_order_income_sar,0) >= 3000 THEN '中'
          ELSE '中'
        END AS priority,
        least(145, (
          72
          + coalesce(finance_no_finish_order_count,0) * 1.2
          + coalesce(finance_no_finish_order_income_sar,0) / 180.0
          + CASE WHEN coalesce(settlement_abnormal_sar,0) > 0 THEN 35 ELSE 0 END
        ))::numeric AS score,
        concat('在途明细 ', coalesce(finance_no_finish_order_count,0), ' 单 / ', round(coalesce(finance_no_finish_order_income_sar,0)::numeric,2), ' SAR；待结算 ', round(coalesce(pending_settlement_income_sar,0)::numeric,2), ' SAR；已结算 ', round(coalesce(payed_income_sar,0)::numeric,2), ' SAR；账期 ', coalesce(account_period_days::text,'-'), ' 天。') AS evidence,
        '进入订单/售后页查看“收入明细 · 在途订单”，和当日订单销售互相核对；其它店还没财务明细时不要误判为 0。' AS next_step
      FROM mart.bi_business_store_current
      WHERE coalesce(finance_no_finish_order_count,0) > 0
         OR coalesce(settlement_abnormal_sar,0) > 0
      ORDER BY score DESC, finance_no_finish_order_income_sar DESC NULLS LAST
      LIMIT 6
    ) fin
    UNION ALL
    SELECT * FROM (
      SELECT
        'finance' AS insight_domain,
        'finance' AS action_domain,
        store_key,
        group_key,
        standard_goods_sn,
        '' AS skc,
        '在途收入集中货号' AS title,
        CASE WHEN coalesce(sum(amount),0) >= 300 THEN '中' ELSE '低' END AS priority,
        least(135, (66 + count(*) * 5 + coalesce(sum(amount),0) / 8.0))::numeric AS score,
        concat('在途收入商品 ', count(*), ' 条 / ', round(coalesce(sum(amount),0)::numeric,2), ' SAR；数量 ', coalesce(sum(quantity),0), '；涉及订单 ', count(distinct order_no), ' 个。') AS evidence,
        '进入货号 360 查看“财务在途商品”，再和订单、售后、链接动作交叉判断是否需要优先跟进。' AS next_step
      FROM finance_goods_rows
      WHERE coalesce(standard_goods_sn,'') <> ''
      GROUP BY store_key, group_key, standard_goods_sn
      ORDER BY score DESC, sum(amount) DESC NULLS LAST
      LIMIT 5
    ) fing
    UNION ALL
    SELECT * FROM (
      SELECT
        'finance' AS insight_domain,
        'finance' AS action_domain,
        store_key,
        group_key,
        '' AS standard_goods_sn,
        '' AS skc,
        '财务商品待匹配' AS title,
        '中' AS priority,
        least(115, (60 + count(*) * 1.8 + coalesce(sum(amount),0) / 20.0))::numeric AS score,
        concat('在途收入商品 ', count(*), ' 条还没有匹配到货号/SKC；已保留 entity_id，预估金额 ', round(coalesce(sum(amount),0)::numeric,2), ' SAR。') AS evidence,
        '进入订单/售后页的“收入明细 · 商品 / SKC”，按 entity_id 复核；后续可继续补商品映射提高匹配率。' AS next_step
      FROM finance_goods_rows
      WHERE coalesce(standard_goods_sn,'') = ''
      GROUP BY store_key, group_key
      HAVING count(*) > 0
      ORDER BY score DESC, count(*) DESC
      LIMIT 3
    ) finm
    UNION ALL
    SELECT * FROM (
      SELECT
        'marketing' AS insight_domain,
        'business' AS action_domain,
        store_key,
        group_key,
        '' AS standard_goods_sn,
        '' AS skc,
        '营销活动贡献' AS title,
        '中' AS priority,
        least(105, (60 + coalesce(sale_amt,0) / 120.0 + coalesce(goods_uv,0)))::numeric AS score,
        concat(coalesce(activity_name,'未命名活动'), '；销售 ', round(coalesce(sale_amt,0)::numeric,2), ' SAR；曝光 ', coalesce(goods_uv,0), '；参与商品 ', coalesce(active_product_cnt,0), '。') AS evidence,
        '进入营销活动明细，看活动贡献是否集中在少数店/少数商品，决定是否复制到其它店。' AS next_step
      FROM fact.marketing_campaign_snapshot
      WHERE snapshot_date = (SELECT max(snapshot_date) FROM fact.marketing_campaign_snapshot)
        AND coalesce(sale_amt,0) > 0
      ORDER BY sale_amt DESC NULLS LAST
      LIMIT 6
    ) m
    ORDER BY score DESC
    LIMIT 42
  ) t
),
trend_sales_daily AS (
  SELECT
    date,
    round(sum(coalesce(sales_sar,0))::numeric, 2) AS sales_sar,
    sum(coalesce(orders,0)) AS orders,
    round(sum(coalesce(quantity,0))::numeric, 0) AS quantity
  FROM net_daily_store_sales
  GROUP BY date
  ORDER BY date DESC
  LIMIT 14
),
trend_sales_series AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY date), '[]'::jsonb) AS data
  FROM (
    SELECT date, sales_sar, orders, quantity
    FROM trend_sales_daily
    ORDER BY date
  ) t
),
trend_link_daily AS (
  SELECT
    date,
    round(sum(coalesce(sale_cnt,0))::numeric, 2) AS sale_cnt,
    round(sum(coalesce(eps_uv,0))::numeric, 0) AS eps_uv,
    round(sum(coalesce(goods_uv,0))::numeric, 0) AS goods_uv,
    round(avg(nullif(click_rate,0))::numeric, 4) AS avg_click_rate,
    round(avg(nullif(pay_rate,0))::numeric, 4) AS avg_pay_rate
  FROM fact.link_performance_daily
  GROUP BY date
  ORDER BY date DESC
  LIMIT 14
),
trend_link_series AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY date), '[]'::jsonb) AS data
  FROM (
    SELECT date, sale_cnt, eps_uv, goods_uv, avg_click_rate, avg_pay_rate
    FROM trend_link_daily
    ORDER BY date
  ) t
),
trend_business_daily AS (
  SELECT
    snapshot_date AS date,
    round(sum(coalesce(trade_amount_sar,0))::numeric, 2) AS trade_amount_sar,
    round(sum(coalesce(in_transit_order_amount_sar,0))::numeric, 2) AS in_transit_sar,
    round(sum(coalesce(pending_settlement_income_sar,0))::numeric, 2) AS pending_settlement_sar,
    round(sum(coalesce(pay_user_count,0))::numeric, 0) AS pay_users
  FROM fact.home_finance_snapshot
  GROUP BY snapshot_date
  ORDER BY snapshot_date DESC
  LIMIT 14
),
trend_business_series AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY date), '[]'::jsonb) AS data
  FROM (
    SELECT date, trade_amount_sar, in_transit_sar, pending_settlement_sar, pay_users
    FROM trend_business_daily
    ORDER BY date
  ) t
),
trend_after_sales_daily AS (
  SELECT
    date,
    case_count,
    amount_sar
  FROM after_sales_event_daily
  WHERE date >= (SELECT max(date) FROM fact.store_daily_sales) - interval '89 days'
  ORDER BY date DESC
  LIMIT 90
),
trend_after_sales_series AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY date), '[]'::jsonb) AS data
  FROM (
    SELECT date, case_count, amount_sar
    FROM trend_after_sales_daily
    ORDER BY date
  ) t
),
trend_after_sales_group_daily AS (
  SELECT
    date,
    group_key,
    case_count,
    amount_sar
  FROM after_sales_event_group_daily
  WHERE date >= (SELECT max(date) FROM fact.store_daily_sales) - interval '89 days'
  ORDER BY date DESC, group_key
  LIMIT 300
),
trend_after_sales_group_series AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY date, group_key), '[]'::jsonb) AS data
  FROM (
    SELECT date, group_key, case_count, amount_sar
    FROM trend_after_sales_group_daily
    ORDER BY date, group_key
  ) t
),
trend_finance_daily AS (
  SELECT
    snapshot_date AS date,
    count(*) AS order_count,
    round(sum(coalesce(estimate_income_money_total,0))::numeric, 2) AS estimate_income_sar
  FROM fact.finance_no_finish_order
  GROUP BY snapshot_date
  ORDER BY snapshot_date DESC
  LIMIT 14
),
trend_finance_series AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY date), '[]'::jsonb) AS data
  FROM (
    SELECT date, order_count, estimate_income_sar
    FROM trend_finance_daily
    ORDER BY date
  ) t
),
trend_sales_ranked_dates AS (
  SELECT date, row_number() OVER (ORDER BY date DESC) AS rn
  FROM (SELECT DISTINCT date FROM net_daily_store_sales) d
),
trend_store_sales_change AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY abs(change_sar) DESC), '[]'::jsonb) AS data
  FROM (
    SELECT
      coalesce(c.store_key, p.store_key) AS store_key,
      round(coalesce(c.sales_sar,0)::numeric, 2) AS current_sales_sar,
      round(coalesce(p.sales_sar,0)::numeric, 2) AS previous_sales_sar,
      round((coalesce(c.sales_sar,0) - coalesce(p.sales_sar,0))::numeric, 2) AS change_sar,
      CASE WHEN coalesce(p.sales_sar,0) = 0 THEN NULL
        ELSE round(((coalesce(c.sales_sar,0) - coalesce(p.sales_sar,0)) / nullif(p.sales_sar,0) * 100)::numeric, 1)
      END AS change_pct
    FROM (
      SELECT store_key, sum(coalesce(sales_sar,0)) AS sales_sar
      FROM net_daily_store_sales
      WHERE date = (SELECT date FROM trend_sales_ranked_dates WHERE rn = 1)
      GROUP BY store_key
    ) c
    FULL JOIN (
      SELECT store_key, sum(coalesce(sales_sar,0)) AS sales_sar
      FROM net_daily_store_sales
      WHERE date = (SELECT date FROM trend_sales_ranked_dates WHERE rn = 2)
      GROUP BY store_key
    ) p USING (store_key)
    WHERE (SELECT count(*) FROM trend_sales_ranked_dates WHERE rn <= 2) >= 2
    ORDER BY abs(coalesce(c.sales_sar,0) - coalesce(p.sales_sar,0)) DESC
    LIMIT 8
  ) t
),
trend_readiness AS (
  SELECT jsonb_build_object(
    'salesDays', (SELECT count(DISTINCT date) FROM fact.store_daily_sales),
    'linkDays', (SELECT count(DISTINCT date) FROM fact.link_performance_daily),
    'businessDays', (SELECT count(DISTINCT snapshot_date) FROM fact.home_finance_snapshot),
    'afterSalesDays', (SELECT count(DISTINCT snapshot_date) FROM fact.after_sales_item),
    'financeDays', (SELECT count(DISTINCT snapshot_date) FROM fact.finance_no_finish_order),
    'salesSeries', (SELECT data FROM trend_sales_series),
    'linkSeries', (SELECT data FROM trend_link_series),
    'businessSeries', (SELECT data FROM trend_business_series),
    'afterSalesSeries', (SELECT data FROM trend_after_sales_series),
    'afterSalesGroupSeries', (SELECT data FROM trend_after_sales_group_series),
    'afterSalesSource', jsonb_build_object(
      'kind', 'request_time',
      'label', '按售后申请时间',
      'snapshotDays', (SELECT count(DISTINCT snapshot_date) FROM fact.after_sales_item),
      'eventDays', (SELECT count(DISTINCT date) FROM after_sales_event_daily),
      'latestEventDate', (SELECT max(date) FROM after_sales_event_daily)
    ),
    'financeSeries', (SELECT data FROM trend_finance_series),
    'storeSalesChange', (SELECT data FROM trend_store_sales_change)
  ) AS data
)
SELECT jsonb_build_object(
  'generatedAt', now(),
  'dates', (SELECT data FROM dates),
  'kpi', (SELECT data FROM kpi),
  'stores', (SELECT data FROM stores),
  'products', (SELECT data FROM products),
  'rankings', jsonb_build_object(
    'salesSummary', (SELECT data FROM sales_period_summary),
    'stores', (SELECT data FROM store_period_rank),
    'products', (SELECT data FROM product_period_rank),
    'dailyStores', (SELECT data FROM daily_store_sales),
    'dailyProducts', (SELECT data FROM daily_product_sales),
    'dailyProductGroups', (SELECT data FROM daily_product_group_sales),
    'dailyStoreProducts', (SELECT data FROM daily_store_product_sales)
  ),
  'profit', jsonb_build_object(
    'dailyStoreProducts', (SELECT data FROM profit_daily_store_product),
    'monthGroups', (SELECT data FROM profit_month_group),
    'products', (SELECT data FROM profit_product_summary)
  ),
  'inventoryDepletion', jsonb_build_object(
    'products', (SELECT data FROM inventory_depletion_products),
    'batches', (SELECT data FROM inventory_depletion_batches),
    'method', jsonb_build_object(
      'stockBasis', '成本表批次 + 毛销量 FIFO 扣减',
      'arrivalRule', '到仓/派送日期和头程运输费均存在才计入到仓库存；缺任一项计入在途或待确认',
      'salesDeduction', '库存消耗按毛销量扣减，退货暂不加回，避免高估可售库存',
      'velocityRule', '日均销量 = 近7天毛销量/7 × 40% + 近30天毛销量/30 × 60%'
    )
  ),
  'actions', (SELECT data FROM actions),
  'links', (SELECT data FROM links),
  'duplicateLinks', (SELECT data FROM duplicate_links),
  'storeLinks', (SELECT data FROM store_links),
  'matrix', (SELECT data FROM matrix),
  'comments', (SELECT data FROM comments),
  'commentSummary', (SELECT data FROM comment_summary),
  'actionDomain', (SELECT data FROM action_domain),
  'finance', (SELECT data FROM finance),
  'financeOrders', (SELECT data FROM finance_orders),
  'financeGoods', (SELECT data FROM finance_goods),
  'inventoryAlerts', (SELECT data FROM inventory_alerts),
  'orders', (SELECT data FROM orders),
  'afterSales', (SELECT data FROM after_sales),
  'afterSalesReview', (SELECT data FROM after_sales_review),
  'rtvReview', (SELECT data FROM rtv_review),
  'rtvTrace', (SELECT data FROM rtv_trace),
  'waybills', (SELECT data FROM waybills),
  'campaigns', (SELECT data FROM campaigns),
  'insights', (SELECT data FROM insights),
  'trend', (SELECT data FROM trend_readiness)
)::text;
`;
}

function svgIcon(name) {
  const common = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  const paths = {
    home: '<path d="m3 10.5 9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/>',
    store: '<path d="M4 10h16l-1.4-5H5.4L4 10Z"/><path d="M5 10v10h14V10"/><path d="M8 20v-6h3v6"/><path d="M14 14h2"/>',
    box: '<path d="M21 8 12 3 3 8l9 5 9-5Z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1 0l-2 2a5 5 0 0 0 7.1 7.1l1.1-1.1"/>',
    action: '<path d="M13 2 3 14h8l-1 8 11-13h-8l1-7Z"/>',
    metabase: '<path d="M4 19V5"/><path d="M9 19V9"/><path d="M14 19V7"/><path d="M19 19V11"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    alert: '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><rect x="4" y="4" width="11" height="11" rx="2"/>',
  };
  return `<svg aria-hidden="true" ${common}>${paths[name] || paths.home}</svg>`;
}

function buildHtml(data, metabaseUrl, audit, pipeline, briefing, firstRunCheck) {
  const json = JSON.stringify({...data, audit, pipeline, briefing, firstRunCheck}).replace(/</g, '\\u003c');
  const links = {
    home: `${metabaseUrl}/dashboard/13`,
    finance: `${metabaseUrl}/dashboard/14`,
    quality: `${metabaseUrl}/dashboard/15`,
    ops: `${metabaseUrl}/dashboard/16`,
    store: `${metabaseUrl}/dashboard/6`,
    product: `${metabaseUrl}/dashboard/7`,
    skc: `${metabaseUrl}/dashboard/8`,
  };
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SHEIN BI 经营系统</title>
  <style>
    :root{
      --bg:#050814; --surface:rgba(15,23,42,.72); --surface-2:rgba(30,41,59,.62);
      --text:#e5edf8; --muted:#93a4bb; --faint:#64748b; --line:rgba(148,163,184,.18);
      --cyan:#22d3ee; --blue:#60a5fa; --violet:#a78bfa; --pink:#f472b6;
      --green:#34d399; --amber:#fbbf24; --red:#fb7185; --orange:#fb923c;
      --radius:24px; --shadow:0 24px 90px rgba(0,0,0,.38);
      --mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono",monospace;
      font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;
    }
    body[data-theme="light"]{
      --bg:#f5f7fb; --surface:#ffffff; --surface-2:#f8fafc;
      --text:#0f172a; --muted:#64748b; --faint:#94a3b8; --line:#e2e8f0;
      --cyan:#0891b2; --blue:#2563eb; --violet:#8b5cf6; --pink:#db2777;
      --green:#10b981; --amber:#d97706; --red:#e11d48; --orange:#f97316;
      --shadow:0 18px 48px rgba(15,23,42,.10);
      color-scheme:light;
      background:#f5f7fb;
    }
    *{box-sizing:border-box}
    body *{min-width:0}
    html{scroll-behavior:smooth}
    body{margin:0;min-height:100dvh;color:var(--text);background:
      radial-gradient(circle at 12% 6%,rgba(96,165,250,.28),transparent 30%),
      radial-gradient(circle at 82% 8%,rgba(167,139,250,.28),transparent 32%),
      radial-gradient(circle at 78% 88%,rgba(34,211,238,.12),transparent 30%),
      linear-gradient(135deg,#050816 0%,#08111f 52%,#050814 100%);}
    body:before{content:"";position:fixed;inset:0;pointer-events:none;background-image:
      linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),
      linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px);background-size:42px 42px;mask-image:linear-gradient(to bottom,black,transparent 88%);}
    body[data-theme="light"]:before{background-image:
      linear-gradient(rgba(15,23,42,.035) 1px,transparent 1px),
      linear-gradient(90deg,rgba(15,23,42,.035) 1px,transparent 1px);opacity:.45;mask-image:linear-gradient(to bottom,black,transparent 72%)}
    button,a,input,select{font:inherit}
    button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid rgba(34,211,238,.55);outline-offset:2px}
    a{color:inherit;text-decoration:none}
    .shell{display:grid;grid-template-columns:286px 1fr;min-height:100dvh}
    .side{position:sticky;top:0;height:100dvh;padding:24px;border-right:1px solid var(--line);background:rgba(2,6,23,.68);backdrop-filter:blur(24px);overflow:auto}
    body[data-theme="light"] .side{background:#ffffff;box-shadow:1px 0 0 rgba(226,232,240,.8)}
    .brand{display:flex;align-items:center;gap:12px;margin-bottom:28px}
    .logo{width:46px;height:46px;border-radius:17px;background:linear-gradient(135deg,var(--cyan),var(--violet));box-shadow:0 0 36px rgba(34,211,238,.34);display:grid;place-items:center;color:#fff}
    .logo svg,.nav svg,.btn svg,.link-pill svg,.copy svg{width:18px;height:18px;flex:none}
    .brand h1{margin:0;font-size:18px;line-height:1.1;letter-spacing:.02em}
    .brand p{margin:4px 0 0;color:var(--muted);font-size:12px}
    .nav{display:grid;gap:8px}
    .nav button,.nav a{width:100%;min-height:44px;display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid transparent;border-radius:15px;background:transparent;color:var(--muted);cursor:pointer;text-align:left}
    .nav button:hover,.nav a:hover,.nav button.active{color:#fff;background:rgba(96,165,250,.13);border-color:rgba(96,165,250,.25)}
    body[data-theme="light"] .nav button:hover,body[data-theme="light"] .nav a:hover,body[data-theme="light"] .nav button.active{color:#0f172a;background:rgba(37,99,235,.10)}
    .meta{margin-top:24px;padding:15px;border:1px solid var(--line);border-radius:18px;background:rgba(15,23,42,.55);color:var(--muted);font-size:12px;line-height:1.7}
    .meta small{display:block;color:var(--muted);font-size:11px;line-height:1.45;margin-top:2px;font-family:var(--mono)}
    body[data-theme="light"] .meta{background:#f8fafc;color:#64748b}
    .audit-ok{color:#bbf7d0}.audit-warn{color:#fde68a}.audit-bad{color:#fecdd3}
    main{position:relative;width:100%;max-width:calc(100vw - 286px);margin:0 auto;padding:28px}
    body[data-current-tab="overview"] main{padding-left:18px;padding-right:18px}
    .hero{position:relative;overflow:hidden;border:1px solid var(--line);border-radius:32px;background:linear-gradient(135deg,rgba(15,23,42,.88),rgba(30,41,59,.52));box-shadow:var(--shadow);padding:28px;margin-bottom:18px}
    body:not([data-current-tab="overview"]) .hero{display:none}
    body[data-theme="light"] .hero{background:linear-gradient(180deg,#ffffff 0%,#f8fafc 100%);box-shadow:0 18px 54px rgba(15,23,42,.08)}
    .hero:after{content:"";position:absolute;width:520px;height:520px;border-radius:999px;right:-210px;top:-260px;background:radial-gradient(circle,rgba(34,211,238,.32),transparent 66%);filter:blur(8px)}
    body[data-theme="light"] .hero:after{background:radial-gradient(circle,rgba(37,99,235,.11),transparent 66%)}
    .hero-top{position:relative;z-index:1;display:flex;justify-content:space-between;gap:20px;align-items:flex-start}
    .eyebrow{color:var(--cyan);font-weight:800;letter-spacing:.16em;font-size:12px;text-transform:uppercase}
    h2{margin:10px 0 12px;font-size:40px;line-height:1.05;letter-spacing:-.035em;max-width:940px}
    .hero p{margin:0;max-width:900px;color:var(--muted);line-height:1.75}
    .quick-links{display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end;min-width:300px}
    .link-pill,.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:42px;border-radius:999px;border:1px solid rgba(148,163,184,.24);padding:10px 14px;background:rgba(15,23,42,.62);color:#dbeafe;cursor:pointer}
    body[data-theme="light"] .link-pill,body[data-theme="light"] .btn{background:#ffffff;color:#1e3a8a;box-shadow:0 1px 2px rgba(15,23,42,.05)}
    .link-pill:hover,.btn:hover{border-color:rgba(34,211,238,.62);box-shadow:0 0 0 4px rgba(34,211,238,.08)}
    .theme-fab{position:fixed;right:18px;bottom:18px;z-index:760;min-height:42px;border-radius:999px;border:1px solid rgba(148,163,184,.28);background:rgba(15,23,42,.88);color:#e0f2fe;padding:9px 14px;font-weight:850;cursor:pointer;box-shadow:0 18px 44px rgba(0,0,0,.22);backdrop-filter:blur(14px)}
    .theme-fab:hover{border-color:rgba(34,211,238,.62);box-shadow:0 0 0 4px rgba(34,211,238,.08),0 18px 44px rgba(0,0,0,.22)}
    body[data-theme="light"] .theme-fab{background:#ffffff;color:#1e3a8a;border-color:#dbe3ef;box-shadow:0 14px 34px rgba(15,23,42,.14)}
    .overview-dock{position:relative;z-index:1;margin-top:24px;border:1px solid rgba(148,163,184,.18);border-radius:26px;background:rgba(2,6,23,.30);padding:18px;overflow:visible}
    body[data-theme="light"] .overview-dock{background:#f8fafc;border-color:#dbe3ef;box-shadow:inset 0 1px 0 rgba(255,255,255,.9)}
    .overview-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:14px;flex-wrap:wrap}
    .overview-head>div{min-width:260px;flex:1}
    .overview-head h3{margin:0;font-size:20px}
    .overview-head .sub{font-size:13px;color:var(--muted);margin-top:4px}
    .home-scope-toolbar{display:grid;grid-template-columns:minmax(260px,1.1fr) minmax(180px,.55fr) auto;gap:10px;align-items:center;margin:0 0 14px;padding:12px;border:1px solid rgba(148,163,184,.16);border-radius:20px;background:rgba(15,23,42,.42)}
    .toolbar .home-scope-toolbar{display:contents}
    body:not([data-current-tab="overview"]) .toolbar .home-scope-toolbar{display:none}
    body:not([data-current-tab="overview"]) .toolbar .home-only-filter{display:none}
    body[data-current-tab="overview"] .toolbar .subpage-filter{display:none!important}
    body:not([data-current-tab="actions"]) .toolbar .action-scope-toolbar{display:none!important}
    body[data-current-tab="actions"] .toolbar{grid-template-columns:minmax(260px,1.05fr) minmax(220px,.82fr) minmax(150px,.5fr) 92px minmax(620px,1.75fr)}
    body[data-current-tab="actions"] .toolbar .subpage-filter{display:block!important}
    body[data-current-tab="actions"] .toolbar-range-dock{display:none!important}
    body[data-theme="light"] .home-scope-toolbar{background:#ffffff;border-color:#e2e8f0;box-shadow:0 6px 18px rgba(15,23,42,.04)}
    .home-scope-hint{display:flex;gap:8px;align-items:center;justify-content:flex-end;flex-wrap:wrap;color:var(--muted);font-size:12px;font-weight:800}
    .toolbar .home-scope-hint{height:38px;min-height:38px;overflow:hidden;flex-wrap:nowrap;justify-content:flex-start}
    .toolbar .home-scope-hint .tag{white-space:nowrap}
    .home-scope-hint .tag{margin:0}
    .overview-core{display:grid;grid-template-columns:1fr;gap:14px;align-items:stretch;margin-bottom:16px}
    .overview-core .kpis{grid-template-columns:repeat(2,minmax(0,1fr));margin:0}
    .overview-core .group-summary-grid.two{grid-template-columns:repeat(2,minmax(0,1fr));margin:0;height:100%}
    .overview-core .group-card{min-height:0}
    .overview-core #groupOverview{height:100%}
    #groupOverview:empty{display:none}
    .kpis{position:relative;z-index:1;display:grid;grid-template-columns:repeat(6,minmax(132px,1fr));gap:14px;margin:0 0 16px}
    .kpi{padding:17px;border-radius:22px;border:1px solid var(--line);background:rgba(2,6,23,.43);color:var(--text);text-align:left;cursor:pointer;transition:.18s transform,.18s border-color,.18s box-shadow}
    .kpi:hover{transform:translateY(-2px);border-color:rgba(34,211,238,.55);box-shadow:0 0 0 4px rgba(34,211,238,.07)}
    body[data-theme="light"] .kpi{background:#ffffff;box-shadow:0 8px 22px rgba(15,23,42,.06)}
    .kpi span{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:13px;font-weight:750}
    .kpi strong{display:block;margin-top:8px;font-size:25px;letter-spacing:-.035em;font-variant-numeric:tabular-nums}
    .kpi b{display:block;margin-top:5px;color:var(--text);font-size:14px;font-weight:750;line-height:1.42}
    .kpi small{display:block;margin-top:8px;color:var(--muted);font-size:13px;line-height:1.45}
    .help{position:relative;z-index:520;display:inline-grid;place-items:center;width:17px;height:17px;border-radius:999px;border:1px solid rgba(148,163,184,.26);color:#cbd5e1;font-size:11px;cursor:help}
    body[data-theme="light"] .help{color:#334155;background:rgba(255,255,255,.75)}
    .help:hover:after,.help:focus-visible:after{content:attr(data-tip);position:absolute;left:50%;bottom:calc(100% + 10px);transform:translateX(-50%);z-index:620;width:260px;padding:10px 12px;border-radius:14px;border:1px solid rgba(148,163,184,.28);background:rgba(2,6,23,.96);color:#e5edf8;box-shadow:var(--shadow);font-size:12px;line-height:1.55;text-align:left;white-space:normal}
    body[data-theme="light"] .help:hover:after,body[data-theme="light"] .help:focus-visible:after{background:#fff;color:#0f172a}
    .toolbar{position:sticky;top:12px;z-index:380;display:grid;grid-template-columns:minmax(270px,360px) 150px 300px 88px minmax(440px,1fr);gap:10px;margin:0 0 16px;padding:8px;border:1px solid var(--line);border-radius:18px;background:rgba(3,7,18,.84);backdrop-filter:blur(18px);box-shadow:0 18px 50px rgba(0,0,0,.22);align-items:center}
    body:not([data-current-tab="overview"]):not([data-current-tab="actions"]) .toolbar{grid-template-columns:minmax(210px,.7fr) minmax(210px,.7fr) minmax(90px,.3fr) 92px minmax(728px,1.68fr)}
    body[data-theme="light"] .toolbar{background:rgba(255,255,255,.96);box-shadow:0 14px 34px rgba(15,23,42,.12)}
    .toolbar-range-dock{grid-column:auto;margin-top:0}
    .toolbar-range-dock[hidden]{display:none!important}
    .toolbar-range-dock .range-toolbar{position:relative;top:auto;margin:0;border-radius:14px;box-shadow:none;background:rgba(15,23,42,.55)}
    body[data-theme="light"] .toolbar-range-dock .range-toolbar{background:#f8fafc;box-shadow:none}
    .toolbar-range-dock .range-toolbar-main{grid-template-columns:minmax(178px,.34fr) minmax(360px,1fr);padding:5px;gap:8px;align-items:center}
    .toolbar-range-dock .range-button{min-height:38px;padding:6px 10px;border-radius:12px}
    .toolbar-range-dock .range-button span,.toolbar-range-dock .range-button small{display:none}
    .toolbar-range-dock .range-button strong{font-size:14px;white-space:nowrap}
    .toolbar-range-dock .range-preset-strip{flex-wrap:nowrap;overflow-x:auto;gap:5px;padding-bottom:0;scrollbar-width:thin}
    .toolbar-range-dock .range-preset-strip button{min-height:30px;padding:5px 8px;font-size:12px;white-space:nowrap}
    .toolbar-range-dock .range-current-tags{display:none}
    .focusbar{display:flex;gap:10px;flex-wrap:wrap;margin:-6px 0 18px;padding:0 4px}
    .toolbar .btn{height:38px;min-height:38px;padding:6px 10px;border-radius:12px;font-size:13px}
    .action-local-filter{border:1px solid rgba(34,211,238,.18);border-radius:20px;background:linear-gradient(135deg,rgba(14,165,233,.10),rgba(15,23,42,.38));padding:14px;margin:0 0 14px}
    .toolbar .action-local-filter{grid-column:auto;margin:0;padding:0;border:0;background:transparent}
    .action-local-filter-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:10px;flex-wrap:wrap}
    .toolbar .action-local-filter-head{display:none}
    .action-local-filter-head strong{font-size:15px}.action-local-filter-head span{color:var(--muted);font-size:12px;line-height:1.55;max-width:720px}
    .action-local-filter-controls{display:grid;grid-template-columns:repeat(3,minmax(160px,1fr));gap:10px;margin-bottom:12px}
    .toolbar .action-local-filter-controls{grid-template-columns:repeat(3,minmax(120px,1fr));gap:8px;margin-bottom:0}
    .action-focusbar{margin:0;padding:0}
    .toolbar .action-focusbar{display:none}
    body[data-theme="light"] .action-local-filter{background:#f8fafc;border-color:#dbeafe}
    .focus-chip{min-height:40px;border:1px solid rgba(148,163,184,.22);border-radius:999px;background:rgba(15,23,42,.68);color:#dbeafe;padding:8px 13px;cursor:pointer;display:inline-flex;align-items:center;gap:8px}
    .focus-chip:hover,.focus-chip.active{border-color:rgba(34,211,238,.55);background:rgba(34,211,238,.11);box-shadow:0 0 0 4px rgba(34,211,238,.06)}
    body[data-theme="light"] .focus-chip{background:#ffffff;color:#334155;border-color:#dbe3ef;box-shadow:0 1px 2px rgba(15,23,42,.04)}
    body[data-theme="light"] .focus-chip:hover,body[data-theme="light"] .focus-chip.active{color:#0f172a;background:#e0f2fe;border-color:#67e8f9;box-shadow:0 0 0 4px rgba(8,145,178,.08)}
    .focus-chip small{color:var(--muted);font-family:var(--mono)}
    .search-wrap{position:relative}.search-wrap svg{position:absolute;left:13px;top:13px;width:18px;height:18px;color:var(--muted)}
    input,select{width:100%;height:38px;min-height:38px;border:1px solid rgba(148,163,184,.22);border-radius:12px;background:rgba(15,23,42,.90);color:#fff;padding:0 12px;outline:none}
    body[data-theme="light"] input,body[data-theme="light"] select{background:#ffffff;color:#0f172a;border-color:#dbe3ef}
    .search-wrap input{padding-left:40px}
    input::placeholder{color:#6b7b90}
    section{display:none}.section.active{display:block}
    .grid{display:grid;gap:16px}.grid.cols-2{grid-template-columns:1.05fr .95fr}.grid.cols-3{grid-template-columns:repeat(3,1fr)}
    .card{border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);box-shadow:0 10px 50px rgba(0,0,0,.18);overflow:hidden}
    body[data-theme="light"] .card{box-shadow:0 10px 28px rgba(15,23,42,.06)}
    .card-h{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;padding:18px 18px 0}
    .card h3{margin:0;font-size:18px;letter-spacing:-.01em}.sub{margin-top:4px;color:var(--muted);font-size:12px;line-height:1.5}
    .card-body{padding:18px}
    .page-guide{position:relative;margin:0 0 16px;border:1px solid rgba(125,211,252,.26);border-radius:24px;background:linear-gradient(135deg,rgba(15,23,42,.92),rgba(30,41,59,.72));box-shadow:0 18px 48px rgba(0,0,0,.18);overflow:hidden}
    .page-guide:before{content:"";position:absolute;inset:0 0 auto 0;height:4px;background:linear-gradient(90deg,#22c55e,#38bdf8,#f97316)}
    body[data-theme="light"] .page-guide{background:linear-gradient(135deg,#ffffff,#f8fafc);box-shadow:0 16px 36px rgba(15,23,42,.07)}
    .page-guide-inner{position:relative;z-index:1;display:grid;grid-template-columns:minmax(240px,.95fr) minmax(320px,1.4fr);gap:18px;padding:20px}
    .page-guide-title{display:flex;align-items:center;gap:10px;font-size:22px;font-weight:900;letter-spacing:-.03em}
    .page-guide-title span{display:grid;place-items:center;width:34px;height:34px;border-radius:12px;background:rgba(56,189,248,.16);color:#7dd3fc}
    body[data-theme="light"] .page-guide-title span{background:#e0f2fe;color:#0369a1}
    .page-guide-purpose{margin-top:10px;color:var(--muted);line-height:1.75;font-size:14px}
    .page-guide-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
    .guide-step{border:1px solid rgba(148,163,184,.18);border-radius:18px;background:rgba(15,23,42,.45);padding:12px}
    body[data-theme="light"] .guide-step{background:#ffffff;border-color:#e2e8f0}
    .guide-step b{display:block;font-size:13px;margin-bottom:6px;color:#e2e8f0}
    body[data-theme="light"] .guide-step b{color:#0f172a}
    .guide-step p{margin:0;color:var(--muted);font-size:12px;line-height:1.55}
    .page-guide-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
    .page-guide-actions .btn{min-height:34px;padding:7px 10px;border-radius:12px;font-size:12px}
    .section-block-label{display:flex;align-items:center;gap:8px;margin:14px 0 8px;color:var(--muted);font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}
    .section-block-label:after{content:"";height:1px;flex:1;background:var(--line)}
    .page-decision{margin:0 0 16px;border:1px solid var(--line);border-radius:24px;background:linear-gradient(135deg,rgba(15,23,42,.76),rgba(30,41,59,.45));box-shadow:0 14px 38px rgba(0,0,0,.14);overflow:hidden}
    body[data-theme="light"] .page-decision{background:#ffffff;box-shadow:0 12px 30px rgba(15,23,42,.06);border-color:#e2e8f0}
    .page-decision-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:18px 18px 10px;border-bottom:1px solid var(--line)}
    .page-decision-head h3{margin:0;font-size:20px;letter-spacing:-.03em}
    .page-decision-head p{margin:6px 0 0;color:var(--muted);line-height:1.65;font-size:13px}
    .page-decision-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;padding:16px 18px}
    .decision-card{border:1px solid rgba(148,163,184,.18);border-radius:18px;background:rgba(15,23,42,.45);padding:14px;min-height:112px}
    body[data-theme="light"] .decision-card{background:#f8fafc;border-color:#e2e8f0;color:#0f172a}
    .decision-card span{display:block;color:var(--muted);font-size:12px;font-weight:800;margin-bottom:8px}
    .decision-card strong{display:block;font-size:24px;line-height:1.15;font-weight:900;letter-spacing:-.04em;font-variant-numeric:tabular-nums}
    .decision-card p{margin:8px 0 0;color:var(--muted);font-size:12px;line-height:1.55}
    .decision-card.good strong{color:#22c55e}.decision-card.mid strong{color:#f59e0b}.decision-card.high strong{color:#fb7185}.decision-card.info strong{color:#38bdf8}
    .decision-next{padding:0 18px 18px;display:flex;flex-wrap:wrap;gap:10px;align-items:center}
    .decision-next .next-label{font-size:12px;color:var(--muted);font-weight:900;letter-spacing:.08em;text-transform:uppercase}
    .decision-next .next-copy{flex:1;min-width:240px;padding:10px 12px;border-radius:14px;background:rgba(56,189,248,.10);color:#bfdbfe;border:1px solid rgba(56,189,248,.22);font-size:13px;line-height:1.6}
    body[data-theme="light"] .decision-next .next-copy{background:#eff6ff;color:#1e3a8a;border-color:#bfdbfe}
    .detail-section{border:1px solid var(--line);border-radius:22px;background:rgba(15,23,42,.36);margin-top:16px;overflow:hidden}
    body[data-theme="light"] .detail-section{background:#ffffff;border-color:#e2e8f0;box-shadow:0 8px 22px rgba(15,23,42,.05)}
    .detail-section>summary{list-style:none;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:15px 18px;font-weight:900}
    .detail-section>summary::-webkit-details-marker{display:none}
    .detail-section>summary:after{content:"展开";font-size:12px;color:var(--muted);font-weight:800}
    .detail-section[open]>summary:after{content:"收起"}
    .detail-section .detail-body{padding:0 16px 16px}
    .detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
    .store-flow{display:grid;grid-template-columns:minmax(260px,.92fr) minmax(360px,1.35fr);gap:16px;align-items:stretch}
    .store-verdict{border:1px solid rgba(56,189,248,.22);border-radius:22px;background:linear-gradient(135deg,rgba(14,165,233,.16),rgba(15,23,42,.42));padding:16px;min-height:100%;display:flex;flex-direction:column;justify-content:space-between}
    body[data-theme="light"] .store-verdict{background:linear-gradient(135deg,#eff6ff,#ffffff);border-color:#bfdbfe}
    .store-verdict h3{margin:0 0 8px;font-size:22px;letter-spacing:-.03em}
    .store-verdict p{margin:0;color:var(--muted);line-height:1.7}
    .store-kpi-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;align-content:stretch}
    .store-kpi{border:1px solid var(--line);border-radius:18px;background:rgba(15,23,42,.42);padding:13px;text-align:center;min-height:104px;display:flex;flex-direction:column;justify-content:center}
    body[data-theme="light"] .store-kpi{background:#f8fafc;border-color:#e2e8f0}
    .store-kpi span{display:block;color:var(--muted);font-size:12px;font-weight:800;margin-bottom:6px}
    .store-kpi strong{display:block;font-size:22px;font-weight:900;font-variant-numeric:tabular-nums}
    .store-kpi small{display:block;margin-top:6px;color:var(--muted);font-size:12px;line-height:1.45}
    .metric-window-note{display:inline-flex;align-items:center;gap:8px;border:1px solid rgba(96,165,250,.26);background:rgba(59,130,246,.10);color:#bfdbfe;border-radius:999px;padding:6px 10px;font-size:12px;font-weight:900}
    body[data-theme="light"] .metric-window-note{background:#eff6ff;color:#1e40af;border-color:#bfdbfe}
    .decision-note{display:block;margin-top:4px;color:var(--muted);font-size:11px;line-height:1.45;max-width:280px}
    .decision-strong{font-weight:900;color:#fda4af}
    body[data-theme="light"] .decision-strong{color:#be123c}
    .compare-note{display:grid;gap:6px;min-width:260px}
    .compare-line{display:flex;align-items:center;justify-content:space-between;gap:10px;border:1px solid rgba(148,163,184,.16);border-radius:12px;padding:7px 9px;background:rgba(15,23,42,.22);font-size:11px;color:var(--muted)}
    body[data-theme="light"] .compare-line{background:#f8fafc;border-color:#e2e8f0}
    .compare-line b{color:var(--text);font-family:var(--mono);font-size:12px}
    .compare-line strong{color:#bfdbfe;font-family:var(--mono);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}
    body[data-theme="light"] .compare-line strong{color:#1d4ed8}
    .coverage-legend{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:0 0 12px}
    .coverage-legend div{border:1px solid rgba(148,163,184,.18);border-radius:16px;background:rgba(15,23,42,.34);padding:12px}
    body[data-theme="light"] .coverage-legend div{background:#ffffff;border-color:#e2e8f0;box-shadow:0 4px 14px rgba(15,23,42,.04)}
    .coverage-legend b{display:block;font-size:13px;margin-bottom:5px}
    .coverage-legend span{display:block;color:var(--muted);font-size:12px;line-height:1.5}
    .comment-preview{display:grid;gap:8px}
    .comment-preview-row{display:grid;grid-template-columns:72px minmax(120px,.7fr) minmax(260px,1.7fr) 88px;gap:10px;align-items:start;border:1px solid rgba(148,163,184,.16);border-radius:14px;background:rgba(15,23,42,.26);padding:10px}
    body[data-theme="light"] .comment-preview-row{background:#ffffff;border-color:#e2e8f0}
    .comment-preview-row p{margin:0;color:var(--text);line-height:1.55;font-size:12px}
    .comment-preview-row small{display:block;color:var(--muted);font-size:11px;line-height:1.45}
    .comment-original{max-width:620px;line-height:1.55}
    .comment-translation{margin-top:6px;color:#bfdbfe;font-size:12px}
    body[data-theme="light"] .comment-translation{color:#1d4ed8}
    .grouped-table thead tr:first-child th{padding-bottom:4px;vertical-align:bottom}
    .grouped-table thead tr:nth-child(2) th{top:32px;padding-top:5px;padding-bottom:9px}
    th.metric-group-th{text-align:center;min-width:124px;color:var(--text);font-size:13px;font-weight:900;letter-spacing:.02em;border-bottom:1px solid rgba(148,163,184,.16)}
    th.metric-sub-th{text-align:center;min-width:62px;color:#bfdbfe;font-size:11px;font-weight:900}
    body[data-theme="light"] th.metric-sub-th{color:#1e40af}
    td.metric-sub-cell{text-align:center;min-width:62px;font-family:var(--mono);font-size:14px;font-weight:800;font-variant-numeric:tabular-nums;vertical-align:middle}
    .evidence-grid{display:grid;grid-template-columns:auto auto;gap:4px 12px;min-width:170px;border:1px solid rgba(148,163,184,.14);border-radius:12px;padding:8px;background:rgba(2,6,23,.18)}
    body[data-theme="light"] .evidence-grid{background:#f8fafc;border-color:#e2e8f0}
    .evidence-grid span{color:var(--muted);font-size:11px;font-weight:800}
    .evidence-grid b{font-family:var(--mono);font-size:12px;text-align:right}
    .problem-stack{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:14px}
    .problem-card{border:1px solid var(--line);border-radius:18px;background:rgba(15,23,42,.36);padding:13px}
    body[data-theme="light"] .problem-card{background:#ffffff;border-color:#e2e8f0}
    .problem-card span{display:block;color:var(--muted);font-size:12px;font-weight:800}
    .problem-card strong{display:block;margin-top:6px;font-size:18px;font-weight:900}
    .problem-card p{margin:7px 0 0;color:var(--muted);font-size:12px;line-height:1.55}
    .store-section-title{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin:22px 0 12px;clear:both}
    .store-section-title.full-bleed-title{grid-column:1/-1}
    .store-section-title h3{margin:0;font-size:20px}
    .store-section-title .sub{margin-top:5px}
    .store-section-title .tag{margin-top:2px}
    .store-action-steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:14px}
    .store-step{border:1px solid rgba(148,163,184,.20);border-radius:18px;background:rgba(15,23,42,.40);padding:14px;min-height:116px}
    body[data-theme="light"] .store-step{background:#fff;border-color:#e2e8f0}
    .store-step b{display:block;font-size:14px;margin-bottom:6px}
    .store-step p{margin:0;color:var(--muted);font-size:12px;line-height:1.6}
    .best-link{display:inline-flex;align-items:center;border-radius:999px;padding:3px 8px;font-size:12px;font-weight:800;background:rgba(34,197,94,.14);color:#86efac;border:1px solid rgba(34,197,94,.25)}
    body[data-theme="light"] .best-link{background:#dcfce7;color:#166534;border-color:#bbf7d0}
    .duplicate-groups{display:grid;gap:14px}
    .duplicate-group{border:1px solid var(--line);border-radius:20px;background:rgba(15,23,42,.34);padding:14px;overflow:hidden}
    body[data-theme="light"] .duplicate-group{background:#ffffff;border-color:#e2e8f0;box-shadow:0 8px 22px rgba(15,23,42,.05)}
    .duplicate-head{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;margin-bottom:10px}
    .duplicate-head h4{margin:0;font-size:17px;letter-spacing:-.02em}
    .duplicate-head p{margin:5px 0 0;color:var(--muted);font-size:12px;line-height:1.55}
    .store-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(214px,1fr));gap:14px}
    .store-card{padding:16px;border-radius:20px;background:linear-gradient(135deg,rgba(15,23,42,.84),rgba(30,41,59,.48));border:1px solid var(--line);cursor:pointer;transition:.18s transform,.18s border-color}
    body[data-theme="light"] .store-card{background:#ffffff;color:#0f172a;border-color:#e2e8f0;box-shadow:0 8px 22px rgba(15,23,42,.05)}
    .store-card:hover{transform:translateY(-2px);border-color:rgba(34,211,238,.46)}
    .row1{display:flex;justify-content:space-between;gap:10px;align-items:center}
    .tag{display:inline-flex;align-items:center;justify-content:center;border-radius:999px;padding:4px 8px;font-size:12px;border:1px solid rgba(148,163,184,.24);color:#cbd5e1;background:rgba(15,23,42,.62);white-space:nowrap}
    body[data-theme="light"] .tag{background:#f8fafc;color:#334155;border-color:#cbd5e1}
    .tag.high{color:#fecdd3;border-color:rgba(251,113,133,.32);background:rgba(251,113,133,.12)}
    .tag.mid{color:#fde68a;border-color:rgba(251,191,36,.30);background:rgba(251,191,36,.11)}
    .tag.good{color:#bbf7d0;border-color:rgba(52,211,153,.30);background:rgba(52,211,153,.10)}
    .tag.info{color:#bae6fd;border-color:rgba(96,165,250,.30);background:rgba(96,165,250,.12)}
    body[data-theme="light"] .tag.high{color:#be123c;background:#fff1f2;border-color:#fecdd3}
    body[data-theme="light"] .tag.mid{color:#92400e;background:#fffbeb;border-color:#fde68a}
    body[data-theme="light"] .tag.good{color:#047857;background:#ecfdf5;border-color:#a7f3d0}
    body[data-theme="light"] .tag.info{color:#1d4ed8;background:#eff6ff;border-color:#bfdbfe}
    .metric-row{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:14px}
    .mini{border-top:1px solid var(--line);padding-top:10px}.mini span{display:block;color:var(--muted);font-size:11px}.mini strong{display:block;margin-top:4px;font-family:var(--mono);font-size:13px}
    .dashboard-grid{display:grid;grid-template-columns:1.12fr .88fr;gap:16px}
    .dashboard-grid.equal{grid-template-columns:repeat(2,minmax(0,1fr))}
    .dashboard-panel{border:1px solid rgba(148,163,184,.16);border-radius:22px;background:linear-gradient(135deg,rgba(15,23,42,.64),rgba(2,6,23,.30));padding:16px;min-height:240px}
    body[data-theme="light"] .dashboard-panel{background:#ffffff;border-color:#e2e8f0;box-shadow:0 8px 24px rgba(15,23,42,.05)}
    .dashboard-panel h4{margin:0 0 8px;font-size:15px}
    .dashboard-panel .sub{margin-bottom:10px}
    .group-summary-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-bottom:16px}
    .group-summary-grid.two{grid-template-columns:repeat(2,minmax(0,1fr))}
    .group-card{position:relative;overflow:hidden;border:1px solid rgba(148,163,184,.18);border-radius:22px;background:linear-gradient(135deg,rgba(15,23,42,.70),rgba(15,23,42,.36));padding:16px;min-height:146px}
    .group-card:before{content:"";position:absolute;inset:0 auto 0 0;width:5px;background:var(--group-color,var(--green))}
    .group-card h4{margin:0 0 10px;font-size:16px}.group-card strong{display:block;margin-top:4px;font-size:26px;letter-spacing:-.04em;font-variant-numeric:tabular-nums}.group-card span{color:var(--muted);font-size:12px}.group-card small{display:block;color:var(--muted);font-size:12px;line-height:1.55;margin-top:8px}
    body[data-theme="light"] .group-card{background:#ffffff;box-shadow:0 8px 22px rgba(15,23,42,.05)}
    .dashboard-section-title{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:18px 0 12px}.dashboard-section-title h3{margin:0;font-size:18px}.legend{display:flex;gap:8px;flex-wrap:wrap;color:var(--muted);font-size:12px}.legend i{display:inline-block;width:10px;height:10px;border-radius:999px;margin-right:5px;background:var(--c)}
    .dashboard-section-title .sub{max-width:760px;text-align:right}
    .home-bars{display:grid;gap:10px}
    .home-bar{display:grid;grid-template-columns:minmax(92px,140px) 1fr auto;gap:10px;align-items:center;font-size:12px}
    .home-bar b{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .home-bar i{display:block;height:10px;border-radius:999px;background:linear-gradient(90deg,var(--bar-color,var(--cyan)),color-mix(in srgb,var(--bar-color,var(--blue)) 72%,white 28%));min-width:4px}
    .home-bar span{font-family:var(--mono);color:var(--text);white-space:nowrap}
    .home-bar small{grid-column:2 / 4;color:var(--muted);font-size:11px;margin-top:-4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .rank-toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:4px 0 14px;flex-wrap:wrap}
    .rank-controls{display:flex;justify-content:flex-end;align-items:center;gap:10px;flex-wrap:wrap}
    .period-switch{display:flex;gap:8px;flex-wrap:wrap}
    .period-switch button{min-height:36px;border-radius:999px;border:1px solid rgba(148,163,184,.26);background:rgba(15,23,42,.58);color:#cbd5e1;padding:7px 12px;cursor:pointer}
    .period-switch button.active,.period-switch button:hover{background:rgba(34,211,238,.14);border-color:rgba(34,211,238,.55);color:#fff}
    .period-picker{display:flex;align-items:center;gap:8px;min-height:38px;border-radius:999px;border:1px solid rgba(148,163,184,.22);background:rgba(15,23,42,.44);padding:0 8px 0 12px;color:var(--muted);font-weight:800;font-size:12px}
    .period-picker select{min-width:190px;min-height:32px;border:0;border-radius:999px;background:transparent;color:var(--text);padding:0 8px;font-weight:900;outline:none}
    .period-picker option{background:#0f172a;color:#e5eefb}
    body[data-theme="light"] .period-switch button{background:#fff;color:#334155;border-color:#dbe3ef}
    body[data-theme="light"] .period-switch button.active,body[data-theme="light"] .period-switch button:hover{background:#e0f2fe;color:#0f172a;border-color:#67e8f9}
    body[data-theme="light"] .period-picker{background:#fff;color:#475569;border-color:#dbe3ef}
    body[data-theme="light"] .period-picker select{color:#0f172a}
    body[data-theme="light"] .period-picker option{background:#fff;color:#0f172a}
    .range-toolbar{position:sticky;top:12px;z-index:360;margin:4px 0 18px;border:1px solid rgba(148,163,184,.18);border-radius:22px;background:rgba(15,23,42,.82);backdrop-filter:blur(18px);box-shadow:0 16px 42px rgba(0,0,0,.22)}
    .floating-range-dock{position:sticky;top:12px;z-index:360;margin:0 0 18px}
    .floating-range-dock .range-toolbar{position:relative;top:auto;margin:0}
    .range-toolbar-main{display:grid;grid-template-columns:minmax(360px,.95fr) minmax(360px,1.35fr) auto;align-items:center;gap:12px;padding:12px}
    .range-button{min-height:54px;display:flex;align-items:center;justify-content:space-between;gap:14px;min-width:min(620px,100%);border-radius:18px;border:1px solid rgba(148,163,184,.26);background:rgba(2,6,23,.46);color:var(--text);padding:10px 14px;cursor:pointer;text-align:left}
    .range-button span{display:block;color:var(--muted);font-size:12px;font-weight:900;letter-spacing:.04em}
    .range-button strong{display:block;margin-top:3px;font-size:18px;letter-spacing:-.02em}
    .range-button small{display:block;color:var(--muted);font-size:12px;margin-top:2px}
    .range-current-tags{display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
    .range-preset-strip{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
    .range-preset-strip button{min-height:34px;border-radius:999px;border:1px solid rgba(148,163,184,.22);background:rgba(15,23,42,.66);color:#dbeafe;padding:6px 10px;cursor:pointer;font-size:12px;font-weight:850}
    .range-preset-strip button.active,.range-preset-strip button:hover{background:rgba(34,211,238,.14);border-color:rgba(34,211,238,.52);color:#fff}
    .range-popover{position:absolute;left:0;right:auto;top:calc(100% + 12px);z-index:430;width:min(1160px,calc(100vw - 320px));min-width:900px;border:1px solid rgba(148,163,184,.22);border-radius:30px;background:linear-gradient(135deg,rgba(2,6,23,.98),rgba(15,23,42,.98));box-shadow:0 28px 80px rgba(0,0,0,.42);padding:18px}
    .range-popover[hidden]{display:none}
    .range-popover-grid{display:grid;grid-template-columns:1fr;gap:18px;align-items:stretch}
    .range-presets{display:grid;gap:8px;align-content:start}
    .range-presets button{min-height:44px;border-radius:16px;border:1px solid rgba(148,163,184,.22);background:rgba(15,23,42,.70);color:#cbd5e1;padding:8px 12px;cursor:pointer;font-size:14px;font-weight:850;text-align:left}
    .range-presets button.active,.range-presets button:hover{background:rgba(34,211,238,.14);border-color:rgba(34,211,238,.50);color:#fff}
    .calendar-duo{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
    .calendar-card{display:block;border:1px solid rgba(148,163,184,.18);border-radius:24px;background:linear-gradient(180deg,rgba(15,23,42,.72),rgba(30,41,59,.44));padding:20px;min-height:190px}
    .calendar-card h4{margin:0 0 12px;font-size:22px}
    .calendar-card span{display:block;color:var(--muted);font-weight:900;font-size:12px;margin-bottom:8px}
    .calendar-card input{width:100%;min-height:56px;border-radius:18px;font-size:22px;font-weight:900}
    .calendar-card small{display:block;margin-top:10px;color:var(--muted);line-height:1.6}
    .calendar-input-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-bottom:14px}
    .calendar-input-card{border:1px solid rgba(148,163,184,.18);border-radius:20px;background:rgba(15,23,42,.48);padding:12px}
    .calendar-input-card span{display:block;color:var(--muted);font-size:12px;font-weight:900;margin-bottom:7px}
    .calendar-input-card input{min-height:48px;border-radius:15px;font-size:18px;font-weight:900}
    .range-calendar-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
    .range-calendar-panel{border:1px solid rgba(148,163,184,.18);border-radius:24px;background:linear-gradient(180deg,rgba(15,23,42,.72),rgba(30,41,59,.44));padding:16px}
    .calendar-panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
    .calendar-panel-head h4{margin:0;font-size:22px;letter-spacing:-.03em}
    .calendar-nav{display:flex;gap:6px}
    .calendar-nav button{width:34px;height:34px;border-radius:12px;border:1px solid rgba(148,163,184,.24);background:rgba(2,6,23,.34);color:var(--text);cursor:pointer}
    .calendar-week,.calendar-days{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px}
    .calendar-week span{color:var(--muted);font-size:12px;font-weight:900;text-align:center;padding:8px 0}
    .calendar-day{min-height:42px;border:1px solid transparent;border-radius:14px;background:rgba(15,23,42,.38);color:var(--text);font-family:var(--mono);font-size:15px;font-weight:900;cursor:pointer}
    .calendar-day.out{opacity:.34}
    .calendar-day.in-range{background:rgba(56,189,248,.16);border-color:rgba(56,189,248,.18)}
    .calendar-day.start,.calendar-day.end{background:linear-gradient(135deg,#2563eb,#22c55e);color:white;border-color:rgba(255,255,255,.40);box-shadow:0 8px 18px rgba(37,99,235,.28)}
    .calendar-day:hover{border-color:rgba(34,211,238,.56);transform:translateY(-1px)}
    .calendar-pick-note{margin-top:12px;color:var(--muted);font-size:12px;line-height:1.55}
    body[data-theme="light"] .range-toolbar{background:rgba(255,255,255,.96);border-color:#e2e8f0;box-shadow:0 14px 34px rgba(15,23,42,.10)}
    body[data-theme="light"] .range-button{background:#fff;color:#0f172a;border-color:#dbe3ef}
    body[data-theme="light"] .range-preset-strip button{background:#fff;color:#334155;border-color:#dbe3ef}
    body[data-theme="light"] .range-preset-strip button.active,body[data-theme="light"] .range-preset-strip button:hover{background:#dcfce7;color:#064e3b;border-color:#86efac}
    body[data-theme="light"] .range-popover{background:linear-gradient(180deg,#ffffff,#f8fafc);border-color:#dbe3ef;box-shadow:0 24px 70px rgba(15,23,42,.20)}
    body[data-theme="light"] .range-presets button{background:#f8fafc;color:#334155;border-color:#dbe3ef}
    body[data-theme="light"] .range-presets button.active,body[data-theme="light"] .range-presets button:hover{background:#dcfce7;color:#064e3b;border-color:#86efac}
    body[data-theme="light"] .calendar-card{background:#f8fafc;border-color:#e2e8f0}
    body[data-theme="light"] .calendar-input-card,body[data-theme="light"] .range-calendar-panel{background:#f8fafc;border-color:#e2e8f0}
    body[data-theme="light"] .calendar-nav button{background:#ffffff;color:#0f172a;border-color:#dbe3ef}
    body[data-theme="light"] .calendar-day{background:#ffffff;color:#0f172a}
    body[data-theme="light"] .calendar-day.in-range{background:#dbeafe;border-color:#bfdbfe}
    .rank-list{display:grid;gap:9px}
    .overview-matrix-card{position:relative;overflow:visible;border:1px solid rgba(148,163,184,.18);border-radius:24px;background:radial-gradient(circle at top right,rgba(34,211,238,.10),transparent 34%),linear-gradient(135deg,rgba(15,23,42,.72),rgba(15,23,42,.38));padding:16px;cursor:pointer;transition:.18s transform,.18s border-color,.18s box-shadow;color:var(--text);text-align:left;display:block}
    .overview-matrix-card:hover{transform:translateY(-2px);border-color:rgba(34,211,238,.50);box-shadow:0 0 0 4px rgba(34,211,238,.07)}
    body[data-theme="light"] .overview-matrix-card{background:#ffffff;border-color:#e2e8f0;box-shadow:0 8px 22px rgba(15,23,42,.05)}
    .matrix-card-head{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:12px}
    .matrix-card-head h4{margin:0;font-size:16px;letter-spacing:-.01em}
    .matrix-card-head .sub{margin:0;text-align:right;max-width:260px}
    .metric-matrix{display:grid;border:1px solid rgba(148,163,184,.16);border-radius:18px;overflow:hidden;background:rgba(2,6,23,.18)}
    body[data-theme="light"] .metric-matrix{background:#f8fafc;border-color:#e2e8f0}
    .metric-matrix.cols-1{grid-template-columns:minmax(70px,.8fr) minmax(120px,1.2fr)}
    .metric-matrix.cols-2{grid-template-columns:minmax(70px,.7fr) repeat(2,minmax(120px,1fr))}
    .metric-matrix.cols-3{grid-template-columns:minmax(70px,.68fr) minmax(108px,1.05fr) minmax(108px,1.05fr) minmax(92px,.82fr)}
    .metric-matrix.cols-4{grid-template-columns:minmax(70px,.68fr) minmax(86px,.9fr) repeat(3,minmax(92px,1fr))}
    .metric-matrix.profit-matrix{grid-template-columns:minmax(70px,.66fr) minmax(118px,1fr) minmax(118px,1fr) minmax(96px,.86fr)}
    .matrix-cell{min-height:50px;padding:10px;border-right:1px solid rgba(148,163,184,.14);border-bottom:1px solid rgba(148,163,184,.14);display:flex;align-items:center;justify-content:center;text-align:center;flex-direction:column;line-height:1.16}
    .metric-matrix.cols-1 .matrix-cell:nth-child(2n),.metric-matrix.cols-2 .matrix-cell:nth-child(3n),.metric-matrix.cols-3 .matrix-cell:nth-child(4n),.metric-matrix.cols-4 .matrix-cell:nth-child(5n){border-right:0}
    .matrix-cell:nth-last-child(-n+2){border-bottom:0}
    .metric-matrix.cols-2 .matrix-cell:nth-last-child(-n+3),.metric-matrix.cols-3 .matrix-cell:nth-last-child(-n+4){border-bottom:0}
    .metric-matrix.cols-4 .matrix-cell:nth-last-child(-n+5){border-bottom:0}
    .matrix-cell.label{font-weight:950;color:var(--text);justify-content:flex-start;text-align:left;background:rgba(148,163,184,.045)}
    .matrix-cell.head{font-size:12px;color:var(--muted);font-weight:950;background:rgba(148,163,184,.09);letter-spacing:.04em}
    .matrix-cell.value{font-family:var(--mono);font-size:21px;font-weight:950;font-variant-numeric:tabular-nums;color:var(--text);letter-spacing:-.035em}
    .profit-matrix .matrix-cell.value{align-items:center;justify-content:center;text-align:center;font-size:20px}
    .metric-matrix.cols-1 .matrix-cell.value{font-size:24px}
    .matrix-cell .minor-money{display:block;margin-top:3px;color:var(--muted);font-size:13px;font-weight:800;letter-spacing:0}
    .matrix-cell .coverage-note{display:block;margin-top:5px;color:var(--muted);font-family:var(--font);font-size:11px;font-weight:800;letter-spacing:0;line-height:1.25}
    .matrix-cell .pending-profit{color:#f97316;font-family:var(--font);font-size:15px;letter-spacing:0}
    .matrix-cell .positive{color:#22c55e}.matrix-cell .warn{color:#f97316}.matrix-cell .danger{color:#ef4444}
    .metric-matrix .matrix-cell{min-height:54px;border-radius:0;background:transparent;padding:10px;display:flex;align-items:center;justify-content:center;text-align:center;flex-direction:column;line-height:1.16}
    .metric-matrix .matrix-cell.label{font-size:16px;font-weight:950;letter-spacing:-.01em;align-items:center;justify-content:center;text-align:center;background:rgba(148,163,184,.065);color:var(--text)}
    .metric-matrix .matrix-cell.head{min-height:44px;font-size:12px;border-radius:0;background:rgba(148,163,184,.09);color:var(--muted)}
    .metric-matrix .matrix-cell.value{font-size:21px;font-weight:950;letter-spacing:-.035em;background:transparent}
    .metric-matrix.cols-1 .matrix-cell.value{font-size:24px}
    .ops-command{display:grid;grid-template-columns:minmax(320px,.9fr) minmax(520px,1.35fr);gap:16px;margin-bottom:16px;align-items:stretch}
    .ops-verdict{border:1px solid rgba(96,165,250,.26);border-radius:26px;background:linear-gradient(145deg,rgba(37,99,235,.17),rgba(15,23,42,.48));padding:18px;display:flex;flex-direction:column;justify-content:space-between;min-height:100%}
    body[data-theme="light"] .ops-verdict{background:linear-gradient(145deg,#eff6ff,#fff);border-color:#bfdbfe}
    .ops-verdict h3{margin:0 0 8px;font-size:24px;letter-spacing:-.04em}.ops-verdict p{margin:0;color:var(--muted);line-height:1.7}.ops-verdict .ops-big{font-family:var(--mono);font-size:32px;font-weight:950;letter-spacing:-.05em;margin:14px 0 4px;font-variant-numeric:tabular-nums;color:#60a5fa}body[data-theme="light"] .ops-verdict .ops-big{color:#1d4ed8}
    .ops-question-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:14px}.ops-question-grid div{border:1px solid rgba(148,163,184,.18);border-radius:16px;padding:10px;background:rgba(15,23,42,.28)}body[data-theme="light"] .ops-question-grid div{background:#f8fafc;border-color:#e2e8f0}.ops-question-grid b{display:block;font-size:12px;margin-bottom:4px}.ops-question-grid span{display:block;font-size:12px;color:var(--muted);line-height:1.45}
    .ops-pillar-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.ops-pillar{border:1px solid rgba(148,163,184,.18);border-radius:20px;padding:14px;background:linear-gradient(135deg,rgba(15,23,42,.64),rgba(2,6,23,.32));min-height:126px}.ops-pillar span{display:block;color:var(--muted);font-size:12px;font-weight:800}.ops-pillar strong{display:block;margin-top:8px;font-family:var(--mono);font-size:24px;font-weight:950;font-variant-numeric:tabular-nums}.ops-pillar small{display:block;margin-top:5px;color:var(--muted);font-size:12px;line-height:1.45}body[data-theme="light"] .ops-pillar{background:#fff;border-color:#e2e8f0}
    .ops-focus-list{display:grid;gap:10px}.ops-focus-row{display:grid;grid-template-columns:88px 1fr auto;gap:10px;align-items:center;border:1px solid rgba(148,163,184,.16);border-radius:16px;padding:10px;background:rgba(15,23,42,.24)}body[data-theme="light"] .ops-focus-row{background:#fff;border-color:#e2e8f0}.ops-focus-row b{font-size:14px}.ops-focus-row small{display:block;color:var(--muted);margin-top:3px}.ops-focus-row .num{font-family:var(--mono);font-weight:900;font-variant-numeric:tabular-nums}
    .page-anchor-row{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 14px}
    .page-anchor-row a,.page-anchor-row button{min-height:36px;border-radius:999px;border:1px solid rgba(148,163,184,.24);background:rgba(15,23,42,.50);color:var(--text);padding:7px 12px;font-weight:850;text-decoration:none;cursor:pointer}
    .page-anchor-row a:hover,.page-anchor-row button:hover{border-color:rgba(34,211,238,.55);background:rgba(34,211,238,.12)}
    body[data-theme="light"] .page-anchor-row a,body[data-theme="light"] .page-anchor-row button{background:#fff;border-color:#dbe3ef;color:#0f172a}
    .mission-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:14px 0}
    .mission-card{border:1px solid rgba(148,163,184,.18);border-radius:20px;background:linear-gradient(135deg,rgba(15,23,42,.54),rgba(2,6,23,.25));padding:14px;min-height:128px}
    body[data-theme="light"] .mission-card{background:#fff;border-color:#e2e8f0;box-shadow:0 8px 20px rgba(15,23,42,.045)}
    .mission-card span{display:block;color:var(--muted);font-size:12px;font-weight:900}.mission-card strong{display:block;margin-top:8px;font-family:var(--mono);font-size:24px;font-weight:950;font-variant-numeric:tabular-nums}.mission-card p{margin:7px 0 0;color:var(--muted);font-size:12px;line-height:1.5}
    .mission-card.good strong{color:#22c55e}.mission-card.warn strong{color:#f97316}.mission-card.bad strong{color:#fb7185}.mission-card.info strong{color:#38bdf8}
    .workstream-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:12px}
    .workstream-card{border:1px solid rgba(148,163,184,.18);border-radius:18px;background:rgba(15,23,42,.28);padding:12px}
    body[data-theme="light"] .workstream-card{background:#f8fafc;border-color:#e2e8f0}
    .workstream-card b{display:block;font-size:13px;margin-bottom:6px}.workstream-card span{display:block;color:var(--muted);font-size:12px;line-height:1.55}
    .rtv-center{display:grid;gap:16px}
    .rtv-hero{display:grid;grid-template-columns:minmax(320px,.92fr) minmax(520px,1.45fr);gap:16px;align-items:stretch}
    .rtv-verdict{border:1px solid rgba(251,113,133,.26);border-radius:26px;background:radial-gradient(circle at top left,rgba(251,113,133,.16),transparent 45%),linear-gradient(145deg,rgba(127,29,29,.16),rgba(15,23,42,.48));padding:18px;display:flex;flex-direction:column;justify-content:space-between;min-height:100%}
    body[data-theme="light"] .rtv-verdict{background:linear-gradient(145deg,#fff1f2,#fff);border-color:#fecdd3}
    .rtv-verdict h3{margin:0 0 8px;font-size:24px;letter-spacing:-.04em}.rtv-verdict p{margin:0;color:var(--muted);line-height:1.72}
    .rtv-big{font-family:var(--mono);font-size:34px;font-weight:950;letter-spacing:-.05em;margin:14px 0 4px;color:#fb7185;font-variant-numeric:tabular-nums}
    body[data-theme="light"] .rtv-big{color:#be123c}
    .rtv-flow-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}
    .rtv-stage{position:relative;border:1px solid rgba(148,163,184,.18);border-radius:20px;background:linear-gradient(135deg,rgba(15,23,42,.64),rgba(2,6,23,.28));padding:14px;min-height:126px;overflow:hidden}
    body[data-theme="light"] .rtv-stage{background:#fff;border-color:#e2e8f0;box-shadow:0 8px 20px rgba(15,23,42,.045)}
    .rtv-stage:before{content:"";position:absolute;left:0;right:0;top:0;height:4px;background:var(--stage,#38bdf8)}
    .rtv-stage span{display:block;color:var(--muted);font-size:12px;font-weight:900}.rtv-stage strong{display:block;margin-top:8px;font-family:var(--mono);font-size:26px;font-weight:950;font-variant-numeric:tabular-nums}.rtv-stage small{display:block;margin-top:5px;color:var(--muted);font-size:12px;line-height:1.45}
    .rtv-stage.good{--stage:#22c55e}.rtv-stage.warn{--stage:#f97316}.rtv-stage.bad{--stage:#ef4444}.rtv-stage.info{--stage:#38bdf8}
    .rtv-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
    .rtv-actions a,.rtv-actions button{min-height:36px;border-radius:999px;border:1px solid rgba(148,163,184,.24);background:rgba(15,23,42,.54);color:var(--text);padding:7px 12px;font-weight:850;text-decoration:none;cursor:pointer}
    .rtv-actions a:hover,.rtv-actions button:hover{border-color:rgba(34,211,238,.55);background:rgba(34,211,238,.12)}
    body[data-theme="light"] .rtv-actions a,body[data-theme="light"] .rtv-actions button{background:#fff;border-color:#dbe3ef;color:#0f172a}
    .rtv-term-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:8px 0 2px}
    .rtv-term{border:1px solid rgba(148,163,184,.16);border-radius:16px;background:rgba(15,23,42,.24);padding:10px}
    body[data-theme="light"] .rtv-term{background:#f8fafc;border-color:#e2e8f0}
    .rtv-term b{display:block;font-size:13px;margin-bottom:5px}.rtv-term span{display:block;color:var(--muted);font-size:12px;line-height:1.55}
    .rtv-decision{display:grid;gap:4px;min-width:130px}.rtv-decision b{font-size:13px}.rtv-decision small{color:var(--muted);line-height:1.45}
    .rtv-waybill{display:grid;gap:4px}.rtv-waybill .mono{font-size:12px}
    .rtv-table-hint{margin:8px 0 12px;color:var(--muted);font-size:12px;line-height:1.6}
    .profit-command{display:grid;grid-template-columns:minmax(320px,.95fr) minmax(520px,1.4fr);gap:16px;margin-bottom:16px;align-items:stretch}
    .profit-verdict{border:1px solid rgba(20,184,166,.26);border-radius:26px;background:linear-gradient(145deg,rgba(13,148,136,.18),rgba(15,23,42,.48));padding:18px;display:flex;flex-direction:column;justify-content:space-between;min-height:100%}
    body[data-theme="light"] .profit-verdict{background:linear-gradient(145deg,#ecfeff,#fff);border-color:#99f6e4}
    .profit-verdict h3{margin:0 0 8px;font-size:24px;letter-spacing:-.04em}.profit-verdict p{margin:0;color:var(--muted);line-height:1.7}
    .profit-verdict .profit-big{font-family:var(--mono);font-size:34px;font-weight:950;letter-spacing:-.05em;margin:14px 0 4px;font-variant-numeric:tabular-nums}.profit-big.good{color:#22c55e}.profit-big.bad{color:#ef4444}.profit-big.warn{color:#f97316}
    .profit-logic{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:14px}.profit-logic div{border:1px solid rgba(148,163,184,.18);border-radius:16px;padding:10px;background:rgba(15,23,42,.28)}body[data-theme="light"] .profit-logic div{background:#f8fafc;border-color:#e2e8f0}.profit-logic b{display:block;font-size:12px;color:var(--text);margin-bottom:4px}.profit-logic span{display:block;font-size:12px;color:var(--muted);line-height:1.45}
.profit-summary-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;margin-bottom:16px}
    .profit-card{border:1px solid rgba(148,163,184,.18);border-radius:22px;background:linear-gradient(135deg,rgba(15,23,42,.68),rgba(2,6,23,.36));padding:15px;min-height:132px;display:flex;flex-direction:column;justify-content:space-between}
    .profit-card span{display:block;color:var(--muted);font-size:12px;font-weight:800}.profit-card strong{display:block;margin-top:8px;font-family:var(--mono);font-size:26px;font-weight:950;font-variant-numeric:tabular-nums;letter-spacing:-.04em}.profit-card small{display:block;margin-top:5px;color:var(--muted);font-size:12px;line-height:1.45}
    .profit-card.good{border-color:rgba(34,197,94,.28);background:linear-gradient(135deg,rgba(6,78,59,.20),rgba(15,23,42,.50))}
    .profit-card.warn{border-color:rgba(251,146,60,.34);background:linear-gradient(135deg,rgba(120,53,15,.22),rgba(15,23,42,.50))}
    .profit-card.bad{border-color:rgba(248,113,113,.34);background:linear-gradient(135deg,rgba(127,29,29,.20),rgba(15,23,42,.50))}
    .profit-workbench-grid{display:grid;grid-template-columns:1fr;gap:16px;align-items:start}
    .profit-tool-grid{display:grid;grid-template-columns:minmax(340px,.52fr) minmax(520px,.78fr);gap:16px;align-items:start;margin-top:16px}
    .profit-tool-card{border:1px solid rgba(148,163,184,.16);border-radius:22px;background:rgba(2,6,23,.20);padding:14px;min-width:0}
    body[data-theme="light"] .profit-tool-card{background:#fff;border-color:#e2e8f0;box-shadow:0 8px 22px rgba(15,23,42,.04)}
    .profit-calculator{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:12px 0}
    .profit-calculator label{display:grid;gap:6px;color:var(--muted);font-size:12px;font-weight:800}
    .profit-calculator input{min-height:40px;border:1px solid var(--line);border-radius:12px;background:rgba(15,23,42,.52);color:var(--text);padding:8px 10px;font-family:var(--mono);font-size:14px}
    .calculator-output{border:1px solid rgba(34,211,238,.24);border-radius:18px;background:rgba(8,47,73,.22);padding:12px;margin-top:10px}
    .calculator-output strong{display:block;font-family:var(--mono);font-size:24px;letter-spacing:-.03em}.calculator-output span{display:block;color:var(--muted);font-size:12px;line-height:1.55;margin-top:5px}
    .profit-scatter{height:330px;position:relative}
    .profit-scatter svg{width:100%;height:300px;display:block;overflow:visible}
    .profit-scatter .axis{fill:var(--muted);font-size:11px}.profit-scatter .grid-line{stroke:rgba(148,163,184,.16);stroke-width:1;stroke-dasharray:4 6}.profit-scatter .axis-line{stroke:rgba(148,163,184,.34);stroke-width:1}.profit-scatter .point{stroke:#fff;stroke-width:1.3;cursor:pointer}
    .selection-model{display:grid;grid-template-columns:minmax(360px,.68fr) minmax(640px,1.32fr);gap:16px;align-items:start}
    .selection-model.wide{grid-template-areas:"verdict matrix" "samples samples"}
    .selection-model.wide .selection-verdict{grid-area:verdict}
    .selection-model.wide .selection-matrix-panel{grid-area:matrix;min-width:0}
    .selection-model.wide .selection-sample-panel{grid-area:samples;min-width:0}
    .selection-sample-panel table{table-layout:auto}
    .selection-verdict{border:1px solid rgba(34,197,94,.22);border-radius:22px;background:linear-gradient(135deg,rgba(6,78,59,.20),rgba(15,23,42,.48));padding:15px}
    .selection-verdict h4{margin:0 0 8px;font-size:20px;letter-spacing:-.03em}.selection-verdict p{margin:0;color:var(--muted);line-height:1.65;font-size:13px}
    .selection-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:12px}.selection-metrics div{border:1px solid rgba(148,163,184,.16);border-radius:16px;background:rgba(2,6,23,.24);padding:10px}.selection-metrics span{display:block;color:var(--muted);font-size:11px;font-weight:850}.selection-metrics strong{display:block;margin-top:5px;font-family:var(--mono);font-size:17px}
    .selection-matrix{display:grid;gap:8px}.matrix-row{display:grid;grid-template-columns:92px repeat(4,minmax(0,1fr));gap:8px}.matrix-cell{min-height:76px;border:1px solid rgba(148,163,184,.16);border-radius:14px;background:rgba(15,23,42,.44);padding:9px;font-size:12px}.matrix-cell.head{min-height:auto;background:rgba(15,23,42,.62);color:var(--muted);font-weight:900;text-align:center}.matrix-cell.good{border-color:rgba(34,197,94,.34);background:rgba(6,78,59,.22)}.matrix-cell.mid{border-color:rgba(251,191,36,.34);background:rgba(120,53,15,.18)}.matrix-cell.bad{border-color:rgba(248,113,113,.34);background:rgba(127,29,29,.18)}.matrix-cell b{display:block;font-family:var(--mono);font-size:15px}.matrix-cell small{display:block;color:var(--muted);line-height:1.45;margin-top:4px}
    .selection-slider-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.selection-slider-grid label{display:grid;gap:6px;color:var(--muted);font-size:12px;font-weight:850}.selection-slider-grid input{min-height:40px;border:1px solid var(--line);border-radius:12px;background:rgba(15,23,42,.52);color:var(--text);padding:8px 10px;font-family:var(--mono);font-size:14px}
    .selection-output{border:1px solid rgba(34,211,238,.24);border-radius:18px;background:rgba(8,47,73,.22);padding:12px;margin-top:10px}.selection-output strong{display:block;font-family:var(--mono);font-size:24px;letter-spacing:-.03em}.selection-output span{display:block;color:var(--muted);font-size:12px;line-height:1.65;margin-top:5px}
    .selection-side{display:grid;gap:12px}
    .trend-panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
    .trend-toggle{display:inline-flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
    .trend-toggle button{min-height:32px;border:1px solid rgba(148,163,184,.22);border-radius:999px;background:rgba(15,23,42,.62);color:var(--muted);padding:6px 10px;font-size:12px;font-weight:850;cursor:pointer}
    .trend-toggle button.active{background:rgba(34,211,238,.14);border-color:rgba(34,211,238,.52);color:#e0f2fe}
    body[data-theme="light"] .trend-toggle button{background:#fff;color:#475569;border-color:#dbe3ef}
    body[data-theme="light"] .trend-toggle button.active{background:#e0f2fe;color:#075985;border-color:#67e8f9}
    .stock-warning-table .evidence-grid{min-width:170px}
    .coverage-board{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin:12px 0}
    .coverage-tile{border:1px solid rgba(148,163,184,.18);border-radius:16px;background:rgba(15,23,42,.42);padding:11px;min-height:118px}
    body[data-theme="light"] .coverage-tile{background:#fff;border-color:#e2e8f0;box-shadow:0 4px 12px rgba(15,23,42,.04)}
    .coverage-tile strong{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:14px}.coverage-tile small{display:block;color:var(--muted);line-height:1.45;margin-top:5px}.coverage-tile .mono{font-size:12px}
    .comment-cell-zh{font-size:14px;line-height:1.65;color:var(--text);font-weight:750;max-width:620px}
    .comment-cell-ar{margin-top:7px;color:var(--muted);font-size:12px;line-height:1.55;max-width:620px}
    .stars{letter-spacing:1px;color:#f59e0b;font-size:16px;white-space:nowrap}
    .stars .off{color:rgba(148,163,184,.35)}
    .action-list{grid-template-columns:repeat(auto-fill,minmax(620px,1fr))}
    body[data-current-tab="actions"] #actionsList.action-list{grid-template-columns:1fr;gap:18px}
    body[data-current-tab="actions"] #actionsList .store-section-title{grid-column:1/-1}
    .action-card.v1-action{display:grid;grid-template-columns:minmax(320px,.72fr) minmax(560px,1.28fr);grid-template-areas:"main evidence" "controls controls";gap:12px;align-items:stretch}
    .action-card.v1-action .action-main,.action-card.v1-action .action-evidence,.action-card.v1-action .action-controls{min-width:0;border:1px solid rgba(148,163,184,.13);border-radius:18px;background:rgba(2,6,23,.16);padding:12px}
    body[data-theme="light"] .action-card.v1-action .action-main,body[data-theme="light"] .action-card.v1-action .action-evidence,body[data-theme="light"] .action-card.v1-action .action-controls{background:#fff;border-color:#e2e8f0}
    .action-card.v1-action .action-main{grid-area:main;display:flex;flex-direction:column;gap:8px}
    .action-card.v1-action .action-evidence{grid-area:evidence;display:grid;gap:10px;align-content:start}
    .action-card.v1-action .action-controls{grid-area:controls;display:grid;grid-template-columns:minmax(360px,.75fr) minmax(360px,.75fr) minmax(560px,1.1fr);gap:10px;align-items:center;align-content:center}
    .action-card.v1-action h4{margin:4px 0 0;font-size:18px;line-height:1.35}
    .action-card.v1-action p{line-height:1.65}
    .action-card.v1-action .action-evidence{font-size:15px;line-height:1.75}
    .action-card.v1-action .action-evidence p,
    .action-card.v1-action .action-evidence .muted,
    .action-card.v1-action .action-evidence .decision-note{font-size:15px;line-height:1.75;max-width:none;color:#cbd5e1}
    body[data-theme="light"] .action-card.v1-action .action-evidence p,
    body[data-theme="light"] .action-card.v1-action .action-evidence .muted,
    body[data-theme="light"] .action-card.v1-action .action-evidence .decision-note{color:#334155}
    .action-card.v1-action .action-evidence .decision-strong{font-size:18px;line-height:1.45}
    .action-card.v1-action .action-evidence .next{font-size:17px;line-height:1.65;font-weight:800;color:#dbeafe}
    body[data-theme="light"] .action-card.v1-action .action-evidence .next{color:#1e3a8a}
    .action-card.v1-action .action-evidence .evidence-grid span{font-size:13px}
    .action-card.v1-action .action-evidence .evidence-grid b{font-size:15px}
    .merged-signal-list{display:grid;gap:8px}
    .merged-signal{border:1px solid rgba(148,163,184,.16);border-radius:14px;background:rgba(15,23,42,.20);padding:9px 10px}
    body[data-theme="light"] .merged-signal{background:#f8fafc;border-color:#e2e8f0}
    .merged-signal b{display:block;color:#fda4af;font-size:15px;line-height:1.45}
    body[data-theme="light"] .merged-signal b{color:#be123c}
    .merged-signal span,.merged-signal small{display:block;color:#cbd5e1;line-height:1.65}
    body[data-theme="light"] .merged-signal span,body[data-theme="light"] .merged-signal small{color:#334155}
    .action-card.v1-action .command-actions,.action-card.v1-action .status-actions{margin-top:0;padding-top:0}
    .action-card.v1-action .command-actions,.action-card.v1-action .status-actions{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
    .action-card.v1-action .status-btn{width:100%;justify-content:center}
    .action-card.v1-action .action-meta{grid-template-columns:minmax(130px,.65fr) minmax(260px,1.25fr) minmax(92px,auto);gap:8px;margin-top:0;padding-top:0;border-top:0}
    .action-card.v1-action .meta-line{grid-column:1/-1;margin-top:0;padding-top:8px;border-top:1px solid rgba(148,163,184,.12)}
    body[data-theme="light"] .profit-card,
    body[data-theme="light"] .calculator-output,body[data-theme="light"] .selection-verdict,body[data-theme="light"] .selection-output{background:#ffffff;border-color:#e2e8f0;box-shadow:0 8px 22px rgba(15,23,42,.05)}
    body[data-theme="light"] .profit-card.good{background:#f0fdf4;border-color:#bbf7d0}
    body[data-theme="light"] .profit-card.warn{background:#fff7ed;border-color:#fed7aa}
    body[data-theme="light"] .profit-card.bad{background:#fff1f2;border-color:#fecdd3}
    body[data-theme="light"] .profit-calculator input,body[data-theme="light"] .selection-slider-grid input{background:#ffffff;color:#0f172a;border-color:#cbd5e1}
    body[data-theme="light"] .selection-metrics div,body[data-theme="light"] .matrix-cell{background:#f8fafc;border-color:#e2e8f0}
    body[data-theme="light"] .matrix-cell.head{background:#eef2ff}
    body[data-theme="light"] .matrix-cell.good{background:#ecfdf5;border-color:#a7f3d0}
    body[data-theme="light"] .matrix-cell.mid{background:#fffbeb;border-color:#fde68a}
    body[data-theme="light"] .matrix-cell.bad{background:#fff1f2;border-color:#fecdd3}
    .rank-list.product-rank .rank-item{min-height:70px}
    .rank-item{display:grid;grid-template-columns:38px minmax(0,1fr) minmax(118px,auto);gap:10px;align-items:center;width:100%;min-height:64px;text-align:left;border:1px solid rgba(148,163,184,.16);border-radius:16px;background:rgba(15,23,42,.48);color:var(--text);padding:10px 12px;cursor:pointer}
    .rank-item:hover{border-color:rgba(34,211,238,.48);background:rgba(34,211,238,.08)}
    body[data-theme="light"] .rank-item{background:#ffffff;border-color:#e2e8f0;color:#0f172a}
    body[data-theme="light"] .rank-item:hover{background:#eff6ff;border-color:#93c5fd}
    .link-like{border:0;background:transparent;color:inherit;padding:0;text-align:left;cursor:pointer;font:inherit}
    .link-like:hover{color:#38bdf8;text-decoration:underline;text-underline-offset:3px}
    .rank-no{display:grid;place-items:center;width:30px;height:30px;border-radius:999px;background:rgba(148,163,184,.14);color:var(--muted);font-family:var(--mono);font-weight:800}
    .rank-name{font-weight:800;line-height:1.35;white-space:normal;word-break:break-word}
    .rank-meta{margin-top:3px;color:var(--muted);font-size:12px;line-height:1.4;white-space:normal;word-break:break-word;display:block;min-height:34px}
    .rank-value{font-family:var(--mono);font-weight:900;font-size:15px;text-align:right;font-variant-numeric:tabular-nums}
    .rank-subvalue{display:block;margin-top:3px;color:var(--muted);font-size:12px;font-weight:600;text-align:right}
    .sparkline-card{height:210px}
    .sparkline-card svg{width:100%;height:160px;display:block}
    .metric-axis{fill:var(--muted);font-size:11px}
    .metric-line{fill:none;stroke:var(--cyan);stroke-width:3;stroke-linecap:round;stroke-linejoin:round}
    .metric-area{fill:rgba(34,211,238,.10)}
    .metric-point{fill:var(--cyan);stroke:rgba(255,255,255,.70);stroke-width:1.5}
    .trend-stack{display:grid;grid-template-columns:1fr;gap:16px}
    .line-chart{height:440px;position:relative}
    .line-chart svg{width:100%;height:350px;display:block;overflow:visible}
    body[data-current-tab="overview"] .trend-stack .card-body{padding-left:4px;padding-right:4px}
    .line-chart .axis{fill:var(--muted);font-size:11px}
    .line-chart .axis-line{stroke:rgba(148,163,184,.34);stroke-width:1}
    .line-chart .grid-line{stroke:rgba(148,163,184,.16);stroke-width:1;stroke-dasharray:4 6}
    .line-chart .value-label{font-size:12px;font-family:var(--mono);font-weight:900;paint-order:stroke;stroke:rgba(2,6,23,.92);stroke-width:4px;stroke-linejoin:round}
    body[data-theme="light"] .line-chart .value-label{stroke:rgba(255,255,255,.92)}
    .line-chart .series{fill:none;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}
    .line-chart .dot{stroke:#fff;stroke-width:1.4}
    .chart-hit{fill:transparent;cursor:crosshair}
    .chart-tip{position:fixed;z-index:900;display:none;pointer-events:none;min-width:190px;border:1px solid var(--line);border-radius:14px;background:rgba(15,23,42,.94);color:var(--text);box-shadow:var(--shadow);padding:10px 12px;font-size:12px;line-height:1.65}
    body[data-theme="light"] .chart-tip{background:#fff;color:#0f172a;border-color:#cbd5e1}
    .chart-tip strong{display:block;font-size:13px;margin-bottom:4px}
    .chart-tip b{font-family:var(--mono);font-size:13px}
    .chart-legend{display:flex;gap:12px;flex-wrap:wrap;margin-top:8px;color:var(--muted);font-size:12px}
    .chart-legend span{display:inline-flex;align-items:center;gap:6px}
    .chart-legend i{width:18px;height:4px;border-radius:999px;background:var(--c)}
    .overview-fold{margin-top:16px;border:1px solid var(--line);border-radius:24px;background:rgba(15,23,42,.42);overflow:hidden}
    body[data-theme="light"] .overview-fold{background:rgba(255,255,255,.70)}
    .overview-fold summary{cursor:pointer;list-style:none;min-height:52px;padding:16px 18px;font-weight:800;color:#bfdbfe;display:flex;justify-content:space-between;gap:10px;align-items:center}
    body[data-theme="light"] .overview-fold summary{color:#1d4ed8}
    .overview-fold summary::-webkit-details-marker{display:none}
    .overview-fold summary:after{content:"展开";font-size:12px;color:var(--muted);font-weight:600}
    .overview-fold[open] summary:after{content:"收起"}
    .overview-fold-body{padding:0 16px 16px}
    .bar{height:8px;background:rgba(148,163,184,.15);border-radius:999px;overflow:hidden;margin-top:10px}.bar i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--cyan),var(--violet),var(--pink))}
    .split{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;align-items:start}
    table{width:100%;border-collapse:separate;border-spacing:0 8px;table-layout:auto}
    th{position:sticky;top:0;background:rgba(8,12,24,.94);z-index:1;color:var(--muted);font-weight:800;text-align:left;font-size:12px;padding:9px 10px;vertical-align:middle}
    td{background:rgba(15,23,42,.65);padding:12px 10px;border-top:1px solid rgba(148,163,184,.12);border-bottom:1px solid rgba(148,163,184,.12);vertical-align:middle;line-height:1.45}
    .table-note{margin-top:8px;color:var(--muted);font-size:12px;line-height:1.5}
    body[data-theme="light"] th{background:rgba(248,250,252,.96)}
    body[data-theme="light"] td{background:rgba(255,255,255,.80)}
    td:first-child{border-left:1px solid rgba(148,163,184,.12);border-radius:14px 0 0 14px}td:last-child{border-right:1px solid rgba(148,163,184,.12);border-radius:0 14px 14px 0}
    .mono{font-family:var(--mono);font-variant-numeric:tabular-nums}.muted{color:var(--muted)}.num{text-align:center;font-family:var(--mono);font-variant-numeric:tabular-nums;white-space:nowrap}
    .copy{display:inline-flex;align-items:center;gap:6px;border:0;border-radius:10px;padding:4px 7px;margin-top:6px;background:rgba(96,165,250,.13);color:#dbeafe;cursor:pointer}
    .copy:hover{background:rgba(96,165,250,.22)}
    body[data-theme="light"] .copy{background:#eff6ff;color:#1d4ed8}
    .action-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(620px,1fr));gap:14px;align-items:stretch}
    .action-card{padding:16px;border:1px solid var(--line);border-radius:20px;background:linear-gradient(135deg,rgba(15,23,42,.78),rgba(17,24,39,.46));min-height:100%;display:flex;flex-direction:column}
    body[data-theme="light"] .action-card{background:linear-gradient(135deg,rgba(255,255,255,.90),rgba(241,245,249,.78))}
    .action-card h4{margin:10px 0 6px;font-size:16px}.action-card p{margin:0;color:#cbd5e1;line-height:1.58}.action-card .next{margin-top:10px;color:#dbeafe}
    body[data-theme="light"] .action-card p,body[data-theme="light"] .action-card .next{color:#334155}
    .next{margin:10px 0 0;color:#dbeafe;line-height:1.58}
    body[data-theme="light"] .next{color:#334155}
    .next.warn{border:1px solid rgba(251,191,36,.24);border-radius:14px;background:rgba(120,53,15,.20);color:#fde68a;padding:9px 10px}
    .status-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
    .status-btn{min-height:34px;border:1px solid rgba(148,163,184,.20);border-radius:999px;background:rgba(15,23,42,.74);color:#cbd5e1;padding:6px 10px;cursor:pointer;font-size:12px}
    body[data-theme="light"] .status-btn{background:rgba(255,255,255,.86);color:#334155}
    .status-btn:hover,.status-btn.active{border-color:rgba(34,211,238,.55);color:#fff;background:rgba(34,211,238,.12)}
    body[data-theme="light"] .status-btn:hover,body[data-theme="light"] .status-btn.active{color:#0f172a;background:#e0f2fe;border-color:#67e8f9}
    .status-badge{display:inline-flex;align-items:center;gap:6px;margin-left:8px}
    .status-dot{width:7px;height:7px;border-radius:999px;background:var(--muted)}
    .status-dot.done{background:var(--green)}.status-dot.review{background:var(--amber)}.status-dot.ignored{background:var(--faint)}.status-dot.open{background:var(--cyan)}
    .progress-grid{display:grid;grid-template-columns:1.1fr repeat(4,minmax(90px,.55fr));gap:10px;margin-bottom:14px}
    .progress-card{border:1px solid rgba(148,163,184,.16);border-radius:18px;background:rgba(2,6,23,.34);padding:13px}
    .progress-card span{display:block;color:var(--muted);font-size:11px}.progress-card strong{display:block;margin-top:6px;font-family:var(--mono);font-size:18px}
    .progress-card small{display:block;margin-top:5px;color:var(--muted);font-size:11px;line-height:1.45}
    .compact-list{margin:4px 0 0;padding-left:18px;color:#cbd5e1;font-size:12px;line-height:1.7}
    .action-card .command-actions{margin-top:auto;padding-top:10px}
    .action-card .status-actions{margin-top:10px}
    .bulk-panel{margin-bottom:14px;border:1px solid rgba(34,211,238,.16);border-radius:20px;background:linear-gradient(135deg,rgba(14,165,233,.10),rgba(15,23,42,.42));padding:14px}
    .bulk-panel .bulk-row{display:grid;grid-template-columns:minmax(110px,.3fr) 1fr auto;gap:8px;margin-top:10px}
    .bulk-panel input{min-height:38px;border-radius:12px;font-size:12px}
    .bulk-panel .bulk-hint{color:var(--muted);font-size:12px;line-height:1.65}
    .progress-card .bar{margin-top:10px}
    .trend-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
    .trend-card{position:relative;border:1px solid rgba(148,163,184,.18);border-radius:20px;background:linear-gradient(135deg,rgba(8,47,73,.25),rgba(15,23,42,.58));padding:14px;overflow:hidden}
    .trend-card.ready{border-color:rgba(52,211,153,.32);background:linear-gradient(135deg,rgba(6,78,59,.28),rgba(15,23,42,.58))}
    .trend-card.wait{border-color:rgba(251,191,36,.30);background:linear-gradient(135deg,rgba(120,53,15,.22),rgba(15,23,42,.58))}
    .trend-card h4{margin:8px 0 6px;font-size:15px}.trend-card p{margin:0;color:#cbd5e1;font-size:12px;line-height:1.55}
    .trend-card .maturity{height:8px;border-radius:999px;background:rgba(148,163,184,.14);overflow:hidden;margin:12px 0 10px}.trend-card .maturity i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--cyan),var(--green))}
    .trend-mini{height:38px;margin-top:10px}.trend-mini svg{width:100%;height:38px;display:block}.trend-line{fill:none;stroke:var(--cyan);stroke-width:2.5;stroke-linecap:round}.trend-area{fill:rgba(34,211,238,.10)}
    .health-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
    .health-card{border:1px solid rgba(148,163,184,.18);border-radius:18px;background:linear-gradient(135deg,rgba(15,23,42,.68),rgba(2,6,23,.38));padding:13px}
    .health-card.good{border-color:rgba(52,211,153,.30);background:linear-gradient(135deg,rgba(6,78,59,.25),rgba(15,23,42,.55))}
    .health-card.warn{border-color:rgba(251,191,36,.34);background:linear-gradient(135deg,rgba(120,53,15,.24),rgba(15,23,42,.55))}
    .health-card.bad{border-color:rgba(251,113,133,.38);background:linear-gradient(135deg,rgba(127,29,29,.26),rgba(15,23,42,.55))}
    .health-card h4{margin:8px 0 6px;font-size:15px}.health-card p{margin:0;color:#cbd5e1;font-size:12px;line-height:1.55}.health-card .mono{font-size:12px}
    .health-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
    .command-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
    .linkops-grid{display:grid;grid-template-columns:minmax(340px,.95fr) minmax(360px,1.05fr);gap:14px}
    .ops-workspace{display:grid;grid-template-columns:minmax(280px,.42fr) minmax(520px,1fr);gap:14px;align-items:start}
    .ops-rail,.ops-chat,.ops-tasks{border:1px solid rgba(148,163,184,.16);border-radius:26px;background:rgba(15,23,42,.34);padding:14px;min-width:0}
    body[data-theme="light"] .ops-rail,body[data-theme="light"] .ops-chat,body[data-theme="light"] .ops-tasks{background:#fff;border-color:#e2e8f0}
    .ops-session{border:1px solid rgba(148,163,184,.14);border-radius:18px;padding:10px;margin-bottom:8px;cursor:pointer;transition:transform .18s ease,border-color .18s ease,background .18s ease}
    .ops-session:hover{transform:translateY(-1px);border-color:rgba(56,189,248,.34)}
    .ops-session.active{background:rgba(14,165,233,.14);border-color:rgba(56,189,248,.48)}
    .ops-session b{display:block;font-size:13px;margin-bottom:5px}.ops-session small{display:block;color:var(--muted);font-size:11px;line-height:1.45}
    .ops-session-head{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:start}
    .ops-session-delete{border:0;background:transparent;color:var(--muted);font-size:12px;cursor:pointer;border-radius:999px;padding:2px 6px}
    .ops-session-delete:hover{background:rgba(248,113,113,.12);color:#fca5a5}
    .ops-reco{border:1px solid rgba(34,197,94,.18);border-radius:16px;background:rgba(20,83,45,.14);padding:10px;margin-bottom:8px;cursor:pointer}
    body[data-theme="light"] .ops-reco{background:#f0fdf4;border-color:#bbf7d0}
    .ops-reco b{display:block;font-size:12px;margin-bottom:4px}.ops-reco p{margin:0;color:var(--muted);font-size:12px;line-height:1.55}
    .chat-stream{display:grid;gap:10px;max-height:620px;overflow:auto;padding-right:4px}
    .chat-msg{max-width:92%;border:1px solid rgba(148,163,184,.16);border-radius:18px;padding:11px 12px;line-height:1.65;font-size:13px}
    .chat-msg.user{justify-self:end;background:rgba(14,165,233,.15);border-color:rgba(56,189,248,.34)}
    .chat-msg.assistant{justify-self:start;background:rgba(15,23,42,.26)}
    body[data-theme="light"] .chat-msg.assistant{background:#f8fafc}
    .chat-compose{margin-top:12px;display:grid;gap:9px}
    .chat-compose textarea{width:100%;min-height:112px;resize:vertical;border:1px solid rgba(148,163,184,.22);border-radius:18px;background:rgba(2,6,23,.42);color:var(--text);padding:13px;font:inherit;line-height:1.55}
    body[data-theme="light"] .chat-compose textarea{background:#fff;color:#0f172a;border-color:#dbe3ef}
    .linkops-command-box textarea{width:100%;min-height:156px;resize:vertical;border:1px solid rgba(148,163,184,.22);border-radius:18px;background:rgba(2,6,23,.42);color:var(--text);padding:14px;font:inherit;line-height:1.55}
    body[data-theme="light"] .linkops-command-box textarea{background:#fff;color:#0f172a;border-color:#dbe3ef}
    .linkops-hints{display:grid;gap:8px;margin-top:10px}
    .linkops-hints button{border:1px solid rgba(148,163,184,.18);border-radius:14px;background:rgba(15,23,42,.42);color:var(--text);padding:9px 10px;text-align:left;cursor:pointer}
    body[data-theme="light"] .linkops-hints button{background:#fff;border-color:#e2e8f0;color:#0f172a}
    .linkops-task{border:1px solid rgba(148,163,184,.16);border-radius:18px;background:rgba(15,23,42,.32);padding:13px;margin-bottom:10px}
    body[data-theme="light"] .linkops-task{background:#fff;border-color:#e2e8f0}
    .linkops-task summary{list-style:none;cursor:pointer}
    .linkops-task summary::-webkit-details-marker{display:none}
    .task-summary{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center}
    .task-summary h4{margin:0;font-size:14px}.task-summary small{display:block;color:var(--muted);font-size:11px;margin-top:4px}
    .task-detail{margin-top:12px;padding-top:12px;border-top:1px solid rgba(148,163,184,.14)}
    .linkops-task h4{margin:0 0 7px;font-size:15px}
    .linkops-task p{margin:5px 0;color:var(--muted);line-height:1.55;font-size:12px}
    .linkops-preview-list{margin:8px 0 0;padding-left:18px;color:var(--muted);font-size:12px;line-height:1.65}
    .task-exec{border:1px solid rgba(56,189,248,.20);border-radius:16px;background:rgba(8,47,73,.16);padding:12px;margin-top:10px}
    body[data-theme="light"] .task-exec{background:#f8fafc;border-color:#bae6fd}
    .task-exec h5{margin:0 0 8px;font-size:13px;color:var(--text)}
    .task-exec-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
    .task-exec-item{border:1px solid rgba(148,163,184,.14);border-radius:12px;padding:9px;background:rgba(15,23,42,.22);min-width:0}
    body[data-theme="light"] .task-exec-item{background:#fff;border-color:#e2e8f0}
    .task-exec-item b{display:block;font-size:11px;color:var(--muted);margin-bottom:4px}
    .task-exec-item span,.task-exec-item div{font-size:12px;line-height:1.55}
    .material-pills{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
    .material-pill{border:1px solid rgba(148,163,184,.20);border-radius:999px;padding:4px 8px;font-size:11px;color:var(--muted);background:rgba(15,23,42,.24)}
    body[data-theme="light"] .material-pill{background:#fff;border-color:#e2e8f0}
    .material-pill.need{color:#fde68a;border-color:rgba(250,204,21,.28)}
    body[data-theme="light"] .material-pill.need{color:#92400e;border-color:#fde68a;background:#fffbeb}
    .task-exec-note{margin-top:8px;font-size:12px;line-height:1.6;color:var(--muted)}
    .asset-panel{border:1px dashed rgba(148,163,184,.28);border-radius:16px;padding:11px;margin-top:10px;background:rgba(15,23,42,.20)}
    body[data-theme="light"] .asset-panel{background:#fff;border-color:#cbd5e1}
    .asset-panel input[type=file]{width:100%;min-height:38px;border-radius:12px;border:1px solid rgba(148,163,184,.18);padding:7px;background:rgba(15,23,42,.18);color:var(--text)}
    body[data-theme="light"] .asset-panel input[type=file]{background:#f8fafc;border-color:#e2e8f0}
    .asset-list{display:grid;gap:6px;margin-top:8px}
    .asset-row{display:grid;grid-template-columns:minmax(120px,1fr) auto auto;gap:8px;align-items:center;border:1px solid rgba(148,163,184,.14);border-radius:12px;padding:8px;font-size:12px}
    body[data-theme="light"] .asset-row{border-color:#e2e8f0}
    .asset-row .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.asset-row .meta{color:var(--muted);font-family:var(--mono);font-size:11px}
    .execution-state{margin-top:10px;border:1px solid rgba(250,204,21,.22);border-radius:16px;background:rgba(120,53,15,.12);padding:10px;color:var(--muted);font-size:12px;line-height:1.6}
    body[data-theme="light"] .execution-state{background:#fffbeb;border-color:#fde68a}
    .agent-answer-grid{display:grid;gap:10px;margin-top:10px}
    .agent-answer-card{border:1px solid rgba(56,189,248,.22);border-radius:16px;background:rgba(8,47,73,.18);padding:12px}
    body[data-theme="light"] .agent-answer-card{background:#f0f9ff;border-color:#bae6fd}
    .agent-answer-card h4{margin:0 0 8px;font-size:13px;color:#7dd3fc}
    body[data-theme="light"] .agent-answer-card h4{color:#0369a1}
    .agent-answer-card ul{margin:0;padding-left:18px;color:var(--muted);font-size:12px;line-height:1.7}
    .agent-answer-card p{margin:0;color:var(--muted);font-size:12px;line-height:1.7}
    .task-progress{height:9px;border-radius:999px;background:rgba(148,163,184,.18);overflow:hidden;margin:9px 0}
    .task-progress>i{display:block;height:100%;background:linear-gradient(90deg,#38bdf8,#22c55e);border-radius:999px}
    .task-actions{display:flex;flex-wrap:wrap;gap:7px;margin-top:10px}
    .task-actions button{border:1px solid rgba(148,163,184,.18);background:rgba(15,23,42,.48);color:var(--text);border-radius:999px;padding:7px 10px;cursor:pointer;font-size:12px}
    body[data-theme="light"] .task-actions button{background:#fff;border-color:#dbe3ef;color:#0f172a}
    .task-actions button.danger{border-color:rgba(248,113,113,.35);color:#fecaca}
    body[data-theme="light"] .task-actions button.danger{color:#b91c1c}
    .title-candidates{display:grid;gap:8px;margin-top:8px}
    .title-candidate{border:1px solid rgba(148,163,184,.18);border-radius:12px;padding:9px;background:rgba(15,23,42,.25);font-size:12px;line-height:1.6}
    body[data-theme="light"] .title-candidate{background:#fff;border-color:#e2e8f0}
    .action-meta{display:grid;grid-template-columns:minmax(96px,.32fr) 1fr auto;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid rgba(148,163,184,.12)}
    .action-meta input{min-height:38px;border-radius:12px;font-size:12px}
    .action-meta .meta-save{min-height:38px;border-radius:12px;padding:7px 10px}
    .meta-line{margin-top:8px;color:#93c5fd;font-size:12px;line-height:1.55}
    .spotlight{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;align-items:stretch}
    .spotlight>div,.split>div{min-width:0}
    .brief-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:12px 0 4px}
    .brief-grid.five{grid-template-columns:repeat(5,minmax(0,1fr))}
    .brief-grid.five .brief{padding:10px}
    .brief{border:1px solid rgba(148,163,184,.16);border-radius:16px;background:rgba(2,6,23,.32);padding:12px}
    body[data-theme="light"] .brief{background:#f8fafc;border-color:#e2e8f0}
    .brief span{display:block;color:var(--muted);font-size:12px}.brief strong{display:block;margin-top:6px;font-family:var(--mono);font-size:18px;line-height:1.25}
    .brief-grid.five .brief strong{font-size:16px}
    .overview-summary-grid .brief strong{font-size:20px}
    .path-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px;align-items:stretch}
    .path-card{border:1px solid rgba(148,163,184,.17);border-radius:18px;background:linear-gradient(135deg,rgba(2,6,23,.40),rgba(30,41,59,.36));padding:14px;min-height:126px}
    .path-card h4{margin:8px 0 6px;font-size:15px}.path-card p{margin:0;color:var(--muted);line-height:1.55;font-size:12px}
    .path-actions{display:grid;gap:8px;margin-top:12px}
    .path-action{width:100%;border:1px solid rgba(148,163,184,.16);border-radius:14px;background:rgba(15,23,42,.58);color:#dbeafe;text-align:left;padding:9px 10px;cursor:pointer}
    .path-action:hover{border-color:rgba(34,211,238,.55);background:rgba(34,211,238,.10)}
    .path-action b{display:block;font-size:12px}.path-action span{display:block;margin-top:4px;color:var(--muted);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.path-action em{float:right;color:var(--cyan);font-style:normal;font-family:var(--mono);font-size:11px}
    .priority-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:12px}
    .priority-card{border:1px solid rgba(148,163,184,.18);border-radius:20px;background:linear-gradient(135deg,rgba(15,23,42,.74),rgba(2,6,23,.38));padding:15px;cursor:pointer;transition:.18s transform,.18s border-color,.18s background}
    .priority-card:hover{transform:translateY(-2px);border-color:rgba(34,211,238,.55);background:linear-gradient(135deg,rgba(8,47,73,.42),rgba(15,23,42,.62))}
    .opportunity-card{border-color:rgba(16,185,129,.30);background:linear-gradient(135deg,rgba(6,78,59,.34),rgba(15,23,42,.64))}
    .opportunity-card:hover{border-color:rgba(52,211,153,.70);background:linear-gradient(135deg,rgba(6,95,70,.45),rgba(15,23,42,.62))}
    .opportunity-card .score{color:#6ee7b7}.opportunity-card .domain{color:#a7f3d0;background:rgba(16,185,129,.12);border-color:rgba(16,185,129,.30)}
    .priority-card h4{margin:8px 0 10px;font-size:15px;line-height:1.35}.priority-card .reason{min-height:42px;color:#cbd5e1;font-size:12px;line-height:1.5}
    .priority-metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px}.priority-metrics span{display:block;color:var(--muted);font-size:10px}.priority-metrics strong{display:block;margin-top:4px;font-family:var(--mono);font-size:12px}
    .chart-box{min-height:320px;border:1px solid rgba(148,163,184,.15);border-radius:20px;background:rgba(2,6,23,.30);padding:12px;overflow:hidden}
    .chart-svg{width:100%;height:auto;display:block}
    .scatter-point{cursor:pointer}.scatter-point circle{transition:.18s r,.18s opacity}.scatter-point:hover circle{r:12;opacity:1}
    .axis-label{fill:#93a4bb;font-size:12px}.chart-label{fill:#e5edf8;font-size:12px;font-weight:800}.chart-muted{fill:#64748b;font-size:11px}
    .heatmap{display:grid;gap:5px;overflow:auto;padding-bottom:6px}
    .heat-row{display:grid;grid-template-columns:190px repeat(15,34px);gap:5px;align-items:center}
    .heat-head{position:sticky;top:0;background:rgba(8,12,24,.96);z-index:2}
    .heat-product{font-size:12px;color:#dbeafe;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .heat-cell{width:34px;height:28px;border-radius:9px;border:1px solid rgba(148,163,184,.16);display:grid;place-items:center;font-size:10px;font-family:var(--mono);cursor:pointer}
    .heat-cell.on{background:rgba(52,211,153,.18);color:#bbf7d0;border-color:rgba(52,211,153,.30)}
    .heat-cell.miss{background:rgba(251,191,36,.18);color:#fde68a;border-color:rgba(251,191,36,.30)}
    .heat-cell.act{background:rgba(251,113,133,.18);color:#fecdd3;border-color:rgba(251,113,133,.32)}
    .heat-cell.none{background:rgba(15,23,42,.50);color:#475569}
    .briefing{display:grid;grid-template-columns:1.15fr .85fr;gap:14px}
    .briefing-main{border:1px solid rgba(34,211,238,.20);border-radius:22px;background:linear-gradient(135deg,rgba(8,47,73,.30),rgba(15,23,42,.48));padding:18px}
    .briefing-main h4{margin:0 0 10px;font-size:18px}.briefing-main p{margin:0 0 10px;color:#dbeafe;line-height:1.65}
    .briefing-list{margin:10px 0 0;padding-left:18px;color:#cbd5e1;line-height:1.7}.briefing-list li{margin:4px 0}
    .briefing-side{display:grid;gap:10px}
    .briefing-note{border:1px solid rgba(148,163,184,.16);border-radius:18px;background:rgba(2,6,23,.32);padding:13px}
    .briefing-note span{display:block;color:var(--muted);font-size:11px}.briefing-note strong{display:block;margin-top:5px;font-size:15px}
    .markdown-preview{margin-top:12px;border:1px solid rgba(148,163,184,.18);border-radius:18px;background:rgba(2,6,23,.36);overflow:hidden}
    .markdown-preview summary{cursor:pointer;min-height:44px;padding:12px 14px;color:#bfdbfe;font-weight:700;list-style:none}
    .markdown-preview summary::-webkit-details-marker{display:none}
    .markdown-preview pre{margin:0;padding:0 14px 14px;max-height:360px;overflow:auto;white-space:pre-wrap;color:#dbeafe;font-family:var(--mono);font-size:12px;line-height:1.65}
    body[data-theme="light"] .briefing-main{background:#ffffff;border-color:#dbeafe;box-shadow:0 8px 24px rgba(15,23,42,.05)}
    body[data-theme="light"] .briefing-main p{color:#334155}
    body[data-theme="light"] .briefing-list{color:#334155}
    body[data-theme="light"] .briefing-note{background:#ffffff;border-color:#e2e8f0;box-shadow:0 8px 20px rgba(15,23,42,.05)}
    body[data-theme="light"] .markdown-preview{background:#ffffff;border-color:#e2e8f0}
    body[data-theme="light"] .markdown-preview summary{color:#1d4ed8}
    body[data-theme="light"] .markdown-preview pre{color:#0f172a;background:#f8fafc}
    .warning-panel{display:none;margin:-6px 0 18px;border:1px solid rgba(251,191,36,.30);border-radius:22px;background:linear-gradient(135deg,rgba(120,53,15,.34),rgba(15,23,42,.62));padding:14px 16px;color:#fde68a}
    .warning-panel.show{display:block}
    .warning-panel.inline{display:block;margin:12px 0;border-radius:18px;background:rgba(120,53,15,.18)}
    body[data-theme="light"] .warning-panel.inline{background:#fffbeb;color:#92400e;border-color:#fde68a}
    .warning-panel h3{margin:0 0 8px;font-size:15px}.warning-panel ul{margin:0;padding-left:18px;color:#fef3c7;line-height:1.6}
    body[data-theme="light"] .warning-panel ul{color:#92400e}
    .domain{color:var(--cyan);font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.08em}.score{font-family:var(--mono);color:#fff}
    body[data-theme="light"] .score{color:#0f172a}
    .insight-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}
    .insight-card{position:relative;overflow:hidden;padding:16px;border:1px solid rgba(148,163,184,.18);border-radius:20px;background:linear-gradient(135deg,rgba(17,24,39,.86),rgba(15,23,42,.46))}
    .insight-card:before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:linear-gradient(var(--cyan),var(--violet),var(--pink))}
    .insight-card h4{margin:10px 0 8px;font-size:16px}
    .insight-card p{margin:0;color:#cbd5e1;line-height:1.56}
    .insight-card .next{margin-top:10px;color:#dbeafe}
    .empty{padding:32px;text-align:center;color:var(--muted)}
    .toast{position:fixed;right:22px;bottom:22px;z-index:99;transform:translateY(20px);opacity:0;transition:.2s;min-width:220px;border:1px solid rgba(52,211,153,.3);border-radius:16px;background:rgba(6,78,59,.86);color:#dcfce7;padding:12px 14px;box-shadow:var(--shadow)}
    .toast.show{transform:translateY(0);opacity:1}
    .sop-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
    .sop-card{border:1px solid rgba(148,163,184,.16);border-radius:22px;background:linear-gradient(145deg,rgba(15,23,42,.78),rgba(30,41,59,.42));padding:16px;min-height:260px;position:relative;overflow:hidden}
    .sop-card:before{content:"";position:absolute;inset:0 0 auto 0;height:3px;background:linear-gradient(90deg,var(--cyan),var(--blue),var(--amber));opacity:.85}
    .sop-card.high{border-color:rgba(248,113,113,.34);box-shadow:0 0 0 1px rgba(248,113,113,.06) inset}
    .sop-card.good{border-color:rgba(52,211,153,.28)}
    .sop-card h4{margin:10px 0 8px;font-size:18px}
    .sop-card .sop-meta{display:flex;justify-content:space-between;gap:10px;align-items:center;color:var(--muted);font-size:12px}
    .sop-card .sop-score{font-size:28px;font-weight:850;color:#e0f2fe;font-variant-numeric:tabular-nums}
    .sop-steps{display:grid;gap:7px;margin:12px 0}
    .sop-steps div{display:grid;grid-template-columns:22px 1fr;gap:8px;color:#cbd5e1;font-size:13px;line-height:1.45}
    .sop-steps b{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:999px;background:rgba(96,165,250,.14);color:#bfdbfe;font-size:12px}
    .sop-evidence{color:#94a3b8;font-size:12px;line-height:1.55;margin-top:8px}
    .sop-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
    .cause-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
    .cause-card{border:1px solid rgba(148,163,184,.16);border-radius:22px;background:linear-gradient(145deg,rgba(8,13,28,.84),rgba(30,41,59,.42));padding:16px;position:relative;overflow:hidden}
    .cause-card:before{content:"";position:absolute;inset:0 0 auto 0;height:3px;background:linear-gradient(90deg,var(--pink),var(--amber),var(--cyan));opacity:.82}
    .cause-card h4{margin:10px 0 8px;font-size:17px;line-height:1.35}
    .cause-card p{margin:0;color:#cbd5e1;line-height:1.55;font-size:13px}
    .cause-factor{display:grid;grid-template-columns:92px 1fr 44px;gap:8px;align-items:center;margin-top:9px;color:#cbd5e1;font-size:12px}
    .cause-factor span{color:#94a3b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .cause-factor .cause-bar{height:8px;border-radius:999px;background:rgba(148,163,184,.14);overflow:hidden}
    .cause-factor .cause-bar i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--pink),var(--amber))}
    .cause-chain{display:grid;gap:7px;margin:12px 0}
    .cause-chain div{display:grid;grid-template-columns:22px 1fr;gap:8px;color:#dbeafe;font-size:13px;line-height:1.45}
    .cause-chain b{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:999px;background:rgba(251,191,36,.13);color:#fde68a;font-size:12px}
    .cause-conclusion{margin-top:10px;border:1px solid rgba(96,165,250,.18);border-radius:14px;background:rgba(59,130,246,.08);padding:9px 10px;color:#bfdbfe}
    .command-room{display:grid;grid-template-columns:1.08fr .92fr;gap:14px}
    .commander-card{border:1px solid rgba(34,211,238,.24);border-radius:24px;background:linear-gradient(135deg,rgba(8,47,73,.36),rgba(15,23,42,.58));padding:18px;position:relative;overflow:hidden}
    .commander-card:after{content:"";position:absolute;width:260px;height:260px;border-radius:999px;right:-120px;top:-130px;background:radial-gradient(circle,rgba(34,211,238,.28),transparent 70%);filter:blur(6px)}
    .commander-card h4{position:relative;margin:10px 0 10px;font-size:22px;line-height:1.2}
    .commander-card p{position:relative;margin:0;color:#dbeafe;line-height:1.65}
    .commander-metrics{position:relative;display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:14px}
    .commander-metrics div{border:1px solid rgba(148,163,184,.16);border-radius:16px;background:rgba(2,6,23,.30);padding:11px}
    .commander-metrics span{display:block;color:#94a3b8;font-size:11px}.commander-metrics strong{display:block;margin-top:5px;font-family:var(--mono);font-size:16px}
    .command-lanes{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
    .command-lane{border:1px solid rgba(148,163,184,.16);border-radius:20px;background:linear-gradient(145deg,rgba(15,23,42,.72),rgba(2,6,23,.38));padding:14px}
    .command-lane h4{margin:8px 0 7px;font-size:15px}.command-lane p{margin:0;color:#cbd5e1;font-size:12px;line-height:1.55}
    .command-lane .lane-target{margin-top:9px;color:#e0f2fe;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .lane-foot{display:flex;gap:8px;flex-wrap:wrap;margin-top:11px}
    .review-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
    .review-card{border:1px solid rgba(148,163,184,.16);border-radius:20px;background:linear-gradient(145deg,rgba(15,23,42,.72),rgba(2,6,23,.38));padding:15px}
    .review-card.due{border-color:rgba(251,191,36,.35);background:linear-gradient(145deg,rgba(120,53,15,.20),rgba(15,23,42,.56))}
    .review-card.overdue{border-color:rgba(251,113,133,.38);background:linear-gradient(145deg,rgba(127,29,29,.22),rgba(15,23,42,.56))}
    .review-card h4{margin:9px 0 7px;font-size:15px;line-height:1.35}
    .review-card p{margin:0;color:#cbd5e1;font-size:12px;line-height:1.55}
    .review-meta{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:10px 0}
    .review-meta div{border:1px solid rgba(148,163,184,.13);border-radius:14px;background:rgba(2,6,23,.25);padding:9px}
    .review-meta span{display:block;color:#94a3b8;font-size:10px}.review-meta strong{display:block;margin-top:4px;font-size:12px;font-family:var(--mono)}
    body[data-theme="light"] .progress-card,
    body[data-theme="light"] .bulk-panel,
    body[data-theme="light"] .health-card,
    body[data-theme="light"] .path-card,
    body[data-theme="light"] .priority-card,
    body[data-theme="light"] .insight-card,
    body[data-theme="light"] .sop-card,
    body[data-theme="light"] .cause-card,
    body[data-theme="light"] .commander-card,
    body[data-theme="light"] .command-lane,
    body[data-theme="light"] .review-card,
    body[data-theme="light"] .chart-box{background:#ffffff;color:#0f172a;border-color:#e2e8f0;box-shadow:0 8px 22px rgba(15,23,42,.05)}
    body[data-theme="light"] .health-card.good{background:#f0fdf4;border-color:#bbf7d0}
    body[data-theme="light"] .health-card.warn,
    body[data-theme="light"] .review-card.due{background:#fffbeb;border-color:#fde68a}
    body[data-theme="light"] .health-card.bad,
    body[data-theme="light"] .review-card.overdue{background:#fff1f2;border-color:#fecdd3}
    body[data-theme="light"] .opportunity-card{background:#ecfdf5;border-color:#a7f3d0}
    body[data-theme="light"] .health-card p,
    body[data-theme="light"] .priority-card .reason,
    body[data-theme="light"] .insight-card p,
    body[data-theme="light"] .insight-card .next,
    body[data-theme="light"] .cause-card p,
    body[data-theme="light"] .cause-factor,
    body[data-theme="light"] .commander-card p,
    body[data-theme="light"] .command-lane p,
    body[data-theme="light"] .command-lane .lane-target,
    body[data-theme="light"] .review-card p,
    body[data-theme="light"] .compact-list{color:#334155}
    body[data-theme="light"] .sop-card .sop-score,
    body[data-theme="light"] .commander-metrics strong{color:#0f172a}
    body[data-theme="light"] .commander-metrics div,
    body[data-theme="light"] .review-meta div{background:#f8fafc;border-color:#e2e8f0}
    .footer{color:var(--muted);font-size:12px;padding:24px 0;text-align:center}
    @media (max-width:1280px){.toolbar{grid-template-columns:minmax(190px,230px) 118px 112px 82px minmax(430px,1fr);gap:8px}body:not([data-current-tab="overview"]):not([data-current-tab="actions"]) .toolbar{grid-template-columns:minmax(154px,.7fr) minmax(154px,.7fr) minmax(72px,.3fr) 82px minmax(350px,1.4fr)}.toolbar-range-dock{grid-column:auto}.toolbar-range-dock .range-toolbar-main{grid-template-columns:minmax(178px,.48fr) minmax(250px,1fr)}body[data-current-tab="actions"] .toolbar{grid-template-columns:minmax(210px,1fr) minmax(180px,.82fr) minmax(118px,.5fr) 82px}.toolbar .action-local-filter{grid-column:1/-1}.toolbar .action-local-filter-controls{grid-template-columns:repeat(3,minmax(120px,1fr))}}
    @media (max-width:1180px){.shell{grid-template-columns:1fr}.side{position:relative;height:auto}main{max-width:100vw}.kpis,.overview-core .kpis{grid-template-columns:1fr}.overview-core,.overview-core .group-summary-grid.two,.home-scope-toolbar,.calendar-duo,.calendar-input-row,.range-calendar-grid,.range-popover-grid,.range-toolbar-main,.page-guide-inner,.page-guide-grid,.page-decision-grid,.store-flow,.store-kpi-grid,.problem-stack,.store-action-steps,.profit-workbench-grid,.profit-tool-grid,.ops-command,.ops-question-grid,.ops-pillar-grid,.profit-command,.profit-logic,.profit-summary-grid,.rtv-hero,.rtv-flow-grid,.rtv-term-grid,.mission-grid,.workstream-grid,.profit-calculator,.selection-model{grid-template-columns:1fr}.selection-model.wide{grid-template-areas:"verdict" "matrix" "samples"}.home-scope-hint{justify-content:flex-start}.range-popover{min-width:0;width:calc(100vw - 56px);left:0}.toolbar{grid-template-columns:1fr}.range-toolbar{top:8px}.grid.cols-2,.grid.cols-3,.split,.spotlight,.sop-grid,.cause-grid,.command-room,.command-lanes,.detail-grid,.action-card.v1-action{grid-template-columns:1fr}.brief-grid{grid-template-columns:repeat(2,1fr)}.brief-grid.five{grid-template-columns:repeat(5,minmax(0,1fr));gap:8px}.coverage-board{grid-template-columns:repeat(2,minmax(0,1fr))}.hero-top{display:block}.quick-links{justify-content:flex-start;margin-top:18px}h2{font-size:30px}}
    @media (max-width:1180px){.action-card.v1-action{grid-template-areas:"main" "evidence" "controls"}.action-card.v1-action .action-controls{grid-template-columns:1fr}.action-card.v1-action .command-actions,.action-card.v1-action .status-actions{grid-template-columns:repeat(2,minmax(0,1fr))}.action-card.v1-action .action-meta{grid-template-columns:1fr}}
    @media (prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
  </style>
</head>
<body>
<div class="shell">
  <aside class="side">
    <div class="brand">
      <div class="logo" aria-hidden="true">${svgIcon('metabase')}</div>
      <div>
        <h1>SHEIN BI</h1>
        <p>经营系统 · 本地门户</p>
      </div>
    </div>
    <nav class="nav" aria-label="主导航">
      <button class="active" data-tab="overview">${svgIcon('home')}总控驾驶舱</button>
      <button data-tab="stores">${svgIcon('store')}店铺视角</button>
      <button data-tab="products">${svgIcon('box')}货号 360</button>
      <button data-tab="links">${svgIcon('link')}SKC / 链接</button>
          <button data-tab="linkops">${svgIcon('action')}链接管理中台</button>
          <button data-tab="comments">${svgIcon('alert')}评价 / 口碑</button>
          <button data-tab="business">${svgIcon('metabase')}订单 / 售后</button>
          <button data-tab="profit">${svgIcon('metabase')}成本 / 利润</button>
          <button data-tab="inventory">${svgIcon('box')}实际库存 / 去化</button>
          <button data-tab="actions">${svgIcon('action')}今日动作池</button>
          <button data-tab="system">${svgIcon('alert')}系统状态</button>
      <a href="${htmlEscape(links.home)}" target="_blank" rel="noreferrer">${svgIcon('metabase')}打开 Metabase 深度分析</a>
    </nav>
    <div class="meta">
      <div><strong>BI 页面生成</strong><br><span id="generatedAt"></span></div>
      <div><strong>SHEIN 销售源</strong><br><span id="salesDate"></span><small id="salesUpdatedAt"></small></div>
      <div><strong>SHEIN 业务域</strong><br><span id="businessDate"></span><small id="businessUpdatedAt"></small></div>
      <div><strong>SHEIN 链接表现</strong><br><span id="linkDate"></span><small id="linkUpdatedAt"></small></div>
      <div><strong>成本表文件</strong><br><span id="manualCostDate"></span></div>
      <div><strong>ET 货代仓</strong><br><span id="etDate"></span></div>
      <div style="margin-top:8px">数据体检：<span id="auditState"></span></div>
    </div>
  </aside>
  <main>
    <div class="toolbar" role="search">
      <div class="home-scope-toolbar" aria-label="首页筛选">
        <div class="search-wrap home-only-filter">${svgIcon('search')}<input id="homeProductFilter" aria-label="首页货号筛选" placeholder="首页货号筛选：标准货号 / SKC / 品名" autocomplete="off" /></div>
        <select id="homeStoreFilter" class="home-only-filter" aria-label="首页店铺或分组筛选"><option value="">全部店铺</option></select>
        <div class="home-scope-hint home-only-filter" id="homeScopeHint"></div>
      </div>
      <div class="search-wrap subpage-filter">${svgIcon('search')}<input id="q" aria-label="全局搜索" placeholder="全局搜索：店铺 / SKC / 动作原因" autocomplete="off" /></div>
      <input id="productFilter" class="subpage-filter" aria-label="货号筛选" placeholder="货号筛选，例如 PA4 / 咖啡机" autocomplete="off" />
      <select id="storeFilter" class="subpage-filter" aria-label="店铺筛选"><option value="">全部店铺</option></select>
      <button class="btn" id="clearFilters">清空筛选</button>
      <div class="action-scope-toolbar action-local-filter" aria-label="动作池专用筛选">
        <div class="action-local-filter-head">
          <strong>动作池专用筛选</strong>
          <span>今日动作池是当前最新待办池，不按时间段回看；这里的业务域、风险、处理状态和快速聚焦只影响动作池，不影响其它页面。</span>
        </div>
        <div class="action-local-filter-controls">
          <select id="domainFilter" aria-label="动作池业务域筛选"><option value="">全部业务域</option></select>
          <select id="riskFilter" aria-label="动作池风险筛选">
            <option value="">全部风险</option>
            <option value="high">高风险优先</option>
            <option value="mid">关注项</option>
            <option value="retire">下架候选</option>
          </select>
          <select id="statusFilter" aria-label="动作池处理状态筛选">
            <option value="">全部状态</option>
            <option value="open">未处理</option>
            <option value="review">待复核</option>
            <option value="done">已处理</option>
            <option value="ignored">已忽略</option>
          </select>
        </div>
        <div class="focusbar action-focusbar" id="focusBar" aria-label="动作池快速聚焦"></div>
      </div>
      <div id="topRangeDock" class="toolbar-range-dock" hidden></div>
    </div>
    <div class="hero">
      <div class="hero-top">
        <div>
          <div class="eyebrow">OPERATING INTELLIGENCE</div>
          <h2>先看总盘，再看排行，具体动作再下钻。</h2>
          <p>首页只保留最直观的经营看板：今日、月累计、分组、店铺排行、货号排行和动作结构。需要处理时再进入店铺、货号、SKC 或动作池。</p>
        </div>
        <div class="quick-links">
          <a class="link-pill" href="${htmlEscape(links.finance)}" target="_blank">${svgIcon('metabase')}财务订单域</a>
          <a class="link-pill" href="${htmlEscape(links.quality)}" target="_blank">${svgIcon('metabase')}退货质量域</a>
          <a class="link-pill" href="${htmlEscape(links.ops)}" target="_blank">${svgIcon('metabase')}库存履约营销域</a>
          <button class="link-pill" id="copyCurrentView">${svgIcon('copy')}复制当前视图</button>
          <button class="link-pill" id="themeToggle" type="button">浅色/深色</button>
        </div>
      </div>
      <div class="overview-dock">
        <div class="overview-head">
          <div>
            <h3>经营总览仪表盘</h3>
            <div class="sub">先选时间段，再看同一口径下的总盘、分组、趋势和排行；本月数据只作为补充参照。</div>
          </div>
          <span class="tag good" id="homeDashboardTag"></span>
        </div>
        <div class="overview-core">
          <div class="kpis" id="kpis"></div>
          <div id="groupOverview"></div>
        </div>
        <div id="homeDashboard"></div>
      </div>
    </div>

    <div class="warning-panel" id="dataWarnings" role="status" aria-live="polite"></div>

    <section id="overview" class="section active">
      <details class="overview-fold" id="dataFold">
        <summary>系统口径、后台地图和趋势准备</summary>
        <div class="overview-fold-body">
          <div class="card" style="margin-bottom:16px">
            <div class="card-h">
              <div><h3>数据可信度 / 覆盖雷达</h3><div class="sub">每天先看这里：哪些数据是今天可用，哪些只是旧快照或阶段性覆盖，避免误判。</div></div>
              <span class="tag info" id="dataReliabilityScore"></span>
            </div>
            <div class="card-body"><div id="dataReliability"></div></div>
          </div>
          <div class="card" style="margin-bottom:16px">
            <div class="card-h">
              <div><h3>趋势准备雷达</h3><div class="sub">只在数据真的积累够以后才做趋势、环比和下滑预警；当前不足时明确告诉你还差几天。</div></div>
              <span class="tag info" id="trendReadinessScore"></span>
            </div>
            <div class="card-body"><div id="trendReadiness"></div></div>
          </div>
          <div class="card" style="margin-bottom:16px">
            <div class="card-h">
              <div><h3>SHEIN 后台数据地图</h3><div class="sub">把后台菜单、核心接口、当前入仓覆盖和 BI 用途放在一起，方便判断系统还缺哪块。</div></div>
              <span class="tag info" id="backendMapScore"></span>
            </div>
            <div class="card-body"><div id="backendDataMap"></div></div>
          </div>
        </div>
      </details>
      <div class="card" style="margin-bottom:16px">
        <div class="card-h">
          <div><h3>今日经营简报</h3><div class="sub">系统把销售、店铺风险、货号风险和动作池压缩成可直接发给团队的晨会摘要。</div></div>
          <div class="status-actions"><button class="btn" id="copyBriefing">复制简报</button><button class="btn" id="copyMarkdownBriefing">复制完整晨报</button></div>
        </div>
        <div class="card-body"><div class="briefing" id="dailyBriefing"></div><details class="markdown-preview"><summary>展开完整 Markdown 晨报预览</summary><pre id="markdownBriefingPreview"></pre></details></div>
      </div>
      <details class="overview-fold" id="detailsFold">
        <summary>作战细节、复查和归因（需要时展开）</summary>
        <div class="overview-fold-body">
      <div class="card" style="margin-bottom:16px">
        <div class="card-h">
          <div><h3>今日指挥室</h3><div class="sub">把归因、SOP、动作池和增长机会压成一屏：今天先打哪一仗、派谁看、处理完复查什么。</div></div>
          <span class="tag high" id="commandRoomTag"></span>
        </div>
        <div class="card-body"><div class="command-room" id="commandRoom"></div></div>
      </div>
      <div class="card" style="margin-bottom:16px">
        <div class="card-h">
          <div><h3>复查队列 / 闭环看板</h3><div class="sub">动作标记已处理或待复查后，会自动变成复查项：几天后回来，看曝光、支付、售后、库存或财务是否真的改善。</div></div>
          <span class="tag info" id="reviewQueueTag"></span>
        </div>
        <div class="card-body"><div id="reviewQueue"></div></div>
      </div>
      <div class="card" style="margin-bottom:16px">
        <div class="card-h">
          <div><h3>经营态势图谱</h3><div class="sub">左边看“哪家店销售高但风险也高”，右边看“哪些货号在哪些店缺覆盖或有动作”。</div></div>
          <span class="tag info">可点击筛选</span>
        </div>
        <div class="card-body">
          <div class="grid cols-2">
            <div>
              <div class="sub" style="margin-bottom:8px">店铺风险象限：横轴净成交额，纵轴综合风险</div>
              <div class="chart-box" id="storeScatter"></div>
            </div>
            <div>
              <div class="sub" style="margin-bottom:8px">货号 × 店铺覆盖热力图：绿色有上架，黄色缺覆盖，红色有动作</div>
              <div class="chart-box" id="coverageHeatmap"></div>
            </div>
          </div>
        </div>
      </div>
      <div class="grid cols-2">
        <div class="card">
          <div class="card-h">
            <div><h3>店铺风险雷达</h3><div class="sub">按综合风险分排序，点店铺卡片即可过滤全站。</div></div>
            <a class="tag info" href="${htmlEscape(links.store)}" target="_blank">店铺深钻</a>
          </div>
          <div class="card-body"><div class="store-grid" id="storeCards"></div></div>
        </div>
        <div class="card">
          <div class="card-h">
            <div><h3>业务动作结构</h3><div class="sub">动作池已限额，目标是每天能操作，不再给千级清单。</div></div>
            <span class="tag good" id="actionTotal"></span>
          </div>
          <div class="card-body">
            <div id="domainBars"></div>
            <div style="margin-top:18px" id="decisionTips"></div>
          </div>
        </div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-h">
          <div><h3>今日作战路径</h3><div class="sub">不是把所有异常都堆给你，而是按经营动作组织：先止损，再补覆盖，再优化承接，最后复制有效打法。</div></div>
          <span class="tag info">系统推荐路径</span>
        </div>
        <div class="card-body"><div class="path-grid" id="battlePath"></div></div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-h">
          <div><h3>场景化 SOP 工作台</h3><div class="sub">按真实运营场景组织数据：每张卡都给出判断依据、处理顺序和跳转入口，避免在表格里迷路。</div></div>
          <span class="tag good" id="sopTotal"></span>
        </div>
        <div class="card-body"><div class="sop-grid" id="sopWorkbench"></div></div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-h">
          <div><h3>经营异常归因中心</h3><div class="sub">把“哪个店/货号有问题”拆成原因链：先判断主因，再给处理顺序和钻取入口。</div></div>
          <span class="tag high" id="rootCauseTotal"></span>
        </div>
        <div class="card-body"><div class="cause-grid" id="rootCauseCenter"></div></div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-h">
          <div><h3>增长机会池</h3><div class="sub">不只看风险，也找“已经证明能卖、售后压力可控、还可以扩店或复制打法”的货号。</div></div>
          <span class="tag good">点击进入货号 360</span>
        </div>
        <div class="card-body"><div class="priority-grid" id="growthOpportunityGrid"></div></div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-h">
          <div><h3>跨域货号优先级</h3><div class="sub">把销售、链接、财务商品、售后、质量和动作池合成一张货号优先处理卡。</div></div>
          <span class="tag info">点击进入货号 360</span>
        </div>
        <div class="card-body"><div class="priority-grid" id="productPriorityGrid"></div></div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-h">
          <div><h3>经营诊断摘要</h3><div class="sub">自动把店铺、货号、链接、库存、售后、履约、营销里的高价值信号合并成诊断。</div></div>
          <span class="tag info" id="insightTotal"></span>
        </div>
        <div class="card-body"><div class="focusbar" id="insightFocusBar"></div><div class="insight-list" id="insightsList"></div></div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-h">
          <div><h3>今天先处理什么</h3><div class="sub">按全局评分排序，优先处理高分、高优先级、跨域风险集中的动作。</div></div>
          <button class="btn" data-tab-jump="actions">查看全部动作</button>
        </div>
        <div class="card-body"><div class="action-list" id="topActions"></div></div>
      </div>
        </div>
      </details>
    </section>

    <section id="stores" class="section">
      <div class="card" style="margin-bottom:16px">
        <div class="card-h"><div><h3>店铺作战台</h3><div class="sub">选择左侧或顶部店铺筛选后，这里会变成该店铺的当天经营入口。</div></div><span class="tag info" id="storeCockpitTag"></span></div>
        <div class="card-body" id="storeCockpit"></div>
      </div>
      <div class="card">
        <div class="card-h"><div><h3>店铺横向对照表</h3><div class="sub">每行一个店：当前时段销售/订单 + 最新风险信号。用于横向找问题店，点店铺进入作战台。</div></div></div>
        <div class="card-body"><div id="storesTable"></div></div>
      </div>
    </section>

    <section id="products" class="section">
      <div class="card" style="margin-bottom:16px">
        <div class="card-h"><div><h3>货号 360 聚焦</h3><div class="sub">搜索某个货号后，这里会把它的销售、覆盖、售后、库存、动作和链接放在一起看。</div></div><span class="tag info" id="productSpotlightTag"></span></div>
        <div class="card-body" id="productSpotlight"></div>
      </div>
      <div class="card">
        <div class="card-h">
          <div><h3>货号 360 风险池</h3><div class="sub">从货号看销售、覆盖、展示库存、退货、评价与风险。</div></div>
          <a class="tag info" href="${htmlEscape(links.product)}" target="_blank">货号深钻</a>
        </div>
        <div class="card-body"><div id="productsTable"></div></div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-h"><div><h3>店铺 × 货号覆盖矩阵</h3><div class="sub">用于看某个货号在哪些店缺链接、缺动作、或已有销售基础。</div></div></div>
        <div class="card-body"><div id="matrixTable"></div></div>
      </div>
    </section>

    <section id="links" class="section">
      <div class="card" style="margin-bottom:16px">
        <div class="card-h">
          <div><h3>SKC / 链接 360 聚焦</h3><div class="sub">搜索 SKC 后，这里会把链接状态、流量承接、订单、财务、售后和动作放在一起。</div></div>
          <span class="tag info" id="linkSpotlightTag"></span>
        </div>
        <div class="card-body" id="linkSpotlight"></div>
      </div>
      <div class="card">
        <div class="card-h">
          <div><h3>SKC / 链接健康</h3><div class="sub">优化、下架候选、流量承接异常、待上架卡点集中到这里。</div></div>
          <a class="tag info" href="${htmlEscape(links.skc)}" target="_blank">SKC 深钻</a>
        </div>
        <div class="card-body"><div id="linksTable"></div></div>
      </div>
    </section>

    <section id="linkops" class="section">
      <div class="card" style="margin-bottom:16px">
        <div class="card-h">
          <div><h3>链接管理中台</h3><div class="sub">先把自然语言运营指令沉淀为任务草案；当前阶段只建任务和预览，不自动修改 SHEIN 后台。</div></div>
          <span class="tag mid" id="linkOpsModeTag">待确认执行</span>
        </div>
        <div class="card-body" id="linkOpsCommandCenter"></div>
      </div>
      <div id="linkOpsTaskList" style="display:none"></div>
    </section>

    <section id="comments" class="section">
      <div class="card" style="margin-bottom:16px">
        <div class="card-h"><div><h3>评价 / 口碑总览</h3><div class="sub">把每个货号的历史评价、低星、差评标签和店铺分布梳理出来；先做筛选和原文查看，中文翻译后续批量补齐。</div></div><span class="tag info" id="commentsTag"></span></div>
        <div class="card-body" id="commentsOverview"></div>
      </div>
      <div class="card">
        <div class="card-h"><div><h3>评价明细</h3><div class="sub">按货号、店铺、SKC 或评价内容筛选；低星和质量投诉优先排在前面。</div></div></div>
        <div class="card-body" id="commentsTable"></div>
      </div>
    </section>

    <section id="business" class="section">
      <div class="card" style="margin-bottom:16px">
        <div class="card-h">
          <div><h3>订单 / 售后复核台</h3><div class="sub">先回答：成交是否真实、售后压力来自哪里、哪些订单/货号需要复核。财务和履约只作为互证证据。</div></div>
          <a class="tag info" href="${htmlEscape(links.finance)}" target="_blank">财务深钻</a>
        </div>
        <div class="card-body"><div id="financeTable"></div></div>
      </div>
      <div class="card" style="margin-bottom:16px" id="rtvWorkbenchCard">
        <div class="card-h">
          <div><h3>RTV / 退货去向中心</h3><div class="sub">专门回答：退货有没有被 ET 收到、收到后去了哪里、是否可以二次销售、还有哪些换单要复核。</div></div>
          <span class="tag mid">RTV 专区</span>
        </div>
        <div class="card-body"><div id="rtvWorkbench"></div></div>
      </div>
      <details class="detail-section" style="margin-top:16px">
        <summary>展开单据证据区：财务、订单、售后、履约</summary>
        <div class="detail-body">
          <div class="card" style="margin-bottom:16px">
            <div class="card-h">
              <div><h3>营销活动辅助解释</h3><div class="sub">只作为销售波动解释，不作为订单售后页主判断。</div></div>
              <a class="tag info" href="${htmlEscape(links.ops)}" target="_blank">营销深钻</a>
            </div>
            <div class="card-body"><div id="campaignTable"></div></div>
          </div>
          <div class="detail-grid">
            <div class="card">
              <div class="card-h"><div><h3>收入明细 · 在途订单</h3><div class="sub">来自新财务入口的“在途订单金额”明细，用来和订单销售互相印证。</div></div></div>
              <div class="card-body"><div id="financeOrdersTable"></div></div>
            </div>
            <div class="card">
              <div class="card-h"><div><h3>收入明细 · 商品 / SKC</h3><div class="sub">把在途收入继续拆到货号和 SKC，用来从商品维度复核财务。</div></div></div>
              <div class="card-body"><div id="financeGoodsTable"></div></div>
            </div>
          </div>
          <div class="card" style="margin-top:16px">
            <div class="card-h"><div><h3>订单明细</h3><div class="sub">用于从店铺/货号/SKC 反查当日订单。</div></div></div>
            <div class="card-body"><div id="ordersTable"></div></div>
          </div>
          <div class="detail-grid" style="margin-top:16px">
            <div class="card" id="afterSalesEvidenceCard">
              <div class="card-h"><div><h3>售后 / 退货明细</h3><div class="sub">退货原因、售后状态、退款金额和对应 SKC。</div></div></div>
              <div class="card-body"><div id="afterSalesTable"></div></div>
            </div>
            <div class="card" id="waybillEvidenceCard">
              <div class="card-h"><div><h3>发货 / 履约明细</h3><div class="sub">面单、仓库、物流商、履约状态和包裹商品。</div></div></div>
              <div class="card-body"><div id="waybillTable"></div></div>
            </div>
          </div>
        </div>
      </details>
    </section>

    <section id="profit" class="section">
      <div class="card" style="margin-bottom:16px">
        <div class="card-h">
          <div><h3>成本 / 利润经营台</h3><div class="sub">先看当前筛选是否赚钱，再看趋势和货号动作；净成交剔除退货，真实退货退款才额外扣 13.88 SAR。</div></div>
          <span class="tag info" id="profitTag"></span>
        </div>
        <div class="card-body" id="profitOverview"></div>
      </div>
      <div class="card" style="margin-bottom:16px" id="profitTrendCard">
        <div class="card-h"><div><h3>月利润趋势</h3><div class="sub">总计 / DSY / LGM 看全局；筛到单店或货号时看当前范围。月趋势按所选日期片段，不强行补整月。</div></div></div>
        <div class="card-body" id="profitTrendPanel"></div>
      </div>
      <div class="grid cols-2" style="margin-bottom:16px" id="profitRankGrid">
        <div class="card">
          <div class="card-h"><div><h3>高利润 / 可加码货号</h3><div class="sub">利润率 ≥ 20%；按利润率从高到低排序，先看哪些货号最值得加码。</div></div></div>
          <div class="card-body" id="profitWinners"></div>
        </div>
        <div class="card">
          <div class="card-h"><div><h3>低利润 / 需要处理货号</h3><div class="sub">利润率 < 20%；按利润率从低到高排序，先看哪些货号最需要处理。</div></div></div>
          <div class="card-body" id="profitLosers"></div>
        </div>
      </div>
      <div class="profit-workbench-grid">
        <div class="card" id="profitSelectionCard">
          <div class="card-h"><div><h3>选品标尺 / 利润试算</h3><div class="sub">基于成本表倒推体积，用未来 2000 RMB/方头程估算新品安全边界。</div></div></div>
          <div class="card-body" id="profitCalculatorPanel"></div>
        </div>
        <div class="card" id="profitCostGapCard">
          <div class="card-h"><div><h3>成本覆盖缺口</h3><div class="sub">没有成本的货号不硬算真实利润；后续成本表更新后这里会自动收敛。</div></div></div>
          <div class="card-body" id="profitCostGaps"></div>
        </div>
      </div>
    </section>

    <section id="inventory" class="section">
      <div class="card" style="margin-bottom:16px">
        <div class="card-h">
          <div><h3>实际库存 / 销售去化</h3><div class="sub">用成本表批次推算经营库存：到仓且已录头程费计入在库，缺到仓或头程费计入在途/待确认；库存扣减按毛销量，退货暂不加回。</div></div>
          <span class="tag info" id="inventoryTag"></span>
        </div>
        <div class="card-body" id="inventoryOverview"></div>
      </div>
      <div class="grid cols-2" style="margin-bottom:16px">
        <div class="card" id="inventoryRiskCard">
          <div class="card-h"><div><h3>补货 / 断货预警</h3><div class="sub">按当前店铺/分组销售速度测算去化天数；库存基数仍是全局物理批次。</div></div></div>
          <div class="card-body" id="inventoryRiskList"></div>
        </div>
        <div class="card" id="inventorySlowCard">
          <div class="card-h"><div><h3>库存沉淀 / 清货候选</h3><div class="sub">到仓有货但 30 天动销弱，优先看是否要做活动、优化链接或暂停补货。</div></div></div>
          <div class="card-body" id="inventorySlowList"></div>
        </div>
      </div>
      <div class="card" style="margin-bottom:16px" id="inventoryProductCard">
        <div class="card-h"><div><h3>货号库存去化明细</h3><div class="sub">一行一个标准货号；支持顶部货号/店铺/分组筛选。店铺筛选只改变销售速度，不代表该店独占这些库存。</div></div></div>
        <div class="card-body" id="inventoryProductTable"></div>
      </div>
      <details class="detail-section" id="inventoryBatchFold">
        <summary>批次生命周期 / 在途明细</summary>
        <div class="detail-body">
          <div id="inventoryBatchTable"></div>
        </div>
      </details>
    </section>

    <section id="actions" class="section">
      <div class="card">
        <div class="card-h">
          <div><h3>今日指导动作池</h3><div class="sub">链接 / 库存 / 质量 / 售后合并后的实操入口，支持状态、负责人、备注和处理指令。</div></div>
          <div class="status-actions"><button class="btn" id="copyFilteredActions">复制当前清单</button><button class="btn" id="exportFilteredActions">导出 CSV</button></div>
        </div>
        <div class="card-body">
          <div id="actionBulkPanel"></div>
          <div id="actionProgress"></div>
          <div class="action-list" id="actionsList"></div>
        </div>
      </div>
    </section>

    <section id="system" class="section">
      <div class="grid cols-2">
        <div class="card">
          <div class="card-h"><div><h3>系统状态</h3><div class="sub">确认今天的数据有没有跑完、是否能放心看。</div></div><span class="tag good" id="systemAuditTag"></span></div>
          <div class="card-body" id="systemStatus"></div>
        </div>
        <div class="card">
          <div class="card-h"><div><h3>快捷入口</h3><div class="sub">日常只需要打开门户；深钻再进 Metabase。</div></div></div>
          <div class="card-body" id="quickAccess"></div>
        </div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-h"><div><h3>当前口径说明</h3><div class="sub">避免把假库存、验证码受限财务明细、模板化建议混在一起。</div></div></div>
        <div class="card-body" id="metricNotes"></div>
      </div>
    </section>

    <div class="footer">SHEIN BI Portal · PostgreSQL Warehouse · Metabase Drilldown</div>
  </main>
</div>
<div id="toast" class="toast" role="status" aria-live="polite">已复制</div>
<button class="theme-fab" id="themeToggleFab" type="button" aria-label="切换浅色或深色主题">浅色/深色</button>
<script id="portal-data" type="application/json">${json}</script>
<script>
let DATA = JSON.parse(document.getElementById('portal-data').textContent);
let STORE_CODES = new Set((DATA.stores || []).map(s => s.store_key));
const STORE_ORDER = ['DL','DX','FY','LQ','NM','HL','JY','ZL','TS','MZ','CX','YJ','XL','QY','QH','TZ'];
function orderedStoreCodes(){
  const known = STORE_ORDER.filter(s => STORE_CODES.has(s));
  const extra = [...STORE_CODES].filter(s => !STORE_ORDER.includes(s)).sort();
  return known.concat(extra);
}
function storeOrderIndex(store){
  const idx = STORE_ORDER.indexOf(String(store || '').toUpperCase());
  return idx >= 0 ? idx : STORE_ORDER.length + 999;
}
let STORE_CODES_ARRAY = orderedStoreCodes();
const TOTAL_STORE_COUNT = STORE_CODES_ARRAY.length || Number(DATA.counts?.stores || 0) || 0;
let portalDataLastReadAt = new Date();
let portalRefreshInFlight = false;
let portalAutoRefreshTimer = null;
const fmt = new Intl.NumberFormat('zh-CN', {maximumFractionDigits: 2});
const fmt0 = new Intl.NumberFormat('zh-CN', {maximumFractionDigits: 0});
const money = n => 'SAR ' + fmt.format(Number(n || 0));
const RMB_RATE = 1.8;
const rmb = n => 'RMB ' + fmt.format(Number(n || 0) * RMB_RATE);
const cny = n => 'RMB ' + fmt.format(Number(n || 0));
const sarToCny = n => Number(n || 0) * RMB_RATE;
const num = n => fmt0.format(Number(n || 0));
const niceCeil = n => {
  const v = Math.max(1, Math.ceil(Number(n || 0)));
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const scaled = v / pow;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return step * pow;
};
const pct = n => n == null || n === '' ? '-' : (Number(n) * 100).toFixed(1) + '%';
const $ = id => document.getElementById(id);
const STORE_GROUP_FALLBACK = {
  DL:'DSY', DX:'DSY', FY:'DSY', LQ:'DSY', NM:'DSY', HL:'DSY', JY:'DSY', ZL:'DSY', TS:'DSY', MZ:'DSY',
  CX:'LGM', YJ:'LGM', XL:'LGM', QY:'LGM', QH:'LGM', TZ:'LGM'
};
const GROUP_META = {
  ALL:{key:'ALL', label:'全部', desc:String(TOTAL_STORE_COUNT || STORE_CODES_ARRAY.length) + ' 店合计', color:'#10b981', cls:'total'},
  DSY:{key:'DSY', label:'DSY 组', desc:'DL/DX/FY/LQ/NM/HL/JY/ZL/TS/MZ', color:'#2563eb', cls:'dsy'},
  LGM:{key:'LGM', label:'LGM 组', desc:'CX/YJ/XL/QY/QH/TZ', color:'#f97316', cls:'lgm'}
};
function storeGroupKey(row){
  return String(row?.group_key || STORE_GROUP_FALLBACK[String(row?.store_key || '').toUpperCase()] || 'OTHER').toUpperCase();
}
function groupMeta(key){
  return GROUP_META[String(key || '').toUpperCase()] || {key:String(key || 'OTHER'), label:String(key || 'OTHER'), desc:'未分组', color:'#94a3b8', cls:'other'};
}
function groupColor(key){ return groupMeta(key).color; }
function storeFilterKind(value = state.store){
  const v = String(value || '');
  if (v.startsWith('GROUP:')) return {type:'group', key:v.slice(6).toUpperCase()};
  if (v) return {type:'store', key:v.toUpperCase()};
  return {type:'all', key:'ALL'};
}
function storeScopeLabel(value = state.store){
  const scope = storeFilterKind(value);
  if (scope.type === 'group') return groupMeta(scope.key).label;
  if (scope.type === 'store') return scope.key;
  return '全部店铺';
}
function storeMatchesScope(row, value = state.store){
  const scope = storeFilterKind(value);
  if (scope.type === 'all') return true;
  const store = String(row?.store_key || '').toUpperCase();
  if (scope.type === 'store') return store === scope.key;
  return storeGroupKey(row) === scope.key;
}
function isActionFilterTab(tab = state.tab){ return tab === 'actions'; }
function actionDomainActive(){ return isActionFilterTab() ? state.domain : ''; }
function actionRiskActive(){ return isActionFilterTab() ? state.risk : ''; }
function actionStatusActive(){ return isActionFilterTab() ? state.status : ''; }
function actionFocusActive(){ return isActionFilterTab() ? (state.focus || 'all') : 'all'; }
let state = {tab:'overview', q:'', product:'', store:'', domain:'', risk:'', status:'', focus:'all', insight:'all', rankPeriod:'day', rankWindow:'', startDate:'', endDate:'', rangePreset:'today', trendMetric:'sales', salesMode:'net', qtyMode:'net', returnsMode:'request', profitMode:'loss'};
let lastRenderedTab = '';
let shouldScrollToActiveTab = false;
const STATE_KEYS = ['tab','q','product','store','domain','risk','status','focus','insight','rankPeriod','rankWindow','startDate','endDate','rangePreset','trendMetric','salesMode','qtyMode','returnsMode','profitMode'];
let applyingHash = false;
const ACTION_STATE_KEY = 'SHEIN_BI_ACTION_STATE_V1';
const ACTION_STATE_API = '/api/action-state';
const LINK_OPS_TASKS_API = '/api/link-ops-tasks';
const LINK_OPS_CHATS_API = '/api/link-ops-chats';
const LINK_OPS_ASSETS_API = '/api/link-ops-assets';
const LINK_OPS_EXECUTE_API = '/api/link-ops-execute';
const OPS_AGENT_ASK_API = '/api/ops-agent/ask';
const SERVICE_HEALTH_API = '/api/health';
const ACTION_STATE_SERVICE_PATH = 'state/bi_action_state.json';
const actionStateStore = {
  mode: window.location.protocol === 'http:' || window.location.protocol === 'https:' ? 'service' : 'browser',
  ready: false,
  error: ''
};
let serviceHealth = {
  checked: false,
  ok: false,
  error: '',
  host: '',
  port: '',
  lanMode: false,
  url: '',
  stateFile: '',
  writableActionState: false,
  readOnly: false,
  authRequired: false,
  user: null,
  checkedAt: ''
};
function normalizeActionState(value){
  const raw = value && value.actions && typeof value.actions === 'object' ? value.actions : (value || {});
  const next = {};
  Object.entries(raw || {}).forEach(([key, item]) => {
    const status = typeof item === 'string' ? item : item?.status;
    const safeStatus = ['open','done','review','ignored'].includes(status) ? status : 'open';
    const owner = typeof item === 'object' && item ? String(item.owner || '').slice(0, 80) : '';
    const note = typeof item === 'object' && item ? String(item.note || '').slice(0, 500) : '';
    const updatedAt = typeof item === 'object' && item ? String(item.updatedAt || '') : '';
    const updatedBy = typeof item === 'object' && item ? String(item.updatedBy || '').slice(0, 80) : '';
    const updatedByUser = typeof item === 'object' && item ? String(item.updatedByUser || '').slice(0, 120) : '';
    if (safeStatus !== 'open' || owner || note || updatedBy) next[key] = {status: safeStatus, owner, note, updatedAt, updatedBy, updatedByUser};
  });
  return next;
}
function loadActionState(){
  try { return normalizeActionState(JSON.parse(localStorage.getItem(ACTION_STATE_KEY) || '{}') || {}); } catch { return {}; }
}
function saveActionState(v){
  try { localStorage.setItem(ACTION_STATE_KEY, JSON.stringify(v || {})); } catch {}
}
function actionStateStoreLabel(){
  if (actionStateStore.mode === 'service' && serviceHealth.readOnly) return '网页服务（局域网只读预览）';
  if (actionStateStore.mode === 'service' && serviceHealth.authRequired && actionStateStore.ready) return '网页服务（登录协作：' + (serviceHealth.user?.displayName || serviceHealth.user?.username || '已登录') + '）';
  if (actionStateStore.mode === 'service' && actionStateStore.ready) return '\u7f51\u9875\u670d\u52a1\uff08\u53ef\u5171\u4eab\u4fdd\u5b58\uff09';
  if (actionStateStore.mode === 'service' && actionStateStore.error) return '\u7f51\u9875\u670d\u52a1\u4e0d\u53ef\u7528\uff0c\u5df2\u4e34\u65f6\u56de\u9000\u5f53\u524d\u6d4f\u89c8\u5668';
  if (actionStateStore.mode === 'service') return '\u6b63\u5728\u8fde\u63a5\u7f51\u9875\u670d\u52a1';
  return '\u5f53\u524d\u6d4f\u89c8\u5668';
}
let actionState = loadActionState();
const linkOpsStore = {ready:false, error:'', tasks:[]};
const linkOpsChatStore = {ready:false, error:'', sessions:[], activeId:''};
const opsAgentStore = {busy:false, answer:'', error:'', lastQuestion:'', durationMs:0};
async function initServiceHealth(){
  if (actionStateStore.mode !== 'service') {
    serviceHealth = {
      ...serviceHealth,
      checked: true,
      ok: false,
      error: '当前是直接打开 HTML 文件，不会请求本机网页服务。',
      checkedAt: new Date().toISOString()
    };
    return;
  }
  try {
    const res = await fetch(SERVICE_HEALTH_API, {cache:'no-store'});
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const payload = await res.json();
    serviceHealth = {
      checked: true,
      ok: Boolean(payload.ok),
      error: '',
      host: String(payload.host || ''),
      port: String(payload.port || ''),
      lanMode: Boolean(payload.lanMode),
      url: String(payload.url || ''),
      stateFile: String(payload.stateFile || ''),
      writableActionState: Boolean(payload.writableActionState),
      readOnly: Boolean(payload.readOnly),
      authRequired: Boolean(payload.authRequired),
      user: payload.user || null,
      checkedAt: new Date().toISOString()
    };
  } catch (err) {
    serviceHealth = {
      ...serviceHealth,
      checked: true,
      ok: false,
      error: err?.message || String(err || 'unknown'),
      checkedAt: new Date().toISOString()
    };
  }
  renderAll();
}
async function initActionState(){
  if (actionStateStore.mode !== 'service') {
    actionStateStore.ready = true;
    return;
  }
  try {
    const res = await fetch(ACTION_STATE_API, {cache:'no-store'});
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const payload = await res.json();
    actionState = normalizeActionState(payload.data || payload);
    saveActionState(actionState);
    actionStateStore.ready = true;
    actionStateStore.error = '';
    renderAll();
  } catch (err) {
    actionStateStore.error = err?.message || String(err || 'unknown');
    actionStateStore.mode = 'browser';
    actionStateStore.ready = true;
    showToast('\u52a8\u4f5c\u72b6\u6001\u670d\u52a1\u4e0d\u53ef\u7528\uff0c\u5df2\u56de\u9000\u5f53\u524d\u6d4f\u89c8\u5668');
    renderAll();
  }
}
async function refreshLinkOpsTasks(){
  if (actionStateStore.mode !== 'service') {
    linkOpsStore.ready = true;
    linkOpsStore.error = '直接打开 HTML 文件时无法读取云端任务池。';
    return;
  }
  try {
    const res = await fetch(LINK_OPS_TASKS_API + '?limit=120', {cache:'no-store'});
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const payload = await res.json();
    linkOpsStore.tasks = Array.isArray(payload?.data?.tasks) ? payload.data.tasks : [];
    linkOpsStore.ready = true;
    linkOpsStore.error = '';
  } catch (err) {
    linkOpsStore.ready = true;
    linkOpsStore.error = err?.message || String(err || 'unknown');
  }
  if ((state.tab || '') === 'linkops') renderAll();
}
async function refreshLinkOpsChats(){
  if (actionStateStore.mode !== 'service') {
    linkOpsChatStore.ready = true;
    linkOpsChatStore.error = '直接打开 HTML 文件时无法读取云端会话。';
    return;
  }
  try {
    const res = await fetch(LINK_OPS_CHATS_API + '?limit=80', {cache:'no-store'});
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const payload = await res.json();
    linkOpsChatStore.sessions = Array.isArray(payload?.data?.sessions) ? payload.data.sessions : [];
    if (!linkOpsChatStore.activeId && linkOpsChatStore.sessions[0]) linkOpsChatStore.activeId = linkOpsChatStore.sessions[0].id;
    if (linkOpsChatStore.activeId && !linkOpsChatStore.sessions.some(s => s.id === linkOpsChatStore.activeId)) {
      linkOpsChatStore.activeId = linkOpsChatStore.sessions[0]?.id || '';
    }
    linkOpsChatStore.ready = true;
    linkOpsChatStore.error = '';
  } catch (err) {
    linkOpsChatStore.ready = true;
    linkOpsChatStore.error = err?.message || String(err || 'unknown');
  }
  if ((state.tab || '') === 'linkops') renderAll();
}
function activeLinkOpsSession(){
  return (linkOpsChatStore.sessions || []).find(s => String(s.id || '') === String(linkOpsChatStore.activeId || '')) || null;
}
async function sendLinkOpsChatMessage(){
  const input = document.getElementById('linkOpsChatInput');
  const message = String(input?.value || '').trim();
  if (!message) return showToast('先输入一条会话消息');
  if (actionStateStore.mode !== 'service') return showToast('当前不是网页服务模式，不能创建会话');
  const now = new Date().toISOString();
  const localId = linkOpsChatStore.activeId || ('local_' + Date.now());
  const localMsg = {id:'local_msg_' + Date.now(), role:'user', content:message, at:now};
  if (linkOpsChatStore.activeId) {
    linkOpsChatStore.sessions = (linkOpsChatStore.sessions || []).map(s => String(s.id || '') === String(linkOpsChatStore.activeId)
      ? {...s, updatedAt:now, messages:[...(Array.isArray(s.messages) ? s.messages : []), localMsg]}
      : s);
  } else {
    linkOpsChatStore.activeId = localId;
    linkOpsChatStore.sessions = [{
      id: localId,
      status: 'sending',
      title: message.slice(0,80),
      createdAt: now,
      updatedAt: now,
      messages: [localMsg],
    }, ...(linkOpsChatStore.sessions || [])];
  }
  if (input) input.value = '';
  opsAgentStore.busy = true;
  opsAgentStore.error = '';
  renderAll();
  try {
    const body = {message, sessionId: localId.startsWith('local_') ? '' : localId};
    const res = await fetch(LINK_OPS_CHATS_API, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body)
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload.ok) throw new Error(payload.error || ('HTTP ' + res.status));
    linkOpsChatStore.sessions = Array.isArray(payload?.data?.sessions) ? payload.data.sessions : [];
    linkOpsChatStore.activeId = payload?.session?.id || linkOpsChatStore.activeId;
    if (input) input.value = '';
    showToast('会话已更新');
  } catch (err) {
    opsAgentStore.error = err?.message || String(err || 'unknown');
    showToast('会话发送失败：' + opsAgentStore.error);
  } finally {
    opsAgentStore.busy = false;
    renderAll();
  }
}
async function deleteLinkOpsChatSession(id){
  if (!id) return;
  if (String(id).startsWith('local_')) {
    linkOpsChatStore.sessions = (linkOpsChatStore.sessions || []).filter(s => String(s.id || '') !== String(id));
    if (linkOpsChatStore.activeId === id) linkOpsChatStore.activeId = linkOpsChatStore.sessions[0]?.id || '';
    renderAll();
    return;
  }
  if (!confirm('确定删除这个会话？已经进入任务池的任务不会被删除。')) return;
  try {
    const res = await fetch(LINK_OPS_CHATS_API + '?id=' + encodeURIComponent(id), {method:'DELETE'});
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload.ok) throw new Error(payload.error || ('HTTP ' + res.status));
    linkOpsChatStore.sessions = Array.isArray(payload?.data?.sessions) ? payload.data.sessions : [];
    if (linkOpsChatStore.activeId === id) linkOpsChatStore.activeId = linkOpsChatStore.sessions[0]?.id || '';
    showToast('会话已删除');
    renderAll();
  } catch (err) {
    showToast('删除会话失败：' + (err?.message || String(err || 'unknown')));
  }
}
async function newLinkOpsChatFromPrompt(promptText = ''){
  linkOpsChatStore.activeId = '';
  renderAll();
  const input = document.getElementById('linkOpsChatInput');
  if (input) {
    input.value = promptText;
    input.focus();
  }
}
async function convertChatToTask(){
  const session = activeLinkOpsSession();
  if (!session) return showToast('先选择一个会话');
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
  const command = (session.title || messages.find(m => m.role === 'user')?.content || '').trim();
  if (!command) return showToast('这个会话还没有可沉淀的任务内容');
  try {
    const res = await fetch(LINK_OPS_TASKS_API, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        command,
        chatSessionId: session.id,
        targets: session.targets || {},
        agentAnswer: lastAssistant?.content || '',
        agentMode: lastAssistant?.meta?.mode || 'readonly-codex-gateway',
        agentDurationMs: lastAssistant?.meta?.durationMs || 0,
      })
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload.ok) throw new Error(payload.error || ('HTTP ' + res.status));
    linkOpsStore.tasks = Array.isArray(payload?.data?.tasks) ? payload.data.tasks : [];
    await fetch(LINK_OPS_CHATS_API, {
      method:'PATCH',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({id: session.id, status:'task_created'})
    }).catch(() => null);
    showToast('已进入任务池');
    refreshLinkOpsChats();
    renderAll();
  } catch (err) {
    showToast('进入任务池失败：' + (err?.message || String(err || 'unknown')));
  }
}
function recommendedLinkOpsPrompts(){
  const actions = (DATA.actions || []).slice().sort((a,b)=>Number(b.score || b.priority_score || 0)-Number(a.score || a.priority_score || 0));
  const prompts = [];
  const weak = actions.find(a => /弱|重复|承接|下架|归档/.test(String(a.category || '') + String(a.next_step || '') + String(a.reason || '')));
  if (weak) prompts.push({
    title:(weak.store_key || '重点店')+' · '+(weak.standard_goods_sn || weak.skc || '弱链接'),
    text:'针对 '+(weak.store_key || '该店')+' 店 '+(weak.standard_goods_sn || weak.skc || '这个货号')+'：先复盘当前弱链接表现，判断是换主图/改标题/补新链接，还是等待替代链接后再下架。请给出具体链接处理顺序和7天复盘标准。',
    reason:'动作池高优先级：'+String(weak.category || weak.reason || weak.next_step || '').slice(0,50),
  });
  const matrixRows = (DATA.matrix || []).filter(r => r.need_supplement_link && r.standard_goods_sn);
  const matrix = matrixRows.sort((a,b)=>Number(b.sales_sar || 0)-Number(a.sales_sar || 0))[0];
  if (matrix) prompts.push({
    title:(matrix.standard_goods_sn || '重点货号')+' · 补覆盖',
    text:'围绕 '+matrix.standard_goods_sn+' 做补覆盖：列出哪些店完全缺链接、哪些店只有待上架、哪些店已有可复制参考 SKC；优先给 '+(matrix.store_key || '缺口店')+' 店制定补链/催上架动作。',
    reason:'覆盖矩阵显示 '+(matrix.store_key || '某店')+' 需要补承接',
  });
  const link = (DATA.storeLinks || DATA.links || [])
    .filter(r => Number(r.c30_sale_cnt || 0) === 0 && Number(r.c30_eps_uv || r.eps_uv || 0) > 3000)
    .sort((a,b)=>Number(b.c30_eps_uv || b.eps_uv || 0)-Number(a.c30_eps_uv || a.eps_uv || 0))[0];
  if (link) prompts.push({
    title:(link.store_key || '店铺')+' · 高曝光0单',
    text:'复盘 '+(link.store_key || '')+' 店 '+(link.standard_goods_sn || link.skc || '')+'：30天曝光 '+num(link.c30_eps_uv || link.eps_uv)+'、销量0。请判断优先改主图、标题、价格、活动，还是重发新链接，并给出具体执行顺序。',
    reason:'链接表现：高曝光但30天0单',
  });
  const wait = (DATA.storeLinks || DATA.links || []).find(r => isWaitShelfLink(r) && (r.standard_goods_sn || r.skc));
  if (wait) prompts.push({
    title:(wait.store_key || '店铺')+' · 待上架卡点',
    text:'检查 '+(wait.store_key || '')+' 店 '+(wait.standard_goods_sn || wait.skc || '')+' 的待上架链接，判断缺证书、缺资质、缺资料还是审核/计划上架问题，并列出该补什么。',
    reason:'链接仓库存在待上架链接',
  });
  prompts.push({
    title:'今日 Top5 链接动作',
    text:'根据当前 BI 数据，列出今天最值得处理的5个链接管理任务。每条都要具体到店铺、货号、问题链接/参考链接、建议动作、预期收益和风险。',
    reason:'综合销售、覆盖和动作池',
  });
  return prompts.slice(0, 4);
}
async function submitLinkOpsCommand(){
  const input = document.getElementById('linkOpsCommand');
  const command = String(input?.value || '').trim();
  if (!command) return showToast('请先输入运营指令');
  if (actionStateStore.mode !== 'service') return showToast('当前不是网页服务模式，不能写入云端任务池');
  opsAgentStore.busy = true;
  opsAgentStore.error = '';
  opsAgentStore.answer = '';
  opsAgentStore.lastQuestion = command;
  opsAgentStore.durationMs = 0;
  renderAll();
  try {
    const askRes = await fetch(OPS_AGENT_ASK_API, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({question: command})
    });
    const askPayload = await askRes.json().catch(() => ({}));
    if (!askRes.ok || !askPayload.ok) throw new Error(askPayload.error || ('HTTP ' + askRes.status));
    opsAgentStore.answer = String(askPayload.answer || '');
    opsAgentStore.durationMs = Number(askPayload.durationMs || 0);
  } catch (err) {
    opsAgentStore.error = err?.message || String(err || 'unknown');
  } finally {
    opsAgentStore.busy = false;
  }
  try {
    const res = await fetch(LINK_OPS_TASKS_API, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        command,
        agentAnswer: opsAgentStore.answer || '',
        agentMode: opsAgentStore.answer ? 'readonly-codex-gateway' : '',
        agentDurationMs: opsAgentStore.durationMs || 0
      })
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload.ok) throw new Error(payload.error || ('HTTP ' + res.status));
    linkOpsStore.tasks = Array.isArray(payload?.data?.tasks) ? payload.data.tasks : [];
    linkOpsStore.ready = true;
    linkOpsStore.error = '';
    if (input) input.value = '';
    showToast(opsAgentStore.answer ? '已生成智能体回答和任务草案' : '已生成任务草案，智能体回答失败');
    renderAll();
  } catch (err) {
    showToast('提交失败：' + (err?.message || String(err || 'unknown')));
    renderAll();
  }
}
function splitAgentAnswer(text){
  const raw = String(text || '').trim();
  if (!raw) return [];
  const nl = String.fromCharCode(10);
  const normalized = raw.split(String.fromCharCode(13)).join('').split('；').join('；'+nl).replace(/。(?=补|下|换|优|关|可|数|原|下|如果|建议|需|当前)/g, '。'+nl);
  const parts = normalized.split(nl).map(x => x.trim()).filter(Boolean);
  const groups = [
    {title:'结论', match:/^(结论|总体|建议|当前)/, items:[]},
    {title:'关键依据', match:/(数据|关键|曝光|UV|销量|订单|销售|覆盖|链接|店铺)/, items:[]},
    {title:'建议动作', match:/(换图|补|下架|优化|催|新链接|观察|确认|推进|复盘)/, items:[]},
    {title:'风险与边界', match:/(风险|人工|不要|不建议|等待|只读|不能|确认)/, items:[]},
  ];
  for (const part of parts) {
    let placed = false;
    for (const g of groups) {
      if (g.match.test(part)) {
        g.items.push(part);
        placed = true;
        break;
      }
    }
    if (!placed) groups[1].items.push(part);
  }
  return groups.filter(g => g.items.length);
}
function renderAgentAnswerCards(text){
  const groups = splitAgentAnswer(text);
  if (!groups.length) return '';
  return '<div class="agent-answer-grid">'+groups.map(g =>
    '<div class="agent-answer-card"><h4>'+escapeHtml(g.title)+'</h4>'+
    (g.items.length === 1 ? '<p>'+escapeHtml(g.items[0])+'</p>' : '<ul>'+g.items.slice(0,8).map(x => '<li>'+escapeHtml(x)+'</li>').join('')+'</ul>')+
    '</div>'
  ).join('')+'</div>';
}
function linkOpsStatusLabel(status){
  return ({
    draft:'草案',
    confirmed:'待开始',
    in_progress:'执行中',
    waiting_review:'待复核',
    done:'已完成',
    archived:'已归档',
  })[status] || status || '草案';
}
function linkOpsStatusClass(status){
  if (status === 'done') return 'good';
  if (status === 'in_progress' || status === 'waiting_review') return 'mid';
  if (status === 'archived') return 'info';
  return 'info';
}
async function patchLinkOpsTask(id, patch, successText){
  if (!id) return;
  if (actionStateStore.mode !== 'service') return showToast('当前不是网页服务模式，不能更新任务');
  try {
    const res = await fetch(LINK_OPS_TASKS_API, {
      method:'PATCH',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({id, ...patch})
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload.ok) throw new Error(payload.error || ('HTTP ' + res.status));
    linkOpsStore.tasks = Array.isArray(payload?.data?.tasks) ? payload.data.tasks : [];
    showToast(successText || '任务已更新');
    renderAll();
  } catch (err) {
    showToast('任务更新失败：' + (err?.message || String(err || 'unknown')));
  }
}
function linkOpsGuessMime(file){
  const name = String(file?.name || '').toLowerCase();
  const type = String(file?.type || '').toLowerCase();
  if (type) return type;
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.webp')) return 'image/webp';
  if (name.endsWith('.pdf')) return 'application/pdf';
  if (name.endsWith('.csv')) return 'text/csv';
  if (name.endsWith('.json')) return 'application/json';
  if (name.endsWith('.txt')) return 'text/plain';
  return 'application/octet-stream';
}
function linkOpsHumanBytes(bytes){
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return '0B';
  if (n < 1024) return Math.round(n)+'B';
  if (n < 1024*1024) return (n/1024).toFixed(1)+'KB';
  return (n/1024/1024).toFixed(1)+'MB';
}
function readFileAsBase64(file){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',').pop() || '');
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}
async function uploadLinkOpsAssets(id){
  if (!id) return;
  if (actionStateStore.mode !== 'service') return showToast('当前不是网页服务模式，不能上传素材');
  const input = Array.from(document.querySelectorAll('[data-linkops-asset-input]')).find(el => el.dataset.linkopsAssetInput === id);
  const files = Array.from(input?.files || []);
  if (!files.length) return showToast('请先选择要上传的素材文件');
  if (files.length > 20) return showToast('一次最多上传 20 个文件');
  const total = files.reduce((s,f)=>s+Number(f.size || 0),0);
  if (files.some(f => Number(f.size || 0) > 10*1024*1024)) return showToast('单个文件不能超过 10MB');
  if (total > 30*1024*1024) return showToast('单次上传总大小不能超过 30MB');
  showToast('正在上传素材...');
  try {
    const encoded = [];
    for (const file of files) {
      encoded.push({
        name: file.name,
        type: linkOpsGuessMime(file),
        size: file.size,
        dataBase64: await readFileAsBase64(file),
      });
    }
    const res = await fetch(LINK_OPS_ASSETS_API, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({taskId:id, files:encoded})
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload.ok) throw new Error(payload.error || ('HTTP ' + res.status));
    linkOpsStore.tasks = Array.isArray(payload?.data?.tasks) ? payload.data.tasks : [];
    if (input) input.value = '';
    showToast('素材已上传到云端任务包');
    renderAll();
  } catch (err) {
    showToast('素材上传失败：' + (err?.message || String(err || 'unknown')));
  }
}
async function startLinkOpsExecutor(id){
  if (!id) return;
  if (actionStateStore.mode !== 'service') return showToast('当前不是网页服务模式，不能启动执行器');
  showToast('正在做执行前检查...');
  try {
    const res = await fetch(LINK_OPS_EXECUTE_API, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({id})
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload.ok) throw new Error(payload.error || ('HTTP ' + res.status));
    linkOpsStore.tasks = Array.isArray(payload?.data?.tasks) ? payload.data.tasks : [];
    const state = payload?.execution?.state || '';
    showToast(state === 'blocked' ? '执行器未启动：请先补齐材料' : '执行器已完成前置检查');
    renderAll();
  } catch (err) {
    showToast('执行器启动失败：' + (err?.message || String(err || 'unknown')));
  }
}
async function deleteLinkOpsTask(id){
  if (!id) return;
  if (!confirm('确定删除这个任务？删除后只能从审计日志追溯。')) return;
  try {
    const res = await fetch(LINK_OPS_TASKS_API + '?id=' + encodeURIComponent(id), {method:'DELETE'});
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload.ok) throw new Error(payload.error || ('HTTP ' + res.status));
    linkOpsStore.tasks = Array.isArray(payload?.data?.tasks) ? payload.data.tasks : [];
    showToast('任务已删除');
    renderAll();
  } catch (err) {
    showToast('删除失败：' + (err?.message || String(err || 'unknown')));
  }
}
async function updateActionStatus(key, status){
  const before = {...actionState};
  const prev = actionState[key] || {};
  const next = {
    status,
    owner: String(prev.owner || ''),
    note: String(prev.note || ''),
    updatedAt: new Date().toISOString()
  };
  if (status === 'open' && !next.owner && !next.note) delete actionState[key];
  else actionState[key] = next;
  saveActionState(actionState);
  renderAll();
  if (actionStateStore.mode === 'service') {
    try {
      const res = await fetch(ACTION_STATE_API, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({key, status, owner: next.owner, note: next.note})
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const payload = await res.json();
      actionState = normalizeActionState(payload.data || payload);
      saveActionState(actionState);
      actionStateStore.ready = true;
      actionStateStore.error = '';
      showToast('\u5df2\u4fdd\u5b58\u5230\u7f51\u9875\u670d\u52a1\uff1a' + statusLabel(status));
      renderAll();
      return;
    } catch (err) {
      actionState = before;
      saveActionState(actionState);
      actionStateStore.error = err?.message || String(err || 'unknown');
      showToast('\u670d\u52a1\u4fdd\u5b58\u5931\u8d25\uff0c\u5df2\u64a4\u56de');
      renderAll();
      return;
    }
  }
  showToast('\u5df2\u4fdd\u5b58\u5230\u5f53\u524d\u6d4f\u89c8\u5668\uff1a' + statusLabel(status));
}
async function updateActionMeta(key, patch){
  const before = {...actionState};
  const prev = actionState[key] || {};
  const next = {
    status: prev.status || 'open',
    owner: patch.owner != null ? String(patch.owner || '').trim().slice(0,80) : String(prev.owner || ''),
    note: patch.note != null ? String(patch.note || '').trim().slice(0,500) : String(prev.note || ''),
    updatedAt: new Date().toISOString()
  };
  if (next.status === 'open' && !next.owner && !next.note) delete actionState[key];
  else actionState[key] = next;
  saveActionState(actionState);
  renderAll();
  if (actionStateStore.mode === 'service') {
    try {
      const res = await fetch(ACTION_STATE_API, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({key, status: next.status, owner: next.owner, note: next.note})
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const payload = await res.json();
      actionState = normalizeActionState(payload.data || payload);
      saveActionState(actionState);
      actionStateStore.ready = true;
      actionStateStore.error = '';
      showToast('备注已保存到网页服务');
      renderAll();
      return;
    } catch (err) {
      actionState = before;
      saveActionState(actionState);
      actionStateStore.error = err?.message || String(err || 'unknown');
      showToast('备注保存失败，已撤回');
      renderAll();
      return;
    }
  }
  showToast('备注已保存到当前浏览器');
}
function mergeNote(oldNote, addition){
  const oldText = String(oldNote || '').trim();
  const addText = String(addition || '').trim();
  if (!addText) return oldText;
  if (!oldText) return addText.slice(0, 500);
  if (oldText.includes(addText)) return oldText.slice(0, 500);
  return (oldText + '；' + addText).slice(0, 500);
}
function actionPatchItem(key, patch = {}, now = new Date().toISOString()){
  const prev = actionState[key] || {};
  const next = {
    status: patch.status != null ? patch.status : (prev.status || 'open'),
    owner: patch.owner != null ? String(patch.owner || '').trim().slice(0,80) : String(prev.owner || ''),
    note: patch.note != null ? String(patch.note || '').trim().slice(0,500) : mergeNote(prev.note || '', patch.noteAppend || ''),
    updatedAt: now
  };
  if (!['open','done','review','ignored'].includes(next.status)) next.status = 'open';
  return next;
}
function applyActionPatchItems(items){
  for (const item of items) {
    if (!item?.key) continue;
    const next = {
      status: item.status || 'open',
      owner: String(item.owner || '').trim().slice(0,80),
      note: String(item.note || '').trim().slice(0,500),
      updatedAt: item.updatedAt || new Date().toISOString()
    };
    if (next.status === 'open' && !next.owner && !next.note) delete actionState[item.key];
    else actionState[item.key] = next;
  }
}
async function updateActionBatch(items, label){
  if (!items.length) return showToast('当前筛选没有可批量处理的动作');
  const before = {...actionState};
  applyActionPatchItems(items);
  saveActionState(actionState);
  renderAll();
  if (actionStateStore.mode === 'service') {
    try {
      const res = await fetch(ACTION_STATE_API, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({actions: items})
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const payload = await res.json();
      actionState = normalizeActionState(payload.data || payload);
      saveActionState(actionState);
      actionStateStore.ready = true;
      actionStateStore.error = '';
      showToast(label + '，已保存到网页服务');
      renderAll();
      return;
    } catch (err) {
      actionState = before;
      saveActionState(actionState);
      actionStateStore.error = err?.message || String(err || 'unknown');
      showToast('批量保存失败，已撤回');
      renderAll();
      return;
    }
  }
  showToast(label + '，已保存到当前浏览器');
}
function escapeHtml(s){
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function riskLevel(score){
  const s = Number(score || 0);
  if (s >= 160) return 'high';
  if (s >= 90) return 'mid';
  return 'good';
}
function riskTag(score){
  const level = riskLevel(score);
  const label = level === 'high' ? '高风险' : level === 'mid' ? '关注' : '稳定';
  return '<span class="tag '+level+'">'+label+'</span>';
}
function priorityTag(p){
  const v = String(p || '-');
  const cls = v.includes('高') ? 'high' : v.includes('中') ? 'mid' : 'good';
  return '<span class="tag '+cls+'">'+v+'</span>';
}
function domainName(d){
  return ({link:'链接', inventory:'库存', quality:'质量', after_sales:'售后', finance:'财务', business:'经营'}[d] || d || '-');
}
function actionKey(a){
  if (a?._actionKey) return a._actionKey;
  return [a.date || '', a.store_key || '', a.action_domain || '', a.category || '', a.standard_goods_sn || '', a.skc || ''].join('|');
}
function actionMergeKey(a){
  if (a?.skc) return [a.date || '', a.store_key || '', a.action_domain || '', a.standard_goods_sn || '', a.skc || ''].join('|');
  return actionKey(a);
}
function uniqueCompact(values){
  return [...new Set((values || []).map(x => String(x || '').trim()).filter(Boolean))];
}
function actionPriorityScore(priority){
  const p = String(priority || '');
  if (p.includes('高') || /high/i.test(p)) return 3;
  if (p.includes('中') || /mid|medium/i.test(p)) return 2;
  if (p.includes('低') || /low/i.test(p)) return 1;
  return 0;
}
function mergedPriority(rows){
  const best = [...(rows || [])].sort((a,b)=>actionPriorityScore(b.priority)-actionPriorityScore(a.priority))[0];
  return best?.priority || rows?.[0]?.priority || '';
}
function mergeActionGroup(rows){
  const sorted = [...(rows || [])].sort((a,b)=>Number(b.score||0)-Number(a.score||0));
  const primary = sorted[0] || {};
  if (sorted.length <= 1) return primary;
  const merged = {...primary};
  merged._actionKey = actionMergeKey(primary);
  merged._mergedActions = sorted;
  merged._mergedCount = sorted.length;
  merged.score = Math.max(...sorted.map(x => Number(x.score || 0)));
  merged.priority = mergedPriority(sorted);
  merged.category = uniqueCompact(sorted.map(x => x.category || x.title)).join(' / ') || primary.category || primary.title || '';
  merged.reason = uniqueCompact(sorted.map(x => x.reason)).join('；') || primary.reason || '';
  merged.evidence = uniqueCompact(sorted.map(x => actionEvidenceText(x) || x.evidence)).join('；') || primary.evidence || '';
  merged.next_step = uniqueCompact(sorted.map(x => x.next_step)).join('；') || primary.next_step || '';
  return merged;
}
function mergeActionsBySkuDomain(rows){
  const map = new Map();
  for (const a of rows || []) {
    const key = actionMergeKey(a);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(a);
  }
  return [...map.values()].map(mergeActionGroup).sort((a,b)=>Number(b.score||0)-Number(a.score||0));
}
function insightKey(x){
  return [x.title || '', x.store_key || '', x.standard_goods_sn || '', x.skc || '', String(x.evidence || '').slice(0,80)].join('|');
}
function insightType(x){
  const title = String(x.title || x.evidence || '');
  const d = String(x.action_domain || x.insight_domain || '');
  if (d === 'finance' || /财务|收入|在途/.test(title)) return 'finance';
  if (d === 'link' || /链接|下架|曝光|支付|点击|上架/.test(title)) return 'link';
  if (d === 'inventory' || /库存/.test(title)) return 'inventory';
  if (d === 'after_sales' || /售后|退货/.test(title)) return 'after_sales';
  if (d === 'quality' || /质量|评价|低星/.test(title)) return 'quality';
  if (x.insight_domain === 'fulfillment' || /履约|面单|包裹|物流/.test(title)) return 'fulfillment';
  if (x.insight_domain === 'marketing' || /营销|活动/.test(title)) return 'marketing';
  return 'business';
}
function actionStatus(a){
  return actionRecord(a).status || 'open';
}
function actionRecord(a){
  const direct = actionState[actionKey(a)];
  if (direct) return direct;
  if (Array.isArray(a?._mergedActions)) {
    const recs = a._mergedActions.map(x => actionState[actionKey(x)]).filter(Boolean);
    if (recs.length) {
      const picked = recs.find(x => x.status && x.status !== 'open') || recs[0];
      return {...picked, owner: picked.owner || '', note: picked.note || ''};
    }
  }
  return {status:'open', owner:'', note:''};
}
function actionStateSummary(){
  const entries = Object.entries(actionState || {});
  const counts = {tracked: entries.length, done: 0, review: 0, ignored: 0, open: 0, withOwner: 0, withNote: 0};
  const owners = new Map();
  let lastUpdated = '';
  for (const [, rec] of entries) {
    const status = rec?.status || 'open';
    counts[status] = (counts[status] || 0) + 1;
    if (rec?.owner) {
      counts.withOwner++;
      owners.set(rec.owner, (owners.get(rec.owner) || 0) + 1);
    }
    if (rec?.note) counts.withNote++;
    if (rec?.updatedAt && rec.updatedAt > lastUpdated) lastUpdated = rec.updatedAt;
  }
  const topOwners = [...owners.entries()].sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0])).slice(0, 5);
  return {counts, topOwners, lastUpdated};
}
function actionStateExportPayload(){
  const rows = (DATA.actions || []).map(a => {
    const key = actionKey(a);
    const rec = actionState[key] || {};
    return {
      key,
      status: rec.status || 'open',
      owner: rec.owner || '',
      note: rec.note || '',
      state_updated_at: rec.updatedAt || '',
      date: a.date || '',
      store_key: a.store_key || '',
      action_domain: a.action_domain || '',
      category: a.category || '',
      priority: a.priority || '',
      score: a.score ?? '',
      standard_goods_sn: a.standard_goods_sn || '',
      skc: a.skc || '',
      reason: a.reason || '',
      evidence: actionEvidenceText(a) || '',
      next_step: a.next_step || ''
    };
  }).filter(x => x.status !== 'open' || x.owner || x.note);
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    portalGeneratedAt: DATA.generatedAt || '',
    dates: DATA.dates || {},
    summary: actionStateSummary(),
    rows
  };
}
function actionStateSummaryText(){
  const s = actionStateSummary();
  const c = s.counts;
  const owners = s.topOwners.map(([owner, n]) => owner + ' ' + n + ' 条').join('；') || '暂无';
  return [
    'SHEIN BI 动作协作摘要',
    '统计时间：' + new Date().toLocaleString('zh-CN'),
    '已追踪动作：' + num(c.tracked) + ' 条',
    '已处理：' + num(c.done) + '；待复查：' + num(c.review) + '；已忽略：' + num(c.ignored) + '；仅备注/负责人：' + num(c.open),
    '有负责人：' + num(c.withOwner) + '；有备注：' + num(c.withNote),
    '负责人分布：' + owners,
    '最近更新：' + (s.lastUpdated || '-')
  ].join('\\n');
}
function actionCommandText(a){
  const rec = actionRecord(a);
  return [
    'SHEIN 动作处理指令',
    '店铺：' + (a.store_key || '-'),
    '业务域：' + domainName(a.action_domain),
    '动作：' + (a.category || a.title || '-'),
    '优先级/分数：' + (a.priority || '-') + ' / ' + num(a.score),
    '货号：' + (a.standard_goods_sn || '-'),
    'SKC：' + (a.skc || '-'),
    '原因：' + (a.reason || '-'),
    '证据：' + (actionEvidenceText(a) || '-'),
    '下一步：' + (a.next_step || '-'),
    '当前状态：' + statusLabel(rec.status || 'open'),
    '负责人：' + (rec.owner || '-'),
    '备注：' + (rec.note || '-')
  ].join('\\n');
}
function focusActionTarget(a, target){
  if (!a) return;
  state.store = a.store_key || '';
  if (target === 'store') {
    state.q = '';
    jumpToTab('stores', {keepFilters:true});
  } else if (target === 'product') {
    state.q = a.standard_goods_sn || a.skc || '';
    jumpToTab('products', {keepFilters:true});
  } else {
    state.q = a.skc || a.standard_goods_sn || '';
    jumpToTab('links', {keepFilters:true});
  }
  safeSetValue('storeFilter', state.store);
  safeSetValue('q', state.q);
  renderAll();
}
function focusInsightTarget(x, target){
  if (!x) return;
  if (target === 'store') {
    state.store = x.store_key || '';
    state.q = '';
    jumpToTab('stores', {keepFilters:true});
  } else if (target === 'product') {
    state.store = x.store_key || '';
    state.q = x.standard_goods_sn || x.skc || '';
    jumpToTab('products', {keepFilters:true});
  } else if (target === 'link') {
    state.store = x.store_key || '';
    state.q = x.skc || x.standard_goods_sn || '';
    jumpToTab('links', {keepFilters:true});
  } else if (target === 'actions') {
    state.store = x.store_key || '';
    state.q = x.standard_goods_sn || x.skc || '';
    state.domain = x.action_domain === 'business' ? '' : (x.action_domain || '');
    jumpToTab('actions', {keepFilters:true});
  } else {
    state.store = x.store_key || '';
    state.q = x.standard_goods_sn || x.skc || '';
    jumpToTab('business', {keepFilters:true});
  }
  safeSetValue('storeFilter', state.store);
  safeSetValue('q', state.q);
  safeSetValue('domainFilter', state.domain);
  renderAll();
}
function downloadActionState(){
  const payload = actionStateExportPayload();
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type:'application/json;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
  a.href = url;
  a.download = 'shein-bi-action-state-' + stamp + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('已导出动作状态 JSON');
}
function downloadTextFile(filename, content, type='text/plain;charset=utf-8'){
  const blob = new Blob([content], {type});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function localFileStamp(){
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + '-' + pad(d.getHours()) + '-' + pad(d.getMinutes()) + '-' + pad(d.getSeconds());
}
function localTimeText(d = new Date()){
  try { return d.toLocaleString('zh-CN'); } catch { return String(d); }
}
function statusLabel(s){
  return ({open:'未处理', done:'已处理', review:'待复查', ignored:'已忽略'}[s] || '未处理');
}
function statusMatchAction(a){
  const activeStatus = actionStatusActive();
  if (!activeStatus) return true;
  return actionStatus(a) === activeStatus;
}
function focusDefs(){
  return [
    {key:'all', label:'全局作战池', hint:'全部精选动作'},
    {key:'supplement', label:'补链接', hint:'只看缺上架链接'},
    {key:'retire', label:'下架/替换', hint:'先替换再淘汰'},
    {key:'optimize', label:'优化承接', hint:'有流量但转化弱'},
    {key:'inventory', label:'库存', hint:'已上架且有销量'},
    {key:'after_sales', label:'售后', hint:'售后集中'},
    {key:'quality', label:'质量', hint:'低星/退货'},
    {key:'fulfillment', label:'履约', hint:'面单/物流异常'}
  ];
}
function focusMatchByKey(row, f){
  if (f === 'all') return true;
  const cat = String(row.category || row.title || row.reason || row.evidence || '');
  if (f === 'supplement') return row.action_domain === 'link' && /补链接|缺上架链接|缺链接/.test(cat);
  if (f === 'retire') return row.action_domain === 'link' && (row.retire_candidate || /下架|淘汰|替换/.test(cat));
  if (f === 'optimize') return row.action_domain === 'link' && /低支付|低点击|无销量|承接|优化|重复弱链接/.test(cat);
  if (f === 'inventory') return row.action_domain === 'inventory' || /库存/.test(cat);
  if (f === 'after_sales') return row.action_domain === 'after_sales' || /售后|退货/.test(cat);
  if (f === 'quality') return row.action_domain === 'quality' || /质量|评价|低星|差评/.test(cat);
  if (f === 'fulfillment') return row.action_domain === 'business' && /履约|面单|物流|包裹|取消/.test(cat);
  return true;
}
function focusMatch(row){
  return focusMatchByKey(row, actionFocusActive());
}
function riskMatch(row){
  const activeRisk = actionRiskActive();
  if (!activeRisk) return true;
  if (activeRisk === 'retire') return Boolean(row.retire_candidate || row.category?.includes('下架'));
  const score = Number(row.risk_score ?? row.score ?? row.max_action_score ?? 0);
  return riskLevel(score) === activeRisk;
}
function productMatch(row){
  const p = (state.product || '').trim().toLowerCase();
  if (!p) return true;
  return productQueryMatch(row, p);
}
function includes(row){
  if (!storeMatchesScope(row)) return false;
  const activeDomain = actionDomainActive();
  if (activeDomain && row.action_domain !== activeDomain) return false;
  if (!focusMatch(row)) return false;
  if (!riskMatch(row)) return false;
  if (!productMatch(row)) return false;
  const q = state.q.trim().toLowerCase();
  if (!q) return true;
  const qUpper = q.toUpperCase();
  if (STORE_CODES.has(qUpper) && !state.store) return row.store_key === qUpper;
  const rec = row && row.action_domain ? actionState[actionKey(row)] : null;
  const extra = rec ? (' ' + (rec.owner || '') + ' ' + (rec.note || '') + ' ' + statusLabel(rec.status || 'open')) : '';
  return (JSON.stringify(row) + extra).toLowerCase().includes(q);
}
function table(rows, cols, opts = {}){
  if(!rows.length) return '<div class="empty">没有匹配数据</div>';
  const limit = opts.limit === false ? rows.length : Number(opts.limit || 40);
  const visible = rows.slice(0, Math.max(1, limit));
  const clipped = rows.length > visible.length;
  const note = clipped
    ? '<div class="table-note">已显示前 '+num(visible.length)+' / 共 '+num(rows.length)+' 条。用店铺、货号、SKC 或业务域筛选可缩小范围；全量明细建议进 Metabase 深钻。</div>'
    : '';
  return '<div style="overflow:auto"><table><thead><tr>'+cols.map(c=>'<th class="'+(c[3]||'')+'">'+c[0]+'</th>').join('')+'</tr></thead><tbody>'+
    visible.map(r=>'<tr>'+cols.map(c=>'<td class="'+[c[2]||'', c[4]||''].filter(Boolean).join(' ')+'">'+c[1](r)+'</td>').join('')+'</tr>').join('')+
    '</tbody></table></div>'+note;
}
function compactTable(rows, cols, opts = {}){
  return table(rows, cols, {...opts, limit: opts.limit ?? 8});
}
function groupedTable(rows, baseCols, metricGroups, opts = {}){
  if(!rows.length) return '<div class="empty">没有匹配数据</div>';
  const limit = opts.limit === false ? rows.length : Number(opts.limit || 40);
  const visible = rows.slice(0, Math.max(1, limit));
  const clipped = rows.length > visible.length;
  const note = clipped
    ? '<div class="table-note">已显示前 '+num(visible.length)+' / 共 '+num(rows.length)+' 条。用店铺、货号、SKC 或业务域筛选可缩小范围；全量明细建议进 Metabase 深钻。</div>'
    : '';
  const baseHead = baseCols.map(c => '<th rowspan="2" class="'+(c[3]||'')+'">'+c[0]+'</th>').join('');
  const groupHead = metricGroups.map(g => '<th colspan="'+g.cols.length+'" class="metric-group-th">'+escapeHtml(g.title)+'</th>').join('');
  const subHead = metricGroups.flatMap(g => g.cols.map(c => '<th class="metric-sub-th">'+escapeHtml(c.label)+'</th>')).join('');
  const body = visible.map(r => '<tr>'+
    baseCols.map(c => '<td class="'+[c[2]||'', c[4]||''].filter(Boolean).join(' ')+'">'+c[1](r)+'</td>').join('')+
    metricGroups.flatMap(g => g.cols.map(c => '<td class="num metric-sub-cell">'+c.value(r)+'</td>')).join('')+
    '</tr>').join('');
  return '<div style="overflow:auto"><table class="grouped-table"><thead><tr>'+baseHead+groupHead+'</tr><tr>'+subHead+'</tr></thead><tbody>'+body+'</tbody></table></div>'+note;
}
function sectionTitleHtml(title, sub = '', tag = '', tagClass = 'info'){
  return '<div class="store-section-title full-bleed-title"><div><h3>'+escapeHtml(title)+'</h3>'+(sub ? '<div class="sub">'+escapeHtml(sub)+'</div>' : '')+'</div>'+(tag ? '<span class="tag '+tagClass+'">'+escapeHtml(tag)+'</span>' : '')+'</div>';
}
function detailBlockHtml(summary, body, open = false){
  return '<details class="detail-section" '+(open ? 'open' : '')+'><summary>'+escapeHtml(summary)+'</summary><div class="detail-body">'+body+'</div></details>';
}
function storePeriodSalesMap(){
  return new Map(aggregateDailyStores().map(x => [x.store_key, x]));
}
function productPeriodSalesMap(){
  return new Map(aggregateDailyProducts().map(x => [x.standard_goods_sn, x]));
}
function copyButton(value, label='复制'){
  if (!value) return '';
  return '<button class="copy" data-copy="'+String(value).replace(/"/g,'&quot;')+'">${svgIcon('copy')}'+label+'</button>';
}
function monthKey(dateText){
  return String(dateText || '').slice(0, 7);
}
function seriesForMonth(series, baseDate){
  const m = monthKey(baseDate);
  return (series || []).filter(x => monthKey(x.date || x.snapshot_date) === m);
}
function sumSeries(series, key){
  return (series || []).reduce((sum, x) => sum + Number(x?.[key] || 0), 0);
}
function aggregateRows(rows, keyFn, reducer){
  const map = new Map();
  for (const row of rows || []) {
    const key = keyFn(row);
    const acc = map.get(key) || {};
    reducer(acc, row);
    map.set(key, acc);
  }
  return Array.from(map.values());
}
function isoDate(d){
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}
function parseDateOnly(v){
  const s = String(v || '').slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}
function addDateDays(dateText, days){
  const d = parseDateOnly(dateText) || parseDateOnly(dataAnchorDate()) || new Date();
  d.setDate(d.getDate() + Number(days || 0));
  return isoDate(d);
}
function monthStart(dateText){
  const d = parseDateOnly(dateText) || new Date();
  return isoDate(new Date(d.getFullYear(), d.getMonth(), 1));
}
function monthEnd(dateText){
  const d = parseDateOnly(dateText) || new Date();
  return isoDate(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}
function addMonths(dateText, months){
  const d = parseDateOnly(dateText) || new Date();
  d.setMonth(d.getMonth() + Number(months || 0));
  return isoDate(d);
}
function dataAnchorDate(){
  const rows = DATA.rankings?.dailyStores || DATA.trend?.salesSeries || [];
  const dates = rows.map(x => String(x.date || '').slice(0, 10)).filter(Boolean).sort();
  return dates.at(-1) || DATA.dates?.salesDate || isoDate(new Date());
}
function calendarToday(){
  return isoDate(new Date());
}
function allDataDateRange(){
  const rows = DATA.rankings?.dailyStores || DATA.trend?.salesSeries || [];
  const dates = rows.map(x => String(x.date || '').slice(0, 10)).filter(Boolean).sort();
  const anchor = dataAnchorDate();
  return {min: dates[0] || anchor, max: dates.at(-1) || anchor};
}
function computePresetRange(preset, anchor = calendarToday()){
  const a = anchor || calendarToday();
  const dataA = dataAnchorDate();
  if (preset === 'latestData') return {start:dataA, end:dataA};
  if (preset === 'today') return {start:a, end:a};
  if (preset === 'yesterday') {
    const y = addDateDays(a, -1);
    return {start:y, end:y};
  }
  if (preset === 'last3') return {start:addDateDays(a, -2), end:a};
  if (preset === 'last7') return {start:addDateDays(a, -6), end:a};
  if (preset === 'last15') return {start:addDateDays(a, -14), end:a};
  if (preset === 'last30') return {start:addDateDays(a, -29), end:a};
  if (preset === 'thisMonth') return {start:monthStart(a), end:a};
  if (preset === 'lastMonth') {
    const d = parseDateOnly(a) || new Date();
    const y = d.getFullYear();
    const m = d.getMonth();
    return {start:isoDate(new Date(y, m - 1, 1)), end:isoDate(new Date(y, m, 0))};
  }
  if (preset === 'last3Months') return {start:addMonths(monthStart(a), -2), end:a};
  if (preset === 'lastYear') return {start:addDateDays(a, -364), end:a};
  return {start:addDateDays(a, -29), end:a};
}
function defaultChartRange(kind){
  const anchor = dataAnchorDate();
  if (kind === 'month') return {start:addMonths(monthStart(anchor), -5), end:anchor};
  return {start:addDateDays(anchor, -29), end:anchor};
}
function ensureDateRange(){
  const anchor = calendarToday();
  if ((!state.startDate || !state.endDate) && state.rangePreset) {
    const r = computePresetRange(state.rangePreset, anchor);
    state.startDate = state.startDate || r.start;
    state.endDate = state.endDate || r.end;
  }
  if (!state.startDate || !state.endDate) {
    const r = computePresetRange('today', anchor);
    state.startDate = r.start;
    state.endDate = r.end;
    state.rangePreset = state.rangePreset || 'today';
  }
  if (state.startDate > state.endDate) {
    const t = state.startDate;
    state.startDate = state.endDate;
    state.endDate = t;
  }
  return {start: state.startDate, end: state.endDate};
}
function selectedRangeText(){
  const r = ensureDateRange();
  return r.start === r.end ? r.end : r.start + ' 至 ' + r.end;
}
function inSelectedRange(row, key = 'date'){
  const r = ensureDateRange();
  const d = String(row?.[key] || '').slice(0, 10);
  return d && d >= r.start && d <= r.end;
}
function inSelectedRangeValue(value){
  const r = ensureDateRange();
  const d = String(value || '').slice(0, 10);
  return Boolean(d && d >= r.start && d <= r.end);
}
function firstDateValue(row, keys = []){
  for (const key of keys) {
    const d = String(row?.[key] || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  }
  return '';
}
function rowInSelectedRangeBy(row, keys = []){
  const d = firstDateValue(row, keys);
  return Boolean(d && inSelectedRangeValue(d));
}
function filterDailyRows(rows, key = 'date'){
  return (rows || []).filter(row => inSelectedRange(row, key));
}
function aggregateDailyStores(start = ensureDateRange().start, end = ensureDateRange().end){
  const map = new Map();
  for (const r of DATA.rankings?.dailyStores || []) {
    const d = String(r.date || '').slice(0, 10);
    if (!d || d < start || d > end) continue;
    const key = r.store_key || '-';
    const row = map.get(key) || {store_key:key, group_key:r.group_key || '', shop_name:r.shop_name || '', sales_sar:0, gross_sales_sar:0, orders:0, gross_orders:0, quantity:0, gross_quantity:0, daysSet:new Set()};
    row.group_key = row.group_key || r.group_key || '';
    row.shop_name = row.shop_name || r.shop_name || '';
    row.sales_sar += Number(r.sales_sar || 0);
    row.gross_sales_sar += Number(r.gross_sales_sar ?? r.sales_sar ?? 0);
    row.orders += Number(r.orders || 0);
    row.gross_orders += Number(r.gross_orders ?? r.orders ?? 0);
    row.quantity += Number(r.quantity || 0);
    row.gross_quantity += Number(r.gross_quantity ?? r.quantity ?? 0);
    row.daysSet.add(d);
    map.set(key, row);
  }
  return Array.from(map.values()).map(r => ({...r, sales_sar:Math.round(r.sales_sar * 100) / 100, gross_sales_sar:Math.round(r.gross_sales_sar * 100) / 100, days:r.daysSet.size, daysSet:undefined}));
}
function aggregateDailyProducts(start = ensureDateRange().start, end = ensureDateRange().end){
  const map = new Map();
  for (const r of DATA.rankings?.dailyProducts || []) {
    const d = String(r.date || '').slice(0, 10);
    if (!d || d < start || d > end) continue;
    const key = r.standard_goods_sn || '-';
    const row = map.get(key) || {standard_goods_sn:key, goods_title:r.goods_title || '', sales_sar:0, gross_sales_sar:0, quantity:0, gross_quantity:0, orders:0, gross_orders:0, store_count:0, daysSet:new Set()};
    row.goods_title = row.goods_title || r.goods_title || '';
    row.skc_list = [row.skc_list, r.skc_list].filter(Boolean).join(' ');
    row.sales_sar += Number(r.sales_sar || 0);
    row.gross_sales_sar += Number(r.gross_sales_sar ?? r.sales_sar ?? 0);
    row.quantity += Number(r.quantity || 0);
    row.gross_quantity += Number(r.gross_quantity ?? r.quantity ?? 0);
    row.orders += Number(r.orders || 0);
    row.gross_orders += Number(r.gross_orders ?? r.orders ?? 0);
    row.store_count = Math.max(Number(row.store_count || 0), Number(r.store_count || 0));
    row.daysSet.add(d);
    map.set(key, row);
  }
  return Array.from(map.values()).map(r => ({...r, sales_sar:Math.round(r.sales_sar * 100) / 100, gross_sales_sar:Math.round(r.gross_sales_sar * 100) / 100, days:r.daysSet.size, daysSet:undefined}));
}
function aggregateDailyProductGroups(start = ensureDateRange().start, end = ensureDateRange().end){
  const map = new Map();
  for (const r of DATA.rankings?.dailyProductGroups || []) {
    const d = String(r.date || '').slice(0, 10);
    if (!d || d < start || d > end) continue;
    const group = String(r.group_key || '').toUpperCase() || 'OTHER';
    const goods = r.standard_goods_sn || '-';
    const key = group + '|' + goods;
    const row = map.get(key) || {group_key:group, standard_goods_sn:goods, sales_sar:0, gross_sales_sar:0, quantity:0, gross_quantity:0, orders:0, gross_orders:0, store_count:0, daysSet:new Set()};
    row.skc_list = [row.skc_list, r.skc_list].filter(Boolean).join(' ');
    row.sales_sar += Number(r.sales_sar || 0);
    row.gross_sales_sar += Number(r.gross_sales_sar ?? r.sales_sar ?? 0);
    row.quantity += Number(r.quantity || 0);
    row.gross_quantity += Number(r.gross_quantity ?? r.quantity ?? 0);
    row.orders += Number(r.orders || 0);
    row.gross_orders += Number(r.gross_orders ?? r.orders ?? 0);
    row.store_count = Math.max(Number(row.store_count || 0), Number(r.store_count || 0));
    row.daysSet.add(d);
    map.set(key, row);
  }
  return Array.from(map.values()).map(r => ({...r, sales_sar:Math.round(r.sales_sar * 100) / 100, gross_sales_sar:Math.round(r.gross_sales_sar * 100) / 100, days:r.daysSet.size, daysSet:undefined}));
}
function productScopeQuery(){
  return String(state.product || '').trim().toLowerCase();
}
function isSkcLikeQuery(q){
  const s = String(q || '').trim().toLowerCase();
  if (!s) return false;
  if (/^s[a-z]\d{4,}/.test(s)) return true;
  return /^[a-z0-9]+$/.test(s) && /\d/.test(s) && s.length >= 8;
}
function isShortCodeQuery(q){
  const s = String(q || '').trim().toLowerCase();
  return /^[a-z0-9-]{1,7}$/.test(s) && /\d/.test(s);
}
function productQueryMatch(row, q = productScopeQuery()){
  if (!q) return true;
  const codeText = [
    row.standard_goods_sn,
    row.standard_goods_sn_list,
    row.goods_sn,
    row.goods_sn_list,
    row.supplier_goods_sn,
    row.product_sn,
    row.product_code,
    row.store_product_code,
    row.standardProductCode,
    row.raw_goods_sn,
    row.raw_goods_sn_list
  ].map(x => String(x || '')).join(' ').toLowerCase();
  if (codeText.includes(q)) return true;

  // 避免短数字/短编号（如 505）误命中 SKC 长编号中间片段；
  // 只有用户输入完整或较长 SKC 片段时，才把 SKC 字段纳入匹配。
  const skcText = [
    row.skc_list,
    row.skc,
    row.skc_code,
    row.sku_code,
    row.spu
  ].map(x => String(x || '')).join(' ').toLowerCase();
  if (isSkcLikeQuery(q) && skcText.includes(q)) return true;

  // 短数字常用于搜货号，不能扫商品标题里的规格数字；中文/长文本再搜标题和品名。
  if (!isShortCodeQuery(q)) {
    const nameText = [
      row.product_name,
      row.goods_title,
      row.goods_name,
      row.goodsName,
      row.title,
      row.name
    ].map(x => String(x || '')).join(' ').toLowerCase();
    if (nameText.includes(q)) return true;
  }
  return false;
}
function productDailyMatch(row){
  const q = productScopeQuery();
  return productQueryMatch(row, q);
}
function aggregateDailyStoreProducts(start = ensureDateRange().start, end = ensureDateRange().end, opts = {}){
  const map = new Map();
  for (const r of DATA.rankings?.dailyStoreProducts || []) {
    const d = String(r.date || '').slice(0, 10);
    if (!d || d < start || d > end) continue;
    if (opts.respectStore !== false && !storeMatchesScope(r)) continue;
    if (opts.respectProduct !== false && !productDailyMatch(r)) continue;
    const store = String(r.store_key || '-').toUpperCase();
    const goods = r.standard_goods_sn || '-';
    const key = (opts.groupBy || 'storeProduct') === 'store' ? store : (opts.groupBy || 'storeProduct') === 'product' ? goods : store + '|' + goods;
    const row = map.get(key) || {store_key:store, group_key:r.group_key || '', standard_goods_sn:goods, goods_title:r.goods_title || '', sales_sar:0, gross_sales_sar:0, quantity:0, gross_quantity:0, orders:0, gross_orders:0, storesSet:new Set(), productsSet:new Set(), daysSet:new Set()};
    row.group_key = row.group_key || r.group_key || '';
    row.goods_title = row.goods_title || r.goods_title || '';
    row.skc_list = [row.skc_list, r.skc_list].filter(Boolean).join(' ');
    row.sales_sar += Number(r.sales_sar || 0);
    row.gross_sales_sar += Number(r.gross_sales_sar ?? r.sales_sar ?? 0);
    row.quantity += Number(r.quantity || 0);
    row.gross_quantity += Number(r.gross_quantity ?? r.quantity ?? 0);
    row.orders += Number(r.orders || 0);
    row.gross_orders += Number(r.gross_orders ?? r.orders ?? 0);
    row.storesSet.add(store);
    row.productsSet.add(goods);
    row.daysSet.add(d);
    map.set(key, row);
  }
  return Array.from(map.values()).map(r => ({...r, sales_sar:Math.round(r.sales_sar * 100) / 100, gross_sales_sar:Math.round(r.gross_sales_sar * 100) / 100, store_count:r.storesSet.size, activeProducts:r.productsSet.size, days:r.daysSet.size, storesSet:undefined, productsSet:undefined, daysSet:undefined}));
}
function aggregateHomeStores(start = ensureDateRange().start, end = ensureDateRange().end){
  const hasProduct = Boolean(productScopeQuery());
  const rows = hasProduct
    ? aggregateDailyStoreProducts(start, end, {groupBy:'store'})
    : aggregateDailyStores(start, end).filter(r => storeMatchesScope(r));
  return rows.filter(r => storeMatchesScope(r));
}
function aggregateHomeProducts(start = ensureDateRange().start, end = ensureDateRange().end){
  const hasProduct = Boolean(productScopeQuery());
  const hasStore = storeFilterKind().type !== 'all';
  if (hasStore || hasProduct) {
    return aggregateDailyStoreProducts(start, end, {groupBy:'product'});
  }
  return aggregateDailyProducts(start, end);
}
function salesScopeSummary(){
  const k = DATA.kpi || {};
  const range = ensureDateRange();
  const rows = aggregateDailyStores(range.start, range.end);
  const series = DATA.trend?.salesSeries || [];
  const salesDate = DATA.dates?.salesDate || dataAnchorDate();
  const monthRows = aggregateDailyStores(monthStart(salesDate), salesDate);
  return {
    date: salesDate || '-',
    rangeStart: range.start,
    rangeEnd: range.end,
    rangeLabel: selectedRangeText(),
    rangeSalesSar: sumSeries(rows, salesAmountKey()),
    rangeOrders: sumSeries(rows, ordersKey()),
    rangeQuantity: sumSeries(rows, quantityKey()),
    rangeDays: new Set((DATA.rankings?.dailyStores || []).map(r => String(r.date || '').slice(0,10)).filter(d => d >= range.start && d <= range.end)).size,
    monthSalesSar: sumSeries(monthRows, salesAmountKey()) || Number(k.salesSar || 0),
    monthOrders: sumSeries(monthRows, ordersKey()) || Number(k.orders || 0),
    monthQuantity: sumSeries(monthRows, quantityKey()) || Number(k.quantity || 0),
    days: Math.max(1, new Set((DATA.rankings?.dailyStores || []).map(r => String(r.date || '').slice(0,10)).filter(d => d >= monthStart(salesDate) && d <= salesDate)).size || 1)
  };
}
function afterSalesScopeSummary(){
  const date = DATA.dates?.businessDate || DATA.dates?.salesDate || dataAnchorDate();
  const range = ensureDateRange();
  const dkey = afterSalesDateKey();
  const valid = r => String(r.order_sub_status_name || '').trim() !== '已取消';
  const dateOf = r => String(r[dkey] || r.request_time || r.snapshot_date || '').slice(0,10);
  const rows = (DATA.afterSales || []).filter(r => {
    const d = dateOf(r);
    return d && d >= range.start && d <= range.end && valid(r);
  });
  const todayRows = (DATA.afterSales || []).filter(r => dateOf(r) === date && valid(r));
  const monthRows = (DATA.afterSales || []).filter(r => {
    const d = dateOf(r);
    return d && d >= monthStart(date) && d <= date && valid(r);
  });
  const amount = arr => arr.reduce((sum,r)=>sum+Number(r.price_amount_total || 0),0);
  return {
    date: date || '-',
    sourceLabel: state.returnsMode === 'order' ? '按订单创建时间' : '按售后申请时间',
    todayCases: todayRows.length,
    todayAmountSar: amount(todayRows),
    rangeCases: rows.length,
    rangeAmountSar: amount(rows),
    monthCases: monthRows.length,
    monthAmountSar: amount(monthRows),
    days: Math.max(1, new Set(rows.map(dateOf).filter(Boolean)).size || 1)
  };
}
function afterSalesGroupScopeSummary(){
  const range = ensureDateRange();
  const rows = DATA.trend?.afterSalesGroupSeries || [];
  const map = new Map();
  for (const r of rows) {
    const d = String(r.date || '').slice(0, 10);
    if (!d || d < range.start || d > range.end) continue;
    const key = String(r.group_key || '').toUpperCase() || 'OTHER';
    const row = map.get(key) || {group_key:key, cases:0, amount_sar:0};
    row.cases += Number(r.case_count || 0);
    row.amount_sar += Number(r.amount_sar || 0);
    map.set(key, row);
  }
  if (!map.size) {
    for (const r of DATA.afterSales || []) {
      const d = String(r[afterSalesDateKey()] || r.request_time || r.snapshot_date || '').slice(0, 10);
      if (!d || d < range.start || d > range.end) continue;
      const key = storeGroupKey(r);
      const row = map.get(key) || {group_key:key, cases:0, amount_sar:0};
      row.cases += 1;
      row.amount_sar += Number(r.price_amount_total || 0);
      map.set(key, row);
    }
  }
  return map;
}
function homeScopeRows(){
  const scope = storeFilterKind();
  if (scope.type === 'group') return [{key:scope.key, label:groupMeta(scope.key).label, scopeValue:'GROUP:' + scope.key}];
  if (scope.type === 'store') return [{key:scope.key, label:scope.key, scopeValue:scope.key}];
  return [
    {key:'ALL', label:'总计', scopeValue:''},
    {key:'DSY', label:'DSY 组', scopeValue:'GROUP:DSY'},
    {key:'LGM', label:'LGM 组', scopeValue:'GROUP:LGM'}
  ];
}
function salesAmountKey(){ return state.salesMode === 'gross' ? 'gross_sales_sar' : 'sales_sar'; }
function quantityKey(){ return state.qtyMode === 'gross' ? 'gross_quantity' : 'quantity'; }
function ordersKey(){ return state.qtyMode === 'gross' ? 'gross_orders' : 'orders'; }
function profitValueKey(){ return state.profitMode === 'rtv' ? 'profitReceivedResellableSar' : 'profitSar'; }
function profitRowValueKey(){ return state.profitMode === 'rtv' ? 'profit_if_rtv_received_resellable_sar' : 'profit_before_storage_sar'; }
function afterSalesDateKey(){ return state.returnsMode === 'order' ? 'order_created_date' : 'request_time'; }
function metricModeToggle(key, items){
  const cur = state[key];
  return '<div class="trend-toggle metric-switch-row" data-mode-group="'+escapeHtml(key)+'">'+items.map(it =>
    '<button type="button" class="'+(cur === it.value ? 'active' : '')+'" data-metric-mode-key="'+escapeHtml(key)+'" data-metric-mode-value="'+escapeHtml(it.value)+'">'+escapeHtml(it.label)+'</button>'
  ).join('')+'</div>';
}
function homeSalesForScope(start, end, scopeValue = ''){
  const hasProduct = Boolean(productScopeQuery());
  const source = hasProduct ? (DATA.rankings?.dailyStoreProducts || []) : (DATA.rankings?.dailyStores || []);
  const row = {sales_sar:0, orders:0, quantity:0, daysSet:new Set()};
  for (const r of source) {
    const d = String(r.date || '').slice(0, 10);
    if (!d || d < start || d > end) continue;
    if (!storeMatchesScope(r, scopeValue)) continue;
    if (hasProduct && !productDailyMatch(r)) continue;
    row.sales_sar += Number(r[salesAmountKey()] ?? r.sales_sar ?? 0);
    row.orders += Number(r[ordersKey()] ?? r.orders ?? 0);
    row.quantity += Number(r[quantityKey()] ?? r.quantity ?? 0);
    row.daysSet.add(d);
  }
  return {...row, sales_sar:Math.round(row.sales_sar * 100) / 100, days:row.daysSet.size, daysSet:undefined};
}
function activeProductCountForScope(start, end, scopeValue = ''){
  const set = new Set();
  for (const r of DATA.rankings?.dailyStoreProducts || []) {
    const d = String(r.date || '').slice(0, 10);
    if (!d || d < start || d > end) continue;
    if (!storeMatchesScope(r, scopeValue)) continue;
    if (!productDailyMatch(r)) continue;
    if (Number(r[quantityKey()] ?? r.quantity ?? 0) > 0 && r.standard_goods_sn) set.add(r.standard_goods_sn);
  }
  return set.size;
}
function homeAfterSalesForScope(start, end, scopeValue = ''){
  const hasProduct = Boolean(productScopeQuery());
  if (state.returnsMode === 'order') {
    const source = hasProduct ? (DATA.rankings?.dailyStoreProducts || []) : (DATA.rankings?.dailyStores || []);
    const out = {cases:0, amount_sar:0};
    for (const r of source) {
      const d = String(r.date || '').slice(0, 10);
      if (!d || d < start || d > end) continue;
      if (!storeMatchesScope(r, scopeValue)) continue;
      if (hasProduct && !productDailyMatch(r)) continue;
      out.cases += Math.max(0, Number(r.gross_orders ?? r.orders ?? 0) - Number(r.orders || 0));
      out.amount_sar += Math.max(0, Number(r.gross_sales_sar ?? r.sales_sar ?? 0) - Number(r.sales_sar || 0));
    }
    return {cases:out.cases, amount_sar:Math.round(out.amount_sar * 100) / 100};
  }
  const detailRows = (DATA.afterSales || []).filter(r => {
    const d = String(r.request_time || r.snapshot_date || '').slice(0, 10);
    if (!d || d < start || d > end) return false;
    if (String(r.order_sub_status_name || '').trim() === '已取消') return false;
    if (!storeMatchesScope(r, scopeValue)) return false;
    if (hasProduct && !productMatch(r)) return false;
    return true;
  });
  return {
    cases: detailRows.length,
    amount_sar: detailRows.reduce((sum, r) => sum + Number(r.price_amount_total || r.amount_sar || r.refund_amount || 0), 0)
  };
}
function profitDailyRows(start, end, scopeValue = state.store, respectProduct = true){
  const q = productScopeQuery();
  return (DATA.profit?.dailyStoreProducts || []).filter(r => {
    const d = String(r.date || '').slice(0, 10);
    if (!d || d < start || d > end) return false;
    if (!storeMatchesScope(r, scopeValue)) return false;
    if (respectProduct && q && !productQueryMatch(r, q)) return false;
    return true;
  });
}
function profitSummaryForRows(rows){
  const out = {
    grossRevenueSar:0,
    netRevenueSar:0,
    productCostSar:0,
    returnFeeSar:0,
    rtvRecoverableCostSar:0,
    rtv09RecoverableCostSar:0,
    rtvReceivedQuantity:0,
    rtvReceivedTo09Quantity:0,
    profitSar:0,
    profitReceivedResellableSar:0,
    profit09ResellableSar:0,
    knownGrossRevenueSar:0,
    missingCostRevenueSar:0,
    missingCostQuantity:0,
    missingCostLines:0,
    reversalLines:0,
    orders:0,
    quantity:0
  };
  for (const r of rows || []) {
    out.grossRevenueSar += Number(r.gross_revenue_sar || 0);
    out.netRevenueSar += Number(r.net_revenue_sar || 0);
    out.productCostSar += Number(r.product_cost_sar || 0);
    out.returnFeeSar += Number(r.return_delivery_fee_sar || 0);
    out.rtvRecoverableCostSar += Number(r.rtv_recoverable_cost_sar || 0);
    out.rtv09RecoverableCostSar += Number(r.rtv_09_recoverable_cost_sar || 0);
    out.rtvReceivedQuantity += Number(r.rtv_received_quantity || 0);
    out.rtvReceivedTo09Quantity += Number(r.rtv_received_to_09_quantity || 0);
    out.profitSar += Number(r.profit_before_storage_sar || 0);
    out.profitReceivedResellableSar += Number(r.profit_if_rtv_received_resellable_sar ?? r.profit_before_storage_sar ?? 0);
    out.profit09ResellableSar += Number(r.profit_if_rtv_09_resellable_sar ?? r.profit_before_storage_sar ?? 0);
    out.knownGrossRevenueSar += Number(r.known_net_revenue_sar ?? r.known_gross_revenue_sar ?? 0);
    out.missingCostRevenueSar += Number(r.missing_cost_revenue_sar || 0);
    out.missingCostQuantity += Number(r.missing_cost_quantity || 0);
    out.missingCostLines += Number(r.missing_cost_lines || 0);
    out.reversalLines += Number(r.reversal_lines || 0);
    out.orders += Number(r.orders || 0);
    out.quantity += Number(r.quantity || 0);
  }
  out.costCoverageRate = out.netRevenueSar > 0 ? out.knownGrossRevenueSar / out.netRevenueSar : null;
  out.margin = out.netRevenueSar > 0 && out.knownGrossRevenueSar > 0 ? out.profitSar / out.netRevenueSar : null;
  out.hasAnyCost = out.knownGrossRevenueSar > 0 || out.productCostSar > 0;
  return out;
}
function homeProfitForScope(start, end, scopeValue = ''){
  return profitSummaryForRows(profitDailyRows(start, end, scopeValue, true));
}
function profitDisplayHtml(summary, opts = {}){
  const s = summary || {};
  if (!s.hasAnyCost) {
    return '<span class="pending-profit">待成本表</span><span class="coverage-note">成本覆盖 0%，先导入成本表</span>';
  }
  const cls = Number(s.profitSar || 0) < 0 ? 'danger' : 'positive';
  return '<span class="'+cls+'">'+escapeHtml(fmt.format(Number(s.profitSar || 0)))+'</span><span class="coverage-note">覆盖 '+pct(s.costCoverageRate)+' · 未扣月仓储</span>';
}
function profitMarginHtml(summary){
  const s = summary || {};
  if (!s.hasAnyCost || s.margin == null) return '<div class="matrix-cell value profit-margin-cell"><span class="pending-profit">待成本表</span></div>';
  const cls = Number(s.margin || 0) >= .25 ? 'positive' : Number(s.margin || 0) >= .1 ? 'warn' : 'danger';
  return '<div class="matrix-cell value profit-margin-cell"><span class="'+cls+'">'+escapeHtml(pct(s.margin))+'</span></div>';
}
function starHtml(value){
  const n = Math.max(0, Math.min(5, Math.round(Number(value || 0))));
  let out = '';
  for (let i = 1; i <= 5; i++) out += '<span class="'+(i <= n ? '' : 'off')+'">★</span>';
  return '<span class="stars" aria-label="'+num(n)+'星">'+out+'</span>';
}
function homeScopeSubtitle(){
  const parts = [storeScopeLabel()];
  const p = productScopeQuery();
  if (p) parts.push('货号/SKC：' + (state.product || '').trim());
  return parts.join(' · ');
}
function kpiJump(tab, patch = {}){
  state = {...state, ...patch, tab};
  if (tab !== 'overview' && !patch.keepHomeFilters) {
    state.q = '';
    state.product = '';
    state.domain = '';
    state.risk = '';
    state.status = '';
    state.focus = 'all';
    state.insight = 'all';
    if (storeFilterKind().type === 'group') state.store = '';
  }
  shouldScrollToActiveTab = true;
  applyStateToControls();
  renderAll();
}
function renderKpis(){
  const range = ensureDateRange();
  const salesTitle = state.salesMode === 'gross' ? '当前时段总销售额' : '当前时段净销售额';
  const salesTip = state.salesMode === 'gross'
    ? '总销售额按订单创建时间统计，不扣售后、退货、派送失败等反转订单。用于看原始成交规模。'
    : '净销售额按订单创建时间统计，已扣除退货、仅退款、派送失败等反转订单。用于利润和真实经营口径。';
  const qtyTip = state.qtyMode === 'gross'
    ? '总订单/销量包含后续发生退货或派送失败的订单，用于看原始出单规模。'
    : '净订单/销量只统计最终仍保留成交额的订单，用于经营结果口径。';
  const afterLabel = state.returnsMode === 'order' ? '按订单创建时间 · 未取消售后' : '按售后申请时间';
  const profitLabel = state.profitMode === 'rtv' ? '按RTV已收入仓可二售测算' : '按退货全损保守估计';
  const rows = homeScopeRows().map(def => {
    const sales = homeSalesForScope(range.start, range.end, def.scopeValue);
    const after = homeAfterSalesForScope(range.start, range.end, def.scopeValue);
    const profit = homeProfitForScope(range.start, range.end, def.scopeValue);
    return {
      ...def,
      sales_sar:sales.sales_sar,
      orders:sales.orders,
      quantity:sales.quantity,
      activeProducts:activeProductCountForScope(range.start, range.end, def.scopeValue),
      returnCases:after.cases,
      returnAmountSar:after.amount_sar,
      profit
    };
  });
  const matrix = (cols, rowsHtml, extraClass = '') => '<div class="metric-matrix cols-'+cols+(extraClass ? ' '+extraClass : '')+'">'+rowsHtml+'</div>';
  const head = cells => cells.map(c => '<div class="matrix-cell head">'+escapeHtml(c)+'</div>').join('');
  const label = txt => '<div class="matrix-cell label">'+escapeHtml(txt)+'</div>';
  const value = html => '<div class="matrix-cell value">'+html+'</div>';
  const moneyValue = v => value(escapeHtml(fmt.format(Number(v || 0))));
  const rmbValue = v => value(escapeHtml(fmt.format(Number(v || 0) * RMB_RATE)));
  const card = (title, sub, body, tip, jump = 'business') =>
    '<div class="overview-matrix-card" role="button" tabindex="0" data-overview-jump="'+escapeHtml(jump)+'" aria-label="查看'+escapeHtml(title)+'">'+
      '<div class="matrix-card-head"><h4>'+escapeHtml(title)+' <em class="help" tabindex="0" data-tip="'+escapeHtml(tip)+'">?</em></h4><div class="sub">'+escapeHtml(sub)+'</div></div>'+body+
    '</div>';
  const profitMoney = r => Number(r.profit?.[profitValueKey()] ?? r.profit?.profitSar ?? 0);
  $('kpis').innerHTML =
    card(salesTitle, selectedRangeText(),
      metricModeToggle('salesMode', [{value:'net', label:'净销售额'}, {value:'gross', label:'总销售额'}])+
      matrix(2, head(['范围','SAR','RMB'])+rows.map(r => label(r.label)+moneyValue(r.sales_sar)+rmbValue(r.sales_sar)).join('')),
      salesTip+' RMB 按固定汇率 1 SAR = 1.8 估算。')+
    card('当前时段订单 / 销量 / 动销', selectedRangeText(),
      metricModeToggle('qtyMode', [{value:'net', label:'净销量'}, {value:'gross', label:'总销量'}])+
      matrix(3, head(['范围','订单','销量','动销货号'])+rows.map(r => label(r.label)+value(num(r.orders)+' 单')+value(num(r.quantity)+' 件')+value(num(r.activeProducts)+' 个')).join('')),
      qtyTip+' 动销货号是当前时段有对应销量的标准货号数量。')+
    card('当前时段退货 / 售后', afterLabel,
      metricModeToggle('returnsMode', [{value:'request', label:'售后申请时间'}, {value:'order', label:'订单创建时间'}])+
      matrix(3, head(['范围','数量','SAR','RMB'])+rows.map(r => label(r.label)+value(num(r.returnCases)+' 单')+moneyValue(r.returnAmountSar)+rmbValue(r.returnAmountSar)).join('')),
      '已取消售后不计入；金额按订单实收/预计收入字段优先，避免售后列表展示价失真。')+
    card('当前时段真实利润', profitLabel,
      metricModeToggle('profitMode', [{value:'loss', label:'全损保守'}, {value:'rtv', label:'RTV入仓测算'}])+
      matrix(3, head(['范围','SAR','RMB','利润率'])+rows.map(r => label(r.label)+value(profitDisplayHtml(r.profit))+value(r.profit?.hasAnyCost ? escapeHtml(fmt.format(profitMoney(r) * RMB_RATE)) : '<span class="pending-profit">待成本表</span>')+profitMarginHtml(r.profit)).join(''), 'profit-matrix'),
      '全损保守：退货营收为0并扣成本；RTV入仓测算：ET已收退件按可二售回收成本测算。月仓储费只用于月度总利润，不拆到单货号。', 'profit');
  document.querySelectorAll('[data-overview-jump]').forEach(btn => btn.addEventListener('click', e => {
    if (e.target?.classList?.contains('help') || e.target?.closest?.('[data-metric-mode-key]')) return;
    kpiJump(btn.dataset.overviewJump || 'business');
  }));
  document.querySelectorAll('[data-metric-mode-key]').forEach(btn => btn.addEventListener('click', e => {
    e.preventDefault(); e.stopPropagation();
    const key = btn.dataset.metricModeKey;
    const val = btn.dataset.metricModeValue;
    if (key && val && state[key] !== val) { state[key] = val; syncUrlHash(); renderAll(); }
  }));
}
function homeBarList(rows, valueKey, labelKey, opts = {}){
  const max = Math.max(1, ...rows.map(r => Number(typeof valueKey === 'function' ? valueKey(r) : r[valueKey] || 0)));
  return '<div class="home-bars">' + rows.map(r => {
    const value = Number(typeof valueKey === 'function' ? valueKey(r) : r[valueKey] || 0);
    const label = typeof labelKey === 'function' ? labelKey(r) : r[labelKey];
    const width = Math.max(4, Math.round(value / max * 100));
    const attr = opts.attr ? opts.attr(r) : '';
    const color = opts.color ? opts.color(r) : '';
    const style = color ? 'style="--bar-color:'+escapeHtml(color)+'"' : '';
    const display = opts.format ? opts.format(value, r) : (opts.money ? money(value) : num(value));
    const meta = opts.meta ? '<small>'+escapeHtml(opts.meta(r))+'</small>' : '';
    return '<button class="home-bar status-btn" '+attr+' '+style+' title="'+escapeHtml(label || '-')+'">'+
      '<b>'+escapeHtml(label || '-')+'</b><i style="width:'+width+'%"></i><span>'+escapeHtml(display)+'</span>'+meta+
    '</button>';
  }).join('') + '</div>';
}
function groupScopeSummary(){
  const stores = DATA.stores || [];
  const make = (key, rows) => {
    const m = groupMeta(key);
    return {
      ...m,
      storeCount: rows.length,
      sales_sar: rows.reduce((s,r)=>s+Number(r.sales_sar||0),0),
      quantity: rows.reduce((s,r)=>s+Number(r.quantity||0),0),
      orders: rows.reduce((s,r)=>s+Number(r.valid_order_count||0),0),
      actions: rows.reduce((s,r)=>s+Number(r.link_action_count||0),0),
      afterSales: rows.reduce((s,r)=>s+Number(r.after_sales_case_count||0),0),
      pendingSar: rows.reduce((s,r)=>s+Number(r.pending_settlement_income_sar||0),0)
    };
  };
  return [
    make('ALL', stores),
    make('DSY', stores.filter(r => storeGroupKey(r) === 'DSY')),
    make('LGM', stores.filter(r => storeGroupKey(r) === 'LGM'))
  ];
}
function renderGroupSummaryCards(rows){
  return '<div class="group-summary-grid">' + rows.map(r =>
    '<article class="group-card '+escapeHtml(r.cls)+'" style="--group-color:'+escapeHtml(r.color)+'">'+
      '<h4>'+escapeHtml(r.label)+'</h4>'+
      '<span>'+escapeHtml(r.desc)+' · '+num(r.storeCount)+' 店</span>'+
      '<strong>'+money(r.sales_sar)+'</strong>'+
      '<small>'+rmb(r.sales_sar)+' · 订单 '+num(r.orders)+' · 销量 '+num(r.quantity)+' 件</small>'+
      '<small>动作 '+num(r.actions)+' · 售后 '+num(r.afterSales)+' · 待结算 '+money(r.pendingSar)+'</small>'+
    '</article>'
  ).join('') + '</div>';
}
function renderGroupSplitCards(rows, totalSales = 0, monthRows = []){
  return '<div class="group-summary-grid two">' + rows.map(r => {
    const share = totalSales ? Math.round(Number(r.sales_sar || 0) / totalSales * 1000) / 10 : 0;
    const month = monthRows.find(x => x.key === r.key) || {};
    return '<article class="group-card '+escapeHtml(r.cls)+'" style="--group-color:'+escapeHtml(r.color)+'">'+
      '<h4>'+escapeHtml(r.label)+'</h4>'+
      '<span>'+escapeHtml(selectedRangeText())+' · '+num(r.storeCount)+' 店 · 占比 '+share+'%</span>'+
      '<strong>'+money(r.sales_sar)+'</strong>'+
      '<small>当前时段：'+rmb(r.sales_sar)+' · 订单 '+num(r.orders)+' · 销量 '+num(r.quantity)+' 件</small>'+
      '<small>本月补充：'+money(month.sales_sar || 0)+' / '+rmb(month.sales_sar || 0)+' · 订单 '+num(month.orders)+' · 销量 '+num(month.quantity)+' 件</small>'+
      '<small>当前辅助信号：售后样本 '+num(r.afterSales)+' · 动作 '+num(r.actions)+'</small>'+
    '</article>';
  }).join('') + '</div>';
}
function panel(title, sub, body, extraClass = ''){
  return '<article class="dashboard-panel '+extraClass+'"><h4>'+escapeHtml(title)+'</h4><div class="sub">'+escapeHtml(sub)+'</div>'+body+'</article>';
}
const PERIOD_META = {
  day:{label:'日', title:'日排行'},
  week:{label:'周', title:'周排行'},
  month:{label:'月', title:'月排行'},
  year:{label:'年', title:'年排行'}
};
function availablePeriods(key = state.rankPeriod){
  const rows = (DATA.rankings?.salesSummary || []).filter(r => r.period_key === key);
  return [...rows].sort((a,b) => String(b.end_date || '').localeCompare(String(a.end_date || '')) || String(b.period_id || '').localeCompare(String(a.period_id || '')));
}
function latestPeriodId(key = state.rankPeriod){
  return availablePeriods(key)[0]?.period_id || '';
}
function selectedPeriodId(key = state.rankPeriod){
  const options = availablePeriods(key);
  if (!options.length) return '';
  if (state.rankWindow && options.some(r => r.period_id === state.rankWindow)) return state.rankWindow;
  return options[0].period_id || '';
}
function ensureRankWindow(){
  const id = selectedPeriodId(state.rankPeriod);
  if (state.rankWindow !== id) state.rankWindow = id;
  return id;
}
function periodSummary(key = state.rankPeriod, id = selectedPeriodId(key)){
  const rows = DATA.rankings?.salesSummary || [];
  return rows.find(r => r.period_key === key && r.period_id === id) || rows.find(r => r.period_key === key) || {};
}
function periodRows(kind, key = state.rankPeriod, id = selectedPeriodId(key)){
  return (DATA.rankings?.[kind] || []).filter(r => r.period_key === key && r.period_id === id);
}
function periodRangeText(row){
  const start = String(row?.start_date || '').slice(0, 10);
  const end = String(row?.end_date || '').slice(0, 10);
  if (!start && !end) return '暂无日期';
  if (start === end) return end || start || '-';
  return (start || '-') + ' 至 ' + (end || '-');
}
function periodOptionLabel(row){
  if (!row) return '-';
  if (row.period_key === 'day') return String(row.period_id || row.end_date || '').slice(0, 10);
  if (row.period_key === 'month') return String(row.period_id || '').slice(0, 7) + '（' + periodRangeText(row) + '）';
  if (row.period_key === 'year') return String(row.period_id || '') + '（' + periodRangeText(row) + '）';
  return periodRangeText(row);
}
function rankPeriodSwitch(){
  const selected = periodSummary();
  const options = availablePeriods(state.rankPeriod);
  return '<div class="rank-toolbar"><div><strong>'+escapeHtml(PERIOD_META[state.rankPeriod]?.title || '排行')+'</strong><div class="sub">当前窗口：'+escapeHtml(periodRangeText(selected))+'；可回顾已入仓的每一天 / 每周 / 每月 / 每年。</div></div>'+
    '<div class="rank-controls">'+
      '<div class="period-switch" aria-label="排行榜周期切换">'+
        Object.entries(PERIOD_META).map(([key, meta]) => '<button type="button" class="'+(state.rankPeriod === key ? 'active' : '')+'" data-rank-period="'+key+'">'+meta.label+'</button>').join('')+
      '</div>'+
      '<label class="period-picker"><span>选择窗口</span><select id="rankWindowSelect" aria-label="选择排行榜时间窗口">'+
        options.map(row => '<option value="'+escapeHtml(row.period_id || '')+'" '+((row.period_id || '') === (selected.period_id || '') ? 'selected' : '')+'>'+escapeHtml(periodOptionLabel(row))+'</option>').join('')+
      '</select></label>'+
    '</div></div>';
}
const RANGE_PRESETS = [
  ['today','今天'],
  ['yesterday','昨天'],
  ['last3','近3天'],
  ['last7','近7天'],
  ['last15','近15天'],
  ['last30','近30天'],
  ['thisMonth','本月'],
  ['lastMonth','上个月'],
  ['last3Months','近3个月'],
  ['lastYear','近一年'],
];
function calendarMonthStart(dateText){
  const d = parseDateOnly(dateText) || parseDateOnly(dataAnchorDate()) || new Date();
  return isoDate(new Date(d.getFullYear(), d.getMonth(), 1));
}
function monthTitle(dateText){
  const d = parseDateOnly(dateText) || parseDateOnly(dataAnchorDate()) || new Date();
  return d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月';
}
function renderCalendarPanel(monthDate, role){
  const first = parseDateOnly(calendarMonthStart(monthDate)) || new Date();
  const year = first.getFullYear();
  const month = first.getMonth();
  const startOffset = (first.getDay() + 6) % 7;
  const gridStart = new Date(year, month, 1 - startOffset);
  const range = ensureDateRange();
  const days = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    const iso = isoDate(d);
    const cls = [
      'calendar-day',
      d.getMonth() === month ? '' : 'out',
      iso >= range.start && iso <= range.end ? 'in-range' : '',
      iso === range.start ? 'start' : '',
      iso === range.end ? 'end' : ''
    ].filter(Boolean).join(' ');
    days.push('<button type="button" class="'+cls+'" data-calendar-date="'+escapeHtml(iso)+'" data-calendar-role="'+escapeHtml(role)+'">'+d.getDate()+'</button>');
  }
  return '<div class="range-calendar-panel">'+
    '<div class="calendar-panel-head"><div><span class="sub">'+(role === 'start' ? '开始时间' : '结束时间')+'</span><h4>'+escapeHtml(monthTitle(monthDate))+'</h4></div>'+
      '<div class="calendar-nav"><button type="button" data-calendar-shift="'+escapeHtml(role)+'" data-calendar-delta="-1">‹</button><button type="button" data-calendar-shift="'+escapeHtml(role)+'" data-calendar-delta="1">›</button></div></div>'+
    '<div class="calendar-week"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div>'+
    '<div class="calendar-days">'+days.join('')+'</div>'+
  '</div>';
}
function calendarBaseMonths(){
  const r = ensureDateRange();
  let startMonth = calendarMonthStart(state.calendarStartMonth || r.start);
  let endMonth = calendarMonthStart(state.calendarEndMonth || r.end);
  if (startMonth === endMonth) endMonth = addMonths(startMonth, 1);
  state.calendarStartMonth = startMonth;
  state.calendarEndMonth = endMonth;
  return {startMonth, endMonth};
}
function dateRangeToolbar(){
  const r = ensureDateRange();
  const months = calendarBaseMonths();
  const presetLabel = RANGE_PRESETS.find(([key]) => key === state.rangePreset)?.[1] || '自定义';
  return '<div class="range-toolbar" id="rangeToolbar">'+
    '<div class="range-toolbar-main">'+
      '<button type="button" class="range-button" id="rangePopupToggle" aria-expanded="false" aria-controls="rangePopover">'+
        '<span>时间筛选</span><div><strong>'+escapeHtml(selectedRangeText())+'</strong><small>点击打开大号双日历；排行榜、趋势、货号销售均按这个时间段重算。</small></div>'+
      '</button>'+
      '<div class="range-preset-strip" aria-label="快捷时间">'+
        RANGE_PRESETS.map(([key,label]) => '<button type="button" class="'+(state.rangePreset === key ? 'active' : '')+'" data-range-preset="'+key+'">'+label+'</button>').join('')+
      '</div>'+
      '<div class="range-current-tags"><span class="tag info">'+escapeHtml(presetLabel)+'</span></div>'+
    '</div>'+
    '<div class="range-popover" id="rangePopover" hidden>'+
      '<div class="calendar-input-row">'+
        '<label class="calendar-input-card"><span>开始日期</span><input id="rangeStart" type="date" value="'+escapeHtml(r.start)+'" /></label>'+
        '<label class="calendar-input-card"><span>结束日期</span><input id="rangeEnd" type="date" value="'+escapeHtml(r.end)+'" /></label>'+
      '</div>'+
      '<div class="range-calendar-grid">'+renderCalendarPanel(months.startMonth, 'start')+renderCalendarPanel(months.endMonth, 'end')+'</div>'+
      '<div class="calendar-pick-note">左侧选择开始日期，右侧选择结束日期；也可以直接改上方日期框。快捷按钮在外层，常用时间段不用打开弹窗。</div>'+
    '</div>'+
  '</div>';
}
function renderFloatingRangeToolbar(){
  const dock = document.getElementById('homeRangeDock');
  if (dock) {
    dock.hidden = true;
    dock.innerHTML = '';
  }
}
function renderTopRangeToolbar(){
  const dock = document.getElementById('topRangeDock');
  if (!dock) return;
  if (isActionFilterTab()) {
    dock.hidden = true;
    dock.innerHTML = '';
    return;
  }
  dock.hidden = false;
  dock.innerHTML = dateRangeToolbar();
}
function bindRangeToolbarControls(root = document){
  const rangeToggle = root.querySelector ? root.querySelector('#rangePopupToggle') : $('rangePopupToggle');
  const rangePopover = root.querySelector ? root.querySelector('#rangePopover') : $('rangePopover');
  if (rangeToggle && rangePopover && !rangeToggle.dataset.boundRangeToggle) {
    rangeToggle.dataset.boundRangeToggle = '1';
    rangeToggle.addEventListener('click', e => {
      e.stopPropagation();
      rangePopover.hidden = !rangePopover.hidden ? true : false;
      rangeToggle.setAttribute('aria-expanded', String(!rangePopover.hidden));
    });
    rangePopover.addEventListener('click', e => e.stopPropagation());
  }
  root.querySelectorAll?.('[data-range-preset]').forEach(btn => {
    if (btn.dataset.boundRangePreset) return;
    btn.dataset.boundRangePreset = '1';
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const preset = btn.dataset.rangePreset || 'last30';
      const r = computePresetRange(preset, calendarToday());
      state.rangePreset = preset;
      state.startDate = r.start;
      state.endDate = r.end;
      state.calendarStartMonth = calendarMonthStart(r.start);
      state.calendarEndMonth = calendarMonthStart(r.end === r.start ? addMonths(r.start, 1) : r.end);
      renderAll();
    });
  });
  const startInput = root.querySelector ? root.querySelector('#rangeStart') : $('rangeStart');
  const endInput = root.querySelector ? root.querySelector('#rangeEnd') : $('rangeEnd');
  if (startInput && !startInput.dataset.boundRangeInput) {
    startInput.dataset.boundRangeInput = '1';
    startInput.addEventListener('change', e => {
      state.startDate = e.target.value || state.startDate;
      state.rangePreset = 'custom';
      state.calendarStartMonth = calendarMonthStart(state.startDate);
      renderAll();
    });
  }
  if (endInput && !endInput.dataset.boundRangeInput) {
    endInput.dataset.boundRangeInput = '1';
    endInput.addEventListener('change', e => {
      state.endDate = e.target.value || state.endDate;
      state.rangePreset = 'custom';
      state.calendarEndMonth = calendarMonthStart(state.endDate);
      renderAll();
    });
  }
  root.querySelectorAll?.('[data-calendar-date]').forEach(btn => {
    if (btn.dataset.boundCalendarDate) return;
    btn.dataset.boundCalendarDate = '1';
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const date = btn.dataset.calendarDate || '';
      const role = btn.dataset.calendarRole || 'start';
      if (!date) return;
      if (role === 'end') {
        state.endDate = date;
        state.calendarEndMonth = calendarMonthStart(date);
      } else {
        state.startDate = date;
        state.calendarStartMonth = calendarMonthStart(date);
      }
      if (state.startDate && state.endDate && state.startDate > state.endDate) {
        const t = state.startDate;
        state.startDate = state.endDate;
        state.endDate = t;
      }
      state.rangePreset = 'custom';
      renderAll();
    });
  });
  root.querySelectorAll?.('[data-calendar-shift]').forEach(btn => {
    if (btn.dataset.boundCalendarShift) return;
    btn.dataset.boundCalendarShift = '1';
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const role = btn.dataset.calendarShift || 'start';
      const delta = Number(btn.dataset.calendarDelta || 0);
      if (role === 'end') state.calendarEndMonth = addMonths(state.calendarEndMonth || state.endDate, delta);
      else state.calendarStartMonth = addMonths(state.calendarStartMonth || state.startDate, delta);
      renderAll();
    });
  });
}
function storeRankName(r){
  return String(r.store_key || '-');
}
function productRankName(r){
  return String(r.standard_goods_sn || '-');
}
function productRankMeta(r, extra = ''){
  return extra;
}
function focusProductQueryFromHome(value){
  const v = String(value || '').trim();
  state.product = v;
  state.q = v;
}
function syncHomeScopeControls(){
  safeSetValue('homeProductFilter', state.product);
  safeSetValue('homeStoreFilter', state.store);
  const hint = $('homeScopeHint');
  if (hint) {
    hint.innerHTML =
      '<span class="tag info">'+escapeHtml(storeScopeLabel())+'</span>'+
      '<span class="tag '+(productScopeQuery() ? 'good' : 'info')+'">'+escapeHtml(productScopeQuery() ? ('货号/SKC：' + state.product.trim()) : '全部货号')+'</span>';
  }
}
function rankList(rows, opts = {}){
  if (!rows.length) return '<div class="empty">当前周期暂无排行数据</div>';
  const valueKey = opts.valueKey || 'sales_sar';
  const max = Math.max(1, ...rows.map(r => Number(r[valueKey] || 0)));
  return '<div class="rank-list '+escapeHtml(opts.className || '')+'">' + rows.map((r, i) => {
    const value = Number(r[valueKey] || 0);
    const pctWidth = Math.max(4, Math.round(value / max * 100));
    const name = opts.name ? opts.name(r) : (r.store_key || r.standard_goods_sn || '-');
    const meta = opts.meta ? opts.meta(r) : '';
    const valueText = opts.format ? opts.format(value, r) : money(value);
    const subValue = opts.subValue ? opts.subValue(r) : '';
    const attr = opts.attr ? opts.attr(r) : '';
    const color = opts.color ? opts.color(r) : 'var(--cyan)';
    return '<button class="rank-item" '+attr+' style="--bar-color:'+escapeHtml(color)+'" title="'+escapeHtml(name)+'">'+
      '<span class="rank-no">'+(i+1)+'</span>'+
      '<span><span class="rank-name">'+escapeHtml(name)+'</span><span class="rank-meta">'+escapeHtml(meta)+'</span><i style="display:block;width:'+pctWidth+'%;height:6px;border-radius:999px;background:var(--bar-color);margin-top:8px"></i></span>'+
      '<span class="rank-value">'+escapeHtml(valueText)+'<span class="rank-subvalue">'+escapeHtml(subValue)+'</span></span>'+
    '</button>';
  }).join('') + '</div>';
}
function chartRangeFor(kind){
  const selected = ensureDateRange();
  if (kind === 'day' && selected.start === selected.end && state.rangePreset === 'today') return defaultChartRange('day');
  if (kind === 'month' && selected.start === selected.end) return defaultChartRange('month');
  return selected;
}
function monthId(dateText){
  return String(dateText || '').slice(0, 7);
}
function monthLabel(dateText){
  const s = String(dateText || '').slice(0, 7);
  return s || '-';
}
function isoDateOnly(value){
  return String(value || '').slice(0, 10);
}
function monthEndDate(id){
  const [y, m] = String(id || '').split('-').map(Number);
  if (!y || !m) return '';
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
function monthPeriodBounds(id, range){
  const start = isoDateOnly(range?.start);
  const end = isoDateOnly(range?.end);
  const monthStart = String(id || '').slice(0, 7) + '-01';
  const monthEnd = monthEndDate(id);
  if (!monthEnd) return {start:monthStart, end:monthStart, partial:false};
  const sliceStart = start && start > monthStart ? start : monthStart;
  const sliceEnd = end && end < monthEnd ? end : monthEnd;
  return {start:sliceStart, end:sliceEnd, partial:sliceStart !== monthStart || sliceEnd !== monthEnd};
}
function monthPeriodLabel(id, range){
  const b = monthPeriodBounds(id, range);
  if (!b.partial) return id || '-';
  return (id || '-') + '（' + b.start.slice(5) + '~' + b.end.slice(5) + '）';
}
function monthSliceNote(range){
  const startId = monthId(range?.start);
  const endId = monthId(range?.end);
  if (!startId || !endId) return '';
  const ids = [];
  let cur = startId + '-01';
  while (monthId(cur) <= endId && ids.length < 24) {
    ids.push(monthId(cur));
    const [y,m] = monthId(cur).split('-').map(Number);
    cur = new Date(Date.UTC(y, m, 1)).toISOString().slice(0,10);
  }
  const partial = ids.map(id => ({id, ...monthPeriodBounds(id, range)})).filter(x => x.partial);
  if (!partial.length) return '';
  return '月趋势按所选日期切片，不补整月：' + partial.map(x => x.id + '=' + x.start.slice(5) + '~' + x.end.slice(5)).join('；') + '。';
}
function buildSalesSeries(kind){
  const range = chartRangeFor(kind);
  const buckets = new Map();
  const hasProduct = Boolean(productScopeQuery());
  const source = hasProduct ? (DATA.rankings?.dailyStoreProducts || []) : (DATA.rankings?.dailyStores || []);
  for (const r of source) {
    const d = String(r.date || '').slice(0, 10);
    if (!d || d < range.start || d > range.end) continue;
    if (!storeMatchesScope(r)) continue;
    if (hasProduct && !productDailyMatch(r)) continue;
    const id = kind === 'month' ? monthId(d) : d;
    const row = buckets.get(id) || {id, label: kind === 'month' ? monthPeriodLabel(id, range) : d, total:0, DSY:0, LGM:0, scope:0};
    const value = Number(r[salesAmountKey()] ?? r.sales_sar ?? 0);
    row.total += value;
    row.scope += value;
    const g = storeGroupKey(r);
    if (g === 'DSY' || g === 'LGM') row[g] += value;
    buckets.set(id, row);
  }
  return Array.from(buckets.values()).sort((a,b)=>String(a.id).localeCompare(String(b.id))).map(r => ({
    ...r,
    total:Math.round(r.total * 100) / 100,
    DSY:Math.round(r.DSY * 100) / 100,
    LGM:Math.round(r.LGM * 100) / 100,
    scope:Math.round(r.scope * 100) / 100
  }));
}
const TREND_METRICS = {
  sales:{label:'销售额', unit:'SAR', money:true, aria:'销售额趋势'},
  quantity:{label:'销量', unit:'件', money:false, aria:'销量趋势'},
  returns:{label:'退货数量', unit:'单', money:false, aria:'退货数量趋势'},
  profit:{label:'利润额', unit:'SAR', money:true, aria:'利润额趋势'}
};
function trendMetricKey(){
  return TREND_METRICS[state.trendMetric] ? state.trendMetric : 'sales';
}
function trendMetricButtons(){
  const cur = trendMetricKey();
  return '<div class="trend-toggle" aria-label="趋势指标切换">'+Object.entries(TREND_METRICS).map(([key, meta]) =>
    '<button type="button" class="'+(cur === key ? 'active' : '')+'" data-trend-metric="'+key+'">'+escapeHtml(meta.label)+'</button>'
  ).join('')+'</div>';
}
function trendValueText(v, metric = trendMetricKey()){
  const n = Number(v || 0);
  return TREND_METRICS[metric]?.money ? money(n) : (num(n) + ' ' + (TREND_METRICS[metric]?.unit || ''));
}
function buildMetricSeries(kind, metric = trendMetricKey()){
  if (metric === 'sales') return buildSalesSeries(kind);
  const range = chartRangeFor(kind);
  const buckets = new Map();
  const ensure = (id) => {
    const row = buckets.get(id) || {id, label: kind === 'month' ? monthPeriodLabel(id, range) : id, total:0, DSY:0, LGM:0, scope:0};
    buckets.set(id, row);
    return row;
  };
  if (metric === 'quantity') {
    const hasProduct = Boolean(productScopeQuery());
    const source = hasProduct ? (DATA.rankings?.dailyStoreProducts || []) : (DATA.rankings?.dailyStores || []);
    for (const r of source) {
      const d = String(r.date || '').slice(0, 10);
      if (!d || d < range.start || d > range.end) continue;
      if (!storeMatchesScope(r)) continue;
      if (hasProduct && !productDailyMatch(r)) continue;
      const id = kind === 'month' ? monthId(d) : d;
      const row = ensure(id);
      const v = Number(r[quantityKey()] ?? r.quantity ?? 0);
      row.total += v; row.scope += v;
      const g = storeGroupKey(r);
      if (g === 'DSY' || g === 'LGM') row[g] += v;
    }
  } else if (metric === 'returns') {
    if (state.returnsMode === 'order') {
      const hasProduct = Boolean(productScopeQuery());
      const source = hasProduct ? (DATA.rankings?.dailyStoreProducts || []) : (DATA.rankings?.dailyStores || []);
      for (const r of source) {
        const d = String(r.date || '').slice(0, 10);
        if (!d || d < range.start || d > range.end) continue;
        if (!storeMatchesScope(r)) continue;
        if (hasProduct && !productDailyMatch(r)) continue;
        const id = kind === 'month' ? monthId(d) : d;
        const row = ensure(id);
        const v = Math.max(0, Number(r.gross_orders ?? r.orders ?? 0) - Number(r.orders || 0));
        row.total += v; row.scope += v;
        const g = storeGroupKey(r);
        if (g === 'DSY' || g === 'LGM') row[g] += v;
      }
    } else {
      for (const r of DATA.afterSales || []) {
        const d = String(r.request_time || r.snapshot_date || '').slice(0, 10);
        if (!d || d < range.start || d > range.end) continue;
        if (String(r.order_sub_status_name || '').trim() === '已取消') continue;
        if (!storeMatchesScope(r)) continue;
        if (productScopeQuery() && !productMatch(r)) continue;
        const id = kind === 'month' ? monthId(d) : d;
        const row = ensure(id);
        row.total += 1; row.scope += 1;
        const g = storeGroupKey(r);
        if (g === 'DSY' || g === 'LGM') row[g] += 1;
      }
    }
  } else if (metric === 'profit') {
    for (const r of profitDailyRows(range.start, range.end, state.store, true)) {
      const d = String(r.date || '').slice(0, 10);
      if (!d) continue;
      const id = kind === 'month' ? monthId(d) : d;
      const row = ensure(id);
      const v = Number(r[profitRowValueKey()] ?? r.profit_before_storage_sar ?? 0);
      row.total += v; row.scope += v;
      const g = storeGroupKey(r);
      if (g === 'DSY' || g === 'LGM') row[g] += v;
    }
  }
  return Array.from(buckets.values()).sort((a,b)=>String(a.id).localeCompare(String(b.id))).map(r => ({
    ...r,
    total:Math.round(r.total * 100) / 100,
    DSY:Math.round(r.DSY * 100) / 100,
    LGM:Math.round(r.LGM * 100) / 100,
    scope:Math.round(r.scope * 100) / 100
  }));
}
function renderMetricLineChart(kind = 'day', metric = trendMetricKey()){
  const series = buildMetricSeries(kind, metric);
  const range = chartRangeFor(kind);
  const scope = storeFilterKind();
  const scoped = scope.type !== 'all' || Boolean(productScopeQuery());
  const colors = scoped ? {scope: metric === 'profit' ? '#14b8a6' : metric === 'returns' ? '#ef4444' : '#10b981'} : {total:'#10b981', DSY:'#2563eb', LGM:'#f97316'};
  const labels = scoped ? {scope:homeScopeSubtitle()} : {total:'总计', DSY:'DSY', LGM:'LGM'};
  if (!series.length) {
    return '<div class="empty">当前时间段 '+escapeHtml(range.start)+' 至 '+escapeHtml(range.end)+' 暂无'+escapeHtml(TREND_METRICS[metric]?.label || '趋势')+'数据。</div>';
  }
  const keys = Object.keys(colors);
  const values = series.flatMap(x => keys.map(k => Number(x[k] || 0)));
  const max = niceCeil(Math.max(1, ...values));
  const w = 1880, h = 310, padL = 92, padR = 28, padT = 24, padB = 52;
  const xFor = (i) => series.length === 1 ? (padL + (w - padR)) / 2 : padL + (i / (series.length - 1)) * (w - padL - padR);
  const yFor = (v) => padT + (1 - (Number(v || 0) / max)) * (h - padT - padB);
  const gridTicks = [0, 0.25, 0.5, 0.75, 1].map(t => {
    const val = max * t;
    const y = yFor(val);
    return '<line class="grid-line" x1="'+padL+'" y1="'+y.toFixed(1)+'" x2="'+(w-padR)+'" y2="'+y.toFixed(1)+'"></line>'+
      '<text class="axis" text-anchor="end" x="'+(padL-10)+'" y="'+(y+4).toFixed(1)+'">'+escapeHtml(trendValueText(val, metric))+'</text>';
  }).join('');
  const lines = keys.map(k => {
    const pts = series.map((r,i) => xFor(i).toFixed(1)+','+yFor(r[k]).toFixed(1)).join(' ');
    const dots = series.map((r,i) => '<circle class="dot" cx="'+xFor(i).toFixed(1)+'" cy="'+yFor(r[k]).toFixed(1)+'" r="3.5" fill="'+colors[k]+'"><title>'+escapeHtml(labels[k]+' '+r.label+' '+trendValueText(r[k], metric))+'</title></circle>').join('');
    return '<polyline class="series" points="'+pts+'" stroke="'+colors[k]+'"></polyline>'+dots;
  }).join('');
  const labelEvery = series.length <= 7 ? 1 : Math.ceil(series.length / 5);
  const valueLabels = keys.map(k => series.map((r,i) => {
    if (!(i === 0 || i === series.length - 1 || i % labelEvery === 0)) return '';
    const v = Number(r[k] || 0);
    if (!v && i !== 0 && i !== series.length - 1) return '';
    const x = xFor(i);
    const y = Math.max(14, yFor(v) - 9 - keys.indexOf(k) * 12);
    const anchor = i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle';
    return '<text class="value-label" text-anchor="'+anchor+'" x="'+x.toFixed(1)+'" y="'+y.toFixed(1)+'" fill="'+colors[k]+'">'+escapeHtml(TREND_METRICS[metric]?.money ? fmt0.format(v) : num(v))+'</text>';
  }).join('')).join('');
  const xLabels = series.length <= 8 ? series : series.filter((_,i)=> i === 0 || i === series.length - 1 || i % Math.ceil(series.length / 6) === 0);
  const axisLabels = xLabels.map(r => {
    const i = series.indexOf(r);
    return '<text class="axis" text-anchor="'+(i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle')+'" x="'+xFor(i).toFixed(1)+'" y="'+(h-8)+'">'+escapeHtml(r.label)+'</text>';
  }).join('');
  const hitRects = series.map((r,i) => {
    const prev = i === 0 ? padL : (xFor(i - 1) + xFor(i)) / 2;
    const next = i === series.length - 1 ? (w - padR) : (xFor(i) + xFor(i + 1)) / 2;
    const tip = [r.label].concat(keys.map(k => labels[k] + '：' + trendValueText(r[k], metric))).join('\\n');
    return '<rect class="chart-hit" x="'+prev.toFixed(1)+'" y="'+padT+'" width="'+Math.max(8, next-prev).toFixed(1)+'" height="'+(h-padT-padB)+'" data-tip="'+escapeHtml(tip)+'"></rect>';
  }).join('');
  const latest = series.at(-1) || {};
  const sliceNote = kind === 'month' ? monthSliceNote(range) : '';
  return '<div class="line-chart">'+
    '<svg viewBox="0 0 '+w+' '+h+'" role="img" aria-label="'+escapeHtml((kind === 'month' ? '月' : '日') + (TREND_METRICS[metric]?.aria || '趋势'))+'">'+
      gridTicks+
      '<line class="axis-line" x1="'+padL+'" y1="'+padT+'" x2="'+padL+'" y2="'+(h-padB)+'"></line>'+
      '<line class="axis-line" x1="'+padL+'" y1="'+(h-padB)+'" x2="'+(w-padR)+'" y2="'+(h-padB)+'"></line>'+
      lines+valueLabels+axisLabels+hitRects+
    '</svg>'+
    '<div class="chart-tip" aria-hidden="true"></div>'+
    '<div class="chart-legend">'+keys.map(k=>'<span><i style="--c:'+colors[k]+'"></i>'+labels[k]+'：'+trendValueText(latest[k] || 0, metric)+'</span>').join('')+'</div>'+
    '<p class="sub">时间段：'+escapeHtml(range.start)+' 至 '+escapeHtml(range.end)+'；当前显示 '+num(series.length)+' 个'+(kind === 'month' ? '月份' : '日期')+'。'+(sliceNote ? ' '+escapeHtml(sliceNote) : '')+'</p>'+
  '</div>';
}
function renderSalesLineChart(kind = 'day'){
  return renderMetricLineChart(kind, 'sales');
}

function buildProfitMonthSeries(){
  const range = chartRangeFor('month');
  const scope = storeFilterKind();
  const hasScopedProduct = Boolean(productScopeQuery()) || scope.type === 'store';
  if (hasScopedProduct) {
    const buckets = new Map();
    for (const r of profitDailyRows(range.start, range.end, state.store, true)) {
      const d = String(r.date || '').slice(0, 10);
      const id = monthId(d);
      if (!id) continue;
      const row = buckets.get(id) || {id, label:monthPeriodLabel(id, range), scope:0, total:0, DSY:0, LGM:0, coverageNumerator:0, coverageDenominator:0};
      const v = Number(r.profit_before_storage_sar || 0);
      row.scope += v;
      row.total += v;
      row.coverageNumerator += Number(r.known_net_revenue_sar ?? r.known_gross_revenue_sar ?? 0);
      row.coverageDenominator += Number(r.net_revenue_sar || 0);
      buckets.set(id, row);
    }
    return Array.from(buckets.values()).sort((a,b)=>String(a.id).localeCompare(String(b.id))).map(r => ({...r, scope:Math.round(r.scope*100)/100, total:Math.round(r.total*100)/100, coverageRate:r.coverageDenominator ? r.coverageNumerator/r.coverageDenominator : null, beforeStorage:true}));
  }
  const rows = (DATA.profit?.monthGroups || []).filter(r => {
    const m = String(r.month_start || '').slice(0, 7);
    if (!m) return false;
    return m >= monthId(range.start) && m <= monthId(range.end);
  });
  const map = new Map();
  for (const r of rows) {
    if (!storeMatchesScope({store_key:'', group_key:r.group_key || ''})) continue;
    const id = String(r.month_start || '').slice(0, 7);
    const row = map.get(id) || {id, label:monthPeriodLabel(id, range), total:0, DSY:0, LGM:0, scope:0, storage:0, coverageNumerator:0, coverageDenominator:0};
    const value = Number(r.profit_after_storage_sar || 0);
    row.total += value;
    row.scope += value;
    const g = String(r.group_key || '').toUpperCase();
    if (g === 'DSY' || g === 'LGM') row[g] += value;
    row.storage += Number(r.allocated_storage_fee_sar || 0);
    row.coverageNumerator += Number(r.known_net_revenue_sar ?? r.known_gross_revenue_sar ?? 0);
    row.coverageDenominator += Number(r.net_revenue_sar || 0);
    map.set(id, row);
  }
  return Array.from(map.values()).sort((a,b)=>String(a.id).localeCompare(String(b.id))).map(r => ({...r, total:Math.round(r.total*100)/100, DSY:Math.round(r.DSY*100)/100, LGM:Math.round(r.LGM*100)/100, scope:Math.round(r.scope*100)/100, coverageRate:r.coverageDenominator ? r.coverageNumerator/r.coverageDenominator : null, beforeStorage:false}));
}
function aggregateProfitMonthRowsFromDailyRows(rows){
  const map = new Map();
  for (const r of rows || []) {
    const id = monthId(String(r.date || '').slice(0, 10));
    if (!id) continue;
    const row = map.get(id) || {
      month_start:id + '-01',
      group_key:homeScopeSubtitle(),
      net_revenue_sar:0,
      product_cost_sar:0,
      return_delivery_fee_sar:0,
      rtv_recoverable_cost_sar:0,
      rtv_09_recoverable_cost_sar:0,
      rtv_received_quantity:0,
      rtv_received_to_09_quantity:0,
      allocated_storage_fee_sar:0,
      profit_after_storage_sar:0,
      profit_if_rtv_received_resellable_after_storage_sar:0,
      profit_if_rtv_09_resellable_after_storage_sar:0,
      known_net_revenue_sar:0,
      known_gross_revenue_sar:0,
      gross_revenue_sar:0,
      beforeStorage:true
    };
    row.net_revenue_sar += Number(r.net_revenue_sar || 0);
    row.product_cost_sar += Number(r.product_cost_sar || 0);
    row.return_delivery_fee_sar += Number(r.return_delivery_fee_sar || 0);
    row.rtv_recoverable_cost_sar += Number(r.rtv_recoverable_cost_sar || 0);
    row.rtv_09_recoverable_cost_sar += Number(r.rtv_09_recoverable_cost_sar || 0);
    row.rtv_received_quantity += Number(r.rtv_received_quantity || 0);
    row.rtv_received_to_09_quantity += Number(r.rtv_received_to_09_quantity || 0);
    row.profit_after_storage_sar += Number(r.profit_before_storage_sar || 0);
    row.profit_if_rtv_received_resellable_after_storage_sar += Number(r.profit_if_rtv_received_resellable_sar ?? r.profit_before_storage_sar ?? 0);
    row.profit_if_rtv_09_resellable_after_storage_sar += Number(r.profit_if_rtv_09_resellable_sar ?? r.profit_before_storage_sar ?? 0);
    row.known_net_revenue_sar += Number(r.known_net_revenue_sar ?? r.known_gross_revenue_sar ?? 0);
    row.known_gross_revenue_sar += Number(r.known_gross_revenue_sar || 0);
    row.gross_revenue_sar += Number(r.gross_revenue_sar || 0);
    map.set(id, row);
  }
  return Array.from(map.values()).sort((a,b)=>String(a.month_start).localeCompare(String(b.month_start))).map(r => ({
    ...r,
    net_revenue_sar:Math.round(r.net_revenue_sar * 100) / 100,
    product_cost_sar:Math.round(r.product_cost_sar * 100) / 100,
    return_delivery_fee_sar:Math.round(r.return_delivery_fee_sar * 100) / 100,
    rtv_recoverable_cost_sar:Math.round(r.rtv_recoverable_cost_sar * 100) / 100,
    rtv_09_recoverable_cost_sar:Math.round(r.rtv_09_recoverable_cost_sar * 100) / 100,
    rtv_received_quantity:Math.round(r.rtv_received_quantity || 0),
    rtv_received_to_09_quantity:Math.round(r.rtv_received_to_09_quantity || 0),
    allocated_storage_fee_sar:0,
    profit_after_storage_sar:Math.round(r.profit_after_storage_sar * 100) / 100,
    profit_if_rtv_received_resellable_after_storage_sar:Math.round(r.profit_if_rtv_received_resellable_after_storage_sar * 100) / 100,
    profit_if_rtv_09_resellable_after_storage_sar:Math.round(r.profit_if_rtv_09_resellable_after_storage_sar * 100) / 100,
    profit_margin_after_storage:r.net_revenue_sar > 0 ? r.profit_after_storage_sar / r.net_revenue_sar : null,
    cost_coverage_revenue_rate:r.net_revenue_sar > 0 ? r.known_net_revenue_sar / r.net_revenue_sar : null
  }));
}
function renderProfitLineChart(){
  const series = buildProfitMonthSeries();
  const range = chartRangeFor('month');
  const scope = storeFilterKind();
  const scoped = scope.type !== 'all' || Boolean(productScopeQuery());
  const colors = scoped ? {scope:'#14b8a6'} : {total:'#10b981', DSY:'#2563eb', LGM:'#f97316'};
  const labels = scoped ? {scope:homeScopeSubtitle()} : {total:'总计', DSY:'DSY', LGM:'LGM'};
  if (!series.length) return '<div class="empty">当前范围暂无可计算利润。请先导入成本表，或确认所选时间段有订单数据。</div>';
  const keys = Object.keys(colors);
  const values = series.flatMap(x => keys.map(k => Number(x[k] || 0)));
  const maxAbs = niceCeil(Math.max(1, ...values.map(v => Math.abs(v))));
  const min = values.some(v => v < 0) ? -maxAbs : 0;
  const max = maxAbs;
  const w = 1880, h = 310, padL = 92, padR = 28, padT = 24, padB = 52;
  const span = Math.max(1, max - min);
  const xFor = (i) => series.length === 1 ? (padL + (w - padR)) / 2 : padL + (i / (series.length - 1)) * (w - padL - padR);
  const yFor = (v) => padT + (1 - ((Number(v || 0) - min) / span)) * (h - padT - padB);
  const ticks = [min, min/2, 0, max/2, max].filter((v,i,a)=>a.indexOf(v)===i).sort((a,b)=>a-b);
  const gridTicks = ticks.map(val => {
    const y = yFor(val);
    return '<line class="grid-line" x1="'+padL+'" y1="'+y.toFixed(1)+'" x2="'+(w-padR)+'" y2="'+y.toFixed(1)+'"></line>'+
      '<text class="axis" text-anchor="end" x="'+(padL-10)+'" y="'+(y+4).toFixed(1)+'">'+escapeHtml(money(val))+'</text>';
  }).join('');
  const lines = keys.map(k => {
    const pts = series.map((r,i) => xFor(i).toFixed(1)+','+yFor(r[k]).toFixed(1)).join(' ');
    const dots = series.map((r,i) => '<circle class="dot" cx="'+xFor(i).toFixed(1)+'" cy="'+yFor(r[k]).toFixed(1)+'" r="3.8" fill="'+colors[k]+'"><title>'+escapeHtml(labels[k]+' '+r.label+' '+money(r[k]))+'</title></circle>').join('');
    return '<polyline class="series" points="'+pts+'" stroke="'+colors[k]+'"></polyline>'+dots;
  }).join('');
  const labelEvery = series.length <= 7 ? 1 : Math.ceil(series.length / 5);
  const valueLabels = keys.map(k => series.map((r,i) => {
    if (!(i === 0 || i === series.length - 1 || i % labelEvery === 0)) return '';
    const v = Number(r[k] || 0);
    if (!v && i !== 0 && i !== series.length - 1) return '';
    const x = xFor(i);
    const y = Math.max(14, yFor(v) - 9 - keys.indexOf(k) * 12);
    const anchor = i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle';
    return '<text class="value-label" text-anchor="'+anchor+'" x="'+x.toFixed(1)+'" y="'+y.toFixed(1)+'" fill="'+colors[k]+'">'+escapeHtml(fmt0.format(v))+'</text>';
  }).join('')).join('');
  const axisLabels = series.map((r,i)=> (series.length <= 8 || i === 0 || i === series.length-1 || i % Math.ceil(series.length/6)===0)
    ? '<text class="axis" text-anchor="'+(i===0?'start':i===series.length-1?'end':'middle')+'" x="'+xFor(i).toFixed(1)+'" y="'+(h-8)+'">'+escapeHtml(r.label)+'</text>'
    : '').join('');
  const hitRects = series.map((r,i) => {
    const prev = i === 0 ? padL : (xFor(i - 1) + xFor(i)) / 2;
    const next = i === series.length - 1 ? (w - padR) : (xFor(i) + xFor(i + 1)) / 2;
    const tip = [r.label].concat(keys.map(k => labels[k] + '：' + money(r[k]))).concat(['成本覆盖：' + pct(r.coverageRate), r.beforeStorage ? '口径：未扣月仓储' : '口径：已扣分摊月仓储']).join('\\n');
    return '<rect class="chart-hit" x="'+prev.toFixed(1)+'" y="'+padT+'" width="'+Math.max(8, next-prev).toFixed(1)+'" height="'+(h-padT-padB)+'" data-tip="'+escapeHtml(tip)+'"></rect>';
  }).join('');
  const latest = series.at(-1) || {};
  const note = series.some(x => x.beforeStorage) ? '当前筛选到单店或货号，展示未扣仓储费的商品经营利润；仓储费只在月度总计/分组口径按净成交额分摊扣除。' : '月度总计与分组已扣按净成交额分摊的月仓储费。';
  const sliceNote = monthSliceNote(range);
  return '<div class="line-chart">'+
    '<svg viewBox="0 0 '+w+' '+h+'" role="img" aria-label="月利润趋势">'+gridTicks+
      '<line class="axis-line" x1="'+padL+'" y1="'+padT+'" x2="'+padL+'" y2="'+(h-padB)+'"></line>'+
      '<line class="axis-line" x1="'+padL+'" y1="'+(h-padB)+'" x2="'+(w-padR)+'" y2="'+(h-padB)+'"></line>'+
      lines+valueLabels+axisLabels+hitRects+
    '</svg><div class="chart-tip" aria-hidden="true"></div>'+
    '<div class="chart-legend">'+keys.map(k=>'<span><i style="--c:'+colors[k]+'"></i>'+labels[k]+'：'+money(latest[k] || 0)+'</span>').join('')+'</div>'+
    '<p class="sub">时间段：'+escapeHtml(range.start)+' 至 '+escapeHtml(range.end)+'；'+escapeHtml(note)+(sliceNote ? ' '+escapeHtml(sliceNote) : '')+'</p>'+
  '</div>';
}
function homeSalesTrendSvg(){
  const series = DATA.trend?.salesSeries || [];
  if (series.length < 2) {
    const s = salesScopeSummary();
    const dayReady = s.days >= 2 ? '已具备' : '还差 '+num(Math.max(0, 2 - s.days))+' 天';
    const weekReady = s.days >= 7 ? '已具备' : '还差 '+num(Math.max(0, 7 - s.days))+' 天';
    const monthReady = s.days >= 30 ? '已具备' : '还差 '+num(Math.max(0, 30 - s.days))+' 天';
    return '<div class="brief-grid">'+
      '<div class="brief"><span>已入仓销售日</span><strong>'+num(s.days)+' 天</strong></div>'+
      '<div class="brief"><span>日环比</span><strong>'+dayReady+'</strong></div>'+
      '<div class="brief"><span>7 日趋势</span><strong>'+weekReady+'</strong></div>'+
      '<div class="brief"><span>30 日预警</span><strong>'+monthReady+'</strong></div>'+
    '</div><p class="sub">首页总盘已经显示今日和本月金额，这里只说明趋势是否够数据；连续跑满 2/7/30 天后再启用日环比、周趋势和长期预警。</p>';
  }
  const vals = series.map(x => Number(x.sales_sar || 0));
  const min = Math.min(...vals), max = Math.max(...vals), span = Math.max(1, max - min);
  const w = 640, h = 170, pad = 22;
  const points = vals.map((v,i) => {
    const x = pad + (i / Math.max(1, vals.length - 1)) * (w - pad * 2);
    const y = pad + (1 - (v - min) / span) * (h - pad * 2);
    return [x,y];
  });
  const line = points.map(p => p.map(n => n.toFixed(1)).join(',')).join(' ');
  const area = pad+','+(h-pad)+' '+line+' '+(w-pad)+','+(h-pad);
  return '<div class="sparkline-card"><svg viewBox="0 0 '+w+' '+h+'" role="img" aria-label="销售趋势">'+
    '<polyline class="metric-area" points="'+area+'"></polyline><polyline class="metric-line" points="'+line+'"></polyline>'+
    points.map((p,i)=>'<circle class="metric-point" cx="'+p[0].toFixed(1)+'" cy="'+p[1].toFixed(1)+'" r="4"><title>'+escapeHtml(series[i].date+' '+money(series[i].sales_sar))+'</title></circle>').join('')+
    '<text class="metric-axis" x="'+pad+'" y="'+(h-4)+'">'+escapeHtml(series[0].date || '')+'</text><text class="metric-axis" text-anchor="end" x="'+(w-pad)+'" y="'+(h-4)+'">'+escapeHtml(series[series.length-1].date || '')+'</text>'+
  '</svg></div>';
}
function renderHomeDashboard(){
  const selectedRange = ensureDateRange();
  syncHomeScopeControls();
  ensureRankWindow();
  syncUrlHash();
  const rankSummary = {start_date:selectedRange.start, end_date:selectedRange.end};
  const storeRankRows = aggregateHomeStores(selectedRange.start, selectedRange.end);
  const productRankRows = aggregateHomeProducts(selectedRange.start, selectedRange.end);
  const storeBySales = [...storeRankRows].sort((a,b)=>Number(b.sales_sar||0)-Number(a.sales_sar||0));
  const storeByQty = [...storeRankRows].sort((a,b)=>Number(b.quantity||0)-Number(a.quantity||0));
  const productBySales = [...productRankRows].sort((a,b)=>Number(b.sales_sar||0)-Number(a.sales_sar||0));
  const productByQty = [...productRankRows].sort((a,b)=>Number(b.quantity||0)-Number(a.quantity||0));
  const domainCounts = (DATA.actions || []).reduce((acc,a)=>{ const k = domainName(a.action_domain || 'other'); acc[k]=(acc[k]||0)+1; return acc; }, {});
  const domainRows = Object.entries(domainCounts).map(([label,count]) => ({label,count})).sort((a,b)=>b.count-a.count);
  $('homeDashboardTag').textContent = '当前时间段 ' + periodRangeText(rankSummary) + ' · ' + homeScopeSubtitle();
  renderFloatingRangeToolbar();
  const groupEl = $('groupOverview');
  if (groupEl) groupEl.innerHTML = '';
  renderKpis();
  $('homeDashboard').innerHTML =
    '<div class="dashboard-section-title trend-panel-head"><div><h3>趋势</h3><div class="sub">日趋势默认近 30 天，月趋势默认近 6 个月；选择店铺、分组或货号后，曲线自动切成对应范围。</div></div>'+trendMetricButtons()+'</div>'+
    '<div class="trend-stack">'+
      panel('日趋势 · '+TREND_METRICS[trendMetricKey()].label, storeFilterKind().type === 'all' && !productScopeQuery() ? '总计 / DSY / LGM 三条线。' : homeScopeSubtitle(), renderMetricLineChart('day'))+
      panel('月趋势 · '+TREND_METRICS[trendMetricKey()].label, storeFilterKind().type === 'all' && !productScopeQuery() ? '按月聚合，总计 / DSY / LGM 三条线。' : '按月聚合：' + homeScopeSubtitle(), renderMetricLineChart('month'))+
    '</div>'+
    '<div class="dashboard-section-title"><h3>排行榜</h3><div class="sub">店铺只显示 DL/DX 等代号，货号显示归并后的标准货号；排行榜按上方时间段重算。</div></div>'+
    '<div class="dashboard-grid equal">'+
      panel('店铺净成交额排行', '当前范围 '+num(storeBySales.length)+' 店 · '+periodRangeText(rankSummary), rankList(storeBySales, {valueKey:'sales_sar', name:storeRankName, format:v=>money(v), subValue:r=>rmb(r.sales_sar), color:r=>groupColor(storeGroupKey(r)), meta:r=>'订单 '+num(r.orders)+' · 销量 '+num(r.quantity)+' 件 · '+num(r.days)+' 天', attr:r=>'data-home-store="'+escapeHtml(r.store_key || '')+'"'}))+
      panel('店铺净销量排行', '完整 '+num(storeByQty.length)+' 店 · 按净成交销量件数排序。', rankList(storeByQty, {valueKey:'quantity', name:storeRankName, format:v=>num(v)+' 件', subValue:r=>money(r.sales_sar), color:r=>groupColor(storeGroupKey(r)), meta:r=>'订单 '+num(r.orders)+' · 净成交 '+money(r.sales_sar)+' · '+num(r.days)+' 天', attr:r=>'data-home-store="'+escapeHtml(r.store_key || '')+'"'}))+
    '</div>'+
    '<div class="dashboard-grid equal" style="margin-top:16px">'+
      panel('产品净成交额排行', '当前范围 '+num(productBySales.length)+' 个标准货号 · 点击进入货号 360。', rankList(productBySales, {className:'product-rank', valueKey:'sales_sar', name:productRankName, format:v=>money(v), subValue:r=>rmb(r.sales_sar), color:()=> '#db2777', meta:r=>productRankMeta(r, '销量 '+num(r.quantity)+' 件 · 订单 '+num(r.orders)+' · 覆盖 '+num(r.store_count)+' 店 · '+num(r.days)+' 天'), attr:r=>'data-home-product="'+escapeHtml(r.standard_goods_sn || '')+'"'}))+
      panel('产品净销量排行', '完整 '+num(productByQty.length)+' 个标准货号 · 按净成交销量件数排序。', rankList(productByQty, {className:'product-rank', valueKey:'quantity', name:productRankName, format:v=>num(v)+' 件', subValue:r=>money(r.sales_sar), color:()=> '#a855f7', meta:r=>productRankMeta(r, '净成交 '+money(r.sales_sar)+' · 订单 '+num(r.orders)+' · 覆盖 '+num(r.store_count)+' 店 · '+num(r.days)+' 天'), attr:r=>'data-home-product="'+escapeHtml(r.standard_goods_sn || '')+'"'}))+
    '</div>'+
    '<div class="dashboard-section-title"><h3>动作与风险</h3><div class="sub">首页只看结构，具体处理进动作池。</div></div>'+
    '<div class="dashboard-grid equal">'+
      panel('动作结构', '动作池精选清单的业务域分布。', homeBarList(domainRows, 'count', 'label', {format:v=>num(v)+' 条', color:()=> '#0891b2', attr:r=>'data-home-domain="'+escapeHtml(r.label || '')+'"'} )+'<button class="btn" style="margin-top:12px" data-home-actions="1">进入今日动作池</button>')+
      panel('趋势准备', '只说明当前是否具备趋势分析条件，不重复展示净成交额。', homeSalesTrendSvg())+
    '</div>';
  bindRangeToolbarControls();
  document.querySelectorAll('[data-home-store]').forEach(btn => btn.addEventListener('click', () => {
    state.store = btn.dataset.homeStore || '';
    state.q = '';
    state.product = '';
    clearActionOnlyFilters();
    jumpToTab('stores', {keepFilters:true});
    renderAll();
  }));
  document.querySelectorAll('[data-home-product]').forEach(btn => btn.addEventListener('click', () => {
    focusProductQueryFromHome(btn.dataset.homeProduct || '');
    clearActionOnlyFilters();
    jumpToTab('products', {keepFilters:true});
    renderAll();
  }));
  document.querySelectorAll('[data-home-actions]').forEach(btn => btn.addEventListener('click', () => {
    state.store = '';
    state.product = '';
    state.q = '';
    jumpToTab('actions', {keepFilters:true});
    renderAll();
  }));
  document.querySelectorAll('[data-home-domain]').forEach(btn => btn.addEventListener('click', () => {
    const label = btn.dataset.homeDomain || '';
    const row = (DATA.actions || []).find(a => domainName(a.action_domain || 'other') === label);
    state.domain = row?.action_domain || '';
    state.store = '';
    state.product = '';
    state.q = '';
    jumpToTab('actions', {keepFilters:true});
    renderAll();
  }));
  document.querySelectorAll('[data-trend-metric]').forEach(btn => btn.addEventListener('click', () => {
    state.trendMetric = btn.dataset.trendMetric || 'sales';
    renderAll();
  }));
}

function renderFilters(){
  const stores = orderedStoreCodes();
  const storeOptions = '<option value="">全部店铺</option><option value="GROUP:DSY">DSY 组</option><option value="GROUP:LGM">LGM 组</option>' + stores.map(s => '<option value="'+s+'">'+s+'</option>').join('');
  $('storeFilter').innerHTML = storeOptions;
  if ($('homeStoreFilter')) $('homeStoreFilter').innerHTML = storeOptions;
  const domains = [...new Set((DATA.actions || []).map(a => a.action_domain))].sort();
  $('domainFilter').innerHTML = '<option value="">全部业务域</option>' + domains.map(d => '<option value="'+d+'">'+domainName(d)+'</option>').join('');
  const formatStamp = value => {
    if (!value) return '-';
    const d = new Date(value);
    return d.toLocaleDateString('zh-CN') + ' ' + d.toLocaleTimeString('zh-CN', {hour12:false});
  };
  $('generatedAt').textContent = formatStamp(DATA.generatedAt);
  const C_TEXT = {
    noPreciseTime:'\u6682\u65e0\u7cbe\u786e\u65f6\u95f4',
    update:'\u66f4\u65b0\uff1a',
    updateTime:'\u66f4\u65b0\u65f6\u95f4\uff1a',
    sales:'\u9500\u552e/\u8ba2\u5355\u6570\u636e',
    business:'\u552e\u540e/\u5e93\u5b58/\u8d22\u52a1\u6570\u636e',
    link:'\u94fe\u63a5\u8868\u73b0\u6570\u636e',
    colon:'\uff1a'
  };
  const shortTs = value => value ? new Date(value).toLocaleString('zh-CN') : C_TEXT.noPreciseTime;
  const dataStamp = (date, updatedAt) => updatedAt ? formatStamp(updatedAt) : (date || '-');
  $('salesDate').textContent = dataStamp(DATA.dates?.salesDate, DATA.dates?.salesUpdatedAt);
  $('businessDate').textContent = dataStamp(DATA.dates?.businessDate, DATA.dates?.businessUpdatedAt);
  $('linkDate').textContent = dataStamp(DATA.dates?.linkDate, DATA.dates?.linkUpdatedAt);
  if ($('manualCostDate')) {
    const costTs = DATA.dates?.manualCostFileUpdatedAt || DATA.dates?.manualCostUpdatedAt || DATA.dates?.manualStorageUpdatedAt || '';
    $('manualCostDate').textContent = costTs ? formatStamp(costTs) : '-';
    const costFiles = Array.isArray(DATA.dates?.manualCostFiles) ? DATA.dates.manualCostFiles : [];
    const costFileLine = costFiles.length ? costFiles.map(file => String(file.file || '') + '：' + shortTs(file.updatedAt)).join('\\n') : '-';
    $('manualCostDate').title = '成本文件修改：' + (DATA.dates?.manualCostFileUpdatedAt ? shortTs(DATA.dates.manualCostFileUpdatedAt) : '-') + '\\n成本入仓刷新：' + (DATA.dates?.manualCostUpdatedAt ? shortTs(DATA.dates.manualCostUpdatedAt) : '-') + '\\n月仓储费：' + (DATA.dates?.manualStorageUpdatedAt ? shortTs(DATA.dates.manualStorageUpdatedAt) : '-') + '\\n\\n文件明细：\\n' + costFileLine;
  }
  if ($('etDate')) {
    $('etDate').textContent = DATA.dates?.etUpdatedAt ? formatStamp(DATA.dates.etUpdatedAt) : '-';
    $('etDate').title = 'ET 货代仓最近抓取：' + (DATA.dates?.etUpdatedAt ? shortTs(DATA.dates.etUpdatedAt) : '-') + '\\n批次：' + (DATA.dates?.etLatestBatchId || '-');
  }
  ['salesUpdatedAt','businessUpdatedAt','linkUpdatedAt'].forEach(id => {
    const el = $(id);
    if (el) {
      el.textContent = '';
      el.hidden = true;
    }
  });
  const dateTitle = (label, date, updatedAt) => {
    const ts = shortTs(updatedAt);
    return label + C_TEXT.colon + (date || '-') + '\\n' + C_TEXT.updateTime + ts;
  };
  $('salesDate').title = dateTitle(C_TEXT.sales, DATA.dates?.salesDate, DATA.dates?.salesUpdatedAt);
  $('businessDate').title = dateTitle(C_TEXT.business, DATA.dates?.businessDate, DATA.dates?.businessUpdatedAt);
  $('linkDate').title = dateTitle(C_TEXT.link, DATA.dates?.linkDate, DATA.dates?.linkUpdatedAt);
  const a = DATA.audit;
  if (!a) $('auditState').innerHTML = '<span class="audit-warn">未找到体检文件</span>';
  else if (a.ok && !a.warnings && !a.errors) $('auditState').innerHTML = '<span class="audit-ok">通过</span>';
  else if (a.errors) $('auditState').innerHTML = '<span class="audit-bad">'+a.errors+' 个错误</span>';
  else $('auditState').innerHTML = '<span class="audit-warn">'+a.warnings+' 个提醒</span>';
}

function bindChartTooltips(){
  document.querySelectorAll('.line-chart').forEach(chart => {
    const tip = chart.querySelector('.chart-tip');
    if (!tip || tip.dataset.bound === '1') return;
    tip.dataset.bound = '1';
    chart.querySelectorAll('.chart-hit').forEach(hit => {
      hit.addEventListener('mousemove', e => {
        const text = hit.getAttribute('data-tip') || '';
        const parts = text.split('\\n');
        tip.innerHTML = '<strong>'+escapeHtml(parts[0] || '-')+'</strong>' + parts.slice(1).map(x => '<div>'+escapeHtml(x).replace(/：/, '：<b>')+'</b></div>').join('');
        tip.style.display = 'block';
        tip.style.left = Math.min(window.innerWidth - 230, e.clientX + 14) + 'px';
        tip.style.top = Math.min(window.innerHeight - 150, e.clientY + 14) + 'px';
      });
      hit.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    });
  });
}
function collectDataWarnings(){
  const warnings = [];
  const d = DATA.dates || {};
  if (d.linkDate && d.salesDate && d.linkDate < d.salesDate) {
    warnings.push('链接数据日 ' + d.linkDate + ' 早于销售日 ' + d.salesDate + '。这通常表示链接同步还没跑完或本次 BI 使用了最近可用链接快照。');
  }
  if (d.linkDate && d.businessDate && d.linkDate < d.businessDate) {
    warnings.push('链接数据日 ' + d.linkDate + ' 早于业务日 ' + d.businessDate + '。链接覆盖、下架/优化建议请按“链接日”口径理解。');
  }
  const auditWarnings = DATA.audit?.warningMessages || [];
  for (const w of auditWarnings) {
    if (/Link data is older than/.test(String(w))) continue;
    if (!warnings.includes(w)) warnings.push(w);
  }
  return warnings;
}
function renderDataWarnings(){
  const warnings = collectDataWarnings();
  const el = $('dataWarnings');
  if (!warnings.length) {
    el.classList.remove('show');
    el.innerHTML = '';
    return;
  }
  el.classList.add('show');
  el.innerHTML = '<h3>数据口径提醒</h3><ul>' + warnings.slice(0, 5).map(w => '<li>'+escapeHtml(w)+'</li>').join('') + '</ul>';
}
function domainHealthRows(){
  const d = DATA.dates || {};
  const k = DATA.kpi || {};
  const audit = DATA.audit || {};
  const pipeline = DATA.pipeline || {};
  const task = pipeline.task || {};
  const latestLog = pipeline.latestLog || {};
  const linkLag = d.linkDate && (d.salesDate || d.businessDate) && (d.linkDate < (d.salesDate || d.businessDate) || d.linkDate < (d.businessDate || d.salesDate));
  const financeCoverage = Number(DATA.financeOrders?.length || 0) > 0 ? 1 : 0;
  const taskPendingFirstRun = isTaskPendingFirstRun(task);
  const rows = [
    {
      key:'sales', label:'销售 / 订单', status: DATA.orders?.length ? 'good' : 'bad',
      value: money(k.salesSar) + ' / ' + num(k.orders) + ' 单',
      detail:'销售日 ' + (d.salesDate || '-') + '；订单商品行 ' + num(DATA.orders?.length || 0) + '。这是今天经营判断的主口径。',
      tab:'business'
    },
    {
      key:'link', label:'链接 / 覆盖', status: linkLag ? 'warn' : (DATA.links?.length ? 'good' : 'bad'),
      value: num(DATA.links?.length || 0) + ' SKC / ' + num(DATA.matrix?.length || 0) + ' 覆盖格',
      detail:'链接日 ' + (d.linkDate || '-') + (linkLag ? '，早于销售/业务日；链接建议按旧快照理解。' : '，和当前业务日一致或可用。'),
      tab:'links'
    },
    {
      key:'inventory', label:'库存展示', status: Number(k.lowStockProducts || 0) ? 'warn' : 'good',
      value: num(k.lowStockProducts) + ' 个低展示库存',
      detail:'使用后台正确展示库存口径；动作池只保留已上架且有销量/订单迹象的低库存项。',
      tab:'actions', focus:'inventory'
    },
    {
      key:'after', label:'售后 / 质量', status: DATA.afterSales?.length ? 'good' : 'warn',
      value: num(k.afterSalesCases) + ' 售后 / ' + num(k.lowStarComments) + ' 低星',
      detail:'业务日 ' + (d.businessDate || '-') + '；售后、低星和质量动作已进入诊断摘要与动作池。',
      tab:'business'
    },
    {
      key:'fulfill', label:'履约 / 营销', status: (DATA.waybills?.length || DATA.campaigns?.length) ? 'good' : 'warn',
      value: num(DATA.waybills?.length || 0) + ' 面单 / ' + num(DATA.campaigns?.length || 0) + ' 活动',
      detail:'用于判断取消包裹、履约异常和活动贡献；当前营销更多是辅助解释，不直接替代动作判断。',
      tab:'business'
    },
    {
      key:'finance', label:'财务明细', status: financeCoverage >= 15 ? 'good' : (financeCoverage > 0 ? 'warn' : 'bad'),
      value: num(DATA.financeOrders?.length || 0) + ' 在途单 / ' + num(DATA.financeGoods?.length || 0) + ' 商品',
      detail: financeCoverage > 0 ? 'gsfs 明细当前覆盖 HL 1/' + num(TOTAL_STORE_COUNT) + ' 店；其它店未接入前，不要把财务明细空值当 0。' : '暂未抓到 gsfs 财务明细。',
      tab:'business'
    },
    {
      key:'actions', label:'今日动作池', status: DATA.actions?.length ? 'good' : 'warn',
      value: num(DATA.actions?.length || 0) + ' 条精选动作',
      detail:'动作池是可处理清单，不是全量异常；当前覆盖链接、售后、质量、库存。',
      tab:'actions'
    },
    {
      key:'automation', label:'自动刷新', status: audit.errors ? 'bad' : (taskPendingFirstRun || audit.warnings ? 'warn' : 'good'),
      value: taskPendingFirstRun ? '待首次运行' : (latestLog.status ? pipelineStatusLabel(latestLog.status) : (task.State || '-')),
      detail: taskPendingFirstRun ? '计划任务已就绪，但 07:00 首次正式自动运行还没发生。' : ('最新日志 ' + (latestLog.file || '-') + '；任务状态 ' + (task.State || '-') + '。'),
      tab:'system'
    }
  ];
  return rows;
}
function renderDataReliability(){
  const rows = domainHealthRows();
  const good = rows.filter(x => x.status === 'good').length;
  const warn = rows.filter(x => x.status === 'warn').length;
  const bad = rows.filter(x => x.status === 'bad').length;
  const score = bad ? '有阻断' : warn ? '可用，有提醒' : '全部通过';
  $('dataReliabilityScore').textContent = score + ' · ' + good + '/' + rows.length;
  $('dataReliabilityScore').className = 'tag ' + (bad ? 'high' : warn ? 'mid' : 'good');
  $('dataReliability').innerHTML =
    '<div class="health-grid">' + rows.map(r =>
      '<article class="health-card '+r.status+'">'+
        '<div class="row1"><span class="tag '+(r.status === 'good' ? 'good' : r.status === 'bad' ? 'high' : 'mid')+'">'+(r.status === 'good' ? '可用' : r.status === 'bad' ? '异常' : '提醒')+'</span><span class="mono">'+escapeHtml(r.key)+'</span></div>'+
        '<h4>'+escapeHtml(r.label)+'</h4>'+
        '<p><b>'+escapeHtml(r.value)+'</b></p>'+
        '<p>'+escapeHtml(r.detail)+'</p>'+
        '<div class="health-actions"><button class="status-btn" data-health-tab="'+escapeHtml(r.tab || 'overview')+'" data-health-focus="'+escapeHtml(r.focus || '')+'">查看</button></div>'+
      '</article>'
    ).join('') + '</div>'+
    '<div class="brief-grid">'+
      '<div class="brief"><span>可直接判断</span><strong>'+num(good)+'</strong></div>'+
      '<div class="brief"><span>需看提醒</span><strong>'+num(warn)+'</strong></div>'+
      '<div class="brief"><span>阻断异常</span><strong>'+num(bad)+'</strong></div>'+
      '<div class="brief"><span>当前建议</span><strong>'+(bad ? '先修数据' : warn ? '带口径看' : '正常作战')+'</strong></div>'+
    '</div>';
}
function trendSparkline(series, metric){
  const values = (series || []).map(x => Number(x?.[metric] || 0)).filter(x => Number.isFinite(x));
  if (values.length < 2) return '<div class="trend-mini"><p class="muted">还没有连续曲线</p></div>';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(1, max - min);
  const step = values.length > 1 ? 100 / (values.length - 1) : 100;
  const pts = values.map((v, i) => {
    const x = Math.round(i * step * 100) / 100;
    const y = Math.round((34 - ((v - min) / span) * 28) * 100) / 100;
    return [x, y];
  });
  const line = pts.map(p => p.join(',')).join(' ');
  const area = '0,38 ' + line + ' 100,38';
  return '<div class="trend-mini" aria-hidden="true"><svg viewBox="0 0 100 38" preserveAspectRatio="none"><polyline class="trend-area" points="'+area+'"></polyline><polyline class="trend-line" points="'+line+'"></polyline></svg></div>';
}
function trendReadinessRows(){
  const t = DATA.trend || {};
  return [
    {
      key:'sales', label:'销售趋势', days:Number(t.salesDays || 0), need:7, series:t.salesSeries || [], metric:'sales_sar',
      value:(t.salesSeries || []).length ? money((t.salesSeries || []).at(-1)?.sales_sar) : '-',
      detail:'用于销售日环比、店铺下滑、货号销售趋势。至少 2 天才能做日环比，7 天后才适合做稳定趋势。',
      tab:'business'
    },
    {
      key:'link', label:'链接表现趋势', days:Number(t.linkDays || 0), need:7, series:t.linkSeries || [], metric:'sale_cnt',
      value:(t.linkSeries || []).length ? num((t.linkSeries || []).at(-1)?.sale_cnt) + ' 链接销量' : '-',
      detail:'用于曝光、访客、点击率、支付率和链接下滑判断。链接日滞后时，趋势也按链接日理解。',
      tab:'links'
    },
    {
      key:'business', label:'经营财务摘要趋势', days:Number(t.businessDays || 0), need:7, series:t.businessSeries || [], metric:'trade_amount_sar',
      value:(t.businessSeries || []).length ? money((t.businessSeries || []).at(-1)?.trade_amount_sar) : '-',
      detail:'用于后台首页财务摘要、在途、待结算和交易额趋势判断。',
      tab:'business'
    },
    {
      key:'afterSales', label:'售后趋势', days:Number(t.afterSalesDays || 0), need:7, series:t.afterSalesSeries || [], metric:'case_count',
      value:(t.afterSalesSeries || []).length ? num((t.afterSalesSeries || []).at(-1)?.case_count) + ' 售后行' : '-',
      detail:'用于售后集中、退货金额异常、质量风险是否持续放大。',
      tab:'business'
    },
    {
      key:'finance', label:'gsfs 财务明细趋势', days:Number(t.financeDays || 0), need:7, series:t.financeSeries || [], metric:'estimate_income_sar',
      value:(t.financeSeries || []).length ? money((t.financeSeries || []).at(-1)?.estimate_income_sar) : '-',
      detail:'目前只覆盖 HL 财务明细；扩到全部店前，只能作为阶段性财务趋势，不代表全店。',
      tab:'business'
    }
  ];
}
function renderTrendReadiness(){
  const rows = trendReadinessRows();
  const dayReady = rows.filter(r => r.days >= 2).length;
  const weekReady = rows.filter(r => r.days >= 7).length;
  const monthReady = rows.filter(r => r.days >= 30).length;
  const allDays = rows.map(r => r.days);
  const minDays = Math.min(...allDays);
  const tagText = weekReady ? '可做周趋势 · ' + weekReady + '/' + rows.length : dayReady ? '可做日环比 · ' + dayReady + '/' + rows.length : '单日观察 · 0/' + rows.length;
  $('trendReadinessScore').textContent = tagText;
  $('trendReadinessScore').className = 'tag ' + (weekReady ? 'good' : dayReady ? 'mid' : 'mid');
  const storeChanges = DATA.trend?.storeSalesChange || [];
  const unavailable = [];
  if (dayReady < rows.length) unavailable.push('日环比：仍有 '+(rows.length - dayReady)+' 个数据域不足 2 天。');
  if (weekReady < rows.length) unavailable.push('7 日趋势：仍有 '+(rows.length - weekReady)+' 个数据域不足 7 天。');
  if (monthReady < rows.length) unavailable.push('30 日下滑预警：仍有 '+(rows.length - monthReady)+' 个数据域不足 30 天。');
  $('trendReadiness').innerHTML =
    '<div class="trend-grid">' + rows.map(r => {
      const pctReady = Math.min(100, Math.round((r.days / r.need) * 100));
      const status = r.days >= 7 ? 'ready' : 'wait';
      const canDo = r.days >= 7 ? '可做 7 日趋势' : r.days >= 2 ? '可做日环比，暂不做周趋势' : '只做横截面，不做趋势';
      const gap = Math.max(0, r.need - r.days);
      return '<article class="trend-card '+status+'">'+
        '<div class="row1"><span class="tag '+(r.days >= 7 ? 'good' : 'mid')+'">'+canDo+'</span><span class="mono">'+escapeHtml(r.key)+'</span></div>'+
        '<h4>'+escapeHtml(r.label)+'</h4>'+
        '<p><b>'+escapeHtml(r.value)+'</b></p>'+
        '<div class="maturity"><i style="width:'+pctReady+'%"></i></div>'+
        '<p>已积累 <b>'+num(r.days)+'</b> 天；稳定趋势目标 <b>'+num(r.need)+'</b> 天'+(gap ? '，还差 <b>'+num(gap)+'</b> 天。' : '。')+'</p>'+
        '<p>'+escapeHtml(r.detail)+'</p>'+
        trendSparkline(r.series, r.metric)+
        '<div class="health-actions"><button class="status-btn" data-trend-tab="'+escapeHtml(r.tab || 'overview')+'">查看相关数据</button></div>'+
      '</article>';
    }).join('') + '</div>'+
    '<div class="brief-grid" style="margin-top:14px">'+
      '<div class="brief"><span>最短积累</span><strong>'+num(minDays)+' 天</strong></div>'+
      '<div class="brief"><span>可做日环比</span><strong>'+num(dayReady)+' / '+num(rows.length)+'</strong></div>'+
      '<div class="brief"><span>可做 7 日趋势</span><strong>'+num(weekReady)+' / '+num(rows.length)+'</strong></div>'+
      '<div class="brief"><span>可做 30 日预警</span><strong>'+num(monthReady)+' / '+num(rows.length)+'</strong></div>'+
    '</div>'+
    '<div class="split" style="margin-top:14px">'+
      '<article class="health-card warn"><div class="row1"><span class="tag mid">当前边界</span><span class="mono">no fake trend</span></div><h4>现在不做假趋势图</h4><p>'+escapeHtml(unavailable.join(' ') || '趋势数据已经具备基础条件。')+'</p><p class="next">等 07:00 自动任务连续积累多天后，这里会自动从“准备雷达”升级为真实趋势诊断。</p></article>'+
      '<article class="health-card '+(storeChanges.length ? 'good' : 'warn')+'"><div class="row1"><span class="tag '+(storeChanges.length ? 'good' : 'mid')+'">'+(storeChanges.length ? '已可计算' : '等待数据')+'</span><span class="mono">store change</span></div><h4>店铺销售波动</h4>'+
        (storeChanges.length ? '<p>'+storeChanges.slice(0,4).map(x => escapeHtml(x.store_key)+': '+money(x.change_sar)+'（'+(x.change_pct == null ? '-' : x.change_pct + '%')+'）').join('<br>')+'</p>' : '<p>目前销售仓只有 1 天切片，还不能计算店铺环比波动。</p>')+
      '</article>'+
    '</div>';
}
function backendDataMapRows(){
  const d = DATA.dates || {};
  const k = DATA.kpi || {};
  return [
    {
      domain:'销售订单域', menu:'订单 > 我的订单', route:'#/gsp/order-management/list', endpoint:'/gsp/orderPlus/listOrder',
      status: DATA.orders?.length ? 'good' : 'bad',
      coverage:'' + num(TOTAL_STORE_COUNT) + ' 店；订单商品行 ' + num(DATA.orders?.length || 0),
      use:'净成交额、净成交订单数、货号/SKC 净销量；作为经营看板主口径。',
      tab:'business'
    },
    {
      domain:'商品链接域', menu:'商品 > 商品列表 / 数据 > 商品分析', route:'#/spmp/commdities/list；#/sbn/merchandise',
      endpoint:'/spmp-api-prefix/spmp/product/list；/sbn/new_goods/get_skc_diagnose_list',
      status: DATA.links?.length ? ((DATA.dates?.linkDate && DATA.dates?.salesDate && DATA.dates.linkDate < DATA.dates.salesDate) ? 'warn' : 'good') : 'bad',
      coverage:'链接 ' + num(DATA.links?.length || 0) + '；覆盖格 ' + num(DATA.matrix?.length || 0) + '；链接日 ' + (d.linkDate || '-'),
      use:'上架覆盖、待上架卡点、优化/下架候选、曝光点击支付漏斗。',
      gap:'链接快照日滞后时，补链/下架/优化建议仍按链接日理解。',
      next:'先观察 05:30 链接同步；如果继续滞后，优先排查链接抓取日志和店铺登录态，再刷新 BI。',
      tab:'links'
    },
    {
      domain:'正确展示库存域', menu:'商品列表库存接口 / 库存菜单待深挖', route:'#/spmp/commdities/list；#/gsp/inventory-management/storage-age',
      endpoint:'/spmp-api-prefix/spmp/product/query_msc_stock_for_released_page；/gsp/storage/stockAge/list',
      status: 'warn',
      coverage:'当前低展示库存 ' + num(k.lowStockProducts) + '；动作池精选库存 ' + num((DATA.actions || []).filter(x => x.action_domain === 'inventory').length),
      use:'展示库存预警；已停用备货信息假库存。库龄列表仍作为后续更完整库存域。',
      gap:'当前已用商品列表正确展示库存，库龄列表仍需要继续补权限/字段。',
      next:'短期只用精选库存动作；中期补库龄列表、库龄、仓库、可售天数等字段后再扩展库存诊断。',
      tab:'actions',
      focus:'inventory'
    },
    {
      domain:'售后退货域', menu:'订单 > 退货退款', route:'#/gsp/order-management/after-sales-list',
      endpoint:'/gsp/aftersalesOrder/list；/gsp/aftersalesOrder/statistic；/gsp/refundReason/listGroup',
      status: DATA.afterSales?.length ? 'good' : 'warn',
      coverage:'售后明细 ' + num(DATA.afterSales?.length || 0) + '；业务日 ' + (d.businessDate || '-'),
      use:'退货退款、退货原因、售后集中货号、质量/描述问题判断。',
      tab:'business'
    },
    {
      domain:'履约面单域', menu:'订单 > 发货面单 / 数据 > 履约分析', route:'#/gsp/order-management/deliver-waybill-list；#/mgs/performance_time_analysis',
      endpoint:'/gsp/place/order/deliver/print/list；/mgs-api-prefix/estimate/newPerformanceIndicator',
      status: DATA.waybills?.length ? 'good' : 'warn',
      coverage:'面单 ' + num(DATA.waybills?.length || 0) + '；履约异常 ' + num(k.waybillExceptions),
      use:'取消包裹、面单、揽收/签收、履约异常对销售与售后的影响。',
      tab:'business'
    },
    {
      domain:'质量评价域', menu:'商品 > 商品质量 / 商品评价', route:'#/pqmp/commoditiesQuality/list；#/mgs/store-management/product-feedback',
      endpoint:'/pqmp-api-prefix/pqmp/quality_analysis/new_list；/mgs-api-prefix/goods/comment/list',
      status: DATA.afterSales?.length ? 'good' : 'warn',
      coverage:'低星评价 ' + num(k.lowStarComments) + '；质量/售后动作 ' + num((DATA.actions || []).filter(x => x.action_domain === 'quality' || x.action_domain === 'after_sales').length),
      use:'质量等级、差评、质量退货率、评价承接，决定优化还是下架。',
      tab:'actions',
      focus:'quality'
    },
    {
      domain:'营销活动域', menu:'数据 > 营销分析', route:'#/sbn/marketing',
      endpoint:'/sbn/marketing/overview；/sbn/marketing/campaign/list',
      status: DATA.campaigns?.length ? 'good' : 'warn',
      coverage:'活动 ' + num(DATA.campaigns?.length || 0),
      use:'解释曝光/销量变化，识别活动贡献和可复制放量机会。',
      tab:'business'
    },
    {
      domain:'财务收入域', menu:'财务 > 我的收入', route:'#/gsfs/finance-management/list',
      endpoint:'/gsfs/finance/platform/incomeOverview；/gsfs/finance/platform/noFinishOrderList',
      status: DATA.financeOrders?.length ? 'warn' : 'bad',
      coverage:'HL 1/' + num(TOTAL_STORE_COUNT) + ' 店；在途单 ' + num(DATA.financeOrders?.length || 0) + '；商品 ' + num(DATA.financeGoods?.length || 0),
      use:'在途收入、账期、财务商品与订单互证；其它店待主账号/权限扩展。',
      gap:'财务明细目前只覆盖 HL，不能把其它店财务明细视为 0。',
      next:'后续逐店切主账号或补财务权限，把 gsfs 在途订单和商品层扩到全部店。',
      tab:'business'
    },
    {
      domain:'市场机会域', menu:'数据 > 市场分析', route:'#/sbn/market-analysis',
      endpoint:'待系统化接入',
      status:'warn',
      coverage:'已完成后台盘点，尚未入仓',
      use:'后续用于热搜词、缺失货盘、热销排行和类目机会。',
      gap:'市场分析已纳入后台地图，但尚未沉淀为事实表。',
      next:'先确认可稳定抓取的热搜词、热销榜、类目机会，再设计机会事实表和增长规则。',
      tab:'system'
    },
    {
      domain:'消息下载域', menu:'消息中心 / 下载中心', route:'#/ssls/message；#/download-management/list',
      endpoint:'/ssls/tab/getMsgCategoryInfo 等候选',
      status:'warn',
      coverage:'已完成后台盘点，尚未作为核心事实入仓',
      use:'后续收集商品预警、违规处罚、营销活动和导出任务状态。',
      gap:'消息/下载中心还只是候选信号，尚未进入每日诊断。',
      next:'优先接入商品预警、违规处罚、导出任务状态，再决定是否进入动作池。',
      tab:'system'
    }
  ];
}
function renderBackendDataMap(){
  const rows = backendDataMapRows();
  const good = rows.filter(x => x.status === 'good').length;
  const warn = rows.filter(x => x.status === 'warn').length;
  const bad = rows.filter(x => x.status === 'bad').length;
  const gaps = rows.filter(x => x.status !== 'good');
  $('backendMapScore').textContent = '已接入 ' + good + ' / 提醒 ' + warn + ' / 异常 ' + bad;
  $('backendMapScore').className = 'tag ' + (bad ? 'mid' : 'good');
  $('backendDataMap').innerHTML =
    '<div class="health-grid">' + rows.map(r =>
      '<article class="health-card '+r.status+'">'+
        '<div class="row1"><span class="tag '+(r.status === 'good' ? 'good' : r.status === 'bad' ? 'high' : 'mid')+'">'+(r.status === 'good' ? '已接入' : r.status === 'bad' ? '异常' : '待完善')+'</span><span class="mono">'+escapeHtml(r.route)+'</span></div>'+
        '<h4>'+escapeHtml(r.domain)+'</h4>'+
        '<p><b>'+escapeHtml(r.menu)+'</b></p>'+
        '<p class="mono">'+escapeHtml(r.endpoint)+'</p>'+
        '<p>'+escapeHtml(r.coverage)+'</p>'+
        '<p>'+escapeHtml(r.use)+'</p>'+
        '<div class="health-actions"><button class="status-btn" data-backend-tab="'+escapeHtml(r.tab || 'overview')+'" data-backend-focus="'+escapeHtml(r.focus || '')+'">看当前数据</button></div>'+
      '</article>'
    ).join('') + '</div>'+
    (gaps.length ? (
      '<div style="margin-top:16px">'+
        '<div class="row1" style="margin-bottom:10px"><h4 style="margin:0">待补数据路线图</h4><span class="tag mid">'+gaps.length+' 个待完善域</span></div>'+
        '<div class="path-grid">' + gaps.map(g =>
          '<article class="path-card">'+
            '<div class="row1"><strong>'+escapeHtml(g.domain)+'</strong><span class="tag '+(g.status === 'bad' ? 'high' : 'mid')+'">'+(g.status === 'bad' ? '异常' : '待完善')+'</span></div>'+
            '<p><b>缺口：</b>'+escapeHtml(g.gap || g.coverage || '-')+'</p>'+
            '<p class="next"><b>下一步：</b>'+escapeHtml(g.next || g.use || '-')+'</p>'+
            '<div class="health-actions"><button class="status-btn" data-backend-tab="'+escapeHtml(g.tab || 'overview')+'" data-backend-focus="'+escapeHtml(g.focus || '')+'">去看相关数据</button></div>'+
          '</article>'
        ).join('') + '</div>'+
      '</div>'
    ) : '');
}
function safeSetValue(id, value){
  const el = $(id);
  if (el) el.value = value || '';
}
function stateFromHash(){
  const raw = window.location.hash ? window.location.hash.slice(1) : '';
  if (!raw) return;
  const params = new URLSearchParams(raw);
  const next = {...state};
  if (!params.has('startDate') && !params.has('endDate') && !params.has('rangePreset')) {
    next.startDate = '';
    next.endDate = '';
    next.rangePreset = 'today';
  }
  for (const key of STATE_KEYS) {
    if (params.has(key)) next[key] = params.get(key) || (key === 'tab' ? 'overview' : key === 'focus' || key === 'insight' ? 'all' : key === 'rankPeriod' ? 'day' : '');
  }
  if (!['day','week','month','year'].includes(next.rankPeriod)) next.rankPeriod = 'day';
  if (!document.getElementById(next.tab)) next.tab = 'overview';
  state = next;
}
function hashFromState(){
  const params = new URLSearchParams();
  const actionOnlyKeys = new Set(['domain','risk','status','focus']);
  const actionIgnoredKeys = new Set(['startDate','endDate','rangePreset']);
  for (const key of STATE_KEYS) {
    if (actionOnlyKeys.has(key) && !isActionFilterTab()) continue;
    if (isActionFilterTab() && actionIgnoredKeys.has(key)) continue;
    const value = state[key];
    if (!value) continue;
    if ((key === 'tab' && value === 'overview') || ((key === 'focus' || key === 'insight') && value === 'all') || (key === 'rankPeriod' && value === 'day')) continue;
    params.set(key, value);
  }
  const s = params.toString();
  return s ? '#' + s : '';
}
function currentViewUrl(){
  const base = window.location.href.split('#')[0];
  return base + hashFromState();
}
function isTaskPendingFirstRun(task){
  return !!(task && task.exists && String(task.LastRunTime || '').startsWith('1999-'));
}
function parseLocalDateTimeText(text){
  if (!text || typeof text !== 'string') return null;
  const m = text.match(/^(\\d{4})-(\\d{2})-(\\d{2})[ T](\\d{2}):(\\d{2}):(\\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}
function taskDateFromEpochOrText(epochMs, text){
  const n = Number(epochMs);
  if (Number.isFinite(n) && n > 0) {
    const d = new Date(n);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return parseLocalDateTimeText(text || '');
}
function minutesBetween(a, b){
  if (!(a instanceof Date) || !(b instanceof Date)) return null;
  const v = Math.round((b.getTime() - a.getTime()) / 60000);
  return Number.isFinite(v) ? v : null;
}
function automationFirstRunSummary(task, latestLog){
  if (!task?.exists) {
    return {level:'bad', title:'自动任务未找到', detail: task?.error || '没有读到 SHEIN-BI-Daily-Pipeline-0700。', items:['先确认 Windows 计划任务是否存在。']};
  }
  const now = new Date();
  const nextRun = taskDateFromEpochOrText(task.NextRunEpochMs, task.NextRunTime || '');
  const lastRun = taskDateFromEpochOrText(task.LastRunEpochMs, task.LastRunTime || '');
  const pending = isTaskPendingFirstRun(task);
  const code = Number(task.LastTaskResult);
  const latestStatus = latestLog?.status || '';
  if (pending && !nextRun) {
    return {
      level:'warn',
      title:'等待首次自动运行',
      detail:'计划任务已就绪，但门户没有解析到明确的下次运行时间。',
      items:[
        '现在看到“尚未首跑”是正常状态。',
        '请以 Windows 计划任务里的下次运行时间为准。',
        '07:00 后刷新门户，确认是否出现真实上次运行时间和新日志。'
      ]
    };
  }
  if (pending && nextRun && now < nextRun) {
    const mins = minutesBetween(now, nextRun);
    return {
      level:'warn',
      title:'等待首次自动运行',
      detail:'计划任务已就绪，距离 ' + (task.NextRunTime || '07:00') + ' 约 ' + (mins == null ? '-' : num(mins)) + ' 分钟。',
      items:[
        '现在看到“尚未首跑”是正常状态。',
        '07:00 之后重新打开或刷新门户，系统状态页会显示真实上次运行时间。',
        '如果 07:00 后刷新后仍显示待首跑，再检查计划任务和最新日志。'
      ]
    };
  }
  if (pending && nextRun && now >= nextRun) {
    const minsLate = minutesBetween(nextRun, now);
    return {
      level:'bad',
      title:'已过计划时间但尚未首跑',
      detail:'距离计划运行时间已过约 ' + (minsLate == null ? '-' : num(minsLate)) + ' 分钟，但任务状态仍是待首跑。',
      items:[
        '先刷新门户或重新生成门户，确认是不是页面旧快照。',
        '再检查 Windows 计划任务是否被禁用、是否正在运行、是否有新日志。',
        '如果没有新日志，优先手动运行 scripts\\\\run_bi_daily_pipeline.ps1 排查。'
      ]
    };
  }
  if (!pending && code === 0) {
    return {
      level: latestStatus === 'success' ? 'good' : 'warn',
      title: latestStatus === 'success' ? '首次自动运行已通过' : '计划任务成功但流水线状态需复核',
      detail:'上次运行：' + (task.LastRunTime || '-') + '；最新流水线：' + (latestLog?.file || '-') + '。',
      items:[
        '计划任务结果码为 0。',
        latestStatus === 'success' ? '最新 BI 流水线日志为成功。' : '请确认最新流水线日志是否和这次计划任务对应。',
        '可以正常查看门户；若有 WARN，按数据口径提醒理解。'
      ]
    };
  }
  if (!pending && code === 267009) {
    return {
      level:'warn',
      title:'自动任务正在运行',
      detail:'上次运行：' + (task.LastRunTime || '-') + '；当前 Windows 结果码显示正在运行。',
      items:['等待流水线结束后刷新门户。', '若运行超过 90 分钟，需要检查是否卡在后台抓取或数据库入仓。']
    };
  }
  return {
    level:'bad',
    title:'自动任务结果异常',
    detail:'上次运行：' + (task.LastRunTime || '-') + '；结果码：' + (Number.isFinite(code) ? code : '-') + '。',
    items:['打开最新流水线日志排查。', '必要时手动运行 BI 每日流水线确认具体错误。']
  };
}
function taskLastRunText(task){
  return isTaskPendingFirstRun(task) ? '尚未首跑' : (task?.LastRunTime || '-');
}
function taskResultText(task){
  if (!task?.exists) return task?.error || '-';
  if (isTaskPendingFirstRun(task)) return '待首次运行';
  const code = Number(task.LastTaskResult);
  if (code === 0) return '成功';
  if (code === 267009) return '正在运行';
  if (code === 267011) return '尚未运行';
  return Number.isFinite(code) ? String(code) : '-';
}
function pipelineStatusLabel(status){
  if (status === 'success') return '成功';
  if (status === 'failed') return '失败';
  if (status === 'running_or_incomplete') return '运行中/未完成';
  if (status === 'missing') return '无日志';
  return status || '-';
}
function pipelineStabilitySummary(recentLogs, task, latestLog){
  const logs = Array.isArray(recentLogs) ? recentLogs : [];
  const total = logs.length;
  const success = logs.filter(x => x.status === 'success').length;
  const failed = logs.filter(x => x.status === 'failed').length;
  const incomplete = logs.filter(x => x.status === 'running_or_incomplete').length;
  const durations = logs.map(x => Number(x.durationSeconds)).filter(Number.isFinite);
  const avgDuration = durations.length ? Math.round(durations.reduce((a,b)=>a+b, 0) / durations.length) : null;
  const maxDuration = durations.length ? Math.max(...durations) : null;
  const warningTotal = logs.reduce((sum, x) => sum + Number(x.warningCount || 0), 0);
  const effectiveKeys = logs.map(x => {
    const e = x.effectiveDates || {};
    return [e.salesDate || '-', e.linkDate || '-', e.businessDate || '-'].join(' / ');
  }).filter(x => x !== '- / - / -');
  const uniqueEffective = Array.from(new Set(effectiveKeys));
  const latestStatus = latestLog?.status || '';
  const pendingFirstRun = isTaskPendingFirstRun(task);
  const successRate = total ? Math.round(success * 100 / total) : 0;
  let level = 'good';
  const notes = [];
  if (!total) {
    level = 'warn';
    notes.push('还没有可解析的 BI 流水线日志。');
  }
  if (pendingFirstRun) {
    level = level === 'bad' ? 'bad' : 'warn';
    notes.push('07:00 自动任务尚未首跑，当前稳定性主要来自手动验证日志。');
  }
  if (latestStatus && latestStatus !== 'success') {
    level = 'bad';
    notes.push('最近一次流水线不是成功状态，需要优先检查最新日志。');
  }
  if (failed || incomplete) {
    level = 'bad';
    notes.push('最近记录中存在失败或未完成流水线。');
  }
  if (warningTotal && level !== 'bad') {
    level = 'warn';
    notes.push('最近流水线有 WARN，当前不阻断，但早上看数前要先读口径提醒。');
  }
  if (uniqueEffective.length > 1) {
    level = level === 'bad' ? 'bad' : 'warn';
    notes.push('最近流水线使用过不同日期口径，说明存在补跑或链接日期兜底。');
  }
  if (!notes.length) notes.push('最近流水线都成功且口径一致，可以按当前门户判断。');
  return {
    total,
    success,
    failed,
    incomplete,
    successRate,
    avgDuration,
    maxDuration,
    warningTotal,
    uniqueEffectiveCount: uniqueEffective.length,
    latestEffective: effectiveKeys[0] || '-',
    level,
    notes,
  };
}
function syncUrlHash(){
  if (applyingHash) return;
  const next = hashFromState();
  if (window.location.hash !== next) history.replaceState(null, '', next || window.location.href.split('#')[0]);
}
function applyStateToControls(){
  safeSetValue('q', state.q);
  safeSetValue('productFilter', state.product);
  safeSetValue('homeProductFilter', state.product);
  safeSetValue('storeFilter', state.store);
  safeSetValue('homeStoreFilter', state.store);
  safeSetValue('domainFilter', isActionFilterTab() ? state.domain : '');
  safeSetValue('riskFilter', isActionFilterTab() ? state.risk : '');
  safeSetValue('statusFilter', isActionFilterTab() ? state.status : '');
  safeSetValue('rankWindowSelect', state.rankWindow);
  safeSetValue('rangeStart', state.startDate);
  safeSetValue('rangeEnd', state.endDate);
  document.body.dataset.currentTab = state.tab || 'overview';
  document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === state.tab));
  document.querySelectorAll('.section').forEach(s => s.classList.toggle('active', s.id === state.tab));
}
function activateTab(tab, opts = {}){
  state.tab = document.getElementById(tab) ? tab : 'overview';
  if (state.tab !== 'overview' && !opts.keepHomeFilters) {
    state.q = '';
    state.product = '';
    state.domain = '';
    state.risk = '';
    state.status = '';
    state.focus = 'all';
    state.insight = 'all';
    if (storeFilterKind().type === 'group') state.store = '';
  }
  if (opts.scroll) shouldScrollToActiveTab = true;
  applyStateToControls();
  syncUrlHash();
}
function clearActionOnlyFilters(){
  state.domain = '';
  state.risk = '';
  state.status = '';
  state.focus = 'all';
}
function jumpToTab(tab, opts = {}){
  activateTab(tab, {scroll: opts.scroll !== false, keepHomeFilters: opts.keepFilters === true});
  if (!isActionFilterTab() && opts.keepActionFilters !== true) {
    clearActionOnlyFilters();
    applyStateToControls();
    syncUrlHash();
  }
}
function focusCount(key){
  return (DATA.actions || []).filter(a => {
    if (!storeMatchesScope(a)) return false;
    const activeDomain = actionDomainActive();
    if (activeDomain && a.action_domain !== activeDomain) return false;
    if (!statusMatchAction(a)) return false;
    if (!productMatch(a)) return false;
    return focusMatchByKey(a, key);
  }).length;
}
function renderFocusBar(){
  if (!isActionFilterTab()) {
    const el = $('focusBar');
    if (el) el.innerHTML = '';
    return;
  }
  $('focusBar').innerHTML = focusDefs().map(f =>
    '<button class="focus-chip '+(state.focus === f.key ? 'active' : '')+'" data-focus="'+f.key+'" title="'+escapeHtml(f.hint)+'">'+
      '<span>'+f.label+'</span><small>'+focusCount(f.key)+'</small>'+
    '</button>'
  ).join('');
  document.querySelectorAll('[data-focus]').forEach(btn => btn.addEventListener('click', () => {
    state.focus = btn.dataset.focus;
    state.q = '';
    state.domain = '';
    state.risk = '';
    if (state.focus === 'inventory') state.domain = 'inventory';
    if (state.focus === 'after_sales') state.domain = 'after_sales';
    if (state.focus === 'quality') state.domain = 'quality';
    if (state.focus === 'retire') state.risk = 'retire';
    $('q').value = '';
    $('domainFilter').value = state.domain;
    $('riskFilter').value = state.risk;
    $('statusFilter').value = state.status;
    jumpToTab('actions', {keepFilters:true});
    applyStateToControls();
    renderAll();
  }));
}
function renderBattlePath(){
  const actions = DATA.actions || [];
  const count = (key) => actions.filter(a => focusMatchByKey(a, key)).length;
  const top = (key) => actions.filter(a => focusMatchByKey(a, key)).sort((a,b)=>Number(b.score||0)-Number(a.score||0)).slice(0,3);
  const cards = [
    ['先止损', 'retire', count('retire'), '下架/替换候选、长期无销量但有曝光、重复弱链接。先确认是否有替代链接。', top('retire')],
    ['补覆盖', 'supplement', count('supplement'), '有些店已卖、有些店缺上架链接的货号；全部店都没上架的不进这里。', top('supplement')],
    ['修承接', 'optimize', count('optimize'), '高访客低支付、有流量无销量、低点击等，优先改主图、价格、评价、活动承接。', top('optimize')],
    ['控风险', 'after_sales', count('after_sales') + count('quality') + count('inventory'), '售后、质量和已上架低展示库存，避免销售被售后或库存展示拖累。', [...top('after_sales'), ...top('quality'), ...top('inventory')].sort((a,b)=>Number(b.score||0)-Number(a.score||0)).slice(0,3)]
  ];
  $('battlePath').innerHTML = cards.map(c =>
    '<article class="path-card"><span class="domain">'+c[0]+'</span><h4>'+c[2]+' 条</h4><p>'+c[3]+'</p>'+
      '<div class="path-actions">'+c[4].map(a => '<button class="path-action" data-path-action-key="'+encodeURIComponent(actionKey(a))+'" data-path-action-focus="'+c[1]+'"><em>'+num(a.score)+'</em><b>'+escapeHtml(a.store_key || '-')+' · '+escapeHtml(a.category || '-')+'</b><span>'+escapeHtml(a.standard_goods_sn || a.skc || a.reason || '-')+'</span></button>').join('')+'</div>'+
      '<button class="btn" style="margin-top:10px" data-focus-jump="'+c[1]+'">查看全部</button></article>'
  ).join('');
  document.querySelectorAll('[data-focus-jump]').forEach(btn => btn.addEventListener('click', () => {
    state.focus = btn.dataset.focusJump;
    jumpToTab('actions', {keepFilters:true});
    renderAll();
  }));
  document.querySelectorAll('[data-path-action-key]').forEach(btn => btn.addEventListener('click', () => {
    const action = (DATA.actions || []).find(a => actionKey(a) === decodeURIComponent(btn.dataset.pathActionKey || ''));
    if (action) {
      state.focus = btn.dataset.pathActionFocus || 'all';
      state.store = action.store_key || '';
      state.q = action.standard_goods_sn || action.skc || '';
      state.domain = '';
      safeSetValue('storeFilter', state.store);
      safeSetValue('q', state.q);
      safeSetValue('domainFilter', state.domain);
    }
    jumpToTab('actions', {keepFilters:true});
    renderAll();
  }));
}
function actionSearchText(a){
  return [a.category, a.title, a.reason, actionEvidenceText(a), a.next_step, a.standard_goods_sn, a.skc, a.store_key, a.action_domain].map(x => String(x || '')).join(' ');
}
function topActionsBy(predicate, limit = 3){
  return (DATA.actions || []).filter(predicate).sort((a,b)=>Number(b.score||0)-Number(a.score||0)).slice(0, limit);
}
function productTopBy(rows, valueFn, limit = 3){
  const map = new Map();
  rows.forEach(r => {
    const sn = r.standard_goods_sn || '未匹配货号';
    const item = map.get(sn) || {sn, count:0, amount:0};
    item.count += 1;
    item.amount += Number(valueFn(r) || 0);
    map.set(sn, item);
  });
  return [...map.values()].sort((a,b)=>b.count-a.count || b.amount-a.amount).slice(0, limit);
}
function sopRows(){
  const actions = DATA.actions || [];
  const textHas = (a, words) => words.some(w => actionSearchText(a).includes(w));
  const retire = topActionsBy(a => a.action_domain === 'link' && (a.retire_candidate || textHas(a, ['下架','淘汰','替换'])), 5);
  const supplement = topActionsBy(a => a.action_domain === 'link' && textHas(a, ['补链接','缺上架','缺链接','补覆盖']), 5);
  const optimize = topActionsBy(a => a.action_domain === 'link' && textHas(a, ['低支付','低点击','高访客','高曝光','无销量','优化','承接']), 5);
  const afterQuality = topActionsBy(a => ['after_sales','quality'].includes(a.action_domain), 5);
  const inventory = topActionsBy(a => a.action_domain === 'inventory' || textHas(a, ['库存','履约','面单','物流','取消']), 5);
  const growth = buildGrowthOpportunities(3);
  const afterProducts = productTopBy(DATA.afterSales || [], r => r.price_amount_total, 3);
  const unmatchedFinanceGoods = (DATA.financeGoods || []).filter(x => !x.standard_goods_sn || x.standard_goods_sn === '未匹配货号').length;
  const financeAmount = (DATA.financeOrders || []).reduce((s,x)=>s+Number(x.estimate_income_money_total||0),0);
  const rows = [
    {
      key:'stop-loss',
      cls:'high',
      label:'先止损',
      title:'弱链接替换 / 下架 SOP',
      count:retire.length,
      score:retire.reduce((s,a)=>s+Number(a.score||0),0),
      evidence:[
        retire[0] ? '最高分：' + (retire[0].store_key || '-') + '｜' + (retire[0].standard_goods_sn || retire[0].skc || '-') + '｜' + num(retire[0].score) : '暂无强下架动作',
        '原则：唯一承接不直接下架，先补新链接或确认不卖。'
      ],
      steps:['先看是否同店已有更强链接','没有替代就先补新链接','确认替代后再下架/停用弱链接'],
      buttons:[{label:'看下架动作', tab:'actions', focus:'retire', risk:'retire'}, retire[0] ? {label:'看首条动作', tab:'actions', action:retire[0]} : null].filter(Boolean)
    },
    {
      key:'coverage-growth',
      cls:'good',
      label:'补覆盖',
      title:'补链接 / 扩店 SOP',
      count:supplement.length + growth.length,
      score:supplement.reduce((s,a)=>s+Number(a.score||0),0) + growth.reduce((s,p)=>s+Number(p.growthScore||0),0),
      evidence:[
        supplement[0] ? '最高补链：' + (supplement[0].store_key || '-') + '｜' + (supplement[0].standard_goods_sn || '-') : '当前补链动作较少',
        growth[0] ? '增长机会：' + growth[0].standard_goods_sn + '｜可扩 ' + num(growth[0].missingStores) + ' 店' : '暂无稳定增长机会'
      ],
      steps:['只补“部分店已上架、部分店缺”的货号','优先复制有销量/低售后压力的打法','补完后观察曝光、商详访客和订单是否同步提升'],
      buttons:[{label:'看补链动作', tab:'actions', focus:'supplement'}, growth[0] ? {label:'看增长货号', tab:'products', q:growth[0].standard_goods_sn} : null].filter(Boolean)
    },
    {
      key:'conversion',
      cls:'',
      label:'修承接',
      title:'有流量无转化 SOP',
      count:optimize.length,
      score:optimize.reduce((s,a)=>s+Number(a.score||0),0),
      evidence:[
        optimize[0] ? '最高分：' + (optimize[0].store_key || '-') + '｜' + (optimize[0].standard_goods_sn || optimize[0].skc || '-') + '｜' + num(optimize[0].score) : '暂无强承接动作',
        '判断顺序：曝光 → 点击 → 商详 → 支付。'
      ],
      steps:['高曝光低点击：先看主图、标题、价格带','高访客低支付：看评价、退货、活动承接','优化后仍 30/60 天无销量再进淘汰'],
      buttons:[{label:'看优化动作', tab:'actions', focus:'optimize'}, optimize[0] ? {label:'看首条 SKC', tab:'links', q:optimize[0].skc || optimize[0].standard_goods_sn} : null].filter(Boolean)
    },
    {
      key:'quality-fire',
      cls:'high',
      label:'控售后',
      title:'售后 / 质量救火 SOP',
      count:afterQuality.length,
      score:afterQuality.reduce((s,a)=>s+Number(a.score||0),0),
      evidence:[
        afterProducts[0] ? '售后集中：' + afterProducts[0].sn + '｜' + num(afterProducts[0].count) + ' 单' : '暂无售后集中货号',
        '低星评价、退货原因和链接承接要一起看。'
      ],
      steps:['先找售后最集中的货号和店铺','区分物流/妥投问题还是商品质量问题','质量问题优先降流、换图说明或替换链接'],
      buttons:[{label:'看售后动作', tab:'actions', domain:'after_sales'}, {label:'看质量动作', tab:'actions', domain:'quality'}, afterProducts[0] ? {label:'看货号 360', tab:'products', q:afterProducts[0].sn} : null].filter(Boolean)
    },
    {
      key:'inventory-fulfill',
      cls:'',
      label:'保履约',
      title:'库存 / 履约保护 SOP',
      count:inventory.length,
      score:inventory.reduce((s,a)=>s+Number(a.score||0),0),
      evidence:[
        '当前低展示库存精选动作：' + num((DATA.actions || []).filter(a => a.action_domain === 'inventory').length) + ' 条',
        '履约/面单快照：' + num((DATA.waybills || []).length) + ' 行。'
      ],
      steps:['只处理已上架且近 30 天有销量/订单的低库存','区分真实库存和 SHEIN 展示库存','取消/面单异常集中时先从店铺作战台排查'],
      buttons:[{label:'看库存动作', tab:'actions', focus:'inventory', domain:'inventory'}, {label:'看订单/售后', tab:'business'}]
    },
    {
      key:'finance-check',
      cls:'',
      label:'对财务',
      title:'收入 / 商品匹配 SOP',
      count:(DATA.financeOrders || []).length,
      score:financeAmount,
      evidence:[
        '在途收入：' + num((DATA.financeOrders || []).length) + ' 单 / ' + money(financeAmount),
        '财务商品未匹配：' + num(unmatchedFinanceGoods) + ' 条；目前主要覆盖 HL。'
      ],
      steps:['先核对 HL 在途收入与当日订单','未匹配商品保留 entity_id 后续补规则','其它店未接主账号前不要把财务空值当 0'],
      buttons:[{label:'看财务明细', tab:'business', q:'HL'}, {label:'看系统提醒', tab:'system'}]
    }
  ];
  const completion = {
    'stop-loss': ['完成定义：旧链接已有替代链接或确认不卖；唯一承接没有被直接下架。', '复查：3-7 天看新链接曝光、商详访客、支付率和订单是否开始承接。'],
    'coverage-growth': ['完成定义：应补店铺已有可上架链接，或已明确标记暂不卖。', '复查：7 天看缺覆盖店是否产生曝光；14 天看是否有商详访客和订单。'],
    'conversion': ['完成定义：主图/标题/价格/评价/活动承接至少改完一项，并记录处理备注。', '复查：3 天看点击率，7 天看支付率和订单；仍无销量再进淘汰观察。'],
    'quality-fire': ['完成定义：已识别退货主因，能区分物流妥投、商品质量、描述不符或评价问题。', '复查：7-14 天看新售后单、低星评价和退货原因是否下降。'],
    'inventory-fulfill': ['完成定义：已确认是 SHEIN 展示库存、履约异常还是真实库存问题；展示库存需要时已调高。', '复查：次日看展示库存和售罄状态；3 天看取消/履约异常是否继续出现。'],
    'finance-check': ['完成定义：HL 在途收入与订单侧能解释；未匹配财务商品保留 entity_id/订单号等待映射。', '复查：每日看 gsfs 在途订单；每周补一次未匹配货号规则。']
  };
  return rows.map(r => ({...r, done: completion[r.key]?.[0] || '', review: completion[r.key]?.[1] || ''}));
}
function renderSopWorkbench(){
  const rows = sopRows();
  const active = rows.filter(x => Number(x.count || 0) > 0).length;
  $('sopTotal').textContent = active + '/' + rows.length + ' 个场景有动作';
  $('sopWorkbench').innerHTML = rows.map(r =>
    '<article class="sop-card '+(r.cls || '')+'">'+
      '<div class="sop-meta"><span class="tag '+(r.cls === 'high' ? 'high' : r.cls === 'good' ? 'good' : 'info')+'">'+escapeHtml(r.label)+'</span><span class="mono">'+escapeHtml(r.key)+'</span></div>'+
      '<h4>'+escapeHtml(r.title)+'</h4>'+
      '<div class="sop-score">'+num(r.count)+' <small style="font-size:13px;color:var(--muted);font-weight:600">项</small></div>'+
      '<div class="sop-evidence">'+(r.evidence || []).map(x => '<div>'+escapeHtml(x)+'</div>').join('')+'</div>'+
      '<div class="sop-steps">'+(r.steps || []).map((x,i)=>'<div><b>'+(i+1)+'</b><span>'+escapeHtml(x)+'</span></div>').join('')+'</div>'+
      '<div class="cause-conclusion">'+escapeHtml(r.done || '')+'<br><span class="muted">'+escapeHtml(r.review || '')+'</span></div>'+
      '<div class="sop-actions">'+(r.buttons || []).map(b => '<button class="status-btn" data-sop-tab="'+escapeHtml(b.tab || 'actions')+'" data-sop-focus="'+escapeHtml(b.focus || '')+'" data-sop-domain="'+escapeHtml(b.domain || '')+'" data-sop-risk="'+escapeHtml(b.risk || '')+'" data-sop-q="'+escapeHtml(b.q || '')+'" data-sop-store="'+escapeHtml(b.store || '')+'" data-sop-action-key="'+(b.action ? encodeURIComponent(actionKey(b.action)) : '')+'">'+escapeHtml(b.label)+'</button>').join('')+'</div>'+
    '</article>'
  ).join('');
}
function clampPct(v){
  return Math.max(4, Math.min(100, Math.round(Number(v || 0))));
}
function actionBucketCounts(rows){
  const text = x => actionSearchText(x);
  return {
    retire: rows.filter(a => a.action_domain === 'link' && /下架|淘汰|替换/.test(text(a))).length,
    supplement: rows.filter(a => a.action_domain === 'link' && /补链接|缺上架|缺链接|补覆盖/.test(text(a))).length,
    optimize: rows.filter(a => a.action_domain === 'link' && /低支付|低点击|高访客|高曝光|无销量|优化|承接/.test(text(a))).length,
    afterQuality: rows.filter(a => ['after_sales','quality'].includes(a.action_domain)).length,
    inventory: rows.filter(a => a.action_domain === 'inventory').length
  };
}
function addCause(causes, label, weight, evidence, nextStep){
  const w = Number(weight || 0);
  if (w <= 0) return;
  causes.push({label, weight: Math.round(w), evidence, nextStep});
}
function buildRootCauseCenter(limit = 9){
  const actions = DATA.actions || [];
  const products = DATA.products || [];
  const stores = DATA.stores || [];
  const links = DATA.storeLinks || DATA.links || [];
  const afterSales = DATA.afterSales || [];
  const waybills = DATA.waybills || [];
  const financeGoods = DATA.financeGoods || [];
  const financeOrders = DATA.financeOrders || [];
  const rows = [];

  for (const p of products) {
    const sn = p.standard_goods_sn || '';
    if (!sn) continue;
    const productActions = actions.filter(a => a.standard_goods_sn === sn);
    const buckets = actionBucketCounts(productActions);
    const productLinks = links.filter(x => x.standard_goods_sn === sn);
    const productAfter = afterSales.filter(x => x.standard_goods_sn === sn);
    const productFinance = financeGoods.filter(x => x.standard_goods_sn === sn);
    const sales = Number(p.sales_sar || 0);
    const afterCases = Number(p.after_sales_case_count || productAfter.length || 0);
    const afterAmount = Number(p.after_sales_amount_sar || productAfter.reduce((s,x)=>s+Number(x.price_amount_total||0),0));
    const afterPressure = sales > 0 ? Math.min(120, afterAmount / Math.max(1, sales) * 18) : Math.min(90, afterCases * 2);
    const linkExposure = productLinks.reduce((s,x)=>s+Number(x.eps_uv||0),0);
    const linkVisitors = productLinks.reduce((s,x)=>s+Number(x.goods_uv||0),0);
    const linkSales30 = productLinks.reduce((s,x)=>s+Number(x.c30_sale_cnt||0),0);
    const financeAmount = productFinance.reduce((s,x)=>s+Number(x.amount||0),0);
    const causes = [];
    addCause(causes, '售后质量', afterPressure + Math.min(45, Number(p.low_star_comment_count || 0) * 5), '售后 ' + num(afterCases) + ' 单 / ' + money(afterAmount) + '；低星 ' + num(p.low_star_comment_count), '先看退货原因和低星评价，再决定是否降流、换图说明或换链接。');
    addCause(causes, '弱链接止损', buckets.retire * 26, '下架/替换动作 ' + num(buckets.retire) + ' 条。', '先确认是否唯一承接；唯一承接先补新链接，再处理旧链接。');
    addCause(causes, '链接承接', buckets.optimize * 20 + (linkExposure > 0 && linkSales30 === 0 ? 28 : 0), '曝光 ' + num(linkExposure) + ' / 商详 ' + num(linkVisitors) + ' / 30天销量 ' + num(linkSales30) + '。', '按曝光→点击→商详→支付拆承接问题，先修主图、价格、评价和活动。');
    addCause(causes, '覆盖缺口', buckets.supplement * 18 + Math.min(36, Number(p.missing_store_count || 0) * 5), '缺覆盖 ' + num(p.missing_store_count) + ' 店；补链动作 ' + num(buckets.supplement) + ' 条。', '只补部分店已上架、部分店缺的货号；全部店都没上架的不催。');
    addCause(causes, '库存展示', Number(p.low_display_stock_count || 0) * 22 + buckets.inventory * 15, '低展示库存 ' + num(p.low_display_stock_count) + ' 个；库存动作 ' + num(buckets.inventory) + ' 条。', '只处理已上架且近 30 天有销量/订单的展示库存风险。');
    addCause(causes, '财务在途', Math.min(60, financeAmount / 30), '财务商品 ' + num(productFinance.length) + ' 条 / ' + money(financeAmount) + '。', '核对财务在途商品是否能匹配订单商品，未匹配保留 entity_id。');
    const sorted = causes.sort((a,b)=>b.weight-a.weight).slice(0, 4);
    if (!sorted.length) continue;
    const score = Number(p.risk_score || 0) + sorted.reduce((s,x)=>s+x.weight,0);
    if (score < 90 && productActions.length < 2) continue;
    const topAction = productActions.sort((a,b)=>Number(b.score||0)-Number(a.score||0))[0];
    const main = sorted[0];
    rows.push({
      kind:'货号',
      subject: sn,
      score,
      title:'货号异常归因 · ' + sn,
      subtitle:'不是先问“要不要下架”，而是先看主因：' + main.label,
      causes: sorted,
      chain:[
        main.evidence,
        '主因判断：' + main.label + '；次因：' + (sorted[1]?.label || '暂无明显次因') + '。',
        main.nextStep
      ],
      conclusion: score >= 220 ? '高优先级：今天先处理或安排负责人。' : '中优先级：可排入本周复核。',
      buttons:[
        {label:'看货号 360', tab:'products', q:sn},
        topAction ? {label:'看关键动作', tab:'actions', q:sn, action:topAction} : {label:'看动作池', tab:'actions', q:sn},
        productLinks[0]?.skc ? {label:'看代表 SKC', tab:'links', q:productLinks[0].skc} : null
      ].filter(Boolean)
    });
  }

  for (const s of stores) {
    const store = s.store_key || '';
    if (!store) continue;
    const storeActions = actions.filter(a => a.store_key === store);
    const storeWaybills = waybills.filter(x => x.store_key === store && /取消|异常|失败|未/.test(String(x.show_status_desc || x.tag_desc || '')));
    const causes = [];
    addCause(causes, '链接覆盖', Number(s.link_action_count || 0) * 2 + Number(s.missing_product_count || 0) * 1.5, '链接动作 ' + num(s.link_action_count) + ' 条；缺覆盖 ' + num(s.missing_product_count) + ' 个。', '先看该店是否集中缺某些已验证货号，再进入补链/替换 SOP。');
    addCause(causes, '售后压力', Math.min(130, Number(s.after_sales_case_count || 0) * 1.7 + Number(s.after_sales_item_amount_sar || 0) / 160), '售后 ' + num(s.after_sales_case_count) + ' 单 / ' + money(s.after_sales_item_amount_sar) + '。', '优先找售后集中的货号，不要按店铺平均处理。');
    addCause(causes, '质量评价', Number(s.low_star_comment_count || 0) * 8 + Number(s.quality_after_sales_item_count || 0) * 2, '低星 ' + num(s.low_star_comment_count) + '；质量售后 ' + num(s.quality_after_sales_item_count) + '。', '把低星评价和售后原因合并看，先控质量风险。');
    addCause(causes, '履约面单', Number(s.waybill_exception_count || storeWaybills.length || 0) * 16, '履约异常 ' + num(s.waybill_exception_count || storeWaybills.length) + ' 个。', '先查取消/未揽收/物流异常包裹，避免影响店铺评分。');
    addCause(causes, '财务在途', Math.min(80, Number(s.finance_no_finish_order_income_sar || 0) / 80) + Number(s.finance_no_finish_order_count || 0) * 2, '财务在途 ' + num(s.finance_no_finish_order_count) + ' 单 / ' + money(s.finance_no_finish_order_income_sar) + '。', 'HL 以外财务明细缺口不要误判为 0；有权限店先核对在途收入。');
    const sorted = causes.sort((a,b)=>b.weight-a.weight).slice(0, 4);
    if (!sorted.length) continue;
    const score = Number(s.risk_score || 0) + sorted.reduce((sum,x)=>sum+x.weight,0);
    if (score < 120) continue;
    rows.push({
      kind:'店铺',
      subject: store,
      score,
      title:'店铺异常归因 · ' + store,
      subtitle:'该店当前主因：' + sorted[0].label,
      causes: sorted,
      chain:[
        sorted[0].evidence,
        '主因判断：' + sorted[0].label + '；次因：' + (sorted[1]?.label || '暂无明显次因') + '。',
        sorted[0].nextStep
      ],
      conclusion:'先进入店铺作战台，再按主因分流到动作池或订单/售后明细。',
      buttons:[
        {label:'看店铺作战台', tab:'stores', store},
        {label:'看该店动作', tab:'actions', store},
        {label:'看订单/售后', tab:'business', store}
      ]
    });
  }

  const unmatched = financeGoods.filter(x => !x.standard_goods_sn || x.standard_goods_sn === '未匹配货号');
  if (unmatched.length) {
    const amount = unmatched.reduce((s,x)=>s+Number(x.amount||0),0);
    rows.push({
      kind:'财务',
      subject:'财务商品待匹配',
      score: Math.min(260, unmatched.length * 7 + amount / 20),
      title:'财务商品归因 · 未匹配货号',
      subtitle:'财务有收入商品，但暂时无法归并到标准货号。',
      causes:[
        {label:'匹配规则', weight:Math.min(100, unmatched.length * 3), evidence:'未匹配财务商品 ' + num(unmatched.length) + ' 条。', nextStep:'优先用 entity_id / 订单号 / SKU Code 回填标准货号。'},
        {label:'收入影响', weight:Math.min(100, amount / 25), evidence:'未匹配金额 ' + money(amount) + '。', nextStep:'金额较大时先人工复核，避免漏算货号利润和趋势。'}
      ],
      chain:[
        '财务在途商品没有标准货号 → 无法进入货号 360 和增长/淘汰判断。',
        '当前先保留 entity_id、订单号和金额，不丢明细。',
        '下一步补映射规则，优先处理金额大的未匹配行。'
      ],
      conclusion:'这是数据治理问题，不是经营动作；先补匹配，避免后续 BI 误判。',
      buttons:[
        {label:'看财务明细', tab:'business', q:'HL'},
        {label:'看系统提醒', tab:'system'}
      ]
    });
  }

  return rows.sort((a,b)=>Number(b.score||0)-Number(a.score||0)).slice(0, limit);
}
function rootCauseCommandText(r){
  return [
    'SHEIN BI 经营异常归因',
    '对象：' + (r.kind || '-') + ' / ' + (r.subject || '-'),
    '分数：' + num(r.score),
    '判断：' + (r.subtitle || '-'),
    '原因链：',
    ...(r.chain || []).map((x,i)=> (i+1) + '）' + x),
    '主因明细：' + (r.causes || []).map(x => x.label + '(' + num(x.weight) + ')').join('；'),
    '结论：' + (r.conclusion || '-')
  ].join('\\n');
}
function renderRootCauseCenter(){
  const rows = buildRootCauseCenter(9);
  $('rootCauseTotal').textContent = rows.length + ' 个重点异常';
  $('rootCauseCenter').innerHTML = rows.map(r => {
    const max = Math.max(...(r.causes || []).map(x => Number(x.weight || 0)), 1);
    return '<article class="cause-card">'+
      '<div class="row1"><span class="tag '+(Number(r.score||0) >= 220 ? 'high' : 'mid')+'">'+escapeHtml(r.kind)+'</span><span class="score">'+num(r.score)+'</span></div>'+
      '<h4>'+escapeHtml(r.title)+'</h4>'+
      '<p>'+escapeHtml(r.subtitle)+'</p>'+
      '<div style="margin:12px 0">'+(r.causes || []).slice(0,4).map(c =>
        '<div class="cause-factor"><span>'+escapeHtml(c.label)+'</span><div class="cause-bar"><i style="width:'+clampPct(Number(c.weight||0)/max*100)+'%"></i></div><b class="mono">'+num(c.weight)+'</b></div>'
      ).join('')+'</div>'+
      '<div class="cause-chain">'+(r.chain || []).slice(0,3).map((x,i)=>'<div><b>'+(i+1)+'</b><span>'+escapeHtml(x)+'</span></div>').join('')+'</div>'+
      '<div class="cause-conclusion">'+escapeHtml(r.conclusion || '')+'</div>'+
      '<div class="sop-actions">'+
        copyButton(rootCauseCommandText(r), '复制归因')+
        (r.buttons || []).map(b => '<button class="status-btn" data-sop-tab="'+escapeHtml(b.tab || 'actions')+'" data-sop-focus="'+escapeHtml(b.focus || '')+'" data-sop-domain="'+escapeHtml(b.domain || '')+'" data-sop-risk="'+escapeHtml(b.risk || '')+'" data-sop-q="'+escapeHtml(b.q || '')+'" data-sop-store="'+escapeHtml(b.store || '')+'" data-sop-action-key="'+(b.action ? encodeURIComponent(actionKey(b.action)) : '')+'">'+escapeHtml(b.label)+'</button>').join('')+
      '</div>'+
    '</article>';
  }).join('') || '<div class="empty">当前没有足够强的跨域异常；先按今日作战路径处理动作池。</div>';
}
function buildGrowthOpportunities(limit = 8){
  const actions = DATA.actions || [];
  const financeGoods = DATA.financeGoods || [];
  const afterSales = DATA.afterSales || [];
  const matrix = DATA.matrix || [];
  const links = DATA.storeLinks || DATA.links || [];
  const orders = DATA.orders || [];
  return (DATA.products || []).map(p => {
    const sn = p.standard_goods_sn || '';
    const productActions = actions.filter(a => a.standard_goods_sn === sn);
    const financeRows = financeGoods.filter(x => x.standard_goods_sn === sn);
    const afterRows = afterSales.filter(x => x.standard_goods_sn === sn);
    const matrixRows = matrix.filter(x => x.standard_goods_sn === sn);
    const linkRows = links.filter(x => x.standard_goods_sn === sn);
    const orderRows = orders.filter(x => x.standard_goods_sn === sn);
    const sales = Number(p.sales_sar || 0);
    const financeAmount = financeRows.reduce((sum,x)=>sum+Number(x.amount||0),0);
    const afterAmount = afterRows.reduce((sum,x)=>sum+Number(x.price_amount_total||0),0);
    const afterRate = sales > 0 ? afterAmount / sales : (afterRows.length ? 9 : 0);
    const missingStores = matrixRows.filter(x => x.need_supplement_link).length || Number(p.missing_store_count || 0);
    const onShelfStores = Number(p.on_shelf_store_count || 0);
    const saleStores = Number(p.sale_store_count || 0);
    const c30Sales = linkRows.reduce((sum,x)=>sum+Number(x.c30_sale_cnt||0),0);
    const exposure = linkRows.reduce((sum,x)=>sum+Number(x.eps_uv||0),0);
    const lowStars = Number(p.low_star_comment_count || 0);
    const retireActions = productActions.filter(x => /下架|淘汰|替换/.test(String(x.category || x.title || x.reason || ''))).length;
    const riskActions = productActions.filter(x => ['after_sales','quality','inventory'].includes(x.action_domain)).length;
    const strongLink = linkRows
      .filter(x => Number(x.c30_sale_cnt || 0) > 0 && !x.retire_candidate)
      .sort((a,b)=>Number(b.c30_sale_cnt||0)-Number(a.c30_sale_cnt||0) || Number(b.eps_uv||0)-Number(a.eps_uv||0))[0];
    const refLabel = growthReferenceLabel(strongLink);
    const opportunityStores = matrixRows.filter(x => x.need_supplement_link).map(x => x.store_key).filter(Boolean).slice(0, 6);
    const positive =
      Math.min(120, sales / 12)
      + Math.min(45, financeAmount / 20)
      + Math.min(55, c30Sales * 8)
      + Math.min(35, exposure / 80)
      + Math.min(70, missingStores * 10)
      + Math.min(35, saleStores * 8)
      + Math.min(25, onShelfStores * 2);
    const penalty =
      Math.min(120, afterRate * 60)
      + Math.min(40, lowStars * 10)
      + Math.min(50, retireActions * 10)
      + Math.min(45, riskActions * 7);
    const growthScore = Math.max(0, Math.round(positive - penalty));
    let opportunityType = '观察放量';
    if (missingStores > 0 && (sales > 0 || c30Sales > 0 || strongLink)) opportunityType = '扩店补覆盖';
    else if (strongLink && exposure > 500) opportunityType = '复制强链接';
    else if (sales > 0 && saleStores > 0) opportunityType = '活动放量';
    const reasons = [
      sales > 0 ? '销售 ' + money(sales) : '',
      c30Sales > 0 ? '链接30天销量 ' + num(c30Sales) : '',
      strongLink ? refLabel + ' ' + strongLink.skc : '',
      missingStores > 0 && onShelfStores > 0 ? '仍可扩 ' + num(missingStores) + ' 店' : '',
      afterRate <= 0.35 ? '售后压力低' : '',
      financeAmount > 0 ? '财务在途 ' + money(financeAmount) : ''
    ].filter(Boolean);
    const nextStep = opportunityType === '扩店补覆盖'
      ? '优先把' + refLabel + '的主图/标题/价格打法复制到缺覆盖店；缺覆盖店：' + (opportunityStores.join('、') || '请在覆盖矩阵复核')
      : opportunityType === '复制强链接'
        ? '复盘' + refLabel + '的主图、标题、价格、活动标签和评价承接，复制给同货号弱链接。'
        : opportunityType === '活动放量'
          ? '先小流量活动测试，再观察曝光、商详访客和支付率是否同步提升。'
          : '保持观察，等连续多日销售/链接表现稳定后再放大。';
    return {
      ...p,
      growthScore,
      opportunityType,
      reasons,
      financeAmount,
      afterAmount,
      afterRate,
      missingStores,
      onShelfStores,
      saleStores,
      c30Sales,
      exposure,
      strongLink,
      opportunityStores,
      orderRows,
      afterRows,
      productActions,
      nextStep
    };
  })
    .filter(x =>
      Number(x.onShelfStores || 0) > 0
      && Number(x.growthScore || 0) >= 30
      && Number(x.afterRate || 0) <= 0.8
      && (Number(x.sales_sar || 0) > 0 || Number(x.c30Sales || 0) > 0 || Number(x.financeAmount || 0) > 0)
      && (Number(x.missingStores || 0) > 0 || x.strongLink || Number(x.saleStores || 0) > 0)
    )
    .sort((a,b)=>Number(b.growthScore||0)-Number(a.growthScore||0) || Number(b.sales_sar||0)-Number(a.sales_sar||0))
    .slice(0, limit);
}
function growthPlaybookText(p){
  if (!p) return '';
  const stores = (p.opportunityStores || []).join('、') || '请在覆盖矩阵里复核缺覆盖店';
  const referenceRisk = growthReferenceRisk(p.strongLink);
  const referenceLabel = referenceRisk ? '参考 SKC（先复核承接）' : '可复制强 SKC';
  const strongSkc = p.strongLink?.skc || '-';
  return [
    'SHEIN BI 增长复制指令',
    '货号：' + (p.standard_goods_sn || '-'),
    '机会类型：' + (p.opportunityType || '-'),
    '机会分：' + num(p.growthScore),
    '证据：销售 ' + money(p.sales_sar) + '；链接30天销量 ' + num(p.c30Sales) + '；已上架 ' + num(p.onShelfStores) + '/' + num(TOTAL_STORE_COUNT) + '；可扩 ' + num(p.missingStores) + ' 店；售后压力 ' + Math.round(Number(p.afterRate || 0) * 100) + '%。',
    referenceLabel + '：' + strongSkc,
    '建议扩店：' + stores,
    '复制清单：1）' + referenceLabel + '的主图/首图；2）标题关键词；3）价格带；4）活动/标签；5）评论和质量承接；6）详情页卖点顺序。',
    '执行方式：先在缺覆盖店补 1 条新链接或替换弱链接，再观察曝光、商详访客、点击率、支付率和订单是否同步提升。',
    '注意：' + (referenceRisk ? '参考 SKC 自身存在“' + referenceRisk + '”，复制前先修价格、评价或详情承接，不要原样放大问题。' : '如果该货号后续出现售后/质量集中，先暂停放量，转入质量复核。'),
    '下一步：' + (p.nextStep || '-')
  ].join('\\n');
}
function growthReferenceRisk(link){
  if (!link) return '';
  const text = [link.health_bucket, link.shelf_status_name, link.action_category, link.reason].map(x => String(x || '')).join(' ');
  if (/下架候选|可下架|先替换再下架|淘汰/.test(text)) return '下架/淘汰候选';
  if (/高访客低支付|低支付|有流量无销量/.test(text)) return '支付转化偏弱';
  if (/高曝光低点击|低点击/.test(text)) return '点击承接偏弱';
  if (/库存|售罄/.test(text)) return '库存/售罄风险';
  return '';
}
function growthReferenceLabel(link){
  return growthReferenceRisk(link) ? '参考SKC' : '强SKC';
}
function focusGrowthSkc(skc){
  if (!skc) return;
  state.q = skc;
  state.store = '';
  safeSetValue('q', state.q);
  safeSetValue('storeFilter', '');
  jumpToTab('links', {keepFilters:true});
  renderAll();
}
function renderGrowthOpportunities(){
  const rows = buildGrowthOpportunities(8);
  $('growthOpportunityGrid').innerHTML = rows.map(p =>
    '<article class="priority-card opportunity-card" data-growth-product="'+escapeHtml(p.standard_goods_sn || '')+'">'+
      '<div class="row1"><span class="domain">'+escapeHtml(p.opportunityType)+'</span><span class="score">'+num(p.growthScore)+'</span></div>'+
      '<h4>'+escapeHtml(p.standard_goods_sn || '-')+'</h4>'+
      '<div class="reason">'+escapeHtml(p.reasons.join('；') || '有正向信号，建议观察')+'</div>'+
      '<div class="priority-metrics">'+
        '<div><span>销售</span><strong>'+money(p.sales_sar)+'</strong></div>'+
        '<div><span>30天销量</span><strong>'+num(p.c30Sales)+'</strong></div>'+
        '<div><span>已上架</span><strong>'+num(p.onShelfStores)+'/'+num(TOTAL_STORE_COUNT)+'</strong></div>'+
        '<div><span>可扩店</span><strong>'+num(p.missingStores)+'</strong></div>'+
        '<div><span>售后压力</span><strong>'+Math.round(Number(p.afterRate||0)*100)+'%</strong></div>'+
        '<div><span>'+growthReferenceLabel(p.strongLink)+'</span><strong class="mono">'+escapeHtml(p.strongLink?.skc || '-').slice(0,18)+'</strong></div>'+
      '</div>'+
      (growthReferenceRisk(p.strongLink) ? '<p class="next warn">参考 SKC 也有'+escapeHtml(growthReferenceRisk(p.strongLink))+'，复制前先修承接，别把问题一起放大。</p>' : '')+
      '<p class="next">'+escapeHtml(p.nextStep)+'</p>'+
      '<div class="command-actions">'+
        copyButton(growthPlaybookText(p), '复制增长指令')+
        (p.strongLink?.skc ? '<button class="status-btn" data-growth-skc="'+escapeHtml(p.strongLink.skc)+'">看'+growthReferenceLabel(p.strongLink)+'</button>' : '')+
      '</div>'+
    '</article>'
  ).join('') || '<div class="empty">暂时没有足够稳的增长机会；当前更适合先处理风险和覆盖。</div>';
  document.querySelectorAll('[data-growth-product]').forEach(card => card.addEventListener('click', () => {
    state.q = card.dataset.growthProduct || '';
    state.store = '';
    safeSetValue('q', state.q);
    safeSetValue('storeFilter', '');
    jumpToTab('products', {keepFilters:true});
    renderAll();
  }));
}
function renderProductPriority(){
  const actions = DATA.actions || [];
  const financeGoods = DATA.financeGoods || [];
  const afterSales = DATA.afterSales || [];
  const matrix = DATA.matrix || [];
  const rows = (DATA.products || []).map(p => {
    const sn = p.standard_goods_sn || '';
    const productActions = actions.filter(a => a.standard_goods_sn === sn);
    const financeRows = financeGoods.filter(x => x.standard_goods_sn === sn);
    const afterRows = afterSales.filter(x => x.standard_goods_sn === sn);
    const matrixRows = matrix.filter(x => x.standard_goods_sn === sn);
    const financeAmount = financeRows.reduce((sum,x)=>sum+Number(x.amount||0),0);
    const afterAmount = afterRows.reduce((sum,x)=>sum+Number(x.price_amount_total||0),0);
    const storeActionCount = new Set(productActions.map(x=>x.store_key).filter(Boolean)).size;
    const missingStores = matrixRows.filter(x => x.need_supplement_link).length || Number(p.missing_store_count || 0);
    const linkRisk = productActions.filter(x => x.action_domain === 'link').length;
    const qualityRisk = productActions.filter(x => x.action_domain === 'quality' || x.action_domain === 'after_sales').length;
    const crossScore =
      Number(p.risk_score || 0)
      + Math.min(80, productActions.length * 8)
      + Math.min(45, storeActionCount * 6)
      + Math.min(35, financeAmount / 20)
      + Math.min(45, afterRows.length * 4)
      + Math.min(35, missingStores * 4);
    const reasons = [
      productActions.length ? '动作 ' + num(productActions.length) + ' 条' : '',
      linkRisk ? '链接 ' + num(linkRisk) : '',
      qualityRisk ? '售后/质量 ' + num(qualityRisk) : '',
      financeRows.length ? '财务在途 ' + num(financeRows.length) + ' 条' : '',
      afterRows.length ? '售后 ' + num(afterRows.length) + ' 单' : '',
      missingStores ? '缺覆盖 ' + num(missingStores) + ' 店' : ''
    ].filter(Boolean);
    return {...p, crossScore, productActions, financeRows, afterRows, financeAmount, afterAmount, missingStores, reasons};
  }).filter(x => x.reasons.length || Number(x.sales_sar || 0) > 0)
    .sort((a,b)=>Number(b.crossScore||0)-Number(a.crossScore||0) || Number(b.sales_sar||0)-Number(a.sales_sar||0))
    .slice(0, 8);
  $('productPriorityGrid').innerHTML = rows.map(p =>
    '<article class="priority-card" data-priority-product="'+escapeHtml(p.standard_goods_sn || '')+'">'+
      '<div class="row1"><span class="domain">货号优先级</span><span class="score">'+num(p.crossScore)+'</span></div>'+
      '<h4>'+escapeHtml(p.standard_goods_sn || '-')+'</h4>'+
      '<div class="reason">'+escapeHtml(p.reasons.join('；') || '暂无异常')+'</div>'+
      '<div class="priority-metrics">'+
        '<div><span>销售</span><strong>'+money(p.sales_sar)+'</strong></div>'+
        '<div><span>上架店</span><strong>'+num(p.on_shelf_store_count)+'/'+num(TOTAL_STORE_COUNT)+'</strong></div>'+
        '<div><span>财务</span><strong>'+money(p.financeAmount)+'</strong></div>'+
        '<div><span>售后</span><strong>'+num(p.afterRows.length)+' / '+money(p.afterAmount)+'</strong></div>'+
        '<div><span>动作</span><strong>'+num(p.productActions.length)+'</strong></div>'+
        '<div><span>缺覆盖</span><strong>'+num(p.missingStores)+'</strong></div>'+
      '</div>'+
    '</article>'
  ).join('') || '<div class="empty">没有跨域货号信号</div>';
  document.querySelectorAll('[data-priority-product]').forEach(card => card.addEventListener('click', () => {
    state.q = card.dataset.priorityProduct || '';
    state.store = '';
    safeSetValue('q', state.q);
    safeSetValue('storeFilter', '');
    jumpToTab('products', {keepFilters:true});
    renderAll();
  }));
}
function buildBriefing(){
  const k = DATA.kpi || {};
  const stores = [...(DATA.stores || [])].sort((a,b)=>Number(b.risk_score||0)-Number(a.risk_score||0));
  const products = [...(DATA.products || [])].sort((a,b)=>Number(b.risk_score||0)-Number(a.risk_score||0));
  const actions = DATA.actions || [];
  const insights = DATA.insights || [];
  const byDomain = Object.fromEntries((DATA.actionDomain || []).map(x => [x.action_domain, Number(x.count || 0)]));
  const topStores = stores.slice(0,3).map(s => s.store_key + ' 风险' + num(s.risk_score) + '/售后' + num(s.after_sales_case_count));
  const topProducts = products.slice(0,3).map(p => p.standard_goods_sn + ' 风险' + num(p.risk_score) + '/上架店' + num(p.on_shelf_store_count) + '/' + num(TOTAL_STORE_COUNT));
  const financeStores = (DATA.finance || []).filter(x => Number(x.finance_no_finish_order_count || 0) > 0);
  const financeCoverage = financeStores.length + '/' + num(TOTAL_STORE_COUNT);
  const financeGoods = DATA.financeGoods || [];
  const financeGoodsMatched = financeGoods.filter(x => x.standard_goods_sn);
  const financeGoodsUnmatched = financeGoods.length - financeGoodsMatched.length;
  const financeGoodsMatchedAmount = financeGoodsMatched.reduce((sum,x)=>sum+Number(x.amount||0),0);
  const financeProductMap = new Map();
  financeGoodsMatched.forEach(x => {
    const key = x.standard_goods_sn || '-';
    const row = financeProductMap.get(key) || {n:0, amount:0};
    row.n += 1;
    row.amount += Number(x.amount || 0);
    financeProductMap.set(key, row);
  });
  const topFinanceProducts = [...financeProductMap.entries()]
    .sort((a,b)=>b[1].amount-a[1].amount || b[1].n-a[1].n)
    .slice(0,2)
    .map(([sn,v]) => sn + ' ' + num(v.n) + '条/' + money(v.amount));
  const retireCount = actions.filter(a => /下架|替换|淘汰/.test(String(a.category || a.title || a.reason || ''))).length;
  const supplementCount = actions.filter(a => /补链接|缺上架链接|缺链接/.test(String(a.category || a.title || a.reason || ''))).length;
  const optimizeCount = actions.filter(a => a.action_domain === 'link' && /低支付|低点击|无销量|承接|优化|重复弱链接/.test(String(a.category || a.title || a.reason || ''))).length;
  const growthRows = buildGrowthOpportunities(3);
  const rootRows = buildRootCauseCenter(3);
  const trendRows = trendReadinessRows();
  const trendDayReady = trendRows.filter(x => x.days >= 2).length;
  const trendWeekReady = trendRows.filter(x => x.days >= 7).length;
  const trendMinDays = Math.min(...trendRows.map(x => x.days));
  const trendState = trendWeekReady ? '可做 7 日趋势 ' + trendWeekReady + '/5' : trendDayReady ? '可做日环比 ' + trendDayReady + '/5' : '单日观察 0/5';
  const sales = salesScopeSummary();
  const after = afterSalesScopeSummary();
  const lines = [
    'SHEIN BI 今日经营简报',
    '数据日期：销售 ' + (DATA.dates?.salesDate || '-') + '；业务 ' + (DATA.dates?.businessDate || '-') + '；链接 ' + (DATA.dates?.linkDate || '-'),
    '',
    '1）经营概览：当前时段销售 ' + money(sales.rangeSalesSar) + ' / ' + rmb(sales.rangeSalesSar) + '，订单 ' + num(sales.rangeOrders) + ' 单，销量 ' + num(sales.rangeQuantity) + ' 件；本月销售 ' + money(sales.monthSalesSar) + ' / ' + rmb(sales.monthSalesSar) + '。',
    '2）售后口径：' + after.sourceLabel + '；当前时段售后/退货 ' + num(after.rangeCases) + ' 单 / ' + money(after.rangeAmountSar) + '；本月 ' + num(after.monthCases) + ' 单。已取消售后不计入。',
    '3）财务口径：待结算 ' + money(k.pendingSettlementSar) + ' / ' + rmb(k.pendingSettlementSar) + '；gsfs 在途明细 ' + num(k.financeNoFinishOrders) + ' 单 / ' + money(k.financeNoFinishIncomeSar) + '；明细覆盖店铺 ' + financeCoverage + '。',
    '4）财务商品：在途商品 ' + num(financeGoods.length) + ' 条，已匹配货号 ' + num(financeGoodsMatched.length) + ' 条，未匹配 ' + num(financeGoodsUnmatched) + ' 条；匹配金额 ' + money(financeGoodsMatchedAmount) + '；集中货号 ' + (topFinanceProducts.join('；') || '暂无') + '。',
    '5）今日动作池：共 ' + num(actions.length) + ' 条；链接 ' + num(byDomain.link) + '，售后 ' + num(byDomain.after_sales) + '，质量 ' + num(byDomain.quality) + '，库存 ' + num(byDomain.inventory) + '。',
    '6）趋势口径：' + trendState + '；最短积累 ' + num(trendMinDays) + ' 天，当前不做假趋势。',
    '7）异常归因：' + (rootRows.map(x => x.subject + '｜' + (x.causes?.[0]?.label || '-') + '｜' + num(x.score) + '分').join('；') || '暂无强异常') + '。',
    '8）优先店铺：' + (topStores.join('；') || '暂无') + '。',
    '9）优先货号：' + (topProducts.join('；') || '暂无') + '。',
    '10）建议路径：先处理下架/替换 ' + num(retireCount) + ' 条，再处理补链接 ' + num(supplementCount) + ' 条，再看优化承接 ' + num(optimizeCount) + ' 条。',
    '',
    '首批诊断：',
    ...insights.slice(0,5).map((x,i)=> (i+1) + '. ' + (x.title || '-') + '｜' + (x.store_key || x.standard_goods_sn || '全局') + '｜' + (x.next_step || '').slice(0,80))
  ];
  if (growthRows.length) {
    lines.splice(13, 0, '11）增长机会：' + growthRows.map(x => (x.standard_goods_sn || '-') + ' 机会分' + num(x.growthScore) + ' / ' + x.opportunityType).join('；') + '。');
  }
  return {
    lines,
    topStores,
    topProducts,
    retireCount,
    supplementCount,
    optimizeCount,
    rootRows,
    growthRows,
    financeCoverage,
    financeGoodsMatched,
    financeGoodsTotal: financeGoods.length,
    financeGoodsUnmatched,
    trendState,
    trendMinDays,
    trendDayReady,
    trendWeekReady
  };
}
function renderBriefing(){
  const b = buildBriefing();
  const lines = b.lines;
  $('dailyBriefing').innerHTML =
    '<div class="briefing-main">'+
      '<h4>'+escapeHtml(lines[0])+'</h4>'+
      '<p>'+escapeHtml(lines[1])+'</p>'+
      '<ul class="briefing-list">'+
        lines.slice(3,10).map(x => '<li>'+escapeHtml(x.replace(/^\\d+）/, ''))+'</li>').join('')+
      '</ul>'+
    '</div>'+
    '<div class="briefing-side">'+
      '<div class="briefing-note"><span>今日优先店铺</span><strong>'+escapeHtml(b.topStores.map(x=>x.split(' ')[0]).join(' / ') || '-')+'</strong></div>'+
      '<div class="briefing-note"><span>财务明细覆盖</span><strong>'+escapeHtml(b.financeCoverage)+'</strong></div>'+
      '<div class="briefing-note"><span>财务商品匹配</span><strong>'+num(b.financeGoodsMatched.length)+' / '+num(b.financeGoodsTotal)+'</strong></div>'+
      '<div class="briefing-note"><span>趋势准备</span><strong>'+escapeHtml(b.trendState)+'</strong></div>'+
      '<div class="briefing-note"><span>异常归因</span><strong>'+num(b.rootRows?.length || 0)+' 个</strong></div>'+
      '<div class="briefing-note"><span>增长机会</span><strong>'+num(b.growthRows?.length || 0)+' 个</strong></div>'+
      '<div class="briefing-note"><span>下架/替换</span><strong>'+num(b.retireCount)+' 条</strong></div>'+
      '<div class="briefing-note"><span>补链接</span><strong>'+num(b.supplementCount)+' 条</strong></div>'+
      '<div class="briefing-note"><span>优化承接</span><strong>'+num(b.optimizeCount)+' 条</strong></div>'+
    '</div>';
  $('markdownBriefingPreview').textContent = fullBriefingText() || '完整 Markdown 晨报还没有生成；每日 BI 流水线完成后会自动生成。';
}
function briefingText(){
  return buildBriefing().lines.join('\\n');
}
function fullBriefingText(){
  return DATA.briefing?.content || briefingText();
}
function commandRoomRows(){
  const actions = DATA.actions || [];
  const textHas = (a, words) => words.some(w => actionSearchText(a).includes(w));
  const root = buildRootCauseCenter(6);
  const growth = buildGrowthOpportunities(4);
  const retire = topActionsBy(a => a.action_domain === 'link' && (a.retire_candidate || textHas(a, ['下架','淘汰','替换'])), 1)[0];
  const supplement = topActionsBy(a => a.action_domain === 'link' && textHas(a, ['补链接','缺上架','缺链接','补覆盖']), 1)[0];
  const optimize = topActionsBy(a => a.action_domain === 'link' && textHas(a, ['低支付','低点击','高访客','高曝光','无销量','优化','承接']), 1)[0];
  const quality = topActionsBy(a => ['after_sales','quality'].includes(a.action_domain), 1)[0];
  const first = root[0];
  const lanes = [
    retire ? {
      label:'先止损',
      title:'弱链接替换',
      score:Number(retire.score || 0),
      target:(retire.store_key || '-') + '｜' + (retire.standard_goods_sn || retire.skc || '-'),
      reason:retire.reason || retire.evidence || '',
      next:retire.next_step || '',
      button:{label:'看止损动作', tab:'actions', focus:'retire', risk:'retire', q:retire.standard_goods_sn || retire.skc || '', store:retire.store_key || '', action:retire},
      copy:actionCommandText(retire)
    } : null,
    supplement ? {
      label:'补覆盖',
      title:'补链接/扩店',
      score:Number(supplement.score || 0),
      target:(supplement.store_key || '-') + '｜' + (supplement.standard_goods_sn || supplement.skc || '-'),
      reason:supplement.reason || supplement.evidence || '',
      next:supplement.next_step || '',
      button:{label:'看补链动作', tab:'actions', focus:'supplement', q:supplement.standard_goods_sn || supplement.skc || '', store:supplement.store_key || '', action:supplement},
      copy:actionCommandText(supplement)
    } : null,
    optimize ? {
      label:'修承接',
      title:'流量转化修复',
      score:Number(optimize.score || 0),
      target:(optimize.store_key || '-') + '｜' + (optimize.standard_goods_sn || optimize.skc || '-'),
      reason:optimize.reason || optimize.evidence || '',
      next:optimize.next_step || '',
      button:{label:'看承接动作', tab:'actions', focus:'optimize', q:optimize.skc || optimize.standard_goods_sn || '', store:optimize.store_key || '', action:optimize},
      copy:actionCommandText(optimize)
    } : null,
    quality ? {
      label:'控风险',
      title:'售后/质量救火',
      score:Number(quality.score || 0),
      target:(quality.store_key || '-') + '｜' + (quality.standard_goods_sn || quality.skc || '-'),
      reason:quality.reason || quality.evidence || '',
      next:quality.next_step || '',
      button:{label:'看风险动作', tab:'actions', domain:quality.action_domain || '', q:quality.standard_goods_sn || quality.skc || '', store:quality.store_key || '', action:quality},
      copy:actionCommandText(quality)
    } : null,
    growth[0] ? {
      label:'找增长',
      title:growth[0].opportunityType || '增长机会',
      score:Number(growth[0].growthScore || 0),
      target:growth[0].standard_goods_sn || '-',
      reason:(growth[0].reasons || []).join('；'),
      next:growth[0].nextStep || '',
      button:{label:'看增长打法', tab:'products', q:growth[0].standard_goods_sn || ''},
      copy:growthPlaybookText(growth[0])
    } : null
  ].filter(Boolean).sort((a,b)=>Number(b.score||0)-Number(a.score||0));
  return {first, lanes, root, growth, actions};
}
function renderCommandRoom(){
  const room = commandRoomRows();
  const first = room.first;
  const lanes = room.lanes.slice(0,4);
  $('commandRoomTag').textContent = first ? '第一优先级 ' + num(first.score) + ' 分' : '暂无强异常';
  const firstButtons = first ? [
    {label:first.kind === '店铺' ? '看店铺' : first.kind === '财务' ? '看财务' : '看货号', tab:first.kind === '店铺' ? 'stores' : first.kind === '财务' ? 'business' : 'products', q:first.kind === '货号' ? first.subject : (first.kind === '财务' ? 'HL' : ''), store:first.kind === '店铺' ? first.subject : ''},
    {label:'看动作池', tab:'actions', q:first.kind === '货号' ? first.subject : '', store:first.kind === '店铺' ? first.subject : ''}
  ] : [];
  $('commandRoom').innerHTML =
    '<article class="commander-card">'+
      '<span class="tag high">今日第一仗</span>'+
      '<h4>'+escapeHtml(first ? first.title : '暂无强异常')+'</h4>'+
      '<p>'+escapeHtml(first ? first.subtitle : '当前没有特别集中的跨域异常，按今日作战路径处理动作池即可。')+'</p>'+
      '<div class="commander-metrics">'+
        '<div><span>归因对象</span><strong>'+escapeHtml(first?.subject || '-')+'</strong></div>'+
        '<div><span>主因</span><strong>'+escapeHtml(first?.causes?.[0]?.label || '-')+'</strong></div>'+
        '<div><span>次因</span><strong>'+escapeHtml(first?.causes?.[1]?.label || '-')+'</strong></div>'+
      '</div>'+
      (first ? '<p class="next">'+escapeHtml(first.chain?.[2] || first.conclusion || '')+'</p>' : '')+
      '<div class="sop-actions">'+
        (first ? copyButton(rootCauseCommandText(first), '复制第一仗') : '')+
        firstButtons.map(b => '<button class="status-btn" data-sop-tab="'+escapeHtml(b.tab)+'" data-sop-q="'+escapeHtml(b.q || '')+'" data-sop-store="'+escapeHtml(b.store || '')+'">'+escapeHtml(b.label)+'</button>').join('')+
      '</div>'+
    '</article>'+
    '<div class="command-lanes">'+lanes.map(l =>
      '<article class="command-lane">'+
        '<div class="row1"><span class="tag '+(l.label === '找增长' ? 'good' : Number(l.score||0) > 1000 ? 'high' : 'mid')+'">'+escapeHtml(l.label)+'</span><span class="score">'+num(l.score)+'</span></div>'+
        '<h4>'+escapeHtml(l.title)+'</h4>'+
        '<div class="lane-target">'+escapeHtml(l.target)+'</div>'+
        '<p>'+escapeHtml(l.reason).slice(0,120)+'</p>'+
        '<p class="next">'+escapeHtml(l.next).slice(0,120)+'</p>'+
        '<div class="lane-foot">'+
          copyButton(l.copy, '复制指令')+
          '<button class="status-btn" data-sop-tab="'+escapeHtml(l.button.tab || 'actions')+'" data-sop-focus="'+escapeHtml(l.button.focus || '')+'" data-sop-domain="'+escapeHtml(l.button.domain || '')+'" data-sop-risk="'+escapeHtml(l.button.risk || '')+'" data-sop-q="'+escapeHtml(l.button.q || '')+'" data-sop-store="'+escapeHtml(l.button.store || '')+'" data-sop-action-key="'+(l.button.action ? encodeURIComponent(actionKey(l.button.action)) : '')+'">'+escapeHtml(l.button.label)+'</button>'+
        '</div>'+
      '</article>'
    ).join('')+'</div>';
}
function reviewSpecForAction(a){
  const text = actionSearchText(a);
  if (a.action_domain === 'link' && /补链接|缺上架|缺链接|补覆盖/.test(text)) {
    return {label:'补覆盖复查', days:7, metrics:'曝光、商详访客、订单', done:'新链接已上架或确认该店暂不卖', review:'7 天看曝光；14 天看是否产生商详访客和订单'};
  }
  if (a.action_domain === 'link' && /下架|淘汰|替换/.test(text)) {
    return {label:'止损复查', days:7, metrics:'替代链接曝光、支付率、订单', done:'弱链接已替换，或唯一承接已先补新链接', review:'3-7 天看替代链接是否接住曝光和订单'};
  }
  if (a.action_domain === 'link') {
    return {label:'承接复查', days:3, metrics:'点击率、商详访客、支付率', done:'主图/价格/标题/评价/活动至少修一项', review:'3 天看点击率；7 天看支付率和订单'};
  }
  if (a.action_domain === 'inventory') {
    return {label:'库存复查', days:1, metrics:'展示库存、售罄状态、订单', done:'已确认展示库存并完成必要调整', review:'次日看展示库存；3 天看售罄/取消是否继续出现'};
  }
  if (a.action_domain === 'quality' || a.action_domain === 'after_sales') {
    return {label:'售后质量复查', days:7, metrics:'新售后单、低星评价、退货原因', done:'已定位退货/低星主因并完成页面或质检处理', review:'7-14 天看新售后和低星是否下降'};
  }
  return {label:'经营复查', days:7, metrics:'订单、风险分、动作是否复发', done:'已完成处理并记录备注', review:'7 天后回看同对象是否再次进入动作池'};
}
function addDaysIso(iso, days){
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString();
}
function daysUntil(iso){
  if (!iso) return null;
  const due = new Date(iso);
  if (Number.isNaN(due.getTime())) return null;
  const today = new Date();
  due.setHours(0,0,0,0);
  today.setHours(0,0,0,0);
  return Math.ceil((due - today) / 86400000);
}
function buildReviewQueue(){
  const rows = [];
  for (const a of DATA.actions || []) {
    const key = actionKey(a);
    const rec = actionState[key];
    if (!rec || (rec.status === 'open' && !rec.owner && !rec.note)) continue;
    const spec = reviewSpecForAction(a);
    const dueAt = rec.status === 'review' ? new Date().toISOString() : addDaysIso(rec.updatedAt, spec.days);
    const left = daysUntil(dueAt);
    const dueState = rec.status === 'review' ? 'due' : left == null ? 'todo' : left < 0 ? 'overdue' : left <= 1 ? 'due' : 'todo';
    rows.push({action:a, key, rec, spec, dueAt, left, dueState});
  }
  return rows.sort((a,b) => {
    const rank = x => x.dueState === 'overdue' ? 0 : x.dueState === 'due' ? 1 : 2;
    return rank(a)-rank(b) || String(a.dueAt || '').localeCompare(String(b.dueAt || '')) || Number(b.action.score||0)-Number(a.action.score||0);
  });
}
function reviewTemplateRows(){
  return [
    {label:'补链接后', days:'7/14 天', metrics:'曝光、商详访客、订单', review:'7 天看曝光是否进来；14 天看是否有商详访客和订单。'},
    {label:'优化承接后', days:'3/7 天', metrics:'点击率、支付率、订单', review:'3 天看点击率；7 天看支付率和订单。'},
    {label:'售后质量处理后', days:'7/14 天', metrics:'新售后、低星、退货原因', review:'7-14 天看新售后和低星是否下降。'},
    {label:'展示库存调整后', days:'1/3 天', metrics:'展示库存、售罄、取消', review:'次日看库存是否恢复；3 天看取消/售罄是否继续。'}
  ];
}
function reviewCommandText(row){
  const a = row.action;
  return [
    'SHEIN BI 复查指令',
    '复查类型：' + row.spec.label,
    '店铺：' + (a.store_key || '-'),
    '货号：' + (a.standard_goods_sn || '-'),
    'SKC：' + (a.skc || '-'),
    '原动作：' + (a.category || a.title || '-'),
    '负责人：' + (row.rec.owner || '-'),
    '处理备注：' + (row.rec.note || '-'),
    '完成定义：' + row.spec.done,
    '复查时间：' + (row.left == null ? '-' : row.left < 0 ? '已逾期 ' + Math.abs(row.left) + ' 天' : row.left === 0 ? '今天' : row.left + ' 天后'),
    '复查指标：' + row.spec.metrics,
    '复查动作：' + row.spec.review
  ].join('\\n');
}
function renderReviewQueue(){
  const rows = buildReviewQueue();
  const due = rows.filter(x => x.dueState === 'due' || x.dueState === 'overdue').length;
  $('reviewQueueTag').textContent = rows.length ? ('待复查 ' + num(due) + ' / 已追踪 ' + num(rows.length)) : '等待动作处理后生成';
  if (!rows.length) {
    $('reviewQueue').innerHTML =
      '<div class="review-grid">'+reviewTemplateRows().map(t =>
        '<article class="review-card">'+
          '<div class="row1"><span class="tag info">'+escapeHtml(t.label)+'</span><span class="mono">'+escapeHtml(t.days)+'</span></div>'+
          '<h4>'+escapeHtml(t.metrics)+'</h4>'+
          '<p>'+escapeHtml(t.review)+'</p>'+
          '<div class="lane-foot">'+copyButton('SHEIN BI 复查模板\\n场景：'+t.label+'\\n时间：'+t.days+'\\n指标：'+t.metrics+'\\n动作：'+t.review, '复制模板')+'</div>'+
        '</article>'
      ).join('')+'</div>'+
      '<p class="next">当前还没有已处理/待复查动作。先在今日动作池里标记负责人、备注和状态，系统就会自动生成复查队列。</p>';
    return;
  }
  $('reviewQueue').innerHTML =
    '<div class="review-grid">'+rows.slice(0,8).map(r => {
      const a = r.action;
      const dueText = r.left == null ? '-' : r.left < 0 ? '逾期 ' + Math.abs(r.left) + ' 天' : r.left === 0 ? '今天复查' : r.left + ' 天后';
      const cls = r.dueState === 'overdue' ? 'overdue' : r.dueState === 'due' ? 'due' : '';
      return '<article class="review-card '+cls+'">'+
        '<div class="row1"><span class="tag '+(cls === 'overdue' ? 'high' : cls === 'due' ? 'mid' : 'info')+'">'+escapeHtml(r.spec.label)+'</span><span class="score">'+escapeHtml(dueText)+'</span></div>'+
        '<h4>'+escapeHtml(a.store_key || '-')+'｜'+escapeHtml(a.standard_goods_sn || a.skc || a.category || '-')+'</h4>'+
        '<p>'+escapeHtml(a.category || a.title || '-')+'</p>'+
        '<div class="review-meta">'+
          '<div><span>负责人</span><strong>'+escapeHtml(r.rec.owner || '-')+'</strong></div>'+
          '<div><span>状态</span><strong>'+escapeHtml(statusLabel(r.rec.status || 'open'))+'</strong></div>'+
          '<div><span>指标</span><strong>'+escapeHtml(r.spec.metrics).slice(0,18)+'</strong></div>'+
        '</div>'+
        '<p class="next">'+escapeHtml(r.spec.review)+'</p>'+
        (r.rec.note ? '<p class="muted">备注：'+escapeHtml(r.rec.note)+'</p>' : '')+
        '<div class="lane-foot">'+
          copyButton(reviewCommandText(r), '复制复查')+
          '<button class="status-btn" data-sop-tab="actions" data-sop-q="'+escapeHtml(a.standard_goods_sn || a.skc || '')+'" data-sop-store="'+escapeHtml(a.store_key || '')+'" data-sop-action-key="'+encodeURIComponent(r.key)+'">看原动作</button>'+
          '<button class="status-btn" data-action-status="done" data-action-key="'+encodeURIComponent(r.key)+'">复查完成</button>'+
        '</div>'+
      '</article>';
    }).join('')+'</div>';
}
function renderCharts(){
  const stores = DATA.stores || [];
  const maxSales = Math.max(1, ...stores.map(s => Number(s.sales_sar || 0)));
  const maxRisk = Math.max(1, ...stores.map(s => Number(s.risk_score || 0)));
  const w = 720, h = 320, left = 58, right = 24, top = 28, bottom = 42;
  const plotW = w - left - right, plotH = h - top - bottom;
  const x = v => left + (Number(v || 0) / maxSales) * plotW;
  const y = v => top + plotH - (Number(v || 0) / maxRisk) * plotH;
  const midX = x(maxSales * 0.5), midY = y(maxRisk * 0.5);
  const points = stores.map(s => {
    const risk = riskLevel(s.risk_score);
    const fill = risk === 'high' ? 'rgba(251,113,133,.88)' : risk === 'mid' ? 'rgba(251,191,36,.86)' : 'rgba(52,211,153,.82)';
    const cx = x(s.sales_sar), cy = y(s.risk_score);
    const r = 7 + Math.min(9, Number(s.after_sales_case_count || 0) / 14);
    return '<g class="scatter-point" data-store="'+escapeHtml(s.store_key)+'">'+
      '<title>'+escapeHtml(s.store_key)+' 销售 '+money(s.sales_sar)+' 风险 '+num(s.risk_score)+' 售后 '+num(s.after_sales_case_count)+'</title>'+
      '<circle cx="'+cx.toFixed(1)+'" cy="'+cy.toFixed(1)+'" r="'+r.toFixed(1)+'" fill="'+fill+'" stroke="rgba(255,255,255,.55)" stroke-width="1"/>'+
      '<text x="'+(cx+10).toFixed(1)+'" y="'+(cy+4).toFixed(1)+'" class="chart-label">'+escapeHtml(s.store_key)+'</text>'+
    '</g>';
  }).join('');
  $('storeScatter').innerHTML =
    '<svg class="chart-svg" viewBox="0 0 '+w+' '+h+'" role="img" aria-label="店铺销售和风险散点图">'+
      '<line x1="'+left+'" y1="'+(top+plotH)+'" x2="'+(w-right)+'" y2="'+(top+plotH)+'" stroke="rgba(148,163,184,.28)"/>'+
      '<line x1="'+left+'" y1="'+top+'" x2="'+left+'" y2="'+(top+plotH)+'" stroke="rgba(148,163,184,.28)"/>'+
      '<line x1="'+midX+'" y1="'+top+'" x2="'+midX+'" y2="'+(top+plotH)+'" stroke="rgba(148,163,184,.14)" stroke-dasharray="5 6"/>'+
      '<line x1="'+left+'" y1="'+midY+'" x2="'+(w-right)+'" y2="'+midY+'" stroke="rgba(148,163,184,.14)" stroke-dasharray="5 6"/>'+
      '<text x="'+left+'" y="'+(h-12)+'" class="axis-label">销售低</text><text x="'+(w-right-54)+'" y="'+(h-12)+'" class="axis-label">销售高</text>'+
      '<text x="10" y="'+top+'" class="axis-label">风险高</text><text x="10" y="'+(top+plotH)+'" class="axis-label">风险低</text>'+
      '<text x="'+(midX+8)+'" y="'+(midY-8)+'" class="chart-muted">右上角：优先盯紧</text>'+
      points+
    '</svg>';
  document.querySelectorAll('.scatter-point').forEach(el => el.addEventListener('click', () => {
    state.store = el.dataset.store || '';
    $('storeFilter').value = state.store;
    jumpToTab('stores', {keepFilters:true});
    renderAll();
  }));

  const storeCodes = [...STORE_CODES].sort();
  const topProducts = [...(DATA.products || [])]
    .sort((a,b)=>Number(b.risk_score||0)-Number(a.risk_score||0))
    .slice(0, 12)
    .map(p => p.standard_goods_sn);
  const matrixMap = new Map((DATA.matrix || []).map(m => [m.store_key + '|' + m.standard_goods_sn, m]));
  const header = '<div class="heat-row heat-head"><div></div>'+storeCodes.map(s => '<div class="heat-product" style="text-align:center">'+s+'</div>').join('')+'</div>';
  const rows = topProducts.map(sn => {
    const cells = storeCodes.map(store => {
      const m = matrixMap.get(store + '|' + sn);
      let cls = 'none', label = '·', title = store + ' ' + sn + '：暂无数据';
      if (m) {
        if (Number(m.action_count || 0) > 0) { cls = 'act'; label = String(m.action_count); }
        else if (m.need_supplement_link) { cls = 'miss'; label = '缺'; }
        else if (m.has_on_shelf_link) { cls = 'on'; label = '上'; }
        title = store + ' ' + sn + '：' + (m.coverage_status || '-') + '；上架 ' + num(m.on_shelf_count) + '；动作 ' + num(m.action_count) + '；销售 ' + money(m.sales_sar);
      }
      return '<button class="heat-cell '+cls+'" data-store="'+store+'" data-product="'+escapeHtml(sn)+'" title="'+escapeHtml(title)+'">'+label+'</button>';
    }).join('');
    return '<div class="heat-row"><div class="heat-product" title="'+escapeHtml(sn)+'">'+escapeHtml(sn)+'</div>'+cells+'</div>';
  }).join('');
  $('coverageHeatmap').innerHTML = '<div class="heatmap">'+header+rows+'</div>';
  document.querySelectorAll('.heat-cell').forEach(el => el.addEventListener('click', () => {
    state.store = el.dataset.store || '';
    state.q = el.dataset.product || '';
    $('storeFilter').value = state.store;
    $('q').value = state.q;
    jumpToTab('products', {keepFilters:true});
    renderAll();
  }));
}
function renderStores(){
  const rangeMap = new Map(aggregateDailyStores().map(x => [x.store_key, x]));
  const stores = (DATA.stores || []).filter(includes).map(s => {
    const r = rangeMap.get(s.store_key) || {};
    return {...s, period_sales_sar:Number(r.sales_sar ?? s.sales_sar ?? 0), period_orders:Number(r.orders ?? s.valid_order_count ?? 0), period_quantity:Number(r.quantity ?? s.quantity ?? 0)};
  });
  $('storeCards').innerHTML = stores.map(s => '<article class="store-card" data-store="'+s.store_key+'"><div class="row1"><strong>'+s.store_key+'</strong>'+riskTag(s.risk_score)+'</div><div class="bar"><i style="width:'+Math.min(100,Number(s.risk_score||0)/2.4)+'%"></i></div><div class="metric-row"><div class="mini"><span>当前销售</span><strong>'+money(s.period_sales_sar)+'</strong></div><div class="mini"><span>售后</span><strong>'+num(s.after_sales_case_count)+'</strong></div><div class="mini"><span>链接动作</span><strong>'+num(s.link_action_count)+'</strong></div></div></article>').join('') || '<div class="empty">没有匹配店铺</div>';
  document.querySelectorAll('.store-card').forEach(el => el.addEventListener('click', () => {
    state.store = el.dataset.store;
    $('storeFilter').value = state.store;
    renderAll();
  }));
  $('storesTable').innerHTML = table(stores, [
    ['店铺', r => '<b>'+r.store_key+'</b><div class="muted">'+(r.group_key || '')+'</div>'],
    ['风险', r => riskTag(r.risk_score)+'<div class="mono">'+num(r.risk_score)+'</div>'],
    ['当前时段销售', r => money(r.period_sales_sar), 'num'],
    ['当前订单/销量', r => num(r.period_orders)+' / '+num(r.period_quantity), 'num'],
    ['待结算', r => money(r.pending_settlement_income_sar), 'num'],
    ['售后', r => num(r.after_sales_case_count)+' 单<br><span class="muted">'+money(r.after_sales_item_amount_sar)+'</span>', 'num'],
    ['库存/质量', r => '低库存 '+num(r.low_display_stock_count)+'<br><span class="muted">低星 '+num(r.low_star_comment_count)+'</span>'],
    ['链接动作', r => num(r.link_action_count)+'<br><span class="muted">下架候选 '+num(r.retire_action_count)+'</span>', 'num']
  ]);
}
function renderDomains(){
  const arr = DATA.actionDomain || [];
  const total = arr.reduce((a,b) => a + Number(b.count || 0), 0);
  $('actionTotal').textContent = total + ' 条';
  $('domainBars').innerHTML = arr.map(d => '<div style="margin-bottom:16px"><div class="row1"><span>'+domainName(d.action_domain)+'</span><strong class="mono">'+d.count+'</strong></div><div class="bar"><i style="width:'+(total ? Number(d.count)/total*100 : 0)+'%"></i></div></div>').join('');
  const topStore = [...(DATA.stores || [])].sort((a,b)=>Number(b.risk_score||0)-Number(a.risk_score||0))[0];
  const topProduct = [...(DATA.products || [])].sort((a,b)=>Number(b.risk_score||0)-Number(a.risk_score||0))[0];
  $('decisionTips').innerHTML = '<div class="split">'+
    '<div class="tag high" style="white-space:normal;line-height:1.5">优先店铺：'+(topStore?.store_key || '-')+'，先看售后、质量和库存是否集中。</div>'+
    '<div class="tag mid" style="white-space:normal;line-height:1.5">优先货号：'+(topProduct?.standard_goods_sn || '-')+'，先判断是链接覆盖、转化还是售后问题。</div>'+
    '</div>';
}
function isUsefulLinkLabel(label){
  const s = String(label || '').trim();
  if (!s) return false;
  if (/创建营销活动|优化商品信息|商品信息|无判断|undefined|null/i.test(s)) return false;
  if (/三明治|早餐机|杆式吸尘器|绞肉机|榨汁机|咖啡机|制冰机|热风梳|卷发|直发|电热水壶|熨烫机|食品料理机|Handheld|Brush|Blow Dryer/i.test(s)) return false;
  return /备货款|新款|中东|高销|销量|上涨|下滑|C\d|B\d|D\d|质量\s*[A-Z]\d|低曝光|低点击|低支付|高曝光|高访客|优化价格|活动|爆款|潜力|层级|A\d/i.test(s);
}
function linkLabelChips(r){
  const tags = [];
  if (Array.isArray(r.skc_tags)) {
    for (const tag of r.skc_tags) {
      if (isUsefulLinkLabel(tag)) tags.push(['good', tag]);
    }
  }
  if (isUsefulLinkLabel(r.skc_label)) tags.push(['good', r.skc_label]);
  if (isUsefulLinkLabel(r.activity_label)) tags.push(['info', r.activity_label]);
  if (isUsefulLinkLabel(r.quality_grade)) tags.push(['mid', '质量 ' + r.quality_grade]);
  if (!tags.length) return '<span class="muted">暂无标签</span>';
  const seen = new Set();
  return tags
    .filter(([, label]) => {
      if (!label || seen.has(label)) return false;
      seen.add(label);
      return true;
    })
    .map(([cls,label]) => '<span class="tag '+cls+'">'+escapeHtml(label)+'</span>')
    .join(' ');
}
function sameStoreProductLinksIncludingSelf(r, allLinks = []){
  if (!r) return [];
  const store = String(r.store_key || '');
  const sn = String(r.standard_goods_sn || '');
  const skc = String(r.skc || '');
  return (allLinks || [])
    .filter(x => {
      if (String(x.store_key || '') !== store) return false;
      if (sn && String(x.standard_goods_sn || '') === sn) return true;
      if (skc && String(x.skc || '') === skc) return true;
      return false;
    })
    .sort((a,b)=>Number(b.c30_sale_cnt||0)-Number(a.c30_sale_cnt||0) || Number(b.c7_sale_cnt||0)-Number(a.c7_sale_cnt||0) || Number(b.c30_eps_uv||b.eps_uv||0)-Number(a.c30_eps_uv||a.eps_uv||0));
}
function sameStoreSameProductLinks(r, allLinks = []){
  return sameStoreProductLinksIncludingSelf(r, allLinks).filter(x => String(x.skc || '') !== String(r?.skc || ''));
}
function isOnShelfLink(r){
  return Boolean(r?.is_on_shelf) || r?.shelf_status === 'ON_SHELF' || r?.shelf_status_name === '\u5df2\u4e0a\u67b6';
}
function isWaitShelfLink(r){
  return Boolean(r?.is_wait_shelf) || r?.shelf_status === 'WAIT_SHELF' || r?.shelf_status_name === '\u5f85\u4e0a\u67b6';
}
function bestAlternativeLink(r, allLinks = []){
  return sameStoreSameProductLinks(r, allLinks)
    .filter(isOnShelfLink)
    .sort((a,b)=>Number(b.c30_sale_cnt||0)-Number(a.c30_sale_cnt||0) || Number(b.c7_sale_cnt||0)-Number(a.c7_sale_cnt||0) || Number(b.c30_goods_uv||b.goods_uv||0)-Number(a.c30_goods_uv||a.goods_uv||0))[0] || null;
}
function waitShelfAlternative(r, allLinks = []){
  return sameStoreSameProductLinks(r, allLinks).find(isWaitShelfLink) || null;
}
function linkDecision(r, allLinks = []){
  const c30Sale = Number(r.c30_sale_cnt || 0);
  const c7Sale = Number(r.c7_sale_cnt || 0);
  const c30Uv = Number(r.c30_goods_uv ?? r.goods_uv ?? 0);
  const best = bestAlternativeLink(r, allLinks);
  const wait = waitShelfAlternative(r, allLinks);
  const bestC30 = Number(best?.c30_sale_cnt || r.group_best_c30 || 0);
  const bestC7 = Number(best?.c7_sale_cnt || 0);
  const rank = Number(r.group_rank || 0);
  if (rank === 1) return {role:'当前最佳', level:'good', text:'当前同货号表现最好，优先保留；可复制标签、活动和承接打法。'};
  if ((r.retire_candidate || (c30Sale === 0 && c7Sale === 0)) && best && (bestC30 > 0 || bestC7 > 0)) {
    if (c30Uv <= 9) return {role:'可果断下架', level:'high', text:'30天销量0且访客个位数；同店已有替代上架链接 '+best.skc+'（30天销量 '+num(bestC30)+'，7天销量 '+num(bestC7)+'），可优先下架/停用弱链接。'};
    return {role:'淘汰候选', level:'high', text:'30天销量0；同店已有替代上架链接 '+best.skc+'（30天销量 '+num(bestC30)+'，7天销量 '+num(bestC7)+'），先确认库存/活动后替换。'};
  }
  if ((r.retire_candidate || c30Sale === 0) && wait) return {role:'先推替代', level:'mid', text:'当前链接30天销量0，且同货号有待上架链接 '+wait.skc+'；先补资料/上架替代链接，再淘汰旧链接。'};
  if (best && c30Sale < bestC30) {
    const gap = bestC30 - c30Sale;
    if (c30Uv <= 9 && c30Sale === 0) return {role:'弱且无流量', level:'high', text:'弱于最佳且30天访客个位数；最佳 '+best.skc+' 30天销量 '+num(bestC30)+'，建议下架弱链接。'};
    return {role:'弱于最佳', level:'mid', text:'弱于同店最佳 '+best.skc+'，30天销量差 '+num(gap)+'；若没有活动/标签优势，优先替换或下架。'};
  }
  if (r.high_exposure_low_click) return {role:'修点击', level:'mid', text:'高曝光低点击，优先看主图、标题、价格带和活动露出。'};
  if (r.high_visit_low_pay) return {role:'修支付', level:'mid', text:'高访客低支付，优先看价格、评价、详情承接和活动承接。'};
  if (r.wait_shelf_block_candidate) return {role:'补资料', level:'mid', text:'待上架卡点，优先补证书/资质/资料或处理审核驳回。'};
  if (c30Sale > 0 || c7Sale > 0) return {role:'保留观察', level:'good', text:'近7/30天有销量，优先保留；可参考其标签/活动打法。'};
  return {role:'观察', level:'info', text:'暂无明确替代链接或强风险，不直接下架；先观察或补新链接。'};
}
function linkRoleTag(r, allLinks = []){
  const d = linkDecision(r, allLinks);
  if (d.role === '当前最佳') return '<span class="best-link">当前最佳</span>';
  const cls = d.level === 'high' ? 'high' : d.level === 'good' ? 'good' : d.level === 'mid' ? 'mid' : 'info';
  return '<span class="tag '+cls+'">'+escapeHtml(d.role)+'</span>';
}
function linkIssueText(r, allLinks = []){ return linkDecision(r, allLinks).text; }
function storeActionReasonHtml(action, allLinks = []){
  const domain = String(action.action_domain || action.domain || '').toLowerCase();
  const link = allLinks.find(x => String(x.skc || '') === String(action.skc || ''));
  if (link && (domain.includes('link') || domain.includes('链接'))) {
    const d = linkDecision(link, allLinks);
    return '<span class="decision-strong">'+escapeHtml(d.role)+'</span><span class="decision-note">'+escapeHtml(d.text)+'</span>';
  }
  return escapeHtml(action.reason || '').slice(0, 140);
}
function parseEvidencePairs(text){
  const pairs = {};
  for (const part of String(text || '').split(',')) {
    const [rawKey, ...rest] = part.trim().split('=');
    if (!rawKey || !rest.length) continue;
    pairs[rawKey.trim()] = rest.join('=').trim();
  }
  return pairs;
}
function evidenceGridHtml(items){
  const rows = (items || []).filter(([,v]) => v !== undefined && v !== null && v !== '');
  if (!rows.length) return '';
  return '<div class="evidence-grid">'+rows.map(([k,v]) => '<span>'+escapeHtml(k)+'</span><b>'+escapeHtml(String(v))+'</b>').join('')+'</div>';
}
function inventoryEvidenceHtml(action){
  const p = parseEvidencePairs(action.evidence || '');
  const items = [
    ['\u6700\u4f4e\u53ef\u552e', p.min_usable],
    ['\u53ef\u552e\u5408\u8ba1', p.usable_total],
    ['\u5e93\u5b58\u5408\u8ba1', p.inventory_total],
    ['\u9501\u5b9a', p.locked],
    ['30\u5929\u94fe\u63a5\u9500\u91cf', p.c30_sale],
    ['30\u5929\u8ba2\u5355\u9500\u91cf', p.order30],
  ].filter(([,v]) => v !== undefined && v !== '');
  if (!items.length) return escapeHtml(action.evidence || '-');
  return evidenceGridHtml(items);
}
function actionEvidenceItems(action){
  if (!action) return [];
  const p = parseEvidencePairs(action.evidence || '');
  const items = [];
  if (p.weakC7 || p.bestC7 || p.weakC30 || p.bestC30) {
    items.push(['\u5f31\u94fe\u63a57\u5929\u9500\u91cf', p.weakC7 ?? '-']);
    items.push(['\u6700\u4f737\u5929\u9500\u91cf', p.bestC7 ?? '-']);
    items.push(['\u5f31\u94fe\u63a530\u5929\u9500\u91cf', p.weakC30 ?? '-']);
    items.push(['\u6700\u4f7330\u5929\u9500\u91cf', p.bestC30 ?? '-']);
  }
  if (p.cases || p.amount || p.status) {
    items.push(['\u552e\u540e\u5355\u6570', p.cases]);
    items.push(['\u552e\u540e\u91d1\u989d', p.amount ? money(p.amount) : '']);
    items.push(['\u72b6\u6001', p.status]);
  }
  if (!items.length) {
    const labelMap = {
      weakC7:'\u5f31\u94fe\u63a57\u5929\u9500\u91cf',
      bestC7:'\u6700\u4f737\u5929\u9500\u91cf',
      weakC30:'\u5f31\u94fe\u63a530\u5929\u9500\u91cf',
      bestC30:'\u6700\u4f7330\u5929\u9500\u91cf',
      cases:'\u552e\u540e\u5355\u6570',
      amount:'\u91d1\u989d',
      status:'\u72b6\u6001',
      min_usable:'\u6700\u4f4e\u53ef\u552e',
      usable_total:'\u53ef\u552e\u5408\u8ba1',
      inventory_total:'\u5e93\u5b58\u5408\u8ba1',
      locked:'\u9501\u5b9a',
      c30_sale:'30\u5929\u94fe\u63a5\u9500\u91cf',
      order30:'30\u5929\u8ba2\u5355\u9500\u91cf',
      quality_return_rate:'\u8d28\u91cf\u9000\u8d27\u7387',
      avg_quality_return_rate:'\u5e73\u5747\u8d28\u91cf\u9000\u8d27\u7387',
      bad_eval_cnt:'\u5dee\u8bc4/\u4f4e\u661f\u6570',
      return_volume:'\u9000\u8d27\u91cf',
      quality_return_volume:'\u8d28\u91cf\u9000\u8d27\u91cf',
      level:'\u8d28\u91cf\u7b49\u7ea7'
    };
    const pctKeys = new Set(['quality_return_rate','avg_quality_return_rate']);
    for (const [k,v] of Object.entries(p)) {
      let val = v;
      if (k === 'amount' && !Number.isNaN(Number(v))) val = money(v);
      else if (pctKeys.has(k) && !Number.isNaN(Number(v))) val = pct(Number(v));
      items.push([labelMap[k] || k, val]);
    }
  }
  return items;
}
function actionEvidenceText(action){
  const items = actionEvidenceItems(action).filter(([,v]) => v !== undefined && v !== null && v !== '');
  if (items.length) return items.map(([k,v]) => k + '\uff1a' + v).join('\uff1b');
  return String(action?.evidence || '').trim();
}
function actionEvidenceHtml(action){
  if (!action) return '';
  if (action.action_domain === 'inventory') return inventoryEvidenceHtml(action);
  const domain = String(action.action_domain || '').toLowerCase();
  const items = actionEvidenceItems(action);
  const grid = evidenceGridHtml(items);
  if (grid) return grid;
  const raw = String(action.evidence || '').trim();
  if (!raw) return '<span class="muted">\u6682\u65e0\u53ef\u91cf\u5316\u8bc1\u636e</span>';
  if (domain.includes('link')) return '<span class="decision-note">'+escapeHtml(raw).slice(0,160)+'</span>';
  return '<span class="muted">'+escapeHtml(raw).slice(0,160)+'</span>';
}
function mergedActionSignalsHtml(action){
  const rows = Array.isArray(action?._mergedActions) ? action._mergedActions : [];
  if (rows.length <= 1) return '';
  return '<div class="merged-signal-list">'+rows.map(x => {
    const reason = String(x.reason || '').trim();
    const evidence = actionEvidenceText(x) || String(x.evidence || '').trim();
    return '<div class="merged-signal">'+
      '<b>'+escapeHtml(x.category || x.title || '-')+'</b>'+
      (reason ? '<span>'+escapeHtml(reason)+'</span>' : '')+
      (evidence ? '<small>'+escapeHtml(evidence).slice(0,220)+'</small>' : '')+
    '</div>';
  }).join('')+'</div>';
}
function stockEvidenceHtml(row){
  const items = [
    ['\u53ef\u552e', row.usable_inventory],
    ['\u5c55\u793a', row.inventory_quantity],
    ['\u9501\u5b9a', Number(row.order_locked_quantity || 0) + Number(row.pay_locked_quantity || 0)],
  ];
  return '<div class="evidence-grid">'+items.map(([k,v]) => '<span>'+escapeHtml(k)+'</span><b>'+num(v)+'</b>').join('')+'</div>';
}
function linkMetricUv(r){ return num(r.c30_eps_uv ?? r.eps_uv) + ' / ' + num(r.c30_goods_uv ?? r.goods_uv); }
function linkMetricUv7(r){ return num(r.c7_eps_uv) + ' / ' + num(r.c7_goods_uv); }
function linkMetricUv30(r){ return num(r.c30_eps_uv ?? r.eps_uv) + ' / ' + num(r.c30_goods_uv ?? r.goods_uv); }
function linkPayRate(r){ return pct(r.c30_pay_rate ?? r.pay_rate); }
function linkPayRate7(r){ return pct(r.c7_pay_rate); }
function linkPayRate30(r){ return pct(r.c30_pay_rate ?? r.pay_rate); }
function linkMetricGroups(includePay = true){
  const groups = [
    {title:'曝光', cols:[{label:'7天', value:r=>num(r.c7_eps_uv)}, {label:'30天', value:r=>num(r.c30_eps_uv ?? r.eps_uv)}]},
    {title:'访客', cols:[{label:'7天', value:r=>num(r.c7_goods_uv)}, {label:'30天', value:r=>num(r.c30_goods_uv ?? r.goods_uv)}]},
    {title:'销量', cols:[{label:'7天', value:r=>num(r.c7_sale_cnt)}, {label:'30天', value:r=>num(r.c30_sale_cnt)}]},
  ];
  if (includePay) {
    groups.push({title:'支付率', cols:[{label:'7天', value:r=>linkPayRate7(r)}, {label:'30天', value:r=>linkPayRate30(r)}]});
  }
  return groups;
}
function commentText(r){
  return String(r.goods_comment_content || '').trim() || '无文字评价';
}
function commentZh(r){
  return String(r.goods_comment_content_zh || r.goods_comment_content_cn || r.translated_content_zh || '').trim();
}
function commentRowLevel(r){
  const star = Number(r.goods_comment_star || 0);
  const quality = /是|1|true|Y/i.test(String(r.is_quality_complaint || r.is_quality || ''));
  if (star > 0 && star <= 2) return 'high';
  if (star === 3 || quality || r.bad_comment_labels) return 'mid';
  return 'good';
}
function commentLevelText(r){
  const level = commentRowLevel(r);
  if (level === 'high') return '低星优先';
  if (level === 'mid') return '关注';
  return '好评/普通';
}
function commentStoreSummary(rows){
  const map = new Map();
  for (const r of rows || []) {
    const key = r.store_key || '-';
    const row = map.get(key) || {store_key:key, count:0, low:0, sum:0, latest:''};
    const star = Number(r.goods_comment_star || 0);
    row.count += 1;
    if (star > 0) row.sum += star;
    if (star > 0 && star <= 3) row.low += 1;
    const d = String(r.comment_date || '').slice(0,10);
    if (d > row.latest) row.latest = d;
    map.set(key, row);
  }
  return [...map.values()].map(r => ({...r, avg:r.count ? r.sum / r.count : 0})).sort((a,b)=>b.low-a.low || b.count-a.count || a.store_key.localeCompare(b.store_key));
}
function commentProductSummary(rows){
  const map = new Map();
  for (const r of rows || []) {
    const key = r.standard_goods_sn || '未归并货号';
    const row = map.get(key) || {standard_goods_sn:key, comment_count:0, low_star_count:0, sum:0, star_count:0, stores:new Set(), latest_comment_date:''};
    const star = Number(r.goods_comment_star || 0);
    row.comment_count += 1;
    if (star > 0) {
      row.sum += star;
      row.star_count += 1;
      if (star <= 3) row.low_star_count += 1;
    }
    if (r.store_key) row.stores.add(r.store_key);
    const d = String(r.comment_date || r.comment_time || '').slice(0,10);
    if (d > row.latest_comment_date) row.latest_comment_date = d;
    map.set(key, row);
  }
  return [...map.values()].map(r => ({
    ...r,
    avg_star:r.star_count ? r.sum / r.star_count : 0,
    store_count:r.stores.size,
    stores:undefined
  })).sort((a,b)=>b.low_star_count-a.low_star_count || b.comment_count-a.comment_count || a.standard_goods_sn.localeCompare(b.standard_goods_sn));
}
function productCommentPreviewHtml(rows, sn){
  const list = (rows || []).slice(0, 8);
  if (!list.length) {
    return '<div class="empty">当前已入库评价里暂未命中 '+escapeHtml(sn || '该货号')+'。后续补历史评价后这里会自动出现。</div>';
  }
  return '<div class="comment-preview">'+list.map(r => {
    const zh = commentZh(r);
    return '<div class="comment-preview-row">'+
      '<div><span class="tag '+commentRowLevel(r)+'">'+escapeHtml(commentLevelText(r))+'</span><small>'+escapeHtml(String(r.comment_date || '').slice(0,10) || '-')+'</small></div>'+
      '<div><b>'+escapeHtml(r.store_key || '-')+'</b><small class="mono">'+escapeHtml(r.skc || '-').slice(0,22)+'</small></div>'+
      '<div><p>'+escapeHtml(commentText(r)).slice(0,220)+'</p><div class="comment-translation">'+(zh ? '中文：'+escapeHtml(zh).slice(0,220) : '中文翻译：待批量翻译入库')+'</div></div>'+
      '<div class="num"><b>'+num(r.goods_comment_star)+'</b> 星<small>'+escapeHtml(r.bad_comment_labels || r.goods_comment_star_name || '-').slice(0,28)+'</small></div>'+
    '</div>';
  }).join('')+'</div>';
}

function duplicateGroups(rows){
  const map = new Map();
  for (const r of rows || []) {
    const key = r.standard_goods_sn || '未归并货号';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return [...map.entries()].map(([sn, items]) => [sn, items.sort((a,b)=>Number(a.group_rank||99)-Number(b.group_rank||99) || Number(b.c30_sale_cnt||0)-Number(a.c30_sale_cnt||0))]);
}
function duplicateLinkGroupHtml(rows, allLinks = []){
  const groups = duplicateGroups(rows).sort((a,b) => {
    const aBest = Number(a[1][0]?.group_best_c30 || a[1][0]?.c30_sale_cnt || 0);
    const bBest = Number(b[1][0]?.group_best_c30 || b[1][0]?.c30_sale_cnt || 0);
    return bBest - aBest || a[0].localeCompare(b[0]);
  });
  if (!groups.length) return '<div class="empty">本店当前没有同货号多条已上架链接。</div>';
  return '<div class="duplicate-groups">'+groups.slice(0,8).map(([sn, items]) => {
    const best = items[0];
    const totalC30 = items.reduce((sum,x)=>sum+Number(x.c30_sale_cnt||0),0);
    return '<article class="duplicate-group">'+
      '<div class="duplicate-head"><div><h4>'+escapeHtml(sn)+'</h4><p>同货号已上架 '+num(items.length)+' 条；30天销量合计 '+num(totalC30)+'；当前最佳 SKC '+escapeHtml(best?.skc || '-')+'。判断会同时看7天、30天和是否有替代链接。</p></div><button class="status-btn" data-product-focus="'+escapeHtml(sn)+'">看货号360</button></div>'+
      groupedTable(items, [
        ['角色', r => linkRoleTag(r, allLinks)],
        ['SKC', r => '<span class="mono">'+escapeHtml(r.skc || '-')+'</span>'+copyButton(r.skc, '复制')],
        ['标签', r => linkLabelChips(r)],
        ['判断', r => '<span class="decision-note">'+escapeHtml(linkIssueText(r, allLinks))+'</span>']
      ], linkMetricGroups(true), {limit:false})+
    '</article>';
  }).join('')+'</div>';
}
function productActionComparisonHtml(action, allLinks = []){
  const sameStoreLinks = sameStoreProductLinksIncludingSelf(action, allLinks);
  const current = sameStoreLinks.find(x => String(x.skc || '') === String(action.skc || '')) || null;
  const onShelf = sameStoreLinks.filter(isOnShelfLink);
  const best = onShelf[0] || sameStoreLinks[0] || null;
  const wait = sameStoreLinks.find(isWaitShelfLink) || null;
  const rows = [];
  if (best) rows.push({...best, _compareRole: best.skc === current?.skc ? '当前最佳' : '同店最佳'});
  if (current && !rows.some(x => String(x.skc || '') === String(current.skc || ''))) rows.push({...current, _compareRole:'当前动作SKC'});
  if (wait && !rows.some(x => String(x.skc || '') === String(wait.skc || ''))) rows.push({...wait, _compareRole:'待上架替代'});
  for (const x of sameStoreLinks) {
    if (rows.length >= 5) break;
    if (!rows.some(r => String(r.skc || '') === String(x.skc || ''))) rows.push({...x, _compareRole:isOnShelfLink(x) ? '同款上架' : isWaitShelfLink(x) ? '待上架' : '同款历史'});
  }
  if (rows.length) {
    return groupedTable(rows, [
      ['角色', r => '<span class="tag '+(r._compareRole === '当前最佳' || r._compareRole === '同店最佳' ? 'good' : r._compareRole === '当前动作SKC' ? 'high' : 'info')+'">'+escapeHtml(r._compareRole)+'</span>'],
      ['SKC', r => '<span class="mono">'+escapeHtml(r.skc || '-')+'</span>'+copyButton(r.skc, '复制')],
      ['状态/标签', r => '<span class="tag '+(isOnShelfLink(r) ? 'good' : isWaitShelfLink(r) ? 'mid' : 'info')+'">'+escapeHtml(r.shelf_status_name || '-')+'</span><br>'+linkLabelChips(r)],
      ['判断', r => '<span class="decision-note">'+escapeHtml(linkIssueText(r, sameStoreLinks))+'</span>']
    ], linkMetricGroups(true), {limit:false});
  }
  return '<span class="decision-note">未在最新链接仓库找到该店该货号的可对比链接；需要先补抓或重新入库该店链接主表，不能直接下结论。</span>';
}
function productRiskVerdict(r){
  const sales = Number(r.period_sales_sar ?? r.sales_sar ?? 0);
  const missing = Number(r.missing_store_count || 0);
  const after = Number(r.after_sales_case_count || 0);
  const lowStars = Number(r.low_star_comment_count || 0);
  const lowStock = Number(r.low_display_stock_count || 0);
  if (after >= 20 || lowStars >= 5) return {level:'high', text:'售后/低星集中：先看评价页和退货原因，暂停放量或先修描述/质量。'};
  if (sales > 0 && missing > 0) return {level:'mid', text:'有销售但覆盖不满：进入货号 360 看缺的是哪些店，优先补有承接价值的店。'};
  if (lowStock > 0) return {level:'mid', text:'低展示库存影响承接：先确认最新展示库存，再决定是否调高库存显示。'};
  if (sales <= 0 && Number(r.on_shelf_store_count || 0) > 0) return {level:'mid', text:'已上架但当前时段无销售：先看同店同款是否有好链接替代，再决定优化或下架。'};
  return {level:'good', text:'暂无强风险：保留观察；如果有好链接，可复制主图、价格、标签和活动打法。'};
}

function actionScoreExplain(a){
  if (!a) return '暂无高优先级动作。';
  return '最高动作分 '+num(a.score)+'：这是动作优先级分，不是金额。分数越高越应该先看；重复弱链接的分数会被“最佳链接与弱链接的30天销量差距”放大。';
}
function renderStoreCockpit(){
  const stores = DATA.stores || [];
  const scope = storeFilterKind();
  const storePool = scope.type === 'group' ? stores.filter(s => storeGroupKey(s) === scope.key) : stores;
  const selected = scope.type === 'store'
    ? stores.find(s => s.store_key === scope.key)
    : [...storePool].sort((a,b)=>Number(b.risk_score||0)-Number(a.risk_score||0))[0];
  if (!selected) {
    $('storeCockpitTag').textContent = '无数据';
    $('storeCockpit').innerHTML = '<div class="empty">暂无店铺数据</div>';
    return;
  }
  const store = selected.store_key;
  $('storeCockpitTag').textContent = scope.type === 'store' ? store : scope.type === 'group' ? groupMeta(scope.key).label + '内默认最高风险 ' + store : '默认最高风险 ' + store;
  const rangeLabel = selectedRangeText();
  const rangeStore = aggregateDailyStores().find(x => x.store_key === store) || {};
  const periodSales = Number(rangeStore.sales_sar ?? selected.sales_sar ?? 0);
  const periodOrders = Number(rangeStore.orders ?? selected.valid_order_count ?? 0);
  const periodQty = Number(rangeStore.quantity ?? 0);
  const actionsAll = (DATA.actions || []).filter(a => a.store_key === store).sort((a,b)=>Number(b.score||0)-Number(a.score||0));
  const linkActions = actionsAll.filter(x => x.action_domain === 'link');
  const afterActions = actionsAll.filter(x => x.action_domain === 'after_sales' || x.action_domain === 'quality');
  const inventoryActions = actionsAll.filter(x => x.action_domain === 'inventory');
  const lowStockActions = inventoryActions.filter(x => String(x.category || '').includes('库存') || String(x.reason || '').includes('库存'));
  const lowStockRows = (DATA.inventoryAlerts || [])
    .filter(x => x.store_key === store)
    .sort((a,b) =>
      Number(a.usable_inventory ?? a.inventory_quantity ?? 999999) - Number(b.usable_inventory ?? b.inventory_quantity ?? 999999)
      || Number(a.inventory_quantity ?? 999999) - Number(b.inventory_quantity ?? 999999)
      || String(a.standard_goods_sn || '').localeCompare(String(b.standard_goods_sn || ''))
      || String(a.skc || '').localeCompare(String(b.skc || ''))
    );
  const businessActions = actionsAll.filter(x => x.action_domain === 'business');
  const topAction = actionsAll[0];
  const matrixAll = (DATA.matrix || []).filter(x => x.store_key === store);
  const afterAll = (DATA.afterSales || []).filter(x => x.store_key === store);
  const afterRange = afterAll.filter(x => inSelectedRange(x, 'request_time'));
  const waybillAll = (DATA.waybills || []).filter(x => x.store_key === store);
  const financeOrdersAll = (DATA.financeOrders || []).filter(x => x.store_key === store);
  const financeGoodsAll = (DATA.financeGoods || []).filter(x => x.store_key === store);
  const allStoreLinks = (DATA.storeLinks || DATA.links || []).filter(x => x.store_key === store);
  const duplicateRows = (DATA.duplicateLinks || []).filter(x => x.store_key === store);
  const duplicateGroupCount = duplicateGroups(duplicateRows).length;
  const missingProducts = matrixAll.filter(x => x.need_supplement_link).length;
  const afterAmount = afterRange.reduce((sum,x)=>sum+Number(x.price_amount_total||0),0);
  const waybillBad = waybillAll.filter(x => ['异常','失败','超时','取消'].some(w => String(x.show_status_desc || '').includes(w))).length;
  const financeGoodsMatched = financeGoodsAll.filter(x => x.standard_goods_sn).length;
  const goodLinks = allStoreLinks
    .filter(x => isOnShelfLink(x) && (Number(x.c30_sale_cnt || 0) > 0 || Number(x.c7_sale_cnt || 0) > 0) && !x.retire_candidate && !x.high_exposure_low_click && !x.high_visit_low_pay)
    .sort((a,b)=>Number(b.c7_sale_cnt||0)-Number(a.c7_sale_cnt||0) || Number(b.c30_sale_cnt||0)-Number(a.c30_sale_cnt||0) || Number(b.c30_goods_uv||b.goods_uv||0)-Number(a.c30_goods_uv||a.goods_uv||0))
    .slice(0, 14);
  const problemLinks = allStoreLinks
    .filter(x => x.retire_candidate || x.high_exposure_low_click || x.high_visit_low_pay || x.wait_shelf_block_candidate || (Number(x.c30_sale_cnt||0) === 0 && Number(x.c7_sale_cnt||0) === 0 && bestAlternativeLink(x, allStoreLinks)))
    .sort((a,b)=>Number(Boolean(b.retire_candidate))-Number(Boolean(a.retire_candidate)) || Number(b.c30_goods_uv||b.goods_uv||0)-Number(a.c30_goods_uv||a.goods_uv||0))
    .slice(0, 14);
  const focusProducts = matrixAll
    .filter(x => x.need_supplement_link || x.duplicate_on_shelf || Number(x.action_count||0) > 0)
    .sort((a,b)=>Number(b.max_action_score||0)-Number(a.max_action_score||0) || Number(b.sales_sar||0)-Number(a.sales_sar||0))
    .slice(0, 10);
  const mainKind = linkActions.length >= afterActions.length && linkActions.length >= businessActions.length ? '链接结构'
    : afterActions.length >= businessActions.length ? '售后/质量' : '履约/经营';
  const verdict = mainKind === '链接结构'
    ? '这个店当前优先从链接结构入手：先看重复链接是否有明确替代，再看缺覆盖、低库存和待优化链接。'
    : mainKind === '售后/质量'
      ? '这个店当前优先从售后/质量入手：先确认退货原因和质量标签，再决定是否优化链接或替换产品。'
      : '这个店当前优先从履约/经营入手：先看异常包裹、低展示库存和财务在途，再处理链接动作。';
  const kpiCards = [
    ['当前时段销售', money(periodSales), rangeLabel + '；订单 ' + num(periodOrders) + '，销量 ' + num(periodQty) + '。这个卡随本页时间筛选变化。'],
    ['链接结构', num(allStoreLinks.filter(isOnShelfLink).length) + ' 条上架', '最新链接日 ' + (DATA.dates?.linkDate || '-') + '；缺覆盖 ' + num(missingProducts) + ' 个货号；重复组 ' + num(duplicateGroupCount) + '。'],
    ['售后/履约压力', num(afterRange.length) + ' 售后 / ' + num(waybillBad) + ' 异常包裹', '售后按申请时间：' + rangeLabel + '；履约是最新业务日快照 ' + (DATA.dates?.businessDate || '-') + '。'],
    ['低展示库存预警', num(lowStockRows.length) + ' 条', '来自 SHEIN 商品列表库存接口，不再用备货信息里的假库存；这里列出本店已上架且展示库存低的 SKC。'],
    ['财务在途收入', num(financeOrdersAll.length) + ' 单 / ' + money(selected.finance_no_finish_order_income_sar), '用于对账和回款跟踪，不代表今天销售；当前是最新财务快照。'],
    ['风险/优先级说明', '风险 ' + num(selected.risk_score) + ' / 最高待办 ' + num(topAction?.score || 0), '这些都是排序分，不是金额、销量或订单数；只用来决定先看哪一条。']
  ];
  const stepCards = [
    ['1. 先定主线', '本店主线：' + mainKind + '。不要从所有表格开始翻，先看本页前四块：重复链接、好链接、库存预警、待处理链接。'],
    ['2. 再做取舍', '重复链接先比较7天/30天销量、访客和替代链接；30天访客个位数且有强替代时，可以果断下架。'],
    ['3. 最后复核', '售后、履约、财务只是复核资料；除非有异常，不要被长明细带偏。']
  ];
  const actionPreview = actionsAll.slice(0, 8);
  $('storeCockpit').innerHTML =
    '<div class="store-flow">'+
      '<article class="store-verdict">'+
        '<div class="row1"><div><h3>'+escapeHtml(store)+' 店铺作战台</h3><p>'+escapeHtml(verdict)+'</p></div>'+riskTag(selected.risk_score)+'</div>'+
        '<div class="store-action-steps">'+stepCards.map(c => '<div class="store-step"><b>'+escapeHtml(c[0])+'</b><p>'+escapeHtml(c[1])+'</p></div>').join('')+'</div>'+
      '</article>'+
      '<div class="store-kpi-grid">'+kpiCards.map(c => '<div class="store-kpi"><span>'+escapeHtml(c[0])+'</span><strong>'+c[1]+'</strong><small>'+escapeHtml(c[2])+'</small></div>').join('')+'</div>'+
    '</div>'+
    '<div class="store-section-title"><div><h3>同货号重复链接对比</h3><div class="sub">这里不是简单写“弱于最佳”，而是把同店同货号所有上架 SKC 放一起，按销量、访客、支付率和替代关系给出更明确判断。</div></div><span class="metric-window-note">表格数字统一：左 7天 / 右 30天</span></div>'+
    duplicateLinkGroupHtml(duplicateRows, allStoreLinks)+
    '<div class="store-section-title"><div><h3>本店好链接 / 可复制打法</h3><div class="sub">不只看差链接。这里列出本店近7/30天有销量、暂无明显承接风险的链接，重点看标签、活动和承接方式。</div></div><span class="tag good">保留/复制</span></div>'+
    groupedTable(goodLinks, [
      ['SKC', r => '<span class="mono">'+escapeHtml(r.skc || '-')+'</span>'+copyButton(r.skc, '复制')],
      ['标准货号', r => '<b>'+escapeHtml(r.standard_goods_sn || '-')+'</b>'],
      ['标签', r => linkLabelChips(r)],
      ['判断', r => escapeHtml(linkIssueText(r, allStoreLinks))]
    ], linkMetricGroups(true), {limit:false})+
    '<div class="store-section-title"><div><h3>本店低展示库存预警</h3><div class="sub">库存来自 SHEIN 商品列表展示库存，不再使用备货信息里的假库存；本表直接列出本店已上架且展示库存低的 SKC，方便你去后台按 SKC 查询。</div></div><span class="tag mid">库存动作 · '+num(lowStockRows.length)+' 条</span></div>'+
    '<div class="stock-warning-table">'+table(lowStockRows, [
      ['SKC / 货号', r => '<b>'+escapeHtml(r.standard_goods_sn || '-')+'</b><br><span class="mono">'+escapeHtml(r.skc || '-')+'</span>'+copyButton(r.skc, '复制')],
      ['库存', r => stockEvidenceHtml(r), 'num'],
      ['状态', r => '<span class="tag good">'+escapeHtml(String(r.shelf_statuses || '').replaceAll('ON_SHELF','已上架'))+'</span>'],
      ['建议', r => '<span class="tag mid">调高展示库存</span><div class="muted">如果继续卖，按 SKC 去后台调高；准备停卖则忽略。</div>']
    ], {limit:false})+'</div>'+
    '<div class="store-section-title"><div><h3>本店待处理链接</h3><div class="sub">只放明确需要处理的链接：下架候选、低点击、低支付、待上架卡点或已有替代的30天0销量链接。</div></div><span class="tag mid">需要动作</span></div>'+
    groupedTable(problemLinks, [
      ['SKC', r => '<span class="mono">'+escapeHtml(r.skc || '-')+'</span>'+copyButton(r.skc, '复制')],
      ['标准货号', r => '<b>'+escapeHtml(r.standard_goods_sn || '-')+'</b>'],
      ['状态', r => '<span class="tag '+(r.retire_candidate ? 'high' : 'mid')+'">'+escapeHtml(r.health_bucket || r.shelf_status_name || '-')+'</span>'],
      ['标签', r => linkLabelChips(r)],
      ['下一步', r => '<span class="decision-strong">'+escapeHtml(linkDecision(r, allStoreLinks).role)+'</span><span class="decision-note">'+escapeHtml(linkIssueText(r, allStoreLinks))+'</span>']
    ], linkMetricGroups(false), {limit:false})+
    '<div class="store-section-title"><div><h3>本店优先货号</h3><div class="sub">销售按当前时间段；动作是最新动作池，动作分只是优先级，不是金额。</div></div><span class="tag info">经营入口</span></div>'+
    '<div class="spotlight">'+
      '<div>'+table(focusProducts, [
        ['货号', r => '<b>'+escapeHtml(r.standard_goods_sn || '-')+'</b><br><button class="status-btn" data-product-focus="'+escapeHtml(r.standard_goods_sn || '')+'">看货号360</button>'],
        ['覆盖', r => '<span class="tag '+(r.need_supplement_link ? 'mid' : 'good')+'">'+escapeHtml(r.coverage_status || '-')+'</span><br><span class="muted">上架 '+num(r.on_shelf_count)+' / 总链接 '+num(r.link_count)+'</span>'],
        ['最佳SKC', r => '<span class="mono">'+escapeHtml(r.best_skc || '-')+'</span>'+copyButton(r.best_skc, '复制')],
      ['当前时段销售', r => money(r.sales_sar)+'<br><span class="muted">销量 '+num(r.quantity)+' / 订单 '+num(r.order_count)+'</span>', 'num'],
      ['待办动作', r => num(r.action_count)+' 条<br><span class="muted">优先级分 '+num(r.max_action_score)+'（只排序）</span>', 'num']
      ], {limit:false})+'</div>'+
      '<div>'+table(actionPreview, [
        ['动作', r => '<b>'+escapeHtml(r.category || '-')+'</b><div class="muted">'+escapeHtml(domainName(r.action_domain))+' · '+escapeHtml(r.standard_goods_sn || '')+'</div>'],
        ['SKC', r => '<span class="mono">'+escapeHtml(r.skc || '-')+'</span>'+copyButton(r.skc, '复制')],
        ['原因', r => storeActionReasonHtml(r, allStoreLinks)],
        ['动作分', r => '<span class="mono">'+num(r.score)+'</span><br><span class="muted">优先级分，不是金额</span>', 'num']
      ], {limit:false})+'</div>'+
    '</div>'+
    '<details class="detail-section" style="margin-top:16px"><summary>复核明细：售后、履约、财务、全量链接</summary><div class="detail-body">'+
      '<div class="detail-grid">'+
        '<div><div class="section-block-label">售后明细 · 当前时段（按售后申请时间）</div>'+table(afterRange.slice(0, 10), [
          ['售后单', r => '<span class="mono">'+escapeHtml(r.aftersales_order_no || r.return_order_no || '-')+'</span>'],
          ['货号/SKC', r => '<b>'+escapeHtml(r.standard_goods_sn || '-').slice(0,46)+'</b><br><span class="mono">'+escapeHtml(r.skc || '-')+'</span>'],
          ['原因', r => escapeHtml(r.reason_names || '-').slice(0,80)]
        ])+'</div>'+
        '<div><div class="section-block-label">履约面单 · 最新业务日快照</div>'+table(waybillAll.slice(0, 10), [
          ['包裹', r => '<span class="mono">'+escapeHtml(r.place_order_package_id || '-')+'</span>'],
          ['状态', r => escapeHtml(r.show_status_desc || '-')],
          ['SKU', r => '<span class="mono">'+escapeHtml(r.skc_list || '').slice(0,90)+'</span>']
        ])+'</div>'+
        '<div><div class="section-block-label">财务在途收入 · 最新财务快照（对账用）</div>'+table(financeOrdersAll.slice(0, 10), [
          ['财务订单', r => '<span class="mono">'+escapeHtml(r.order_no || '-')+'</span>'],
          ['发货日', r => r.order_delivery_time || '-'],
          ['类型', r => escapeHtml(r.big_category_name || '-')+'<br><span class="muted">'+escapeHtml(r.second_order_type_name || '')+'</span>'],
          ['预估收入', r => money(r.estimate_income_money_total), 'num']
        ])+'</div>'+
        '<div><div class="section-block-label">财务商品 · 最新业务日</div>'+table(financeGoodsAll.slice(0, 10), [
          ['订单', r => '<span class="mono">'+escapeHtml(r.order_no || '-')+'</span>'],
          ['货号/SKC', r => (r.standard_goods_sn ? '<b>'+escapeHtml(r.standard_goods_sn).slice(0,50)+'</b>' : '<span class="muted">未匹配</span>')+'<br><span class="mono">'+escapeHtml(r.skc || r.entity_id || '-')+'</span>'],
          ['数量/金额', r => num(r.quantity)+'<br><span class="muted">'+money(r.amount)+'</span>', 'num']
        ])+'</div>'+
      '</div>'+
      '<div class="section-block-label">本店链接池 · 最新链接日</div>'+
      groupedTable(allStoreLinks.slice(0, 40), [
        ['SKC', r => '<span class="mono">'+escapeHtml(r.skc || '-')+'</span>'+copyButton(r.skc, '复制')],
        ['货号', r => '<b>'+escapeHtml(r.standard_goods_sn || '-')+'</b>'],
        ['状态/标签', r => '<span class="tag">'+escapeHtml(r.shelf_status_name || '-')+'</span><br>'+linkLabelChips(r)]
      ], linkMetricGroups(true))+
    '</div></details>';
}

function renderProductSpotlight(){
  const products = DATA.products || [];
  const q = state.q.trim().toLowerCase();
  let product = null;
  if (q) product = products.find(p => String(p.standard_goods_sn || '').toLowerCase().includes(q));
  if (!product) product = [...products].filter(includes).sort((a,b)=>Number(b.risk_score||0)-Number(a.risk_score||0))[0] || products[0];
  if (!product) {
    $('productSpotlightTag').textContent = '无数据';
    $('productSpotlight').innerHTML = '<div class="empty">暂无货号数据</div>';
    return;
  }
  const sn = product.standard_goods_sn;
  $('productSpotlightTag').textContent = q ? '搜索聚焦' : '默认最高风险';
  const matrix = STORE_CODES_ARRAY.map(store => {
    const hit = (DATA.matrix || []).find(x => x.standard_goods_sn === sn && x.store_key === store);
    return hit || {store_key:store, group_key:STORE_GROUP_FALLBACK[store] || '', standard_goods_sn:sn, coverage_status:'暂无上架/销售信号', has_on_shelf_link:false, need_supplement_link:false, link_count:0, on_shelf_count:0, wait_shelf_count:0, sold_out_count:0, duplicate_on_shelf:false, best_skc:'', best_link_c30_sale:0, sales_sar:0, quantity:0, action_count:0, focus_action_count:0, max_action_score:0, _empty:true};
  });
  const actions = (DATA.actions || []).filter(x => x.standard_goods_sn === sn).slice(0, 8);
  const allLinks = (DATA.storeLinks || DATA.links || []).filter(x => x.standard_goods_sn === sn);
  const linksByStore = new Map();
  allLinks.forEach(link => {
    const key = link.store_key || '';
    if (!key) return;
    if (!linksByStore.has(key)) linksByStore.set(key, []);
    linksByStore.get(key).push(link);
  });
  const storeLinkMetric = (store, key) => (linksByStore.get(store) || []).reduce((sum, x) => sum + Number(x?.[key] || 0), 0);
  const links = allLinks.slice(0, 24);
  const ordersAll = (DATA.orders || []).filter(x => x.standard_goods_sn === sn);
  const afterAllRaw = (DATA.afterSales || []).filter(x => x.standard_goods_sn === sn);
  const afterAll = afterAllRaw.filter(x => inSelectedRange(x, 'request_time'));
  const financeGoodsAll = (DATA.financeGoods || []).filter(x => x.standard_goods_sn === sn);
  const commentAll = (DATA.comments || [])
    .filter(x => x.standard_goods_sn === sn)
    .sort((a,b)=>Number(a.goods_comment_star || 9)-Number(b.goods_comment_star || 9) || String(b.comment_date || '').localeCompare(String(a.comment_date || '')));
  const lowComments = commentAll.filter(r => Number(r.goods_comment_star || 0) > 0 && Number(r.goods_comment_star || 0) <= 3);
  const growth = buildGrowthOpportunities(30).find(x => x.standard_goods_sn === sn);
  const orders = ordersAll.slice(0, 8);
  const after = afterAll.slice(0, 8);
  const financeGoods = financeGoodsAll.slice(0, 8);
  const orderAmount = ordersAll.reduce((sum,x)=>sum+Number(x.sales_sar||0),0);
  const afterAmount = afterAll.reduce((sum,x)=>sum+Number(x.price_amount_total||0),0);
  const financeGoodsAmount = financeGoodsAll.reduce((sum,x)=>sum+Number(x.amount||0),0);
  const missingStores = Number(product.missing_store_count || 0);
  const rangeProduct = aggregateDailyProducts().find(x => x.standard_goods_sn === sn);
  const rangeSalesSar = Number(rangeProduct?.sales_sar ?? product.sales_sar ?? 0);
  const rangeQuantity = Number(rangeProduct?.quantity ?? product.quantity ?? 0);
  const rangeOrders = Number(rangeProduct?.orders ?? ordersAll.length ?? 0);
  const rangeLabel = selectedRangeText();
  const decisionCards = [
    ['链接覆盖', num(product.on_shelf_store_count) + '/' + num(TOTAL_STORE_COUNT) + ' 店上架', missingStores > 0 ? '仍有 ' + num(missingStores) + ' 个店缺上架链接；先看是否属于“部分店已卖，部分店缺覆盖”。' : '各店覆盖基本完整，重点转向链接承接和优胜劣汰。'],
    ['订单表现', money(rangeSalesSar) + ' / ' + num(rangeOrders) + ' 单', '当前时间段：' + rangeLabel + '。对照销售明细，看销售是否集中在少数店或少数 SKC。'],
    ['财务在途', money(financeGoodsAmount) + ' / ' + num(financeGoodsAll.length) + ' 条', financeGoodsAll.length ? '财务在途已能回到货号层，可和订单、售后互相印证。' : '暂未匹配到财务商品，可能是其它店还未接入财务明细或 entity_id 未补齐。'],
    ['售后质量', num(afterAll.length) + ' 单 / ' + money(afterAmount), afterAll.length ? '当前时段售后集中时不要只补链接，先判断退货原因、评价和质量等级。' : '当前时段售后样本未命中该货号，可优先看覆盖和承接。'],
    ['评价口碑', num(commentAll.length) + ' 条 / 低星 ' + num(lowComments.length), commentAll.length ? '货号页先看摘要；完整历史评价已单开“评价 / 口碑”页，可按货号和店铺筛选。' : '当前评论库未命中该货号，后续补历史评价后自动出现。']
  ];
  if (growth) decisionCards.push([
    '增长打法',
    growth.opportunityType + ' / ' + num(growth.growthScore) + ' 分',
    '可扩 ' + num(growth.missingStores) + ' 店；' + growthReferenceLabel(growth.strongLink) + ' ' + (growth.strongLink?.skc || '-') + '；从这里复制主图、标题、价格带和活动承接。'
  ]);
  const growthBlock = growth ? (
    '<div class="card soft" style="margin:12px 0">'+
      '<div class="card-h"><div><h3>增长打法包</h3><div class="sub">不是风险处理，而是把已验证的链接/货号打法复制到缺覆盖店或弱链接。</div></div><span class="tag good">'+escapeHtml(growth.opportunityType)+'</span></div>'+
      '<div class="card-body">'+
        '<div class="brief-grid">'+
          '<div class="brief"><span>机会分</span><strong>'+num(growth.growthScore)+'</strong></div>'+
          '<div class="brief"><span>可扩店</span><strong>'+num(growth.missingStores)+'</strong></div>'+
          '<div class="brief"><span>30天销量</span><strong>'+num(growth.c30Sales)+'</strong></div>'+
          '<div class="brief"><span>'+growthReferenceLabel(growth.strongLink)+'</span><strong class="mono">'+escapeHtml(growth.strongLink?.skc || '-').slice(0,20)+'</strong></div>'+
        '</div>'+
        (growthReferenceRisk(growth.strongLink) ? '<p class="next warn">参考 SKC 存在'+escapeHtml(growthReferenceRisk(growth.strongLink))+'，先修承接再复制。</p>' : '')+
        '<p class="next">'+escapeHtml(growth.nextStep || '')+'</p>'+
        '<div class="command-actions">'+
          copyButton(growthPlaybookText(growth), '复制增长指令')+
          (growth.strongLink?.skc ? '<button class="status-btn" data-growth-skc="'+escapeHtml(growth.strongLink.skc)+'">看'+growthReferenceLabel(growth.strongLink)+'</button>' : '')+
        '</div>'+
      '</div>'+
    '</div>'
  ) : '';
  const matrixSorted = [...matrix].sort((a,b)=>storeOrderIndex(a.store_key)-storeOrderIndex(b.store_key) || String(a.store_key || '').localeCompare(String(b.store_key || '')));
  const actionRows = actions.map(a => {
    const link = allLinks.find(x => String(x.skc || '') === String(a.skc || ''));
    return {...a, _decision: link ? linkDecision(link, allLinks) : null, _comparison: productActionComparisonHtml(a, allLinks)};
  });
  const detailBody =
    '<div class="table-note">这里不是新的动作清单，而是复核区：确认这条 SKC 是否真的有订单、财务是否能对上、售后是否集中。看不出问题时可以先跳过。</div>'+
    '<div class="detail-grid">'+
      '<div><div class="section-block-label">订单明细 · 当前筛选命中</div>'+table(orders, [
        ['店铺', r => '<b>'+r.store_key+'</b>'],
        ['订单时间', r => '<span class="mono">'+(r.order_create_time || '').replace('T',' ').slice(0,19)+'</span>'],
        ['SKC', r => '<span class="mono">'+(r.skc || '-')+'</span>'+copyButton(r.skc, '复制SKC')],
        ['数量/金额', r => num(r.quantity)+'<br><span class="muted">'+money(r.sales_sar)+'</span>', 'num']
      ])+'</div>'+
      '<div><div class="section-block-label">售后明细 · 质量复核</div>'+table(after, [
        ['店铺', r => '<b>'+r.store_key+'</b>'],
        ['申请时间', r => '<span class="mono">'+(r.request_time || '').replace('T',' ').slice(0,19)+'</span>'],
        ['原因', r => escapeHtml(r.reason_names || '-').slice(0,80)],
        ['金额', r => money(r.price_amount_total), 'num']
      ])+'</div>'+
    '</div>'+
    '<div class="detail-grid" style="margin-top:14px">'+
      '<div><div class="section-block-label">财务商品 · 对账复核</div>'+table(financeGoods, [
        ['店铺', r => '<b>'+r.store_key+'</b>'],
        ['财务订单', r => '<span class="mono">'+(r.order_no || '-')+'</span>'],
        ['SKC', r => '<span class="mono">'+(r.skc || '-')+'</span>'+copyButton(r.skc, '复制SKC')],
        ['数量/金额', r => num(r.quantity)+'<br><span class="muted">'+money(r.amount)+'</span>', 'num']
      ])+'</div>'+
      '<div><div class="section-block-label">链接池 · 7/30 表现</div>'+groupedTable(links, [
        ['店铺', r => '<b>'+r.store_key+'</b>'],
        ['SKC', r => '<span class="mono">'+(r.skc || '-')+'</span>'+copyButton(r.skc, '复制SKC')],
        ['状态/标签', r => '<span class="tag '+(isOnShelfLink(r) ? 'good' : isWaitShelfLink(r) ? 'mid' : 'info')+'">'+escapeHtml(r.shelf_status_name || '-')+'</span><br>'+linkLabelChips(r)]
      ], linkMetricGroups(true))+'</div>'+
    '</div>'+
    '<div style="margin-top:14px">'+
      '<div class="section-block-label">评价口碑 · 低星优先</div>'+
      productCommentPreviewHtml(commentAll, sn)+
      '<div class="command-actions" style="margin-top:10px"><button class="status-btn" data-product-comments="'+escapeHtml(sn)+'">去评价页看完整历史评价</button></div>'+
    '</div>';
  $('productSpotlight').innerHTML =
    '<div class="store-flow">'+
      '<div class="store-verdict"><div class="row1"><div><h3>'+escapeHtml(sn)+'</h3><p>货号页先判断：这个标准货号是要扩店、修链接、控售后，还是淘汰弱链接。</p></div>'+riskTag(product.risk_score)+'</div>'+
        '<div class="store-action-steps">'+
          '<div class="store-step"><b>1 看当前销售</b><p>'+escapeHtml(rangeLabel)+'：'+money(rangeSalesSar)+'，销量 '+num(rangeQuantity)+'，订单 '+num(rangeOrders)+'。</p></div>'+
          '<div class="store-step"><b>2 看覆盖缺口</b><p>上架 '+num(product.on_shelf_store_count)+'/'+num(TOTAL_STORE_COUNT)+' 店，缺 '+num(missingStores)+' 店；不是全店未上架才需要补链。</p></div>'+
        '<div class="store-step"><b>3 看质量与财务</b><p>当前时段售后 '+num(afterAll.length)+' 单，低星评价 '+num(lowComments.length)+' 条，财务商品 '+num(financeGoodsAll.length)+' 条，用来和订单互相印证。</p></div>'+
        '</div>'+
      '</div>'+
      '<div class="store-kpi-grid">'+
        '<div class="store-kpi"><span>销售额</span><strong>'+money(rangeSalesSar)+'</strong><small>'+escapeHtml(rangeLabel)+'</small></div>'+
        '<div class="store-kpi"><span>销量 / 订单</span><strong>'+num(rangeQuantity)+' / '+num(rangeOrders)+'</strong><small>按订单创建时间</small></div>'+
        '<div class="store-kpi"><span>上架店</span><strong>'+num(product.on_shelf_store_count)+'/'+num(TOTAL_STORE_COUNT)+'</strong><small>缺 '+num(missingStores)+' 店</small></div>'+
        '<div class="store-kpi"><span>动作</span><strong>'+num(actions.length)+'</strong><small>最新动作池</small></div>'+
        '<div class="store-kpi"><span>售后金额</span><strong>'+money(afterAmount)+'</strong><small>'+num(afterAll.length)+' 单</small></div>'+
        '<div class="store-kpi"><span>评价口碑</span><strong>'+num(commentAll.length)+' / '+num(lowComments.length)+'</strong><small>评价 / 低星</small></div>'+
      '</div>'+
    '</div>'+
    '<div class="path-grid" style="margin:14px 0">'+decisionCards.map(c =>
      '<article class="path-card"><span class="domain">'+escapeHtml(c[0])+'</span><h4>'+escapeHtml(c[1])+'</h4><p>'+escapeHtml(c[2])+'</p></article>'
    ).join('')+'</div>'+
    growthBlock+
    sectionTitleHtml('店铺覆盖与承接', '固定显示 '+num(TOTAL_STORE_COUNT)+' 个店。先扫卡片状态，再看明细表；销售是本店该标准货号全部 SKC / 链接合计。', num(TOTAL_STORE_COUNT)+' 店全量')+
    '<div class="coverage-board">'+matrixSorted.map(r => {
      const cls = r.need_supplement_link ? 'mid' : Number(r.sales_sar || 0) > 0 ? 'good' : r._empty ? 'info' : 'good';
      const status = r.need_supplement_link ? '缺承接' : Number(r.sales_sar || 0) > 0 ? '有销售' : r.has_on_shelf_link ? '已上架' : '空白';
      const dateNote = r.link_date ? ' · 数据 ' + String(r.link_date).slice(5) : '';
      const storeExposure = storeLinkMetric(r.store_key, 'eps_uv');
      const storeExposure30 = storeLinkMetric(r.store_key, 'c30_eps_uv');
      const storeVisitors30 = storeLinkMetric(r.store_key, 'c30_goods_uv');
      return '<article class="coverage-tile"><strong>'+escapeHtml(r.store_key || '-')+' <span class="tag '+cls+'">'+escapeHtml(status)+'</span></strong>'+
        '<small>净成交 '+escapeHtml(money(r.sales_sar))+' · 销量 '+num(r.quantity)+'</small>'+
        '<small>链接 上架 '+num(r.on_shelf_count)+' / 总 '+num(r.link_count)+' · 待上架 '+num(r.wait_shelf_count)+escapeHtml(dateNote)+'</small>'+
        '<small>曝光 当日 '+num(storeExposure)+' · 30天 '+num(storeExposure30)+' / 访客 '+num(storeVisitors30)+'</small>'+
        '<small>最佳 <span class="mono">'+escapeHtml(r.best_skc || '-')+'</span></small></article>';
    }).join('')+'</div>'+
    table(matrixSorted, [
      ['店铺', r => '<b>'+r.store_key+'</b>'],
      ['覆盖', r => '<span class="tag '+(r.need_supplement_link ? 'mid' : 'good')+'">'+escapeHtml(r.coverage_status || '-')+'</span>'],
      ['链接结构', r => '上架 '+num(r.on_shelf_count)+' / 总 '+num(r.link_count)+'<br><span class="muted">待上架 '+num(r.wait_shelf_count)+' · 售罄 '+num(r.sold_out_count)+'</span>'],
      ['最佳 SKC', r => '<span class="mono">'+(r.best_skc || '-')+'</span>'+copyButton(r.best_skc, '复制SKC')],
      ['曝光/访客', r => '当日曝光 '+num(storeLinkMetric(r.store_key, 'eps_uv'))+'<br><span class="muted">30天曝光 '+num(storeLinkMetric(r.store_key, 'c30_eps_uv'))+' · 访客 '+num(storeLinkMetric(r.store_key, 'c30_goods_uv'))+'</span>', 'num'],
      ['本店货号合计销售', r => money(r.sales_sar)+'<br><span class="muted">全部 SKC 合计销量 '+num(r.quantity)+'</span>', 'num'],
      ['待办动作', r => num(r.action_count)+' 条<br><span class="muted">优先级分 '+num(r.max_action_score)+'</span>', 'num']
    ])+
    sectionTitleHtml('本货号待处理动作', '只展示命中这个标准货号的精选动作；重复弱链接会直接调取全量链接仓库，给出同店同款完整对比线索。', num(actionRows.length)+' 条', actionRows.length ? 'mid' : 'good')+
    table(actionRows, [
      ['店铺', r => '<b>'+r.store_key+'</b>'],
      ['动作', r => '<span class="tag mid">'+escapeHtml(r.category || '-')+'</span>'],
      ['SKC', r => '<span class="mono">'+(r.skc || '-')+'</span>'+copyButton(r.skc, '复制SKC')],
      ['同店同款对比', r => r._comparison],
      ['判断/下一步', r => (r._decision ? '<span class="decision-strong">'+escapeHtml(r._decision.role)+'</span><span class="decision-note">'+escapeHtml(r._decision.text)+'</span>' : '')+'<span class="decision-note">'+escapeHtml(r.next_step || '').slice(0,120)+'</span>']
    ])+
    detailBlockHtml('货号复核明细：订单、售后、财务、链接池', detailBody);
}
function linkOpsIntentLabel(intent){
  const map = {
    copy_product_draft:'复制上品/补覆盖',
    update_title:'改标题',
    update_images:'换图',
    retire_link:'下架/归档',
    campaign_signup:'营销活动',
    flash_discount:'限时折扣',
    certificate_review:'证书资质',
    manual_review:'人工复核'
  };
  return map[intent] || intent || '任务';
}
function linkOpsTaskActionTitle(intents = []){
  if (intents.includes('copy_product_draft')) return '补齐店铺覆盖：复制同款参数并创建草稿/待上架链接';
  if (intents.includes('retire_link')) return '处理差链接：确认替代承接后下架或归档弱链接';
  if (intents.includes('update_images') && intents.includes('update_title')) return '优化链接素材：换图并同步优化标题';
  if (intents.includes('update_images')) return '优化链接图片：替换目标链接商品图';
  if (intents.includes('update_title')) return '优化链接标题：生成并写入确认后的标题';
  if (intents.includes('campaign_signup')) return '报名官方营销活动：按利润规则生成报名方案';
  if (intents.includes('flash_discount')) return '设置限时折扣：按成本、限量和有效期执行';
  if (intents.includes('certificate_review')) return '补齐证书/资质：定位缺口并准备提交材料';
  return '人工复核：把会话结论整理成可执行检查清单';
}
function linkOpsTaskRequiredMaterials(intents = []){
  const items = [];
  if (intents.includes('copy_product_draft')) items.push('源 SKC / 类目参数 / 证书 / 图片 / 价格 / 库存100 / 10年后上架时间');
  if (intents.includes('update_title')) items.push('最终标题文本或取标题规则');
  if (intents.includes('update_images')) items.push('本机图片素材包，需先上传/同步到云端');
  if (intents.includes('campaign_signup')) items.push('活动 ID、报名商品、成本与最低利润率');
  if (intents.includes('flash_discount')) items.push('折扣价、限量、有效期、利润底线');
  if (intents.includes('certificate_review')) items.push('证书/资质文件或可复用的同货号证书');
  if (!items.length) items.push('人工确认后的执行口径和目标链接');
  return [...new Set(items)];
}
function linkOpsTaskExecutorNote(intents = []){
  if (intents.includes('update_images')) {
    return '云服务器不能直接读取你本机图片。短期做法是：先把图片素材包上传/同步到云端任务，再由执行器调用 SHEIN API/WebAPI 写入。';
  }
  if (intents.includes('update_title')) {
    return '标题是文本，确认后可以直接存到任务并由云端执行器写入；如果标题规则在本机 skill，需先同步 skill/规则到云端。';
  }
  if (intents.includes('copy_product_draft')) {
    return '上品任务先生成草稿/待上架，不直接正式上架；图片、证书和源 SKC 参数必须在云端任务里齐全后才执行。';
  }
  if (intents.includes('campaign_signup') || intents.includes('flash_discount')) {
    return '活动/折扣属于写操作，确认后进入执行队列；最终是否自动提交要按活动安全规则控制。';
  }
  return '确认后进入执行队列；若缺素材或接口权限，任务会停在“执行中/待材料”，不会静默乱改后台。';
}
function renderLinkOpsTaskExecution(t){
  const intents = Array.isArray(t?.intents) ? t.intents : [];
  const stores = Array.isArray(t?.targets?.stores) ? t.targets.stores : [];
  const refs = Array.isArray(t?.targets?.productRefs) ? t.targets.productRefs : [];
  const materials = linkOpsTaskRequiredMaterials(intents);
  const hasAgentAnswer = !!String(t?.preview?.agentAnswer || '').trim();
  const targetText = [
    stores.length ? '店铺：'+stores.join('、') : '店铺：待从会话/数据里确认',
    refs.length ? '货号/SKC：'+refs.join('、') : '货号/SKC：待确认'
  ].join('；');
  return '<div class="task-exec">'+
    '<h5>这条任务具体要做什么</h5>'+
    '<div class="task-exec-grid">'+
      '<div class="task-exec-item"><b>任务目标</b><span>'+escapeHtml(linkOpsTaskActionTitle(intents))+'</span></div>'+
      '<div class="task-exec-item"><b>执行对象</b><span>'+escapeHtml(targetText)+'</span></div>'+
      '<div class="task-exec-item"><b>需要材料</b><div class="material-pills">'+materials.map(x => '<span class="material-pill need">'+escapeHtml(x)+'</span>').join('')+'</div></div>'+
      '<div class="task-exec-item"><b>执行方式</b><span>'+escapeHtml(linkOpsTaskExecutorNote(intents))+'</span></div>'+
    '</div>'+
    '<div class="task-exec-note">'+
      (hasAgentAnswer
        ? '已带有智能体建议，可人工确认后开始执行。'
        : '执行内容还不完整：建议先在会话里让智能体把步骤、目标链接、素材和风险讲清楚，再放入任务池。')+
    '</div>'+
  '</div>';
}
function renderLinkOpsAssetPanel(t){
  const id = String(t?.id || '');
  const assets = Array.isArray(t?.assets) ? t.assets : [];
  const rows = assets.slice(0, 12).map(a =>
    '<div class="asset-row">'+
      '<span class="name">'+escapeHtml(a.originalName || a.storedName || a.id || '素材')+'</span>'+
      '<span class="meta">'+escapeHtml(a.kind || 'file')+' · '+escapeHtml(linkOpsHumanBytes(a.bytes))+'</span>'+
      '<span class="meta">'+escapeHtml(String(a.uploadedAt || '').replace('T',' ').slice(0,16))+'</span>'+
    '</div>'
  ).join('');
  return '<div class="asset-panel">'+
    '<div class="row1"><div><b>任务素材包</b><p>图片/证书/标题文件会上传到云端任务目录；服务器不能直接读取你本机文件。</p></div><span class="tag '+(assets.length ? 'good' : 'info')+'">'+num(assets.length)+' 个素材</span></div>'+
    (rows ? '<div class="asset-list">'+rows+'</div>' : '<div class="empty">还没有素材。需要换图、补证书、复制上品时，先在这里上传。</div>')+
    '<div class="command-actions" style="margin-top:9px">'+
      '<input type="file" multiple data-linkops-asset-input="'+escapeHtml(id)+'" accept=".jpg,.jpeg,.png,.webp,.pdf,.txt,.csv,.json,image/jpeg,image/png,image/webp,application/pdf,text/plain,text/csv,application/json">'+
      '<button class="btn" type="button" data-linkops-task-action="upload_assets" data-task-id="'+escapeHtml(id)+'">上传到云端任务包</button>'+
    '</div>'+
  '</div>';
}
function renderLinkOpsExecutionState(t){
  const execution = t?.execution && typeof t.execution === 'object' ? t.execution : null;
  if (!execution || !execution.runId) return '';
  const preflight = execution.preflight && typeof execution.preflight === 'object' ? execution.preflight : {};
  const blockers = Array.isArray(preflight.blockers) ? preflight.blockers : [];
  const warnings = Array.isArray(preflight.warnings) ? preflight.warnings : [];
  return '<div class="execution-state">'+
    '<b>执行器状态：'+escapeHtml(execution.state || 'unknown')+'</b><br>'+
    '<span class="mono">runId='+escapeHtml(execution.runId || '-')+'</span><br>'+
    '<span>安全边界：第一版不静默提交 SHEIN；缺材料/权限时不会显示成功。</span>'+
    (blockers.length ? '<ul class="linkops-preview-list">'+blockers.map(x => '<li>'+escapeHtml(x)+'</li>').join('')+'</ul>' : '')+
    (warnings.length ? '<ul class="linkops-preview-list">'+warnings.map(x => '<li>'+escapeHtml(x)+'</li>').join('')+'</ul>' : '')+
  '</div>';
}
function linkOpsMatchProductRef(row, refs = []){
  if (!refs.length) return false;
  const hay = [
    row?.standard_goods_sn,
    row?.skc,
    row?.product_name_cn,
    row?.goods_sn,
    row?.product_code
  ].filter(Boolean).join(' ').toLowerCase();
  return refs.some(ref => {
    const q = String(ref || '').trim().toLowerCase();
    if (!q) return false;
    const compact = q.replace(/[\s-]/g, '');
    const hayCompact = hay.replace(/[\s-]/g, '');
    return hay.includes(q) || hayCompact.includes(compact);
  });
}
function linkOpsStoreAdvice(matrix, storeLinks){
  const links = storeLinks || [];
  const onShelf = links.filter(isOnShelfLink);
  const wait = links.filter(isWaitShelfLink);
  const problemLinks = links.filter(x =>
    x.retire_candidate ||
    x.high_exposure_low_click ||
    x.high_visit_low_pay ||
    x.wait_shelf_block_candidate ||
    (Number(x.c30_sale_cnt || 0) === 0 && Number(x.c7_sale_cnt || 0) === 0 && onShelf.length > 1)
  );
  const best = [...onShelf].sort((a,b) =>
    Number(b.c30_sale_cnt || 0) - Number(a.c30_sale_cnt || 0) ||
    Number(b.c7_sale_cnt || 0) - Number(a.c7_sale_cnt || 0) ||
    Number(b.c30_goods_uv || b.goods_uv || 0) - Number(a.c30_goods_uv || a.goods_uv || 0)
  )[0] || null;
  const actions = [];
  if (matrix?.need_supplement_link || (!onShelf.length && wait.length)) {
    actions.push('补新链接：当前没有已上架承接，优先用其他店同款 SKC 复制参数/证书/图片，先建草稿。');
  }
  if (problemLinks.some(x => x.retire_candidate) || (onShelf.length > 1 && problemLinks.length)) {
    actions.push('下架/归档：有重复弱链接，先确认不是唯一承接，再下架弱链或等替代链接上架后归档。');
  }
  if (problemLinks.some(x => x.high_exposure_low_click)) {
    actions.push('换图/标题：存在高曝光低点击，优先改主图、标题关键词和价格露出。');
  }
  if (problemLinks.some(x => x.high_visit_low_pay)) {
    actions.push('修支付：存在高访客低支付，优先检查价格、评价、活动承接和详情页。');
  }
  if (!actions.length && best) actions.push('保留观察：已有上架链接，先保留当前最佳，继续跟踪 7/30 天表现。');
  if (!actions.length) actions.push('暂不处理：当前数据不足，先等待链接日更或人工补充目标。');
  return {onShelf, wait, problemLinks, best, actions};
}
function renderLinkOpsDataAdvice(task){
  const refs = Array.isArray(task?.targets?.productRefs) ? task.targets.productRefs : [];
  if (!refs.length) return '';
  const matrixRows = (DATA.matrix || []).filter(r => linkOpsMatchProductRef(r, refs));
  const linkRows = (DATA.storeLinks || DATA.links || []).filter(r => linkOpsMatchProductRef(r, refs));
  if (!matrixRows.length && !linkRows.length) {
    return '<div class="next warn">没有在当前 BI 快照里匹配到这些货号/SKC：'+escapeHtml(refs.join(', '))+'。请确认货号写法，或等待链接/业务域日更。</div>';
  }
  const stores = [...new Set([...(DATA.stores || []).map(s => s.store_key || s.key || s.code).filter(Boolean), ...matrixRows.map(r => r.store_key), ...linkRows.map(r => r.store_key)])]
    .sort((a,b)=>storeOrderIndex(a)-storeOrderIndex(b) || String(a).localeCompare(String(b)));
  const rows = stores.map(store => {
    const m = matrixRows.find(x => x.store_key === store) || null;
    const links = linkRows.filter(x => x.store_key === store);
    return {store, matrix:m, links, advice:linkOpsStoreAdvice(m, links)};
  }).filter(x => x.matrix || x.links.length);
  const summary = {
    stores: rows.length,
    needSupplement: rows.filter(x => x.matrix?.need_supplement_link || (!x.advice.onShelf.length && x.advice.wait.length)).length,
    problem: rows.filter(x => x.advice.problemLinks.length).length,
    onShelf: rows.reduce((s,x)=>s+x.advice.onShelf.length,0),
    wait: rows.reduce((s,x)=>s+x.advice.wait.length,0),
  };
  return '<div style="margin-top:12px">'+
    '<div class="section-block-label">基于当前 BI 数据的建议</div>'+
    '<div class="brief-grid five" style="margin-bottom:10px">'+
      '<div class="brief-kpi"><span>命中店铺</span><strong>'+num(summary.stores)+'</strong><small>当前快照</small></div>'+
      '<div class="brief-kpi"><span>需补覆盖</span><strong>'+num(summary.needSupplement)+'</strong><small>缺上架/只有待上架</small></div>'+
      '<div class="brief-kpi"><span>问题店铺</span><strong>'+num(summary.problem)+'</strong><small>存在弱链/承接问题</small></div>'+
      '<div class="brief-kpi"><span>上架链接</span><strong>'+num(summary.onShelf)+'</strong><small>同货号</small></div>'+
      '<div class="brief-kpi"><span>待上架</span><strong>'+num(summary.wait)+'</strong><small>可优先补资料</small></div>'+
    '</div>'+
    table(rows, [
      ['店铺', r => '<b>'+escapeHtml(r.store)+'</b>'],
      ['覆盖', r => '<span class="tag '+(r.matrix?.need_supplement_link ? 'mid' : r.advice.onShelf.length ? 'good' : 'info')+'">'+escapeHtml(r.matrix?.coverage_status || (r.advice.onShelf.length ? '有上架链接' : r.advice.wait.length ? '只有待上架' : '暂无链接'))+'</span><br><span class="muted">上架 '+num(r.advice.onShelf.length)+' / 待上架 '+num(r.advice.wait.length)+' / 问题 '+num(r.advice.problemLinks.length)+'</span>'],
      ['最佳/参考', r => r.advice.best ? '<span class="mono">'+escapeHtml(r.advice.best.skc || '-')+'</span><br><span class="muted">30天销量 '+num(r.advice.best.c30_sale_cnt)+' · 访客 '+num(r.advice.best.c30_goods_uv || r.advice.best.goods_uv)+'</span>' : '<span class="muted">暂无上架参考</span>'],
      ['建议', r => '<ul class="linkops-preview-list">'+r.advice.actions.map(x => '<li>'+escapeHtml(x)+'</li>').join('')+'</ul>']
    ], {limit:false})+
  '</div>';
}
function renderLinkOps(){
  const center = $('linkOpsCommandCenter');
  const list = $('linkOpsTaskList');
  if (!center || !list) return;
  const prompts = recommendedLinkOpsPrompts();
  const sessions = linkOpsChatStore.sessions || [];
  const active = activeLinkOpsSession();
  const messages = Array.isArray(active?.messages) ? active.messages : [];
  center.innerHTML =
    '<div class="ops-workspace">'+
      '<aside class="ops-rail">'+
        '<div class="card-h" style="padding:0 0 10px"><div><h3>运营会话</h3><div class="sub">先聊清楚，再进入任务池</div></div><button class="btn" id="newOpsChat" type="button">新会话</button></div>'+
        (linkOpsChatStore.error ? '<div class="next warn">会话不可用：'+escapeHtml(linkOpsChatStore.error)+'</div>' : '')+
        (sessions.length ? sessions.map(s => {
          const count = Array.isArray(s.messages) ? s.messages.length : 0;
          const activeCls = String(s.id || '') === String(linkOpsChatStore.activeId || '') ? ' active' : '';
          return '<div class="ops-session'+activeCls+'" data-linkops-session-id="'+escapeHtml(s.id || '')+'"><div class="ops-session-head"><div><b>'+escapeHtml(s.title || '未命名会话')+'</b><small>'+escapeHtml(s.status === 'sending' ? '发送中' : linkOpsStatusLabel(s.status || 'chatting'))+' · '+num(count)+' 条消息 · '+escapeHtml(String(s.updatedAt || s.createdAt || '').replace('T',' ').slice(0,16))+'</small></div><button class="ops-session-delete" type="button" data-linkops-session-delete="'+escapeHtml(s.id || '')+'">删除</button></div></div>';
        }).join('') : '<div class="empty">还没有会话。点右侧推荐指令，或直接输入你的运营问题。</div>')+
        '<div style="margin-top:14px"><div class="section-block-label">基于当前数据的推荐指令</div>'+
          prompts.map(p => '<div class="ops-reco" data-linkops-reco="'+escapeHtml(p.text)+'"><b>'+escapeHtml(p.title)+'</b><p>'+escapeHtml(p.reason)+'</p></div>').join('')+
        '</div>'+
      '</aside>'+
      '<main class="ops-chat">'+
        '<div class="card-h" style="padding:0 0 12px"><div><h3>'+(active ? escapeHtml(active.title || '运营会话') : '新运营会话')+'</h3><div class="sub">只读分析，不会改 SHEIN；聊成熟后点“进入任务池”。</div></div>'+
        (active ? '<button class="btn primary" id="convertChatToTask" type="button">进入任务池</button>' : '')+'</div>'+
        '<div class="chat-stream">'+
          (messages.length ? messages.map(m => '<div class="chat-msg '+(m.role === 'assistant' ? 'assistant' : 'user')+'">'+(m.role === 'assistant' ? renderAgentAnswerCards(m.content) : '<p>'+escapeHtml(m.content || '')+'</p>')+'<small class="muted">'+escapeHtml(String(m.at || '').replace('T',' ').slice(0,16))+'</small></div>').join('') : '<div class="empty">这是一个独立会话。你可以问“这个品哪些店该补链接”“这条链接该换图还是下架”“怎么报限时折扣”。</div>')+
          (opsAgentStore.busy ? '<div class="chat-msg assistant"><div class="empty">智能体正在分析当前 BI 数据...</div></div>' : '')+
          (opsAgentStore.error ? '<div class="next warn">智能体错误：'+escapeHtml(opsAgentStore.error)+'</div>' : '')+
        '</div>'+
        '<div class="chat-compose">'+
          '<label class="section-block-label" for="linkOpsChatInput">继续对话</label>'+
          '<textarea id="linkOpsChatInput" placeholder="例如：把建议拆成可执行步骤；先只看QY/TZ/YJ；不要下架，优先换图；再给我一个更保守的方案。"></textarea>'+
          '<div class="command-actions"><button class="btn primary" id="sendLinkOpsChat" type="button">发送给智能体</button><button class="btn" id="clearLinkOpsChat" type="button">清空输入</button></div>'+
        '</div>'+
      '</main>'+
    '</div>'+
    '<div class="ops-tasks" style="margin-top:14px">'+
      '<div class="card-h" style="padding:0 0 12px"><div><h3>链接运营任务池</h3><div class="sub">这里只放可执行任务：必须能看清任务目标、对象、材料和执行方式。</div></div><button class="btn" id="refreshLinkOpsTasks" type="button">刷新任务池</button></div>'+
      '<div id="linkOpsTaskListInline"></div>'+
    '</div>';
  const tasks = linkOpsStore.tasks || [];
  const targetList = $('linkOpsTaskListInline') || list;
  const renderTaskList = () => {
    if (linkOpsStore.error) return '<div class="empty">任务池暂不可用：'+escapeHtml(linkOpsStore.error)+'</div>';
    if (!tasks.length) return '<div class="empty">暂无任务。先在会话里聊清楚，再点“进入任务池”。</div>';
    return tasks.map(t => {
      const intents = Array.isArray(t.intents) ? t.intents : [];
      const stores = Array.isArray(t.targets?.stores) ? t.targets.stores : [];
      const refs = Array.isArray(t.targets?.productRefs) ? t.targets.productRefs : [];
      const riskNotes = Array.isArray(t.preview?.riskNotes) ? t.preview.riskNotes : [];
      const nextChecks = Array.isArray(t.preview?.nextChecks) ? t.preview.nextChecks : [];
      const agentAnswer = String(t.preview?.agentAnswer || '').trim();
      const progress = Math.max(0, Math.min(100, Number(t.progress || 0)));
      const history = Array.isArray(t.history) ? t.history.slice(-3).reverse() : [];
      const taskTitle = linkOpsTaskActionTitle(intents);
      return '<details class="linkops-task">'+
        '<summary class="task-summary"><div><h4>'+escapeHtml(taskTitle)+'</h4><small>'+escapeHtml(stores.join(', ') || '待识别店铺')+' · '+escapeHtml(refs.join(', ') || '待识别货号')+' · 进度 '+num(progress)+'%</small></div><span class="tag '+linkOpsStatusClass(t.status)+'">'+escapeHtml(linkOpsStatusLabel(t.status))+'</span></summary>'+
        '<div class="task-detail">'+
        '<div class="row1"><div>'+intents.map(x => '<span class="tag mid">'+escapeHtml(linkOpsIntentLabel(x))+'</span>').join(' ')+'</div><span class="muted">'+escapeHtml(String(t.createdAt || '').replace('T',' ').slice(0,16))+'</span></div>'+
        '<div class="task-progress"><i style="width:'+num(progress)+'%"></i></div><p>进度：<b>'+num(progress)+'%</b>'+(t.note ? ' · '+escapeHtml(t.note) : '')+'</p>'+
        '<p>原始指令：'+escapeHtml(String(t.command || '').slice(0,260))+'</p>'+
        renderLinkOpsTaskExecution(t)+
        renderLinkOpsAssetPanel(t)+
        renderLinkOpsExecutionState(t)+
        (agentAnswer ? '<details style="margin-top:8px" open><summary>智能体结论</summary>'+renderAgentAnswerCards(agentAnswer)+'</details>' : '')+
        renderLinkOpsDataAdvice(t)+
        (riskNotes.length ? '<ul class="linkops-preview-list">'+riskNotes.map(x => '<li>'+escapeHtml(x)+'</li>').join('')+'</ul>' : '')+
        (nextChecks.length ? '<details style="margin-top:8px"><summary>执行前检查项</summary><ul class="linkops-preview-list">'+nextChecks.map(x => '<li>'+escapeHtml(x)+'</li>').join('')+'</ul></details>' : '')+
        (history.length ? '<details style="margin-top:8px"><summary>操作记录</summary><ul class="linkops-preview-list">'+history.map(h => '<li>'+escapeHtml(String(h.at || '').replace('T',' ').slice(0,19))+' · '+escapeHtml(h.event || '-')+' · '+escapeHtml(h.by || '-')+'</li>').join('')+'</ul></details>' : '')+
        '<div class="task-actions">'+
          '<button type="button" data-linkops-task-action="confirm" data-task-id="'+escapeHtml(t.id || '')+'">确认成任务</button>'+
          '<button type="button" data-linkops-task-action="start" data-task-id="'+escapeHtml(t.id || '')+'">开始执行</button>'+
          '<button type="button" data-linkops-task-action="done" data-task-id="'+escapeHtml(t.id || '')+'">标记完成</button>'+
          '<button type="button" data-linkops-task-action="archive" data-task-id="'+escapeHtml(t.id || '')+'">归档</button>'+
          '<button class="danger" type="button" data-linkops-task-action="delete" data-task-id="'+escapeHtml(t.id || '')+'">删除</button>'+
        '</div>'+
        '</div>'+
      '</details>';
    }).join('');
  };
  targetList.innerHTML = renderTaskList();
  if (targetList !== list) list.innerHTML = '';
  document.querySelectorAll('[data-linkops-session-delete]').forEach(btn => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteLinkOpsChatSession(btn.dataset.linkopsSessionDelete || '');
  }));
  document.querySelectorAll('[data-linkops-session-id]').forEach(el => el.addEventListener('click', () => { linkOpsChatStore.activeId = el.dataset.linkopsSessionId || ''; renderAll(); }));
  document.querySelectorAll('[data-linkops-reco]').forEach(el => el.addEventListener('click', () => newLinkOpsChatFromPrompt(el.dataset.linkopsReco || '')));
  document.getElementById('newOpsChat')?.addEventListener('click', () => newLinkOpsChatFromPrompt(''));
  document.getElementById('sendLinkOpsChat')?.addEventListener('click', sendLinkOpsChatMessage);
  document.getElementById('clearLinkOpsChat')?.addEventListener('click', () => { const input = document.getElementById('linkOpsChatInput'); if (input) input.value = ''; });
  document.getElementById('convertChatToTask')?.addEventListener('click', convertChatToTask);
  document.getElementById('refreshLinkOpsTasks')?.addEventListener('click', refreshLinkOpsTasks);
  document.querySelectorAll('[data-linkops-task-action]').forEach(btn => btn.addEventListener('click', () => {
    const id = btn.dataset.taskId || '';
    const action = btn.dataset.linkopsTaskAction || '';
    if (action === 'confirm') return patchLinkOpsTask(id, {event:'confirm_task', status:'confirmed', progress:30, note:'已确认成可执行任务，下一步检查材料并开始执行。'}, '已确认成任务');
    if (action === 'upload_assets') return uploadLinkOpsAssets(id);
    if (action === 'start') return startLinkOpsExecutor(id);
    if (action === 'done') return patchLinkOpsTask(id, {event:'mark_done', status:'done', progress:100, note:'已人工确认完成。'}, '已标记完成');
    if (action === 'archive') return patchLinkOpsTask(id, {event:'archive', status:'archived', progress:100}, '已归档');
    if (action === 'delete') return deleteLinkOpsTask(id);
  }));
}
function renderProducts(){
  const rows = (DATA.products || []).filter(includes);
  const rangeMap = productPeriodSalesMap();
  const rowsWithRange = rows.map(r => {
    const p = rangeMap.get(r.standard_goods_sn) || {};
    const enriched = {...r, period_sales_sar:Number(p.sales_sar ?? r.sales_sar ?? 0), period_quantity:Number(p.quantity ?? r.quantity ?? 0), period_orders:Number(p.orders ?? r.order_count ?? 0)};
    return {...enriched, _verdict:productRiskVerdict(enriched)};
  });
  $('productsTable').innerHTML =
    sectionTitleHtml('货号风险池', '这张表用于先筛出“该扩、该修、该控售后、该观察”的货号；销售按当前时间段，覆盖/库存/售后/评价是最新业务快照。点货号进入货号 360 看各店承接。', selectedRangeText())+
    table(rowsWithRange, [
    ['货号', r => '<b>'+r.standard_goods_sn+'</b>'],
    ['系统判断', r => '<span class="tag '+r._verdict.level+'">'+escapeHtml(r._verdict.level === 'high' ? '先控风险' : r._verdict.level === 'mid' ? '重点关注' : '保留观察')+'</span><span class="decision-note">'+escapeHtml(r._verdict.text)+'</span>'],
    ['风险分', r => riskTag(r.risk_score)+'<div class="mono">'+num(r.risk_score)+'</div>'],
    ['当前时段销售', r => money(r.period_sales_sar)+'<br><span class="muted">销量 '+num(r.period_quantity)+' · 订单 '+num(r.period_orders)+'</span>', 'num'],
    ['覆盖/库存', r => '上架店 '+num(r.on_shelf_store_count)+'/'+num(TOTAL_STORE_COUNT)+'<br><span class="muted">缺店 '+num(r.missing_store_count)+' · 低库存 '+num(r.low_display_stock_count)+'</span>'],
    ['售后/评价', r => '售后 '+num(r.after_sales_case_count)+' · 质退 '+num(r.quality_return_volume)+'<br><span class="muted">评论 '+num(r.comment_count)+' · 低星 '+num(r.low_star_comment_count)+'</span>']
  ]);
  const matrixRows = (DATA.matrix || []).filter(includes);
  $('matrixTable').innerHTML =
    sectionTitleHtml('店铺 × 货号覆盖矩阵', '这是批量版货号地图：不是让你逐行操作，而是快速找“某店某货号缺链接 / 有销售但承接弱 / 动作分高”的组合。想看单个货号，请在货号 360 聚焦里搜索。', selectedRangeText())+
    '<div class="coverage-legend">'+
      '<div><b>发挥什么作用</b><span>把“货号 × 店铺”摊开，先找哪里有销售、哪里缺承接。</span></div>'+
      '<div><b>什么时候看</b><span>某个货号销售不错但覆盖不满，或某店动作很多时，用它定位具体组合。</span></div>'+
      '<div><b>不逐行扫</b><span>这不是每天逐行操作表；先筛店铺/货号，再看高动作分。</span></div>'+
      '<div><b>下一步</b><span>点货号去 360，看同店同款链接、评价、售后和订单。</span></div>'+
    '</div>'+
    table(matrixRows, [
    ['店铺', r => '<b>'+r.store_key+'</b>'],
    ['货号', r => '<b>'+r.standard_goods_sn+'</b>'],
    ['覆盖状态', r => '<span class="tag '+(r.need_supplement_link ? 'mid' : 'good')+'">'+(r.coverage_status || '-')+'</span>'],
    ['链接', r => '总 '+num(r.link_count)+' / 上架 '+num(r.on_shelf_count)+'<br><span class="muted">待上架 '+num(r.wait_shelf_count)+' / 售罄 '+num(r.sold_out_count)+'</span>'],
    ['最佳 SKC', r => '<span class="mono">'+(r.best_skc || '-')+'</span>'+copyButton(r.best_skc, '复制SKC')],
      ['本店货号合计销售', r => money(r.sales_sar)+'<br><span class="muted">全部 SKC 合计销量 '+num(r.quantity)+'</span>', 'num'],
    ['待办动作', r => num(r.action_count)+' 条<br><span class="muted">优先级分 '+num(r.max_action_score)+'</span>', 'num']
  ]);
}
function renderLinkSpotlight(){
  const linkRows = DATA.links || [];
  const q = state.q.trim().toLowerCase();
  let link = null;
  if (q) {
    link = linkRows.find(x =>
      String(x.skc || '').toLowerCase().includes(q)
      || String(x.standard_goods_sn || '').toLowerCase().includes(q)
    );
  }
  if (!link) {
    const filtered = linkRows.filter(includes);
    link = [...filtered].sort((a,b) =>
      Number(Boolean(b.retire_candidate))-Number(Boolean(a.retire_candidate))
      || Number(Boolean(b.high_visit_low_pay))-Number(Boolean(a.high_visit_low_pay))
      || Number(b.eps_uv||0)-Number(a.eps_uv||0)
    )[0] || linkRows[0];
  }
  if (!link) {
    $('linkSpotlightTag').textContent = '无数据';
    $('linkSpotlight').innerHTML = '<div class="empty">暂无 SKC / 链接数据</div>';
    return;
  }
  const skc = link.skc || '';
  const sn = link.standard_goods_sn || '';
  $('linkSpotlightTag').textContent = q ? '搜索聚焦' : '默认高风险';
  const allRelatedLinks = (DATA.storeLinks || DATA.links || []).filter(x => (skc && x.skc === skc) || (sn && x.standard_goods_sn === sn));
  const relatedLinks = allRelatedLinks.slice(0, 16);
  const actions = (DATA.actions || []).filter(x => (skc && x.skc === skc) || (sn && x.standard_goods_sn === sn)).slice(0, 8);
  const orders = (DATA.orders || []).filter(x => (skc && x.skc === skc) || (sn && x.standard_goods_sn === sn)).slice(0, 8);
  const after = (DATA.afterSales || []).filter(x => (skc && x.skc === skc) || (sn && x.standard_goods_sn === sn)).slice(0, 8);
  const financeGoods = (DATA.financeGoods || []).filter(x => (skc && x.skc === skc) || (sn && x.standard_goods_sn === sn)).slice(0, 8);
  const orderAmount = orders.reduce((sum,x)=>sum+Number(x.sales_sar||0),0);
  const afterAmount = after.reduce((sum,x)=>sum+Number(x.price_amount_total||0),0);
  const financeAmount = financeGoods.reduce((sum,x)=>sum+Number(x.amount||0),0);
  const issueLabels = [
    link.retire_candidate ? '下架候选' : '',
    link.high_exposure_low_click ? '高曝光低点击' : '',
    link.high_visit_low_pay ? '高访客低支付' : '',
    link.wait_shelf_block_candidate ? '待上架卡点' : '',
    Number(link.c30_sale_cnt||0) > 0 ? '近30天有销量' : ''
  ].filter(Boolean);
  const decisionCards = [
    ['链接状态', (link.shelf_status_name || '-') + ' / ' + (link.health_bucket || '-'), issueLabels.length ? '当前标签：' + issueLabels.join('、') + '。先判断是优化、替换还是保留观察。' : '当前没有明显链接异常标签，可从订单和售后侧继续看。'],
    ['流量承接', '曝光 ' + num(link.eps_uv) + ' / 访客 ' + num(link.goods_uv), '点击率 ' + pct(link.click_rate) + '，支付率 ' + pct(link.pay_rate) + '；有访客没支付时优先看价格、评价、详情承诺和活动承接。'],
    ['销售 / 财务', money(orderAmount) + ' / ' + money(financeAmount), '订单明细 ' + num(orders.length) + ' 行，财务在途商品 ' + num(financeGoods.length) + ' 条，用来互相印证。'],
    ['售后质量', num(after.length) + ' 单 / ' + money(afterAmount), after.length ? '这个 SKC/货号已有售后样本，优化前先看退货原因和质量风险。' : '当前售后样本未命中，可优先看链接承接。']
  ];
  const mainDecision = linkDecision(link, allRelatedLinks);
  const actionsWithDecision = actions.map(a => {
    const l = allRelatedLinks.find(x => String(x.skc || '') === String(a.skc || ''));
    return {...a, _decision:l ? linkDecision(l, allRelatedLinks) : null};
  });
  const detailBody =
    '<div class="detail-grid">'+
      '<div><div class="section-block-label">订单 / 财务互证</div>'+table([...orders, ...financeGoods].slice(0,16), [
        ['来源', r => r.order_no && r.sales_sar != null ? '订单' : '财务'],
        ['店铺/单号', r => '<b>'+escapeHtml(r.store_key || '-')+'</b><br><span class="mono">'+escapeHtml(r.order_no || '-')+'</span>'],
        ['商品', r => '<span class="muted">'+escapeHtml(r.goods_title || '').slice(0,80)+'</span>'],
        ['金额/数量', r => (r.sales_sar != null ? money(r.sales_sar) : money(r.amount))+'<br><span class="muted">数量 '+num(r.quantity)+'</span>', 'num']
      ])+'</div>'+
      '<div><div class="section-block-label">售后质量复核</div>'+table(after, [
        ['售后单', r => '<span class="mono">'+(r.aftersales_order_no || r.return_order_no || '-')+'</span>'],
        ['店铺', r => '<b>'+r.store_key+'</b>'],
        ['原因', r => escapeHtml(r.reason_names || '-').slice(0,80)],
        ['金额', r => money(r.price_amount_total), 'num']
      ])+'</div>'+
    '</div>';
  $('linkSpotlight').innerHTML =
    '<div class="store-flow">'+
      '<div class="store-verdict"><div class="row1"><div><h3>'+escapeHtml(skc || sn || '-')+'</h3><p>'+escapeHtml(sn || '-')+' · '+escapeHtml(link.store_key || '-')+'。SKC 页只判断这条链接：保留、优化、替换、补资料还是下架。</p></div>'+riskTag(Number(link.eps_uv||0)/8 + Number(actions[0]?.score||0)/80)+'</div>'+
        '<div class="store-action-steps">'+
          '<div class="store-step"><b>当前判断</b><p><span class="decision-strong">'+escapeHtml(mainDecision.role)+'</span>：'+escapeHtml(mainDecision.text)+'</p></div>'+
          '<div class="store-step"><b>7天短期</b><p>销量 '+num(link.c7_sale_cnt)+'，访客 '+num(link.c7_goods_uv)+'，支付率 '+linkPayRate7(link)+'。</p></div>'+
          '<div class="store-step"><b>30天稳定性</b><p>销量 '+num(link.c30_sale_cnt)+'，访客 '+num(link.c30_goods_uv ?? link.goods_uv)+'，支付率 '+linkPayRate30(link)+'。</p></div>'+
        '</div>'+
      '</div>'+
      '<div class="store-kpi-grid">'+
        '<div class="store-kpi"><span>状态</span><strong>'+escapeHtml(link.shelf_status_name || '-')+'</strong><small>'+escapeHtml(link.health_bucket || '-')+'</small></div>'+
        '<div class="store-kpi"><span>7天销量</span><strong>'+num(link.c7_sale_cnt)+'</strong><small>短期表现</small></div>'+
        '<div class="store-kpi"><span>30天销量</span><strong>'+num(link.c30_sale_cnt)+'</strong><small>稳定表现</small></div>'+
        '<div class="store-kpi"><span>7天访客</span><strong>'+num(link.c7_goods_uv)+'</strong><small>商详访客</small></div>'+
        '<div class="store-kpi"><span>30天访客</span><strong>'+num(link.c30_goods_uv ?? link.goods_uv)+'</strong><small>商详访客</small></div>'+
        '<div class="store-kpi"><span>动作</span><strong>'+num(actions.length)+'</strong><small>最新动作池</small></div>'+
      '</div>'+
    '</div>'+
    '<div class="path-grid" style="margin:14px 0">'+decisionCards.map(c =>
      '<article class="path-card"><span class="domain">'+escapeHtml(c[0])+'</span><h4>'+escapeHtml(c[1])+'</h4><p>'+escapeHtml(c[2])+'</p></article>'
    ).join('')+'</div>'+
    sectionTitleHtml('这条 SKC 的待处理动作', '动作只写需要你做什么；具体表现看下面 7/30 指标，不再用一堆混合描述。', num(actionsWithDecision.length)+' 条', actionsWithDecision.length ? 'mid' : 'good')+
    table(actionsWithDecision, [
      ['店铺', r => '<b>'+r.store_key+'</b>'],
      ['动作', r => '<span class="tag mid">'+escapeHtml(r.category || '-')+'</span>'],
      ['货号/SKC', r => '<b>'+escapeHtml(r.standard_goods_sn || '-').slice(0,48)+'</b><br><span class="mono">'+(r.skc || '-')+'</span>'+copyButton(r.skc, '复制SKC')],
      ['判断/下一步', r => (r._decision ? '<span class="decision-strong">'+escapeHtml(r._decision.role)+'</span><span class="decision-note">'+escapeHtml(r._decision.text)+'</span>' : '')+'<span class="decision-note">'+escapeHtml(r.next_step || '').slice(0,120)+'</span>']
    ])+
    sectionTitleHtml('同货号 / 同 SKC 链接对比', '同一个标准货号的其它链接放在一起，用 7天和30天判断这条是不是弱链接、替代链接或当前最佳。', '表格数字：7天 / 30天')+
    groupedTable(relatedLinks, [
      ['角色', r => linkRoleTag(r, allRelatedLinks)],
      ['店铺', r => '<b>'+r.store_key+'</b>'],
      ['SKC', r => '<span class="mono">'+(r.skc || '-')+'</span>'+copyButton(r.skc, '复制SKC')],
      ['状态/标签', r => '<span class="tag '+(isOnShelfLink(r) ? 'good' : isWaitShelfLink(r) ? 'mid' : 'info')+'">'+escapeHtml(r.shelf_status_name || '-')+'</span><br>'+linkLabelChips(r)],
      ['判断', r => '<span class="decision-note">'+escapeHtml(linkIssueText(r, allRelatedLinks))+'</span>']
    ], linkMetricGroups(true))+
    detailBlockHtml('SKC 数据复核区：订单 / 财务 / 售后互证', detailBody);
}
function renderLinks(){
  const rows = (DATA.links || []).filter(includes);
  $('linksTable').innerHTML =
    sectionTitleHtml('SKC / 链接健康池', '先按状态、风险和 7/30 表现判断：补资料、优化承接、替换下架，还是保留观察。', '最新链接日')+
    groupedTable(rows, [
    ['店铺', r => '<b>'+r.store_key+'</b>'],
    ['SKC', r => '<span class="mono">'+(r.skc || '-')+'</span><div class="muted">'+(r.standard_goods_sn || '')+'</div>'+copyButton(r.skc, '复制SKC')],
    ['状态/健康', r => '<span class="tag '+(isOnShelfLink(r) ? 'good' : isWaitShelfLink(r) ? 'mid' : 'info')+'">'+escapeHtml(r.shelf_status_name || '-')+'</span><br><span class="muted">'+escapeHtml(r.health_bucket || '')+'</span>'],
    ['标签', r => linkLabelChips(r)],
    ['风险', r => [
      r.retire_candidate ? '下架候选' : '',
      r.high_exposure_low_click ? '低点击' : '',
      r.high_visit_low_pay ? '低支付' : '',
      r.wait_shelf_block_candidate ? '待上架卡点' : ''
    ].filter(Boolean).map(x => '<span class="tag mid">'+x+'</span>').join(' ') || '<span class="tag good">正常</span>']
  ], linkMetricGroups(true));
}
function renderComments(){
  const rows = (DATA.comments || [])
    .filter(includes)
    .filter(r => inSelectedRangeValue(r.comment_date || r.comment_time || r.order_time))
    .sort((a,b)=>
    (commentRowLevel(a) === 'high' ? -1 : commentRowLevel(b) === 'high' ? 1 : 0) ||
    String(b.comment_date || '').localeCompare(String(a.comment_date || '')) ||
    Number(a.goods_comment_star || 9) - Number(b.goods_comment_star || 9)
  );
  const commentsEmptyNote = !rows.length && (DATA.comments || []).length
    ? '<div class="warning-panel inline"><h3>当前时间段或筛选条件下没有评价，不是评价底库丢失</h3><ul><li>评价底库仍有 '+num((DATA.comments || []).length)+' 条全量评价。</li><li>当前页面会严格跟随顶部时间段；如果看历史评价，请切到近30天、近一年，或清空筛选。</li></ul></div>'
    : '';
  const summary = commentProductSummary(rows);
  const lowRows = rows.filter(r => Number(r.goods_comment_star || 0) > 0 && Number(r.goods_comment_star || 0) <= 3);
  const qualityRows = rows.filter(r => /是|1|true|Y/i.test(String(r.is_quality_complaint || r.is_quality || '')) || r.bad_comment_labels);
  const storeRows = commentStoreSummary(rows).slice(0, 15);
  const latest = rows.reduce((max,r)=>String(r.comment_date || '') > max ? String(r.comment_date || '') : max, '');
  $('commentsTag').textContent = selectedRangeText() + ' · ' + num(rows.length) + ' 条评价';
  $('commentsOverview').innerHTML =
    commentsEmptyNote+
    '<div class="store-flow">'+
      '<div class="store-verdict"><h3>评价页怎么用</h3><p>建议单开这个页面：评价是质量和转化的底层原因，不应该塞在货号页最下面。先按货号或店铺筛选，再看低星、差评标签和原文。</p>'+
        '<div class="store-action-steps">'+
          '<div class="store-step"><b>1 先选时间/货号/店铺</b><p>顶部时间段、货号筛选、店铺筛选和全局搜索都会作用到评价明细。</p></div>'+
          '<div class="store-step"><b>2 先看低星</b><p>低星和质量投诉优先排前面，用来解释售后、转化和链接下滑。</p></div>'+
          '<div class="store-step"><b>3 再翻译归因</b><p>当前先保留原文；批量中文翻译建议后续做成入库字段，不依赖浏览器插件。</p></div>'+
        '</div>'+
      '</div>'+
      '<div class="store-kpi-grid">'+
        '<div class="store-kpi"><span>评价总数</span><strong>'+num(rows.length)+'</strong><small>当前筛选</small></div>'+
        '<div class="store-kpi"><span>低星评价</span><strong>'+num(lowRows.length)+'</strong><small>≤3 星</small></div>'+
        '<div class="store-kpi"><span>质量/差评标签</span><strong>'+num(qualityRows.length)+'</strong><small>需归因</small></div>'+
        '<div class="store-kpi"><span>覆盖货号</span><strong>'+num(new Set(rows.map(r=>r.standard_goods_sn).filter(Boolean)).size)+'</strong><small>标准货号</small></div>'+
        '<div class="store-kpi"><span>覆盖店铺</span><strong>'+num(new Set(rows.map(r=>r.store_key).filter(Boolean)).size)+'</strong><small>店铺</small></div>'+
        '<div class="store-kpi"><span>最新评价</span><strong>'+escapeHtml(latest || '-').slice(0,10)+'</strong><small>评价日期</small></div>'+
      '</div>'+
    '</div>'+
    '<div class="split" style="margin-top:14px">'+
      '<div>'+sectionTitleHtml('按货号汇总', '找评论多、低星多、最近仍在出问题的货号。')+table(summary, [
        ['货号', r => '<button class="link-like" data-comment-product="'+escapeHtml(r.standard_goods_sn || '')+'"><b>'+escapeHtml(r.standard_goods_sn || '-')+'</b></button>'],
        ['评价', r => num(r.comment_count), 'num'],
        ['低星', r => num(r.low_star_count), 'num'],
        ['均星', r => num(r.avg_star), 'num'],
        ['覆盖店/最新', r => num(r.store_count)+' 店<br><span class="muted">'+escapeHtml(r.latest_comment_date || '-')+'</span>']
      ], {limit:20})+'</div>'+
      '<div>'+sectionTitleHtml('按店铺汇总', '同一货号多店售卖时，用这个看差评是否集中在某个店。')+table(storeRows, [
        ['店铺', r => '<b>'+escapeHtml(r.store_key)+'</b>'],
        ['评价', r => num(r.count), 'num'],
        ['低星', r => num(r.low), 'num'],
        ['均星', r => num(r.avg), 'num'],
        ['最新', r => escapeHtml(r.latest || '-')]
      ], {limit:false})+'</div>'+
    '</div>';
  $('commentsTable').innerHTML =
    commentsEmptyNote+
    '<div class="table-note">当前时间段：'+escapeHtml(selectedRangeText())+'。先看原文；中文翻译已优先读取 SHEIN 平台译文字段；没有中文时再显示待翻译提示。</div>'+
    table(rows, [
      ['判断', r => '<span class="tag '+commentRowLevel(r)+'">'+escapeHtml(commentLevelText(r))+'</span>'],
      ['时间', r => '<span class="mono">'+escapeHtml(String(r.comment_time || r.comment_date || '-').replace('T',' ').slice(0,19))+'</span>'],
      ['店铺', r => '<b>'+escapeHtml(r.store_key || '-')+'</b>'],
      ['货号/SKC', r => '<b>'+escapeHtml(r.standard_goods_sn || '-').slice(0,64)+'</b><br><span class="mono">'+escapeHtml(r.skc || '-')+'</span>'+copyButton(r.skc, '复制SKC')],
      ['星级/标签', r => starHtml(r.goods_comment_star)+'<br><span class="muted">'+escapeHtml(r.bad_comment_labels || r.goods_comment_star_name || '-')+'</span>'],
      ['中文 / 阿文原文', r => '<div class="comment-cell-zh">'+(commentZh(r) ? escapeHtml(commentZh(r)).slice(0,320) : '<span class="muted">中文翻译待入库</span>')+'</div><div class="comment-cell-ar">'+escapeHtml(commentText(r)).slice(0,260)+'</div>'],
      ['属性', r => '<span class="muted">'+escapeHtml(r.goods_attribute || '-').slice(0,80)+'</span>']
    ], {limit:80});
  document.querySelectorAll('[data-comment-product]').forEach(btn => btn.addEventListener('click', () => {
    state.q = btn.dataset.commentProduct || '';
    safeSetValue('q', state.q);
    jumpToTab('products', {keepFilters:true});
    renderAll();
  }));
}
function insightDefs(){
  return [
    ['all','全部'],
    ['finance','财务'],
    ['link','链接'],
    ['after_sales','售后'],
    ['quality','质量'],
    ['inventory','库存'],
    ['fulfillment','履约'],
    ['marketing','营销'],
    ['business','经营']
  ];
}
function insightRowsBase(){
  return (DATA.insights || []).filter(includes);
}
function insightRows(){
  const base = insightRowsBase();
  if (!state.insight || state.insight === 'all') return base;
  return base.filter(x => insightType(x) === state.insight);
}
function renderInsightFocusBar(){
  const base = insightRowsBase();
  $('insightFocusBar').innerHTML = insightDefs().map(([key,label]) => {
    const n = key === 'all' ? base.length : base.filter(x => insightType(x) === key).length;
    return '<button class="focus-chip '+(state.insight === key || (!state.insight && key === 'all') ? 'active' : '')+'" data-insight-focus="'+key+'"><span>'+label+'</span><small>'+num(n)+'</small></button>';
  }).join('');
  document.querySelectorAll('[data-insight-focus]').forEach(btn => btn.addEventListener('click', () => {
    state.insight = btn.dataset.insightFocus || 'all';
    renderAll();
  }));
}
function renderInsights(){
  renderInsightFocusBar();
  const rows = insightRows();
  $('insightTotal').textContent = rows.length + ' 条';
  $('insightsList').innerHTML = rows.slice(0, 18).map(x => {
    const key = encodeURIComponent(insightKey(x));
    const detailTarget = ['finance','after_sales','fulfillment','marketing'].includes(insightType(x)) ? 'business' : 'actions';
    return '<article class="insight-card">'+
    '<div class="row1"><span class="domain">'+domainName(x.action_domain || x.insight_domain)+'</span><span class="score">'+num(x.score)+'</span></div>'+
    '<h4>'+escapeHtml(x.title || '-')+' · '+escapeHtml(x.store_key || x.standard_goods_sn || '全局')+'</h4>'+
    '<p><b>'+escapeHtml(x.standard_goods_sn || '')+'</b> '+(x.skc ? '<span class="mono">'+escapeHtml(x.skc)+'</span> '+copyButton(x.skc, '复制SKC') : '')+'</p>'+
    '<p class="muted">'+escapeHtml(actionEvidenceText(x) || x.evidence || '')+'</p>'+
    '<p class="next">'+escapeHtml(x.next_step || '')+'</p>'+
    '<div style="margin-top:10px">'+priorityTag(x.priority)+'</div>'+
    '<div class="command-actions">'+
      (x.store_key ? '<button class="status-btn" data-insight-target="store" data-insight-key="'+key+'">看店铺</button>' : '')+
      (x.standard_goods_sn ? '<button class="status-btn" data-insight-target="product" data-insight-key="'+key+'">看货号</button>' : '')+
      (x.skc ? '<button class="status-btn" data-insight-target="link" data-insight-key="'+key+'">看SKC</button>' : '')+
      '<button class="status-btn" data-insight-target="'+detailTarget+'" data-insight-key="'+key+'">看明细</button>'+
    '</div>'+
  '</article>';
  }).join('') || '<div class="empty">没有匹配诊断</div>';
}
function rtvTraceDecision(row){
  const status = String(row?.trace_status || '');
  const has09 = Number(row?.final_09_quantity || 0) > 0 || status.includes('可售09');
  const still03 = Number(row?.still_03_quantity || 0) > 0 || status.includes('仍在03');
  const damaged = Number(row?.final_damaged_quantity || 0) > 0 || Number(row?.final_scrap_quantity || 0) > 0 || /破损|报废/.test(status);
  const unknown = /未知|未解析/.test(status);
  const unmatched = /未匹配/.test(status);
  if (has09) return {label:'已回可售09', cls:'good', hint:'这部分可以进入“可二次销售”测算。', action:'利润页看二售测算；库存页看09可售。'};
  if (damaged) return {label:'破损/报废', cls:'high', hint:'已收到但不应当作可售库存。', action:'按损失处理，必要时查 ET 损溢/破损单。'};
  if (still03) return {label:'仍在03 RTV', cls:'mid', hint:'ET 已收退件，但还在 RTV 仓，未回到可售。', action:'等仓处理或催换包装/上架，暂不按可售。'};
  if (unknown) return {label:'去向待确认', cls:'high', hint:'已收或疑似已收，但后续仓库去向不清晰。', action:'先查 ET 库存流水和 RTV 明细。'};
  if (unmatched) return {label:'未匹配ET', cls:'high', hint:'SHEIN 有退货，但还没找到对应 ET RTV 收件。', action:'优先查换单物流，尤其 EMile 数字单号。'};
  if (status) return {label:'ET已收待判定', cls:'info', hint:'已有收件线索，继续看仓库去向。', action:'看仓库去向列和数量拆分。'};
  return {label:'待复核', cls:'mid', hint:'当前记录缺少明确状态。', action:'先核退货单和物流号。'};
}
function rtvTraceDecisionHtml(row){
  const d = rtvTraceDecision(row);
  return '<div class="rtv-decision"><span class="tag '+escapeHtml(d.cls)+'">'+escapeHtml(d.label)+'</span><b>'+escapeHtml(d.action)+'</b><small>'+escapeHtml(d.hint)+'</small></div>';
}
function rtvWarehouseTermsHtml(){
  return '<div class="rtv-term-grid">'+
    '<div class="rtv-term"><b>09 可售仓</b><span>能再次发给买家的散件库存；进入这里才是真正可二售。</span></div>'+
    '<div class="rtv-term"><b>03 RTV 仓</b><span>退件/退回暂存仓；已收到但还没确认回到可售。</span></div>'+
    '<div class="rtv-term"><b>04 破损仓</b><span>破损或待换包装；未处理前不当作可售。</span></div>'+
    '<div class="rtv-term"><b>06 报废仓</b><span>毁损报废；按资产损失看，不进入可售。</span></div>'+
  '</div>';
}
function rtvReviewActionText(row){
  if (row?.suspected_emile_handoff) return '疑似 EMile 换单：进 SHEIN 退货物流详情找“新的运单号”，再和 ET 物流号核对。';
  if (String(row?.review_priority || '') === 'high') return '高优先级：同货号/时间窗口接近，先复制 ET 物流号去 SHEIN 退货详情复核。';
  if (row?.candidate_cases) return '有 SHEIN 候选：按候选退货单逐个看物流轨迹。';
  return '没有明确候选：先按 ET 物流号、货号和收件时间反查。';
}
function renderBusiness(){
  const allBusinessCount = (DATA.finance || []).length + (DATA.orders || []).length + (DATA.afterSales || []).length + (DATA.rtvReview || []).length + (DATA.rtvTrace || []).length + (DATA.waybills || []).length + (DATA.financeOrders || []).length + (DATA.financeGoods || []).length;
  const financeRows = (DATA.finance || []).filter(includes);
  const orderRows = (DATA.orders || []).filter(includes).filter(r => rowInSelectedRangeBy(r, ['created_date', 'order_create_time']));
  const afterRows = (DATA.afterSales || []).filter(includes).filter(r => rowInSelectedRangeBy(r, ['request_time', 'snapshot_date']));
  const afterReviewRows = (DATA.afterSalesReview || []).filter(includes).filter(r => rowInSelectedRangeBy(r, ['request_time', 'order_created_date', 'snapshot_date']));
  const rtvReviewRows = (DATA.rtvReview || []).filter(includes).filter(r => rowInSelectedRangeBy(r, ['create_time']));
  const rtvTraceRows = (DATA.rtvTrace || []).filter(includes).filter(r => rowInSelectedRangeBy(r, ['request_time', 'rtv_latest_received_time']));
  const waybillRows = (DATA.waybills || []).filter(includes).filter(r => rowInSelectedRangeBy(r, ['collect_time', 'print_time', 'snapshot_date']));
  const financeOrderRows = (DATA.financeOrders || []).filter(includes).filter(r => rowInSelectedRangeBy(r, ['order_delivery_time', 'snapshot_date']));
  const financeGoodsRows = (DATA.financeGoods || []).filter(includes).filter(r => rowInSelectedRangeBy(r, ['order_delivery_time', 'snapshot_date']));
  const filteredBusinessCount = financeRows.length + orderRows.length + afterRows.length + afterReviewRows.length + rtvReviewRows.length + rtvTraceRows.length + waybillRows.length + financeOrderRows.length + financeGoodsRows.length;
  const businessEmptyNote = !filteredBusinessCount && allBusinessCount
    ? '<div class="warning-panel inline"><h3>当前筛选下没有订单/售后结果，不是底库丢失</h3><ul><li>底库仍有订单、售后、财务或履约数据，共 '+num(allBusinessCount)+' 行。</li><li>请看顶部时间、店铺、货号和全局搜索；点“清空筛选”可恢复。</li></ul></div>'
    : '';
  const financeTrade = financeRows.reduce((sum,r)=>sum+Number(r.trade_amount_sar||0),0);
  const pending = financeRows.reduce((sum,r)=>sum+Number(r.pending_settlement_income_sar||0),0);
  const inTransit = financeRows.reduce((sum,r)=>sum+Number(r.in_transit_order_amount_sar||0),0);
  const orderSales = orderRows.reduce((sum,r)=>sum+Number(r.sales_sar||0),0);
  const afterAmount = afterRows.reduce((sum,r)=>sum+Number(r.price_amount_total||0),0);
  const afterReviewAmount = afterReviewRows.reduce((sum,r)=>sum+Number(r.price_amount_total||0),0);
  const highRtvReview = rtvReviewRows.filter(r => String(r.review_priority || '') === 'high');
  const emileRtvReview = rtvReviewRows.filter(r => r.suspected_emile_handoff);
  const rtvTraceReceived = rtvTraceRows.filter(r => !String(r.trace_status || '').includes('未匹配'));
  const rtvTraceTo09 = rtvTraceRows.filter(r => Number(r.final_09_quantity || 0) > 0 || String(r.trace_status || '').includes('可售09'));
  const rtvTraceStill03 = rtvTraceRows.filter(r => Number(r.still_03_quantity || 0) > 0 || String(r.trace_status || '').includes('仍在03'));
  const rtvTraceDamagedOrScrap = rtvTraceRows.filter(r => Number(r.final_damaged_quantity || 0) > 0 || Number(r.final_scrap_quantity || 0) > 0 || String(r.trace_status || '').match(/破损|报废/));
  const rtvTraceUnknown = rtvTraceRows.filter(r => String(r.trace_status || '').match(/未匹配|未知|未解析/));
  const abnormalWaybills = waybillRows.filter(r => String(r.show_status_desc || '').match(/异常|失败|超时|取消/));
  const afterRate = orderSales > 0 ? afterAmount / orderSales : null;
  const afterByProduct = aggregateRows(afterRows, r => r.standard_goods_sn || '未归并', (acc, r) => {
    acc.standard_goods_sn = r.standard_goods_sn || '未归并';
    acc.cases = (acc.cases || 0) + 1;
    acc.amount = (acc.amount || 0) + Number(r.price_amount_total || 0);
    acc.stores = acc.stores || new Set();
    if (r.store_key) acc.stores.add(r.store_key);
  }).map(r => ({...r, store_count:r.stores?.size || 0})).sort((a,b)=>Number(b.amount||0)-Number(a.amount||0)).slice(0,6);
  const afterByStore = aggregateRows(afterRows, r => r.store_key || '-', (acc, r) => {
    acc.store_key = r.store_key || '-';
    acc.cases = (acc.cases || 0) + 1;
    acc.amount = (acc.amount || 0) + Number(r.price_amount_total || 0);
  }).sort((a,b)=>Number(b.amount||0)-Number(a.amount||0)).slice(0,6);
  const focusHtml = [
    ...afterByProduct.map(r => ({scope:'货号', name:r.standard_goods_sn, desc:'售后 '+num(r.cases)+' 单 · '+num(r.store_count)+' 店', amount:r.amount, q:r.standard_goods_sn})),
    ...afterByStore.map(r => ({scope:'店铺', name:r.store_key, desc:'售后 '+num(r.cases)+' 单', amount:r.amount, store:r.store_key}))
  ].sort((a,b)=>Number(b.amount||0)-Number(a.amount||0)).slice(0,8).map(r =>
    '<button class="ops-focus-row" '+(r.store ? 'data-home-store="'+escapeHtml(r.store)+'"' : r.q ? 'data-home-product="'+escapeHtml(r.q)+'"' : '')+'>'+
      '<span class="tag '+(r.scope === '货号' ? 'info' : 'mid')+'">'+escapeHtml(r.scope)+'</span>'+
      '<span><b>'+escapeHtml(r.name || '-')+'</b><small>'+escapeHtml(r.desc || '')+'</small></span>'+
      '<span class="num">'+escapeHtml(money(r.amount))+'</span>'+
    '</button>'
  ).join('') || '<div class="empty">当前筛选下暂无售后压力集中项。</div>';
  $('financeTable').innerHTML =
    businessEmptyNote+
    '<div class="ops-command">'+
      '<section class="ops-verdict"><div><h3>订单 / 售后复核台</h3><p>先用当前时间段确认：成交是否真实、售后压力是否集中、履约异常能否解释退款。这里不是流水仓库，明细只在需要查单时展开。</p><div class="ops-big">'+escapeHtml(pct(afterRate))+'</div><p>售后金额 / 订单销售额。比例越高，越应该先看售后集中货号和履约异常。</p></div>'+
        '<div class="ops-question-grid">'+
          '<div><b>成交是否真实</b><span>订单销售 '+escapeHtml(money(orderSales))+'；财务摘要为最新快照 '+escapeHtml(money(financeTrade))+'</span></div>'+
          '<div><b>售后压力在哪</b><span>售后 '+escapeHtml(num(afterRows.length))+' 单，金额 '+escapeHtml(money(afterAmount))+'；未落定 '+escapeHtml(num(afterReviewRows.length))+' 单</span></div>'+
          '<div><b>退件收到后去哪</b><span>ET 已收 '+escapeHtml(num(rtvTraceReceived.length))+' 单；可售09 '+escapeHtml(num(rtvTraceTo09.length))+'，03待处理 '+escapeHtml(num(rtvTraceStill03.length))+'，破损/报废 '+escapeHtml(num(rtvTraceDamagedOrScrap.length))+'</span></div>'+
          '<div><b>RTV 是否漏匹配</b><span>待核 '+escapeHtml(num(rtvReviewRows.length))+' 条，其中疑似 EMile 换单 '+escapeHtml(num(emileRtvReview.length))+' 条</span></div>'+
          '<div><b>履约是否解释异常</b><span>异常/取消面单 '+escapeHtml(num(abnormalWaybills.length))+' 条</span></div>'+
        '</div></section>'+
        '<section><div class="ops-pillar-grid">'+
        '<div class="ops-pillar"><span>订单销售</span><strong>'+money(orderSales)+'</strong><small>'+num(orderRows.length)+' 行 · 按订单创建时间</small></div>'+
        '<div class="ops-pillar"><span>售后金额</span><strong>'+money(afterAmount)+'</strong><small>'+num(afterRows.length)+' 单 · 按售后申请时间</small></div>'+
        '<div class="ops-pillar"><span>未落定售后</span><strong>'+num(afterReviewRows.length)+'</strong><small>'+money(afterReviewAmount)+' · 每日复核最新状态</small></div>'+
        '<div class="ops-pillar"><span>RTV 已收</span><strong>'+num(rtvTraceReceived.length)+'</strong><small>收到后再看 09/03/04/06 去向</small></div>'+
        '<div class="ops-pillar"><span>RTV 可二售09</span><strong>'+num(rtvTraceTo09.length)+'</strong><small>能进入二售测算；不是主利润口径</small></div>'+
        '<div class="ops-pillar"><span>换单待核 high</span><strong>'+num(highRtvReview.length)+'</strong><small>优先复制 ET 物流号去 SHEIN 轨迹核对</small></div>'+
        '<div class="ops-pillar"><span>最新财务待结算</span><strong>'+money(pending)+'</strong><small>财务摘要是最新快照；明细 '+num(financeOrderRows.length)+' 条</small></div>'+
        '<div class="ops-pillar"><span>履约异常/取消</span><strong>'+num(abnormalWaybills.length)+'</strong><small>用于解释退款、取消、未妥投</small></div>'+
      '</div>'+
      sectionTitleHtml('优先复核对象', '只列真正需要先复核的货号 / 店铺；按售后金额排序，点击可带筛选跳转。', selectedRangeText())+
      '<div class="ops-focus-list">'+focusHtml+'</div></section>'+
    '</div>'+
    '<details class="detail-section" style="margin-top:16px" id="financeEvidenceFold"><summary>查看财务店铺摘要</summary><div class="detail-body">'+
    sectionTitleHtml('财务店铺摘要', '每行一个店：看待结算、在途、已结算、账期和异常金额。', '最新财务快照')+
    table(financeRows, [
    ['店铺', r => '<b>'+r.store_key+'</b>'],
    ['交易额', r => money(r.trade_amount_sar), 'num'],
    ['待结算', r => money(r.pending_settlement_income_sar), 'num'],
    ['在途订单', r => money(r.in_transit_order_amount_sar), 'num'],
    ['已结算', r => money(r.payed_income_sar), 'num'],
    ['财务在途明细', r => num(r.finance_no_finish_order_count)+' 单<br><span class="muted">'+money(r.finance_no_finish_order_income_sar)+'</span>', 'num'],
    ['账期', r => (r.account_period_days ? num(r.account_period_days)+' 天' : '-')+'<br><span class="muted">'+escapeHtml(r.privilege_config_type_desc || '')+'</span>'],
    ['结算异常', r => money(r.settlement_abnormal_sar), 'num'],
    ['可提现', r => money(r.withdrawable_amount_sar), 'num']
  ])+'</div></details>';
  $('financeOrdersTable').innerHTML =
    sectionTitleHtml('收入明细 · 在途订单', '按发货日过滤；用于和订单销售互相印证，不是所有店都已完整接入财务明细。', selectedRangeText()+' · '+num(financeOrderRows.length)+' 条')+
    table(financeOrderRows, [
    ['店铺', r => '<b>'+r.store_key+'</b>'],
    ['发货日', r => r.order_delivery_time || '-'],
    ['订单', r => '<span class="mono">'+(r.order_no || '-')+'</span><div class="muted">'+escapeHtml(r.finance_row_id || '')+'</div>'],
    ['类型', r => escapeHtml(r.big_category_name || '-')+'<br><span class="muted">'+escapeHtml(r.second_order_type_name || '')+'</span>'],
    ['预估收入', r => money(r.estimate_income_money_total), 'num'],
    ['商品明细', r => num(r.goods_detail_count)+' 条'],
    ['状态', r => escapeHtml(r.check_status || '-')]
  ]);
  $('financeGoodsTable').innerHTML =
    sectionTitleHtml('收入明细 · 商品 / SKC', '按财务订单发货日过滤；商品层用于回到标准货号和 SKC。', selectedRangeText()+' · '+num(financeGoodsRows.length)+' 条')+
    table(financeGoodsRows, [
    ['店铺', r => '<b>'+r.store_key+'</b>'],
    ['财务订单', r => '<span class="mono">'+(r.order_no || '-')+'</span>'],
    ['货号', r => r.standard_goods_sn || r.raw_goods_sn ? '<b>'+escapeHtml(r.standard_goods_sn || r.raw_goods_sn).slice(0,60)+'</b>' : '<span class="muted">未匹配货号</span><div class="mono">'+escapeHtml(r.entity_id || '-')+'</div>'],
    ['SKC', r => '<span class="mono">'+(r.skc || '-')+'</span>'+copyButton(r.skc, '复制SKC')],
    ['商品', r => '<span class="muted">'+escapeHtml(r.goods_title || '').slice(0,90)+'</span>'],
    ['数量', r => num(r.quantity), 'num'],
    ['金额', r => money(r.amount), 'num']
  ]);
  const campaignRows = (DATA.campaigns || []).filter(includes);
  $('campaignTable').innerHTML =
    sectionTitleHtml('营销活动摘要', '活动只作为解释销售波动和链接承接的辅助信号；优先看仍有销售/曝光价值的活动。', num(campaignRows.length)+' 条')+
    table(campaignRows, [
    ['店铺', r => '<b>'+r.store_key+'</b>'],
    ['活动', r => '<b>'+escapeHtml(r.activity_name || '-').slice(0,80)+'</b><div class="muted">'+escapeHtml(r.active_status || '')+'</div>'],
    ['时间', r => (r.start_date || '-')+'<br><span class="muted">'+(r.end_date || '-')+'</span>'],
    ['商品数', r => num(r.active_product_cnt), 'num'],
    ['曝光/加车', r => num(r.goods_uv)+' / '+num(r.cart_uv), 'num'],
    ['销售', r => money(r.sale_amt), 'num']
  ]);
  $('ordersTable').innerHTML =
    sectionTitleHtml('订单明细', '按订单创建时间口径；用于从店铺、货号、SKC 反查销售。', selectedRangeText())+
    table(orderRows, [
    ['店铺', r => '<b>'+r.store_key+'</b>'],
    ['订单', r => '<span class="mono">'+(r.order_no || '-')+'</span><div class="muted">'+(r.order_create_time || '').replace('T',' ').slice(0,19)+'</div>'],
    ['货号', r => '<b>'+escapeHtml(r.standard_goods_sn || '-').slice(0,60)+'</b>'],
    ['SKC', r => '<span class="mono">'+(r.skc || '-')+'</span>'+copyButton(r.skc, '复制SKC')],
    ['商品', r => '<span class="muted">'+escapeHtml(r.goods_title || '').slice(0,90)+'</span>'],
    ['数量', r => num(r.quantity), 'num'],
    ['销售额', r => money(r.sales_sar), 'num'],
    ['履约', r => escapeHtml(r.goods_performance_status_desc || '-')]
  ]);
  $('afterSalesReviewTable').innerHTML =
    sectionTitleHtml('未落定售后待复核', '只列未最终退款/未取消/未签收的售后单；这些单会在每日业务域抓取中继续刷新，最终取消后忽略，最终退款后进入正式售后口径。', selectedRangeText()+' · '+num(afterReviewRows.length)+' 单')+
    table(afterReviewRows, [
    ['店铺', r => '<b>'+r.store_key+'</b>'],
    ['售后单', r => '<span class="mono">'+(r.aftersales_order_no || r.return_order_no || '-')+'</span><div class="muted">申请 '+(r.request_time || '').replace('T',' ').slice(0,19)+'</div>'],
    ['订单', r => '<span class="mono">'+(r.order_no || '-')+'</span><div class="muted">订单 '+String(r.order_created_date || r.order_create_time || '-').slice(0,10)+'</div>'],
    ['货号/SKC', r => '<b>'+escapeHtml(r.standard_goods_sn || '-').slice(0,60)+'</b><br><span class="mono">'+(r.skc || '-')+'</span>'+copyButton(r.skc, '复制SKC')],
    ['状态', r => '<span class="tag mid">'+escapeHtml(r.order_sub_status_name || r.return_package_status_name || '待复核')+'</span><div class="muted">'+escapeHtml(r.review_reason || '')+'</div>'],
    ['已挂起', r => num(r.open_days)+' 天', 'num'],
    ['金额', r => money(r.price_amount_total), 'num']
  ]);
  $('afterSalesTable').innerHTML =
    sectionTitleHtml('售后 / 退货明细', '按售后申请时间口径；重点看退货原因是否集中到某货号、某 SKC 或某店。', selectedRangeText())+
    table(afterRows, [
    ['店铺', r => '<b>'+r.store_key+'</b>'],
    ['售后单', r => '<span class="mono">'+(r.aftersales_order_no || r.return_order_no || '-')+'</span><div class="muted">'+(r.request_time || '').replace('T',' ').slice(0,19)+'</div>'],
    ['货号/SKC', r => '<b>'+escapeHtml(r.standard_goods_sn || '-').slice(0,60)+'</b><br><span class="mono">'+(r.skc || '-')+'</span>'+copyButton(r.skc, '复制SKC')],
    ['原因', r => escapeHtml(r.reason_names || '-')],
    ['状态', r => escapeHtml(r.order_sub_status_name || r.return_package_status_name || '-')],
    ['金额', r => money(r.price_amount_total), 'num']
  ]);
  const rtvTraceStatusTag = status => {
    const s = String(status || '-');
    const cls = s.includes('未匹配') ? 'high' : s.includes('可售09') ? 'good' : s.match(/破损|报废/) ? 'mid' : s.match(/未知|未解析/) ? 'high' : 'info';
    return '<span class="tag '+cls+'">'+escapeHtml(s)+'</span>';
  };
  const rtvTraceHtml =
    sectionTitleHtml('退货收件 / 仓库去向追踪', '把 SHEIN 退货单和 ET RTV 收件、库存流水串起来：收到没有，收到后在 09 / 03 / 04 / 06 / 未知哪里。09 去向为库存流水 FIFO 证据，不是单件序列号扫描。', selectedRangeText()+' · '+num(rtvTraceRows.length)+' 条')+
    '<div class="rtv-table-hint">阅读顺序：先看“结论/动作”，再看 SHEIN 退货物流和 ET 收件号，最后看 09/03/04/06 数量拆分。09=可售，03=RTV待处理，04=破损，06=报废。</div>'+
    table(rtvTraceRows, [
      ['结论/动作', r => rtvTraceDecisionHtml(r)],
      ['状态', r => rtvTraceStatusTag(r.trace_status)],
      ['店铺/退货单', r => '<b>'+escapeHtml(r.store_key || '-')+'</b><div class="mono">'+escapeHtml(r.return_order_no || r.aftersales_order_no || '-')+'</div><div class="muted">'+escapeHtml((r.request_time || '').replace('T',' ').slice(0,19))+'</div>'],
      ['货号/SKC', r => '<b>'+escapeHtml(r.standard_goods_sn || '-').slice(0,60)+'</b><br><span class="mono">'+escapeHtml(r.skc || '-')+'</span>'+copyButton(r.skc, '复制SKC')],
      ['SHEIN退货物流', r => '<span class="mono">'+escapeHtml(r.shein_return_express_numbers || '-')+'</span>'],
      ['ET收件', r => '<span class="mono">'+escapeHtml(r.et_return_order_ids || '-')+'</span><div class="muted">'+escapeHtml(r.rtv_express_numbers || '')+'</div><div class="muted">'+escapeHtml((r.rtv_latest_received_time || '').replace('T',' ').slice(0,19))+'</div>'],
      ['仓库去向', r => '<b>'+escapeHtml(r.destination_summary || r.rtv_warehouses || '-')+'</b><div class="muted">'+escapeHtml(r.rtv_warehouses || '')+'</div>'],
      ['数量拆分', r => '总 '+num(r.quantity || 0)+'<br><span class="muted">09 '+num(r.final_09_quantity || 0)+' · 03 '+num(r.still_03_quantity || 0)+' · 04 '+num(r.final_damaged_quantity || 0)+' · 06 '+num(r.final_scrap_quantity || 0)+' · 未知 '+num(r.final_other_quantity || 0)+'</span>', 'num']
    ], {limit: 300});
  const rtvReviewTop = rtvReviewRows
    .sort((a,b)=>(String(a.review_priority||'') === 'high' ? -1 : 0) - (String(b.review_priority||'') === 'high' ? -1 : 0) || String(b.create_time || '').localeCompare(String(a.create_time || '')))
    .slice(0, 500);
  const splitCandidates = text => String(text || '').split(' || ').filter(Boolean).slice(0, 3).map(x => '<div class="muted">'+escapeHtml(x).slice(0, 150)+'</div>').join('');
  const rtvReviewHtml =
    sectionTitleHtml('RTV 换单待复核', '反向从 ET 已收 RTV 找 SHEIN：ET 有收件物流号，但 SHEIN 售后当前物流号没有直接匹配。EMile/数字单号优先进退货单物流详情核实。', selectedRangeText()+' · '+num(rtvReviewTop.length)+' 条')+
    table(rtvReviewTop, [
      ['优先级', r => '<span class="tag '+(r.review_priority === 'high' ? 'high' : r.review_priority === 'medium' ? 'mid' : '')+'">'+escapeHtml(r.review_priority || '-')+'</span>'],
      ['ET RTV / 物流', r => '<span class="mono">'+escapeHtml(r.return_order_id || '-')+'</span><div class="mono">'+escapeHtml(r.et_shipment_number_raw || '-')+'</div>'+copyButton(r.et_shipment_number_raw, '复制ET物流号')],
      ['货号/SKU', r => '<b>'+escapeHtml(r.standard_goods_sn || '-').slice(0,60)+'</b><div class="mono">'+escapeHtml(r.sku_code || '-')+'</div>'],
      ['收件仓/数量', r => escapeHtml(r.store_name_in || '-')+'<br><span class="muted">'+escapeHtml(r.to_instock_name || '')+' · '+num(r.received_quantity || r.in_quantity || 0)+' 件</span>'],
      ['下一步', r => '<b>'+escapeHtml(rtvReviewActionText(r))+'</b><div class="muted">'+escapeHtml(r.review_reason || '-')+'</div>'],
      ['SHEIN 候选', r => splitCandidates(r.candidate_cases) || '<span class="muted">暂无同货号候选，需按 ET 物流号人工查</span>']
    ]);
  if ($('rtvWorkbench')) {
    $('rtvWorkbench').innerHTML =
      '<div class="rtv-center">'+
        '<div class="rtv-hero">'+
          '<section class="rtv-verdict"><div><h3>RTV 先看这里</h3><p>不要再从订单、售后、财务几张表里来回找。这里按退货闭环看：SHEIN 有退货 → ET 是否收到 → 收到后去了哪里 → 是否进入二售测算。</p><div class="rtv-big">'+escapeHtml(num(highRtvReview.length))+'</div><p>高优先级换单待核。先处理这些，能提高“已收可二售”召回。</p></div>'+
            '<div class="rtv-actions"><button type="button" onclick="document.getElementById(\\'rtvTraceTableAnchor\\')?.scrollIntoView({behavior:\\'smooth\\',block:\\'start\\'})">看退货去向</button><button type="button" onclick="document.getElementById(\\'rtvReviewTableAnchor\\')?.scrollIntoView({behavior:\\'smooth\\',block:\\'start\\'})">看换单待核</button><button type="button" onclick="document.querySelector(\\'[data-tab=profit]\\')?.click()">看利润影响</button><button type="button" onclick="document.querySelector(\\'[data-tab=inventory]\\')?.click()">看库存去化</button></div></section>'+
          '<section><div class="rtv-flow-grid">'+
            '<div class="rtv-stage info"><span>SHEIN 退货</span><strong>'+num(rtvTraceRows.length)+'</strong><small>当前筛选下可追踪退货记录</small></div>'+
            '<div class="rtv-stage good"><span>ET 已收到</span><strong>'+num(rtvTraceReceived.length)+'</strong><small>已匹配或已有收件线索</small></div>'+
            '<div class="rtv-stage good"><span>回到09可售</span><strong>'+num(rtvTraceTo09.length)+'</strong><small>进入二售测算，不改主利润</small></div>'+
            '<div class="rtv-stage warn"><span>仍在03/待处理</span><strong>'+num(rtvTraceStill03.length)+'</strong><small>已收但还不能当可售</small></div>'+
            '<div class="rtv-stage bad"><span>未知/未匹配</span><strong>'+num(rtvTraceUnknown.length)+'</strong><small>优先查换单或 ET 明细</small></div>'+
          '</div>'+rtvWarehouseTermsHtml()+'</section>'+
        '</div>'+
        '<div id="rtvTraceTableAnchor">'+rtvTraceHtml+'</div>'+
        '<div id="rtvReviewTableAnchor">'+rtvReviewHtml+'</div>'+
      '</div>';
  }
  $('waybillTable').innerHTML =
    sectionTitleHtml('发货 / 履约明细', '按揽收/打印/快照时间过滤；用于解释取消、未妥投、物流异常和售后集中。', selectedRangeText())+
    table(waybillRows, [
    ['店铺', r => '<b>'+r.store_key+'</b>'],
    ['包裹/物流', r => '<span class="mono">'+(r.place_order_package_id || '-')+'</span><div class="muted">'+escapeHtml(r.express_code || '')+' '+escapeHtml(r.express_no || '')+'</div>'],
    ['状态', r => '<span class="tag '+(String(r.show_status_desc || '').match(/异常|失败|超时|取消/) ? 'high' : 'good')+'">'+escapeHtml(r.show_status_desc || '-')+'</span><div class="muted">'+escapeHtml(r.tag_desc || '')+'</div>'],
    ['仓库/物流商', r => escapeHtml(r.warehouse_name || '-')+'<br><span class="muted">'+escapeHtml(r.provider_name || '')+'</span>'],
    ['货号/SKC', r => '<span class="muted">'+escapeHtml(r.goods_sn_list || '').slice(0,70)+'</span><br><span class="mono">'+escapeHtml(r.skc_list || '').slice(0,70)+'</span>'],
    ['数量/费用', r => num(r.goods_quantity)+'<br><span class="muted">'+money(r.estimate_performance_price)+'</span>', 'num']
  ]);
}
function profitKpiCard(label, value, sub = '', cls = ''){
  return '<article class="profit-card '+escapeHtml(cls)+'"><span>'+escapeHtml(label)+'</span><strong>'+escapeHtml(value)+'</strong><small>'+escapeHtml(sub)+'</small></article>';
}
function profitProductRows(){
  return (DATA.profit?.products || []).filter(r => productMatch(r));
}
function profitCostMetaByProduct(){
  const map = new Map();
  for (const r of DATA.profit?.products || []) {
    const key = String(r.standard_goods_sn || '').trim();
    if (key) map.set(key, r);
  }
  return map;
}
function purchaseBand(v){
  const n = Number(v || 0);
  if (n <= 0) return null;
  if (n < 30) return '0-30';
  if (n < 80) return '30-80';
  if (n < 150) return '80-150';
  return '150+';
}
function volumeBand(v){
  const n = Number(v || 0);
  if (n <= 0) return null;
  if (n < 5) return '<5L';
  if (n < 15) return '5-15L';
  if (n < 25) return '15-25L';
  return '25L+';
}
function selectionSamples(rows = profitProductRows()){
  return (rows || []).map(r => {
    const purchase = Number(r.avg_purchase_unit_price || 0);
    const inferredVolume = Number(r.inferred_volume_l_1600 || r.inferredVolume || 0);
    const margin = r.profit_margin_before_storage == null ? null : Number(r.profit_margin_before_storage);
    const qty = Number(r.quantity || 0);
    const profit = Number(r.profit_before_storage_sar || 0);
    const revenue = Number(r.net_revenue_sar || r.gross_revenue_sar || 0);
    const freightUnitCny = Number(r.future_first_leg_unit_cny_at_2000 || (inferredVolume * 2) || 0);
    const fixedTailSar = 0.3 + 6 + 24.984;
    const actualAvgSaleSar = qty > 0 ? Number(r.gross_revenue_sar || 0) / qty : null;
    const profitPerCbm = inferredVolume > 0 ? profit / (inferredVolume / 1000 * Math.max(1, qty)) : null;
    const roi = purchase > 0 ? (profit * RMB_RATE) / (purchase * Math.max(1, qty)) : null;
    return {...r, purchase, inferredVolume, margin, qty, profit, revenue, freightUnitCny, fixedTailSar, actualAvgSaleSar, profitPerCbm, roi, pBand:purchaseBand(purchase), vBand:volumeBand(inferredVolume)};
  }).filter(r => r.purchase > 0 && r.inferredVolume > 0 && r.margin != null && r.qty > 0);
}
function median(values){
  const a = values.map(Number).filter(Number.isFinite).sort((x,y)=>x-y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid-1] + a[mid]) / 2;
}
function quantile(values, q){
  const a = values.map(Number).filter(Number.isFinite).sort((x,y)=>x-y);
  if (!a.length) return null;
  const pos = (a.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (pos - lo);
}
function modelCostSar(purchaseCny, volumeL, otherCny = 0){
  const freightCny = Number(volumeL || 0) * 2; // 2000 RMB/CBM = 2 RMB/L
  return (Number(purchaseCny || 0) + freightCny + Number(otherCny || 0)) / RMB_RATE + 0.3 + 6 + 24.984;
}
function breakevenSaleSar(purchaseCny, volumeL, returnRate = 0.05, targetMargin = 0){
  const rr = Math.max(0, Math.min(0.8, Number(returnRate || 0)));
  const cost = modelCostSar(purchaseCny, volumeL, 0);
  const expectedReturnLoss = rr * (cost + 13.88);
  const denom = Math.max(0.01, 1 - rr - Number(targetMargin || 0));
  return (cost + expectedReturnLoss) / denom;
}
function selectionCellStats(samples, pBand, vBand){
  const rows = samples.filter(r => r.pBand === pBand && r.vBand === vBand);
  if (!rows.length) return {pBand, vBand, n:0, cls:'mid', label:'样本少', score:null};
  const medMargin = median(rows.map(r=>r.margin));
  const totalProfit = rows.reduce((a,r)=>a+r.profit,0);
  const totalQty = rows.reduce((a,r)=>a+r.qty,0);
  const medDensity = median(rows.map(r=>r.profitPerCbm));
  const score = (Number(medMargin || 0) * 55) + Math.min(25, Math.log10(Math.max(1,totalProfit)) * 7) + Math.min(20, Math.log10(Math.max(1,totalQty)) * 5);
  const cls = medMargin >= .25 && totalProfit > 1000 ? 'good' : medMargin < .1 || totalProfit < 0 ? 'bad' : 'mid';
  return {pBand, vBand, n:rows.length, cls, label:cls === 'good' ? '优先' : cls === 'bad' ? '谨慎' : '观察', score, medMargin, totalProfit, totalQty, medDensity, examples:rows.sort((a,b)=>b.profit-a.profit).slice(0,2)};
}
function bestSelectionZones(samples){
  const pBands = ['0-30','30-80','80-150','150+'];
  const vBands = ['<5L','5-15L','15-25L','25L+'];
  const cells = pBands.flatMap(p => vBands.map(v => selectionCellStats(samples, p, v))).filter(c => c.n);
  return cells.sort((a,b)=>Number(b.score||-999)-Number(a.score||-999));
}
function renderSelectionBenchmark(samples){
  if (!samples.length) return '<div class="empty">成本表暂时没有足够的头程/进货价样本，无法建立选品标尺。</div>';
  const zones = bestSelectionZones(samples);
  const best = zones[0];
  const purchaseMedian = median(samples.map(r=>r.purchase));
  const purchaseP25 = quantile(samples.map(r=>r.purchase), .25);
  const purchaseP75 = quantile(samples.map(r=>r.purchase), .75);
  const volumeMedian = median(samples.map(r=>r.inferredVolume));
  const volumeP25 = quantile(samples.map(r=>r.inferredVolume), .25);
  const volumeP75 = quantile(samples.map(r=>r.inferredVolume), .75);
  const topExamples = samples.slice().sort((a,b)=>(b.profit||0)-(a.profit||0)).slice(0,5);
  const pBands = ['0-30','30-80','80-150','150+'];
  const vBands = ['<5L','5-15L','15-25L','25L+'];
  const rows = ['<div class="matrix-row"><div></div>'+pBands.map(p=>'<div class="matrix-cell head">进货 '+escapeHtml(p)+' RMB</div>').join('')+'</div>'];
  for (const v of vBands) {
    rows.push('<div class="matrix-row"><div class="matrix-cell head">体积 '+escapeHtml(v)+'</div>'+pBands.map(p => {
      const c = selectionCellStats(samples,p,v);
      const ex = (c.examples||[]).map(x=>x.standard_goods_sn).join(' / ');
      return '<div class="matrix-cell '+c.cls+'"><b>'+escapeHtml(c.label)+'</b><small>样本 '+num(c.n)+' · 中位利润率 '+(c.medMargin == null ? '-' : pct(c.medMargin))+'</small><small>'+escapeHtml(ex || '暂无历史品')+'</small></div>';
    }).join('')+'</div>');
  }
  return '<div class="selection-model wide">'+
    '<div class="selection-verdict"><h4>选品标尺结论</h4><p>按历史成本表倒推体积，并用实际销售利润校准：当前最优区间是 <b>进货 '+escapeHtml(best?.pBand || '-')+' RMB、体积 '+escapeHtml(best?.vBand || '-')+'</b>。未来新选品按 <b>2000 RMB/方 = 2 RMB/L</b> 估算头程；如果没有把握售价，先避开低货值大体积。</p>'+
      '<div class="selection-metrics">'+
        '<div><span>历史进货价中位数</span><strong>'+escapeHtml(cny(purchaseMedian))+'</strong><small>'+escapeHtml(cny(purchaseP25))+' ~ '+escapeHtml(cny(purchaseP75))+'</small></div>'+
        '<div><span>倒推体积中位数</span><strong>'+escapeHtml(fmt.format(volumeMedian))+'L</strong><small>'+escapeHtml(fmt.format(volumeP25))+'L ~ '+escapeHtml(fmt.format(volumeP75))+'L</small></div>'+
        '<div><span>尾程固定费</span><strong>SAR 31.28</strong><small>上架 0.3 + 出库 6 + 派送 24.984</small></div>'+
      '</div></div>'+
    '<div class="selection-matrix-panel">'+
      sectionTitleHtml('进货价 × 体积选品矩阵', '绿色优先、橙色观察、红色谨慎；体积来自历史头程按 1600 RMB/方倒推，未来头程按 2000 RMB/方重算。')+
      '<div class="selection-matrix">'+rows.join('')+'</div>'+
    '</div>'+
    '<div class="selection-sample-panel">'+
      sectionTitleHtml('历史利润样本 Top 5', '看真实赚钱品落在哪些进货价和体积区间。')+
      table(topExamples, [
      ['货号', r => '<b>'+escapeHtml(r.standard_goods_sn || '-')+'</b>'],
      ['进货价/体积', r => escapeHtml(cny(r.purchase))+'<br><span class="muted">'+escapeHtml(fmt.format(r.inferredVolume))+'L</span>', 'num'],
      ['净成交/利润', r => money(r.net_revenue_sar || r.gross_revenue_sar)+'<br><span class="muted">利润 '+money(r.profit)+'</span>', 'num'],
      ['利润率/ROI', r => pct(r.margin)+'<br><span class="muted">ROI '+pct(r.roi)+'</span>', 'num'],
      ['未来头程', r => escapeHtml(cny(r.freightUnitCny))+' / 件', 'num']
    ], {limit:5})+
    '</div>'+
  '</div>';
}
function aggregateProfitProductsFromDailyRows(rows){
  const metaMap = profitCostMetaByProduct();
  const groups = new Map();
  for (const r of rows || []) {
    const key = String(r.standard_goods_sn || '').trim();
    if (!key) continue;
    const g = groups.get(key) || {
      standard_goods_sn:key,
      gross_revenue_sar:0,
      net_revenue_sar:0,
      quantity:0,
      orders:0,
      order_lines:0,
      product_cost_sar:0,
      return_delivery_fee_sar:0,
      rtv_recoverable_cost_sar:0,
      rtv_09_recoverable_cost_sar:0,
      rtv_received_quantity:0,
      rtv_received_to_09_quantity:0,
      profit_before_storage_sar:0,
      profit_if_rtv_received_resellable_sar:0,
      profit_if_rtv_09_resellable_sar:0,
      known_net_revenue_sar:0,
      known_gross_revenue_sar:0,
      missing_cost_revenue_sar:0,
      missing_cost_quantity:0,
      missing_cost_lines:0,
      reversal_lines:0
    };
    g.gross_revenue_sar += Number(r.gross_revenue_sar || 0);
    g.net_revenue_sar += Number(r.net_revenue_sar || 0);
    g.quantity += Number(r.quantity || 0);
    g.orders += Number(r.orders || 0);
    g.order_lines += Number(r.order_lines || 0);
    g.product_cost_sar += Number(r.product_cost_sar || 0);
    g.return_delivery_fee_sar += Number(r.return_delivery_fee_sar || 0);
    g.rtv_recoverable_cost_sar += Number(r.rtv_recoverable_cost_sar || 0);
    g.rtv_09_recoverable_cost_sar += Number(r.rtv_09_recoverable_cost_sar || 0);
    g.rtv_received_quantity += Number(r.rtv_received_quantity || 0);
    g.rtv_received_to_09_quantity += Number(r.rtv_received_to_09_quantity || 0);
    g.profit_before_storage_sar += Number(r.profit_before_storage_sar || 0);
    g.profit_if_rtv_received_resellable_sar += Number(r.profit_if_rtv_received_resellable_sar ?? r.profit_before_storage_sar ?? 0);
    g.profit_if_rtv_09_resellable_sar += Number(r.profit_if_rtv_09_resellable_sar ?? r.profit_before_storage_sar ?? 0);
    g.known_net_revenue_sar += Number(r.known_net_revenue_sar ?? r.known_gross_revenue_sar ?? 0);
    g.known_gross_revenue_sar += Number(r.known_gross_revenue_sar || 0);
    g.missing_cost_revenue_sar += Number(r.missing_cost_revenue_sar || 0);
    g.missing_cost_quantity += Number(r.missing_cost_quantity || 0);
    g.missing_cost_lines += Number(r.missing_cost_lines || 0);
    g.reversal_lines += Number(r.reversal_lines || 0);
    groups.set(key, g);
  }
  return Array.from(groups.values()).map(g => {
    const meta = metaMap.get(g.standard_goods_sn) || {};
    const coverage = g.net_revenue_sar > 0 ? g.known_net_revenue_sar / g.net_revenue_sar : null;
    const margin = g.net_revenue_sar > 0 && g.known_net_revenue_sar > 0 ? g.profit_before_storage_sar / g.net_revenue_sar : null;
    return {
      ...meta,
      ...g,
      unit_cost_sar: meta.unit_cost_sar,
      complete_batch_count: meta.complete_batch_count,
      ignored_batch_count: meta.ignored_batch_count,
      costed_quantity: meta.costed_quantity,
      avg_purchase_unit_price: meta.avg_purchase_unit_price,
      avg_volume_l: meta.avg_volume_l,
      avg_weight_kg: meta.avg_weight_kg,
      last_cost_imported_at: meta.last_cost_imported_at,
      cost_coverage_revenue_rate: coverage,
      profit_margin_before_storage: margin
    };
  });
}
function renderProfitScatter(rows){
  const usable = selectionSamples(rows).slice(0, 120);
  if (!usable.length) return '<div class="empty">成本表里还没有足够的体积/利润率样本；后续成本表补“长宽高”后会出现选品曲线。</div>';
  const xs = usable.map(r => Number(r.inferredVolume || 0));
  const ys = usable.map(r => Number(r.profit_margin_before_storage || 0));
  const maxX = niceCeil(Math.max(1, ...xs));
  const minY = Math.min(-0.2, Math.min(...ys));
  const maxY = Math.max(0.8, Math.max(...ys));
  const w=720,h=300,padL=58,padR=22,padT=20,padB=44;
  const xFor = v => padL + (Number(v || 0)/maxX) * (w-padL-padR);
  const yFor = v => padT + (1 - ((Number(v || 0)-minY)/(maxY-minY))) * (h-padT-padB);
  const yTicks = [minY, 0, (maxY)/2, maxY];
  const grid = yTicks.map(v => '<line class="grid-line" x1="'+padL+'" y1="'+yFor(v).toFixed(1)+'" x2="'+(w-padR)+'" y2="'+yFor(v).toFixed(1)+'"></line><text class="axis" text-anchor="end" x="'+(padL-8)+'" y="'+(yFor(v)+4).toFixed(1)+'">'+escapeHtml(pct(v))+'</text>').join('');
  const points = usable.map(r => {
    const margin = Number(r.profit_margin_before_storage || 0);
    const color = margin >= .25 ? '#22c55e' : margin >= .1 ? '#f97316' : '#ef4444';
    return '<circle class="point" cx="'+xFor(r.inferredVolume).toFixed(1)+'" cy="'+yFor(margin).toFixed(1)+'" r="5" fill="'+color+'"><title>'+escapeHtml((r.standard_goods_sn||'-')+' 体积 '+fmt.format(r.inferredVolume)+'L 利润率 '+pct(margin))+'</title></circle>';
  }).join('');
  return '<div class="profit-scatter"><svg viewBox="0 0 '+w+' '+h+'" role="img" aria-label="利润率与体积散点">'+grid+
    '<line class="axis-line" x1="'+padL+'" y1="'+padT+'" x2="'+padL+'" y2="'+(h-padB)+'"></line>'+
    '<line class="axis-line" x1="'+padL+'" y1="'+yFor(0).toFixed(1)+'" x2="'+(w-padR)+'" y2="'+yFor(0).toFixed(1)+'"></line>'+
    '<line class="axis-line" x1="'+padL+'" y1="'+(h-padB)+'" x2="'+(w-padR)+'" y2="'+(h-padB)+'"></line>'+
    points+
    '<text class="axis" x="'+padL+'" y="'+(h-8)+'">0L</text><text class="axis" text-anchor="end" x="'+(w-padR)+'" y="'+(h-8)+'">'+escapeHtml(fmt.format(maxX))+'L</text>'+
  '</svg><p class="sub">横轴体积（L），纵轴利润率；绿色高利润，橙色观察，红色谨慎。</p></div>';
}
function renderProfitCalculator(){
  const html =
    '<div class="selection-slider-grid">'+
      '<label>预估售价 SAR<input id="calcSaleSar" type="number" step="0.01" value="99"></label>'+
      '<label>进货单价 CNY<input id="calcPurchaseCny" type="number" step="0.01" value="60"></label>'+
      '<label>预估体积 L<input id="calcVolumeL" type="number" step="0.1" value="10"></label>'+
      '<label>预估退货/派送失败率 %<input id="calcReturnRate" type="number" step="0.1" value="5"></label>'+
    '</div>'+
    '<div class="selection-output" id="calcProfitOutput"></div>'+
    '<p class="sub">计算口径：单位成本=(采购+头程+其它)/1.8；退货期望成本=退货率 × (单位成本 + 13.88 SAR)，退货营收按 0 保守处理。体积目前只用于选品参考，不直接扣仓储到单品。</p>';
  return html;
}
function updateProfitCalculator(){
  const out = $('calcProfitOutput');
  if (!out) return;
  const sale = Number($('calcSaleSar')?.value || 0);
  const purchase = Number($('calcPurchaseCny')?.value || 0);
  const rr = Math.max(0, Number($('calcReturnRate')?.value || 0) / 100);
  const volume = Number($('calcVolumeL')?.value || 0);
  const freightCny = volume * 2;
  const unitCostSar = modelCostSar(purchase, volume, 0);
  const expectedReturnLoss = rr * (unitCostSar + 13.88);
  const expectedProfit = sale * (1 - rr) - unitCostSar - expectedReturnLoss;
  const margin = sale > 0 ? expectedProfit / sale : null;
  const be0 = breakevenSaleSar(purchase, volume, rr, 0);
  const be25 = breakevenSaleSar(purchase, volume, rr, .25);
  const fixedRatio = sale > 0 ? (0.3 + 6 + 24.984) / sale : null;
  const verdict = margin == null ? '请输入售价' : margin >= .25 ? '达到优先选品线' : margin >= .1 ? '可观察，但要看动销和售后' : '低于安全线，谨慎选品';
  out.innerHTML = '<strong>'+escapeHtml(money(expectedProfit))+' · '+escapeHtml(pct(margin))+'</strong>'+
    '<span>未来头程按 2000 RMB/方估算：体积 '+escapeHtml(fmt.format(volume))+'L = 头程 '+escapeHtml(cny(freightCny))+' / 件；总成本 '+escapeHtml(money(unitCostSar))+'；预期退货损失 '+escapeHtml(money(expectedReturnLoss))+'。</span>'+
    '<span>保本售价 '+escapeHtml(money(be0))+'；若要 25% 利润率，建议售价至少 '+escapeHtml(money(be25))+'。尾程固定费占售价 '+escapeHtml(pct(fixedRatio))+'。'+escapeHtml(verdict)+'</span>';
}
function bindProfitCalculator(){
  document.querySelectorAll('#profitCalculatorPanel input').forEach(input => {
    if (input.dataset.profitCalcBound) return;
    input.dataset.profitCalcBound = '1';
    input.addEventListener('input', updateProfitCalculator);
  });
  updateProfitCalculator();
}
function profitActionText(r){
  const margin = Number(r.profit_margin_before_storage ?? 0);
  const profit = Number(r.profit_before_storage_sar || 0);
  const reversal = Number(r.reversal_lines || 0);
  const coverage = Number(r.cost_coverage_revenue_rate || 0);
  if (coverage < .9) return '<span class="tag mid">先补成本</span><br><span class="muted">覆盖 '+escapeHtml(pct(coverage))+'</span>';
  if (profit <= 0) return '<span class="tag high">暂停/复核</span><br><span class="muted">利润为负</span>';
  if (margin < .1) return '<span class="tag high">调价/淘汰</span><br><span class="muted">利润率 '+escapeHtml(pct(margin))+'</span>';
  if (reversal > 0 && margin < .25) return '<span class="tag mid">控退货</span><br><span class="muted">反转 '+escapeHtml(num(reversal))+' 行</span>';
  if (margin >= .25 && profit > 0) return '<span class="tag good">可加码</span><br><span class="muted">利润率 '+escapeHtml(pct(margin))+'</span>';
  return '<span class="tag info">观察</span><br><span class="muted">继续跟踪</span>';
}
function renderProfitPage(){
  const range = ensureDateRange();
  const rows = profitDailyRows(range.start, range.end, state.store, true);
  const summary = profitSummaryForRows(rows);
  const allCostProducts = profitProductRows();
  const selectionRows = selectionSamples(allCostProducts);
  const products = aggregateProfitProductsFromDailyRows(rows);
  const costProducts = products.filter(r => Number(r.known_net_revenue_sar ?? r.known_gross_revenue_sar ?? 0) > 0 || Number(r.product_cost_sar || 0) > 0).length;
  const missingProducts = products.filter(r => Number(r.missing_cost_revenue_sar || 0) > 0 || (Number(r.net_revenue_sar || 0) > 0 && Number(r.cost_coverage_revenue_rate || 0) < .9)).length;
  const rawMonthRows = DATA.profit?.monthGroups || [];
  const isScopedProfit = storeFilterKind().type !== 'all' || Boolean(productScopeQuery());
  const monthRows = isScopedProfit ? aggregateProfitMonthRowsFromDailyRows(profitDailyRows(chartRangeFor('month').start, chartRangeFor('month').end, state.store, true)) : rawMonthRows;
  const storageMonths = new Set(rawMonthRows.filter(r => Number(r.month_storage_fee_sar || 0) > 0).map(r => String(r.month_start || '').slice(0,7))).size;
  const hasCost = summary.hasAnyCost;
  const margin = Number(summary.margin ?? 0);
  const profitLevel = !hasCost ? 'warn' : Number(summary.profitSar || 0) < 0 ? 'bad' : margin >= .25 ? 'good' : margin >= .1 ? 'warn' : 'bad';
  const profitVerdict = !hasCost
    ? '当前筛选范围成本覆盖不足，先补成本表再判断利润。'
    : Number(summary.profitSar || 0) < 0
      ? '当前筛选范围亏损，优先看低利润货号、退货侵蚀和成本异常。'
      : margin >= .25
        ? '当前筛选范围利润健康，可优先复盘高利润货号并考虑加码。'
        : margin >= .1
          ? '当前筛选范围有利润但安全垫一般，先看退货费和低利润货号。'
          : '当前筛选范围利润率偏低，适合做调价、控退货或淘汰复核。';
  $('profitTag').textContent = selectedRangeText() + ' · ' + homeScopeSubtitle();
  $('profitOverview').innerHTML =
    '<div class="page-anchor-row"><button type="button" onclick="document.getElementById(\\'profitTrendCard\\')?.scrollIntoView({behavior:\\'smooth\\',block:\\'start\\'})">看月利润趋势</button><button type="button" onclick="document.getElementById(\\'profitRankGrid\\')?.scrollIntoView({behavior:\\'smooth\\',block:\\'start\\'})">看加码/处理货号</button><button type="button" onclick="document.getElementById(\\'profitSelectionCard\\')?.scrollIntoView({behavior:\\'smooth\\',block:\\'start\\'})">看选品标尺</button><button type="button" onclick="document.getElementById(\\'profitCostGapCard\\')?.scrollIntoView({behavior:\\'smooth\\',block:\\'start\\'})">看成本缺口</button></div>'+
    '<div class="mission-grid">'+
      '<div class="mission-card '+escapeHtml(profitLevel)+'"><span>真实商品利润</span><strong>'+escapeHtml(hasCost ? money(summary.profitSar) : '待成本')+'</strong><p>主口径：退货营收归 0，真实退货退款扣退货运费；不把 RTV 回收直接冲回主利润。</p></div>'+
      '<div class="mission-card '+(Number(summary.rtvRecoverableCostSar||0) ? 'good' : 'info')+'"><span>RTV 已收可二售</span><strong>'+escapeHtml(hasCost ? money(summary.profitReceivedResellableSar) : '-')+'</strong><p>测算口径：如果 ET 已收退件未来可卖，理论上比保守口径多 '+escapeHtml(money(summary.rtvRecoverableCostSar))+'。</p></div>'+
      '<div class="mission-card '+(Number(summary.costCoverageRate||0) >= .9 ? 'good' : 'warn')+'"><span>成本覆盖率</span><strong>'+escapeHtml(pct(summary.costCoverageRate))+'</strong><p>缺成本净成交 '+escapeHtml(money(summary.missingCostRevenueSar))+'；成本不足时不要硬看利润率。</p></div>'+
      '<div class="mission-card '+(Number(summary.returnFeeSar||0) ? 'warn' : 'good')+'"><span>售后侵蚀</span><strong>'+escapeHtml(money(summary.returnFeeSar))+'</strong><p>反转 '+escapeHtml(num(summary.reversalLines))+' 行；先定位低利润且退货多的货号。</p></div>'+
    '</div>'+
    '<div class="profit-command">'+
      '<section class="profit-verdict">'+
        '<div><h3>先看结论</h3><p>'+escapeHtml(profitVerdict)+'</p>'+
          '<div class="profit-big '+escapeHtml(profitLevel)+'">'+escapeHtml(hasCost ? money(summary.profitSar) : '待成本表')+'</div>'+
          '<p>'+escapeHtml(selectedRangeText())+' · '+escapeHtml(homeScopeSubtitle())+' · 利润率 '+escapeHtml(hasCost ? pct(summary.margin) : '-')+'</p></div>'+
        '<div class="profit-logic">'+
          '<div><b>收入</b><span>净成交 '+escapeHtml(money(summary.netRevenueSar))+'</span></div>'+
          '<div><b>成本</b><span>商品成本 '+escapeHtml(money(summary.productCostSar))+'</span></div>'+
          '<div><b>退货</b><span>反转 '+escapeHtml(num(summary.reversalLines))+' 行 · 退货费 '+escapeHtml(money(summary.returnFeeSar))+'</span></div>'+
          '<div><b>仓储</b><span>单店/货号未拆；月总盘扣除</span></div>'+
        '</div>'+
      '</section>'+
      '<section>'+
    '<div class="profit-summary-grid">'+
      profitKpiCard('当前真实利润', hasCost ? money(summary.profitSar) : '待成本表', hasCost ? ('RMB '+fmt.format(Number(summary.profitSar||0)*RMB_RATE)+' · 未扣月仓储') : '导入成本表后自动替换首页粗估', hasCost ? (Number(summary.profitSar||0) >= 0 ? 'good' : 'bad') : 'warn')+
      profitKpiCard('利润率', hasCost ? pct(summary.margin) : '-', '当前筛选口径；单店/货号不拆仓储费', hasCost ? (Number(summary.margin||0) >= .25 ? 'good' : Number(summary.margin||0) >= .1 ? 'warn' : 'bad') : 'warn')+
      profitKpiCard('成本覆盖', pct(summary.costCoverageRate), '缺成本净成交 '+money(summary.missingCostRevenueSar), Number(summary.costCoverageRate||0) >= .9 ? 'good' : 'warn')+
      profitKpiCard('退货保守扣减', money(summary.returnFeeSar), '反转 '+num(summary.reversalLines)+' 行；仅真实退货退款扣 13.88 SAR', Number(summary.returnFeeSar||0) ? 'bad' : 'good')+
      profitKpiCard('RTV 已收二售测算', hasCost ? money(summary.profitReceivedResellableSar) : '-', '比保守口径多 '+money(summary.rtvRecoverableCostSar)+'；已收 '+num(summary.rtvReceivedQuantity)+' 件', Number(summary.rtvRecoverableCostSar||0) ? 'good' : 'warn')+
    '</div>'+
    '<div class="store-flow">'+
      '<div class="store-verdict"><h3>口径说明</h3><p>商品/店铺/货号层先算“未扣仓储费”的真实商品经营利润；月度总利润再扣月仓储费。仓储费是全仓总数，不能硬拆到每个货号。</p>'+
        '<div class="store-action-steps">'+
          '<div class="store-step"><b>成本批次</b><p>同货号完整批次总成本 / 发货总数；缺头程运输费的批次不计入均摊。</p></div>'+
          '<div class="store-step"><b>退货反转</b><p>退货/仅退款/派件失败营收按 0；仅真实退货退款额外扣 13.88 SAR。</p></div>'+
          '<div class="store-step"><b>月仓储费</b><p>只算月总利润；DSY/LGM 按当月净成交额比例分摊，不拆到单货号。</p></div>'+
        '</div></div>'+
      '<div class="store-kpi-grid">'+
        '<div class="store-kpi"><span>已覆盖成本货号</span><strong>'+num(costProducts)+'</strong><small>完整批次</small></div>'+
        '<div class="store-kpi"><span>缺成本货号</span><strong>'+num(missingProducts)+'</strong><small>补表优先</small></div>'+
        '<div class="store-kpi"><span>仓储费月份</span><strong>'+num(storageMonths)+'</strong><small>只进月总利润</small></div>'+
        '<div class="store-kpi"><span>成本覆盖净成交</span><strong>'+money(summary.knownGrossRevenueSar)+'</strong><small>可算利润部分</small></div>'+
        '<div class="store-kpi"><span>商品成本</span><strong>'+money(summary.productCostSar)+'</strong><small>完整批次均摊</small></div>'+
        '<div class="store-kpi"><span>净营收</span><strong>'+money(summary.netRevenueSar)+'</strong><small>退货营收按 0</small></div>'+
      '</div>'+
    '</div></section></div>';
  const profitMonthDetailRows = monthRows.filter(r => {
      const m = String(r.month_start || '').slice(0,7);
      const cr = chartRangeFor('month');
      if (!(m >= monthId(cr.start) && m <= monthId(cr.end))) return false;
      return isScopedProfit || storeMatchesScope({store_key:'', group_key:r.group_key || ''});
    });
  $('profitTrendPanel').innerHTML = renderProfitLineChart() + sectionTitleHtml('月度利润明细', isScopedProfit ? '当前店铺/分组/货号筛选下的月度商品经营利润；未拆月仓储费。' : '总计和分组月利润；仓储费按 DSY/LGM 净成交额比例分摊。') + table(profitMonthDetailRows, [
      ['月份/组', r => '<b>'+escapeHtml(String(r.month_start || '').slice(0,7))+'</b><br><span class="tag info">'+escapeHtml(r.group_key || '-')+'</span>'],
      ['净营收', r => money(r.net_revenue_sar), 'num'],
      ['商品成本', r => money(r.product_cost_sar), 'num'],
      ['退货费', r => money(r.return_delivery_fee_sar), 'num'],
      ['RTV二售测算', r => money(r.profit_if_rtv_received_resellable_after_storage_sar ?? r.profit_if_rtv_received_resellable_sar ?? r.profit_after_storage_sar)+'<br><span class="muted">已收 '+num(r.rtv_received_quantity || 0)+' 件</span>', 'num'],
      ['分摊仓储', r => money(r.allocated_storage_fee_sar), 'num'],
      ['月利润', r => money(r.profit_after_storage_sar)+'<br><span class="muted">'+pct(r.profit_margin_after_storage)+'</span>', 'num'],
      ['覆盖', r => pct(r.cost_coverage_revenue_rate), 'num']
    ], {limit:false});
  $('profitCalculatorPanel').innerHTML = renderSelectionBenchmark(selectionRows) +
    '<div class="profit-tool-grid">'+
      '<div class="profit-tool-card">'+sectionTitleHtml('新选品利润试算', '输入计划售价、进货价和体积，按未来 2000 RMB/方头程 + SHEIN 固定尾程费估算保本线。') + renderProfitCalculator()+'</div>'+
      '<div class="profit-tool-card">'+sectionTitleHtml('历史样本：进货价 / 倒推体积 × 利润率', '当前成本表没有物理长宽高，体积先由历史头程按 1600 RMB/方倒推，未来头程按 2000 RMB/方重算；后续补长宽高后会更准。') + renderProfitScatter(allCostProducts)+'</div>'+
    '</div>';
  const profitMarginSplit = .20;
  const rankedProfitProducts = products
    .filter(r => Number(r.cost_coverage_revenue_rate || 0) >= .9 && Number(r.net_revenue_sar || 0) > 0 && r.profit_margin_before_storage != null)
    .sort((a,b)=>Number(b.profit_margin_before_storage ?? -999)-Number(a.profit_margin_before_storage ?? -999));
  const winners = rankedProfitProducts.filter(r => Number(r.profit_margin_before_storage || 0) >= profitMarginSplit);
  const losers = rankedProfitProducts.filter(r => Number(r.profit_margin_before_storage || 0) < profitMarginSplit)
    .sort((a,b)=>Number(a.profit_margin_before_storage ?? 999)-Number(b.profit_margin_before_storage ?? 999));
  const gapRows = products.filter(r => Number(r.missing_cost_revenue_sar || 0) > 0 || (Number(r.net_revenue_sar || 0) > 0 && Number(r.cost_coverage_revenue_rate || 0) < .9))
    .sort((a,b)=>Number(b.missing_cost_revenue_sar||0)-Number(a.missing_cost_revenue_sar||0));
  const profitCols = [
    ['货号', r => '<button class="link-like" data-profit-product="'+escapeHtml(r.standard_goods_sn || '')+'"><b>'+escapeHtml(r.standard_goods_sn || '-')+'</b></button>'],
    ['净成交/原销售', r => money(r.net_revenue_sar)+'<br><span class="muted">原 '+money(r.gross_revenue_sar)+'</span>', 'num'],
    ['成本/退货费', r => money(r.product_cost_sar)+'<br><span class="muted">退货费 '+money(r.return_delivery_fee_sar)+'</span>', 'num'],
    ['利润/率', r => money(r.profit_before_storage_sar)+'<br><span class="muted">'+pct(r.profit_margin_before_storage)+'</span>', 'num'],
    ['RTV二售测算', r => money(r.profit_if_rtv_received_resellable_sar ?? r.profit_before_storage_sar)+'<br><span class="muted">已收 '+num(r.rtv_received_quantity || 0)+' 件</span>', 'num'],
    ['单位成本', r => r.unit_cost_sar == null ? '-' : money(r.unit_cost_sar), 'num'],
    ['建议动作', r => profitActionText(r)]
  ];
  $('profitWinners').innerHTML = winners.length
    ? table(winners, profitCols, {limit:30})
    : '<div class="empty">当前时间、店铺/分组、货号筛选下暂无利润率 ≥ 20% 的货号。</div>';
  $('profitLosers').innerHTML = losers.length
    ? table(losers, profitCols, {limit:30})
    : '<div class="empty">当前时间、店铺/分组、货号筛选下暂无利润率 < 20% 的货号。</div>';
  $('profitCostGaps').innerHTML =
    '<div class="table-note">成本文件放在 <span class="mono">inputs/costs/</span>；模板是 <span class="mono">inputs/costs/SHEIN成本表模板.xlsx</span>。如果一批货缺头程运输费，会显示为缺口但不会污染单位成本。</div>'+
    (gapRows.length ? table(gapRows, [
      ['货号', r => '<button class="link-like" data-profit-product="'+escapeHtml(r.standard_goods_sn || '')+'"><b>'+escapeHtml(r.standard_goods_sn || '-')+'</b></button>'],
      ['成本覆盖', r => pct(r.cost_coverage_revenue_rate), 'num'],
      ['缺成本净成交', r => money(r.missing_cost_revenue_sar), 'num'],
      ['缺成本数量', r => num(r.missing_cost_quantity)+' 件', 'num'],
      ['完整批次', r => num(r.complete_batch_count), 'num'],
      ['忽略批次', r => num(r.ignored_batch_count), 'num'],
      ['最近导入', r => escapeHtml(String(r.last_cost_imported_at || '-').replace('T',' ').slice(0,19))]
    ], {limit:80}) : '<div class="empty">当前筛选范围成本覆盖正常，暂无缺口。</div>');
  document.querySelectorAll('[data-profit-product]').forEach(btn => btn.addEventListener('click', () => {
    state.product = btn.dataset.profitProduct || '';
    state.q = state.product;
    jumpToTab('products', {keepFilters:true});
    renderAll();
  }));
  bindProfitCalculator();
  bindChartTooltips();
}
function compactSkuKey(value){
  return String(value || '').normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]+/g, '');
}
function inventoryProductMatchesSale(productRow, saleRow){
  const sale = compactSkuKey(saleRow?.standard_goods_sn);
  if (!sale) return false;
  const keys = [
    productRow?.standard_goods_sn,
    ...(String(productRow?.standard_goods_sn_list || '').split('/')),
    ...(String(productRow?.raw_goods_sn_list || '').split('/'))
  ].map(compactSkuKey).filter(Boolean);
  return keys.includes(sale);
}
function inventoryProductVisible(row){
  const pq = productScopeQuery();
  const q = String(state.q || '').trim().toLowerCase();
  if (pq && !productQueryMatch(row, pq)) return false;
  if (q && !productQueryMatch(row, q) && !JSON.stringify(row).toLowerCase().includes(q)) return false;
  return true;
}
function inventoryScopeGrossSales(productRow, start, end){
  const rows = DATA.profit?.dailyStoreProducts || [];
  let quantity = 0;
  let revenue = 0;
  let orders = 0;
  const days = new Set();
  const stores = new Set();
  for (const r of rows) {
    const d = String(r.date || '').slice(0, 10);
    if (!d || d < start || d > end) continue;
    if (!storeMatchesScope(r)) continue;
    if (!inventoryProductMatchesSale(productRow, r)) continue;
    quantity += Number(r.quantity || 0);
    revenue += Number(r.gross_revenue_sar || 0);
    orders += Number(r.orders || 0);
    days.add(d);
    if (r.store_key) stores.add(String(r.store_key).toUpperCase());
  }
  return {quantity, revenue, orders, days:days.size, storeCount:stores.size};
}
function inventoryRowsWithScope(){
  const anchor = dataAnchorDate();
  const start7 = addDateDays(anchor, -6);
  const start30 = addDateDays(anchor, -29);
  return (DATA.inventoryDepletion?.products || [])
    .filter(inventoryProductVisible)
    .map(r => {
      const s7 = inventoryScopeGrossSales(r, start7, anchor);
      const s30 = inventoryScopeGrossSales(r, start30, anchor);
      const scopedDaily = 0.4 * (Number(s7.quantity || 0) / 7) + 0.6 * (Number(s30.quantity || 0) / 30);
      const onHand = inventoryOnHandQty(r);
      const incoming = Number(r.incoming_quantity || 0);
      const scopedDays = scopedDaily > 0 ? onHand / scopedDaily : null;
      const scopedDaysWithIncoming = scopedDaily > 0 ? (onHand + incoming) / scopedDaily : null;
      const scopeHasSales = Number(s30.quantity || 0) > 0 || Number(s7.quantity || 0) > 0;
      return {
        ...r,
        scoped_sold_7d:s7.quantity,
        scoped_sold_30d:s30.quantity,
        scoped_revenue_30d:s30.revenue,
        scoped_orders_30d:s30.orders,
        scoped_store_count:s30.storeCount,
        scoped_daily_sales:scopedDaily,
        scoped_days_of_supply_on_hand:scopedDays,
        scoped_days_of_supply_with_incoming:scopedDaysWithIncoming,
        scope_has_sales:scopeHasSales
      };
    })
    .filter(r => {
      if (storeFilterKind().type === 'all') return true;
      if (productScopeQuery() || state.q) return true;
      return r.scope_has_sales;
    });
}
function inventoryHasEt(row){
  return Boolean(row.has_et_inventory) || Number(row.et_estimated_available_qty||0) > 0 || Number(row.et_pending_process_qty||0) > 0 || Number(row.et_full_carton_qty||0) > 0;
}
function inventoryOnHandQty(row){
  return inventoryHasEt(row) ? Number(row.et_estimated_available_qty || 0) : Number(row.estimated_on_hand_quantity || 0);
}
function inventoryLooseQty(row){ return inventoryHasEt(row) ? Number(row.et_loose_sellable_qty || 0) : Number(row.estimated_on_hand_quantity || 0); }
function inventoryFullCartonQty(row){ return Number(row.et_full_carton_qty || 0); }
function inventoryPendingQty(row){ return inventoryHasEt(row) ? Number(row.et_pending_process_qty || 0) : 0; }
function inventorySourceText(row){ return inventoryHasEt(row) ? 'ET仓实盘' : '成本表估算'; }
function inventoryWarehouseText(row){
  if (!inventoryHasEt(row)) return '成本表批次';
  return [row.et_loose_warehouses, row.et_box_warehouses].filter(Boolean).join(' / ') || 'ET仓';
}
function inventoryRiskClass(row){
  const status = String(row.stock_status || '');
  const days = row.scoped_days_of_supply_on_hand == null ? Number(row.days_of_supply_on_hand ?? Infinity) : Number(row.scoped_days_of_supply_on_hand);
  const sold30 = Number(row.scoped_sold_30d ?? row.gross_sold_30d ?? 0);
  const onHand = inventoryOnHandQty(row);
  if (inventoryHasEt(row)) {
    if (onHand <= 0 && sold30 > 0) return 'high';
    if (Number.isFinite(days) && days <= 14) return 'high';
    if (Number.isFinite(days) && days <= 30) return 'mid';
    if (sold30 <= 0 && onHand > 0) return 'mid';
    if (inventoryLooseQty(row) <= 0 && inventoryFullCartonQty(row) > 0) return 'mid';
    return 'good';
  }
  if (/疑似缺货|已售罄|14天/.test(status) || days <= 14) return 'high';
  if (/在途|低动销|30天|库存偏慢/.test(status) || days <= 30) return 'mid';
  return 'good';
}
function inventoryAdvice(row){
  const onHand = inventoryOnHandQty(row);
  const incoming = Number(row.incoming_quantity || 0);
  const sold30 = Number(row.scoped_sold_30d ?? row.gross_sold_30d ?? 0);
  const days = row.scoped_days_of_supply_on_hand;
  const status = String(row.stock_status || '');
  if (inventoryHasEt(row)) {
    if (inventoryLooseQty(row) <= 0 && inventoryFullCartonQty(row) > 0) return '09散件仓缺货但01整箱仓有货，优先确认是否要拆箱上架或直接按箱发。';
    if (onHand <= 0 && incoming > 0) return 'ET当前无可售，成本表显示仍有在途；先盯到仓和展示库存，避免继续推流。';
    if (onHand <= 0) return 'ET实盘无可售库存；先核对是否在03/04/06或箱仓，再决定补货/下架。';
    if (inventoryPendingQty(row) > 0) return '有RTV/破损/待处理库存，先处理可恢复销售的货，再判断是否补货。';
    if (sold30 <= 0) return 'ET有库存但30天无销量：优先检查链接覆盖、价格、活动和评价，不建议盲目补货。';
    if (days != null && days <= 14) return '按ET实盘和当前速度，14天内可能卖完，优先准备补货或拆箱上架。';
    if (days != null && days <= 30) return '30天内可能卖完，关注采购、头程和01到09转仓节奏。';
    if (days != null && days > 120) return 'ET实盘库存去化偏慢，考虑活动清货或暂停补货。';
    return 'ET库存节奏正常，结合利润和链接表现决定是否加码。';
  }
  if (/成本表缺到仓批次/.test(status)) return '已有销售但成本表没有可扣减的到仓批次，先核实是否漏填到仓日期、头程费或历史批次。';
  if (status.includes('未发/待确认')) return '成本表有数量但缺发货/到仓信息，暂不计入库存；等发货或到仓后再纳入去化。';
  if (onHand <= 0 && incoming > 0) return '到仓前关注链接库存；到仓后优先补展示库存。';
  if (onHand <= 0) return '疑似已无到仓库存；先核实成本表是否漏批次，再判断是否补货。';
  if (sold30 <= 0) return '30天无销量：先看链接覆盖、价格和活动；不建议继续补货。';
  if (days != null && days <= 14) return '按当前速度 14 天内可能卖完，优先准备补货或提高到仓批次跟进。';
  if (days != null && days <= 30) return '30 天内可能卖完，关注采购与头程节奏。';
  if (days != null && days > 120) return '库存去化偏慢，考虑活动清货或暂停补货。';
  return '库存节奏正常，按链接表现和利润决定是否加码。';
}
function inventoryStatusTag(row){
  const cls = inventoryRiskClass(row);
  return '<span class="tag '+cls+'">'+escapeHtml(row.stock_status || '-')+'</span>';
}
function inventoryDaysText(v){
  if (v == null || !Number.isFinite(Number(v))) return '-';
  const n = Number(v);
  if (n > 999) return '999+ 天';
  return fmt.format(n) + ' 天';
}
function renderInventoryPage(){
  const rows = inventoryRowsWithScope();
  const anchor = dataAnchorDate();
  const totalOnHand = rows.reduce((s,r)=>s+inventoryOnHandQty(r),0);
  const totalIncoming = rows.reduce((s,r)=>s+Number(r.incoming_quantity||0),0);
  const totalNotShipped = rows.reduce((s,r)=>s+Number(r.not_shipped_quantity||0),0);
  const totalArrived = rows.reduce((s,r)=>s+Number(r.arrived_quantity||0),0);
  const totalEtLoose = rows.reduce((s,r)=>s+Number(r.et_loose_sellable_qty||0),0);
  const totalEtBox = rows.reduce((s,r)=>s+Number(r.et_full_carton_qty||0),0);
  const totalEtPending = rows.reduce((s,r)=>s+inventoryPendingQty(r),0);
  const etProductCount = rows.filter(inventoryHasEt).length;
  const sold30 = rows.reduce((s,r)=>s+Number(r.scoped_sold_30d||0),0);
  const daily = rows.reduce((s,r)=>s+Number(r.scoped_daily_sales||0),0);
  const urgent = rows.filter(r => inventoryRiskClass(r) === 'high').length;
  const slow = rows.filter(r => Number(r.estimated_on_hand_quantity||0) > 0 && Number(r.scoped_sold_30d||0) <= 0).length;
  const scopeText = storeScopeLabel() + (productScopeQuery() || state.q ? ' · 已按货号/关键词筛选' : '');
  $('inventoryTag').textContent = scopeText + ' · 截至 ' + anchor;
  $('inventoryOverview').innerHTML =
    '<div class="page-anchor-row"><button type="button" onclick="document.getElementById(\\'inventoryRiskCard\\')?.scrollIntoView({behavior:\\'smooth\\',block:\\'start\\'})">看补货/断货</button><button type="button" onclick="document.getElementById(\\'inventorySlowCard\\')?.scrollIntoView({behavior:\\'smooth\\',block:\\'start\\'})">看清货候选</button><button type="button" onclick="document.getElementById(\\'inventoryProductCard\\')?.scrollIntoView({behavior:\\'smooth\\',block:\\'start\\'})">看货号明细</button><button type="button" onclick="document.getElementById(\\'inventoryBatchFold\\')?.scrollIntoView({behavior:\\'smooth\\',block:\\'start\\'})">看批次/在途</button></div>'+
    '<div class="mission-grid">'+
      '<div class="mission-card good"><span>可承接库存</span><strong>'+escapeHtml(num(totalOnHand))+'</strong><p>ET 09散件 + 01整箱；这是今天最接近实盘的可售/可承接口径。</p></div>'+
      '<div class="mission-card warn"><span>待处理库存</span><strong>'+escapeHtml(num(totalEtPending))+'</strong><p>03 RTV / 04破损 / 06报废，不直接当可卖；先处理可回流部分。</p></div>'+
      '<div class="mission-card info"><span>在途 / 未发</span><strong>'+escapeHtml(num(totalIncoming))+'</strong><p>成本表有发货但缺到仓或头程费；未发 '+escapeHtml(num(totalNotShipped))+'。</p></div>'+
      '<div class="mission-card bad"><span>高风险货号</span><strong>'+escapeHtml(num(urgent))+'</strong><p>断货、14天内断货或实盘缺货；优先看补货/断货预警。</p></div>'+
    '</div>'+
    '<div class="store-flow">'+
      '<div class="store-verdict"><h3>先看结论</h3><p>有 ET 数据时，本页优先使用货代仓实盘库存：09散件仓和01整箱仓计入可售，03/04/06作为待处理/不可售提示；成本表继续用于在途、批次和成本解释。</p>'+
        '<div class="store-action-steps">'+
          '<div class="store-step"><b>09散件</b><p>买家订单主要从这里出库，是最核心可售库存。</p></div>'+
          '<div class="store-step"><b>01整箱</b><p>海运到仓后的整箱库存，可拆到09或个别按箱发。</p></div>'+
          '<div class="store-step"><b>03/04/06</b><p>RTV、破损、报废等待处理库存，不直接当作可卖库存。</p></div>'+
        '</div></div>'+
      '<div class="store-kpi-grid">'+
        '<div class="store-kpi"><span>ET可售库存</span><strong>'+num(totalOnHand)+'</strong><small>覆盖 '+num(etProductCount)+' 个货号；09 '+num(totalEtLoose)+' · 01 '+num(totalEtBox)+'</small></div>'+
        '<div class="store-kpi"><span>待处理仓</span><strong>'+num(totalEtPending)+'</strong><small>03 RTV / 04破损 / 06报废，不计入可售</small></div>'+
        '<div class="store-kpi"><span>成本表在途</span><strong>'+num(totalIncoming)+'</strong><small>有发货但缺到仓或头程费；未发 '+num(totalNotShipped)+'</small></div>'+
        '<div class="store-kpi"><span>近30天毛销量</span><strong>'+num(sold30)+'</strong><small>'+escapeHtml(scopeText)+' · 店铺筛选只影响销售速度</small></div>'+
        '<div class="store-kpi"><span>加权日销</span><strong>'+fmt.format(daily)+'</strong><small>7天40% + 30天60%</small></div>'+
        '<div class="store-kpi"><span>高风险货号</span><strong>'+num(urgent)+'</strong><small>断货/14天内断货/实盘缺货</small></div>'+
      '</div>'+
    '</div>'+
    '<div class="table-note">库存数优先来自 ET 货代仓实盘；店铺/分组筛选只改变“销售速度”和“去化天数”，不硬拆全局物理库存。</div>';
  const riskRows = rows
    .filter(r => inventoryRiskClass(r) === 'high' || Number(r.scoped_days_of_supply_on_hand ?? Infinity) <= 30 || Number(r.oversold_or_missing_batch_quantity || 0) > 0)
    .sort((a,b)=>(inventoryRiskClass(a)==='high'?-1:1) - (inventoryRiskClass(b)==='high'?-1:1) || Number(a.scoped_days_of_supply_on_hand ?? 99999)-Number(b.scoped_days_of_supply_on_hand ?? 99999))
    .slice(0,40);
  const slowRows = rows
    .filter(r => inventoryOnHandQty(r) > 0 && (Number(r.scoped_sold_30d||0) <= 0 || Number(r.scoped_days_of_supply_on_hand ?? 0) > 120))
    .sort((a,b)=>inventoryOnHandQty(b)-inventoryOnHandQty(a))
    .slice(0,40);
  const compactCols = [
    ['货号', r => '<button class="link-like" data-inventory-product="'+escapeHtml(r.standard_goods_sn || '')+'"><b>'+escapeHtml(r.standard_goods_sn || '-')+'</b></button><div class="muted">'+escapeHtml(r.goods_title || '').slice(0,60)+'</div>'],
    ['状态', r => inventoryStatusTag(r)+'<div class="muted">'+escapeHtml(inventoryAdvice(r)).slice(0,70)+'</div>'],
    ['可售/在途', r => num(inventoryOnHandQty(r))+' / '+num(r.incoming_quantity)+'<div class="muted">'+escapeHtml(inventorySourceText(r))+'</div>', 'num'],
    ['近7/30销量', r => num(r.scoped_sold_7d)+' / '+num(r.scoped_sold_30d), 'num'],
    ['预计可卖', r => inventoryDaysText(r.scoped_days_of_supply_on_hand), 'num']
  ];
  $('inventoryRiskList').innerHTML = riskRows.length ? table(riskRows, compactCols, {limit:40}) : '<div class="empty">当前筛选下没有明显断货或补货风险。</div>';
  $('inventorySlowList').innerHTML = slowRows.length ? table(slowRows, compactCols, {limit:40}) : '<div class="empty">当前筛选下没有明显库存沉淀货号。</div>';
  $('inventoryProductTable').innerHTML = table(rows, [
    ['货号', r => '<button class="link-like" data-inventory-product="'+escapeHtml(r.standard_goods_sn || '')+'"><b>'+escapeHtml(r.standard_goods_sn || '-')+'</b></button><div class="muted">'+escapeHtml(r.goods_title || '').slice(0,80)+'</div>'],
    ['库存状态', r => inventoryStatusTag(r)+'<div class="muted">'+escapeHtml(inventorySourceText(r))+' · '+escapeHtml(inventoryWarehouseText(r)).slice(0,70)+'</div>'],
    ['ET实盘可售', r => inventoryHasEt(r) ? (num(r.et_estimated_available_qty)+'<div class="muted">09 '+num(r.et_loose_sellable_qty)+' / 01 '+num(r.et_full_carton_qty)+'</div>') : '<span class="muted">暂无ET</span>', 'num'],
    ['待处理仓', r => inventoryHasEt(r) ? (num(r.et_pending_process_qty)+'<div class="muted">03 '+num(r.et_rtv_qty)+' / 04 '+num(r.et_damaged_qty)+' / 06 '+num(r.et_scrap_qty)+'</div>') : '<span class="muted">-</span>', 'num'],
    ['成本表到仓/估算', r => num(r.arrived_quantity)+' / '+num(r.estimated_on_hand_quantity)+'<div class="muted">去化 '+pct(r.depletion_rate)+'</div>', 'num'],
    ['在途 / 未发', r => num(r.incoming_quantity)+' / '+num(r.not_shipped_quantity), 'num'],
    ['累计毛销 / 净销', r => num(r.gross_sold_quantity)+' / '+num(r.net_sold_quantity)+'<div class="muted">退货反转 '+num(r.reversal_quantity)+'</div>', 'num'],
    ['近7/30毛销量', r => num(r.scoped_sold_7d)+' / '+num(r.scoped_sold_30d)+'<div class="muted">当前范围 '+num(r.scoped_store_count)+' 店</div>', 'num'],
    ['日销 / 去化天数', r => fmt.format(r.scoped_daily_sales)+' / '+inventoryDaysText(r.scoped_days_of_supply_on_hand)+'<div class="muted">含在途 '+inventoryDaysText(r.scoped_days_of_supply_with_incoming)+'</div>', 'num'],
    ['到仓/最近销售', r => escapeHtml(r.latest_arrived_date || '-')+'<div class="muted">最近销售 '+escapeHtml(r.last_sale_date || '-')+'</div>'],
    ['建议', r => escapeHtml(inventoryAdvice(r))]
  ], {limit:120});
  const batchRows = (DATA.inventoryDepletion?.batches || [])
    .filter(r => inventoryProductVisible({...r, goods_title:r.goods_title || '', standard_goods_sn_list:r.standard_goods_sn}))
    .sort((a,b)=>String(a.standard_goods_sn||'').localeCompare(String(b.standard_goods_sn||'')) || Number(a.batch_sort||0)-Number(b.batch_sort||0));
  $('inventoryBatchTable').innerHTML = sectionTitleHtml('批次生命周期', '按先进先出估算每个到仓批次剩余数量；在途/未发批次保留原数量。')+
    table(batchRows, [
      ['货号', r => '<b>'+escapeHtml(r.standard_goods_sn || '-')+'</b><div class="muted">'+escapeHtml(r.goods_title || '').slice(0,60)+'</div>'],
      ['批次/状态', r => '<span class="mono">'+escapeHtml(r.batch_no || '-')+'</span><br><span class="tag '+(r.batch_status==='已到仓'?'good':r.batch_status==='在途/待录头程'?'mid':'info')+'">'+escapeHtml(r.batch_status || '-')+'</span>'],
      ['发货/到仓', r => escapeHtml(r.shipped_date || '-')+'<br><span class="muted">'+escapeHtml(r.arrived_date || '-')+'</span>'],
      ['发货数/剩余', r => num(r.shipped_quantity)+' / <b>'+num(r.estimated_remaining_quantity)+'</b>', 'num'],
      ['货款/头程', r => cny(r.goods_cost_amount)+'<br><span class="muted">'+cny(r.first_leg_freight_amount)+'</span>', 'num'],
      ['单件成本', r => r.unit_cost_sar ? money(r.unit_cost_sar) : '<span class="muted">待成本</span>', 'num'],
      ['来源', r => '<span class="muted">'+escapeHtml(r.source_file || '')+'</span><div class="muted">第 '+num(r.source_row_no)+' 行</div>']
    ], {limit:200});
  document.querySelectorAll('[data-inventory-product]').forEach(btn => btn.addEventListener('click', () => {
    state.product = btn.dataset.inventoryProduct || '';
    state.q = state.product;
    jumpToTab('products', {keepFilters:true});
    renderAll();
  }));
}
function actionCard(a){
  const rec = actionRecord(a);
  const st = actionStatus(a);
  const key = encodeURIComponent(actionKey(a));
  const evidenceHtml = actionEvidenceHtml(a);
  const mergedSignalsHtml = mergedActionSignalsHtml(a);
  const mergeTag = Number(a._mergedCount || 0) > 1 ? '<span class="tag info">合并 '+num(a._mergedCount)+' 条</span>' : '';
  const reasonHtml = a.action_domain === 'link'
    ? storeActionReasonHtml(a, DATA.storeLinks || DATA.links || [])
    : '<span class="decision-note">'+escapeHtml(a.reason || '').slice(0,160)+'</span>';
  return '<article class="action-card v1-action">'+
    '<div class="action-main">'+
      '<div class="row1"><span class="domain">'+domainName(a.action_domain)+'<span class="status-badge"><i class="status-dot '+st+'"></i>'+statusLabel(st)+'</span></span><span class="score">'+num(a.score)+'</span></div>'+
      '<h4>'+escapeHtml(a.category || '-')+' · '+escapeHtml(a.store_key || '-')+'</h4>'+
      '<p><b>'+escapeHtml(a.standard_goods_sn || a.title || '-')+'</b> '+(a.skc ? '<span class="mono">'+escapeHtml(a.skc)+'</span> '+copyButton(a.skc, '复制SKC') : '')+'</p>'+
      '<div style="margin-top:10px">'+priorityTag(a.priority)+mergeTag+'</div>'+
    '</div>'+
    '<div class="action-evidence">'+
      (mergedSignalsHtml || ('<p class="muted">'+reasonHtml+'</p><div class="muted">'+evidenceHtml+'</div>'))+
      '<p class="next">'+escapeHtml(a.next_step || '')+'</p>'+
    '</div>'+
    '<div class="action-controls">'+
      '<div class="command-actions">'+
        '<button class="status-btn" data-action-copy-command="'+key+'">复制处理指令</button>'+
        '<button class="status-btn" data-action-focus-target="store" data-action-key="'+key+'">看店铺</button>'+
        '<button class="status-btn" data-action-focus-target="product" data-action-key="'+key+'">看货号</button>'+
        '<button class="status-btn" data-action-focus-target="link" data-action-key="'+key+'">看SKC</button>'+
      '</div>'+
      '<div class="status-actions">'+
        '<button class="status-btn '+(st === 'done' ? 'active' : '')+'" data-action-key="'+key+'" data-action-status="done">已处理</button>'+
        '<button class="status-btn '+(st === 'review' ? 'active' : '')+'" data-action-key="'+key+'" data-action-status="review">待复查</button>'+
        '<button class="status-btn '+(st === 'ignored' ? 'active' : '')+'" data-action-key="'+key+'" data-action-status="ignored">忽略</button>'+
        '<button class="status-btn '+(st === 'open' ? 'active' : '')+'" data-action-key="'+key+'" data-action-status="open">未处理</button>'+
      '</div>'+
      ((rec.owner || rec.note || rec.updatedBy) ? '<div class="meta-line">负责人：'+escapeHtml(rec.owner || '-')+'；备注：'+escapeHtml(rec.note || '-')+(rec.updatedBy ? '；最近操作：'+escapeHtml(rec.updatedBy) : '')+'</div>' : '')+
      '<div class="action-meta">'+
        '<input name="action-owner" aria-label="负责人" placeholder="负责人" value="'+escapeHtml(rec.owner || '')+'" data-action-owner="'+key+'" />'+
        '<input name="action-note" aria-label="处理备注" placeholder="备注 / 复查时间" value="'+escapeHtml(rec.note || '')+'" data-action-note="'+key+'" />'+
        '<button class="status-btn meta-save" data-action-save-meta="'+key+'">保存</button>'+
      '</div>'+
    '</div>'+
  '</article>';
}
function currentActions(){
  return mergeActionsBySkuDomain((DATA.actions || []).filter(includes)).filter(statusMatchAction);
}
function findActionByKey(key){
  return currentActions().find(a => actionKey(a) === key) || (DATA.actions || []).find(a => actionKey(a) === key);
}
function actionListText(rows = currentActions()){
  const header = [
    'SHEIN BI 当前筛选动作清单',
    '生成时间：' + new Date().toLocaleString('zh-CN'),
    '视图链接：' + currentViewUrl(),
    '筛选：店铺=' + (state.store || '全部') + '；搜索=' + (state.q || '无') + '；业务域=' + (state.domain || '全部') + '；风险=' + (state.risk || '全部') + '；状态=' + (state.status || '全部') + '；聚焦=' + (state.focus || 'all'),
    '数量：' + num(rows.length) + ' 条',
    ''
  ];
  const body = rows.slice(0, 80).map((a, i) => {
    const rec = actionRecord(a);
    return [
      (i + 1) + '. ' + (a.store_key || '-') + '｜' + domainName(a.action_domain) + '｜' + (a.category || a.title || '-'),
      '货号：' + (a.standard_goods_sn || '-') + '｜SKC：' + (a.skc || '-'),
      '分数/优先级：' + num(a.score) + ' / ' + (a.priority || '-'),
      '原因：' + (a.reason || '-'),
      '证据：' + (actionEvidenceText(a) || '-'),
      '下一步：' + (a.next_step || '-'),
      '状态：' + statusLabel(rec.status || 'open') + '｜负责人：' + (rec.owner || '-') + '｜备注：' + (rec.note || '-')
    ].join('\\n');
  });
  return header.concat(body).join('\\n\\n');
}
function csvCell(value){
  const s = String(value ?? '').replace(/\\r?\\n/g, ' ').replace(/"/g, '""');
  return '"' + s + '"';
}
function actionListCsv(rows = currentActions()){
  const cols = [
    ['date', a => a.date || ''],
    ['store_key', a => a.store_key || ''],
    ['domain', a => domainName(a.action_domain)],
    ['category', a => a.category || a.title || ''],
    ['priority', a => a.priority || ''],
    ['score', a => a.score ?? ''],
    ['standard_goods_sn', a => a.standard_goods_sn || ''],
    ['skc', a => a.skc || ''],
    ['reason', a => a.reason || ''],
    ['evidence', a => actionEvidenceText(a) || ''],
    ['next_step', a => a.next_step || ''],
    ['status', a => statusLabel(actionRecord(a).status || 'open')],
    ['owner', a => actionRecord(a).owner || ''],
    ['note', a => actionRecord(a).note || ''],
    ['view_url', () => currentViewUrl()]
  ];
  return [
    cols.map(c => csvCell(c[0])).join(','),
    ...rows.map(a => cols.map(c => csvCell(c[1](a))).join(','))
  ].join('\\r\\n');
}
function isLoopbackHost(host){
  const h = String(host || '').toLowerCase();
  return !h || h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}
function teamAccessReadiness(){
  const protocol = window.location.protocol;
  const host = window.location.hostname || '';
  const port = window.location.port || (protocol === 'https:' ? '443' : protocol === 'http:' ? '80' : '');
  const isFile = protocol === 'file:';
  const isService = protocol === 'http:' || protocol === 'https:';
  const isLoopback = isLoopbackHost(host);
  const lanPreview = Boolean(serviceHealth.lanMode) || (isService && !isLoopback);
  const sharedActionState = actionStateStore.mode === 'service' && actionStateStore.ready && !actionStateStore.error && serviceHealth.writableActionState;
  const serviceReady = isService && serviceHealth.checked && serviceHealth.ok;
  const shareLinksReady = true;
  const exportReady = true;
  const firstRunReady = Boolean(DATA.firstRunCheck?.exists);
  const score =
    (isService ? 18 : 0) +
    (serviceReady ? 18 : 0) +
    (sharedActionState ? 22 : 0) +
    (shareLinksReady ? 14 : 0) +
    (exportReady ? 14 : 0) +
    (firstRunReady ? 14 : 0);
  const title = lanPreview ? '局域网预览中' : isService ? '本机服务模式' : '本机文件模式';
  const level = lanPreview ? 'mid' : isService ? 'good' : 'mid';
  const scope = serviceHealth.readOnly
    ? '当前是局域网只读预览，适合先给同事看页面；不会写入共享动作状态。'
    : serviceHealth.authRequired
      ? '当前是局域网登录协作模式：同事登录后可标记处理、写备注，并自动记录操作者。'
    : lanPreview
      ? '当前地址可能已能被同一局域网访问；但还没有登录权限和正式账号体系，不建议长期开放。'
    : isService
      ? '当前只绑定本机访问，适合你自己使用和验证，不会暴露给同事或公网。'
      : '当前是直接打开 HTML 文件，适合只读查看；动作状态只保存在当前浏览器。';
  const currentUrl = isService ? window.location.origin + '/' : 'file:// 本机门户文件';
  const rows = [
    ['当前访问', currentUrl],
    ['访问范围', lanPreview ? '局域网预览 / 需谨慎' : isService ? '仅本机 127.0.0.1' : '仅当前电脑文件'],
    ['网页服务', serviceReady ? '已连接' : isService ? ('未确认：' + (serviceHealth.error || '等待检测')) : '未使用'],
    ['登录用户', serviceHealth.user ? ((serviceHealth.user.displayName || serviceHealth.user.username || '-') + ' / ' + (serviceHealth.user.role || '-')) : serviceHealth.authRequired ? '需要登录' : '-'],
    ['协作状态', serviceHealth.readOnly ? '局域网只读，不写共享状态' : sharedActionState ? '可写入共享状态文件' : '仅当前浏览器本地状态'],
    ['状态文件', sharedActionState ? (serviceHealth.stateFile || ACTION_STATE_SERVICE_PATH) : '-'],
    ['深链接', '已支持复制当前视图，换成局域网/服务器域名后参数可复用'],
    ['导出/分工', serviceHealth.readOnly ? '局域网试用只读；仍可导出/复制，不写回共享状态' : '已支持动作清单 CSV、JSON、负责人、备注、复查状态'],
    ['安全边界', serviceHealth.readOnly ? '只开放局域网只读预览，未开放公网' : serviceHealth.authRequired ? '局域网内需要账号密码；未开放公网' : lanPreview ? '未加账号密码，暂不建议给团队长期使用' : '未开放局域网/公网，安全边界清晰']
  ];
  const ready = [
    '本机经营门户已经可用',
    serviceHealth.readOnly ? '局域网同事只能只读预览；动作状态不会写回共享文件' : serviceHealth.authRequired ? '登录后动作处理状态、负责人、备注会写入共享状态并留审计' : '动作处理状态、负责人、备注可以保存',
    '当前视图可复制为深链接',
    '动作池可以复制清单和导出 CSV',
    '系统状态页能看自动任务、体检、验收和恢复状态'
  ];
  const missing = [
    '正式团队账号 / 密码或飞书登录',
    '局域网或服务器固定访问地址',
    '多人同时编辑的冲突控制和审计日志',
    '动作状态写入 PostgreSQL，而不是只写本机 JSON',
    'HTTPS / 服务器备份 / 权限分级'
  ];
  const next = lanPreview
    ? serviceHealth.authRequired ? '当前适合给同事局域网协作试用；长期使用前再固定地址、完善权限分级和备份。' : '当前适合临时给同事只读试用；如果要长期使用，下一步再补简单登录密码、固定地址和权限。'
    : '当前先保持本机安全模式；等你确认门户定版后，再切团队访问方案。';
  return {title, level, score: Math.min(100, score), scope, rows, ready, missing, next, isService, sharedActionState, lanPreview};
}
function teamAccessSummaryText(){
  const r = teamAccessReadiness();
  return [
    'SHEIN BI 团队访问准备度',
    '生成时间：' + localTimeText(),
    '',
    '【当前结论】',
    '- 模式：' + r.title,
    '- 准备度：' + num(r.score) + '%',
    '- 范围：' + r.scope,
    '- 下一步：' + r.next,
    '',
    '【已具备】',
    ...r.ready.map(x => '- ' + x),
    '',
    '【团队版还缺】',
    ...r.missing.map(x => '- ' + x),
    '',
    '【当前细节】',
    ...r.rows.map(([k,v]) => '- ' + k + '：' + v)
  ].join('\\n');
}
function openApiReconciliationRows(){
  return (DATA.openapiReconciliation || [])
    .slice()
    .sort((a,b)=>String(b.date || '').localeCompare(String(a.date || '')) || String(a.store_key || '').localeCompare(String(b.store_key || '')));
}
function openApiStatusLabel(status){
  if (status === 'matched') return '一致';
  if (status === 'warning') return '有差异';
  if (status === 'missing_browser') return '缺浏览器数据';
  if (status === 'missing_api') return '缺 API 数据';
  return status || '-';
}
function openApiStatusClass(status){
  if (status === 'matched') return 'good';
  if (status === 'warning') return 'mid';
  return 'high';
}
function openApiReconciliationSummary(){
  const rows = openApiReconciliationRows();
  const matched = rows.filter(r => r.status === 'matched').length;
  const warning = rows.filter(r => r.status && r.status !== 'matched').length;
  const latest = rows[0] || null;
  const totalDelta = rows.reduce((sum,r)=>sum+Math.abs(Number(r.sales_sar_delta || 0)),0);
  const latestGeneratedAt = rows.map(r => r.generated_at).filter(Boolean).sort().at(-1) || '';
  return {rows, matched, warning, latest, totalDelta, latestGeneratedAt};
}
function renderOpenApiReconciliationPanel(){
  const s = openApiReconciliationSummary();
  if (!s.rows.length) return '';
  const allMatched = s.warning === 0;
  const latest = s.latest || {};
  const titleTag = allMatched ? '试点一致' : '需复核';
  const tagClass = allMatched ? 'good' : 'mid';
  const rows = s.rows.slice(0, 12);
  return '<div class="card soft" style="margin-top:12px">' +
    '<div class="card-h"><div><h3>SHEIN OpenAPI 试点对账</h3><div class="sub">只展示 API 并行表与原浏览器抓取的对比；当前不会覆盖正式 BI 销售表。</div></div><span class="tag '+tagClass+'">'+escapeHtml(titleTag)+'</span></div>' +
    '<div class="progress-grid" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr))">' +
      '<div class="progress-card"><span>最新店铺/日期</span><strong>'+escapeHtml((latest.store_key || '-') + ' ' + (latest.date || '-'))+'</strong><small>HL 单店试点</small></div>' +
      '<div class="progress-card"><span>一致天数</span><strong>'+num(s.matched)+'</strong><small>共 '+num(s.rows.length)+' 条对账</small></div>' +
      '<div class="progress-card"><span>差异天数</span><strong>'+num(s.warning)+'</strong><small>销售差异合计 '+money(s.totalDelta)+'</small></div>' +
      '<div class="progress-card"><span>最近入仓</span><strong>'+escapeHtml(s.latestGeneratedAt ? String(s.latestGeneratedAt).slice(0,10) : '-')+'</strong><small>'+escapeHtml(s.latestGeneratedAt ? localTimeText(new Date(s.latestGeneratedAt)) : '-')+'</small></div>' +
    '</div>' +
    table(rows, [
      ['日期/店铺', r=>'<b>'+escapeHtml(r.date || '-')+'</b><br><span class="tag info">'+escapeHtml(r.store_key || '-')+'</span>'],
      ['状态', r=>'<span class="tag '+openApiStatusClass(r.status)+'">'+escapeHtml(openApiStatusLabel(r.status))+'</span>'],
      ['浏览器销售', r=>money(r.browser_sales_sar), 'num'],
      ['API 销售', r=>money(r.api_sales_sar), 'num'],
      ['销售差异', r=>money(r.sales_sar_delta), 'num'],
      ['订单差异', r=>'订单 '+num(r.order_count_delta)+'<br><span class="muted">浏览器独有 '+num(r.browser_only_order_count)+' / API 独有 '+num(r.api_only_order_count)+'</span>', 'num'],
      ['文件', r=>'<span class="mono">'+escapeHtml(r.api_source_file || '-')+'</span>']
    ], {limit:false}) +
    '<p class="muted" style="margin:10px 0 0">下一步等销量/SFS 等权限全部审批后，再把更多业务域也接入 API；通过多日 matched 后才切换正式数据源。</p>' +
  '</div>';
}
function systemStatusSummaryText(){
  const audit = DATA.audit || {};
  const pipeline = DATA.pipeline || {};
  const latestLog = pipeline.latestLog || {};
  const recentLogs = Array.isArray(pipeline.recentLogs) ? pipeline.recentLogs : [];
  const task = pipeline.task || {};
  const stability = pipelineStabilitySummary(recentLogs, task, latestLog);
  const firstRun = automationFirstRunSummary(task, latestLog);
  const firstRunCheck = DATA.firstRunCheck || {};
  const firstRunCheckStatus = firstRunCheck.status === 'error' ? '需处理' : firstRunCheck.status === 'warning' ? '有提醒' : firstRunCheck.status === 'ok' ? '通过' : '-';
  const actionSummary = actionStateSummary();
  const teamAccess = teamAccessReadiness();
  const openapi = openApiReconciliationSummary();
  const warningMessages = [
    ...(Array.isArray(DATA.warnings) ? DATA.warnings : []),
    ...(Array.isArray(audit.warningMessages) ? audit.warningMessages : [])
  ].filter(Boolean);
  const errorMessages = Array.isArray(audit.errorMessages) ? audit.errorMessages.filter(Boolean) : [];
  const lines = [
    'SHEIN BI 系统巡检摘要',
    '生成时间：' + localTimeText(),
    '门户读取：' + localTimeText(portalDataLastReadAt),
    '',
    '【数据口径】',
    '- 销售日：' + (DATA.dates?.salesDate || '-'),
    '- 业务日：' + (DATA.dates?.businessDate || '-'),
    '- 链接日：' + (DATA.dates?.linkDate || '-'),
    '- 体检：' + (audit.ok ? '通过' : '需检查') + '；提醒 ' + num(audit.warnings || 0) + '；错误 ' + num(audit.errors || 0),
    '',
    '【自动任务】',
    '- 任务：' + (task.TaskName || 'SHEIN-BI-Daily-Pipeline-0700'),
    '- 状态：' + (task.State || '-'),
    '- 下次运行：' + (task.NextRunTime || '-'),
    '- 上次运行：' + taskLastRunText(task),
    '- 上次结果：' + taskResultText(task),
    '- 首跑判断：' + firstRun.title + '；' + (firstRun.detail || '-'),
    '',
    '【首跑验收报告】',
    '- 报告文件：' + (firstRunCheck.exists ? (firstRunCheck.file || '-') : '未生成'),
    '- 报告结论：' + firstRunCheckStatus + '；提醒 ' + num(firstRunCheck.warnings || 0) + '；错误 ' + num(firstRunCheck.errors || 0),
    '- 报告更新时间：' + (firstRunCheck.updatedAt ? localTimeText(new Date(firstRunCheck.updatedAt)) : '-'),
    '',
    '【最近流水线】',
    '- 最新日志：' + (latestLog.file || '-'),
    '- 流水线状态：' + pipelineStatusLabel(latestLog.status),
    '- 日志结束：' + (latestLog.endedAt || '-'),
    '- 最近 8 次成功率：' + num(stability.successRate) + '%；成功 ' + num(stability.success) + ' / 失败 ' + num(stability.failed) + ' / 未完成 ' + num(stability.incomplete),
    '- WARN 合计：' + num(stability.warningTotal),
    '',
    '【协作动作】',
    '- 已追踪：' + num(actionSummary.counts.tracked),
    '- 已处理：' + num(actionSummary.counts.done) + '；待复查：' + num(actionSummary.counts.review) + '；已忽略：' + num(actionSummary.counts.ignored),
    '- 有负责人：' + num(actionSummary.counts.withOwner) + '；有备注：' + num(actionSummary.counts.withNote),
    '',
    '【团队访问准备度】',
    '- 模式：' + teamAccess.title,
    '- 准备度：' + num(teamAccess.score) + '%',
    '- 范围：' + teamAccess.scope,
    '- 下一步：' + teamAccess.next
  ];
  if (openapi.rows.length) {
    const latest = openapi.latest || {};
    lines.push(
      '',
      '【SHEIN OpenAPI 试点】',
      '- 最新：' + (latest.store_key || '-') + ' ' + (latest.date || '-') + '，' + openApiStatusLabel(latest.status),
      '- 一致天数：' + num(openapi.matched) + ' / ' + num(openapi.rows.length),
      '- 差异天数：' + num(openapi.warning),
      '- 最新入仓：' + (openapi.latestGeneratedAt ? localTimeText(new Date(openapi.latestGeneratedAt)) : '-')
    );
  }
  if (warningMessages.length) {
    lines.push('', '【提醒】');
    warningMessages.slice(0, 8).forEach((x, i) => lines.push('- ' + (i + 1) + '. ' + x));
  }
  if (errorMessages.length) {
    lines.push('', '【错误】');
    errorMessages.slice(0, 8).forEach((x, i) => lines.push('- ' + (i + 1) + '. ' + x));
  }
  return lines.join('\\n');
}
function filteredActionKeys(rows = currentActions()){
  return rows.map(a => actionKey(a)).filter(Boolean);
}
function buildBatchItems(rows, patchBuilder){
  const now = new Date().toISOString();
  return rows.map(a => {
    const key = actionKey(a);
    const patch = typeof patchBuilder === 'function' ? patchBuilder(a) : patchBuilder;
    return {key, ...actionPatchItem(key, patch, now)};
  });
}
function confirmBatch(message, count){
  return window.confirm(message + '\\n\\n当前筛选动作：' + count + ' 条。\\n只会修改当前筛选结果，不会操作 SHEIN 后台。');
}
function renderActions(){
  const actions = currentActions();
  const actionEmptyNote = !actions.length && (DATA.actions || []).length
    ? '<div class="warning-panel inline"><h3>当前筛选下没有动作，不是动作池丢失</h3><ul><li>底库动作池仍有 '+num((DATA.actions || []).length)+' 条精选动作。</li><li>请检查顶部店铺/货号/搜索，以及动作池里的业务域、风险、处理状态和聚焦筛选；点“清空筛选”可恢复。</li></ul></div>'
    : '';
  $('topActions').innerHTML = actionEmptyNote + (actions.slice(0, 8).map(actionCard).join('') || '<div class="empty">没有匹配动作</div>');
  const statusCounts = actions.reduce((acc, a) => {
    const st = actionStatus(a);
    acc[st] = (acc[st] || 0) + 1;
    return acc;
  }, {open: 0, done: 0, review: 0, ignored: 0});
  const closed = Number(statusCounts.done || 0) + Number(statusCounts.ignored || 0);
  const total = actions.length;
  const progress = total ? Math.round(closed / total * 100) : 0;
  const domainRows = Object.entries(actions.reduce((acc,a)=>{
    const k = a.action_domain || 'other';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {})).map(([domain,count]) => ({domain, count})).sort((a,b)=>b.count-a.count);
  const storeRows = Object.entries(actions.reduce((acc,a)=>{
    const k = a.store_key || '-';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {})).map(([store,count]) => ({store, count})).sort((a,b)=>b.count-a.count).slice(0, 10);
  const highCount = actions.filter(a => String(a.priority || '').includes('高') || riskLevel(a.score) === 'high').length;
  $('actionBulkPanel').innerHTML =
    '<div class="store-flow">'+
      '<div class="store-verdict"><h3>今日动作池怎么用</h3><p>这里是精选实操清单，不是异常全集。先用顶部全局筛选或动作池专用筛选缩小范围，再分派负责人或标记复查；所有操作只写本地协作状态，不会改 SHEIN 后台。</p>'+
        '<div class="store-action-steps">'+
          '<div class="store-step"><b>1 先筛选</b><p>顶部先按店铺、货号、SKC 缩小范围；动作池内再按业务域、风险或处理状态细分。</p></div>'+
          '<div class="store-step"><b>2 再处理</b><p>优先看高分、高优先级、重复弱链接和库存售后集中项。</p></div>'+
          '<div class="store-step"><b>3 记复查</b><p>处理后标记已处理/待复查，首页会生成复查队列。</p></div>'+
        '</div>'+
      '</div>'+
      '<div class="store-kpi-grid">'+
        '<div class="store-kpi"><span>当前筛选</span><strong>'+num(total)+'</strong><small>动作条数</small></div>'+
        '<div class="store-kpi"><span>高优先级</span><strong>'+num(highCount)+'</strong><small>先处理</small></div>'+
        '<div class="store-kpi"><span>未处理</span><strong>'+num(statusCounts.open)+'</strong><small>待分派</small></div>'+
        '<div class="store-kpi"><span>待复查</span><strong>'+num(statusCounts.review)+'</strong><small>看效果</small></div>'+
        '<div class="store-kpi"><span>已处理</span><strong>'+num(statusCounts.done)+'</strong><small>已闭环</small></div>'+
        '<div class="store-kpi"><span>已忽略</span><strong>'+num(statusCounts.ignored)+'</strong><small>暂不做</small></div>'+
      '</div>'+
    '</div>'+
    '<div class="split" style="margin-top:14px">'+
      '<div>'+sectionTitleHtml('按业务域拆分', '用于判断今天主要是在修链接、库存、售后、质量还是履约。')+table(domainRows, [
        ['业务域', r => '<span class="tag info">'+domainName(r.domain)+'</span>'],
        ['数量', r => num(r.count), 'num']
      ])+'</div>'+
      '<div>'+sectionTitleHtml('动作最多店铺', '用于快速锁定今天最需要盯的店。')+table(storeRows, [
        ['店铺', r => '<b>'+escapeHtml(r.store)+'</b>'],
        ['数量', r => num(r.count), 'num']
      ])+'</div>'+
    '</div>'+
    '<div class="bulk-panel" style="margin-top:14px">'+
      '<div class="row1"><strong>批量分派当前筛选</strong><span class="tag info">'+num(total)+' 条</span></div>'+
      '<div class="bulk-hint">批量操作前建议先用顶部筛到单店/单货号，再用本页业务域/风险/状态细分，避免一次处理太多。</div>'+
      '<div class="bulk-row">'+
        '<input id="bulkOwner" aria-label="批量负责人" placeholder="负责人，例如：小王" />'+
        '<input id="bulkNote" aria-label="批量备注" placeholder="批量备注，会追加到现有备注后面" />'+
        '<button class="status-btn" id="bulkAssignActions">分配当前筛选</button>'+
      '</div>'+
      '<div class="status-actions">'+
        '<button class="status-btn" id="bulkReviewActions">当前筛选标为待复查</button>'+
        '<button class="status-btn" id="bulkDoneActions">当前筛选标为已处理</button>'+
        '<button class="status-btn" id="bulkOpenActions">恢复当前筛选未处理</button>'+
        '<button class="status-btn" id="bulkClearActions">清空当前筛选协作状态</button>'+
      '</div>'+
    '</div>';
  $('actionProgress').innerHTML =
    '<div class="progress-grid">'+
      '<div class="progress-card"><span>当前筛选处理进度</span><strong>'+progress+'%</strong><div class="bar"><i style="width:'+progress+'%"></i></div></div>'+
      '<div class="progress-card"><span>未处理</span><strong>'+num(statusCounts.open)+'</strong></div>'+
      '<div class="progress-card"><span>待复查</span><strong>'+num(statusCounts.review)+'</strong></div>'+
      '<div class="progress-card"><span>已处理</span><strong>'+num(statusCounts.done)+'</strong></div>'+
      '<div class="progress-card"><span>已忽略</span><strong>'+num(statusCounts.ignored)+'</strong></div>'+
    '</div>';
  $('actionsList').innerHTML =
    sectionTitleHtml('动作明细', '每张卡只回答：哪个店/货号/SKC、为什么、证据、下一步。', num(actions.length)+' 条')+
    actionEmptyNote+
    (actions.map(actionCard).join('') || '<div class="empty">没有匹配动作</div>');
}
function renderSystem(){
  const audit = DATA.audit || {};
  const pipeline = DATA.pipeline || {};
  const latestLog = pipeline.latestLog || {};
  const recentLogs = Array.isArray(pipeline.recentLogs) ? pipeline.recentLogs : [];
  const task = pipeline.task || {};
  const stability = pipelineStabilitySummary(recentLogs, task, latestLog);
  const stabilityTagClass = stability.level === 'good' ? 'good' : stability.level === 'bad' ? 'high' : 'mid';
  const firstRun = automationFirstRunSummary(task, latestLog);
  const firstRunTagClass = firstRun.level === 'good' ? 'good' : firstRun.level === 'bad' ? 'high' : 'mid';
  const checkRecovery = DATA.firstRunCheck?.recovery || {};
  const checkDryRun = DATA.firstRunCheck?.scheduledDryRun || {};
  const checkScheduledLog = DATA.firstRunCheck?.scheduledRunLog || {};
  const checkLatestLog = DATA.firstRunCheck?.latestLog || {};
  const checkLatestRelation = DATA.firstRunCheck?.latestLogRelation || {};
  const teamAccess = teamAccessReadiness();
  const teamAccessTagClass = teamAccess.level === 'good' ? 'good' : teamAccess.level === 'high' ? 'high' : 'mid';
  const healthRows = [
    ['销售日', DATA.dates?.salesDate || '-'],
    ['业务日', DATA.dates?.businessDate || '-'],
    ['链接日', DATA.dates?.linkDate || '-'],
    ['体检文件', audit.file || '-'],
    ['体检结果', audit.ok ? '通过' : '需检查'],
    ['提醒/错误', (audit.warnings || 0) + ' / ' + (audit.errors || 0)],
    ['晨报文件', DATA.briefing?.exists ? DATA.briefing.file : '未生成'],
    ['晨报更新时间', DATA.briefing?.updatedAt ? new Date(DATA.briefing.updatedAt).toLocaleString('zh-CN') : '-'],
    ['首跑验收报告', DATA.firstRunCheck?.exists ? DATA.firstRunCheck.file : '未生成'],
    ['验收报告结论', DATA.firstRunCheck?.exists ? ((DATA.firstRunCheck.status === 'error' ? '需处理' : DATA.firstRunCheck.status === 'warning' ? '有提醒' : '通过') + '；提醒 ' + num(DATA.firstRunCheck.warnings || 0) + '；错误 ' + num(DATA.firstRunCheck.errors || 0)) : '-'],
    ['恢复状态', checkRecovery.title ? (checkRecovery.title + '；' + (checkRecovery.next || '-')) : '-'],
    ['入口 dry-run', checkDryRun.ok ? ('通过 / ' + [checkDryRun.salesDate, checkDryRun.linkDate, checkDryRun.businessDate].filter(Boolean).join(' / ')) : (checkDryRun.error || '-')],
    ['正式任务日志', checkScheduledLog.file ? (checkScheduledLog.file + ' / ' + pipelineStatusLabel(checkScheduledLog.status) + (checkScheduledLog.taskDeltaText ? ' / ' + checkScheduledLog.taskDeltaText : '')) : '-'],
    ['最新流水线关系', checkLatestLog.file ? (checkLatestLog.file + ' / ' + (checkLatestRelation.text || '-')) : '-']
  ];
  const pipelineRows = [
    ['计划任务', task.exists ? (task.TaskName || 'SHEIN-BI-Daily-Pipeline-0700') : '未找到'],
    ['任务状态', task.exists ? (task.State || '-') : (task.error || '-')],
    ['下次运行', task.NextRunTime || '-'],
    ['上次运行', taskLastRunText(task)],
    ['上次结果', taskResultText(task)],
    ['最新日志', latestLog.file || '-'],
    ['流水线状态', pipelineStatusLabel(latestLog.status)],
    ['日志结束时间', latestLog.endedAt || '-'],
    ['\u52a8\u4f5c\u72b6\u6001\u5b58\u50a8', actionStateStoreLabel()],
    ['\u72b6\u6001\u6587\u4ef6', actionStateStore.mode === 'service' && actionStateStore.ready ? ACTION_STATE_SERVICE_PATH : '-']
  ];
  const actionSummary = actionStateSummary();
  const actionCounts = actionSummary.counts;
  const actionStateRows = [
    ['已追踪动作', num(actionCounts.tracked)],
    ['已处理', num(actionCounts.done)],
    ['待复查', num(actionCounts.review)],
    ['已忽略', num(actionCounts.ignored)],
    ['仅备注/负责人', num(actionCounts.open)],
    ['有负责人', num(actionCounts.withOwner)],
    ['有备注', num(actionCounts.withNote)],
    ['负责人分布', actionSummary.topOwners.map(([owner,n]) => owner + ' ' + n).join('；') || '-'],
    ['最近更新', actionSummary.lastUpdated || '-']
  ];
  const countRows = [
    ['店铺', (DATA.stores || []).length],
    ['货号', (DATA.products || []).length],
    ['动作', (DATA.actions || []).length],
    ['诊断', (DATA.insights || []).length],
    ['订单', (DATA.orders || []).length],
    ['财务商品', (DATA.financeGoods || []).length],
    ['售后', (DATA.afterSales || []).length],
    ['面单', (DATA.waybills || []).length],
    ['营销活动', (DATA.campaigns || []).length],
    ['评价明细', (DATA.comments || []).length]
  ];
  $('systemAuditTag').textContent = audit.ok ? '体检通过' : '需要检查';
  $('systemAuditTag').className = 'tag ' + (audit.ok ? 'good' : 'high');
  const warningRows = collectDataWarnings().map((x,i)=>({k:'提醒 '+(i+1), v:x}));
  $('systemStatus').innerHTML =
    '<div class="store-flow">'+
      '<div class="store-verdict"><h3>今天数据能不能放心看？</h3><p>系统状态页先给结论：看体检、数据日期、自动任务和 warning。日志和团队访问放到折叠区，避免一进来全是运维明细。</p>'+
        '<div class="store-action-steps">'+
          '<div class="store-step"><b>1 看体检</b><p>'+escapeHtml(audit.ok ? '体检通过' : '体检有错误')+'；提醒 '+num(audit.warnings || 0)+'，错误 '+num(audit.errors || 0)+'。</p></div>'+
          '<div class="store-step"><b>2 看数据日</b><p>销售 '+escapeHtml(DATA.dates?.salesDate || '-')+'，业务 '+escapeHtml(DATA.dates?.businessDate || '-')+'，链接 '+escapeHtml(DATA.dates?.linkDate || '-')+'。</p></div>'+
          '<div class="store-step"><b>3 看自动任务</b><p>'+escapeHtml(firstRun.title)+'；最近成功率 '+num(stability.successRate)+'%。</p></div>'+
        '</div>'+
      '</div>'+
      '<div class="store-kpi-grid">'+
        '<div class="store-kpi"><span>体检</span><strong>'+escapeHtml(audit.ok ? '通过' : '检查')+'</strong><small>错误 '+num(audit.errors || 0)+'</small></div>'+
        '<div class="store-kpi"><span>销售日</span><strong>'+escapeHtml(DATA.dates?.salesDate || '-')+'</strong><small>订单销售</small></div>'+
        '<div class="store-kpi"><span>业务日</span><strong>'+escapeHtml(DATA.dates?.businessDate || '-')+'</strong><small>售后/库存/财务</small></div>'+
        '<div class="store-kpi"><span>链接日</span><strong>'+escapeHtml(DATA.dates?.linkDate || '-')+'</strong><small>链接表现</small></div>'+
        '<div class="store-kpi"><span>流水线</span><strong>'+escapeHtml(pipelineStatusLabel(latestLog.status))+'</strong><small>'+escapeHtml(latestLog.endedAt || '-')+'</small></div>'+
        '<div class="store-kpi"><span>协作动作</span><strong>'+num(actionCounts.tracked)+'</strong><small>已追踪</small></div>'+
      '</div>'+
    '</div>'+
    renderOpenApiReconciliationPanel()+
    sectionTitleHtml('数据体检与数量', '先看这些；如果这里通过，业务页面通常可以正常使用。', audit.ok ? '体检通过' : '需检查', audit.ok ? 'good' : 'high')+
    '<div class="split">' +
      '<div>' + table(healthRows.map(x => ({k:x[0], v:x[1]})), [['项目', r=>r.k], ['状态', r=>'<span class="mono">'+escapeHtml(r.v)+'</span>']]) + '</div>' +
      '<div>' + table(countRows.map(x => ({k:x[0], v:x[1]})), [['数据域', r=>r.k], ['数量', r=>'<span class="mono">'+num(r.v)+'</span>', 'num']]) + '</div>' +
    '</div>' +
    sectionTitleHtml('自动任务与协作状态', '用于判断是不是需要手动刷新、重跑验收，或者只等下一次定时任务。')+
    '<div class="split">' +
      '<div>' + table(pipelineRows.map(x => ({k:x[0], v:x[1]})), [['自动任务', r=>r.k], ['状态', r=>'<span class="mono">'+escapeHtml(r.v)+'</span>']]) + '</div>' +
      '<div>' + table(actionStateRows.map(x => ({k:x[0], v:x[1]})), [['动作协作', r=>r.k], ['状态', r=>'<span class="mono">'+escapeHtml(r.v)+'</span>']]) + '</div>' +
    '</div>' +
    '<div class="card soft" style="margin-top:12px">' +
      '<div class="card-h"><div><h3>首跑验收 / 自动刷新观察</h3><div class="sub">专门判断 07:00 自动任务是否已经首跑，以及首跑后是否可用。</div></div><span class="tag '+firstRunTagClass+'">'+escapeHtml(firstRun.title)+'</span></div>' +
      '<div class="card-body"><p class="next '+(firstRun.level === 'bad' ? 'warn' : '')+'">'+escapeHtml(firstRun.detail || '-')+'</p>' +
      '<ul class="compact-list">' + (firstRun.items || []).map(x => '<li>'+escapeHtml(x)+'</li>').join('') + '</ul>' +
      '<div class="status-actions"><button class="status-btn" id="refreshPortalData">重新读取最新状态</button><button class="status-btn" id="runFirstRunCheck">重新生成验收报告</button><button class="status-btn" id="copySystemStatusSummary">复制系统巡检摘要</button><span class="muted">通过本机网页服务打开时可用；直接双击 HTML 时请重新打开文件。</span></div>' +
      '<p class="muted" style="margin:8px 0 0">本页最近读取：<span id="portalDataLastReadAt">'+escapeHtml(localTimeText(portalDataLastReadAt))+'</span>；停留在系统状态页时，每 60 秒会自动尝试读取一次最新状态。</p></div>' +
    '</div>' +
    '<div class="card soft" style="margin-top:12px">' +
      '<div class="card-h"><div><h3>运行稳定性诊断</h3><div class="sub">基于最近 8 次 BI 流水线，判断早上自动刷新是否稳定。</div></div><span class="tag '+stabilityTagClass+'">'+(stability.level === 'good' ? '稳定' : stability.level === 'bad' ? '需处理' : '有提醒')+'</span></div>' +
      '<div class="progress-grid" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr))">' +
        '<div class="progress-card"><span>成功率</span><strong>'+num(stability.successRate)+'%</strong><div class="bar"><i style="width:'+Math.max(0, Math.min(100, stability.successRate))+'%"></i></div></div>' +
        '<div class="progress-card"><span>最近记录</span><strong>'+num(stability.total)+'</strong><small>成功 '+num(stability.success)+' / 失败 '+num(stability.failed)+' / 未完成 '+num(stability.incomplete)+'</small></div>' +
        '<div class="progress-card"><span>平均耗时</span><strong>'+(stability.avgDuration == null ? '-' : num(stability.avgDuration)+'s')+'</strong><small>最长 '+(stability.maxDuration == null ? '-' : num(stability.maxDuration)+'s')+'</small></div>' +
        '<div class="progress-card"><span>WARN 合计</span><strong>'+num(stability.warningTotal)+'</strong><small>最近口径 '+escapeHtml(stability.latestEffective || '-')+'</small></div>' +
      '</div>' +
      '<ul class="compact-list">' + stability.notes.map(x => '<li>'+escapeHtml(x)+'</li>').join('') + '</ul>' +
    '</div>' +
    detailBlockHtml('运维明细：流水线日志、团队访问、warning 原文',
      '<div class="section-block-label">最近流水线日志</div>' + table(recentLogs.map(x => ({...x})), [
        ['最近流水线', r=>'<span class="mono">'+escapeHtml(r.file || '-')+'</span>'],
        ['状态', r=>'<span class="tag '+(r.status === 'success' ? 'good' : r.status === 'failed' ? 'high' : 'mid')+'">'+escapeHtml(pipelineStatusLabel(r.status))+'</span>'],
        ['开始', r=>'<span class="mono">'+escapeHtml(r.startedAt || '-')+'</span>'],
        ['耗时', r=>r.durationSeconds == null ? '-' : '<span class="mono">'+num(r.durationSeconds)+'s</span>', 'num'],
        ['口径', r=>escapeHtml([r.effectiveDates?.salesDate, r.effectiveDates?.linkDate, r.effectiveDates?.businessDate].filter(Boolean).join(' / ') || '-')],
        ['WARN', r=>Number(r.warningCount || 0) ? '<span class="tag mid">'+num(r.warningCount)+'</span>' : '<span class="tag good">0</span>', 'num']
      ]) +
      '<div class="section-block-label">团队访问准备度</div>' +
      '<div class="split">' +
        '<div>' + table(teamAccess.rows.map(x => ({k:x[0], v:x[1]})), [['当前能力', r=>r.k], ['状态', r=>'<span class="mono">'+escapeHtml(r.v)+'</span>']]) + '</div>' +
        '<div class="progress-grid" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr));margin-bottom:0">' +
          '<div class="progress-card"><span>本机服务</span><strong>'+(teamAccess.isService ? '已用' : '未用')+'</strong><small>'+escapeHtml(actionStateStore.mode === 'service' ? 'http 服务模式' : 'HTML 文件模式')+'</small></div>' +
          '<div class="progress-card"><span>共享状态</span><strong>'+(teamAccess.sharedActionState ? '可写' : '本地')+'</strong><small>'+escapeHtml(teamAccess.sharedActionState ? ACTION_STATE_SERVICE_PATH : '当前浏览器 localStorage')+'</small></div>' +
          '<div class="progress-card"><span>开放范围</span><strong>'+(teamAccess.lanPreview ? '局域网' : '本机')+'</strong><small>'+escapeHtml(teamAccess.lanPreview ? '需补权限' : '暂不对外')+'</small></div>' +
          '<div class="progress-card"><span>团队版</span><strong>'+escapeHtml(teamAccess.title)+'</strong><small>'+num(teamAccess.score)+'%</small></div>' +
        '</div>' +
      '</div>' +
      '<div class="split" style="margin-top:12px">' +
        '<article class="action-card"><span class="domain">已具备</span><ul class="compact-list">'+teamAccess.ready.map(x => '<li>'+escapeHtml(x)+'</li>').join('')+'</ul></article>' +
        '<article class="action-card"><span class="domain">团队版还缺</span><ul class="compact-list">'+teamAccess.missing.map(x => '<li>'+escapeHtml(x)+'</li>').join('')+'</ul></article>' +
      '</div>' +
      '<div class="status-actions"><button class="status-btn" id="copyTeamAccessSummary">复制团队访问准备度</button><span class="muted">'+escapeHtml(teamAccess.next)+'</span></div>' +
      (latestLog.warnings?.length ? '<div class="section-block-label">日志 warning</div>' + table(latestLog.warnings.map((x,i)=>({k:'日志提醒 '+(i+1), v:x})), [['类型', r=>r.k], ['内容', r=>escapeHtml(r.v)]]) : '') +
      (warningRows.length ? '<div class="section-block-label">数据口径提醒</div>' + table(warningRows, [['类型', r=>r.k], ['内容', r=>escapeHtml(r.v)]]) : '')
    );
  const portalPath = 'E:\\\\Codex WorkSpace\\\\Shein销售统计\\\\outputs\\\\bi-portal\\\\index.html';
  const briefingPath = 'E:\\\\Codex WorkSpace\\\\Shein销售统计\\\\outputs\\\\bi-briefings\\\\latest.md';
  const firstRunCheckPath = 'E:\\\\Codex WorkSpace\\\\Shein销售统计\\\\outputs\\\\bi_first_run_check\\\\latest.md';
  const openCmd = 'E:\\\\Codex WorkSpace\\\\Shein销售统计\\\\打开SHEIN-BI经营门户.cmd';
  $('quickAccess').innerHTML =
    '<div class="action-list">' +
      '<article class="action-card"><span class="domain">本地门户</span><h4>每天先打开这个</h4><p class="mono">'+portalPath+'</p>'+copyButton(portalPath, '复制路径')+'<p class="next">双击项目根目录里的“打开SHEIN-BI经营门户.cmd”也可以直接打开。</p></article>' +
      '<article class="action-card"><span class="domain">晨报</span><h4>Markdown 经营晨报</h4><p class="mono">'+briefingPath+'</p>'+copyButton(briefingPath, '复制路径')+'<p class="next">每日 BI 流水线会自动生成 latest.md；也可以双击项目根目录里的“打开SHEIN-BI经营晨报.cmd”直接打开，适合复制到飞书群或留档复盘。</p></article>' +
      '<article class="action-card"><span class="domain">首跑验收</span><h4>自动任务验收报告</h4><p class="mono">'+firstRunCheckPath+'</p>'+copyButton(firstRunCheckPath, '复制路径')+'<p class="next">双击“检查SHEIN-BI自动任务.cmd”可生成最新验收报告；07:00 后用它确认自动任务是否真正跑完。</p></article>' +
      '<article class="action-card"><span class="domain">网页服务</span><h4>本机网页访问入口</h4><p class="mono">http://127.0.0.1:8787/</p>'+copyButton('http://127.0.0.1:8787/', '复制地址')+'<p class="next">双击“打开SHEIN-BI网页服务.cmd”可启动本机服务。默认只给本机访问；需要给同事看时再用局域网模式。</p></article>' +
      '<article class="action-card"><span class="domain">协作状态</span><h4>动作状态导出</h4><p class="next">导出当前已处理、待复查、忽略、负责人和备注，方便临时备份或发给团队。</p><div class="status-actions"><button class="status-btn" data-export-action-state="json">导出 JSON</button><button class="status-btn" data-copy-action-summary="1">复制摘要</button></div></article>' +
      '<article class="action-card"><span class="domain">Metabase</span><h4>深度分析入口</h4><p class="mono">${htmlEscape(links.home)}</p><a class="btn" href="${htmlEscape(links.home)}" target="_blank">打开 Metabase</a></article>' +
      '<article class="action-card"><span class="domain">刷新数据</span><h4>BI 每日自动任务</h4><p class="mono">SHEIN-BI-Daily-Pipeline-0700</p><p class="next">每天 07:00 隐藏运行；如果需要手动刷新，可运行 scripts\\\\run_bi_daily_pipeline.ps1。</p></article>' +
    '</div>';
  const notes = [
    {k:'正确展示库存', v:'来自商品列表库存接口，不再使用备货信息里的假库存。库存动作只保留已上架且近 30 天有销量/订单的低库存项。'},
    {k:'链接数据日期', v:'如果链接日早于销售日/业务日，说明 BI 正在沿用最新可用链接快照。此时销售、售后、库存可以正常看，但链接覆盖和优化建议要按链接日理解。'},
    {k:'财务明细', v:'HL 主账号已接入“我的收入”gsfs 财务明细；其它店尚未全部切主账号。商品层明细会尽量用 entity_id 与订单商品匹配，未匹配行会保留 entity_id 供后续复核。'},
    {k:'动作池', v:'动作池是精选入口，不是全量异常清单；当前保留链接、售后、质量、库存四类。'},
    {k:'诊断摘要', v:'诊断摘要会把店铺、货号、链接、售后、履约、营销信号合并排序，用于先判断今天看哪里。'},
    {k:'飞书生产链路', v:'飞书同步、日报和原销售看板仍保留运行，BI 系统稳定后再考虑替换。'}
  ];
  $('metricNotes').innerHTML = '<div class="action-list">' + notes.map(n =>
    '<article class="action-card"><span class="domain">口径</span><h4>'+n.k+'</h4><p>'+n.v+'</p></article>'
  ).join('') + '</div>';
}
const PAGE_GUIDES = {
  stores: {
    title: '店铺视角',
    purpose: '回答一个问题：哪个店现在最需要关注？先看上方结论，再看 店铺矩阵，不要一上来钻明细。',
    steps: [
      ['先看结论', '选择店铺后，店铺作战台会把销售、链接、售后、履约和库存压成几张判断卡。'],
      ['再看对比', '店铺横向对照表用于比较当前时段销售和最新风险信号，重点找销售高但售后高、动作多或覆盖弱的店。'],
      ['最后下钻', '点货号、SKC 或动作，再进入货号 360 / SKC 链接 / 动作池处理。']
    ],
    actions: [
      ['看店铺作战台', 'storeCockpit'],
      ['看店铺横向对照', 'storesTable'],
      ['去今日动作池', 'actions', 'tab']
    ]
  },
  products: {
    title: '货号 360',
    purpose: '回答一个问题：这个标准货号到底该扩、该修，还是该淘汰？这里按标准货号归并，不按各店后台原始货号拆散。',
    steps: [
      ['先搜货号', '从首页产品排行点进来，或在顶部搜索框输入标准货号 / 关键词。'],
      ['看四类判断', '优先看销售、链接覆盖、售后质量、财务在途，不要只看单一指标。'],
      ['看覆盖矩阵', '店铺 × 货号矩阵用来判断哪些店缺链接、哪些店已有更好链接。']
    ],
    actions: [
      ['看货号聚焦', 'productSpotlight'],
      ['看风险池', 'productsTable'],
      ['看覆盖矩阵', 'matrixTable']
    ]
  },
  links: {
    title: 'SKC / 链接',
    purpose: '回答一个问题：这条具体链接表现如何，应该优化、替换、补资料，还是暂时不动？SKC 是最直接的后台查询入口。',
    steps: [
      ['先搜 SKC', '输入 SKC 后先看链接状态、流量承接、销售财务和售后质量。'],
      ['再判断动作', '低点击、低支付、下架候选、待上架卡点会集中在链接健康表。'],
      ['避免误判', '已废且已下架链接只作历史状态，不再要求归档处理。']
    ],
    actions: [
      ['看 SKC 聚焦', 'linkSpotlight'],
      ['看链接健康', 'linksTable'],
      ['去动作池', 'actions', 'tab']
    ]
  },
  comments: {
    title: '评价 / 口碑',
    purpose: '回答一个问题：差评、低星和质量投诉到底集中在哪个货号、哪个店、哪个 SKC？这里是售后和转化问题的原因库。',
    steps: [
      ['先筛货号', '用顶部货号筛选或全局搜索定位某个标准货号，也可以从货号 360 跳进来。'],
      ['再看低星', '低星、质量投诉和差评标签优先排前面，先找真实不满点。'],
      ['最后归因', '把评价原文、退货原因、链接承接一起看，判断是质量、物流、描述还是价格预期问题。']
    ],
    actions: [
      ['看评价总览', 'commentsOverview'],
      ['看评价明细', 'commentsTable'],
      ['去货号 360', 'products', 'tab']
    ]
  },
  business: {
    title: '订单 / 售后',
    purpose: '回答一个问题：销售、退货、履约、财务之间能不能互相印证？这里不是单纯订单列表。',
    steps: [
      ['先看财务摘要', '确认在途、待结算、账期等财务口径是否异常。'],
      ['再看订单售后', '订单明细用于反查销售，售后按申请时间口径看退货压力。'],
      ['最后看履约', '面单和履约异常用于解释取消、延迟、售后集中等问题。']
    ],
    actions: [
      ['看财务摘要', 'financeTable'],
      ['看订单明细', 'ordersTable'],
      ['看售后明细', 'afterSalesTable'],
      ['看履约明细', 'waybillTable']
    ]
  },
  profit: {
    title: '成本 / 利润',
    purpose: '回答一个问题：真实利润到底从哪里来？先补成本覆盖，再看月度总利润、分组利润和货号利润，仓储费只影响月总盘。',
    steps: [
      ['先看覆盖', '成本表缺口会直接影响真实利润可信度；缺头程运费的批次会被保留但不计入单位成本。'],
      ['再看月利润', '月度利润会扣商品成本、退货派送费和按净成交额分摊的月仓储费。'],
      ['最后做选品', '用单位成本、体积、售价和退货率模拟利润率，指导后续选品。']
    ],
    actions: [
      ['看利润总览', 'profitOverview'],
      ['看月利润趋势', 'profitTrendPanel'],
      ['看选品计算器', 'profitCalculatorPanel']
    ]
  },
  inventory: {
    title: '实际库存 / 去化',
    purpose: '回答一个问题：按现在销售速度，这些货还够卖多久？这里用成本表批次推算经营库存，不等于真实仓库系统。',
    steps: [
      ['先看在库', '有到仓/派送日期且有头程费用的批次才计入到仓库存。'],
      ['再看速度', '去化按毛销量扣库存，店铺/分组筛选只改变销售速度，不改变全局库存基数。'],
      ['最后做动作', '断货风险看补货，在途看催到仓/录头程，低动销库存看活动清货或暂停补货。']
    ],
    actions: [
      ['看库存总览', 'inventoryOverview'],
      ['看补货预警', 'inventoryRiskList'],
      ['看批次明细', 'inventoryBatchTable']
    ]
  },
  actions: {
    title: '今日动作池',
    purpose: '回答一个问题：今天到底先处理哪些事？这里是精选实操清单，不是全量异常仓库。',
    steps: [
      ['先筛选', '可按店铺、货号、业务域、风险和处理状态筛。'],
      ['再分派', '批量分派负责人、备注、待复查，便于团队协作。'],
      ['闭环复查', '处理后标记已处理或待复查，首页复查队列会提醒后续看效果。']
    ],
    actions: [
      ['看批量处理', 'actionBulkPanel'],
      ['看处理进度', 'actionProgress'],
      ['看动作列表', 'actionsList']
    ]
  },
  system: {
    title: '系统状态',
    purpose: '回答一个问题：今天的数据能不能放心看？先看体检和任务结果，再看日志和入口。',
    steps: [
      ['先看体检', '确认销售、业务域、链接和自动任务是否成功。'],
      ['再看提醒', 'warning 不一定阻断，但要知道哪些数据是旧快照或阶段性覆盖。'],
      ['最后看入口', '这里集中放门户、晨报、验收报告和 Metabase 入口。']
    ],
    actions: [
      ['看系统状态', 'systemStatus'],
      ['看快捷入口', 'quickAccess'],
      ['看口径说明', 'metricNotes']
    ]
  }
};
function guideButtonHtml(item){
  const [label, target, type] = item;
  const attr = type === 'tab' ? 'data-guide-tab' : 'data-guide-target';
  return '<button class="btn" type="button" '+attr+'="'+escapeHtml(target)+'">'+escapeHtml(label)+'</button>';
}
function decisionCardHtml(card){
  const level = card.level || 'info';
  return '<div class="decision-card '+escapeHtml(level)+'">'+
    '<span>'+escapeHtml(card.label || '')+'</span>'+
    '<strong>'+escapeHtml(card.value || '-')+'</strong>'+
    '<p>'+escapeHtml(card.hint || '')+'</p>'+
  '</div>';
}
function decisionSummaryHtml(cfg){
  return '<div class="page-decision-head">'+
    '<div><h3>'+escapeHtml(cfg.title || '本页决策摘要')+'</h3><p>'+escapeHtml(cfg.subtitle || '')+'</p></div>'+
    (cfg.tag ? '<span class="tag info">'+escapeHtml(cfg.tag)+'</span>' : '')+
  '</div>'+
  '<div class="page-decision-grid">'+(cfg.cards || []).map(decisionCardHtml).join('')+'</div>'+
  '<div class="decision-next"><span class="next-label">下一步</span><div class="next-copy">'+escapeHtml(cfg.next || '')+'</div>'+(cfg.target ? '<button class="btn" type="button" data-decision-target="'+escapeHtml(cfg.target)+'">直接查看</button>' : '')+'</div>';
}
function sectionDecisionBlock(id, cfg){
  const section = document.getElementById(id);
  if (!section) return;
  let block = section.querySelector(':scope > .page-decision');
  if (!block) {
    block = document.createElement('div');
    block.className = 'page-decision';
    const guide = section.querySelector(':scope > .page-guide');
    if (guide) guide.after(block);
    else section.prepend(block);
  }
  block.innerHTML = decisionSummaryHtml(cfg);
}
function removeSectionDecisionBlock(id){
  const section = document.getElementById(id);
  const block = section?.querySelector(':scope > .page-decision');
  if (block) block.remove();
}
function focusedStore(){
  const stores = DATA.stores || [];
  const scope = storeFilterKind();
  if (scope.type === 'store') return stores.find(s => s.store_key === scope.key) || null;
  const pool = scope.type === 'group' ? stores.filter(s => storeGroupKey(s) === scope.key) : stores;
  return [...pool].sort((a,b)=>Number(b.risk_score||0)-Number(a.risk_score||0))[0] || null;
}
function focusedProduct(){
  const products = DATA.products || [];
  const q = (state.product || state.q || '').trim().toLowerCase();
  if (q) {
    const hit = products.find(p => String(p.standard_goods_sn || '').toLowerCase().includes(q));
    if (hit) return hit;
  }
  return [...products].filter(includes).sort((a,b)=>Number(b.risk_score||0)-Number(a.risk_score||0))[0] || products[0] || null;
}
function focusedLink(){
  const linkRows = DATA.links || [];
  const q = (state.product || state.q || '').trim().toLowerCase();
  if (q) {
    const hit = linkRows.find(x =>
      String(x.skc || '').toLowerCase().includes(q) ||
      String(x.standard_goods_sn || '').toLowerCase().includes(q)
    );
    if (hit) return hit;
  }
  const filtered = linkRows.filter(includes);
  return [...filtered].sort((a,b) =>
    Number(Boolean(b.retire_candidate))-Number(Boolean(a.retire_candidate)) ||
    Number(Boolean(b.high_visit_low_pay))-Number(Boolean(a.high_visit_low_pay)) ||
    Number(b.eps_uv||0)-Number(a.eps_uv||0)
  )[0] || linkRows[0] || null;
}
function renderPageDecisionSummaries(){
  const rangeText = selectedRangeText();
  const actions = currentActions();
  const activeIds = ['stores','products','links','business','profit','inventory','actions','system'];
  activeIds.forEach(id => {
    if (state.tab !== id) removeSectionDecisionBlock(id);
  });
  const store = focusedStore();
  const stores = DATA.stores || [];
  const topSalesStore = [...stores].sort((a,b)=>Number(b.sales_sar||0)-Number(a.sales_sar||0))[0];
  const topRiskStore = [...stores].sort((a,b)=>Number(b.risk_score||0)-Number(a.risk_score||0))[0];
  if (state.tab === 'stores' && store) {
    if (storeFilterKind().type !== 'all') {
      removeSectionDecisionBlock('stores');
    } else {
    const storeActions = (DATA.actions || []).filter(a => a.store_key === store.store_key);
    const rangeStore = aggregateDailyStores().find(x => x.store_key === store.store_key) || {};
    const storeCards = [
      {label:'当前时段销售最高', value:(topSalesStore?.store_key || '-') + ' · ' + money(topSalesStore?.sales_sar), hint:'按当前时间筛选统计，用来找贡献最大的店。', level:'good'},
      {label:'风险分最高店', value:(topRiskStore?.store_key || '-') + ' · 风险分 ' + num(topRiskStore?.risk_score), hint:'风险分是综合优先级分，不是金额；优先看售后、缺链接、履约或库存是否集中。', level:'high'},
      {label:'当前聚焦店', value:store.store_key + ' · ' + money(rangeStore.sales_sar ?? store.sales_sar), hint:'未选店时默认聚焦最高风险店；点击店铺卡可切换。', level:'info'},
      {label:'待处理动作', value:num(storeActions.length) + ' 条', hint:'筛到该店后进入动作池分派处理。', level:storeActions.length ? 'mid' : 'good'}
    ];
    sectionDecisionBlock('stores', {
      title: '店铺经营决策摘要',
      subtitle: '未选店铺时默认提示最高风险店，同时保留当前时段销售最高店作为对照。',
      tag: '全部店铺',
      cards: storeCards,
      next: '先点击店铺横向对照表里的最高风险店或销售最高店，再看该店的作战台。',
      target:'storeCockpit'
    });
    }
  }
  const product = state.tab === 'products' ? focusedProduct() : null;
  if (product) {
    const sn = product.standard_goods_sn || '-';
    const rangeProduct = aggregateDailyProducts().find(x => x.standard_goods_sn === sn);
    const productActions = (DATA.actions || []).filter(a => a.standard_goods_sn === sn);
    sectionDecisionBlock('products', {
      title: sn + ' · 货号决策摘要',
      subtitle: '当前时间段：' + rangeText + '。这里按标准货号归并，看的是“产品”而不是各店后台原始货号。',
      tag: state.q ? '搜索聚焦' : '默认高风险',
      cards: [
        {label:'当前时段销售', value:money(rangeProduct?.sales_sar ?? product.sales_sar), hint:'销量 '+num(rangeProduct?.quantity ?? product.quantity)+'；订单 '+num(rangeProduct?.orders || 0), level:'good'},
        {label:'链接覆盖', value:num(product.on_shelf_store_count) + '/' + num(TOTAL_STORE_COUNT) + ' 店', hint:'缺覆盖 '+num(product.missing_store_count)+' 店；先区分“该补链”还是“暂不上”。', level:Number(product.missing_store_count||0) ? 'mid' : 'good'},
        {label:'售后压力', value:num(product.after_sales_case_count) + ' 单', hint:'质退 '+num(product.quality_return_volume)+'；低星 '+num(product.low_star_comment_count), level:Number(product.after_sales_case_count||0) ? 'high' : 'good'},
        {label:'相关动作', value:num(productActions.length) + ' 条', hint:'动作多时先看优先级和下一步，不要逐条扫全表。', level:productActions.length ? 'mid' : 'good'}
      ],
      next:'先看“货号 360 聚焦”的四张判断卡；如果缺店明显，再看“店铺 × 货号覆盖矩阵”。',
      target:'productSpotlight'
    });
  }
  const link = state.tab === 'links' ? focusedLink() : null;
  if (link) {
    const issueCount = [link.retire_candidate, link.high_exposure_low_click, link.high_visit_low_pay, link.wait_shelf_block_candidate].filter(Boolean).length;
    sectionDecisionBlock('links', {
      title: (link.skc || '-') + ' · SKC 决策摘要',
      subtitle: 'SKC 是后台查询链接的直接入口。先判断状态，再看曝光、点击、支付和相关动作。',
      tag: link.store_key || '',
      cards: [
        {label:'链接状态', value:(link.shelf_status_name || '-') + ' / ' + (link.health_bucket || '-'), hint:'已废且下架只忽略；待上架卡点要补资料。', level:issueCount ? 'mid' : 'good'},
        {label:'近30天销量', value:num(link.c30_sale_cnt), hint:'有销量先优化承接；长期无销量再考虑替换或淘汰。', level:Number(link.c30_sale_cnt||0) ? 'good' : 'mid'},
        {label:'曝光 / 访客', value:num(link.eps_uv) + ' / ' + num(link.goods_uv), hint:'曝光高访客低看主图标题；访客高支付低看价格评价详情。', level:'info'},
        {label:'点击 / 支付', value:pct(link.click_rate) + ' / ' + pct(link.pay_rate), hint:'两个转化率决定先修点击还是修成交。', level:issueCount ? 'high' : 'good'}
      ],
      next:'先看“SKC / 链接 360 聚焦”，需要处理时再跳到动作池；不要从全量链接健康表开始扫。',
      target:'linkSpotlight'
    });
  }
  if (state.tab === 'business') {
  const financeRows = (DATA.finance || []).filter(includes);
  const orders = (DATA.orders || []).filter(includes).filter(r => rowInSelectedRangeBy(r, ['created_date', 'order_create_time']));
  const after = (DATA.afterSales || []).filter(includes).filter(r => rowInSelectedRangeBy(r, ['request_time', 'snapshot_date']));
  const waybills = (DATA.waybills || []).filter(includes).filter(r => rowInSelectedRangeBy(r, ['collect_time', 'print_time', 'snapshot_date']));
  const financePending = financeRows.reduce((s,r)=>s+Number(r.pending_settlement_income_sar||0),0);
  const afterAmount = after.reduce((s,r)=>s+Number(r.price_amount_total||0),0);
  sectionDecisionBlock('business', {
    title:'订单 / 售后 / 财务决策摘要',
    subtitle:'当前时间段：' + selectedRangeText() + '。订单、售后、履约明细跟随时间筛选；财务摘要是最新快照。',
    tag: state.store || '全部店铺',
    cards:[
      {label:'订单明细', value:num(orders.length) + ' 行', hint:'用于反查店铺、货号、SKC 的销售来源。', level:'good'},
      {label:'售后退货', value:num(after.length) + ' 单', hint:'金额 '+money(afterAmount)+'；按售后申请时间口径理解。', level:after.length ? 'high' : 'good'},
      {label:'待结算', value:money(financePending), hint:'财务摘要目前优先看在途、待结算和账期。', level:'info'},
      {label:'履约面单', value:num(waybills.length) + ' 行', hint:'异常、取消、延迟可解释售后和订单波动。', level:'mid'}
    ],
    next:'先看财务摘要和售后退货；需要复核某个订单或 SKC 时，再展开收入明细、订单明细和履约明细。',
    target:'financeTable'
  });
  }
  if (state.tab === 'inventory') {
    const invRows = inventoryRowsWithScope();
    const high = invRows.filter(r => inventoryRiskClass(r) === 'high').length;
    const onHand = invRows.reduce((s,r)=>s+Number(r.estimated_on_hand_quantity||0),0);
    const incoming = invRows.reduce((s,r)=>s+Number(r.incoming_quantity||0),0);
    const daily = invRows.reduce((s,r)=>s+Number(r.scoped_daily_sales||0),0);
    const slow = invRows.filter(r => Number(r.estimated_on_hand_quantity||0) > 0 && Number(r.scoped_sold_30d||0) <= 0).length;
    sectionDecisionBlock('inventory', {
      title:'实际库存 / 去化决策摘要',
      subtitle:'当前范围：' + storeScopeLabel() + '；库存优先来自 ET 货代仓实盘，销售速度按当前筛选范围计算。',
      tag:'ET实盘优先',
      cards:[
        {label:'ET可售库存', value:num(onHand)+' 件', hint:'09散件仓 + 01整箱仓；无ET数据时回退成本表估算。', level:onHand ? 'info' : 'mid'},
        {label:'成本表在途', value:num(incoming)+' 件', hint:'有发货但缺到仓或缺头程费，暂不计入ET可售。', level:incoming ? 'mid' : 'good'},
        {label:'加权日销', value:fmt.format(daily)+' 件/天', hint:'近7天40% + 近30天60%，用于估算去化周期。', level:daily ? 'good' : 'mid'},
        {label:'高风险货号', value:num(high)+' 个', hint:'疑似缺货、14天内断货或批次缺口。低动销 '+num(slow)+' 个。', level:high ? 'high' : 'good'}
      ],
      next:'先处理高风险补货，再看低动销库存是否需要活动清货；对异常货号先核对成本表是否漏批次。',
      target:'inventoryRiskList'
    });
  }
  if (state.tab === 'profit') {
  const pr = profitSummaryForRows(profitDailyRows(ensureDateRange().start, ensureDateRange().end, state.store, true));
  const prProducts = aggregateProfitProductsFromDailyRows(profitDailyRows(ensureDateRange().start, ensureDateRange().end, state.store, true));
  const costProducts = prProducts.filter(r => Number(r.known_gross_revenue_sar || 0) > 0 || Number(r.product_cost_sar || 0) > 0).length;
  const missingProducts = prProducts.filter(r => Number(r.missing_cost_revenue_sar || 0) > 0 || Number(r.cost_coverage_revenue_rate || 0) < .9).length;
  sectionDecisionBlock('profit', {
    title:'成本 / 利润决策摘要',
    subtitle:'当前时间段：' + rangeText + '。真实利润跟随顶部时间、店铺/分组和货号筛选；月仓储费只在月度总盘扣除。',
    tag: pr.hasAnyCost ? ('覆盖 ' + pct(pr.costCoverageRate)) : '等待成本表',
    cards:[
      {label:'当前真实利润', value:pr.hasAnyCost ? money(pr.profitSar) : '待成本表', hint:'净营收 - 商品成本 - 退货派送费；单店/货号口径未扣月仓储。', level:pr.hasAnyCost ? (Number(pr.profitSar||0) >= 0 ? 'good' : 'high') : 'mid'},
      {label:'成本覆盖', value:pct(pr.costCoverageRate), hint:'只有有成本的净成交额才计入真实利润；缺成本不能硬算。', level:Number(pr.costCoverageRate||0) >= .9 ? 'good' : 'mid'},
      {label:'成本货号', value:num(costProducts) + ' 个', hint:'缺成本货号 '+num(missingProducts)+' 个；导入成本表后自动更新。', level:costProducts ? 'good' : 'mid'},
      {label:'退货费用', value:money(pr.returnFeeSar), hint:'退货或派送失败每单加 13.88 SAR，按保守毁损处理。', level:Number(pr.returnFeeSar||0) ? 'high' : 'good'}
    ],
    next:'先补齐成本覆盖，再看月利润趋势；选品前用右侧计算器模拟售价、体积、头程和退货率。',
    target:'profitOverview'
  });
  }
  if (state.tab === 'actions') {
  const statusCounts = actions.reduce((acc,a)=>{ const st=actionStatus(a); acc[st]=(acc[st]||0)+1; return acc; },{});
  const domainCount = actions.reduce((acc,a)=>{ const k=domainName(a.action_domain); acc[k]=(acc[k]||0)+1; return acc; },{});
  const topDomain = Object.entries(domainCount).sort((a,b)=>b[1]-a[1])[0];
  sectionDecisionBlock('actions', {
    title:'今日动作池决策摘要',
    subtitle:'动作池是精选实操清单。先筛小范围，再分派负责人，不要把它当成全量异常表逐行扫。',
    tag:num(actions.length) + ' 条',
    cards:[
      {label:'当前筛选动作', value:num(actions.length), hint:'受店铺、货号、业务域、风险、状态共同影响。', level:actions.length ? 'mid' : 'good'},
      {label:'最大业务域', value:(topDomain?.[0] || '-') + (topDomain ? ' · ' + num(topDomain[1]) : ''), hint:'先处理最集中的问题域。', level:'info'},
      {label:'未处理', value:num(statusCounts.open || 0), hint:'未处理越多，越要先用筛选收窄。', level:(statusCounts.open||0) ? 'high' : 'good'},
      {label:'待复查', value:num(statusCounts.review || 0), hint:'处理后的复查队列会回到首页闭环。', level:(statusCounts.review||0) ? 'mid' : 'good'}
    ],
    next:'先用顶部全局筛选缩小到一个店或一个货号，再用动作池专用筛选细分后批量分派；处理后标记“已处理”或“待复查”。',
    target:'actionBulkPanel'
  });
  }
  if (state.tab === 'system') {
  const audit = DATA.audit || {};
  const pipeline = DATA.pipeline || {};
  const task = pipeline.task || {};
  const taskOk = Number(task.lastTaskResult ?? task.LastTaskResult ?? 0) === 0;
  sectionDecisionBlock('system', {
    title:'系统状态决策摘要',
    subtitle:'这页回答“今天的数据能不能放心看”。先看是否阻断，再看 warning 是不是口径提醒。',
    tag:audit.ok ? '体检通过' : '需检查',
    cards:[
      {label:'数据体检', value:audit.ok ? '通过' : '需处理', hint:'错误 '+num(audit.errors||0)+'；提醒 '+num(audit.warnings||0), level:audit.ok ? 'good' : 'high'},
      {label:'销售 / 业务 / 链接', value:[DATA.dates?.salesDate, DATA.dates?.businessDate, DATA.dates?.linkDate].filter(Boolean).join(' / '), hint:'三个口径日一致时最适合做当日判断。', level:'info'},
      {label:'BI 自动任务', value:taskOk ? '成功' : '待确认', hint:'07:00 每日流水线，失败会保留验收报告。', level:taskOk ? 'good' : 'mid'},
      {label:'团队访问', value:'本机模式', hint:'当前只开放 127.0.0.1，团队版需再配置权限和固定地址。', level:'mid'}
    ],
    next:'如果体检错误为 0，可以正常看经营页面；如果有 warning，先读“当前口径说明”再判断是否影响今天操作。',
    target:'systemStatus'
  });
  }
  document.querySelectorAll('[data-decision-target]').forEach(btn => {
    if (btn.dataset.decisionBound) return;
    btn.dataset.decisionBound = '1';
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const target = document.getElementById(btn.dataset.decisionTarget || '');
      if (target) {
        target.closest('details')?.setAttribute('open', 'open');
        target.scrollIntoView({behavior:'smooth', block:'start'});
      }
    });
  });
}
function renderPageGuides(){
  Object.entries(PAGE_GUIDES).forEach(([id, cfg]) => {
    const section = document.getElementById(id);
    if (!section) return;
    let guide = section.querySelector(':scope > .page-guide');
    const html =
      '<div class="page-guide-inner">' +
        '<div>' +
          '<div class="page-guide-title"><span>'+escapeHtml(id === 'stores' ? '店' : id === 'products' ? '货' : id === 'links' ? '链' : id === 'comments' ? '评' : id === 'business' ? '单' : id === 'profit' ? '利' : id === 'inventory' ? '库' : id === 'actions' ? '办' : '检')+'</span>'+escapeHtml(cfg.title)+'</div>' +
          '<div class="page-guide-purpose">'+escapeHtml(cfg.purpose)+'</div>' +
          '<div class="page-guide-actions">'+cfg.actions.map(guideButtonHtml).join('')+'</div>' +
        '</div>' +
        '<div class="page-guide-grid">' + cfg.steps.map((s, i) =>
          '<div class="guide-step"><b>'+(i+1)+'. '+escapeHtml(s[0])+'</b><p>'+escapeHtml(s[1])+'</p></div>'
        ).join('') + '</div>' +
      '</div>';
    if (!guide) {
      guide = document.createElement('div');
      guide.className = 'page-guide';
      section.prepend(guide);
    }
    guide.innerHTML = html;
  });
  document.querySelectorAll('[data-guide-tab]').forEach(btn => {
    if (btn.dataset.guideBound) return;
    btn.dataset.guideBound = '1';
    btn.addEventListener('click', e => {
      e.stopPropagation();
      jumpToTab(btn.dataset.guideTab || 'overview', {keepFilters:true});
    });
  });
  document.querySelectorAll('[data-guide-target]').forEach(btn => {
    if (btn.dataset.guideBound) return;
    btn.dataset.guideBound = '1';
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const target = document.getElementById(btn.dataset.guideTarget || '');
      if (target) {
        target.closest('details')?.setAttribute('open', 'open');
        target.scrollIntoView({behavior:'smooth', block:'start'});
      }
    });
  });
}
function renderAll(){
  document.body.dataset.currentTab = state.tab || 'overview';
  applyStateToControls();
  syncUrlHash();
  renderPageGuides();
  renderDataWarnings();
  renderFocusBar();
  renderFloatingRangeToolbar();
  renderTopRangeToolbar();
  if (state.tab === 'overview') {
    renderFloatingRangeToolbar();
    renderHomeDashboard();
    bindChartTooltips();
    renderBriefing();
    if ($('dataFold')?.open) {
      renderDataReliability();
      renderTrendReadiness();
      renderBackendDataMap();
    }
    if ($('detailsFold')?.open) {
      renderCommandRoom();
      renderBattlePath();
      renderCharts();
      renderDomains();
      renderGrowthOpportunities();
      renderProductPriority();
      renderInsights();
      renderActions();
      renderReviewQueue();
      renderSopWorkbench();
      renderRootCauseCenter();
    }
  } else if (state.tab === 'stores') {
    renderStores();
    renderStoreCockpit();
  } else if (state.tab === 'products') {
    renderProducts();
    renderProductSpotlight();
  } else if (state.tab === 'links') {
    renderLinkSpotlight();
    renderLinks();
  } else if (state.tab === 'linkops') {
    renderLinkOps();
  } else if (state.tab === 'comments') {
    renderComments();
  } else if (state.tab === 'business') {
    renderBusiness();
  } else if (state.tab === 'profit') {
    renderProfitPage();
    bindChartTooltips();
  } else if (state.tab === 'inventory') {
    renderInventoryPage();
  } else if (state.tab === 'actions') {
    renderActions();
  } else if (state.tab === 'system') {
    renderSystem();
  }
  renderPageDecisionSummaries();
  bindRangeToolbarControls();
  bindChartTooltips();
  if (lastRenderedTab !== state.tab) {
    lastRenderedTab = state.tab;
    document.body.dataset.currentTab = state.tab || 'overview';
    if (shouldScrollToActiveTab) {
      window.setTimeout(() => {
        if ((state.tab || 'overview') === 'overview') {
          window.scrollTo({top: 0, behavior: 'smooth'});
          return;
        }
        const target = document.getElementById(state.tab);
        if (target) target.scrollIntoView({behavior:'smooth', block:'start'});
      }, 0);
    }
  }
  shouldScrollToActiveTab = false;
  document.querySelectorAll('.copy').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(btn.dataset.copy || '');
      showToast('已复制：' + (btn.dataset.copy || ''));
    } catch {
      showToast('复制失败，请手动复制');
    }
  }));
  document.querySelectorAll('[data-growth-skc]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    focusGrowthSkc(btn.dataset.growthSkc || '');
  }));
  document.querySelectorAll('[data-product-comments]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    state.q = btn.dataset.productComments || state.q || '';
    safeSetValue('q', state.q);
    jumpToTab('comments', {keepFilters:true});
    renderAll();
  }));
  document.querySelectorAll('[data-health-tab]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    const tab = btn.dataset.healthTab || 'overview';
    const focus = btn.dataset.healthFocus || '';
    if (focus) state.focus = focus;
    if (tab === 'actions') {
      $('domainFilter').value = '';
      $('riskFilter').value = '';
      $('statusFilter').value = state.status;
    }
    jumpToTab(tab, {keepFilters:true});
    renderAll();
  }));
  document.querySelectorAll('[data-backend-tab]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    const tab = btn.dataset.backendTab || 'overview';
    const focus = btn.dataset.backendFocus || '';
    if (focus) state.focus = focus;
    jumpToTab(tab, {keepFilters:true});
    renderAll();
  }));
  document.querySelectorAll('[data-trend-tab]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    const tab = btn.dataset.trendTab || 'overview';
    jumpToTab(tab, {keepFilters:true});
    renderAll();
  }));
  document.querySelectorAll('[data-sop-tab]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    const actionKeyValue = decodeURIComponent(btn.dataset.sopActionKey || '');
    const action = actionKeyValue ? (DATA.actions || []).find(a => actionKey(a) === actionKeyValue) : null;
    state.focus = btn.dataset.sopFocus || 'all';
    state.domain = btn.dataset.sopDomain || '';
    state.risk = btn.dataset.sopRisk || '';
    state.store = btn.dataset.sopStore || (action?.store_key || '');
    state.q = btn.dataset.sopQ || (action ? (action.standard_goods_sn || action.skc || '') : '');
    safeSetValue('q', state.q);
    safeSetValue('storeFilter', state.store);
    safeSetValue('domainFilter', state.domain);
    safeSetValue('riskFilter', state.risk);
    safeSetValue('statusFilter', state.status);
    jumpToTab(btn.dataset.sopTab || 'actions', {keepFilters:true});
    renderAll();
  }));
  document.querySelectorAll('[data-action-status]').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    const key = decodeURIComponent(btn.dataset.actionKey || '');
    const status = btn.dataset.actionStatus || 'open';
    await updateActionStatus(key, status);
  }));
  document.querySelectorAll('[data-action-save-meta]').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    const key = decodeURIComponent(btn.dataset.actionSaveMeta || '');
    const card = btn.closest('.action-card');
    const ownerInput = card?.querySelector('[data-action-owner]');
    const noteInput = card?.querySelector('[data-action-note]');
    await updateActionMeta(key, {
      owner: ownerInput?.value || '',
      note: noteInput?.value || ''
    });
  }));
  document.querySelectorAll('[data-action-copy-command]').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    const key = decodeURIComponent(btn.dataset.actionCopyCommand || '');
    const action = findActionByKey(key);
    if (!action) return showToast('没有找到这条动作');
    try {
      await navigator.clipboard.writeText(actionCommandText(action));
      showToast('已复制处理指令');
    } catch {
      showToast('复制失败，请手动复制动作内容');
    }
  }));
  document.querySelectorAll('[data-action-focus-target]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    const key = decodeURIComponent(btn.dataset.actionKey || '');
    const action = findActionByKey(key);
    focusActionTarget(action, btn.dataset.actionFocusTarget || 'store');
  }));
  const bulkAssign = $('bulkAssignActions');
  if (bulkAssign) bulkAssign.addEventListener('click', async e => {
    e.stopPropagation();
    const actions = currentActions();
    const owner = ($('bulkOwner')?.value || '').trim();
    const note = ($('bulkNote')?.value || '').trim();
    if (!actions.length) return showToast('当前筛选没有动作');
    if (!owner && !note) return showToast('请先填写负责人或备注');
    if (!confirmBatch('确认批量分配当前筛选动作？', actions.length)) return;
    const items = buildBatchItems(actions, () => ({owner: owner || undefined, noteAppend: note || undefined}));
    await updateActionBatch(items, '已批量分配 ' + actions.length + ' 条动作');
  });
  const bulkReview = $('bulkReviewActions');
  if (bulkReview) bulkReview.addEventListener('click', async e => {
    e.stopPropagation();
    const actions = currentActions();
    if (!actions.length) return showToast('当前筛选没有动作');
    if (!confirmBatch('确认把当前筛选动作标为待复查？', actions.length)) return;
    await updateActionBatch(buildBatchItems(actions, {status:'review'}), '已批量标为待复查 ' + actions.length + ' 条');
  });
  const bulkDone = $('bulkDoneActions');
  if (bulkDone) bulkDone.addEventListener('click', async e => {
    e.stopPropagation();
    const actions = currentActions();
    if (!actions.length) return showToast('当前筛选没有动作');
    if (!confirmBatch('确认把当前筛选动作标为已处理？', actions.length)) return;
    await updateActionBatch(buildBatchItems(actions, {status:'done'}), '已批量标为已处理 ' + actions.length + ' 条');
  });
  const bulkOpen = $('bulkOpenActions');
  if (bulkOpen) bulkOpen.addEventListener('click', async e => {
    e.stopPropagation();
    const actions = currentActions();
    if (!actions.length) return showToast('当前筛选没有动作');
    if (!confirmBatch('确认把当前筛选动作恢复为未处理？负责人和备注会保留。', actions.length)) return;
    await updateActionBatch(buildBatchItems(actions, {status:'open'}), '已批量恢复未处理 ' + actions.length + ' 条');
  });
  const bulkClear = $('bulkClearActions');
  if (bulkClear) bulkClear.addEventListener('click', async e => {
    e.stopPropagation();
    const actions = currentActions();
    if (!actions.length) return showToast('当前筛选没有动作');
    if (!confirmBatch('确认清空当前筛选动作的状态、负责人和备注？', actions.length)) return;
    const now = new Date().toISOString();
    const items = filteredActionKeys(actions).map(key => ({key, status:'open', owner:'', note:'', updatedAt:now}));
    await updateActionBatch(items, '已清空当前筛选协作状态 ' + actions.length + ' 条');
  });
  document.querySelectorAll('[data-insight-target]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    const key = decodeURIComponent(btn.dataset.insightKey || '');
    const insight = (DATA.insights || []).find(x => insightKey(x) === key);
    focusInsightTarget(insight, btn.dataset.insightTarget || 'business');
  }));
  document.querySelectorAll('[data-export-action-state]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    downloadActionState();
  }));
  document.querySelectorAll('[data-copy-action-summary]').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(actionStateSummaryText());
      showToast('已复制动作协作摘要');
    } catch {
      showToast('复制失败，请手动复制系统状态');
    }
  }));
  const refreshBtn = $('refreshPortalData');
  if (refreshBtn) refreshBtn.addEventListener('click', refreshPortalData);
  const copySystemBtn = $('copySystemStatusSummary');
  if (copySystemBtn) copySystemBtn.addEventListener('click', async e => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(systemStatusSummaryText());
      showToast('已复制系统巡检摘要');
    } catch {
      showToast('复制失败，请手动复制系统状态');
    }
  });
  const runFirstRunCheckBtn = $('runFirstRunCheck');
  if (runFirstRunCheckBtn) runFirstRunCheckBtn.addEventListener('click', runFirstRunCheckFromPortal);
  const copyTeamAccessBtn = $('copyTeamAccessSummary');
  if (copyTeamAccessBtn) copyTeamAccessBtn.addEventListener('click', async e => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(teamAccessSummaryText());
      showToast('已复制团队访问准备度');
    } catch {
      showToast('复制失败，请手动复制团队访问准备度');
    }
  });
}
function showToast(text){
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}
async function refreshPortalData(options = {}){
  const silent = !!options.silent;
  if (actionStateStore.mode !== 'service') {
    if (!silent) showToast('直接打开 HTML 时，请重新打开文件查看最新状态');
    return;
  }
  if (portalRefreshInFlight) return;
  portalRefreshInFlight = true;
  const btn = $('refreshPortalData');
  if (btn) {
    btn.disabled = true;
    btn.textContent = silent ? '自动读取中...' : '读取中...';
  }
  try {
    const res = await fetch('data.json?ts=' + Date.now(), {cache: 'no-store'});
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const next = await res.json();
    DATA = next;
    STORE_CODES = new Set((DATA.stores || []).map(s => s.store_key));
    STORE_CODES_ARRAY = orderedStoreCodes();
    portalDataLastReadAt = new Date();
    renderKpis();
    renderFilters();
    applyStateToControls();
    renderAll();
    const stamp = $('portalDataLastReadAt');
    if (stamp) stamp.textContent = localTimeText(portalDataLastReadAt);
    if (!silent) showToast('已读取最新状态');
  } catch (err) {
    console.warn('refresh portal data failed', err);
    if (!silent) showToast('读取失败，请重新打开门户');
  } finally {
    portalRefreshInFlight = false;
    const freshBtn = $('refreshPortalData');
    if (freshBtn) {
      freshBtn.disabled = false;
      freshBtn.textContent = '重新读取最新状态';
    }
  }
}
let firstRunCheckRefreshInFlight = false;
async function runFirstRunCheckFromPortal(e){
  if (e) e.stopPropagation();
  if (actionStateStore.mode !== 'service') {
    showToast('直接打开 HTML 时，请双击“检查SHEIN-BI自动任务.cmd”生成验收报告');
    return;
  }
  if (firstRunCheckRefreshInFlight) return;
  firstRunCheckRefreshInFlight = true;
  const btn = $('runFirstRunCheck');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '生成中...';
  }
  try {
    const res = await fetch('/api/first-run-check', {method:'POST', cache:'no-store'});
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload.ok) throw new Error(payload.error || payload.run?.stderr || ('HTTP ' + res.status));
    DATA.firstRunCheck = payload.firstRunCheck || DATA.firstRunCheck || {};
    portalDataLastReadAt = new Date();
    renderAll();
    const status = DATA.firstRunCheck?.status === 'error' ? '需处理' : DATA.firstRunCheck?.status === 'warning' ? '有提醒' : '通过';
    showToast('已生成首跑验收报告：' + status);
  } catch (err) {
    showToast('生成验收报告失败：' + (err?.message || String(err || '未知错误')));
  } finally {
    firstRunCheckRefreshInFlight = false;
    const freshBtn = $('runFirstRunCheck');
    if (freshBtn) {
      freshBtn.disabled = false;
      freshBtn.textContent = '重新生成验收报告';
    }
  }
}
function startPortalAutoRefresh(){
  if (portalAutoRefreshTimer || actionStateStore.mode !== 'service') return;
  portalAutoRefreshTimer = window.setInterval(() => {
    if (document.hidden) return;
    if (state.tab !== 'system') return;
    refreshPortalData({silent:true});
  }, 60000);
}
function applyTheme(theme){
  const next = theme === 'light' ? 'light' : 'dark';
  document.body.dataset.theme = next;
  try { localStorage.setItem('SHEIN_BI_THEME', next); } catch {}
  const btn = $('themeToggle');
  if (btn) btn.textContent = next === 'light' ? '切换深色' : '切换浅色';
  const fab = $('themeToggleFab');
  if (fab) fab.textContent = next === 'light' ? '切换深色' : '切换浅色';
}
function initTheme(){
  let saved = '';
  try { saved = localStorage.getItem('SHEIN_BI_THEME') || ''; } catch {}
  if (!saved) saved = window.matchMedia?.('(prefers-color-scheme: light)')?.matches ? 'light' : 'dark';
  applyTheme(saved);
  const btn = $('themeToggle');
  if (btn) btn.addEventListener('click', () => applyTheme(document.body.dataset.theme === 'light' ? 'dark' : 'light'));
  const fab = $('themeToggleFab');
  if (fab) fab.addEventListener('click', () => applyTheme(document.body.dataset.theme === 'light' ? 'dark' : 'light'));
}
document.querySelectorAll('[data-tab]').forEach(btn => btn.addEventListener('click', () => { activateTab(btn.dataset.tab, {scroll:true}); renderAll(); }));
document.querySelectorAll('[data-tab-jump]').forEach(btn => btn.addEventListener('click', () => { activateTab(btn.dataset.tabJump, {scroll:true}); renderAll(); }));
$('q').addEventListener('input', e => { state.q = e.target.value; renderAll(); });
$('productFilter').addEventListener('input', e => { state.product = e.target.value; renderAll(); });
$('storeFilter').addEventListener('change', e => { state.store = e.target.value; renderAll(); });
if ($('homeProductFilter')) $('homeProductFilter').addEventListener('input', e => { state.product = e.target.value; renderAll(); });
if ($('homeStoreFilter')) $('homeStoreFilter').addEventListener('change', e => { state.store = e.target.value; renderAll(); });
$('domainFilter').addEventListener('change', e => { state.domain = e.target.value; if (!isActionFilterTab()) jumpToTab('actions', {keepFilters:true}); else shouldScrollToActiveTab = true; renderAll(); });
$('riskFilter').addEventListener('change', e => { state.risk = e.target.value; if (!isActionFilterTab()) jumpToTab('actions', {keepFilters:true}); else shouldScrollToActiveTab = true; renderAll(); });
$('statusFilter').addEventListener('change', e => { state.status = e.target.value; if (!isActionFilterTab()) jumpToTab('actions', {keepFilters:true}); else shouldScrollToActiveTab = true; renderAll(); });
  $('clearFilters').addEventListener('click', () => {
  state.q = ''; state.product = ''; state.store = ''; state.domain = ''; state.risk = ''; state.status = ''; state.focus = 'all'; state.insight = 'all';
  $('q').value = ''; $('productFilter').value = ''; $('storeFilter').value = ''; if ($('homeProductFilter')) $('homeProductFilter').value = ''; if ($('homeStoreFilter')) $('homeStoreFilter').value = ''; $('domainFilter').value = ''; $('riskFilter').value = ''; $('statusFilter').value = '';
  renderAll();
});
$('copyBriefing').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(briefingText());
    showToast('已复制今日经营简报');
  } catch {
    showToast('复制失败，请手动选择简报文本');
  }
});
$('copyMarkdownBriefing').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(fullBriefingText());
    showToast('已复制完整 Markdown 晨报');
  } catch {
    showToast('复制失败，请展开预览后手动复制');
  }
});
$('copyCurrentView').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(currentViewUrl());
    showToast('已复制当前视图链接');
  } catch {
    showToast('复制失败，请手动复制地址栏链接');
  }
});
['dataFold','detailsFold'].forEach(id => {
  const el = $(id);
  if (el) el.addEventListener('toggle', () => { if (el.open) renderAll(); });
});
$('copyFilteredActions').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(actionListText());
    showToast('已复制当前筛选动作清单');
  } catch {
    showToast('复制失败，请手动选择动作内容');
  }
});
$('exportFilteredActions').addEventListener('click', () => {
  const stamp = localFileStamp();
  downloadTextFile('shein-bi-actions-' + stamp + '.csv', '\\ufeff' + actionListCsv(), 'text/csv;charset=utf-8');
  showToast('已导出当前动作 CSV');
});
document.getElementById('refreshLinkOpsTasks')?.addEventListener('click', refreshLinkOpsTasks);
window.addEventListener('hashchange', () => {
  applyingHash = true;
  stateFromHash();
  applyStateToControls();
  renderAll();
  applyingHash = false;
});
stateFromHash();
initTheme();
renderKpis();
renderFilters();
applyStateToControls();
renderAll();
initServiceHealth();
initActionState();
refreshLinkOpsTasks();
refreshLinkOpsChats();
startPortalAutoRefresh();
</script>
</body>
</html>`;
}

async function main() {
  markStage('main:start');
  const args = parseArgs(process.argv.slice(2));
  markStage('metabase:url');
  const metabaseUrl = (args.metabaseUrl || await readMetabaseUrl() || 'http://localhost:3000').replace(/\/$/, '');
  markStage('read:audit');
  const audit = await readLatestAuditSummary();
  markStage('read:pipeline');
  const pipeline = await readPipelineStatus();
  markStage('read:briefing');
  const briefing = await readLatestBriefingSummary();
  markStage('read:firstRunCheck');
  const firstRunCheck = await readLatestFirstRunCheckSummary();
  const raw = await runPsql(args, buildSql());
  markStage('read:openapiReconciliation');
  const openapiReconciliation = await readOpenApiReconciliation(args);
  markStage('json:parse');
  const parsedData = deepSanitize(JSON.parse(raw));
  parsedData.openapiReconciliation = deepSanitize(openapiReconciliation);
  const data = await attachManualCostFileMeta(await enrichPortalDataWithLocalLinkLabels(parsedData));
  markStage('sanitize');
  const safeAudit = deepSanitize(audit);
  const safePipeline = deepSanitize(pipeline);
  const safeBriefing = deepSanitize(briefing);
  const safeFirstRunCheck = deepSanitize(firstRunCheck);
  markStage('write:mkdir');
  await fs.mkdir(args.outDir, {recursive: true});
  const jsonFile = path.join(args.outDir, 'data.json');
  const htmlFile = path.join(args.outDir, 'index.html');
  markStage('write:data');
  await writeFileWithRetry(jsonFile, JSON.stringify({...data, audit: safeAudit, pipeline: safePipeline, briefing: safeBriefing, firstRunCheck: safeFirstRunCheck}, null, 2), 'utf8');
  markStage('build:html');
  const html = buildHtml(data, metabaseUrl, safeAudit, safePipeline, safeBriefing, safeFirstRunCheck);
  markStage('write:html');
  await writeFileWithRetry(htmlFile, html, 'utf8');
  markStage('done');
  clearTimeout(portalGenerateTimer);
  console.log(JSON.stringify({
    ok: true,
    html: htmlFile,
    data: jsonFile,
    metabaseUrl,
    audit: safeAudit ? {
      file: safeAudit.file || '',
      ok: Boolean(safeAudit.ok),
      warnings: Number(safeAudit.warnings || 0),
      errors: Number(safeAudit.errors || 0),
      generatedAt: safeAudit.generatedAt || null,
    } : null,
    pipeline: safePipeline ? {
      latestLog: safePipeline.latestLog ? {
        file: safePipeline.latestLog.file || '',
        status: safePipeline.latestLog.status || '',
        startedAt: safePipeline.latestLog.startedAt || '',
        endedAt: safePipeline.latestLog.endedAt || '',
        durationSeconds: safePipeline.latestLog.durationSeconds ?? null,
        warningCount: Array.isArray(safePipeline.latestLog.warnings) ? safePipeline.latestLog.warnings.length : Number(safePipeline.latestLog.warningCount || 0),
        effectiveDates: safePipeline.latestLog.effectiveDates || {},
      } : null,
      recentLogCount: Array.isArray(safePipeline.recentLogs) ? safePipeline.recentLogs.length : 0,
      task: safePipeline.task ? {
        exists: Boolean(safePipeline.task.exists),
        TaskName: safePipeline.task.TaskName || '',
        State: safePipeline.task.State || '',
        NextRunTime: safePipeline.task.NextRunTime || '',
        LastRunTime: safePipeline.task.LastRunTime || '',
        LastTaskResult: safePipeline.task.LastTaskResult ?? null,
      } : null,
    } : null,
    briefing: safeBriefing ? {
      exists: Boolean(safeBriefing.exists),
      file: safeBriefing.file || '',
      updatedAt: safeBriefing.updatedAt || null,
      bytes: Number(safeBriefing.bytes || 0),
    } : null,
    firstRunCheck: safeFirstRunCheck ? {
      exists: Boolean(safeFirstRunCheck.exists),
      file: safeFirstRunCheck.file || '',
      updatedAt: safeFirstRunCheck.updatedAt || null,
      status: safeFirstRunCheck.status || '',
      warnings: Number(safeFirstRunCheck.warnings || 0),
      errors: Number(safeFirstRunCheck.errors || 0),
    } : null,
    counts: {
      stores: data.stores?.length || 0,
      products: data.products?.length || 0,
      actions: data.actions?.length || 0,
      links: data.links?.length || 0,
      matrix: data.matrix?.length || 0,
      finance: data.finance?.length || 0,
      financeOrders: data.financeOrders?.length || 0,
      financeGoods: data.financeGoods?.length || 0,
      orders: data.orders?.length || 0,
      afterSales: data.afterSales?.length || 0,
      rtvReview: data.rtvReview?.length || 0,
      rtvTrace: data.rtvTrace?.length || 0,
      waybills: data.waybills?.length || 0,
      campaigns: data.campaigns?.length || 0,
      insights: data.insights?.length || 0,
      openapiReconciliation: data.openapiReconciliation?.length || 0,
    },
  }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

