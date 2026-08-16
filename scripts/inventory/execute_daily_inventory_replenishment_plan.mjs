#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
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
import {
  appendDurableJournalRecord,
  classifyRecoveredInventoryIntent,
  inventoryRecoveryScopeKey,
  recoveredInventoryIntentMismatch,
  submitDurableInventoryWriteOnce,
} from '../../lib/durable_inventory_write.mjs';

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
const runDeadlineEpoch = Number(process.env.SHEIN_BI_INVENTORY_RUN_DEADLINE_EPOCH || 0);

function assertInventoryWriteWindow(runDate) {
  const currentDate = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date());
  if (currentDate !== runDate) throw new Error(`Inventory write date drifted across midnight: ${runDate} -> ${currentDate}`);
  if (Number.isFinite(runDeadlineEpoch) && runDeadlineEpoch > 0) {
    const remaining = runDeadlineEpoch - Math.floor(Date.now() / 1000);
    if (remaining < 60) throw new Error(`Inventory write safety window is exhausted: remainingSeconds=${remaining}`);
  }
}

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
// Hard per-run row ceiling: the plan must never be partially executed.
// Fail before the row loop, before any OpenAPI call and before the journal
// is created, so a plan larger than --max-rows produces zero writes.
const planActionableRows = asArray(plan.actionable);
if (planActionableRows.length > args.maxRows) {
  throw new Error(`Plan actionable rows ${planActionableRows.length} exceed the per-run row ceiling ${args.maxRows}; refusing partial execution before any write`);
}
const rows = planActionableRows;
const planRecoveryScopes = rows.map(row => inventoryRecoveryScopeKey({runDate: plan.date, storeKey: row.storeKey, skc: row.skc, skuCode: row.skuCode}));
if (new Set(planRecoveryScopes).size !== planRecoveryScopes.length) {
  throw new Error('Plan contains duplicate inventory recovery scope; refusing all writes');
}
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
let unresolvedIntents = [];
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
  unresolvedIntents,
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
const results = [];
const pendingIntents = new Map();
try {
  const journal = await fs.readFile(journalFile, 'utf8');
  if (journal && !journal.endsWith('\n')) throw new Error('INVENTORY_JOURNAL_TORN_TAIL');
  const lines = journal.split(/\r?\n/).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    try {
      const entry = JSON.parse(line);
      if (entry?.kind === 'intent' && entry?.logicalActionKey) {
        const intentId = entry.intentId || `legacy-${index}-${entry.logicalActionKey}`;
        pendingIntents.set(intentId, {...entry, intentId});
        continue;
      }
      if (entry?.kind === 'write_outcome' && entry?.intentId) {
        if (['rejected', 'readback_matched'].includes(entry.disposition)) pendingIntents.delete(entry.intentId);
        continue;
      }
      // Historical result rows are audit evidence only.  They are never
      // restored as current terminal state: every restart re-runs read-only
      // guards and performs a fresh stock readback under the SKU lock.
    } catch (error) {
      throw new Error(`INVENTORY_JOURNAL_INVALID_LINE:${index + 1}:${error.message}`);
    }
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
const appendJournalRecord = async entry => {
  await appendDurableJournalRecord(journalFile, entry);
};
if (!results.length) {
  const handle = await fs.open(journalFile, 'a', 0o600);
  await handle.close();
}
const recordResult = async (row, logicalActionKey = '') => {
  await appendJournalRecord({
    kind: 'result',
    sequence: results.length + 1,
    planHash: plan.payloadHash,
    logicalActionKey: logicalActionKey || undefined,
    recordedAt: new Date().toISOString(),
    row,
  });
  results.push(row);
};
// ET rows are bound by the alias-aware identity (resolveInventoryIdentityKey)
// exactly like the planner: explicitly separate products (KJ-102S vs KJ-102)
// must never share an ET row through a collapsed canonicalInventoryKey.
const etByKey = new Map(asArray(bi?.inventoryDepletion?.products).map(row => [
  String(
    resolveInventoryIdentityKey(row.standard_goods_sn || row.match_key || '')
    || canonicalInventoryKey(row.standard_goods_sn || row.match_key || ''),
  ).toUpperCase(),
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
  const matchKey = resolveInventoryIdentityKey(
    metrics.standard_goods_sn
    ?? metrics.standardGoodsSn
    ?? metrics.raw_goods_sn
    ?? metrics.rawGoodsSn,
  ) || canonicalInventoryKey(
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
const clients = new Map();
const pendingIntentsByScope = new Map();
for (const intent of pendingIntents.values()) {
  const scopeKey = intent?.recoveryScopeKey || inventoryRecoveryScopeKey({
    runDate: intent?.runDate,
    storeKey: intent?.storeKey,
    skc: intent?.skc,
    skuCode: intent?.skuCode,
  });
  if (!pendingIntentsByScope.has(scopeKey)) pendingIntentsByScope.set(scopeKey, []);
  pendingIntentsByScope.get(scopeKey).push(intent);
}
const currentPlanScopeSet = new Set(planRecoveryScopes);
unresolvedIntents = [...pendingIntentsByScope.entries()]
  .filter(([scopeKey]) => !currentPlanScopeSet.has(scopeKey))
  .flatMap(([scopeKey, intents]) => intents.map(intent => ({
    intentId: intent.intentId,
    recoveryScopeKey: scopeKey,
    logicalActionKey: intent.logicalActionKey,
    runDate: intent.runDate,
    storeKey: intent.storeKey,
    skc: intent.skc,
    skuCode: intent.skuCode,
    targetUsableInventory: intent.targetUsableInventory,
    planHash: intent.planHash,
    policyVersion: intent.policyVersion,
    authorizationId: intent.authorizationId,
    state: 'needs_manual_resolve',
    reason: 'durable intent scope is absent from the rebuilt current plan; duplicate submission and final success are forbidden',
  })));
if (unresolvedIntents.length) {
  for (const row of rows) {
    await recordResult({
      storeKey: row.storeKey,
      skc: row.skc,
      skuCode: row.skuCode,
      canonical: row.canonical,
      ruleClass: row.ruleClass,
      targetUsableInventory: Number(row.targetUsableInventory),
      state: 'needs_manual_resolve',
      error: `${unresolvedIntents.length} durable inventory intent(s) are absent from the rebuilt plan; no current-plan POST was attempted`,
    });
  }
}
for (const row of unresolvedIntents.length ? [] : rows) {
  const result = {
    storeKey: row.storeKey,
    skc: row.skc,
    skuCode: row.skuCode,
    canonical: row.canonical,
    ruleClass: row.ruleClass,
    targetUsableInventory: Number(row.targetUsableInventory),
    state: 'planned',
  };
  // Per-row catch scope: activeIntent must be declared outside the per-row
  // try.  A catch block cannot see `let` bindings declared inside its try
  // block, so an error before the durable intent would otherwise raise
  // `ReferenceError: activeIntent is not defined` instead of recording
  // `blocked` (production 2026.08.16.10 regression).
  let activeIntent = null;
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
    const logicalActionKey = stableInventoryHash({
      runDate: plan.date,
      store: row.storeKey,
      skc: row.skc,
      sku: row.skuCode,
      target: approvedTarget,
      actionType: 'VI_OVERWRITE_TO_EXACT_USABLE_TARGET',
      policyVersion: plan.policyVersion,
      authorizationId: executionAuthorization?.authorizationId || '',
    });
    const recoveryScopeKey = inventoryRecoveryScopeKey({runDate: plan.date, storeKey: row.storeKey, skc: row.skc, skuCode: row.skuCode});
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
      const scopeIntents = pendingIntentsByScope.get(recoveryScopeKey) || [];
      if (scopeIntents.length) {
        if (scopeIntents.length !== 1) {
          await recordResult({...result, logicalActionKey, state: 'needs_manual_resolve', before, error: `multiple durable inventory intents exist in recovery scope ${recoveryScopeKey}; duplicate submission forbidden`}, logicalActionKey);
          continue;
        }
        const [recoveredIntent] = scopeIntents;
        const mismatch = recoveredInventoryIntentMismatch(recoveredIntent, {
          logicalActionKey,
          plan,
          row,
          approvedTarget,
          authorizationId: executionAuthorization?.authorizationId || null,
        });
        if (mismatch) {
          await recordResult({
            ...result,
            logicalActionKey,
            state: 'needs_manual_resolve',
            before,
            idempotencyKey: recoveredIntent.idempotencyKey || null,
            requestPayloadHash: recoveredIntent.requestPayloadHash || null,
            error: `durable inventory intent does not belong to the current immutable plan: ${mismatch}; duplicate submission forbidden`,
          }, logicalActionKey);
          continue;
        }
        if (classifyRecoveredInventoryIntent(recoveredIntent, before.totalUsableInventory) === 'readback_matched') {
          const recoveredWrite = {
            attempt: 1,
            overwrite: recoveredIntent?.request?.body?.updateSkuInventoryQuantityRequests?.[0]?.changeQuantity,
            idempotencyKey: recoveredIntent.idempotencyKey,
            requestPayloadHash: recoveredIntent.requestPayloadHash,
            request: recoveredIntent.request,
            code: '0',
            msg: 'exact live readback matched after recovery of durable pre-submit intent',
            traceId: '',
            success: true,
            recoveredFromIntent: true,
          };
          await appendJournalRecord({
            kind: 'write_outcome',
            intentId: recoveredIntent.intentId,
            logicalActionKey,
            disposition: 'readback_matched',
            recordedAt: new Date().toISOString(),
          });
          pendingIntents.delete(recoveredIntent.intentId);
          await recordResult({...result, logicalActionKey, state: 'updated_readback_matched', before: recoveredIntent.before, after: before, writes: [recoveredWrite]}, logicalActionKey);
        } else {
          await recordResult({
            ...result,
            logicalActionKey,
            state: 'submitted_but_readback_pending',
            before,
            idempotencyKey: recoveredIntent.idempotencyKey,
            requestPayloadHash: recoveredIntent.requestPayloadHash,
            error: 'durable pre-submit intent exists and exact target is not visible; duplicate submission is forbidden',
          }, logicalActionKey);
        }
        continue;
      }
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
      const overwrite = computeInventoryOverwriteQuantity(approvedTarget, before);
      const idempotencyKey = `bi-inv-${logicalActionKey.slice(0, 42)}`;
      const request = {
        pathname: '/open-api/stock/change-inventory/v2',
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
      };
      const requestPayloadHash = stableInventoryHash(request);
      activeIntent = {
        kind: 'intent',
        intentId: randomUUID(),
        logicalActionKey,
        recoveryScopeKey,
        planHash: plan.payloadHash,
        runDate: plan.date,
        storeKey: row.storeKey,
        skc: row.skc,
        skuCode: row.skuCode,
        targetUsableInventory: approvedTarget,
        policyVersion: plan.policyVersion,
        authorizationId: executionAuthorization?.authorizationId || null,
        idempotencyKey,
        requestPayloadHash,
        request,
        before,
        recordedAt: new Date().toISOString(),
      };
      // Persist and fsync the exact immutable write intent before the network
      // call.  A crash after SHEIN accepts the request therefore leaves a
      // durable lock which recovery must read back; it can never invent a new
      // key or submit a second overwrite.
      assertInventoryWriteWindow(plan.date);
      // The live map shares the journal's intentId key (load and every delete
      // path use intentId), so terminal outcomes below actually release the
      // entry instead of leaving a stale pending record behind.
      pendingIntents.set(activeIntent.intentId, activeIntent);
      const submission = await submitDurableInventoryWriteOnce({
        journalFile,
        intent: activeIntent,
        // The write interface is called exactly once.  Read-only requests may
        // retry rate limits, but a write never retries at the transport layer;
        // the durable intent makes any unknown outcome readback-only.
        submit: () => {
          // Re-check immediately after the durable fsync and immediately
          // before the transport call; scheduler/disk stalls cannot carry a
          // request across midnight or below the readback safety reserve.
          assertInventoryWriteWindow(plan.date);
          return client.request(request.pathname, {
            method: request.method,
            body: request.body,
            headers: request.headers,
          });
        },
        readback: () => readStock(client, row.skuCode),
        wait: attempt => sleep(Math.min(3000, 500 * (2 ** (attempt - 2)))),
        maxReadbackAttempts: 10,
      });
      const response = submission.response;
      writes.push({
        attempt: 1,
        overwrite,
        idempotencyKey,
        requestPayloadHash,
        request,
        code: response?.data?.code,
        msg: response?.data?.msg || '',
        traceId: response?.data?.traceId || '',
        success: response?.data?.info?.success ?? null,
      });
      if (submission.state === 'rejected') {
        pendingIntents.delete(activeIntent.intentId);
        activeIntent = null;
        throw new Error(`inventory write failed: ${response?.data?.code} ${response?.data?.msg || ''}`);
      }
      if (submission.state === 'ambiguous_response') {
        await recordResult({...result, logicalActionKey, state: 'needs_manual_resolve', before, writes, error: 'inventory write response did not contain explicit code=0 and info.success=true; durable intent retained and duplicate submission forbidden'}, logicalActionKey);
        activeIntent = null;
        continue;
      }
      after = submission.after;
      if (submission.state === 'submitted_but_readback_pending') {
        await recordResult({...result, logicalActionKey, state: 'submitted_but_readback_pending', before, after, writes, error: `readback usable inventory ${after?.totalUsableInventory ?? 'unavailable'} does not match target ${approvedTarget}; duplicate submission forbidden`}, logicalActionKey);
        activeIntent = null;
        continue;
      }
      pendingIntents.delete(activeIntent.intentId);
      activeIntent = null;
      await recordResult({...result, logicalActionKey, state: 'updated_readback_matched', before, after, writes}, logicalActionKey);
    } finally {
      await release();
    }
  } catch (error) {
    if (activeIntent && error?.inventoryIntentDurable === true) {
      await recordResult({
        ...result,
        logicalActionKey: activeIntent.logicalActionKey,
        state: 'suspicious_write_attempted',
        idempotencyKey: activeIntent.idempotencyKey,
        requestPayloadHash: activeIntent.requestPayloadHash,
        error: `${error.message}; write intent is durable and automatic resubmission is forbidden`,
      }, activeIntent.logicalActionKey);
    } else {
      await recordResult({...result, state: 'blocked', error: error.message});
    }
  }
}
const unsafeResultCount = results.filter(row => ['blocked', 'submitted_but_readback_pending', 'suspicious_write_attempted', 'submitted_readback_failed', 'needs_manual_resolve'].includes(row.state)).length;
const counts = {
  total: results.length,
  updated: results.filter(row => row.state === 'updated_readback_matched').length,
  dryRunReady: results.filter(row => row.state === 'dry_run_ready').length,
  skipped: results.filter(row => row.state.startsWith('skipped_')).length,
  blocked: Math.max(unsafeResultCount, unresolvedIntents.length),
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
