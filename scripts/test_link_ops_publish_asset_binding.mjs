#!/usr/bin/env node
import {
  applyApprovedImageBindingsToPublishPayload,
  applyExplicitPublishPreparationOverrides,
  taskHasUnboundImageAssets,
} from '../lib/link_ops_publish_asset_binding.mjs';

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
check('binds SKU image to uploaded main', bound.payload.skc_list[0].sku_list[0].image_info.image_info_list[0].image_url, 'https://img.shein.com/upload/main.png');

const overridden = applyExplicitPublishPreparationOverrides(bound.payload, {
  standardGoodsSn: '(全)SK-999食品料理机',
  supplyPrice: 210,
  inventory: 100,
  categoryId: 12345,
  titleAr: 'Arabic locked title',
  titleEn: 'English locked title',
});
check('locks exact supplier code', overridden.payload.skc_list[0].supplier_code, '(全)SK-999食品料理机');
check('locks exact supplier sku', overridden.payload.skc_list[0].sku_list[0].supplier_sku, '(全)SK-999食品料理机');
check('locks exact supply price', overridden.payload.skc_list[0].sku_list[0].cost_info.cost_price, '210.00');
check('locks inventory while preserving warehouse', overridden.payload.skc_list[0].sku_list[0].stock_info_list[0].stock, 100);
check('preserves warehouse id', overridden.payload.skc_list[0].sku_list[0].stock_info_list[0].warehouse_id, 'WH-1');
check('locks category', overridden.payload.category_id, 12345);
check('locks Arabic title', overridden.payload.multi_language_name_list.find(row => row.language === 'ar')?.name, 'Arabic locked title');
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
