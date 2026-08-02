import fs from 'node:fs';
import path from 'node:path';
import {
  buildManualLimitedDiscountIndex,
  formatShanghaiDateTime,
  manualLimitedDiscountKey,
  parseShanghaiDateTime,
} from './marketing_manual_limited_discount_overrides.mjs';
import {
  ceil2,
  deriveTopTreatmentTargetFromCost,
  findMarketingCostEvidence,
  pctConfigToRatio,
  unwrapBiLinksData,
} from './marketing_pricing_policy.mjs';
import {
  applyLowEtFastSellerPricePullback,
  buildLowEtFastSellerPricingContext,
} from './marketing_low_et_fast_seller_pricing.mjs';

export const DEFAULT_HIGH_CLICK_SPECIAL_POLICY = Object.freeze({
  enabled: true,
  criteria: {
    c7ExposureMinExclusive: 3000,
    c7ClickRateMinExclusive: 0.04,
    cartVisitorRouteEnabled: true,
    c7CartExposureMinInclusive: 3000,
    c7CartVisitorsMinInclusive: 20,
    c7SaleCountEquals: 0,
    onShelfOnly: true,
  },
  execution: {
    cartVisitorRouteAutoExecute: false,
    cartVisitorRouteApprovalStatus: 'pending_initial_user_confirmation',
  },
  pricing: {
    top5MarginDeltaPct: 2,
    floorMarginPct: 15,
    rounding: 'ceil2',
  },
  limitedDiscount: {
    activityStock: 10,
    durationDays: 7,
    activityNamePrefix: '高点击低转化专属限时折扣',
  },
  effectReview: {
    enabled: true,
    lookbackDays: 30,
  },
});

export function getHighClickSpecialPolicy(marketingPolicy = {}) {
  const configured = marketingPolicy?.highClickLowConversionSpecial || {};
  return {
    ...DEFAULT_HIGH_CLICK_SPECIAL_POLICY,
    ...configured,
    criteria: {
      ...DEFAULT_HIGH_CLICK_SPECIAL_POLICY.criteria,
      ...(configured.criteria || {}),
    },
    execution: {
      ...DEFAULT_HIGH_CLICK_SPECIAL_POLICY.execution,
      ...(configured.execution || {}),
    },
    pricing: {
      ...DEFAULT_HIGH_CLICK_SPECIAL_POLICY.pricing,
      ...(configured.pricing || {}),
    },
    limitedDiscount: {
      ...DEFAULT_HIGH_CLICK_SPECIAL_POLICY.limitedDiscount,
      ...(configured.limitedDiscount || {}),
    },
    effectReview: {
      ...DEFAULT_HIGH_CLICK_SPECIAL_POLICY.effectReview,
      ...(configured.effectReview || {}),
    },
  };
}

export function highClickSpecialMetricSnapshot(row) {
  const c7Exposure = numberOrNull(row?.c7_eps_uv ?? row?.c7EpsUv);
  const c7Clicks = numberOrNull(row?.c7_goods_uv ?? row?.c7GoodsUv);
  const c7CartVisitors = numberOrNull(row?.c7_cart_uv ?? row?.c7CartUv);
  const explicitRate = numberOrNull(row?.c7_click_rate ?? row?.c7ClickRate);
  const c7ClickRate = c7Exposure !== null && c7Exposure > 0 && c7Clicks !== null
    ? c7Clicks / c7Exposure
    : explicitRate;
  const c7SaleCount = numberOrNull(row?.c7_sale_cnt ?? row?.c7SaleCnt);
  return {
    c7Exposure,
    c7Clicks,
    c7CartVisitors,
    c7ClickRate: c7ClickRate === null ? null : round4(c7ClickRate),
    c7SaleCount,
    complete: c7Exposure !== null
      && c7SaleCount !== null
      && (c7ClickRate !== null || c7CartVisitors !== null),
    clickRateSource: c7Exposure !== null && c7Exposure > 0 && c7Clicks !== null
      ? 'c7_goods_uv/c7_eps_uv'
      : explicitRate !== null ? 'c7_click_rate' : 'missing',
  };
}

export function evaluateHighClickLowConversionRow(row, policy = DEFAULT_HIGH_CLICK_SPECIAL_POLICY) {
  const cfg = policy?.criteria || DEFAULT_HIGH_CLICK_SPECIAL_POLICY.criteria;
  const metrics = highClickSpecialMetricSnapshot(row);
  if (cfg.onShelfOnly !== false && !isOnShelf(row)) {
    return {qualifies: false, reason: 'not_on_shelf', metrics};
  }
  if (metrics.c7Exposure === null || metrics.c7SaleCount === null) {
    return {qualifies: false, reason: 'missing_c7_metrics', metrics};
  }
  if (metrics.c7SaleCount !== Number(cfg.c7SaleCountEquals)) {
    return {qualifies: false, reason: 'c7_sales_not_equal_required_value', metrics};
  }
  const clickRateRoute = metrics.c7ClickRate !== null
    && metrics.c7Exposure > Number(cfg.c7ExposureMinExclusive)
    && metrics.c7ClickRate > Number(cfg.c7ClickRateMinExclusive);
  const cartVisitorRoute = cfg.cartVisitorRouteEnabled !== false
    && metrics.c7CartVisitors !== null
    && metrics.c7Exposure >= Number(cfg.c7CartExposureMinInclusive)
    && metrics.c7CartVisitors >= Number(cfg.c7CartVisitorsMinInclusive);
  const qualificationRoutes = [
    ...(clickRateRoute ? ['click_rate'] : []),
    ...(cartVisitorRoute ? ['cart_visitors'] : []),
  ];
  if (!qualificationRoutes.length) {
    if (metrics.c7ClickRate === null && (cfg.cartVisitorRouteEnabled === false || metrics.c7CartVisitors === null)) {
      return {qualifies: false, reason: 'missing_c7_conversion_metrics', metrics, qualificationRoutes};
    }
    return {qualifies: false, reason: 'high_click_or_cart_threshold_not_met', metrics, qualificationRoutes};
  }
  return {
    qualifies: true,
    reason: qualificationRoutes.length > 1
      ? 'high_click_and_cart_zero_sales'
      : qualificationRoutes[0] === 'cart_visitors'
        ? 'high_cart_visitors_zero_sales'
        : 'high_click_zero_sales',
    metrics,
    qualificationRoutes,
  };
}

export function deriveHighClickSpecialPricing({
  canonical,
  priceOverridesDoc,
  costDoc,
  marketingPolicy = {},
  highClickPolicy = getHighClickSpecialPolicy(marketingPolicy),
} = {}) {
  const cost = findMarketingCostEvidence(costDoc || {}, canonical);
  if (!(cost.productUnitCostSar > 0)) {
    return {available: false, reason: 'missing_product_cost', ...cost};
  }
  const canonicalRowsRaw = (priceOverridesDoc?.items || [])
    .map(row => ({
      canonical: canonicalFromPlanRow(row),
      finalTargetPrice: numberOrNull(row?.finalTargetPrice ?? row?.targetPrice),
      isTop: row?.isTopExposureLink === true || row?.newListingTopTreatment === true,
      storeKey: normalizeStoreKey(row?.storeKey || row?.store || row?.['店铺']),
      skc: String(row?.skc || row?.SKC || '').trim(),
    }))
    .filter(row => canonicalKey(row.canonical) === canonicalKey(canonical) && row.finalTargetPrice > 0);
  const canonicalRows = [...canonicalRowsRaw.reduce((map, row, index) => {
    const key = row.storeKey && row.skc ? `${row.storeKey}::${row.skc}` : `row:${index}`;
    const previous = map.get(key);
    if (!previous || row.isTop || !previous.isTop) map.set(key, row);
    return map;
  }, new Map()).values()];
  const explicitTopRows = canonicalRows.filter(row => row.isTop);
  let top5TargetPrice = representativePrice(explicitTopRows.map(row => row.finalTargetPrice));
  let top5TargetSource = 'latest_approved_explicit_top5_rows';
  if (!(top5TargetPrice > 0)) {
    const derived = deriveTopTreatmentTargetFromCost({
      canonical,
      costDoc,
      policy: marketingPolicy,
    });
    if (derived.available) {
      top5TargetPrice = derived.price;
      top5TargetSource = derived.source;
    }
  }
  if (!(top5TargetPrice > 0)) {
    return {
      available: false,
      reason: 'missing_top5_target_price',
      productUnitCostSar: cost.productUnitCostSar,
      top5RowCount: explicitTopRows.length,
    };
  }

  const top5Margin = round4(1 - (cost.productUnitCostSar / top5TargetPrice));
  const marginDelta = pctConfigToRatio(highClickPolicy?.pricing?.top5MarginDeltaPct ?? 2);
  const floorMargin = pctConfigToRatio(
    highClickPolicy?.pricing?.floorMarginPct
      ?? marketingPolicy?.targetFloorMarginPct
      ?? 15,
  );
  const specialMargin = round4(top5Margin - marginDelta);
  if (!(specialMargin >= floorMargin - 1e-9)) {
    return {
      available: false,
      reason: 'special_margin_below_policy_floor',
      productUnitCostSar: cost.productUnitCostSar,
      top5TargetPrice,
      top5TargetSource,
      top5Margin,
      specialMargin,
      floorMargin,
      marginDelta,
    };
  }
  const specialPrice = ceil2(cost.productUnitCostSar / (1 - specialMargin));
  if (!(specialPrice > cost.productUnitCostSar) || !(specialPrice < top5TargetPrice - 0.005)) {
    return {
      available: false,
      reason: 'derived_special_price_not_below_top5_target',
      productUnitCostSar: cost.productUnitCostSar,
      top5TargetPrice,
      top5TargetSource,
      top5Margin,
      specialMargin,
      specialPrice,
      floorMargin,
      marginDelta,
    };
  }
  return {
    available: true,
    reason: 'top5_margin_minus_2_points',
    productUnitCostSar: cost.productUnitCostSar,
    storageUnitCostSar: cost.storageUnitCostSar,
    top5TargetPrice,
    top5TargetSource,
    top5Margin,
    specialMargin,
    specialPrice,
    floorMargin,
    marginDelta,
    top5RowCount: explicitTopRows.length,
    top5Samples: explicitTopRows.slice(0, 8),
    calculation: `ceil2(${cost.productUnitCostSar} / (1 - ${specialMargin}))`,
  };
}

export function buildHighClickLowConversionSpecialAudit({
  linksDataDoc,
  inventoryTrendDoc,
  priceOverridesDoc,
  costDoc,
  manualRegistry,
  marketingPolicy = {},
  reportDate,
  now = new Date(),
  sourceLinksData = '',
  sourceLinksDataStatus = 'ok',
  sourcePriceOverrides = '',
  sourceCostMap = '',
  sourceInventoryTrend = '',
} = {}) {
  const policy = getHighClickSpecialPolicy(marketingPolicy);
  const base = {
    enabled: policy.enabled !== false,
    criteria: policy.criteria,
    pricingRule: policy.pricing,
    executionPolicy: policy.execution,
    activityStock: positiveInt(policy?.limitedDiscount?.activityStock, 10),
    durationDays: positiveInt(policy?.limitedDiscount?.durationDays, 7),
    sourceLinksData,
    sourceLinksDataStatus,
    sourcePriceOverrides,
    sourceCostMap,
    sourceInventoryTrend,
    qualifyingCount: 0,
    actionCount: 0,
    protectedCount: 0,
    blockedCount: 0,
    pendingApprovalCount: 0,
    rows: [],
    protectedRows: [],
    blockedRows: [],
    pendingApprovalRows: [],
  };
  if (!base.enabled) return base;
  if (sourceLinksDataStatus !== 'ok') {
    base.blockedRows.push({
      status: 'links_data_source_not_fresh',
      sourceLinksData,
      sourceLinksDataStatus,
      reason: 'fresh_7d_metrics_are_required_before_automatic_enrollment',
    });
    base.blockedCount = 1;
    return base;
  }
  const index = buildManualLimitedDiscountIndex(manualRegistry || {entries: []}, now);
  const lowEtContext = buildLowEtFastSellerPricingContext({
    inventoryTrendDoc,
    linksDataDoc,
    baselineDoc: priceOverridesDoc,
    costDoc,
    marketingPolicy,
    reportDate,
  });
  base.lowEtFastSellerPricePullback = {
    evidenceHash: lowEtContext.evidenceHash,
    blockerCount: lowEtContext.blockers.length,
    blockers: lowEtContext.blockers,
  };
  const validFrom = formatShanghaiDateTime(now);
  const validTo = endOfFutureShanghaiDate(reportDate || validFrom.slice(0, 10), base.durationDays);
  for (const row of uniqueLinkRows(linksDataDoc)) {
    const evaluation = evaluateHighClickLowConversionRow(row, policy);
    if (!evaluation.qualifies) continue;
    const storeKey = normalizeStoreKey(row?.store_key || row?.storeKey || row?.store);
    const skc = String(row?.skc || row?.SKC || '').trim();
    const canonical = String(
      row?.standard_goods_sn
      || row?.standardGoodsSn
      || row?.product_display_name
      || row?.raw_goods_sn
      || '',
    ).trim();
    if (!storeKey || !skc || !canonical) continue;
    base.qualifyingCount += 1;
    const key = manualLimitedDiscountKey(storeKey, skc);
    const active = index.activeByKey.get(key) || null;
    const previous = index.allByKey.get(key) || null;
    const common = {
      storeKey,
      skc,
      canonical,
      productName: row?.product_display_name || row?.category4_name || canonical,
      metrics: evaluation.metrics,
      qualificationReason: evaluation.reason,
      qualificationRoutes: evaluation.qualificationRoutes || [],
      activityStock: base.activityStock,
      validFrom,
      validTo,
      currentActivityLabel: row?.activity_label || '',
    };
    if (active) {
      base.protectedRows.push({
        ...common,
        status: 'already_protected_by_active_manual_special',
        currentSpecialPrice: active.specialPrice,
        currentValidTo: active.validTo,
        currentActivityId: active.currentActivityId,
        currentReason: active.reason,
      });
      continue;
    }
    const pricing = deriveHighClickSpecialPricing({
      canonical,
      priceOverridesDoc,
      costDoc,
      marketingPolicy,
      highClickPolicy: policy,
    });
    if (!pricing.available) {
      base.blockedRows.push({...common, status: 'pricing_blocked', pricing});
      continue;
    }
    const lowEtDecision = applyLowEtFastSellerPricePullback({
      row: {
        ...common,
        targetPrice: pricing.specialPrice,
        finalTargetPrice: pricing.specialPrice,
        limitedDiscountPrice: pricing.specialPrice,
        productUnitCostSar: pricing.productUnitCostSar,
        ordinaryTargetMargin: pricing.top5Margin,
      },
      context: lowEtContext,
      costDoc,
    });
    if (lowEtDecision.blocked) {
      base.blockedRows.push({
        ...common,
        status: 'low_et_fast_seller_pricing_blocked',
        pricing,
        lowEtFastSellerPricePullback: {
          reason: lowEtDecision.reason,
          evidence: lowEtDecision.evidence || null,
        },
      });
      continue;
    }
    const readyRow = {
      ...common,
      status: 'ready_for_protected_special_discount',
      pricing,
      specialPrice: lowEtDecision.applied ? lowEtDecision.row.finalTargetPrice : pricing.specialPrice,
      lowEtFastSellerPricePullback: lowEtDecision.audit || {
        applied: false,
        reason: lowEtDecision.reason,
        contextEvidenceHash: lowEtContext.evidenceHash,
      },
      replacesExpiredRegistryEntry: Boolean(previous),
      previousRegistryEntry: previous ? {
        specialPrice: previous.specialPrice,
        validFrom: previous.validFrom,
        validTo: previous.validTo,
        currentActivityId: previous.currentActivityId,
        reason: previous.reason,
      } : null,
      action: 'register_then_restore_exact_high_click_special',
    };
    const cartOnlyPendingApproval = readyRow.qualificationRoutes.includes('cart_visitors')
      && !readyRow.qualificationRoutes.includes('click_rate')
      && policy?.execution?.cartVisitorRouteAutoExecute !== true;
    if (cartOnlyPendingApproval) {
      base.pendingApprovalRows.push({
        ...readyRow,
        status: 'pending_initial_user_confirmation',
        action: 'await_user_confirmation_before_first_cart_visitor_batch',
        approvalStatus: policy?.execution?.cartVisitorRouteApprovalStatus || 'pending_initial_user_confirmation',
      });
    } else {
      base.rows.push(readyRow);
    }
  }
  base.rows.sort(compareAuditRows);
  base.protectedRows.sort(compareAuditRows);
  base.blockedRows.sort(compareAuditRows);
  base.pendingApprovalRows.sort(compareAuditRows);
  base.actionCount = base.rows.length;
  base.protectedCount = base.protectedRows.length;
  base.blockedCount = base.blockedRows.length;
  base.pendingApprovalCount = base.pendingApprovalRows.length;
  return base;
}

export function revalidateHighClickSpecialCandidate(candidate, linkRow, policy) {
  const evaluation = evaluateHighClickLowConversionRow(linkRow, policy);
  const sameIdentity = normalizeStoreKey(linkRow?.store_key || linkRow?.storeKey || linkRow?.store) === normalizeStoreKey(candidate?.storeKey)
    && String(linkRow?.skc || linkRow?.SKC || '').trim() === String(candidate?.skc || '').trim();
  return {
    ok: sameIdentity && evaluation.qualifies,
    sameIdentity,
    evaluation,
    reason: !sameIdentity ? 'store_skc_identity_mismatch' : evaluation.reason,
  };
}

export function isHighClickSpecialEntry(entry) {
  const text = [
    entry?.reason,
    entry?.sourceArtifact,
    entry?.automationRule,
  ].filter(Boolean).join(' ');
  return /high[_\s-]*click|高点击|低转化/i.test(text);
}

export function buildHighClickSpecialEffectAudit({
  linksDataDoc,
  manualRegistry,
  experimentLedger = null,
  root = process.cwd(),
  now = new Date(),
  policy = DEFAULT_HIGH_CLICK_SPECIAL_POLICY,
} = {}) {
  const rowsByKey = new Map(uniqueLinkRows(linksDataDoc).map(row => [
    manualLimitedDiscountKey(row?.store_key || row?.storeKey || row?.store, row?.skc || row?.SKC),
    row,
  ]));
  const lookbackDays = positiveInt(policy?.effectReview?.lookbackDays, 30);
  const cutoff = now.getTime() - lookbackDays * 24 * 60 * 60 * 1000;
  const combined = new Map();
  for (const entry of manualRegistry?.entries || []) {
    if (!isHighClickSpecialEntry(entry)) continue;
    const id = `${manualLimitedDiscountKey(entry.storeKey, entry.skc)}::${entry.validFrom || ''}`;
    combined.set(id, {entry, ledgerRecord: null});
  }
  for (const record of experimentLedger?.experiments || []) {
    const entry = {
      storeKey: record.storeKey,
      skc: record.skc,
      canonical: record.canonical,
      specialPrice: record.specialPrice,
      activityStock: record.activityStock,
      validFrom: record.validFrom,
      validTo: record.validTo,
      currentActivityId: record.currentActivityId,
      reason: 'automated_high_click_zero_sales_top5_minus_2_margin_points',
      sourceArtifact: record.sourcePlan,
      status: record.ok === false ? 'active' : 'completed',
    };
    const id = `${manualLimitedDiscountKey(entry.storeKey, entry.skc)}::${entry.validFrom || ''}`;
    const previous = combined.get(id);
    combined.set(id, {entry: previous?.entry || entry, ledgerRecord: record});
  }
  const rows = [];
  for (const {entry, ledgerRecord} of combined.values()) {
    const validTo = parseShanghaiDateTime(entry.validTo);
    if (validTo && validTo.getTime() < cutoff) continue;
    const key = manualLimitedDiscountKey(entry.storeKey, entry.skc);
    const current = highClickSpecialMetricSnapshot(rowsByKey.get(key));
    const artifactBaseline = readHighClickBaselineFromArtifact(root, entry);
    const ledgerBaseline = normalizeBaselineSnapshot(ledgerRecord?.baseline, ledgerRecord?.updatedAt, ledgerRecord?.sourcePlan);
    const baseline = ledgerBaseline.complete ? ledgerBaseline : artifactBaseline;
    const validFrom = parseShanghaiDateTime(entry.validFrom);
    const windowStatus = !validFrom || !validTo
      ? 'invalid_window'
      : now.getTime() < validFrom.getTime()
        ? 'pending'
        : now.getTime() <= validTo.getTime() ? 'active' : 'ended';
    const salesDelta = baseline.c7SaleCount !== null && current.c7SaleCount !== null
      ? current.c7SaleCount - baseline.c7SaleCount
      : null;
    const converted = current.c7SaleCount !== null && current.c7SaleCount > 0;
    const effectStatus = converted
      ? 'converted'
      : current.complete !== true
        ? 'missing_current_metrics'
      : windowStatus === 'active'
        ? 'observing_no_sale_yet'
        : windowStatus === 'ended' ? 'ended_without_sale' : 'pending';
    rows.push({
      storeKey: normalizeStoreKey(entry.storeKey),
      skc: String(entry.skc || '').trim(),
      canonical: entry.canonical || '',
      specialPrice: numberOrNull(entry.specialPrice),
      activityStock: Number(entry.activityStock || 0),
      validFrom: entry.validFrom,
      validTo: entry.validTo,
      currentActivityId: entry.currentActivityId || null,
      windowStatus,
      baseline,
      current,
      deltas: {
        c7Exposure: delta(current.c7Exposure, baseline.c7Exposure),
        c7CartVisitors: delta(current.c7CartVisitors, baseline.c7CartVisitors),
        c7ClickRate: delta(current.c7ClickRate, baseline.c7ClickRate, 4),
        c7SaleCount: salesDelta,
      },
      effectStatus,
      directionalOnly: true,
      judgment: effectStatus === 'converted'
        ? 'special_window_has_rolling_7d_sales'
        : effectStatus === 'missing_current_metrics'
          ? 'refresh_current_7d_metrics_before_effect_judgment'
        : effectStatus === 'observing_no_sale_yet'
          ? 'continue_observation_until_valid_to'
          : effectStatus === 'ended_without_sale'
            ? 'no_sale_observed_in_latest_rolling_7d_snapshot'
            : 'not_started',
      sourceArtifact: entry.sourceArtifact || '',
      experimentId: ledgerRecord?.experimentId || null,
      executionStatus: ledgerRecord?.status || null,
    });
  }
  rows.sort((a, b) => String(b.validFrom || '').localeCompare(String(a.validFrom || '')) || compareAuditRows(a, b));
  return {
    enabled: policy?.effectReview?.enabled !== false,
    method: 'rolling_7d_directional_comparison_not_causal_attribution',
    total: rows.length,
    activeCount: rows.filter(row => row.windowStatus === 'active').length,
    convertedCount: rows.filter(row => row.effectStatus === 'converted').length,
    observingNoSaleCount: rows.filter(row => row.effectStatus === 'observing_no_sale_yet').length,
    endedWithoutSaleCount: rows.filter(row => row.effectStatus === 'ended_without_sale').length,
    missingBaselineCount: rows.filter(row => row.baseline.complete !== true).length,
    missingCurrentMetricsCount: rows.filter(row => row.effectStatus === 'missing_current_metrics').length,
    rows,
  };
}

export function uniqueLinkRows(linksDataDoc) {
  const data = unwrapBiLinksData(linksDataDoc);
  const candidates = [
    ...(Array.isArray(data.storeLinks) ? data.storeLinks : []),
    ...(Array.isArray(data.links) ? data.links : []),
  ];
  const byKey = new Map();
  for (const row of candidates) {
    const storeKey = normalizeStoreKey(row?.store_key || row?.storeKey || row?.store);
    const skc = String(row?.skc || row?.SKC || '').trim();
    if (!storeKey || !skc) continue;
    const key = manualLimitedDiscountKey(storeKey, skc);
    const previous = byKey.get(key);
    if (!previous || linkRowEvidenceScore(row) >= linkRowEvidenceScore(previous)) byKey.set(key, row);
  }
  return [...byKey.values()];
}

function readHighClickBaselineFromArtifact(root, entry) {
  const empty = {
    capturedAt: '',
    c7Exposure: null,
    c7Clicks: null,
    c7CartVisitors: null,
    c7ClickRate: null,
    c7SaleCount: null,
    complete: false,
    source: entry?.sourceArtifact || '',
  };
  const source = String(entry?.sourceArtifact || '').trim();
  if (!source) return empty;
  const file = path.resolve(root, source);
  const relative = path.relative(path.resolve(root), file);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(file)) return empty;
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return empty;
  }
  const candidates = [
    ...(Array.isArray(doc?.rows) ? doc.rows : []),
    ...(Array.isArray(doc?.candidates) ? doc.candidates : []),
    ...(Array.isArray(doc?.actionRows) ? doc.actionRows : []),
    ...(doc?.storeKey && doc?.skc ? [doc] : []),
  ];
  const found = candidates.find(row => (
    normalizeStoreKey(row?.storeKey || row?.store) === normalizeStoreKey(entry?.storeKey)
    && String(row?.skc || '').trim() === String(entry?.skc || '').trim()
  ));
  if (!found) return empty;
  const metrics = found.metrics || found.baseline || found.traffic || found;
  const c7Exposure = numberOrNull(metrics?.c7Exposure ?? metrics?.c7_eps_uv);
  const c7Clicks = numberOrNull(metrics?.c7Clicks ?? metrics?.c7_goods_uv);
  const c7CartVisitors = numberOrNull(metrics?.c7CartVisitors ?? metrics?.c7_cart_uv);
  const c7ClickRate = numberOrNull(metrics?.c7ClickRate ?? metrics?.c7_click_rate);
  const c7SaleCount = numberOrNull(metrics?.c7SaleCount ?? metrics?.c7_sale_cnt)
    ?? (doc?.trafficWindow?.filters?.saleCount !== undefined
      ? numberOrNull(doc.trafficWindow.filters.saleCount)
      : null);
  return {
    capturedAt: found?.baselineCapturedAt || doc?.createdAt || doc?.validFrom || '',
    c7Exposure,
    c7Clicks,
    c7CartVisitors,
    c7ClickRate,
    c7SaleCount,
    complete: c7Exposure !== null
      && c7SaleCount !== null
      && (c7ClickRate !== null || c7CartVisitors !== null),
    source,
  };
}

function normalizeBaselineSnapshot(value, capturedAt = '', source = '') {
  const metrics = value || {};
  const c7Exposure = numberOrNull(metrics?.c7Exposure ?? metrics?.c7_eps_uv);
  const c7Clicks = numberOrNull(metrics?.c7Clicks ?? metrics?.c7_goods_uv);
  const c7CartVisitors = numberOrNull(metrics?.c7CartVisitors ?? metrics?.c7_cart_uv);
  const c7ClickRate = numberOrNull(metrics?.c7ClickRate ?? metrics?.c7_click_rate);
  const c7SaleCount = numberOrNull(metrics?.c7SaleCount ?? metrics?.c7_sale_cnt);
  return {
    capturedAt: String(capturedAt || ''),
    c7Exposure,
    c7Clicks,
    c7CartVisitors,
    c7ClickRate,
    c7SaleCount,
    complete: c7Exposure !== null
      && c7SaleCount !== null
      && (c7ClickRate !== null || c7CartVisitors !== null),
    source: String(source || ''),
  };
}

function canonicalFromPlanRow(row) {
  return String(
    row?.canonical
    || row?.standard_goods_sn
    || row?.standardGoodsSn
    || row?.['标准货号']
    || row?.supplierNo
    || '',
  ).trim();
}

function canonicalKey(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[()（）【】\[\]_:：/\\-]/g, '')
    .toUpperCase();
}

function representativePrice(values) {
  const nums = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return null;
  return round2(nums[Math.floor((nums.length - 1) / 2)]);
}

function endOfFutureShanghaiDate(reportDate, durationDays) {
  const match = String(reportDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return '';
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + durationDays));
  return `${date.toISOString().slice(0, 10)} 23:59:59`;
}

function isOnShelf(row) {
  const explicit = row?.is_on_shelf ?? row?.isOnShelf;
  const explicitlyOnShelf = explicit === true
    || explicit === 1
    || explicit === '1'
    || String(explicit || '').toLowerCase() === 'true';
  const explicitlyOffShelf = explicit === false
    || explicit === 0
    || explicit === '0'
    || String(explicit || '').toLowerCase() === 'false'
    || row?.is_out_shelf === true
    || row?.is_out_shelf === 1
    || row?.is_out_shelf === '1';
  const status = String(
    row?.shelf_status_name
    || row?.shelfStatusName
    || row?.visible_shelf_statuses
    || '',
  );
  if (explicitlyOffShelf || /下架|售罄|SOLD_OUT|OUT_SHELF/i.test(status)) return false;
  return explicitlyOnShelf || /已上架|在售|ON_SHELF/i.test(status);
}

function linkRowEvidenceScore(row) {
  const metrics = highClickSpecialMetricSnapshot(row);
  return (metrics.complete ? 100 : 0)
    + (row?.is_on_shelf === true ? 10 : 0)
    + (numberOrNull(row?.c7_eps_uv) !== null ? 1 : 0);
}

function compareAuditRows(a, b) {
  const exposureDiff = Number(b?.metrics?.c7Exposure || 0) - Number(a?.metrics?.c7Exposure || 0);
  if (exposureDiff) return exposureDiff;
  return `${a?.storeKey || ''}::${a?.skc || ''}`.localeCompare(`${b?.storeKey || ''}::${b?.skc || ''}`);
}

function delta(current, baseline, digits = 2) {
  if (current === null || baseline === null) return null;
  const factor = 10 ** digits;
  return Math.round((Number(current) - Number(baseline)) * factor) / factor;
}

function normalizeStoreKey(value) {
  return String(value || '').trim().toUpperCase();
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(String(value).replace(/[%SAR,\s]/g, ''));
  return Number.isFinite(number) ? number : null;
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function round4(value) {
  return Math.round((Number(value) + Number.EPSILON) * 10_000) / 10_000;
}
