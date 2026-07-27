import fs from 'node:fs/promises';
import {SHEIN_OPENAPI_BASE_URLS, SheinOpenApiClient} from './shein_openapi_client.mjs';

const DISCUSS_LIST_PATH = '/open-api/goods/discuss/query-discuss-list';
const DOCUMENT_STATE_PATH = '/open-api/goods/query-document-state';
const SEARCH_PRODUCT_PATH = '/open-api/goods/searchProduct';
const SPU_INFO_PATH = '/open-api/goods/spu-info';
const NEGOTIATION_FAILURE = /(?:议价|核价|报价|价格|price|negotiat)/iu;

function text(value) {
  return String(value ?? '').trim();
}

function finite(value) {
  if (value === null || value === undefined || text(value) === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function storeRows(config) {
  if (Array.isArray(config?.stores)) return config.stores;
  if (config?.stores && typeof config.stores === 'object') {
    return Object.entries(config.stores).map(([storeKey, row]) => ({storeKey, ...(row || {})}));
  }
  return [];
}

function collectDiscussRows(value, {depth = 0, seen = new Set(), rows = []} = {}) {
  if (!value || typeof value !== 'object' || seen.has(value) || depth > 6 || rows.length >= 1000) return rows;
  seen.add(value);
  if (!Array.isArray(value) && text(value.skcName ?? value.skc_name) && Array.isArray(value.skuCostPrices ?? value.sku_cost_prices)) {
    rows.push(value);
    return rows;
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    collectDiscussRows(child, {depth: depth + 1, seen, rows});
  }
  return rows;
}

function collectDocumentSkcRows(value, {depth = 0, seen = new Set(), rows = []} = {}) {
  if (!value || typeof value !== 'object' || seen.has(value) || depth > 6 || rows.length >= 1000) return rows;
  seen.add(value);
  if (!Array.isArray(value) && text(value.skcName ?? value.skc_name) && (Array.isArray(value.failedReason ?? value.failed_reason) || value.documentState !== undefined || value.document_state !== undefined)) rows.push(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) collectDocumentSkcRows(child, {depth: depth + 1, seen, rows});
  return rows;
}

function collectProductSkcRows(value, {depth = 0, seen = new Set(), rows = [], spuName = ''} = {}) {
  if (!value || typeof value !== 'object' || seen.has(value) || depth > 7 || rows.length >= 1000) return rows;
  seen.add(value);
  const inheritedSpu = Array.isArray(value) ? spuName : text(value.spuName ?? value.spu_name) || spuName;
  if (!Array.isArray(value) && text(value.skcName ?? value.skc_name)) {
    rows.push({...value, __spuName: inheritedSpu});
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    collectProductSkcRows(child, {depth: depth + 1, seen, rows, spuName: inheritedSpu});
  }
  return rows;
}

function collectSkcDetailRows(value, {depth = 0, seen = new Set(), rows = []} = {}) {
  if (!value || typeof value !== 'object' || seen.has(value) || depth > 7 || rows.length >= 1000) return rows;
  seen.add(value);
  if (!Array.isArray(value) && text(value.skcName ?? value.skc_name)) rows.push(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    collectSkcDetailRows(child, {depth: depth + 1, seen, rows});
  }
  return rows;
}

function shelfStateRows(value) {
  for (const key of ['shelfStatusInfoList', 'shelf_status_info_list', 'skcSiteShelfStatusList', 'skc_site_shelf_status_list']) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  return [];
}

function siteShelfState(value) {
  const rows = shelfStateRows(value);
  return rows.find(row => text(row?.siteAbbr ?? row?.site_abbr ?? row?.site).toLowerCase() === 'shein-sa') || rows[0] || null;
}

function siteRecycleState(value) {
  const rows = Array.isArray(value?.recycleInfoList)
    ? value.recycleInfoList
    : Array.isArray(value?.recycle_info_list) ? value.recycle_info_list : [];
  return rows.find(row => text(row?.subSite ?? row?.sub_site ?? row?.site).toLowerCase() === 'shein-sa') || rows[0] || null;
}

function normalizeShelfState(code, {firstShelfTime = '', lastShelfTime = '', recycleStatus = ''} = {}) {
  const value = text(code);
  const neverShelved = text(firstShelfTime) === '1970-01-01 08:00:01'
    && text(lastShelfTime) === '2018-08-28 00:00:00'
    && !['1', 'true'].includes(text(recycleStatus).toLowerCase());
  const row = {
    '1': {action: 'on_shelf', shelfStatusName: '已上架'},
    '2': {action: 'wait_shelf', shelfStatusName: '待上架'},
    '3': {action: 'sold_out', shelfStatusName: '已售罄'},
    '4': {action: 'off_shelf', shelfStatusName: '已下架'},
  }[value] || (value === '0' && neverShelved
    ? {action: 'wait_shelf', shelfStatusName: '待上架', stateEvidence: 'not_on_shelf_and_never_shelved'}
    : null);
  if (!row) return null;
  const shelfStatusCode = value === '0' && neverShelved ? '2' : value;
  return Object.freeze({
    platformShelfStatusCode: value,
    shelfStatusCode,
    ...row,
    isOnShelf: shelfStatusCode === '1',
    isWaitShelf: shelfStatusCode === '2',
    isSoldOut: shelfStatusCode === '3',
    isOutShelf: shelfStatusCode === '4',
  });
}

function localizedFailureReason(row) {
  const reasons = Array.isArray(row?.failedReason) ? row.failedReason : Array.isArray(row?.failed_reason) ? row.failed_reason : [];
  const normalized = reasons.map(item => typeof item === 'string'
    ? {language: '', content: text(item)}
    : {language: text(item?.language ?? item?.lang).toLowerCase(), content: text(item?.content ?? item?.reason ?? item?.message)}).filter(item => item.content);
  return (normalized.find(item => /^(?:zh(?:-cn|_cn)?|cn)$/i.test(item.language)) || normalized[0])?.content || '';
}

function assertReadableResponse(response, label) {
  const code = text(response?.data?.code);
  if (!response?.ok || (code && code !== '0')) throw new Error(`SHEIN ${label} query failed: http=${response?.status || 0} code=${code || '-'}`);
  return response.data;
}

function latestMerchantOffer(skuRow) {
  const histories = Array.isArray(skuRow?.costPriceHistories)
    ? skuRow.costPriceHistories
    : Array.isArray(skuRow?.cost_price_histories) ? skuRow.cost_price_histories : [];
  return histories
    .map((row, index) => ({
      serial: finite(row?.serialNumber ?? row?.serial_number) ?? index,
      amount: finite(row?.costPrice ?? row?.cost_price),
      currency: text(row?.currency),
    }))
    .filter(row => row.amount !== null)
    .sort((left, right) => right.serial - left.serial)[0] || null;
}

function priceRange(rows, amountKey, currencyKey) {
  const valid = rows
    .map(row => ({amount: finite(row?.[amountKey]), currency: text(row?.[currencyKey])}))
    .filter(row => row.amount !== null);
  if (!valid.length) return null;
  const amounts = valid.map(row => row.amount);
  const currencies = [...new Set(valid.map(row => row.currency).filter(Boolean))];
  return Object.freeze({
    min: Math.min(...amounts),
    max: Math.max(...amounts),
    currency: currencies.length === 1 ? currencies[0] : '',
  });
}

export function shouldLookupProductAuditContext(auditFailureReason) {
  return NEGOTIATION_FAILURE.test(text(auditFailureReason));
}

export function normalizeDiscussAuditContext(row, {auditFailureReason = ''} = {}) {
  if (!row || typeof row !== 'object') return null;
  const skuRows = Array.isArray(row.skuCostPrices)
    ? row.skuCostPrices
    : Array.isArray(row.sku_cost_prices) ? row.sku_cost_prices : [];
  const merchantRows = skuRows.map(latestMerchantOffer).filter(Boolean);
  const suggestedRows = skuRows.map(sku => ({
    suggestCostPrice: sku?.suggestCostPrice ?? sku?.suggest_cost_price,
    suggestCostCurrency: sku?.suggestCostCurrency ?? sku?.suggest_cost_currency,
  }));
  const merchantOffer = priceRange(merchantRows, 'amount', 'currency');
  const platformSuggested = priceRange(suggestedRows, 'suggestCostPrice', 'suggestCostCurrency');
  return Object.freeze({
    source: 'shein_discuss_list',
    skc: text(row.skcName ?? row.skc_name),
    supplierCode: text(row.supplierCode ?? row.supplier_code),
    discussSn: text(row.discussSn ?? row.discuss_sn),
    discussStatus: text(row.discussStatus ?? row.discuss_status),
    discussType: text(row.discussType ?? row.discuss_type),
    appealCount: finite(row.appealCount ?? row.appeal_count),
    failureReason: text(auditFailureReason) || [text(row.reason), text(row.appealReason ?? row.appeal_reason)].filter(Boolean).join('；'),
    merchantOffer,
    platformSuggested,
  });
}

export async function createSheinWebhookAuditContextProvider({
  configFile,
  config,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8_000,
  maxPages = 3,
} = {}) {
  const source = config || JSON.parse(await fs.readFile(configFile, 'utf8'));
  const baseUrl = text(source?.apiBaseUrls?.prodSemiManaged) || SHEIN_OPENAPI_BASE_URLS.prodSemiManaged;
  const stores = new Map();
  for (const row of storeRows(source)) {
    if (row?.enabled === false) continue;
    const storeKey = text(row?.storeKey ?? row?.key ?? row?.store).toUpperCase();
    const openKeyId = text(row?.openKeyId ?? row?.open_key_id);
    const secretKey = text(row?.secretKey ?? row?.secret_key);
    if (storeKey && openKeyId && secretKey) stores.set(storeKey, {openKeyId, secretKey});
  }

  async function getProductSearchRow({storeKey, skc} = {}) {
    const key = text(storeKey).toUpperCase();
    const targetSkc = text(skc);
    if (!key || !targetSkc) return null;
    const credential = stores.get(key);
    if (!credential) return null;
    const client = new SheinOpenApiClient({baseUrl, ...credential, fetchImpl, timeoutMs});
    const response = await client.request(SEARCH_PRODUCT_PATH, {
      method: 'POST',
      body: {pageNum: 1, pageSize: 10, skcNameList: [targetSkc]},
      headers: {language: 'zh-cn'},
    });
    const data = assertReadableResponse(response, 'product');
    const exact = collectProductSkcRows(data).find(row => text(row.skcName ?? row.skc_name) === targetSkc);
    if (!exact) return null;
    return {key, targetSkc, exact};
  }

  async function getProductIdentity({storeKey, skc} = {}) {
    const found = await getProductSearchRow({storeKey, skc});
    if (!found) return null;
    const {targetSkc, exact} = found;
    const spu = text(exact.__spuName ?? exact.spuName ?? exact.spu_name);
    return Object.freeze({
      source: 'shein_product_search',
      skc: targetSkc,
      ...(spu ? {spu} : {}),
      supplierCode: text(exact.supplierCode ?? exact.supplier_code),
      currentShelfStatus: text(exact.skcShelfStatus ?? exact.skc_shelf_status),
    });
  }

  async function getProductState({storeKey, skc} = {}) {
    const found = await getProductSearchRow({storeKey, skc});
    if (!found) return null;
    const {key, targetSkc, exact} = found;
    const credential = stores.get(key);
    const spu = text(exact.__spuName ?? exact.spuName ?? exact.spu_name);
    const supplierCode = text(exact.supplierCode ?? exact.supplier_code);
    let detail = exact;
    let sourceName = 'shein_product_search';

    if (spu && credential) {
      const client = new SheinOpenApiClient({baseUrl, ...credential, fetchImpl, timeoutMs});
      const response = await client.request(SPU_INFO_PATH, {
        method: 'POST',
        body: {spuName: spu, languageList: ['en', 'ar']},
        headers: {language: 'zh-cn'},
      });
      const data = assertReadableResponse(response, 'product detail');
      const detailMatches = collectSkcDetailRows(data)
        .filter(row => text(row.skcName ?? row.skc_name) === targetSkc);
      detail = detailMatches.find(row => shelfStateRows(row).length) || detailMatches[0] || exact;
      sourceName += '+shein_spu_info';
    }

    const siteState = siteShelfState(detail);
    const recycleState = siteRecycleState(detail);
    const firstShelfTime = text(siteState?.firstShelfTime ?? siteState?.first_shelf_time);
    const lastShelfTime = text(siteState?.lastShelfTime ?? siteState?.last_shelf_time);
    const recycleStatus = text(recycleState?.recycleStatus ?? recycleState?.recycle_status);
    const exactState = normalizeShelfState(siteState?.shelfStatus ?? siteState?.shelf_status, {
      firstShelfTime,
      lastShelfTime,
      recycleStatus,
    });
    const binaryState = normalizeShelfState(exact.skcShelfStatus ?? exact.skc_shelf_status);
    const state = exactState || (binaryState?.shelfStatusCode === '1' ? binaryState : null);
    return Object.freeze({
      source: sourceName,
      storeKey: key,
      skc: targetSkc,
      spu,
      supplierCode,
      ...(state || {}),
      firstShelfTime,
      lastShelfTime,
      lastUpdateTime: text(siteState?.lastUpdateTime ?? siteState?.last_update_time),
      recycleStatus,
    });
  }

  return Object.freeze({
    getProductIdentity,
    getProductState,
    async getAuditContext({storeKey, skc, productId, version, documentId, auditFailureReason} = {}) {
      const key = text(storeKey).toUpperCase();
      const targetSkc = text(skc);
      if (!key || !targetSkc) return null;
      const credential = stores.get(key);
      if (!credential) return null;
      const client = new SheinOpenApiClient({baseUrl, ...credential, fetchImpl, timeoutMs});
      const errors = [];
      const sources = [];
      let failureReason = text(auditFailureReason);
      let resolvedDocumentId = text(documentId);
      let supplierCode = '';
      let discussContext = null;

      if (text(productId)) {
        try {
          const response = await client.request(DOCUMENT_STATE_PATH, {
            method: 'POST',
            body: {spuList: [{spuName: text(productId), ...(text(version) ? {version: text(version)} : {})}]},
            headers: {language: 'zh-cn'},
          });
          const data = assertReadableResponse(response, 'document state');
          const exact = collectDocumentSkcRows(data).find(row => text(row.skcName ?? row.skc_name) === targetSkc);
          if (exact) {
            failureReason = localizedFailureReason(exact) || failureReason;
            resolvedDocumentId = text(exact.documentSn ?? exact.document_sn) || resolvedDocumentId;
            sources.push('shein_document_state');
          }
        } catch (error) {
          errors.push(error);
        }
      }

      if (shouldLookupProductAuditContext(failureReason)) {
        try {
          for (let pageNum = 1; pageNum <= Math.max(1, Number(maxPages) || 1); pageNum += 1) {
            const response = await client.request(DISCUSS_LIST_PATH, {method: 'POST', body: {pageNum, pageSize: 200}, headers: {language: 'CN'}});
            const data = assertReadableResponse(response, 'discuss list');
            const rows = collectDiscussRows(data);
            const exact = rows.find(row => text(row.skcName ?? row.skc_name) === targetSkc);
            if (exact) {
              discussContext = normalizeDiscussAuditContext(exact, {auditFailureReason: failureReason});
              supplierCode = text(discussContext?.supplierCode);
              sources.push('shein_discuss_list');
              break;
            }
            if (rows.length < 200) break;
          }
        } catch (error) {
          errors.push(error);
        }
      }

      if (!supplierCode) {
        try {
          const identity = await getProductIdentity({storeKey: key, skc: targetSkc});
          if (identity) {
            supplierCode = text(identity.supplierCode);
            sources.push('shein_product_search');
          }
        } catch (error) {
          errors.push(error);
        }
      }

      const context = {
        ...(discussContext || {}),
        source: sources.join('+'),
        skc: targetSkc,
        supplierCode,
        documentId: resolvedDocumentId,
        failureReason: failureReason || text(discussContext?.failureReason),
      };
      if (context.failureReason || context.supplierCode || context.merchantOffer || context.platformSuggested) return Object.freeze(context);
      if (errors.length) throw errors[0];
      return null;
    },
  });
}
