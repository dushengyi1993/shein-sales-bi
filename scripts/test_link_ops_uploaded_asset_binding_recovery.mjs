#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  LISTING_BIND_RECOVERY_AUDIT_TYPE,
  LISTING_IMAGE_UPLOAD_AUDIT_TYPE,
  RECOVER_UPLOADED_ASSET_BINDING_CONFIRM_TEXT,
  buildRecoveredTaskFromPlan,
  canonicalJson,
  canonicalRecoveredPublishAssetBindingFingerprint,
  createUploadedAssetBindingRecoveryPlan,
  createUploadedAssetBindingRecoveryProposal,
  extractAuthoritativeUploadTuplesFromAudit,
  extractTaskExactIdentity,
  extractTaskIdentity,
  sha256Hex,
  validateAuditUploadTuples,
  validateTaskFourWriteSlotsAreFalse,
  validateUploadedAssetBindingRecoveryReplay,
} from '../lib/link_ops_uploaded_asset_binding_recovery.mjs';

let assertionCount = 0;
function check(value, message) {
  assert.ok(value, message);
  assertionCount += 1;
}
function equal(actual, expected, message) {
  assert.equal(actual, expected, message);
  assertionCount += 1;
}
function deepEqual(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  assertionCount += 1;
}
function throwsCode(fn, expectedCode, message) {
  assert.throws(fn, error => {
    assert.equal(error?.code || error?.response?.code, expectedCode, error?.message);
    return true;
  }, message);
  assertionCount += 1;
}

const PREPARE_BATCH_ID = 'a'.repeat(64);
const RELEASE_ID = 'rel-20260831-v4';
const TASK_ID = 'task-copy-001';
const TARGET_STORE = 'HL';
const SOURCE_STORE = 'CX';
const SOURCE_SKC = 'sv25082902871830770';
const STANDARD_GOODS_SN = 'SM-961';

function createTask(overrides = {}) {
  return {
    id: TASK_ID,
    storeKey: TARGET_STORE,
    sourceStore: SOURCE_STORE,
    sourceSkc: SOURCE_SKC,
    standardGoodsSn: STANDARD_GOODS_SN,
    repositoryRevision: 10,
    releaseId: RELEASE_ID,
    intents: ['copy_product_draft'],
    writeStores: [TARGET_STORE],
    stores: [TARGET_STORE],
    submitted: false,
    actualWriteSubmitted: false,
    issuedExecuteToExecutor: false,
    sheinWriteAttempted: false,
    publishResult: null,
    assets: [],
    lifecycle: {status: 'ready_for_submit'},
    publishPreparation: {
      targetStore: TARGET_STORE,
      standardGoodsSn: STANDARD_GOODS_SN,
      supplyPrice: 172.22,
      inventory: 100,
      titles: {},
      attributeOverrides: [],
    },
    openapiPublishPayload: {
      product_type_id: 9851,
      skc_list: [{supplier_code: STANDARD_GOODS_SN, sku_list: [{}]}],
    },
    execution: {
      state: 'waiting_review',
      submitted: false,
      actualWriteSubmitted: false,
      issuedExecuteToExecutor: false,
      sheinWriteAttempted: false,
      publishResult: null,
      writeAudit: {
        submitted: false,
        actualWriteSubmitted: false,
        issuedExecuteToExecutor: false,
        sheinWriteAttempted: false,
      },
    },
    ...overrides,
  };
}

function createProducerAudits({store = TARGET_STORE} = {}) {
  const rows = [
    {name: 'main.jpg', imageType: 1},
    {name: 'detail-1.jpg', imageType: 2},
    {name: 'second.jpg', imageType: 1},
    {name: 'square.jpg', imageType: 5},
    {name: 'detail-2.jpg', imageType: 2},
    {name: 'detail-3.jpg', imageType: 2},
  ];
  return rows.map((row, index) => ({
    type: LISTING_IMAGE_UPLOAD_AUDIT_TYPE,
    storeKey: store,
    imageType: row.imageType,
    file: {
      name: row.name,
      sha256: sha256Hex(`content-${index}`),
    },
    result: {
      imageUrl: `https://img.ltwebstatic.com/item/${index + 1}.jpg`,
    },
  }));
}

function exactSix(audits = createProducerAudits()) {
  return [4, 0, 5, 2, 1, 3].map(index => ({
    name: audits[index].file.name,
    imageUrl: audits[index].result.imageUrl,
    sha256: audits[index].file.sha256,
  }));
}

function createPlan({task = createTask(), audits = createProducerAudits(), tuples = exactSix(audits)} = {}) {
  return createUploadedAssetBindingRecoveryPlan({
    task,
    tuples,
    auditLogs: audits,
    expectedRevision: task.repositoryRevision,
    expectedReleaseId: task.releaseId,
    expectedPrepareBatchId: PREPARE_BATCH_ID,
    confirmMarker: RECOVER_UPLOADED_ASSET_BINDING_CONFIRM_TEXT,
    actor: 'operator-1',
  });
}

console.log('--- exports and pure-library boundary ---');
equal(createUploadedAssetBindingRecoveryProposal, createUploadedAssetBindingRecoveryPlan, 'proposal alias');
equal(extractTaskIdentity, extractTaskExactIdentity, 'identity alias');
equal(LISTING_BIND_RECOVERY_AUDIT_TYPE, 'link-ops-recover-uploaded-asset-binding', 'audit type');
equal(sha256Hex('test'), '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', 'sha256 helper');
equal(canonicalJson({b: 2, a: 1}), '{"a":1,"b":2}', 'canonical JSON');
{
  const source = fs.readFileSync(new URL('../lib/link_ops_uploaded_asset_binding_recovery.mjs', import.meta.url), 'utf8');
  check(!/from\s+['"](?:node:)?(?:fs|fs\/promises|http|https|net|tls|dns|dgram|child_process|worker_threads)['"]/.test(source), 'pure library has no IO imports');
  check(!/\b(?:fetch|writeFile|appendFile|spawn|exec|fork)\s*\(/.test(source), 'pure library has no IO calls');
}

console.log('--- task identity and prewrite guards ---');
deepEqual(extractTaskExactIdentity(createTask()), {
  taskId: TASK_ID,
  targetStore: TARGET_STORE,
  standardGoodsSn: STANDARD_GOODS_SN,
  sourceStore: SOURCE_STORE,
  sourceSkc: SOURCE_SKC,
  repositoryRevision: 10,
  releaseId: RELEASE_ID,
}, 'exact identity');
throwsCode(() => extractTaskExactIdentity(createTask({targets: {sourceStore: 'FY'}})), 'RECOVER_TASK_IDENTITY_CONFLICT', 'identity conflict');
throwsCode(() => validateTaskFourWriteSlotsAreFalse(createTask({submitted: true})), 'RECOVER_TASK_WRITE_SLOT_NOT_FALSE', 'submitted guard');
throwsCode(() => validateTaskFourWriteSlotsAreFalse(createTask({publishResult: {ok: true}})), 'RECOVER_TASK_PUBLISH_RESULT_NOT_NULL', 'publish result guard');
throwsCode(() => validateTaskFourWriteSlotsAreFalse(createTask({assets: [{}]})), 'RECOVER_TASK_ASSETS_NOT_EMPTY', 'asset guard');

console.log('--- exact contextless producer audit matching and role derivation ---');
{
  const audits = createProducerAudits();
  const validation = validateAuditUploadTuples(exactSix(audits), audits, extractTaskExactIdentity(createTask()), {expectedPrepareBatchId: PREPARE_BATCH_ID});
  equal(validation.normalizedBindings.length, 6, 'six bindings');
  deepEqual(validation.normalizedBindings.map(row => row.name), audits.map(row => row.file.name), 'caller tuple order cannot alter producer audit order');
  deepEqual(validation.normalizedBindings.map(row => row.role), ['mainCover', 'detail', 'carouselSecondCover', 'squareImage', 'detail', 'detail'], 'roles derive from producer order plus type');
  deepEqual(validation.normalizedBindings.map(row => row.imageType), [1, 2, 1, 5, 2, 2], 'producer image types retained');
  equal(validation.matchedAuditEntries.length, 6, 'six authoritative matches');

  const extracted = extractAuthoritativeUploadTuplesFromAudit(audits, extractTaskExactIdentity(createTask()), {
    expectedPrepareBatchId: PREPARE_BATCH_ID,
    tuples: exactSix(audits),
  });
  deepEqual(extracted.tuples.map(row => row.role), validation.normalizedBindings.map(row => row.role), 'extract helper uses exact tuples');
}
{
  const audits = createProducerAudits();
  const historical = createProducerAudits().map((entry, index) => ({
    ...structuredClone(entry),
    at: `2026-08-29T10:00:0${index}.000Z`,
    file: {...entry.file, name: `old-${entry.file.name}`, sha256: sha256Hex(`old-${index}`)},
    result: {...entry.result, imageUrl: `https://img.ltwebstatic.com/old/${index + 1}.jpg`, traceId: `old-trace-${index + 1}`},
  }));
  const validation = validateAuditUploadTuples(exactSix(audits), [...historical, ...audits], extractTaskExactIdentity(createTask()), {expectedPrepareBatchId: PREPARE_BATCH_ID});
  check(validation.normalizedBindings.every(row => !row.name.startsWith('old-')), 'unselected historical rows excluded by tuple set');
}
{
  const audits = createProducerAudits();
  throwsCode(
    () => validateAuditUploadTuples(exactSix(audits), [...audits, structuredClone(audits[0])], extractTaskExactIdentity(createTask()), {expectedPrepareBatchId: PREPARE_BATCH_ID}),
    'RECOVER_UPLOADED_BINDING_AUDIT_AMBIGUOUS',
    'duplicate exact audit match rejects',
  );
  const wrongType = structuredClone(audits);
  wrongType[3].imageType = 2;
  throwsCode(
    () => validateAuditUploadTuples(exactSix(wrongType), wrongType, extractTaskExactIdentity(createTask()), {expectedPrepareBatchId: PREPARE_BATCH_ID}),
    'RECOVER_UPLOADED_BINDING_TYPE_COMPOSITION_INVALID',
    'non-unique square type rejects',
  );
  const wrongOrder = structuredClone(audits);
  [wrongOrder[0], wrongOrder[2]] = [wrongOrder[2], wrongOrder[0]];
  const reordered = validateAuditUploadTuples(exactSix(wrongOrder), wrongOrder, extractTaskExactIdentity(createTask()), {expectedPrepareBatchId: PREPARE_BATCH_ID});
  equal(reordered.normalizedBindings[0].name, 'second.jpg', 'first type1 becomes mainCover after authoritative audit reordering');
  equal(reordered.normalizedBindings[2].name, 'main.jpg', 'second type1 becomes carouselSecondCover after authoritative audit reordering');
}
{
  const audits = createProducerAudits();
  const legacyFabricated = structuredClone(audits[0]);
  legacyFabricated.role = 'mainCover';
  legacyFabricated.prepareBatchId = PREPARE_BATCH_ID;
  throwsCode(
    () => validateAuditUploadTuples(exactSix(audits), [legacyFabricated, ...audits.slice(1)], extractTaskExactIdentity(createTask()), {expectedPrepareBatchId: PREPARE_BATCH_ID}),
    'RECOVER_UPLOADED_BINDING_TUPLE_NOT_IN_AUDIT',
    'role/batch enriched row is not accepted as true producer evidence',
  );
}

console.log('--- plan, payload binding, and idempotent replay drift checks ---');
{
  const task = createTask();
  const audits = createProducerAudits();
  const tuples = exactSix(audits);
  const plan1 = createPlan({task, audits, tuples});
  const plan2 = createPlan({task, audits, tuples});
  equal(plan1.expectedRevision, 10, 'plan expected revision');
  equal(plan1.nextRevision, 11, 'plan next revision');
  equal(plan1.recoveredBinding.imageCount, 6, 'plan six images');
  equal(plan1.tupleHash, plan2.tupleHash, 'deterministic tuple hash');
  equal(plan1.requestHash, plan2.requestHash, 'deterministic request hash');
  equal(plan1.bindingFingerprint, plan2.bindingFingerprint, 'deterministic binding fingerprint');
  throwsCode(() => createUploadedAssetBindingRecoveryPlan({
    task,
    tuples,
    auditLogs: audits,
    expectedRevision: 9,
    expectedReleaseId: RELEASE_ID,
    expectedPrepareBatchId: PREPARE_BATCH_ID,
    confirmMarker: RECOVER_UPLOADED_ASSET_BINDING_CONFIRM_TEXT,
  }), 'RECOVER_CAS_REVISION_CONFLICT', 'CAS conflict');
  throwsCode(() => createUploadedAssetBindingRecoveryPlan({
    task,
    tuples,
    auditLogs: audits,
    expectedRevision: 10,
    expectedReleaseId: RELEASE_ID,
    expectedPrepareBatchId: PREPARE_BATCH_ID,
    confirmMarker: 'wrong',
  }), 'RECOVER_UPLOADED_BINDING_CONFIRM_REQUIRED', 'confirm guard');

  const recoveredTask = buildRecoveredTaskFromPlan(task, plan1, {actorUser: 'test-user'});
  recoveredTask.repositoryRevision = 11;
  equal(recoveredTask.execution.state, 'needs_repreflight', 'preflight invalidated');
  equal(recoveredTask.publishAssetBinding.evidence.recoveryIdentity.taskId, TASK_ID, 'committed task identity');
  equal(recoveredTask.publishAssetBinding.evidence.recoveryIdentity.targetStore, TARGET_STORE, 'committed target identity');
  check(/^[a-f0-9]{64}$/.test(recoveredTask.publishAssetBinding.evidence.payloadHash), 'committed payload hash');
  equal(recoveredTask.publishAssetBinding.bindingFingerprint, canonicalRecoveredPublishAssetBindingFingerprint(recoveredTask, {
    targetStore: TARGET_STORE,
    images: recoveredTask.publishAssetBinding.images,
    publishPreparation: recoveredTask.publishAssetBinding.publishPreparation,
  }), 'fingerprint recomputation');

  const replay = validateUploadedAssetBindingRecoveryReplay({task: recoveredTask, tuples, auditLogs: audits, expectedPrepareBatchId: PREPARE_BATCH_ID});
  equal(replay.bindingFingerprint, recoveredTask.publishAssetBinding.bindingFingerprint, 'replay fingerprint');
  equal(replay.tupleHash, recoveredTask.publishAssetBinding.evidence.tupleHash, 'replay tuple hash');

  const payloadDrift = structuredClone(recoveredTask);
  payloadDrift.openapiPublishPayload.skc_list[0].image_info.image_info_list[0].image_url = 'https://img.ltwebstatic.com/item/drift.jpg';
  throwsCode(() => validateUploadedAssetBindingRecoveryReplay({task: payloadDrift, tuples, auditLogs: audits, expectedPrepareBatchId: PREPARE_BATCH_ID}), 'RECOVER_IDEMPOTENT_REPLAY_PAYLOAD_DRIFT', 'payload drift');

  const identityDrifts = [
    ['taskId', taskValue => { taskValue.id = 'task-copy-drift'; }],
    ['targetStore', taskValue => {
      taskValue.storeKey = 'FY';
      taskValue.writeStores = ['FY'];
      taskValue.stores = ['FY'];
      taskValue.publishPreparation.targetStore = 'FY';
      taskValue.publishAssetBinding.targetStore = 'FY';
      taskValue.publishAssetBinding.publishPreparation.targetStore = 'FY';
    }],
    ['sourceStore', taskValue => { taskValue.sourceStore = 'FY'; }],
    ['sourceSkc', taskValue => { taskValue.sourceSkc = 'sv25082902871839999'; }],
    ['standardGoodsSn', taskValue => {
      taskValue.standardGoodsSn = 'SM-961-DRIFT';
      taskValue.publishPreparation.standardGoodsSn = 'SM-961-DRIFT';
      taskValue.publishAssetBinding.publishPreparation.standardGoodsSn = 'SM-961-DRIFT';
    }],
  ];
  for (const [label, mutate] of identityDrifts) {
    const identityDrift = structuredClone(recoveredTask);
    mutate(identityDrift);
    throwsCode(() => validateUploadedAssetBindingRecoveryReplay({task: identityDrift, tuples, auditLogs: audits, expectedPrepareBatchId: PREPARE_BATCH_ID}), 'RECOVER_IDEMPOTENT_REPLAY_IDENTITY_DRIFT', `${label} drift`);
  }

  const tupleDrift = structuredClone(recoveredTask);
  tupleDrift.publishAssetBinding.images[0].sha256 = 'f'.repeat(64);
  throwsCode(() => validateUploadedAssetBindingRecoveryReplay({task: tupleDrift, tuples, auditLogs: audits, expectedPrepareBatchId: PREPARE_BATCH_ID}), 'RECOVER_IDEMPOTENT_REPLAY_TUPLE_DRIFT', 'tuple drift');

  const fingerprintDrift = structuredClone(recoveredTask);
  fingerprintDrift.publishAssetBinding.bindingFingerprint = 'f'.repeat(64);
  throwsCode(() => validateUploadedAssetBindingRecoveryReplay({task: fingerprintDrift, tuples, auditLogs: audits, expectedPrepareBatchId: PREPARE_BATCH_ID}), 'RECOVER_IDEMPOTENT_REPLAY_FINGERPRINT_DRIFT', 'fingerprint drift');
}

console.log(`All ${assertionCount} uploaded-asset recovery assertions passed cleanly.`);
