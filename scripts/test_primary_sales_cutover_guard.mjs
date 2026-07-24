import assert from 'node:assert/strict';
import {
  guardFormalSalesFacts,
  normalizePrimarySalesGuard,
  partitionFormalSalesRows,
} from '../lib/primary_sales_cutover_guard.mjs';

assert.deepEqual(
  normalizePrimarySalesGuard({enabled: true, cutover_date: '2026-07-23T00:00:00Z'}),
  {enabled: true, cutoverDate: '2026-07-23'},
);

const rows = [
  {created_date: '2026-07-22', id: 'legacy'},
  {created_date: '2026-07-23', id: 'cutover'},
  {date: '2026-07-24', id: 'after'},
];
const partition = partitionFormalSalesRows(rows, {enabled: true, cutoverDate: '2026-07-23'});
assert.deepEqual(partition.kept.map(row => row.id), ['legacy']);
assert.deepEqual(partition.skipped.map(row => row.id), ['cutover', 'after']);

const guarded = guardFormalSalesFacts({
  daily: [{date: '2026-07-23'}],
  orders: [{created_date: '2026-07-23'}],
  items: [{created_date: '2026-07-23'}, {created_date: '2026-07-22'}],
  paymentFlags: [{created_date: '2026-07-24'}],
  catalog: [{file: 'kept'}],
}, {enabled: true, cutoverDate: '2026-07-23'});
assert.equal(guarded.sales.daily.length, 0);
assert.equal(guarded.sales.orders.length, 0);
assert.equal(guarded.sales.items.length, 1);
assert.equal(guarded.sales.paymentFlags.length, 0);
assert.equal(guarded.sales.catalog.length, 1);
assert.deepEqual(guarded.skipped, {daily: 1, orders: 1, items: 1, paymentFlags: 1});
assert.equal(guarded.skippedTotal, 4);

console.log('primary_sales_cutover_guard: cutover rows cannot overwrite formal sales facts');
