#!/usr/bin/env node
/**
 * Build a read-only daily guard report for SHEIN marketing automation.
 *
 * This script intentionally does not call SHEIN, launch browsers, submit
 * activities, cancel coupons, edit budgets, or modify limited discounts. It
 * only summarizes existing scan/audit artifacts so heartbeat automation can
 * report from stable evidence instead of re-interpreting files ad hoc.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_OUT_DIR = path.join(ROOT, 'outputs', 'reports');
const DEFAULT_MAX_AGE_HOURS = 72;
const TARGET_PLAN_DEFAULT = path.join(ROOT, 'tmp', 'marketing-signup', 'selection-plan-2026-06-03-ALL-ready.json');
const PRICE_OVERRIDES_DEFAULT = path.join(ROOT, 'tmp', 'marketing-signup', 'price-overrides-2026-06-03-ALL-ready.json');
const CRITICAL_SOURCE_LABELS = new Set([
  'couponSubmitLatestSummary',
  'lowPriceOverlapLive',
  'lowPriceOverlapCancelList',
  'oldOrdinaryOverlapLive',
  'oldOrdinaryOverlapCancelList',
  'marketingStackReview',
]);
const STALE_BLOCKER_SOURCE_LABELS = new Set([
  'couponSubmitLatestSummary',
  'lowPriceOverlapLive',
  'lowPriceOverlapCancelList',
  'oldOrdinaryOverlapLive',
  'oldOrdinaryOverlapCancelList',
]);

function parseArgs(argv) {
  const args = {
    date: formatLocalDate(new Date()),
    outDir: DEFAULT_OUT_DIR,
    maxAgeHours: DEFAULT_MAX_AGE_HOURS,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--date') args.date = String(argv[++i] || '').trim();
    else if (a === '--out-dir') args.outDir = path.resolve(argv[++i]);
    else if (a === '--max-age-hours') args.maxAgeHours = Number(argv[++i]);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new Error(`Invalid --date ${args.date}; expected YYYY-MM-DD`);
  if (!Number.isFinite(args.maxAgeHours) || args.maxAgeHours <= 0) args.maxAgeHours = DEFAULT_MAX_AGE_HOURS;
  return args;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatLocalDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function rel(file) {
  if (!file) return '';
  return path.relative(ROOT, file).replaceAll('\\', '/');
}

function exists(file) {
  return Boolean(file && fsSync.existsSync(file));
}

function parseLocalDateTime(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] || 0),
    Number(m[5] || 0),
    Number(m[6] || 0),
  );
}

function parseAnyDateTime(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  const parsed = new Date(s);
  if (Number.isFinite(parsed.getTime())) return parsed;
  return parseLocalDateTime(s);
}

function ageHours(now, then) {
  if (!now || !then) return null;
  return Math.round(((now.getTime() - then.getTime()) / 36_000)) / 100;
}

function listFiles(dir, regex) {
  if (!fsSync.existsSync(dir)) return [];
  return fsSync.readdirSync(dir, {withFileTypes: true})
    .filter(d => d.isFile() && regex.test(d.name))
    .map(d => path.join(dir, d.name))
    .sort((a, b) => fsSync.statSync(b).mtimeMs - fsSync.statSync(a).mtimeMs);
}

function latestFile(dir, regex) {
  return listFiles(dir, regex)[0] || '';
}

async function readJsonIfExists(file, fallback = null) {
  if (!exists(file)) return fallback;
  const text = await fs.readFile(file, 'utf8');
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}

async function readSource(label, file, now, maxAgeHours) {
  const source = {
    label,
    path: rel(file),
    exists: exists(file),
    mtime: '',
    generatedAt: '',
    createdAt: '',
    ageHours: null,
    status: 'missing',
  };
  if (!source.exists) return {source, data: null};
  const stat = fsSync.statSync(file);
  source.mtime = stat.mtime.toISOString();
  source.artifactAgeHours = ageHours(now, stat.mtime);
  source.ageHours = source.artifactAgeHours;
  try {
    const data = await readJsonIfExists(file, null);
    source.generatedAt = data?.generatedAt || data?.source?.biGeneratedAt || '';
    source.createdAt = data?.createdAt || data?.summary?.createdAt || '';
    source.dataTimestamp = source.generatedAt || source.createdAt || '';
    const dataDate = parseAnyDateTime(source.dataTimestamp);
    source.dataAgeHours = dataDate ? ageHours(now, dataDate) : null;
    source.status = (
      (source.artifactAgeHours !== null && source.artifactAgeHours > maxAgeHours)
      || (source.dataAgeHours !== null && source.dataAgeHours > maxAgeHours)
    ) ? 'stale' : 'ok';
    return {source, data};
  } catch (err) {
    source.status = 'parse_error';
    source.error = err.message;
    return {source, data: null};
  }
}

function countBy(rows, field) {
  const out = {};
  for (const row of rows || []) {
    const key = String(row?.[field] || '(empty)');
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function countOrderStatuses(orderAuditFiles) {
  const statusCounts = {};
  let rows = 0;
  const samples = [];
  for (const doc of orderAuditFiles) {
    for (const row of doc?.rows || []) {
      rows += 1;
      const status = String(row.status || row.reason || 'unknown');
      statusCounts[status] = (statusCounts[status] || 0) + 1;
      if (samples.length < 10) {
        samples.push({
          storeKey: row.storeKey,
          orderNo: row.orderNo,
          skc: row.skc,
          canonical: row.canonical,
          currencyPrice: row.currencyPrice,
          finalTargetPrice: row.finalTargetPrice,
          deltaSar: row.deltaSar,
          planWindowStatus: row.planWindowStatus,
          status: row.status,
        });
      }
    }
  }
  return {
    files: orderAuditFiles.length,
    rows,
    below: statusCounts.below_target || 0,
    above: statusCounts.above_target || 0,
    outsideWindow: statusCounts.outside_plan_window || 0,
    grainUnknown: statusCounts.grain_unknown || 0,
    missingPlan: statusCounts.missing_plan || 0,
    statusCounts,
    samples,
  };
}

function summarizeCouponSubmit(doc) {
  if (!doc) return {status: 'unknown'};
  const stores = Array.isArray(doc.stores) ? doc.stores : [];
  const identityFailures = stores
    .filter(s => s?.identity && s.identity.ok === false)
    .map(s => ({store: s.store, reason: s.identity.reason || s.identity.error || 'identity_failed'}));
  return {
    status: doc.dryRun === true ? 'ok' : 'untrusted',
    summaryPath: '',
    dryRun: doc.dryRun === true,
    ok: doc.ok,
    okStores: doc.totals?.okStores ?? stores.filter(s => s.ok).length,
    failedStores: doc.totals?.failedStores ?? stores.filter(s => !s.ok).length,
    targetCount: doc.totals?.targetCount ?? stores.reduce((n, s) => n + Number(s.target?.targetCount || 0), 0),
    toSubmit: doc.totals?.toSubmit ?? stores.reduce((n, s) => n + Number(s.target?.toSubmit || 0), 0),
    identityFailures,
  };
}

function summarizeLowPriceOverlap(liveDoc, cancelDoc) {
  const stores = Array.isArray(liveDoc?.stores) ? liveDoc.stores : [];
  const priceDecisionCounts = liveDoc?.priceDecisionCounts || {};
  return {
    belowTarget: Number(liveDoc?.activeCouponBelowTargetCount || 0),
    missingEvidence: Number(liveDoc?.activeCouponMissingPriceEvidenceCount || 0),
    matchesTarget: Number(priceDecisionCounts.coupon_final_matches_target || 0),
    aboveTarget: Number(priceDecisionCounts.coupon_final_above_target || 0),
    cancelRows: Array.isArray(cancelDoc?.rows) ? cancelDoc.rows.length : 0,
    allStoresOk: stores.length > 0 ? stores.every(s => s.ok !== false) : null,
    storeCount: stores.length,
  };
}

function summarizeOldOrdinaryOverlap(liveDoc, cancelDoc) {
  return {
    riskCancel: cancelDoc?.riskCancel === true,
    cancelRows: Array.isArray(cancelDoc?.rows) ? cancelDoc.rows.length : 0,
    observationRows: Number(liveDoc?.activeCouponObservationCount || 0),
    riskRows: Number(liveDoc?.activeCouponRiskCount || 0),
    storeCount: Array.isArray(liveDoc?.stores) ? liveDoc.stores.length : 0,
    allStoresOk: Array.isArray(liveDoc?.stores) && liveDoc.stores.length ? liveDoc.stores.every(s => s.ok !== false) : null,
  };
}

function summarizeAboveTargetActions(doc) {
  const rows = (doc?.rows || []).map(r => ({
    storeKey: r.storeKey,
    skc: r.skc,
    canonical: r.canonical,
    currentBasePrice: r.limitedDiscountPrice,
    targetBaseNeeded: r.targetBaseNeeded,
    finalWithCoupon: r.finalWithCoupon,
    targetFinalPrice: r.targetFinalPrice,
    diff: r.diff,
    limitedDiscountEnd: r.limitedDiscountEnd,
    suggestedAction: r.suggestedAction,
    executeAutomatically: r.executeAutomatically === true,
  }));
  return {count: rows.length, rows};
}

function summarizeBiPortal(doc, source) {
  return {
    generatedAt: doc?.generatedAt || '',
    salesDate: doc?.dates?.salesDate || '',
    linkDate: doc?.dates?.linkDate || '',
    businessDate: doc?.dates?.businessDate || '',
    status: source.status,
    stale: source.status === 'stale',
  };
}

function summarizeT3Candidates(stackDoc, reportDate) {
  const start = parseLocalDateTime(`${reportDate} 00:00:00`);
  const end = new Date(start.getTime() + 3 * 24 * 60 * 60 * 1000);
  const grouped = new Map();
  for (const row of stackDoc?.detailRows || []) {
    const deadline = parseLocalDateTime(row['报名截止']);
    if (!deadline || deadline < start || deadline > end) continue;
    if (String(row['活动类型'] || '').includes('优惠券')) continue;
    const key = [row['店铺'], row['活动ID']].join('::');
    const item = grouped.get(key) || {
      store: row['店铺'],
      activityId: row['活动ID'],
      activityName: row['活动名称'],
      signupDeadline: row['报名截止'],
      rows: 0,
      missingCostRows: 0,
      missingStorageRows: 0,
      missingOverrideRows: 0,
      canonicalSamples: [],
    };
    item.rows += 1;
    if (!(Number(row['商品完整成本SAR']) > 0)) item.missingCostRows += 1;
    if (!(Number(row['仓储费摊销SAR/件']) > 0)) item.missingStorageRows += 1;
    const combo = String(row['本期组合/券策略'] || row['修改意见/备注'] || '');
    if (!combo && !(Number(row['本次建议普通活动价SAR']) > 0)) item.missingOverrideRows += 1;
    if (item.canonicalSamples.length < 5 && row['标准货号']) item.canonicalSamples.push(row['标准货号']);
    grouped.set(key, item);
  }
  return [...grouped.values()].sort((a, b) => String(a.signupDeadline).localeCompare(String(b.signupDeadline)));
}

function latestOrderAuditSelection() {
  const dir = path.join(ROOT, 'tmp', 'marketing-signup', 'order-price-audit');
  const selected = new Map();
  const ignoredNoWindowFiles = [];
  for (const file of listFiles(dir, /^order-price-audit-.*\.json$/)) {
    let doc = null;
    try {
      doc = JSON.parse(fsSync.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const stores = Array.isArray(doc?.summary?.stores) && doc.summary.stores.length
      ? doc.summary.stores
      : [path.basename(file).split('-').slice(3, 4).join('') || path.basename(file)];
    const hasWindow = Boolean(doc?.summary?.planStartTime && doc?.summary?.planEndTime);
    if (!hasWindow) {
      ignoredNoWindowFiles.push({
        path: rel(file),
        stores,
        reason: 'missing planStartTime/planEndTime',
      });
      continue;
    }
    for (const store of stores) {
      if (!selected.has(store)) {
        selected.set(store, {file, hasWindow, store});
      }
    }
  }
  const selectedFiles = [...new Set([...selected.values()].map(x => x.file))].slice(0, 10);
  return {selectedFiles, ignoredNoWindowFiles: ignoredNoWindowFiles.slice(0, 50)};
}

function loadPreviousGuardReport(reportDate) {
  const dir = DEFAULT_OUT_DIR;
  const files = listFiles(dir, /^marketing-daily-guard-\d{4}-\d{2}-\d{2}\.json$/)
    .filter(f => !f.endsWith(`marketing-daily-guard-${reportDate}.json`));
  if (!files.length) return null;
  try {
    return JSON.parse(fsSync.readFileSync(files[0], 'utf8'));
  } catch {
    return null;
  }
}

function buildChangesSincePrevious(current, previous) {
  if (!previous) return [];
  const changes = [];
  const pairs = [
    ['lowPriceOverlap.belowTarget', current.lowPriceOverlap?.belowTarget, previous.lowPriceOverlap?.belowTarget],
    ['lowPriceOverlap.missingEvidence', current.lowPriceOverlap?.missingEvidence, previous.lowPriceOverlap?.missingEvidence],
    ['aboveTargetActions.count', current.aboveTargetActions?.count, previous.aboveTargetActions?.count],
    ['oldOrdinaryOverlap.cancelRows', current.oldOrdinaryOverlap?.cancelRows, previous.oldOrdinaryOverlap?.cancelRows],
    ['t3MarketingCandidates.count', current.t3MarketingCandidates?.length, previous.t3MarketingCandidates?.length],
  ];
  for (const [field, now, before] of pairs) {
    if (now !== before) changes.push({field, previous: before, current: now});
  }
  return changes;
}

function validateSuggestedCommand(command) {
  const c = String(command || '');
  const violations = [];
  if (/\s--execute(?:\s|$)/.test(c)) violations.push('contains --execute');
  if (/submit_coupon_activity_goods\.mjs/.test(c) && !/--dry-run|--no-submit/.test(c)) {
    violations.push('submit_coupon_activity_goods.mjs must include --dry-run or --no-submit');
  }
  if (/--discount-max\s+(30|50)\b/.test(c)) violations.push('contains forbidden --discount-max 30/50');
  if (/(cancel_coupon_extra_goods|set_coupon_site_budget|end_limited_discounts_for_coupon_plan|apply_hl_limited_discount_rescue)\.mjs/.test(c)) {
    violations.push('write-capable script is not allowed as a suggested command');
  }
  return violations;
}

function buildDryRunCommands(reportDate) {
  if (reportDate < '2026-06-09') return [];
  const storesConfig = JSON.parse(fsSync.readFileSync(path.join(ROOT, 'config', 'stores.json'), 'utf8'));
  const stores = (storesConfig.stores || []).filter(s => s.enabled !== false).map(s => s.storeKey).join(',');
  return [{
    label: 'post-holiday-15pct-coupon-dry-run',
    command: `node scripts/marketing/submit_coupon_activity_goods.mjs --stores ${stores} --target-plan ${rel(TARGET_PLAN_DEFAULT)} --price-overrides ${rel(PRICE_OVERRIDES_DEFAULT)} --dry-run`,
  }];
}

function addBlocker(blockers, code, message, evidence = {}) {
  blockers.push({code, message, evidence});
}

function buildMarkdown(report) {
  const lines = [];
  lines.push(`# SHEIN 营销每日巡检 ${report.reportDate}`);
  lines.push('');
  lines.push(`- mode: \`${report.mode}\``);
  lines.push(`- generated: \`${report.createdAt}\``);
  lines.push(`- safety: readOnly=${report.safety.readOnly}, liveScan=${report.safety.liveScan}, writeActions=${report.safety.writeActions}`);
  lines.push('');
  lines.push('## 状态摘要');
  lines.push('');
  lines.push(report.noActionSummary || '未生成状态摘要。');
  lines.push('');
  lines.push('## 阻塞 / 风险');
  lines.push('');
  if (!report.blockers.length) {
    lines.push('- 无阻塞项。');
  } else {
    for (const b of report.blockers) lines.push(`- \`${b.code}\`：${b.message}`);
  }
  if (report.sourceWarnings.length) {
    lines.push('');
    lines.push('## 数据源提醒');
    lines.push('');
    for (const w of report.sourceWarnings) lines.push(`- \`${w.code}\`：${w.message}`);
  }
  lines.push('');
  lines.push('## 价格栈');
  lines.push('');
  lines.push(`- 低价限时折扣叠券：below=${report.lowPriceOverlap.belowTarget}, missing=${report.lowPriceOverlap.missingEvidence}, matches=${report.lowPriceOverlap.matchesTarget}, above=${report.lowPriceOverlap.aboveTarget}, cancelRows=${report.lowPriceOverlap.cancelRows}`);
  lines.push(`- 旧普通活动叠券：riskCancel=${report.oldOrdinaryOverlap.riskCancel}, cancelRows=${report.oldOrdinaryOverlap.cancelRows}, observationRows=${report.oldOrdinaryOverlap.observationRows}`);
  lines.push(`- 偏高候选：${report.aboveTargetActions.count}`);
  if (report.aboveTargetActions.rows.length) {
    lines.push('');
    lines.push('| 店铺 | SKC | 标准货号 | 当前基准价 | 建议基准价 | 券后价 | 目标价 | diff |');
    lines.push('| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |');
    for (const r of report.aboveTargetActions.rows.slice(0, 20)) {
      lines.push(`| ${r.storeKey} | \`${r.skc}\` | ${r.canonical} | ${num(r.currentBasePrice)} | ${num(r.targetBaseNeeded)} | ${num(r.finalWithCoupon)} | ${num(r.targetFinalPrice)} | ${num(r.diff)} |`);
    }
  }
  lines.push('');
  lines.push('## T-3 可报活动提醒');
  lines.push('');
  if (!report.t3MarketingCandidates.length) {
    lines.push('- 暂无 T-3 截止活动候选。');
  } else {
    lines.push('| 店铺 | 活动ID | 报名截止 | 行数 | 缺成本 | 缺仓储 |');
    lines.push('| --- | --- | --- | ---: | ---: | ---: |');
    for (const r of report.t3MarketingCandidates.slice(0, 30)) {
      lines.push(`| ${r.store} | ${r.activityId} | ${r.signupDeadline} | ${r.rows} | ${r.missingCostRows} | ${r.missingStorageRows} |`);
    }
  }
  lines.push('');
  lines.push('## 订单价格审计');
  lines.push('');
  lines.push(`- files=${report.orderPriceAudit.files}, rows=${report.orderPriceAudit.rows}, below=${report.orderPriceAudit.below}, above=${report.orderPriceAudit.above}, outsideWindow=${report.orderPriceAudit.outsideWindow}, missingPlan=${report.orderPriceAudit.missingPlan}`);
  if (report.orderPriceAudit.ignoredNoWindowFiles.length) {
    lines.push(`- ignoredNoWindowFiles=${report.orderPriceAudit.ignoredNoWindowFiles.length}（缺活动窗口，未参与 below/above 统计）`);
  }
  lines.push('');
  lines.push('## 建议 dry-run 命令');
  lines.push('');
  if (!report.suggestedDryRunCommands.length) {
    lines.push('- 暂无建议命令。');
  } else {
    for (const c of report.suggestedDryRunCommands) lines.push(`- ${c.label}: \`${c.command}\``);
  }
  lines.push('');
  lines.push('## 数据源');
  lines.push('');
  for (const s of report.sourceFiles) {
    lines.push(`- ${s.label}: ${s.exists ? `\`${s.path}\`` : '(missing)'} status=${s.status} artifactAgeHours=${s.artifactAgeHours ?? '-'} dataAgeHours=${s.dataAgeHours ?? '-'}`);
  }
  lines.push('');
  return lines.join('\n');
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : '';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date();
  const sources = [];
  const read = async (label, file) => {
    const item = await readSource(label, file, now, args.maxAgeHours);
    sources.push(item.source);
    return item;
  };

  const biPortal = await read('biPortalData', path.join(ROOT, 'outputs', 'bi-portal', 'data.json'));
  const couponSubmitPath = latestFile(path.join(ROOT, 'tmp', 'marketing-signup', 'coupon-submit-results'), /^summary-.*\.json$/);
  const couponSubmit = await read('couponSubmitLatestSummary', couponSubmitPath);
  const lowLive = await read('lowPriceOverlapLive', latestFile(path.join(ROOT, 'tmp', 'marketing-signup', 'low-price-overlap-risk'), /^coupon-low-price-overlap-live-.*\.json$/));
  const lowCancel = await read('lowPriceOverlapCancelList', latestFile(path.join(ROOT, 'tmp', 'marketing-signup', 'low-price-overlap-risk'), /^coupon-low-price-overlap-cancel-list-.*\.json$/));
  const oldLive = await read('oldOrdinaryOverlapLive', latestFile(path.join(ROOT, 'tmp', 'marketing-signup', 'old-ordinary-overlap-risk'), /^coupon-old-ordinary-overlap-live-.*\.json$/));
  const oldCancel = await read('oldOrdinaryOverlapCancelList', latestFile(path.join(ROOT, 'tmp', 'marketing-signup', 'old-ordinary-overlap-risk'), /^coupon-old-ordinary-overlap-cancel-list-.*\.json$/));
  const abovePlan = await read('aboveTargetActionPlan', latestFile(path.join(ROOT, 'tmp', 'marketing-signup', 'low-price-overlap-risk'), /^price-above-target-limited-discount-action-plan-.*\.json$/));
  const budgetDryRun = await read('couponBudgetDryRun', latestFile(path.join(ROOT, 'tmp', 'marketing-signup', 'coupon-budget-results'), /^coupon-site-budget-dry-run-.*\.json$/));
  const stackReview = await read('marketingStackReview', latestFile(path.join(ROOT, 'outputs', 'reports'), /^marketing-stack-review-\d{4}-\d{2}-\d{2}\.json$/));

  const orderAuditSelection = latestOrderAuditSelection();
  const orderFiles = orderAuditSelection.selectedFiles;
  const orderDocs = [];
  for (const file of orderFiles) {
    const item = await read(`orderPriceAudit:${path.basename(file)}`, file);
    if (item.data) orderDocs.push(item.data);
  }

  const couponSubmitDryRun = summarizeCouponSubmit(couponSubmit.data);
  couponSubmitDryRun.summaryPath = rel(couponSubmitPath);

  const lowPriceOverlap = summarizeLowPriceOverlap(lowLive.data, lowCancel.data);
  const oldOrdinaryOverlap = summarizeOldOrdinaryOverlap(oldLive.data, oldCancel.data);
  const aboveTargetActions = summarizeAboveTargetActions(abovePlan.data);
  const orderPriceAudit = countOrderStatuses(orderDocs);
  const biPortalFreshness = summarizeBiPortal(biPortal.data, biPortal.source);
  const t3MarketingCandidates = summarizeT3Candidates(stackReview.data, args.date);
  const suggestedDryRunCommands = buildDryRunCommands(args.date);
  const blockers = [];
  const sourceWarnings = [];
  const unknownSources = [];

  const safety = {
    readOnly: true,
    liveScan: false,
    writeActions: false,
    dryRunCommandsOnly: true,
    blockedExecuteCommands: ['--execute', '--discount-max 30', '--discount-max 50'],
  };

  for (const src of sources) {
    if (src.status === 'missing' && CRITICAL_SOURCE_LABELS.has(src.label)) {
      addBlocker(blockers, 'critical_source_missing', `${src.label} 缺失，不能生成 no-action 结论`, {path: src.path});
      unknownSources.push({label: src.label, path: src.path, status: src.status});
    }
    if (src.status === 'parse_error') {
      addBlocker(blockers, 'source_parse_error', `${src.label} 解析失败`, {path: src.path, error: src.error});
      if (CRITICAL_SOURCE_LABELS.has(src.label)) unknownSources.push({label: src.label, path: src.path, status: src.status});
    }
    if (src.status === 'stale' && STALE_BLOCKER_SOURCE_LABELS.has(src.label)) {
      addBlocker(blockers, 'source_stale', `${src.label} 已超过 ${args.maxAgeHours} 小时`, {path: src.path, artifactAgeHours: src.artifactAgeHours, dataAgeHours: src.dataAgeHours});
    } else if (src.status === 'stale') {
      sourceWarnings.push({
        code: 'source_stale',
        label: src.label,
        message: `${src.label} 已超过 ${args.maxAgeHours} 小时，不能作为 no-action 的完整新鲜证据`,
        evidence: {path: src.path, artifactAgeHours: src.artifactAgeHours, dataAgeHours: src.dataAgeHours},
      });
    }
  }
  if (couponSubmitDryRun.status === 'untrusted') addBlocker(blockers, 'coupon_submit_not_dry_run', '最新优惠券提交 summary 不是 dry-run，不能作为自动任务安全证据', {path: couponSubmitDryRun.summaryPath});
  for (const f of couponSubmitDryRun.identityFailures || []) addBlocker(blockers, 'store_identity_failure', `${f.store} 身份校验失败`, f);
  if (lowPriceOverlap.belowTarget > 0) addBlocker(blockers, 'coupon_final_below_target', `低价叠券 below target=${lowPriceOverlap.belowTarget}`);
  if (lowPriceOverlap.missingEvidence > 0) addBlocker(blockers, 'coupon_missing_price_evidence', `低价叠券缺价格证据=${lowPriceOverlap.missingEvidence}`);
  if (lowPriceOverlap.cancelRows > 0) addBlocker(blockers, 'low_price_cancel_rows_nonzero', `低价叠券取消候选 rows=${lowPriceOverlap.cancelRows}`);
  if (oldOrdinaryOverlap.riskCancel || oldOrdinaryOverlap.cancelRows > 0) addBlocker(blockers, 'old_ordinary_cancel_rows_nonzero', `旧普通活动 cancel rows=${oldOrdinaryOverlap.cancelRows}`);
  if (budgetDryRun.source.status === 'missing') {
    // Budget is not always checked daily; keep unknown, not a blocker.
  }
  for (const cmd of suggestedDryRunCommands) {
    const violations = validateSuggestedCommand(cmd.command);
    if (violations.length) addBlocker(blockers, 'unsafe_suggested_command', `${cmd.label} 命令不安全`, {command: cmd.command, violations});
  }

  const report = {
    schemaVersion: 1,
    mode: 'read-only',
    createdAt: now.toISOString(),
    reportDate: args.date,
    sourceFiles: sources,
    safety,
    couponSubmitDryRun,
    lowPriceOverlap,
    oldOrdinaryOverlap,
    aboveTargetActions,
    orderPriceAudit,
    biPortalFreshness,
    t3MarketingCandidates,
    budgetDryRun: budgetDryRun.source.status === 'missing'
      ? {status: 'unknown', reason: 'no coupon budget dry-run source found'}
      : {status: budgetDryRun.source.status, path: budgetDryRun.source.path},
    blockers,
    sourceWarnings,
    unknownSources,
    changesSincePrevious: [],
    noActionSummary: '',
    suggestedDryRunCommands,
  };
  report.orderPriceAudit.ignoredNoWindowFiles = orderAuditSelection.ignoredNoWindowFiles;
  report.changesSincePrevious = buildChangesSincePrevious(report, loadPreviousGuardReport(args.date));
  const canNoAction = !report.blockers.length
    && !report.sourceWarnings.length
    && !report.unknownSources.length
    && !report.t3MarketingCandidates.length
    && !report.aboveTargetActions.count
    && !report.lowPriceOverlap.belowTarget
    && !report.lowPriceOverlap.missingEvidence
    && !report.lowPriceOverlap.cancelRows
    && !report.oldOrdinaryOverlap.riskCancel
    && !report.oldOrdinaryOverlap.cancelRows;
  if (canNoAction) {
    report.noActionSummary = '当前已有证据未显示需要动作；仅保持每日巡检。';
  } else if (!report.blockers.length) {
    report.noActionSummary = '无阻塞项，但存在观察/建议项或数据源提醒；请按报告查看是否需要人工确认。';
  } else {
    report.noActionSummary = '存在阻塞项；需要刷新证据或人工处理后，才能形成安全的 no-action 结论。';
  }

  await fs.mkdir(args.outDir, {recursive: true});
  const jsonPath = path.join(args.outDir, `marketing-daily-guard-${args.date}.json`);
  const mdPath = path.join(args.outDir, `marketing-daily-guard-${args.date}.md`);
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await fs.writeFile(mdPath, buildMarkdown(report), 'utf8');
  console.log(JSON.stringify({ok: true, mode: report.mode, json: rel(jsonPath), md: rel(mdPath), blockers: report.blockers.length}, null, 2));
}

await main().catch(err => {
  console.error(err);
  process.exit(1);
});
