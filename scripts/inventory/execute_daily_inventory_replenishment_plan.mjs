#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  assertDailyInventoryExecutionAuthorization,
  assertCurrentInventoryListingIdentity,
  canonicalInventoryKey,
  computeInventoryOverwriteQuantity,
  resolveInventoryIdentityKey,
  resolveInventoryShelfStatus,
  stableInventoryHash,
} from '../../lib/inventory_replenishment_policy.mjs';
import {SheinOpenApiClient, SHEIN_OPENAPI_BASE_URLS} from '../../lib/shein_openapi_client.mjs';
import {selectVirtualInventoryWarehouseCode} from '../../lib/shein_inventory_warehouse.mjs';
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
    linksData: path.join(ROOT, 'outputs', 'bi-portal', 'sections', 'linksData.json'),
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
    else if (a === '--links-data') args.linksData = path.resolve(argv[++i] || '');
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

function isRateLimitedResponse(response) {
  const code = String(response?.data?.code ?? '');
  const message = String(response?.data?.msg || '').toLowerCase();
  return code === '832213' || message.includes('限流') || message.includes('qps') || message.includes('rate limit');
}

async function requestWithRateLimitRetry(client, pathname, options, {maxAttempts = 4} = {}) {
  let response;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    response = await client.request(pathname, options);
    if (!isRateLimitedResponse(response) || attempt === maxAttempts) return response;
    await sleep(1500 * attempt);
  }
  return response;
}

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
  const response = await requestWithRateLimitRetry(client, '/open-api/openapi-business-backend/query-store-info', {method: 'POST', body: {}, headers: {language: 'en'}});
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
  const response = await requestWithRateLimitRetry(client, '/open-api/stock/stock-query', {
    method: 'POST',
    body: {skuCodeList: [skuCode], warehouseType: '2', invType: 'VI'},
    headers: {language: 'en'},
  });
  if (String(response.data?.code) !== '0') throw new Error(`stock-query failed: ${response.data?.code} ${response.data?.msg || ''}`);
  const row = asArray(response.data?.info)
    .flatMap(group => asArray(group?.goodsInventory))
    .flatMap(group => asArray(group?.skuList))
    .find(item => String(item?.skuCode || '') === skuCode);
  if (!row) {
    return {
      skuCode,
      totalInventoryQuantity: 0,
      totalUsableInventory: 0,
      totalLockedQuantity: 0,
      stockRowMissing: true,
      warehouseCodes: [],
    };
  }
  return {
    skuCode,
    totalInventoryQuantity: Number(row.totalInventoryQuantity || 0),
    totalUsableInventory: Number(row.totalUsableInventory || 0),
    totalLockedQuantity: Number(row.totalLockedQuantity || 0),
    stockRowMissing: false,
    warehouseCodes: asArray(row.warehouseInventoryList)
      .map(item => String(item?.warehouseCode || '').trim())
      .filter(Boolean),
  };
}

async function resolveMissingVirtualInventoryWarehouseCode(client) {
  const response = await requestWithRateLimitRetry(client, '/open-api/msc/warehouse/list', {
    method: 'GET',
    headers: {language: 'en'},
  });
  if (String(response.data?.code) !== '0') {
    throw new Error(`warehouse-list failed: ${response.data?.code} ${response.data?.msg || ''}`);
  }
  return selectVirtualInventoryWarehouseCode(response.data?.info, {site: 'shein-sa'});
}

async function assertStillListed(client, row) {
  const response = await requestWithRateLimitRetry(client, '/open-api/goods/spu-info', {
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
  const liveSkuCodes = asArray(skc.skuInfoList).map(item => String(item?.skuCode || '')).filter(Boolean);
  const liveSupplierCode = String(skc?.supplierCode || response.data?.info?.supplierCode || '').trim();
  assertCurrentInventoryListingIdentity({
    expectedMatchKey: row.canonical || row.supplierCode,
    expectedSkuCode: row.skuCode,
    liveSupplierCode,
    liveSkuCodes,
  });
}

const args = parseArgs(process.argv.slice(2));
const [plan, policy, config, biDocument, linksDocument] = await Promise.all([
  readJson(args.plan),
  readJson(args.policy),
  readJson(args.config),
  readJson(args.biData),
  readJson(args.linksData),
]);
const bi = biDocument?.data && typeof biDocument.data === 'object' ? biDocument.data : biDocument;
const links = linksDocument?.data && typeof linksDocument.data === 'object' ? linksDocument.data : linksDocument;
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
  lowEtAllocations: plan.lowEtAllocations,
  ...(plan.detailRefreshTargets ? {detailRefreshTargets: plan.detailRefreshTargets} : {}),
  sourceEvidence: asArray(plan.sourceEvidence).map(({ageHours: _ageHours, ...evidence}) => evidence),
  ...(plan.executionConstraints ? {executionConstraints: plan.executionConstraints} : {}),
});
if (expectedHash !== plan.payloadHash) throw new Error(`Plan payload hash mismatch: expected=${plan.payloadHash} actual=${expectedHash}`);
if (plan.executable !== true || asArray(plan.blockers).length) throw new Error('Plan is not executable');
const today = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date());
if (plan.date !== today) throw new Error(`Plan date is not current day: ${plan.date} vs ${today}`);
for (const evidence of asArray(plan.sourceEvidence)) {
  const evidenceStore = String(evidence.store || '');
  const maximumAge = evidenceStore === 'ET'
    ? Number(policy.maxBiSnapshotAgeHours || 4)
    : evidenceStore === 'BI_LINKS'
      ? Number(plan?.executionConstraints?.decreaseOnly
        ? policy?.lowEtFastGuard?.maxLinksSnapshotAgeHours || policy.maxLinksSnapshotAgeHours || 4
        : policy.maxLinksSnapshotAgeHours || 4)
      : Number(policy.maxOpenApiSnapshotAgeHours || 2);
  const evidenceAge = ageHours(evidence.fetchedAt);
  if (!Number.isFinite(evidenceAge) || evidenceAge < -0.25 || evidenceAge > maximumAge) {
    throw new Error(`Plan source evidence is stale: ${evidence.store || evidence.file || 'unknown'} ageHours=${evidenceAge}`);
  }
}
const currentSourceTimes = new Map([
  ['ET', biGeneratedAt],
  ['BI_LINKS', linksDocument.cachedAt || linksDocument.generatedAt || links.generatedAt || links.createdAt],
]);
for (const evidence of asArray(plan.sourceEvidence).filter(row => currentSourceTimes.has(String(row.store || '')))) {
  if (String(currentSourceTimes.get(String(evidence.store || '')) || '') !== String(evidence.fetchedAt || '')) {
    throw new Error(`Plan source changed after hash generation: ${evidence.store}`);
  }
}
const rows = asArray(plan.actionable).slice(0, args.maxRows);
if (plan?.executionConstraints?.decreaseOnly === true && rows.some(row => (
  Number(row.targetUsableInventory) >= Number(row.platformUsableInventory)
))) {
  throw new Error('Decrease-only safety plan contains a non-decrease action');
}
let executionAuthorization = null;
if (args.execute) {
  executionAuthorization = assertDailyInventoryExecutionAuthorization({
    policy,
    mode: args.executionMode,
    context: process.env.SHEIN_BI_INVENTORY_AUTOMATION_CONTEXT || '',
    authorizationId: process.env.SHEIN_BI_INVENTORY_AUTOMATION_AUTHORIZATION || '',
    payloadHash: plan.payloadHash,
    confirmHash: args.confirmHash,
  });
}
const resultEnvelope = currentResults => ({
  schemaVersion: 'daily-inventory-replenishment-result/v1',
  generatedAt: new Date().toISOString(),
  planHash: plan.payloadHash,
  policyVersion: plan.policyVersion,
  execute: args.execute,
  executionMode: args.execute ? executionAuthorization?.mode : 'dry_run',
  authorizationId: executionAuthorization?.authorizationId || null,
  authorizationContext: executionAuthorization?.context || null,
  executionConstraints: plan.executionConstraints || null,
  results: currentResults,
});
const writeResultFile = async currentResults => {
  const envelope = resultEnvelope(currentResults);
  await fs.mkdir(path.dirname(args.out), {recursive: true});
  await fs.writeFile(`${args.out}.tmp`, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  await fs.rename(`${args.out}.tmp`, args.out);
};
const journalFile = `${args.out}.journal.ndjson`;
await fs.mkdir(path.dirname(args.out), {recursive: true});
await fs.writeFile(journalFile, '', {encoding: 'utf8', mode: 0o600});
const recordResult = async row => {
  results.push(row);
  await fs.appendFile(journalFile, `${JSON.stringify({
    sequence: results.length,
    planHash: plan.payloadHash,
    recordedAt: new Date().toISOString(),
    row,
  })}\n`, {encoding: 'utf8', mode: 0o600});
};
const etByKey = new Map(asArray(bi?.inventoryDepletion?.products).map(row => [
  String(row.match_key || canonicalInventoryKey(row.standard_goods_sn)).toUpperCase(),
  row,
]));
const linkMetricRows = Array.isArray(links?.storeLinks)
  ? links.storeLinks
  : Array.isArray(links?.links) ? links.links : [];
const linkMetricsByKey = new Map(linkMetricRows.map(row => [
  `${String(row.store_key || row.storeKey || '').toUpperCase()}::${String(row.skc || '').trim()}`,
  row,
]));
const onShelfSkcsByStoreMatchKey = new Map();
for (const metrics of linkMetricRows) {
  if (resolveInventoryShelfStatus(metrics).code !== '1') continue;
  const matchKey = canonicalInventoryKey(
    metrics.standard_goods_sn
    ?? metrics.standardGoodsSn
    ?? metrics.raw_goods_sn
    ?? metrics.rawGoodsSn,
  );
  if (!matchKey) continue;
  const key = `${String(metrics.store_key || metrics.storeKey || '').toUpperCase()}::${matchKey}`;
  if (!onShelfSkcsByStoreMatchKey.has(key)) onShelfSkcsByStoreMatchKey.set(key, new Set());
  onShelfSkcsByStoreMatchKey.get(key).add(String(metrics.skc || ''));
}
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
    if (Number(row.etSellableInventory) !== etQty) throw new Error(`ET sellable inventory changed after plan: ${row.etSellableInventory} -> ${etQty}`);
    const approvedTarget = Number(row.targetUsableInventory);
    if (!Number.isInteger(approvedTarget) || approvedTarget < 0 || approvedTarget > Number(policy.targetUsableInventory || 100)) {
      throw new Error(`Invalid approved target usable inventory: ${row.targetUsableInventory}`);
    }
    const metrics = linkMetricsByKey.get(`${String(row.storeKey || '').toUpperCase()}::${String(row.skc || '').trim()}`);
    if (!metrics) throw new Error('Current 7-day link metrics are unavailable');
    const metricsIdentityKey = resolveInventoryIdentityKey(
      metrics.standard_goods_sn
      ?? metrics.standardGoodsSn
      ?? metrics.raw_goods_sn
      ?? metrics.rawGoodsSn,
    );
    const expectedIdentityKey = resolveInventoryIdentityKey(row.canonical || row.supplierCode);
    if (!metricsIdentityKey || !expectedIdentityKey || metricsIdentityKey !== expectedIdentityKey) {
      throw new Error('linksData canonical identity changed or is unavailable');
    }
    const currentShelfStatus = resolveInventoryShelfStatus(metrics, row.openApiShelfStatusCode || row.shelfStatusCode);
    if (currentShelfStatus.code !== String(row.shelfStatusCode || '')) {
      throw new Error(`Four-state shelf status changed after plan: ${row.shelfStatusName || row.shelfStatusCode} -> ${currentShelfStatus.name}`);
    }
    if (!new Set((policy.eligibleShelfStatusCodes || ['1', '3']).map(String)).has(currentShelfStatus.code)) {
      throw new Error(`Link is not inventory-relevant: ${currentShelfStatus.name}`);
    }
    const currentSameStoreOnShelfSkcs = [...(onShelfSkcsByStoreMatchKey.get(
      `${String(row.storeKey || '').toUpperCase()}::${String(row.matchKey || canonicalInventoryKey(row.canonical)).toUpperCase()}`,
    ) || [])]
      .filter(skc => skc && skc !== String(row.skc || ''))
      .sort();
    if (
      currentShelfStatus.code === String(policy.soldOutShelfStatusCode || '3')
      && policy.ignoreSoldOutWhenSameStoreHasOnShelfCanonical !== false
      && currentSameStoreOnShelfSkcs.length > 0
    ) {
      throw new Error(`Sold-out link is superseded by same-store on-shelf link(s): ${currentSameStoreOnShelfSkcs.join(',')}`);
    }
    if (JSON.stringify(currentSameStoreOnShelfSkcs) !== JSON.stringify([...asArray(row.sameStoreOnShelfSkcs)].sort())) {
      throw new Error('Same-store on-shelf link evidence changed after plan');
    }
    if (Number(metrics.c7_sale_cnt) !== Number(row.c7SaleCount) || Number(metrics.c7_eps_uv) !== Number(row.c7Exposure)) {
      throw new Error('7-day sales/exposure evidence changed after plan');
    }
    if (row.ruleClass === 'low_et_top_exposure_allocation') {
      if (etQty > Number(policy.lowEtAllocationAtOrBelow ?? 10)) throw new Error(`ET no longer requires physical allocation: ${etQty}`);
      if (etQty < Number(row.plannedAllocationTotal || 0)) {
        throw new Error(`ET sellable inventory dropped below planned allocation total: ${etQty} < ${row.plannedAllocationTotal}`);
      }
    } else {
      if (etQty < Number(policy.minimumEtSellableForVirtualTopUp || 11)) throw new Error(`ET sellable inventory requires physical allocation: ${etQty}`);
      if (etQty < approvedTarget) throw new Error(`ET sellable inventory dropped below approved target: ${etQty} < ${approvedTarget}`);
      if (row.ruleClass === 'recent_sale_scarcity' && Number(metrics.c7_sale_cnt) < Number(policy?.recentSaleScarcity?.minimumSaleCount ?? 1)) {
        throw new Error('Link no longer qualifies for recent-sale scarcity inventory');
      }
      if (row.ruleClass === 'legacy_virtual_inventory_top_up' && Number(metrics.c7_sale_cnt) >= Number(policy?.recentSaleScarcity?.minimumSaleCount ?? 1)) {
        throw new Error('Link now qualifies for recent-sale scarcity inventory; rebuild plan');
      }
    }
    if (!args.execute) {
      await recordResult({...result, state: 'dry_run_ready', etSellableInventory: etQty});
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
      if (before.totalUsableInventory === approvedTarget) {
        await recordResult({...result, state: 'skipped_target_already_matched', before});
        continue;
      }
      if (plan?.executionConstraints?.decreaseOnly === true && before.totalUsableInventory < approvedTarget) {
        await recordResult({...result, state: 'skipped_safety_no_increase', before});
        continue;
      }
      if (row.ruleClass === 'recent_sale_scarcity') {
        const refillBelow = Number(policy?.recentSaleScarcity?.refillWhenBelow ?? 5);
        const capAbove = Number(policy?.recentSaleScarcity?.capWhenAbove ?? 10);
        if (before.totalUsableInventory >= refillBelow && before.totalUsableInventory <= capAbove) {
          await recordResult({...result, state: 'skipped_within_scarcity_band', before});
          continue;
        }
      } else if (row.ruleClass === 'legacy_virtual_inventory_top_up') {
        if (before.totalUsableInventory > Number(policy.triggerUsableInventoryAtOrBelow || 20)) {
          await recordResult({...result, state: 'skipped_recovered', before});
          continue;
        }
      }
      const warehouseCode = before.stockRowMissing
        ? await resolveMissingVirtualInventoryWarehouseCode(client)
        : '';
      let after = before;
      const writes = [];
      for (let attempt = 1; attempt <= 2 && after.totalUsableInventory !== approvedTarget; attempt += 1) {
        const overwrite = computeInventoryOverwriteQuantity(approvedTarget, after);
        const idempotencyKey = `bi-inv-${stableInventoryHash({planHash: plan.payloadHash, store: row.storeKey, sku: row.skuCode, target: approvedTarget, overwrite, attempt}).slice(0, 42)}`;
        const response = await requestWithRateLimitRetry(client, '/open-api/stock/change-inventory/v2', {
          method: 'POST',
          body: {updateSkuInventoryQuantityRequests: [{
            idempotencyKey,
            skuCode: row.skuCode,
            invType: 'VI',
            ...(warehouseCode ? {warehouseCode} : {}),
            changeType: 'OVERWRITE',
            changeQuantity: overwrite,
            changeReason: plan?.executionConstraints?.decreaseOnly
              ? 'Owner-authorized ET low-inventory safety reduction after current-day ET guard'
              : 'Owner-authorized daily inventory target after current-day ET and sales/exposure guard',
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
          if (readbackAttempt > 1) await sleep(Math.min(3000, 500 * (2 ** (readbackAttempt - 2))));
          after = await readStock(client, row.skuCode);
          if (after.totalUsableInventory === approvedTarget) break;
        }
      }
      if (after.totalUsableInventory !== approvedTarget) throw new Error(`readback usable inventory ${after.totalUsableInventory} does not match target ${approvedTarget}`);
      await recordResult({...result, state: 'updated_readback_matched', before, after, writes});
    } finally {
      await release();
    }
  } catch (error) {
    await recordResult({...result, state: 'blocked', error: error.message});
  }
}
const counts = {
  total: results.length,
  updated: results.filter(row => row.state === 'updated_readback_matched').length,
  dryRunReady: results.filter(row => row.state === 'dry_run_ready').length,
  skipped: results.filter(row => row.state.startsWith('skipped_')).length,
  blocked: results.filter(row => row.state === 'blocked').length,
};
// Per-row progress is append-only in the journal. Publish the complete JSON
// envelope exactly once so result-file IO stays O(N), not O(N²).
await writeResultFile(results);
console.log(JSON.stringify({
  ok: counts.blocked === 0,
  planHash: plan.payloadHash,
  out: path.relative(ROOT, args.out).replaceAll(path.sep, '/'),
  journal: path.relative(ROOT, journalFile).replaceAll(path.sep, '/'),
  counts,
}, null, 2));
if (counts.blocked) process.exitCode = 1;
