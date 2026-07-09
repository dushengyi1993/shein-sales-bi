#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import {buildFactRows} from './load_shein_openapi_sales_warehouse.mjs';
import {isValidSalesGoodsRow, salesExclusionReason} from '../lib/shein_sales_validity.mjs';

const data = {
  storeKey: 'TST',
  groupKey: 'G',
  shopName: 'Test Store',
  start: '2026-07-03',
  fetchTime: '2026-07-03T12:00:00.000Z',
  summary: {salesSar: 9999, salesRmb: 9999},
  orderRows: [
    {orderId: 'VALID', orderNo: 'VALID', allocateTimeFull: '2026-07-03 10:00:00'},
    {orderId: 'CANCEL_FLAG', orderNo: 'CANCEL_FLAG', allocateTimeFull: '2026-07-03 11:00:00'},
    {orderId: 'CANCEL_STATUS', orderNo: 'CANCEL_STATUS', allocateTimeFull: '2026-07-03 12:00:00'},
  ],
  goodsRows: [
    {
      orderId: 'VALID',
      orderNo: 'VALID',
      goodsId: '1001',
      goodsSn: 'S1810电热水壶',
      number: 1,
      currencyCode: 'SAR',
      currencyPrice: 100,
      newOrderGoodsStatus: 1,
      goodsPerformanceStatus: 3,
      goodsPerformanceStatusDesc: '',
    },
    {
      orderId: 'CANCEL_FLAG',
      orderNo: 'CANCEL_FLAG',
      goodsId: '1002',
      goodsSn: 'KJ-102三明治机',
      number: 1,
      currencyCode: 'SAR',
      currencyPrice: 57.4,
      newOrderGoodsStatus: 6,
      goodsPerformanceStatus: 2,
      goodsPerformanceStatusDesc: '',
      isValidSale: false,
      salesExclusionReason: 'cancelled_before_pickup',
    },
    {
      orderId: 'CANCEL_STATUS',
      orderNo: 'CANCEL_STATUS',
      goodsId: '1003',
      goodsSn: 'SK-13065吸尘器',
      number: 1,
      currencyCode: 'SAR',
      currencyPrice: 57.78,
      newOrderGoodsStatus: 6,
      goodsPerformanceStatus: 6,
      goodsPerformanceStatusDesc: '揽收前已取消',
    },
  ],
};

assert.equal(isValidSalesGoodsRow(data.goodsRows[0]), true, 'normal OpenAPI sale remains valid');
assert.equal(isValidSalesGoodsRow(data.goodsRows[1]), false, 'explicit OpenAPI invalid sale flag is honored');
assert.equal(salesExclusionReason(data.goodsRows[1]), 'cancelled_before_pickup', 'explicit exclusion reason is preserved');
assert.equal(isValidSalesGoodsRow(data.goodsRows[2]), false, 'cancelled performance status is excluded');

const fact = buildFactRows(data, path.join(process.cwd(), 'outputs', 'shein_openapi_fetch', 'TST', '2026-07-03.json'));
assert.equal(fact.daily.length, 1);
assert.equal(fact.orders.length, 3);
assert.equal(fact.items.length, 3);

const daily = fact.daily[0];
assert.equal(daily.sales_sar, 100);
assert.equal(daily.sales_rmb, 180);
assert.equal(daily.valid_order_count, 1);
assert.equal(daily.goods_line_count, 3);
assert.equal(daily.quantity_all, 3);
assert.equal(daily.quantity_positive_amount, 1);
assert.equal(JSON.parse(daily.raw_summary).excludedGoodsLineCount, 2);

const byOrder = new Map(fact.items.map(row => [row.order_no, row]));
assert.equal(byOrder.get('VALID').quantity, 1);
assert.equal(byOrder.get('VALID').currency_price, 100);
assert.equal(byOrder.get('VALID').sales_sar, 100);
assert.equal(byOrder.get('VALID').sales_rmb, 180);

for (const orderNo of ['CANCEL_FLAG', 'CANCEL_STATUS']) {
  const row = byOrder.get(orderNo);
  assert.equal(row.quantity, 0, `${orderNo} quantity should be zeroed`);
  assert.equal(row.sales_sar, 0, `${orderNo} sales_sar should be zeroed`);
  assert.equal(row.sales_rmb, 0, `${orderNo} sales_rmb should be zeroed`);
  assert.equal(Number(row.currency_price) > 0, true, `${orderNo} original currency_price should be preserved for audit`);
}

console.log('openapi_sales_loader_validity: checks passed');
