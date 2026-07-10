#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  buildProductDisplayName,
  enrichProductDisplayNames,
  resolveProductDisplayName,
} from '../lib/product_display_name.mjs';

const cases = [
  [{standard_goods_sn: 'SM-505A', goods_title: '电动缝纫机'}, 'SM-505A电动缝纫机'],
  [{standard_goods_sn: 'SK-10075', goods_title: '电油炸锅'}, 'SK-10075电油炸锅'],
  [{standard_goods_sn: 'SK-1928', goods_title: '直发夹板'}, 'SK-1928直发夹板'],
  [{standard_goods_sn: 'S1810电热水壶', goods_title: '电热水壶'}, 'S1810电热水壶'],
  [{standard_goods_sn: 'XYZ-999', goods_title: '测试产品'}, 'XYZ-999测试产品'],
  [{standard_goods_sn: 'T1', goods_title: ''}, 'T1激光脱毛仪'],
  [{standard_goods_sn: '093'}, '093'],
];

for (const [row, expected] of cases) {
  assert.equal(buildProductDisplayName(row), expected, `${row.standard_goods_sn} display name`);
}

assert.equal(resolveProductDisplayName({standard_goods_sn: 'SM-505A'}).source, 'config/product_aliases.json');
assert.equal(resolveProductDisplayName({standard_goods_sn: 'T1'}).needsReview, false);
assert.equal(resolveProductDisplayName({standard_goods_sn: '093'}).needsReview, true);

const data = {
  rankings: {
    dailyProducts: [
      {standard_goods_sn: 'SM-505A', goods_title: '电动缝纫机'},
      {standard_goods_sn: 'T1', goods_title: ''},
    ],
  },
  inventoryDepletion: {
    products: [
      {standard_goods_sn: 'SK-10075', goods_title: '电油炸锅'},
      {standard_goods_sn: 'S1810电热水壶', goods_title: '电热水壶'},
    ],
  },
};

const enriched = enrichProductDisplayNames(data);
assert.equal(enriched.rankings.dailyProducts[0].product_display_name, 'SM-505A电动缝纫机');
assert.equal(enriched.rankings.dailyProducts[1].product_display_name, 'T1激光脱毛仪');
assert.equal(enriched.rankings.dailyProducts[1].product_display_name_needs_review, undefined);
assert.equal(enriched.inventoryDepletion.products[0].product_display_name, 'SK-10075电油炸锅');
assert.equal(enriched.inventoryDepletion.products[1].product_display_name, 'S1810电热水壶');
assert.equal(enriched.productDisplayNames['SM-505A'], 'SM-505A电动缝纫机');
assert.equal(enriched.productDisplayNames['SK-10075'], 'SK-10075电油炸锅');

console.log(`product_display_name: ${cases.length} direct checks plus recursive enrich checks passed`);
