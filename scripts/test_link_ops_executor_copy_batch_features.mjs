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

// --- 6863 pre-validation diagnostics: redaction is fragment-driven, so
// ordinary platform pre-valid messages stay visible while any exact,
// substring, or whitespace-variant echo of reviewed description text is
// still hash-only before truncation. ---
const descPayload = {multi_language_desc_list: [
  {language: 'en', name: 'Reviewed EN five lines\nsecond line\nthird line\nfourth line\nfifth line'},
  {language: 'ar', name: 'وصف عربي مراجعة\nسطر ثاني\nسطر ثالث\nسطر رابع\nسطر خامس'},
]};
const ordinaryPreValidMessage = 'sku_code 不能为空：请填写库存 sku_code 后再提交';
check('non-allowlisted platform free text is hash-only when descriptions exist', __testHooks.sanitizePublishPlatformText(ordinaryPreValidMessage, descPayload, 300), value => /^\[平台回显内容已脱敏 sha256=[a-f0-9]{64}\]$/.test(value));
check('non-allowlisted field label is hash-only when descriptions exist', __testHooks.sanitizePublishPlatformText('sku_info_list', descPayload, 80), value => /^\[平台回显内容已脱敏 sha256=[a-f0-9]{64}\]$/.test(value));
const safeInputCurrentDiagnostic = 'Because Power Supply(147) selected Wall Plug(1047), Input current(1002323) is required';
check('allowlisted input-current diagnostic stays visible', __testHooks.sanitizePublishPlatformText(safeInputCurrentDiagnostic, descPayload, 300), safeInputCurrentDiagnostic);
const longOrdinaryDiagnostic = `base_info 缺少必填字段：${'sku_code '.repeat(60)}请补充后再提交`;
check('long non-allowlisted diagnostic is hash-only', __testHooks.sanitizePublishPlatformText(longOrdinaryDiagnostic, descPayload, 300), value => /^\[平台回显内容已脱敏 sha256=[a-f0-9]{64}\]$/.test(value));
check('exact multi-line description echo is hash-only', __testHooks.sanitizePublishPlatformText(descPayload.multi_language_desc_list[0].name, descPayload, 300), value => /^\[平台回显内容已脱敏 sha256=[a-f0-9]{64}\]$/.test(value));
check('embedded exact description line echo is hash-only', __testHooks.sanitizePublishPlatformText('field error: second line', descPayload, 300), value => /^\[平台回显内容已脱敏 sha256=[a-f0-9]{64}\]$/.test(value) && !value.includes('second line'));
const longSingleLine = `Reviewed long single-line point ${'y'.repeat(360)}`;
const truncatedEchoPayload = {multi_language_desc_list: [
  {language: 'en', name: `${longSingleLine}\nsecond line\nthird line\nfourth line\nfifth line`},
]};
const platformCutEcho = __testHooks.sanitizePublishPlatformText(`desc error: ${longSingleLine.slice(0, 180)}`, truncatedEchoPayload, 300);
check('platform-truncated long description echo is hash-only before truncation', platformCutEcho, value => /^\[平台回显内容已脱敏 sha256=[a-f0-9]{64}\]$/.test(value) && !value.includes(longSingleLine.slice(0, 80)));
const spacedLongLine = `Reviewed  double-spaced  long  point ${'z'.repeat(360)}`;
const spacedLongPayload = {multi_language_desc_list: [
  {language: 'en', name: `${spacedLongLine}\nsecond line\nthird line\nfourth line\nfifth line`},
]};
const wrappedCollapsedEcho = __testHooks.sanitizePublishPlatformText(spacedLongLine.replace(/\s+/g, ' ').slice(0, 160), spacedLongPayload, 300);
check('whitespace-collapsed truncated long echo is hash-only', wrappedCollapsedEcho, value => /^\[平台回显内容已脱敏 sha256=[a-f0-9]{64}\]$/.test(value) && !value.includes('Reviewed double-spaced long point'));

// --- 6863 redaction boundaries: complete short reviewed lines (1-3 chars)
// and partial echoes below the long-window threshold still redact, while a
// one-character token inside an unrelated larger diagnostic stays visible. ---
const shortLinesPayload = {multi_language_desc_list: [{language: 'en', name: 'x\nab\nabc\ndefghij\nklmnopqr'}]};
check('one-char reviewed line exact echo is hash-only', __testHooks.sanitizePublishPlatformText('x', shortLinesPayload, 300), value => /^\[平台回显内容已脱敏 sha256=[a-f0-9]{64}\]$/.test(value));
check('two-char reviewed line echo is hash-only', __testHooks.sanitizePublishPlatformText('value ab value', shortLinesPayload, 300), value => /^\[平台回显内容已脱敏 sha256=[a-f0-9]{64}\]$/.test(value));
check('three-char reviewed line echo is hash-only', __testHooks.sanitizePublishPlatformText('prefix abc suffix', shortLinesPayload, 300), value => /^\[平台回显内容已脱敏 sha256=[a-f0-9]{64}\]$/.test(value) && !value.includes('abc'));
check('one-char reviewed line as standalone token is hash-only', __testHooks.sanitizePublishPlatformText('please enter x value', shortLinesPayload, 300), value => /^\[平台回显内容已脱敏 sha256=[a-f0-9]{64}\]$/.test(value));
check('one-char token inside non-allowlisted free text remains hash-only', __testHooks.sanitizePublishPlatformText('max value required', shortLinesPayload, 300), value => /^\[平台回显内容已脱敏 sha256=[a-f0-9]{64}\]$/.test(value));
check('unrelated non-allowlisted diagnostic remains hash-only', __testHooks.sanitizePublishPlatformText('sku_code 不能为空：请填写库存 sku_code 后再提交', shortLinesPayload, 300), value => /^\[平台回显内容已脱敏 sha256=[a-f0-9]{64}\]$/.test(value));
const partialLine = `Reviewed partial echo line ${'q'.repeat(200)}`;
const partialPayload = {multi_language_desc_list: [{language: 'en', name: `${partialLine}\nsecond\nthird\nfourth\nfifth`}]};
const prefix63Echo = __testHooks.sanitizePublishPlatformText(`err: ${partialLine.slice(0, 63)}`, partialPayload, 300);
check('63-char prefix partial echo is hash-only', prefix63Echo, value => /^\[平台回显内容已脱敏 sha256=[a-f0-9]{64}\]$/.test(value) && !value.includes(partialLine.slice(0, 32)));
const prefix31Echo = __testHooks.sanitizePublishPlatformText(`err: ${partialLine.slice(0, 31)}`, partialPayload, 300);
check('31-char prefix partial echo is hash-only', prefix31Echo, value => /^\[平台回显内容已脱敏 sha256=[a-f0-9]{64}\]$/.test(value) && !value.includes(partialLine.slice(0, 16)));
const middle63Echo = __testHooks.sanitizePublishPlatformText(`err: ${partialLine.slice(40, 103)}`, partialPayload, 300);
check('63-char middle partial echo is hash-only', middle63Echo, value => /^\[平台回显内容已脱敏 sha256=[a-f0-9]{64}\]$/.test(value));
const suffix63Echo = __testHooks.sanitizePublishPlatformText(`err: ${partialLine.slice(-63)}`, partialPayload, 300);
check('63-char suffix partial echo is hash-only', suffix63Echo, value => /^\[平台回显内容已脱敏 sha256=[a-f0-9]{64}\]$/.test(value));
const spacedPartialLine = `Reviewed  partial  echo  line ${'w'.repeat(180)}`;
const spacedPartialPayload = {multi_language_desc_list: [{language: 'en', name: `${spacedPartialLine}\nsecond\nthird\nfourth\nfifth`}]};
const spacedPartial63 = __testHooks.sanitizePublishPlatformText(spacedPartialLine.replace(/\s+/g, ' ').slice(0, 63), spacedPartialPayload, 300);
check('63-char whitespace-collapsed partial echo is hash-only', spacedPartial63, value => /^\[平台回显内容已脱敏 sha256=[a-f0-9]{64}\]$/.test(value) && !value.includes('Reviewed partial echo line'));

// --- 6863 tri-state publish success: compact storage keeps missing success
// as undefined; only explicit false may prove publish_pre_valid_failed. ---
const triStateMissing = __testHooks.compactPublishResultForStorage({code: '0', msg: 'OK', info: {}}, {});
check('compact storage keeps missing success as undefined', triStateMissing?.info?.success, undefined);
const triStateFalse = __testHooks.compactPublishResultForStorage({code: '0', msg: 'OK', info: {success: false}}, {});
check('compact storage keeps explicit success=false', triStateFalse?.info?.success, false);
const triStateTrue = __testHooks.compactPublishResultForStorage({code: '0', msg: 'OK', info: {success: true}}, {});
check('compact storage keeps explicit success=true', triStateTrue?.info?.success, true);
for (const [label, value] of [['null', null], ['zero', 0], ['string-false', 'false']]) {
  const compact = __testHooks.compactPublishResultForStorage({code: '0', msg: 'OK', info: {success: value}}, {});
  check(`compact storage keeps ${label} success unknown`, compact?.info?.success, undefined);
}
const inheritedInfo = Object.create({success: false});
const inheritedCompact = __testHooks.compactPublishResultForStorage({code: '0', msg: 'OK', info: inheritedInfo}, {});
check('compact storage rejects inherited success=false', inheritedCompact?.info?.success, undefined);

// Compact storage and blocker construction route every platform echo through
// the sanitizer: no reviewed fragment can survive into stored or blocker text.
const preValidInfo = {
  success: false,
  pre_valid_result: [
    {module: 'attribute', form_name: '商品属性', messages: [safeInputCurrentDiagnostic]},
    {module: 'desc', form_name: 'description', messages: [`description invalid: ${longSingleLine.slice(0, 150)}`, 'second line']},
  ],
};
const preValidMessages = __testHooks.publishPreValidMessages(preValidInfo, truncatedEchoPayload);
check('pre-valid diagnostics keep allowlisted structured field message visible', preValidMessages.some(text => text.includes(safeInputCurrentDiagnostic)), true);
check('pre-valid diagnostics redact truncated description echoes', preValidMessages.some(text => /平台回显内容已脱敏/.test(text)), true);
check('pre-valid diagnostics redact exact line echoes', preValidMessages.some(text => /平台回显内容已脱敏/.test(text) && !text.includes('second line')), true);
check('pre-valid diagnostics never leak reviewed fragments', preValidMessages.every(text => !text.includes(longSingleLine.slice(0, 60)) && !text.includes('second line') && !text.includes('Reviewed EN five lines')), true);
const storedResult = __testHooks.compactPublishResultForStorage({
  httpStatus: 200,
  code: '0',
  msg: `description invalid: ${longSingleLine.slice(0, 150)}`,
  traceId: 't-6863',
  info: preValidInfo,
}, truncatedEchoPayload);
const storedJson = JSON.stringify(storedResult);
check('compact storage redacts description echoes in msg', /平台回显内容已脱敏/.test(storedResult.msg), true);
check('compact storage redacts description echoes in pre-valid rows', storedResult.info.pre_valid_result.some(row => row.messages.some(text => /平台回显内容已脱敏/.test(text))), true);
check('compact storage keeps allowlisted structured pre-valid message', storedResult.info.pre_valid_result.some(row => row.messages.includes(safeInputCurrentDiagnostic)), true);
check('compact storage never leaks reviewed fragments', !storedJson.includes(longSingleLine.slice(0, 60)) && !storedJson.includes('second line') && !storedJson.includes('Reviewed EN five lines'), true);
const blockerText = `publishOrEdit 平台预校验失败，未创建新链接：${preValidMessages.join('；')}`;
check('blocker construction never leaks reviewed fragments', !blockerText.includes(longSingleLine.slice(0, 60)) && !blockerText.includes('second line') && !blockerText.includes('Reviewed EN five lines'), true);

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

// --- 03012 readback identity binding: pending review must never fall back to an
// old same-goods-number link, and supplier-code-only matches are demoted when the
// publishOrEdit-returned new identity is known. ---
function readbackClient({spuInfoResult, searchResult, productQueryResult}) {
  const calls = [];
  return {
    calls,
    async request(pathname, opts) {
      calls.push({pathname, body: opts?.body});
      if (pathname === '/open-api/goods/spu-info') return spuInfoResult;
      if (pathname === '/open-api/goods/searchProduct') return searchResult;
      if (pathname === '/open-api/openapi-business-backend/product/query') return productQueryResult;
      throw new Error(`unexpected path ${pathname}`);
    },
    async requestReadOnly(pathname, opts) {
      return this.request(pathname, opts);
    },
  };
}
const newIdentityFingerprint = {
  targetStore: 'HL',
  taskId: '03012',
  taskProductRefs: [],
  publishSpuNames: ['v2608132357607966'],
  publishSkcNames: ['sv260813235760796666648'],
  publishSkuCodes: ['SPMP260813353184931'],
  targetSupplierCodes: ['HL-03012-SN'],
  targetSupplierSkus: ['HL-03012-SKU1'],
  targetPlatformSkuCodes: [],
  targetPlatformSkcNames: [],
};
const oldLinkRow = {spuName: 'v2602011917311806', skcName: 'sv-old', supplierCode: 'HL-03012-SN', skuCodeList: ['HL-03012-SKU1']};
const newLinkRow = {spuName: 'v2608132357607966', skcName: 'sv260813235760796666648', supplierCode: 'HL-03012-SN', skuCodeList: ['SPMP260813353184931']};
const demotedOld = __testHooks.matchProductReadbackRows([oldLinkRow], newIdentityFingerprint);
check('old same-goods link is not reliable readback when new identity is known', demotedOld.strong.length, 0);
check('old same-goods link demotion is explicit', demotedOld.weak[0]?.weakMatchReasons.some(reason => reason.startsWith('sameGoodsNumberOldLinkWithoutPublishIdentity:')), true);
const matchedNewLink = __testHooks.matchProductReadbackRows([newLinkRow], newIdentityFingerprint);
check('new identity row stays a strong readback', matchedNewLink.strong.length, 1);
const legacyFingerprint = {...newIdentityFingerprint, publishSpuNames: [], publishSkcNames: [], publishSkuCodes: []};
const legacyMatchedOld = __testHooks.matchProductReadbackRows([oldLinkRow], legacyFingerprint);
check('supplier-code match stays strong without publish identity (legacy semantics)', legacyMatchedOld.strong.length, 1);

const pendingSpuInfoResult = {ok: true, status: 200, data: {code: '0003', msg: 'audit pending', info: null}};
const pendingSearchResult = {ok: true, status: 200, data: {code: '0', msg: 'OK', info: {data: [oldLinkRow]}}};
const pendingProductQueryResult = {ok: true, status: 200, data: {code: '0', msg: 'OK', info: {data: []}}};
const pendingReadbackClient = readbackClient({spuInfoResult: pendingSpuInfoResult, searchResult: pendingSearchResult, productQueryResult: pendingProductQueryResult});
const pendingReadback = await __testHooks.readbackPublishedProduct(pendingReadbackClient, newIdentityFingerprint, {enabled: true, task: null});
check('pending-review spu-info is an explicit unverifiable state', pendingReadback.status, 'new_identity_pending_review_unverifiable');
check('pending-review readback is not ok but not a mismatch failure', pendingReadback.ok, false);
check('pending-review readback marks pendingReview', pendingReadback.pendingReview, true);
check('pending-review readback still runs searchProduct strong fallbacks', pendingReadbackClient.calls.some(call => call.pathname === '/open-api/goods/searchProduct'), true);
check('pending-review readback keeps old-link rows as weak only', pendingReadback.weakMatchedRows.some(row => row.weakMatchReasons.some(reason => reason.startsWith('sameGoodsNumberOldLinkWithoutPublishIdentity:'))), true);
check('pending-review readback never binds the old link', pendingReadback.matchedRows.length, 0);

const matchedSpuInfoResult = {ok: true, status: 200, data: {code: '0', msg: 'OK', info: newLinkRow}};
const matchedReadbackClient = readbackClient({spuInfoResult: matchedSpuInfoResult, searchResult: pendingSearchResult});
const matchedReadback = await __testHooks.readbackPublishedProduct(matchedReadbackClient, newIdentityFingerprint, {enabled: true, task: null});
check('available new-identity spu-info still strong-matches', matchedReadback.status, 'matched_publish_spu_in_spu_info');
check('available new-identity spu-info readback is ok', matchedReadback.ok, true);

// --- 15032/794 input voltage provenance: when the official target template does
// not return Input voltage(1002322), fill ONLY from same-goods-number OpenAPI
// links with provenance; missing/ambiguous/different-goods-number keep blocker. ---
const voltageTemplateResponse = {
  code: '0',
  msg: 'OK',
  info: {
    data: [{
      product_type_id: 9851,
      attribute_infos: [
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
          attribute_id: 1001466,
          attribute_name: 'Plug(Voltage)',
          attribute_mode: 1,
          attribute_type: 4,
          attribute_status: 2,
          attribute_value_info_list: [
            {attribute_value_id: 2535083, attribute_value: 'UK Plug(220-240V)'},
          ],
        },
      ],
    }],
  },
};
function provenanceClient({searchRows, spuInfoBySpu, templateResponse = voltageTemplateResponse}) {
  const calls = {searchProduct: 0, spuInfo: 0};
  return {
    calls,
    async request(pathname, opts) {
      if (pathname === '/open-api/goods/query-attribute-template') return {ok: true, status: 200, data: templateResponse};
      if (pathname === '/open-api/goods/searchProduct') {
        calls.searchProduct += 1;
        calls.lastSearchBody = opts?.body;
        return {ok: true, status: 200, data: {code: '0', msg: 'OK', info: {data: searchRows}}};
      }
      if (pathname === '/open-api/goods/spu-info') {
        calls.spuInfo += 1;
        const spuName = opts?.body?.spuName;
        return {ok: true, status: 200, data: {code: '0', msg: 'OK', info: spuInfoBySpu[spuName] || null}};
      }
      throw new Error(`unexpected path ${pathname}`);
    },
  };
}
const wallPlugPayload = {
  product_type_id: 9851,
  product_attribute_list: [
    {attribute_id: 147, attribute_value_id: 1047, attribute_name: 'Power Supply'},
    {attribute_id: 1001466, attribute_value: '220-240V', attribute_name: 'Plug Voltage'},
  ],
  skc_list: [{supplier_code: 'HL-03012-SN', sale_name: 'Wall Plug'}],
};
const exactSourceContext = {
  copyProductDraft: true,
  exactSourceLock: true,
  sourceStore: 'DL',
  sourceSkc: 'sv-dl-source',
  standardGoodsSn: 'HL-03012-SN',
  sourcePayloadSupplierCodes: ['HL-03012-SN'],
};
// Locked owner authorization: the locked copy payload itself (exact DL
// sourceSkc) already carries official Plug(Voltage)=220-240V, so the
// deterministic range inference fills 1002322 without any live lookup.
const voltageLockedPayloadClient = provenanceClient({searchRows: [], spuInfoBySpu: {}});
const voltageApplied = await __testHooks.applyAttributeTemplateRules(
  voltageLockedPayloadClient,
  clone(wallPlugPayload),
  exactSourceContext,
);
const voltageRow = voltageApplied.payload.product_attribute_list.find(row => Number(row.attribute_id) === 1002322);
check('locked payload Plug(Voltage) fills 1002322 value id', voltageRow?.attribute_value_id, 301114341);
check('locked payload Plug(Voltage) keeps extra value', voltageRow?.attribute_extra_value, '220-240');
check('locked payload provenance has no blockers', voltageApplied.blockers.length, 0);
check('locked payload provenance is audited', voltageApplied.applied.some(item => item.startsWith('attribute_provenance:1002322.from_locked_source_payload.1001466')), true);
check('locked payload provenance marks official catalog mapping', voltageApplied.applied.some(item => item === 'official_catalog_mapping:1002322.vac_value_id=301114341'), true);
check('locked payload provenance evidence is ok', voltageApplied.evidence.inputVoltageProvenance?.status, 'ok');
check('locked payload provenance source is locked_source_payload', voltageApplied.evidence.inputVoltageProvenance?.source, 'locked_source_payload');
check('locked payload provenance records source store', voltageApplied.evidence.inputVoltageProvenance?.sourceStore, 'DL');
check('locked payload provenance records source skc', voltageApplied.evidence.inputVoltageProvenance?.sourceSkc, 'sv-dl-source');
check('locked payload provenance records standard goods number', voltageApplied.evidence.inputVoltageProvenance?.standardGoodsNumber, 'HL-03012-SN');
check('locked payload provenance never queries the target store', voltageLockedPayloadClient.calls.searchProduct, 0);
const voltageRepeated = await __testHooks.applyAttributeTemplateRules(voltageLockedPayloadClient, clone(wallPlugPayload), exactSourceContext);
check('locked payload provenance is deterministic for payload hash', __testHooks.sha256Stable(voltageRepeated.payload), __testHooks.sha256Stable(voltageApplied.payload));
check('payload hash covers the provenance-filled attribute', __testHooks.sha256Stable(voltageApplied.payload) !== __testHooks.sha256Stable(clone(wallPlugPayload)), true);

// Guard failures all keep the blocker and never touch the payload.
const guardEmptyBlocked = await __testHooks.applyAttributeTemplateRules(
  provenanceClient({searchRows: [], spuInfoBySpu: {}}),
  clone(wallPlugPayload),
  {},
);
check('empty source context blocks input voltage provenance', guardEmptyBlocked.blockers.some(text => /必须人工补充 Input voltage/.test(text)), true);
check('empty source context does not fill payload', guardEmptyBlocked.payload.product_attribute_list.some(row => Number(row.attribute_id) === 1002322), false);

const guardNonCopyBlocked = await __testHooks.applyAttributeTemplateRules(
  provenanceClient({searchRows: [], spuInfoBySpu: {}}),
  clone(wallPlugPayload),
  {...exactSourceContext, copyProductDraft: false},
);
check('non-copy intent blocks input voltage provenance', guardNonCopyBlocked.blockers.some(text => /不是精确的 copy_product_draft/.test(text)), true);
check('non-copy intent does not fill payload', guardNonCopyBlocked.payload.product_attribute_list.some(row => Number(row.attribute_id) === 1002322), false);

const guardImpreciseBlocked = await __testHooks.applyAttributeTemplateRules(
  provenanceClient({searchRows: [], spuInfoBySpu: {}}),
  clone(wallPlugPayload),
  {...exactSourceContext, exactSourceLock: false},
);
check('imprecise source blocks input voltage provenance', guardImpreciseBlocked.blockers.some(text => /来源不是本次 findOrBuild 的精确 source lock/.test(text)), true);

const guardMismatchBlocked = await __testHooks.applyAttributeTemplateRules(
  provenanceClient({searchRows: [], spuInfoBySpu: {}}),
  clone(wallPlugPayload),
  {...exactSourceContext, sourcePayloadSupplierCodes: ['OTHER-GOODS-A']},
);
check('source payload goods A with task goods B blocks provenance', guardMismatchBlocked.blockers.some(text => /与任务目标标准货号/.test(text)), true);
check('goods-number mismatch does not fill payload', guardMismatchBlocked.payload.product_attribute_list.some(row => Number(row.attribute_id) === 1002322), false);

const guardPunctuationMismatchBlocked = await __testHooks.applyAttributeTemplateRules(
  provenanceClient({searchRows: [], spuInfoBySpu: {}}),
  clone(wallPlugPayload),
  {...exactSourceContext, sourcePayloadSupplierCodes: ['HL03012SN']},
);
check('HL03012SN vs HL-03012-SN strict identity blocks provenance', guardPunctuationMismatchBlocked.blockers.some(text => /与任务目标标准货号/.test(text)), true);
check('strict identity mismatch does not fill payload', guardPunctuationMismatchBlocked.payload.product_attribute_list.some(row => Number(row.attribute_id) === 1002322), false);

const guardMissingIntentBlocked = await __testHooks.applyAttributeTemplateRules(
  provenanceClient({searchRows: [], spuInfoBySpu: {}}),
  clone(wallPlugPayload),
  {...exactSourceContext, copyProductDraft: undefined},
);
check('missing copy intent blocks the provenance path', guardMissingIntentBlocked.blockers.some(text => /必须人工补充 Input voltage/.test(text)), true);
check('missing copy intent does not fill payload', guardMissingIntentBlocked.payload.product_attribute_list.some(row => Number(row.attribute_id) === 1002322), false);

const guardUnresolvableBlocked = await __testHooks.applyAttributeTemplateRules(
  provenanceClient({searchRows: [], spuInfoBySpu: {}}),
  {
    ...wallPlugPayload,
    product_attribute_list: [
      {attribute_id: 147, attribute_value_id: 1047, attribute_name: 'Power Supply'},
      {attribute_id: 1001466, attribute_value_id: 999999, attribute_name: 'Plug Voltage'},
    ],
  },
  exactSourceContext,
);
check('unresolvable locked payload keeps blocker', guardUnresolvableBlocked.blockers.some(text => /无法推导电压范围/.test(text)), true);
check('unresolvable locked payload does not fill', guardUnresolvableBlocked.payload.product_attribute_list.some(row => Number(row.attribute_id) === 1002322), false);
check('unresolvable provenance evidence is unresolvable', guardUnresolvableBlocked.evidence.inputVoltageProvenance?.status, 'unresolvable');

// Scope hash v2: the same body with a different locked source store/sourceSkc
// or target goods number must produce a different execution lock hash.
const scopeDl = {payload: clone(wallPlugPayload), sourceStore: 'DL', sourceSkc: 'A', standardGoodsSn: 'HL-03012-SN'};
const scopeMz = {payload: clone(wallPlugPayload), sourceStore: 'MZ', sourceSkc: 'B', standardGoodsSn: 'HL-03012-SN'};
check('scope hash differs when source store/skc drift', __testHooks.sha256Stable(scopeDl) !== __testHooks.sha256Stable(scopeMz), true);
const scopeOtherGoods = {payload: clone(wallPlugPayload), sourceStore: 'DL', sourceSkc: 'A', standardGoodsSn: 'HL-OTHER-SN'};
check('scope hash differs when target goods number drifts', __testHooks.sha256Stable(scopeDl) !== __testHooks.sha256Stable(scopeOtherGoods), true);
check('scope hash is stable for identical scope', __testHooks.sha256Stable(scopeDl), __testHooks.sha256Stable({...scopeDl}));

const voltageConflictTemplateResponse = {
  code: '0',
  msg: 'OK',
  info: {
    data: [{
      product_type_id: 9851,
      attribute_infos: [
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
          attribute_id: 1002322,
          attribute_name: 'Input voltage',
          attribute_mode: 4,
          attribute_type: 4,
          attribute_status: 2,
          attribute_value_info_list: [
            {attribute_value_id: 999999, attribute_value: 'Vac 50–60Hz'},
          ],
        },
      ],
    }],
  },
};
const voltageConflictClient = provenanceClient({searchRows: [], spuInfoBySpu: {}, templateResponse: voltageConflictTemplateResponse});
const voltageConflict = await __testHooks.applyAttributeTemplateRules(voltageConflictClient, clone(wallPlugPayload), exactSourceContext);
const conflictRow = voltageConflict.payload.product_attribute_list.find(row => Number(row.attribute_id) === 1002322);
check('template Vac unit id conflict blocks instead of adopting 999999', voltageConflict.blockers.some(text => /冲突/.test(text)), true);
check('template conflict evidence is unit_value_id_conflict', voltageConflict.evidence.inputVoltageProvenance?.status, 'unit_value_id_conflict');
check('template conflict records the conflicting template id', voltageConflict.evidence.inputVoltageProvenance?.templateVacValueId, 999999);
check('template conflict never fills 1002322', Boolean(conflictRow), false);

// --- exact source SKC -> SPU resolution for bound-payload copies ---
function skcSearchClient(rows, {fail = false} = {}) {
  return {
    calls: [],
    async request(pathname, opts) {
      this.calls.push({pathname, body: opts?.body});
      if (fail) throw new Error('search exploded');
      return {ok: true, status: 200, data: {code: '0', msg: 'OK', info: {data: rows}}};
    },
  };
}
const skcRow = spu => ({spuName: spu, skcList: [{skcName: 'sv25082902871830770'}]});
const skcUnique = await __testHooks.resolveSourceSpuByExactSkc(skcSearchClient([skcRow('v25082902871830770')]), 'DL', 'sv25082902871830770');
check('exact SKC search resolves the unique SPU', skcUnique.ok && skcUnique.spuName, 'v25082902871830770');
check('exact SKC search audit records searchProduct', skcUnique.call?.path, '/open-api/goods/searchProduct');
const skcCaseMismatch = await __testHooks.resolveSourceSpuByExactSkc(skcSearchClient([skcRow('v25082902871830770')]), 'DL', 'SV25082902871830770');
check('case-variant SKC never matches', skcCaseMismatch.ok, false);
check('case-variant SKC is not_found', skcCaseMismatch.reason, 'not_found');
const skcZero = await __testHooks.resolveSourceSpuByExactSkc(skcSearchClient([]), 'DL', 'sv25082902871830770');
check('zero search results block', skcZero.ok, false);
check('zero search results reason', skcZero.reason, 'not_found');
const skcAmbiguous = await __testHooks.resolveSourceSpuByExactSkc(skcSearchClient([skcRow('v-a'), skcRow('v-b')]), 'DL', 'sv25082902871830770');
check('multiple SPUs block as ambiguous', skcAmbiguous.ok, false);
check('multiple SPUs reason', skcAmbiguous.reason, 'ambiguous');
const skcFailed = await __testHooks.resolveSourceSpuByExactSkc(skcSearchClient([], {fail: true}), 'DL', 'sv25082902871830770');
check('search failure blocks', skcFailed.ok, false);
check('search failure reason', skcFailed.reason, 'query_failed');

// --- source scope boundary: no declaration is allowed, partial/multi/conflict blocks ---
const scopeNoSource = __testHooks.resolveLockedSourceScope({payloadFound: {}, task: {targets: {}}, intents: ['copy_product_draft']});
check('copy without any declared source is not globally blocked', scopeNoSource.blockers.length, 0);
check('copy without declared source keeps empty stable scope', scopeNoSource.sourceStore, '');
const scopePartialStore = __testHooks.resolveLockedSourceScope({payloadFound: {}, task: {targets: {sourceStores: ['DL']}}, intents: ['copy_product_draft']});
check('store-only partial declaration blocks', scopePartialStore.blockers.length, 1);
const scopePartialSkc = __testHooks.resolveLockedSourceScope({payloadFound: {}, task: {targets: {sourceSkc: 'sv25082902871830770'}}, intents: ['copy_product_draft']});
check('skc-only partial declaration blocks', scopePartialSkc.blockers.length, 1);
const scopeMulti = __testHooks.resolveLockedSourceScope({payloadFound: {}, task: {targets: {sourceStores: ['DL', 'MZ'], sourceSkc: 'sv25082902871830770'}}, intents: ['copy_product_draft']});
check('multi-valued sourceStores block', scopeMulti.blockers.length, 1);
const scopeConflict = __testHooks.resolveLockedSourceScope({payloadFound: {inferred: {sourceStore: 'MZ', sourceSkc: 'sv-mz'}}, task: {targets: {sourceStores: ['DL'], sourceSkc: 'sv25082902871830770'}}, intents: ['copy_product_draft']});
check('exact source conflict with inferred blocks', scopeConflict.blockers.length, 2);
const scopeExact175 = __testHooks.resolveLockedSourceScope({payloadFound: {}, task: {targets: {sourceStores: ['DL'], sourceSkc: 'sv25082902871830770'}}, intents: ['copy_product_draft']});
check('exact source keeps DL/sourceSkc', scopeExact175.sourceStore, 'DL');
check('exact source keeps the skc', scopeExact175.sourceSkc, 'sv25082902871830770');
check('exact source has no blockers', scopeExact175.blockers.length, 0);

const ok = checks.every(row => row.pass);
console.log(JSON.stringify({ok, checks}, null, 2));
if (!ok) process.exit(1);
