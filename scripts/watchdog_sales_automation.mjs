#!/usr/bin/env node
/**
 * Watchdog for SHEIN sales automation.
 *
 * Runs at Windows user logon. It is intentionally idempotent:
 * - infer the latest successful previous-day final sync from checkpoint/logs;
 * - catch up missing final days up to yesterday;
 * - optionally run one current-day intraday sync;
 * - send a Lark alert if recovery fails.
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECKPOINT_PATH = path.join(ROOT, 'state', 'shein_sync_checkpoint.json');
const REPORT_CONFIG_PATH = path.join(ROOT, 'config', 'lark_report.json');
const JOB_LOG_DIR = path.join(ROOT, 'logs', 'jobs');

function parseArgs(argv) {
  const args = {group: 'DSY', syncToday: true, sendAlert: true, maxCatchupDays: 14};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--group') args.group = argv[++i].toUpperCase();
    else if (a === '--no-sync-today') args.syncToday = false;
    else if (a === '--sync-today') args.syncToday = true;
    else if (a === '--no-alert') args.sendAlert = false;
    else if (a === '--send-alert') args.sendAlert = true;
    else if (a === '--max-catchup-days') args.maxCatchupDays = Number(argv[++i]);
  }
  return args;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function bjDate(offsetDays = 0) {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const bj = new Date(utc + 8 * 3600_000);
  bj.setDate(bj.getDate() + offsetDays);
  return `${bj.getFullYear()}-${pad2(bj.getMonth() + 1)}-${pad2(bj.getDate())}`;
}
function addDays(date, n) { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth()+1)}-${pad2(d.getUTCDate())}`; }
function eachDateExclusiveAfter(start, end) { const out=[]; if (!start) return out; let d=addDays(start,1); while (d <= end) { out.push(d); d=addDays(d,1); } return out; }

async function readJson(file, fallback = null) {
  try { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (err) { if (err.code === 'ENOENT') return fallback; throw err; }
}
async function writeJson(file, obj) { await fs.mkdir(path.dirname(file), {recursive:true}); await fs.writeFile(file, JSON.stringify(obj, null, 2), 'utf8'); }

function parseFirstJson(text) {
  const s = String(text || '').trim();
  const starts = [s.indexOf('{'), s.indexOf('[')].filter(i => i >= 0);
  if (!starts.length) return null;
  try { return JSON.parse(s.slice(Math.min(...starts))); } catch { return null; }
}

function runNode(script, args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {cwd: ROOT, stdio:['ignore','pipe','pipe']});
    let stdout='', stderr='';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
    child.on('close', code => resolve({ok: code === 0, code, stdout, stderr, parsed: parseFirstJson(stdout)}));
    child.on('error', err => resolve({ok:false, code:-1, stdout, stderr:String(err.stack || err)}));
  });
}

function jobArgsForGroup(group, mode, extra = []) {
  const args = ['--mode', mode, '--group', group, ...extra];
  // Watchdog may run DSY and LGM separately. Do not refresh derived display
  // tables or dashboard inside one group run, otherwise a successful group could
  // publish a half-new / half-stale view while the other group failed. The outer
  // scheduled wrapper refreshes monthly/compact/dashboard once both groups pass.
  args.push('--no-monthly', '--no-compact-display', '--no-dashboard');
  return args;
}

function runLark(args) {
  return new Promise(resolve => {
    const child = spawn('lark-cli', args, {cwd: ROOT, stdio:['ignore','pipe','pipe']});
    let stdout='', stderr='';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
    child.on('close', code => resolve({ok: code === 0, code, stdout, stderr, parsed: parseFirstJson(stdout)}));
    child.on('error', err => resolve({ok:false, code:-1, stdout, stderr:String(err.stack || err)}));
  });
}

async function inferFromJobLogs(group) {
  const out = {lastFinalDate: null, lastIntradayDate: null};
  let files = [];
  try { files = fssync.readdirSync(JOB_LOG_DIR).filter(n => n.endsWith('.json')).map(n => path.join(JOB_LOG_DIR, n)); } catch {}
  for (const file of files) {
    let job = null;
    try { job = JSON.parse(fssync.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { continue; }
    if (job.group !== group || job.finalStatus !== 'done' || !job.date) continue;
    if (job.mode === 'intraday') out.lastIntradayDate = !out.lastIntradayDate || job.date > out.lastIntradayDate ? job.date : out.lastIntradayDate;
    if (job.mode === 'yesterday-final' || /最终/.test(job.status || '')) out.lastFinalDate = !out.lastFinalDate || job.date > out.lastFinalDate ? job.date : out.lastFinalDate;
  }
  return out;
}

async function sendAlertIfNeeded(args, text) {
  if (!args.sendAlert || !text) return {skipped: true};
  const cfg = await readJson(REPORT_CONFIG_PATH, {});
  const recipient = cfg.recipientUserId;
  const identity = cfg.defaultIdentity || 'bot';
  if (!recipient) return {skipped: true, reason: 'missing recipientUserId'};
  const res = await runLark(['im','+messages-send','--as',identity,'--user-id',recipient,'--text',text]);
  return {ok: res.ok, code: res.code, stderrTail: res.stderr.slice(-1000), stdoutTail: res.stdout.slice(-1000)};
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const today = bjDate(0);
  const yesterday = bjDate(-1);
  const checkpoint = await readJson(CHECKPOINT_PATH, {version:1, groups:{}});
  checkpoint.groups ||= {};
  checkpoint.groups[args.group] ||= {};
  const groupCp = checkpoint.groups[args.group];
  const inferred = await inferFromJobLogs(args.group);
  if (!groupCp.lastFinalDate && inferred.lastFinalDate) groupCp.lastFinalDate = inferred.lastFinalDate;
  if (!groupCp.lastIntradayDate && inferred.lastIntradayDate) groupCp.lastIntradayDate = inferred.lastIntradayDate;
  if (!groupCp.lastFinalDate) groupCp.lastFinalDate = yesterday;

  let catchupDates = eachDateExclusiveAfter(groupCp.lastFinalDate, yesterday);
  if (catchupDates.length > args.maxCatchupDays) catchupDates = catchupDates.slice(-args.maxCatchupDays);

  const result = {
    ok: true,
    group: args.group,
    startedAt: new Date().toISOString(),
    today,
    yesterday,
    inferred,
    checkpointBefore: {...groupCp},
    catchupDates,
    catchupResults: [],
    todaySync: null,
    alert: null,
  };

  for (const date of catchupDates) {
    const run = await runNode('run_sales_sync_job.mjs', jobArgsForGroup(args.group, 'yesterday-final', ['--date', date, '--status', '前日最终版']));
    result.catchupResults.push({date, ok: run.ok, code: run.code, parsed: run.parsed, stderrTail: run.stderr.slice(-2000), stdoutTail: run.stdout.slice(-2000)});
    if (run.ok) groupCp.lastFinalDate = date;
    else result.ok = false;
    await writeJson(CHECKPOINT_PATH, {...checkpoint, updatedAt:new Date().toISOString()});
  }

  if (args.syncToday) {
    const run = await runNode('run_sales_sync_job.mjs', jobArgsForGroup(args.group, 'intraday'));
    result.todaySync = {date: today, ok: run.ok, code: run.code, parsed: run.parsed, stderrTail: run.stderr.slice(-2000), stdoutTail: run.stdout.slice(-2000)};
    if (run.ok) groupCp.lastIntradayDate = today;
    else result.ok = false;
  }

  groupCp.lastWatchdogAt = new Date().toISOString();
  checkpoint.updatedAt = groupCp.lastWatchdogAt;
  await writeJson(CHECKPOINT_PATH, checkpoint);
  result.checkpointAfter = {...groupCp};
  result.finishedAt = new Date().toISOString();

  if (!result.ok) {
    const failedDates = result.catchupResults.filter(r => !r.ok).map(r => r.date);
    const loginRequired = [
      ...new Set([
        ...(result.catchupResults.flatMap(r => r.parsed?.loginRequiredStores || [])),
        ...(result.todaySync?.parsed?.loginRequiredStores || []),
      ]),
    ];
    const failedStores = [
      ...new Set([
        ...(result.catchupResults.flatMap(r => (r.parsed?.failedStores || []).map(x => x.storeKey))),
        ...((result.todaySync?.parsed?.failedStores || []).map(x => x.storeKey)),
      ]),
    ];
    const msg = [
      '【SHEIN 自动化恢复失败】',
      `时间：${new Date().toLocaleString('zh-CN', {timeZone:'Asia/Shanghai', hour12:false})}`,
      `分组：${args.group}`,
      failedDates.length ? `补跑失败日期：${failedDates.join(', ')}` : null,
      result.todaySync && !result.todaySync.ok ? `今日同步失败：${today}` : null,
      loginRequired.length ? `需要重新登录店铺：${loginRequired.join(', ')}` : null,
      failedStores.length && !loginRequired.length ? `失败店铺：${failedStores.join(', ')}` : null,
      '请打开工作区 logs/jobs/watchdog-*.json 查看详情。',
    ].filter(Boolean).join('\n');
    result.alert = await sendAlertIfNeeded(args, msg);
  }

  await fs.mkdir(JOB_LOG_DIR, {recursive:true});
  const logFile = path.join(JOB_LOG_DIR, `watchdog-${new Date().toISOString().replace(/[:.]/g, '-')}-${args.group}.json`);
  await writeJson(logFile, result);
  console.log(JSON.stringify({...result, logFile: path.relative(ROOT, logFile)}, null, 2));
  if (!result.ok) process.exitCode = 1;
}

await main();
