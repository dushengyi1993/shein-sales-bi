#!/usr/bin/env node
/**
 * Build a full review/action plan for known ordinary activity + coupon risks.
 * Read-only: consumes marketing-daily-guard JSON and writes CSV/MD reports.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_OUT_DIR = path.join(ROOT, 'outputs', 'reports');

function parseArgs(argv) {
  const args = {
    date: formatLocalDate(new Date()),
    guard: '',
    outDir: DEFAULT_OUT_DIR,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--date') args.date = String(argv[++i] || '').trim();
    else if (a === '--guard') args.guard = path.resolve(argv[++i]);
    else if (a === '--out-dir') args.outDir = path.resolve(argv[++i]);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new Error(`Invalid --date ${args.date}; expected YYYY-MM-DD`);
  if (!args.guard) args.guard = path.join(ROOT, 'outputs', 'reports', `marketing-daily-guard-${args.date}.json`);
  return args;
}

function formatLocalDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function rel(file) {
  return path.relative(ROOT, file || '').replaceAll('\\', '/');
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/[%SAR,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function trustRank(value) {
  const trust = String(value || '');
  if (trust === 'submitted' || trust === 'batch_submit_enabled_result_ok') return 1;
  if (trust === 'filled_price_candidate') return 2;
  if (trust === 'unverified_price_candidate') return 3;
  return 4;
}

function classifySeverity(row) {
  if (row.type === 'evidence_incomplete') return 'needs_live_price_evidence';
  const diff = numberOrNull(row.diff);
  const trust = String(row.ordinaryEvidenceTrust || '');
  if (diff !== null && diff <= -30 && ['submitted', 'filled_price_candidate', 'batch_submit_enabled_result_ok'].includes(trust)) return 'critical_trusted_large_gap';
  if (['submitted', 'filled_price_candidate', 'batch_submit_enabled_result_ok'].includes(trust)) return 'high_trusted_below_target';
  return 'fail_closed_needs_live_confirmation';
}

function recommendation(row) {
  if (row.type === 'evidence_incomplete') return '系统自动 live 读取普通活动商品价/已报集合；取不到才报告登录/接口/身份阻塞。';
  return '旧普通活动结束前禁止补 15% 券；若 live 复核发现该 SKC 的 15% 券仍 active，才按用户授权取消该 SKC 15% 券或临时下架，旧活动结束后再复扫补回。';
}

function buildRows(report) {
  const guard = report.knownOrdinaryActivityGuard || {};
  const rows = [];
  for (const row of guard.belowTargetRows || []) {
    rows.push({
      type: 'below_target',
      storeKey: row.storeKey || '',
      skc: row.skc || '',
      canonical: row.canonical || '',
      planActivityId: row.activityId || '',
      decision: row.decision || '',
      ordinaryActivityId: row.ordinaryActivityId || '',
      ordinaryActivityName: row.ordinaryActivityName || '',
      ordinaryEventStart: row.ordinaryEventStart || '',
      ordinaryEventEnd: row.ordinaryEventEnd || '',
      ordinaryEvidenceTrust: row.ordinaryEvidenceTrust || '',
      ordinaryEvidenceSource: row.ordinaryEvidenceSource || '',
      lowestOrdinaryPrice: row.lowestOrdinaryPrice ?? '',
      couponFactor: row.couponFactor ?? '',
      finalWithCoupon: row.finalWithCoupon ?? '',
      finalTargetPrice: row.finalTargetPrice ?? '',
      diff: row.diff ?? '',
      shouldCancelCoupon: row.shouldCancelCoupon === true,
    });
  }
  for (const row of guard.evidenceIncompleteRows || []) {
    rows.push({
      type: 'evidence_incomplete',
      storeKey: row.storeKey || '',
      skc: row.skc || '',
      canonical: row.canonical || '',
      planActivityId: row.activityId || '',
      decision: row.decision || '',
      ordinaryActivityId: '',
      ordinaryActivityName: '',
      ordinaryEventStart: row.stackReviewSamples?.[0]?.eventStart || '',
      ordinaryEventEnd: row.stackReviewSamples?.[0]?.eventEnd || '',
      ordinaryEvidenceTrust: 'missing_price_evidence',
      ordinaryEvidenceSource: row.reason || '',
      lowestOrdinaryPrice: '',
      couponFactor: row.couponFactor ?? '',
      finalWithCoupon: '',
      finalTargetPrice: row.finalTargetPrice ?? '',
      diff: '',
      shouldCancelCoupon: false,
    });
  }
  return rows.map(row => ({...row, severity: classifySeverity(row), recommendation: recommendation(row)}))
    .sort((a, b) => trustRank(a.ordinaryEvidenceTrust) - trustRank(b.ordinaryEvidenceTrust)
      || String(a.storeKey).localeCompare(String(b.storeKey))
      || Math.abs(numberOrNull(b.diff) || 0) - Math.abs(numberOrNull(a.diff) || 0)
      || String(a.skc).localeCompare(String(b.skc)));
}

function summarize(rows) {
  const byStore = {};
  const byTrust = {};
  const bySeverity = {};
  const byType = {};
  const byOrdinaryEventEnd = {};
  for (const row of rows) {
    byStore[row.storeKey] = (byStore[row.storeKey] || 0) + 1;
    byTrust[row.ordinaryEvidenceTrust] = (byTrust[row.ordinaryEvidenceTrust] || 0) + 1;
    bySeverity[row.severity] = (bySeverity[row.severity] || 0) + 1;
    byType[row.type] = (byType[row.type] || 0) + 1;
    const eventEnd = row.ordinaryEventEnd || '(missing)';
    byOrdinaryEventEnd[eventEnd] = (byOrdinaryEventEnd[eventEnd] || 0) + 1;
  }
  return {totalRows: rows.length, byType, byStore, byTrust, bySeverity, byOrdinaryEventEnd};
}

function toCsv(rows) {
  const cols = ['type','severity','storeKey','skc','canonical','planActivityId','decision','ordinaryActivityId','ordinaryEventStart','ordinaryEventEnd','ordinaryEvidenceTrust','lowestOrdinaryPrice','couponFactor','finalWithCoupon','finalTargetPrice','diff','shouldCancelCoupon','ordinaryEvidenceSource','recommendation'];
  return [cols.join(','), ...rows.map(row => cols.map(col => csv(row[col])).join(','))].join('\n') + '\n';
}

function csv(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : '';
}

function formatCountMap(counts) {
  const entries = Object.entries(counts || {}).filter(([, value]) => Number(value) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]) || String(a[0]).localeCompare(String(b[0])));
  if (!entries.length) return '无';
  return entries.map(([key, value]) => `${key} ${value}条`).join('；');
}

function typeLabel(value) {
  if (value === 'below_target') return '旧活动价叠券低于目标';
  if (value === 'evidence_incomplete') return '有旧活动标签但缺实际填报价';
  return value || '-';
}

function trustLabel(value) {
  if (value === 'submitted') return '已提交证据';
  if (value === 'batch_submit_enabled_result_ok') return '批量提交成功证据';
  if (value === 'filled_price_candidate') return '已填价候选证据';
  if (value === 'unverified_price_candidate') return '未验证填价候选';
  if (value === 'missing_price_evidence') return '缺实际填报价';
  return value || '-';
}

function actionLabel(row) {
  if (row.type === 'evidence_incomplete') return '系统自动只读查价';
  if (row.shouldCancelCoupon === true) return '暂缓补券；如券仍 active 才取消';
  return 'live 复核价格栈后再决定';
}

function buildMarkdown(report) {
  const lines = [];
  lines.push(`# 旧普通活动低价叠券风险清单 ${report.reportDate}`);
  lines.push('');
  lines.push('- 本报告只读：只生成复核/补救清单，不取消、不提交、不改价。');
  lines.push('');
  lines.push('## 先看结论');
  lines.push('');
  if (!report.rows.length) {
    lines.push('- 没有未处理的旧普通活动 + 15% 券低价风险，也没有缺实际填报价证据的旧活动标签。');
    lines.push('- 当前不需要取消优惠券，也不需要补普通活动价证据。');
  } else {
    const belowCount = report.rows.filter(row => row.type === 'below_target').length;
    const incompleteCount = report.rows.filter(row => row.type === 'evidence_incomplete').length;
    lines.push(`- 需要处理 ${report.rows.length} 条：其中 ${belowCount} 条是“旧普通活动价叠 15% 券后低于目标价”，${incompleteCount} 条是“有旧活动标签但缺实际填报价”。`);
    lines.push('- 缺实际填报价不是交给用户的结论；系统必须先自动只读查价。只有登录失效、店铺身份不确定或平台接口不可达时，才报告具体阻塞。');
    lines.push('- 这些行不是“全部现在取消”的指令：默认动作是旧普通活动结束前阻断/暂缓补 15% 券；只有 live 复核发现 15% 券仍 active，才取消对应券或临时下架。');
  }
  lines.push('');
  lines.push('## 按店铺汇总');
  lines.push('');
  lines.push(`- ${formatCountMap(report.summary.byStore)}`);
  if (report.rows.length) {
    lines.push('');
    lines.push('## 按旧活动结束时间');
    lines.push('');
    lines.push(`- ${formatCountMap(report.summary.byOrdinaryEventEnd)}`);
  }
  lines.push('');
  lines.push('## 需要做什么');
  lines.push('');
  if (!report.rows.length) {
    lines.push('- 无需动作。');
  } else {
    const belowStores = Object.entries(report.summary.byStore || {}).map(([store]) => store).join('、');
    lines.push(`- 先按店铺打开后台复核：${belowStores || '见下表'}。`);
    lines.push('- 旧普通活动仍在生效窗口内时，先把对应 SKC 从补券队列里拦住，不要硬报 15% 券。');
    lines.push('- 只有 live 复核确认“旧普通活动价 × 券因子 < 目标价 - 1 SAR”且 15% 券仍 active 的，才取消对应 SKC 的 15% 券；不要取消普通营销活动。');
    lines.push('- 只有旧活动标签但缺实际填报价的，系统先自动 live 查价；查不到时输出明确阻塞原因。证据补齐前禁止 no-action、禁止补券。');
    lines.push('- 旧普通活动结束后，必须重新进入补券复扫队列，确认不会低于目标价后再补回 15% 券。');
  }
  lines.push('');
  lines.push('## 优先复核样例');
  lines.push('');
  if (!report.rows.length) {
    lines.push('- 无。');
  } else {
    lines.push('| 店铺 | SKC | 标准货号 | 问题 | 旧活动 | 旧活动价 | 券后价 | 目标价 | 差额 | 证据 | 明确动作 |');
    lines.push('| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |');
    for (const r of report.rows.slice(0, 80)) {
      lines.push(`| ${r.storeKey} | \`${r.skc}\` | ${r.canonical} | ${typeLabel(r.type)} | ${r.ordinaryActivityId || '-'} | ${num(r.lowestOrdinaryPrice)} | ${num(r.finalWithCoupon)} | ${num(r.finalTargetPrice)} | ${num(r.diff)} | ${trustLabel(r.ordinaryEvidenceTrust)} | ${actionLabel(r)} |`);
    }
  }
  lines.push('');
  lines.push('## 处理边界');
  lines.push('');
  lines.push('- 本清单不是自动取消指令；它只告诉你哪些 SKC 必须 live 复核。');
  lines.push('- 真实取消券、临时下架、补券、改限时折扣都必须另走授权执行和执行后回读。');
  lines.push(`- 完整机器数据：\`${report.sources.guard}\`；CSV 保留给脚本/筛选使用，给人看的结论以本 Markdown 为准。`);
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const guard = JSON.parse((await fs.readFile(args.guard, 'utf8')).replace(/^\uFEFF/, ''));
  const rows = buildRows(guard);
  const report = {
    schemaVersion: 1,
    mode: 'read-only',
    createdAt: new Date().toISOString(),
    reportDate: args.date,
    sources: {guard: rel(args.guard)},
    summary: summarize(rows),
    rows,
  };
  await fs.mkdir(args.outDir, {recursive: true});
  const base = path.join(args.outDir, `known-ordinary-coupon-risk-plan-${args.date}`);
  await fs.writeFile(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await fs.writeFile(`${base}.csv`, toCsv(rows), 'utf8');
  await fs.writeFile(`${base}.md`, buildMarkdown(report), 'utf8');
  console.log(JSON.stringify({ok: true, json: rel(`${base}.json`), csv: rel(`${base}.csv`), md: rel(`${base}.md`), rows: rows.length}, null, 2));
}

await main().catch(err => {
  console.error(err);
  process.exit(1);
});
