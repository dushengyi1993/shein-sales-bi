import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {SheinOpenApiClient, SHEIN_OPENAPI_BASE_URLS} from './shein_openapi_client.mjs';
import {
  formatStoreIdentityError,
  openApiIdentityToStorageIdentity,
  storeIdentityMatchesMerchantOnly,
  validateStoreIdentity,
} from './shein_store_identity.mjs';
import {acquireCrossProcessTicketLock} from './cross_process_ticket_lock.mjs';
import {normalizeActivityStockSnapshot} from './marketing_activity_inventory_transaction.mjs';
import {inventoryLogicalActionKey, inventoryRecoveryScopeKey, discoverInventoryJournalFiles,
  readInventoryIntentJournals, submitDurableInventoryWriteOnce} from './durable_inventory_write.mjs';
import {computeInventoryOverwriteQuantity, stableInventoryHash, INVENTORY_OVERWRITE_COMPUTATION_VERSION} from './inventory_replenishment_policy.mjs';

export async function createMarketingActivityInventoryOpenApiAdapter({
  root = process.cwd(),
  storeKey,
  transactionHash,
  execute = false,
  configPath = process.env.SHEIN_OPENAPI_CONFIG_FILE || path.join(root, 'config', 'shein_openapi.local.json'),
} = {}) {
  const normalizedStoreKey = String(storeKey || '').trim().toUpperCase();
  if (!normalizedStoreKey) throw new Error('storeKey is required for activity inventory adapter');
  if (execute && process.platform !== 'linux') throw new Error('CLOUD_INVENTORY_REQUIRED: the complete marketing inventory transaction must execute on the managed cloud');
  if (execute && !/^[a-f0-9]{64}$/.test(String(transactionHash || ''))) throw new Error('Marketing inventory transaction hash is required');
  if (execute && !String(process.env.SHEIN_BI_MARKETING_AUTOMATION_AUTHORIZATION || '').trim()) throw new Error('Current marketing transaction authorization is required');
  const runtimeRoot = process.env.SHEIN_BI_INVENTORY_RUNTIME_ROOT || '/srv/shein-bi/runtime/daily-inventory-replenishment';
  const runDate = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date());
  const journalFile = execute ? path.join(runtimeRoot, 'runs', 'marketing', transactionHash, `daily-inventory-replenishment-${runDate}.json.journal.ndjson`) : '';
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
    inventoryStoreKey: normalizedStoreKey,
    ...(journalFile ? {inventoryJournalFile: journalFile} : {}),
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
  const adapter = {
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
      return acquireCrossProcessTicketLock(lockPath(root, normalizedStoreKey, target.skc), {
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
    async writeStock(options) {
      if (!execute) throw new Error('Marketing inventory adapter is read-only');
      return writeMarketingInventoryOnce({client, root, storeKey: normalizedStoreKey, journalFile, transactionHash,
        runDate, readStock: adapter.readStock, ...options});
    },
  };
  if (execute) {
    const files = await discoverInventoryJournalFiles(journalFile, {includeAll: true});
    const bundle = await readInventoryIntentJournals(files, {allowMultiplePendingByScope: true});
    if ([...bundle.intents.values()].some(intent => intent.marketingTransactionHash === transactionHash)) {
      throw new Error('MARKETING_INVENTORY_PRIOR_ATTEMPT: transaction already has durable inventory evidence; read-only reconciliation is required');
    }
  }
  return adapter;
}

export async function writeMarketingInventoryOnce({client, storeKey, journalFile, transactionHash, runDate,
  target, phase, overwriteQuantity, desiredUsableInventory, readStock}) {
  if (!['temporary_raise', 'restore'].includes(phase)) throw new Error('Invalid marketing inventory phase');
  const commandId = `marketing:${transactionHash}:${phase}`;
  const logicalActionKey = inventoryLogicalActionKey({commandId, storeKey, skc: target.skc, skuCode: target.skuCode, targetUsableInventory: desiredUsableInventory});
  const idempotencyKey = 'bi-inv-' + logicalActionKey.slice(0, 42);
  const readBundle = async () => readInventoryIntentJournals(await discoverInventoryJournalFiles(journalFile, {
    includeAll: true, additionalDirectories: client.inventoryJournalDomainDirectories(),
  }), {allowMultiplePendingByScope: true});
  await fs.mkdir(path.dirname(journalFile), {recursive: true});
  const outcome = await submitDurableInventoryWriteOnce({
    journalFile,
    readFenceBundle: readBundle,
    prepareUnderLock: async () => {
      const bundle = await readBundle();
      if ([...bundle.intents.values()].some(intent => intent.logicalActionKey === logicalActionKey)) {
        throw new Error('INVENTORY_WRITE_ALREADY_RECORDED: only readback is permitted');
      }
      const before = {...normalizeActivityStockSnapshot(await readStock(target)), stockRowMissing: false};
      if (computeInventoryOverwriteQuantity(desiredUsableInventory, before) !== overwriteQuantity) {
        throw new Error('MARKETING_INVENTORY_OCCUPANCY_CHANGED_BEFORE_SUBMIT');
      }
      const request = {pathname: '/open-api/stock/change-inventory/v2', method: 'POST',
        body: {updateSkuInventoryQuantityRequests: [{idempotencyKey, skuCode: target.skuCode, invType: 'VI', changeType: 'OVERWRITE',
          changeQuantity: overwriteQuantity, changeReason: phase === 'restore'
            ? 'Restore pre-enrollment usable inventory after transactional marketing signup'
            : 'Temporarily satisfy live platform minimum during transactional marketing signup'}]}, headers: {language: 'en'}};
      const intent = {kind: 'intent', intentId: crypto.randomUUID(), commandId, logicalActionKey,
        recoveryScopeKey: inventoryRecoveryScopeKey({storeKey, skc: target.skc, skuCode: target.skuCode}),
        planHash: transactionHash, marketingTransactionHash: transactionHash, marketingPhase: phase,
        runDate, storeKey, skc: target.skc, skuCode: target.skuCode, invType: 'VI',
        targetUsableInventory: desiredUsableInventory, policyVersion: 'marketing-activity-inventory/v1',
        overwriteComputationVersion: INVENTORY_OVERWRITE_COMPUTATION_VERSION,
        authorizationId: process.env.SHEIN_BI_MARKETING_AUTOMATION_AUTHORIZATION,
        idempotencyKey, requestPayloadHash: stableInventoryHash(request), request, before, recordedAt: new Date().toISOString()};
      const scope = {storeKey, skc: target.skc, skuCode: target.skuCode, invType: 'VI', intentId: intent.intentId,
        logicalActionKey, requestPayloadHash: intent.requestPayloadHash};
      return {intent, inventoryScope: scope, fenceBundle: bundle,
        assertInventoryAdmission: () => client.assertInventoryFence(request.pathname, request.method, request.body, request.headers, scope)};
    },
    submit: ({intent, inventoryScope}) => client.request(intent.request.pathname, {...intent.request, inventoryScope}),
    readback: async () => ({ok: true, ...normalizeActivityStockSnapshot(await readStock(target))}),
    maxReadbackAttempts: 10,
    wait: () => new Promise(resolve => setTimeout(resolve, 3000)),
    inventoryCutoverLock: client.inventoryCutoverLock,
  });
  return {ok: outcome.state === 'readback_matched', state: outcome.state,
    code: outcome.response?.data?.code, idempotencyKey, after: outcome.after,
    message: outcome.state === 'readback_matched' ? '' : 'Inventory request is recorded; no repeat POST is permitted'};
}

async function loadProductsBySkc(client) {
  const products = new Map();
  for (let pageNum = 1; pageNum <= 100; pageNum += 1) {
    const response = await client.requestReadOnly('/open-api/openapi-business-backend/product/query', {
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

function lockPath(root, storeKey, skc) {
  const safe = `daily-inventory-${storeKey}-${skc}`.replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(process.env.SHEIN_BI_INVENTORY_SKU_LOCK_DIR || path.join(root, 'state', 'locks'), safe);
}

function asArray(value) {
  return value == null ? [] : Array.isArray(value) ? value : [value];
}
