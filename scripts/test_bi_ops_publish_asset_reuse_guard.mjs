#!/usr/bin/env node
import {__testHooks} from './serve_bi_portal.mjs';

const {
  canonicalPublishAssetBindingFingerprint,
  sparseMergePublishPreparation,
  validateReusedApprovedTaskBinding,
} = __testHooks;

const checks = [];
function check(label, actual, expected) {
  const pass = typeof expected === 'function' ? expected(actual) : Object.is(actual, expected);
  checks.push({label, actual, expected: typeof expected === 'function' ? 'predicate' : expected, pass});
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function expectRejected(label, task, expectedCode) {
  try {
    validateReusedApprovedTaskBinding(task, {targetStore: 'JSH'});
    check(label, 'accepted', expectedCode);
  } catch (error) {
    check(label, error?.code || '', expectedCode);
  }
}

const images = [
  {name: 'main.png', relativePath: 'main.png', role: 'mainCover', imageType: 1, imageUrl: 'https://img.shein.com/reviewed/main.png', width: 900, height: 1200, sha256: 'a'.repeat(64)},
  {name: 'square.png', relativePath: 'square.png', role: 'squareImage', imageType: 5, imageUrl: 'https://img.shein.com/reviewed/square.png', width: 1200, height: 1200, sha256: 'b'.repeat(64)},
];

const task = {
  id: 'reuse-approved-binding-guard-smoke',
  intents: ['copy_product_draft'],
  targets: {stores: ['JSH'], writeStores: ['JSH']},
  publishPreparation: {
    standardGoodsSn: 'SK-272',
    supplierSku: 'SK-272',
    supplyPrice: 414,
    inventory: 100,
    categoryId: 8898,
    titles: {ar: 'Arabic title', en: 'English title'},
    attributeOverrides: [
      {attribute_id: 1002323, attribute_extra_value: '700', attribute_unit: 'mA'},
      {attribute_id: 2001, attribute_extra_value: '1500', attribute_unit: 'W'},
    ],
  },
  publishAssetBinding: {
    schemaVersion: 1,
    sourceApproved: true,
    authority: 'human_reviewed_source',
    targetStore: 'JSH',
    imageCount: images.length,
    images,
    bindingFingerprint: '',
  },
};
task.publishAssetBinding.bindingFingerprint = canonicalPublishAssetBindingFingerprint(task, {
  binding: task.publishAssetBinding,
  images: task.publishAssetBinding.images,
});

check('canonical approved binding accepted', validateReusedApprovedTaskBinding(task, {targetStore: 'JSH'}) === task.publishAssetBinding, true);
expectRejected('missing binding rejected', {...task, publishAssetBinding: null}, 'REUSE_APPROVED_BINDING_MISSING');
expectRejected('sourceApproved drift rejected', {...task, publishAssetBinding: {...task.publishAssetBinding, sourceApproved: false}}, 'REUSE_APPROVED_BINDING_METADATA_INVALID');
expectRejected('authority drift rejected', {...task, publishAssetBinding: {...task.publishAssetBinding, authority: 'partner_uploaded'}}, 'REUSE_APPROVED_BINDING_METADATA_INVALID');
try {
  validateReusedApprovedTaskBinding(task, {targetStore: 'MZ'});
  check('requested target store mismatch rejected', 'accepted', 'REUSE_APPROVED_BINDING_METADATA_INVALID');
} catch (error) {
  check('requested target store mismatch rejected', error?.code || '', 'REUSE_APPROVED_BINDING_METADATA_INVALID');
}
expectRejected('imageCount drift rejected', {...task, publishAssetBinding: {...task.publishAssetBinding, imageCount: 1}}, 'REUSE_APPROVED_BINDING_METADATA_INVALID');
expectRejected('missing image sha rejected', {...task, publishAssetBinding: {...task.publishAssetBinding, images: images.map((row, index) => index ? row : {...row, sha256: ''})}}, 'REUSE_APPROVED_BINDING_METADATA_INVALID');
expectRejected('fingerprint shape rejected', {...task, publishAssetBinding: {...task.publishAssetBinding, bindingFingerprint: 'bad'}}, 'REUSE_APPROVED_BINDING_METADATA_INVALID');
expectRejected('image URL drift rejected by canonical fingerprint', {...task, publishAssetBinding: {...task.publishAssetBinding, images: images.map((row, index) => index ? row : {...row, imageUrl: 'https://img.shein.com/drift/main.png'})}}, 'REUSE_APPROVED_BINDING_METADATA_INVALID');
expectRejected('image role drift rejected by canonical fingerprint', {...task, publishAssetBinding: {...task.publishAssetBinding, images: images.map((row, index) => index ? row : {...row, role: 'detail'})}}, 'REUSE_APPROVED_BINDING_METADATA_INVALID');

const maintenanceTask = {
  id: 'reuse-approved-maintenance-binding-guard-smoke',
  intents: ['update_images'],
  targets: {stores: ['JSH'], writeStores: ['JSH']},
  imageEditPayload: {spu_name: 'v-maintenance-smoke', skc_list: [{skc_name: 'sv-maintenance-smoke', sku_list: [{sku_code: 'SKU-MAINT-1'}]}]},
  publishAssetBinding: {
    schemaVersion: 2,
    kind: 'update_images',
    sourceApproved: true,
    authority: 'human_reviewed_source',
    targetStore: 'JSH',
    imageCount: images.length,
    images: clone(images),
    evidence: {identity: {spuName: 'v-maintenance-smoke', skcName: 'sv-maintenance-smoke', skuCodes: ['SKU-MAINT-1']}},
    bindingFingerprint: '',
  },
};
maintenanceTask.publishAssetBinding.bindingFingerprint = canonicalPublishAssetBindingFingerprint(maintenanceTask, {
  binding: maintenanceTask.publishAssetBinding,
  images: maintenanceTask.publishAssetBinding.images,
});
check('canonical maintenance binding accepted', validateReusedApprovedTaskBinding(maintenanceTask, {targetStore: 'JSH', expectedKind: 'update_images'}) === maintenanceTask.publishAssetBinding, true);
for (const [label, kind] of [['missing kind', undefined], ['copy kind', 'copy_product_draft'], ['arbitrary kind', 'other']]) {
  try {
    const changed = clone(maintenanceTask);
    if (kind === undefined) delete changed.publishAssetBinding.kind;
    else changed.publishAssetBinding.kind = kind;
    validateReusedApprovedTaskBinding(changed, {targetStore: 'JSH', expectedKind: 'update_images'});
    check(`maintenance ${label} rejected`, 'accepted', 'REUSE_APPROVED_BINDING_METADATA_INVALID');
  } catch (error) {
    check(`maintenance ${label} rejected`, error?.code || '', 'REUSE_APPROVED_BINDING_METADATA_INVALID');
  }
}
try {
  validateReusedApprovedTaskBinding({...maintenanceTask, publishAssetBinding: {...maintenanceTask.publishAssetBinding, schemaVersion: 1}}, {targetStore: 'JSH', expectedKind: 'update_images'});
  check('maintenance wrong schema rejected', 'accepted', 'REUSE_APPROVED_BINDING_METADATA_INVALID');
} catch (error) {
  check('maintenance wrong schema rejected', error?.code || '', 'REUSE_APPROVED_BINDING_METADATA_INVALID');
}
try {
  validateReusedApprovedTaskBinding({
    ...maintenanceTask,
    publishAssetBinding: {
      ...maintenanceTask.publishAssetBinding,
      images: maintenanceTask.publishAssetBinding.images.map((row, index) => index ? row : {...row, imageUrl: 'https://img.shein.com/drift/maintenance.png'}),
    },
  }, {targetStore: 'JSH', expectedKind: 'update_images'});
  check('maintenance image drift rejected', 'accepted', 'REUSE_APPROVED_BINDING_METADATA_INVALID');
} catch (error) {
  check('maintenance image drift rejected', error?.code || '', 'REUSE_APPROVED_BINDING_METADATA_INVALID');
}

const merged = sparseMergePublishPreparation(task.publishPreparation, {
  standardGoodsSn: '',
  supplierSku: '',
  supplyPrice: null,
  inventory: null,
  categoryId: null,
  titles: {},
  attributeOverrides: [{attribute_id: 1002323, attribute_extra_value: '6800', attribute_unit: 'mA'}],
});
check('sparse merge keeps standard goods number', merged.standardGoodsSn, 'SK-272');
check('sparse merge keeps supplier sku', merged.supplierSku, 'SK-272');
check('sparse merge keeps supply price', merged.supplyPrice, 414);
check('sparse merge keeps inventory', merged.inventory, 100);
check('sparse merge keeps category', merged.categoryId, 8898);
check('sparse merge keeps Arabic title', merged.titles.ar, 'Arabic title');
check('sparse merge keeps English title', merged.titles.en, 'English title');
check('sparse merge replaces same-id input current', merged.attributeOverrides.find(row => Number(row.attribute_id) === 1002323)?.attribute_extra_value, '6800');
check('sparse merge keeps other attribute override', merged.attributeOverrides.find(row => Number(row.attribute_id) === 2001)?.attribute_extra_value, '1500');

try {
  sparseMergePublishPreparation(task.publishPreparation, {attributeOverrides: [{attribute_id: 1.5, attribute_extra_value: 'bad'}]});
  check('fractional override id rejected', 'accepted', 'REUSE_APPROVED_BINDING_ATTRIBUTE_OVERRIDE_INVALID');
} catch (error) {
  check('fractional override id rejected', error?.code || '', 'REUSE_APPROVED_BINDING_ATTRIBUTE_OVERRIDE_INVALID');
}

const oneHundredOverrides = Array.from({length: 100}, (_, index) => ({attribute_id: index + 1, attribute_extra_value: String(index + 1)}));
try {
  sparseMergePublishPreparation({attributeOverrides: oneHundredOverrides}, {attributeOverrides: [{attribute_id: 1002323, attribute_extra_value: '6800'}]});
  check('101st unique override rejected instead of truncated', 'accepted', 'REUSE_APPROVED_BINDING_ATTRIBUTE_OVERRIDE_LIMIT_EXCEEDED');
} catch (error) {
  check('101st unique override rejected instead of truncated', error?.code || '', 'REUSE_APPROVED_BINDING_ATTRIBUTE_OVERRIDE_LIMIT_EXCEEDED');
}
try {
  sparseMergePublishPreparation({attributeOverrides: [...oneHundredOverrides, {attribute_id: 'not-a-number', attribute_extra_value: 'bad'}]}, {});
  check('invalid 101st raw override validated before truncation', 'accepted', 'REUSE_APPROVED_BINDING_ATTRIBUTE_OVERRIDE_INVALID');
} catch (error) {
  check('invalid 101st raw override validated before truncation', error?.code || '', 'REUSE_APPROVED_BINDING_ATTRIBUTE_OVERRIDE_INVALID');
}

for (const [label, invalidId] of [
  ['boolean override id', true],
  ['array override id', [1]],
  ['exponent override id', '1e3'],
  ['hex override id', '0x10'],
]) {
  try {
    sparseMergePublishPreparation({}, {attributeOverrides: [{attribute_id: invalidId, attribute_extra_value: 'bad'}]});
    check(`${label} rejected`, 'accepted', 'REUSE_APPROVED_BINDING_ATTRIBUTE_OVERRIDE_INVALID');
  } catch (error) {
    check(`${label} rejected`, error?.code || '', 'REUSE_APPROVED_BINDING_ATTRIBUTE_OVERRIDE_INVALID');
  }
}
const digitStringMerged = sparseMergePublishPreparation({}, {attributeOverrides: [{attribute_id: '1002323', attribute_extra_value: '6800'}]});
check('decimal digit-string override id accepted', digitStringMerged.attributeOverrides[0]?.attribute_id, '1002323');

const ok = checks.every(row => row.pass);
console.log(JSON.stringify({ok, checks}, null, 2));
if (!ok) process.exit(1);
