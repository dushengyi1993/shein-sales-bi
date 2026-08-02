import fs from 'node:fs/promises';
import path from 'node:path';
import {SheinOpenApiClient, SHEIN_OPENAPI_BASE_URLS} from './shein_openapi_client.mjs';
import {
  formatStoreIdentityError,
  openApiIdentityToStorageIdentity,
  storeIdentityMatchesMerchantOnly,
  validateStoreIdentity,
} from './shein_store_identity.mjs';
import {acquireCrossProcessTicketLock} from './cross_process_ticket_lock.mjs';
import {normalizeActivityStockSnapshot} from './marketing_activity_inventory_transaction.mjs';

export async function createMarketingActivityInventoryOpenApiAdapter({
  root = process.cwd(),
  storeKey,
  configPath = process.env.SHEIN_OPENAPI_CONFIG_FILE || path.join(root, 'config', 'shein_openapi.local.json'),
} = {}) {
  const normalizedStoreKey = String(storeKey || '').trim().toUpperCase();
  if (!normalizedStoreKey) throw new Error('storeKey is required for activity inventory adapter');
  const [config, truth] = await Promise.all([
    fs.readFile(configPath, 'utf8').then(JSON.parse),
    fs.readFile(path.join(root, 'config', 'store_account_truth.json'), 'utf8').then(JSON.parse),
  ]);
  const stores = Array.isArray(config.stores)
    ? config.stores
    : Object.entries(config.stores || {}).map(([key, value]) => ({storeKey: key, ...value}));
  const configuredStore = stores.find(row => String(row.storeKey || row.key || '').trim().toUpperCase() === normalizedStoreKey);
  if (!configuredStore?.openKeyId || !configuredStore?.secretKey) {
    throw new Error(`OpenAPI credentials missing for ${normalizedStoreKey}`);
  }
  const client = new SheinOpenApiClient({
    baseUrl: config.apiBaseUrls?.prodSemiManaged || SHEIN_OPENAPI_BASE_URLS.prodSemiManaged,
    openKeyId: configuredStore.openKeyId,
    secretKey: configuredStore.secretKey,
  });
  const identityResponse = await client.request('/open-api/openapi-business-backend/query-store-info', {
    method: 'POST',
    body: {},
    headers: {language: 'en'},
  });
  if (String(identityResponse.data?.code) !== '0') {
    throw new Error(`store-info failed: ${identityResponse.data?.code} ${identityResponse.data?.msg || ''}`);
  }
  const identity = validateStoreIdentity({
    store: configuredStore,
    truth: truth.stores?.[normalizedStoreKey],
    storageIdentity: openApiIdentityToStorageIdentity(identityResponse.data),
    href: 'openapi:/open-api/openapi-business-backend/query-store-info',
    context: 'marketing_activity_inventory_transaction',
  });
  if (!identity.ok && !storeIdentityMatchesMerchantOnly(identity)) {
    throw new Error(formatStoreIdentityError(identity));
  }

  const productsBySkc = await loadProductsBySkc(client);
  return {
    storeKey: normalizedStoreKey,
    identity,
    async resolveTargets(targets) {
      return targets.map(target => {
        const product = productsBySkc.get(String(target.skc || '').trim());
        if (!product) throw new Error(`OpenAPI product/query did not return ${normalizedStoreKey}::${target.skc}`);
        const skuCodes = [...new Set(asArray(product.skuCodeList).map(String).filter(Boolean))];
        if (skuCodes.length !== 1) {
          throw new Error(
            `Activity inventory transaction requires one live SKU code per target until platform minimum is SKU-specific: `
            + `${normalizedStoreKey}::${target.skc} found=${skuCodes.length}`,
          );
        }
        return {...target, storeKey: normalizedStoreKey, skuCode: skuCodes[0]};
      });
    },
    acquireLock(target) {
      return acquireCrossProcessTicketLock(lockPath(root, normalizedStoreKey, target.skc, target.skuCode), {
        timeoutMs: 60_000,
        staleMs: 15 * 60_000,
        timeoutMessage: `activity inventory lock timeout for ${normalizedStoreKey}::${target.skc}::${target.skuCode}`,
        timeoutCode: 'MARKETING_ACTIVITY_INVENTORY_LOCK_TIMEOUT',
      });
    },
    async readStock(target) {
      const response = await client.request('/open-api/stock/stock-query', {
        method: 'POST',
        body: {skuCodeList: [target.skuCode], warehouseType: '2', invType: 'VI'},
        headers: {language: 'en'},
      });
      if (String(response.data?.code) !== '0') {
        throw new Error(`stock-query failed: ${response.data?.code} ${response.data?.msg || ''}`);
      }
      const row = asArray(response.data?.info)
        .flatMap(group => asArray(group?.goodsInventory))
        .flatMap(group => asArray(group?.skuList))
        .find(item => String(item?.skuCode || '') === String(target.skuCode));
      if (!row) throw new Error(`stock-query did not return SKU ${target.skuCode}`);
      return normalizeActivityStockSnapshot(row);
    },
    async writeStock({target, overwriteQuantity, idempotencyKey, phase}) {
      const response = await client.request('/open-api/stock/change-inventory/v2', {
        method: 'POST',
        body: {
          updateSkuInventoryQuantityRequests: [{
            idempotencyKey,
            skuCode: target.skuCode,
            invType: 'VI',
            changeType: 'OVERWRITE',
            changeQuantity: overwriteQuantity,
            changeReason: phase === 'restore'
              ? 'Restore pre-enrollment usable inventory after transactional marketing signup'
              : 'Temporarily satisfy live platform minimum during transactional marketing signup',
          }],
        },
        headers: {language: 'en'},
      });
      const ok = String(response.data?.code) === '0' && response.data?.info?.success !== false;
      return {
        ok,
        code: response.data?.code,
        message: response.data?.msg || '',
        traceId: response.data?.traceId || '',
        info: response.data?.info || null,
      };
    },
  };
}

async function loadProductsBySkc(client) {
  const products = new Map();
  for (let pageNum = 1; pageNum <= 100; pageNum += 1) {
    const response = await client.request('/open-api/openapi-business-backend/product/query', {
      method: 'POST',
      body: {pageNum, pageSize: 100},
      headers: {language: 'en'},
    });
    if (String(response.data?.code) !== '0') {
      throw new Error(`product/query failed: ${response.data?.code} ${response.data?.msg || ''}`);
    }
    const rows = asArray(response.data?.info?.data);
    for (const row of rows) {
      const skc = String(row?.skcName || '').trim();
      if (skc) products.set(skc, row);
    }
    if (rows.length < 100) break;
  }
  return products;
}

function lockPath(root, storeKey, skc, skuCode) {
  const safe = `${storeKey}-${skc}-${skuCode}`.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 180);
  return path.join(root, 'state', 'locks', `marketing-activity-inventory-${safe}.lock`);
}

function asArray(value) {
  return value == null ? [] : Array.isArray(value) ? value : [value];
}
