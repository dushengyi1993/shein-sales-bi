#!/usr/bin/env node
import {__testHooks} from './serve_bi_portal.mjs';

const {
  canonicalPublishAssetBindingFingerprint,
  invalidateDependentPublishLocksForPreparationMigration,
  persistedPublishPreparationLock,
  replaceExplicitPublishPreparationTitlesInCapturePayload,
  sparseMergePublishPreparation,
  validateExistingPublishAssetBindingForAdopt,
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
    targetStore: 'JSH',
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
task.publishAssetBinding.publishPreparation = persistedPublishPreparationLock(task.publishPreparation);
task.publishAssetBinding.bindingFingerprint = canonicalPublishAssetBindingFingerprint(task, {
  binding: task.publishAssetBinding,
  images: task.publishAssetBinding.images,
});

check('canonical approved binding accepted', validateReusedApprovedTaskBinding(task, {targetStore: 'JSH'}) === task.publishAssetBinding, true);

const legacyCompactTask = clone(task);
legacyCompactTask.publishAssetBinding.publishPreparation = {
  targetStore: 'JSH',
  titleGroup: null,
  standardGoodsSn: 'SK-272',
  supplierSku: 'SK-272',
  supplyPrice: 414,
  supplyPriceCurrency: 'SAR',
  inventory: 100,
  categoryId: 8898,
  titleLanguages: ['ar', 'en'],
  attributeOverrideIds: [1002323, 2001],
};
legacyCompactTask.publishAssetBinding.bindingFingerprint = canonicalPublishAssetBindingFingerprint(legacyCompactTask, {
  binding: legacyCompactTask.publishAssetBinding,
  images: legacyCompactTask.publishAssetBinding.images,
  publishPreparation: legacyCompactTask.publishAssetBinding.publishPreparation,
});
check('exact legacy compact evidence may be reused once for migration', validateReusedApprovedTaskBinding(legacyCompactTask, {targetStore: 'JSH'}) === legacyCompactTask.publishAssetBinding, true);
check('legacy compact evidence is never accepted by adopt gate', validateExistingPublishAssetBindingForAdopt(legacyCompactTask).ok, false);
for (const key of ['titleLanguages', 'attributeOverrideIds', 'publishPreparation']) {
  const drifted = clone(legacyCompactTask);
  if (key === 'publishPreparation') delete drifted.publishAssetBinding.publishPreparation;
  else delete drifted.publishAssetBinding.publishPreparation[key];
  try {
    validateReusedApprovedTaskBinding(drifted, {targetStore: 'JSH'});
    check(`legacy compact deletion ${key} fails reuse`, 'accepted', 'REUSE_APPROVED_BINDING_METADATA_INVALID');
  } catch (error) {
    check(`legacy compact deletion ${key} fails reuse`, error?.code || '', 'REUSE_APPROVED_BINDING_METADATA_INVALID');
  }
}

// FY Title3 regression: an old same-task capture may contain placeholder
// titles, but only an explicitly supplied destination title may replace the
// matching structured row before the protected payload is rebuilt. The
// non-title payload and an omitted title remain untouched.
const fyCapturePayload = {
  category_id: 123,
  multiLanguageNameList: [
    {language: 'ar', product_name: 'FY old Arabic title', marker: 'keep-ar'},
    {language: 'en', product_name: 'FY old English title', marker: 'keep-en'},
    {language: 'zh-cn', name: 'FY old Chinese title', marker: 'keep-zh'},
  ],
  skc_list: [{supplier_code: 'FY-SN', sku_list: [{supplier_sku: 'FY-SKU'}]}],
};
const fyExplicitPreparation = {
  targetStore: 'FY',
  titleGroup: 'title3',
  titles: {ar: 'FY new Arabic title', en: 'FY new English title'},
};
const fyReplaced = replaceExplicitPublishPreparationTitlesInCapturePayload(fyCapturePayload, fyExplicitPreparation);
check('FY Title3 explicit capture replacement covers ar/en only', fyReplaced.replacedLanguages.join(','), 'ar,en');
check('FY Title3 replaces old Arabic title in its existing row', fyReplaced.payload.multiLanguageNameList.find(row => row.language === 'ar')?.product_name, 'FY new Arabic title');
check('FY Title3 replaces old English title in its existing row', fyReplaced.payload.multiLanguageNameList.find(row => row.language === 'en')?.product_name, 'FY new English title');
check('FY Title3 leaves non-target title row unchanged', fyReplaced.payload.multiLanguageNameList.find(row => row.language === 'zh-cn')?.name, 'FY old Chinese title');
check('FY Title3 leaves protected non-title fields unchanged', JSON.stringify({category_id: fyReplaced.payload.category_id, skc_list: fyReplaced.payload.skc_list}), JSON.stringify({category_id: 123, skc_list: [{supplier_code: 'FY-SN', sku_list: [{supplier_sku: 'FY-SKU'}]}]}));
check('FY Title3 replacement does not mutate old capture snapshot', fyCapturePayload.multiLanguageNameList.find(row => row.language === 'en')?.product_name, 'FY old English title');
const migratedDependencies = invalidateDependentPublishLocksForPreparationMigration({
  openapiPublishPayload: {
    ...fyReplaced.payload,
    multi_language_desc_list: [{language: 'en', product_desc: 'locked description'}],
  },
  descriptionMaterialBinding: {contentSha256: 'a'.repeat(64)},
  productAttributeBinding: {evidenceSha256: 'b'.repeat(64)},
});
check('preparation migration removes bound descriptions before rebind', Object.hasOwn(migratedDependencies.task.openapiPublishPayload, 'multi_language_desc_list'), false);
check('preparation migration removes stale description binding', Object.hasOwn(migratedDependencies.task, 'descriptionMaterialBinding'), false);
check('preparation migration removes stale product attribute binding', Object.hasOwn(migratedDependencies.task, 'productAttributeBinding'), false);
check('preparation migration reports both invalidated dependencies', migratedDependencies.invalidatedDescriptionBinding && migratedDependencies.invalidatedProductAttributeBinding, true);
const fyNoExplicit = replaceExplicitPublishPreparationTitlesInCapturePayload(fyCapturePayload, {targetStore: 'FY', titleGroup: 'title3'});
check('missing explicit FY title leaves old capture snapshot unchanged', fyNoExplicit.payload === fyCapturePayload && fyNoExplicit.replacedLanguages.length, 0);
try {
  replaceExplicitPublishPreparationTitlesInCapturePayload(
    {...fyCapturePayload, multiLanguageNameList: fyCapturePayload.multiLanguageNameList.filter(row => row.language !== 'en')},
    fyExplicitPreparation,
  );
  check('missing structured FY English title row fails closed', 'accepted', 'structured-title-row');
} catch (error) {
  check('missing structured FY English title row fails closed', error?.message || '', value => /structured title row|禁止新增|猜测/.test(value));
}

// The task and binding must both preserve the complete preparation.  Compact
// audit evidence cannot substitute for title values or attribute rows at the
// adopt/reuse safety gate.
const fyFullPreparation = {
  targetStore: 'FY',
  titleGroup: 'title3',
  standardGoodsSn: 'FY-SN-POST-DESC',
  supplierSku: 'FY-SKU-POST-DESC',
  supplyPrice: 222.22,
  inventory: 77,
  categoryId: 123456,
  titles: {ar: 'FY locked Arabic title', en: 'FY locked English title'},
  attributeOverrides: [{attribute_id: 1002328, attribute_extra_value: '1', attribute_unit: ''}],
};
const fyPersistedPreparation = persistedPublishPreparationLock(fyFullPreparation);
const fyMergedPreparation = sparseMergePublishPreparation(
  fyFullPreparation,
  {standardGoodsSn: 'FY-SN-POST-DESC-2'},
);
check('sparse reuse retains target store', fyMergedPreparation.targetStore, 'FY');
check('sparse reuse retains title group', fyMergedPreparation.titleGroup, 'title3');
check('persisted preparation retains exact English title', fyPersistedPreparation.titles.en, fyFullPreparation.titles.en);
check('persisted preparation retains exact Arabic title', fyPersistedPreparation.titles.ar, fyFullPreparation.titles.ar);
check('persisted preparation retains full attribute row', JSON.stringify(fyPersistedPreparation.attributeOverrides), JSON.stringify(fyFullPreparation.attributeOverrides));
const fyPostDescriptionTask = {
  id: 'lot_20260821092430_a122f67f-fixture',
  intents: ['copy_product_draft'],
  targets: {stores: ['FY'], writeStores: ['FY'], publishPreparation: clone(fyFullPreparation)},
  publishPreparation: clone(fyFullPreparation),
  publishAssetBinding: {
    ...clone(task.publishAssetBinding),
    targetStore: 'FY',
    publishPreparation: clone(fyPersistedPreparation),
    images: clone(images),
    imageCount: images.length,
  },
};
fyPostDescriptionTask.publishAssetBinding.bindingFingerprint = canonicalPublishAssetBindingFingerprint(fyPostDescriptionTask, {
  binding: fyPostDescriptionTask.publishAssetBinding,
  images: fyPostDescriptionTask.publishAssetBinding.images,
  publishPreparation: fyFullPreparation,
});
check('post-prepare-descriptions full preparation accepts full task fingerprint', validateReusedApprovedTaskBinding(fyPostDescriptionTask, {targetStore: 'FY'}) === fyPostDescriptionTask.publishAssetBinding, true);
check('post-description full preparation passes adopt fingerprint gate', validateExistingPublishAssetBindingForAdopt(fyPostDescriptionTask).ok, true);
for (const [label, mutate] of [
  ['missing persisted preparation', value => { delete value.publishAssetBinding.publishPreparation; }],
  ['missing persisted titles', value => { delete value.publishAssetBinding.publishPreparation.titles; }],
  ['missing persisted attribute overrides', value => { delete value.publishAssetBinding.publishPreparation.attributeOverrides; }],
]) {
  const drifted = clone(fyPostDescriptionTask);
  mutate(drifted);
  check(`${label} fails adopt fingerprint gate`, validateExistingPublishAssetBindingForAdopt(drifted).ok, false);
}
const fyTamperedPreparationTask = clone(fyPostDescriptionTask);
fyTamperedPreparationTask.publishPreparation.titles.en = 'FY tampered English title';
try {
  validateReusedApprovedTaskBinding(fyTamperedPreparationTask, {targetStore: 'FY'});
  check('task title drift remains fail closed after compact evidence', 'accepted', 'REUSE_APPROVED_BINDING_METADATA_INVALID');
} catch (error) {
  check('task title drift remains fail closed after compact evidence', error?.code || '', 'REUSE_APPROVED_BINDING_METADATA_INVALID');
}
try {
  validateReusedApprovedTaskBinding(fyPostDescriptionTask, {targetStore: 'LQ'});
  check('FY binding requested from wrong store fails closed', 'accepted', 'REUSE_APPROVED_BINDING_METADATA_INVALID');
} catch (error) {
  check('FY binding requested from wrong store fails closed', error?.code || '', 'REUSE_APPROVED_BINDING_METADATA_INVALID');
}

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
