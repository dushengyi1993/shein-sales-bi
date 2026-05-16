#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_STATE_DIR = path.join(ROOT, 'state', 'cloud_ops_watchdog');
const DEFAULT_LOG_DIR = process.env.SHEIN_CLOUD_WATCHDOG_LOG_DIR || '/srv/shein-bi/logs/cloud-watchdog';
const UNIT_NAMES = [
  'shein-bi-cloud-today.service',
  'shein-bi-cloud-yesterday.service',
  'shein-bi-db-backup.service',
  'shein-bi-cloud-et-forwarder.service',
  'shein-bi-cloud-link-business.service',
  'shein-bi-cloud-daily-lark-report.service',
  'shein-bi-cloud-openapi-hl.service',
  'shein-bi-cloud-rtv-verify.service',
];
const TIMER_NAMES = [
  'shein-bi-cloud-today.timer',
  'shein-bi-cloud-yesterday.timer',
  'shein-bi-db-backup.timer',
  'shein-bi-cloud-et-forwarder.timer',
  'shein-bi-cloud-link-business.timer',
  'shein-bi-cloud-daily-lark-report.timer',
  'shein-bi-cloud-openapi-hl.timer',
  'shein-bi-cloud-rtv-verify.timer',
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
    const child = spawn(command, args, {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], ...options});
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('error', err => resolve({ok: false, code: -1, stdout, stderr: String(err?.stack || err)}));
    child.on('close', code => resolve({ok: code === 0, code, stdout, stderr}));
  });
}

async function systemctlShow(name) {
  const res = await run('systemctl', ['show', name, '--no-pager', '--property=LoadState,ActiveState,SubState,Result,ExecMainStatus,StateChangeTimestamp,ExecMainStartTimestamp,ExecMainExitTimestamp']);
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
  const units = [];
  for (const unit of UNIT_NAMES) {
    const status = await systemctlShow(unit);
    units.push(status);
    if (status.LoadState === 'not-found') continue;
    if (status.ActiveState === 'failed' || (status.Result && !['success', ''].includes(status.Result))) {
      issues.push(`服务异常：${unit} state=${status.ActiveState || '-'} result=${status.Result || '-'} exit=${status.ExecMainStatus || '-'}`);
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

  const report = {
    ok: issues.length === 0,
    generatedAt: new Date().toISOString(),
    issues,
    portal,
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
  if (issues.length && (args.force || issueKey !== previous)) {
    const text = issues.slice(0, 12).join('\n');
    notifyResult = await notify(args, text, logFile);
    notified = notifyResult.ok;
    if (notifyResult.ok) await fs.writeFile(stateFile, issueKey, 'utf8');
  } else if (!issues.length) {
    await fs.writeFile(stateFile, 'OK', 'utf8');
  }

  console.log(JSON.stringify({...report, logFile, notified, notifyCode: notifyResult?.code ?? null}, null, 2));
  if (issues.length) process.exitCode = args.dryRun ? 0 : 1;
}

main().catch(err => {
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});
