import fs from 'node:fs/promises';
import {normalizeGoodsSnDetailed} from './product_sku_normalizer.mjs';

export const DEFAULT_MARKETING_PRICING_POLICY = Object.freeze({
  targetFloorMarginPct: 15,
  limitedDiscount: {
    mustExistForPlannedLinks: true,
    defaultDiscountRatePct: 15,
    defaultPriceFactor: 0.85,
    oldLimitedDiscountCanBeCancelledAndRecreated: true,
    mustNotInterfereTargetPrice: true,
    adjustWhenInterferes: true,
  },
  exposureTopLinks: {
    enabled: true,
    topN: 5,
    metricFields: ['c7_eps_uv', 'c7EpsUv', 'c30_eps_uv', 'c30EpsUv', 'eps_uv', 'epsUv'],
    groupScope: 'global_standard_goods_sn',
    onShelfOnly: true,
    marginDeltaPct: 5,
    floorMarginPct: 15,
    whenBaseAtOrBelowFloor: 'keep_top_at_floor_raise_others_by_delta',
    whenBaseAboveFloor: 'lower_top_links_by_delta',
    fixedPricePolicy: 'do_not_override_fixed_price_or_row_override',
  },
  newListingWithin7Days: {
    enabled: true,
    windowDays: 7,
    onShelfOnly: true,
    requireNoOrdinaryMarketing: true,
    pricingTreatment: 'same_as_global_exposure_top5',
    limitedDiscount: {
      autoFallbackWhenNoOrdinaryMarketing: true,
      durationDays: 7,
      replaceExistingLimitedDiscountWhenNotTopTier: true,
      activityNamePrefix: '新上架7天高曝光兜底限时折扣',
    },
    ordinaryMarketing: {
      applyTopTreatmentForFirstNewListingSignup: true,
      activityNamePatterns: ['New Arrivals', '新品', '超级新品'],
    },
  },
});

export async function readJsonIfExists(file, fallback = null) {
  try {
    const text = await fs.readFile(file, 'utf8');
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function loadMarketingPricingPolicy(file) {
  const configured = file ? await readJsonIfExists(file, {}) : {};
  return mergePolicy(DEFAULT_MARKETING_PRICING_POLICY, configured || {});
}

export function buildExposureTopLinkIndex(bi, policy = DEFAULT_MARKETING_PRICING_POLICY) {
  const cfg = policy?.exposureTopLinks || {};
  const enabled = cfg.enabled !== false;
  const topN = positiveInt(cfg.topN, 5);
  const metricFields = Array.isArray(cfg.metricFields) && cfg.metricFields.length
    ? cfg.metricFields
    : DEFAULT_MARKETING_PRICING_POLICY.exposureTopLinks.metricFields;
  const empty = {
    enabled,
    topN,
    metricFields,
    rowCount: 0,
    topByGroup: new Map(),
    rowsByGroup: new Map(),
    // Backward-compatible aliases. Callers may still pass storeKey, but the
    // effective business rule is global canonical standard goods sn.
    topByCanonical: new Map(),
    rowsByCanonical: new Map(),
    metricFieldByGroup: new Map(),
    metricLabelByGroup: new Map(),
  };
  if (!enabled || !bi || typeof bi !== 'object') return empty;

  const biData = unwrapBiLinksData(bi);
  const candidates = [
    ...(Array.isArray(biData.storeLinks) ? biData.storeLinks : []),
    ...(Array.isArray(biData.links) ? biData.links : []),
  ];
  const byGroup = new Map();
  for (const row of candidates) {
    const skc = String(row?.skc || '').trim();
    if (!skc) continue;
    if (cfg.onShelfOnly !== false && isExplicitlyOffShelf(row)) continue;
    const canonical = canonicalFromLinkRow(row);
    if (!canonical) continue;
    const storeKey = normalizeStoreKey(row?.store_key || row?.storeKey || row?.store || '');
    const metricValues = Object.fromEntries(metricFields.map(field => [field, numberOrNull(fieldValue(row, field))]));
    if (!hasAnyPositiveMetric(metricValues)) continue;
    const entry = {
      skc,
      canonical,
      storeKey,
      productName: row.product_display_name || row.product_name_cn || row.skc_label || '',
      score: null,
      metricValues,
      linkDate: row.link_date || '',
      linkKey: exposureLinkKey(storeKey, skc),
      source: Array.isArray(biData.storeLinks) && biData.storeLinks.includes(row) ? 'storeLinks' : 'links',
    };
    const group = exposureGroupKey(canonical);
    if (!byGroup.has(group)) byGroup.set(group, new Map());
    const bySkc = byGroup.get(group);
    const previous = bySkc.get(entry.linkKey);
    if (!previous || compareExposureEntry(entry, previous) < 0) {
      bySkc.set(entry.linkKey, entry);
    }
  }

  const rowsByGroup = new Map();
  const topByGroup = new Map();
  const metricFieldByGroup = new Map();
  const metricLabelByGroup = new Map();
  for (const [group, bySkc] of byGroup.entries()) {
    const groupRows = [...bySkc.values()];
    const metricField = selectRankingMetricField(groupRows, metricFields);
    if (!metricField) continue;
    const rows = groupRows
      .map(row => ({
        ...row,
        score: positiveMetricValue(row.metricValues, metricField),
        rankMetricField: metricField,
        rankMetricLabel: exposureMetricLabel(metricField),
      }))
      .filter(row => row.score !== null && row.score > 0)
      .sort(compareExposureEntry);
    if (!rows.length) continue;
    rows.forEach((row, idx) => {
      row.rank = idx + 1;
      row.isTopExposureLink = idx < topN;
    });
    rowsByGroup.set(group, rows);
    topByGroup.set(group, new Set(rows.slice(0, topN).map(row => row.linkKey)));
    metricFieldByGroup.set(group, metricField);
    metricLabelByGroup.set(group, exposureMetricLabel(metricField));
  }
  return {
    enabled,
    topN,
    metricFields,
    rowCount: candidates.length,
    groupScope: cfg.groupScope || DEFAULT_MARKETING_PRICING_POLICY.exposureTopLinks.groupScope,
    topByGroup,
    rowsByGroup,
    topByCanonical: topByGroup,
    rowsByCanonical: rowsByGroup,
    metricFieldByGroup,
    metricLabelByGroup,
  };
}

export function marginTargetsForExposurePolicy(baseMargin, policy = DEFAULT_MARKETING_PRICING_POLICY) {
  const cfg = policy?.exposureTopLinks || {};
  const base = Number(baseMargin);
  if (!Number.isFinite(base) || base <= 0) {
    return {applies: false, reason: 'invalid_base_margin', baseMargin: null};
  }
  const floorMargin = pctConfigToRatio(cfg.floorMarginPct ?? policy?.targetFloorMarginPct ?? 15);
  const delta = pctConfigToRatio(cfg.marginDeltaPct ?? 5);
  if (base <= floorMargin + 1e-9) {
    return {
      applies: true,
      mode: 'base_at_or_below_floor_raise_others',
      baseMargin: base,
      topMargin: floorMargin,
      otherMargin: floorMargin + delta,
      floorMargin,
      delta,
    };
  }
  return {
    applies: true,
    mode: 'base_above_floor_lower_top',
    baseMargin: base,
    topMargin: Math.max(floorMargin, base - delta),
    otherMargin: base,
    floorMargin,
    delta,
  };
}

export function resolveExposureAdjustedMargin({
  baseMargin,
  storeKey,
  canonical,
  skc,
  policy = DEFAULT_MARKETING_PRICING_POLICY,
  exposureIndex,
} = {}) {
  const cfg = policy?.exposureTopLinks || {};
  if (cfg.enabled === false) {
    return {enabled: false, applied: false, margin: baseMargin, reason: 'disabled'};
  }
  const targets = marginTargetsForExposurePolicy(baseMargin, policy);
  if (!targets.applies) {
    return {enabled: true, applied: false, margin: baseMargin, reason: targets.reason, targets};
  }
  const rank = exposureRankInfo(exposureIndex, canonical, skc, storeKey);
  if (!rank.hasExposureData) {
    return {
      enabled: true,
      applied: false,
      margin: baseMargin,
      reason: 'exposure_data_unavailable',
      targets,
      rank,
    };
  }
  const isTop = rank.isTopExposureLink;
  const margin = isTop ? targets.topMargin : targets.otherMargin;
  return {
    enabled: true,
    applied: true,
    reason: isTop ? 'top_exposure_link' : (rank.hasSkcExposureData ? 'non_top_exposure_link' : 'skc_not_in_exposure_rank'),
    margin,
    isTopExposureLink: isTop,
    targets,
    rank,
  };
}

export function exposureRankInfo(exposureIndex, canonical, skc, storeKey = '') {
  const group = exposureGroupKey(canonical);
  const rows = exposureIndex?.rowsByGroup?.get(group)
    || exposureIndex?.rowsByCanonical?.get(group)
    || [];
  if (!rows.length) {
    return {
      hasExposureData: false,
      hasSkcExposureData: false,
      isTopExposureLink: false,
      rank: null,
      topN: exposureIndex?.topN || null,
      storeKey: normalizeStoreKey(storeKey),
    };
  }
  const requestedSkc = String(skc || '').trim();
  const requestedStoreKey = normalizeStoreKey(storeKey);
  const found = rows.find(row => {
    if (row.skc !== requestedSkc) return false;
    return requestedStoreKey ? row.storeKey === requestedStoreKey : true;
  }) || null;
  return {
    hasExposureData: true,
    hasSkcExposureData: !!found,
    isTopExposureLink: Boolean(found?.isTopExposureLink),
    rank: found?.rank || null,
    topN: exposureIndex?.topN || null,
    storeKey: normalizeStoreKey(storeKey),
    score: found?.score ?? null,
    metricValues: found?.metricValues || null,
    rankMetricField: found?.rankMetricField || exposureIndex?.metricFieldByGroup?.get(group) || null,
    rankMetricLabel: found?.rankMetricLabel || exposureIndex?.metricLabelByGroup?.get(group) || null,
  };
}

export function exposureTopRowsForCanonical(exposureIndex, canonical, storeKey = '') {
  const rows = exposureIndex?.rowsByGroup?.get(exposureGroupKey(canonical))
    || exposureIndex?.rowsByCanonical?.get(exposureGroupKey(canonical))
    || [];
  const topN = exposureIndex?.topN || 5;
  return rows.slice(0, topN);
}

export function unwrapBiLinksData(bi) {
  if (!bi || typeof bi !== 'object') return {};
  const data = bi.data && typeof bi.data === 'object' ? bi.data : bi;
  return {
    ...data,
    generatedAt: data.generatedAt || bi.generatedAt || '',
    dates: data.dates || bi.dates || {},
  };
}

export function buildLinkRowIndexFromBi(bi) {
  const data = unwrapBiLinksData(bi);
  const rows = [
    ...(Array.isArray(data.storeLinks) ? data.storeLinks : []),
    ...(Array.isArray(data.links) ? data.links : []),
  ];
  const byLinkKey = new Map();
  for (const row of rows) {
    const storeKey = normalizeStoreKey(row?.store_key || row?.storeKey || row?.store || '');
    const skc = String(row?.skc || row?.SKC || '').trim();
    if (!storeKey || !skc) continue;
    const key = exposureLinkKey(storeKey, skc);
    if (!byLinkKey.has(key)) byLinkKey.set(key, row);
  }
  return {rows, byLinkKey};
}

export function inferNewListingShelfAgeDays(link, reportDate = '') {
  const direct = numberOrNull(link?.shelf_age_days ?? link?.shelf_days);
  if (direct !== null) return {value: direct, source: 'shelf_age_days'};
  for (const field of ['first_shelf_time', 'firstShelfTime', 'created_time', 'createdTime', 'link_date']) {
    const value = link?.[field];
    const days = daysBetweenLocalDateLike(value, reportDate);
    if (days !== null && days >= 0) return {value: days, source: field};
  }
  return {value: null, source: 'missing'};
}

export function hasOrdinaryMarketingEvidence(link) {
  if (!link || typeof link !== 'object') return false;
  if (link.marketing_ordinary_price_is_current === true || link.marketing_ordinary_price_is_current === 1 || link.marketing_ordinary_price_is_current === '1') return true;
  if (numberOrNull(link.marketing_ordinary_price_sar) !== null) return true;
  const names = String(link.performance_activity_names || link.marketing_activity_names || link.activity_names || '').trim();
  if (!names) return false;
  const withoutNonOrdinary = names
    .replace(/#[^#]*(?:限时折扣|limited\s*discount|coupon|优惠券)[^#]*/gi, '')
    .trim();
  return /(New\s*Arrivals|新品|普通营销|普通活动|Regular\s*Campaign|Campaign|营销活动)/i.test(withoutNonOrdinary);
}

export function isRecentNewListingLink(link, policy = DEFAULT_MARKETING_PRICING_POLICY, reportDate = '') {
  const cfg = policy?.newListingWithin7Days || DEFAULT_MARKETING_PRICING_POLICY.newListingWithin7Days;
  if (cfg.enabled === false) return {applies: false, reason: 'disabled'};
  if (cfg.onShelfOnly !== false && isExplicitlyOffShelf(link)) return {applies: false, reason: 'off_shelf'};
  const age = inferNewListingShelfAgeDays(link, reportDate);
  const windowDays = positiveInt(cfg.windowDays, 7);
  if (age.value === null) return {applies: false, reason: 'missing_shelf_age', shelfAgeDays: null, shelfAgeSource: age.source, windowDays};
  if (age.value > windowDays) return {applies: false, reason: 'outside_window', shelfAgeDays: age.value, shelfAgeSource: age.source, windowDays};
  if (cfg.requireNoOrdinaryMarketing !== false && hasOrdinaryMarketingEvidence(link)) {
    return {applies: false, reason: 'ordinary_marketing_exists', shelfAgeDays: age.value, shelfAgeSource: age.source, windowDays};
  }
  return {applies: true, reason: 'recent_new_listing_no_ordinary_marketing', shelfAgeDays: age.value, shelfAgeSource: age.source, windowDays};
}

export function isNewListingOrdinaryMarketingActivity(row, policy = DEFAULT_MARKETING_PRICING_POLICY) {
  const cfg = policy?.newListingWithin7Days?.ordinaryMarketing || DEFAULT_MARKETING_PRICING_POLICY.newListingWithin7Days.ordinaryMarketing;
  if (cfg.applyTopTreatmentForFirstNewListingSignup === false) return false;
  const patterns = Array.isArray(cfg.activityNamePatterns) && cfg.activityNamePatterns.length
    ? cfg.activityNamePatterns
    : DEFAULT_MARKETING_PRICING_POLICY.newListingWithin7Days.ordinaryMarketing.activityNamePatterns;
  const haystack = [
    row?.['活动名称'],
    row?.activityName,
    row?._raw?.activity?.name,
    row?._raw?.activity?.label,
    row?._raw?.activityDetail?.activity_name,
    row?._raw?.activityDetail?.text_tag_content,
    row?._raw?.activityDetail?.activity_explain,
  ].filter(Boolean).join(' ');
  return patterns.some(pattern => new RegExp(escapeRegExp(pattern), 'i').test(haystack));
}

export function pctRatioText(value) {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  return Number.isFinite(n) ? `${round2(n * 100)}%` : '';
}

export function pctConfigToRatio(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n > 1 ? n / 100 : n;
}

function mergePolicy(base, override) {
  const out = {...base, ...override};
  for (const key of ['limitedDiscount', 'exposureTopLinks', 'newListingWithin7Days']) {
    out[key] = {...(base?.[key] || {}), ...(override?.[key] || {})};
  }
  out.newListingWithin7Days.limitedDiscount = {
    ...(base?.newListingWithin7Days?.limitedDiscount || {}),
    ...(override?.newListingWithin7Days?.limitedDiscount || {}),
  };
  out.newListingWithin7Days.ordinaryMarketing = {
    ...(base?.newListingWithin7Days?.ordinaryMarketing || {}),
    ...(override?.newListingWithin7Days?.ordinaryMarketing || {}),
  };
  return out;
}

function canonicalFromLinkRow(row) {
  const direct = String(row?.standard_goods_sn || row?.standardGoodsSn || '').trim();
  if (direct) return direct;
  const raw = row?.raw_goods_sn || row?.rawGoodsSn || row?.supplierNo || row?.sku_supplier_no || row?.skc_label || '';
  const title = row?.product_name_cn || row?.product_display_name || row?.goods_title || '';
  const normalized = normalizeGoodsSnDetailed(raw, {goodsTitle: title});
  return normalized.canonical || String(raw || '').trim();
}

function canonicalKey(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[()（）【】\[\]_:：/\\-]/g, '')
    .toUpperCase();
}

function exposureGroupKey(canonical) {
  return canonicalKey(canonical);
}

function exposureLinkKey(storeKey, skc) {
  const normalizedStore = normalizeStoreKey(storeKey);
  return `${normalizedStore}#${String(skc || '').trim()}`;
}

function normalizeStoreKey(value) {
  return String(value || '').trim().toUpperCase();
}

function isExplicitlyOffShelf(row) {
  if (row?.is_on_shelf === false || row?.is_on_shelf === 0 || row?.is_on_shelf === '0') return true;
  const status = String(row?.shelf_status_name || '').trim();
  return /下架|已售罄|售罄/.test(status);
}

function daysBetweenLocalDateLike(start, end) {
  if (!start || !end) return null;
  const startDate = parseDateLike(start);
  const endDate = parseDateLike(end);
  if (!startDate || !endDate) return null;
  return Math.floor((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));
}

function parseDateLike(value) {
  if (!value) return null;
  const text = String(value).trim();
  const m = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  return Number.isFinite(d.getTime()) ? d : null;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasAnyPositiveMetric(metricValues) {
  return Object.values(metricValues || {}).some(value => Number(value) > 0);
}

function selectRankingMetricField(rows, fields) {
  for (const field of fields) {
    if (rows.some(row => positiveMetricValue(row.metricValues, field) > 0)) {
      return field;
    }
  }
  return null;
}

function positiveMetricValue(metricValues, field) {
  const direct = numberOrNull(metricValues?.[field]);
  if (direct !== null && direct > 0) return direct;
  const camel = numberOrNull(metricValues?.[snakeToCamel(field)]);
  if (camel !== null && camel > 0) return camel;
  return null;
}

function exposureMetricLabel(field) {
  const normalized = String(field || '');
  if (/^c7/i.test(normalized)) return '7天曝光';
  if (/^c30/i.test(normalized)) return '30天曝光兜底';
  if (/eps/i.test(normalized)) return '总曝光兜底';
  if (/goods/i.test(normalized)) return '商品曝光兜底';
  return normalized || '曝光';
}

function compareExposureEntry(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const ac7 = Number(a.metricValues?.c7_eps_uv || a.metricValues?.c7EpsUv || 0);
  const bc7 = Number(b.metricValues?.c7_eps_uv || b.metricValues?.c7EpsUv || 0);
  if (bc7 !== ac7) return bc7 - ac7;
  const ae = Number(a.metricValues?.eps_uv || a.metricValues?.epsUv || 0);
  const be = Number(b.metricValues?.eps_uv || b.metricValues?.epsUv || 0);
  if (be !== ae) return be - ae;
  return String(a.skc).localeCompare(String(b.skc));
}

function fieldValue(row, field) {
  return row?.[field] ?? row?.[snakeToCamel(field)];
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/[%SAR,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function snakeToCamel(value) {
  return String(value || '').replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}
