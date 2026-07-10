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

console.log('bi_product_section_contract: slim sales/traffic sections and bounded matrix rendering checks passed');
