#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generator = fs.readFileSync(path.join(root, 'scripts', 'generate_bi_portal.mjs'), 'utf8');
const server = fs.readFileSync(path.join(root, 'scripts', 'serve_bi_portal.mjs'), 'utf8');
const client = fs.readFileSync(path.join(root, 'scripts', 'bi_app', 'client.js'), 'utf8');
const prewarm = fs.readFileSync(path.join(root, 'scripts', 'prewarm_bi_portal_sections.sh'), 'utf8');

for (const source of [generator, server, client, prewarm]) {
  assert.match(source, /productSalesDaily/, 'productSalesDaily must exist across generator, server, client, and prewarm');
  assert.match(source, /homeTrafficDaily/, 'homeTrafficDaily must exist across generator, server, client, and prewarm');
}
assert.match(client, /products:\['linksData','productSalesDaily'\]/, 'product page must not load the oversized homeRankings section');
assert.match(client, /home:\['homeRankings','afterSales','homeProfit','homeTrafficDaily'\]/, 'home must load the slim traffic section');
assert.doesNotMatch(client.match(/const BASE_NEED=\{[^;]+/)?.[0] || '', /home:\[[^\]]*productTrafficDaily/, 'home must not load SKC-level traffic details');
assert.match(client, /source=A\(D\.productSalesDaily\)\.length\?A\(D\.productSalesDaily\):A\(rankingProductRows\(\)\)/, 'product sales keeps a backward-compatible fallback');
const standaloneSections = generator.slice(generator.indexOf('const STANDALONE_SECTION_SQL'));
const productSql = standaloneSections.match(/productSalesDaily:\s*`[\s\S]*?`,\s*priceScatter:/)?.[0] || '';
assert.match(productSql, /net_revenue_sar/);
assert.match(productSql, /AS sales_sar/);
assert.match(productSql, /AS quantity/);
assert.match(productSql, /AS orders/);
assert.match(productSql, /profitMart\('profit_order_item'\)/);
assert.doesNotMatch(productSql, /gross_sales_sar|goods_title|skc_list/, 'slim product section must not reintroduce large unused fields');
assert.match(client, /productGroupLimit:40/);
assert.match(client, /data-product-matrix-more/);

const homeTrafficSql = standaloneSections.match(/homeTrafficDaily:\s*`[\s\S]*?`,\s*productTrafficDaily:/)?.[0] || '';
assert.match(homeTrafficSql, /raw_home_traffic AS MATERIALIZED/);
assert.match(homeTrafficSql, /home_traffic_product_keys AS MATERIALIZED/);
assert.match(homeTrafficSql, /GROUP BY r\.date, r\.store_key, k\.standard_goods_sn/);
assert.doesNotMatch(homeTrafficSql, /shelf_status|is_on_shelf|nullif\(r\.skc/, 'home traffic must not contain detail-only status/SKC fields');

const productTrafficSql = standaloneSections.match(/productTrafficDaily:\s*`[\s\S]*?`,\s*productSalesDaily:/)?.[0] || '';
assert.match(productTrafficSql, /raw_product_traffic AS MATERIALIZED/);
assert.match(productTrafficSql, /product_traffic_keys AS MATERIALIZED/);
assert.match(productTrafficSql, /latest_link_status AS MATERIALIZED/);

const inventorySql = generator.slice(
  generator.indexOf('inventory_cost_product AS ('),
  generator.indexOf('inventory_depletion_batches AS ('),
);
assert.match(inventorySql, /LEFT JOIN mart\.product_unit_cost_by_match_key cost_rate ON cost_rate\.match_key = k\.match_key/);
assert.match(inventorySql, /round\(unit_cost_sar::numeric, 2\) AS unit_cost_sar/);
assert.match(inventorySql, /round\(cost_arrived_cost_sar::numeric, 2\) AS arrived_cost_sar/);
assert.doesNotMatch(inventorySql, /NULL::numeric AS unit_cost_sar/, 'ET-backed inventory rows must retain known cost evidence');
assert.match(inventorySql, /gross_sold_14d/, 'inventory projection must expose a real 14-day sales window');
assert.match(generator, /sum\(gross_quantity\) FILTER \(WHERE created_date >= \(SELECT max_date FROM anchor\) - interval '13 days'\) AS gross_sold_14d/, '14-day window is anchored inclusively at 13 days before the latest sales date');
assert.match(inventorySql, /inventory_match_status/, 'inventory projection must publish ET match freshness state');
assert.match(inventorySql, /WHEN et\.match_key IS NULL THEN 'not_matched'/, 'unmatched keys must not masquerade as ET inventory');
assert.match(inventorySql, /round\(et_ship_arrived_quantity::numeric, 0\) AS arrived_quantity/, 'arrived quantity must not reuse current sellable quantity');
assert.match(inventorySql, /least\(et_ship_first_arrived_date, cost_first_arrived_date\) AS first_arrived_date/, 'first arrival must be the earliest known arrival');
assert.match(inventorySql, /greatest\(et_ship_latest_arrived_date, cost_latest_arrived_date\) AS latest_arrived_date/, 'latest arrival must be the latest known arrival');
assert.match(inventorySql, /inventory_match_status = 'matched' AND coalesce\(et_estimated_available_qty,0\) <= 0/, 'only fresh ET matches can be labelled out of stock');

console.log('bi_product_section_contract: slim sales/traffic sections, inventory cost continuity, and bounded matrix rendering checks passed');
