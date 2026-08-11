#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  allocateLowEtInventory,
  canonicalInventoryKey,
  classifyEtInventoryAlert,
  compareAllStoreSoldOutBootstrapCandidates,
  decideDailyInventoryReplenishment,
  normalizeOpenApiProductCatalog,
  resolveInventoryShelfStatus,
  selectAllStoreSoldOutBootstrapSeed,
  stableInventoryHash,
} from '../../lib/inventory_replenishment_policy.mjs';
import {readInventoryBootstrapLockRegistry} from '../../lib/inventory_bootstrap_lock_registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const args = {
    date: new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date()),
    policy: path.join(ROOT, 'config', 'inventory_replenishment_policy.json'),
    stores: path.join(ROOT, 'config', 'stores.json'),
    productsDir: path.join(ROOT, 'outputs', 'shein_openapi_products'),
    biData: path.join(ROOT, 'outputs', 'bi-portal', 'sections', 'inventoryTrend.json'),
    linksData: path.join(ROOT, 'outputs', 'bi-portal', 'sections', 'linksData.json'),
    operationMode: 'daily',
    bootstrapLockFile: process.env.SHEIN_BI_INVENTORY_BOOTSTRAP_LOCK_FILE
      || path.join(ROOT, 'state', 'inventory', 'all-store-sold-out-bootstrap-locks.json'),
    out: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--date') args.date = String(argv[++i] || '');
    else if (a === '--policy') args.policy = path.resolve(argv[++i] || '');
    else if (a === '--stores') args.stores = path.resolve(argv[++i] || '');
    else if (a === '--products-dir') args.productsDir = path.resolve(argv[++i] || '');
    else if (a === '--bi-data') args.biData = path.resolve(argv[++i] || '');
    else if (a === '--links-data') args.linksData = path.resolve(argv[++i] || '');
    else if (a === '--operation-mode') args.operationMode = String(argv[++i] || '');
    else if (a === '--bootstrap-lock-file') args.bootstrapLockFile = path.resolve(argv[++i] || '');
    else if (a === '--out') args.out = path.resolve(argv[++i] || '');
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new Error('Invalid --date');
  if (!['daily', 'et_low_inventory_safety'].includes(args.operationMode)) throw new Error('Invalid --operation-mode');
  if (!args.out) args.out = path.join(ROOT, 'outputs', 'reports', `daily-inventory-replenishment-plan-${args.date}.json`);
  return args;
}

const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const ageHours = value => (Date.now() - new Date(value || '').getTime()) / 3_600_000;
const dateText = value => String(value || '').slice(0, 10);
const enabledStoreKeys = config => {
  const rows = Array.isArray(config?.stores)
    ? config.stores
    : Object.entries(config?.stores || {}).map(([storeKey, value]) => ({storeKey, ...value}));
  return rows.filter(row => row.enabled !== false).map(row => String(row.storeKey || row.key || '').trim().toUpperCase()).filter(Boolean);
};

const args = parseArgs(process.argv.slice(2));
const [policy, storeConfig, biDocument, linksDocument, bootstrapLockState] = await Promise.all([
  readJson(args.policy),
  readJson(args.stores),
  readJson(args.biData),
  readJson(args.linksData),
  readInventoryBootstrapLockRegistry(args.bootstrapLockFile),
]);
const bi = biDocument?.data && typeof biDocument.data === 'object' ? biDocument.data : biDocument;
const links = linksDocument?.data && typeof linksDocument.data === 'object' ? linksDocument.data : linksDocument;
const stores = enabledStoreKeys(storeConfig);
const biGeneratedAt = biDocument.cachedAt || biDocument.generatedAt || bi.generatedAt || bi.createdAt;
const biAge = ageHours(biGeneratedAt);
const linksGeneratedAt = linksDocument.cachedAt || linksDocument.generatedAt || links.generatedAt || links.createdAt;
const linksAge = ageHours(linksGeneratedAt);
const maximumLinksAgeHours = args.operationMode === 'et_low_inventory_safety'
  ? Number(policy?.lowEtFastGuard?.maxLinksSnapshotAgeHours || policy.maxLinksSnapshotAgeHours || 4)
  : Number(policy.maxLinksSnapshotAgeHours || 4);
const blockers = [];
const sourceEvidence = [];
sourceEvidence.push({
  store: 'ET',
  file: 'outputs/bi-portal/sections/inventoryTrend.json',
  fetchedAt: biGeneratedAt || '',
  ageHours: Number.isFinite(biAge) ? Number(biAge.toFixed(4)) : null,
});
if (!Number.isFinite(biAge) || biAge < -0.25 || biAge > Number(policy.maxBiSnapshotAgeHours || 4)) {
  blockers.push(`BI/ET projection is stale: generatedAt=${biGeneratedAt || ''} ageHours=${biAge}`);
}
sourceEvidence.push({
  store: 'BI_LINKS',
  file: 'outputs/bi-portal/sections/linksData.json',
  fetchedAt: linksGeneratedAt || '',
  ageHours: Number.isFinite(linksAge) ? Number(linksAge.toFixed(4)) : null,
});
if (!Number.isFinite(linksAge) || linksAge < -0.25 || linksAge > maximumLinksAgeHours) {
  blockers.push(`BI links data is stale: generatedAt=${linksGeneratedAt || ''} ageHours=${linksAge}`);
}

const etRows = Array.isArray(bi?.inventoryDepletion?.products) ? bi.inventoryDepletion.products : [];
const etByKey = new Map(etRows.map(row => [String(row.match_key || canonicalInventoryKey(row.standard_goods_sn)).toUpperCase(), row]));
const linkMetricRows = Array.isArray(links?.storeLinks)
  ? links.storeLinks
  : Array.isArray(links?.links) ? links.links : [];
const linkMetricsByKey = new Map(linkMetricRows.map(row => [
  `${String(row.store_key || row.storeKey || '').toUpperCase()}::${String(row.skc || '').trim()}`,
  row,
]));
const linkRows = [];
const storeCatalogs = {};
for (const store of stores) {
  const file = path.join(args.productsDir, store, 'latest.json');
  try {
    const doc = await readJson(file);
    const sourceAge = ageHours(doc.fetchedAt);
    sourceEvidence.push({
      store,
      file: `outputs/shein_openapi_products/${store}/latest.json`,
      fetchedAt: doc.fetchedAt || '',
      ageHours: Number(sourceAge.toFixed(4)),
      stockFailedChunkCount: Number(doc?.summary?.stockFailedChunkCount || 0),
      detailMissingAfterFallbackCount: Number(doc?.summary?.detailMissingAfterFallbackCount || 0),
    });
    if (!Number.isFinite(sourceAge) || sourceAge < -0.25 || sourceAge > Number(policy.maxOpenApiSnapshotAgeHours || 2)) {
      blockers.push(`${store} OpenAPI product snapshot is stale`);
    }
    if (Number(doc?.summary?.stockFailedChunkCount || 0) > 0) blockers.push(`${store} OpenAPI stock snapshot has failed chunks`);
    if (Number(doc?.summary?.detailMissingAfterFallbackCount || 0) > 0) {
      blockers.push(`${store} OpenAPI product detail evidence is incomplete`);
    }
    if (!Array.isArray(doc.productList)) {
      blockers.push(`${store} OpenAPI product catalog evidence is unavailable`);
    } else {
      const catalog = normalizeOpenApiProductCatalog(doc.normalizedRows || []);
      if (catalog.length !== (doc.normalizedRows || []).length) {
        blockers.push(`${store} OpenAPI product catalog supplier identity is incomplete`);
      }
      storeCatalogs[store] = {rowCount: catalog.length, hash: stableInventoryHash(catalog)};
    }
    for (const row of doc.normalizedRows || []) {
      if (!String(row?.supplierCode || '').trim()) blockers.push(`${store} OpenAPI product canonical evidence is incomplete`);
      if (row?.sourceCompleteness?.hasCurrentDetail !== true) {
        blockers.push(`${store} OpenAPI product canonical evidence is not from current detail`);
      }
      linkRows.push(row);
    }
  } catch (error) {
    blockers.push(`${store} OpenAPI product snapshot unavailable: ${error.message}`);
  }
}

const actionable = [];
const linkAlerts = [];
const ignored = [];
const lowEtAllocations = [];
const bootstrapGroups = [];
const rowContexts = linkRows.map(row => {
  const matchKey = canonicalInventoryKey(row.supplierCode);
  const metrics = linkMetricsByKey.get(`${String(row.storeKey || '').toUpperCase()}::${String(row.skc || '').trim()}`);
  return {
    row,
    metrics,
    matchKey,
    shelfStatus: resolveInventoryShelfStatus(metrics, row.shelfStatusCode),
  };
});
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
for (const context of rowContexts) {
  if (context.shelfStatus.code !== '1' || !context.matchKey) continue;
  const key = `${String(context.row.storeKey || '').toUpperCase()}::${context.matchKey}`;
  if (!onShelfSkcsByStoreMatchKey.has(key)) onShelfSkcsByStoreMatchKey.set(key, new Set());
  onShelfSkcsByStoreMatchKey.get(key).add(String(context.row.skc || ''));
}
const sellingStoresByMatchKey = new Map();
for (const context of rowContexts) {
  if (context.shelfStatus.code !== '1' || Number(context.row.sheinUsableInventory) <= 0 || !context.matchKey) continue;
  const lock = bootstrapLockState.registry.locks[context.matchKey];
  if (
    policy?.allStoreSoldOutBootstrap?.excludeSeedFromCrossStoreSellingEvidence === true
    && lock
    && String(lock.storeKey) === String(context.row.storeKey || '').toUpperCase()
    && String(lock.skc) === String(context.row.skc || '')
  ) continue;
  if (!sellingStoresByMatchKey.has(context.matchKey)) sellingStoresByMatchKey.set(context.matchKey, new Set());
  sellingStoresByMatchKey.get(context.matchKey).add(String(context.row.storeKey || ''));
}

const linkKey = context => `${String(context.row.storeKey || '').toUpperCase()}::${String(context.row.skc || '')}`;
const contextsByMatchKey = new Map();
for (const context of rowContexts) {
  if (!context.matchKey) continue;
  if (!contextsByMatchKey.has(context.matchKey)) contextsByMatchKey.set(context.matchKey, []);
  contextsByMatchKey.get(context.matchKey).push(context);
}
const bootstrapOverrideByLink = new Map();
const bootstrapRoleByLink = new Map();
const lowEtThreshold = Number(policy.lowEtAllocationAtOrBelow ?? 10);
const bootstrapTarget = Number(policy?.allStoreSoldOutBootstrap?.targetUsableInventory ?? 10);

function sameStoreOnShelfSkcsFor(context) {
  return [...(onShelfSkcsByStoreMatchKey.get(
    `${String(context.row.storeKey || '').toUpperCase()}::${context.matchKey}`,
  ) || [])]
    .filter(skc => skc && skc !== String(context.row.skc || ''))
    .sort();
}

function bootstrapCandidate(context) {
  return {
    storeKey: String(context.row.storeKey || '').toUpperCase(),
    skc: String(context.row.skc || ''),
    skuCode: String(context.row.skuCodes?.[0] || ''),
    c7Exposure: context.metrics?.c7_eps_uv ?? null,
    c7GoodsVisitors: context.metrics?.c7_goods_uv ?? null,
    c7SaleCount: context.metrics?.c7_sale_cnt ?? null,
    platformUsableInventory: Number(context.row.sheinUsableInventory),
  };
}

function bootstrapGroupLink(context) {
  return {
    storeKey: String(context.row.storeKey || '').toUpperCase(),
    spu: String(context.row.spu || ''),
    skc: String(context.row.skc || ''),
    skuCode: String(context.row.skuCodes?.[0] || ''),
    shelfStatusCode: context.shelfStatus.code,
    c7Exposure: context.metrics?.c7_eps_uv ?? null,
    c7GoodsVisitors: context.metrics?.c7_goods_uv ?? null,
    c7SaleCount: context.metrics?.c7_sale_cnt ?? null,
    platformUsableInventory: Number(context.row.sheinUsableInventory),
  };
}

function blockBootstrapGroup(matchKey, group, reason, details = {}) {
  for (const context of group) {
    if (!['1', '3'].includes(context.shelfStatus.code)) continue;
    bootstrapOverrideByLink.set(linkKey(context), {action: 'block', reason});
  }
  bootstrapGroups.push({matchKey, state: 'blocked', reason, ...details});
}

for (const [matchKey, group] of contextsByMatchKey) {
  const et = etByKey.get(matchKey);
  const etQty = Number(et?.current_sellable_quantity ?? et?.et_estimated_available_qty);
  const operationalDate = dateText(
    String(et?.et_operational_stock_policy || '').includes('01_full_carton_exception')
      ? et?.et_box_snapshot_date
      : et?.et_store_snapshot_date,
  );
  const lock = bootstrapLockState.registry.locks[matchKey] || null;
  const soldOutCandidates = group.filter(context => (
    context.shelfStatus.code === '3' && sameStoreOnShelfSkcsFor(context).length === 0
  ));
  const organicSelling = group.filter(context => (
    context.shelfStatus.code === '1'
    && Number(context.row.sheinUsableInventory) > 0
    && !(lock
      && String(lock.storeKey) === String(context.row.storeKey || '').toUpperCase()
      && String(lock.skc) === String(context.row.skc || ''))
  ));
  if ((lock || soldOutCandidates.length > 0) && group.some(context => (
    !Array.isArray(context.row.skuCodes) || context.row.skuCodes.length !== 1
  ))) {
    blockBootstrapGroup(matchKey, group, 'all_store_sold_out_bootstrap_canonical_requires_single_sku_links', {lock});
    continue;
  }

  if (lock) {
    const lockedContext = group.find(context => (
      String(context.row.storeKey || '').toUpperCase() === String(lock.storeKey)
      && String(context.row.skc || '') === String(lock.skc)
    ));
    if (
      operationalDate === args.date
      && String(et?.inventory_match_status || '') === 'matched'
      && Number.isFinite(etQty)
      && etQty <= lowEtThreshold
    ) {
      bootstrapGroups.push({
        matchKey,
        state: 'suspended_low_et_allocation',
        etSellableInventory: etQty,
        lock,
      });
      continue;
    }
    let invalidReason = '';
    if (!lockedContext) invalidReason = 'all_store_sold_out_bootstrap_locked_seed_missing';
    else if (Number(lock.targetUsableInventory) !== bootstrapTarget) invalidReason = 'all_store_sold_out_bootstrap_locked_seed_target_changed';
    else if (String(lock.policyVersion || '') !== String(policy.policyVersion || '')) invalidReason = 'all_store_sold_out_bootstrap_locked_seed_policy_changed';
    else if (!['1', '3'].includes(lockedContext.shelfStatus.code)) invalidReason = 'all_store_sold_out_bootstrap_locked_seed_status_changed';
    else if (sameStoreOnShelfSkcsFor(lockedContext).length > 0) invalidReason = 'all_store_sold_out_bootstrap_locked_seed_superseded';
    else if (
      !Array.isArray(lockedContext.row.skuCodes)
      || lockedContext.row.skuCodes.length !== 1
      || String(lockedContext.row.skuCodes[0]) !== String(lock.skuCode)
    ) invalidReason = 'all_store_sold_out_bootstrap_locked_seed_sku_changed';
    if (invalidReason || operationalDate !== args.date || String(et?.inventory_match_status || '') !== 'matched' || !Number.isFinite(etQty) || etQty <= lowEtThreshold) {
      blockBootstrapGroup(matchKey, group, invalidReason || 'all_store_sold_out_bootstrap_locked_seed_et_invalid', {lock});
      continue;
    }
    if (organicSelling.length > 0) {
      blockBootstrapGroup(matchKey, group, 'all_store_sold_out_bootstrap_locked_seed_has_other_natural_selling', {
        lock,
        organicSellingStores: [...new Set(organicSelling.map(context => String(context.row.storeKey || '').toUpperCase()))].sort(),
      });
      continue;
    }
    if (soldOutCandidates.length) {
      try {
        if (soldOutCandidates.some(context => !Array.isArray(context.row.skuCodes) || context.row.skuCodes.length !== 1)) {
          throw new Error('bootstrap sold-out candidate must have exactly one SKU');
        }
        const selection = selectAllStoreSoldOutBootstrapSeed(soldOutCandidates.map(bootstrapCandidate), policy);
        for (const duplicate of selection.duplicates) {
          bootstrapOverrideByLink.set(`${String(duplicate.storeKey).toUpperCase()}::${duplicate.skc}`, {
            action: 'skip',
            reason: 'sold_out_duplicate_not_selected',
          });
        }
      } catch (error) {
        blockBootstrapGroup(matchKey, group, `all_store_sold_out_bootstrap_selection_blocked: ${error.message}`, {lock});
        continue;
      }
    }
    bootstrapRoleByLink.set(linkKey(lockedContext), {role: 'locked_seed', lock});
    bootstrapGroups.push({
      matchKey,
      state: 'locked_seed',
      seed: bootstrapCandidate(lockedContext),
      targetUsableInventory: Number(lock.targetUsableInventory),
      organicSellingStores: [...new Set(organicSelling.map(context => String(context.row.storeKey || '').toUpperCase()))].sort(),
      lock,
      groupLinks: group.map(bootstrapGroupLink),
      storeCatalogs,
    });
    continue;
  }

  if (!soldOutCandidates.length || !Number.isFinite(etQty) || etQty <= lowEtThreshold) continue;
  let selection;
  try {
    selection = selectAllStoreSoldOutBootstrapSeed(soldOutCandidates.map(bootstrapCandidate), policy);
  } catch (error) {
    blockBootstrapGroup(matchKey, group, `all_store_sold_out_bootstrap_selection_blocked: ${error.message}`);
    continue;
  }
  const duplicateKeys = new Set(selection.duplicates.map(row => `${row.storeKey}::${row.skc}`));
  for (const context of soldOutCandidates) {
    if (duplicateKeys.has(linkKey(context))) {
      bootstrapOverrideByLink.set(linkKey(context), {action: 'skip', reason: 'sold_out_duplicate_not_selected'});
    }
  }
  if (organicSelling.length > 0 || policy?.allStoreSoldOutBootstrap?.enabled !== true) continue;
  if (operationalDate !== args.date || String(et?.inventory_match_status || '') !== 'matched') {
    blockBootstrapGroup(matchKey, group, 'all_store_sold_out_bootstrap_et_not_current_day');
    continue;
  }
  const seedContext = soldOutCandidates.find(context => (
    String(context.row.storeKey || '').toUpperCase() === String(selection.seed?.storeKey || '')
    && String(context.row.skc || '') === String(selection.seed?.skc || '')
  ));
  if (!seedContext) {
    blockBootstrapGroup(matchKey, group, 'all_store_sold_out_bootstrap_seed_missing_after_selection');
    continue;
  }
  const existingUsableTotal = group
    .filter(context => ['1', '3'].includes(context.shelfStatus.code))
    .reduce((sum, context) => sum + Math.max(0, Number(context.row.sheinUsableInventory || 0)), 0);
  const increment = Math.max(0, bootstrapTarget - Number(seedContext.row.sheinUsableInventory || 0));
  if (!Number.isInteger(bootstrapTarget) || bootstrapTarget < 1 || existingUsableTotal + increment > etQty) {
    blockBootstrapGroup(matchKey, group, 'all_store_sold_out_bootstrap_budget_exceeds_et', {existingUsableTotal, increment, etSellableInventory: etQty});
    continue;
  }
  bootstrapRoleByLink.set(linkKey(seedContext), {role: 'new_seed'});
  for (const candidate of selection.storeCandidates) {
    const key = `${String(candidate.storeKey).toUpperCase()}::${candidate.skc}`;
    if (key !== linkKey(seedContext) && !bootstrapOverrideByLink.has(key)) {
      bootstrapOverrideByLink.set(key, {action: 'skip', reason: 'sold_out_bootstrap_not_selected'});
    }
  }
  bootstrapGroups.push({
    matchKey,
    state: 'new_seed',
    seed: bootstrapCandidate(seedContext),
    targetUsableInventory: bootstrapTarget,
    existingUsableTotal,
    plannedIncrement: increment,
    etSellableInventory: etQty,
    rankedStoreCandidates: [...selection.storeCandidates].sort(compareAllStoreSoldOutBootstrapCandidates),
    groupLinks: group.map(bootstrapGroupLink),
    storeCatalogs,
  });
}

const evaluatedRows = [];
for (const context of rowContexts) {
  const {row, metrics, matchKey, shelfStatus} = context;
  const et = etByKey.get(matchKey);
  const otherSellingStores = [...(sellingStoresByMatchKey.get(matchKey) || [])]
    .filter(storeKey => storeKey && storeKey !== row.storeKey)
    .sort();
  const sameStoreOnShelfSkcs = [...(onShelfSkcsByStoreMatchKey.get(
    `${String(row.storeKey || '').toUpperCase()}::${matchKey}`,
  ) || [])]
    .filter(skc => skc && skc !== String(row.skc || ''))
    .sort();
  const inventoryRelevant = shelfStatus.code === '1'
    || (shelfStatus.code === '3' && sameStoreOnShelfSkcs.length === 0);
  const operationalDate = dateText(
    String(et?.et_operational_stock_policy || '').includes('01_full_carton_exception')
      ? et?.et_box_snapshot_date
      : et?.et_store_snapshot_date,
  );
  const bootstrapOverride = bootstrapOverrideByLink.get(linkKey(context));
  const bootstrapRole = bootstrapRoleByLink.get(linkKey(context));
  const decision = bootstrapOverride || decideDailyInventoryReplenishment({
    shelfStatusCode: shelfStatus.code,
    otherStoreOnShelfWithStock: otherSellingStores.length > 0,
    sameStoreOnShelfLinkExists: sameStoreOnShelfSkcs.length > 0,
    skuCount: Array.isArray(row.skuCodes) ? row.skuCodes.length : 0,
    platformUsableInventory: row.sheinUsableInventory,
    etSellableInventory: et?.current_sellable_quantity ?? et?.et_estimated_available_qty,
    etSnapshotCurrentDay: operationalDate === args.date && String(et?.inventory_match_status || '') === 'matched',
    c7SaleCount: metrics?.c7_sale_cnt,
    allStoreSoldOutBootstrapSeed: bootstrapRole?.role === 'new_seed',
    allStoreSoldOutBootstrapLocked: bootstrapRole?.role === 'locked_seed',
    policy,
  });
  const base = {
    storeKey: row.storeKey,
    spu: row.spu,
    skc: row.skc,
    skuCode: row.skuCodes?.[0] || '',
    supplierCode: row.supplierCode || '',
    canonical: et?.standard_goods_sn || row.supplierCode || '',
    matchKey,
    platformUsableInventory: Number(row.sheinUsableInventory),
    platformTotalInventory: Number(row.sheinInventoryQuantity),
    platformLockedInventory: Number(row.sheinLockedQuantity),
    openApiShelfStatusCode: String(row.shelfStatusCode || ''),
    shelfStatusCode: shelfStatus.code,
    shelfStatusName: shelfStatus.name,
    shelfStatusSource: shelfStatus.source,
    sameStoreOnShelfSkcs,
    otherSellingStores,
    crossStoreSoldOutFinding: Number(row.sheinUsableInventory) <= 0
      && otherSellingStores.length > 0
      && inventoryRelevant
      && sameStoreOnShelfSkcs.length === 0,
    etSellableInventory: et?.current_sellable_quantity ?? et?.et_estimated_available_qty ?? null,
    etSnapshotDate: operationalDate,
    c7SaleCount: metrics?.c7_sale_cnt ?? null,
    c30SaleCount: metrics?.c30_sale_cnt ?? null,
    c7Exposure: metrics?.c7_eps_uv ?? null,
    c7GoodsVisitors: metrics?.c7_goods_uv ?? null,
    productName: metrics?.product_display_name || metrics?.product_name_cn || '',
    bootstrapRole: bootstrapRole?.role || null,
    bootstrapRegistryHash: bootstrapLockState.hash,
    decision: decision.reason,
  };
  evaluatedRows.push({row, et, metrics, decision, base, inventoryRelevant});
}

const lowEtGroups = new Map();
for (const item of evaluatedRows) {
  const threshold = Number(policy.lowEtAllocationAtOrBelow ?? 10);
  const etQty = Number(item.base.etSellableInventory);
  if (!item.inventoryRelevant || !Number.isFinite(etQty) || etQty > threshold) continue;
  if (!lowEtGroups.has(item.base.matchKey)) lowEtGroups.set(item.base.matchKey, []);
  lowEtGroups.get(item.base.matchKey).push(item);
}

const handledLowEtKeys = new Set();
const blockedLowEtKeys = new Set();
for (const [matchKey, group] of lowEtGroups) {
  handledLowEtKeys.add(matchKey);
  const blockingRows = group.filter(item => item.decision.action !== 'allocate');
  if (blockingRows.length) {
    blockedLowEtKeys.add(matchKey);
    for (const item of group) {
      linkAlerts.push({
        ...item.base,
        action: 'block',
        decision: blockingRows.some(row => row.base.storeKey === item.base.storeKey && row.base.skc === item.base.skc)
          ? item.decision.reason
          : 'low_et_allocation_group_has_blocked_link',
      });
    }
    continue;
  }
  try {
    const ranked = allocateLowEtInventory(group.map(item => item.base), Math.floor(Number(group[0].base.etSellableInventory)), policy);
    const plannedAllocationTotal = ranked.reduce((sum, row) => sum + Number(row.targetUsableInventory || 0), 0);
    for (const allocation of ranked) {
      const allocationRow = {
        ...allocation,
        plannedAllocationTotal,
        allocationLinkCount: ranked.length,
        topExposureLinkCount: Math.min(Number(policy?.lowEtAllocation?.topExposureLinkCount ?? 5), ranked.length),
        decision: allocation.isTopExposureLink
          ? 'low_et_allocate_to_top_exposure_link'
          : 'low_et_zero_non_top_exposure_link',
      };
      lowEtAllocations.push(allocationRow);
      if (Number(allocation.platformUsableInventory) !== Number(allocation.targetUsableInventory)) {
        actionable.push({
          ...allocationRow,
          ruleClass: 'low_et_top_exposure_allocation',
          inventoryAction: Number(allocation.platformUsableInventory) < Number(allocation.targetUsableInventory) ? 'increase' : 'decrease',
          replenishmentQuantity: Math.max(0, Number(allocation.targetUsableInventory) - Number(allocation.platformUsableInventory)),
          reductionQuantity: Math.max(0, Number(allocation.platformUsableInventory) - Number(allocation.targetUsableInventory)),
        });
      }
    }
  } catch (error) {
    blockedLowEtKeys.add(matchKey);
    for (const item of group) linkAlerts.push({...item.base, action: 'block', decision: `low_et_allocation_blocked: ${error.message}`});
  }
}

for (const item of evaluatedRows) {
  if (handledLowEtKeys.has(item.base.matchKey)) continue;
  const {decision, base} = item;
  if (decision.action === 'set_exact') {
    if (Number(base.platformUsableInventory) === Number(decision.targetUsableInventory)) {
      if (base.bootstrapRole === 'locked_seed' && bootstrapRoleByLink.get(`${base.storeKey}::${base.skc}`)?.lock?.status === 'pending') {
        actionable.push({
          ...base,
          ruleClass: 'all_store_sold_out_bootstrap_seed',
          targetUsableInventory: decision.targetUsableInventory,
          inventoryAction: 'stable',
          replenishmentQuantity: 0,
          reductionQuantity: 0,
          bootstrapActivationOnly: true,
        });
        continue;
      }
      ignored.push({
        ...base,
        action: 'skip',
        decision: 'target_inventory_already_satisfied',
        originalDecision: decision.reason,
        targetUsableInventory: decision.targetUsableInventory,
      });
      continue;
    }
    actionable.push({
      ...base,
      ruleClass: base.bootstrapRole
        ? 'all_store_sold_out_bootstrap_seed'
        : String(decision.reason || '').startsWith('recent_sale_scarcity')
          ? 'recent_sale_scarcity'
          : 'legacy_virtual_inventory_top_up',
      targetUsableInventory: decision.targetUsableInventory,
      inventoryAction: Number(base.platformUsableInventory) < Number(decision.targetUsableInventory) ? 'increase' : 'decrease',
      replenishmentQuantity: Math.max(0, decision.targetUsableInventory - Number(base.platformUsableInventory)),
      reductionQuantity: Math.max(0, Number(base.platformUsableInventory) - decision.targetUsableInventory),
    });
  } else if (decision.action === 'alert' || decision.action === 'block') linkAlerts.push({...base, action: decision.action});
  else ignored.push({...base, action: decision.action});
}

const inventoryRelevantMatchKeys = new Set(
  evaluatedRows.filter(item => item.inventoryRelevant).map(item => item.base.matchKey).filter(Boolean),
);
const etAlertsExcludedNoRelevantLinks = etRows.filter(row => !inventoryRelevantMatchKeys.has(
  String(row.match_key || canonicalInventoryKey(row.standard_goods_sn)).toUpperCase(),
)).length;
const etAlerts = etRows
  .filter(row => inventoryRelevantMatchKeys.has(
    String(row.match_key || canonicalInventoryKey(row.standard_goods_sn)).toUpperCase(),
  ))
  .map(row => {
    const daysOfSupplyOnHand = row.days_of_supply_on_hand ?? null;
    const etSellableInventory = row.current_sellable_quantity ?? row.et_estimated_available_qty ?? null;
    const hasNumericDays = daysOfSupplyOnHand !== null
      && daysOfSupplyOnHand !== ''
      && Number.isFinite(Number(daysOfSupplyOnHand));
    const hasNumericEt = etSellableInventory !== null
      && etSellableInventory !== ''
      && Number.isFinite(Number(etSellableInventory));
    return {
      ...row,
      alert: classifyEtInventoryAlert(row, policy),
      manualAllocationNeeded: hasNumericEt
        && Number(etSellableInventory) <= Number(policy?.etAlerts?.lowQuantity ?? 10),
      replenishmentNeeded: hasNumericEt
        && Number(etSellableInventory) > Number(policy?.etAlerts?.lowQuantity ?? 10)
        && hasNumericDays
        && Number(daysOfSupplyOnHand) < Number(policy?.etAlerts?.replenishmentDaysOfSupply ?? 120),
    };
  })
  .filter(row => row.alert.severity !== 'ok')
  .map(row => ({
    severity: row.alert.severity,
    reason: row.alert.reason,
    canonical: row.standard_goods_sn,
    matchKey: row.match_key,
    etSellableInventory: row.current_sellable_quantity ?? row.et_estimated_available_qty ?? null,
    daysOfSupplyOnHand: row.days_of_supply_on_hand ?? null,
    daysOfSupplyWithIncoming: row.days_of_supply_with_incoming ?? null,
    grossSold7d: row.gross_sold_7d ?? null,
    grossSold30d: row.gross_sold_30d ?? null,
    incomingQuantity: row.incoming_quantity ?? null,
    inventoryMatchStatus: row.inventory_match_status || '',
    manualAllocationNeeded: row.manualAllocationNeeded,
    replenishmentNeeded: row.replenishmentNeeded,
  }));

actionable.sort((a, b) => a.storeKey.localeCompare(b.storeKey) || a.skc.localeCompare(b.skc));
linkAlerts.sort((a, b) => a.canonical.localeCompare(b.canonical) || a.storeKey.localeCompare(b.storeKey));
lowEtAllocations.sort((a, b) => a.canonical.localeCompare(b.canonical) || a.exposureRank - b.exposureRank);
const outcomeByLink = new Map([...ignored, ...linkAlerts, ...lowEtAllocations, ...actionable].map(row => [
  `${row.storeKey}::${row.skc}`,
  row,
]));
const crossStoreSoldOutFindings = evaluatedRows
  .map(item => outcomeByLink.get(`${item.base.storeKey}::${item.base.skc}`) || item.base)
  .filter(row => row.crossStoreSoldOutFinding)
  .sort((a, b) => a.canonical.localeCompare(b.canonical) || a.storeKey.localeCompare(b.storeKey));
const payload = {
  schemaVersion: 'daily-inventory-replenishment-plan/v1',
  date: args.date,
  policyVersion: policy.policyVersion,
  generatedAt: new Date().toISOString(),
  sourceEvidence,
  blockers: [...new Set(blockers)],
  actionable,
  linkAlerts,
  ignored,
  lowEtAllocations,
  bootstrapLockRegistry: {
    schemaVersion: bootstrapLockState.registry.schemaVersion,
    exists: bootstrapLockState.exists,
    hash: bootstrapLockState.hash,
  },
  bootstrapGroups,
  crossStoreSoldOutFindings,
  etAlerts,
};
const payloadHash = stableInventoryHash({
  schemaVersion: payload.schemaVersion,
  date: payload.date,
  policyVersion: payload.policyVersion,
  actionable,
  lowEtAllocations,
  bootstrapGroups,
  bootstrapRegistryHash: bootstrapLockState.hash,
  sourceEvidence: sourceEvidence.map(({ageHours: _ageHours, ...evidence}) => evidence),
});
const report = {
  ...payload,
  payloadHash,
  executable: payload.blockers.length === 0,
  counts: {
    enabledStores: stores.length,
    scannedLinks: linkRows.length,
    inventoryRelevantLinks: evaluatedRows.filter(item => item.inventoryRelevant).length,
    actionable: actionable.length,
    inventoryIncreases: actionable.filter(row => row.inventoryAction === 'increase').length,
    inventoryDecreases: actionable.filter(row => row.inventoryAction === 'decrease').length,
    recentSaleScarcityActions: actionable.filter(row => row.ruleClass === 'recent_sale_scarcity').length,
    legacyVirtualTopUps: actionable.filter(row => row.ruleClass === 'legacy_virtual_inventory_top_up').length,
    lowEtAllocationActions: actionable.filter(row => row.ruleClass === 'low_et_top_exposure_allocation').length,
    bootstrapSeedActions: actionable.filter(row => row.ruleClass === 'all_store_sold_out_bootstrap_seed').length,
    bootstrapGroups: bootstrapGroups.length,
    bootstrapBlockedGroups: bootstrapGroups.filter(row => row.state === 'blocked').length,
    lowEtAllocationRows: lowEtAllocations.length,
    lowEtZeroTargets: lowEtAllocations.filter(row => Number(row.targetUsableInventory) === 0).length,
    lowEtNonTopZeroTargets: lowEtAllocations.filter(row => row.isTopExposureLink === false && Number(row.targetUsableInventory) === 0).length,
    lowEtCandidateCanonicalCount: lowEtGroups.size,
    lowEtAllocatedCanonicalCount: new Set(lowEtAllocations.map(row => row.matchKey)).size,
    lowEtBlockedCanonicalCount: blockedLowEtKeys.size,
    crossStoreSoldOutFindings: crossStoreSoldOutFindings.length,
    crossStoreSoldOutActionable: crossStoreSoldOutFindings.filter(row => actionable.some(action => action.storeKey === row.storeKey && action.skc === row.skc)).length,
    crossStoreSoldOutAlerts: crossStoreSoldOutFindings.filter(row => linkAlerts.some(alert => alert.storeKey === row.storeKey && alert.skc === row.skc)).length,
    outShelfLinksExcluded: ignored.filter(row => row.shelfStatusCode === '4').length,
    waitShelfLinksExcluded: ignored.filter(row => row.shelfStatusCode === '2').length,
    soldOutLinksIgnoredSameStoreOnShelf: ignored.filter(row => row.decision === 'sold_out_has_same_store_on_shelf_link').length,
    linkAlerts: linkAlerts.length,
    etCritical: etAlerts.filter(row => row.severity === 'critical').length,
    etWarning: etAlerts.filter(row => row.severity === 'warning').length,
    etReplenishment: etAlerts.filter(row => row.severity === 'replenishment').length,
    etBelow120Days: etAlerts.filter(row => row.replenishmentNeeded).length,
    etManualAllocation: etAlerts.filter(row => row.manualAllocationNeeded).length,
    etUnknown: etAlerts.filter(row => row.severity === 'unknown').length,
    etAlertsExcludedNoRelevantLinks,
  },
};
await fs.mkdir(path.dirname(args.out), {recursive: true});
await fs.writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ok: report.executable, out: path.relative(ROOT, args.out).replaceAll(path.sep, '/'), payloadHash, counts: report.counts, blockers: report.blockers}, null, 2));
if (!report.executable) process.exitCode = 2;
