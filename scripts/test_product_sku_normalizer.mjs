#!/usr/bin/env node
import assert from 'node:assert/strict';
import {normalizeGoodsSnDetailed} from '../lib/product_sku_normalizer.mjs';

const cases = [
  ['S1810电热水壶', 'S1810电热水壶', false],
  ['S1810热水壶', 'S1810电热水壶', false],
  ['S1810水壶', 'S1810电热水壶', false],
  ['1810', 'S1810电热水壶', false],
  ['BL02热水壶', 'S1810电热水壶', false],
  ['GL-BL02', 'S1810电热水壶', false],
  ['S1810配件', 'S1810配件', true],
];

for (const [input, expectedCanonical, expectedNeedsReview] of cases) {
  const detail = normalizeGoodsSnDetailed(input, {goodsTitle: input});
  assert.equal(detail.canonical, expectedCanonical, `${input} canonical`);
  assert.equal(detail.needsReview, expectedNeedsReview, `${input} needsReview`);
}

console.log(`product_sku_normalizer: ${cases.length} checks passed`);
