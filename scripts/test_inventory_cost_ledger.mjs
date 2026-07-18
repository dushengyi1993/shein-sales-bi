#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {buildInventoryCostLedger} from '../lib/inventory_cost_ledger.mjs';

const events = [
  {eventKey:'r1',matchKey:'P1',effectiveAt:'2026-01-01 00:00:00',eventType:'receipt',quantity:10,costAmountSar:100,sourceKey:'r1'},
  {eventKey:'s1',matchKey:'P1',effectiveAt:'2026-01-02 00:00:00',eventType:'sale',quantity:4,sourceKey:'s1',sourceOrderItemKey:'s1'},
  {eventKey:'r2',matchKey:'P1',effectiveAt:'2026-02-01 00:00:00',eventType:'receipt',quantity:10,costAmountSar:200,sourceKey:'r2'},
  {eventKey:'s2',matchKey:'P1',effectiveAt:'2026-02-02 00:00:00',eventType:'sale',quantity:2,sourceKey:'s2',sourceOrderItemKey:'s2'},
  {eventKey:'rtv1',matchKey:'P1',effectiveAt:'2026-02-03 00:00:00',eventType:'rtv_09_return',quantity:1,unitCostSar:999,sourceKey:'rtv1',sourceOrderItemKey:'s1'},
];
const built = buildInventoryCostLedger(events, {ledgerVersion:'test'});
assert.equal(built.saleAssignments.get('s1').cogsSar, 40);
assert.equal(built.saleAssignments.get('s1').unitCostSar, 10);
assert.equal(built.saleAssignments.get('s2').unitCostSar, 16.25);
assert.equal(built.saleAssignments.get('s2').cogsSar, 32.5);
const rtv = built.rows.find(row => row.eventKey === 'rtv1');
assert.equal(rtv.costAmountSar, 10);
assert.equal(rtv.valuationStatus, 'valued');

// A future high-cost receipt must never change an earlier sale assignment.
const future = buildInventoryCostLedger([...events, {
  eventKey:'r3',matchKey:'P1',effectiveAt:'2027-01-01 00:00:00',eventType:'receipt',quantity:100,costAmountSar:10000,sourceKey:'r3',
}], {ledgerVersion:'test2'});
assert.equal(future.saleAssignments.get('s1').cogsSar, 40);
assert.equal(future.saleAssignments.get('s2').cogsSar, 32.5);

const shortfall = buildInventoryCostLedger([
  {eventKey:'s0',matchKey:'P2',effectiveAt:'2026-01-01',eventType:'sale',quantity:3,sourceKey:'s0',sourceOrderItemKey:'s0'},
  {eventKey:'r0',matchKey:'P2',effectiveAt:'2026-01-02',eventType:'receipt',quantity:5,costAmountSar:50,sourceKey:'r0'},
], {ledgerVersion:'shortfall'});
assert.equal(shortfall.saleAssignments.get('s0').valuationStatus, 'missing_opening');
assert.equal(shortfall.saleAssignments.get('s0').unvaluedQuantity, 3);
const receiptAfterShortfall = shortfall.rows.find(row => row.eventKey === 'r0');
assert.equal(receiptAfterShortfall.quantityAfter, 2);
assert.equal(receiptAfterShortfall.valueAfterSar, 20);
assert.equal(receiptAfterShortfall.avgUnitCostAfterSar, 10);

const reset = buildInventoryCostLedger([
  {eventKey:'r-old',matchKey:'P3',effectiveAt:'2026-06-30',eventType:'receipt',quantity:100,costAmountSar:1000,sourceKey:'r-old'},
  {eventKey:'count',matchKey:'P3',effectiveAt:'2026-07-01',eventType:'inventory_count_reset',quantity:12,costAmountSar:180,sourceKey:'count'},
  {eventKey:'s-new',matchKey:'P3',effectiveAt:'2026-07-02',eventType:'sale',quantity:2,sourceKey:'s-new',sourceOrderItemKey:'s-new'},
], {ledgerVersion:'reset'});
assert.equal(reset.saleAssignments.get('s-new').unitCostSar, 15);
assert.equal(reset.endingStates.get('P3').quantity, 10);
assert.equal(reset.endingStates.get('P3').value, 150);

const negativeRtv = buildInventoryCostLedger([
  {eventKey:'s-neg',matchKey:'P4',effectiveAt:'2026-01-01',eventType:'sale',quantity:2,sourceKey:'s-neg',sourceOrderItemKey:'s-neg'},
  {eventKey:'rtv-neg',matchKey:'P4',effectiveAt:'2026-01-02',eventType:'rtv_09_return',quantity:1,unitCostSar:12,sourceKey:'rtv-neg',sourceOrderItemKey:'s-neg'},
], {ledgerVersion:'negative-rtv'});
const negativeRtvRow = negativeRtv.rows.find(row => row.eventKey === 'rtv-neg');
assert.equal(negativeRtvRow.quantityAfter, -1);
assert.equal(negativeRtvRow.valueAfterSar, 0);
assert.equal(negativeRtvRow.valuationStatus, 'rtv_shortfall_covered');

const rebuildScript = await fs.readFile(new URL('./rebuild_inventory_cost_ledger.mjs', import.meta.url), 'utf8');
assert.match(rebuildScript, /status='frozen'/);
assert.match(rebuildScript, /effective_at::date < \$\{cutoff\}/);
assert.match(rebuildScript, /oi\.created_date < \$\{cutoff\}/);
assert.doesNotMatch(rebuildScript, /product_unit_cost_by_match_key/);
const periodScript = await fs.readFile(new URL('./manage_accounting_period.mjs', import.meta.url), 'utf8');
const seedScript = await fs.readFile(new URL('./seed_inventory_cost_opening_from_et.mjs', import.meta.url), 'utf8');
assert.match(periodScript, /\\\\pset tuples_only on/);
assert.match(seedScript, /\\\\pset tuples_only on/);

console.log(JSON.stringify({ok:true, tests:['moving-average','future-receipt-isolation','rtv-reentry','missing-opening','inventory-count-reset','negative-rtv-shortfall','frozen-boundary','psql-readback-meta-command']}, null, 2));
