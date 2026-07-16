#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'relisted-cost-fallback-'));
const skc = 'sv260203191115934454301';
const canonical = 'SK-13034杆式吸尘器';
const linksData = path.join(tmp, 'linksData.json');
const priceOverrides = path.join(tmp, 'price-overrides.json');
const costMap = path.join(tmp, 'cost-map.json');
const liveScan = path.join(tmp, 'live.json');
const historyDir = path.join(tmp, 'shein_links');
const storeHistory = path.join(historyDir, 'NM');
const storesConfig = path.join(tmp, 'stores.json');
await fs.mkdir(storeHistory, {recursive: true});
await fs.writeFile(storesConfig, JSON.stringify({stores: [{storeKey: 'NM', enabled: true}]}));

await fs.writeFile(linksData, JSON.stringify({storeLinks: [{
  store_key: 'NM', skc, standard_goods_sn: canonical, raw_goods_sn: canonical,
  is_on_shelf: true, is_sold_out: false, is_out_shelf: false,
  shelf_status_name: '已上架', shelf_age_days: 67, c7_eps_uv: 222,
  original_supply_price_range_sar: '273.52', activity_label: '',
}]}));
await fs.writeFile(priceOverrides, JSON.stringify({items: []}));
await fs.writeFile(costMap, JSON.stringify({
  costMap: {'SK-13034': 95, [canonical]: 95},
  trueCostMap: {[canonical]: {
    unitCostSar: 95,
    storageUnitCostSar: null,
    trueUnitCostSar: null,
    storageMethod: 'missing',
  }},
}));
await fs.writeFile(liveScan, JSON.stringify({ok: true, partial: false, rows: []}));
const snapshot = (status, hasActivity = false) => ({linkRows: [{
  storeKey: 'NM', skc, standardGoodsSn: canonical,
  shelfStatus: status,
  shelfStatusName: status === 'ON_SHELF' ? '已上架' : '已售罄',
  isOnShelf: status === 'ON_SHELF', isSoldOut: status === 'SOLD_OUT', hasActivity,
}]});
await fs.writeFile(path.join(storeHistory, '2026-07-06.json'), JSON.stringify(snapshot('SOLD_OUT')));
await fs.writeFile(path.join(storeHistory, '2026-07-07.json'), JSON.stringify(snapshot('ON_SHELF')));

const reportJson = path.join(tmp, 'report.json');
const result = spawnSync(process.execPath, [
  'scripts/marketing/build_new_listing_limited_discount_plan.mjs',
  '--date', '2026-07-12',
  '--links-data', linksData,
  '--price-overrides', priceOverrides,
  '--cost-map', costMap,
  '--current-marketing-live-scan', liveScan,
  '--link-history-dir', historyDir,
  '--stores-config', storesConfig,
  '--no-supplemental-price-overrides',
  '--out-dir', path.join(tmp, 'out'),
  '--report-json', reportJson,
  '--report-md', path.join(tmp, 'report.md'),
], {encoding: 'utf8'});

assert.equal(result.status, 0, result.stderr || result.stdout);
const payload = JSON.parse(result.stdout);
assert.equal(payload.actionable, 1);
assert.equal(payload.blocked, 0);
const report = JSON.parse(await fs.readFile(reportJson, 'utf8'));
assert.equal(report.rows[0].limitedDiscountPrice, 126.67);
assert.equal(report.rows[0].topTierPriceSource, 'derived_from_product_cost_top_treatment_margin');
assert.equal(report.rows[0].targetPriceEvidenceScope, 'product_cost_top_treatment_fallback');
assert.equal(report.rows[0].productUnitCostSar, 95);
assert.equal(report.rows[0].storageUnitCostSar, null);

console.log(JSON.stringify({ok: true, test: 'relisted_cost_exists_missing_storage_still_derives_top_treatment'}));
