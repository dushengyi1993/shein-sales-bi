#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import {maskLarkDeliveryTarget, resolveLarkDeliveryTarget} from '../lib/lark_delivery_target.mjs';

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

function bjDateTime(now = new Date()) {
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

export const NO_KEY_RETRY_PROTECTED_KINDS = Object.freeze([
  'webhook',
  'cloud-watchdog',
  'cloud-watchdog-recovery',
]);

export function shouldRetryLegacyNoKeyFallback({kind = '', ok = false, output = ''} = {}) {
  if (ok === true) return false;
  if (NO_KEY_RETRY_PROTECTED_KINDS.includes(String(kind || '').trim().toLowerCase())) return false;
  return /field validation failed/i.test(String(output || ''));
}

function humanServiceName(unit) {
  const names = {
    'shein-bi-portal.service': 'BI 网页服务',
    'shein-bi-webhook.service': 'SHEIN 实时消息接收服务',
    'shein-bi-cloud-session-manager.service': '店铺登录状态维护服务',
    'shein-bi-lark-sales-qa.service': '飞书问数服务',
    'shein-bi-et-low-inventory-guard.service': '低库存安全检查',
    'shein-bi-et-low-inventory-recheck.service': '低库存自动复查',
    'shein-bi-cloud-openapi-stock-refresh.service': '商品库存同步',
    'shein-bi-cloud-today-sales-reconcile.service': '当天销售核对',
    'shein-bi-cloud-daily-refresh.service': '每日经营数据更新',
    'shein-bi-cloud-portal-section-queue.service': 'BI 页面缓存更新',
    'shein-bi-profit-refresh.service': '利润数据更新',
    'shein-bi-cloud-watchdog.service': 'BI 自动体检',
  };
  return names[unit] || unit.replace(/^shein-bi-cloud-/, '').replace(/\.service$/, '').replace(/-/g, ' ');
}

function humanizeWatchdogIssue(issue) {
  const text = String(issue || '').trim();
  let match = text.match(/^云端源码不一致：commitMatch=(true|false) dirty=(\d+) hidden=(\d+) missing=(\d+)$/i);
  if (match) {
    const [, commitMatch, dirty, hidden, missing] = match;
    const parts = [];
    if (Number(dirty)) parts.push(`${dirty} 项未提交改动`);
    if (Number(hidden)) parts.push(`${hidden} 项暂存区改动`);
    if (Number(missing)) parts.push(`${missing} 个正式文件缺失`);
    if (commitMatch !== 'true') parts.push('服务器版本号与正式发布版本不同');
    return {
      type: 'source',
      text: `服务器运行目录有${parts.join('、') || '未发布变更'}。这不是抓数失败，但这些改动可能在下次发布或重启时被覆盖，需要维护人员核对后正式发布或移出运行目录。`,
      detail: `版本号${commitMatch === 'true' ? '一致' : '不一致'}；未提交 ${dirty}；暂存区 ${hidden}；缺失文件 ${missing}`,
    };
  }

  match = text.match(/^服务异常：(\S+)\s+state=(\S+)\s+result=(\S+)\s+exit=(\S+)\s+code=(\S+)$/);
  if (match) {
    return {
      type: 'service',
      text: `${humanServiceName(match[1])}连续运行失败，相关数据可能暂时还是上一次成功结果。系统会保留旧数据并继续自动重试；如果仍无法恢复，再由维护人员处理。`,
      detail: `${match[1]}：state=${match[2]} result=${match[3]} exit=${match[4]} code=${match[5]}`,
    };
  }

  match = text.match(/^常驻服务未运行：(\S+)\s+state=(\S+)\s+result=(\S+)$/);
  if (match) {
    return {
      type: 'service',
      text: `${humanServiceName(match[1])}当前没有运行，相关实时更新可能暂停。`,
      detail: `${match[1]}：state=${match[2]} result=${match[3]}`,
    };
  }

  match = text.match(/^BI 覆盖不足：(.+)$/);
  if (match) {
    return {
      type: 'coverage',
      text: `部分店铺的数据还没有收齐：${match[1].replace(/覆盖不足：?/g, '').replace(/；/g, '；')}。已收齐的店铺仍可正常查看，缺失部分会继续补采。`,
      detail: '',
    };
  }

  match = text.match(/^日更补采异常：date=([^\s]+)\s+status=([^\s]+)\s+message=profit mart refresh failed(?:\s+status=\S+)?(?:\s+log=.*)?$/i);
  if (match) {
    return {
      type: 'profit',
      text: `${match[1]} 的利润数据更新遇到数据库并发冲突。页面继续使用上一次完整利润数据，系统会自动重试，不会把缺失利润显示成 0。`,
      detail: '',
    };
  }

  match = text.match(/^链接\/业务域日更部分店铺失败：date=([^\s]+)\s+failed=([^\s]+)(?:\s+log=.*)?$/);
  if (match) {
    return {
      type: 'coverage',
      text: `${match[1]} 的商品链接数据没有全部更新，受影响店铺：${match[2].split(',').join('、')}。销售数据不一定受影响，但这些店铺的链接状态和流量指标可能仍是旧值。`,
      detail: '',
    };
  }

  match = text.match(/^营销修复队列未闭环：date=([^\s]+).*?rows=(\S+)\s+groups=(\S+)\s+workerStatus=(\S+)$/);
  if (match) {
    return {
      type: 'marketing',
      text: `${match[1]} 的营销自动修复还没有全部处理完，共 ${match[3]} 组、${match[2]} 条链接。未完成项不会强行写入 SHEIN，系统会继续处理或等待明确的业务条件。`,
      detail: `workerStatus=${match[4]}`,
    };
  }

  match = text.match(/^定时器未运行：(\S+)/);
  if (match) {
    return {
      type: 'timer',
      text: `自动排班 ${match[1]} 当前没有运行，对应任务可能不会按时执行。`,
      detail: text,
    };
  }

  if (/^BI 数据文件不可读：/.test(text)) {
    return {
      type: 'portal',
      text: 'BI 页面暂时读不到完整数据文件。为避免把缺失数据误显示为 0，受影响的页面会保留上一次完整结果；系统正在自动恢复。',
      detail: '',
    };
  }

  if (/^BI 实时运行状态不可读：/.test(text)) {
    return {
      type: 'portal',
      text: 'BI 页面服务仍在运行，但实时更新状态暂时无法确认。页面可能不会立刻刷新，系统正在自动重新连接。',
      detail: '',
    };
  }

  if (/^BI 实时更新通道未连接：/.test(text)) {
    return {
      type: 'portal',
      text: 'BI 的实时更新连接已中断。现有数据仍可查看，但新数据可能延迟出现；系统正在自动重新连接。',
      detail: '',
    };
  }

  if (/^订单闭环 DB 审计失败：/.test(text)) {
    return {
      type: 'orders',
      text: '订单数据完整性检查没有完成。系统不会把未确认的数据当作完整结果，并会继续自动复查。',
      detail: '',
    };
  }

  if (/^systemd 批量快照不完整：/.test(text)) {
    return {
      type: 'runtime',
      text: '服务器自动体检没有读全运行状态，目前无法确认所有任务是否正常。系统会自动重试；在确认前不会把未知状态当作正常。',
      detail: '',
    };
  }

  if (/过期|覆盖不足|部分失败|补采异常/.test(text)) {
    return {
      type: 'coverage',
      text: text
        .replace(/^日更补采异常：/, '日更补采没有完整结束：')
        .replace(/\s+log=\S+/g, '')
        .replace(/\bdate=/g, '日期 ')
        .replace(/\bstatus=/g, '状态 ')
        .replace(/\bmessage=/g, '说明 '),
      detail: '',
    };
  }

  return {type: 'other', text, detail: ''};
}

function buildWatchdogMessage({message, logFile, now}) {
  const issues = String(message || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const human = issues.map(humanizeWatchdogIssue);
  const sourceOnly = human.length > 0 && human.every(item => item.type === 'source');
  const headline = sourceOnly
    ? '⚠️ BI 服务器上有未发布的程序改动'
    : `⚠️ BI 有 ${human.length || 1} 项需要维护`;
  const lines = [headline, ''];
  if (sourceOnly) {
    lines.push('数据抓取没有失败，BI 当前仍可使用。');
  } else {
    lines.push('系统已经完成自动重试确认；以下问题仍未恢复。');
  }
  for (const item of human) lines.push(human.length > 1 ? `- ${item.text}` : item.text);
  const details = human.map(item => item.detail).filter(Boolean);
  if (details.length) {
    lines.push('', `维护信息：${details.join('；')}`);
  }
  if (logFile) lines.push(`维护日志：${logFile}`);
  lines.push('', `提醒时间：${bjDateTime(now)}`);
  return lines.join('\n');
}

function recoveryText(item) {
  if (item.type === 'service') return item.text.replace(/连续运行失败.*$/u, '已经恢复运行，后续自动任务会按原计划继续。');
  if (item.type === 'profit') return '利润数据已经重新生成，页面已恢复使用最新完整结果。';
  if (item.type === 'coverage') return '缺失的数据已经补齐，对应页面与指标已恢复更新。';
  if (item.type === 'timer') return '自动排班已经恢复运行。';
  return `${item.text.replace(/[。；]+$/u, '')} 已恢复。`;
}

function buildWatchdogRecoveryMessage({message, logFile, now}) {
  const issues = String(message || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const human = issues.map(humanizeWatchdogIssue);
  const lines = ['✅ BI 已自动恢复', '', '此前已提醒的问题现在已经恢复：'];
  for (const item of human) lines.push(`- ${recoveryText(item)}`);
  lines.push('', '系统会继续按原计划更新数据，无需人工处理。');
  if (logFile) lines.push(`恢复依据：${logFile}`);
  lines.push('', `恢复时间：${bjDateTime(now)}`);
  return lines.join('\n');
}

export function buildSyncIssueMessage({
  isWebhook = false,
  isMarketing = false,
  isCloudWatchdog = false,
  isCloudWatchdogRecovery = false,
  title,
  failed = [],
  loginRequired = [],
  message = '',
  logFile = '',
  now = new Date(),
} = {}) {
  if (isWebhook) {
    return [
      `🚨 ${title}`,
      '',
      message || 'SHEIN 平台发来一项需要人工处理的变化。',
      '',
      `时间：${bjDateTime(now)}`,
    ].join('\n');
  }
  if (isMarketing) {
    return [
      `⚠️ ${title}`,
      '',
      message || '有营销兜底任务因业务条件不足而未执行。',
      '',
      `提醒时间：${bjDateTime(now)}`,
    ].join('\n');
  }
  if (isCloudWatchdogRecovery) {
    return buildWatchdogRecoveryMessage({message, logFile, now});
  }
  if (isCloudWatchdog) {
    return buildWatchdogMessage({message, logFile, now});
  }
  return [
    `⚠️ ${title}`,
    '',
    failed.length ? `失败店铺：${failed.join('、')}` : '',
    loginRequired.length ? `疑似登录态/验证问题：${loginRequired.join('、')}` : '',
    message || '本次数据没有完整更新。',
    logFile ? `维护日志：${logFile}` : '',
    '',
    '已成功的数据仍可查看；缺失部分会继续补采。',
    `提醒时间：${bjDateTime(now)}`,
  ].filter(Boolean).join('\n');
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
  const target = resolveLarkDeliveryTarget({config: cfg});
  const identity = cfg.defaultIdentity || 'bot';
  const date = args.date || new Date().toISOString().slice(0, 10);
  const modeLabel = args.mode || 'sync';
  const kind = String(args.kind || '').toLowerCase();
  const isWebhook = kind === 'webhook';
  const isMarketing = kind === 'marketing';
  const isCloudWatchdog = kind === 'cloud-watchdog';
  const isCloudWatchdogRecovery = kind === 'cloud-watchdog-recovery';
  const title = args.title || (isWebhook
    ? `SHEIN 平台高优先级动态：${modeLabel}`
    : isMarketing
      ? `SHEIN 营销任务提醒：${date}`
      : `SHEIN 同步异常提醒：${date} ${modeLabel}`);
  const text = buildSyncIssueMessage({
    isWebhook,
    isMarketing,
    isCloudWatchdog,
    isCloudWatchdogRecovery,
    title,
    failed,
    loginRequired,
    message: args.message,
    logFile: args.logFile,
  });

  await fs.mkdir(OUT_DIR, {recursive: true});
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const outFile = path.join(OUT_DIR, `sync-issue-${date}-${stamp}.txt`);
  await fs.writeFile(outFile, text, 'utf8');

  if (args.dryRun) {
    console.log(JSON.stringify({ok: true, dryRun: true, text, outFile}, null, 2));
    return;
  }
  if (!target) {
    console.log(JSON.stringify({ok: false, skipped: true, reason: 'missing Feishu recipientChatId/recipientUserId', outFile}, null, 2));
    process.exitCode = 1;
    return;
  }

  const baseLarkArgs = [
    'im', '+messages-send',
    '--as', identity,
    ...target.cliArgs,
    '--text', text,
  ];
  const key = args.idempotencyKey || idempotencyKey([date, modeLabel, failed.join(','), loginRequired.join(','), args.message, stamp]);
  let res = await runLark([...baseLarkArgs, '--idempotency-key', key]);
  let fallbackTried = false;
  // Webhook P0 alerts and cloud-watchdog/recovery dispatches are deduplicated
  // by the durable receipt worker through their idempotency key. Never retry
  // those without the key: a process crash between send and local
  // acknowledgement would otherwise produce duplicate emergency messages.
  if (!isWebhook && !res.ok && !isCloudWatchdog && !isCloudWatchdogRecovery
    && /field validation failed/i.test(`${res.stdout}\n${res.stderr}`)) {
    fallbackTried = true;
    res = await runLark(baseLarkArgs);
  }
  console.log(JSON.stringify({
    ok: res.ok,
    code: res.code,
    outFile,
    target: maskLarkDeliveryTarget(target),
    idempotencyKey: key,
    fallbackTried,
    stdoutTail: res.stdout.slice(-1000),
    stderrTail: res.stderr.slice(-1000),
  }, null, 2));
  if (!res.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(err?.stack || String(err));
    process.exitCode = 1;
  });
}
