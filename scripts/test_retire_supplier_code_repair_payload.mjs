#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  buildSupplierCodeRepairPayload,
  isHardExcludedRetireRow,
  supplierCodeRepairFinalStatus,
  INPUT_CURRENT_ATTRIBUTE_ID,
  INPUT_VOLTAGE_ATTRIBUTE_ID,
  HAZARD_CATEGORY_ATTRIBUTE_ID,
  HAZARD_CATEGORY_NON_TRANSPORT_SENSITIVE_VALUE_ID,
  HAZARDOUS_MATERIALS_CLASSIFICATION_ATTRIBUTE_ID,
} from '../lib/retire_supplier_code_repair_payload.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptText = await fs.readFile(path.join(ROOT, 'scripts/repair_retire_supplier_code_openapi.mjs'), 'utf8');
assert.equal(scriptText.includes('/open-api/goods/modify-skc-shelf'), false, 'repair runner must never call shelf endpoint');
assert.match(scriptText, /repair_supplier_code_only/);

assert.equal(isHardExcludedRetireRow({store: 'FY', standard_goods_sn: 'SK-5110电磁炉', skc: 'whatever'}), true);
assert.equal(isHardExcludedRetireRow({store: 'FY', product_name: 'SK-5110电磁炉', skc: 'whatever'}), true);
assert.equal(isHardExcludedRetireRow({store: 'FY', standard_goods_sn: 'SK-270厨师机', skc: 'sv260108224672888369376'}), true);
assert.equal(isHardExcludedRetireRow({store: 'FY', standard_goods_sn: 'SK-270厨师机', skc: 'other'}), false);

const failedRow = {
  store: 'CX',
  skc: 'sv-failed',
  standard_goods_sn: 'SK-03012台式榨汁机',
  suggested_waste_goods_sn: '（废）SK-03012台式榨汁机',
  retireOk: true,
  partialOk: false,
  post: {supplierCode: 'SK-03012榨汁机', siteShelfStatus: 0},
};
assert.equal(supplierCodeRepairFinalStatus(failedRow), 'retired+supplierCodeNotChanged');
assert.notEqual(supplierCodeRepairFinalStatus(failedRow), 'retired+supplierCodeChanged');
assert.equal(supplierCodeRepairFinalStatus({...failedRow, post: {supplierCode: '（废）SK-03012台式榨汁机', siteShelfStatus: 0}}), 'retired+supplierCodeChanged');
assert.equal(supplierCodeRepairFinalStatus({...failedRow, partialOk: true, post: {supplierCode: 'SK-03012榨汁机', siteShelfStatus: 0}}), 'retired+pendingReview');

const longAr = 'ع'.repeat(340);
const spuInfo = {
  spuName: 'v-smoke',
  categoryId: 8891,
  productTypeId: 5590,
  productMultiNameList: [
    {language: 'en', productName: 'Juicer'},
    {language: 'ar', productName: longAr},
  ],
  productAttributeInfoList: [
    {attributeId: 1000546, attributeValueId: 0, attributeValue: 'SK-03012', attributeMultiList: [{language: 'en', attributeName: 'Product Model'}]},
    {attributeId: 147, attributeValueId: 1047, attributeValue: null, attributeValueMultiList: [{language: 'en', attributeValueName: 'Wall Plug'}], attributeMultiList: [{language: 'en', attributeName: 'Power Supply'}]},
    {attributeId: 1000616, attributeValueId: 1004580, attributeValue: null, attributeValueMultiList: [{language: 'en', attributeValueName: 'None'}], attributeMultiList: [{language: 'en', attributeName: 'Product Features'}]},
    {attributeId: 1001466, attributeValueId: 2535083, attributeValue: null, attributeValueMultiList: [{language: 'en', attributeValueName: 'UK Plug(220-240V)'}], attributeMultiList: [{language: 'en', attributeName: 'Plug(Voltage)'}]},
  ],
  skcInfoList: [{skcName: 'sv-failed', productMultiNameList: [{language: 'ar', productName: longAr}]}],
};
const templateRows = [
  {attribute_id: 1000546, attribute_mode: 0, attribute_value_info_list: []},
  {attribute_id: 147, attribute_mode: 1, attribute_value_info_list: [{attribute_value_id: 1047, attribute_value: 'Wall Plug'}]},
  {attribute_id: 1000616, attribute_mode: 1, attribute_value_info_list: [{attribute_value_id: 1004580, attribute_value: 'None'}]},
  {attribute_id: 1001466, attribute_mode: 1, attribute_value_info_list: [{attribute_value_id: 2535083, attribute_value: 'UK Plug(220-240V)'}]},
  {attribute_id: 1002322, attribute_mode: 4, attribute_value_info_list: [{attribute_value_id: 301114341, attribute_value: 'Vac 50–60Hz'}]},
  {attribute_id: 1002323, attribute_mode: 4, attribute_value_info_list: [{attribute_value_id: 304301999, attribute_value: 'A'}, {attribute_value_id: 304302428, attribute_value: 'mA'}]},
];
const repair = buildSupplierCodeRepairPayload({
  row: failedRow,
  spuInfo,
  attributeTemplateRows: templateRows,
  fillStandardInfo: {default_language: 'ar', default_language_title_max_length: 325},
  inputCurrentHint: {attribute_extra_value: '3.6', attribute_value_id: 304301999, source: 'same_standard_goods_sn'},
});
assert.deepEqual(repair.blockers, []);
assert.equal(repair.body.skc_list[0].supplier_code, '（废）SK-03012台式榨汁机');
assert.equal(repair.body.skc_list[0].skc_title.length, 325);
assert.ok(repair.body.product_attribute_list.some(row => Number(row.attribute_id) === INPUT_VOLTAGE_ATTRIBUTE_ID && row.attribute_extra_value === '220-240'));
assert.ok(repair.body.product_attribute_list.some(row => Number(row.attribute_id) === INPUT_CURRENT_ATTRIBUTE_ID && row.attribute_extra_value === '3.6'));
assert.ok(repair.evidence.hasInputVoltage);
assert.ok(repair.evidence.hasInputCurrent);

const blocked = buildSupplierCodeRepairPayload({
  row: failedRow,
  spuInfo,
  attributeTemplateRows: templateRows,
  fillStandardInfo: {default_language: 'ar', default_language_title_max_length: 325},
});
assert.ok(blocked.blockers.some(x => /Input current/.test(x)), 'missing current must block instead of guessing');

const currentOnlyLinkedRule = buildSupplierCodeRepairPayload({
  row: failedRow,
  spuInfo,
  attributeTemplateRows: templateRows.filter(row => Number(row.attribute_id) !== INPUT_VOLTAGE_ATTRIBUTE_ID),
  fillStandardInfo: {default_language: 'ar', default_language_title_max_length: 325},
  inputCurrentHint: {attribute_extra_value: '3.6', attribute_value_id: 304301999, source: 'same_standard_goods_sn'},
  requiredLinkedAttributeIds: [INPUT_CURRENT_ATTRIBUTE_ID],
});
assert.deepEqual(currentOnlyLinkedRule.blockers, []);
assert.equal(currentOnlyLinkedRule.evidence.hasInputVoltage, false);
assert.equal(currentOnlyLinkedRule.evidence.hasInputCurrent, true);
assert.deepEqual(currentOnlyLinkedRule.evidence.requiredLinkedAttributeIds, [INPUT_CURRENT_ATTRIBUTE_ID]);

const hazardInfo = {
  ...spuInfo,
  productAttributeInfoList: [
    ...spuInfo.productAttributeInfoList,
    {attributeId: HAZARD_CATEGORY_ATTRIBUTE_ID, attributeValueId: HAZARD_CATEGORY_NON_TRANSPORT_SENSITIVE_VALUE_ID, attributeValue: null},
  ],
};
const hazardTemplateRows = [
  ...templateRows,
  {
    attribute_id: HAZARD_CATEGORY_ATTRIBUTE_ID,
    attribute_name: 'Hazard Category',
    attribute_mode: 1,
    attribute_status: 2,
    attribute_value_info_list: [{attribute_value_id: HAZARD_CATEGORY_NON_TRANSPORT_SENSITIVE_VALUE_ID, attribute_value: 'Others (Non-Transport Sensitive Items)'}],
  },
  {
    attribute_id: HAZARDOUS_MATERIALS_CLASSIFICATION_ATTRIBUTE_ID,
    attribute_name: 'Hazardous materials classification',
    attribute_mode: 3,
    attribute_status: 3,
    attribute_value_info_list: [
      {attribute_value_id: 316914027, attribute_value: 'Class 9 - Lithium-ion batteries'},
      {attribute_value_id: 316913742, attribute_value: 'Class 9 - Lithium-ion batteries contained in equipment'},
      {attribute_value_id: 316914660, attribute_value: '该商品不属于危险品'},
    ],
  },
];
const hazardCategoryOnly = buildSupplierCodeRepairPayload({
  row: failedRow,
  spuInfo: hazardInfo,
  attributeTemplateRows: hazardTemplateRows,
  fillStandardInfo: {default_language: 'ar', default_language_title_max_length: 325},
  inputCurrentHint: {attribute_extra_value: '3.6', attribute_value_id: 304301999, source: 'same_standard_goods_sn'},
});
assert.ok(hazardCategoryOnly.blockers.some(text => /provide an approved product-specific or unanimous sibling hint/.test(text)));
assert.equal(hazardCategoryOnly.body, null);

const hazardHinted = buildSupplierCodeRepairPayload({
  row: failedRow,
  spuInfo,
  attributeTemplateRows: hazardTemplateRows,
  fillStandardInfo: {default_language: 'ar', default_language_title_max_length: 325},
  inputCurrentHint: {attribute_extra_value: '3.6', attribute_value_id: 304301999, source: 'same_standard_goods_sn'},
  hazardousClassificationHint: {attribute_value_id: 316913742, source: 'user_approved_lithium_battery_contained_in_equipment'},
});
assert.deepEqual(hazardHinted.blockers, []);
assert.ok(hazardHinted.body.product_attribute_list.some(row => Number(row.attribute_id) === HAZARDOUS_MATERIALS_CLASSIFICATION_ATTRIBUTE_ID && Number(row.attribute_value_id) === 316913742));
assert.equal(hazardHinted.evidence.hazardousClassificationHint.attributeValueId, 316913742);

const featureRequiredTemplateRows = templateRows.map(row => Number(row.attribute_id) === 1000616 ? {...row, attribute_status: 3} : row);
const featureMissingInfo = {
  ...spuInfo,
  productAttributeInfoList: spuInfo.productAttributeInfoList.filter(row => Number(row.attributeId) !== 1000616),
};
const featureHinted = buildSupplierCodeRepairPayload({
  row: failedRow,
  spuInfo: featureMissingInfo,
  attributeTemplateRows: featureRequiredTemplateRows,
  fillStandardInfo: {default_language: 'ar', default_language_title_max_length: 325},
  inputCurrentHint: {attribute_extra_value: '3.6', attribute_value_id: 304301999, source: 'same_standard_goods_sn'},
  requiredAttributeHints: {
    1000616: {attribute_value_id: 1004580, source: 'same_canonical_cross_store_unanimous_required_attribute'},
  },
});
assert.deepEqual(featureHinted.blockers, []);
assert.ok(featureHinted.body.product_attribute_list.some(row => Number(row.attribute_id) === 1000616 && Number(row.attribute_value_id) === 1004580));
assert.deepEqual(featureHinted.evidence.requiredAttributeHintIds, [1000616]);

if (process.platform === 'win32') {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'retire-supplier-code-repair-'));
  const previous = path.join(tmp, 'previous-final-summary.json');
  await fs.writeFile(previous, JSON.stringify({finalRows: [
    {...failedRow, finalStatus: 'retired+partialEditFailed'},
    {store: 'FY', skc: 'sv260108224672888369376', standard_goods_sn: 'SK-5110电磁炉', suggested_waste_goods_sn: '（废）SK-5110电磁炉', retireOk: true, post: {supplierCode: 'SK-5110电磁炉', siteShelfStatus: 0}},
  ]}, null, 2));
  const child = spawn(process.execPath, ['scripts/repair_retire_supplier_code_openapi.mjs', '--input', previous, '--dry-run', '--out-dir', path.join(tmp, 'out'), '--openapi-products-dir', path.join(tmp, 'missing-products')], {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d.toString(); });
  child.stderr.on('data', d => { stderr += d.toString(); });
  const code = await new Promise(resolve => child.on('close', resolve));
  assert.equal(code, 1, `local dry-run should be blocked before any OpenAPI access; stdout=${stdout} stderr=${stderr}`);
  assert.match(stderr, /Refusing SHEIN OpenAPI access on Windows\/local Codex/);
}

console.log(JSON.stringify({ok: true, checks: ['status_guard', 'no_shelf_endpoint', 'fy_sk5110_hard_exclude', 'payload_attributes_title_guard', 'official_linked_rule_scope', 'required_hazard_classification', 'approved_hazard_classification_hint', 'required_attribute_sibling_hint']}, null, 2));
