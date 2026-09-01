#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  buildEmptyDescriptionAuthorization,
  EMPTY_DESCRIPTION_CONFIRM_TEXT,
  evaluateDescriptionReadback,
  sha256StableJson,
  stripPublishPayloadDescriptions,
  validateCopyProductDescriptionPolicy,
  validateEmptyDescriptionAuthorization,
} from '../lib/link_ops_product_descriptions.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];
function check(label, fn) {
  fn();
  checks.push(label);
}

const payload = {
  category_id: 123,
  source_system: 'OpenAPI',
  multi_language_name_list: [{language: 'en', name: 'Simple sewing machine'}],
  product_attribute_list: [{attribute_id: 1, attribute_value_id: 2}],
  site_list: [{main_site: 'shein', sub_site_list: ['shein-sa']}],
  skc_list: [{
    supplier_code: 'SM-520A',
    image_info: {image_info_list: [{image_type: 1, image_sort: 1, image_url: 'https://img.shein.com/a.jpg'}]},
    sku_list: [{supplier_sku: 'SM-520A', cost_info: {currency: 'SAR', cost_price: '300'}, stock_info_list: [{warehouse_id: 'WH', inventory_num: 100}]}],
  }],
};

function taskFixture() {
  return {
    id: 'lot_20260823165335_14157218',
    repositoryRevision: 2,
    intents: ['copy_product_draft'],
    targets: {
      stores: ['CX'],
      writeStores: ['CX'],
      sourceStores: ['NM'],
      sourceSkc: 'sv260607214383789182889',
      standardGoodsSn: 'SM-520A',
      publishPreparation: {targetStore: 'CX', standardGoodsSn: 'SM-520A', supplyPrice: 300, inventory: 100},
    },
    publishPreparation: {targetStore: 'CX', standardGoodsSn: 'SM-520A', supplyPrice: 300, inventory: 100},
    publishAssetBinding: {
      schemaVersion: 1,
      sourceApproved: true,
      authority: 'human_reviewed_source',
      targetStore: 'CX',
      bindingFingerprint: 'b'.repeat(64),
      publishPreparation: {targetStore: 'CX', standardGoodsSn: 'SM-520A', supplyPrice: 300, inventory: 100},
    },
    openapiPublishPayload: structuredClone(payload),
  };
}

const task = taskFixture();
const marker = buildEmptyDescriptionAuthorization({
  task,
  payload: task.openapiPublishPayload,
  baseTaskRevision: task.repositoryRevision,
  authorizedAt: '2026-08-24T01:30:00.000+08:00',
  authorizedByUser: 'owner@example.test',
});
const authorizedTask = {...task, emptyDescriptionAuthorization: marker};

check('confirmation token is explicit and stable', () => {
  assert.equal(EMPTY_DESCRIPTION_CONFIRM_TEXT, 'USER_EXPLICIT_EMPTY_DESCRIPTION');
});
check('default missing descriptions remain blocked', () => {
  assert.equal(validateCopyProductDescriptionPolicy(task, task.openapiPublishPayload).ok, false);
});
check('exact marker permits an omitted description field', () => {
  const gate = validateCopyProductDescriptionPolicy(authorizedTask, authorizedTask.openapiPublishPayload);
  assert.equal(gate.ok, true);
  assert.equal(gate.mode, 'explicit_empty');
});
check('marker binds the exact payload and request key', () => {
  assert.equal(marker.payloadHash, sha256StableJson(payload));
  assert.match(marker.authorizationRequestKey, /^[a-f0-9]{64}$/);
  assert.equal(validateEmptyDescriptionAuthorization(authorizedTask, payload).ok, true);
});
check('description fields are removed rather than fabricated as empty rows', () => {
  const stripped = stripPublishPayloadDescriptions({...payload, multi_language_desc_list: [], multiLanguageDescList: []});
  assert.equal(Object.hasOwn(stripped, 'multi_language_desc_list'), false);
  assert.equal(Object.hasOwn(stripped, 'multiLanguageDescList'), false);
});
check('marker cannot bypass a partial description payload', () => {
  const partial = {...payload, multi_language_desc_list: [{language: 'en', name: 'one'}]};
  assert.equal(validateCopyProductDescriptionPolicy({...authorizedTask, openapiPublishPayload: partial}, partial).ok, false);
});
check('marker cannot coexist with a reviewed binding', () => {
  const drifted = {...authorizedTask, descriptionMaterialBinding: {kind: 'copy_product_draft'}};
  assert.equal(validateCopyProductDescriptionPolicy(drifted, payload).ok, false);
});
check('marker cannot authorize a mixed-intent task', () => {
  const mixed = {...authorizedTask, intents: ['copy_product_draft', 'update_images']};
  assert.equal(validateEmptyDescriptionAuthorization(mixed, payload).ok, false);
  assert.throws(() => buildEmptyDescriptionAuthorization({
    task: {...task, intents: ['copy_product_draft', 'update_images']},
    payload,
    baseTaskRevision: task.repositoryRevision,
    authorizedAt: '2026-08-24T01:30:00.000+08:00',
    authorizedByUser: 'owner@example.test',
  }), error => error?.code === 'EMPTY_DESCRIPTION_INTENT_INVALID');
});

for (const [label, mutateTask] of [
  ['task id drift', value => ({...value, id: 'lot_other'})],
  ['target store drift', value => ({...value, targets: {...value.targets, writeStores: ['DL'], stores: ['DL']}})],
  ['source store drift', value => ({...value, targets: {...value.targets, sourceStores: ['QY']}})],
  ['source skc drift', value => ({...value, targets: {...value.targets, sourceSkc: 'sv260607205585078068247'}})],
  ['standard goods drift', value => ({
    ...value,
    targets: {...value.targets, standardGoodsSn: 'SM-825', publishPreparation: {...value.targets.publishPreparation, standardGoodsSn: 'SM-825'}},
    publishPreparation: {...value.publishPreparation, standardGoodsSn: 'SM-825'},
    publishAssetBinding: {...value.publishAssetBinding, publishPreparation: {...value.publishAssetBinding.publishPreparation, standardGoodsSn: 'SM-825'}},
  })],
  ['image fingerprint drift', value => ({...value, publishAssetBinding: {...value.publishAssetBinding, bindingFingerprint: 'c'.repeat(64)}})],
  ['payload drift', value => ({...value, openapiPublishPayload: {...value.openapiPublishPayload, category_id: 999}})],
]) {
  check(label, () => assert.equal(validateEmptyDescriptionAuthorization(mutateTask(authorizedTask), mutateTask(authorizedTask).openapiPublishPayload).ok, false));
}

check('extra marker metadata is rejected', () => {
  const drifted = {...authorizedTask, emptyDescriptionAuthorization: {...marker, extra: true}};
  assert.equal(validateEmptyDescriptionAuthorization(drifted, payload).ok, false);
});
check('empty live readback closes and non-empty live text fails', () => {
  assert.equal(evaluateDescriptionReadback(null, {productMultiDescList: []}).ok, true);
  assert.equal(evaluateDescriptionReadback(null, {productMultiDescList: [{language: 'en', productDesc: 'unexpected'}]}).ok, false);
});
check('empty live readback fails closed when description evidence is absent or malformed', () => {
  for (const spuInfo of [
    {},
    {productMultiDescList: null},
    {productMultiDescList: {}},
    {productMultiDescList: [null]},
    {productMultiDescList: [{productDesc: 'unexpected'}]},
    {productMultiDescList: [{language: 'en'}]},
    {productMultiDescList: [{language: 'en', productDesc: null}]},
  ]) {
    const readback = evaluateDescriptionReadback(null, spuInfo);
    assert.equal(readback.ok, false);
    assert.equal(readback.status, 'description_readback_unverifiable');
  }
});

process.env.SHEIN_LINK_OPS_EXECUTOR_SELF_TEST = '1';
const {__testHooks} = await import('./link_ops_hl_openapi_executor.mjs');
check('legacy execution scope is byte-stable when no marker exists', () => {
  const base = __testHooks.buildProductExecutionHashScope({payload, targetStore: 'CX', sourceStore: 'NM', sourceSkc: task.targets.sourceSkc, standardGoodsSn: 'SM-520A'});
  const explicitNull = __testHooks.buildProductExecutionHashScope({payload, targetStore: 'CX', sourceStore: 'NM', sourceSkc: task.targets.sourceSkc, standardGoodsSn: 'SM-520A', emptyDescriptionAuthorization: null});
  assert.equal(sha256StableJson(base), sha256StableJson(explicitNull));
  assert.equal(Object.hasOwn(base, 'emptyDescriptionAuthorization'), false);
});
check('authorized execution scope locks the marker', () => {
  const base = __testHooks.buildProductExecutionHashScope({payload, targetStore: 'CX', sourceStore: 'NM', sourceSkc: task.targets.sourceSkc, standardGoodsSn: 'SM-520A'});
  const locked = __testHooks.buildProductExecutionHashScope({payload, targetStore: 'CX', sourceStore: 'NM', sourceSkc: task.targets.sourceSkc, standardGoodsSn: 'SM-520A', emptyDescriptionAuthorization: marker});
  assert.notEqual(sha256StableJson(base), sha256StableJson(locked));
  assert.deepEqual(locked.emptyDescriptionAuthorization, marker);
});
check('exact-source hydration cannot reintroduce descriptions', () => {
  const hydrated = {
    ...payload,
    multi_language_desc_list: [
      {language: 'en', product_desc: 'source text that must not be copied'},
      {language: 'ar', product_desc: 'نص مصدر يجب حذفه'},
    ],
  };
  const projected = __testHooks.applyExplicitEmptyDescriptionProjection(
    hydrated,
    authorizedTask,
    authorizedTask.openapiPublishPayload,
  );
  assert.equal(Object.hasOwn(projected.payload, 'multi_language_desc_list'), false);
  assert.deepEqual(projected.applied, ['destination.emptyDescriptionAuthorization.omit_descriptions']);
});
check('empty-description terminal readback requests every supported language', () => {
  assert.deepEqual(__testHooks.descriptionReadbackLanguageList(authorizedTask), ['en', 'ar', 'zh-cn']);
  assert.deepEqual(__testHooks.descriptionReadbackLanguageList(task), ['en', 'ar']);
});
const strongReadbackCalls = [];
const strongReadbackWithoutDescriptionEvidence = await __testHooks.readbackPublishedProduct({
  async request(endpoint, options) {
    strongReadbackCalls.push({endpoint, body: structuredClone(options?.body || {})});
    return {
      ok: true,
      status: 200,
      data: {
        code: '0',
        info: {
          spuName: 'v-empty-description-readback',
          skcInfoList: [{
            skcName: 'sv-empty-description-readback',
            supplierCode: 'SM-520A',
            skuInfoList: [{skuCode: 'sku-empty-description-readback', supplierSku: 'SM-520A'}],
          }],
          // Deliberately omit productMultiDescList: identity is strong, but
          // description emptiness has not been proven.
        },
      },
    };
  },
}, {
  publishSpuNames: ['v-empty-description-readback'],
  publishSkcNames: ['sv-empty-description-readback'],
  publishSkuCodes: ['sku-empty-description-readback'],
  targetSupplierCodes: ['SM-520A'],
  targetSupplierSkus: ['SM-520A'],
}, {enabled: true, task: authorizedTask});
check('strong product identity cannot close when empty-description evidence is absent', () => {
  assert.equal(strongReadbackWithoutDescriptionEvidence.ok, false);
  assert.equal(strongReadbackWithoutDescriptionEvidence.status, 'description_readback_unverifiable');
  assert.deepEqual(strongReadbackCalls[0]?.body?.languageList, ['en', 'ar', 'zh-cn']);
});

const [cliSource, portalSource, executorSource] = await Promise.all([
  fs.readFile(path.join(ROOT, 'scripts', 'bi_ops_cli.mjs'), 'utf8'),
  fs.readFile(path.join(ROOT, 'scripts', 'serve_bi_portal.mjs'), 'utf8'),
  fs.readFile(path.join(ROOT, 'scripts', 'link_ops_hl_openapi_executor.mjs'), 'utf8'),
]);
check('managed CLI exposes paired explicit flags', () => {
  assert.match(cliSource, /--allow-empty-description/);
  assert.match(cliSource, /--empty-description-confirm/);
  assert.match(cliSource, /EMPTY_DESCRIPTION_CONFIRM_TEXT/);
});
check('server constructs and readbacks the marker on the existing CAS path', () => {
  assert.match(portalSource, /buildEmptyDescriptionAuthorization/);
  assert.match(portalSource, /verifyPersistedPublishAssetBindingReadback/);
  assert.match(portalSource, /delete taskForCapture\.emptyDescriptionAuthorization/);
  assert.match(portalSource, /delete nextTask\.emptyDescriptionAuthorization/);
});
check('executor uses one combined description policy and official readback', () => {
  assert.match(executorSource, /validateCopyProductDescriptionPolicy/);
  assert.match(executorSource, /evaluateDescriptionReadback\(task\?\.descriptionMaterialBinding \|\| null, info\)/);
});

console.log(JSON.stringify({ok: true, checks: checks.length, labels: checks}, null, 2));
