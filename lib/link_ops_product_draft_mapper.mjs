import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_STOCK_QTY = 100;

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
  const chinese = firstNonEmpty(
    productRaw?.product_name_ch,
    productRaw?.productNameCh,
    linkRow?.productNameCn,
  );
  const multi = firstNonEmpty(productRaw?.product_name_multi, productRaw?.productNameMulti, linkRow?.productNameMulti);
  const names = [];
  if (english) names.push({language: 'en', name: safeString(english, 500)});
  if (chinese) names.push({language: 'zh-cn', name: safeString(chinese, 500)});
  if (multi) names.push({language: 'multi', name: safeString(multi, 500)});
  return names;
}

function normalizeSaleAttributes(skcRaw) {
  const mainAttr = skcRaw?.main_attr || skcRaw?.mainAttr;
  if (!mainAttr || typeof mainAttr !== 'object') return [];
  const attributeId = firstNonEmpty(mainAttr.attribute_id, mainAttr.attributeId);
  const attributeValueId = firstNonEmpty(mainAttr.attribute_value_id, mainAttr.attributeValueId);
  const out = {};
  if (attributeId) out.attribute_id = Number(attributeId);
  if (attributeValueId) out.attribute_value_id = Number(attributeValueId);
  return Object.keys(out).length ? [out] : [];
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

function buildPayloadDraft(canonicalDraft) {
  const product = canonicalDraft.product || {};
  const firstSkc = canonicalDraft.skcs?.[0] || {};
  const images = asArray(canonicalDraft.images?.candidates);
  const payload = {
    source_system: 'OpenAPI',
    site_list: [{main_site: 'shein', sub_site_list: ['shein-sa']}],
    shelf_way: 2,
    hope_on_sale_date: canonicalDraft.publishPolicy?.hopeOnSaleDate || tenYearsLaterBeijing(),
  };
  if (product.categoryId) payload.category_id = Number(product.categoryId);
  if (product.brandCode) payload.brand_code = product.brandCode;
  if (canonicalDraft.names?.length) {
    payload.multi_language_name_list = canonicalDraft.names.map(row => ({
      language: row.language,
      name: row.name,
    }));
  }

  const saleAttributes = normalizeSaleAttributes(firstSkc.sourceSkcRaw || {});
  const skuList = asArray(firstSkc.skus).map(sku => {
    const out = {
      mall_state: 1,
      stock_info_list: [{inventory_num: canonicalDraft.publishPolicy?.stockQty || DEFAULT_STOCK_QTY}],
    };
    if (sku.sourceSupplierSku) out.supplier_sku = sku.sourceSupplierSku;
    return out;
  });

  payload.skc_list = [{
    supplier_code: firstSkc.supplierCode || product.supplierCode || '',
    image_info: {
      image_info_list: images.slice(0, 12).map((image, index) => ({
        image_url: image.url,
        image_sort: index + 1,
      })),
    },
    sale_attribute: saleAttributes,
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
  if (!product.categoryId) blockers.push('源快照缺 category_id，不能确定 HL 发布叶子类目。');
  if (!canonicalDraft.names?.length) blockers.push('源快照缺商品标题，不能生成 multi_language_name_list。');
  if (!canonicalDraft.images?.candidates?.length) blockers.push('源快照缺商品图片，不能生成 image_info。');
  if (!skcs.length) blockers.push('源快照缺 SKC 信息。');
  if (!skus.length) blockers.push('源快照缺 SKU 信息。');
  if (!payloadDraft?.skc_list?.[0]?.sale_attribute?.length) blockers.push('源快照缺销售属性 attribute_id / attribute_value_id。');
  if (!payloadDraft?.skc_list?.[0]?.sku_list?.some(row => row.supplier_sku)) {
    blockers.push('源快照没有可直接复用的 supplier_sku；不能把平台 sku_code 冒充供货商 SKU。');
  }
  blockers.push('当前快照缺 product_attribute_list：需要商品编辑详情或类目属性模板补齐材质、功率、容量等发布参数。');
  blockers.push('当前快照缺 SKU 尺寸/重量 height/length/width/weight：需要商品详情、成本表扩展字段或人工默认模板。');
  blockers.push('当前快照缺 SKU cost_info：需要供货价/成本信息，不能从展示库存页的 “-” 反推。');
  warnings.push('库存策略已按用户规则生成草稿库存 100，但正式 OpenAPI 可能还需要仓库 ID，执行前必须用 HL 仓库列表补齐。');
  if (!product.productTypeId) warnings.push('源快照未提供 product_type_id；若 publishOrEdit 强制要求，需要从类目发布配置接口补齐。');
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
  const storeCandidates = [
    task?.sourceStore,
    task?.source_store,
    task?.copySourceStore,
    task?.copy_source_store,
    task?.metadata?.sourceStore,
    ...asArray(task?.targets?.stores),
    ...asArray(task?.stores),
  ].map(normalizeStoreKey).filter(Boolean);
  const sourceStore = storeCandidates.find(store => store !== target && /^[A-Z]{2}$/.test(store)) || '';
  const refCandidates = [
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

  const productRaw = rawProduct?.product || linkRaw?.product || null;
  const skcRaw = rawProduct?.skc || linkRaw?.skc || null;
  const stockupRaw = rawStockup?.row || inventoryRaw || null;
  const diagnoseRaw = rawDiagnose?.row || performanceRaw?.day || performanceRaw?.c7 || performanceRaw?.c30 || null;
  if (!linkRow && !productRaw && !stockupRaw && !diagnoseRaw) {
    throw new Error(`在 ${store} ${resolvedDate} 快照中没有找到 SKC ${skc}。`);
  }

  const names = buildNames({linkRow, performanceRow, diagnoseRaw, productRaw});
  const images = imageCandidates({linkRow, inventoryRow, performanceRow, productRaw, skcRaw, stockupRaw, diagnoseRaw});
  const skuList = normalizeSkuList({skcRaw: skcRaw || {}, stockupRaw: stockupRaw || {}});
  const supplierCode = firstNonEmpty(
    skcRaw?.supplier_code,
    skcRaw?.supplierCode,
    stockupRaw?.supplierCode,
    inventoryRow?.rawGoodsSn,
    linkRow?.rawGoodsSn,
  );
  const canonicalDraft = {
    schema: 'shein-link-ops-canonical-product-draft/v1',
    generatedAt: now.toISOString(),
    source: {
      type: 'source_store_webapi_snapshot',
      storeKey: store,
      date: resolvedDate,
      skc,
      pointers: findSourcePointers({aggregate, rawProduct, rawStockup, rawDiagnose}),
    },
    target: {
      storeKey: normalizeStoreKey(targetStore),
      writeTransport: 'shein_openapi',
    },
    product: {
      spu: firstNonEmpty(productRaw?.spu_name, productRaw?.spuName, stockupRaw?.spu, linkRow?.spu),
      categoryId: firstNonEmpty(productRaw?.category_id, productRaw?.categoryId, linkRow?.categoryId),
      productTypeId: firstNonEmpty(productRaw?.product_type_id, productRaw?.productTypeId),
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
      brandCode: firstNonEmpty(productRaw?.brand_code, productRaw?.brandCode),
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
  const openapiPublishPayloadDraft = buildPayloadDraft(canonicalDraft);
  const quality = validateCanonicalForOpenApi(canonicalDraft, openapiPublishPayloadDraft);
  canonicalDraft.quality = quality;
  return {
    ok: true,
    generatedAt: canonicalDraft.generatedAt,
    sourceStore: store,
    sourceSkc: skc,
    sourceDate: resolvedDate,
    targetStore: canonicalDraft.target.storeKey,
    canonicalDraft,
    openapiPublishPayloadDraft,
    readyForOpenApiSubmit: quality.readyForOpenApiSubmit,
    blockers: quality.blockers,
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
    blockers: result.blockers || [],
    warnings: result.warnings || [],
    sourcePointers: draft.source?.pointers || [],
  };
}
