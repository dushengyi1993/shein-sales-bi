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
const BI_PORTAL_DATA_DEFAULT = path.join(ROOT, 'outputs', 'bi-portal', 'data.json');
const STORES_CONFIG_DEFAULT = path.join(ROOT, 'config', 'stores.json');
const NEW_SKC_SHELF_AGE_DAYS = 30;
const NEW_SKC_MAX_ROWS = 80;
const CRITICAL_SOURCE_LABELS = new Set([
  'couponSubmitLatestSummary',
  'lowPriceOverlapLive',
  'lowPriceOverlapCancelList',
  'oldOrdinaryOverlapLive',
  'oldOrdinaryOverlapCancelList',
  'marketingStackReview',
  'targetSelectionPlan',
  'priceOverridesPlan',
  'storesConfig',
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
    biPortalData: BI_PORTAL_DATA_DEFAULT,
    targetPlan: TARGET_PLAN_DEFAULT,
    priceOverrides: PRICE_OVERRIDES_DEFAULT,
    storesConfig: STORES_CONFIG_DEFAULT,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--date') args.date = String(argv[++i] || '').trim();
    else if (a === '--out-dir') args.outDir = path.resolve(argv[++i]);
    else if (a === '--max-age-hours') args.maxAgeHours = Number(argv[++i]);
    else if (a === '--bi-portal-data') args.biPortalData = path.resolve(argv[++i]);
    else if (a === '--target-plan') args.targetPlan = path.resolve(argv[++i]);
    else if (a === '--price-overrides') args.priceOverrides = path.resolve(argv[++i]);
    else if (a === '--stores-config') args.storesConfig = path.resolve(argv[++i]);
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
    meaning: 'limited_discount_coupon_scan; above means limited-fallback coupon final is above target, not final transaction price',
    belowTarget: Number(liveDoc?.activeCouponBelowTargetCount || 0),
    missingEvidence: Number(liveDoc?.activeCouponMissingPriceEvidenceCount || 0),
    matchesTarget: Number(priceDecisionCounts.coupon_final_matches_target || 0),
    limitedFallbackAboveTarget: Number(priceDecisionCounts.coupon_final_above_target || 0),
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

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round2(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function classifyFallbackPriceStack(row) {
  const couponFactor = numberOrNull(row.couponFactor);
  const targetFinalPrice = numberOrNull(row.targetFinalPrice ?? row.finalTargetPrice);
  const limitedDiscountPrice = numberOrNull(row.limitedDiscountPrice);
  const ordinaryMarketingPrice = numberOrNull(
    row.ordinaryMarketingPrice
    ?? row.effectiveOrdinaryMarketingPrice
    ?? row.ordinaryActivityPrice
  );
  const ordinaryCoverageConfirmedAbsent = row.ordinaryCoverageConfirmedAbsent === true
    || row.noOrdinaryMarketingActivity === true;
  const currentSellingPrice = numberOrNull(row.currentSellingPrice ?? row.currentPrice ?? row.salePrice);
  const candidates = [];
  if (ordinaryMarketingPrice !== null) {
    candidates.push({source: 'ordinary_marketing', price: ordinaryMarketingPrice});
  }
  if (limitedDiscountPrice !== null) {
    candidates.push({source: 'limited_discount', price: limitedDiscountPrice});
  }
  if (currentSellingPrice !== null) {
    candidates.push({source: 'current_selling_price', price: currentSellingPrice});
  }
  const effective = candidates.length
    ? candidates.reduce((best, item) => (item.price < best.price ? item : best), candidates[0])
    : null;
  const effectiveFinalWithCoupon = effective && couponFactor !== null
    ? round2(effective.price * couponFactor)
    : null;
  const priceStackEvidenceComplete = ordinaryMarketingPrice !== null || ordinaryCoverageConfirmedAbsent;
  let finalPriceStatus = 'price_stack_evidence_incomplete';
  if (effectiveFinalWithCoupon !== null && targetFinalPrice !== null) {
    if (effectiveFinalWithCoupon < targetFinalPrice - 1) finalPriceStatus = 'effective_final_below_target';
    else if (effectiveFinalWithCoupon > targetFinalPrice + 1) finalPriceStatus = 'effective_final_above_target';
    else finalPriceStatus = 'effective_final_matches_target';
  }
  if (!priceStackEvidenceComplete && effectiveFinalWithCoupon !== null && targetFinalPrice !== null) {
    if (effectiveFinalWithCoupon < targetFinalPrice - 1) finalPriceStatus = 'limited_fallback_below_target_price_stack_incomplete';
    else if (effectiveFinalWithCoupon > targetFinalPrice + 1) finalPriceStatus = 'limited_fallback_above_target_price_stack_incomplete';
    else finalPriceStatus = 'limited_fallback_matches_target_price_stack_incomplete';
  }
  return {
    candidates,
    effectiveBasePrice: effective?.price ?? null,
    effectiveBaseSource: effective?.source || '',
    effectiveFinalWithCoupon,
    finalPriceStatus,
    priceStackEvidenceComplete,
    ordinaryMarketingPrice,
    ordinaryCoverageConfirmedAbsent,
    limitedDiscountPrice,
    currentSellingPrice,
  };
}

function classifyOrdinaryEvidence(row, stack) {
  const planActivityId = row.ordinaryPlanActivityId || '';
  const liveCheck = String(row.ordinaryActivity42892LiveCheck || row.ordinaryActivityLiveCheck || '').trim();
  const isPartakeMatches = Number(row.ordinaryActivity42892IsPartakeMatches || row.ordinaryActivityIsPartakeMatches || 0);
  const availableMatches = Number(row.ordinaryActivity42892AvailableMatches || row.ordinaryActivityAvailableMatches || 0);
  if (stack.ordinaryMarketingPrice !== null) {
    return {
      status: 'ordinary_price_evidence_present',
      summary: `已读取普通营销活动价 ${stack.ordinaryMarketingPrice}`,
      planActivityId,
      isPartakeMatches,
      availableMatches,
    };
  }
  if (stack.ordinaryCoverageConfirmedAbsent) {
    return {
      status: 'ordinary_coverage_confirmed_absent',
      summary: '已确认该时间窗口无普通营销活动覆盖；限时折扣可作为兜底基准价候选',
      planActivityId,
      isPartakeMatches,
      availableMatches,
    };
  }
  if (isPartakeMatches > 0 || availableMatches > 0) {
    return {
      status: 'checked_specific_activity_match_without_price',
      summary: `计划普通活动 ${planActivityId || '-'} live check 命中商品，但缺普通活动价，不能只看限时折扣价`,
      planActivityId,
      isPartakeMatches,
      availableMatches,
    };
  }
  if (liveCheck.includes('no_target_skc')) {
    return {
      status: 'checked_specific_activity_no_match',
      summary: `计划普通活动 ${planActivityId || '-'} live check 未命中目标 SKC；若普通活动确实未覆盖，限时折扣才是兜底候选`,
      planActivityId,
      isPartakeMatches,
      availableMatches,
    };
  }
  return {
    status: 'ordinary_evidence_incomplete',
    summary: '普通营销活动覆盖/价格证据不完整；不能仅凭限时折扣价判断最终成交价偏高',
    planActivityId,
    isPartakeMatches,
    availableMatches,
  };
}

function summarizeAboveTargetActions(doc) {
  const rows = (doc?.rows || []).map(r => {
    const stack = classifyFallbackPriceStack(r);
    const ordinaryEvidence = classifyOrdinaryEvidence(r, stack);
    const limitedFallbackFinalWithCoupon = stack.limitedDiscountPrice !== null && numberOrNull(r.couponFactor) !== null
      ? round2(stack.limitedDiscountPrice * numberOrNull(r.couponFactor))
      : numberOrNull(r.finalWithCoupon);
    const targetFinal = numberOrNull(r.targetFinalPrice);
    const limitedFallbackDiff = limitedFallbackFinalWithCoupon !== null && targetFinal !== null
      ? round2(limitedFallbackFinalWithCoupon - targetFinal)
      : numberOrNull(r.diff);
    const fallbackOnly = stack.effectiveBaseSource === 'limited_discount' || !stack.priceStackEvidenceComplete;
    const suggestedAction = fallbackOnly
      ? '先确认普通营销活动是否覆盖并形成更低可叠券基准价；若未覆盖，才调整限时折扣兜底到 targetBaseNeeded；保留 15% 券，不取消券'
      : '已有更低有效基准价证据时，不得只因限时折扣价偏高而调整限时折扣；先按有效基准价复核最终成交价';
    return {
      storeKey: r.storeKey,
      skc: r.skc,
      canonical: r.canonical,
      priceStackEvidenceComplete: stack.priceStackEvidenceComplete,
      finalPriceStatus: stack.finalPriceStatus,
      effectiveBaseSource: stack.effectiveBaseSource,
      effectiveBasePrice: stack.effectiveBasePrice,
      effectiveFinalWithCoupon: stack.effectiveFinalWithCoupon,
      ordinaryEvidenceStatus: ordinaryEvidence.status,
      ordinaryEvidenceSummary: ordinaryEvidence.summary,
      ordinaryPlanActivityId: ordinaryEvidence.planActivityId,
      ordinaryActivityIsPartakeMatches: ordinaryEvidence.isPartakeMatches,
      ordinaryActivityAvailableMatches: ordinaryEvidence.availableMatches,
      limitedFallbackPrice: stack.limitedDiscountPrice,
      targetBaseNeeded: numberOrNull(r.targetBaseNeeded),
      limitedFallbackFinalWithCoupon,
      targetFinalPrice: targetFinal,
      limitedFallbackDiff,
      legacyFieldMeaning: 'currentBasePrice/finalWithCoupon/diff were removed from this summary because limited-discount fallback is not necessarily the final effective price',
      limitedDiscountEnd: r.limitedDiscountEnd,
      suggestedAction,
      originalSuggestedAction: r.suggestedAction || '',
      executeAutomatically: false,
      reason: `${ordinaryEvidence.summary}；限时折扣价 × 券只能表示“兜底层”是否偏高，不等于最终成交价偏高。`,
    };
  });
  return {
    meaning: 'limited_discount_fallback_high_candidates_not_final_price_above_target',
    count: rows.length,
    legacyFieldMeaning: 'aboveTargetActions are limited-discount fallback candidates, not final transaction-price above-target conclusions',
    incompletePriceStackEvidenceCount: rows.filter(r => !r.priceStackEvidenceComplete).length,
    effectiveFinalAboveTargetCount: rows.filter(r => r.priceStackEvidenceComplete && r.finalPriceStatus === 'effective_final_above_target').length,
    effectiveFinalMatchesTargetCount: rows.filter(r => r.priceStackEvidenceComplete && r.finalPriceStatus === 'effective_final_matches_target').length,
    effectiveFinalBelowTargetCount: rows.filter(r => r.priceStackEvidenceComplete && r.finalPriceStatus === 'effective_final_below_target').length,
    limitedFallbackBelowTargetIncompleteCount: rows.filter(r => r.finalPriceStatus === 'limited_fallback_below_target_price_stack_incomplete').length,
    rows,
  };
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

function normKey(value) {
  return String(value || '').trim().toUpperCase();
}

function normSku(value) {
  return String(value || '').trim();
}

function planItemKey(row) {
  return `${normKey(row?.storeKey || row?.store || row?.['店铺'])}::${normSku(row?.skc || row?.SKC || row?.['SKC'])}`;
}

function standardKey(storeKey, canonical) {
  return `${normKey(storeKey)}::${normSku(canonical)}`;
}

function collectPlanEvidence(selectionPlanDoc, priceOverridesDoc) {
  const selectedBySkc = new Map();
  const overrideBySkc = new Map();
  const excludedBySkc = new Map();
  const plannedStandardsByStore = new Map();
  const addStandard = row => {
    const storeKey = normKey(row?.storeKey || row?.store || row?.['店铺']);
    const canonical = normSku(row?.canonical || row?.standard_goods_sn || row?.standardGoodsSn || row?.['标准货号']);
    if (!storeKey || !canonical) return;
    const key = standardKey(storeKey, canonical);
    const item = plannedStandardsByStore.get(key) || {
      storeKey,
      canonical,
      plannedSkcSamples: [],
      couponFactors: new Set(),
      finalTargetPriceSamples: [],
      combos: new Set(),
    };
    const skc = normSku(row?.skc || row?.SKC || row?.['SKC']);
    if (skc && item.plannedSkcSamples.length < 5 && !item.plannedSkcSamples.includes(skc)) item.plannedSkcSamples.push(skc);
    const couponFactor = numberOrNull(row?.couponFactor);
    if (couponFactor !== null) item.couponFactors.add(couponFactor);
    const finalTargetPrice = numberOrNull(row?.finalTargetPrice ?? row?.targetPrice);
    if (finalTargetPrice !== null && item.finalTargetPriceSamples.length < 5) item.finalTargetPriceSamples.push(finalTargetPrice);
    const combo = String(row?.combo || row?.rule || '').trim();
    if (combo) item.combos.add(combo);
    plannedStandardsByStore.set(key, item);
  };
  for (const row of selectionPlanDoc?.items || []) {
    const key = planItemKey(row);
    if (!key.endsWith('::')) selectedBySkc.set(key, row);
    addStandard(row);
  }
  for (const row of priceOverridesDoc?.items || []) {
    const key = planItemKey(row);
    if (!key.endsWith('::')) overrideBySkc.set(key, row);
    addStandard(row);
  }
  for (const row of [
    ...(selectionPlanDoc?.excluded || []),
    ...(priceOverridesDoc?.excluded || []),
  ]) {
    const key = planItemKey(row);
    if (!key.endsWith('::') && !excludedBySkc.has(key)) excludedBySkc.set(key, row);
  }
  return {
    selectedBySkc,
    overrideBySkc,
    excludedBySkc,
    plannedStandardsByStore,
  };
}

function summarizeStandardPlanEvidence(item) {
  if (!item) return null;
  return {
    storeKey: item.storeKey,
    canonical: item.canonical,
    plannedSkcSamples: item.plannedSkcSamples,
    couponFactors: [...item.couponFactors].sort((a, b) => a - b),
    finalTargetPriceSamples: item.finalTargetPriceSamples,
    comboSamples: [...item.combos].slice(0, 3),
  };
}

function isFifteenCouponAllowed(row) {
  const couponFactor = numberOrNull(row?.couponFactor);
  const finalTargetPrice = numberOrNull(row?.finalTargetPrice);
  const combo = String(row?.combo || '').toLowerCase();
  const forbidsCoupon = /禁止\s*15|15\s*%\s*券都禁止|15\/30\/50|不叠券|禁报券/.test(combo);
  return Boolean(couponFactor !== null && Math.abs(couponFactor - 0.85) < 0.01 && finalTargetPrice !== null && !forbidsCoupon);
}

function daysBetweenLocalDates(start, end) {
  if (!start || !end) return null;
  const startDate = parseLocalDateTime(String(start).slice(0, 10));
  const endDate = parseLocalDateTime(String(end).slice(0, 10));
  if (!startDate || !endDate) return null;
  return Math.floor((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));
}

function inferShelfAgeDays(link, reportDate) {
  const direct = numberOrNull(link?.shelf_age_days ?? link?.shelf_days);
  if (direct !== null) return {value: direct, source: 'shelf_age_days'};
  const fromLinkDate = daysBetweenLocalDates(link?.link_date, reportDate);
  if (fromLinkDate !== null && fromLinkDate >= 0) return {value: fromLinkDate, source: 'link_date'};
  return {value: null, source: 'missing'};
}

function summarizeNewSkcCandidates({biDoc, biSource, selectionPlanDoc, priceOverridesDoc, storesConfigDoc, reportDate}) {
  const links = Array.isArray(biDoc?.storeLinks) ? biDoc.storeLinks : [];
  const enabledStores = new Set();
  const knownStores = new Set();
  for (const store of storesConfigDoc?.stores || []) {
    const storeKey = normKey(store.storeKey);
    if (!storeKey) continue;
    knownStores.add(storeKey);
    if (store.enabled !== false) enabledStores.add(storeKey);
  }
  const plan = collectPlanEvidence(selectionPlanDoc, priceOverridesDoc);
  const ignored = [];
  const rows = [];
  const byDecision = {};
  let onShelfRows = 0;
  let missingExactPlanOnShelf = 0;
  let recentMissingExactPlanOnShelf = 0;
  let unknownAgeMissingExactPlanOnShelf = 0;
  let exactPlannedRows = 0;
  let exactExcludedRows = 0;

  for (const link of links) {
    const storeKey = normKey(link.store_key || link.storeKey || link.store);
    const skc = normSku(link.skc || link.SKC);
    const canonical = normSku(link.standard_goods_sn || link.standardGoodsSn || link.canonical);
    const isOnShelf = link.is_on_shelf === true || /已上架|ON_SHELF/i.test(String(link.shelf_status_name || link.shelf_statuses || ''));
    if (!isOnShelf) continue;
    onShelfRows += 1;
    if (!storeKey || !skc) {
      ignored.push({storeKey, skc, canonical, reason: 'missing_store_or_skc'});
      continue;
    }
    if (!knownStores.has(storeKey)) {
      ignored.push({storeKey, skc, canonical, reason: 'unknown_store'});
      continue;
    }
    if (!enabledStores.has(storeKey)) {
      ignored.push({storeKey, skc, canonical, reason: 'disabled_store'});
      continue;
    }
    const exactKey = `${storeKey}::${skc}`;
    if (plan.selectedBySkc.has(exactKey) || plan.overrideBySkc.has(exactKey)) {
      exactPlannedRows += 1;
      continue;
    }
    missingExactPlanOnShelf += 1;
    const shelfAge = inferShelfAgeDays(link, reportDate);
    const shelfAgeDays = shelfAge.value;
    const isRecent = shelfAgeDays !== null && shelfAgeDays <= NEW_SKC_SHELF_AGE_DAYS;
    const unknownAge = shelfAgeDays === null;
    if (isRecent) recentMissingExactPlanOnShelf += 1;
    if (unknownAge) unknownAgeMissingExactPlanOnShelf += 1;
    if (!isRecent && !unknownAge) continue;

    const exactExcluded = plan.excludedBySkc.get(exactKey) || null;
    if (exactExcluded) exactExcludedRows += 1;
    const sameStandard = canonical ? plan.plannedStandardsByStore.get(standardKey(storeKey, canonical)) : null;
    let decision = 'unplanned_new_on_shelf_skc_needs_pricing';
    let action = '待定价；先补 finalTargetPrice/cost/couponFactor，再决定普通活动、限时折扣兜底和 15% 券';
    if (unknownAge) {
      decision = 'unknown_shelf_age_needs_review';
      action = '缺上架天数且无法用 link_date 兜底；先刷新 BI 链接快照/补年龄证据，再判断是否新链接';
    } else if (exactExcluded) {
      decision = 'known_excluded_needs_pricing';
      action = `已在计划 excluded，原因 ${exactExcluded.reason || 'unknown'}；只能先补价格证据，不能自动报券`;
    } else if (sameStandard) {
      decision = 'same_standard_goods_sn_needs_confirmation';
      action = '同店同标准货号已有计划，但当前 SKC 没有精确计划；需人工确认是否同款同成本/同底价，不得自动继承活动或券策略';
    }
    byDecision[decision] = (byDecision[decision] || 0) + 1;
    const override = plan.overrideBySkc.get(exactKey) || null;
    const couponDryRunEligible = override ? isFifteenCouponAllowed(override) : false;
    rows.push({
      storeKey,
      skc,
      canonical,
      decision,
      action,
      shelfAgeDays,
      shelfAgeSource: shelfAge.source,
      isOnShelf: true,
      linkDate: link.link_date || '',
      c7EpsUv: numberOrNull(link.c7_eps_uv),
      c30EpsUv: numberOrNull(link.c30_eps_uv),
      platformSaleableStock: numberOrNull(link.platform_saleable_stock),
      performanceActivityNames: link.performance_activity_names || '',
      healthBucket: link.health_bucket || '',
      exactPlan: false,
      exactExcludedReason: exactExcluded?.reason || '',
      sameStandardPlan: summarizeStandardPlanEvidence(sameStandard),
      couponDryRunEligible,
      couponDryRunReason: couponDryRunEligible
        ? '已有精确 15% 券价格证据，可进入 dry-run 评估'
        : '缺精确 finalTargetPrice/couponFactor=0.85/allowed15 证据，不能生成 15% 券 dry-run 建议',
    });
  }
  rows.sort((a, b) => {
    const av = Number(a.c7EpsUv || 0);
    const bv = Number(b.c7EpsUv || 0);
    if (bv !== av) return bv - av;
    return String(a.storeKey).localeCompare(String(b.storeKey)) || String(a.skc).localeCompare(String(b.skc));
  });
  const stale = biSource?.status === 'stale';
  return {
    status: stale ? 'stale_observation_only' : 'ok',
    source: biSource?.path || '',
    sourceGeneratedAt: biDoc?.generatedAt || '',
    linkDate: biDoc?.dates?.linkDate || '',
    recentWindowDays: NEW_SKC_SHELF_AGE_DAYS,
    storeLinksRows: links.length,
    onShelfRows,
    exactPlannedRows,
    missingExactPlanOnShelf,
    recentMissingExactPlanOnShelf,
    unknownAgeMissingExactPlanOnShelf,
    ignoredCount: ignored.length,
    ignored: ignored.slice(0, 30),
    exactExcludedRows,
    needsPricing: rows.filter(r => r.decision === 'unplanned_new_on_shelf_skc_needs_pricing' || r.decision === 'known_excluded_needs_pricing').length,
    needsConfirmation: rows.filter(r => r.decision === 'same_standard_goods_sn_needs_confirmation').length,
    needsAgeReview: rows.filter(r => r.decision === 'unknown_shelf_age_needs_review').length,
    needsCouponReview: rows.filter(r => r.couponDryRunEligible).length,
    byDecision,
    rows: rows.slice(0, NEW_SKC_MAX_ROWS),
  };
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
    ['newSkcCandidates.recentMissingExactPlanOnShelf', current.newSkcCandidates?.recentMissingExactPlanOnShelf, previous.newSkcCandidates?.recentMissingExactPlanOnShelf],
    ['newSkcCandidates.unknownAgeMissingExactPlanOnShelf', current.newSkcCandidates?.unknownAgeMissingExactPlanOnShelf, previous.newSkcCandidates?.unknownAgeMissingExactPlanOnShelf],
    ['newSkcCandidates.needsPricing', current.newSkcCandidates?.needsPricing, previous.newSkcCandidates?.needsPricing],
    ['newSkcCandidates.needsConfirmation', current.newSkcCandidates?.needsConfirmation, previous.newSkcCandidates?.needsConfirmation],
    ['newSkcCandidates.needsAgeReview', current.newSkcCandidates?.needsAgeReview, previous.newSkcCandidates?.needsAgeReview],
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
  lines.push(`- 限时折扣兜底层叠券扫描：below=${report.lowPriceOverlap.belowTarget}, missing=${report.lowPriceOverlap.missingEvidence}, matches=${report.lowPriceOverlap.matchesTarget}, fallbackAbove=${report.lowPriceOverlap.limitedFallbackAboveTarget}（非最终成交价结论）, cancelRows=${report.lowPriceOverlap.cancelRows}`);
  lines.push(`- 旧普通活动叠券：riskCancel=${report.oldOrdinaryOverlap.riskCancel}, cancelRows=${report.oldOrdinaryOverlap.cancelRows}, observationRows=${report.oldOrdinaryOverlap.observationRows}`);
  lines.push(`- 兜底限时折扣偏高候选（非最终成交价结论）：${report.aboveTargetActions.count}；证据不完整=${report.aboveTargetActions.incompletePriceStackEvidenceCount || 0}，有效最终价偏高=${report.aboveTargetActions.effectiveFinalAboveTargetCount || 0}`);
  if (report.aboveTargetActions.rows.length) {
    lines.push('');
    lines.push('| 店铺 | SKC | 标准货号 | 普通活动证据 | 限时折扣价（仅兜底） | 兜底建议基准价 | 兜底券后价 | 目标价 | diff | 动作口径 |');
    lines.push('| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |');
    for (const r of report.aboveTargetActions.rows.slice(0, 20)) {
      lines.push(`| ${r.storeKey} | \`${r.skc}\` | ${r.canonical} | ${r.ordinaryEvidenceStatus} | ${num(r.limitedFallbackPrice)} | ${num(r.targetBaseNeeded)} | ${num(r.limitedFallbackFinalWithCoupon)} | ${num(r.targetFinalPrice)} | ${num(r.limitedFallbackDiff)} | ${r.suggestedAction} |`);
    }
  }
  lines.push('');
  lines.push('## 新 SKC / 新链接候选');
  lines.push('');
  lines.push(`- sourceStatus=${report.newSkcCandidates.status}, linkDate=${report.newSkcCandidates.linkDate || '-'}, recentWindowDays=${report.newSkcCandidates.recentWindowDays}`);
  lines.push(`- onShelf=${report.newSkcCandidates.onShelfRows}, exactPlanned=${report.newSkcCandidates.exactPlannedRows}, missingExactPlanOnShelf=${report.newSkcCandidates.missingExactPlanOnShelf}, recentMissing=${report.newSkcCandidates.recentMissingExactPlanOnShelf}, unknownAge=${report.newSkcCandidates.unknownAgeMissingExactPlanOnShelf}`);
  lines.push(`- needsPricing=${report.newSkcCandidates.needsPricing}, needsConfirmation=${report.newSkcCandidates.needsConfirmation}, needsAgeReview=${report.newSkcCandidates.needsAgeReview}, needsCouponReview=${report.newSkcCandidates.needsCouponReview}, ignored=${report.newSkcCandidates.ignoredCount}`);
  if (!report.newSkcCandidates.rows.length) {
    lines.push('- 暂无 30 天内上架且缺精确价格计划的 SKC 候选。');
  } else {
    lines.push('');
    lines.push('| 店铺 | SKC | 标准货号 | 上架天数 | C7曝光 | 库存 | 决策 | 动作 |');
    lines.push('| --- | --- | --- | ---: | ---: | ---: | --- | --- |');
    for (const r of report.newSkcCandidates.rows.slice(0, 30)) {
      lines.push(`| ${r.storeKey} | \`${r.skc}\` | ${r.canonical} | ${num(r.shelfAgeDays)} | ${num(r.c7EpsUv)} | ${num(r.platformSaleableStock)} | ${r.decision} | ${r.action} |`);
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

  const biPortal = await read('biPortalData', args.biPortalData);
  const targetPlan = await read('targetSelectionPlan', args.targetPlan);
  const priceOverrides = await read('priceOverridesPlan', args.priceOverrides);
  const storesConfig = await read('storesConfig', args.storesConfig);
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
  const newSkcCandidates = summarizeNewSkcCandidates({
    biDoc: biPortal.data,
    biSource: biPortal.source,
    selectionPlanDoc: targetPlan.data,
    priceOverridesDoc: priceOverrides.data,
    storesConfigDoc: storesConfig.data,
    reportDate: args.date,
  });
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
  if (aboveTargetActions.effectiveFinalBelowTargetCount > 0) {
    addBlocker(blockers, 'effective_final_below_target_from_price_stack', `有效价格栈券后低于目标=${aboveTargetActions.effectiveFinalBelowTargetCount}`);
  }
  if (aboveTargetActions.limitedFallbackBelowTargetIncompleteCount > 0) {
    addBlocker(blockers, 'limited_fallback_below_target_price_stack_incomplete', `限时折扣兜底层券后低于目标但价格栈证据不完整=${aboveTargetActions.limitedFallbackBelowTargetIncompleteCount}`);
  }
  if (newSkcCandidates.ignoredCount > 0) {
    sourceWarnings.push({
      code: 'new_skc_ignored_store_rows',
      label: 'newSkcCandidates',
      message: `BI storeLinks 有 ${newSkcCandidates.ignoredCount} 行因 unknown/disabled/missing store 或缺 SKC 被忽略，不能作为可执行候选`,
      evidence: {samples: newSkcCandidates.ignored.slice(0, 10)},
    });
  }
  if (newSkcCandidates.unknownAgeMissingExactPlanOnShelf > 0) {
    sourceWarnings.push({
      code: 'new_skc_unknown_shelf_age',
      label: 'newSkcCandidates',
      message: `${newSkcCandidates.unknownAgeMissingExactPlanOnShelf} 个上架且缺精确计划的 SKC 缺上架天数/link_date 证据，不能判定是否新链接`,
      evidence: {samples: newSkcCandidates.rows.filter(r => r.decision === 'unknown_shelf_age_needs_review').slice(0, 10)},
    });
  }
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
    newSkcCandidates,
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
    && !report.newSkcCandidates.recentMissingExactPlanOnShelf
    && !report.newSkcCandidates.unknownAgeMissingExactPlanOnShelf
    && !report.newSkcCandidates.needsPricing
    && !report.newSkcCandidates.needsConfirmation
    && !report.newSkcCandidates.needsAgeReview
    && !report.newSkcCandidates.needsCouponReview
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
