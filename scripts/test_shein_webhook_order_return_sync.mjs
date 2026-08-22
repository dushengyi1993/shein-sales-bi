#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  buildTargetedOpenApiSalesUpsertSql,
  buildTargetedOpenApiSalesReadbackSql,
  buildOpenApiSalesAtomicSql,
  buildFactRows as buildSalesFactRows,
  readbackTargetedOpenApiSales,
} from './load_shein_openapi_sales_warehouse.mjs';
import {
  buildTargetedOpenApiReturnsUpsertSql,
  buildTargetedOpenApiReturnsReadbackSql,
  buildOpenApiReturnsAtomicSql,
  buildFactRows as buildReturnFactRows,
  readbackTargetedOpenApiReturns,
} from './load_shein_openapi_returns_warehouse.mjs';
import {fetchOpenApiOrderDetailsForStore} from './fetch_shein_openapi_sales.mjs';
import {fetchOpenApiReturnOrderDetailsForStore} from './fetch_shein_openapi_returns.mjs';
import {syncWebhookOrder, syncWebhookReturn} from '../lib/shein_webhook_order_return_sync.mjs';

function assertTargetedDetailReplacement(built, {storeKey, identityValue, applyFunction}, label) {
  assert.doesNotMatch(built.script, /openapi_(store_daily_sales|sales_reconciliation|return_reconciliation)/i, `${label} must not write day-level tables`);
  assert.match(built.script, /BEGIN;[\s\S]*COMMIT;/, `${label} is atomic`);
  assert.doesNotMatch(built.script, /\bCOPY\b|\\\./, `${label} must be executable by node-postgres without psql meta-commands`);
  assert.doesNotMatch(built.script, /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+fact\./i, `${label} runtime role must not receive raw fact DML`);
  assert.match(built.script, new RegExp(`ops\\.${applyFunction}\\([\\s\\S]*?'${storeKey}',[\\s\\S]*?'${identityValue}',[\\s\\S]*?'[^']+'::timestamptz`), `${label} uses one versioned scoped SECURITY DEFINER apply function`);
  assert.doesNotMatch(built.script, /ops\.prepare_shein_webhook_/, `${label} cannot invoke the lower-level delete helper directly`);
}

const [salesFetcherSource, returnsFetcherSource] = await Promise.all([
  fs.readFile(new URL('./fetch_shein_openapi_sales.mjs', import.meta.url), 'utf8'),
  fs.readFile(new URL('./fetch_shein_openapi_returns.mjs', import.meta.url), 'utf8'),
]);
assert.match(salesFetcherSource, /for \(const date of eachDate[\s\S]*?const fetchTime = new Date\(\)\.toISOString\(\);[\s\S]*?await fetchOrderListForDate/, 'daily sales must version the slice before its first API request');
assert.match(returnsFetcherSource, /for \(const date of eachDate[\s\S]*?const fetchTime = new Date\(\)\.toISOString\(\);[\s\S]*?await fetchReturnOrderListForDate/, 'daily returns must version the slice before its first API request');

const salesArtifact = {
  storeKey: 'HL', groupKey: 'g', shopName: 'shop', start: '2026-07-19', fetchTime: '2026-07-19T01:02:03.000Z',
  orders: [{orderNo: 'SO-1', orderAllocateTime: '2026-07-19 09:00:00', orderStatus: 4, isCod: 1, orderGoodsInfoList: [{goodsId: 'G-1'}]}],
  orderRows: [{orderId: '', orderNo: 'SO-1', billno: 'SO-1', orderCreateTime: '2026-07-19 09:00:00', allocateTimeFull: '2026-07-19 09:00:00', site: 'SA', orderStatus: 4}],
  goodsRows: [{orderId: '', orderNo: 'SO-1', billno: 'SO-1', orderCreateTime: '2026-07-19 09:00:00', goodsId: 'G-1', goodsSn: 'SKU-1', goodsTitle: 'item', number: 1, currencyCode: 'SAR', currencyPrice: 12.5, newOrderGoodsStatus: 4, goodsPerformanceStatus: 4}],
};
const sales = buildTargetedOpenApiSalesUpsertSql({artifact: salesArtifact, storeKey: 'HL', orderNo: 'SO-1'});
assertTargetedDetailReplacement(sales, {storeKey: 'HL', identityValue: 'SO-1', applyFunction: 'apply_shein_webhook_order_snapshot'}, 'sales');
assert.equal(sales.rowCounts.headers, 1);
assert.equal(sales.rowCounts.items, 1);
assert.match(sales.script, /HL/);
assert.match(sales.script, /SO-1/);
assert.throws(() => buildTargetedOpenApiSalesUpsertSql({artifact: salesArtifact, storeKey: 'DX', orderNo: 'SO-1'}), /Store mismatch/);
assert.throws(() => buildTargetedOpenApiSalesUpsertSql({artifact: {...salesArtifact, goodsRows: []}, storeKey: 'HL', orderNo: 'SO-1'}), /item detail is empty/);
assert.throws(() => buildTargetedOpenApiSalesUpsertSql({artifact: {...salesArtifact, fetchTime: ''}, storeKey: 'HL', orderNo: 'SO-1'}), /unversioned warehouse write/);
assert.match(buildTargetedOpenApiSalesReadbackSql({storeKey: 'HL', orderNo: 'SO-1'}), /store_key = 'HL' AND order_no = 'SO-1'/);
const salesFactRows = buildSalesFactRows(salesArtifact, 'webhook://full-sales-test');
const fullSalesSql = buildOpenApiSalesAtomicSql({...salesFactRows, reconciliations: [], pairs: [{date: salesFactRows.date, store: 'HL', sourceSnapshotAt: salesFactRows.sourceSnapshotAt}]}).script;
assert.match(fullSalesSql, /header\.source_snapshot_at > slice\.source_snapshot_at/, 'daily sales cleanup must preserve a newer targeted order');
assert.match(fullSalesSql, /freshness_parent\."source_snapshot_at" > "stage_fact_openapi_order_item_[^"]+"\."source_snapshot_at"/, 'daily item insert must reject an older snapshot under a newer header');
assert.match(fullSalesSql, /BEGIN;[\s\S]*pg_advisory_xact_lock[\s\S]*SET LOCAL shein_bi\.bulk_openapi_sales_reconcile = 'on';[\s\S]*COMMIT;/,
  'bulk OpenAPI loading must set the transaction-local mirror bypass after its sorted locks');
assert.doesNotMatch(sales.script, /shein_bi\.bulk_openapi_sales_reconcile/,
  'targeted Webhook replacement must never set the bulk mirror bypass');

const returnArtifact = {
  storeKey: 'DL', groupKey: 'g', shopName: 'shop', start: '2026-07-19', fetchTime: '2026-07-19T01:02:03.000Z',
  returnOrderRefs: [{returnOrderNo: 'RO-1', orderNo: 'SO-1', requestReturnTime: '2026-07-19 09:00:00'}],
  returnOrders: [{returnOrderNo: 'RO-1', orderNo: 'SO-1', requestReturnTime: '2026-07-19 09:00:00', returnOrderStatus: 2, returnGoodsInfoList: [{goodsId: 'RG-1', goodsSn: 'SKU-1', goodsTitle: 'item', estimateIncomeMoney: '8.5'}]}],
};
const returns = buildTargetedOpenApiReturnsUpsertSql({artifact: returnArtifact, storeKey: 'DL', returnOrderNo: 'RO-1'});
assertTargetedDetailReplacement(returns, {storeKey: 'DL', identityValue: 'RO-1', applyFunction: 'apply_shein_webhook_return_snapshot'}, 'returns');
assert.equal(returns.rowCounts.headers, 1);
assert.equal(returns.rowCounts.items, 1);
assert.match(returns.script, /DL/);
assert.match(returns.script, /RO-1/);
assert.throws(() => buildTargetedOpenApiReturnsUpsertSql({artifact: returnArtifact, storeKey: 'DL', returnOrderNo: 'RO-other'}), /Expected exactly one return header/);
assert.throws(() => buildTargetedOpenApiReturnsUpsertSql({artifact: {...returnArtifact, returnOrders: [{...returnArtifact.returnOrders[0], returnGoodsInfoList: []}]}, storeKey: 'DL', returnOrderNo: 'RO-1'}), /item detail is empty/);
assert.throws(() => buildTargetedOpenApiReturnsUpsertSql({artifact: {...returnArtifact, fetchTime: ''}, storeKey: 'DL', returnOrderNo: 'RO-1'}), /unversioned warehouse write/);
assert.match(buildTargetedOpenApiReturnsReadbackSql({storeKey: 'DL', returnOrderNo: 'RO-1'}), /store_key = 'DL' AND return_order_no = 'RO-1'/);
const returnFactRows = buildReturnFactRows(returnArtifact, 'webhook://full-return-test');
const fullReturnSql = buildOpenApiReturnsAtomicSql({...returnFactRows, reconciliations: [], pairs: [{date: '2026-07-19', store: 'DL', sourceSnapshotAt: returnFactRows.sourceSnapshotAt}]}).script;
assert.match(fullReturnSql, /header\.source_snapshot_at > slice\.source_snapshot_at/, 'daily return cleanup must preserve a newer targeted return');
assert.match(fullReturnSql, /freshness_parent\."source_snapshot_at" > "stage_fact_openapi_return_item_[^"]+"\."source_snapshot_at"/, 'daily return item insert must reject an older snapshot under a newer header');

await assert.rejects(
  () => readbackTargetedOpenApiSales({}, {storeKey: 'HL', orderNo: 'SO-1'}, {headers: 1, items: 1, paymentFlags: 1, sourceSnapshotAt: salesArtifact.fetchTime}, {executor: async () => ({stdout: '{"sourceSnapshotAt":"2026-07-19T01:02:03.000Z","headers":1,"items":0,"paymentFlags":1}\n'})}),
  /items=0, expected=1/,
);
await assert.rejects(
  () => readbackTargetedOpenApiReturns({}, {storeKey: 'DL', returnOrderNo: 'RO-1'}, {headers: 1, items: 1, sourceSnapshotAt: returnArtifact.fetchTime}, {executor: async () => ({stdout: '{"sourceSnapshotAt":"2026-07-19T01:02:03.000Z","headers":1,"items":0}\n'})}),
  /items=0, expected=1/,
);
const supersededSales = await readbackTargetedOpenApiSales(
  {},
  {storeKey: 'HL', orderNo: 'SO-1'},
  {headers: 1, items: 1, paymentFlags: 1, sourceSnapshotAt: salesArtifact.fetchTime},
  {executor: async () => ({stdout: '{"sourceSnapshotAt":"2026-07-19T01:03:03.000Z","headers":1,"items":9,"paymentFlags":0}\n'})},
);
assert.equal(supersededSales.superseded, true, 'a newer order snapshot is authoritative even when its row shape differs');
const supersededReturns = await readbackTargetedOpenApiReturns(
  {},
  {storeKey: 'DL', returnOrderNo: 'RO-1'},
  {headers: 1, items: 1, sourceSnapshotAt: returnArtifact.fetchTime},
  {executor: async () => ({stdout: '{"sourceSnapshotAt":"2026-07-19T01:03:03.000Z","headers":1,"items":9}\n'})},
);
assert.equal(supersededReturns.superseded, true, 'a newer return snapshot is authoritative even when its row shape differs');

const calls = [];
const matchingOrderClient = {
  async request(endpoint, request) {
    calls.push({endpoint, request});
    return {data: {code: '0', info: [{orderNo: 'SO-1', orderAllocateTime: '2026-07-19 09:00:00', orderGoodsInfoList: [{goodsId: 'G-1', goodsSn: 'SKU-1', goodsTitle: 'item', number: 1, currencyCode: 'SAR', currencyPrice: 12.5}]}]}};
  },
};
const fetchedOrder = await fetchOpenApiOrderDetailsForStore({
  storeKey: 'HL', orderNos: ['SO-1'], client: matchingOrderClient, storesConfig: {stores: [{key: 'HL', shopName: 'shop'}]},
});
assert.equal(fetchedOrder.storeKey, 'HL');
assert.deepEqual(calls[0], {endpoint: '/open-api/order/order-detail', request: {body: {orderNoList: ['SO-1']}}});
await assert.rejects(
  () => fetchOpenApiOrderDetailsForStore({storeKey: 'HL', orderNos: ['SO-1'], client: {request: async () => ({data: {code: '0', info: [{orderNo: 'SO-other'}]}})}, storesConfig: {stores: []}}),
  /target mismatch/,
);

const matchingReturnClient = {
  async request(endpoint, request) {
    calls.push({endpoint, request});
    return {data: {code: '0', info: [{returnOrderNo: 'RO-1', requestReturnTime: '2026-07-19 09:00:00', returnGoodsInfoList: [{goodsId: 'RG-1', goodsSn: 'SKU-1', goodsTitle: 'item', quantity: 1, estimateIncomeMoney: '8.5'}]}]}};
  },
};
const fetchedReturn = await fetchOpenApiReturnOrderDetailsForStore({storeKey: 'DL', returnOrderNos: ['RO-1'], client: matchingReturnClient});
assert.equal(fetchedReturn.storeKey, 'DL');
assert.deepEqual(calls[1], {endpoint: '/open-api/return-order/details', request: {body: {returnOrderNoList: ['RO-1']}}});
await assert.rejects(
  () => fetchOpenApiReturnOrderDetailsForStore({storeKey: 'DL', returnOrderNos: ['RO-1'], client: {request: async () => ({data: {code: '0', info: [{returnOrderNo: 'RO-other'}]}})}}),
  /target mismatch/,
);

const executedSql = [];
const executor = async (_args, sql) => {
  executedSql.push(sql);
  if (sql.startsWith('SELECT')) {
    return {stdout: sql.includes('returnOrderNo')
      ? '{"storeKey":"DL","returnOrderNo":"RO-1","sourceSnapshotAt":"2026-07-19T01:02:03.000Z","headers":1,"items":1}\n'
      : '{"storeKey":"HL","orderNo":"SO-1","sourceSnapshotAt":"2026-07-19T01:02:03.000Z","headers":1,"items":1,"paymentFlags":1}\n'};
  }
  return {stdout: ''};
};
const syncedOrder = await syncWebhookOrder({storeKey: 'HL', orderNo: 'SO-1', fetchTime: salesArtifact.fetchTime, client: matchingOrderClient, storesConfig: {stores: [{key: 'HL', shopName: 'shop'}]}, executor});
const syncedReturn = await syncWebhookReturn({storeKey: 'DL', returnOrderNo: 'RO-1', fetchTime: returnArtifact.fetchTime, client: matchingReturnClient, executor});
assert.equal(syncedOrder.readback.headers, 1);
assert.equal(syncedReturn.readback.headers, 1);
assert.equal(executedSql.length, 4);
assertTargetedDetailReplacement({script: executedSql[0]}, {storeKey: 'HL', identityValue: 'SO-1', applyFunction: 'apply_shein_webhook_order_snapshot'}, 'sync order mutation');
assertTargetedDetailReplacement({script: executedSql[2]}, {storeKey: 'DL', identityValue: 'RO-1', applyFunction: 'apply_shein_webhook_return_snapshot'}, 'sync return mutation');

const aborted = new AbortController();
aborted.abort(Object.assign(new Error('lease lost'), {code: 'SHEIN_WEBHOOK_LEASE_LOST'}));
const writesBeforeAbortCheck = executedSql.length;
await assert.rejects(
  () => syncWebhookOrder({storeKey: 'HL', orderNo: 'SO-1', signal: aborted.signal, client: matchingOrderClient, storesConfig: {stores: []}, executor}),
  /lease lost/,
);
assert.equal(executedSql.length, writesBeforeAbortCheck, 'aborted lease must not start a warehouse write');

console.log(JSON.stringify({ok: true, sales: sales.rowCounts, returns: returns.rowCounts}, null, 2));
