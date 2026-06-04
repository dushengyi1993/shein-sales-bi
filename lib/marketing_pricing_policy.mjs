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
    metricFields: ['c30_eps_uv', 'c7_eps_uv', 'eps_uv'],
    onShelfOnly: true,
    marginDeltaPct: 5,
    floorMarginPct: 15,
    whenBaseAtOrBelowFloor: 'keep_top_at_floor_raise_others_by_delta',
    whenBaseAboveFloor: 'lower_top_links_by_delta',
    fixedPricePolicy: 'do_not_override_fixed_price_or_row_override',
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
    topByCanonical: new Map(),
    rowsByCanonical: new Map(),
  };
  if (!enabled || !bi || typeof bi !== 'object') return empty;

  const candidates = [
    ...(Array.isArray(bi.storeLinks) ? bi.storeLinks : []),
    ...(Array.isArray(bi.links) ? bi.links : []),
  ];
  const byCanonical = new Map();
  for (const row of candidates) {
    const skc = String(row?.skc || '').trim();
    if (!skc) continue;
    if (cfg.onShelfOnly !== false && isExplicitlyOffShelf(row)) continue;
    const canonical = canonicalFromLinkRow(row);
    if (!canonical) continue;
    const score = exposureScore(row, metricFields);
    if (score === null) continue;
    const entry = {
      skc,
      canonical,
      storeKey: row.store_key || row.storeKey || '',
      productName: row.product_display_name || row.product_name_cn || row.skc_label || '',
      score,
      metricValues: Object.fromEntries(metricFields.map(field => [field, numberOrNull(row[field])])),
      linkDate: row.link_date || '',
      source: Array.isArray(bi.storeLinks) && bi.storeLinks.includes(row) ? 'storeLinks' : 'links',
    };
    if (!byCanonical.has(canonical)) byCanonical.set(canonical, new Map());
    const bySkc = byCanonical.get(canonical);
    const previous = bySkc.get(skc);
    if (!previous || compareExposureEntry(entry, previous) < 0) {
      bySkc.set(skc, entry);
    }
  }

  const rowsByCanonical = new Map();
  const topByCanonical = new Map();
  for (const [canonical, bySkc] of byCanonical.entries()) {
    const rows = [...bySkc.values()].sort(compareExposureEntry);
    rows.forEach((row, idx) => {
      row.rank = idx + 1;
      row.isTopExposureLink = idx < topN;
    });
    rowsByCanonical.set(canonicalKey(canonical), rows);
    topByCanonical.set(canonicalKey(canonical), new Set(rows.slice(0, topN).map(row => row.skc)));
  }
  return {
    enabled,
    topN,
    metricFields,
    rowCount: candidates.length,
    topByCanonical,
    rowsByCanonical,
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
  const rank = exposureRankInfo(exposureIndex, canonical, skc);
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

export function exposureRankInfo(exposureIndex, canonical, skc) {
  const key = canonicalKey(canonical);
  const rows = exposureIndex?.rowsByCanonical?.get(key) || [];
  if (!rows.length) {
    return {hasExposureData: false, hasSkcExposureData: false, isTopExposureLink: false, rank: null, topN: exposureIndex?.topN || null};
  }
  const found = rows.find(row => row.skc === String(skc || '').trim()) || null;
  return {
    hasExposureData: true,
    hasSkcExposureData: !!found,
    isTopExposureLink: Boolean(found?.isTopExposureLink),
    rank: found?.rank || null,
    topN: exposureIndex?.topN || null,
    score: found?.score ?? null,
    metricValues: found?.metricValues || null,
  };
}

export function exposureTopRowsForCanonical(exposureIndex, canonical) {
  const rows = exposureIndex?.rowsByCanonical?.get(canonicalKey(canonical)) || [];
  const topN = exposureIndex?.topN || 5;
  return rows.slice(0, topN);
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
  for (const key of ['limitedDiscount', 'exposureTopLinks']) {
    out[key] = {...(base?.[key] || {}), ...(override?.[key] || {})};
  }
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

function isExplicitlyOffShelf(row) {
  if (row?.is_on_shelf === false || row?.is_on_shelf === 0 || row?.is_on_shelf === '0') return true;
  const status = String(row?.shelf_status_name || '').trim();
  return /下架|已售罄|售罄/.test(status);
}

function exposureScore(row, fields) {
  const values = fields.map(field => numberOrNull(row?.[field]));
  const positive = values.find(value => value !== null && value > 0);
  if (positive !== undefined) return positive;
  return null;
}

function compareExposureEntry(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const ac7 = Number(a.metricValues?.c7_eps_uv || 0);
  const bc7 = Number(b.metricValues?.c7_eps_uv || 0);
  if (bc7 !== ac7) return bc7 - ac7;
  const ae = Number(a.metricValues?.eps_uv || 0);
  const be = Number(b.metricValues?.eps_uv || 0);
  if (be !== ae) return be - ae;
  return String(a.skc).localeCompare(String(b.skc));
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

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}
