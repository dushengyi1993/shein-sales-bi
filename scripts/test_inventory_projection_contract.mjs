#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inventoryMatchStatus, normalizeInventoryProjection} from '../lib/inventory_projection_contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = fs.readFileSync(path.join(root, 'scripts', 'bi_app', 'client.js'), 'utf8');
const lark = fs.readFileSync(path.join(root, 'scripts', 'lark_sales_qa_bot.mjs'), 'utf8');
const generator = fs.readFileSync(path.join(root, 'scripts', 'generate_bi_portal.mjs'), 'utf8');
const standards = fs.readFileSync(path.join(root, 'scripts', 'marketing', 'export_dsy_marketing_standards.mjs'), 'utf8');
const stackReview = fs.readFileSync(path.join(root, 'scripts', 'marketing', 'export_marketing_stack_review.mjs'), 'utf8');
const inventoryWriter = fs.readFileSync(path.join(root, 'scripts', 'marketing', 'manage_manual_limited_discount_inventory.mjs'), 'utf8');

const freshZero = normalizeInventoryProjection({inventory_match_status: 'matched', et_estimated_available_qty: 0, et_ship_arrived_quantity: 21});
assert.equal(freshZero.has_et_inventory, true);
assert.equal(freshZero.current_sellable_quantity, 0);
assert.equal(freshZero.arrived_quantity, 21);
assert.equal(freshZero.is_fresh_matched_out_of_stock, true, 'fresh matched zero is eligible for an out-of-stock claim');

for (const status of ['not_matched', 'stale']) {
  const projection = normalizeInventoryProjection({inventory_match_status: status, et_estimated_available_qty: 0, et_ship_arrived_quantity: 8});
  assert.equal(projection.current_sellable_quantity, null, `${status} current sellable stock is unknown`);
  assert.equal(projection.is_fresh_matched_out_of_stock, false, `${status} must never be called out of stock`);
}

assert.equal(inventoryMatchStatus({has_et_inventory: true}), 'matched', 'legacy snapshots remain readable');
assert.equal(inventoryMatchStatus({}), 'not_matched', 'missing ET evidence is not a zero-stock record');
assert.equal(normalizeInventoryProjection({inventory_match_status: 'matched'}).arrived_quantity, null, 'unknown shipment arrivals stay null');
assert.match(client, /未匹配或快照过期不会被当作 0 或断货/, 'active client copy preserves the tri-state invariant');
assert.match(lark, /ET匹配 \$\{inventoryMatchStatusLabel\(r\)\}/, 'Lark response exposes the same ET match state');
assert.match(lark, /累计到仓 \$\{r\.arrived_quantity == null \? '未知'/, 'Lark keeps arrival quantity separate from current sellable quantity');
assert.match(generator, /et\.operational_sellable_qty AS et_estimated_available_qty/, 'portal uses the centralized operational ET stock policy');
assert.match(generator, /et\.estimated_available_qty AS et_all_warehouse_inventory_qty/, 'all-warehouse physical stock remains separate evidence');
assert.match(generator, /productRow\?\.product_display_name/, 'inventory joins may use the normalized display key when ET uses a raw code');
assert.match(generator, /function compactSkuKeys\(value, storeKey='[^']*'\)/, 'inventory joins strip an explicit store prefix without collapsing model suffixes');
const schema = fs.readFileSync(path.join(root, 'infra', 'warehouse', 'schema.sql'), 'utf8');
assert.match(schema, /WHEN coalesce\(s\.match_key,b\.match_key\) = 'SK03038'/, 'only the approved SK-03038 exception counts 01 full-carton stock as operational sellable');
assert.match(
  schema,
  /sum\(coalesce\(quantity, 0\)\) FILTER \(WHERE storeroom_name LIKE '%09%' OR storeroom_name ILIKE '%散件%'\) AS loose_sellable_qty/,
  '09 operational sellable stock uses ET available Quantity, not physical RealQuantity',
);
assert.match(
  schema,
  /sum\(coalesce\(quantity, 0\)\) FILTER \(WHERE storeroom_name LIKE '%01%' OR storeroom_name ILIKE '%整箱%'\) AS full_carton_qty/,
  'the approved 01 full-carton exception also uses ET available Quantity',
);
assert.doesNotMatch(
  schema,
  /sum\(coalesce\(real_quantity, quantity, 0\)\) FILTER \(WHERE storeroom_name LIKE '%(?:09|01)%'/,
  'physical RealQuantity must never feed an operational-sellable warehouse aggregate',
);
assert.match(schema, /0\.3 \* \(coalesce\(s\.gross_sold_7d,0\) \/ 7\.0\) \+ 0\.7 \* \(coalesce\(s\.gross_sold_30d,0\) \/ 30\.0\)/, 'warehouse velocity uses 30% recent and 70% 30-day baseline');
assert.match(generator, /gross_sold_7d,0\) \/ 7\.0 \* 0\.3.*gross_sold_30d,0\) \/ 30\.0 \* 0\.7/, 'portal SQL uses the same velocity weights');
assert.match(generator, /round\(weighted_daily_gross_sales::numeric, 4\)/, 'portal keeps enough daily-rate precision for slow sellers');
assert.match(client, /gross_sold_7d'\]\)\/7\*\.3\+firstNum\(r,\['gross_sold_30d'\]\)\/30\*\.7/, 'browser fallback uses the same velocity weights');
assert.match(client, /预计月销/);
assert.match(client, /低样本/);
assert.doesNotMatch(generator, /近7天(?:毛销量\/7 × |)70%|7天70% \+ 30天30%/, 'old aggressive velocity copy is removed');
const sk272Daily = 1 / 7 * 0.3 + 1 / 30 * 0.7;
assert.equal(Number((sk272Daily * 30).toFixed(2)), 1.99, 'SK-272 example projects about 1.99 units/month');
assert.equal(Number((35 / sk272Daily / 30).toFixed(1)), 17.6, 'SK-272 example depletes 35 units in about 17.6 months');
assert.match(standards, /inventoryProjection\.fresh_matched \? inventoryProjection\.current_sellable_quantity : null/, 'marketing standards do not turn unknown ET stock into zero');
assert.match(stackReview, /projection\.fresh_matched \? projection\.current_sellable_quantity : null/, 'marketing stack review preserves unknown ET stock');
assert.match(inventoryWriter, /operational_sellable_qty/);
assert.match(inventoryWriter, /operationalSnapshotDate/, 'inventory writes validate the applicable warehouse snapshot rather than the freshest unrelated ET snapshot');
assert.doesNotMatch(inventoryWriter, /estimatedAvailableQty: Number\(row\.estimated_available_qty\)/, 'inventory writes never use all-warehouse physical stock as operational sellable');

console.log('inventory_projection_contract: tri-state ET match, fresh-zero, arrival separation, and legacy compatibility passed');
