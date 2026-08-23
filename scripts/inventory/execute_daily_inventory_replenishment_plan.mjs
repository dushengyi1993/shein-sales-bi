#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {
  assertDailyInventoryExecutionAuthorization,
  assertCurrentInventoryListingIdentity,
  buildDailyInventoryPlanHashPayload,
  canonicalInventoryKey,
  computeInventoryOverwriteQuantity,
  INVENTORY_OVERWRITE_COMPUTATION_VERSION,
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
  discoverInventoryJournalFiles,
  inventoryIntentScopeKey,
  inventoryRecoveryScopeKey,
  readInventoryIntentJournals,
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
    reconcilePendingOnly: false,
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
    else if (a === '--reconcile-pending-only') args.reconcilePendingOnly = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.plan) throw new Error('--plan is required');
  if (!Number.isInteger(args.maxRows) || args.maxRows < 1 || args.maxRows > 1000) throw new Error('Invalid --max-rows');
  if (args.reconcilePendingOnly && !args.execute) throw new Error('--reconcile-pending-only requires --execute');
  if (!args.out) args.out = path.join(ROOT, 'outputs', 'reports', `daily-inventory-replenishment-result-${Date.now()}.json`);
  return args;
}

const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const asArray = value => value == null ? [] : Array.isArray(value) ? value : [value];
const ageHours = value => (Date.now() - new Date(value || '').getTime()) / 3_600_000;
const runDeadlineEpoch = Number(process.env.SHEIN_BI_INVENTORY_RUN_DEADLINE_EPOCH || 0);
const etText = value => String(value ?? '').trim();
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const isCount = value => value !== '' && value != null && Number.isInteger(Number(value)) && Number(value) >= 0;

async function readControlledEtFile(file, label) {
  const relative = etText(file).replaceAll('\\', '/');
  if (!relative || path.isAbsolute(relative) || !relative.startsWith('outputs/et-forwarder/')) {
    throw new Error(`${label} path is outside outputs/et-forwarder`);
  }
  const root = await fs.realpath(path.join(ROOT, 'outputs', 'et-forwarder'));
  const candidate = path.resolve(ROOT, relative);
  const stat = await fs.lstat(candidate);
  if (!stat.isFile()) throw new Error(`${label} is not a regular file`);
  const real = await fs.realpath(candidate);
  if (real !== root && !real.startsWith(`${root}${path.sep}`)) throw new Error(`${label} realpath escapes outputs/et-forwarder`);
  const bytes = await fs.readFile(real);
  return {relative, real, bytes, hash: sha256(bytes), json: JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''))};
}

function etEvidenceHash(fact) {
  return stableInventoryHash({
    schemaVersion: 'et-low-inventory-evidence/v1',
    manifestHash: etText(fact.manifestHash).toLowerCase(),
    batchId: etText(fact.batchId),
    targetDate: etText(fact.targetDate),
    endpoints: ['store_stock', 'box_stock'].map(endpoint => {
      const file = fact.files?.[endpoint] || {};
      return {
        endpoint,
        path: etText(file.path),
        hash: etText(file.hash).toLowerCase(),
        rowCount: isCount(file.rowCount) ? Number(file.rowCount) : null,
        count: isCount(file.count) ? Number(file.count) : null,
        rawRowCount: isCount(file.rawRowCount) ? Number(file.rawRowCount) : null,
        pageCount: isCount(file.pageCount) ? Number(file.pageCount) : null,
        fetchedAt: etText(file.fetchedAt),
        complete: file.complete === true,
      };
    }),
  });
}

function assertFreshEtTimestamp(value, targetDate, maxAgeSeconds, label) {
  const timestamp = new Date(value || '').getTime();
  const date = Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date(timestamp))
    : '';
  const ageSeconds = (Date.now() - timestamp) / 1000;
  if (date !== targetDate || !Number.isFinite(ageSeconds) || ageSeconds < -300 || ageSeconds > maxAgeSeconds) {
    throw new Error(`${label} freshness is invalid`);
  }
}

async function validateEtSafetyFact(plan) {
  const fact = plan.etFactSource;
  const constraints = plan.executionConstraints;
  const etEvidence = asArray(plan.sourceEvidence).filter(row => row.store === 'ET' && row.authoritative === true);
  if (fact?.schemaVersion !== 'et-low-inventory-fact-source/v1' || fact?.kind !== 'et_forwarder_manifest') {
    throw new Error('ET safety fact source schema/kind is invalid');
  }
  if (constraints?.mode !== 'et_low_inventory_safety' || constraints.decreaseOnly !== true
    || etEvidence.length !== 1 || etEvidence[0].source !== 'et_forwarder_manifest') {
    throw new Error('ET safety constraints/sourceEvidence binding is invalid');
  }
  const evidence = etEvidence[0];
  const boundFields = ['batchId', 'targetDate', 'manifestHash', 'inventoryEvidenceHash', 'completeInventoryEvidence', 'maxAgeSeconds'];
  if (boundFields.some(field => etText(evidence[field]) !== etText(fact[field]))) throw new Error('ET safety sourceEvidence differs from etFactSource');
  if (etText(evidence.file) !== etText(fact.manifestPath)
    || etText(evidence.fetchedAt) !== etText(fact.createdAt)
    || stableInventoryHash(evidence.sourceFiles) !== stableInventoryHash(fact.files)
    || stableInventoryHash(evidence.endpointRows) !== stableInventoryHash(fact.endpointRows)
    || etText(constraints.triggerBatchId) !== etText(fact.batchId)
    || etText(constraints.triggerTargetDate) !== etText(fact.targetDate)
    || etText(constraints.triggerManifestHash).toLowerCase() !== etText(fact.manifestHash).toLowerCase()
    || Number(constraints.maximumEtSellableInventory) !== 10
    || fact.targetDate !== plan.date || fact.completeInventoryEvidence !== true || Number(fact.invalidRows) !== 0) {
    throw new Error('ET safety immutable source binding is invalid');
  }
  const manifestFile = await readControlledEtFile(fact.manifestPath, 'ET manifest');
  if (manifestFile.hash !== etText(fact.manifestHash).toLowerCase()) throw new Error('ET manifest hash changed after plan');
  const pointerRef = etText(fact.pointerPath).replaceAll('\\', '/');
  if (!pointerRef || path.isAbsolute(pointerRef) || !pointerRef.startsWith('outputs/et-forwarder/')) {
    throw new Error('ET manifest pointer path is invalid');
  }
  if (path.resolve(ROOT, pointerRef) !== path.resolve(ROOT, manifestFile.relative)) {
    const pointer = await readControlledEtFile(pointerRef, 'ET manifest pointer');
    if (!etText(pointer.json?.manifestPath)) throw new Error('ET manifest pointer target is missing');
    const target = await readControlledEtFile(pointer.json.manifestPath, 'ET manifest pointer target');
    if (target.real !== manifestFile.real || ['batchId', 'targetDate', 'createdAt'].some(field => etText(pointer.json[field]) !== etText(fact[field]))
      || pointer.json.ok !== true || pointer.json.mode !== 'daily') throw new Error('ET manifest pointer drifted after plan');
  }
  const manifest = manifestFile.json;
  const maxAgeSeconds = Number(fact.maxAgeSeconds);
  if (manifest.ok !== true || manifest.mode !== 'daily'
    || ['batchId', 'targetDate', 'createdAt'].some(field => etText(manifest[field]) !== etText(fact[field]))
    || !Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 1 || maxAgeSeconds > 21600) {
    throw new Error('ET manifest identity/freshness is invalid');
  }
  assertFreshEtTimestamp(fact.createdAt, fact.targetDate, maxAgeSeconds, 'ET manifest');
  for (const endpoint of ['store_stock', 'box_stock']) {
    const bound = fact.files?.[endpoint];
    const meta = manifest.endpoints?.[endpoint];
    const relative = etText(manifest.files?.[endpoint]);
    if (!bound || !relative || meta?.kind !== 'snapshot' || bound.complete !== true
      || meta.stoppedByOverlap !== false || meta.stoppedByDailyInitialCap !== false) {
      throw new Error(`ET ${endpoint} completeness binding is invalid`);
    }
    const manifestDir = path.dirname(manifestFile.real);
    const declaredPath = path.resolve(manifestDir, relative);
    if (path.isAbsolute(relative) || (declaredPath !== manifestDir && !declaredPath.startsWith(`${manifestDir}${path.sep}`))) {
      throw new Error(`ET ${endpoint} manifest path is invalid`);
    }
    const declaredFile = await readControlledEtFile(path.relative(ROOT, declaredPath), `ET manifest ${endpoint}`);
    const endpointFile = await readControlledEtFile(bound.path, `ET ${endpoint}`);
    if (endpointFile.real !== declaredFile.real || endpointFile.hash !== etText(bound.hash).toLowerCase()) {
      throw new Error(`ET ${endpoint} file/hash differs from manifest binding`);
    }
    const doc = endpointFile.json;
    const pages = Array.isArray(doc.pages) ? doc.pages : [];
    const rows = Array.isArray(doc.rows) ? doc.rows : [];
    const rowCounts = [bound.rowCount, bound.count, bound.rawRowCount, fact.endpointRows?.[endpoint],
      meta.rowCount, meta.count, meta.rawRowCount, doc.count, doc.rawRowCount];
    const pageCounts = [bound.pageCount, meta.pages];
    if (doc.endpoint !== endpoint || etText(doc.fetchedAt) !== etText(bound.fetchedAt)
      || !Array.isArray(doc.rows) || pages.length < 1
      || rowCounts.some(value => !isCount(value) || Number(value) !== rows.length)
      || pageCounts.some(value => !isCount(value) || Number(value) !== pages.length)
      || pages.some(page => !isCount(page?.rows) || Number(page.count) !== Number(meta.count))
      || pages.reduce((sum, page) => sum + Number(page.rows), 0) !== rows.length) {
      throw new Error(`ET ${endpoint} endpoint completeness metadata drifted`);
    }
    assertFreshEtTimestamp(bound.fetchedAt, fact.targetDate, maxAgeSeconds, `ET ${endpoint}`);
  }
  if (etText(fact.inventoryEvidenceHash).toLowerCase() !== etEvidenceHash(fact)) throw new Error('ET inventoryEvidenceHash mismatch');
}

function etRowsFromSafetyAllocations(plan) {
  const actionable = asArray(plan.actionable);
  if (!actionable.length) return new Map();
  const allocations = asArray(plan.lowEtAllocations);
  const exact = new Map();
  const facts = new Map();
  for (const allocation of allocations) {
    const exactKey = `${etText(allocation.storeKey).toUpperCase()}::${etText(allocation.skc)}::${etText(allocation.skuCode)}`;
    if (!allocation.storeKey || !allocation.skc || !allocation.skuCode || exact.has(exactKey)) throw new Error('ET low allocation identity is missing or duplicated');
    exact.set(exactKey, allocation);
    const matchKey = etText(allocation.matchKey).toUpperCase();
    const canonicalKey = etText(resolveInventoryIdentityKey(allocation.canonical) || canonicalInventoryKey(allocation.canonical)).toUpperCase();
    const quantity = Number(allocation.etSellableInventory);
    const snapshotDate = etText(allocation.etSnapshotDate).slice(0, 10);
    const fact = `${quantity}::${snapshotDate}`;
    if (!matchKey || canonicalKey !== matchKey || !Number.isInteger(quantity) || quantity < 0 || snapshotDate !== plan.date
      || (facts.has(matchKey) && facts.get(matchKey) !== fact)) throw new Error(`ET low allocation fact conflicts for ${matchKey || '(missing)'}`);
    facts.set(matchKey, fact);
  }
  const rows = new Map();
  for (const row of actionable) {
    const allocation = exact.get(`${etText(row.storeKey).toUpperCase()}::${etText(row.skc)}::${etText(row.skuCode)}`);
    const fields = ['matchKey', 'canonical', 'etSellableInventory', 'etSnapshotDate', 'plannedAllocationTotal', 'targetUsableInventory'];
    if (row.ruleClass !== 'low_et_top_exposure_allocation' || !allocation
      || fields.some(field => etText(allocation[field]) !== etText(row[field]))) throw new Error('ET actionable does not match its exact lowEtAllocation');
    rows.set(etText(row.matchKey || canonicalInventoryKey(row.canonical)).toUpperCase(), {
      current_sellable_quantity: Number(allocation.etSellableInventory),
      et_store_snapshot_date: etText(allocation.etSnapshotDate).slice(0, 10),
      inventory_match_status: 'matched',
    });
  }
  return rows;
}

function isValidCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

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
// Recovery-only adjudicates a write that already crossed the transport
// boundary. Requiring mutable ET/links decision snapshots here can strand the
// durable intent forever; the immutable plan/intent and fresh live identity +
// stock readback below are the only relevant evidence, and no new write path
// is reachable in this mode.
const plan = await readJson(args.plan);
const isEtLowInventorySafetyPlan = plan.schemaVersion === 'et-low-inventory-safety-plan/v1';
const [policy, config, biDocument, linksDocument] = await Promise.all([
  readJson(args.policy),
  readJson(args.config),
  args.reconcilePendingOnly || isEtLowInventorySafetyPlan ? Promise.resolve({}) : readJson(args.biData),
  args.reconcilePendingOnly ? Promise.resolve({}) : readJson(args.linksData),
]);
const bi = biDocument?.data && typeof biDocument.data === 'object' ? biDocument.data : biDocument;
const links = linksDocument?.data && typeof linksDocument.data === 'object' ? linksDocument.data : linksDocument;
const biGeneratedAt = biDocument.cachedAt || biDocument.generatedAt || bi.generatedAt || bi.createdAt;
const biAge = ageHours(biGeneratedAt);
if (!args.reconcilePendingOnly && !isEtLowInventorySafetyPlan
  && (!Number.isFinite(biAge) || biAge < -0.25 || biAge > Number(policy.maxBiSnapshotAgeHours || 4))) {
  throw new Error(`BI/ET projection is stale: generatedAt=${biGeneratedAt || ''} ageHours=${biAge}`);
}
const today = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date());
if (!isValidCalendarDate(plan.date)) throw new Error(`Plan date is invalid: ${plan.date}`);
if (plan.date > today) throw new Error(`Plan date is in the future: ${plan.date} vs ${today}`);
const historicalReconcileOnly = args.reconcilePendingOnly && plan.date < today;
if (plan.policyVersion !== policy.policyVersion && !historicalReconcileOnly) {
  throw new Error(`Plan policy version is stale: ${plan.policyVersion} vs ${policy.policyVersion}`);
}
const expectedHash = isEtLowInventorySafetyPlan
  ? stableInventoryHash({
      schemaVersion: plan.schemaVersion,
      date: plan.date,
      policyVersion: plan.policyVersion,
      actionable: plan.actionable,
      lowEtAllocations: plan.lowEtAllocations,
      etFactSource: plan.etFactSource,
      sourceEvidence: asArray(plan.sourceEvidence).map(({
        ageHours: _ageHours,
        manifestAgeSeconds: _manifestAgeSeconds,
        endpointAgeSeconds: _endpointAgeSeconds,
        ...evidence
      }) => evidence),
      ...(plan.executionConstraints ? {executionConstraints: plan.executionConstraints} : {}),
    })
  : stableInventoryHash(buildDailyInventoryPlanHashPayload(plan));
if (expectedHash !== plan.payloadHash) throw new Error(`Plan payload hash mismatch: expected=${plan.payloadHash} actual=${expectedHash}`);
if (plan.executable !== true || asArray(plan.blockers).length) throw new Error('Plan is not executable');
if (!args.reconcilePendingOnly && plan.date !== today) throw new Error(`Plan date is not current day: ${plan.date} vs ${today}`);
if (!args.reconcilePendingOnly && isEtLowInventorySafetyPlan) await validateEtSafetyFact(plan);
const safetyEtRows = !args.reconcilePendingOnly && isEtLowInventorySafetyPlan ? etRowsFromSafetyAllocations(plan) : null;
for (const evidence of (args.reconcilePendingOnly ? [] : asArray(plan.sourceEvidence))
  .filter(row => !(isEtLowInventorySafetyPlan && row.store === 'ET_PORTAL_PROJECTION_DIAGNOSTIC'))) {
  const evidenceStore = String(evidence.store || '');
  const maximumAge = evidenceStore === 'ET'
    ? Number(isEtLowInventorySafetyPlan ? plan.etFactSource.maxAgeSeconds / 3600 : policy.maxBiSnapshotAgeHours || 4)
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
  ['BI_LINKS', linksDocument.cachedAt || linksDocument.generatedAt || links.generatedAt || links.createdAt],
]);
if (!isEtLowInventorySafetyPlan) currentSourceTimes.set('ET', biGeneratedAt);
for (const evidence of (args.reconcilePendingOnly ? [] : asArray(plan.sourceEvidence)).filter(row => currentSourceTimes.has(String(row.store || '')))) {
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
let deferredHistoricalIntents = [];
const resultEnvelope = currentResults => ({
  schemaVersion: 'daily-inventory-replenishment-result/v1',
  generatedAt: new Date().toISOString(),
  planHash: plan.payloadHash,
  policyVersion: plan.policyVersion,
  execute: args.execute,
  reconcilePendingOnly: args.reconcilePendingOnly,
  executionMode: args.execute ? executionAuthorization?.mode : 'dry_run',
  authorizationId: executionAuthorization?.authorizationId || null,
  authorizationContext: executionAuthorization?.context || null,
  executionConstraints: plan.executionConstraints || null,
  // A historical intent omitted from today's rebuilt plan has no current
  // write to suppress. Keep the unresolved warning visible for audit and
  // future reappearance interception, but do not turn it into a run blocker.
  deferredHistorical: deferredHistoricalIntents,
  // Keep the established validator contract: only a current-plan unresolved
  // intent belongs here. Historical scopes absent from this plan are warnings
  // in deferredHistorical and must not fail the morning chain.
  unresolvedIntents: [],
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
// A current result keeps its sidecar for compatibility. This executor is
// shared by daily replenishment and ET low-inventory runs; their journals use
// different prefixes but are isolated in their own result directories. Every
// sidecar in this directory therefore belongs to the same inventory write
// domain and must participate in cross-day recovery without moving or
// rewriting the original append-only journal.
const journalFiles = await discoverInventoryJournalFiles(journalFile, {includeAll: true});
const journalBundle = await readInventoryIntentJournals(journalFiles, {maxRunDate: today});
const pendingIntents = new Map(journalBundle.pending);
const inventoryIntents = new Map(journalBundle.intents);
const terminalIntentOutcomes = new Map(journalBundle.terminalOutcomes);
const journalIntentKey = intent => `${path.resolve(intent?.journalFile || journalFile)}\u0000${intent?.intentId || ''}`;
const appendJournalRecord = async (entry, targetJournalFile = journalFile) => {
  await appendDurableJournalRecord(targetJournalFile, entry);
};
const inventoryIntentEntriesByScope = new Map();
for (const [intentKey, intent] of inventoryIntents.entries()) {
  const scopeKey = inventoryIntentScopeKey(intent);
  if (!inventoryIntentEntriesByScope.has(scopeKey)) inventoryIntentEntriesByScope.set(scopeKey, []);
  inventoryIntentEntriesByScope.get(scopeKey).push({intentKey, intent});
}
// An older pending intent may be released without stock inference only when
// the complete journal set proves one unambiguous later intent in the same
// date-independent item scope and that exact later intent already has a
// terminal readback_matched outcome. The supersede outcome is append-only in
// the older intent's original journal and records the exact later evidence.
if (args.execute) {
  for (const [pendingKey, olderIntent] of [...pendingIntents.entries()]) {
    const scopeKey = inventoryIntentScopeKey(olderIntent);
    const strictlyLater = (inventoryIntentEntriesByScope.get(scopeKey) || [])
      .filter(({intent}) => intent.runDate > olderIntent.runDate);
    if (strictlyLater.length !== 1) continue;
    const [{intentKey: laterKey, intent: laterIntent}] = strictlyLater;
    const laterOutcome = terminalIntentOutcomes.get(laterKey);
    const laterRecordedAt = String(laterOutcome?.recordedAt || '');
    if (laterOutcome?.disposition !== 'readback_matched' || !Number.isFinite(new Date(laterRecordedAt).getTime())) continue;
    const supersedeRecordedAt = new Date().toISOString();
    if (new Date(supersedeRecordedAt).getTime() < new Date(laterRecordedAt).getTime()) continue;
    const supersedeOutcome = {
      kind: 'write_outcome',
      intentId: olderIntent.intentId,
      logicalActionKey: olderIntent.logicalActionKey,
      disposition: 'superseded_by_later_readback',
      recordedAt: supersedeRecordedAt,
      supersededByIntentId: laterIntent.intentId,
      supersededByRunDate: laterIntent.runDate,
      supersededByRecordedAt: laterRecordedAt,
    };
    await appendJournalRecord(supersedeOutcome, olderIntent.journalFile);
    pendingIntents.delete(pendingKey);
    terminalIntentOutcomes.set(pendingKey, {
      ...supersedeOutcome,
      journalFile: olderIntent.journalFile,
      journalDate: olderIntent.journalDate || olderIntent.runDate,
    });
  }
}
const currentInventoryIntents = new Map([...inventoryIntents].filter(([, intent]) => intent.journalFile === path.resolve(journalFile)));
const currentPendingIntents = new Map([...pendingIntents].filter(([, intent]) => intent.journalFile === path.resolve(journalFile)));
const currentTerminalIntentOutcomes = new Map([...terminalIntentOutcomes].filter(([, outcome]) => outcome.journalFile === path.resolve(journalFile)));
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
const etByKey = isEtLowInventorySafetyPlan
  ? safetyEtRows || new Map()
  : new Map(asArray(bi?.inventoryDepletion?.products).map(row => [
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
  const scopeKey = inventoryIntentScopeKey({
    storeKey: intent?.storeKey,
    skc: intent?.skc,
    skuCode: intent?.skuCode,
  });
  if (!pendingIntentsByScope.has(scopeKey)) pendingIntentsByScope.set(scopeKey, []);
  pendingIntentsByScope.get(scopeKey).push(intent);
}
const inventoryIntentsByScope = new Map();
for (const intent of inventoryIntents.values()) {
  const scopeKey = inventoryIntentScopeKey({
    storeKey: intent?.storeKey,
    skc: intent?.skc,
    skuCode: intent?.skuCode,
  });
  if (!inventoryIntentsByScope.has(scopeKey)) inventoryIntentsByScope.set(scopeKey, []);
  inventoryIntentsByScope.get(scopeKey).push(intent);
}
const currentInventoryIntentsByScope = new Map();
for (const intent of currentInventoryIntents.values()) {
  const scopeKey = inventoryIntentScopeKey({storeKey: intent?.storeKey, skc: intent?.skc, skuCode: intent?.skuCode});
  if (!currentInventoryIntentsByScope.has(scopeKey)) currentInventoryIntentsByScope.set(scopeKey, []);
  currentInventoryIntentsByScope.get(scopeKey).push(intent);
}
const currentPendingIntentsByScope = new Map();
for (const intent of currentPendingIntents.values()) {
  const scopeKey = inventoryIntentScopeKey({storeKey: intent?.storeKey, skc: intent?.skc, skuCode: intent?.skuCode});
  if (!currentPendingIntentsByScope.has(scopeKey)) currentPendingIntentsByScope.set(scopeKey, []);
  currentPendingIntentsByScope.get(scopeKey).push(intent);
}
const currentPlanScopeSet = new Set(planRecoveryScopes);
if (args.reconcilePendingOnly) {
  const failures = [];
  if (currentInventoryIntents.size !== rows.length) {
    failures.push(`intent_count=${currentInventoryIntents.size},plan_count=${rows.length}`);
  }
  for (const row of rows) {
    const recoveryScopeKey = inventoryRecoveryScopeKey({runDate: plan.date, storeKey: row.storeKey, skc: row.skc, skuCode: row.skuCode});
    const scopeIntents = currentInventoryIntentsByScope.get(recoveryScopeKey) || [];
    if (scopeIntents.length !== 1) {
      failures.push(`scope_count=${scopeIntents.length}:${row.storeKey}:${row.skc}:${row.skuCode}`);
      continue;
    }
    const approvedTarget = Number(row.targetUsableInventory);
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
    const mismatch = recoveredInventoryIntentMismatch(scopeIntents[0], {
      logicalActionKey,
      plan,
      row,
      approvedTarget,
      authorizationId: executionAuthorization?.authorizationId || null,
      // A prior-date reconcile-only plan is historical readback/supersede
      // handling. Current-day recovery must prove the new explicit version;
      // historical read-only reconciliation must remain compatible with
      // unversioned legacy intents.
      requireCurrentOverwriteComputationVersion: plan.date === today,
    });
    if (mismatch) failures.push(`intent_mismatch=${mismatch}:${row.storeKey}:${row.skc}:${row.skuCode}`);
    const intentId = scopeIntents[0].intentId;
    const currentIntentKey = [...currentInventoryIntents.entries()].find(([, intent]) => intent.intentId === intentId)?.[0];
    const terminalOutcome = currentIntentKey ? currentTerminalIntentOutcomes.get(currentIntentKey) : null;
    if (currentIntentKey && !pendingIntents.has(currentIntentKey) && terminalOutcome?.disposition !== 'readback_matched') {
      failures.push(`intent_lifecycle=${terminalOutcome?.disposition || 'missing'}:${row.storeKey}:${row.skc}:${row.skuCode}`);
    }
  }
  for (const scopeKey of currentInventoryIntentsByScope.keys()) {
    if (!currentPlanScopeSet.has(scopeKey)) failures.push(`extra_intent_scope=${scopeKey}`);
  }
  if (failures.length) {
    throw new Error(`INVENTORY_RECONCILE_PENDING_ONLY_PRECONDITION_FAILED:${failures.join('|')}`);
  }
}
deferredHistoricalIntents = [...pendingIntentsByScope.entries()]
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
    state: 'deferred_historical',
    warning: 'durable intent scope is absent from the rebuilt current plan; retained for audit and intercepted if the scope reappears',
  })));
// Historical pending scopes that are absent from today's rebuilt plan remain
// visible in the envelope-level audit field.  They must not be projected onto
// every current row: doing so duplicates result rows and blocks unrelated
// item scopes.  A current row is blocked only when its own scope is reached
// in the serial loop below.
for (const row of rows) {
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
    const approvedTarget = Number(row.targetUsableInventory);
    if (!Number.isInteger(approvedTarget) || approvedTarget < 0 || approvedTarget > Number(policy.targetUsableInventory || 100)) {
      throw new Error(`Invalid approved target usable inventory: ${row.targetUsableInventory}`);
    }
    if (!args.reconcilePendingOnly) {
      const et = etByKey.get(String(row.matchKey || canonicalInventoryKey(row.canonical)).toUpperCase());
      const etQty = Number(et?.current_sellable_quantity ?? et?.et_estimated_available_qty);
      const etDate = String(
        String(et?.et_operational_stock_policy || '').includes('01_full_carton_exception')
          ? et?.et_box_snapshot_date
          : et?.et_store_snapshot_date,
      ).slice(0, 10);
      if (etDate !== today || String(et?.inventory_match_status || '') !== 'matched') throw new Error('ET inventory is not a current-day matched fact');
      if (Number(row.etSellableInventory) !== etQty) throw new Error(`ET sellable inventory changed after plan: ${row.etSellableInventory} -> ${etQty}`);
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
      // Another executor may have persisted this scope after our startup
      // snapshot while we waited for the per-SKU ticket.  Re-read the full
      // journal set after acquiring that ticket and before creating any new
      // intent or issuing a POST; otherwise an empty startup cache can race
      // into a second durable intent.
      const freshJournalFiles = await discoverInventoryJournalFiles(journalFile, {includeAll: true});
      const freshJournalBundle = await readInventoryIntentJournals(freshJournalFiles, {maxRunDate: today});
      const freshScopeIntents = freshJournalBundle.pendingByScope.get(recoveryScopeKey) || [];
      await assertStillListed(client, row);
      let before = await readStock(client, row.skuCode);
      const scopeIntents = freshScopeIntents;
      if (scopeIntents.length) {
        if (scopeIntents.length !== 1) {
          await recordResult({...result, logicalActionKey, state: 'needs_manual_resolve', before, error: `multiple durable inventory intents exist in recovery scope ${recoveryScopeKey}; duplicate submission forbidden`}, logicalActionKey);
          continue;
        }
        const [recoveredIntent] = scopeIntents;
        const historicalScopeMismatch = [
          [String(recoveredIntent?.storeKey || '').trim().toUpperCase() === String(row.storeKey || '').trim().toUpperCase(), 'storeKey'],
          [String(recoveredIntent?.skc || '').trim() === String(row.skc || '').trim(), 'skc'],
          [String(recoveredIntent?.skuCode || '').trim() === String(row.skuCode || '').trim(), 'skuCode'],
          [String(recoveredIntent?.logicalActionKey || '').trim() !== '', 'logicalActionKey'],
        ].find(([ok]) => !ok)?.[1] || '';
        if (recoveredIntent.runDate !== plan.date) {
          if (historicalScopeMismatch) {
            await recordResult({
              ...result,
              logicalActionKey: recoveredIntent.logicalActionKey,
              state: 'needs_manual_resolve',
              historicalPending: true,
              before,
              historicalIntentId: recoveredIntent.intentId,
              historicalRunDate: recoveredIntent.runDate,
              error: `historical durable inventory intent scope cannot be proven: ${historicalScopeMismatch}; duplicate submission forbidden`,
            }, recoveredIntent.logicalActionKey);
            continue;
          }
          const historicalTarget = Number(recoveredIntent.targetUsableInventory);
          if (Number(before.totalUsableInventory) === historicalTarget) {
            await appendJournalRecord({
              kind: 'write_outcome',
              intentId: recoveredIntent.intentId,
              logicalActionKey: recoveredIntent.logicalActionKey,
              disposition: 'readback_matched',
              recordedAt: new Date().toISOString(),
            }, recoveredIntent.journalFile);
            pendingIntents.delete(journalIntentKey(recoveredIntent));
            const sameCurrentTarget = Number(before.totalUsableInventory) === approvedTarget;
            await recordResult({
              ...result,
              logicalActionKey: recoveredIntent.logicalActionKey,
              state: sameCurrentTarget ? 'skipped_target_already_matched' : 'historical_readback_matched',
              disposition: 'readback_matched',
              historicalIntentClosed: true,
              historicalIntentId: recoveredIntent.intentId,
              historicalRunDate: recoveredIntent.runDate,
              historicalTargetUsableInventory: historicalTarget,
              deferred: true,
              before,
              after: before,
              error: 'historical durable inventory intent matched by fresh identity and stock readback; current corrective action deferred to a future plan',
            }, recoveredIntent.logicalActionKey);
          } else {
            await recordResult({
              ...result,
              logicalActionKey: recoveredIntent.logicalActionKey,
              state: 'submitted_but_readback_pending',
              disposition: 'skipped',
              historicalPending: true,
              historicalIntentId: recoveredIntent.intentId,
              historicalRunDate: recoveredIntent.runDate,
              historicalTargetUsableInventory: historicalTarget,
              before,
              idempotencyKey: recoveredIntent.idempotencyKey || null,
              requestPayloadHash: recoveredIntent.requestPayloadHash || null,
              error: `historical durable inventory intent remains pending: live usable inventory ${before?.totalUsableInventory ?? 'unavailable'} does not match historical target ${historicalTarget}; current scope skipped and duplicate submission forbidden`,
            }, recoveredIntent.logicalActionKey);
          }
          continue;
        }
        const mismatch = recoveredInventoryIntentMismatch(recoveredIntent, {
          logicalActionKey,
          plan,
          row,
          approvedTarget,
          authorizationId: executionAuthorization?.authorizationId || null,
          requireCurrentOverwriteComputationVersion: plan.date === today,
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
          }, recoveredIntent.journalFile);
          pendingIntents.delete(journalIntentKey(recoveredIntent));
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
      if (args.reconcilePendingOnly) {
        const [lifecycleIntent] = currentInventoryIntentsByScope.get(recoveryScopeKey) || [];
        const lifecycleKey = lifecycleIntent && journalIntentKey(lifecycleIntent);
        const lifecycleOutcome = lifecycleIntent && currentTerminalIntentOutcomes.get(lifecycleKey);
        if (lifecycleOutcome?.disposition !== 'readback_matched') {
          throw new Error(`INVENTORY_RECONCILE_PENDING_ONLY_LIFECYCLE_MISSING:${recoveryScopeKey}`);
        }
        await recordResult({
          ...result,
          state: 'skipped_terminal_readback_recorded',
          terminalIntentId: lifecycleIntent.intentId,
          terminalRunDate: lifecycleIntent.runDate,
          terminalDisposition: lifecycleOutcome.disposition,
          terminalRecordedAt: lifecycleOutcome.recordedAt,
          currentLiveUsableInventory: before.totalUsableInventory,
          before,
        }, lifecycleIntent.logicalActionKey);
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
        overwriteComputationVersion: INVENTORY_OVERWRITE_COMPUTATION_VERSION,
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
      // The live map uses a composite journal+intentId key (load and every
      // delete path use it), so terminal outcomes below actually release the
      // entry instead of leaving a stale pending record behind.
      pendingIntents.set(journalIntentKey(activeIntent), activeIntent);
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
        pendingIntents.delete(journalIntentKey(activeIntent));
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
      pendingIntents.delete(journalIntentKey(activeIntent));
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
const unsafeResultCount = results.filter(row => ['blocked', 'submitted_but_readback_pending', 'suspicious_write_attempted', 'submitted_readback_failed', 'needs_manual_resolve', 'historical_readback_matched'].includes(row.state)).length;
const counts = {
  total: results.length,
  updated: results.filter(row => row.state === 'updated_readback_matched').length,
  dryRunReady: results.filter(row => row.state === 'dry_run_ready').length,
  skipped: results.filter(row => row.state.startsWith('skipped_')).length,
  deferredHistorical: deferredHistoricalIntents.length,
  blocked: unsafeResultCount,
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
