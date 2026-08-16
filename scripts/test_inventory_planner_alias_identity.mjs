#!/usr/bin/env node
/**
 * Planner-level alias identity test for the 2026-08-12 YJ ET low-inventory
 * guard incident: OpenAPI supplierCode `SK-3065蒸汽熨烫机` and links
 * standard_goods_sn `SK-GT-3065蒸汽熨烫机` are the same canonical, so the
 * et_low_inventory_safety plan must NOT report a canonical evidence conflict,
 * while a genuinely different links code must still fail closed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'planner-alias-identity-'));
const date = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date());
const now = new Date().toISOString();

const productsDir = path.join(tmp, 'products');
await fs.mkdir(path.join(productsDir, 'YJ'), {recursive: true});
await fs.writeFile(path.join(tmp, 'stores.json'), JSON.stringify({stores: [{storeKey: 'YJ', enabled: true}]}));

const productRow = {
  storeKey: 'YJ',
  spu: 'v2606281958253718',
  skc: 'sv260628195825371800298',
  skuCodes: ['sv260628195825371800298'],
  supplierCode: 'SK-3065蒸汽熨烫机',
  shelfStatusCode: '1',
  sheinUsableInventory: 0,
  sheinInventoryQuantity: 0,
  sheinLockedQuantity: 0,
  sourceCompleteness: {hasCurrentDetail: true},
};
await fs.writeFile(path.join(productsDir, 'YJ', 'latest.json'), JSON.stringify({
  fetchedAt: now,
  summary: {stockFailedChunkCount: 0, detailMissingAfterFallbackCount: 0},
  normalizedRows: [productRow],
}));

await fs.writeFile(path.join(tmp, 'inventoryTrend.json'), JSON.stringify({
  cachedAt: now,
  data: {
    inventoryDepletion: {
      products: [{
        match_key: 'SKGT3065',
        standard_goods_sn: 'SK-GT-3065蒸汽熨烫机',
        current_sellable_quantity: 2,
        et_store_snapshot_date: date,
        inventory_match_status: 'matched',
        days_of_supply_on_hand: 60,
      }],
    },
  },
}));

const baseLinks = {
  cachedAt: now,
  data: {
    storeLinks: [{
      store_key: 'YJ',
      skc: 'sv260628195825371800298',
      // Incident shape: links standard_goods_sn canonicalInventoryKey form is
      // SKGT3065 while the OpenAPI supplierCode form is SK3065; both are the
      // same alias-resolved canonical SK-GT-3065蒸汽熨烫机.
      standard_goods_sn: 'SKGT3065蒸汽熨烫机',
      shelf_status_name: '已上架',
      is_on_shelf: true,
      c7_eps_uv: 100,
      c7_goods_uv: 10,
      c7_sale_cnt: 0,
      c30_sale_cnt: 0,
    }],
  },
};

async function buildPlan(links, name) {
  const linksFile = path.join(tmp, `${name}-links.json`);
  await fs.writeFile(linksFile, JSON.stringify(links));
  const out = path.join(tmp, `${name}-plan.json`);
  const savedArgv = process.argv;
  const savedExitCode = process.exitCode;
  process.exitCode = undefined;
  process.argv = [
    process.execPath,
    path.join(ROOT, 'scripts', 'inventory', 'build_daily_inventory_replenishment_plan.mjs'),
    '--date', date,
    '--policy', path.join(ROOT, 'config', 'inventory_replenishment_policy.json'),
    '--stores', path.join(tmp, 'stores.json'),
    '--products-dir', productsDir,
    '--bi-data', path.join(tmp, 'inventoryTrend.json'),
    '--links-data', linksFile,
    '--operation-mode', 'et_low_inventory_safety',
    '--out', out,
  ];
  try {
    await import(`./inventory/build_daily_inventory_replenishment_plan.mjs?alias-identity=${name}-${Date.now()}`);
  } finally {
    process.argv = savedArgv;
    process.exitCode = savedExitCode;
  }
  return JSON.parse(await fs.readFile(out, 'utf8'));
}

// 1. alias-equivalent evidence: SK-3065蒸汽熨烫机 (OpenAPI) vs
// SK-GT-3065蒸汽熨烫机 (links) is NOT a canonical conflict.
const aliasPlan = await buildPlan(baseLinks, 'alias-equivalent');
assert.equal(aliasPlan.executable, true, aliasPlan.blockers.join('; '));
assert.equal(aliasPlan.blockers.length, 0, aliasPlan.blockers.join('; '));
assert.ok(!aliasPlan.blockers.some(text => /canonical evidence/.test(text)),
  'alias-equivalent evidence must not produce a canonical-evidence blocker');
const allocation = aliasPlan.lowEtAllocations.find(row => row.skc === 'sv260628195825371800298');
assert.ok(allocation, 'the alias-equivalent YJ row must be processed for low-ET allocation');
assert.equal(allocation.canonical, 'SK-GT-3065蒸汽熨烫机');
assert.equal(allocation.matchKey, 'SK-GT-3065蒸汽熨烫机',
  'grouping matchKey is the alias-resolved identity so explicitly separate products never collapse');
assert.equal(aliasPlan.counts.lowEtBlockedCanonicalCount, 0);

// 2. a genuinely different links code still fails closed.
const conflictingLinks = structuredClone(baseLinks);
conflictingLinks.data.storeLinks[0].standard_goods_sn = 'SK11004蒸汽熨烫机';
const conflictPlan = await buildPlan(conflictingLinks, 'real-conflict');
assert.equal(conflictPlan.executable, false);
assert.ok(conflictPlan.blockers.some(text => text.startsWith('low-ET OpenAPI product canonical evidence does not match current BI link: store=YJ')),
  conflictPlan.blockers.join('; '));

console.log(JSON.stringify({ok: true, tests: ['alias-equivalent-no-conflict', 'real-difference-fails-closed']}, null, 2));
