#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  buildBiOpsDirectQueryResponse,
  planBiOpsDirectQuerySections,
  scopeBiOpsDirectQueryData,
} from '../lib/bi_ops_direct_query.mjs';

const linkPlan = planBiOpsDirectQuerySections(
  '找出点击率4%以上、近7天曝光量3000以上且近7天销量为0的链接',
);
assert.deepEqual(
  linkPlan.sections,
  ['linksData', 'productState', 'productTrafficDaily'],
  'link filtering must load deterministic link/state/traffic data instead of a sales answer bot',
);

const todayPlan = planBiOpsDirectQuerySections('今天全部店铺销售额和订单数是多少');
assert.deepEqual(
  todayPlan.sections,
  ['rankings', 'liveSalesToday'],
  'today sales must include complete rankings and the live event-backed section',
);

assert.throws(
  () => planBiOpsDirectQuerySections('test', {sections: ['notASection']}),
  error => error?.code === 'BI_QUERY_SECTION_UNSUPPORTED',
);
assert.throws(
  () => planBiOpsDirectQuerySections('test', {
    sections: ['rankings', 'profit', 'actions', 'linksData', 'productState', 'comments', 'orders', 'afterSales', 'waybills'],
  }),
  error => error?.code === 'BI_QUERY_TOO_MANY_SECTIONS',
);

const data = {
  generatedAt: '2026-07-28T12:00:00.000+08:00',
  dates: {
    salesDate: '2026-07-28',
    salesUpdatedAt: '2026-07-28T11:59:00.000+08:00',
    linkUpdatedAt: '2026-07-28T08:30:00.000+08:00',
  },
  stores: [
    {store_key: 'DX', label: 'DX 店'},
    {store_key: 'HL', label: 'HL 店'},
  ],
  productDisplayNames: {'SKU-1': '测试商品'},
  rankings: {
    salesSummary: [
      {period_key: 'day', end_date: '2026-07-28', gross_sales_sar: 300},
    ],
    dailyStores: [
      {date: '2026-07-28', store_key: 'DX', gross_sales_sar: 100},
      {date: '2026-07-28', store_key: 'HL', gross_sales_sar: 200},
    ],
    dailyProducts: [
      {date: '2026-07-28', standard_goods_sn: 'SKU-1', gross_sales_sar: 300},
    ],
    dailyStoreProducts: [
      {date: '2026-07-28', store_key: 'DX', standard_goods_sn: 'SKU-1', gross_sales_sar: 100},
      {date: '2026-07-28', store_key: 'HL', standard_goods_sn: 'SKU-1', gross_sales_sar: 200},
    ],
  },
  storeLinks: [
    {store_key: 'DX', standard_goods_sn: 'SKU-1', skc: 'sv-dx', c7_eps_uv: 4000, c7_goods_uv: 200, c7_sale_cnt: 0},
    {store_key: 'HL', standard_goods_sn: 'SKU-1', skc: 'sv-hl', c7_eps_uv: 5000, c7_goods_uv: 100, c7_sale_cnt: 0},
  ],
  links: [],
  matrix: [],
  productStateOverlay: [
    {store_key: 'DX', skc: 'sv-dx', shelf_status_name: '已上架'},
    {store_key: 'HL', skc: 'sv-hl', shelf_status_name: '待上架'},
  ],
};

const meta = {
  coreGeneratedAt: data.generatedAt,
  loadedSections: ['rankings', 'linksData', 'productState'],
  attemptedSections: [
    {section: 'rankings', status: 'loaded'},
    {section: 'linksData', status: 'loaded'},
    {section: 'productState', status: 'loaded'},
  ],
  sourceByPath: {
    rankings: 'rankings',
    storeLinks: 'linksData',
    productStateOverlay: 'productState',
  },
};

const globalResponse = buildBiOpsDirectQueryResponse({
  question: '查询销售和链接',
  sections: ['rankings', 'linksData', 'productState'],
  data,
  meta,
  readStores: ['*'],
});
assert.equal(globalResponse.ok, true);
assert.equal(globalResponse.mode, 'direct-bi-data');
assert.equal(globalResponse.aiInvoked, false);
assert.equal(globalResponse.scope.mode, 'all_stores');
assert.equal(globalResponse.data.rankings.dailyStores.length, 2);
assert.equal(globalResponse.data.storeLinks.length, 2);

const restrictedResponse = buildBiOpsDirectQueryResponse({
  question: '只查 DX',
  sections: ['rankings', 'linksData', 'productState'],
  data,
  meta,
  readStores: ['DX'],
});
assert.equal(restrictedResponse.ok, true);
assert.deepEqual(restrictedResponse.scope.stores, ['DX']);
assert.deepEqual(restrictedResponse.data.stores.map(row => row.store_key), ['DX']);
assert.deepEqual(restrictedResponse.data.rankings.dailyStores.map(row => row.store_key), ['DX']);
assert.deepEqual(restrictedResponse.data.rankings.dailyStoreProducts.map(row => row.store_key), ['DX']);
assert.deepEqual(restrictedResponse.data.storeLinks.map(row => row.store_key), ['DX']);
assert.deepEqual(restrictedResponse.data.productStateOverlay.map(row => row.store_key), ['DX']);
assert.deepEqual(
  restrictedResponse.data.rankings.dailyProducts,
  [],
  'cross-store product aggregates must not leak through a restricted account',
);
assert.deepEqual(
  restrictedResponse.data.rankings.salesSummary,
  [],
  'cross-store total aggregates must not leak through a restricted account',
);
assert.ok(restrictedResponse.scope.omittedUnauthorizedRows >= 4);
assert.ok(restrictedResponse.scope.omittedUnscopedAggregateRows >= 2);
assert.equal(restrictedResponse.rowCounts['rankings.dailyStores'], 1);

assert.throws(
  () => scopeBiOpsDirectQueryData(data, {readStores: ['DX'], requestedStores: ['HL']}),
  error => error?.code === 'BI_QUERY_STORE_FORBIDDEN'
    && error?.deniedStores?.includes('HL'),
);

const incomplete = buildBiOpsDirectQueryResponse({
  question: '查询售后',
  sections: ['afterSales'],
  data,
  meta: {
    coreGeneratedAt: data.generatedAt,
    loadedSections: [],
    attemptedSections: [{section: 'afterSales', status: 'missing'}],
  },
  readStores: ['*'],
});
assert.equal(incomplete.ok, false);
assert.deepEqual(incomplete.sections.issues, [{
  section: 'afterSales',
  status: 'missing',
  expectedGeneratedAt: '',
  generatedAt: '',
}]);

console.log('bi_ops_direct_query: deterministic planning, no-agent contract, store scoping, and incomplete-data guard passed');
