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
  inventory_recovery_date: '2026-05-01',
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
const missingRecoveryEvidence = {...base, inventory_recovery_date: ''};
assert.equal(evaluateLowExposureZeroSalesRetireCandidate(missingRecoveryEvidence, {performanceDate}).reason, 'missing_recovery_evidence');
assert.equal(evaluateLowExposureZeroSalesRetireCandidate({...missingRecoveryEvidence, recovery_history_checked: true}, {performanceDate}).candidate, true);
for (const patch of [
  {inventory_recovery_date: '2026-07-03'},
  {inventory_recovery_date: '', relisted_at: '2026-07-02'},
  {inventory_recovery_date: '', relisted_at: '', last_shelf_time: '2026-07-01'},
]) {
  const got = evaluateLowExposureZeroSalesRetireCandidate({...base, ...patch}, {performanceDate});
  assert.equal(got.candidate, false);
  assert.equal(got.bucket, 'excludedByRecentRecovery15d');
  assert.equal(got.reason, 'inventory_recovery_or_relist_within_15d');
}

console.log(JSON.stringify({ok: true, performanceDate, cutoffDate: firstShelf15dCutoffDate(performanceDate)}, null, 2));
