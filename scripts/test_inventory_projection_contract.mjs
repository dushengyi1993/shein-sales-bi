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
const schema = fs.readFileSync(path.join(root, 'infra', 'warehouse', 'schema.sql'), 'utf8');
assert.match(schema, /WHEN coalesce\(s\.match_key,b\.match_key\) = 'SK03038'/, 'only the approved SK-03038 exception counts 01 full-carton stock as operational sellable');
assert.match(standards, /inventoryProjection\.fresh_matched \? inventoryProjection\.current_sellable_quantity : null/, 'marketing standards do not turn unknown ET stock into zero');
assert.match(stackReview, /projection\.fresh_matched \? projection\.current_sellable_quantity : null/, 'marketing stack review preserves unknown ET stock');
assert.match(inventoryWriter, /operational_sellable_qty/);
assert.match(inventoryWriter, /operationalSnapshotDate/, 'inventory writes validate the applicable warehouse snapshot rather than the freshest unrelated ET snapshot');
assert.doesNotMatch(inventoryWriter, /estimatedAvailableQty: Number\(row\.estimated_available_qty\)/, 'inventory writes never use all-warehouse physical stock as operational sellable');

console.log('inventory_projection_contract: tri-state ET match, fresh-zero, arrival separation, and legacy compatibility passed');
