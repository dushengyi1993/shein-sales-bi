#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generator = fs.readFileSync(path.join(root, 'scripts', 'generate_bi_portal.mjs'), 'utf8');
const linkFetcher = fs.readFileSync(path.join(root, 'scripts', 'fetch_shein_links.mjs'), 'utf8');
const server = fs.readFileSync(path.join(root, 'scripts', 'serve_bi_portal.mjs'), 'utf8');
const client = fs.readFileSync(path.join(root, 'scripts', 'bi_app', 'client.js'), 'utf8');
const prewarm = fs.readFileSync(path.join(root, 'scripts', 'prewarm_bi_portal_sections.sh'), 'utf8');
const warehouseSchema = fs.readFileSync(path.join(root, 'infra', 'warehouse', 'schema.sql'), 'utf8');

for (const source of [generator, server, client, prewarm]) {
  assert.match(source, /productSalesDaily/, 'productSalesDaily must exist across generator, server, client, and prewarm');
  assert.match(source, /homeTrafficDaily/, 'homeTrafficDaily must exist across generator, server, client, and prewarm');
}
assert.match(client, /products:\['linksData','productState','productSalesDaily'\]/, 'product page must use the lightweight live-state overlay without loading the oversized homeRankings section');
assert.match(client, /home:\['homeRankings','afterSales','homeProfit','homeTrafficDaily','liveSalesToday'\]/, 'home must load slim traffic plus the current-day profit overlay');
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
assert.match(
  productTrafficSql,
  /store_latest_link AS \(\s*SELECT store_key, max\(snapshot_date\) AS link_date\s*FROM fact\.link_master_snapshot\s*GROUP BY store_key/,
  'standalone traffic SQL must anchor first_shelf_time on each store latest link snapshot',
);
assert.match(
  productTrafficSql,
  /JOIN store_latest_link sll\s+ON sll\.store_key = l\.store_key\s+AND sll\.link_date = l\.snapshot_date/,
  'standalone latest_link_status must read the per-store latest snapshot only',
);
assert.equal(
  (productTrafficSql.match(/max\(l\.first_shelf_time\) AS first_shelf_time/g) || []).length,
  2,
  'standalone traffic SQL must publish first_shelf_time both in latest_link_status and in the emitted rows',
);
assert.match(
  productTrafficSql,
  /LEFT JOIN latest_link_status l ON l\.store_key = r\.store_key AND l\.skc = r\.skc/,
  'standalone traffic rows must join current link facts without date alignment',
);

const coreTrafficSql = generator.slice(
  generator.indexOf('product_traffic_daily AS (', generator.indexOf('store_latest_perf AS (')),
  generator.indexOf('trend_business_daily AS ('),
);
const coreLatestLinkAt = generator.indexOf('store_latest_link AS (', generator.indexOf('actions AS ('));
const coreLatestLinkSql = generator.slice(coreLatestLinkAt, generator.indexOf('store_latest_perf AS (', coreLatestLinkAt));
assert.match(coreLatestLinkSql, /latest_link_status AS MATERIALIZED \(/, 'core traffic must deduplicate the latest link snapshot before joining metrics');
assert.match(coreLatestLinkSql, /max\(l\.first_shelf_time\) AS first_shelf_time/);
assert.match(coreLatestLinkSql, /GROUP BY l\.store_key, l\.skc/, 'core latest link facts must be unique per store and SKC');
assert.match(coreTrafficSql, /max\(l\.first_shelf_time\) AS first_shelf_time/, 'core traffic SQL must publish first_shelf_time');
assert.match(
  coreTrafficSql,
  /LEFT JOIN latest_link_status l\s+ON l\.store_key = p\.store_key\s+AND l\.skc = p\.skc/,
  'core traffic must join one deduplicated current link fact per store and SKC',
);
assert.doesNotMatch(coreTrafficSql, /l\.snapshot_date = p\.date/, 'core traffic must not align link facts to the performance date');

assert.match(client, /trafficSortHead\('firstShelf','首次上架'\)/, 'traffic detail must expose a sortable first-shelf column');
assert.match(
  client,
  /if\(key==='firstShelf'\)return String\(r\.first_shelf_time\|\|''\)/,
  'traffic first-shelf sort must compare the raw timestamp string',
);
assert.match(
  client,
  /if\(key==='firstShelf'\)\{const am=!av,bm=!bv;if\(am!==bm\)return am\?1:-1\}/,
  'traffic first-shelf sorting must keep missing timestamps last in both directions',
);
assert.match(
  client,
  /\['status','store','product','skc','tags','firstShelf'\]\.includes\(k\)\?'asc':'desc'/,
  'traffic first-shelf column must default to ascending order like other text columns',
);
assert.match(client, /fmtStamp\(r\.first_shelf_time\)/, 'traffic detail row must render first shelf time via the timestamp formatter');

const linksDataSql = generator.slice(
  generator.indexOf('store_latest_perf AS ('),
  generator.indexOf('matrix AS ('),
);
assert.match(linksDataSql, /link_traffic_windows AS \(/, 'link data must aggregate add-to-cart visitors by link');
assert.match(linksDataSql, /AS c7_cart_uv/, 'link data must expose a seven-day add-to-cart visitor metric');
assert.match(linksDataSql, /AS c30_cart_uv/, 'link data must expose a 30-day add-to-cart visitor metric');
assert.match(linksDataSql, /c7_eps_uv, c7_goods_uv, c7_cart_uv, c7_pay_rate/, 'store links must publish c7 cart visitors beside the other c7 metrics');
assert.match(linkFetcher, /c7CartUv:\s*num\(c7\?\.cartUvIdx,\s*0\)/, 'future link snapshots must persist the platform c7 cart visitor metric');
assert.match(linkFetcher, /c30CartUv:\s*num\(c30\?\.cartUvIdx,\s*0\)/, 'future link snapshots must persist the platform c30 cart visitor metric');

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
assert.match(warehouseSchema, /latest_running AS \(/, 'ET current inventory view must retain latest running-balance evidence');
assert.match(warehouseSchema, /ET流水零余额回填/, 'current complete snapshots must carry forward known zero 09-warehouse balances instead of reporting them unmatched');
assert.match(warehouseSchema, /FROM store_agg_complete s/, 'ET inventory view must include zero-balance carry-forward rows');

console.log('bi_product_section_contract: slim sales/traffic sections, traffic first-shelf column, inventory cost continuity, and bounded matrix rendering checks passed');
