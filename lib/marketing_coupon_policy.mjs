import fs from 'node:fs/promises';
import path from 'node:path';

const TARGET_FACTOR_TOLERANCE = 0.011;
export const PRICE_GUARD_TOLERANCE_SAR = 1.0;

export async function loadCouponTargetEligibilityPlan({
  root = process.cwd(),
  planPath,
  priceOverridesPaths = [],
  targetDiscountPct = 15,
  allowPlanItemCouponPolicy = false,
} = {}) {
  if (!planPath) return null;
  const projectRoot = path.resolve(root);
  const planSources = [];
  const priceOverrideSources = [];
  const seenPlans = new Set();
  const seenOverrides = new Set();
  const collectedOverridePaths = new Set(splitPathList(priceOverridesPaths).map(p => resolveInputPath(projectRoot, p)));
  const planItems = [];

  async function collectPlan(file) {
    const resolved = resolveInputPath(projectRoot, file);
    if (seenPlans.has(resolved)) return;
    seenPlans.add(resolved);
    const doc = await readJsonStrict(resolved);
    planSources.push(resolved);

    for (const overridePath of extractPriceOverridePaths(doc)) {
      collectedOverridePaths.add(resolveInputPath(projectRoot, overridePath));
    }
    const inferred = await inferExistingPriceOverridePath(resolved);
    if (inferred) collectedOverridePaths.add(inferred);

    if (Array.isArray(doc?.ordinaryPlanPaths)) {
      for (const nested of doc.ordinaryPlanPaths) {
        await collectPlan(nested);
      }
      return;
    }

    const items = Array.isArray(doc) ? doc
      : Array.isArray(doc?.items) ? doc.items
      : Array.isArray(doc?.rows) ? doc.rows
      : [];
    for (const item of items) {
      if (!item || item.selected === false) continue;
      planItems.push({...item, __sourcePlan: resolved});
    }
  }

  await collectPlan(planPath);

  const overrideRowsByKey = new Map();
  async function collectOverride(file) {
    const resolved = resolveInputPath(projectRoot, file);
    if (seenOverrides.has(resolved)) return;
    seenOverrides.add(resolved);
    const doc = await readJsonIfExists(resolved, null);
    if (!doc) return;
    priceOverrideSources.push(resolved);
    for (const nested of extractPriceOverridePaths(doc)) {
      await collectOverride(nested);
    }
    const rows = Array.isArray(doc) ? doc
      : Array.isArray(doc?.items) ? doc.items
      : [];
    for (const row of rows) {
      const key = storeSkcKey(row?.storeKey, row?.skc);
      if (!key) continue;
      if (!overrideRowsByKey.has(key)) overrideRowsByKey.set(key, []);
      overrideRowsByKey.get(key).push({...row, __sourcePriceOverride: resolved});
    }
  }

  for (const overridePath of collectedOverridePaths) {
    await collectOverride(overridePath);
  }

  const byStore = new Map();
  const allByStore = new Map();
  const blockedByStore = new Map();
  const rowsByStore = new Map();
  const seenPlanKeys = new Set();

  for (const item of planItems) {
    const storeKey = normalizeStoreKey(item.storeKey);
    const skc = normalizeSkc(item.skc);
    const key = storeSkcKey(storeKey, skc);
    if (!key || seenPlanKeys.has(key)) continue;
    seenPlanKeys.add(key);
    addToStoreSet(allByStore, storeKey, skc);

    const overrideRows = overrideRowsByKey.get(key) || [];
    const decision = classifyCouponTarget({
      planItem: item,
      overrideRows,
      targetDiscountPct,
      allowPlanItemCouponPolicy,
    });
    const row = {
      storeKey,
      skc,
      activityId: item.activityId ?? decision.row?.activityId ?? '',
      canonical: item.canonical || decision.row?.canonical || '',
      supplierNo: item.supplierNo || decision.row?.supplierNo || '',
      category: decision.category,
      allowed15: decision.allowed15,
      reason: decision.reason,
      targetPrice: decision.row?.targetPrice ?? '',
      finalTargetPrice: decision.row?.finalTargetPrice ?? '',
      cost: decision.row?.cost ?? '',
      couponFactor: decision.row?.couponFactor ?? '',
      combo: decision.row?.combo || '',
      overrideFound: overrideRows.length > 0,
      sourcePlan: item.__sourcePlan || '',
      sourcePriceOverride: decision.sources.join(';'),
      conflictCount: decision.conflictCount || 0,
    };
    addToStoreRows(rowsByStore, storeKey, row);
    if (decision.allowed15) {
      addToStoreSet(byStore, storeKey, skc);
    } else {
      addToStoreRows(blockedByStore, storeKey, row);
    }
  }

  return {
    path: resolveInputPath(projectRoot, planPath),
    targetDiscountPct,
    planSources,
    priceOverrideSources,
    byStore,
    allowed15ByStore: byStore,
    allByStore,
    blockedByStore,
    rowsByStore,
    summary: summarizeCouponTargetEligibilityMaps({allByStore, byStore, blockedByStore, rowsByStore}),
  };
}

export function classifyCouponTarget({planItem = null, overrideRows = [], targetDiscountPct = 15, allowPlanItemCouponPolicy = false} = {}) {
  if (!overrideRows.length && !allowPlanItemCouponPolicy) {
    return {
      allowed15: false,
      category: 'not_in_price_overrides',
      reason: 'missing_price_override_row',
      row: planItem,
      sources: [],
    };
  }
  const rows = overrideRows.length ? overrideRows : (planItem ? [planItem] : []);
  if (!rows.length) {
    return {
      allowed15: false,
      category: 'not_in_price_overrides',
      reason: 'missing_price_override_row',
      row: null,
      sources: [],
    };
  }

  const decisions = rows.map(row => classifyCouponEligibilityRow(row, {targetDiscountPct}));
  const informativeDecisions = decisions.filter(d => d.category !== 'unknown');
  const decisionsForConflict = informativeDecisions.length ? informativeDecisions : decisions;
  const signatures = new Set(decisionsForConflict.map(d => `${d.category}|${d.allowed15}|${d.reason}|${normalizeFactor(d.row?.couponFactor)}|${normalizeCombo(d.row?.combo)}`));
  if (signatures.size > 1) {
    return {
      allowed15: false,
      category: 'ambiguous',
      reason: 'conflicting_price_override_coupon_policy',
      row: rows[0],
      sources: unique(rows.map(r => r.__sourcePriceOverride).filter(Boolean)),
      conflictCount: signatures.size,
      decisions: decisions.slice(0, 5),
    };
  }
  const decision = decisionsForConflict[0];
  const hasOverride = overrideRows.length > 0;
  if (!hasOverride && decision.category === 'unknown') {
    return {
      ...decision,
      category: 'not_in_price_overrides',
      reason: 'plan_item_has_no_price_override_coupon_policy',
      sources: [],
    };
  }
  return {
    ...decision,
    sources: unique(rows.map(r => r.__sourcePriceOverride).filter(Boolean)),
  };
}

export function classifyCouponEligibilityRow(row, {targetDiscountPct = 15} = {}) {
  const combo = String(row?.combo || '').trim();
  const compactCombo = normalizeCombo(combo);
  const factor = numberOrNull(row?.couponFactor);
  const targetFactor = round4(1 - Number(targetDiscountPct) / 100);
  const basis = {row, couponFactor: factor, combo};

  if (forbidsTarget15(compactCombo)) {
    return {
      ...basis,
      allowed15: false,
      category: 'forbidden',
      reason: 'combo_forbids_15pct_coupon',
    };
  }

  if (factor !== null) {
    if (Math.abs(factor - targetFactor) <= TARGET_FACTOR_TOLERANCE) {
      return {
        ...basis,
        allowed15: true,
        category: 'allowed15',
        reason: 'coupon_factor_matches_15pct',
      };
    }
    if (factor < 1) {
      return {
        ...basis,
        allowed15: false,
        category: 'ambiguous',
        reason: `coupon_factor_${factor}_does_not_match_15pct`,
      };
    }
    return {
      ...basis,
      allowed15: false,
      category: 'forbidden',
      reason: 'coupon_factor_1_no_coupon',
    };
  }

  if (allowsTarget15(compactCombo)) {
    return {
      ...basis,
      allowed15: true,
      category: 'allowed15',
      reason: 'combo_explicitly_allows_15pct_coupon',
    };
  }

  return {
    ...basis,
    allowed15: false,
    category: 'unknown',
    reason: combo ? 'combo_has_no_explicit_15pct_coupon_allowance' : 'missing_coupon_factor_and_combo',
  };
}

export function summarizeCouponTargetEligibilityPlan(plan) {
  if (!plan) return null;
  return summarizeCouponTargetEligibilityMaps(plan);
}

export function couponPlanStoreView(plan, storeKey) {
  const key = normalizeStoreKey(storeKey);
  const allSet = plan?.allByStore?.get(key) || new Set();
  const allowedSet = plan?.allowed15ByStore?.get(key) || plan?.byStore?.get(key) || new Set();
  const blockedRows = plan?.blockedByStore?.get(key) || [];
  const rows = plan?.rowsByStore?.get(key) || [];
  const categoryCounts = {};
  for (const row of rows) categoryCounts[row.category] = (categoryCounts[row.category] || 0) + 1;
  return {
    storeKey: key,
    allSet,
    allowedSet,
    blockedRows,
    rows,
    categoryCounts,
    allCount: allSet.size,
    allowedCount: allowedSet.size,
    blockedCount: blockedRows.length,
  };
}

export function findCouponPlanRow(plan, storeKey, skc) {
  const key = normalizeStoreKey(storeKey);
  const targetSkc = normalizeSkc(skc);
  return (plan?.rowsByStore?.get(key) || []).find(row => row.skc === targetSkc) || null;
}

export function plannedCouponFactor(planRow, fallbackDiscountPct = 15) {
  const explicit = numberOrNull(planRow?.couponFactor);
  if (explicit !== null) return explicit;
  return round2(1 - Number(fallbackDiscountPct || 15) / 100);
}

export function plannedFinalTargetPrice(planRow, couponFactor = null) {
  const finalTarget = numberOrNull(planRow?.finalTargetPrice);
  if (finalTarget !== null) return finalTarget;
  return null;
}

export function classifyLimitedDiscountCouponStack(limitedRow, planRow, options = {}) {
  const normalizedOptions = typeof options === 'number'
    ? {fallbackDiscountPct: options}
    : (options || {});
  const fallbackDiscountPct = normalizedOptions.fallbackDiscountPct ?? normalizedOptions.targetDiscountPct ?? 15;
  const priceToleranceSar = numberOrNull(normalizedOptions.priceToleranceSar) ?? PRICE_GUARD_TOLERANCE_SAR;
  const couponFactor = plannedCouponFactor(planRow, fallbackDiscountPct);
  const limitedDiscountPrice = numberOrNull(limitedRow?.limitedDiscountPrice);
  const finalTargetPrice = plannedFinalTargetPrice(planRow, couponFactor);
  const out = {
    skc: limitedRow?.skc || '',
    supplierNo: limitedRow?.supplierNo || '',
    limitedDiscountPrice,
    couponFactor,
    finalTargetPrice,
    finalWithCoupon: null,
    diff: null,
    allowSubmit: false,
    shouldCancelCoupon: false,
    priceToleranceSar,
    decision: '',
  };
  if (limitedDiscountPrice === null) {
    out.decision = 'missing_limited_discount_price';
    return out;
  }
  if (finalTargetPrice === null) {
    out.decision = 'missing_final_target_price';
    return out;
  }
  out.finalWithCoupon = round2(limitedDiscountPrice * couponFactor);
  out.diff = round2(out.finalWithCoupon - finalTargetPrice);
  if (out.diff < -priceToleranceSar) {
    out.decision = 'coupon_final_below_target';
    out.shouldCancelCoupon = true;
    return out;
  }
  out.allowSubmit = true;
  out.decision = Math.abs(out.diff) <= priceToleranceSar
    ? 'coupon_final_matches_target'
    : 'coupon_final_above_target';
  return out;
}

export function isCouponActiveStatus(status) {
  return ['0', '1'].includes(String(status ?? ''));
}

export function normalizeStoreKey(value) {
  return String(value || '').trim().toUpperCase();
}

export function normalizeSkc(value) {
  return String(value || '').trim();
}

function summarizeCouponTargetEligibilityMaps(plan) {
  const stores = new Set([
    ...mapKeys(plan?.allByStore),
    ...mapKeys(plan?.allowed15ByStore || plan?.byStore),
    ...mapKeys(plan?.blockedByStore),
    ...mapKeys(plan?.rowsByStore),
  ]);
  const out = [];
  for (const storeKey of [...stores].sort()) {
    const view = couponPlanStoreView(plan, storeKey);
    out.push({
      storeKey,
      all: view.allCount,
      allowed15: view.allowedCount,
      blocked: view.blockedCount,
      forbidden: view.categoryCounts.forbidden || 0,
      unknown: view.categoryCounts.unknown || 0,
      ambiguous: view.categoryCounts.ambiguous || 0,
      notInPriceOverrides: view.categoryCounts.not_in_price_overrides || 0,
    });
  }
  return out;
}

function extractPriceOverridePaths(doc) {
  const paths = [];
  for (const key of ['priceOverrides', 'priceOverride', 'priceOverridePath', 'priceOverridePaths']) {
    if (doc?.[key]) paths.push(...splitPathList(doc[key]));
  }
  for (const source of doc?.sourceFiles || []) {
    if (/price-overrides/i.test(String(source))) paths.push(source);
  }
  return unique(paths);
}

async function inferExistingPriceOverridePath(planPath) {
  const file = path.basename(planPath);
  if (!/selection-plan/i.test(file)) return null;
  const candidate = path.join(path.dirname(planPath), file.replace(/selection-plan/i, 'price-overrides'));
  try {
    await fs.access(candidate);
    return candidate;
  } catch {
    return null;
  }
}

async function readJsonStrict(file) {
  const text = await fs.readFile(file, 'utf8');
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}

async function readJsonIfExists(file, fallback) {
  try {
    return await readJsonStrict(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

function splitPathList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(splitPathList);
  return String(value).split(',').map(x => x.trim()).filter(Boolean);
}

function resolveInputPath(root, value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return path.resolve(root, text);
}

function storeSkcKey(storeKey, skc) {
  const store = normalizeStoreKey(storeKey);
  const normalizedSkc = normalizeSkc(skc);
  return store && normalizedSkc ? `${store}__${normalizedSkc}` : '';
}

function addToStoreSet(map, storeKey, skc) {
  const key = normalizeStoreKey(storeKey);
  if (!key || !skc) return;
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(normalizeSkc(skc));
}

function addToStoreRows(map, storeKey, row) {
  const key = normalizeStoreKey(storeKey);
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(row);
}

function mapKeys(map) {
  return map ? [...map.keys()] : [];
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/[%SAR,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function normalizeFactor(value) {
  const n = numberOrNull(value);
  return n === null ? '' : String(round4(n));
}

function normalizeCombo(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[，,；;]/g, ';');
}

function forbidsTarget15(compactCombo) {
  return /不叠券/.test(compactCombo)
    || /券都禁止/.test(compactCombo)
    || /15\/30\/50%?券都禁止/.test(compactCombo)
    || /禁止15%?券/.test(compactCombo)
    || /15%?券(?:都|也)?禁止/.test(compactCombo);
}

function allowsTarget15(compactCombo) {
  return /仅15%?券/.test(compactCombo)
    || /普通活动[+＋]15%?券/.test(compactCombo)
    || /普通活动[+＋]仅15%?券/.test(compactCombo);
}

function round4(value) {
  return Math.round((Number(value) + Number.EPSILON) * 10000) / 10000;
}
