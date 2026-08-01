#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
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
    biData: path.join(ROOT, 'outputs', 'bi-portal', 'data.json'),
    out: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--date') args.date = String(argv[++i] || '');
    else if (a === '--policy') args.policy = path.resolve(argv[++i] || '');
    else if (a === '--stores') args.stores = path.resolve(argv[++i] || '');
    else if (a === '--products-dir') args.productsDir = path.resolve(argv[++i] || '');
    else if (a === '--bi-data') args.biData = path.resolve(argv[++i] || '');
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
const [policy, storeConfig, biDocument] = await Promise.all([readJson(args.policy), readJson(args.stores), readJson(args.biData)]);
const bi = biDocument?.data && typeof biDocument.data === 'object' ? biDocument.data : biDocument;
const stores = enabledStoreKeys(storeConfig);
const biGeneratedAt = biDocument.generatedAt || bi.generatedAt || bi.createdAt;
const biAge = ageHours(biGeneratedAt);
const blockers = [];
const sourceEvidence = [];
sourceEvidence.push({
  store: 'ET',
  file: 'outputs/bi-portal/data.json',
  fetchedAt: biGeneratedAt || '',
  ageHours: Number.isFinite(biAge) ? Number(biAge.toFixed(4)) : null,
});
if (!Number.isFinite(biAge) || biAge < -0.25 || biAge > Number(policy.maxBiSnapshotAgeHours || 4)) {
  blockers.push(`BI/ET projection is stale: generatedAt=${biGeneratedAt || ''} ageHours=${biAge}`);
}

const etRows = Array.isArray(bi?.inventoryDepletion?.products) ? bi.inventoryDepletion.products : [];
const etByKey = new Map(etRows.map(row => [String(row.match_key || canonicalInventoryKey(row.standard_goods_sn)).toUpperCase(), row]));
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
const sellingStoresByMatchKey = new Map();
for (const row of linkRows) {
  if (String(row.shelfStatusCode || '') !== '1' || Number(row.sheinUsableInventory) <= 0) continue;
  const matchKey = canonicalInventoryKey(row.supplierCode);
  if (!matchKey) continue;
  if (!sellingStoresByMatchKey.has(matchKey)) sellingStoresByMatchKey.set(matchKey, new Set());
  sellingStoresByMatchKey.get(matchKey).add(String(row.storeKey || ''));
}
for (const row of linkRows) {
  const matchKey = canonicalInventoryKey(row.supplierCode);
  const et = etByKey.get(matchKey);
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
    decision: decision.reason,
  };
  if (decision.action === 'top_up') actionable.push({
    ...base,
    targetUsableInventory: decision.targetUsableInventory,
    replenishmentQuantity: Math.max(0, decision.targetUsableInventory - Number(row.sheinUsableInventory)),
  });
  else if (decision.action === 'alert' || decision.action === 'block') linkAlerts.push({...base, action: decision.action});
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
        && Number(etSellableInventory) <= Number(policy?.etAlerts?.lowQuantity ?? 20),
      replenishmentNeeded: hasNumericEt
        && Number(etSellableInventory) > Number(policy?.etAlerts?.lowQuantity ?? 20)
        && hasNumericDays
        && Number(daysOfSupplyOnHand) < Number(policy?.etAlerts?.replenishmentDaysOfSupply ?? 90),
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
const crossStoreSoldOutFindings = [...actionable, ...linkAlerts]
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
  crossStoreSoldOutFindings,
  etAlerts,
};
const payloadHash = stableInventoryHash({
  schemaVersion: payload.schemaVersion,
  date: payload.date,
  policyVersion: payload.policyVersion,
  actionable,
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
    crossStoreSoldOutActionable: actionable.filter(row => row.crossStoreSoldOutFinding).length,
    crossStoreSoldOutAlerts: linkAlerts.filter(row => row.crossStoreSoldOutFinding).length,
    linkAlerts: linkAlerts.length,
    etCritical: etAlerts.filter(row => row.severity === 'critical').length,
    etWarning: etAlerts.filter(row => row.severity === 'warning').length,
    etReplenishment: etAlerts.filter(row => row.severity === 'replenishment').length,
    etBelow90Days: etAlerts.filter(row => row.replenishmentNeeded).length,
    etManualAllocation: etAlerts.filter(row => row.manualAllocationNeeded).length,
    etUnknown: etAlerts.filter(row => row.severity === 'unknown').length,
  },
};
await fs.mkdir(path.dirname(args.out), {recursive: true});
await fs.writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ok: report.executable, out: path.relative(ROOT, args.out).replaceAll(path.sep, '/'), payloadHash, counts: report.counts, blockers: report.blockers}, null, 2));
if (!report.executable) process.exitCode = 2;
