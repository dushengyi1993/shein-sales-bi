#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  assertDailyInventoryExecutionAuthorization,
  canonicalInventoryKey,
  computeInventoryOverwriteQuantity,
  stableInventoryHash,
} from '../../lib/inventory_replenishment_policy.mjs';
import {SheinOpenApiClient, SHEIN_OPENAPI_BASE_URLS} from '../../lib/shein_openapi_client.mjs';
import {
  formatStoreIdentityError,
  openApiIdentityToStorageIdentity,
  storeIdentityMatchesMerchantOnly,
  validateStoreIdentity,
} from '../../lib/shein_store_identity.mjs';
import {acquireCrossProcessTicketLock} from '../../lib/cross_process_ticket_lock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TRUTH = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'store_account_truth.json'), 'utf8'));

function parseArgs(argv) {
  const args = {
    plan: '',
    policy: path.join(ROOT, 'config', 'inventory_replenishment_policy.json'),
    config: process.env.SHEIN_OPENAPI_CONFIG_FILE || path.join(ROOT, 'config', 'shein_openapi.local.json'),
    biData: path.join(ROOT, 'outputs', 'bi-portal', 'sections', 'inventoryTrend.json'),
    out: '',
    execute: false,
    executionMode: 'manual_review',
    confirmHash: '',
    maxRows: 500,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--plan') args.plan = path.resolve(argv[++i] || '');
    else if (a === '--policy') args.policy = path.resolve(argv[++i] || '');
    else if (a === '--config') args.config = path.resolve(argv[++i] || '');
    else if (a === '--bi-data') args.biData = path.resolve(argv[++i] || '');
    else if (a === '--out') args.out = path.resolve(argv[++i] || '');
    else if (a === '--max-rows') args.maxRows = Number(argv[++i]);
    else if (a === '--execute') args.execute = true;
    else if (a === '--dry-run') args.execute = false;
    else if (a === '--execution-mode') args.executionMode = String(argv[++i] || '');
    else if (a === '--confirm-hash') args.confirmHash = String(argv[++i] || '');
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.plan) throw new Error('--plan is required');
  if (!Number.isInteger(args.maxRows) || args.maxRows < 1 || args.maxRows > 1000) throw new Error('Invalid --max-rows');
  if (!args.out) args.out = path.join(ROOT, 'outputs', 'reports', `daily-inventory-replenishment-result-${Date.now()}.json`);
  return args;
}

const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const asArray = value => value == null ? [] : Array.isArray(value) ? value : [value];
const ageHours = value => (Date.now() - new Date(value || '').getTime()) / 3_600_000;

function findStoreConfig(config, storeKey) {
  const rows = Array.isArray(config?.stores)
    ? config.stores
    : Object.entries(config?.stores || {}).map(([key, value]) => ({storeKey: key, ...value}));
  return rows.find(row => String(row.storeKey || row.key || '').trim().toUpperCase() === storeKey);
}

async function createStoreClient(config, storeKey) {
  const store = findStoreConfig(config, storeKey);
  if (!store?.enabled || !store?.openKeyId || !store?.secretKey) throw new Error(`${storeKey} OpenAPI credentials unavailable`);
  const client = new SheinOpenApiClient({
    baseUrl: config.apiBaseUrls?.prodSemiManaged || SHEIN_OPENAPI_BASE_URLS.prodSemiManaged,
    openKeyId: store.openKeyId,
    secretKey: store.secretKey,
  });
  const response = await client.request('/open-api/openapi-business-backend/query-store-info', {method: 'POST', body: {}, headers: {language: 'en'}});
  if (String(response.data?.code) !== '0') throw new Error(`${storeKey} store identity query failed`);
  const identity = validateStoreIdentity({
    store,
    truth: TRUTH.stores?.[storeKey],
    storageIdentity: openApiIdentityToStorageIdentity(response.data),
    href: 'openapi:/open-api/openapi-business-backend/query-store-info',
    context: 'daily_inventory_replenishment',
  });
  if (!identity.ok && !storeIdentityMatchesMerchantOnly(identity)) throw new Error(formatStoreIdentityError(identity));
  return client;
}

async function readStock(client, skuCode) {
  const response = await client.request('/open-api/stock/stock-query', {
    method: 'POST',
    body: {skuCodeList: [skuCode], warehouseType: '2', invType: 'VI'},
    headers: {language: 'en'},
  });
  if (String(response.data?.code) !== '0') throw new Error(`stock-query failed: ${response.data?.code} ${response.data?.msg || ''}`);
  const row = asArray(response.data?.info)
    .flatMap(group => asArray(group?.goodsInventory))
    .flatMap(group => asArray(group?.skuList))
    .find(item => String(item?.skuCode || '') === skuCode);
  if (!row) throw new Error(`stock-query returned no row for ${skuCode}`);
  return {
    skuCode,
    totalInventoryQuantity: Number(row.totalInventoryQuantity || 0),
    totalUsableInventory: Number(row.totalUsableInventory || 0),
    totalLockedQuantity: Number(row.totalLockedQuantity || 0),
  };
}

async function assertStillListed(client, row) {
  const response = await client.request('/open-api/goods/spu-info', {
    method: 'POST',
    body: {spuName: row.spu, languageList: ['en']},
    headers: {language: 'en'},
  });
  if (String(response.data?.code) !== '0') throw new Error(`spu-info failed: ${response.data?.code} ${response.data?.msg || ''}`);
  const skc = asArray(response.data?.info?.skcInfoList).find(item => String(item?.skcName || '') === row.skc);
  if (!skc) throw new Error(`spu-info no longer contains ${row.skc}`);
  const shelf = asArray(skc.shelfStatusInfoList).find(item => String(item?.siteAbbr || '').toLowerCase() === 'shein-sa')
    || asArray(skc.shelfStatusInfoList)[0];
  const liveShelfStatus = String(shelf?.shelfStatus ?? '');
  const eligibleStatuses = new Set((policy.eligibleShelfStatusCodes || ['1']).map(String));
  if (!eligibleStatuses.has(liveShelfStatus)) throw new Error(`${row.skc} shelf status is no longer eligible: ${liveShelfStatus}`);
  const liveSkuCodes = new Set(asArray(skc.skuInfoList).map(item => String(item?.skuCode || '')).filter(Boolean));
  if (!liveSkuCodes.has(row.skuCode)) throw new Error(`${row.skc} SKU mapping changed`);
}

const args = parseArgs(process.argv.slice(2));
const [plan, policy, config, biDocument] = await Promise.all([readJson(args.plan), readJson(args.policy), readJson(args.config), readJson(args.biData)]);
const bi = biDocument?.data && typeof biDocument.data === 'object' ? biDocument.data : biDocument;
const biGeneratedAt = biDocument.cachedAt || biDocument.generatedAt || bi.generatedAt || bi.createdAt;
const biAge = ageHours(biGeneratedAt);
if (!Number.isFinite(biAge) || biAge < -0.25 || biAge > Number(policy.maxBiSnapshotAgeHours || 4)) {
  throw new Error(`BI/ET projection is stale: generatedAt=${biGeneratedAt || ''} ageHours=${biAge}`);
}
if (plan.policyVersion !== policy.policyVersion) throw new Error(`Plan policy version is stale: ${plan.policyVersion} vs ${policy.policyVersion}`);
const expectedHash = stableInventoryHash({
  schemaVersion: plan.schemaVersion,
  date: plan.date,
  policyVersion: plan.policyVersion,
  actionable: plan.actionable,
  sourceEvidence: asArray(plan.sourceEvidence).map(({ageHours: _ageHours, ...evidence}) => evidence),
});
if (expectedHash !== plan.payloadHash) throw new Error(`Plan payload hash mismatch: expected=${plan.payloadHash} actual=${expectedHash}`);
if (plan.executable !== true || asArray(plan.blockers).length) throw new Error('Plan is not executable');
const today = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date());
if (plan.date !== today) throw new Error(`Plan date is not current day: ${plan.date} vs ${today}`);
for (const evidence of asArray(plan.sourceEvidence)) {
  const maximumAge = String(evidence.store || '') === 'ET'
    ? Number(policy.maxBiSnapshotAgeHours || 4)
    : Number(policy.maxOpenApiSnapshotAgeHours || 2);
  const evidenceAge = ageHours(evidence.fetchedAt);
  if (!Number.isFinite(evidenceAge) || evidenceAge < -0.25 || evidenceAge > maximumAge) {
    throw new Error(`Plan source evidence is stale: ${evidence.store || evidence.file || 'unknown'} ageHours=${evidenceAge}`);
  }
}
const rows = asArray(plan.actionable).slice(0, args.maxRows);
if (args.execute) {
  assertDailyInventoryExecutionAuthorization({
    policy,
    mode: args.executionMode,
    context: process.env.SHEIN_BI_INVENTORY_AUTOMATION_CONTEXT || '',
    authorizationId: process.env.SHEIN_BI_INVENTORY_AUTOMATION_AUTHORIZATION || '',
    payloadHash: plan.payloadHash,
    confirmHash: args.confirmHash,
  });
}
const etByKey = new Map(asArray(bi?.inventoryDepletion?.products).map(row => [
  String(row.match_key || canonicalInventoryKey(row.standard_goods_sn)).toUpperCase(),
  row,
]));
const results = [];
const clients = new Map();
for (const row of rows) {
  const result = {storeKey: row.storeKey, skc: row.skc, skuCode: row.skuCode, canonical: row.canonical, state: 'planned'};
  try {
    const et = etByKey.get(String(row.matchKey || canonicalInventoryKey(row.canonical)).toUpperCase());
    const etQty = Number(et?.current_sellable_quantity ?? et?.et_estimated_available_qty);
    const etDate = String(
      String(et?.et_operational_stock_policy || '').includes('01_full_carton_exception')
        ? et?.et_box_snapshot_date
        : et?.et_store_snapshot_date,
    ).slice(0, 10);
    if (etDate !== today || String(et?.inventory_match_status || '') !== 'matched') throw new Error('ET inventory is not a current-day matched fact');
    if (etQty < Number(policy.minimumEtSellableForVirtualTopUp || 21)) throw new Error(`ET sellable inventory requires manual allocation: ${etQty}`);
    const approvedTarget = Number(row.targetUsableInventory);
    if (!Number.isInteger(approvedTarget) || approvedTarget < 1 || approvedTarget > Number(policy.targetUsableInventory || 100)) {
      throw new Error(`Invalid approved target usable inventory: ${row.targetUsableInventory}`);
    }
    if (etQty < approvedTarget) throw new Error(`ET sellable inventory dropped below approved target: ${etQty} < ${approvedTarget}`);
    if (!args.execute) {
      results.push({...result, state: 'dry_run_ready', etSellableInventory: etQty});
      continue;
    }
    let client = clients.get(row.storeKey);
    if (!client) {
      client = await createStoreClient(config, row.storeKey);
      clients.set(row.storeKey, client);
    }
    const lockFile = path.join(ROOT, 'state', 'locks', `daily-inventory-${row.storeKey}-${row.skc}`.replace(/[^A-Za-z0-9_.-]/g, '_'));
    const release = await acquireCrossProcessTicketLock(lockFile, {timeoutMs: 60_000, staleMs: 20 * 60_000});
    try {
      await assertStillListed(client, row);
      let before = await readStock(client, row.skuCode);
      if (before.totalUsableInventory > Number(policy.triggerUsableInventoryAtOrBelow || 20)) {
        results.push({...result, state: 'skipped_recovered', before});
        continue;
      }
      let after = before;
      const writes = [];
      for (let attempt = 1; attempt <= 2 && after.totalUsableInventory < approvedTarget; attempt += 1) {
        const overwrite = computeInventoryOverwriteQuantity(approvedTarget, after);
        const idempotencyKey = `bi-inv-${stableInventoryHash({planHash: plan.payloadHash, store: row.storeKey, sku: row.skuCode, overwrite, attempt}).slice(0, 42)}`;
        const response = await client.request('/open-api/stock/change-inventory/v2', {
          method: 'POST',
          body: {updateSkuInventoryQuantityRequests: [{
            idempotencyKey,
            skuCode: row.skuCode,
            invType: 'VI',
            changeType: 'OVERWRITE',
            changeQuantity: overwrite,
            changeReason: 'Owner-authorized daily low virtual inventory replenishment after current-day ET stock guard',
          }]},
          headers: {language: 'en'},
        });
        writes.push({
          attempt,
          overwrite,
          code: response.data?.code,
          msg: response.data?.msg || '',
          traceId: response.data?.traceId || '',
          success: response.data?.info?.success ?? null,
        });
        if (String(response.data?.code) !== '0' || response.data?.info?.success === false) {
          throw new Error(`inventory write failed: ${response.data?.code} ${response.data?.msg || ''}`);
        }
        for (let readbackAttempt = 1; readbackAttempt <= 10; readbackAttempt += 1) {
          await sleep(3000);
          after = await readStock(client, row.skuCode);
          if (after.totalUsableInventory >= approvedTarget) break;
        }
      }
      if (after.totalUsableInventory < approvedTarget) throw new Error(`readback usable inventory ${after.totalUsableInventory} below target ${approvedTarget}`);
      results.push({...result, state: 'updated_readback_matched', before, after, writes});
    } finally {
      await release();
    }
  } catch (error) {
    results.push({...result, state: 'blocked', error: error.message});
  }
  const interim = {schemaVersion: 'daily-inventory-replenishment-result/v1', generatedAt: new Date().toISOString(), planHash: plan.payloadHash, execute: args.execute, results};
  await fs.mkdir(path.dirname(args.out), {recursive: true});
  await fs.writeFile(`${args.out}.tmp`, `${JSON.stringify(interim, null, 2)}\n`, 'utf8');
  await fs.rename(`${args.out}.tmp`, args.out);
}
const counts = {
  total: results.length,
  updated: results.filter(row => row.state === 'updated_readback_matched').length,
  dryRunReady: results.filter(row => row.state === 'dry_run_ready').length,
  skipped: results.filter(row => row.state === 'skipped_recovered').length,
  blocked: results.filter(row => row.state === 'blocked').length,
};
if (results.length === 0) {
  const empty = {schemaVersion: 'daily-inventory-replenishment-result/v1', generatedAt: new Date().toISOString(), planHash: plan.payloadHash, execute: args.execute, results};
  await fs.mkdir(path.dirname(args.out), {recursive: true});
  await fs.writeFile(args.out, `${JSON.stringify(empty, null, 2)}\n`, 'utf8');
}
console.log(JSON.stringify({ok: counts.blocked === 0, planHash: plan.payloadHash, out: path.relative(ROOT, args.out).replaceAll(path.sep, '/'), counts}, null, 2));
if (counts.blocked) process.exitCode = 1;
