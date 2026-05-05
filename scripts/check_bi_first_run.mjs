#!/usr/bin/env node
/**
 * Read-only first-run checker for SHEIN BI daily pipeline.
 * It does not run the pipeline and does not modify SHEIN, Feishu, or the database.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TASK_NAME = 'SHEIN-BI-Daily-Pipeline-0640';

function pad(n) { return String(n).padStart(2, '0'); }
function localStamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function localText(d = new Date()) {
  try { return d.toLocaleString('zh-CN', {hour12: false}); } catch { return String(d); }
}
function parseLocalDateTime(text) {
  if (!text || typeof text !== 'string') return null;
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2])-1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  return Number.isNaN(d.getTime()) ? null : d;
}
function minutesBetween(a, b) {
  if (!(a instanceof Date) || !(b instanceof Date)) return null;
  return Math.round((b.getTime() - a.getTime()) / 60000);
}
function secondsBetween(a, b) {
  if (!(a instanceof Date) || !(b instanceof Date)) return null;
  return Math.round((b.getTime() - a.getTime()) / 1000);
}
function statusText(code) {
  const n = Number(code);
  if (n === 0) return '成功';
  if (n === 267009) return '正在运行';
  if (n === 267011) return '尚未运行';
  if (Number.isFinite(n)) return `结果码 ${n}`;
  return '-';
}
function isPendingFirstRun(task) {
  return !!(task?.exists && String(task.LastRunTime || '').startsWith('1999-'));
}
function isTaskRunning(task) {
  return !!(task?.exists && (String(task.State || '').toLowerCase() === 'running' || Number(task.LastTaskResult) === 267009));
}
async function run(command, args = [], options = {}) {
  const timeoutMs = Number(options.timeoutMs || 15_000);
  const child = spawn(command, args, {cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  child.stdout.on('data', d => stdout += d.toString());
  child.stderr.on('data', d => stderr += d.toString());
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill(); } catch {}
  }, timeoutMs);
  const code = await new Promise(resolve => child.on('close', resolve));
  clearTimeout(timer);
  return {code, stdout: stdout.trim(), stderr: stderr.trim(), timedOut};
}
async function readTask() {
  const ps = [
    '$ErrorActionPreference="Stop"',
    `$name="${TASK_NAME}"`,
    '$t=Get-ScheduledTask -TaskName $name',
    '$i=Get-ScheduledTaskInfo -TaskName $name',
    '$next=if($i.NextRunTime){$i.NextRunTime.ToString("yyyy-MM-dd HH:mm:ss")}else{""}',
    '$last=if($i.LastRunTime){$i.LastRunTime.ToString("yyyy-MM-dd HH:mm:ss")}else{""}',
    '$nextMs=if($i.NextRunTime){([DateTimeOffset]$i.NextRunTime).ToUnixTimeMilliseconds()}else{$null}',
    '$lastMs=if($i.LastRunTime){([DateTimeOffset]$i.LastRunTime).ToUnixTimeMilliseconds()}else{$null}',
    '$o=[pscustomobject]@{TaskName=$t.TaskName;State=([string]$t.State);NextRunTime=$next;NextRunEpochMs=$nextMs;LastRunTime=$last;LastRunEpochMs=$lastMs;LastTaskResult=$i.LastTaskResult}',
    '$o | ConvertTo-Json -Compress'
  ].join(';');
  try {
    const res = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {timeoutMs: 8_000});
    if (res.timedOut) return await readTaskViaSchtasks('PowerShell 读取 Windows 计划任务超时');
    if (res.code !== 0 || !res.stdout) return {exists:false, error: res.stderr || `exit ${res.code}`};
    return {exists:true, ...JSON.parse(res.stdout)};
  } catch (err) {
    return await readTaskViaSchtasks(String(err.message || err));
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
  const d = parseLocalDateTime(normalized);
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d.getTime() : null;
}
async function readTaskViaSchtasks(reason = '') {
  try {
    const res = await run('cmd.exe', ['/c', 'schtasks /query /tn SHEIN-BI-Daily-Pipeline-0640 /v /fo csv'], {timeoutMs: 8_000});
    if (res.code !== 0 || !res.stdout) return {exists:false, error: reason || res.stderr || `schtasks exit ${res.code}`};
    const lines = res.stdout.split(/\r?\n/).filter(Boolean);
    const cols = parseCsvPrefix(lines[1] || '', 8);
    const taskName = String(cols[1] || '').replace(/^\\+/, '') || TASK_NAME;
    const nextRun = normalizeSchtasksDate(cols[2] || '');
    const lastRun = normalizeSchtasksDate(cols[5] || '');
    const lastResult = Number(cols[6]);
    const state = inferTaskState(normalizeTaskState(cols[3] || ''), nextRun, lastResult);
    return {
      exists:true,
      fallback:'schtasks',
      fallbackReason: reason || '',
      TaskName: taskName,
      State: state,
      NextRunTime: nextRun,
      NextRunEpochMs: epochMsFromLocalText(nextRun),
      LastRunTime: lastRun,
      LastRunEpochMs: epochMsFromLocalText(lastRun),
      LastTaskResult: Number.isFinite(lastResult) ? lastResult : null
    };
  } catch (err) {
    return {exists:false, error: reason || String(err.message || err)};
  }
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
  return zeros > sample.length * 0.2 ? buf.toString('utf16le') : buf.toString('utf8');
}
function parseLog(file, text, stat) {
  const times = [...String(text || '').matchAll(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/g)].map(m => m[1]);
  const effective = text.match(/effective dates salesDate=(\d{4}-\d{2}-\d{2}) linkDate=(\d{4}-\d{2}-\d{2}) businessDate=(\d{4}-\d{2}-\d{2})/);
  const warnings = text.split(/\r?\n/).filter(x => /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]\s+WARN\b/.test(x));
  const ok = /DONE BI daily pipeline/.test(text) && !/FAIL /.test(text);
  const failed = /FAIL /.test(text);
  return {
    file,
    status: ok ? 'success' : failed ? 'failed' : 'running_or_incomplete',
    startedAt: times[0] || '',
    endedAt: times[times.length - 1] || '',
    effectiveDates: effective ? {salesDate: effective[1], linkDate: effective[2], businessDate: effective[3]} : {},
    warningCount: warnings.length,
    latestWarning: warnings[warnings.length - 1] || '',
    modifiedAt: stat.mtime.toISOString(),
    bytes: stat.size
  };
}
async function latestLogs(limit = 8) {
  const dir = path.join(ROOT, 'logs');
  try {
    const names = (await fs.readdir(dir)).filter(x => /^bi-daily-pipeline-.*\.log$/i.test(x));
    const rows = [];
    for (const name of names) {
      const file = path.join(dir, name);
      const stat = await fs.stat(file);
      rows.push({name, file, stat});
    }
    // The timestamp in the file name is the pipeline start time.  A scheduled
    // run that hangs can be modified much later than a successful manual
    // verification run, so mtime would make the older scheduled run look like
    // the "latest" pipeline.  Sort by file name/start timestamp instead.
    rows.sort((a,b) => b.name.localeCompare(a.name));
    const out = [];
    for (const row of rows.slice(0, limit)) {
      const text = await readTextAuto(row.file);
      out.push(parseLog(row.name, text, row.stat));
    }
    return out;
  } catch {
    return [];
  }
}
async function latestAudit() {
  const dir = path.join(ROOT, 'outputs', 'bi_audit');
  try {
    const names = (await fs.readdir(dir)).filter(x => /^bi-audit-.*\.json$/i.test(x)).sort().reverse();
    if (!names.length) return null;
    const file = path.join(dir, names[0]);
    const j = JSON.parse(await fs.readFile(file, 'utf8'));
    const warnings = Array.isArray(j.warnings) ? j.warnings : (Array.isArray(j.evaluation?.warnings) ? j.evaluation.warnings : []);
    const errors = Array.isArray(j.errors) ? j.errors : (Array.isArray(j.evaluation?.errors) ? j.evaluation.errors : []);
    return {file:names[0], ok:!!j.ok, warnings:warnings.length, errors:errors.length, warningMessages:warnings, errorMessages:errors};
  } catch {
    return null;
  }
}
async function portalStatus() {
  const html = path.join(ROOT, 'outputs', 'bi-portal', 'index.html');
  const data = path.join(ROOT, 'outputs', 'bi-portal', 'data.json');
  const out = {};
  for (const [key, file] of Object.entries({html, data})) {
    try {
      const stat = await fs.stat(file);
      out[key] = {exists:true, file:path.relative(ROOT, file), modifiedAt:stat.mtime.toISOString(), bytes:stat.size};
    } catch (err) {
      out[key] = {exists:false, file:path.relative(ROOT, file), error:String(err.message || err)};
    }
  }
  return out;
}

async function scheduledEntryDryRun() {
  const script = path.join(ROOT, 'scripts', 'scheduled_bi_daily_pipeline.ps1');
  try {
    const res = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-DryRun'], {timeoutMs: 20_000});
    const base = {
      checkedAt: localText(),
      script: path.relative(ROOT, script),
      exitCode: res.code,
      timedOut: res.timedOut,
      stderr: res.stderr || ''
    };
    if (res.timedOut) return {...base, ok:false, error:'scheduled entry dry-run timed out'};
    if (res.code !== 0) return {...base, ok:false, error:res.stderr || `exit ${res.code}`};
    try {
      const parsed = JSON.parse(res.stdout);
      return {
        ...base,
        ...parsed,
        ok: !!parsed.ok,
        repo: ROOT,
        pipelineScript: path.join(ROOT, 'scripts', 'run_bi_daily_pipeline.ps1')
      };
    } catch (err) {
      return {...base, ok:false, error:`dry-run JSON parse failed: ${err.message}`, stdout:res.stdout};
    }
  } catch (err) {
    return {ok:false, checkedAt:localText(), script:path.relative(ROOT, script), error:String(err.message || err)};
  }
}

function findScheduledRunLog(task, recentLogs = []) {
  const lastRun = task?.LastRunEpochMs ? new Date(Number(task.LastRunEpochMs)) : parseLocalDateTime(task?.LastRunTime || '');
  if (!(lastRun instanceof Date) || Number.isNaN(lastRun.getTime())) return null;
  const candidates = [];
  for (const log of recentLogs) {
    const started = parseLocalDateTime(log.startedAt || '');
    if (!(started instanceof Date) || Number.isNaN(started.getTime())) continue;
    const deltaSeconds = secondsBetween(lastRun, started);
    const absDeltaSeconds = Math.abs(deltaSeconds);
    if (absDeltaSeconds <= 15 * 60) {
      candidates.push({...log, taskDeltaSeconds: deltaSeconds, taskDeltaText: `${deltaSeconds >= 0 ? '+' : ''}${deltaSeconds}s`});
    }
  }
  candidates.sort((a, b) => Math.abs(a.taskDeltaSeconds) - Math.abs(b.taskDeltaSeconds));
  return candidates[0] || null;
}

function classifyLatestLogRelation(task, latestLog = {}) {
  const lastRun = task?.LastRunEpochMs ? new Date(Number(task.LastRunEpochMs)) : parseLocalDateTime(task?.LastRunTime || '');
  const latestStarted = parseLocalDateTime(latestLog.startedAt || '');
  if (!(lastRun instanceof Date) || Number.isNaN(lastRun.getTime()) || !(latestStarted instanceof Date) || Number.isNaN(latestStarted.getTime())) {
    return {kind:'unknown', deltaSeconds:null, text:'无法判断'};
  }
  const deltaSeconds = secondsBetween(lastRun, latestStarted);
  if (Math.abs(deltaSeconds) <= 15 * 60) return {kind:'scheduled', deltaSeconds, text:'对应正式自动任务'};
  if (deltaSeconds > 15 * 60) return {kind:'manual_after_task', deltaSeconds, text:'晚于正式任务，可能是手动验证'};
  return {kind:'before_task', deltaSeconds, text:'早于正式任务'};
}

function verdict({task, recentLogs = [], scheduledRunLog, scheduledDryRun, audit, portal}) {
  const logs = recentLogs;
  const now = new Date();
  const nextRun = task?.NextRunEpochMs ? new Date(Number(task.NextRunEpochMs)) : parseLocalDateTime(task?.NextRunTime || '');
  const lastRun = task?.LastRunEpochMs ? new Date(Number(task.LastRunEpochMs)) : parseLocalDateTime(task?.LastRunTime || '');
  const pending = isPendingFirstRun(task);
  const running = isTaskRunning(task);
  const latest = logs[0] || {};
  const scheduled = scheduledRunLog || null;
  const targetLog = scheduled || latest;
  const targetStarted = parseLocalDateTime(targetLog.startedAt || '');
  const targetEnded = parseLocalDateTime(targetLog.endedAt || '');
  const errors = [];
  const warnings = [];
  let status = 'ok';
  if (!task?.exists) errors.push(`计划任务未找到：${task?.error || TASK_NAME}`);
  if (pending && nextRun && now < nextRun) warnings.push(`尚未到首次运行时间，距离 ${task.NextRunTime} 约 ${minutesBetween(now, nextRun)} 分钟。`);
  if (pending && nextRun && now >= nextRun) errors.push(`已过计划时间 ${task.NextRunTime}，但计划任务仍显示尚未首跑。`);
  if (running) warnings.push('计划任务正在运行，稍后重新生成验收报告再看最终结果。');
  if (!pending && !running && Number(task.LastTaskResult) !== 0) errors.push(`计划任务上次结果不是成功：${statusText(task.LastTaskResult)}。`);
  if (!pending && !running && lastRun instanceof Date && !Number.isNaN(lastRun.getTime())) {
    if (!scheduled) {
      warnings.push(`未在最近流水线中找到与计划任务上次运行时间 ${task.LastRunTime || '-'} 对应的日志；最新日志可能是手动验证。`);
    } else if (scheduled.status !== 'success') {
      errors.push(`计划任务对应流水线不是成功状态：${scheduled.file} / ${scheduled.status}。`);
    }
    if (targetLog.file && (!(targetStarted instanceof Date) || Number.isNaN(targetStarted.getTime()))) {
      errors.push(`计划任务已运行，但对应流水线日志没有解析到开始时间：${targetLog.file}。`);
    } else if (targetLog.file && Math.abs(secondsBetween(lastRun, targetStarted)) > 15 * 60) {
      warnings.push(`当前用于判断的流水线日志不在计划任务运行时间附近：任务 ${task.LastRunTime}，日志 ${targetLog.file} / ${targetLog.startedAt}。`);
    }
    if (targetLog.file && (!(targetEnded instanceof Date) || Number.isNaN(targetEnded.getTime()))) {
      errors.push(`计划任务已运行，但对应流水线日志没有解析到结束时间：${targetLog.file}。`);
    }
  }
  if (!scheduled && latest.status && latest.status !== 'success') {
    if (running && latest.status !== 'failed') warnings.push(`最新流水线尚未结束：${latest.file} / ${latest.status}。`);
    else errors.push(`最新流水线不是成功状态：${latest.file} / ${latest.status}。`);
  }
  if (!latest.file) warnings.push('未找到 BI 流水线日志。');
  if (audit && audit.errors) errors.push(`最新 BI 体检有 ${audit.errors} 个错误。`);
  if (audit && audit.warnings) warnings.push(`最新 BI 体检有 ${audit.warnings} 个提醒。`);
  if (!portal?.html?.exists || !portal?.data?.exists) errors.push('门户 index.html 或 data.json 不存在。');
  if (!scheduledDryRun?.ok) {
    errors.push(`计划任务入口 dry-run 失败：${scheduledDryRun?.error || scheduledDryRun?.stderr || 'unknown error'}。`);
  } else {
    const dates = [scheduledDryRun.salesDate, scheduledDryRun.linkDate, scheduledDryRun.businessDate].filter(Boolean);
    if (dates.length !== 3) warnings.push('计划任务入口 dry-run 没有返回完整日期口径。');
    else if (new Set(dates).size !== 1) errors.push(`计划任务入口 dry-run 日期口径不一致：${dates.join(' / ')}。`);
    if (!String(scheduledDryRun.pipelineScript || '').toLowerCase().endsWith('scripts\\run_bi_daily_pipeline.ps1'.toLowerCase())) {
      errors.push(`计划任务入口 dry-run 指向的流水线脚本异常：${scheduledDryRun.pipelineScript || '-'}。`);
    }
  }
  if (errors.length) status = 'error';
  else if (warnings.length) status = 'warning';
  return {status, errors, warnings};
}
function recoveryStatus({task, latestLog = {}, latestLogRelation = {}, scheduledRunLog, scheduledDryRun, audit, portal, verdict: v}) {
  const taskFailed = !!(task?.exists && !isPendingFirstRun(task) && !isTaskRunning(task) && Number(task.LastTaskResult) !== 0);
  const scheduledLogFailed = !!(scheduledRunLog?.status && scheduledRunLog.status !== 'success');
  const latestManualSuccess = latestLog?.status === 'success' && latestLogRelation?.kind === 'manual_after_task';
  const entryOk = !!scheduledDryRun?.ok;
  const auditOk = !!audit?.ok && Number(audit?.errors || 0) === 0;
  const portalOk = !!portal?.html?.exists && !!portal?.data?.exists;
  if ((taskFailed || scheduledLogFailed) && latestManualSuccess && entryOk && auditOk && portalOk) {
    return {
      level: 'pending_next_auto',
      title: '已修复，待下次正式自动验证',
      summary: '正式自动任务上次仍失败，但入口 dry-run、最新手动轻量流水线、BI 体检和门户刷新均已通过。',
      evidence: [
        `正式任务结果：${statusText(task.LastTaskResult)}`,
        `正式任务日志：${scheduledRunLog?.file || '-' } / ${scheduledRunLog?.status || '-'}`,
        `手动验证日志：${latestLog.file || '-'} / ${latestLog.status || '-'}`,
        `入口 dry-run：${entryOk ? '通过' : '失败'}`,
        `体检：${auditOk ? '通过' : '需检查'}`
      ],
      next: `等待下一次正式自动运行 ${task.NextRunTime || '06:40'}；若成功，计划任务结果应恢复为成功。`
    };
  }
  if (v?.status === 'ok') {
    return {
      level: 'ok',
      title: '正式自动任务通过',
      summary: '计划任务、对应流水线、体检和门户均未发现阻断问题。',
      evidence: [],
      next: '继续按每日自动刷新观察。'
    };
  }
  if (isTaskRunning(task)) {
    return {
      level: 'running',
      title: '正式自动任务运行中',
      summary: '计划任务仍在运行，稍后重新生成验收报告。',
      evidence: [],
      next: '等待任务结束后刷新系统状态页。'
    };
  }
  return {
    level: v?.status === 'warning' ? 'warning' : 'error',
    title: v?.status === 'warning' ? '有提醒，需复核' : '需处理',
    summary: '仍存在需要处理或复核的问题。',
    evidence: [],
    next: '查看结论明细中的错误和提醒。'
  };
}
function logLine(log) {
  if (!log?.file) return '- 日志：-';
  return [
    `- 日志：${log.file}`,
    `- 状态：${log.status || '-'}`,
    `- 开始：${log.startedAt || '-'}`,
    `- 结束：${log.endedAt || '-'}`,
    `- WARN：${log.warningCount ?? '-'}`,
    `- 口径：${[log.effectiveDates?.salesDate, log.effectiveDates?.linkDate, log.effectiveDates?.businessDate].filter(Boolean).join(' / ') || '-'}`
  ].join('\n');
}

function markdown(summary) {
  const {generatedAt, task, latestLog, latestLogRelation, scheduledRunLog, scheduledDryRun, recovery, recentLogs, audit, portal, verdict: v} = summary;
  const latestIsScheduled = latestLog?.file && scheduledRunLog?.file && latestLog.file === scheduledRunLog.file;
  const lines = [
    '# SHEIN BI 首跑验收',
    '',
    `- 生成时间：${generatedAt}`,
    `- 结论：${v.status === 'ok' ? '通过' : v.status === 'warning' ? '有提醒' : '需处理'}`,
    `- 恢复状态：${recovery?.title || '-'}`,
    `- 下一步：${recovery?.next || '-'}`,
    '',
    '## 自动任务',
    '',
    `- 任务：${task.TaskName || TASK_NAME}`,
    `- 状态：${task.State || '-'}`,
    `- 下次运行：${task.NextRunTime || '-'}`,
    `- 上次运行：${isPendingFirstRun(task) ? '尚未首跑' : (task.LastRunTime || '-')}`,
    `- 上次结果：${isPendingFirstRun(task) ? '待首次运行' : statusText(task.LastTaskResult)}`,
    '',
    '## 计划任务入口 dry-run',
    '',
    `- 结果：${scheduledDryRun?.ok ? '通过' : '失败'}`,
    `- 脚本：${scheduledDryRun?.script || 'scripts\\scheduled_bi_daily_pipeline.ps1'}`,
    `- 流水线：${scheduledDryRun?.pipelineScript || '-'}`,
    `- 日期口径：${[scheduledDryRun?.salesDate, scheduledDryRun?.linkDate, scheduledDryRun?.businessDate].filter(Boolean).join(' / ') || '-'}`,
    `- 说明：${scheduledDryRun?.note || scheduledDryRun?.error || '-'}`,
    '',
    '## 正式自动任务对应流水线',
    '',
    scheduledRunLog?.file ? logLine(scheduledRunLog) : `- 未找到与上次运行时间 ${task.LastRunTime || '-'} 对应的流水线日志。`,
    scheduledRunLog?.taskDeltaText ? `- 与计划任务开始时间差：${scheduledRunLog.taskDeltaText}` : '',
    '',
    latestIsScheduled ? '## 最新流水线' : '## 最新流水线（可能是手动验证）',
    '',
    logLine(latestLog),
    `- 与正式任务关系：${latestLogRelation?.text || '-'}`,
    '',
    '## 体检与门户',
    '',
    `- 体检文件：${audit?.file || '-'}`,
    `- 体检结果：${audit?.ok ? '通过' : '需检查'}；提醒 ${audit?.warnings ?? '-'}；错误 ${audit?.errors ?? '-'}`,
    `- 门户 HTML：${portal.html.exists ? '存在' : '缺失'}；${portal.html.file}`,
    `- 门户数据：${portal.data.exists ? '存在' : '缺失'}；${portal.data.file}`,
    '',
    '## 结论明细',
    ''
  ].filter(x => x !== '');
  if (v.errors.length) lines.push('### 错误', '', ...v.errors.map(x => `- ${x}`), '');
  if (v.warnings.length) lines.push('### 提醒', '', ...v.warnings.map(x => `- ${x}`), '');
  if (!v.errors.length && !v.warnings.length) lines.push('- 当前没有错误或提醒。', '');
  lines.push('## 最近记录', '', ...recentLogs.slice(0, 8).map(x => `- ${x.file}：${x.status}；${x.startedAt || '-'}；WARN ${x.warningCount || 0}`), '');
  return lines.join('\n');
}

async function main() {
  const [task, recentLogs, audit, portal, scheduledDryRun] = await Promise.all([readTask(), latestLogs(20), latestAudit(), portalStatus(), scheduledEntryDryRun()]);
  const latestLog = recentLogs[0] || {};
  const scheduledRunLog = findScheduledRunLog(task, recentLogs);
  const summary = {
    generatedAt: localText(),
    task,
    latestLog,
    latestLogRelation: classifyLatestLogRelation(task, latestLog),
    scheduledRunLog,
    scheduledDryRun,
    recentLogs,
    audit,
    portal
  };
  summary.verdict = verdict(summary);
  summary.recovery = recoveryStatus(summary);
  if (summary.recovery?.level === 'pending_next_auto' && summary.verdict.status === 'error') {
    summary.verdict = {
      status: 'warning',
      errors: [],
      warnings: [
        ...summary.verdict.errors.map(x => `今日自动任务失败但已手动恢复，保留到明天自动验证：${x}`),
        ...summary.verdict.warnings,
      ],
    };
  }
  const outDir = path.join(ROOT, 'outputs', 'bi_first_run_check');
  await fs.mkdir(outDir, {recursive:true});
  const stamp = localStamp();
  const jsonFile = path.join(outDir, `bi-first-run-check-${stamp}.json`);
  const mdFile = path.join(outDir, `bi-first-run-check-${stamp}.md`);
  const latestJson = path.join(outDir, 'latest.json');
  const latestMd = path.join(outDir, 'latest.md');
  const md = markdown(summary);
  await fs.writeFile(jsonFile, JSON.stringify(summary, null, 2), 'utf8');
  await fs.writeFile(latestJson, JSON.stringify(summary, null, 2), 'utf8');
  await fs.writeFile(mdFile, md, 'utf8');
  await fs.writeFile(latestMd, md, 'utf8');
  console.log(JSON.stringify({ok: summary.verdict.status !== 'error', status: summary.verdict.status, json: jsonFile, markdown: mdFile, latestJson, latestMd, errors: summary.verdict.errors, warnings: summary.verdict.warnings}, null, 2));
  if (summary.verdict.status === 'error') process.exitCode = 2;
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
