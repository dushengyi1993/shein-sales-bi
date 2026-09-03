#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// 1. Static contract & SQL invariant verification
const generateBiPortalPath = path.join(ROOT, 'scripts', 'generate_bi_portal.mjs');
const generateBiPortalCode = fs.readFileSync(generateBiPortalPath, 'utf8');

assert.ok(
  generateBiPortalCode.includes('store_links_ranked AS ('),
  'generate_bi_portal.mjs must define store_links_ranked CTE with row_number() OVER (PARTITION BY store_key)'
);

assert.ok(
  generateBiPortalCode.includes('row_number() OVER (') &&
  generateBiPortalCode.includes('PARTITION BY store_key') &&
  generateBiPortalCode.includes('ORDER BY coalesce(c30_sale_cnt,0) DESC, coalesce(c30_goods_uv, goods_uv, 0) DESC, skc'),
  'store_links_ranked must preserve per-store business priority ranking: c30_sale_cnt DESC, c30_goods_uv/goods_uv DESC, skc'
);

assert.ok(
  generateBiPortalCode.includes('ORDER BY store_rank, store_key'),
  'store_links must order globally by store_rank, store_key for fair round-robin allocation across all stores'
);

assert.ok(
  generateBiPortalCode.includes('LIMIT 2200'),
  'store_links must preserve the global limit of 2200'
);

// 2. Behavioral verification of SQL logic simulation
// All 19 SHEIN stores from config/stores.json
const storesConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'stores.json'), 'utf8'));
const allStores = (storesConfig.stores ? storesConfig.stores.map(s => s.storeKey) : storesConfig).sort();

assert.equal(allStores.length, 19, 'Expected exactly 19 stores in stores.json');
assert.ok(allStores.includes('ZL'), 'Store list must include ZL');
assert.equal(allStores[allStores.length - 1], 'ZL', 'ZL must be the last store alphabetically to test starvation edge cases');

// Synthesize dataset: 19 stores, with earlier stores having large number of links (e.g. 180 links each).
// If previous naive ORDER BY store_key LIMIT 2200 were used, the first 12 stores (12 * 180 = 2160) + 13th store (40 links)
// would exhaust the quota of 2200, leaving stores 14..19 (including ZL) with 0 links (complete starvation).
const synthesizedRows = [];
for (const store of allStores) {
  const linkCount = store === 'ZL' ? 120 : 180;
  for (let i = 1; i <= linkCount; i++) {
    synthesizedRows.push({
      store_key: store,
      skc: store + '-SKC-' + String(i).padStart(4, '0'),
      c30_sale_cnt: i <= 10 ? 100 - i : (i <= 50 ? 50 - i : 0),
      c30_goods_uv: i * 2,
      goods_uv: i,
    });
  }
}

assert.ok(synthesizedRows.length > 3000, 'Synthesized dataset has ' + synthesizedRows.length + ' rows > 3000');

// --- Naive Old SQL logic simulation ---
// ORDER BY store_key, coalesce(c30_sale_cnt,0) DESC, coalesce(c30_goods_uv, goods_uv, 0) DESC, skc LIMIT 2200
const naiveResults = [...synthesizedRows].sort((a, b) => {
  if (a.store_key !== b.store_key) return a.store_key.localeCompare(b.store_key);
  if (b.c30_sale_cnt !== a.c30_sale_cnt) return b.c30_sale_cnt - a.c30_sale_cnt;
  if (b.c30_goods_uv !== a.c30_goods_uv) return b.c30_goods_uv - a.c30_goods_uv;
  return a.skc.localeCompare(b.skc);
}).slice(0, 2200);

const naiveZlLinks = naiveResults.filter(r => r.store_key === 'ZL');
assert.equal(
  naiveZlLinks.length,
  0,
  'Baseline confirmation: under naive store_key ordering, alphabetical tail store ZL is completely starved (0 links)'
);

// --- New SQL logic simulation ---
// Step 1: Per-store row_number()
const perStoreBuckets = new Map();
for (const row of synthesizedRows) {
  if (!perStoreBuckets.has(row.store_key)) perStoreBuckets.set(row.store_key, []);
  perStoreBuckets.get(row.store_key).push(row);
}

const rankedRows = [];
for (const [store, rows] of perStoreBuckets.entries()) {
  rows.sort((a, b) => {
    if (b.c30_sale_cnt !== a.c30_sale_cnt) return b.c30_sale_cnt - a.c30_sale_cnt;
    if (b.c30_goods_uv !== a.c30_goods_uv) return b.c30_goods_uv - a.c30_goods_uv;
    return a.skc.localeCompare(b.skc);
  });
  rows.forEach((r, idx) => {
    rankedRows.push({...r, store_rank: idx + 1});
  });
}

// Step 2: Global ORDER BY store_rank, store_key LIMIT 2200
const patchedResults = [...rankedRows].sort((a, b) => {
  if (a.store_rank !== b.store_rank) return a.store_rank - b.store_rank;
  return a.store_key.localeCompare(b.store_key);
}).slice(0, 2200);

// Assertions on Patched Results:
// 1. Total count equals 2200
assert.equal(patchedResults.length, 2200, 'Patched query must respect global limit of 2200');

// 2. All 19 stores have links represented (zero starvation)
const coveredStores = new Set(patchedResults.map(r => r.store_key));
assert.equal(coveredStores.size, 19, 'All 19 stores must be covered in store_links');
for (const store of allStores) {
  assert.ok(coveredStores.has(store), 'Store ' + store + ' must be present in store_links');
}

// 3. ZL has full fair allocation (at least 2200 / 19 = ~115 links)
const zlLinks = patchedResults.filter(r => r.store_key === 'ZL');
assert.ok(
  zlLinks.length >= 115,
  'Store ZL must receive its fair round-robin quota: received ' + zlLinks.length + ' >= 115'
);

// 4. Per-store ranking priority is strictly preserved
for (const store of allStores) {
  const storeRows = patchedResults.filter(r => r.store_key === store);
  for (let i = 1; i < storeRows.length; i++) {
    const prev = storeRows[i - 1];
    const curr = storeRows[i];
    assert.ok(
      prev.c30_sale_cnt >= curr.c30_sale_cnt,
      'Store ' + store + ' row ' + i + ' violates c30_sale_cnt descending priority'
    );
    if (prev.c30_sale_cnt === curr.c30_sale_cnt) {
      assert.ok(
        prev.c30_goods_uv >= curr.c30_goods_uv,
        'Store ' + store + ' row ' + i + ' violates secondary goods_uv descending priority'
      );
    }
  }
}

console.log(JSON.stringify({
  ok: true,
  test: 'test_links_data_store_coverage',
  totalLimit: patchedResults.length,
  storesCovered: coveredStores.size,
  zlLinksCount: zlLinks.length,
  naiveZlLinksCount: naiveZlLinks.length,
}, null, 2));
