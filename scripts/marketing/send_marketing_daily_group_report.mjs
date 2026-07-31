#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolveLarkDeliveryTarget} from '../../lib/lark_delivery_target.mjs';
import {buildMarketingRepairBlockerNotice} from '../../lib/marketing_repair_blocker_notice.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const args = {date: '', queue: '', guard: '', execution: '', dryRun: false, adoptExisting: false};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--date') args.date = argv[++i] || '';
    else if (arg === '--queue') args.queue = argv[++i] || '';
    else if (arg === '--guard') args.guard = argv[++i] || '';
    else if (arg === '--execution') args.execution = argv[++i] || '';
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--adopt-existing') args.adoptExisting = true;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new Error('Missing or invalid --date');
  return args;
}

async function readText(file, fallback = '') {
  try { return await fs.readFile(file, 'utf8'); }
  catch { return fallback; }
}

async function readJson(file, fallback = null) {
  try { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
  catch { return fallback; }
}

function extractBullets(markdown, heading) {
  const marker = `## ${heading}`;
  const start = markdown.indexOf(marker);
  if (start < 0) return [];
  const rest = markdown.slice(start + marker.length);
  const end = rest.search(/\n##\s+/);
  return (end >= 0 ? rest.slice(0, end) : rest)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith('- '))
    .map(line => line.slice(2).trim());
}

function firstMatching(lines, pattern) {
  return lines.find(line => pattern.test(line)) || '';
}

export function buildMarketingDailyGroupSummary({date, guardMarkdown = '', executionMarkdown = '', executionReport = null} = {}) {
  const intro = extractBullets(guardMarkdown, '先看结论');
  const fallback = extractBullets(guardMarkdown, '限时折扣兜底情况');
  const highClick = extractBullets(guardMarkdown, '高点击低转化专属折扣');
  const keyState = extractBullets(guardMarkdown, '今日关键状态');
  const executionConclusion = extractBullets(executionMarkdown, '结论');
  const executed = extractBullets(executionMarkdown, '已执行');
  const blockers = buildMarketingRepairBlockerNotice(executionReport || {}).rows;

  const lines = [
    `## ${date} 营销巡检完整结论`,
    '',
    `**${intro[0] || '营销巡检已完成。'}**`,
  ];
  const liveScan = firstMatching(fallback, /^巡检：/);
  if (liveScan) lines.push(`- ${liveScan.replace(/^巡检：/, '实时检查：')}`);
  for (const line of executionConclusion) lines.push(`- ${line}`);
  if (executed.length) lines.push(`- 已执行明细：${executed.join('；')}`);
  if (blockers.length) {
    lines.push('- 未完成明细：');
    for (const row of blockers) {
      lines.push(`  - ${row.storeKey} · ${row.canonical || row.skc}：平台可用 ${row.platformStock ?? '未知'}，ET 可用 ${row.etStock ?? '未知'}，活动需要 ${row.required ?? '未知'}`);
    }
  }
  const highClickStatus = firstMatching(highClick, /^本轮候选：/);
  const tracking = firstMatching(highClick, /^效果跟踪：/);
  const orderPrice = firstMatching(keyState, /^订单商品行成交价：/);
  const future = firstMatching(keyState, /^未来 3 天普通活动提醒：/);
  for (const line of [highClickStatus, tracking, orderPrice, future].filter(Boolean)) lines.push(`- ${line}`);
  lines.push(
    '',
    blockers.length
      ? '**下一步：**库存恢复后系统会自动复查；当前没有虚增库存，也没有强行提交被平台阻断的活动。'
      : '**下一步：**今天没有需要人工处理的营销事项。',
    '',
    '完整人话版巡检报告和自动执行结果见附件。',
  );
  return lines.join('\n');
}

function runLark(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('lark-cli', args, {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    child.on('error', reject);
    child.on('close', code => code === 0
      ? resolve({stdout, stderr})
      : reject(new Error(`lark-cli exited ${code}: ${stderr || stdout}`)));
  });
}

async function writeState(file, state) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fs.rename(temp, file);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const compactDate = args.date.replaceAll('-', '');
  const queuePath = path.resolve(ROOT, args.queue || `state/cloud_marketing_live_guard/repair-queues/marketing-repair-${args.date}.json`);
  const guardJsonPath = path.resolve(ROOT, args.guard || `outputs/reports/marketing-daily-guard-${args.date}.json`);
  const guardMdPath = guardJsonPath.replace(/\.json$/i, '.md');
  const executionJsonPath = path.resolve(ROOT, args.execution || `outputs/reports/new-listing-7d-limited-discount-execution-summary-${args.date}.json`);
  const executionMdPath = executionJsonPath.replace(/\.json$/i, '.md');
  const statePath = path.resolve(ROOT, `state/cloud_marketing_live_guard/group-delivery/marketing-daily-${args.date}.json`);

  const queue = await readJson(queuePath, null);
  if (queue && !['completed', 'blocked'].includes(String(queue.status || ''))) {
    console.log(JSON.stringify({ok: true, skipped: true, reason: `repair queue is not terminal: ${queue.status || 'unknown'}`}));
    return;
  }

  const guardMarkdown = await readText(guardMdPath);
  if (!guardMarkdown) throw new Error(`Missing marketing guard Markdown: ${guardMdPath}`);
  const executionMarkdown = await readText(executionMdPath);
  const executionReport = await readJson(executionJsonPath, null);
  const summary = buildMarketingDailyGroupSummary({
    date: args.date,
    guardMarkdown,
    executionMarkdown,
    executionReport,
  });
  const fingerprint = crypto.createHash('sha256')
    .update([guardMarkdown, executionMarkdown, String(queue?.status || 'no_queue')].join('\n---\n'))
    .digest('hex');
  const prior = await readJson(statePath, {});
  const state = prior.fingerprint === fingerprint
    ? prior
    : {date: args.date, fingerprint, summarySent: false, guardSent: false, executionSent: !executionMarkdown};

  if (args.dryRun) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      queueStatus: queue?.status || 'no_queue',
      summary,
      files: [guardMdPath, ...(executionMarkdown ? [executionMdPath] : [])],
    }, null, 2));
    return;
  }

  if (args.adoptExisting) {
    await writeState(statePath, {
      ...state,
      summarySent: true,
      guardSent: true,
      executionSent: true,
      adoptedExistingAt: new Date().toISOString(),
    });
    console.log(JSON.stringify({ok: true, adoptedExisting: true, fingerprint}));
    return;
  }

  if (state.summarySent && state.guardSent && state.executionSent) {
    console.log(JSON.stringify({ok: true, skipped: true, reason: 'same final report already delivered'}));
    return;
  }

  const config = await readJson(path.join(ROOT, 'config/lark_report.json'), {});
  const target = resolveLarkDeliveryTarget({config});
  if (!target) throw new Error('Feishu delivery target is not configured');
  const identity = String(config.defaultIdentity || 'bot');
  const shortHash = fingerprint.slice(0, 8);

  if (!state.summarySent) {
    await runLark(['im', '+messages-send', '--as', identity, ...target.cliArgs, '--markdown', summary,
      '--idempotency-key', `mkt-day-${compactDate}-sum-${shortHash}`]);
    state.summarySent = true;
    await writeState(statePath, state);
  }
  if (!state.guardSent) {
    await runLark(['im', '+messages-send', '--as', identity, ...target.cliArgs, '--file', path.relative(ROOT, guardMdPath),
      '--idempotency-key', `mkt-day-${compactDate}-guard-${shortHash}`]);
    state.guardSent = true;
    await writeState(statePath, state);
  }
  if (!state.executionSent && executionMarkdown) {
    await runLark(['im', '+messages-send', '--as', identity, ...target.cliArgs, '--file', path.relative(ROOT, executionMdPath),
      '--idempotency-key', `mkt-day-${compactDate}-exec-${shortHash}`]);
    state.executionSent = true;
    await writeState(statePath, state);
  }

  console.log(JSON.stringify({ok: true, delivered: true, fingerprint}));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
