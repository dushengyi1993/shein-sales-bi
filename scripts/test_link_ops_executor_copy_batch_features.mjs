#!/usr/bin/env node
/**
 * Focused smoke for opt-in batch copy-link payload transforms:
 * - per-store random cost_info.cost_price from supplyPriceRange
 * - detail-only image sort shuffle with main/square sort invariants
 * - air-fryer input current auto-override from power/voltage
 * - official product template enrichment for Power Adapter input voltage and
 *   non-dangerous-goods classification
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

check('numeric OpenAPI code 0 plus explicit success true is accepted', __testHooks.publishResultSucceeded({code: 0, info: {success: true}}), true);
check('string OpenAPI code 0 plus explicit success true is accepted', __testHooks.publishResultSucceeded({code: '0', info: {success: true}}), true);
check('code 0 without explicit success is rejected', __testHooks.publishResultSucceeded({code: 0, info: {}}), false);
const sensitiveLine = `Reviewed long point ${'x'.repeat(360)}`;
const sensitivePayload = {multi_language_desc_list: [{language: 'en', name: `${sensitiveLine}\nline two\nline three\nline four\nline five`}]};
const sanitizedLongEcho = __testHooks.sanitizePublishPlatformText(sensitiveLine, sensitivePayload, 300);
check('long single-line description echo is hash-only before truncation', sanitizedLongEcho, value => /^\[平台回显内容已脱敏 sha256=[a-f0-9]{64}\]$/.test(value) && !value.includes(sensitiveLine.slice(0, 80)));
const spacedLine = 'Reviewed  point with preserved double spaces';
const spacedPayload = {multi_language_desc_list: [{language: 'en', name: `${spacedLine}\nline two\nline three\nline four\nline five`}]};
const sanitizedSpacedEcho = __testHooks.sanitizePublishPlatformText(spacedLine.replace(/\s+/g, ' '), spacedPayload, 300);
check('whitespace-variant description echo is hash-only', sanitizedSpacedEcho, value => /^\[平台回显内容已脱敏 sha256=[a-f0-9]{64}\]$/.test(value) && !value.includes('Reviewed point'));

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
const hlPriceRepeat = __testHooks.applyRandomSupplyPrice(clone(basePayload), priceTask, {}, 'HL');
const tzPrice = __testHooks.applyRandomSupplyPrice(clone(basePayload), priceTask, {}, 'TZ');
const hlSkuPrices = asArray(hlPrice.payload.skc_list?.[0]?.sku_list).map(row => row.cost_info?.cost_price);
const tzSkuPrices = asArray(tzPrice.payload.skc_list?.[0]?.sku_list).map(row => row.cost_info?.cost_price);
check('HL randomized all SKUs to one per-store price', new Set(hlSkuPrices).size, 1);
check('TZ randomized all SKUs to one per-store price', new Set(tzSkuPrices).size, 1);
check('random price in configured range', [...hlSkuPrices, ...tzSkuPrices].every(v => Number(v) >= 310 && Number(v) <= 347), true);
check('random price differs by store bucket', hlSkuPrices[0] !== tzSkuPrices[0], true);
check('randomized price is deterministic across preflight and execute', JSON.stringify(hlPriceRepeat.payload), JSON.stringify(hlPrice.payload));

const shuffleTask = {id: 'copy-task-1', shuffleImages: true};
const shuffled = __testHooks.shufflePublishDetailImages(clone(basePayload), shuffleTask, {}, 'HL');
const shuffledRepeat = __testHooks.shufflePublishDetailImages(clone(basePayload), shuffleTask, {}, 'HL');
const shuffledRows = shuffled.payload.skc_list[0].image_info.image_info_list;
const globallyUnique = __testHooks.ensurePublishImageSortGlobalUnique(shuffled.payload).payload;
const finalRows = globallyUnique.skc_list[0].image_info.image_info_list;
check('shuffleImages emits applied changes', shuffled.applied.length > 0, true);
check('main image remains sort=1', finalRows.find(row => Number(row.image_type) === 1)?.image_sort, 1);
check('square image keeps original sort position', finalRows.find(row => Number(row.image_type) === 5)?.image_sort, 3);
check('detail image sorts fill non-reserved positions only', finalRows.filter(row => Number(row.image_type) === 2).map(row => Number(row.image_sort)).sort((a, b) => a - b).join(','), '2,4,5');
check('image sorts remain globally unique', new Set(finalRows.map(row => Number(row.image_sort))).size, finalRows.length);
check('detail image shuffle is deterministic across preflight and execute', JSON.stringify(shuffledRepeat.payload), JSON.stringify(shuffled.payload));

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

const officialTemplateResponse = {
  code: '0',
  msg: 'OK',
  info: {
    data: [{
      product_type_id: 9851,
      attribute_infos: [
        {
          attribute_id: 1002328,
          attribute_name: 'Hazardous materials classification',
          attribute_mode: 3,
          attribute_type: 4,
          attribute_status: 3,
          attribute_value_info_list: [
            {attribute_value_id: 316913742, attribute_value: 'Class 9 (Miscellaneous Dangerous Goods) - Lithium-ion batteries contained in equipment'},
            {attribute_value_id: 316914085, attribute_value: 'Class 9 (Miscellaneous Dangerous Goods) - Lithium-ion batteries packed with equipment'},
            {attribute_value_id: 316914660, attribute_value: 'This product is not classified as dangerous goods'},
          ],
        },
        {
          attribute_id: 1002322,
          attribute_name: 'Input voltage',
          attribute_mode: 4,
          attribute_type: 4,
          attribute_status: 2,
          attribute_value_info_list: [
            {attribute_value_id: 301114341, attribute_value: 'Vac 50–60Hz'},
            {attribute_value_id: 301121023, attribute_value: 'Vdc'},
          ],
        },
        {
          attribute_id: 1001466,
          attribute_name: 'Plug(Voltage)',
          attribute_mode: 1,
          attribute_type: 4,
          attribute_status: 2,
          attribute_value_info_list: [
            {attribute_value_id: 2535083, attribute_value: 'UK Plug(220-240V)'},
          ],
        },
        {
          attribute_id: 1000462,
          attribute_name: 'Hazard Category',
          attribute_mode: 1,
          attribute_type: 4,
          attribute_status: 2,
          attribute_value_info_list: [
            {attribute_value_id: 1006206, attribute_value: 'Others (Non-Transport Sensitive Items)'},
          ],
        },
        {
          attribute_id: 147,
          attribute_name: 'Power Supply',
          attribute_mode: 1,
          attribute_type: 4,
          attribute_status: 3,
          attribute_value_info_list: [
            {attribute_value_id: 1047, attribute_value: 'Wall Plug'},
            {attribute_value_id: 1007239, attribute_value: 'Power Adapter'},
          ],
        },
        {
          attribute_id: 1000616,
          attribute_name: 'Product Features',
          attribute_mode: 1,
          attribute_type: 4,
          attribute_status: 3,
          attribute_value_info_list: [{attribute_value_id: 1004580, attribute_value: 'None'}],
        },
        {
          attribute_id: 1000546,
          attribute_name: 'Product Model',
          attribute_mode: 0,
          attribute_type: 4,
          attribute_status: 3,
          attribute_value_info_list: [],
        },
      ],
    }],
  },
};
const templateClient = {
  async request(pathname) {
    if (pathname !== '/open-api/goods/query-attribute-template') throw new Error(`unexpected template path ${pathname}`);
    return {ok: true, status: 200, data: officialTemplateResponse};
  },
};
const sm505PowerAdapterPayload = {
  product_type_id: 9851,
  product_attribute_list: [
    {attribute_id: 1000546, attribute_extra_value: 'TXSM-505A'},
    {attribute_id: 1000616, attribute_value_id: 1004580},
    {attribute_id: 1000462, attribute_value_id: 1006206},
    {attribute_id: 147, attribute_value_id: 1007239},
    {attribute_id: 1001466, attribute_value_id: 2535083},
  ],
};
const templateApplied = await __testHooks.applyAttributeTemplateRules(templateClient, sm505PowerAdapterPayload);
const templateRows = asArray(templateApplied.payload.product_attribute_list);
const templateInputVoltage = templateRows.find(row => Number(row.attribute_id) === 1002322);
const templateHazardousClassification = templateRows.find(row => Number(row.attribute_id) === 1002328);
check('Power Adapter triggers required input voltage enrichment', templateInputVoltage?.attribute_extra_value, '220-240');
check('input voltage uses official Vac unit value id', templateInputVoltage?.attribute_value_id, 301114341);
check('non-transport-sensitive source maps to non-dangerous classification', templateHazardousClassification?.attribute_value_id, 316914660);
check('all official required template attributes are present', templateApplied.blockers.length, 0);
check('template evidence retains final input voltage', templateApplied.evidence.finalProductAttributes.find(row => row.attributeId === 1002322)?.attributeExtraValue, '220-240');
check('template evidence retains final hazardous classification', templateApplied.evidence.finalProductAttributes.find(row => row.attributeId === 1002328)?.attributeValueId, 316914660);

function duplicateGuardClient({shelfStatus = 0, recycleStatus = 1, documentState = 3} = {}) {
  return {
    async request(pathname) {
      if (pathname === '/open-api/goods/searchProduct') {
        return {
          ok: true,
          status: 200,
          data: {
            code: '0',
            msg: 'OK',
            info: {
              data: [{
                spuName: 'v-existing-sm505',
                spuShelfStatus: shelfStatus,
                skcList: [{
                  skcName: 'sv-existing-sm505',
                  supplierCode: 'SM-505A电动缝纫机',
                  skcShelfStatus: shelfStatus,
                  skcSiteShelfStatusList: [{subSite: 'shein-sa', status: shelfStatus}],
                }],
              }],
              meta: {count: 1},
            },
          },
        };
      }
      if (pathname === '/open-api/goods/spu-info') {
        return {
          ok: true,
          status: 200,
          data: {
            code: '0',
            msg: 'OK',
            info: {
              spuName: 'v-existing-sm505',
              skcInfoList: [{
                skcName: 'sv-existing-sm505',
                supplierCode: 'SM-505A电动缝纫机',
                shelfStatusInfoList: [{siteAbbr: 'shein-sa', shelfStatus, lastUpdateTime: '2026-06-09 15:38:00'}],
                recycleInfoList: [{subSite: 'shein-sa', recycleStatus}],
              }],
            },
          },
        };
      }
      if (pathname === '/open-api/goods/query-document-state') {
        return {
          ok: true,
          status: 200,
          data: {
            code: '0',
            msg: 'OK',
            info: {data: [{spuName: 'v9000001', skcList: [{skcName: 'sv9000001', documentState}]}]},
          },
        };
      }
      throw new Error(`unexpected duplicate-guard path ${pathname}`);
    },
  };
}

const duplicateGuardPayload = {skc_list: [{supplier_code: 'SM-505A电动缝纫机'}]};
const recycledDuplicate = await __testHooks.inspectTargetDuplicateProducts(duplicateGuardClient({shelfStatus: 0, recycleStatus: 1}), duplicateGuardPayload, 'TZ');
check('historical recycled same-goods link does not silently block a confirmed new link', recycledDuplicate.blockers.length, 0);
check('historical recycled same-goods link is surfaced before confirmation', recycledDuplicate.warnings.some(text => /历史回收链接.*sv-existing-sm505/.test(text)), true);
check('historical recycled same-goods link evidence is classified', recycledDuplicate.evidence.recycledCount, 1);

const activeDuplicate = await __testHooks.inspectTargetDuplicateProducts(duplicateGuardClient({shelfStatus: 1, recycleStatus: 0}), duplicateGuardPayload, 'TZ');
check('active same-goods target link blocks duplicate publish', activeDuplicate.blockers.some(text => /已存在同货号在售链接.*sv-existing-sm505/.test(text)), true);
check('active same-goods target link evidence is classified', activeDuplicate.evidence.activeCount, 1);

const rejectedReplacementTask = {
  allowDuplicateNewPublish: true,
  notes: {
    repairMode: 'republish_rejected',
    replacesRejectedTarget: {store: 'TZ', spu: 'v9000001', skc: 'sv9000001', state: 3},
  },
};
const forgedRejected = await __testHooks.inspectTargetDuplicateProducts(
  duplicateGuardClient({shelfStatus: 1, recycleStatus: 0, documentState: 2}),
  duplicateGuardPayload,
  'TZ',
  rejectedReplacementTask,
);
check('task-declared rejection cannot bypass live state 2', forgedRejected.blockers.some(text => /已存在同货号在售链接/.test(text)), true);
check('live state 2 rejection override is denied', forgedRejected.evidence.rejectedReplacementOverride.liveValidation.documentState, 2);
const verifiedRejected = await __testHooks.inspectTargetDuplicateProducts(
  duplicateGuardClient({shelfStatus: 1, recycleStatus: 0, documentState: 3}),
  duplicateGuardPayload,
  'TZ',
  rejectedReplacementTask,
);
check('live state 3 rejection override allows one replacement', verifiedRejected.blockers.length, 0);
check('live state 3 rejection override is audited', verifiedRejected.evidence.rejectedReplacementOverride.liveValidation.status, 'verified_terminal_rejected');

const withdrawnReplacementTask = {
  allowDuplicateNewPublish: true,
  notes: {
    repairMode: 'republish_withdrawn',
    replacesWithdrawnTarget: {store: 'TZ', spu: 'v9000001', skc: 'sv9000001', state: 4},
  },
};
const verifiedWithdrawn = await __testHooks.inspectTargetDuplicateProducts(
  duplicateGuardClient({shelfStatus: 1, recycleStatus: 0, documentState: 4}),
  duplicateGuardPayload,
  'TZ',
  withdrawnReplacementTask,
);
check('live state 4 withdrawn override allows one replacement', verifiedWithdrawn.blockers.length, 0);
check('live state 4 withdrawn override is audited', verifiedWithdrawn.evidence.rejectedReplacementOverride.liveValidation.status, 'verified_terminal_withdrawn');

const ok = checks.every(row => row.pass);
console.log(JSON.stringify({ok, checks}, null, 2));
if (!ok) process.exit(1);
