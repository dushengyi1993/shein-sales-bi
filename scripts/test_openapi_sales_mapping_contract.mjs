#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  mapOpenApiOrderDetails,
  resolveOpenApiStoreMetadata,
} from '../lib/shein_openapi_sales_mapper.mjs';
import {extractPaymentFlagsFromSalesArtifact} from '../lib/order_payment_flags.mjs';
import {compareSalesArtifacts} from './load_shein_openapi_sales_warehouse.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const detail = {
  orderNo: 'O-1',
  orderStatus: 4,
  orderAllocateTime: '2026-07-10 09:00:00',
  addTime: '2026-07-10 09:00:01',
  orderTime: '2026-07-10 08:49:01',
  paymentTime: '2026-07-10 08:48:30',
  salesSite: 'SA',
  isCod: 1,
  orderGoodsInfoList: [
    {
      goodsId: 'G-1',
      goodsSn: 'S1810电热水壶',
      sellerSku: 'SELLER-1',
      skuCode: 'SKU-1',
      skc: 'SKC-1',
      goodsTitle: 'Kettle',
      saleCurrency: 'SAR',
      estimatedIncome: 100,
      newGoodsStatus: 4,
      performanceTag: 1,
      skuAttribute: [{language: 'CN', attrName: '颜色', attrValueId: '11'}],
    },
    {
      goodsId: 'G-2',
      goodsSn: 'KJ-102三明治机',
      sellerSku: 'SELLER-2',
      skuCode: 'SKU-2',
      skc: 'SKC-2',
      goodsTitle: 'Sandwich maker',
      saleCurrency: 'SAR',
      estimatedIncome: 57.4,
      newGoodsStatus: 6,
      performanceTag: 2,
      skuAttribute: [{language: 'CN', attrName: '插头规格', attrValueId: '22'}],
    },
  ],
};

const metadata = resolveOpenApiStoreMetadata(
  'TST',
  {storeKey: 'TST', shopName: 'TST'},
  {stores: [{key: 'TST', groupKey: 'DSY', shopName: 'GS0000001'}]},
);
assert.deepEqual(metadata, {storeKey: 'TST', groupKey: 'DSY', shopName: 'GS0000001'});

const mapped = mapOpenApiOrderDetails([detail]);
assert.equal(mapped.orderRows.length, 1);
assert.equal(mapped.goodsRows.length, 2);
assert.equal(mapped.orderRows[0].orderId, '', 'OpenAPI orderNo must not masquerade as the internal WebAPI orderId');
assert.equal(mapped.orderRows[0].orderCreateTime, detail.orderAllocateTime);
assert.equal(mapped.orderRows[0].allocateTimeFull, detail.orderAllocateTime);
assert.equal(mapped.orderRows[0].orderStatusDesc, '已发货');

const valid = mapped.goodsRows.find((row) => row.goodsId === 'G-1');
assert.equal(valid.orderCreateTime, detail.orderAllocateTime);
assert.equal(valid.entityId, '', 'OpenAPI goodsId must not masquerade as WebAPI entityId');
assert.equal(valid.suffix, '', 'attribute names must not masquerade as WebAPI SKU suffix values');
assert.equal(valid.currencyPrice, 100);
assert.equal(valid.goodsPerformanceStatus, 4);
assert.equal(valid.goodsPerformanceStatusDesc, '尾程已发货');
assert.equal(valid.isValidSale, true);

const cancelled = mapped.goodsRows.find((row) => row.goodsId === 'G-2');
assert.equal(cancelled.currencyPrice, 0, 'cancelled estimated income must not become a sale price');
assert.equal(cancelled.openApiEstimatedIncome, 57.4, 'raw OpenAPI estimated income remains auditable');
assert.equal(cancelled.goodsPerformanceStatus, 6);
assert.equal(cancelled.goodsPerformanceStatusDesc, '揽收前已取消');
assert.equal(cancelled.pageStatus, 'CANCEL');
assert.equal(cancelled.isValidSale, false);
assert.equal(cancelled.salesExclusionReason, 'cancelled_before_pickup');

const refundedAfterFulfillmentDetail = {
  ...structuredClone(detail),
  orderNo: 'O-2',
  orderStatus: 6,
  orderGoodsInfoList: [
    {
      ...structuredClone(detail.orderGoodsInfoList[0]),
      goodsId: 'G-3',
      skuCode: 'SKU-3',
      skc: 'SKC-3',
      estimatedIncome: 139.38,
      newGoodsStatus: 6,
      performanceTag: 1,
    },
    {
      ...structuredClone(detail.orderGoodsInfoList[0]),
      goodsId: 'G-4',
      skuCode: 'SKU-4',
      skc: 'SKC-4',
      estimatedIncome: 156.94,
      newGoodsStatus: 6,
      performanceTag: 3,
    },
  ],
};
const refundedAfterFulfillment = mapOpenApiOrderDetails([refundedAfterFulfillmentDetail]);
for (const row of refundedAfterFulfillment.goodsRows) {
  assert.equal(row.isValidSale, true, 'a positive-income refund after fulfilment remains a gross sale');
  assert.equal(row.salesExclusionReason, '');
  assert.equal(row.postFulfillmentRefund, true);
  assert.equal(row.goodsPerformanceStatus, 4);
  assert.equal(row.goodsPerformanceStatusDesc, '退款后履约状态待复查');
  assert.equal(row.performStatusDesc, '退款后履约状态待复查');
  assert.equal(row.currencyPrice, row.openApiEstimatedIncome);
}

const apiArtifact = {
  storeKey: 'TST',
  groupKey: metadata.groupKey,
  shopName: metadata.shopName,
  start: '2026-07-10',
  source: 'shein-openapi',
  orderRefs: [{orderNo: 'O-1'}],
  orders: [detail],
  ...mapped,
};
const browserArtifact = structuredClone(apiArtifact);
browserArtifact.source = 'shein-webapi';
browserArtifact.orderRefs = [{orderId: 'INTERNAL-1'}];
browserArtifact.orders = [{
  id: 'INTERNAL-1',
  orderNo: 'O-1',
  tagCodeList: [{tagCode: 'COD', tagDesc: 'COD'}],
}];
browserArtifact.orderRows[0].orderId = 'INTERNAL-1';
browserArtifact.goodsRows[0].orderId = 'INTERNAL-1';
browserArtifact.goodsRows[0].entityId = 'ENTITY-1';
browserArtifact.goodsRows[0].suffix = '黑色';
browserArtifact.goodsRows[0].goodsPerformanceStatus = 1;
browserArtifact.goodsRows[0].goodsPerformanceStatusDesc = '';
browserArtifact.goodsRows[1].orderId = 'INTERNAL-1';
browserArtifact.goodsRows[1].entityId = 'ENTITY-2';
browserArtifact.goodsRows[1].suffix = '英规';
browserArtifact.goodsRows[1].salesExclusionReason = 'cancelled_page_status';

const exact = compareSalesArtifacts(browserArtifact, apiArtifact);
assert.equal(exact.matched, true);
assert.equal(exact.quality.businessLineDiffCount, 0);
assert.equal(exact.quality.scatterPointDiffCount, 0);
assert.equal(exact.quality.orderTimeDiffCount, 0);
assert.equal(exact.quality.codDiffCount, 0);
assert.equal(exact.quality.metadataDiffCount, 0);
assert.equal(exact.quality.statusDiffCount > 0, true, 'transport-specific status overlays are visible but do not corrupt sales parity');
assert.equal(exact.quality.identityOverlayRequired, true);

const refundedReturnBrowser = structuredClone(apiArtifact);
refundedReturnBrowser.source = 'shein-webapi';
refundedReturnBrowser.orderRefs = [{orderId: 'INTERNAL-RETURN'}];
refundedReturnBrowser.orders = [{
  id: 'INTERNAL-RETURN',
  orderNo: 'O-1',
  tagCodeList: [{tagCode: 'COD', tagDesc: 'COD'}],
}];
const refundedReturnLine = refundedReturnBrowser.goodsRows.find((row) => row.goodsId === 'G-2');
refundedReturnLine.pageStatus = 'RETURN_ON_WAY';
refundedReturnLine.pageStatusDesc = '派件失败退回中';
refundedReturnLine.performStatus = 4;
refundedReturnLine.performStatusDesc = '尾程已发货';
refundedReturnLine.goodsPerformanceStatus = 4;
refundedReturnLine.goodsPerformanceStatusDesc = '尾程已发货';
refundedReturnLine.salesExclusionReason = '';
const transportStatusConflict = compareSalesArtifacts(refundedReturnBrowser, apiArtifact);
assert.equal(transportStatusConflict.matched, true,
  'the same refunded zero-value line must reconcile even when transports expose different fulfilment states');
assert.equal(transportStatusConflict.quality.businessLineDiffCount, 0,
  'transport-specific exclusion labels must not change business-line identity');
assert.equal(transportStatusConflict.quality.statusDiffCount, 2,
  'the replaced fulfilment state remains visible as one removed and one added status key');

const paymentFlag = extractPaymentFlagsFromSalesArtifact(apiArtifact, {
  date: apiArtifact.start,
  sourceKind: 'openapi',
})[0];
assert.equal(paymentFlag.order_create_time, detail.orderAllocateTime, 'COD fact time must use the mapped business time');

const brokenArtifact = structuredClone(apiArtifact);
brokenArtifact.groupKey = '';
brokenArtifact.goodsRows[0].orderCreateTime = '2026-07-10 08:49:01';
brokenArtifact.goodsRows[0].currencyPrice = 99;
const broken = compareSalesArtifacts(browserArtifact, brokenArtifact);
assert.equal(broken.matched, false);
assert.equal(broken.quality.metadataDiffCount > 0, true);
assert.equal(broken.quality.orderTimeDiffCount > 0, true);
assert.equal(broken.quality.businessLineDiffCount > 0, true);
assert.equal(broken.quality.scatterPointDiffCount > 0, true);

const fetchSource = await fs.readFile(path.join(ROOT, 'scripts', 'fetch_shein_openapi_sales.mjs'), 'utf8');
assert.match(fetchSource, /shein_openapi_sales_mapper\.mjs/, 'fetcher must use the tested pure mapper');

const runnerSource = await fs.readFile(path.join(ROOT, 'scripts', 'run_shein_openapi_sales_reconciliation.mjs'), 'utf8');
assert.match(runnerSource, /\['--ensure-only'\]/, 'parallel reconciliation must run schema DDL once before store workers');
assert.match(runnerSource, /'--skip-ensure'/, 'parallel store loaders must not race on schema DDL');

const productRunnerSource = await fs.readFile(path.join(ROOT, 'scripts', 'run_shein_openapi_products_reconciliation.mjs'), 'utf8');
assert.match(productRunnerSource, /\['--ensure-only'(?:,|\])/, 'parallel product reconciliation must run schema DDL once');
assert.match(productRunnerSource, /'--skip-ensure'/, 'parallel product loaders must not race on schema DDL');

console.log('openapi_sales_mapping_contract: checks passed');
