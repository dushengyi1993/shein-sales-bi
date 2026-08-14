#!/usr/bin/env node
/**
 * Daily current-detail targeting boundary.
 *
 * The first daily build must not block on cached detail for rows outside the
 * inventory-relevant set, and it must emit deduplicated, sorted
 * detailRefreshTargets for every inventory-relevant store+SPU so the guard can
 * refresh exactly those rows with current detail. A cached inventory-relevant
 * row still fails closed and still appears in the targets. The second daily
 * build (--required-detail-targets, schema daily-inventory-detail-targets/v1)
 * re-validates each manifest target: missing from the refreshed snapshot, not
 * current, or missing supplierCode all block. The ET manifest schema
 * (et-low-inventory-detail-targets/v1) stays rejected in daily mode; the ET
 * evidence suite covers ET mode compatibility separately.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-inventory-detail-targeting-'));
const date = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date());
const now = new Date().toISOString();

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
  cached: {
    hasList: true,
    hasDetail: true,
    hasCurrentDetail: false,
    hasCachedDetail: true,
    detailSource: 'prior_cache',
    detailFetchedAt: now,
    hasStock: true,
  },
};

// One row per skc. r4 and r5 share store+SPU (dedup target case).
const rows = {
  r1: ['A', 'spu-rel-current', 'skc-rel-current', 'REL-1产品', '1', 'current'],
  r2: ['A', 'spu-rel-cached', 'skc-rel-cached', 'CACHED-1产品', '1', 'cached'],
  r3: ['A', 'spu-off-cached', 'skc-off-cached', 'OFF-1产品', '2', 'cached'],
  r4: ['A', 'spu-rel-dup', 'skc-rel-dup-a', 'DUP-1产品', '1', 'current'],
  r5: ['A', 'spu-rel-dup', 'skc-rel-dup-b', 'DUP-1产品', '1', 'current'],
  r6: ['B', 'spu-b-current', 'skc-b-current', 'REL-2产品', '1', 'current'],
  r7: ['A', 'spu-nocode', 'skc-nocode', '', '1', 'current'],
  r8: ['A', 'spu-new-current', 'skc-new-current', 'NEW-1产品', '1', 'current'],
  r9: ['A', 'spu-new-off', 'skc-new-off', 'NEWOFF-1产品', '2', 'cached'],
};

const row = ([store, spu, skc, supplierCode, shelfStatusCode, source], sourceOverride) => ({
  storeKey: store,
  spu,
  skc,
  skuCodes: [skc.replace(/^skc-/, 'sku-')],
  supplierCode,
  shelfStatusCode,
  sheinUsableInventory: 100,
  sheinInventoryQuantity: 100,
  sheinLockedQuantity: 0,
  sourceCompleteness: completeness[sourceOverride || source],
});

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
      products: [
        {match_key: 'REL1', standard_goods_sn: 'REL-1产品', current_sellable_quantity: 50, et_store_snapshot_date: date, inventory_match_status: 'matched', days_of_supply_on_hand: 150},
        {match_key: 'CACHED1', standard_goods_sn: 'CACHED-1产品', current_sellable_quantity: 50, et_store_snapshot_date: date, inventory_match_status: 'matched', days_of_supply_on_hand: 150},
        {match_key: 'OFF1', standard_goods_sn: 'OFF-1产品', current_sellable_quantity: 50, et_store_snapshot_date: date, inventory_match_status: 'matched', days_of_supply_on_hand: 150},
        {match_key: 'DUP1', standard_goods_sn: 'DUP-1产品', current_sellable_quantity: 50, et_store_snapshot_date: date, inventory_match_status: 'matched', days_of_supply_on_hand: 150},
        {match_key: 'REL2', standard_goods_sn: 'REL-2产品', current_sellable_quantity: 50, et_store_snapshot_date: date, inventory_match_status: 'matched', days_of_supply_on_hand: 150},
      ],
    },
  },
}));
await fs.writeFile(linksFile, JSON.stringify({
  cachedAt: now,
  data: {
    storeLinks: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].map(key => {
      const [store, , skc, supplierCode] = rows[key];
      return {
        store_key: store,
        skc,
        standard_goods_sn: supplierCode,
        c7_eps_uv: 500,
        c7_goods_uv: 50,
        c7_sale_cnt: 0,
        c30_sale_cnt: 0,
      };
    }),
  },
}));

async function writeSnapshot(store, keys, sourceOverrides = {}) {
  await fs.mkdir(path.join(productsDir, store), {recursive: true});
  await fs.writeFile(path.join(productsDir, store, 'latest.json'), JSON.stringify({
    fetchedAt: now,
    summary: {stockFailedChunkCount: 0, detailMissingAfterFallbackCount: 0},
    normalizedRows: keys.map(key => row(rows[key], sourceOverrides[key])),
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
    '--out', out,
    ...(requiredDetailTargets ? ['--required-detail-targets', requiredDetailTargets] : []),
  ];
  try {
    await import(`./inventory/build_daily_inventory_replenishment_plan.mjs?detail-targeting=${name}-${Date.now()}`);
  } finally {
    process.argv = savedArgv;
    process.exitCode = savedExitCode;
  }
  return JSON.parse(await fs.readFile(out, 'utf8'));
}

const manifestFile = path.join(tmp, 'required-detail-targets.json');
const writeManifest = (stores, {schemaVersion = 'daily-inventory-detail-targets/v1', manifestDate = date} = {}) =>
  fs.writeFile(manifestFile, JSON.stringify({
    schemaVersion,
    date: manifestDate,
    generatedAt: now,
    budgetPerStore: 64,
    stores,
  }));

// 1. Cached non-relevant row passes: a wait-shelf row with cached detail must
// neither block the first build nor enter detailRefreshTargets.
await writeSnapshot('A', ['r1', 'r3', 'r4', 'r5']);
await writeSnapshot('B', ['r6']);
const nonRelevantPass = await buildPlan('cached-nonrelevant-pass');
assert.equal(nonRelevantPass.executable, true);
assert.equal(nonRelevantPass.blockers.length, 0);
assert.equal(nonRelevantPass.counts.scannedLinks, 5);
assert.equal(nonRelevantPass.counts.inventoryRelevantLinks, 4);
assert.equal(nonRelevantPass.counts.detailRefreshTargetCount, 3);
assert.equal(nonRelevantPass.counts.detailRefreshTargetStores, 2);
assert.deepEqual(nonRelevantPass.detailRefreshTargets.map(target => [target.storeKey, target.spu]), [
  ['A', 'spu-rel-current'],
  ['A', 'spu-rel-dup'],
  ['B', 'spu-b-current'],
], 'targets must be deduplicated per store+SPU and sorted');
assert.equal(nonRelevantPass.detailRefreshTargets.find(target => target.spu === 'spu-rel-dup')?.skc, 'skc-rel-dup-a',
  'dedup must keep one representative skc per store+SPU');
assert.ok(!nonRelevantPass.detailRefreshTargets.some(target => target.spu === 'spu-off-cached'),
  'cached non-relevant rows must never be detail targets');
assert.match(nonRelevantPass.payloadHash, /^[a-f0-9]{64}$/);

// 2. Cached relevant row blocks the first build and still appears in targets:
// the guard needs the full inventory-relevant target set to refresh.
await writeSnapshot('A', ['r1', 'r2', 'r3', 'r4', 'r5']);
await writeSnapshot('B', ['r6']);
const cachedRelevantBlocked = await buildPlan('cached-relevant-blocked');
assert.equal(cachedRelevantBlocked.executable, false);
assert.equal(cachedRelevantBlocked.blockers.length, 1);
assert.ok(cachedRelevantBlocked.blockers.includes(
  'A OpenAPI product canonical evidence is not from current detail: store=A spu=spu-rel-cached skc=skc-rel-cached',
));
assert.ok(!cachedRelevantBlocked.blockers.some(text => /spu-off-cached/.test(text)),
  'cached non-relevant rows must not add blockers');
assert.equal(cachedRelevantBlocked.counts.detailRefreshTargetCount, 4);
assert.deepEqual(cachedRelevantBlocked.detailRefreshTargets.map(target => [target.storeKey, target.spu]), [
  ['A', 'spu-rel-cached'],
  ['A', 'spu-rel-current'],
  ['A', 'spu-rel-dup'],
  ['B', 'spu-b-current'],
], 'blocked first build must still emit every inventory-relevant store+SPU target, sorted');

// 3. Current target pass: after the targeted refresh every manifest target is
// current with supplierCode, so the second build is executable.
await writeSnapshot('A', ['r1', 'r2', 'r3', 'r4', 'r5'], {r2: 'current'});
await writeSnapshot('B', ['r6']);
await writeManifest({
  A: ['spu-rel-cached', 'spu-rel-current', 'spu-rel-dup'],
  B: ['spu-b-current'],
});
const currentTargetsPass = await buildPlan('current-targets-pass', {requiredDetailTargets: manifestFile});
assert.equal(currentTargetsPass.executable, true);
assert.equal(currentTargetsPass.blockers.length, 0);
assert.equal(currentTargetsPass.counts.detailRefreshTargetCount, 4);
assert.deepEqual(currentTargetsPass.detailRefreshTargets.map(target => [target.storeKey, target.spu]), [
  ['A', 'spu-rel-cached'],
  ['A', 'spu-rel-current'],
  ['A', 'spu-rel-dup'],
  ['B', 'spu-b-current'],
]);
assert.match(currentTargetsPass.payloadHash, /^[a-f0-9]{64}$/);

// 4. Required target missing from the refreshed snapshot blocks.
await writeSnapshot('A', ['r1', 'r2', 'r3', 'r4', 'r5'], {r2: 'current'});
await writeSnapshot('B', ['r6']);
await writeManifest({
  A: ['spu-rel-cached', 'spu-rel-current', 'spu-rel-dup', 'spu-rel-missing'],
  B: ['spu-b-current'],
});
const missingRequiredTarget = await buildPlan('missing-required-target', {requiredDetailTargets: manifestFile});
assert.equal(missingRequiredTarget.executable, false);
assert.equal(missingRequiredTarget.blockers.length, 1);
assert.ok(missingRequiredTarget.blockers.includes(
  'daily current-detail target is missing from refreshed snapshot: store=A spu=spu-rel-missing',
));

// 5. Required target still cached after refresh blocks.
await writeSnapshot('A', ['r1', 'r2', 'r3', 'r4', 'r5']);
await writeSnapshot('B', ['r6']);
await writeManifest({
  A: ['spu-rel-cached', 'spu-rel-current', 'spu-rel-dup'],
  B: ['spu-b-current'],
});
const cachedRequiredTarget = await buildPlan('cached-required-target', {requiredDetailTargets: manifestFile});
assert.equal(cachedRequiredTarget.executable, false);
assert.equal(cachedRequiredTarget.blockers.length, 1);
assert.ok(cachedRequiredTarget.blockers.includes(
  'daily current-detail target is not from current detail after refresh: store=A spu=spu-rel-cached',
));

// 6. Required target without supplierCode blocks (manifest-level and the kept
// global daily supplierCode completeness check both fire).
await writeSnapshot('A', ['r1', 'r2', 'r3', 'r4', 'r5', 'r7'], {r2: 'current'});
await writeSnapshot('B', ['r6']);
await writeManifest({
  A: ['spu-rel-cached', 'spu-rel-current', 'spu-rel-dup', 'spu-nocode'],
  B: ['spu-b-current'],
});
const missingSupplierCodeTarget = await buildPlan('missing-supplier-code-target', {requiredDetailTargets: manifestFile});
assert.equal(missingSupplierCodeTarget.executable, false);
assert.equal(missingSupplierCodeTarget.blockers.length, 2);
assert.ok(missingSupplierCodeTarget.blockers.includes(
  'daily current-detail target has incomplete canonical evidence after refresh: store=A spu=spu-nocode',
));
assert.ok(missingSupplierCodeTarget.blockers.includes('A OpenAPI product canonical evidence is incomplete'),
  'the global daily supplierCode completeness check must stay in place');

// 7. Daily mode rejects the ET manifest schema: schemas are not interchangeable.
await writeSnapshot('A', ['r1', 'r2', 'r3', 'r4', 'r5'], {r2: 'current'});
await writeSnapshot('B', ['r6']);
await writeManifest({
  A: ['spu-rel-cached', 'spu-rel-current', 'spu-rel-dup'],
  B: ['spu-b-current'],
}, {schemaVersion: 'et-low-inventory-detail-targets/v1'});
const etSchemaRejectedInDaily = await buildPlan('et-schema-rejected-in-daily', {requiredDetailTargets: manifestFile});
assert.equal(etSchemaRejectedInDaily.executable, false);
assert.equal(etSchemaRejectedInDaily.blockers.length, 1);
assert.ok(etSchemaRejectedInDaily.blockers.includes('daily current-detail target manifest is invalid'));

// 8. Manifest date must match the plan date.
await writeSnapshot('A', ['r1', 'r2', 'r3', 'r4', 'r5'], {r2: 'current'});
await writeSnapshot('B', ['r6']);
await writeManifest({
  A: ['spu-rel-cached', 'spu-rel-current', 'spu-rel-dup'],
  B: ['spu-b-current'],
}, {manifestDate: '2000-01-01'});
const dateMismatch = await buildPlan('manifest-date-mismatch', {requiredDetailTargets: manifestFile});
assert.equal(dateMismatch.executable, false);
assert.equal(dateMismatch.blockers.length, 1);
assert.ok(dateMismatch.blockers.includes(
  'daily current-detail target manifest date does not match plan date: 2000-01-01',
));

// 9. Re-computed targets must all be covered by the manifest: a new
// inventory-relevant store+SPU surfaced by the refreshed snapshot that the
// manifest omits fails closed with an explicit blocker, and still appears in
// the emitted targets for the next refresh pass.
await writeSnapshot('A', ['r1', 'r2', 'r3', 'r4', 'r5', 'r8'], {r2: 'current'});
await writeSnapshot('B', ['r6']);
await writeManifest({
  A: ['spu-rel-cached', 'spu-rel-current', 'spu-rel-dup'],
  B: ['spu-b-current'],
});
const uncoveredNewTarget = await buildPlan('uncovered-new-target', {requiredDetailTargets: manifestFile});
assert.equal(uncoveredNewTarget.executable, false);
assert.equal(uncoveredNewTarget.blockers.length, 1);
assert.ok(uncoveredNewTarget.blockers.includes(
  'daily current-detail target set is not fully covered by manifest: store=A spu=spu-new-current',
));
assert.equal(uncoveredNewTarget.counts.detailRefreshTargetCount, 5);
assert.ok(uncoveredNewTarget.detailRefreshTargets.some(target => target.storeKey === 'A' && target.spu === 'spu-new-current'),
  'the uncovered row must still be emitted as a target for the next refresh pass');

// 10. A new non-relevant row surfaced by the refreshed snapshot needs no
// manifest coverage and must not block.
await writeSnapshot('A', ['r1', 'r2', 'r3', 'r4', 'r5', 'r9'], {r2: 'current'});
await writeSnapshot('B', ['r6']);
await writeManifest({
  A: ['spu-rel-cached', 'spu-rel-current', 'spu-rel-dup'],
  B: ['spu-b-current'],
});
const uncoveredNonRelevant = await buildPlan('uncovered-nonrelevant', {requiredDetailTargets: manifestFile});
assert.equal(uncoveredNonRelevant.executable, true);
assert.equal(uncoveredNonRelevant.blockers.length, 0);

// 11. Source contract: targets stay in the payload hash, both manifest schemas
// are wired, and the current-detail gate applies only to inventory-relevant
// rows after evaluatedRows is known; the second build must enforce full
// manifest coverage of the re-computed target set.
const plannerSource = await fs.readFile(
  path.join(ROOT, 'scripts', 'inventory', 'build_daily_inventory_replenishment_plan.mjs'),
  'utf8',
);
assert.match(plannerSource, /stableInventoryHash\(\{[\s\S]*?detailRefreshTargets/,
  'detailRefreshTargets must stay inside the payload hash input');
assert.match(plannerSource, /daily-inventory-detail-targets\/v1/,
  'the daily manifest schema must be accepted and validated');
assert.match(plannerSource, /et-low-inventory-detail-targets\/v1/,
  'the ET manifest schema compatibility must be retained');
assert.match(plannerSource, /if \(!item\.inventoryRelevant\) continue;[\s\S]*?hasCurrentDetail !== true/,
  'the current-detail gate must apply only after inventory relevance is known and only to relevant rows');
assert.match(plannerSource, /not fully covered by manifest/,
  'the second daily build must fail closed when re-computed targets are not fully covered by the manifest');

console.log(JSON.stringify({ok: true, checks: 49}, null, 2));
