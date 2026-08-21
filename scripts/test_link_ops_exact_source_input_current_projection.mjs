#!/usr/bin/env node
import assert from 'node:assert/strict';

process.env.SHEIN_LINK_OPS_EXECUTOR_SELF_TEST = '1';
const {__testHooks} = await import('./link_ops_hl_openapi_executor.mjs');

const INPUT_CURRENT_ATTRIBUTE_ID = 1002323;
const SOURCE_SKC = 'sv251109008981839372';

function sourcePayload({withExistingInputCurrent = false} = {}) {
  const attributes = Array.from({length: 11}, (_, index) => ({
    attribute_id: 2000000 + index,
    attribute_value_id: 3000000 + index,
  }));
  if (withExistingInputCurrent) {
    attributes[4] = {
      attribute_id: INPUT_CURRENT_ATTRIBUTE_ID,
      attribute_extra_value: '1200',
      attribute_value_id: 304302428,
    };
  }
  return {
    product_type_id: 9851,
    product_attribute_list: attributes,
    skc_list: [{source_skc: SOURCE_SKC, sku_list: []}],
  };
}

function validOverride(extraValue = '6818') {
  return {
    attribute_id: INPUT_CURRENT_ATTRIBUTE_ID,
    attribute_extra_value: extraValue,
    attribute_unit: 'mA',
    label: '输入电流',
    source: 'explicit_prepare_publish',
  };
}

function camelOverride(extraValue = '6818') {
  return {
    attributeId: INPUT_CURRENT_ATTRIBUTE_ID,
    attributeExtraValue: extraValue,
    attributeUnit: 'mA',
    label: '输入电流',
    source: 'explicit_prepare_publish',
  };
}

function approvedBinding(publishPreparation) {
  return {
    sourceApproved: true,
    authority: 'human_reviewed_source',
    targetStore: 'FY',
    boundAt: '2026-08-21T10:00:00.000Z',
    bindingFingerprint: 'a'.repeat(64),
    imageCount: 2,
    images: [{
      name: 'main.png',
      role: 'mainCover',
      imageType: 1,
      imageUrl: 'https://img.shein.com/s1810/main.png',
      width: 900,
      height: 1200,
      order: 1,
    }, {
      name: 'square.png',
      role: 'squareImage',
      imageType: 5,
      imageUrl: 'https://img.shein.com/s1810/square.png',
      width: 1200,
      height: 1200,
      order: 2,
    }],
    publishPreparation,
  };
}

function taskWithPreparation(attributeOverrides) {
  return {
    intents: ['copy_product_draft'],
    targets: {
      sourceStores: ['FY'],
      sourceSkc: SOURCE_SKC,
      writeStores: ['FY'],
      stores: ['FY'],
    },
    publishPreparation: {attributeOverrides},
  };
}

function merge(attributeOverrides, options = {}) {
  return mergeTask(taskWithPreparation(attributeOverrides), options);
}

function mergeTask(task, options = {}) {
  return __testHooks.mergeExactSourceDestinationBindings(
    sourcePayload(options),
    task,
    null,
    'FY',
  );
}

function inputCurrentRows(payload) {
  return payload.product_attribute_list.filter(row => Number(row.attribute_id) === INPUT_CURRENT_ATTRIBUTE_ID);
}

const valid = merge([validOverride()]);
assert.equal(valid.payload.product_attribute_list.length, 12, 'valid override must add exactly one source attribute');
assert.equal(inputCurrentRows(valid.payload).length, 1, 'valid override must produce one Input current row');
assert.deepEqual(inputCurrentRows(valid.payload)[0], {
  attribute_id: INPUT_CURRENT_ATTRIBUTE_ID,
  attribute_extra_value: '6818',
  __manual_attribute_unit: 'mA',
});
assert.equal(valid.applied.some(value => value.includes('1002323') && value.includes('6818mA')), true);

const finalized = await __testHooks.applyAttributeTemplateRules({
  async request(pathname) {
    assert.equal(pathname, '/open-api/goods/query-attribute-template');
    return {
      ok: true,
      status: 200,
      data: {
        code: '0',
        msg: 'OK',
        info: {data: [{
          product_type_id: 9851,
          attribute_infos: [{
            attribute_id: INPUT_CURRENT_ATTRIBUTE_ID,
            attribute_name: 'Input current',
            attribute_mode: 4,
            attribute_status: 3,
            attribute_value_info_list: [{attribute_value_id: 304302428, attribute_value: 'mA'}],
          }],
        }]},
      },
    };
  },
}, valid.payload, {copyProductDraft: true, exactSourceLock: true});
const finalizedInputCurrent = inputCurrentRows(finalized.payload);
assert.equal(finalized.blockers.length, 0, JSON.stringify(finalized.blockers));
assert.equal(finalizedInputCurrent.length, 1, 'template finalization must retain one Input current row');
assert.equal(finalizedInputCurrent[0].attribute_extra_value, '6818');
assert.equal(finalizedInputCurrent[0].attribute_value_id, 304302428);
assert.equal(Object.hasOwn(finalizedInputCurrent[0], '__manual_attribute_unit'), false);

const replaced = merge([validOverride()], {withExistingInputCurrent: true});
assert.equal(replaced.payload.product_attribute_list.length, 11, 'valid override must replace an existing source row');
assert.equal(inputCurrentRows(replaced.payload).length, 1, 'replacement must remove source duplicates');
assert.equal(inputCurrentRows(replaced.payload)[0].attribute_extra_value, '6818');

const noOverridePayload = sourcePayload();
const noOverride = __testHooks.mergeExactSourceDestinationBindings(
  noOverridePayload,
  {intents: ['copy_product_draft'], targets: {sourceStores: ['FY'], sourceSkc: SOURCE_SKC, writeStores: ['FY'], stores: ['FY']}},
  {},
  'FY',
);
assert.deepEqual(noOverride.payload.product_attribute_list, noOverridePayload.product_attribute_list, 'no override must leave source attributes unchanged');
const emptyOverride = merge([]);
assert.deepEqual(emptyOverride.payload.product_attribute_list, noOverridePayload.product_attribute_list, 'empty override list must leave source attributes unchanged');

const targetsOnlyTask = taskWithPreparation([validOverride()]);
targetsOnlyTask.targets.publishPreparation = targetsOnlyTask.publishPreparation;
delete targetsOnlyTask.publishPreparation;
const targetsOnly = mergeTask(targetsOnlyTask);
assert.equal(inputCurrentRows(targetsOnly.payload).length, 1, 'legal targets-only preparation must remain supported');
assert.equal(inputCurrentRows(targetsOnly.payload)[0].attribute_extra_value, '6818');

function crossSourceTask(rootOverrides, targetOverrides, {targetSnakeAlias = false} = {}) {
  const task = taskWithPreparation(rootOverrides);
  task.targets.publishPreparation = targetSnakeAlias
    ? {attribute_overrides: targetOverrides}
    : {attributeOverrides: targetOverrides};
  return task;
}

const threeWayIdentical = crossSourceTask([validOverride()], [camelOverride()], {targetSnakeAlias: true});
threeWayIdentical.publishAssetBinding = approvedBinding({attributeOverrides: [validOverride()]});
const threeWayIdenticalResult = mergeTask(threeWayIdentical);
assert.equal(inputCurrentRows(threeWayIdenticalResult.payload).length, 1, 'identical task/targets/binding declarations must project once');
assert.equal(inputCurrentRows(threeWayIdenticalResult.payload)[0].attribute_extra_value, '6818');

assert.throws(
  () => mergeTask(crossSourceTask([validOverride('6818')], [validOverride('7000')])),
  /declarations differ across persisted publishPreparation sources/i,
  'different root/targets declarations must fail closed',
);

const bindingTaskConflict = taskWithPreparation([validOverride('6818')]);
bindingTaskConflict.publishAssetBinding = approvedBinding({attributeOverrides: [validOverride('7000')]});
assert.throws(
  () => mergeTask(bindingTaskConflict),
  /declarations differ across persisted publishPreparation sources/i,
  'binding must not hide a different task declaration',
);

const metadataFallbackIdentical = taskWithPreparation([validOverride()]);
metadataFallbackIdentical.metadata = {
  publishAssetBinding: approvedBinding({attribute_overrides: [camelOverride()]}),
};
const metadataFallbackResult = mergeTask(metadataFallbackIdentical);
assert.equal(inputCurrentRows(metadataFallbackResult.payload).length, 1, 'metadata binding fallback must participate in semantic agreement');

const singleSourceDualAlias = taskWithPreparation([validOverride()]);
singleSourceDualAlias.publishPreparation.attribute_overrides = [validOverride()];
assert.throws(
  () => mergeTask(singleSourceDualAlias),
  /both attributeOverrides aliases/i,
  'one persisted preparation object with both aliases must fail closed',
);

const invalidCases = [
  ['duplicate', [validOverride(), validOverride('7000')]],
  ['other attribute id', [{...validOverride(), attribute_id: 1002322}]],
  ['empty value', [{...validOverride(), attribute_extra_value: ''}]],
  ['non-numeric value', [{...validOverride(), attribute_extra_value: '6818mA'}]],
  ['decimal value', [{...validOverride(), attribute_extra_value: '6818.5'}]],
  ['zero value', [{...validOverride(), attribute_extra_value: '0'}]],
  ['unreasonable value', [{...validOverride(), attribute_extra_value: '100001'}]],
  ['wrong unit', [{...validOverride(), attribute_unit: 'A'}]],
  ['wrong source', [{...validOverride(), source: 'request'}]],
  ['non-object row', [null]],
];

for (const [label, overrides] of invalidCases) {
  assert.throws(() => merge(overrides), /exact source|Input current|1002323/i, `${label} must fail closed`);
}

assert.throws(() => __testHooks.applyExactSourceLockedInputCurrentOverride(sourcePayload(), {
  attributeOverrides: validOverride(),
}), /must be an array/i, 'non-array override declaration must fail closed');

assert.throws(() => __testHooks.applyExactSourceLockedInputCurrentOverride(sourcePayload(), {
  attributeOverrides: [validOverride()],
  attribute_overrides: [validOverride()],
}), /both attributeOverrides aliases/i, 'dual override aliases must fail closed');

console.log(JSON.stringify({
  ok: true,
  checks: [
    'valid_6818_adds_one_unique_input_current',
    'valid_6818_template_finalizes_unique_input_current',
    'valid_6818_replaces_existing_input_current',
    'no_override_unchanged',
    'legal_targets_only_source_unchanged',
    'three_way_identical_semantics_allowed_once',
    'cross_source_different_values_blocked',
    'binding_task_difference_blocked',
    'metadata_binding_fallback_checked',
    'single_source_dual_alias_blocked',
    'duplicate_blocked',
    'other_attribute_id_blocked',
    'empty_non_numeric_out_of_range_blocked',
    'wrong_unit_blocked',
    'wrong_source_blocked',
    'malformed_and_dual_aliases_blocked',
  ],
}, null, 2));
