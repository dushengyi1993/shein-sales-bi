#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_CONFIG_PATH = path.join(ROOT, 'config', 'lark_report.json');
const OUT_DIR = process.env.SHEIN_SYNC_ISSUE_OUT_DIR || path.join(ROOT, 'outputs', 'sync_issue_alerts');

function parseArgs(argv) {
  const args = {
    kind: 'sync',
    mode: '',
    date: '',
    failedStores: '',
    loginRequiredStores: '',
    message: '',
    logFile: '',
    title: '',
    idempotencyKey: '',
    dryRun: false,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--kind') args.kind = argv[++i] || args.kind;
    else if (a === '--mode') args.mode = argv[++i] || '';
    else if (a === '--date') args.date = argv[++i] || '';
    else if (a === '--failed-stores') args.failedStores = argv[++i] || '';
    else if (a === '--login-required-stores') args.loginRequiredStores = argv[++i] || '';
    else if (a === '--message') args.message = argv[++i] || '';
    else if (a === '--log-file') args.logFile = argv[++i] || '';
    else if (a === '--title') args.title = argv[++i] || '';
    else if (a === '--idempotency-key') args.idempotencyKey = argv[++i] || '';
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--force') args.force = true;
  }
  return args;
}

function bjDateTime() {
  const now = new Date();
  const bj = new Date(now.getTime() + 8 * 3600_000);
  return bj.toISOString().replace('T', ' ').slice(0, 19);
}

async function readJson(file, fallback = null) {
  try { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
  catch { return fallback; }
}

function splitStores(text) {
  return [...new Set(String(text || '').split(/[,\s，、]+/).map(s => s.trim().toUpperCase()).filter(Boolean))];
}

function runLark(args) {
  return new Promise(resolve => {
    const child = spawn('lark-cli', args, {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('close', code => resolve({ok: code === 0, code, stdout, stderr}));
    child.on('error', err => resolve({ok: false, code: -1, stdout, stderr: String(err.stack || err)}));
  });
}

function idempotencyKey(parts) {
  const raw = parts.filter(Boolean).join('|');
  const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 24);
  return `sync-issue-${hash}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const failed = splitStores(args.failedStores);
  const loginRequired = splitStores(args.loginRequiredStores);
  const shouldSend = args.force || failed.length || loginRequired.length || args.message;
  if (!shouldSend) {
    console.log(JSON.stringify({ok: true, skipped: true, reason: 'no issue'}));
    return;
  }

  const cfg = await readJson(REPORT_CONFIG_PATH, {});
  const recipient = cfg.recipientUserId;
  const identity = cfg.defaultIdentity || 'bot';
  const date = args.date || new Date().toISOString().slice(0, 10);
  const modeLabel = args.mode || 'sync';
  const isWebhook = String(args.kind || '').toLowerCase() === 'webhook';
  const title = args.title || (isWebhook
    ? `SHEIN 平台高优先级动态：${modeLabel}`
    : `SHEIN 同步异常提醒：${date} ${modeLabel}`);
  const text = [
    `${isWebhook ? '🚨' : '⚠️'} ${title}`,
    '',
    failed.length ? `失败店铺：${failed.join('、')}` : '',
    loginRequired.length ? `疑似登录态/验证问题：${loginRequired.join('、')}` : '',
    args.message ? `原因：${args.message}` : '',
    args.logFile ? `日志：${args.logFile}` : '',
    '',
    isWebhook
      ? '处理原则：该消息仅用于平台高优先级异常；详情与普通动态请到 BI「平台动态」查看。'
      : '处理原则：已成功店铺的数据继续同步；BI 会尽量刷新可用数据，不因单店失败整条中断。',
    `提醒时间：${bjDateTime()}`,
  ].filter(Boolean).join('\n');

  await fs.mkdir(OUT_DIR, {recursive: true});
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const outFile = path.join(OUT_DIR, `sync-issue-${date}-${stamp}.txt`);
  await fs.writeFile(outFile, text, 'utf8');

  if (args.dryRun) {
    console.log(JSON.stringify({ok: true, dryRun: true, text, outFile}, null, 2));
    return;
  }
  if (!recipient) {
    console.log(JSON.stringify({ok: false, skipped: true, reason: 'missing recipientUserId', outFile}, null, 2));
    process.exitCode = 1;
    return;
  }

  const baseLarkArgs = [
    'im', '+messages-send',
    '--as', identity,
    '--user-id', recipient,
    '--text', text,
  ];
  const key = args.idempotencyKey || idempotencyKey([date, modeLabel, failed.join(','), loginRequired.join(','), args.message, stamp]);
  let res = await runLark([...baseLarkArgs, '--idempotency-key', key]);
  let fallbackTried = false;
  // Webhook P0 alerts are retried by the durable receipt worker. Never retry
  // those without an idempotency key: a process crash between send and local
  // acknowledgement would otherwise produce duplicate emergency messages.
  if (!isWebhook && !res.ok && /field validation failed/i.test(`${res.stdout}\n${res.stderr}`)) {
    fallbackTried = true;
    res = await runLark(baseLarkArgs);
  }
  console.log(JSON.stringify({
    ok: res.ok,
    code: res.code,
    outFile,
    idempotencyKey: key,
    fallbackTried,
    stdoutTail: res.stdout.slice(-1000),
    stderrTail: res.stderr.slice(-1000),
  }, null, 2));
  if (!res.ok) process.exitCode = 1;
}

main().catch(err => {
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});
