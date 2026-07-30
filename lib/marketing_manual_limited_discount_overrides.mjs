import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_MANUAL_LIMITED_DISCOUNT_OVERRIDES_PATH = path.resolve(
  process.env.SHEIN_BI_MANUAL_LIMITED_DISCOUNT_REGISTRY
    || path.join(MODULE_ROOT, 'config', 'marketing_manual_limited_discount_overrides.json'),
);
export const MANUAL_LIMITED_DISCOUNT_PRICE_TOLERANCE_SAR = 0.01;

export function manualLimitedDiscountKey(storeKey, skc) {
  return `${String(storeKey || '').trim().toUpperCase()}::${String(skc || '').trim()}`;
}

export function parseShanghaiDateTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const normalized = raw.replace(' ', 'T');
  const zoned = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(normalized) ? normalized : `${normalized}+08:00`;
  const date = new Date(zoned);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function formatShanghaiDateTime(value = new Date()) {
  const date = value instanceof Date ? value : parseShanghaiDateTime(value);
  if (!date) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function normalizeManualLimitedDiscountEntry(entry) {
  return {
    ...entry,
    storeKey: String(entry?.storeKey || '').trim().toUpperCase(),
    skc: String(entry?.skc || '').trim(),
    canonical: String(entry?.canonical || '').trim(),
    specialPrice: numberOrNull(entry?.specialPrice),
    activityStock: Number(entry?.activityStock),
    validFrom: String(entry?.validFrom || '').trim(),
    validTo: String(entry?.validTo || '').trim(),
    currentActivityId: entry?.currentActivityId === '' || entry?.currentActivityId == null
      ? null
      : Number(entry.currentActivityId),
    originalActivityId: entry?.originalActivityId === '' || entry?.originalActivityId == null
      ? null
      : Number(entry.originalActivityId),
    status: String(entry?.status || 'active').trim().toLowerCase(),
  };
}

export function validateManualLimitedDiscountRegistry(doc) {
  const errors = [];
  const entries = Array.isArray(doc?.entries) ? doc.entries.map(normalizeManualLimitedDiscountEntry) : [];
  if (!doc || typeof doc !== 'object') errors.push('registry must be a JSON object');
  if (!Array.isArray(doc?.entries)) errors.push('registry.entries must be an array');
  const seen = new Set();
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const prefix = `entries[${i}]`;
    const key = manualLimitedDiscountKey(entry.storeKey, entry.skc);
    if (!entry.storeKey) errors.push(`${prefix}.storeKey is required`);
    if (!entry.skc) errors.push(`${prefix}.skc is required`);
    if (seen.has(key)) errors.push(`${prefix} duplicates storeKey+skc ${key}`);
    seen.add(key);
    if (!(entry.specialPrice > 0)) errors.push(`${prefix}.specialPrice must be positive`);
    if (!Number.isInteger(entry.activityStock) || entry.activityStock <= 0) errors.push(`${prefix}.activityStock must be a positive integer`);
    const from = parseShanghaiDateTime(entry.validFrom);
    const to = parseShanghaiDateTime(entry.validTo);
    if (!from) errors.push(`${prefix}.validFrom is invalid`);
    if (!to) errors.push(`${prefix}.validTo is invalid`);
    if (from && to && from.getTime() >= to.getTime()) errors.push(`${prefix}.validFrom must be before validTo`);
    if (!entry.reason) errors.push(`${prefix}.reason is required`);
    if (!entry.sourceThreadId) errors.push(`${prefix}.sourceThreadId is required`);
    if (!entry.sourceArtifact) errors.push(`${prefix}.sourceArtifact is required`);
    if (!['active', 'disabled', 'cancelled', 'completed'].includes(entry.status)) errors.push(`${prefix}.status is unsupported`);
    if (entry.currentActivityId !== null && !(Number.isInteger(entry.currentActivityId) && entry.currentActivityId > 0)) {
      errors.push(`${prefix}.currentActivityId must be a positive integer or null`);
    }
  }
  return {ok: errors.length === 0, errors, entries};
}

export async function loadManualLimitedDiscountRegistry(file = DEFAULT_MANUAL_LIMITED_DISCOUNT_OVERRIDES_PATH) {
  const resolved = path.resolve(file);
  const doc = JSON.parse((await fs.readFile(resolved, 'utf8')).replace(/^\uFEFF/, ''));
  const validation = validateManualLimitedDiscountRegistry(doc);
  if (!validation.ok) throw new Error(`Invalid manual limited-discount registry ${resolved}: ${validation.errors.join('; ')}`);
  return {...doc, entries: validation.entries, sourcePath: resolved};
}

export function isManualLimitedDiscountActive(entry, at = new Date()) {
  const normalized = normalizeManualLimitedDiscountEntry(entry);
  if (normalized.status !== 'active') return false;
  const now = at instanceof Date ? at : parseShanghaiDateTime(at);
  const from = parseShanghaiDateTime(normalized.validFrom);
  const to = parseShanghaiDateTime(normalized.validTo);
  if (!now || !from || !to) return false;
  return now.getTime() >= from.getTime() && now.getTime() <= to.getTime();
}

export function buildManualLimitedDiscountIndex(doc, at = new Date()) {
  const allByKey = new Map();
  const activeByKey = new Map();
  for (const raw of doc?.entries || []) {
    const entry = normalizeManualLimitedDiscountEntry(raw);
    const key = manualLimitedDiscountKey(entry.storeKey, entry.skc);
    allByKey.set(key, entry);
    if (isManualLimitedDiscountActive(entry, at)) activeByKey.set(key, entry);
  }
  return {allByKey, activeByKey, at: formatShanghaiDateTime(at), sourcePath: doc?.sourcePath || ''};
}

export function findActiveManualLimitedDiscount(indexOrDoc, storeKey, skc, at = new Date()) {
  const key = manualLimitedDiscountKey(storeKey, skc);
  if (indexOrDoc?.activeByKey instanceof Map) return indexOrDoc.activeByKey.get(key) || null;
  return buildManualLimitedDiscountIndex(indexOrDoc, at).activeByKey.get(key) || null;
}

export function applyManualLimitedDiscountOverride(row, entry) {
  const normalized = normalizeManualLimitedDiscountEntry(entry);
  return {
    ...row,
    storeKey: normalized.storeKey,
    skc: normalized.skc,
    canonical: row?.canonical || normalized.canonical,
    limitedDiscountPrice: normalized.specialPrice,
    finalTargetPrice: normalized.specialPrice,
    targetPrice: normalized.specialPrice,
    expectedFinalNoCoupon: normalized.specialPrice,
    originalPlannedFinalPrice: normalized.specialPrice,
    couponFactor: 1,
    activityStock: normalized.activityStock,
    endTime: normalized.validTo,
    sourceRule: 'manual_special_limited_discount_override',
    manualSpecialLimitedDiscount: true,
    manualSpecialReason: normalized.reason,
    manualSpecialValidFrom: normalized.validFrom,
    manualSpecialValidTo: normalized.validTo,
    manualSpecialCurrentActivityId: normalized.currentActivityId,
    manualSpecialSourceThreadId: normalized.sourceThreadId,
    manualSpecialSourceArtifact: normalized.sourceArtifact,
  };
}

export function partitionRowsByManualLimitedDiscount(rows, indexOrDoc, at = new Date()) {
  const index = indexOrDoc?.activeByKey instanceof Map ? indexOrDoc : buildManualLimitedDiscountIndex(indexOrDoc, at);
  const protectedRows = [];
  const ordinaryRows = [];
  for (const row of rows || []) {
    const entry = findActiveManualLimitedDiscount(index, row?.storeKey || row?.store, row?.skc || row?.SKC, at);
    if (entry) protectedRows.push({row, entry});
    else ordinaryRows.push(row);
  }
  return {ordinaryRows, protectedRows};
}

export function selectManualLimitedDiscountCoverageRows(entry, {
  currentRows = [],
  allRows = [],
  at = new Date(),
  maxFutureLeadMinutes = 120,
} = {}) {
  const normalized = normalizeManualLimitedDiscountEntry(entry);
  const now = at instanceof Date ? at : parseShanghaiDateTime(at);
  const validTo = parseShanghaiDateTime(normalized.validTo);
  const currentActivityId = normalized.currentActivityId === null ? '' : String(normalized.currentActivityId);
  const maxLeadMs = Number(maxFutureLeadMinutes) * 60 * 1000;
  const scheduledRows = [];

  if (now && validTo && currentActivityId && Number.isFinite(maxLeadMs) && maxLeadMs >= 0) {
    for (const row of allRows || []) {
      const evidenceType = String(row?.evidenceType ?? row?.marketing_price_evidence_type ?? '');
      if (!/future_limited_discount/i.test(evidenceType)) continue;
      const activityId = String(row?.activityId ?? row?.marketing_limited_discount_activity_id ?? '');
      if (activityId !== currentActivityId) continue;
      const start = parseShanghaiDateTime(
        row?.start
        ?? row?.startTime
        ?? row?.marketing_limited_discount_start,
      );
      if (!start || start.getTime() <= now.getTime() || start.getTime() > validTo.getTime()) continue;
      if (start.getTime() - now.getTime() > maxLeadMs) continue;
      scheduledRows.push(row);
    }
  }

  return {
    rows: [...(currentRows || []), ...scheduledRows],
    currentRows: [...(currentRows || [])],
    scheduledRows,
    coverageMode: scheduledRows.length ? 'current_or_scheduled_exact_activity' : 'current_only',
  };
}

export function classifyManualLimitedDiscountLiveState(entry, liveRows = []) {
  const normalized = normalizeManualLimitedDiscountEntry(entry);
  const expectedEnd = parseShanghaiDateTime(normalized.validTo);
  const coverage = (liveRows || []).map(row => {
    const price = numberOrNull(
      row?.price
      ?? row?.limitedDiscountPrice
      ?? row?.marketing_limited_discount_price_sar
      ?? row?.marketing_limited_discount_price,
    );
    const activityStock = numberOrNull(
      row?.activityStock
      ?? row?.attendNumSum
      ?? row?.marketing_limited_discount_attend_num_sum,
    );
    const end = parseShanghaiDateTime(
      row?.end
      ?? row?.endTime
      ?? row?.marketing_limited_discount_end,
    );
    const checks = {
      price: price !== null && Math.abs(price - normalized.specialPrice) <= MANUAL_LIMITED_DISCOUNT_PRICE_TOLERANCE_SAR,
      activityStock: activityStock !== null && activityStock >= normalized.activityStock,
      validTo: Boolean(expectedEnd && end && end.getTime() >= expectedEnd.getTime()),
    };
    return {
      activityId: row?.activityId ?? row?.marketing_limited_discount_activity_id ?? null,
      price,
      activityStock,
      startTime: row?.start ?? row?.startTime ?? row?.marketing_limited_discount_start ?? '',
      endTime: row?.end ?? row?.endTime ?? row?.marketing_limited_discount_end ?? '',
      evidenceType: row?.evidenceType ?? row?.marketing_price_evidence_type ?? '',
      checks,
      ok: Object.values(checks).every(Boolean),
    };
  });
  const prices = coverage.map(row => row.price).filter(Number.isFinite);
  if (!prices.length) return {status: 'missing', expectedPrice: normalized.specialPrice, livePrices: []};
  const exactPrice = coverage.some(row => row.checks.price);
  const exactCoverage = coverage.some(row => row.ok);
  return {
    status: exactCoverage ? 'covered_exact' : exactPrice ? 'coverage_mismatch' : 'price_mismatch',
    expectedPrice: normalized.specialPrice,
    livePrices: prices,
    expectedActivityStock: normalized.activityStock,
    expectedValidTo: normalized.validTo,
    liveCoverage: coverage,
  };
}

export function resolveLimitedDiscountInventoryTopUpAction({platformStock, etStock, activityStock}) {
  const platform = numberOrNull(platformStock);
  const et = numberOrNull(etStock);
  const required = Number(activityStock);
  if (!Number.isInteger(required) || required <= 0) return {ok: false, action: 'block', reason: 'invalid_activity_stock'};
  if (platform !== null && platform >= required) {
    return {ok: true, action: 'no_top_up_needed', required, platformStock: platform, etStock: et, topUpTo: null};
  }
  if (et === null) return {ok: false, action: 'block', reason: 'missing_et_stock_evidence', required, platformStock: platform, etStock: null};
  if (et < required) return {ok: false, action: 'block', reason: 'et_stock_below_activity_stock', required, platformStock: platform, etStock: et};
  return {ok: true, action: 'top_up_platform_virtual_stock', required, platformStock: platform, etStock: et, topUpTo: required};
}

export const resolveManualLimitedDiscountInventoryAction = resolveLimitedDiscountInventoryTopUpAction;
