#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  evaluateLowExposureZeroSalesRetireCandidate,
  firstShelf15dCutoffDate,
} from '../lib/link_retire_candidate_policy.mjs';

const performanceDate = '2026-07-04';
assert.equal(firstShelf15dCutoffDate(performanceDate), '2026-06-20');

const base = {
  is_on_shelf: true,
  c7_exposure: 0,
  c7_sale_cnt: 0,
  new_goods_tag: '',
  first_shelf_time: '2026-06-19 23:59:59',
};

assert.equal(evaluateLowExposureZeroSalesRetireCandidate(base, {performanceDate}).candidate, true);

for (const firstShelf of ['2026-06-20 00:00:00', '2026-06-28 14:57:56', '2026-07-04 20:31:21']) {
  const got = evaluateLowExposureZeroSalesRetireCandidate({...base, first_shelf_time: firstShelf}, {performanceDate});
  assert.equal(got.candidate, false);
  assert.equal(got.bucket, 'excludedByFirstShelf15d');
}

assert.equal(evaluateLowExposureZeroSalesRetireCandidate({...base, new_goods_tag: '4'}, {performanceDate}).bucket, 'excludedByNewGoodsTag');
assert.equal(evaluateLowExposureZeroSalesRetireCandidate({...base, c7_exposure: 301}, {performanceDate}).reason, 'c7_exposure_gt_300');
assert.equal(evaluateLowExposureZeroSalesRetireCandidate({...base, c7_sale_cnt: 1}, {performanceDate}).reason, 'c7_sale_cnt_not_zero');
const missingNewTag = {...base};
delete missingNewTag.new_goods_tag;
assert.equal(evaluateLowExposureZeroSalesRetireCandidate(missingNewTag, {performanceDate}).reason, 'missing_new_goods_tag');
assert.equal(evaluateLowExposureZeroSalesRetireCandidate({...base, first_shelf_time: ''}, {performanceDate}).bucket, 'cannotJudge');

console.log(JSON.stringify({ok: true, performanceDate, cutoffDate: firstShelf15dCutoffDate(performanceDate)}, null, 2));
