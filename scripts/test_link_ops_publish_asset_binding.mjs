#!/usr/bin/env node
import {
  applyApprovedImageBindingsToPublishPayload,
  applyApprovedImageBindingsToMaintenancePayload,
  applyExplicitPublishPreparationOverrides,
  taskHasUnboundImageAssets,
} from '../lib/link_ops_publish_asset_binding.mjs';
import {
  buildPendingListingImageCorrection,
  extractExactDocumentState,
  validatePendingListingImageCorrection,
} from '../lib/link_ops_pending_listing_image_correction.mjs';

const checks = [];
function check(label, actual, expected) {
  const pass = typeof expected === 'function' ? expected(actual) : actual === expected;
  checks.push({label, actual, expected: typeof expected === 'function' ? 'predicate' : expected, pass});
}

const payload = {
  category_id: 1,
  multi_language_name_list: [{language: 'ar', name: 'old ar'}, {language: 'en', name: 'old en'}],
  skc_list: [{
    supplier_code: 'old-code',
    image_info: {image_info_list: [{image_type: 1, image_sort: 1, image_url: 'https://img.shein.com/source.jpg'}]},
    sku_list: [{
      supplier_sku: 'old-sku',
      cost_info: {currency: 'SAR', cost_price: '99.00'},
      stock_info_list: [{warehouse_id: 'WH-1', stock: 8}],
    }],
  }],
};
const bindings = [
  {name: '02-main.png', role: 'mainCover', imageType: 1, imageUrl: 'https://img.shein.com/upload/main.png', width: 900, height: 1200, order: 1},
  {name: '05-carousel.png', role: 'carouselSecondCover', imageType: 1, imageUrl: 'https://img.shein.com/upload/carousel.png', width: 900, height: 1200, order: 2},
  {name: '11-15speed.png', role: 'detail', imageType: 2, imageUrl: 'https://img.shein.com/upload/15speed.png', width: 900, height: 1200, order: 3},
  {name: '12-45db.png', role: 'detail', imageType: 2, imageUrl: 'https://img.shein.com/upload/45db.png', width: 900, height: 1200, order: 4},
  {name: '03-square.png', role: 'squareImage', imageType: 5, imageUrl: 'https://img.shein.com/upload/square.png', width: 1254, height: 1254, order: 5},
];

const bound = applyApprovedImageBindingsToPublishPayload(payload, bindings, {sourceApproved: true});
check('binds every approved image', bound.evidence.boundImageCount, 5);
check('retains approved 15 speed image', JSON.stringify(bound.payload), text => text.includes('15speed.png'));
check('retains approved 45dB image', JSON.stringify(bound.payload), text => text.includes('45db.png'));
check('uses measured square image', bound.evidence.squareDimensions, '1254x1254');
check('replaces source SKC images', JSON.stringify(bound.payload), text => !text.includes('source.jpg'));
check('binds separate SPU carousel', bound.payload.image_info?.image_info_list?.[0]?.image_url, 'https://img.shein.com/upload/carousel.png');
check('does not invent SKU image when no skuImage role was planned', 'image_info' in bound.payload.skc_list[0].sku_list[0], false);
check('reports no SKU image when no skuImage role was planned', bound.evidence.skuImage, '');

const explicitSkuBindings = [
  ...bindings,
  {name: '13-sku.png', role: 'skuImage', imageType: 1, imageUrl: 'https://img.shein.com/upload/sku.png', width: 900, height: 1200, order: 6},
];
const explicitlyBoundSku = applyApprovedImageBindingsToPublishPayload(payload, explicitSkuBindings, {sourceApproved: true});
check('binds SKU image only when explicitly planned', explicitlyBoundSku.payload.skc_list[0].sku_list[0].image_info.image_info_list[0].image_url, 'https://img.shein.com/upload/sku.png');
check('reports explicitly planned SKU image', explicitlyBoundSku.evidence.skuImage, '13-sku.png');

const maintenanceBound = applyApprovedImageBindingsToMaintenancePayload({
  spuName: 'B2608062023343035',
  skcName: 'SB260806202334303501938',
  skuCodes: ['SKU-LIVE-SB-001'],
}, explicitSkuBindings, {sourceApproved: true});
check('maintenance binding canonicalizes SPU', maintenanceBound.payload.spu_name, 'b2608062023343035');
check('maintenance binding canonicalizes SB SKC', maintenanceBound.payload.skc_list[0].skc_name, 'sb260806202334303501938');
check('maintenance binding carries exact SKU only for image binding', maintenanceBound.payload.skc_list[0].sku_list[0].sku_code, 'SKU-LIVE-SB-001');
check('maintenance binding has no title field', 'multi_language_name_list' in maintenanceBound.payload, false);
check('maintenance binding has no inventory or price fields', JSON.stringify(maintenanceBound.payload), text => !/stock_info|cost_info|shopPrice|specialPrice/.test(text));
check('maintenance binding records task image payload source', maintenanceBound.evidence.payloadSource, 'task.imageEditPayload');

const maintenanceWithoutSkuImage = applyApprovedImageBindingsToMaintenancePayload({
  spuName: 'B2608062023343035',
  skcName: 'SB260806202334303501938',
  skuCodes: ['SKU-LIVE-SB-001'],
}, bindings, {sourceApproved: true});
check('maintenance binding omits SKU node when no SKU image is planned',
  'sku_list' in maintenanceWithoutSkuImage.payload.skc_list[0], false);
check('maintenance binding still locks exact SKU identity outside payload',
  maintenanceWithoutSkuImage.identity.skuCodes[0], 'SKU-LIVE-SB-001');
check('maintenance binding without SKU image does not claim SKU fields are touched',
  maintenanceWithoutSkuImage.evidence.touchedFields.join(','), text => !text.includes('sku_list'));

const maintenanceShBound = applyApprovedImageBindingsToMaintenancePayload({
  spuName: 'B2608062023343035',
  skcName: 'SH260607203410692590516',
}, bindings, {sourceApproved: true});
check('maintenance binding canonicalizes SH SKC', maintenanceShBound.payload.skc_list[0].skc_name, 'sh260607203410692590516');
let shMisclassifiedAsSpu = false;
try {
  applyApprovedImageBindingsToMaintenancePayload({
    spuName: 'SH260607203410692590516',
    skcName: 'SB260806202334303501938',
  }, bindings, {sourceApproved: true});
} catch {
  shMisclassifiedAsSpu = true;
}
check('maintenance binding rejects SH SKC as SPU', shMisclassifiedAsSpu, true);

const correction = buildPendingListingImageCorrection({
  sourceTask: {
    id: 'published-source-task',
    openapiPublishPayload: payload,
    execution: {actualWriteSubmitted: true},
  },
  sourceTaskId: 'published-source-task',
  targetStore: 'HL',
  identity: {spuName: 'B2608062023343035', skcName: 'SB260806202334303501938', skuCodes: ['SKU-LIVE-SB-001']},
  documentVersion: 'SPMP260806300745650',
  approvedBindings: explicitSkuBindings,
  approvedBindingFingerprint: 'b'.repeat(64),
});
const correctionTask = {publishAssetBinding: {bindingFingerprint: 'b'.repeat(64)}, pendingNewListingImageCorrection: correction};
const correctionValidation = validatePendingListingImageCorrection(correctionTask, {store: 'HL'});
check('pending correction validates exact source/binding identity', correctionValidation.ok, true);
check('pending correction injects platform SPU', correction.republishPayload.spu_name, 'b2608062023343035');
check('pending correction injects platform SB SKC', correction.republishPayload.skc_list[0].skc_name, 'sb260806202334303501938');
check('pending correction injects platform SKU', correction.republishPayload.skc_list[0].sku_list[0].sku_code, 'SKU-LIVE-SB-001');
check('pending correction keeps original title', correction.republishPayload.multi_language_name_list[0].name, 'old ar');
check('pending correction keeps original supplier code', correction.republishPayload.skc_list[0].supplier_code, 'old-code');
check('pending correction keeps original price', correction.republishPayload.skc_list[0].sku_list[0].cost_info.cost_price, '99.00');
check('pending correction keeps original inventory', correction.republishPayload.skc_list[0].sku_list[0].stock_info_list[0].stock, 8);
check('pending correction replaces wrong image', JSON.stringify(correction.republishPayload), text => text.includes('/upload/main.png') && !text.includes('source.jpg'));
const state = extractExactDocumentState({info: {data: [{spuName: 'b2608062023343035', version: 'SPMP260806300745650', skcList: [{skcName: 'sb260806202334303501938', documentState: 1}]}]}}, correction.identity, correction.documentVersion);
check('pending correction reads one exact pending document', state.documentState, 1);
const tamperedCorrectionTask = JSON.parse(JSON.stringify(correctionTask));
tamperedCorrectionTask.pendingNewListingImageCorrection.republishPayload.skc_list[0].supplier_code = 'tampered';
check('pending correction rejects protected-field drift', validatePendingListingImageCorrection(tamperedCorrectionTask, {store: 'HL'}).ok, false);

const overridden = applyExplicitPublishPreparationOverrides(bound.payload, {
  standardGoodsSn: '(全)SK-999食品料理机',
  supplyPrice: 210,
  inventory: 100,
  categoryId: 12345,
  titleAr: 'Arabic locked title',
  titleEn: 'English locked title',
  supplierSku: '(全)SK-999食品料理机-2',
  attributeOverrides: [{attribute_id: 1002323, attribute_extra_value: '3409', attribute_unit: 'mA'}],
});
check('locks exact supplier code', overridden.payload.skc_list[0].supplier_code, '(全)SK-999食品料理机');
check('locks unique supplier sku separately', overridden.payload.skc_list[0].sku_list[0].supplier_sku, '(全)SK-999食品料理机-2');
check('locks exact supply price', overridden.payload.skc_list[0].sku_list[0].cost_info.cost_price, '210.00');
check('locks inventory while preserving warehouse', overridden.payload.skc_list[0].sku_list[0].stock_info_list[0].stock, 100);
check('preserves warehouse id', overridden.payload.skc_list[0].sku_list[0].stock_info_list[0].warehouse_id, 'WH-1');
check('locks category', overridden.payload.category_id, 12345);
check('locks Arabic title', overridden.payload.multi_language_name_list.find(row => row.language === 'ar')?.name, 'Arabic locked title');
check('records explicit input current attribute', overridden.evidence.attributeOverrideIds.join(','), '1002323');
const renormalized = applyExplicitPublishPreparationOverrides(bound.payload, {
  standardGoodsSn: '(全)SK-999食品料理机',
  supplyPrice: 210,
  inventory: 100,
  categoryId: 12345,
  titles: {ar: 'Nested Arabic locked title', en: 'Nested English locked title'},
});
check('keeps nested Arabic title after re-normalization', renormalized.payload.multi_language_name_list.find(row => row.language === 'ar')?.name, 'Nested Arabic locked title');
check('keeps nested English title after re-normalization', renormalized.payload.multi_language_name_list.find(row => row.language === 'en')?.name, 'Nested English locked title');
check('reports nested title languages after re-normalization', renormalized.evidence.titleLanguages.join(','), 'ar,en');
const noNumericOverrides = applyExplicitPublishPreparationOverrides(payload, {standardGoodsSn: 'SK-999食品料理机'});
check('missing supply price does not become zero', noNumericOverrides.payload.skc_list[0].sku_list[0].cost_info.cost_price, '99.00');
check('missing inventory does not become zero', noNumericOverrides.payload.skc_list[0].sku_list[0].stock_info_list[0].stock, 8);
check('missing numeric overrides remain null in evidence', JSON.stringify({supplyPrice:noNumericOverrides.evidence.supplyPrice,inventory:noNumericOverrides.evidence.inventory,categoryId:noNumericOverrides.evidence.categoryId}), '{"supplyPrice":null,"inventory":null,"categoryId":null}');
check('image assets without binding are detected', taskHasUnboundImageAssets({assets: [{mime: 'image/png'}]}), true);
check('bound image assets are not detected as unbound', taskHasUnboundImageAssets({assets: [{mime: 'image/png'}], publishAssetBinding: {boundAt: new Date().toISOString()}}), false);

let rejected = false;
try { applyApprovedImageBindingsToPublishPayload(payload, bindings, {sourceApproved: false}); } catch { rejected = true; }
check('unapproved source cannot use deterministic binding path', rejected, true);

const ok = checks.every(row => row.pass);
console.log(JSON.stringify({ok, checks}, null, 2));
if (!ok) process.exitCode = 1;
