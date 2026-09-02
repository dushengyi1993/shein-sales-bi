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
  ['SK-7032', 'SK-YM-7032绞肉机', false],
  ['WK-1710-4', 'WK-1710-4手持搅拌器', false],
  ['KJ-102横条三明治机', 'KJ-102三明治机和早餐机', false],
  ['KJ-102S三明治机', 'KJ-102S三明治机和早餐机', false],
  ['KJ-102三明治机', 'KJ-102三明治机和早餐机', false],
  ['SK-1714', 'SK-1714-5手持搅拌器', false],
  ['1714', 'SK-1714-5手持搅拌器', false],
  ['PA4-6L小冰箱', 'PA4-6L便携式冰箱', false],
  ['PA4-6L便携式冰箱', 'PA4-6L便携式冰箱', false],
  ['全PA4-6L便携式冰箱', 'PA4-6L便携式冰箱', false],
  ['SK-446切片机', 'SK-446电动刀与切片器', false],
  ['SK-3065', 'SK-GT-3065蒸汽熨烫机', false],
  ['SK-675', 'SK-JFB-675B卷发钳和卷发棒', false],
  ['SK-13065布衣清洗机', 'SK-13065吸尘器', false],
  ['SK-13065吸尘器', 'SK-13065吸尘器', false],
  ['SK-13065地毯清洗机', 'SK-13065吸尘器', false],
  ['DL-SK-13034', 'SK-13034杆式吸尘器', false],
  ['SK=-3378杆式吸尘器', 'SK-3378杆式吸尘器', false],
  ['SK-5110', 'SK-5110电磁炉', false],
  ['389', 'JD-389空气炸锅', false],
  ['689', 'JD-389空气炸锅', false],
  ['YJ389空气炸锅', 'JD-389空气炸锅', false],
  ['ZL389空气炸锅', 'JD-389空气炸锅', false],
  ['KFJ683901', 'SK-6863半自动意式咖啡机', false],
  ['EN 62368-1:2014+A11:2017', '', false],
  ['093', '093', true],
];

for (const [input, expectedCanonical, expectedNeedsReview] of cases) {
  const detail = normalizeGoodsSnDetailed(input, {goodsTitle: input});
  assert.equal(detail.canonical, expectedCanonical, `${input} canonical`);
  assert.equal(detail.needsReview, expectedNeedsReview, `${input} needsReview`);
}

console.log(`product_sku_normalizer: ${cases.length} checks passed`);
