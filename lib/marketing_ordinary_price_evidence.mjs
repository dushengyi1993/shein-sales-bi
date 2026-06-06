import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

import {
  PRICE_GUARD_TOLERANCE_SAR,
  plannedCouponFactor,
  plannedFinalTargetPrice,
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
  const rows = [];
  const diagnostics = [];
  let filesRead = 0;
  if (!fsSync.existsSync(resolvedDir)) {
    return {dir: resolvedDir, nowLocal, rows, diagnostics: [{type: 'dir_missing', dir: resolvedDir}], filesRead, parseErrorCount: 0};
  }
  for (const entry of await fs.readdir(resolvedDir, {withFileTypes: true})) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
    const file = path.join(resolvedDir, entry.name);
    let doc;
    try {
      doc = parseJsonWithOptionalPreamble(await fs.readFile(file, 'utf8'));
      filesRead += 1;
    } catch (err) {
      diagnostics.push({type: 'parse_error', file: path.relative(projectRoot, file), error: err.message});
      continue;
    }
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
        rows.push({
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
          fillSource: path.relative(projectRoot, file),
        });
      }
    }
  }
  rows.sort((a, b) => a.ordinaryMarketingPrice - b.ordinaryMarketingPrice
    || String(a.storeKey).localeCompare(String(b.storeKey))
    || String(a.skc).localeCompare(String(b.skc))
    || Number(a.activityId) - Number(b.activityId));
  return {dir: resolvedDir, nowLocal, rows, diagnostics, filesRead, parseErrorCount: diagnostics.filter(d => d.type === 'parse_error').length};
}

export function classifyKnownOrdinaryCouponStack(evidenceRows = [], planRow, options = {}) {
  const normalizedOptions = typeof options === 'number'
    ? {fallbackDiscountPct: options}
    : (options || {});
  const fallbackDiscountPct = normalizedOptions.fallbackDiscountPct ?? normalizedOptions.targetDiscountPct ?? 15;
  const priceToleranceSar = numberOrNull(normalizedOptions.priceToleranceSar) ?? PRICE_GUARD_TOLERANCE_SAR;
  const couponFactor = plannedCouponFactor(planRow, fallbackDiscountPct);
  const finalTargetPrice = plannedFinalTargetPrice(planRow, couponFactor);
  const validRows = (Array.isArray(evidenceRows) ? evidenceRows : [])
    .map(row => ({...row, ordinaryMarketingPrice: numberOrNull(row?.ordinaryMarketingPrice)}))
    .filter(row => row.ordinaryMarketingPrice !== null)
    .sort((a, b) => a.ordinaryMarketingPrice - b.ordinaryMarketingPrice);
  const lowest = validRows[0] || null;
  const out = {
    couponFactor,
    finalTargetPrice,
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
  if (finalTargetPrice === null) {
    out.allowSubmit = false;
    out.decision = 'missing_final_target_price';
    return out;
  }
  out.finalWithCoupon = round2(lowest.ordinaryMarketingPrice * couponFactor);
  out.diff = round2(out.finalWithCoupon - finalTargetPrice);
  if (out.diff < -priceToleranceSar) {
    out.allowSubmit = false;
    out.shouldCancelCoupon = true;
    out.decision = 'known_ordinary_final_below_target';
    return out;
  }
  out.decision = Math.abs(out.diff) <= priceToleranceSar
    ? 'known_ordinary_final_matches_target'
    : 'known_ordinary_final_above_target';
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
  if (result?.submit?.ok === true) {
    return {level: 'submitted', reason: 'result_submit_ok'};
  }
  if (doc?.submit === true && result?.ok === true) {
    return {level: 'batch_submit_enabled_result_ok', reason: 'summary_submit_true_result_ok'};
  }
  if (result?.fill?.ok === true) {
    return {level: 'filled_price_candidate', reason: 'fill_ok_without_submit_proof'};
  }
  return {level: 'unverified_price_candidate', reason: 'no_submit_or_fill_success_proof'};
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
