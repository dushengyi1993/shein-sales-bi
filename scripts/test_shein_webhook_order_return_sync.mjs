#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  buildTargetedOpenApiSalesUpsertSql,
  buildTargetedOpenApiSalesReadbackSql,
  readbackTargetedOpenApiSales,
} from './load_shein_openapi_sales_warehouse.mjs';
import {
  buildTargetedOpenApiReturnsUpsertSql,
  buildTargetedOpenApiReturnsReadbackSql,
  readbackTargetedOpenApiReturns,
} from './load_shein_openapi_returns_warehouse.mjs';
import {fetchOpenApiOrderDetailsForStore} from './fetch_shein_openapi_sales.mjs';
import {fetchOpenApiReturnOrderDetailsForStore} from './fetch_shein_openapi_returns.mjs';
import {syncWebhookOrder, syncWebhookReturn} from '../lib/shein_webhook_order_return_sync.mjs';

function assertTargetedDetailReplacement(built, {storeKey, identityColumn, identityValue, tables}, label) {
  assert.doesNotMatch(built.script, /openapi_(store_daily_sales|sales_reconciliation|return_reconciliation)/i, `${label} must not write day-level tables`);
  assert.match(built.script, /BEGIN;[\s\S]*COMMIT;/, `${label} is atomic`);
  assert.doesNotMatch(built.script, /\bCOPY\b|\\\./, `${label} must be executable by node-postgres without psql meta-commands`);
  const deletes = built.script.match(/DELETE FROM [^;]+;/g) || [];
  assert.equal(deletes.length, tables.length, `${label} clears each replaceable detail table exactly once`);
  for (const table of tables) {
    assert.ok(deletes.some((sql) => sql === `DELETE FROM ${table} WHERE store_key = '${storeKey}' AND ${identityColumn} = '${identityValue}';`), `${label} clears stale detail rows only for the requested record`);
  }
  for (const sql of deletes) {
    assert.match(sql, new RegExp(`store_key = '${storeKey}' AND ${identityColumn} = '${identityValue}'`), `${label} cannot delete another store or record`);
    assert.doesNotMatch(sql, /\bdate\b|_date\b/i, `${label} never uses a date-slice delete`);
  }
}

const salesArtifact = {
  storeKey: 'HL', groupKey: 'g', shopName: 'shop', start: '2026-07-19', fetchTime: '2026-07-19T01:02:03.000Z',
  orders: [{orderNo: 'SO-1', orderAllocateTime: '2026-07-19 09:00:00', orderStatus: 4, isCod: 1, orderGoodsInfoList: [{goodsId: 'G-1'}]}],
  orderRows: [{orderId: '', orderNo: 'SO-1', billno: 'SO-1', orderCreateTime: '2026-07-19 09:00:00', allocateTimeFull: '2026-07-19 09:00:00', site: 'SA', orderStatus: 4}],
  goodsRows: [{orderId: '', orderNo: 'SO-1', billno: 'SO-1', orderCreateTime: '2026-07-19 09:00:00', goodsId: 'G-1', goodsSn: 'SKU-1', goodsTitle: 'item', number: 1, currencyCode: 'SAR', currencyPrice: 12.5, newOrderGoodsStatus: 4, goodsPerformanceStatus: 4}],
};
const sales = buildTargetedOpenApiSalesUpsertSql({artifact: salesArtifact, storeKey: 'HL', orderNo: 'SO-1'});
assertTargetedDetailReplacement(sales, {storeKey: 'HL', identityColumn: 'order_no', identityValue: 'SO-1', tables: ['fact.openapi_order_item', 'fact.openapi_order_payment_flag']}, 'sales');
assert.equal(sales.rowCounts.headers, 1);
assert.equal(sales.rowCounts.items, 1);
assert.match(sales.script, /HL/);
assert.match(sales.script, /SO-1/);
assert.throws(() => buildTargetedOpenApiSalesUpsertSql({artifact: salesArtifact, storeKey: 'DX', orderNo: 'SO-1'}), /Store mismatch/);
assert.match(buildTargetedOpenApiSalesReadbackSql({storeKey: 'HL', orderNo: 'SO-1'}), /store_key = 'HL' AND order_no = 'SO-1'/);

const returnArtifact = {
  storeKey: 'DL', groupKey: 'g', shopName: 'shop', start: '2026-07-19', fetchTime: '2026-07-19T01:02:03.000Z',
  returnOrderRefs: [{returnOrderNo: 'RO-1', orderNo: 'SO-1', requestReturnTime: '2026-07-19 09:00:00'}],
  returnOrders: [{returnOrderNo: 'RO-1', orderNo: 'SO-1', requestReturnTime: '2026-07-19 09:00:00', returnOrderStatus: 2, returnGoodsInfoList: [{goodsId: 'RG-1', goodsSn: 'SKU-1', goodsTitle: 'item', estimateIncomeMoney: '8.5'}]}],
};
const returns = buildTargetedOpenApiReturnsUpsertSql({artifact: returnArtifact, storeKey: 'DL', returnOrderNo: 'RO-1'});
assertTargetedDetailReplacement(returns, {storeKey: 'DL', identityColumn: 'return_order_no', identityValue: 'RO-1', tables: ['fact.openapi_return_item']}, 'returns');
assert.equal(returns.rowCounts.headers, 1);
assert.equal(returns.rowCounts.items, 1);
assert.match(returns.script, /DL/);
assert.match(returns.script, /RO-1/);
assert.throws(() => buildTargetedOpenApiReturnsUpsertSql({artifact: returnArtifact, storeKey: 'DL', returnOrderNo: 'RO-other'}), /Expected exactly one return header/);
assert.match(buildTargetedOpenApiReturnsReadbackSql({storeKey: 'DL', returnOrderNo: 'RO-1'}), /store_key = 'DL' AND return_order_no = 'RO-1'/);

await assert.rejects(
  () => readbackTargetedOpenApiSales({}, {storeKey: 'HL', orderNo: 'SO-1'}, {headers: 1, items: 1, paymentFlags: 1}, {executor: async () => ({stdout: '{"headers":1,"items":0,"paymentFlags":1}\n'})}),
  /items=0, expected=1/,
);
await assert.rejects(
  () => readbackTargetedOpenApiReturns({}, {storeKey: 'DL', returnOrderNo: 'RO-1'}, {headers: 1, items: 1}, {executor: async () => ({stdout: '{"headers":1,"items":0}\n'})}),
  /items=0, expected=1/,
);

const calls = [];
const matchingOrderClient = {
  async request(endpoint, request) {
    calls.push({endpoint, request});
    return {data: {code: '0', info: [{orderNo: 'SO-1', orderAllocateTime: '2026-07-19 09:00:00', orderGoodsInfoList: []}]}};
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
    return {data: {code: '0', info: [{returnOrderNo: 'RO-1', requestReturnTime: '2026-07-19 09:00:00', returnGoodsInfoList: []}]}};
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
      ? '{"storeKey":"DL","returnOrderNo":"RO-1","headers":1,"items":0}\n'
      : '{"storeKey":"HL","orderNo":"SO-1","headers":1,"items":0,"paymentFlags":1}\n'};
  }
  return {stdout: ''};
};
const syncedOrder = await syncWebhookOrder({storeKey: 'HL', orderNo: 'SO-1', client: matchingOrderClient, storesConfig: {stores: [{key: 'HL', shopName: 'shop'}]}, executor});
const syncedReturn = await syncWebhookReturn({storeKey: 'DL', returnOrderNo: 'RO-1', client: matchingReturnClient, executor});
assert.equal(syncedOrder.readback.headers, 1);
assert.equal(syncedReturn.readback.headers, 1);
assert.equal(executedSql.length, 4);
assertTargetedDetailReplacement({script: executedSql[0]}, {storeKey: 'HL', identityColumn: 'order_no', identityValue: 'SO-1', tables: ['fact.openapi_order_item', 'fact.openapi_order_payment_flag']}, 'sync order mutation');
assertTargetedDetailReplacement({script: executedSql[2]}, {storeKey: 'DL', identityColumn: 'return_order_no', identityValue: 'RO-1', tables: ['fact.openapi_return_item']}, 'sync return mutation');

const aborted = new AbortController();
aborted.abort(Object.assign(new Error('lease lost'), {code: 'SHEIN_WEBHOOK_LEASE_LOST'}));
const writesBeforeAbortCheck = executedSql.length;
await assert.rejects(
  () => syncWebhookOrder({storeKey: 'HL', orderNo: 'SO-1', signal: aborted.signal, client: matchingOrderClient, storesConfig: {stores: []}, executor}),
  /lease lost/,
);
assert.equal(executedSql.length, writesBeforeAbortCheck, 'aborted lease must not start a warehouse write');

console.log(JSON.stringify({ok: true, sales: sales.rowCounts, returns: returns.rowCounts}, null, 2));
