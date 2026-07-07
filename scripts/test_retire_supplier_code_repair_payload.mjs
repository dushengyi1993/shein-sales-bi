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

console.log(JSON.stringify({ok: true, checks: ['status_guard', 'no_shelf_endpoint', 'fy_sk5110_hard_exclude', 'payload_attributes_title_guard']}, null, 2));
