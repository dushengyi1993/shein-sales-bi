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

function latestTimestamp(...values) {
  const parsed = values
    .map(value => Date.parse(String(value || '')))
    .filter(Number.isFinite);
  return parsed.length ? Math.max(...parsed) : NaN;
}

export function assessMarketingDailyDeliveryReadiness({queue = null, guardReport = null, executionReport = null} = {}) {
  const queueStatus = String(queue?.status || 'no_queue');
  if (!queue) {
    return {ready: false, reason: 'repair queue is missing; inspection cannot be called final'};
  }
  if (!['completed', 'blocked', 'deferred_to_local'].includes(queueStatus)) {
    return {ready: false, reason: `repair queue is not terminal: ${queueStatus}`};
  }
  const guardAt = latestTimestamp(guardReport?.updatedAt, guardReport?.createdAt);
  if (!Number.isFinite(guardAt)) return {ready: false, reason: 'final guard timestamp is missing'};
  const totalRows = Number(queue?.counts?.totalRows || 0);
  const outstanding = countOutstandingGuardRepairs(guardReport);
  if (totalRows === 0 && outstanding.total > 0) {
    return {
      ready: false,
      reason: 'terminal zero-row queue conflicts with outstanding guard repair actions',
      outstanding,
    };
  }
  if (totalRows === 0) return {ready: true, reason: 'terminal no-repair guard'};
  if (queueStatus === 'deferred_to_local') {
    return {
      ready: true,
      reason: 'inspection is complete and the exact non-empty repair queue is handed to local controlled execution',
      outstanding,
    };
  }

  const queueAt = latestTimestamp(queue?.updatedAt, queue?.createdAt);
  const executionAt = latestTimestamp(
    executionReport?.finishedAt,
    executionReport?.updatedAt,
    executionReport?.createdAt,
  );
  const requiredAt = Math.max(
    Number.isFinite(queueAt) ? queueAt : 0,
    Number.isFinite(executionAt) ? executionAt : 0,
  );
  if (guardAt < requiredAt) {
    return {
      ready: false,
      reason: 'final guard predates the terminal queue or execution result',
      guardAt: new Date(guardAt).toISOString(),
      requiredAt: new Date(requiredAt).toISOString(),
    };
  }
  return {ready: true, reason: 'terminal queue has post-execution final guard'};
}

export function countOutstandingGuardRepairs(guardReport = null) {
  const guard = guardReport || {};
  const counts = {
    highClickSpecial: Number(guard?.highClickLowConversionSpecial?.actionCount || 0),
    manualSpecialRestore: Number(guard?.manualSpecialLimitedDiscount?.actionCount || 0),
    driftRepair: Math.max(
      Number(guard?.limitedDiscountTargetPriceDrift?.belowTarget || 0),
      Number(guard?.limitedDiscountTargetPriceDrift?.belowRows?.length || 0),
    ),
    fallbackRepair: Math.max(
      Number(guard?.newSkcCandidates?.newListingWithin7DaysLimitedDiscount?.executableActionCount || 0),
      Number(guard?.newSkcCandidates?.newListingWithin7DaysLimitedDiscount?.actionCount || 0),
    ),
  };
  return {
    ...counts,
    total: Object.values(counts).reduce((sum, value) => sum + value, 0),
  };
}

function extractSection(markdown, heading) {
  const marker = `## ${heading}`;
  const start = markdown.indexOf(marker);
  if (start < 0) return '';
  const rest = markdown.slice(start);
  const next = rest.slice(marker.length).search(/\n##\s+/);
  return (next >= 0 ? rest.slice(0, marker.length + next) : rest).trim();
}

export function buildMarketingDailyGroupSummary({
  date,
  queue = null,
  guardMarkdown = '',
  guardReport = null,
  executionMarkdown = '',
  executionReport = null,
} = {}) {
  const fallback = extractBullets(guardMarkdown, '限时折扣兜底情况');
  const highClick = extractBullets(guardMarkdown, '高点击低转化专属折扣');
  const keyState = extractBullets(guardMarkdown, '今日关键状态');
  const executionConclusion = extractBullets(executionMarkdown, '结论');
  const blockers = buildMarketingRepairBlockerNotice(executionReport || {}).rows;
  const liveScan = firstMatching(fallback, /^巡检：/);
  const highClickStatus = firstMatching(highClick, /^本轮候选：/);
  const remainingDrift = Number(guardReport?.limitedDiscountTargetPriceDrift?.belowTarget || 0);
  const manual = guardReport?.manualSpecialLimitedDiscount || {};
  const live = guardReport?.mandatoryLimitedDiscountStatus?.live || {};
  const repair = guardReport?.mandatoryLimitedDiscountStatus?.latestAutoRepair || {};
  const orders = guardReport?.orderPriceAudit || {};
  const effect = guardReport?.highClickSpecialEffect || {};
  const ordinaryActivityCount = new Set((guardReport?.t3MarketingCandidates || [])
    .map(row => String(row?.activityId || ''))
    .filter(Boolean)).size;
  const localHandoff = String(queue?.status || '') === 'deferred_to_local';
  const queuedRows = Number(queue?.counts?.totalRows || 0);
  const sentenceParts = [
    localHandoff
      ? `${date} 营销巡检已完成，${queuedRows} 条已形成精确队列，等待本地受控处理`
      : `${date} 营销巡检和授权修复已完成`,
    Number(live.storeCount || 0) > 0
      ? `SHEIN后台最终回读 ${Number(live.okStoreCount || 0)}/${Number(live.storeCount || 0)} 店，当前限时折扣 ${Number(live.limitedRows || 0)} 行`
      : liveScan?.replace(/^巡检：/, ''),
    !localHandoff && executionConclusion.length ? '本轮授权范围内可安全执行的动作均已处理' : '',
    `人工特殊折扣 ${Number(manual.activeCount || 0)}/${Number(manual.checked || 0)} 精确覆盖`,
    remainingDrift > 0 ? `仍有 ${remainingDrift} 条目标价漂移受平台或ET库存阻断` : '目标价漂移已处理完毕',
    Number(repair.blockedCount || blockers.length) > 0
      ? `另有 ${Number(repair.blockedCount || blockers.length)} 条兜底库存阻断`
      : '',
    `订单商品行审计 ${Number(orders.auditedRows || 0)} 行，低于目标 ${Number(orders.below || 0)} 条、高于目标 ${Number(orders.above || 0)} 条`,
    Number(effect.total || 0) > 0
      ? `高点击专属折扣跟踪 ${Number(effect.total || 0)} 条，已出单 ${Number(effect.convertedCount || 0)} 条`
      : highClickStatus,
    ordinaryActivityCount > 0 ? `未来3天普通活动 ${ordinaryActivityCount} 个批次待跟进` : '',
    '完整明细见唯一附件',
  ].filter(Boolean);
  return `${sentenceParts.join('；')}。`;
}

export function buildMarketingDailyFinalMarkdown({
  date,
  summary,
  queue = null,
  guardMarkdown = '',
  executionMarkdown = '',
} = {}) {
  const guardSections = [
    '需要做什么',
    '需要留意',
    '已确认安全/已处理',
    '限时折扣兜底情况',
    '高点击低转化专属折扣',
    '今日关键状态',
  ].map(heading => extractSection(guardMarkdown, heading)).filter(Boolean);
  const executionSections = [
    '结论',
    '已执行',
    '未完成',
  ].map(heading => extractSection(executionMarkdown, heading)).filter(Boolean);
  const stageLines = Object.entries(queue?.stages || {}).map(([name, stage]) => (
    `- ${name}: ${stage?.status || 'unknown'}；行数 ${Number(stage?.rows || 0)}；组数 ${Number(stage?.groups || 0)}`
  ));
  const markdown = [
    `# ${date} 营销巡检报告`,
    '',
    String(queue?.status || '') === 'deferred_to_local'
      ? '> 本文件为今日只读巡检结论；精确写入队列已移交本地受控执行，不能视为写后终态。'
      : '> 本文件为巡检、授权修复及写后 live 回读全部结束后的唯一最终附件。',
    '',
    '## 最终结论',
    '',
    summary,
    '',
    ...guardSections.flatMap(section => [section, '']),
    ...(stageLines.length ? ['## 自动化阶段终态', '', ...stageLines, ''] : []),
    ...(executionSections.length ? ['## 自动执行结果', '', ...executionSections.flatMap(section => [section, ''])] : []),
  ].join('\n').trim() + '\n';
  return markdown
    .replaceAll('，不能自动执行', '，仍需等待阻断解除')
    .replaceAll('不能自动执行；', '仍需等待阻断解除；');
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
  const guardMarkdown = await readText(guardMdPath);
  if (!guardMarkdown) throw new Error(`Missing marketing guard Markdown: ${guardMdPath}`);
  const guardReport = await readJson(guardJsonPath, null);
  if (!guardReport) throw new Error(`Missing marketing guard JSON: ${guardJsonPath}`);
  const executionMarkdown = await readText(executionMdPath);
  const executionReport = await readJson(executionJsonPath, null);
  const readiness = assessMarketingDailyDeliveryReadiness({queue, guardReport, executionReport});
  if (!readiness.ready) {
    console.log(JSON.stringify({ok: true, skipped: true, finalReady: false, ...readiness}));
    process.exitCode = 3;
    return;
  }
  const summary = buildMarketingDailyGroupSummary({
    date: args.date,
    queue,
    guardMarkdown,
    guardReport,
    executionMarkdown,
    executionReport,
  });
  const finalMarkdown = buildMarketingDailyFinalMarkdown({
    date: args.date,
    summary,
    queue,
    guardMarkdown,
    executionMarkdown,
  });
  const finalMdPath = path.resolve(ROOT, `outputs/reports/marketing-daily-final-${args.date}.md`);
  await fs.writeFile(finalMdPath, finalMarkdown, 'utf8');
  const fingerprint = crypto.createHash('sha256')
    .update([finalMarkdown, String(queue?.status || 'no_queue')].join('\n---\n'))
    .digest('hex');
  const prior = await readJson(statePath, {});
  const state = prior.fingerprint === fingerprint
    ? prior
    : {
      date: args.date,
      fingerprint,
      queueFingerprint: queue?.queueFingerprint || '',
      summarySent: false,
      finalReportSent: false,
    };

  if (args.dryRun) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      finalReady: true,
      queueStatus: queue?.status || 'no_queue',
      summary,
      files: [finalMdPath],
    }, null, 2));
    return;
  }

  if (args.adoptExisting) {
    await writeState(statePath, {
      ...state,
      summarySent: true,
      finalReportSent: true,
      adoptedExistingAt: new Date().toISOString(),
    });
    console.log(JSON.stringify({ok: true, adoptedExisting: true, fingerprint}));
    return;
  }

  if (state.summarySent && state.finalReportSent) {
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
  if (!state.finalReportSent) {
    await runLark(['im', '+messages-send', '--as', identity, ...target.cliArgs, '--file', path.relative(ROOT, finalMdPath),
      '--idempotency-key', `mkt-day-${compactDate}-final-${shortHash}`]);
    state.finalReportSent = true;
    await writeState(statePath, state);
  }

  console.log(JSON.stringify({ok: true, delivered: true, fingerprint}));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
