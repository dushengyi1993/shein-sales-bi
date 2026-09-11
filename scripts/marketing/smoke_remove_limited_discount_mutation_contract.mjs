#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateRemovalMutationContract} from './_managed_limited_discount_conflict.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const helperPath = path.join(ROOT, 'scripts/marketing/remove_skc_from_limited_discount.mjs');
const helperSource = await fs.readFile(helperPath, 'utf8');
const beforeValidationIndex = helperSource.indexOf('const beforeContractValidation');
const deleteIndex = helperSource.indexOf("post('/promotion/simple_platform/delete_activity_goods'");
const afterValidationIndex = helperSource.indexOf('const afterContractValidation');
assert.ok(beforeValidationIndex >= 0 && beforeValidationIndex < deleteIndex,
  'the real delete helper must validate the locked snapshot inside its mutation invocation before DELETE');
assert.ok(afterValidationIndex > deleteIndex,
  'the real delete helper must validate preserved activity state, deadline, and goods after DELETE');
assert.match(helperSource, /--execute requires --expected-snapshot/);

const target = good('TARGET', 70, 10, 90, 'T-1');
const preserved = good('PRESERVED', 75, 12, 44, 'P-1');
const expected = {
  schemaVersion: 1,
  storeKey: 'DL',
  activityId: 88990001,
  state: 3,
  startTime: '2026-09-01 00:00:00',
  endTime: '2026-09-30 23:59:59',
  plannedSkcs: ['TARGET'],
  preserveSkcs: ['PRESERVED'],
  beforeGoods: [target, preserved],
};
const activity = {
  activity_id: expected.activityId,
  state: expected.state,
  start_time: expected.startTime,
  end_time: expected.endTime,
};

assert.equal(validateRemovalMutationContract({
  expected,
  currentActivity: activity,
  currentGoods: [preserved, target],
  phase: 'before',
}).ok, true);

for (const [name, currentActivity, currentGoods, expectedError] of [
  ['target-price', activity, [{...target, product_act_price: 69}, preserved], 'before_goods_attributes_changed'],
  ['target-stock', activity, [{...target, stock_num: 89}, preserved], 'before_goods_attributes_changed'],
  ['preserved-price', activity, [target, {...preserved, product_act_price: 74}], 'before_goods_attributes_changed'],
  ['activity-state', {...activity, state: 4}, [target, preserved], 'before_activity_state_changed'],
  ['activity-deadline', {...activity, end_time: '2026-09-29 23:59:59'}, [target, preserved], 'before_activity_end_time_changed'],
]) {
  const validation = validateRemovalMutationContract({expected, currentActivity, currentGoods, phase: 'before'});
  assert.equal(validation.ok, false, `${name} drift must block DELETE`);
  assert.ok(validation.errors.includes(expectedError), `${name} must report ${expectedError}`);
}

assert.equal(validateRemovalMutationContract({
  expected,
  currentActivity: activity,
  currentGoods: [preserved],
  phase: 'after',
}).ok, true);

for (const [name, currentActivity, currentGoods, expectedError] of [
  ['preserved-stock', activity, [{...preserved, stock_num: 43}], 'after_goods_attributes_changed'],
  ['terminal-state', {...activity, state: 4}, [preserved], 'after_activity_state_changed'],
  ['terminal-deadline', {...activity, end_time: '2026-09-29 23:59:59'}, [preserved], 'after_activity_end_time_changed'],
]) {
  const validation = validateRemovalMutationContract({expected, currentActivity, currentGoods, phase: 'after'});
  assert.equal(validation.ok, false, `${name} drift must fail terminal selective-delete verification`);
  assert.ok(validation.errors.includes(expectedError), `${name} must report ${expectedError}`);
}

console.log(JSON.stringify({
  ok: true,
  test: 'real_remove_helper_binds_snapshot_before_delete_and_verifies_preserved_terminal_contract',
}));

function good(skc, price, activityStock, stock, id) {
  return {
    skc,
    sku_supplier_no: `SUP-${skc}`,
    product_act_price: price,
    max_product_act_price: price,
    attend_num_sum: activityStock,
    stock_num: stock,
    goods_state: 1,
    id,
  };
}
