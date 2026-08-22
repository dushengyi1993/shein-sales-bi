#!/usr/bin/env node
/**
 * ET low-inventory guard/recheck detail-evidence boundary.
 *
 * The hourly stock refresh writes `outputs/shein_openapi_products/<STORE>/latest.json`
 * in stock_only mode, so every normalized row carries cached detail evidence
 * (`hasCurrentDetail === false`). The inventory planner fails closed unless a
 * row's canonical identity (supplierCode) is backed by a detail fetched in the
 * current run. This test pins the exact boundary with fixture-shaped evidence:
 *
 * - current stock-only detail (detail fetched in this run) is recognized and
 *   the plan stays executable for every store;
 * - cached detail, even a minutes-old `detailFetchedAt`, still blocks the whole
 *   plan (no freshness loophole for plan-stage canonical identity);
 * - stale cached detail and missing detail still block;
 * - a failed stock chunk still blocks.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildEtLowInventorySafetyPlan} from './inventory/build_et_low_inventory_safety_plan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'et-low-inventory-detail-evidence-'));
const date = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date());
const now = new Date().toISOString();
const staleDetailAt = new Date(Date.now() - 22 * 86_400_000).toISOString();

const completeness = {
  current: {
    hasList: true,
    hasDetail: true,
    hasCurrentDetail: true,
    hasCachedDetail: false,
    detailSource: 'current',
    detailFetchedAt: now,
    hasStock: true,
  },
  freshCached: {
    hasList: true,
    hasDetail: true,
    hasCurrentDetail: false,
    hasCachedDetail: true,
    detailSource: 'prior_cache',
    detailFetchedAt: now,
    hasStock: true,
  },
  staleCached: {
    hasList: true,
    hasDetail: true,
    hasCurrentDetail: false,
    hasCachedDetail: true,
    detailSource: 'prior_cache',
    detailFetchedAt: staleDetailAt,
    hasStock: true,
  },
  missing: {
    hasList: true,
    hasDetail: false,
    hasCurrentDetail: false,
    hasCachedDetail: false,
    detailSource: 'missing',
    detailFetchedAt: '',
    hasStock: true,
  },
};

const row = (store, index, source) => ({
  storeKey: store,
  spu: `spu-ev-${index}`,
  skc: `skc-ev-${index}`,
  skuCodes: [`sku-ev-${index}`],
  supplierCode: source === 'missing' ? '' : `EVID-${index}产品`,
  shelfStatusCode: '1',
  sheinUsableInventory: 0,
  sheinInventoryQuantity: 0,
  sheinLockedQuantity: 0,
  sourceCompleteness: completeness[source],
});

const productListFor = rows => rows.map(item => ({
  spuName: item.spu,
  skcName: item.skc,
  skuCodeList: item.skuCodes,
}));

const productsDir = path.join(tmp, 'products');
const storesFile = path.join(tmp, 'stores.json');
const biFile = path.join(tmp, 'inventoryTrend.json');
const linksFile = path.join(tmp, 'linksData.json');

await fs.writeFile(storesFile, JSON.stringify({
  stores: [{storeKey: 'A', enabled: true}, {storeKey: 'B', enabled: true}],
}));
await fs.writeFile(biFile, JSON.stringify({
  cachedAt: now,
  data: {
    inventoryDepletion: {
      products: [1, 2].map(index => ({
        match_key: `EVID${index}`,
        standard_goods_sn: `EVID-${index}产品`,
        current_sellable_quantity: 2,
        et_store_snapshot_date: date,
        inventory_match_status: 'matched',
        days_of_supply_on_hand: 60,
      })),
    },
  },
}));
await fs.writeFile(linksFile, JSON.stringify({
  cachedAt: now,
  data: {
    storeLinks: ['A', 'B'].flatMap(store => [1, 2].map(index => ({
      store_key: store,
      skc: `skc-ev-${index}`,
      standard_goods_sn: `EVID-${index}产品`,
      c7_eps_uv: 100 - index,
      c7_goods_uv: 10 - index,
      c7_sale_cnt: 0,
      c30_sale_cnt: 0,
    }))),
  },
}));

async function writeSnapshot(store, rows, summary = {}) {
  await fs.mkdir(path.join(productsDir, store), {recursive: true});
  await fs.writeFile(path.join(productsDir, store, 'latest.json'), JSON.stringify({
    fetchedAt: now,
    summary: {stockFailedChunkCount: 0, detailMissingAfterFallbackCount: 0, ...summary},
    productList: productListFor(rows),
    normalizedRows: rows,
  }));
}

async function buildPlan(name, {
  requiredDetailTargets = '',
  etManifest = '',
  etBatchId = '',
  etManifestHash = '',
  etMaxAgeSeconds = etManifest ? '1800' : '',
} = {}) {
  const out = path.join(tmp, `${name}.json`);
  const savedArgv = process.argv;
  const savedExitCode = process.exitCode;
  process.exitCode = undefined;
  process.argv = [
    process.execPath,
    path.join(ROOT, 'scripts', 'inventory', 'build_daily_inventory_replenishment_plan.mjs'),
    '--date', date,
    '--policy', path.join(ROOT, 'config', 'inventory_replenishment_policy.json'),
    '--stores', storesFile,
    '--products-dir', productsDir,
    '--bi-data', biFile,
    '--links-data', linksFile,
    '--operation-mode', 'et_low_inventory_safety',
    '--out', out,
    ...(requiredDetailTargets ? ['--required-detail-targets', requiredDetailTargets] : []),
    ...(etManifest ? ['--et-manifest', etManifest] : []),
    ...(etBatchId ? ['--et-batch-id', etBatchId] : []),
    ...(etManifestHash ? ['--et-manifest-hash', etManifestHash] : []),
    ...(etMaxAgeSeconds !== '' ? ['--et-max-age-seconds', String(etMaxAgeSeconds)] : []),
  ];
  try {
    await import(`./inventory/build_daily_inventory_replenishment_plan.mjs?detail-evidence=${name}-${Date.now()}`);
  } finally {
    process.argv = savedArgv;
    process.exitCode = savedExitCode;
  }
  return JSON.parse(await fs.readFile(out, 'utf8'));
}

// 1. Current stock-only detail is recognized: both stores carry detail fetched
// in this run, so the whole 19-store-style plan stays executable.
await writeSnapshot('A', [row('A', 1, 'current'), row('A', 2, 'current')]);
await writeSnapshot('B', [row('B', 1, 'current'), row('B', 2, 'current')]);
const currentPlan = await buildPlan('current-detail');
assert.equal(currentPlan.executable, true);
assert.equal(currentPlan.counts.enabledStores, 2);
assert.equal(currentPlan.counts.scannedLinks, 4);
assert.ok(!currentPlan.blockers.some(text => /not from current detail/.test(text)),
  'current-run detail must not produce a canonical-evidence blocker');
assert.equal(currentPlan.blockers.length, 0);

// The ET safety filter accepts the current-evidence source plan unchanged.
const safetyPlan = buildEtLowInventorySafetyPlan(currentPlan, {batchId: 'et-evidence-test'});
assert.equal(safetyPlan.executable, true);
assert.equal(safetyPlan.blockers.length, 0);

// 2. A minutes-old cached detail still blocks: freshness of the cache is not
// proof that the canonical identity is current at plan stage.
await writeSnapshot('A', [row('A', 1, 'freshCached'), row('A', 2, 'freshCached')]);
await writeSnapshot('B', [row('B', 1, 'current'), row('B', 2, 'current')]);
const freshCachedPlan = await buildPlan('fresh-cached-detail');
assert.equal(freshCachedPlan.executable, false);
assert.ok(freshCachedPlan.blockers.some(text => text.startsWith('low-ET OpenAPI product canonical evidence is not from current detail: store=A')),
  'a fresh cached detail must still fail closed: only a current-run detail proves canonical identity');
assert.ok(!freshCachedPlan.blockers.some(text => /detail evidence is incomplete/.test(text)),
  'a fresh cached detail is not a missing-detail blocker; it is a canonical-currency blocker');

// 3. Stale cached detail (beyond the 21-day reconciliation cache window) still
// blocks with the same canonical-currency reason.
await writeSnapshot('A', [row('A', 1, 'staleCached'), row('A', 2, 'staleCached')]);
const staleCachedPlan = await buildPlan('stale-cached-detail');
assert.equal(staleCachedPlan.executable, false);
assert.ok(staleCachedPlan.blockers.some(text => text.startsWith('low-ET OpenAPI product canonical evidence is not from current detail: store=A')));

// 4. Missing detail still blocks, both at summary level and per row.
await writeSnapshot('A', [row('A', 1, 'missing'), row('A', 2, 'missing')], {detailMissingAfterFallbackCount: 1});
const missingDetailPlan = await buildPlan('missing-detail');
assert.equal(missingDetailPlan.executable, false);
assert.ok(missingDetailPlan.blockers.some(text => text.startsWith('low-ET OpenAPI product canonical evidence is not from current detail: store=A')));
assert.ok(missingDetailPlan.blockers.some(text => text.startsWith('low-ET OpenAPI product canonical evidence is incomplete: store=A')));

// 5. A failed stock chunk still blocks even when every row carries current detail.
await writeSnapshot('A', [row('A', 1, 'current'), row('A', 2, 'current')], {stockFailedChunkCount: 1});
await writeSnapshot('B', [row('B', 1, 'current'), row('B', 2, 'current')]);
const stockFailurePlan = await buildPlan('stock-chunk-failure');
assert.equal(stockFailurePlan.executable, false);
assert.ok(stockFailurePlan.blockers.includes('A OpenAPI stock snapshot has failed chunks'));

// 6. A targeted run must prove that every requested SPU returned current
// detail. If a requested SPU disappears or the API omits it, rebuilding from a
// merely smaller candidate set must not silently pass.
const requiredTargetsFile = path.join(tmp, 'required-detail-targets.json');
await fs.writeFile(requiredTargetsFile, JSON.stringify({
  schemaVersion: 'et-low-inventory-detail-targets/v1',
  stores: {A: ['spu-ev-1', 'spu-ev-missing']},
}));
await writeSnapshot('A', [row('A', 1, 'current'), row('A', 2, 'current')]);
const missingTargetPlan = await buildPlan('missing-required-target', {requiredDetailTargets: requiredTargetsFile});
assert.equal(missingTargetPlan.executable, false);
assert.ok(missingTargetPlan.blockers.includes('low-ET current-detail target is unavailable after refresh: store=A spu=spu-ev-missing'));

// 7. Same-run ET warehouse/manifest facts must win over a stale Portal ET
// projection. The first pass still blocks on current-detail evidence, which is
// the only recoverable blocker class; after the bounded detail refresh and
// rebuild, the same ET batch remains bound to the executable plan.
const etBatchId = `et-daily-${date}-22-20-03-regression`;
const etManifestDir = path.join(tmp, 'et-forwarder', date, etBatchId);
const etManifestPath = path.join(etManifestDir, 'manifest.json');
const etStoreStockPath = path.join(etManifestDir, 'store_stock.json');
const etBoxStockPath = path.join(etManifestDir, 'box_stock.json');
await fs.mkdir(etManifestDir, {recursive: true});
await fs.writeFile(etStoreStockPath, JSON.stringify({
  endpoint: 'store_stock',
  fetchedAt: now,
  count: 2,
  rawRowCount: 2,
  rows: [1, 2].map(index => ({
    Barcode: `EVID-${index}产品`,
    StoreroomName: '09散件仓',
    Quantity: 2,
    RealQuantity: 2,
  })),
  pages: [{page: 1, count: 2, rows: 2}],
}));
await fs.writeFile(etBoxStockPath, JSON.stringify({
  endpoint: 'box_stock',
  fetchedAt: now,
  count: 0,
  rawRowCount: 0,
  rows: [],
  pages: [{page: 1, count: 0, rows: 0}],
}));
const etManifest = {
  batchId: etBatchId,
  mode: 'daily',
  targetDate: date,
  createdAt: now,
  ok: true,
  endpoints: {
    store_stock: {
      kind: 'snapshot', count: 2, rawRowCount: 2, rowCount: 2, pages: 1,
      overlapCount: 0, stoppedByOverlap: false, stoppedByDailyInitialCap: false,
    },
    box_stock: {
      kind: 'snapshot', count: 0, rawRowCount: 0, rowCount: 0, pages: 1,
      overlapCount: 0, stoppedByOverlap: false, stoppedByDailyInitialCap: false,
    },
  },
  files: {store_stock: 'store_stock.json', box_stock: 'box_stock.json'},
  // Deliberately omit EVID-2 from the embedded projection. The planner must
  // ignore this non-complete projection and obtain both products from the raw
  // endpoint snapshots.
  products: [{
    match_key: 'EVID1',
    standard_goods_sn: 'EVID-1产品',
    current_sellable_quantity: 2,
    inventory_match_status: 'matched',
  }],
};
await fs.writeFile(etManifestPath, JSON.stringify(etManifest));
const etManifestHash = crypto.createHash('sha256')
  .update(await fs.readFile(etManifestPath))
  .digest('hex');

await fs.writeFile(biFile, JSON.stringify({
  cachedAt: '2026-08-21T16:25:46+08:00',
  data: {
    inventoryDepletion: {
      products: [{
        match_key: 'EVID1',
        standard_goods_sn: 'EVID-1产品',
        current_sellable_quantity: 99,
        et_store_snapshot_date: '2026-08-21',
        inventory_match_status: 'matched',
      }],
    },
  },
}));
await writeSnapshot('A', [row('A', 1, 'freshCached'), row('A', 2, 'freshCached')]);
await writeSnapshot('B', [row('B', 1, 'current'), row('B', 2, 'current')]);
const sameRunEtPlan = await buildPlan('same-run-et-manifest-current-detail', {
  etManifest: etManifestPath,
  etBatchId,
  etManifestHash,
});
assert.equal(sameRunEtPlan.executable, false);
assert.ok(sameRunEtPlan.blockers.some(text => text.startsWith('low-ET OpenAPI product canonical evidence is not from current detail: store=A')));
assert.ok(!sameRunEtPlan.blockers.some(text => text.startsWith('BI/ET projection is stale')),
  'a stale Portal projection is diagnostic only when the same-run ET manifest is valid');
assert.equal(sameRunEtPlan.etFactSource.kind, 'et_forwarder_manifest');
assert.equal(sameRunEtPlan.etFactSource.batchId, etBatchId);
assert.equal(sameRunEtPlan.etFactSource.targetDate, date);
assert.equal(sameRunEtPlan.etFactSource.manifestHash, etManifestHash);
assert.equal(sameRunEtPlan.etFactSource.completeInventoryEvidence, true);
assert.match(sameRunEtPlan.etFactSource.inventoryEvidenceHash, /^[a-f0-9]{64}$/);
assert.match(sameRunEtPlan.etFactSource.files.store_stock.hash, /^[a-f0-9]{64}$/);
assert.equal(sameRunEtPlan.etFactSource.files.store_stock.rowCount, 2);
assert.equal(sameRunEtPlan.sourceEvidence.find(item => item.store === 'ET_PORTAL_PROJECTION_DIAGNOSTIC')?.authoritative, false);
assert.ok(sameRunEtPlan.detailRefreshTargets.some(target => target.storeKey === 'A'));
assert.ok(sameRunEtPlan.blockers.every(text => text.startsWith('low-ET OpenAPI product canonical evidence is not from current detail:')),
  'only current-detail blockers may enter the bounded refresh branch');

const sameRunTargetsFile = path.join(tmp, 'same-run-et-detail-targets.json');
await fs.writeFile(sameRunTargetsFile, JSON.stringify({
  schemaVersion: 'et-low-inventory-detail-targets/v1',
  stores: {A: ['spu-ev-1', 'spu-ev-2']},
}));
await writeSnapshot('A', [row('A', 1, 'current'), row('A', 2, 'current')]);
const rebuiltSameRunEtPlan = await buildPlan('same-run-et-manifest-rebuilt', {
  requiredDetailTargets: sameRunTargetsFile,
  etManifest: etManifestPath,
  etBatchId,
  etManifestHash,
});
assert.equal(rebuiltSameRunEtPlan.executable, true);
assert.equal(rebuiltSameRunEtPlan.blockers.length, 0);
assert.equal(rebuiltSameRunEtPlan.etFactSource.manifestHash, etManifestHash);
assert.equal(rebuiltSameRunEtPlan.counts.etTotalRows, 2);
assert.equal(rebuiltSameRunEtPlan.lowEtAllocations.length, 4,
  'an embedded projection that omits EVID-2 cannot remove the raw endpoint product');
assert.ok(rebuiltSameRunEtPlan.actionable.every(item => Number(item.etSellableInventory) === 2),
  'the rebuilt plan must use the fresh ET manifest quantity rather than stale Portal quantity');

const portalProjectionBytes = await fs.readFile(biFile);
await fs.unlink(biFile);
const missingPortalSameRunPlan = await buildPlan('same-run-et-manifest-missing-portal', {
  etManifest: etManifestPath,
  etBatchId,
  etManifestHash,
});
await fs.writeFile(biFile, portalProjectionBytes);
assert.equal(missingPortalSameRunPlan.executable, true);
assert.equal(missingPortalSameRunPlan.sourceEvidence.find(item => item.store === 'ET_PORTAL_PROJECTION_DIAGNOSTIC')?.authoritative, false);

const wrongDateManifestPath = path.join(etManifestDir, 'manifest-wrong-date.json');
await fs.writeFile(wrongDateManifestPath, JSON.stringify({...etManifest, targetDate: '2026-08-21'}));
const wrongDateManifestHash = crypto.createHash('sha256')
  .update(await fs.readFile(wrongDateManifestPath))
  .digest('hex');
const wrongDatePlan = await buildPlan('same-run-et-wrong-date', {
  etManifest: wrongDateManifestPath,
  etBatchId,
  etManifestHash: wrongDateManifestHash,
});
assert.equal(wrongDatePlan.executable, false);
assert.ok(wrongDatePlan.blockers.some(text => text.startsWith(`ET manifest date mismatch: expected=${date} actual=2026-08-21`)));

const staleCreatedAtManifestPath = path.join(etManifestDir, 'manifest-stale-created-at.json');
await fs.writeFile(staleCreatedAtManifestPath, JSON.stringify({
  ...etManifest,
  createdAt: '2026-08-21T16:25:46+08:00',
}));
const staleCreatedAtManifestHash = crypto.createHash('sha256')
  .update(await fs.readFile(staleCreatedAtManifestPath))
  .digest('hex');
const staleCreatedAtPlan = await buildPlan('same-run-et-stale-created-at', {
  etManifest: staleCreatedAtManifestPath,
  etBatchId,
  etManifestHash: staleCreatedAtManifestHash,
});
assert.equal(staleCreatedAtPlan.executable, false);
assert.ok(staleCreatedAtPlan.blockers.some(text => text.startsWith(`ET manifest createdAt date is stale: expected=${date}`)));

const sameDayStart = new Date(`${date}T00:00:00+08:00`).toISOString();
const sameDayOverAgeManifestPath = path.join(etManifestDir, 'manifest-same-day-over-age.json');
await fs.writeFile(sameDayOverAgeManifestPath, JSON.stringify({...etManifest, createdAt: sameDayStart}));
const sameDayOverAgeManifestHash = crypto.createHash('sha256')
  .update(await fs.readFile(sameDayOverAgeManifestPath))
  .digest('hex');
const sameDayOverAgePlan = await buildPlan('same-run-et-same-day-over-age', {
  etManifest: sameDayOverAgeManifestPath,
  etBatchId,
  etManifestHash: sameDayOverAgeManifestHash,
  etMaxAgeSeconds: 1,
});
assert.equal(sameDayOverAgePlan.executable, false);
assert.ok(sameDayOverAgePlan.blockers.some(text => text.startsWith('ET manifest createdAt exceeds max age:')),
  'a same-Shanghai-day manifest must still fail when it exceeds the bounded max age');

const overAgeEndpointDir = path.join(tmp, 'et-forwarder', date, `${etBatchId}-over-age-endpoint`);
await fs.mkdir(overAgeEndpointDir, {recursive: true});
await fs.writeFile(path.join(overAgeEndpointDir, 'store_stock.json'), JSON.stringify({
  endpoint: 'store_stock', fetchedAt: sameDayStart, count: 2, rawRowCount: 2,
  rows: [1, 2].map(index => ({Barcode: `EVID-${index}产品`, StoreroomName: '09散件仓', Quantity: 2})),
  pages: [{page: 1, count: 2, rows: 2}],
}));
await fs.writeFile(path.join(overAgeEndpointDir, 'box_stock.json'), JSON.stringify({
  endpoint: 'box_stock', fetchedAt: sameDayStart, count: 0, rawRowCount: 0, rows: [],
  pages: [{page: 1, count: 0, rows: 0}],
}));
const overAgeEndpointManifestPath = path.join(overAgeEndpointDir, 'manifest.json');
await fs.writeFile(overAgeEndpointManifestPath, JSON.stringify({...etManifest, createdAt: now}));
const overAgeEndpointManifestHash = crypto.createHash('sha256')
  .update(await fs.readFile(overAgeEndpointManifestPath))
  .digest('hex');
const overAgeEndpointPlan = await buildPlan('same-run-et-endpoint-same-day-over-age', {
  etManifest: overAgeEndpointManifestPath,
  etBatchId,
  etManifestHash: overAgeEndpointManifestHash,
  etMaxAgeSeconds: 1,
});
assert.equal(overAgeEndpointPlan.executable, false);
assert.ok(overAgeEndpointPlan.blockers.some(text => text.startsWith('ET manifest store_stock file fetchedAt exceeds max age:')),
  'same-day endpoint files must independently satisfy the max-age bound');

const missingFreshnessThresholdPlan = await buildPlan('same-run-et-missing-freshness-threshold', {
  etManifest: etManifestPath,
  etBatchId,
  etManifestHash,
  etMaxAgeSeconds: '',
});
assert.equal(missingFreshnessThresholdPlan.executable, false);
assert.ok(missingFreshnessThresholdPlan.blockers.includes('ET manifest max-age threshold is missing or invalid: value=(missing)'));

const embeddedOnlyManifestPath = path.join(etManifestDir, 'manifest-embedded-only.json');
await fs.writeFile(embeddedOnlyManifestPath, JSON.stringify({...etManifest, endpoints: {}, files: {}}));
const embeddedOnlyManifestHash = crypto.createHash('sha256')
  .update(await fs.readFile(embeddedOnlyManifestPath))
  .digest('hex');
const embeddedOnlyPlan = await buildPlan('same-run-et-embedded-only', {
  etManifest: embeddedOnlyManifestPath,
  etBatchId,
  etManifestHash: embeddedOnlyManifestHash,
});
assert.equal(embeddedOnlyPlan.executable, false);
assert.ok(embeddedOnlyPlan.blockers.includes('ET manifest is missing store_stock file'));
assert.ok(embeddedOnlyPlan.blockers.includes('ET manifest is missing box_stock file'));

const omittedRawDir = path.join(tmp, 'et-forwarder', date, `${etBatchId}-omitted-raw-product`);
await fs.mkdir(omittedRawDir, {recursive: true});
await fs.writeFile(path.join(omittedRawDir, 'store_stock.json'), JSON.stringify({
  endpoint: 'store_stock', fetchedAt: now, count: 2, rawRowCount: 1,
  rows: [{Barcode: 'EVID-1产品', StoreroomName: '09散件仓', Quantity: 2}],
  pages: [{page: 1, count: 2, rows: 1}],
}));
await fs.copyFile(etBoxStockPath, path.join(omittedRawDir, 'box_stock.json'));
const omittedRawManifestPath = path.join(omittedRawDir, 'manifest.json');
await fs.writeFile(omittedRawManifestPath, JSON.stringify(etManifest));
const omittedRawManifestHash = crypto.createHash('sha256')
  .update(await fs.readFile(omittedRawManifestPath))
  .digest('hex');
const omittedRawPlan = await buildPlan('same-run-et-omitted-raw-product', {
  etManifest: omittedRawManifestPath,
  etBatchId,
  etManifestHash: omittedRawManifestHash,
});
assert.equal(omittedRawPlan.executable, false);
assert.ok(omittedRawPlan.blockers.some(text => text.includes('store_stock completeness counts do not bind the full endpoint snapshot')),
  'omitting a raw stock product while retaining the authoritative endpoint count must fail closed');

const wrongBatchPlan = await buildPlan('same-run-et-wrong-batch', {
  etManifest: etManifestPath,
  etBatchId: `${etBatchId}-different`,
  etManifestHash,
});
assert.equal(wrongBatchPlan.executable, false);
assert.ok(wrongBatchPlan.blockers.some(text => text.startsWith('ET manifest batch mismatch:')));

const wrongHashPlan = await buildPlan('same-run-et-wrong-hash', {
  etManifest: etManifestPath,
  etBatchId,
  etManifestHash: 'a'.repeat(64),
});
assert.equal(wrongHashPlan.executable, false);
assert.ok(wrongHashPlan.blockers.some(text => text.startsWith('ET manifest hash mismatch:')));

await writeSnapshot('A', [row('A', 1, 'current'), row('A', 2, 'current')], {stockFailedChunkCount: 1});
await writeSnapshot('B', [row('B', 1, 'current'), row('B', 2, 'current')]);
const sameRunStockFailurePlan = await buildPlan('same-run-et-stock-chunk-failure', {
  etManifest: etManifestPath,
  etBatchId,
  etManifestHash,
});
assert.equal(sameRunStockFailurePlan.executable, false);
assert.ok(sameRunStockFailurePlan.blockers.includes('A OpenAPI stock snapshot has failed chunks'));

// 8. Evidence contract between the collector and the planner. The fetch only
// marks a row current when the detail was fetched in this run, and the planner
// requires exactly that proof before any store may pass. The hourly stock
// refresh requests no current detail outside the daily bounded pass, so its
// snapshots cannot carry the proof; changing that entry point is the only way
// to unblock the guard without relaxing fail-closed.
const fetchSource = await fs.readFile(path.join(ROOT, 'scripts', 'fetch_shein_openapi_products.mjs'), 'utf8');
const plannerSource = await fs.readFile(path.join(ROOT, 'scripts', 'inventory', 'build_daily_inventory_replenishment_plan.mjs'), 'utf8');
const stockRefreshSource = await fs.readFile(path.join(ROOT, 'scripts', 'cloud_openapi_stock_refresh.sh'), 'utf8');
const guardSource = await fs.readFile(path.join(ROOT, 'scripts', 'cloud_et_low_inventory_guard.sh'), 'utf8');
assert.match(fetchSource, /hasCurrentDetail: detailEvidence\?\.source === 'current'/,
  'the collector must record hasCurrentDetail only for detail fetched in this run');
assert.match(fetchSource, /hasCachedDetail: detailEvidence\?\.source === 'prior_cache'/);
assert.match(fetchSource, /const selectedDetailSpus = args\.skipDetails[\s\S]*args\.priorityDetailsOnly/,
  'a stock-only run requests zero current detail by design');
assert.match(plannerSource, /row\?\.sourceCompleteness\?\.hasCurrentDetail !== true/,
  'the planner must keep the strict current-detail canonical-evidence gate');
assert.match(stockRefreshSource, /DETAIL_BUDGET="\$\{SHEIN_OPENAPI_STOCK_REFRESH_DETAIL_BUDGET:-32\}"/,
  'the frequent refresh keeps a bounded per-store detail budget; it cannot cover the full catalog');
assert.match(stockRefreshSource, /SKIP_DETAILS=1[\s\S]*else[\s\S]*SKIP_DETAILS=1/,
  'every frequent pass outside the daily detail clock reuses cached detail');
assert.match(fetchSource, /args\.priorityDetailsOnly[\s\S]*availablePrioritySpus\.slice\(0, args\.maxDetails\)/,
  'targeted mode must fetch only allowlisted current-detail SPUs within the per-store budget');
assert.match(guardSource, /MAX_TARGETS > DETAIL_BUDGET/,
  'the ET guard must fail closed when any store exceeds the configured current-detail budget');
assert.match(guardSource, /SHEIN_OPENAPI_PRODUCT_RECONCILE_PRIORITY_DETAILS_ONLY=1/,
  'the ET guard must not spend the detail budget on non-candidates');
assert.match(guardSource, /all\(\.blockers\[\]; startswith\("low-ET OpenAPI product canonical evidence is not from current detail:"\)\)/,
  'automatic evidence recovery must run only when every blocker is an exact current-detail blocker');
assert.match(plannerSource, /--et-manifest/,
  'the planner must accept the same-run ET manifest as a facts source');
assert.match(plannerSource, /et_forwarder_manifest/,
  'the planner must label the ET manifest as the authoritative fact source');
assert.match(guardSource, /--et-manifest-hash "\$ET_MANIFEST_HASH"/,
  'the guard must bind both source-plan builds to the immutable ET manifest hash');
assert.match(guardSource, /--et-max-age-seconds "\$ET_FACT_MAX_AGE_SECONDS"/,
  'the guard must pass an explicit bounded ET freshness threshold');
assert.match(plannerSource, /Embedded inventory projections are never authoritative/,
  'embedded inventory projections must not bypass raw endpoint completeness evidence');

console.log(JSON.stringify({ok: true, checks: 61}, null, 2));
