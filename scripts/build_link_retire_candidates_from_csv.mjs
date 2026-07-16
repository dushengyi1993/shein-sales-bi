#!/usr/bin/env node
/**
 * Build a read-only low-exposure / zero-sales retire candidate report from an
 * enriched link CSV. This never calls SHEIN OpenAPI and never executes
 * off-shelf writes; it only prepares a human-confirmation table.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {evaluateLowExposureZeroSalesRetireCandidate} from '../lib/link_retire_candidate_policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {
    input: '',
    outDir: path.join(ROOT, 'tmp', 'retire-candidates'),
    performanceDate: '',
    prefix: 'retire-candidates-v5-first-shelf-15d',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--input' || a === '--csv') args.input = path.resolve(String(argv[++i] || ''));
    else if (a === '--out-dir') args.outDir = path.resolve(String(argv[++i] || ''));
    else if (a === '--performance-date' || a === '--perf-date') args.performanceDate = String(argv[++i] || '').trim();
    else if (a === '--prefix') args.prefix = String(argv[++i] || '').trim() || args.prefix;
  }
  if (!args.input) throw new Error('build_link_retire_candidates_from_csv requires --input <enriched candidate csv>');
  return args;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuote = false;
  const src = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuote) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuote = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') {
      cell += ch;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const headers = rows.shift() || [];
  return rows
    .filter(r => r.some(x => String(x || '').trim()))
    .map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, columns) {
  return [
    columns.map(csvEscape).join(','),
    ...rows.map(row => columns.map(col => csvEscape(row[col])).join(',')),
  ].join('\n');
}

function stamp() {
  const now = new Date(Date.now() + 8 * 3600_000);
  return now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

function inferPerformanceDate(args, rows) {
  return args.performanceDate
    || rows.find(r => r.perf_date)?.perf_date
    || rows.find(r => r.performanceDate)?.performanceDate
    || rows.find(r => r.date)?.date
    || '';
}

function groupCount(rows, key) {
  const map = new Map();
  for (const row of rows) map.set(row[key] || '', (map.get(row[key] || '') || 0) + 1);
  return [...map.entries()]
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'zh-Hans-CN'))
    .map(([value, count]) => ({[key]: value, count}));
}

function groupProducts(rows) {
  const map = new Map();
  for (const row of rows) map.set(row.standard_goods_sn || '', (map.get(row.standard_goods_sn || '') || 0) + 1);
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), 'zh-Hans-CN'))
    .map(([standardGoodsSn, count]) => ({standardGoodsSn, count}));
}

function withVerdict(row, performanceDate) {
  const verdict = evaluateLowExposureZeroSalesRetireCandidate({
    ...row,
    performanceDate,
  }, {performanceDate});
  return {
    ...row,
    shelf_age_days_at_perf_date: verdict.shelfAgeDays ?? '',
    retire_candidate_bucket: verdict.bucket,
    retire_candidate_reason: verdict.reason,
    first_shelf_15d_cutoff_date: verdict.cutoffDate || '',
    recovery_or_relist_date: verdict.recoveryDate || '',
    recovery_age_days_at_perf_date: verdict.recoveryAgeDays ?? '',
    recovery_evidence_source: verdict.recoveryEvidenceSource || '',
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rows = parseCsv(await fs.readFile(args.input, 'utf8'));
  const performanceDate = inferPerformanceDate(args, rows);
  if (!performanceDate) throw new Error('missing performance date; pass --performance-date YYYY-MM-DD or include perf_date/date column');
  const evaluated = rows.map(row => withVerdict(row, performanceDate));
  const candidates = evaluated.filter(row => row.retire_candidate_bucket === 'candidate');
  const excludedByFirstShelf15d = evaluated.filter(row => row.retire_candidate_bucket === 'excludedByFirstShelf15d');
  const excludedByNewGoodsTag = evaluated.filter(row => row.retire_candidate_bucket === 'excludedByNewGoodsTag');
  const excludedByRecentRecovery15d = evaluated.filter(row => row.retire_candidate_bucket === 'excludedByRecentRecovery15d');
  const cannotJudge = evaluated.filter(row => row.retire_candidate_bucket === 'cannotJudge');
  const targetSkcs = ['sv260628145147517093202', 'sv260620170564657240918'];
  const targetSkcCheck = targetSkcs.map(skc => {
    const row = evaluated.find(x => x.skc === skc) || {};
    return {
      skc,
      presentInCandidates: candidates.some(x => x.skc === skc),
      bucket: row.retire_candidate_bucket || '',
      reason: row.retire_candidate_reason || '',
      store: row.store || row.store_key || '',
      standard_goods_sn: row.standard_goods_sn || '',
      first_shelf_time: row.first_shelf_time || '',
      shelf_age_days_at_perf_date: row.shelf_age_days_at_perf_date || '',
    };
  });
  const summary = {
    generatedAt: new Date(Date.now() + 8 * 3600_000).toISOString().replace('Z', '+08:00'),
    reportVersion: 'v6-first-shelf-and-recovery-15d',
    input: args.input,
    performanceDate,
    criteria: {
      currentStatus: 'current on-shelf links only',
      c7Exposure: 'c7EpsUv <= 300',
      c7Sales: 'c7_sale_cnt = 0',
      newTagExclusion: 'exclude non-empty raw_summary.newGoodsTag / newGoodsTag',
      firstShelf15dSafety: 'exclude first_shelf_time within 15 days regardless of newGoodsTag; missing first_shelf_time is cannotJudge',
      recovery15dSafety: 'exclude inventory_recovery_date / relisted_at within 15 days; last_shelf_time is fallback only',
      executionBoundary: 'read-only report; user confirmation is required before retire_link and （废）standard goods sn changes',
    },
    counts: {
      inputRows: rows.length,
      candidateRows: candidates.length,
      excludedByFirstShelf15d: excludedByFirstShelf15d.length,
      excludedByNewGoodsTag: excludedByNewGoodsTag.length,
      excludedByRecentRecovery15d: excludedByRecentRecovery15d.length,
      cannotJudgeRows: cannotJudge.length,
    },
    byStore: groupCount(candidates, 'store'),
    byProductTop: groupProducts(candidates).slice(0, 50),
    targetSkcCheck,
    excludedByFirstShelf15dExamples: excludedByFirstShelf15d.slice(0, 50),
    cannotJudgeExamples: cannotJudge.slice(0, 30),
  };
  const columns = [
    ...Object.keys(evaluated[0] || {}).filter(c => ![
      'shelf_age_days_at_perf_date',
      'retire_candidate_bucket',
      'retire_candidate_reason',
      'first_shelf_15d_cutoff_date',
      'recovery_or_relist_date',
      'recovery_age_days_at_perf_date',
      'recovery_evidence_source',
    ].includes(c)),
    'shelf_age_days_at_perf_date',
    'retire_candidate_bucket',
    'retire_candidate_reason',
    'first_shelf_15d_cutoff_date',
    'recovery_or_relist_date',
    'recovery_age_days_at_perf_date',
    'recovery_evidence_source',
  ];
  await fs.mkdir(args.outDir, {recursive: true});
  const base = path.join(args.outDir, `${args.prefix}.${stamp()}`);
  const outCsv = `${base}.csv`;
  const outJson = `${base}.json`;
  const outSummary = `${base}-summary.json`;
  const outMd = `${base}.md`;
  await fs.writeFile(outCsv, `\uFEFF${toCsv(candidates, columns)}`, 'utf8');
  await fs.writeFile(outJson, JSON.stringify({summary, rows: candidates}, null, 2), 'utf8');
  await fs.writeFile(outSummary, JSON.stringify(summary, null, 2), 'utf8');
  const md = [
    '# 待下架链接候选明细 v6-first-shelf-and-recovery-15d（只读）',
    '',
    '**固定安全线：首次上架或库存恢复/重新在售 15 天内，不管有没有新品标签或营销活动，都不执行下架。未执行下架/改货号。**',
    '',
    `- 表现数据日：${performanceDate}`,
    `- 输入行：${rows.length}；候选：${candidates.length}；首次上架15天保护：${excludedByFirstShelf15d.length}；库存恢复/重新在售15天保护：${excludedByRecentRecovery15d.length}；新品标签排除：${excludedByNewGoodsTag.length}；待确认/不执行：${cannotJudge.length}。`,
    '',
    '## 按店铺汇总',
    '',
    '| 店铺 | 候选数 |',
    '|---|---:|',
    ...summary.byStore.map(r => `| ${r.store} | ${r.count} |`),
    '',
    '## 候选明细',
    '',
    '| store | 标准货号 | SKC | 创建时间 | 初次上架时间 | 快照日上架天数 | 7天曝光 | 7天销量 | 建议废货号 |',
    '|---|---|---|---|---|---:|---:|---:|---|',
    ...candidates.map(r => `| ${r.store || ''} | ${r.standard_goods_sn || ''} | ${r.skc || ''} | ${r.link_created_time || ''} | ${r.first_shelf_time || ''} | ${r.shelf_age_days_at_perf_date || ''} | ${r.c7_exposure ?? r.c7EpsUv ?? ''} | ${r.c7_sale_cnt ?? r.c7SaleCnt ?? ''} | ${r.suggested_waste_goods_sn || ''} |`),
  ].join('\n');
  await fs.writeFile(outMd, md, 'utf8');
  console.log(JSON.stringify({ok: true, outCsv, outMd, outJson, outSummary, counts: summary.counts, targetSkcCheck}, null, 2));
}

await main();
