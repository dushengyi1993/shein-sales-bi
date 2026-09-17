#!/usr/bin/env node
/**
 * Same-store on-shelf evidence parity test.
 *
 * Production regression (reported 2026-09-17): the daily plan recorded
 * `sameStoreOnShelfSkcs` from linksData.storeLinks unioned with every row of the
 * per-store OpenAPI product snapshot, while the executor re-derived the same set
 * from linksData.storeLinks alone. storeLinks is only a per-store ranked
 * *presentation* sample (generate_bi_portal.mjs store_links LIMIT 2200), so every
 * on-shelf sibling outside that sample looked like a post-plan change: the CX/QY
 * rows below were permanently `pre_submit_blocked` with
 * `reasonCode=same_store_on_shelf_changed` on 2026-09-14/15/16/17.
 *
 * Fixed contract, pinned here:
 *   - planner and executor both build the sibling set through
 *     buildSameStoreOnShelfSkcIndex (storeLinks four-state union the complete
 *     store+canonical coverage matrix skc_list),
 *   - an on-shelf sibling that only the matrix knows about IS recorded,
 *   - a sibling the matrix reports as 已售罄 is NOT recorded even when the
 *     OpenAPI product snapshot says the link is 已上架,
 *   - the executor accepts the plan it was built from and still fails closed on
 *     a genuinely new same-store on-shelf link.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  buildSameStoreOnShelfSkcIndex,
  listCoverageSkcStatuses,
  resolveInventoryIdentityKey,
  sameStoreOnShelfIndexKey,
} from '../lib/inventory_replenishment_policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'same-store-shelf-evidence-'));
const date = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date());
const now = new Date().toISOString();
const STORE = 'A';
const CANONICAL = 'MX-1产品';
const OWN_SKC = 'skc-own';
const MATRIX_ONLY_SKC = 'skc-matrix-only';
const SOLD_OUT_SKC = 'skc-cache-sold-out';

// ---------------------------------------------------------------------------
// 1. Index contract
// ---------------------------------------------------------------------------
assert.deepEqual(listCoverageSkcStatuses('skc-own:已上架 / skc-x:已售罄 / skc-y:待上架'), [
  {skc: 'skc-own', statusName: '已上架'},
  {skc: 'skc-x', statusName: '已售罄'},
  {skc: 'skc-y', statusName: '待上架'},
]);
assert.deepEqual(listCoverageSkcStatuses(''), []);
assert.equal(sameStoreOnShelfIndexKey('a', CANONICAL), sameStoreOnShelfIndexKey('A', CANONICAL));
// The alias-aware identity preserves case for codes that config/product_aliases.json
// does not list, and the executor used to upper-case only its lookup, never the
// index it built. The shared key folds case on both sides so a lower-case code
// form can neither hide a sibling nor invent one.
assert.notEqual(resolveInventoryIdentityKey('mx-1产品'), resolveInventoryIdentityKey(CANONICAL));
assert.equal(sameStoreOnShelfIndexKey('a', 'mx-1产品'), sameStoreOnShelfIndexKey('A', CANONICAL));

const contractIndex = buildSameStoreOnShelfSkcIndex({
  storeLinks: [
    {store_key: 'a', skc: OWN_SKC, standard_goods_sn: 'mx-1产品', is_on_shelf: true},
    {store_key: 'A', skc: SOLD_OUT_SKC, standard_goods_sn: CANONICAL, is_sold_out: true},
  ],
  matrix: [{store_key: 'A', standard_goods_sn: CANONICAL,
    skc_list: `${OWN_SKC}:已上架 / ${SOLD_OUT_SKC}:已售罄 / ${MATRIX_ONLY_SKC}:已上架`}],
});
assert.deepEqual(
  [...contractIndex.get(sameStoreOnShelfIndexKey('A', CANONICAL))].sort(),
  [MATRIX_ONLY_SKC, OWN_SKC].sort(),
  'on-shelf evidence is storeLinks four-state union matrix 已上架, and excludes a 已售罄 link',
);
assert.equal(contractIndex.get(sameStoreOnShelfIndexKey('B', CANONICAL)), undefined,
  'sibling evidence must not leak across stores');

// ---------------------------------------------------------------------------
// 2. Fixture: one store, one canonical, three links
// ---------------------------------------------------------------------------
const productsDir = path.join(tmp, 'products');
await fs.mkdir(path.join(productsDir, STORE), {recursive: true});
await fs.writeFile(path.join(tmp, 'stores.json'), JSON.stringify({stores: [{storeKey: STORE, enabled: true}]}));
await fs.writeFile(path.join(productsDir, STORE, 'latest.json'), JSON.stringify({
  fetchedAt: now,
  summary: {stockFailedChunkCount: 0, detailMissingAfterFallbackCount: 0},
  normalizedRows: [
    {
      storeKey: STORE, spu: 'spu-own', skc: OWN_SKC, skuCodes: ['sku-own'], supplierCode: CANONICAL,
      shelfStatusCode: '1', sheinUsableInventory: 5, sheinInventoryQuantity: 5, sheinLockedQuantity: 0,
      sourceCompleteness: {hasCurrentDetail: true},
    },
    {
      // Only the OpenAPI product snapshot knows this link, and its product-list
      // shelf status cannot express 已售罄: the matrix below is the four-state
      // truth and it must win.
      storeKey: STORE, spu: 'spu-cache-sold-out', skc: SOLD_OUT_SKC, skuCodes: ['sku-cache-sold-out'],
      supplierCode: CANONICAL, shelfStatusCode: '1', sheinUsableInventory: 0, sheinInventoryQuantity: 0,
      sheinLockedQuantity: 0, sourceCompleteness: {hasCurrentDetail: true},
    },
  ],
}));
await fs.writeFile(path.join(tmp, 'inventoryTrend.json'), JSON.stringify({
  cachedAt: now,
  data: {
    inventoryDepletion: {
      products: [{
        match_key: 'MX1', standard_goods_sn: CANONICAL, current_sellable_quantity: 50,
        et_store_snapshot_date: date, inventory_match_status: 'matched', days_of_supply_on_hand: 150,
      }],
    },
  },
}));
const linksData = {
  cachedAt: now,
  data: {
    storeLinks: [{
      store_key: STORE, skc: OWN_SKC, standard_goods_sn: CANONICAL, shelf_status_name: '已上架', is_on_shelf: true,
      c7_eps_uv: 100, c7_goods_uv: 10, c7_sale_cnt: 0, c30_sale_cnt: 0,
    }],
    matrix: [{
      store_key: STORE, standard_goods_sn: CANONICAL,
      skc_list: `${OWN_SKC}:已上架 / ${SOLD_OUT_SKC}:已售罄 / ${MATRIX_ONLY_SKC}:已上架`,
    }],
  },
};
await fs.writeFile(path.join(tmp, 'linksData.json'), JSON.stringify(linksData));

// ---------------------------------------------------------------------------
// 3. Planner records the matrix sibling and never the 已售罄 one
// ---------------------------------------------------------------------------
const planFile = path.join(tmp, 'plan.json');
const savedArgv = process.argv;
process.argv = [
  process.execPath,
  path.join(ROOT, 'scripts', 'inventory', 'build_daily_inventory_replenishment_plan.mjs'),
  '--date', date,
  '--policy', path.join(ROOT, 'config', 'inventory_replenishment_policy.json'),
  '--stores', path.join(tmp, 'stores.json'),
  '--products-dir', productsDir,
  '--bi-data', path.join(tmp, 'inventoryTrend.json'),
  '--links-data', path.join(tmp, 'linksData.json'),
  '--out', planFile,
];
try {
  await import(`./inventory/build_daily_inventory_replenishment_plan.mjs?same-store-shelf=${Date.now()}`);
} finally {
  process.argv = savedArgv;
}
const plan = JSON.parse(await fs.readFile(planFile, 'utf8'));
assert.equal(plan.executable, true, plan.blockers.join('; '));
const plannedRows = [...(plan.actionable || []), ...(plan.ignored || [])];
const ownRow = plannedRows.find(row => row.skc === OWN_SKC);
assert.ok(ownRow, 'the low-inventory row must be evaluated');
assert.deepEqual(ownRow.sameStoreOnShelfSkcs, [MATRIX_ONLY_SKC],
  'the matrix-only 已上架 sibling must be recorded, and the cache-only 已售罄 sibling must not be');

// ---------------------------------------------------------------------------
// 4. Executor accepts its own plan (the production false block) ...
// ---------------------------------------------------------------------------
const executorPlanFile = path.join(tmp, 'executor-plan.json');
const executorLinksFile = path.join(tmp, 'executor-links.json');
const executorOut = path.join(tmp, 'executor-result.json');
await fs.writeFile(executorPlanFile, JSON.stringify(plan, null, 2));
await fs.writeFile(executorLinksFile, JSON.stringify(linksData));
const runExecutor = async () => {
  const argv = process.argv;
  process.argv = [
    process.execPath,
    path.join(ROOT, 'scripts', 'inventory', 'execute_daily_inventory_replenishment_plan.mjs'),
    '--plan', executorPlanFile,
    '--policy', path.join(ROOT, 'config', 'inventory_replenishment_policy.json'),
    '--config', path.join(tmp, 'stores.json'),
    '--bi-data', path.join(tmp, 'inventoryTrend.json'),
    '--links-data', executorLinksFile,
    '--out', executorOut,
  ];
  const savedExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await import(`./inventory/execute_daily_inventory_replenishment_plan.mjs?same-store-shelf=${Math.random()}`);
  } finally {
    process.argv = argv;
    process.exitCode = savedExitCode;
  }
  return JSON.parse(await fs.readFile(executorOut, 'utf8'));
};
const accepted = (await runExecutor()).results.find(row => row.skc === OWN_SKC);
assert.ok(accepted, 'the executor must evaluate the planned row');
assert.notEqual(accepted.state, 'pre_submit_blocked',
  `a plan built from the shared sibling evidence must not be pre-submit-blocked: ${JSON.stringify(accepted)}`);
assert.equal(accepted.preSubmitExclusion, undefined, JSON.stringify(accepted));

// ---------------------------------------------------------------------------
// 5. ... and still fails closed on a genuinely new same-store on-shelf link
// ---------------------------------------------------------------------------
const controlLinks = structuredClone(linksData);
controlLinks.data.storeLinks.push({
  store_key: STORE, skc: 'skc-new-sibling', standard_goods_sn: CANONICAL, shelf_status_name: '已上架',
  is_on_shelf: true, c7_eps_uv: 10, c7_goods_uv: 1, c7_sale_cnt: 0, c30_sale_cnt: 0,
});
await fs.writeFile(executorLinksFile, JSON.stringify(controlLinks));
const changed = (await runExecutor()).results.find(row => row.skc === OWN_SKC);
assert.equal(changed.state, 'pre_submit_blocked', JSON.stringify(changed));
assert.equal(changed.preSubmitExclusion?.reasonCode, 'same_store_on_shelf_changed', JSON.stringify(changed));
assert.deepEqual(changed.preSubmitExclusion.plannedOnShelfSkcs, [MATRIX_ONLY_SKC]);
assert.deepEqual(changed.preSubmitExclusion.observedOnShelfSkcs, [MATRIX_ONLY_SKC, 'skc-new-sibling'].sort());

// ---------------------------------------------------------------------------
// 6. Source discipline: one shared derivation, no local re-implementation
// ---------------------------------------------------------------------------
for (const file of [
  'scripts/inventory/build_daily_inventory_replenishment_plan.mjs',
  'scripts/inventory/execute_daily_inventory_replenishment_plan.mjs',
]) {
  const source = await fs.readFile(path.join(ROOT, file), 'utf8');
  assert.match(source, /buildSameStoreOnShelfSkcIndex\(\{/, `${file} must use the shared sibling index`);
  assert.doesNotMatch(source, /onShelfSkcsByStoreMatchKey\.set\(/,
    `${file} must not re-derive the sibling index locally`);
}

console.log(JSON.stringify({
  ok: true,
  tests: [
    'index-contract-four-state-union',
    'planner-records-matrix-only-sibling',
    'planner-excludes-sold-out-cache-sibling',
    'executor-accepts-shared-evidence-plan',
    'executor-still-blocks-new-on-shelf-sibling',
    'single-shared-derivation',
  ],
}, null, 2));
