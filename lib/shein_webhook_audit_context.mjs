import fs from 'node:fs/promises';
import {SHEIN_OPENAPI_BASE_URLS, SheinOpenApiClient} from './shein_openapi_client.mjs';

const DISCUSS_LIST_PATH = '/open-api/goods/discuss/query-discuss-list';
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

  return Object.freeze({
    async getAuditContext({storeKey, skc, auditFailureReason} = {}) {
      const key = text(storeKey).toUpperCase();
      const targetSkc = text(skc);
      if (!key || !targetSkc || !shouldLookupProductAuditContext(auditFailureReason)) return null;
      const credential = stores.get(key);
      if (!credential) return null;
      const client = new SheinOpenApiClient({baseUrl, ...credential, fetchImpl, timeoutMs});
      for (let pageNum = 1; pageNum <= Math.max(1, Number(maxPages) || 1); pageNum += 1) {
        const response = await client.request(DISCUSS_LIST_PATH, {
          method: 'POST',
          body: {pageNum, pageSize: 200},
          headers: {language: 'CN'},
        });
        const code = text(response?.data?.code);
        if (!response.ok || (code && code !== '0')) {
          throw new Error(`SHEIN discuss list query failed: http=${response.status || 0} code=${code || '-'}`);
        }
        const rows = collectDiscussRows(response.data);
        const exact = rows.find(row => text(row.skcName ?? row.skc_name) === targetSkc);
        if (exact) return normalizeDiscussAuditContext(exact, {auditFailureReason});
        if (rows.length < 200) break;
      }
      return null;
    },
  });
}
