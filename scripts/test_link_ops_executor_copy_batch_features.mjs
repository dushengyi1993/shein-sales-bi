#!/usr/bin/env node
/**
 * Focused smoke for opt-in batch copy-link payload transforms:
 * - per-store random cost_info.cost_price from supplyPriceRange
 * - detail-only image sort shuffle with main/square sort invariants
 * - air-fryer input current auto-override from power/voltage
 */
process.env.SHEIN_LINK_OPS_EXECUTOR_SELF_TEST = '1';

const {__testHooks} = await import('./link_ops_hl_openapi_executor.mjs');

const checks = [];
function check(label, actual, expected) {
  const pass = typeof expected === 'function' ? expected(actual) : Object.is(actual, expected);
  checks.push({label, actual, expected: typeof expected === 'function' ? expected.toString() : expected, pass});
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const basePayload = {
  product_attribute_list: [
    {attribute_id: 147, attribute_value_id: 1047, attribute_name: 'Power Supply'},
    {attribute_id: 1001466, attribute_value: '220-240V', attribute_name: 'Plug Voltage'},
    {attribute_id: 900001, attribute_extra_value: '1500W', attribute_name: 'Power'},
  ],
  multi_language_name_list: [{language: 'en', name: 'BY-506 Air Fryer'}],
  skc_list: [{
    sale_name: '英规插(220-240V)',
    image_info: {
      image_info_list: [
        {image_type: 1, image_sort: 1, image_url: 'https://example.invalid/main.jpg'},
        {image_type: 2, image_sort: 2, image_url: 'https://example.invalid/detail-a.jpg'},
        {image_type: 5, image_sort: 3, image_url: 'https://example.invalid/square.jpg'},
        {image_type: 2, image_sort: 4, image_url: 'https://example.invalid/detail-b.jpg'},
        {image_type: 2, image_sort: 5, image_url: 'https://example.invalid/detail-c.jpg'},
      ],
    },
    sku_list: [
      {cost_info: {currency: 'SAR', cost_price: '310.00'}},
      {cost_info: {currency: 'SAR', cost_price: '310.00'}},
    ],
  }],
};

const noFeaturePayload = clone(basePayload);
const noPrice = __testHooks.applyRandomSupplyPrice(noFeaturePayload, {}, {}, 'HL');
check('absent supplyPriceRange leaves payload unchanged', JSON.stringify(noPrice.payload), JSON.stringify(noFeaturePayload));
check('absent supplyPriceRange has no applied changes', noPrice.applied.length, 0);
const noShuffle = __testHooks.shufflePublishDetailImages(noFeaturePayload, {}, {});
check('absent shuffleImages leaves payload unchanged', JSON.stringify(noShuffle.payload), JSON.stringify(noFeaturePayload));
check('absent shuffleImages has no applied changes', noShuffle.applied.length, 0);

const priceTask = {supplyPriceRange: {min: 310, max: 347}};
const hlPrice = __testHooks.applyRandomSupplyPrice(clone(basePayload), priceTask, {}, 'HL');
const tzPrice = __testHooks.applyRandomSupplyPrice(clone(basePayload), priceTask, {}, 'TZ');
const hlSkuPrices = asArray(hlPrice.payload.skc_list?.[0]?.sku_list).map(row => row.cost_info?.cost_price);
const tzSkuPrices = asArray(tzPrice.payload.skc_list?.[0]?.sku_list).map(row => row.cost_info?.cost_price);
check('HL randomized all SKUs to one per-store price', new Set(hlSkuPrices).size, 1);
check('TZ randomized all SKUs to one per-store price', new Set(tzSkuPrices).size, 1);
check('random price in configured range', [...hlSkuPrices, ...tzSkuPrices].every(v => Number(v) >= 310 && Number(v) <= 347), true);
check('random price differs by store bucket', hlSkuPrices[0] !== tzSkuPrices[0], true);

const shuffled = __testHooks.shufflePublishDetailImages(clone(basePayload), {shuffleImages: true}, {});
const shuffledRows = shuffled.payload.skc_list[0].image_info.image_info_list;
const globallyUnique = __testHooks.ensurePublishImageSortGlobalUnique(shuffled.payload).payload;
const finalRows = globallyUnique.skc_list[0].image_info.image_info_list;
check('shuffleImages emits applied changes', shuffled.applied.length > 0, true);
check('main image remains sort=1', finalRows.find(row => Number(row.image_type) === 1)?.image_sort, 1);
check('square image keeps original sort position', finalRows.find(row => Number(row.image_type) === 5)?.image_sort, 3);
check('detail image sorts fill non-reserved positions only', finalRows.filter(row => Number(row.image_type) === 2).map(row => Number(row.image_sort)).sort((a, b) => a - b).join(','), '2,4,5');
check('image sorts remain globally unique', new Set(finalRows.map(row => Number(row.image_sort))).size, finalRows.length);

const currentApplied = __testHooks.applyManualAttributeOverrides(clone(basePayload), {targets: {productRefs: ['BY-506空气炸锅']}}, {});
const currentRows = asArray(currentApplied.payload.product_attribute_list);
const inputCurrent = currentRows.find(row => Number(row.attribute_id) === 1002323);
check('input current derived from 1500W and 220V', inputCurrent?.attribute_extra_value, '6818');
check('input current override uses mA unit marker', inputCurrent?.__manual_attribute_unit, 'mA');

const fallbackPayload = clone(basePayload);
fallbackPayload.product_attribute_list = fallbackPayload.product_attribute_list.filter(row => Number(row.attribute_id) !== 900001);
const fallbackApplied = __testHooks.applyManualAttributeOverrides(fallbackPayload, {targets: {productRefs: ['BY-506空气炸锅']}}, {});
const fallbackCurrent = asArray(fallbackApplied.payload.product_attribute_list).find(row => Number(row.attribute_id) === 1002323);
check('air fryer input current default applied without power', fallbackCurrent?.attribute_extra_value, '6800');

const ok = checks.every(row => row.pass);
console.log(JSON.stringify({ok, checks}, null, 2));
if (!ok) process.exit(1);
