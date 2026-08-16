import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {buildProductDisplayName} from './product_display_name.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_STOCK_QTY = 100;
const SKC_IMAGE_TYPE = {
  MAIN: 1,
  DETAIL: 2,
  SQUARE: 5,
  COLOR: 6,
};
const ALLOWED_SKC_IMAGE_TYPES = new Set(Object.values(SKC_IMAGE_TYPE));

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeStoreKey(value) {
  return String(value || '').trim().toUpperCase();
}

function safeString(value, max = 1000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function jsonClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sha256StableJson(value) {
  return crypto.createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function rel(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function parseMaybeJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || !/^[\[{]/.test(text)) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function tenYearsLaterBeijing(date = new Date()) {
  const bj = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  bj.setUTCFullYear(bj.getUTCFullYear() + 10);
  bj.setUTCHours(10, 0, 0, 0);
  const pad = n => String(n).padStart(2, '0');
  return `${bj.getUTCFullYear()}-${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())} ${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}:${pad(bj.getUTCSeconds())}`;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return '';
}

function uniqStrings(values) {
  return [...new Set(values.map(v => safeString(v, 240)).filter(Boolean))];
}

async function listDateCandidates(sourceStore) {
  const store = normalizeStoreKey(sourceStore);
  const dates = new Set();
  const aggregateDir = path.join(ROOT, 'outputs', 'shein_links', store);
  if (await exists(aggregateDir)) {
    for (const item of await fs.readdir(aggregateDir, {withFileTypes: true})) {
      const m = item.isFile() && item.name.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
      if (m) dates.add(m[1]);
    }
  }
  const rawDir = path.join(ROOT, 'outputs', 'shein_links_raw', store);
  if (await exists(rawDir)) {
    for (const item of await fs.readdir(rawDir, {withFileTypes: true})) {
      if (item.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(item.name)) dates.add(item.name);
    }
  }
  return [...dates].sort().reverse();
}

export async function resolveSourceDate({sourceStore, date = 'latest'} = {}) {
  if (date && date !== 'latest') return date;
  const candidates = await listDateCandidates(sourceStore);
  if (!candidates.length) {
    throw new Error(`未找到 ${normalizeStoreKey(sourceStore)} 的链接/WebAPI 快照。`);
  }
  return candidates[0];
}

async function loadAggregateSnapshot(sourceStore, date) {
  const file = path.join(ROOT, 'outputs', 'shein_links', normalizeStoreKey(sourceStore), `${date}.json`);
  if (!(await exists(file))) return null;
  return {file, data: await readJson(file)};
}

async function loadRawSnapshots(sourceStore, date) {
  const dir = path.join(ROOT, 'outputs', 'shein_links_raw', normalizeStoreKey(sourceStore), date);
  if (!(await exists(dir))) return [];
  const files = (await fs.readdir(dir))
    .filter(name => /\.json$/i.test(name))
    .sort();
  const out = [];
  for (const name of files) {
    const file = path.join(dir, name);
    try {
      out.push({file, data: await readJson(file)});
    } catch {
      // 跳过坏快照，不让单个历史 raw 文件打断映射。
    }
  }
  return out;
}

function rowContainsSkc(row, skc) {
  if (!row || !skc) return false;
  if (String(row.skc || row.skcName || row.skc_name || '') === skc) return true;
  if (String(row.uniqueKey || '').includes(skc)) return true;
  if (String(row.skuCodes || row.skuCode || '').includes(skc)) return true;
  return JSON.stringify(row).includes(skc);
}

function findAggregateRow(aggregate, key, skc) {
  const rows = asArray(aggregate?.data?.[key]);
  return rows.find(row => rowContainsSkc(row, skc)) || null;
}

function flattenProductStatusRows(rawData) {
  const out = [];
  for (const bucket of asArray(rawData?.productStatuses)) {
    out.push(...asArray(bucket?.rows));
  }
  return out;
}

function findRawProductRow(rawSnapshots, skc) {
  for (const snap of rawSnapshots) {
    for (const row of flattenProductStatusRows(snap.data)) {
      const skcs = asArray(row?.skc_info_list || row?.skcInfoList);
      if (skcs.some(item => String(item?.skc_name || item?.skcName || item?.skc || '') === skc)) {
        return {
          file: snap.file,
          product: row,
          skc: skcs.find(item => String(item?.skc_name || item?.skcName || item?.skc || '') === skc),
        };
      }
    }
  }
  return null;
}

function findRawStockupRow(rawSnapshots, skc) {
  for (const snap of rawSnapshots) {
    const row = asArray(snap.data?.stockup?.rows).find(item => String(item?.skc || '') === skc);
    if (row) return {file: snap.file, row};
  }
  return null;
}

function findRawDiagnoseRow(rawSnapshots, skc) {
  for (const snap of rawSnapshots) {
    const diagnose = snap.data?.diagnose || {};
    for (const period of ['day', 'c7', 'prev7', 'c30']) {
      const row = asArray(diagnose?.[period]?.rows).find(item => String(item?.skc || '') === skc);
      if (row) return {file: snap.file, period, row};
    }
  }
  return null;
}

function imageCandidates({linkRow, inventoryRow, performanceRow, productRaw, skcRaw, stockupRaw, diagnoseRaw}) {
  return uniqStrings([
    stockupRaw?.picUrl,
    inventoryRow?.imageUrl,
    diagnoseRaw?.imgUrl,
    performanceRow?.imageUrl,
    linkRow?.imageUrl,
    skcRaw?.main_image_url,
    skcRaw?.mainImageUrl,
    skcRaw?.main_image_thumbnail_url,
    skcRaw?.mainImageThumbnailUrl,
    productRaw?.main_image_url,
  ]).map((url, index) => ({
    url,
    role: index === 0 ? 'main' : 'candidate',
    source: 'source_webapi_snapshot',
  }));
}

function buildNames({linkRow, performanceRow, diagnoseRaw, productRaw}) {
  const english = firstNonEmpty(
    productRaw?.product_name_en,
    productRaw?.productNameEn,
    linkRow?.productNameEn,
    performanceRow?.goodsName,
    diagnoseRaw?.goodsName,
  );
  const arabic = firstNonEmpty(
    productRaw?.product_name_ar,
    productRaw?.productNameAr,
    linkRow?.productNameAr,
  );
  const multi = firstNonEmpty(productRaw?.product_name_multi, productRaw?.productNameMulti, linkRow?.productNameMulti);
  const names = [];
  if (english) names.push({language: 'en', name: safeString(english, 500)});
  if (arabic) names.push({language: 'ar', name: safeString(arabic, 500)});
  if (multi) names.push({language: 'multi', name: safeString(multi, 500)});
  return names;
}

function normalizeSaleAttributes(skcRaw) {
  const mainAttr = skcRaw?.main_attr || skcRaw?.mainAttr;
  if (!mainAttr || typeof mainAttr !== 'object') return null;
  const attributeId = firstNonEmpty(mainAttr.attribute_id, mainAttr.attributeId);
  const attributeValueId = firstNonEmpty(mainAttr.attribute_value_id, mainAttr.attributeValueId);
  const out = {};
  if (attributeId) out.attribute_id = Number(attributeId);
  if (attributeValueId) out.attribute_value_id = Number(attributeValueId);
  return Object.keys(out).length ? out : null;
}

function normalizeSkuList({skcRaw, stockupRaw}) {
  const stockSkuRows = asArray(stockupRaw?.skuList).filter(row => row && row.skuCode && row.skuCode !== '合计');
  const bySkuCode = new Map(stockSkuRows.map(row => [String(row.skuCode), row]));
  const skuInfo = asArray(skcRaw?.sku_info || skcRaw?.skuInfo);
  const rows = skuInfo.length ? skuInfo : stockSkuRows.map(row => ({sku_code: row.skuCode}));
  return rows.map((sku, index) => {
    const skuCode = String(firstNonEmpty(sku?.sku_code, sku?.skuCode, sku?.code)).trim();
    const stockRow = bySkuCode.get(skuCode) || stockSkuRows[index] || null;
    return {
      sourceSkuCode: skuCode,
      sourceSkuId: stockRow?.id ? String(stockRow.id) : '',
      sourceSkuAttr: safeString(stockRow?.attr || skcRaw?.sale_name || skcRaw?.saleName || ''),
      sourceSupplierSku: safeString(stockRow?.supplierSku || stockRow?.supplier_sku || ''),
      sourcePurchasePrice: safeString(stockRow?.purchasePrice || ''),
      sourceFinalPrice: safeString(stockRow?.finalPrice || stockRow?.price || ''),
      sourceStock: Number.isFinite(Number(stockRow?.stock)) ? Number(stockRow.stock) : null,
    };
  }).filter(row => row.sourceSkuCode || row.sourceSkuAttr);
}

function compactValue(value) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\s+/g, '').trim();
}

function normalizeNumericOrString(value) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const text = String(value).trim();
  const n = Number(text);
  return Number.isFinite(n) && text !== '' ? n : text;
}

function normalizeOpenApiAttribute(row) {
  if (!row || typeof row !== 'object') return null;
  const attributeId = firstNonEmpty(row.attribute_id, row.attributeId);
  const attributeValueId = firstNonEmpty(row.attribute_value_id, row.attributeValueId);
  const attributeExtraValue = firstNonEmpty(row.attribute_extra_value, row.attributeExtraValue, row.attribute_value, row.attributeValue, row.value);
  const out = {};
  if (attributeId !== '') out.attribute_id = normalizeNumericOrString(attributeId);
  const normalizedValueId = normalizeNumericOrString(attributeValueId);
  if (normalizedValueId !== undefined && String(normalizedValueId) !== '0') out.attribute_value_id = normalizedValueId;
  if (attributeExtraValue !== '') out.attribute_extra_value = safeString(attributeExtraValue, 500);
  return Object.keys(out).length ? out : null;
}

function uniqueObjects(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const key = JSON.stringify(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function openApiSkcList(info) {
  return asArray(info?.skcInfoList || info?.skc_info_list);
}

function openApiSkuList(skcInfo) {
  return asArray(skcInfo?.skuInfoList || skcInfo?.sku_info_list);
}

function rowSkcName(row) {
  return safeString(firstNonEmpty(row?.skcName, row?.skc_name, row?.skc), 160);
}

function openApiDetailHasSkc(item, skc) {
  const info = item?.info || item?.data || {};
  return item?.ok !== false && Boolean(skc) && openApiSkcList(info).some(row => rowSkcName(row) === skc);
}

function openApiDetailSpuName(item) {
  const info = item?.info || item?.data || {};
  return safeString(info?.spuName || info?.spu_name, 160);
}

function findOpenApiDetailEntry(entries, {spuName, skc}) {
  const details = asArray(entries);
  if (spuName && safeString(spuName, 160)) {
    // normalizedRow 已提供 spuName：只允许 SPU+SKC 双精确，避免 SKC 撞名误配。
    return details.find(item => {
      return item?.ok !== false && openApiDetailSpuName(item) === safeString(spuName, 160) && openApiDetailHasSkc(item, skc);
    }) || null;
  }
  // 仅 spuName 缺失时才允许按 SKC 精确匹配。
  return details.find(item => openApiDetailHasSkc(item, skc)) || null;
}

function hasOpenApiSpuEntry(entries, spuName) {
  return asArray(entries).some(item => item?.ok !== false && spuName && openApiDetailSpuName(item) === safeString(spuName, 160));
}

function hasOpenApiSkcEntry(entries, skc) {
  return asArray(entries).some(item => openApiDetailHasSkc(item, skc));
}

function isFreshCachedDetail(detailFetchedAt, now) {
  const value = typeof detailFetchedAt === 'string' ? detailFetchedAt : '';
  if (!value) return false;
  const fetchedMs = Date.parse(value);
  if (!Number.isFinite(fetchedMs)) return false;
  const buildMs = now instanceof Date && Number.isFinite(now.getTime()) ? now.getTime() : Date.now();
  if (fetchedMs > buildMs) return false;
  if (buildMs - fetchedMs > 24 * 60 * 60 * 1000) return false;
  return true;
}

// 结构化身份冲突：current 详情与目标 SPU/SKC 不能双精确命中时，给出稳定
// code/message，而不是静默 return null。executor 依据 code 精确审计。
function openApiIdentityConflict(entries, {spuName, skc}) {
  const spu = safeString(spuName, 160);
  const targetSkc = safeString(skc, 160);
  if (spu && hasOpenApiSpuEntry(entries, spu)) {
    return {
      code: 'SOURCE_DETAIL_CONFLICT_SAME_SPU_WRONG_SKC',
      message: `源详情快照存在 SPU ${spu}，但该详情不含目标 SKC ${targetSkc}，身份冲突，禁止用缓存回退或按 SKC 误配。`,
    };
  }
  if (targetSkc && hasOpenApiSkcEntry(entries, targetSkc)) {
    return {
      code: 'SOURCE_DETAIL_CONFLICT_SAME_SKC_WRONG_SPU',
      message: `源详情快照存在目标 SKC ${targetSkc}，但所属 SPU 与目标 SPU ${spu || '未知'} 不一致，身份冲突，禁止误配发布。`,
    };
  }
  return null;
}

async function loadOpenApiProductDetail(sourceStore, skc, now) {
  const store = normalizeStoreKey(sourceStore);
  const file = path.join(ROOT, 'outputs', 'shein_openapi_products', store, 'latest.json');
  if (!(await exists(file))) return {detail: null, conflict: null};
  let data;
  try {
    data = await readJson(file);
  } catch {
    return {detail: null, conflict: null};
  }
  const rows = asArray(data?.normalizedRows || data?.rows || data?.items);
  const normalizedRow = rows.find(row => rowContainsSkc(row, skc)) || null;
  const spuName = firstNonEmpty(normalizedRow?.spu, normalizedRow?.spuName, normalizedRow?.spu_name);
  const currentDetail = findOpenApiDetailEntry(data?.detailResults, {spuName, skc});
  if (!currentDetail) {
    // current 中存在同 SPU 缺目标 SKC，或同 SKC 但 SPU 不符的详情：身份冲突，
    // fail closed，不用 fallback 掩盖，并给出结构化 blocker。
    const conflict = openApiIdentityConflict(data?.detailResults, {spuName, skc});
    if (conflict) return {detail: null, conflict};
  }
  let detail = currentDetail;
  let detailSource = 'openapi_product_detail_snapshot';
  let detailFetchedAt = firstNonEmpty(currentDetail?.detailFetchedAt, currentDetail?.fetchedAt, data?.fetchedAt, data?.generatedAt);
  if (!detail) {
    const fallbackDetail = findOpenApiDetailEntry(data?.detailFallbackResults, {spuName, skc});
    if (fallbackDetail && isFreshCachedDetail(fallbackDetail?.detailFetchedAt, now)) {
      detail = fallbackDetail;
      detailSource = 'openapi_product_detail_cached_fallback';
      detailFetchedAt = fallbackDetail?.detailFetchedAt;
    }
  }
  const info = detail?.info || detail?.data || null;
  if (!info) return {detail: null, conflict: null};
  const skcInfo = openApiSkcList(info).find(row => rowSkcName(row) === skc) || null;
  if (!skcInfo) return {detail: null, conflict: null};
  return {
    detail: {
      file,
      row: normalizedRow,
      info,
      skcInfo,
      matchedSpuName: openApiDetailSpuName(detail),
      matchedSkcName: safeString(skc, 160),
      source: detailSource,
      detailFetchedAt: typeof detailFetchedAt === 'string' ? detailFetchedAt : '',
    },
    conflict: null,
  };
}

function attributeIdOf(row) {
  const id = firstNonEmpty(row?.attribute_id, row?.attributeId);
  const normalized = normalizeNumericOrString(id);
  return normalized === undefined || normalized === null || normalized === '' ? '' : String(normalized);
}

function openApiSaleAttributeIds({skcInfo}) {
  const rows = [
    skcInfo,
    ...asArray(skcInfo?.saleAttributeList || skcInfo?.sale_attribute_list),
    ...asArray(skcInfo?.attributeInfoList || skcInfo?.attribute_info_list),
    ...asArray(skcInfo?.skuInfoList || skcInfo?.sku_info_list).flatMap(skuInfo => [
      ...asArray(skuInfo?.saleAttributeList || skuInfo?.sale_attribute_list),
      ...asArray(skuInfo?.productSkuAttributeList || skuInfo?.product_sku_attribute_list),
    ]),
  ];
  return new Set(rows.map(attributeIdOf).filter(Boolean));
}

function openApiProductAttributes(info, {excludeAttributeIds = new Set()} = {}) {
  return uniqueObjects(asArray(info?.productAttributeInfoList || info?.product_attribute_info_list)
    .map(normalizeOpenApiAttribute)
    .filter(row => row && !excludeAttributeIds.has(String(row.attribute_id))));
}

function openApiSaleAttributes({skcInfo, skuInfo}) {
  const rows = [
    ...asArray(skcInfo?.saleAttributeList || skcInfo?.sale_attribute_list),
    ...asArray(skcInfo?.attributeInfoList || skcInfo?.attribute_info_list),
    ...asArray(skuInfo?.saleAttributeList || skuInfo?.sale_attribute_list),
    ...asArray(skuInfo?.productSkuAttributeList || skuInfo?.product_sku_attribute_list),
  ];
  const normalized = rows.map(normalizeOpenApiAttribute).filter(Boolean);
  const skcLevel = normalizeOpenApiAttribute(skcInfo);
  if (skcLevel) normalized.unshift(skcLevel);
  return uniqueObjects(normalized);
}

function openApiSaleAttribute({skcInfo, skuInfo}) {
  return openApiSaleAttributes({skcInfo, skuInfo})[0] || null;
}

function hasSaleAttribute(value) {
  if (!value) return false;
  if (Array.isArray(value)) return value.some(hasSaleAttribute);
  if (typeof value !== 'object') return false;
  return Object.keys(value).length > 0;
}

function firstImageUrl(row) {
  if (!row || typeof row !== 'object') return '';
  return firstNonEmpty(
    row.imageUrl,
    row.image_url,
    row.imageOriginUrl,
    row.image_origin_url,
    row.mainImageUrl,
    row.main_image_url,
    row.url,
  );
}

function normalizeSkcImageType(row, index = 0) {
  const raw = firstNonEmpty(
    row?.image_type,
    row?.imageType,
    row?.img_type,
    row?.imgType,
    row?.type,
  );
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && ALLOWED_SKC_IMAGE_TYPES.has(numeric)) return numeric;
  const text = String(raw || '').trim().toUpperCase();
  if (text === 'MAIN' || text === 'MAIN_IMAGE' || text === 'PRIMARY') return SKC_IMAGE_TYPE.MAIN;
  if (text === 'DETAIL' || text === 'DETAIL_IMAGE' || text === 'DESC' || text === 'DESCRIPTION') return SKC_IMAGE_TYPE.DETAIL;
  if (text === 'SQUARE' || text === 'SQUARE_IMAGE' || text === 'BLOCK' || text === 'BLOCK_IMAGE') return SKC_IMAGE_TYPE.SQUARE;
  if (text === 'COLOR' || text === 'COLOR_BLOCK' || text === 'COLOR_SWATCH' || text === 'SWATCH') return SKC_IMAGE_TYPE.COLOR;
  return index === 0 ? SKC_IMAGE_TYPE.MAIN : SKC_IMAGE_TYPE.DETAIL;
}

function payloadImageInfoList(images, limit = 12) {
  const sourceRows = asArray(images)
    .map((image, index) => ({
      url: safeString(image?.url || image?.image_url || image?.imageUrl, 1000),
      image_type: normalizeSkcImageType(image, index),
    }))
    .filter(row => row.url);
  if (!sourceRows.length) return [];
  if (!sourceRows.some(row => row.image_type === SKC_IMAGE_TYPE.MAIN)) {
    sourceRows[0].image_type = SKC_IMAGE_TYPE.MAIN;
  }

  const out = [];
  const seen = new Set();
  let hasMain = false;
  let hasSquare = false;
  let hasColor = false;
  let detailCount = 0;
  for (const row of sourceRows) {
    let imageType = row.image_type;
    if (imageType === SKC_IMAGE_TYPE.MAIN) {
      if (hasMain) imageType = SKC_IMAGE_TYPE.DETAIL;
      else hasMain = true;
    }
    if (imageType === SKC_IMAGE_TYPE.SQUARE) {
      if (hasSquare) imageType = SKC_IMAGE_TYPE.DETAIL;
      else hasSquare = true;
    }
    if (imageType === SKC_IMAGE_TYPE.COLOR) {
      if (hasColor) imageType = SKC_IMAGE_TYPE.DETAIL;
      else hasColor = true;
    }
    if (imageType === SKC_IMAGE_TYPE.DETAIL) {
      detailCount += 1;
      if (detailCount > 10) continue;
    }
    const key = `${imageType}|${row.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      image_url: row.url,
      image_sort: out.length + 1,
      image_type: imageType,
    });
    if (out.length >= limit) break;
  }
  const mainIndex = out.findIndex(row => row.image_type === SKC_IMAGE_TYPE.MAIN);
  if (mainIndex > 0) {
    const [main] = out.splice(mainIndex, 1);
    out.unshift(main);
    out.forEach((row, index) => { row.image_sort = index + 1; });
  }
  if (out[0]) {
    out[0].image_type = SKC_IMAGE_TYPE.MAIN;
    out[0].image_sort = 1;
  }
  return out;
}

function openApiImageCandidates({info, skcInfo}) {
  const rows = [
    ...asArray(skcInfo?.skcImageInfoList || skcInfo?.skc_image_info_list),
    ...asArray(skcInfo?.siteDetailImageInfoList || skcInfo?.site_detail_image_info_list),
    ...asArray(info?.spuImageInfoList || info?.spu_image_info_list),
  ];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const url = firstImageUrl(row);
    if (!url) continue;
    const imageType = normalizeSkcImageType(row, out.length);
    const key = `${imageType}|${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      url,
      imageType,
      role: imageType === SKC_IMAGE_TYPE.MAIN ? 'main' : imageType === SKC_IMAGE_TYPE.SQUARE ? 'square' : imageType === SKC_IMAGE_TYPE.COLOR ? 'color' : 'detail',
      source: 'source_openapi_spu_info',
    });
  }
  return out;
}

function openApiNames({info, skcInfo}) {
  const rows = [
    ...asArray(skcInfo?.productMultiNameList || skcInfo?.product_multi_name_list),
    ...asArray(info?.productMultiNameList || info?.product_multi_name_list),
  ];
  return uniqueObjects(rows.map(row => {
    const language = safeString(firstNonEmpty(row?.language, row?.lang, row?.languageCode), 40);
    const name = safeString(firstNonEmpty(row?.name, row?.productName, row?.product_name, row?.value), 500);
    if (!language || !name) return null;
    return {language, name};
  }).filter(Boolean));
}

function preferredCostInfo(skuInfo) {
  const rows = asArray(skuInfo?.costInfoList || skuInfo?.cost_info_list);
  const row = rows.find(item => String(item?.currency || '').toUpperCase() === 'SAR') || rows[0] || null;
  if (!row) return null;
  const currency = safeString(row.currency || 'SAR', 20);
  const costPrice = firstNonEmpty(row.cost_price, row.costPrice, row.price, row.value);
  if (!currency || costPrice === '') return null;
  return {
    currency,
    cost_price: safeString(costPrice, 40),
  };
}

function dimensionValue(skuInfo, key) {
  return firstNonEmpty(
    skuInfo?.[key],
    skuInfo?.sellerSkuWeight?.[key],
    skuInfo?.seller_sku_weight?.[key],
    skuInfo?.wmsSkuWeight?.[key],
    skuInfo?.wms_sku_weight?.[key],
  );
}

function openApiSkuPayloadRows({skcInfo, stockQty}) {
  return openApiSkuList(skcInfo).map((skuInfo) => {
    const out = {
      mall_state: normalizeNumericOrString(firstNonEmpty(skuInfo?.mall_state, skuInfo?.mallState, 1)),
      stock_info_list: [{inventory_num: Number(stockQty) > 0 ? Number(stockQty) : DEFAULT_STOCK_QTY}],
    };
    const saleAttributeList = uniqueObjects([
      ...asArray(skuInfo?.saleAttributeList || skuInfo?.sale_attribute_list),
      ...asArray(skuInfo?.productSkuAttributeList || skuInfo?.product_sku_attribute_list),
    ].map(normalizeOpenApiAttribute).filter(Boolean));
    if (saleAttributeList.length) out.sale_attribute_list = saleAttributeList;
    const supplierSku = firstNonEmpty(
      skuInfo?.supplier_sku,
      skuInfo?.supplierSku,
      skuInfo?.skuSupplierInfo?.supplierSku,
      skuInfo?.sku_supplier_info?.supplier_sku,
    );
    if (supplierSku !== '') out.supplier_sku = safeString(supplierSku, 120);
    for (const key of ['height', 'length', 'width', 'weight']) {
      const value = dimensionValue(skuInfo, key);
      if (value !== '') out[key] = normalizeNumericOrString(value);
    }
    const costInfo = preferredCostInfo(skuInfo);
    if (costInfo) out.cost_info = costInfo;
    return out;
  });
}

function applyOpenApiDetailToPayload(payload, openApiDetail, canonicalDraft) {
  const info = openApiDetail?.info;
  const skcInfo = openApiDetail?.skcInfo;
  if (!payload || !info || !skcInfo) return {applied: []};
  const applied = [];
  const setIfPresent = (target, key, value, label = key) => {
    if (value === undefined || value === null || value === '') return;
    target[key] = value;
    applied.push(label);
  };
  setIfPresent(payload, 'category_id', normalizeNumericOrString(firstNonEmpty(info.categoryId, info.category_id)), 'category_id');
  setIfPresent(payload, 'product_type_id', normalizeNumericOrString(firstNonEmpty(info.productTypeId, info.product_type_id)), 'product_type_id');
  setIfPresent(payload, 'brand_code', safeString(firstNonEmpty(info.brandCode, info.brand_code), 80), 'brand_code');

  const saleAttributeIds = openApiSaleAttributeIds({skcInfo});
  const attrs = openApiProductAttributes(info, {excludeAttributeIds: saleAttributeIds});
  if (attrs.length) {
    payload.product_attribute_list = attrs;
    applied.push('product_attribute_list');
    if (saleAttributeIds.size) applied.push('product_attribute_list.filtered_sale_attributes');
  }

  const names = openApiNames({info, skcInfo});
  if (names.length && !asArray(payload.multi_language_name_list).length) {
    payload.multi_language_name_list = names;
    applied.push('multi_language_name_list');
  }

  const skcList = asArray(payload.skc_list || payload.skcList);
  if (!skcList.length) payload.skc_list = [{}];
  const targetSkc = payload.skc_list[0];
  const supplierCode = firstNonEmpty(
    targetStandardGoodsSn(canonicalDraft),
    skcInfo.supplierCode,
    skcInfo.supplier_code,
    info.supplierCode,
    info.supplier_code,
  );
  if (supplierCode !== '') {
    targetSkc.supplier_code = safeString(supplierCode, 240);
    applied.push(targetStandardGoodsSn(canonicalDraft) ? 'skc_list.supplier_code.standard_goods_sn' : 'skc_list.supplier_code');
  }

  const images = openApiImageCandidates({info, skcInfo});
  if (images.length) {
    targetSkc.image_info = {
      image_info_list: payloadImageInfoList(images, 12),
    };
    if (canonicalDraft?.images) canonicalDraft.images.candidates = images;
    applied.push('skc_list.image_info');
  }

  const firstSkuInfo = openApiSkuList(skcInfo)[0] || null;
  const saleAttr = openApiSaleAttribute({skcInfo, skuInfo: firstSkuInfo});
  if (saleAttr) {
    targetSkc.sale_attribute = saleAttr;
    applied.push('skc_list.sale_attribute');
  }

  const skuRows = openApiSkuPayloadRows({skcInfo, stockQty: canonicalDraft?.publishPolicy?.stockQty});
  if (skuRows.length) {
    targetSkc.sku_list = skuRows;
    applied.push('skc_list.sku_list');
  }
  return {applied: [...new Set(applied)]};
}

function findSourcePointers({aggregate, rawProduct, rawStockup, rawDiagnose}) {
  const pointers = [];
  if (aggregate?.file) pointers.push({type: 'aggregate', path: rel(aggregate.file)});
  if (rawProduct?.file) pointers.push({type: 'raw_product_status', path: rel(rawProduct.file)});
  if (rawStockup?.file) pointers.push({type: 'raw_stockup', path: rel(rawStockup.file)});
  if (rawDiagnose?.file) pointers.push({type: `raw_diagnose_${rawDiagnose.period}`, path: rel(rawDiagnose.file)});
  const seen = new Set();
  return pointers.filter(item => {
    const key = `${item.type}|${item.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function summarizeSourceRows({linkRow, inventoryRow, performanceRow, productRaw, skcRaw, stockupRaw, diagnoseRaw}) {
  return {
    hasLinkRow: Boolean(linkRow),
    hasInventoryRow: Boolean(inventoryRow),
    hasPerformanceRow: Boolean(performanceRow),
    hasRawProductStatus: Boolean(productRaw && skcRaw),
    hasRawStockup: Boolean(stockupRaw),
    hasRawDiagnose: Boolean(diagnoseRaw),
    categoryId: firstNonEmpty(productRaw?.category_id, productRaw?.categoryId, linkRow?.categoryId),
    categoryName: firstNonEmpty(stockupRaw?.categoryName, inventoryRow?.categoryName),
    brandCode: firstNonEmpty(productRaw?.brand_code, productRaw?.brandCode),
    brandName: firstNonEmpty(productRaw?.brand_name, productRaw?.brandName, linkRow?.brandName),
  };
}

function targetStandardGoodsSn(canonicalDraft) {
  const product = canonicalDraft?.product || {};
  const value = firstNonEmpty(product.standardGoodsSn, product.standard_goods_sn);
  return value ? safeString(buildProductDisplayName(value), 240) : '';
}

function buildPayloadDraft(canonicalDraft) {
  const product = canonicalDraft.product || {};
  const firstSkc = canonicalDraft.skcs?.[0] || {};
  const images = asArray(canonicalDraft.images?.candidates);
  const shelfWay = Number(canonicalDraft.publishPolicy?.shelfWay ?? 2);
  const hopeOnSaleDate = canonicalDraft.publishPolicy?.hopeOnSaleDate || tenYearsLaterBeijing();
  const rawStandardGoodsSn = firstNonEmpty(product.standardGoodsSn, firstSkc.standardGoodsSn, product.supplierCode, firstSkc.supplierCode);
  const standardGoodsSn = rawStandardGoodsSn ? safeString(buildProductDisplayName(rawStandardGoodsSn), 240) : '';
  const payload = {
    source_system: 'OpenAPI',
    site_list: [{main_site: 'shein', sub_site_list: ['shein-sa']}],
    shelf_way: shelfWay,
  };
  if (shelfWay === 2 && hopeOnSaleDate) {
    payload.hope_on_sale_date = hopeOnSaleDate;
  }
  if (product.categoryId) payload.category_id = Number(product.categoryId);
  if (product.brandCode) payload.brand_code = product.brandCode;
  if (canonicalDraft.names?.length) {
    payload.multi_language_name_list = canonicalDraft.names.map(row => ({
      language: row.language,
      name: row.name,
    }));
  }

  const saleAttribute = normalizeSaleAttributes(firstSkc.sourceSkcRaw || {});
  const skuList = asArray(firstSkc.skus).map(sku => {
    const out = {
      mall_state: 1,
      stock_info_list: [{inventory_num: canonicalDraft.publishPolicy?.stockQty || DEFAULT_STOCK_QTY}],
    };
    if (standardGoodsSn) out.supplier_sku = standardGoodsSn;
    else if (sku.sourceSupplierSku) out.supplier_sku = sku.sourceSupplierSku;
    return out;
  });

  payload.skc_list = [{
    supplier_code: standardGoodsSn || firstSkc.supplierCode || product.supplierCode || '',
    image_info: {
      image_info_list: payloadImageInfoList(images, 12),
    },
    ...(saleAttribute ? {sale_attribute: saleAttribute} : {}),
    sku_list: skuList,
  }];
  return payload;
}

function validateCanonicalForOpenApi(canonicalDraft, payloadDraft) {
  const blockers = [];
  const warnings = [];
  const product = canonicalDraft.product || {};
  const skcs = asArray(canonicalDraft.skcs);
  const firstSkc = skcs[0] || {};
  const skus = asArray(firstSkc.skus);
  const payloadSkus = asArray(payloadDraft?.skc_list?.[0]?.sku_list);
  if (!product.categoryId) blockers.push('源快照缺 category_id，不能确定 HL 发布叶子类目。');
  if (!canonicalDraft.names?.length) blockers.push('源快照缺商品标题，不能生成 multi_language_name_list。');
  if (!canonicalDraft.images?.candidates?.length) blockers.push('源快照缺商品图片，不能生成 image_info。');
  if (!skcs.length) blockers.push('源快照缺 SKC 信息。');
  if (!skus.length && !payloadSkus.length) blockers.push('源快照缺 SKU 信息。');
  if (!hasSaleAttribute(payloadDraft?.skc_list?.[0]?.sale_attribute)) blockers.push('源快照缺销售属性 attribute_id / attribute_value_id。');
  if (!payloadDraft?.skc_list?.[0]?.sku_list?.some(row => row.supplier_sku)) {
    warnings.push('源快照没有可直接复用的 supplier_sku；不会把平台 sku_code 冒充供货商 SKU。若发布接口强制要求，再按规则或人工补。');
  }
  if (!payloadDraft?.product_attribute_list?.length) {
    blockers.push('当前快照缺 product_attribute_list：需要商品编辑详情或类目属性模板补齐材质、功率、容量等发布参数。');
  }
  if (payloadSkus.some(row => ['height', 'length', 'width', 'weight'].some(key => row?.[key] === undefined || row?.[key] === null || row?.[key] === ''))) {
    blockers.push('当前快照缺 SKU 尺寸/重量 height/length/width/weight：需要商品详情、成本表扩展字段或人工默认模板。');
  }
  if (payloadSkus.some(row => !row?.cost_info)) {
    blockers.push('当前快照缺 SKU cost_info：需要供货价/成本信息，不能从展示库存页的 “-” 反推。');
  }
  warnings.push('库存策略已按用户规则生成草稿库存 100，但正式 OpenAPI 可能还需要仓库 ID，执行前必须用目标店仓库列表补齐。');
  if (!product.productTypeId && !payloadDraft?.product_type_id) warnings.push('源快照未提供 product_type_id；若 publishOrEdit 强制要求，需要从类目发布配置接口补齐。');
  if (canonicalDraft.images?.candidates?.some(image => /thumbnail/i.test(image.url))) {
    warnings.push('图片候选中含 thumbnail 链接；正式发布前应优先使用原图或用户上传素材。');
  }
  return {
    readyForOpenApiSubmit: blockers.length === 0,
    blockers,
    warnings,
  };
}

export function inferSourceProductFromTask(task, {targetStore = 'HL'} = {}) {
  const target = normalizeStoreKey(targetStore);
  const validStore = store => /^[A-Z0-9]{2,4}$/.test(store);
  const explicitStoreCandidates = [
    ...asArray(task?.targets?.sourceStores),
    ...asArray(task?.targets?.readStores),
    task?.sourceStore,
    task?.source_store,
    task?.copySourceStore,
    task?.copy_source_store,
    task?.metadata?.sourceStore,
    ...asArray(task?.sourceStores),
    ...asArray(task?.readStores),
  ].map(normalizeStoreKey).filter(Boolean);
  const fallbackStoreCandidates = [
    ...asArray(task?.targets?.stores),
    ...asArray(task?.stores),
  ].map(normalizeStoreKey).filter(Boolean);
  const sourceStore = explicitStoreCandidates.find(validStore)
    || fallbackStoreCandidates.find(store => store !== target && validStore(store))
    || '';
  const refCandidates = [
    task?.targets?.sourceSkc,
    task?.targets?.source_skc,
    task?.sourceSkc,
    task?.source_skc,
    task?.skc,
    task?.metadata?.sourceSkc,
    ...asArray(task?.targets?.productRefs),
    ...asArray(task?.productRefs),
    task?.productRef,
    task?.command,
    task?.title,
    task?.summary,
  ].map(v => safeString(v, 2000)).filter(Boolean);
  let sourceSkc = '';
  for (const ref of refCandidates) {
    const m = ref.match(/\b(s[avb]\d{8,})\b/i);
    if (m) {
      sourceSkc = m[1];
      break;
    }
  }
  return {sourceStore, sourceSkc};
}

export async function buildProductDraftFromSnapshots({
  sourceStore,
  sourceSkc,
  date = 'latest',
  targetStore = 'HL',
  stockQty = DEFAULT_STOCK_QTY,
  now = new Date(),
} = {}) {
  const store = normalizeStoreKey(sourceStore);
  const skc = safeString(sourceSkc, 120);
  if (!store) throw new Error('缺 sourceStore。');
  if (!skc) throw new Error('缺 sourceSkc。');
  const resolvedDate = await resolveSourceDate({sourceStore: store, date});
  const aggregate = await loadAggregateSnapshot(store, resolvedDate);
  const rawSnapshots = await loadRawSnapshots(store, resolvedDate);

  const linkRow = findAggregateRow(aggregate, 'linkRows', skc);
  const inventoryRow = findAggregateRow(aggregate, 'inventoryRows', skc);
  const performanceRow = findAggregateRow(aggregate, 'performanceRows', skc);
  const linkRaw = parseMaybeJson(linkRow?.rawSummary);
  const inventoryRaw = parseMaybeJson(inventoryRow?.rawSummary);
  const performanceRaw = parseMaybeJson(performanceRow?.rawSummary);
  const rawProduct = findRawProductRow(rawSnapshots, skc);
  const rawStockup = findRawStockupRow(rawSnapshots, skc);
  const rawDiagnose = findRawDiagnoseRow(rawSnapshots, skc);
  const openApiLookup = await loadOpenApiProductDetail(store, skc, now);
  const openApiDetail = openApiLookup?.detail || null;
  const mappingBlockers = openApiLookup?.conflict ? [openApiLookup.conflict] : [];

  const productRaw = rawProduct?.product || linkRaw?.product || null;
  const skcRaw = rawProduct?.skc || linkRaw?.skc || null;
  const stockupRaw = rawStockup?.row || inventoryRaw || null;
  const diagnoseRaw = rawDiagnose?.row || performanceRaw?.day || performanceRaw?.c7 || performanceRaw?.c30 || null;
  if (!linkRow && !productRaw && !stockupRaw && !diagnoseRaw && !openApiDetail?.info) {
    throw new Error(`在 ${store} ${resolvedDate} 快照中没有找到 SKC ${skc}。`);
  }

  const openApiNameRows = openApiNames({info: openApiDetail?.info, skcInfo: openApiDetail?.skcInfo});
  const names = openApiNameRows.length ? openApiNameRows : buildNames({linkRow, performanceRow, diagnoseRaw, productRaw});
  const openApiImages = openApiImageCandidates({info: openApiDetail?.info, skcInfo: openApiDetail?.skcInfo});
  const images = openApiImages.length
    ? openApiImages
    : imageCandidates({linkRow, inventoryRow, performanceRow, productRaw, skcRaw, stockupRaw, diagnoseRaw});
  const skuList = normalizeSkuList({skcRaw: skcRaw || {}, stockupRaw: stockupRaw || {}});
  const supplierCode = firstNonEmpty(
    openApiDetail?.skcInfo?.supplierCode,
    openApiDetail?.skcInfo?.supplier_code,
    openApiDetail?.info?.supplierCode,
    openApiDetail?.info?.supplier_code,
    skcRaw?.supplier_code,
    skcRaw?.supplierCode,
    stockupRaw?.supplierCode,
    inventoryRow?.rawGoodsSn,
    linkRow?.rawGoodsSn,
  );
  const sourcePointers = findSourcePointers({aggregate, rawProduct, rawStockup, rawDiagnose});
  if (openApiDetail?.file) {
    sourcePointers.push({
      type: openApiDetail.source,
      path: rel(openApiDetail.file),
      spuName: openApiDetail.matchedSpuName,
      skcName: openApiDetail.matchedSkcName,
      detailFetchedAt: safeString(openApiDetail?.detailFetchedAt, 80),
    });
  }
  const canonicalDraft = {
    schema: 'shein-link-ops-canonical-product-draft/v1',
    generatedAt: now.toISOString(),
    source: {
      type: 'source_store_webapi_snapshot',
      storeKey: store,
      date: resolvedDate,
      skc,
      pointers: sourcePointers,
    },
    target: {
      storeKey: normalizeStoreKey(targetStore),
      writeTransport: 'shein_openapi',
    },
    product: {
      spu: firstNonEmpty(openApiDetail?.info?.spuName, openApiDetail?.info?.spu_name, productRaw?.spu_name, productRaw?.spuName, stockupRaw?.spu, linkRow?.spu),
      categoryId: firstNonEmpty(openApiDetail?.info?.categoryId, openApiDetail?.info?.category_id, productRaw?.category_id, productRaw?.categoryId, linkRow?.categoryId),
      productTypeId: firstNonEmpty(openApiDetail?.info?.productTypeId, openApiDetail?.info?.product_type_id, productRaw?.product_type_id, productRaw?.productTypeId),
      categoryName: firstNonEmpty(stockupRaw?.categoryName, inventoryRow?.categoryName),
      categoryPath: uniqStrings([
        performanceRow?.category1,
        performanceRow?.category2,
        performanceRow?.category3,
        performanceRow?.category4,
        diagnoseRaw?.newCate1Nm,
        diagnoseRaw?.newCate2Nm,
        diagnoseRaw?.newCate3Nm,
        diagnoseRaw?.newCate4Nm,
      ]),
      brandCode: firstNonEmpty(openApiDetail?.info?.brandCode, openApiDetail?.info?.brand_code, productRaw?.brand_code, productRaw?.brandCode),
      brandName: firstNonEmpty(productRaw?.brand_name, productRaw?.brandName, linkRow?.brandName),
      supplierCode: safeString(supplierCode, 240),
      standardGoodsSn: safeString(linkRow?.standardGoodsSn || performanceRow?.standardGoodsSn || inventoryRow?.standardGoodsSn || supplierCode, 240),
    },
    names,
    images: {
      candidates: images,
    },
    skcs: [{
      sourceSkc: skc,
      sourceSkcCode: firstNonEmpty(skcRaw?.skc_code, skcRaw?.skcCode, linkRow?.skcCode),
      supplierCode: safeString(supplierCode, 240),
      saleName: safeString(firstNonEmpty(skcRaw?.sale_name, skcRaw?.saleName, linkRow?.saleName), 240),
      sourceMallSellStatus: firstNonEmpty(skcRaw?.mall_sell_status, skcRaw?.mallSellStatus, linkRow?.mallSellStatus),
      sourceSkcRaw: jsonClone(skcRaw || {}),
      skus: skuList,
    }],
    publishPolicy: {
      stockQty: Number(stockQty) > 0 ? Number(stockQty) : DEFAULT_STOCK_QTY,
      shelfWay: 2,
      hopeOnSaleDate: tenYearsLaterBeijing(now),
      submitMode: 'draft_or_waiting_review_after_user_confirm',
    },
    sourceSummary: summarizeSourceRows({linkRow, inventoryRow, performanceRow, productRaw, skcRaw, stockupRaw, diagnoseRaw}),
  };
  canonicalDraft.sourceSummary.hasOpenApiProductDetail = Boolean(openApiDetail?.info && openApiDetail?.skcInfo);
  canonicalDraft.sourceSummary.openApiProductAttributeCount = openApiProductAttributes(openApiDetail?.info).length;
  canonicalDraft.sourceSummary.openApiSkuCount = openApiSkuList(openApiDetail?.skcInfo).length;
  const openapiPublishPayloadDraft = buildPayloadDraft(canonicalDraft);
  const openApiApplied = applyOpenApiDetailToPayload(openapiPublishPayloadDraft, openApiDetail, canonicalDraft);
  canonicalDraft.openApiDetail = openApiDetail ? {
    source: openApiDetail.source,
    file: rel(openApiDetail.file),
    spuName: safeString(firstNonEmpty(openApiDetail?.info?.spuName, openApiDetail?.info?.spu_name), 160),
    skcName: rowSkcName(openApiDetail?.skcInfo),
    matchedSpuName: openApiDetail.matchedSpuName,
    matchedSkcName: openApiDetail.matchedSkcName,
    productAttributeCount: openApiProductAttributes(openApiDetail?.info).length,
    skcImageCount: openApiImageCandidates({info: openApiDetail?.info, skcInfo: openApiDetail?.skcInfo}).length,
    skuCount: openApiSkuList(openApiDetail?.skcInfo).length,
    detailFetchedAt: safeString(openApiDetail?.detailFetchedAt, 80),
    appliedToPayload: openApiApplied.applied,
  } : null;
  const quality = validateCanonicalForOpenApi(canonicalDraft, openapiPublishPayloadDraft);
  canonicalDraft.quality = quality;
  const sourceDetailLock = openApiDetail ? {
    source: openApiDetail.source,
    matchedSpuName: openApiDetail.matchedSpuName,
    matchedSkcName: openApiDetail.matchedSkcName,
    detailFetchedAt: openApiDetail.detailFetchedAt,
    detailContentSha256: sha256StableJson({
      info: openApiDetail.info,
      matchedSkcName: openApiDetail.matchedSkcName,
    }),
  } : null;
  return {
    ok: true,
    generatedAt: canonicalDraft.generatedAt,
    sourceStore: store,
    sourceSkc: skc,
    sourceDate: resolvedDate,
    targetStore: canonicalDraft.target.storeKey,
    canonicalDraft,
    openapiPublishPayloadDraft,
    sourceDetailLock,
    mappingBlockers,
    readyForOpenApiSubmit: quality.readyForOpenApiSubmit && mappingBlockers.length === 0,
    blockers: [...quality.blockers, ...mappingBlockers.map(blocker => blocker.message)],
    warnings: quality.warnings,
  };
}

export function summarizeDraftForExecutor(result) {
  if (!result?.canonicalDraft) return null;
  const draft = result.canonicalDraft;
  const payload = result.openapiPublishPayloadDraft || {};
  return {
    sourceStore: result.sourceStore,
    sourceSkc: result.sourceSkc,
    sourceDate: result.sourceDate,
    targetStore: result.targetStore,
    readyForOpenApiSubmit: result.readyForOpenApiSubmit,
    categoryId: draft.product?.categoryId || null,
    brandCode: draft.product?.brandCode || null,
    nameCount: draft.names?.length || 0,
    imageCount: draft.images?.candidates?.length || 0,
    skcCount: draft.skcs?.length || 0,
    skuCount: draft.skcs?.reduce((sum, skc) => sum + asArray(skc.skus).length, 0) || 0,
    payloadSkcCount: asArray(payload.skc_list || payload.skcList).length,
    openApiDetail: draft.openApiDetail || null,
    sourceDetailLock: result.sourceDetailLock || null,
    mappingBlockers: result.mappingBlockers || [],
    blockers: result.blockers || [],
    warnings: result.warnings || [],
    sourcePointers: draft.source?.pointers || [],
  };
}
