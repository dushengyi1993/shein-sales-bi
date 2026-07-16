/**
 * Shared read-only policy for low-exposure / zero-sales link retire candidates.
 *
 * This module only evaluates BI/warehouse rows. It never calls SHEIN OpenAPI and
 * must not be used as proof of execution approval.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function dateOnly(value) {
  const text = firstNonEmpty(value);
  if (!text) return '';
  const m = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

function daysBeforeDate(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() - days * MS_PER_DAY).toISOString().slice(0, 10);
}

export function firstShelf15dCutoffDate(performanceDate) {
  return daysBeforeDate(dateOnly(performanceDate), 14);
}

function dayDiff(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return Math.floor((end.getTime() - start.getTime()) / MS_PER_DAY);
}

function latestRecoveryEvidence(row) {
  const signals = [
    ['inventory_recovery_date', row.inventory_recovery_date ?? row.inventoryRecoveryDate],
    ['relisted_at', row.relisted_at ?? row.relistedAt],
    ['last_shelf_time', row.last_shelf_time ?? row.lastShelfTime ?? row.latest_shelf_time ?? row.latestShelfTime],
  ].map(([source, value]) => ({source, date: dateOnly(value)}))
    .filter(item => item.date)
    .sort((a, b) => b.date.localeCompare(a.date));
  return signals[0] || {source: '', date: ''};
}

function trueLike(value) {
  if (value === true || value === 1) return true;
  return ['true', '1', 'yes', 'y', 'complete', 'checked', '已核对', '完整'].includes(String(value ?? '').trim().toLowerCase());
}

function recoveryEvidenceWasChecked(row) {
  return trueLike(
    row.recovery_evidence_complete
      ?? row.recoveryEvidenceComplete
      ?? row.recovery_history_checked
      ?? row.recoveryHistoryChecked,
  );
}

/**
 * Returns a structured verdict for a read-only retire-candidate row.
 *
 * Fixed safety guards: links within 15 days of either first shelf or a recent
 * inventory recovery / relist are not executable. Inventory recovery evidence
 * takes precedence upstream; last_shelf_time is only a fallback signal because
 * SHEIN does not reliably update it after SOLD_OUT -> replenished recovery.
 */
export function evaluateLowExposureZeroSalesRetireCandidate(row = {}, options = {}) {
  const performanceDate = dateOnly(options.performanceDate || row.performanceDate || row.perf_date || row.date);
  const cutoffDate = firstShelf15dCutoffDate(performanceDate);
  const shelfStatusText = firstNonEmpty(row.current_status, row.shelf_status_name, row.shelfStatusName);
  const isOnShelf = row.is_on_shelf === true
    || row.isOnShelf === true
    || String(row.is_on_shelf || '').toLowerCase() === 'true'
    || shelfStatusText === '已上架';
  const c7Exposure = numberOrNull(row.c7_exposure ?? row.c7EpsUv ?? row.c7_eps_uv ?? row.eps_uv);
  const c7SaleCnt = numberOrNull(row.c7_sale_cnt ?? row.c7SaleCnt);
  const hasNewGoodsTagField = Object.hasOwn(row, 'new_goods_tag')
    || Object.hasOwn(row, 'newGoodsTag')
    || Object.hasOwn(row, 'performance_new_goods_tag')
    || Object.hasOwn(row, 'new_tag_value');
  const newGoodsTag = firstNonEmpty(row.new_goods_tag, row.newGoodsTag, row.performance_new_goods_tag, row.new_tag_value);
  const firstShelfDate = dateOnly(row.first_shelf_time ?? row.firstShelfTime);
  const shelfAgeDays = firstShelfDate && performanceDate ? dayDiff(firstShelfDate, performanceDate) : null;
  const recoveryEvidence = latestRecoveryEvidence(row);
  const recoveryDate = recoveryEvidence.date;
  const recoveryAgeDays = recoveryDate && performanceDate ? dayDiff(recoveryDate, performanceDate) : null;
  const recoveryEvidenceComplete = Boolean(recoveryDate) || recoveryEvidenceWasChecked(row);

  if (!performanceDate || !cutoffDate) return {candidate: false, bucket: 'cannotJudge', reason: 'missing_performance_date', cutoffDate, firstShelfDate, shelfAgeDays};
  if (!isOnShelf) return {candidate: false, bucket: 'excluded', reason: 'not_on_shelf', cutoffDate, firstShelfDate, shelfAgeDays};
  if (c7Exposure === null) return {candidate: false, bucket: 'cannotJudge', reason: 'missing_c7_exposure', cutoffDate, firstShelfDate, shelfAgeDays};
  if (c7Exposure > 300) return {candidate: false, bucket: 'excluded', reason: 'c7_exposure_gt_300', cutoffDate, firstShelfDate, shelfAgeDays};
  if (c7SaleCnt === null) return {candidate: false, bucket: 'cannotJudge', reason: 'missing_c7_sale_cnt', cutoffDate, firstShelfDate, shelfAgeDays};
  if (c7SaleCnt !== 0) return {candidate: false, bucket: 'excluded', reason: 'c7_sale_cnt_not_zero', cutoffDate, firstShelfDate, shelfAgeDays};
  if (!hasNewGoodsTagField) return {candidate: false, bucket: 'cannotJudge', reason: 'missing_new_goods_tag', cutoffDate, firstShelfDate, shelfAgeDays};
  if (newGoodsTag) return {candidate: false, bucket: 'excludedByNewGoodsTag', reason: 'new_goods_tag_present', cutoffDate, firstShelfDate, shelfAgeDays, newGoodsTag};
  if (!firstShelfDate) return {candidate: false, bucket: 'cannotJudge', reason: 'missing_first_shelf_time', cutoffDate, firstShelfDate, shelfAgeDays};
  if (firstShelfDate >= cutoffDate) return {candidate: false, bucket: 'excludedByFirstShelf15d', reason: 'first_shelf_within_15d', cutoffDate, firstShelfDate, shelfAgeDays};
  if (!recoveryEvidenceComplete) return {
    candidate: false,
    bucket: 'cannotJudge',
    reason: 'missing_recovery_evidence',
    cutoffDate,
    firstShelfDate,
    shelfAgeDays,
    recoveryDate,
    recoveryAgeDays,
    recoveryEvidenceSource: recoveryEvidence.source,
  };
  if (recoveryDate >= cutoffDate) return {
    candidate: false,
    bucket: 'excludedByRecentRecovery15d',
    reason: 'inventory_recovery_or_relist_within_15d',
    cutoffDate,
    firstShelfDate,
    shelfAgeDays,
    recoveryDate,
    recoveryAgeDays,
    recoveryEvidenceSource: recoveryEvidence.source,
  };
  return {
    candidate: true,
    bucket: 'candidate',
    reason: 'pass',
    cutoffDate,
    firstShelfDate,
    shelfAgeDays,
    recoveryDate,
    recoveryAgeDays,
    recoveryEvidenceSource: recoveryEvidence.source,
    recoveryEvidenceComplete,
  };
}
