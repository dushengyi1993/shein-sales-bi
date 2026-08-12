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

async function buildPlan(name, {requiredDetailTargets = ''} = {}) {
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

// 7. Evidence contract between the collector and the planner. The fetch only
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
assert.match(guardSource, /all\(\.blockers\[\]; startswith\("low-ET OpenAPI product canonical evidence"\)\)/,
  'automatic evidence recovery must run only when every blocker is a recoverable low-ET canonical-evidence blocker');

console.log(JSON.stringify({ok: true, checks: 30}, null, 2));
