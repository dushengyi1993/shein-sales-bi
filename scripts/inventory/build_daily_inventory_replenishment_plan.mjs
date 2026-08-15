#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  allocateLowEtInventory,
  canonicalInventoryKey,
  classifyEtInventoryAlert,
  decideDailyInventoryReplenishment,
  resolveInventoryIdentityKey,
  resolveInventoryShelfStatus,
  stableInventoryHash,
} from '../../lib/inventory_replenishment_policy.mjs';

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
    requiredDetailTargets: '',
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
    else if (a === '--required-detail-targets') args.requiredDetailTargets = path.resolve(argv[++i] || '');
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
const [policy, storeConfig, biDocument, linksDocument] = await Promise.all([
  readJson(args.policy),
  readJson(args.stores),
  readJson(args.biData),
  readJson(args.linksData),
]);
const requiredDetailTargets = args.requiredDetailTargets
  ? await readJson(args.requiredDetailTargets)
  : null;
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
const etMatchedCurrentDayRows = etRows.filter(row => {
  if (String(row?.inventory_match_status || '') !== 'matched') return false;
  const rowOperationalDate = dateText(
    String(row?.et_operational_stock_policy || '').includes('01_full_carton_exception')
      ? row?.et_box_snapshot_date
      : row?.et_store_snapshot_date,
  );
  return rowOperationalDate === args.date;
}).length;
// Global current-day ET source gate: a freshly published cache can still
// carry an old ET business day. When the policy requires a current-day ET
// snapshot, zero matched current-day operational rows (or an empty ET
// projection) must block the whole plan instead of silently producing an
// empty executable plan. Mixed old/new stays per-row: safe current-day rows
// execute and old rows keep their per-row blockers.
if (policy.requireCurrentDayEtSnapshot === true && etMatchedCurrentDayRows === 0) {
  blockers.push(`BI/ET projection has no matched current-day operational rows: matched=${etMatchedCurrentDayRows} total=${etRows.length}`);
}
const etEvidence = sourceEvidence.find(item => item.store === 'ET');
if (etEvidence) Object.assign(etEvidence, {totalEtRows: etRows.length, matchedCurrentDayEtRows: etMatchedCurrentDayRows});
const linkMetricRows = Array.isArray(links?.storeLinks)
  ? links.storeLinks
  : Array.isArray(links?.links) ? links.links : [];
const linkMetricsByKey = new Map(linkMetricRows.map(row => [
  `${String(row.store_key || row.storeKey || '').toUpperCase()}::${String(row.skc || '').trim()}`,
  row,
]));
const linkRows = [];
for (const store of stores) {
  const file = path.join(args.productsDir, store, 'latest.json');
  try {
    const doc = await readJson(file);
    const sourceAge = ageHours(doc.fetchedAt);
    const stockFailedChunkCount = doc?.summary?.stockFailedChunkCount;
    const hasValidStockFailureEvidence = Number.isInteger(stockFailedChunkCount) && stockFailedChunkCount >= 0;
    sourceEvidence.push({
      store,
      file: `outputs/shein_openapi_products/${store}/latest.json`,
      fetchedAt: doc.fetchedAt || '',
      ageHours: Number(sourceAge.toFixed(4)),
      stockFailedChunkCount: hasValidStockFailureEvidence ? stockFailedChunkCount : null,
      detailMissingAfterFallbackCount: Number(doc?.summary?.detailMissingAfterFallbackCount || 0),
    });
    if (!Number.isFinite(sourceAge) || sourceAge < -0.25 || sourceAge > Number(policy.maxOpenApiSnapshotAgeHours || 2)) {
      blockers.push(`${store} OpenAPI product snapshot is stale`);
    }
    if (!hasValidStockFailureEvidence) blockers.push(`${store} OpenAPI stock snapshot evidence is incomplete`);
    else if (stockFailedChunkCount > 0) blockers.push(`${store} OpenAPI stock snapshot has failed chunks`);
    // Daily inventory decisions use list + stock to determine relevance, then
    // require current detail and canonical identity only for that recomputed
    // inventory-relevant store+SPU set. The snapshot-wide missing-detail count
    // remains provenance, but non-relevant catalog rows must not block the
    // targeted refresh contract.
    for (const row of doc.normalizedRows || []) {
      linkRows.push(row);
    }
  } catch (error) {
    blockers.push(`${store} OpenAPI product snapshot unavailable: ${error.message}`);
  }
}
const dailyRequiredTargetsByStore = new Map();
if (requiredDetailTargets) {
  if (args.operationMode === 'et_low_inventory_safety') {
    if (requiredDetailTargets.schemaVersion !== 'et-low-inventory-detail-targets/v1'
      || !requiredDetailTargets.stores
      || typeof requiredDetailTargets.stores !== 'object') {
      blockers.push('low-ET current-detail target manifest is invalid');
    } else {
      const rowsByStoreSpu = new Map(linkRows.map(row => [
        `${String(row.storeKey || '').toUpperCase()}::${String(row.spu || '')}`,
        row,
      ]));
      for (const [storeKey, spus] of Object.entries(requiredDetailTargets.stores)) {
        if (!Array.isArray(spus)) {
          blockers.push(`low-ET current-detail target manifest is invalid for store=${storeKey}`);
          continue;
        }
        for (const spu of spus) {
          const identity = `store=${String(storeKey).toUpperCase()} spu=${String(spu || '')}`;
          const row = rowsByStoreSpu.get(`${String(storeKey).toUpperCase()}::${String(spu || '')}`);
          if (!row || row?.sourceCompleteness?.hasCurrentDetail !== true) {
            blockers.push(`low-ET current-detail target is unavailable after refresh: ${identity}`);
          }
        }
      }
    }
  } else if (args.operationMode === 'daily') {
    if (requiredDetailTargets.schemaVersion !== 'daily-inventory-detail-targets/v1'
      || !requiredDetailTargets.stores
      || typeof requiredDetailTargets.stores !== 'object'
      || !Object.keys(requiredDetailTargets.stores).length) {
      blockers.push('daily current-detail target manifest is invalid');
    } else if (String(requiredDetailTargets.date || '') !== args.date) {
      blockers.push(`daily current-detail target manifest date does not match plan date: ${String(requiredDetailTargets.date || '')}`);
    } else {
      const budgetPerStore = Number(requiredDetailTargets.budgetPerStore);
      if (!Number.isInteger(budgetPerStore) || budgetPerStore < 1) {
        blockers.push('daily current-detail target manifest has no valid per-store budget');
      } else {
        const rowsByStoreSpu = new Map();
        for (const row of linkRows) {
          const key = `${String(row.storeKey || '').toUpperCase()}::${String(row.spu || '').trim()}`;
          if (!rowsByStoreSpu.has(key)) rowsByStoreSpu.set(key, []);
          rowsByStoreSpu.get(key).push(row);
        }
        const seenNormalizedStores = new Set();
        for (const [storeKey, spus] of Object.entries(requiredDetailTargets.stores)) {
          const normalizedStore = String(storeKey || '').toUpperCase();
          if (!Array.isArray(spus)) {
            blockers.push(`daily current-detail target manifest is invalid for store=${storeKey}`);
            continue;
          }
          if (!normalizedStore) {
            blockers.push('daily current-detail target manifest has an empty store key');
            continue;
          }
          if (seenNormalizedStores.has(normalizedStore)) {
            blockers.push(`daily current-detail target manifest has duplicate normalized store key: store=${normalizedStore}`);
          }
          seenNormalizedStores.add(normalizedStore);
          if (!dailyRequiredTargetsByStore.has(normalizedStore)) dailyRequiredTargetsByStore.set(normalizedStore, []);
          dailyRequiredTargetsByStore.get(normalizedStore).push(...spus.map(value => String(value || '').trim()));
        }
        for (const [storeKey, normalizedSpus] of dailyRequiredTargetsByStore) {
          const uniqueSpus = [...new Set(normalizedSpus.filter(Boolean))];
          if (!uniqueSpus.length || uniqueSpus.length !== normalizedSpus.length) {
            blockers.push(`daily current-detail target manifest has empty or duplicate SPUs for store=${storeKey}`);
            continue;
          }
          if (uniqueSpus.length > budgetPerStore) {
            blockers.push(`daily current-detail target manifest exceeds per-store budget: store=${storeKey} count=${uniqueSpus.length} budget=${budgetPerStore}`);
            continue;
          }
          for (const spu of uniqueSpus) {
            const identity = `store=${storeKey} spu=${spu}`;
            const rows = rowsByStoreSpu.get(`${storeKey}::${spu}`) || [];
            if (!rows.length) {
              blockers.push(`daily current-detail target is missing from refreshed snapshot: ${identity}`);
              continue;
            }
            if (!rows.every(row => row?.sourceCompleteness?.hasCurrentDetail === true)) {
              blockers.push(`daily current-detail target is not from current detail after refresh: ${identity}`);
            }
            if (!rows.every(row => String(row?.supplierCode || '').trim())) {
              blockers.push(`daily current-detail target has incomplete canonical evidence after refresh: ${identity}`);
            }
          }
        }
      }
    }
  }
}

const actionable = [];
const linkAlerts = [];
const ignored = [];
const lowEtAllocations = [];
const rowContexts = linkRows.map(row => {
  const metrics = linkMetricsByKey.get(`${String(row.storeKey || '').toUpperCase()}::${String(row.skc || '').trim()}`);
  const productMatchKey = canonicalInventoryKey(row.supplierCode);
  const rawMetricsKey = metrics?.standard_goods_sn
    ?? metrics?.standardGoodsSn
    ?? metrics?.raw_goods_sn
    ?? metrics?.rawGoodsSn;
  const metricsMatchKey = canonicalInventoryKey(
    rawMetricsKey,
  );
  const matchKey = args.operationMode === 'et_low_inventory_safety'
    ? (metricsMatchKey || productMatchKey)
    : productMatchKey;
  return {
    row,
    metrics,
    matchKey,
    productMatchKey,
    resolvedProductKey: resolveInventoryIdentityKey(row.supplierCode),
    resolvedMetricsKey: metrics ? resolveInventoryIdentityKey(rawMetricsKey) : '',
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
  if (!sellingStoresByMatchKey.has(context.matchKey)) sellingStoresByMatchKey.set(context.matchKey, new Set());
  sellingStoresByMatchKey.get(context.matchKey).add(String(context.row.storeKey || ''));
}
const evaluatedRows = [];
for (const context of rowContexts) {
  const {row, metrics, matchKey, productMatchKey, resolvedProductKey, resolvedMetricsKey, shelfStatus} = context;
  const canonicalEvidenceConflict = Boolean(metrics)
    && (!resolvedProductKey || !resolvedMetricsKey || resolvedProductKey !== resolvedMetricsKey);
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
  const policyDecision = decideDailyInventoryReplenishment({
    shelfStatusCode: shelfStatus.code,
    sameStoreOnShelfLinkExists: sameStoreOnShelfSkcs.length > 0,
    skuCount: Array.isArray(row.skuCodes) ? row.skuCodes.length : 0,
    platformUsableInventory: row.sheinUsableInventory,
    etSellableInventory: et?.current_sellable_quantity ?? et?.et_estimated_available_qty,
    etSnapshotCurrentDay: operationalDate === args.date && String(et?.inventory_match_status || '') === 'matched',
    c7SaleCount: metrics?.c7_sale_cnt,
    policy,
  });
  const decision = canonicalEvidenceConflict
    ? {action: 'block', reason: 'openapi_linksdata_canonical_evidence_conflict'}
    : policyDecision;
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
    decision: decision.reason,
  };
  evaluatedRows.push({row, et, metrics, decision, base, inventoryRelevant, productMatchKey, resolvedProductKey, resolvedMetricsKey});
}

// First daily build evidence gate: every inventory-relevant SPU (on-shelf, or
// sold out with no other on-shelf same-store link for the canonical) must
// carry current-run detail before the plan may execute, because cached detail
// cannot prove the canonical mapping is still current. Cached rows outside
// the inventory-relevant set stay out of this gate; the guard refreshes
// exactly the emitted detailRefreshTargets and rebuilds with
// --required-detail-targets. Current-detail fail-closed is never deleted.
if (args.operationMode === 'daily' && !requiredDetailTargets) {
  for (const item of evaluatedRows) {
    if (!item.inventoryRelevant) continue;
    if (!String(item.row?.supplierCode || '').trim()) {
      blockers.push(`${item.base.storeKey} OpenAPI product canonical evidence is incomplete: store=${item.base.storeKey} spu=${item.base.spu} skc=${item.base.skc}`);
    }
    if (item.row?.sourceCompleteness?.hasCurrentDetail !== true) {
      blockers.push(`${item.base.storeKey} OpenAPI product canonical evidence is not from current detail: store=${item.base.storeKey} spu=${item.base.spu} skc=${item.base.skc}`);
    }
  }
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
const lowEtDetailRefreshTargets = [...lowEtGroups.values()]
  .flatMap(group => group.map(item => ({
    storeKey: String(item.base.storeKey || '').toUpperCase(),
    spu: String(item.base.spu || ''),
    skc: String(item.base.skc || ''),
    matchKey: String(item.base.matchKey || ''),
  })))
  .filter(row => row.storeKey && row.spu)
  .sort((a, b) => a.storeKey.localeCompare(b.storeKey) || a.spu.localeCompare(b.spu) || a.skc.localeCompare(b.skc));
// Daily mode targets every inventory-relevant SPU, deduplicated per
// store+SPU, so stale canonical mapping changes cannot silently drop actions;
// et mode keeps the conservative low-ET candidate set.
const dailyDetailRefreshTargets = [];
if (args.operationMode === 'daily') {
  const targetByStoreSpu = new Map();
  for (const item of evaluatedRows) {
    if (!item.inventoryRelevant) continue;
    const storeKey = String(item.base.storeKey || '').toUpperCase();
    const spu = String(item.base.spu || '').trim();
    if (!storeKey || !spu) continue;
    const key = `${storeKey}::${spu}`;
    const candidate = {
      storeKey,
      spu,
      skc: String(item.base.skc || ''),
      matchKey: String(item.base.matchKey || ''),
    };
    const existing = targetByStoreSpu.get(key);
    if (!existing || candidate.skc.localeCompare(existing.skc) < 0) targetByStoreSpu.set(key, candidate);
  }
  dailyDetailRefreshTargets.push(...targetByStoreSpu.values());
  dailyDetailRefreshTargets.sort((a, b) => a.storeKey.localeCompare(b.storeKey) || a.spu.localeCompare(b.spu));
}
const detailRefreshTargets = args.operationMode === 'daily'
  ? dailyDetailRefreshTargets
  : lowEtDetailRefreshTargets;
// Second daily build coverage gate: validating the manifest's own targets is
// not enough. The refreshed snapshot may surface new inventory-relevant
// store+SPU rows after the first build emitted targets (or drop old ones), so
// every re-computed dailyDetailRefreshTargets entry must also be covered by
// the manifest. An uncovered target fails closed with an explicit blocker;
// the guard treats this as terminal (not a recoverable refresh condition).
if (args.operationMode === 'daily'
  && requiredDetailTargets
  && dailyRequiredTargetsByStore.size) {
  const coveredTargets = new Set();
  for (const [storeKey, spus] of dailyRequiredTargetsByStore) {
    for (const spu of spus) {
      const value = String(spu || '').trim();
      if (storeKey && value) coveredTargets.add(`${storeKey}::${value}`);
    }
  }
  for (const target of dailyDetailRefreshTargets) {
    if (!coveredTargets.has(`${target.storeKey}::${target.spu}`)) {
      blockers.push(`daily current-detail target set is not fully covered by manifest: store=${target.storeKey} spu=${target.spu}`);
    }
  }
}
if (args.operationMode === 'et_low_inventory_safety') {
  for (const group of lowEtGroups.values()) {
    for (const item of group) {
      const identity = `store=${item.base.storeKey} spu=${item.base.spu} skc=${item.base.skc}`;
      if (!String(item.row?.supplierCode || '').trim()) {
        blockers.push(`low-ET OpenAPI product canonical evidence is incomplete: ${identity}`);
      }
      if (item.row?.sourceCompleteness?.hasCurrentDetail !== true) {
        blockers.push(`low-ET OpenAPI product canonical evidence is not from current detail: ${identity}`);
      }
      if (item.metrics && item.resolvedMetricsKey && item.resolvedProductKey !== item.resolvedMetricsKey) {
        blockers.push(`low-ET OpenAPI product canonical evidence does not match current BI link: ${identity}`);
      }
    }
  }
}
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
      ruleClass: String(decision.reason || '').startsWith('recent_sale_scarcity')
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
  detailRefreshTargets,
  crossStoreSoldOutFindings,
  etAlerts,
};
const payloadHash = stableInventoryHash({
  schemaVersion: payload.schemaVersion,
  date: payload.date,
  policyVersion: payload.policyVersion,
  actionable,
  lowEtAllocations,
  detailRefreshTargets,
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
    lowEtAllocationRows: lowEtAllocations.length,
    lowEtZeroTargets: lowEtAllocations.filter(row => Number(row.targetUsableInventory) === 0).length,
    lowEtNonTopZeroTargets: lowEtAllocations.filter(row => row.isTopExposureLink === false && Number(row.targetUsableInventory) === 0).length,
    lowEtCandidateCanonicalCount: lowEtGroups.size,
    lowEtAllocatedCanonicalCount: new Set(lowEtAllocations.map(row => row.matchKey)).size,
    lowEtBlockedCanonicalCount: blockedLowEtKeys.size,
    detailRefreshTargetCount: detailRefreshTargets.length,
    detailRefreshTargetStores: new Set(detailRefreshTargets.map(row => row.storeKey)).size,
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
    etTotalRows: etRows.length,
    etMatchedCurrentDayRows,
  },
};
await fs.mkdir(path.dirname(args.out), {recursive: true});
await fs.writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ok: report.executable, out: path.relative(ROOT, args.out).replaceAll(path.sep, '/'), payloadHash, counts: report.counts, blockers: report.blockers}, null, 2));
if (!report.executable) process.exitCode = 2;
