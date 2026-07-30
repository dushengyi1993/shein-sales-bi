#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {maskLarkDeliveryTarget, resolveLarkDeliveryTarget} from '../lib/lark_delivery_target.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = path.join(ROOT, 'config', 'lark_report.json');

function beijingDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function parseArgs(argv) {
  const args = {date: beijingDate(), dryRun: false, force: false};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--date') args.date = String(argv[++i] || '');
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--force') args.force = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new Error('Invalid --date');
  return args;
}

async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function latestJson(dir, prefix) {
  try {
    const names = (await fs.readdir(dir)).filter(name => name.startsWith(prefix) && name.endsWith('.json')).sort();
    return names.length ? readJson(path.join(dir, names.at(-1)), null) : null;
  } catch {
    return null;
  }
}

function runLark(args) {
  return new Promise(resolve => {
    const child = spawn('lark-cli', args, {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => resolve({ok: false, code: -1, stdout, stderr: String(error?.message || error)}));
    child.once('close', code => resolve({ok: code === 0, code, stdout, stderr}));
  });
}

function queueHumanStatus(status, counts = {}) {
  const groups = Number(counts.totalGroups || 0);
  if (!groups) return '今天没有需要自动修复的营销任务。';
  if (status === 'completed') return `自动修复已完成，共处理 ${groups} 组。`;
  if (status === 'blocked') return `有 ${groups} 组候选，其中部分因库存或平台条件不足被安全跳过，没有强行写入。`;
  if (status === 'pending' || status === 'awaiting_final_readback') return `仍有 ${groups} 组候选在处理或等待最终回读。`;
  return `识别到 ${groups} 组候选，当前状态需要继续核对。`;
}

const args = parseArgs(process.argv.slice(2));
const config = await readJson(CONFIG_FILE, {});
const target = resolveLarkDeliveryTarget({config});
if (!target) throw new Error('Missing Feishu recipientChatId/recipientUserId');
const identity = config.defaultIdentity || 'bot';
const sentDir = path.join(ROOT, 'state', 'daily_ops_group_digest_sent');
const sentFile = path.join(sentDir, `${args.date}.json`);
if (!args.force && await exists(sentFile)) {
  console.log(JSON.stringify({ok: true, skipped: true, reason: 'already_sent', date: args.date}));
  process.exit(0);
}

const guardState = await readJson(path.join(ROOT, 'state', 'cloud_ops_alerts', 'marketing-live-guard-last.json'), {});
const repairState = await readJson(path.join(ROOT, 'state', 'cloud_ops_alerts', 'marketing-repair-last.json'), {});
const queue = await readJson(path.join(ROOT, 'state', 'cloud_marketing_live_guard', 'repair-queues', `marketing-repair-${args.date}.json`), {});
const guardJson = await readJson(path.join(ROOT, 'outputs', 'reports', `marketing-daily-guard-${args.date}.json`), {});
const product = await readJson(path.join(ROOT, 'state', 'openapi-probes', 'product-reconciliation.latest.json'), {});
const audit = await latestJson(path.join(ROOT, 'outputs', 'bi_audit'), 'bi-audit-');

const guardForToday = guardState.date === args.date;
const repairForToday = repairState.date === args.date;
const guardBlockers = Array.isArray(guardJson.blockers) ? guardJson.blockers.length : null;
const contextWarnings = Array.isArray(guardJson.contextWarnings) ? guardJson.contextWarnings.length : null;
const queueStatus = queue.status || (repairForToday ? repairState.queueStatus : '') || '';
const queueCounts = queue.counts || (repairForToday ? repairState.queueCounts : {}) || {};
const productCounts = product.counts || {};
const productHealthy = product.ok === true && Number(productCounts.matched || 0) === 19 && Number(productCounts.failed || 0) === 0;
const auditHealthy = audit?.ok === true;

const lines = [
  `# 地利 SHEIN 沙特半托｜${args.date} 每日巡检`,
  '',
  `- 营销巡检：${guardForToday && guardState.status === 'ok' ? '已完成' : guardForToday ? '有提醒，详见附件' : '今天尚未生成最终结论'}`,
  `- 营销风险：${guardBlockers == null ? '尚无报告' : guardBlockers ? `${guardBlockers} 个需要处理` : '没有硬性阻断'}${contextWarnings ? `；另有 ${contextWarnings} 条背景提示` : ''}`,
  `- 自动修复：${queueHumanStatus(queueStatus, queueCounts)}`,
  `- 商品数据：${productHealthy ? '19家店全量商品、详情和库存对账通过' : '存在缺口，请查看BI数据体检'}`,
  `- BI数据体检：${auditHealthy ? '通过' : '存在提醒，请查看BI数据体检'}`,
  '',
  '附件包含今天的巡检结论和营销巡检人话版报告，供团队留档。',
];
const markdown = lines.join('\n');
const conclusionFile = path.join(ROOT, 'outputs', 'reports', `daily-ops-inspection-${args.date}.md`);
await fs.mkdir(path.dirname(conclusionFile), {recursive: true});
await fs.writeFile(conclusionFile, `${markdown}\n`, 'utf8');
const guardMarkdownFile = path.join(ROOT, 'outputs', 'reports', `marketing-daily-guard-${args.date}.md`);
const attachments = [conclusionFile];
if (await exists(guardMarkdownFile)) attachments.push(guardMarkdownFile);

if (args.dryRun) {
  console.log(JSON.stringify({
    ok: true,
    dryRun: true,
    date: args.date,
    target: maskLarkDeliveryTarget(target),
    markdown,
    attachments: attachments.map(file => path.relative(ROOT, file)),
  }, null, 2));
  process.exit(0);
}

const baseKey = `ops-digest-${args.date.replaceAll('-', '')}`;
const summaryResult = await runLark([
  'im', '+messages-send', '--as', identity, ...target.cliArgs,
  '--markdown', markdown, '--idempotency-key', baseKey,
]);
if (!summaryResult.ok) throw new Error(`Feishu daily inspection summary failed: ${summaryResult.stderr || summaryResult.stdout}`);
for (let i = 0; i < attachments.length; i += 1) {
  const relative = path.relative(ROOT, attachments[i]).replace(/\\/g, '/');
  const result = await runLark([
    'im', '+messages-send', '--as', identity, ...target.cliArgs,
    '--file', relative, '--idempotency-key', `${baseKey}-f${i + 1}`,
  ]);
  if (!result.ok) throw new Error(`Feishu daily inspection attachment failed: ${result.stderr || result.stdout}`);
}

await fs.mkdir(sentDir, {recursive: true});
const temporary = `${sentFile}.${process.pid}.tmp`;
await fs.writeFile(temporary, `${JSON.stringify({
  date: args.date,
  sentAt: new Date().toISOString(),
  target: maskLarkDeliveryTarget(target),
  attachments: attachments.map(file => path.relative(ROOT, file)),
}, null, 2)}\n`, {encoding: 'utf8', mode: 0o640});
await fs.rename(temporary, sentFile);
console.log(JSON.stringify({
  ok: true,
  date: args.date,
  target: maskLarkDeliveryTarget(target),
  attachments: attachments.map(file => path.relative(ROOT, file)),
}, null, 2));
