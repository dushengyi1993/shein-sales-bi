#!/usr/bin/env node
/**
 * Research-only high coupon candidate report for SHEIN marketing.
 *
 * This script is deliberately read-only. It does not launch browsers, call
 * SHEIN, submit coupons, cancel goods, edit budgets, or create limited
 * discounts. It only combines the approved price plan, latest marketing stack
 * review, and known ordinary activity price evidence to identify which rows
 * might be worth manual 30%/50% coupon review.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  couponPlanStoreView,
  loadCouponTargetEligibilityPlan,
} from '../../lib/marketing_coupon_policy.mjs';
import {
  classifyKnownOrdinaryCouponStack,
  groupOrdinaryEvidenceBySkc,
  loadKnownOrdinaryPriceEvidence,
} from '../../lib/marketing_ordinary_price_evidence.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_TARGET_PLAN = path.join(ROOT, 'tmp', 'marketing-signup', 'selection-plan-2026-06-03-ALL-ready.json');
const DEFAULT_PRICE_OVERRIDES = path.join(ROOT, 'tmp', 'marketing-signup', 'price-overrides-2026-06-03-ALL-ready.json');
const DEFAULT_OUT_DIR = path.join(ROOT, 'outputs', 'reports');
const RATES = [30, 50];
const PRICE_TOLERANCE_SAR = 1;
const FLOOR_MARGIN = 0.15;

function parseArgs(argv) {
  const args = {
    date: formatLocalDate(new Date()),
    targetPlan: DEFAULT_TARGET_PLAN,
    priceOverrides: DEFAULT_PRICE_OVERRIDES,
    stackReview: '',
    outDir: DEFAULT_OUT_DIR,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--date') args.date = String(argv[++i] || '').trim();
    else if (a === '--target-plan') args.targetPlan = path.resolve(argv[++i]);
    else if (a === '--price-overrides') args.priceOverrides = path.resolve(argv[++i]);
    else if (a === '--stack-review') args.stackReview = path.resolve(argv[++i]);
    else if (a === '--out-dir') args.outDir = path.resolve(argv[++i]);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new Error(`Invalid --date ${args.date}; expected YYYY-MM-DD`);
  if (!args.stackReview) args.stackReview = latestFile(path.join(ROOT, 'outputs', 'reports'), /^marketing-stack-review-\d{4}-\d{2}-\d{2}\.json$/);
  return args;
}

function formatLocalDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function rel(file) {
  return path.relative(ROOT, file || '').replaceAll('\\', '/');
}

function latestFile(dir, regex) {
  if (!fsSync.existsSync(dir)) return '';
  return fsSync.readdirSync(dir, {withFileTypes: true})
    .filter(d => d.isFile() && regex.test(d.name))
    .map(d => path.join(dir, d.name))
    .sort((a, b) => fsSync.statSync(b).mtimeMs - fsSync.statSync(a).mtimeMs)[0] || '';
}

async function readJson(file) {
  return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/[%SAR,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function buildStackDetailIndex(stackDoc) {
  const map = new Map();
  for (const row of Array.isArray(stackDoc?.detailRows) ? stackDoc.detailRows : []) {
    const storeKey = String(row['店铺'] || row.storeKey || '').trim().toUpperCase();
    const skc = String(row.SKC || row.skc || '').trim();
    if (!storeKey || !skc) continue;
    const key = `${storeKey}__${skc}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function pickStackDetail(details, activityId) {
  if (!details.length) return null;
  const exact = details.find(row => String(row['活动ID'] || '') === String(activityId || ''));
  return exact || details[0];
}

function hasExistingOrdinaryLabel(details) {
  return details.some(row => /既有(?:普通活动)?标签|既有普通营销活动|旧普通活动|度假季/.test([
    row['普通营销活动价/折扣'],
    row['风险提示'],
  ].filter(Boolean).join(' ')));
}

function classifyRate({planRow, stackRow, stackRows, knownEvidenceRows, ratePct}) {
  const factor = round2(1 - ratePct / 100);
  const finalTargetPrice = numberOrNull(planRow.finalTargetPrice);
  const currentSellingPrice = numberOrNull(stackRow?.['当前售价SAR']);
  const minDiscountPct = numberOrNull(stackRow?.['平台最低降幅%']);
  const fullCost = numberOrNull(stackRow?.['含仓储费成本SAR']) ?? numberOrNull(stackRow?.['商品完整成本SAR']) ?? numberOrNull(planRow.cost);
  const storage = numberOrNull(stackRow?.['仓储费摊销SAR/件']);
  const requiredBasePrice = finalTargetPrice !== null ? round2(finalTargetPrice / factor) : null;
  const platformAllowedMaxBasePrice = currentSellingPrice !== null && minDiscountPct !== null
    ? round2(currentSellingPrice * (1 - minDiscountPct / 100))
    : null;
  const finalIfPlatformForcedMax = platformAllowedMaxBasePrice !== null ? round2(platformAllowedMaxBasePrice * factor) : null;
  const marginAfterCost = finalTargetPrice !== null && fullCost !== null && finalTargetPrice > 0
    ? round2((finalTargetPrice - fullCost) / finalTargetPrice)
    : null;
  const oldOrdinaryGuard = knownEvidenceRows.length
    ? classifyKnownOrdinaryCouponStack(knownEvidenceRows, {...planRow, couponFactor: factor, finalTargetPrice}, {fallbackDiscountPct: ratePct})
    : null;

  const reasons = [];
  let decision = 'research_candidate_needs_manual_review';
  let priority = 50;

  if (/券都禁止|不叠券|禁止(?:15|30|50)%?券/.test(String(planRow.combo || ''))) {
    reasons.push('current_plan_forbids_coupon');
  }
  if (finalTargetPrice === null) reasons.push('missing_final_target_price');
  if (currentSellingPrice === null) reasons.push('missing_current_selling_price');
  if (minDiscountPct === null) reasons.push('missing_platform_min_discount');
  if (fullCost === null) reasons.push('missing_full_cost');
  if (storage === null) reasons.push('missing_storage_cost_evidence');
  if (marginAfterCost !== null && marginAfterCost < FLOOR_MARGIN) reasons.push('below_15pct_margin_floor');
  if (requiredBasePrice !== null && platformAllowedMaxBasePrice !== null && requiredBasePrice > platformAllowedMaxBasePrice + PRICE_TOLERANCE_SAR) {
    reasons.push('platform_min_discount_forces_lower_base_price');
  }
  if (oldOrdinaryGuard?.decision === 'known_ordinary_final_below_target') {
    reasons.push('known_old_ordinary_price_would_stack_below_target');
  }
  if (!knownEvidenceRows.length && hasExistingOrdinaryLabel(stackRows)) {
    reasons.push('existing_ordinary_label_without_price_evidence');
  }

  if (reasons.length) {
    decision = 'blocked_or_needs_evidence';
    priority = reasons.includes('known_old_ordinary_price_would_stack_below_target') ? 5 : 20;
  } else if (ratePct === 50) {
    priority = 10;
  } else if (ratePct === 30) {
    priority = 15;
  }

  return {
    ratePct,
    couponFactor: factor,
    decision,
    reasons,
    priority,
    finalTargetPrice,
    requiredBasePrice,
    currentSellingPrice,
    platformMinDiscountPct: minDiscountPct,
    platformAllowedMaxBasePrice,
    finalIfPlatformForcedMax,
    fullCost,
    storageCost: storage,
    marginAfterCost,
    knownOldOrdinaryLowestPrice: oldOrdinaryGuard?.lowestOrdinaryPrice ?? null,
    knownOldOrdinaryFinalWithCoupon: oldOrdinaryGuard?.finalWithCoupon ?? null,
    knownOldOrdinaryDecision: oldOrdinaryGuard?.decision || '',
    knownOldOrdinaryActivityId: oldOrdinaryGuard?.lowestOrdinaryEvidence?.activityId || '',
    knownOldOrdinaryEventEnd: oldOrdinaryGuard?.lowestOrdinaryEvidence?.eventEnd || '',
  };
}

function summarize(rows) {
  const byRate = {};
  const byDecision = {};
  const byReason = {};
  for (const row of rows) {
    byRate[row.ratePct] = (byRate[row.ratePct] || 0) + 1;
    byDecision[row.decision] = (byDecision[row.decision] || 0) + 1;
    for (const reason of row.reasons) byReason[reason] = (byReason[reason] || 0) + 1;
  }
  return {
    totalRows: rows.length,
    candidateRows: rows.filter(r => r.decision === 'research_candidate_needs_manual_review').length,
    blockedOrNeedsEvidenceRows: rows.filter(r => r.decision !== 'research_candidate_needs_manual_review').length,
    byRate,
    byDecision,
    byReason,
  };
}

function toCsv(rows) {
  const cols = [
    'storeKey','skc','canonical','ratePct','decision','reasons','finalTargetPrice','requiredBasePrice','currentSellingPrice','platformMinDiscountPct','platformAllowedMaxBasePrice','finalIfPlatformForcedMax','fullCost','storageCost','marginAfterCost','knownOldOrdinaryLowestPrice','knownOldOrdinaryFinalWithCoupon','knownOldOrdinaryDecision','activityId','ordinaryActivityId','ordinaryEventEnd',
  ];
  return [cols.join(','), ...rows.map(row => cols.map(col => csv(row[col])).join(','))].join('\n') + '\n';
}

function csv(value) {
  if (Array.isArray(value)) value = value.join(';');
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function buildMarkdown(report) {
  const lines = [];
  lines.push(`# SHEIN 30%/50% 优惠券研究候选 ${report.reportDate}`);
  lines.push('');
  lines.push('- mode: `research-only`，不提交、不取消、不补预算、不生成 execute 命令。');
  lines.push(`- targetPlan: \`${report.sources.targetPlan}\``);
  lines.push(`- priceOverrides: \`${report.sources.priceOverrides}\``);
  lines.push(`- stackReview: \`${report.sources.stackReview}\``);
  lines.push('');
  lines.push('## 汇总');
  lines.push('');
  lines.push(`- totalRows=${report.summary.totalRows}, candidates=${report.summary.candidateRows}, blockedOrNeedsEvidence=${report.summary.blockedOrNeedsEvidenceRows}`);
  lines.push(`- byRate=${JSON.stringify(report.summary.byRate)}, byDecision=${JSON.stringify(report.summary.byDecision)}`);
  lines.push(`- topReasons=${JSON.stringify(report.summary.byReason)}`);
  lines.push('');
  lines.push('## 人工研究候选 Top 50');
  lines.push('');
  const candidateRows = report.rows.filter(r => r.decision === 'research_candidate_needs_manual_review').slice(0, 50);
  if (!candidateRows.length) {
    lines.push('- 暂无证据完整的 30%/50% 人工研究候选。');
  } else {
    lines.push('| 店铺 | SKC | 标准货号 | 券档 | 目标最终价 | 反推基准价 | 当前售价 | 平台最高可填活动价 | 含仓储利润率 |');
    lines.push('| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const r of candidateRows) {
      lines.push(`| ${r.storeKey} | \`${r.skc}\` | ${r.canonical || ''} | ${r.ratePct}% | ${num(r.finalTargetPrice)} | ${num(r.requiredBasePrice)} | ${num(r.currentSellingPrice)} | ${num(r.platformAllowedMaxBasePrice)} | ${pct(r.marginAfterCost)} |`);
    }
  }
  lines.push('');
  lines.push('## 被阻断/需补证据 Top 80');
  lines.push('');
  const blockedRows = report.rows.filter(r => r.decision !== 'research_candidate_needs_manual_review').slice(0, 80);
  if (!blockedRows.length) {
    lines.push('- 无阻断项。');
  } else {
    lines.push('| 店铺 | SKC | 标准货号 | 券档 | 原因 | 目标最终价 | 反推基准价 | 平台最高可填活动价 | 旧活动券后价 |');
    lines.push('| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: |');
    for (const r of blockedRows) {
      lines.push(`| ${r.storeKey} | \`${r.skc}\` | ${r.canonical || ''} | ${r.ratePct}% | ${r.reasons.join(';')} | ${num(r.finalTargetPrice)} | ${num(r.requiredBasePrice)} | ${num(r.platformAllowedMaxBasePrice)} | ${num(r.knownOldOrdinaryFinalWithCoupon)} |`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : '';
}

function pct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${(n * 100).toFixed(2)}%` : '';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.stackReview) throw new Error('No marketing stack review JSON found; pass --stack-review');
  const plan = await loadCouponTargetEligibilityPlan({
    root: ROOT,
    planPath: args.targetPlan,
    priceOverridesPaths: [args.priceOverrides],
    targetDiscountPct: 15,
    allowPlanItemCouponPolicy: true,
  });
  const stackDoc = await readJson(args.stackReview);
  const stackIndex = buildStackDetailIndex(stackDoc);
  const rows = [];
  const storeKeys = [...plan.rowsByStore.keys()].sort();
  const ordinaryEvidenceByStore = new Map();
  for (const storeKey of storeKeys) {
    const evidence = await loadKnownOrdinaryPriceEvidence({root: ROOT, storeKey});
    ordinaryEvidenceByStore.set(storeKey, groupOrdinaryEvidenceBySkc(evidence.rows));
  }
  for (const storeKey of storeKeys) {
    const view = couponPlanStoreView(plan, storeKey);
    const bySkc = ordinaryEvidenceByStore.get(storeKey) || new Map();
    for (const planRow of view.rows) {
      const details = stackIndex.get(`${storeKey}__${planRow.skc}`) || [];
      const stackRow = pickStackDetail(details, planRow.activityId);
      for (const ratePct of RATES) {
        const rate = classifyRate({
          planRow,
          stackRow,
          stackRows: details,
          knownEvidenceRows: bySkc.get(planRow.skc) || [],
          ratePct,
        });
        rows.push({
          storeKey,
          skc: planRow.skc,
          canonical: planRow.canonical,
          supplierNo: planRow.supplierNo,
          activityId: planRow.activityId,
          combo: planRow.combo,
          category: planRow.category,
          ...rate,
        });
      }
    }
  }
  rows.sort((a, b) => a.priority - b.priority
    || b.ratePct - a.ratePct
    || String(a.storeKey).localeCompare(String(b.storeKey))
    || String(a.canonical).localeCompare(String(b.canonical))
    || String(a.skc).localeCompare(String(b.skc)));
  const report = {
    schemaVersion: 1,
    mode: 'research-only',
    createdAt: new Date().toISOString(),
    reportDate: args.date,
    safety: {
      readOnly: true,
      writeActions: false,
      generatesCommands: false,
      forbidden: ['high_coupon_submission', 'write_actions', 'execute_mode'],
    },
    sources: {
      targetPlan: rel(args.targetPlan),
      priceOverrides: rel(args.priceOverrides),
      stackReview: rel(args.stackReview),
    },
    ratesPct: RATES,
    summary: summarize(rows),
    rows,
  };
  await fs.mkdir(args.outDir, {recursive: true});
  const base = path.join(args.outDir, `marketing-high-coupon-research-${args.date}`);
  await fs.writeFile(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await fs.writeFile(`${base}.csv`, toCsv(rows), 'utf8');
  await fs.writeFile(`${base}.md`, buildMarkdown(report), 'utf8');
  console.log(JSON.stringify({ok: true, mode: report.mode, json: rel(`${base}.json`), csv: rel(`${base}.csv`), md: rel(`${base}.md`), candidates: report.summary.candidateRows}, null, 2));
}

await main().catch(err => {
  console.error(err);
  process.exit(1);
});
