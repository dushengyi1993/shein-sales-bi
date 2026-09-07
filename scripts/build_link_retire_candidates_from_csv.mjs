#!/usr/bin/env node
/**
 * Build a read-only low-exposure / zero-sales retire candidate report from an
 * enriched link CSV or managed-query JSON. This never calls SHEIN OpenAPI and never executes
 * off-shelf writes; it only prepares a human-confirmation table.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {evaluateLowExposureZeroSalesRetireCandidate} from '../lib/link_retire_candidate_policy.mjs';
import {stageAndDeliverBusinessResult} from '../lib/ops_business_result_pipeline.mjs';
import {runLocalCloudTeamReport} from '../lib/cloud_team_report_local.mjs';
import {CLOUD_TEAM_REPORT_CLOUD_HOST, sha256Bytes} from '../lib/cloud_team_report_common.mjs';

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
    else if (a === '--stage-delivery') args.stageDelivery = true;
    else if (a === '--send') args.send = true;
  }
  if (!args.input) throw new Error('build_link_retire_candidates_from_csv requires --input <enriched candidate csv or query json>');
  if (args.send || args.stageDelivery || process.env.STAGE_OPS_DELIVERY === '1') {
    throw new Error('Legacy CSV/JSON policy output is not a complete business review. Use scripts/link_retire_review.mjs and its bound XLSX --send contract for shein-3 delivery.');
  }
  return args;
}

export function parseCsv(text) {
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

export function parseRetireCandidateInput(text, file = '') {
  const source = String(text || '').replace(/^\uFEFF/, '').trim();
  const jsonLike = /\.json$/iu.test(String(file || '')) || source.startsWith('{') || source.startsWith('[');
  if (!jsonLike) return {format: 'csv', rows: parseCsv(source)};
  let parsed;
  try { parsed = JSON.parse(source); }
  catch (error) { throw new Error(`invalid retire candidate JSON: ${error.message}`); }
  const candidates = [
    parsed?.data?.storeLinks,
    parsed?.data?.links,
    parsed?.storeLinks,
    parsed?.links,
    parsed?.rows,
    parsed,
  ];
  const rows = candidates.find(Array.isArray);
  if (!rows) throw new Error('retire candidate JSON has no supported rows array (data.storeLinks/data.links/storeLinks/links/rows)');
  if (!rows.every(row => row && typeof row === 'object' && !Array.isArray(row))) {
    throw new Error('retire candidate JSON rows must be objects');
  }
  return {format: 'json', rows};
}

/**
 * Map managed-query JSON rows (data.storeLinks / data.links) onto the enriched
 * CSV column names the policy and the delisting executor read. This is a
 * display/evidence mapping only: it never invents recovery history, and the
 * new-goods-tag gate stays fail-closed unless the row carries an explicit tag
 * field or the server's own `retire_candidate` flag (which already verified
 * raw newGoodsTag is empty).
 */
export function normalizeQueryRetireRows(rows) {
  const aliases = [
    ['store', 'store', 'store_key', 'storeKey'],
    ['spu', 'spu'],
    ['current_status', 'current_status', 'shelf_status_name', 'shelfStatusName'],
    ['c7_exposure', 'c7_exposure', 'c7EpsUv', 'c7_eps_uv', 'eps_uv'],
    ['c7_sale_cnt', 'c7_sale_cnt', 'c7SaleCnt'],
    ['new_tag_value', 'new_tag_value', 'new_goods_tag', 'newGoodsTag', 'performance_new_goods_tag'],
    ['first_shelf_time', 'first_shelf_time', 'firstShelfTime'],
    ['link_created_time', 'link_created_time', 'created_time', 'createdTime'],
    ['standard_goods_sn', 'standard_goods_sn', 'standardGoodsSn'],
    ['skc', 'skc'],
  ];
  return rows.map(row => {
    const normalized = {...row};
    for (const [target, ...sources] of aliases) {
      if (normalized[target] !== undefined && String(normalized[target]).trim() !== '') continue;
      for (const source of sources) {
        const value = normalized[source];
        if (value !== undefined && value !== null && String(value).trim() !== '') {
          normalized[target] = value;
          break;
        }
      }
    }
    if (!normalized.new_tag_value && normalized.retire_candidate === true) {
      normalized.new_goods_tag = '';
      normalized.new_tag_value = '';
    }
    return normalized;
  });
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
    || rows.find(r => r.link_date)?.link_date
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
  const input = parseRetireCandidateInput(await fs.readFile(args.input, 'utf8'), args.input);
  const rows = input.format === 'json' ? normalizeQueryRetireRows(input.rows) : input.rows;
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
    inputFormat: input.format,
    ...(input.format === 'json' ? {
      evidenceScope: {
        newGoodsTag: 'explicit row tag fields, or server-verified empty when row.retire_candidate === true',
        recoveryEvidence: 'linksData rows do not carry recovery history; rows without inventory_recovery_date/relisted_at/last_shelf_time/recovery_evidence_complete stay 待确认 and never become candidates',
      },
    } : {}),
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

  // F1 hook: stage into shared automation delivery staging area if requested via env or flag
  let stagedResult = null;
  if (process.env.STAGE_OPS_DELIVERY === '1' || args.stageDelivery) {
    try {
      stagedResult = await stageAndDeliverBusinessResult({
        automationId: 'link-retire-candidates',
        businessDate: performanceDate,
        result: {
          action: '待下架链接候选报告筛选',
          ok: true,
          counts: summary.counts,
          performanceDate,
          summary,
        },
        attachmentName: 'candidates.json',
        attachmentContent: JSON.stringify({summary, rows: candidates}, null, 2),
      });
    } catch {}
  }

  let cloudDeliveryOutcome = null;
  if (args.send) {
    try {
      const jsonBytes = await fs.readFile(outJson);
      const expectedSha = sha256Bytes(jsonBytes);
      const sshBin = process.env.CLOUD_TEAM_REPORT_SSH_BIN;
      const sshSpawnImpl = sshBin
        ? (bin, a, o) => {
            if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(sshBin)) {
              return spawn(process.env.ComSpec || 'cmd.exe', ['/c', sshBin, ...a], o);
            }
            return spawn(sshBin, a, o);
          }
        : undefined;
      cloudDeliveryOutcome = await runLocalCloudTeamReport({
        automationId: 'link-retire-candidates',
        businessDate: performanceDate,
        summaryFile: outMd,
        attachment: outJson,
        expectedAttachmentSha256: expectedSha,
        cloudSsh: process.env.CLOUD_TEAM_REPORT_SSH_HOST || CLOUD_TEAM_REPORT_CLOUD_HOST,
        ...(sshSpawnImpl ? { spawnImpl: sshSpawnImpl } : {}),
      });
    } catch (err) {
      cloudDeliveryOutcome = { ok: false, error: err.message };
    }
  }

  console.log(JSON.stringify({
    ok: true, outCsv, outMd, outJson, outSummary, counts: summary.counts, targetSkcCheck,
    ...(stagedResult ? { stagedDelivery: stagedResult.status } : {}),
    ...(cloudDeliveryOutcome ? { sendDelivery: cloudDeliveryOutcome } : {}),
  }, null, 2));
}

await main();
