#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {__testHooks as portalHooks} from './serve_bi_portal.mjs';
import {
  PRODUCT_ATTRIBUTE_BINDING_AUTHORITY,
  PRODUCT_ATTRIBUTE_BINDING_KIND,
  PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT,
  PRODUCT_ATTRIBUTE_BINDING_SCHEMA_VERSION,
  PRODUCT_ATTRIBUTE_PAYLOAD_HASH_ALGORITHM,
  productAttributeBindingRequestKeyV2,
} from '../lib/link_ops_product_attribute_binding.mjs';
import {sha256StableJson} from '../lib/link_ops_product_descriptions.mjs';

process.env.SHEIN_LINK_OPS_EXECUTOR_SELF_TEST = '1';
const {__testHooks: executorHooks} = await import('./link_ops_hl_openapi_executor.mjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_SKC = 'sv251109008981839372';
const HAZARD_ATTRIBUTE_ID = 1000462;
const HAZARD_VALUE_ID = 1006206;
const CLASSIFICATION_ATTRIBUTE_ID = 1002328;
const CLASSIFICATION_VALUE_ID = 316914660;

function exactTask(targets = {sourceStores: ['FY'], sourceSkc: SOURCE_SKC}) {
  return {
    id: 'S1810-EXACT-SOURCE-GATE-TEST',
    intents: ['copy_product_draft'],
    targets,
    openapiPublishPayload: {
      product_attribute_list: [
        {attribute_id: CLASSIFICATION_ATTRIBUTE_ID, attribute_value_id: CLASSIFICATION_VALUE_ID},
        {attribute_id: HAZARD_ATTRIBUTE_ID, attribute_value_id: HAZARD_VALUE_ID},
      ],
    },
  };
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function validBoundTask() {
  const payload = {
    product_attribute_list: [
      {attribute_id: CLASSIFICATION_ATTRIBUTE_ID, attribute_value_id: CLASSIFICATION_VALUE_ID},
    ],
  };
  const aliasRegistryFingerprint = sha256(await fs.readFile(path.join(ROOT, 'config', 'product_aliases.json')));
  const catalogFingerprint = sha256(await fs.readFile(path.join(ROOT, 'config', 'product_catalog.json')));
  const identityEvidenceSha256 = '1'.repeat(64);
  const verifiedAt = '2026-08-21T00:00:00.000Z';
  const donor = {
    storeKey: 'FY',
    skc: SOURCE_SKC,
    spu: 'spu-test-1002328',
    rawCode: 'S1810',
  };
  const baseTaskRevision = 1;
  const taskId = 'VALID-PRODUCT-ATTRIBUTE-BINDING-TEST';
  const targetStore = 'HL';
  const evidenceSha256 = sha256StableJson({
    donorStore: donor.storeKey,
    donorSkc: donor.skc,
    donorSpu: donor.spu,
    rawDonorCode: donor.rawCode,
    rawTaskCode: 'S1810',
    canonicalCode: 'S1810',
    taskModelValue: 'S1810',
    donorModelValue: 'S1810',
    attributeId: CLASSIFICATION_ATTRIBUTE_ID,
    attributeValueId: CLASSIFICATION_VALUE_ID,
    verifiedAt,
    identityEvidenceSha256,
    aliasRegistryFingerprint,
    catalogFingerprint,
  });
  const payloadHash = sha256StableJson(payload);
  const binding = {
    schemaVersion: PRODUCT_ATTRIBUTE_BINDING_SCHEMA_VERSION,
    bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT,
    kind: PRODUCT_ATTRIBUTE_BINDING_KIND,
    authority: PRODUCT_ATTRIBUTE_BINDING_AUTHORITY,
    baseTaskRevision,
    attributeId: CLASSIFICATION_ATTRIBUTE_ID,
    attributeValueId: CLASSIFICATION_VALUE_ID,
    targetStore,
    donor,
    taskRawCode: 'S1810',
    taskModelValue: 'S1810',
    donorModelValue: 'S1810',
    canonicalCode: 'S1810',
    verifiedAt,
    identityOk: true,
    identityEvidenceSha256,
    evidenceSha256,
    aliasRegistryFingerprint,
    catalogFingerprint,
    aliasRegistrySource: 'config/product_aliases.json',
    catalogSource: 'config/product_catalog.json',
    payloadHashAlgorithm: PRODUCT_ATTRIBUTE_PAYLOAD_HASH_ALGORITHM,
    oldPayloadHash: payloadHash,
    newPayloadHash: payloadHash,
    imageBindingFingerprint: '',
    descriptionContentSha256: '',
    descriptionHashes: {'ar': '', 'en': '', 'zh-cn': ''},
  };
  binding.bindingRequestKey = productAttributeBindingRequestKeyV2({
    schemaVersion: binding.schemaVersion,
    bindingMode: binding.bindingMode,
    taskId,
    targetStore,
    baseTaskRevision,
    attributeId: binding.attributeId,
    attributeValueId: binding.attributeValueId,
    donorStore: donor.storeKey,
    donorSkc: donor.skc,
    donorSpu: donor.spu,
    evidenceSha256,
    oldPayloadHash: payloadHash,
    newPayloadHash: payloadHash,
  });
  return {id: taskId, openapiPublishPayload: payload, productAttributeBinding: binding};
}

function sourcePayload({emptyClassification = false} = {}) {
  const payload = {
    product_type_id: 9851,
    product_attribute_list: [
      {attribute_id: HAZARD_ATTRIBUTE_ID, attribute_value_id: HAZARD_VALUE_ID},
    ],
  };
  if (emptyClassification) payload.product_attribute_list.push({attribute_id: CLASSIFICATION_ATTRIBUTE_ID});
  return payload;
}

function templateResponse(attributeInfos) {
  return {
    ok: true,
    status: 200,
    data: {
      code: '0',
      msg: 'OK',
      info: {data: [{product_type_id: 9851, attribute_infos: attributeInfos}]},
    },
  };
}

const classificationTemplate = {
  attribute_id: CLASSIFICATION_ATTRIBUTE_ID,
  attribute_name: 'Hazardous materials classification',
  attribute_mode: 3,
  attribute_type: 4,
  attribute_status: 3,
  attribute_value_info_list: [
    {attribute_value_id: CLASSIFICATION_VALUE_ID, attribute_value: 'This product is not classified as dangerous goods'},
  ],
};

const exact = exactTask();
assert.deepEqual(portalHooks.portalExactCopySourceLock(exact), {sourceStore: 'FY', sourceSkc: SOURCE_SKC});
assert.deepEqual(executorHooks.exactCopySourceLock(exact), {sourceStore: 'FY', sourceSkc: SOURCE_SKC});
assert.equal(portalHooks.productAttributeExecutionGate(exact).ok, true, 'strict exact source must pass Portal pre-gate');

const compatibilityOnly = exactTask({readStores: ['FY'], source_skc: SOURCE_SKC});
assert.equal(portalHooks.portalExactCopySourceLock(compatibilityOnly), null);
assert.equal(executorHooks.exactCopySourceLock(compatibilityOnly), null);
assert.equal(portalHooks.productAttributeExecutionGate(compatibilityOnly).ok, false, 'compatibility-only source fields must remain blocked');

const nonExact = exactTask({sourceStores: [], sourceSkc: ''});
assert.equal(portalHooks.productAttributeExecutionGate(nonExact).ok, false, 'non-exact unbound whitelist row must remain blocked');

const boundGate = portalHooks.productAttributeExecutionGate(await validBoundTask());
assert.equal(boundGate.ok, true, `valid binding path changed: ${JSON.stringify(boundGate.blockers)}`);
assert.equal(boundGate.exactSourceUnboundRowsAllowed, undefined, 'valid binding must not use the unbound exact-source exception');

const sourceContext = {copyProductDraft: true, exactSourceLock: true, sourceStore: 'FY', sourceSkc: SOURCE_SKC};
const successful = await executorHooks.applyAttributeTemplateRules({
  async request(pathname) {
    assert.equal(pathname, '/open-api/goods/query-attribute-template');
    return templateResponse([classificationTemplate]);
  },
}, sourcePayload({emptyClassification: true}), sourceContext);
const classificationRows = successful.payload.product_attribute_list
  .filter(row => Number(row.attribute_id) === CLASSIFICATION_ATTRIBUTE_ID);
assert.equal(successful.blockers.length, 0, JSON.stringify(successful.blockers));
assert.equal(classificationRows.length, 1);
assert.equal(Number(classificationRows[0].attribute_value_id), CLASSIFICATION_VALUE_ID);
assert.equal(Boolean(successful.payload) && successful.blockers.length === 0, true, 'successful derivation must be ready');

async function assertBlockedWithoutPublish(label, client, payload = sourcePayload()) {
  let publishOrEditCalls = 0;
  const guardedClient = {
    async request(pathname, options) {
      if (pathname === '/open-api/goods/product/publishOrEdit') {
        publishOrEditCalls += 1;
        return {ok: true, status: 200, data: {code: '0', info: {success: true}}};
      }
      return client.request(pathname, options);
    },
  };
  const result = await executorHooks.applyAttributeTemplateRules(guardedClient, payload, sourceContext);
  const readyForSubmit = result.blockers.length === 0 && Boolean(result.payload);
  if (executorHooks.shouldIssuePublishOrEdit('execute', readyForSubmit)) {
    await guardedClient.request('/open-api/goods/product/publishOrEdit', {method: 'POST', body: result.payload});
  }
  assert.equal(result.blockers.some(message => String(message).includes(String(CLASSIFICATION_ATTRIBUTE_ID))), true, `${label} must block 1002328`);
  assert.equal(readyForSubmit, false, `${label} must not be ready`);
  assert.equal(publishOrEditCalls, 0, `${label} must not issue publishOrEdit`);
}

await assertBlockedWithoutPublish('template throw', {
  async request() {
    throw new Error('template unavailable');
  },
});

await assertBlockedWithoutPublish('template nonzero', {
  async request() {
    return {ok: true, status: 200, data: {code: '50001', msg: 'template failed'}};
  },
});

await assertBlockedWithoutPublish('template missing 1002328', {
  async request() {
    return templateResponse([]);
  },
});

await assertBlockedWithoutPublish('empty 1002328 shell plus template throw', {
  async request() {
    throw new Error('template unavailable');
  },
}, sourcePayload({emptyClassification: true}));

await assertBlockedWithoutPublish('empty 1002328 shell plus template nonzero', {
  async request() {
    return {ok: true, status: 200, data: {code: '50001', msg: 'template failed'}};
  },
}, sourcePayload({emptyClassification: true}));

await assertBlockedWithoutPublish('empty 1002328 shell plus missing template', {
  async request() {
    return templateResponse([]);
  },
}, sourcePayload({emptyClassification: true}));

const ordinaryFailure = await executorHooks.applyAttributeTemplateRules({
  async request() {
    throw new Error('template unavailable');
  },
}, {product_type_id: 9851, product_attribute_list: []}, sourceContext);
assert.equal(ordinaryFailure.blockers.length, 0, 'ordinary products must retain warning-only template failures');
assert.equal(ordinaryFailure.warnings.length, 1);

console.log(JSON.stringify({
  ok: true,
  checks: [
    'portal_strict_exact_source_allowed',
    'portal_compatibility_only_blocked',
    'portal_non_exact_unbound_blocked',
    'portal_valid_binding_unchanged',
    'hazard_template_success_unique_ready',
    'hazard_template_throw_blocked_no_publish',
    'hazard_template_nonzero_blocked_no_publish',
    'hazard_template_missing_blocked_no_publish',
    'empty_classification_shell_template_throw_blocked_no_publish',
    'empty_classification_shell_template_nonzero_blocked_no_publish',
    'empty_classification_shell_missing_template_blocked_no_publish',
    'ordinary_template_failure_warning_only',
  ],
}, null, 2));
