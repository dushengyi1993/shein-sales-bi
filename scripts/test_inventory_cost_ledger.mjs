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
assert.equal(shortfall.saleAssignments.get('s0').valuationStatus, 'valued_after_inventory_gap_receipt');
assert.equal(shortfall.saleAssignments.get('s0').unvaluedQuantity, 0);
assert.equal(shortfall.saleAssignments.get('s0').cogsSar, 30);
const receiptAfterShortfall = shortfall.rows.find(row => row.eventKey === 'r0');
assert.equal(receiptAfterShortfall.quantityAfter, 2);
assert.equal(receiptAfterShortfall.valueAfterSar, 20);
assert.equal(receiptAfterShortfall.avgUnitCostAfterSar, 10);
assert.equal(receiptAfterShortfall.estimationVarianceSar, 30);

const unresolvedKnownCostShortfall = buildInventoryCostLedger([
  {eventKey:'count-known',matchKey:'P2B',effectiveAt:'2026-01-01',eventType:'inventory_count_reset',quantity:1,costAmountSar:12,sourceKey:'count-known'},
  {eventKey:'s-known-1',matchKey:'P2B',effectiveAt:'2026-01-02',eventType:'sale',quantity:1,sourceKey:'s-known-1',sourceOrderItemKey:'s-known-1'},
  {eventKey:'s-known-2',matchKey:'P2B',effectiveAt:'2026-01-03',eventType:'sale',quantity:2,sourceKey:'s-known-2',sourceOrderItemKey:'s-known-2'},
], {ledgerVersion:'unresolved-known-cost-shortfall'});
assert.equal(unresolvedKnownCostShortfall.saleAssignments.get('s-known-2').unitCostSar, 12);
assert.equal(unresolvedKnownCostShortfall.saleAssignments.get('s-known-2').cogsSar, 24);
assert.equal(unresolvedKnownCostShortfall.saleAssignments.get('s-known-2').unvaluedQuantity, 0);
assert.equal(unresolvedKnownCostShortfall.saleAssignments.get('s-known-2').estimatedQuantity, 2);
assert.equal(unresolvedKnownCostShortfall.saleAssignments.get('s-known-2').valuationStatus, 'estimated_inventory_gap_last_moving_average');
const unresolvedKnownShortfallSale = unresolvedKnownCostShortfall.rows.find(row => row.eventKey === 's-known-2');
assert.equal(unresolvedKnownShortfallSale.quantityAfter, -2);
assert.equal(unresolvedKnownShortfallSale.valueAfterSar, -24);
assert.equal(unresolvedKnownShortfallSale.avgUnitCostAfterSar, 12);

const knownCostShortfall = buildInventoryCostLedger([
  {eventKey:'count-known',matchKey:'P2B',effectiveAt:'2026-01-01',eventType:'inventory_count_reset',quantity:1,costAmountSar:12,sourceKey:'count-known'},
  {eventKey:'s-known-1',matchKey:'P2B',effectiveAt:'2026-01-02',eventType:'sale',quantity:1,sourceKey:'s-known-1',sourceOrderItemKey:'s-known-1'},
  {eventKey:'s-known-2',matchKey:'P2B',effectiveAt:'2026-01-03',eventType:'sale',quantity:2,sourceKey:'s-known-2',sourceOrderItemKey:'s-known-2'},
  {eventKey:'r-known',matchKey:'P2B',effectiveAt:'2026-01-04',eventType:'receipt',quantity:5,costAmountSar:100,sourceKey:'r-known'},
], {ledgerVersion:'known-cost-shortfall'});
assert.equal(knownCostShortfall.saleAssignments.get('s-known-2').unitCostSar, 20);
assert.equal(knownCostShortfall.saleAssignments.get('s-known-2').cogsSar, 40);
assert.equal(knownCostShortfall.saleAssignments.get('s-known-2').unvaluedQuantity, 0);
assert.equal(knownCostShortfall.saleAssignments.get('s-known-2').estimatedQuantity, 0);
assert.equal(knownCostShortfall.saleAssignments.get('s-known-2').settledEstimatedQuantity, 2);
assert.equal(knownCostShortfall.saleAssignments.get('s-known-2').estimationVarianceSar, 16);
assert.equal(knownCostShortfall.saleAssignments.get('s-known-2').valuationStatus, 'valued_after_inventory_gap_receipt');
const knownShortfallSale = knownCostShortfall.rows.find(row => row.eventKey === 's-known-2');
assert.equal(knownShortfallSale.quantityAfter, -2);
assert.equal(knownShortfallSale.avgUnitCostAfterSar, 12);
const knownReceipt = knownCostShortfall.rows.find(row => row.eventKey === 'r-known');
assert.equal(knownReceipt.quantityAfter, 3);
assert.equal(knownReceipt.valueAfterSar, 60);
assert.equal(knownReceipt.avgUnitCostAfterSar, 20);
assert.equal(knownReceipt.estimationVarianceSar, 16);
assert.equal(12 + 100, 12 + knownCostShortfall.saleAssignments.get('s-known-2').cogsSar + knownReceipt.valueAfterSar);

const incomingCostShortfall = buildInventoryCostLedger([
  {eventKey:'count-incoming',matchKey:'P2C',effectiveAt:'2026-01-01',eventType:'inventory_count_reset',quantity:1,costAmountSar:12,sourceKey:'count-incoming'},
  {eventKey:'s-incoming-1',matchKey:'P2C',effectiveAt:'2026-01-02',eventType:'sale',quantity:1,sourceKey:'s-incoming-1',sourceOrderItemKey:'s-incoming-1'},
  {
    eventKey:'s-incoming-2',matchKey:'P2C',effectiveAt:'2026-01-03',eventType:'sale',quantity:2,
    estimatedUnitCostSar:20,estimatedCostBasis:'in_transit_weighted_as_of_sale',
    sourceKey:'s-incoming-2',sourceOrderItemKey:'s-incoming-2',
  },
], {ledgerVersion:'incoming-cost-shortfall'});
assert.equal(incomingCostShortfall.saleAssignments.get('s-incoming-2').unitCostSar, 20);
assert.equal(incomingCostShortfall.saleAssignments.get('s-incoming-2').cogsSar, 40);
assert.equal(incomingCostShortfall.saleAssignments.get('s-incoming-2').estimatedQuantity, 2);
assert.equal(incomingCostShortfall.saleAssignments.get('s-incoming-2').valuationStatus, 'estimated_inventory_gap_in_transit_cost');
assert.equal(incomingCostShortfall.saleAssignments.get('s-incoming-2').valuationBasis, 'in_transit_weighted_as_of_sale');

const estimatedMissingOpening = buildInventoryCostLedger([
  {
    eventKey:'s-evidence',matchKey:'P2D',effectiveAt:'2026-01-03',eventType:'sale',quantity:2,
    estimatedUnitCostSar:15,estimatedCostBasis:'past_arrived_weighted_as_of_sale',
    sourceKey:'s-evidence',sourceOrderItemKey:'s-evidence',
  },
], {ledgerVersion:'estimated-missing-opening'});
assert.equal(estimatedMissingOpening.saleAssignments.get('s-evidence').cogsSar, 30);
assert.equal(estimatedMissingOpening.saleAssignments.get('s-evidence').estimatedQuantity, 2);
assert.equal(estimatedMissingOpening.saleAssignments.get('s-evidence').unvaluedQuantity, 0);
assert.equal(estimatedMissingOpening.saleAssignments.get('s-evidence').valuationStatus, 'estimated_missing_opening_past_arrived_cost');

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
assert.equal(negativeRtvRow.valuationStatus, 'rtv_shortfall_settled');

const rebuildScript = await fs.readFile(new URL('./rebuild_inventory_cost_ledger.mjs', import.meta.url), 'utf8');
assert.match(rebuildScript, /status='frozen'/);
assert.match(rebuildScript, /effective_at::date < \$\{cutoff\}/);
assert.match(rebuildScript, /oi\.created_date < \$\{cutoff\}/);
assert.match(rebuildScript, /FROM ops\.rtv_tracking_verification v/);
assert.match(rebuildScript, /d\.return_order_id = v\.et_return_order_id/);
assert.match(rebuildScript, /'ops\.rtv_tracking_verification'::text AS source_table/);
assert.match(rebuildScript, /economic_return_key/);
assert.match(rebuildScript, /min\(source_priority\) OVER/);
assert.match(rebuildScript, /WHERE source_priority = selected_source_priority/);
assert.doesNotMatch(
  rebuildScript,
  /DISTINCT ON \(store_key, order_no, return_order_id, match_key\)/,
  'a manually verified replacement ET id must not create a second economic RTV event',
);
assert.match(rebuildScript, /pg_advisory_xact_lock\(hashtextextended\('shein-inventory-cost-ledger-rebuild'/);
assert.match(rebuildScript, /stale inventory-cost rebuild refused/);
assert.match(rebuildScript, /const SOURCE_TABLES[\s\S]*'fact\.order_item'[\s\S]*'ops\.accounting_period_close'/);
assert.match(rebuildScript, /LOCK TABLE\s+\$\{SOURCE_TABLES\.join\('[\s\S]*IN SHARE MODE/);
assert.match(rebuildScript, /inventory-cost source changed after snapshot/);
assert.match(rebuildScript, /'sourceSnapshotAt', statement_timestamp\(\)/);
assert.match(rebuildScript, /'sourceSnapshot', txid_current_snapshot\(\)::text/);
assert.match(rebuildScript, /'sourceCounts', jsonb_build_object/);
assert.match(rebuildScript, /txid_visible_in_snapshot/);
assert.match(rebuildScript, /rows_not_visible_in_snapshot/);
assert.match(rebuildScript, /source_state\.row_count <> \$\{expectedCount\}/);
assert.match(rebuildScript, /sourceCutoffAt: source\?\.sourceSnapshotAt \|\| startedAt/);
assert.match(rebuildScript, /sourceSnapshot: source\?\.sourceSnapshot \|\| ''/);
assert.match(rebuildScript, /sourceCounts: source\?\.sourceCounts \|\| \{\}/);
assert.match(rebuildScript, /openingStates: \[\.\.\.openingStateMap\(source\?\.openingStates\)\.entries\(\)\]/);
assert.match(rebuildScript, /AND completed_at > \$\{sqlLiteral\(run\.startedAt\)\}::timestamptz/);
assert.doesNotMatch(rebuildScript, /product_unit_cost_by_match_key/);
assert.match(rebuildScript, /mart\.product_cost_batch_timeline/);
assert.match(rebuildScript, /in_transit_weighted_as_of_sale/);
assert.match(rebuildScript, /past_arrived_weighted_as_of_sale/);
assert.match(rebuildScript, /estimated_unit_cost_sar/);
assert.match(rebuildScript, /settled_estimated_quantity/);
assert.match(rebuildScript, /estimation_variance_sar/);
const periodScript = await fs.readFile(new URL('./manage_accounting_period.mjs', import.meta.url), 'utf8');
const seedScript = await fs.readFile(new URL('./seed_inventory_cost_opening_from_et.mjs', import.meta.url), 'utf8');
assert.match(periodScript, /\\\\pset tuples_only on/);
assert.match(seedScript, /\\\\pset tuples_only on/);

console.log(JSON.stringify({ok:true, tests:['moving-average','future-receipt-isolation','rtv-reentry','manual-rtv-verification-source','missing-opening-receipt-settlement','known-cost-negative-inventory-estimate','negative-inventory-receipt-variance-settlement','inventory-value-conservation','in-transit-shortfall-estimate','past-arrival-missing-opening-estimate','inventory-count-reset','negative-rtv-shortfall','frozen-boundary','concurrent-rebuild-stale-write-guard','source-snapshot-lock','psql-readback-meta-command']}, null, 2));
