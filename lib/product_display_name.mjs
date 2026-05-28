import {getCatalogConfig, normalizeGoodsSnDetailed} from './product_sku_normalizer.mjs';

const catalogConfig = getCatalogConfig();
const catalogStandards = [
  ...(catalogConfig.standards || []),
  ...(catalogConfig.extraConfirmedStandards || []),
].filter(Boolean);

function hasHan(value) {
  return /\p{Script=Han}/u.test(String(value || ''));
}

function cleanText(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function compactText(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, '').trim();
}

function modelCodeKey(value) {
  return compactText(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function splitLeadingModel(value) {
  const raw = compactText(value);
  const match = raw.match(/^([A-Za-z0-9][A-Za-z0-9_-]*)(.*)$/u);
  if (!match) return {code: '', rest: raw};
  return {code: match[1], rest: match[2] || ''};
}

function buildCatalogCodeIndex() {
  const byCode = new Map();
  for (const canonical of catalogStandards) {
    const split = splitLeadingModel(canonical);
    if (!split.code || !hasHan(split.rest)) continue;
    const key = modelCodeKey(split.code);
    if (!key) continue;
    if (!byCode.has(key)) byCode.set(key, []);
    byCode.get(key).push(canonical);
  }
  return byCode;
}

const catalogByCode = buildCatalogCodeIndex();
const catalogExact = new Map(catalogStandards.map(canonical => [compactText(canonical).toUpperCase(), canonical]));

function catalogDisplayByCode(value) {
  const split = splitLeadingModel(value);
  const key = modelCodeKey(split.code || value);
  if (!key) return '';
  const matches = catalogByCode.get(key) || [];
  return matches.length === 1 ? matches[0] : '';
}

function titleCandidates(row) {
  if (!row || typeof row !== 'object') return [];
  return [
    row.goods_title,
    row.product_name_cn,
    row.product_name,
    row.title,
    row.name,
  ].map(cleanText).filter(Boolean);
}

function chineseDescriptorFromTitle(title, sn) {
  const cleaned = compactText(title);
  if (!hasHan(cleaned)) return '';
  const snCode = modelCodeKey(splitLeadingModel(sn).code || sn);
  const titleSplit = splitLeadingModel(cleaned);
  const titleCode = modelCodeKey(titleSplit.code);
  if (snCode && titleCode && snCode === titleCode && hasHan(titleSplit.rest)) {
    return titleSplit.rest.replace(/^[：:：/\\|·,，;；._-]+/u, '').trim();
  }
  return cleaned.replace(/^[：:：/\\|·,，;；._-]+/u, '').trim();
}

function displayFromTitle(sn, row) {
  const snText = cleanText(sn);
  const compactSn = compactText(snText);
  const snKey = modelCodeKey(splitLeadingModel(snText).code || snText);
  for (const title of titleCandidates(row)) {
    const compactTitle = compactText(title);
    if (!hasHan(compactTitle)) continue;
    const exactCatalog = catalogExact.get(compactTitle.toUpperCase());
    if (exactCatalog) return exactCatalog;
    const titleSplit = splitLeadingModel(compactTitle);
    const titleKey = modelCodeKey(titleSplit.code);
    if (titleKey && snKey && titleKey === snKey && hasHan(titleSplit.rest)) {
      return `${compactSn}${titleSplit.rest}`;
    }
    const descriptor = chineseDescriptorFromTitle(title, snText);
    if (descriptor && hasHan(descriptor)) return `${compactSn}${descriptor}`;
  }
  return '';
}

function rowStandardGoodsSn(rowOrSn) {
  if (typeof rowOrSn === 'string' || typeof rowOrSn === 'number') return cleanText(rowOrSn);
  if (!rowOrSn || typeof rowOrSn !== 'object') return '';
  return cleanText(rowOrSn.standard_goods_sn || rowOrSn.goods_sn || '');
}

function chooseDisplay(candidate) {
  return cleanText(candidate) || '';
}

export function resolveProductDisplayName(rowOrSn) {
  const sn = rowStandardGoodsSn(rowOrSn);
  if (!sn) {
    const fallback = chooseDisplay(typeof rowOrSn === 'object' ? (rowOrSn?.product_display_name || rowOrSn?.product_name || rowOrSn?.goods_title) : rowOrSn);
    return {
      displayName: fallback || '-',
      source: fallback ? 'fallback' : 'empty',
      needsReview: !fallback || !hasHan(fallback),
    };
  }

  const context = typeof rowOrSn === 'object'
    ? {goodsTitle: rowOrSn.goods_title || rowOrSn.product_name || rowOrSn.product_name_cn || rowOrSn.title || ''}
    : {};
  const normalized = normalizeGoodsSnDetailed(sn, context);
  if (normalized?.canonicalInCatalog && hasHan(normalized.canonical)) {
    return {
      displayName: normalized.canonical,
      source: normalized.source || 'product_sku_normalizer',
      needsReview: false,
    };
  }

  const exactCatalog = catalogExact.get(compactText(sn).toUpperCase());
  if (exactCatalog) {
    return {displayName: exactCatalog, source: 'config/product_catalog.json:exact', needsReview: false};
  }

  const catalogByModel = catalogDisplayByCode(sn);
  if (catalogByModel) {
    return {displayName: catalogByModel, source: 'config/product_catalog.json:model_code', needsReview: false};
  }

  if (hasHan(sn)) {
    return {
      displayName: compactText(sn),
      source: 'standard_goods_sn',
      needsReview: Boolean(normalized?.needsReview),
    };
  }

  const titleDisplay = displayFromTitle(sn, rowOrSn);
  if (titleDisplay) {
    return {displayName: titleDisplay, source: 'title_descriptor', needsReview: false};
  }

  return {
    displayName: sn,
    source: normalized?.reviewReason || normalized?.source || 'raw_standard_goods_sn',
    needsReview: true,
  };
}

export function buildProductDisplayName(rowOrSn) {
  return resolveProductDisplayName(rowOrSn).displayName;
}

function shouldReplaceMapValue(current, next) {
  if (!current) return true;
  if (hasHan(next) && !hasHan(current)) return true;
  return next.length > current.length && hasHan(next);
}

export function enrichProductDisplayNames(data) {
  const productDisplayNames = new Map();

  function visit(value) {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== 'object') return;

    const sn = rowStandardGoodsSn(value);
    if (sn) {
      const resolved = resolveProductDisplayName(value);
      value.product_display_name = resolved.displayName;
      if (resolved.needsReview) value.product_display_name_needs_review = true;
      else if ('product_display_name_needs_review' in value) delete value.product_display_name_needs_review;
      if (resolved.source) value.product_display_name_source = resolved.source;
      const current = productDisplayNames.get(sn);
      if (shouldReplaceMapValue(current, resolved.displayName)) {
        productDisplayNames.set(sn, resolved.displayName);
      }
    }

    for (const [key, child] of Object.entries(value)) {
      if (key === 'productDisplayNames') continue;
      visit(child);
    }
  }

  visit(data);
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const sorted = [...productDisplayNames.entries()].sort((a, b) => a[0].localeCompare(b[0], 'en'));
    data.productDisplayNames = Object.fromEntries(sorted);
  }
  return data;
}
