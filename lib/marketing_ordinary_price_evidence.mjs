import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

import {
  PRICE_GUARD_TOLERANCE_SAR,
  isOptionalTrafficCouponPlanRow,
  plannedCouponFactor,
  plannedFinalTargetPrice,
  plannedCouponSafetyFloor,
  normalizeStoreKey,
  normalizeSkc,
} from './marketing_coupon_policy.mjs';

const DEFAULT_DEADLINE_FILL_DIR = path.join('tmp', 'mbrs', 'deadline-fill-results');

export async function loadKnownOrdinaryPriceEvidence({
  root = process.cwd(),
  storeKey = '',
  dir = DEFAULT_DEADLINE_FILL_DIR,
  nowLocal = shanghaiDateTimeString(new Date()),
} = {}) {
  const projectRoot = path.resolve(root);
  const resolvedDir = path.resolve(projectRoot, dir);
  const storeFilter = normalizeStoreKey(storeKey);
  const rawRows = [];
  const diagnostics = [];
  let filesRead = 0;
  if (!fsSync.existsSync(resolvedDir)) {
    return {dir: resolvedDir, nowLocal, rows: [], diagnostics: [{type: 'dir_missing', dir: resolvedDir}], filesRead, parseErrorCount: 0};
  }
  for (const entry of await fs.readdir(resolvedDir, {withFileTypes: true})) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
    const file = path.join(resolvedDir, entry.name);
    let stat;
    let doc;
    try {
      stat = await fs.stat(file);
      doc = parseJsonWithOptionalPreamble(await fs.readFile(file, 'utf8'));
      filesRead += 1;
    } catch (err) {
      diagnostics.push({type: 'parse_error', file: path.relative(projectRoot, file), error: err.message});
      continue;
    }
    const sourceTime = evidenceSourceTime(doc, stat);
    for (const result of flattenDeadlineFillResults(doc)) {
      const activity = normalizeActivity(result.activity || {});
      const sourceStore = normalizeStoreKey(result.store || doc.store || result.storeKey || '');
      if (storeFilter && sourceStore !== storeFilter) continue;
      if (!sourceStore || !activity.activityId) continue;
      if (activity.eventEnd && activity.eventEnd < nowLocal) continue;
      const targetRows = Array.isArray(result.fill?.targets) ? result.fill.targets : [];
      const rewriteBySkc = new Map(
        (Array.isArray(result.fill?.platformRewrites) ? result.fill.platformRewrites : [])
          .map(row => [normalizeSkc(row.skc), row])
          .filter(([skc]) => skc),
      );
      const trust = classifyResultTrust(result, doc);
      for (const target of targetRows) {
        const skc = normalizeSkc(target.skc);
        if (!skc) continue;
        const rewrite = rewriteBySkc.get(skc);
        const submittedPrice = numberOrNull(rewrite?.actualPrice)
          ?? numberOrNull(target.targetPrice)
          ?? numberOrNull(target.targetPriceText);
        if (submittedPrice === null) continue;
        rawRows.push({
          storeKey: sourceStore,
          activityId: activity.activityId,
          activityName: activity.name,
          signStart: activity.signStart,
          signEnd: activity.signEnd,
          eventStart: activity.eventStart,
          eventEnd: activity.eventEnd,
          skc,
          supplierNo: target.supplierNo || '',
          canonical: target.canonical || '',
          ordinaryMarketingPrice: submittedPrice,
          priceSource: rewrite ? 'deadline_fill_platform_rewrite_actual' : 'deadline_fill_target',
          evidenceTrust: trust.level,
          evidenceTrustReason: trust.reason,
          resultOk: result.ok === true,
          fillOk: result.fill?.ok === true,
          submitSubmitted: result.submit?.submitted === true,
          submitOk: result.submit?.ok === true,
          minDiscount: numberOrNull(target.minDiscount),
          editMode: target.editMode || '',
          approvedTargetPrice: numberOrNull(target.approvedTargetPrice),
          platformAdjustmentStatus: target.platformAdjustmentStatus || '',
          platformPricePolicy: target.platformPricePolicy || '',
          belowApprovedTarget: target.belowApprovedTarget === true,
          requiresReapproval: target.requiresReapproval === true,
          fillSource: path.relative(projectRoot, file),
          evidenceTime: sourceTime.iso,
          evidenceTimeMs: sourceTime.ms,
          sourceFileMtimeMs: stat?.mtimeMs || 0,
        });
      }
    }
  }
  const {rows, collapsedCount} = collapseOrdinaryEvidenceRows(rawRows);
  rows.sort((a, b) => a.ordinaryMarketingPrice - b.ordinaryMarketingPrice
    || String(a.storeKey).localeCompare(String(b.storeKey))
    || String(a.skc).localeCompare(String(b.skc))
    || Number(a.activityId) - Number(b.activityId));
  return {
    dir: resolvedDir,
    nowLocal,
    rows,
    rawRowCount: rawRows.length,
    collapsedCount,
    diagnostics,
    filesRead,
    parseErrorCount: diagnostics.filter(d => d.type === 'parse_error').length,
  };
}

export function classifyKnownOrdinaryCouponStack(evidenceRows = [], planRow, options = {}) {
  const normalizedOptions = typeof options === 'number'
    ? {fallbackDiscountPct: options}
    : (options || {});
  const fallbackDiscountPct = normalizedOptions.fallbackDiscountPct ?? normalizedOptions.targetDiscountPct ?? 15;
  const priceToleranceSar = numberOrNull(normalizedOptions.priceToleranceSar) ?? PRICE_GUARD_TOLERANCE_SAR;
  const couponFactor = plannedCouponFactor(planRow, fallbackDiscountPct);
  const isTrafficCoupon = isOptionalTrafficCouponPlanRow(planRow);
  const finalTargetPrice = plannedFinalTargetPrice(planRow, couponFactor);
  const safetyFloor = isTrafficCoupon ? plannedCouponSafetyFloor(planRow, normalizedOptions) : null;
  const validRows = (Array.isArray(evidenceRows) ? evidenceRows : [])
    .map(row => ({...row, ordinaryMarketingPrice: numberOrNull(row?.ordinaryMarketingPrice)}))
    .filter(row => row.ordinaryMarketingPrice !== null)
    .sort((a, b) => a.ordinaryMarketingPrice - b.ordinaryMarketingPrice);
  const lowest = validRows[0] || null;
  const out = {
    couponFactor,
    finalTargetPrice,
    safetyFloor,
    isTrafficCoupon,
    ordinaryEvidenceCount: validRows.length,
    lowestOrdinaryPrice: lowest?.ordinaryMarketingPrice ?? null,
    lowestOrdinaryEvidence: lowest,
    finalWithCoupon: null,
    diff: null,
    allowSubmit: true,
    shouldCancelCoupon: false,
    priceToleranceSar,
    decision: validRows.length ? 'known_ordinary_price_safe_or_above_target' : 'no_known_ordinary_price_evidence',
  };
  if (!validRows.length) return out;
  const guardTarget = isTrafficCoupon ? safetyFloor : finalTargetPrice;
  if (guardTarget === null) {
    out.allowSubmit = false;
    out.decision = 'missing_final_target_price';
    return out;
  }
  out.finalWithCoupon = round2(lowest.ordinaryMarketingPrice * couponFactor);
  out.diff = round2(out.finalWithCoupon - guardTarget);
  if (out.diff < -priceToleranceSar) {
    out.allowSubmit = false;
    out.shouldCancelCoupon = true;
    out.decision = isTrafficCoupon ? 'known_ordinary_final_below_safety_floor' : 'known_ordinary_final_below_target';
    return out;
  }
  out.decision = isTrafficCoupon
    ? (Math.abs(out.diff) <= priceToleranceSar ? 'traffic_known_ordinary_final_matches_safety_floor' : 'traffic_known_ordinary_final_above_safety_floor')
    : (Math.abs(out.diff) <= priceToleranceSar ? 'known_ordinary_final_matches_target' : 'known_ordinary_final_above_target');
  return out;
}

export function groupOrdinaryEvidenceBySkc(rows = []) {
  const map = new Map();
  for (const row of rows) {
    const skc = normalizeSkc(row?.skc);
    if (!skc) continue;
    if (!map.has(skc)) map.set(skc, []);
    map.get(skc).push(row);
  }
  return map;
}

export function buildMarketingStackDetailIndex(stackDoc) {
  const map = new Map();
  const detailRows = Array.isArray(stackDoc?.detailRows) ? stackDoc.detailRows : [];
  for (const row of detailRows) {
    const storeKey = normalizeStoreKey(row?.['店铺'] || row?.storeKey || row?.store);
    const skc = normalizeSkc(row?.SKC || row?.skc);
    if (!storeKey || !skc) continue;
    const key = `${storeKey}__${skc}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

export function stackRowsHaveExistingOrdinaryMarketingLabel(stackRows = []) {
  return (stackRows || []).some(row => {
    const text = [
      row?.['普通营销活动价/折扣'],
      row?.['风险提示'],
      row?.ordinaryMarketingSummary,
      row?.risk,
    ].filter(Boolean).join(' ');
    return /既有(?:普通活动)?标签|既有普通营销活动|旧普通活动|度假季/.test(text);
  });
}

function flattenDeadlineFillResults(doc) {
  const out = [];
  if (doc?.activity && doc?.fill) out.push(doc);
  for (const store of Array.isArray(doc?.stores) ? doc.stores : []) {
    for (const result of Array.isArray(store?.results) ? store.results : []) {
      out.push({...result, store: result.store || store.store});
    }
  }
  return out;
}

function normalizeActivity(activity) {
  return {
    activityId: Number(activity.activityId || activity.activity_id || 0),
    name: activity.name || activity.activityName || activity.activity_name || '',
    signStart: activity.signStart || activity.activity_start_zone_time || activity.raw?.activity_start_zone_time || '',
    signEnd: activity.signEnd || activity.activity_end_zone_time || activity.raw?.activity_end_zone_time || '',
    eventStart: activity.eventStart || activity.start_zone_time || activity.raw?.start_zone_time || '',
    eventEnd: activity.eventEnd || activity.end_zone_time || activity.raw?.end_zone_time || '',
  };
}

function classifyResultTrust(result, doc) {
  if (result?.submit?.submitted === true && result?.submit?.ok !== false) {
    return {level: 'submitted', reason: 'result_submit_submitted'};
  }
  if (doc?.submit === true && result?.ok === true) {
    return {level: 'batch_submit_enabled_result_ok', reason: 'summary_submit_true_result_ok'};
  }
  if (result?.fill?.ok === true) {
    return {level: 'filled_price_candidate', reason: 'fill_ok_without_submit_proof'};
  }
  return {level: 'unverified_price_candidate', reason: 'no_submit_or_fill_success_proof'};
}

function collapseOrdinaryEvidenceRows(rows = []) {
  const byKey = new Map();
  let collapsedCount = 0;
  for (const row of rows) {
    const key = `${normalizeStoreKey(row.storeKey)}__${Number(row.activityId) || 0}__${normalizeSkc(row.skc)}`;
    if (!key.endsWith('__') && !key.includes('__0__')) {
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, row);
        continue;
      }
      collapsedCount += 1;
      if (compareOrdinaryEvidence(row, existing) > 0) byKey.set(key, row);
    }
  }
  return {rows: [...byKey.values()], collapsedCount};
}

function compareOrdinaryEvidence(a, b) {
  const trustDiff = trustRank(a?.evidenceTrust) - trustRank(b?.evidenceTrust);
  if (trustDiff) return trustDiff;
  const timeDiff = (Number(a?.evidenceTimeMs) || 0) - (Number(b?.evidenceTimeMs) || 0);
  if (timeDiff) return timeDiff;
  const mtimeDiff = (Number(a?.sourceFileMtimeMs) || 0) - (Number(b?.sourceFileMtimeMs) || 0);
  if (mtimeDiff) return mtimeDiff;
  // Last deterministic tie-breaker: prefer the row from the lexicographically
  // later source file so repeated local rebuilds are stable.
  return String(a?.fillSource || '').localeCompare(String(b?.fillSource || ''));
}

function trustRank(level) {
  switch (level) {
    case 'submitted':
      return 4;
    case 'batch_submit_enabled_result_ok':
      return 3;
    case 'filled_price_candidate':
      return 2;
    case 'unverified_price_candidate':
      return 1;
    default:
      return 0;
  }
}

function evidenceSourceTime(doc, stat) {
  const candidates = [
    doc?.createdAt,
    doc?.now,
    doc?.finishedAt,
    doc?.startedAt,
  ];
  for (const value of candidates) {
    const ms = Date.parse(value || '');
    if (Number.isFinite(ms)) return {ms, iso: new Date(ms).toISOString()};
  }
  const ms = Number(stat?.mtimeMs || 0);
  return {ms, iso: ms ? new Date(ms).toISOString() : ''};
}

function parseJsonWithOptionalPreamble(text) {
  const normalized = String(text || '').replace(/^\uFEFF/, '');
  try {
    return JSON.parse(normalized);
  } catch (err) {
    const firstObject = normalized.indexOf('{');
    if (firstObject > 0) return JSON.parse(normalized.slice(firstObject));
    throw err;
  }
}

function shanghaiDateTimeString(date) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/[%SAR,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}
