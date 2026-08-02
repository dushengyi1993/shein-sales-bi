#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  allocateLowEtInventory,
  canonicalInventoryKey,
  classifyEtInventoryAlert,
  decideDailyInventoryReplenishment,
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
    else if (a === '--out') args.out = path.resolve(argv[++i] || '');
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new Error('Invalid --date');
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
const bi = biDocument?.data && typeof biDocument.data === 'object' ? biDocument.data : biDocument;
const links = linksDocument?.data && typeof linksDocument.data === 'object' ? linksDocument.data : linksDocument;
const stores = enabledStoreKeys(storeConfig);
const biGeneratedAt = biDocument.cachedAt || biDocument.generatedAt || bi.generatedAt || bi.createdAt;
const biAge = ageHours(biGeneratedAt);
const linksGeneratedAt = linksDocument.cachedAt || linksDocument.generatedAt || links.generatedAt || links.createdAt;
const linksAge = ageHours(linksGeneratedAt);
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
if (!Number.isFinite(linksAge) || linksAge < -0.25 || linksAge > Number(policy.maxLinksSnapshotAgeHours || 4)) {
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
    });
    if (!Number.isFinite(sourceAge) || sourceAge < -0.25 || sourceAge > Number(policy.maxOpenApiSnapshotAgeHours || 2)) {
      blockers.push(`${store} OpenAPI product snapshot is stale`);
    }
    if (Number(doc?.summary?.stockFailedChunkCount || 0) > 0) blockers.push(`${store} OpenAPI stock snapshot has failed chunks`);
    for (const row of doc.normalizedRows || []) linkRows.push(row);
  } catch (error) {
    blockers.push(`${store} OpenAPI product snapshot unavailable: ${error.message}`);
  }
}

const actionable = [];
const linkAlerts = [];
const ignored = [];
const lowEtAllocations = [];
const sellingStoresByMatchKey = new Map();
for (const row of linkRows) {
  if (String(row.shelfStatusCode || '') !== '1' || Number(row.sheinUsableInventory) <= 0) continue;
  const matchKey = canonicalInventoryKey(row.supplierCode);
  if (!matchKey) continue;
  if (!sellingStoresByMatchKey.has(matchKey)) sellingStoresByMatchKey.set(matchKey, new Set());
  sellingStoresByMatchKey.get(matchKey).add(String(row.storeKey || ''));
}
const evaluatedRows = [];
for (const row of linkRows) {
  const matchKey = canonicalInventoryKey(row.supplierCode);
  const et = etByKey.get(matchKey);
  const metrics = linkMetricsByKey.get(`${String(row.storeKey || '').toUpperCase()}::${String(row.skc || '').trim()}`);
  const otherSellingStores = [...(sellingStoresByMatchKey.get(matchKey) || [])]
    .filter(storeKey => storeKey && storeKey !== row.storeKey)
    .sort();
  const operationalDate = dateText(
    String(et?.et_operational_stock_policy || '').includes('01_full_carton_exception')
      ? et?.et_box_snapshot_date
      : et?.et_store_snapshot_date,
  );
  const decision = decideDailyInventoryReplenishment({
    shelfStatusCode: String(row.shelfStatusCode || ''),
    otherStoreOnShelfWithStock: otherSellingStores.length > 0,
    skuCount: Array.isArray(row.skuCodes) ? row.skuCodes.length : 0,
    platformUsableInventory: row.sheinUsableInventory,
    etSellableInventory: et?.current_sellable_quantity ?? et?.et_estimated_available_qty,
    etSnapshotCurrentDay: operationalDate === args.date && String(et?.inventory_match_status || '') === 'matched',
    c7SaleCount: metrics?.c7_sale_cnt,
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
    shelfStatusCode: String(row.shelfStatusCode || ''),
    otherSellingStores,
    crossStoreSoldOutFinding: Number(row.sheinUsableInventory) <= 0 && otherSellingStores.length > 0,
    etSellableInventory: et?.current_sellable_quantity ?? et?.et_estimated_available_qty ?? null,
    etSnapshotDate: operationalDate,
    c7SaleCount: metrics?.c7_sale_cnt ?? null,
    c30SaleCount: metrics?.c30_sale_cnt ?? null,
    c7Exposure: metrics?.c7_eps_uv ?? null,
    c7GoodsVisitors: metrics?.c7_goods_uv ?? null,
    productName: metrics?.product_display_name || metrics?.product_name_cn || '',
    decision: decision.reason,
  };
  evaluatedRows.push({row, et, metrics, decision, base});
}

const lowEtGroups = new Map();
for (const item of evaluatedRows) {
  const threshold = Number(policy.lowEtAllocationAtOrBelow ?? 10);
  const etQty = Number(item.base.etSellableInventory);
  const eligibleStatus = new Set((policy.eligibleShelfStatusCodes || ['1', '3']).map(String)).has(item.base.shelfStatusCode);
  if (!eligibleStatus || !Number.isFinite(etQty) || etQty > threshold) continue;
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

const etAlerts = etRows
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
  crossStoreSoldOutFindings,
  etAlerts,
};
const payloadHash = stableInventoryHash({
  schemaVersion: payload.schemaVersion,
  date: payload.date,
  policyVersion: payload.policyVersion,
  actionable,
  lowEtAllocations,
  sourceEvidence: sourceEvidence.map(({ageHours: _ageHours, ...evidence}) => evidence),
});
const report = {
  ...payload,
  payloadHash,
  executable: payload.blockers.length === 0,
  counts: {
    enabledStores: stores.length,
    scannedLinks: linkRows.length,
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
    crossStoreSoldOutFindings: crossStoreSoldOutFindings.length,
    crossStoreSoldOutActionable: crossStoreSoldOutFindings.filter(row => actionable.some(action => action.storeKey === row.storeKey && action.skc === row.skc)).length,
    crossStoreSoldOutAlerts: crossStoreSoldOutFindings.filter(row => linkAlerts.some(alert => alert.storeKey === row.storeKey && alert.skc === row.skc)).length,
    linkAlerts: linkAlerts.length,
    etCritical: etAlerts.filter(row => row.severity === 'critical').length,
    etWarning: etAlerts.filter(row => row.severity === 'warning').length,
    etReplenishment: etAlerts.filter(row => row.severity === 'replenishment').length,
    etBelow120Days: etAlerts.filter(row => row.replenishmentNeeded).length,
    etManualAllocation: etAlerts.filter(row => row.manualAllocationNeeded).length,
    etUnknown: etAlerts.filter(row => row.severity === 'unknown').length,
  },
};
await fs.mkdir(path.dirname(args.out), {recursive: true});
await fs.writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ok: report.executable, out: path.relative(ROOT, args.out).replaceAll(path.sep, '/'), payloadHash, counts: report.counts, blockers: report.blockers}, null, 2));
if (!report.executable) process.exitCode = 2;
