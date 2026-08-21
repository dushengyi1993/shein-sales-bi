#!/usr/bin/env node
/**
 * Smoke test: copy_product_draft can enrich a source link payload from the
 * store-level OpenAPI product detail cache (`goods/spu-info`).
 *
 * Identity and freshness rules under test:
 * - exact sourceSkc: the detail entry AND its skcInfo must exactly hit the
 *   requested SKC; skcInfo never falls back to the first SKC row.
 * - current same-SPU detail missing the target SKC is an identity conflict:
 *   fail closed, and a cached fallback must NOT mask it.
 * - fallback is used only when current has neither the SPU nor the target SKC,
 *   and only when the row-level detailFetchedAt is valid, not in the future,
 *   and at most 24h before the build time; payload-level timestamps never
 *   masquerade as fallback freshness.
 * - provenance records the actual matched SPU/SKC, source, and detailFetchedAt.
 *
 * This uses a process-private output root and removes it in finally; it never
 * calls SHEIN and never enables real writes.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildProductDraftFromSnapshots, summarizeDraftForExecutor} from '../lib/link_ops_product_draft_mapper.mjs';
import {writeOpenApiProductCacheAtomically} from '../lib/shein_openapi_product_cache.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORE = 'SMK';
const DATE = '2099-01-01';
const SKC = 'sv20990101000000001';
const SPU = 'v209901010000';
const BUILD_NOW = new Date('2026-06-28T00:00:00+08:00'); // UTC 2026-06-27T16:00:00.000Z
const FETCHED_AT = '2026-06-28T00:00:00.000Z'; // payload-level snapshot time (current-hit provenance only)
const FRESH_AT = '2026-06-27T10:00:00.000Z'; // 6h before build -> fresh
const BOUNDARY_AT = '2026-06-26T16:00:00.000Z'; // exactly 24h before build -> allowed
const EXPIRED_AT = '2026-06-26T15:59:59.000Z'; // 24h + 1s -> expired
const FUTURE_AT = '2026-06-28T00:00:00.000Z'; // after build -> future
const tmpBase = path.join(ROOT, 'tmp');
await fs.mkdir(tmpBase, {recursive: true});
const tmpRoot = await fs.mkdtemp(path.join(tmpBase, 'link-ops-product-detail-'));
const testOutputDir = path.join(tmpRoot, 'outputs');
process.env.SHEIN_BI_OUTPUT_DIR = testOutputDir;
process.env.SHEIN_OPENAPI_PRODUCT_CACHE_DIR = path.join(testOutputDir, 'shein_openapi_products');

function check(checks, label, actual, expected) {
  const pass = typeof expected === 'function' ? expected(actual) : Object.is(actual, expected);
  checks.push({label, actual, expected: typeof expected === 'function' ? expected.toString() : expected, pass});
}

function hasOnlyPositiveSafeAttributeIds(value) {
  if (Array.isArray(value)) return value.every(hasOnlyPositiveSafeAttributeIds);
  if (!value || typeof value !== 'object') return true;
  for (const [key, item] of Object.entries(value)) {
    if ((key === 'attribute_id' || key === 'attributeId') && item !== undefined && item !== null && item !== '') {
      if (!Number.isSafeInteger(Number(item)) || Number(item) <= 0) return false;
    }
    if (!hasOnlyPositiveSafeAttributeIds(item)) return false;
  }
  return true;
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

const fixtureRoots = [
  path.join(testOutputDir, 'shein_links', STORE),
  path.join(testOutputDir, 'shein_links_raw', STORE),
  path.join(testOutputDir, 'shein_openapi_products', STORE),
];

async function writeLinkFixture() {
  await writeJson(path.join(testOutputDir, 'shein_links', STORE, `${DATE}.json`), {
    linkRows: [{
      storeKey: STORE,
      skc: SKC,
      spu: SPU,
      standardGoodsSn: 'SMK-505',
      productNameCn: 'SMK-505缝纫机',
      rawGoodsSn: 'SOURCE-RAW-SMK-505',
    }],
    inventoryRows: [],
    performanceRows: [],
  });
}

function completeDetailEntry() {
  return {
    ok: true,
    info: {
      spuName: SPU,
      categoryId: 13127,
      productTypeId: 9851,
      brandCode: '2a64l',
      supplierCode: 'SOURCE-SPU-SUPPLIER-505',
      productMultiNameList: [
        {language: 'en', productName: 'SMK 505 sewing machine'},
        {language: 'ar', productName: 'ماكينة خياطة اختبار'},
      ],
      productAttributeInfoList: [
        {attributeId: 1000546, attributeValueId: 0, attributeValue: 'TXSM-505A'},
        {attributeId: 160, attributeValueId: 62},
        {attributeId: 27, attributeValueId: 536},
        {attributeId: 1001466, attributeValueId: 2535083},
      ],
      skcInfoList: [{
        skcName: SKC,
        supplierCode: 'SOURCE-SKC-SUPPLIER-505',
        attributeId: 1001466,
        attributeValueId: 2535083,
        saleAttributeList: [{attributeId: 0, attributeValueId: 0}],
        skcImageInfoList: [
          {imageUrl: 'https://example.invalid/main.jpg', imageType: 'MAIN'},
          {imageUrl: 'https://example.invalid/detail.jpg', imageType: 'DETAIL'},
          {imageUrl: 'https://example.invalid/square.jpg', imageType: 'SQUARE'},
        ],
        skuInfoList: [{
          skuCode: 'SKU-SMK-505',
          supplierSku: '',
          length: '31.10',
          width: '29.50',
          height: '14.70',
          weight: 2500,
          sellerSkuWeight: {length: '31.10', width: '29.50', height: '14.70', weight: 2500},
          mallState: 1,
          saleAttributeList: [
            {attributeId: 27, attributeValueId: 536},
            {attributeId: '301', attributeValueId: '401'},
            {attributeId: 0, attributeValueId: 0},
            {attribute_id: 0, attribute_value_id: 0},
            {attributeId: 1.5, attributeValueId: 0},
            {attributeId: -7, attributeValueId: 0},
            {attributeId: 9007199254740993, attributeValueId: 0},
            {attribute_id: 'not-a-number', attribute_value_id: 0},
          ],
          costInfoList: [
            {currency: 'CNY', costPrice: 205.21},
            {currency: 'SAR', costPrice: 124.44},
          ],
        }],
      }],
    },
  };
}

function withSkcName(entry, skcName) {
  return {
    ...entry,
    info: {
      ...entry.info,
      skcInfoList: [{...entry.info.skcInfoList[0], skcName}],
    },
  };
}

function withSpuName(entry, spuName) {
  return {
    ...entry,
    info: {...entry.info, spuName},
  };
}

function fallbackEntry(overrides = {}) {
  return {
    ...completeDetailEntry(),
    detailFetchedAt: FRESH_AT,
    source: 'prior_cache',
    ...overrides,
  };
}

async function writeDetailSnapshot({detailResults, detailFallbackResults, fetchedAt = FETCHED_AT}) {
  await writeOpenApiProductCacheAtomically(path.join(testOutputDir, 'shein_openapi_products', STORE, 'latest.json'), {
    ok: true,
    storeKey: STORE,
    normalizedRows: [{store: STORE, spu: SPU, skc: SKC}],
    fetchedAt,
    detailResults,
    detailFallbackResults,
  }, {
    storeKey: STORE,
    generatedAt: '2026-06-27T00:00:00+08:00',
  });
}

async function buildDraft() {
  return buildProductDraftFromSnapshots({
    sourceStore: STORE,
    sourceSkc: SKC,
    targetStore: STORE,
    date: DATE,
    now: BUILD_NOW,
  });
}

async function runScenario({name, detailResults, detailFallbackResults, fetchedAt, expected}) {
  const checks = [];
  const c = (label, actual, expectedValue) => check(checks, `${name}: ${label}`, actual, expectedValue);
  await writeDetailSnapshot({detailResults, detailFallbackResults, fetchedAt});
  const result = await buildDraft();
  const payload = result.openapiPublishPayloadDraft;
  const skc = payload.skc_list?.[0] || {};
  const sku = skc.sku_list?.[0] || {};
  const summary = summarizeDraftForExecutor(result);
  c('ready for OpenAPI submit', result.readyForOpenApiSubmit, true);
  c('no mapping blockers', result.blockers.length, 0);
  c('product type from OpenAPI detail', payload.product_type_id, expected.productTypeId);
  c('OpenAPI Arabic title copied', payload.multi_language_name_list?.find(row => row.language === 'ar')?.name, 'ماكينة خياطة اختبار');
  c('product attributes copied dynamically without sales attrs', payload.product_attribute_list?.length, 2);
  c('custom attribute value preserved as attribute_extra_value', payload.product_attribute_list?.[0]?.attribute_extra_value, 'TXSM-505A');
  c('custom attribute zero value id removed', payload.product_attribute_list?.[0]?.attribute_value_id, undefined);
  c('new-link supplier_code uses standard goods sn', skc.supplier_code, 'SMK-505');
  c('new-link supplier_code does not copy source OpenAPI supplierCode', skc.supplier_code === 'SOURCE-SKC-SUPPLIER-505', false);
  c('skc images copied from OpenAPI detail', skc.image_info?.image_info_list?.length, 3);
  c('skc image types mapped for publishOrEdit', skc.image_info?.image_info_list?.map(row => row.image_type).join(','), '1,2,5');
  c('main image sort remains first', skc.image_info?.image_info_list?.[0]?.image_sort, 1);
  c('sale attribute is object for publishOrEdit', Array.isArray(skc.sale_attribute), false);
  c('SKC sale attribute copied from OpenAPI detail', skc.sale_attribute?.attribute_id, 1001466);
  c('SKU sale attribute list copied from OpenAPI detail', sku.sale_attribute_list?.[0]?.attribute_id, 27);
  c('degenerate sales attributes fully removed', sku.sale_attribute_list?.length, 2);
  c('legal SKU sale attribute preserved', JSON.stringify(sku.sale_attribute_list?.[0]), JSON.stringify({attribute_id: 27, attribute_value_id: 536}));
  c('legal digit-string sale attribute normalized and preserved', JSON.stringify(sku.sale_attribute_list?.[1]), JSON.stringify({attribute_id: 301, attribute_value_id: 401}));
  c('degenerate SKC-level id=0 sales attribute removed', skc.sale_attribute_list?.length ?? 0, 0);
  c('only positive safe-integer attribute_id values remain in payload draft', hasOnlyPositiveSafeAttributeIds(payload), true);
  c('sales attrs are not mixed into product attrs', payload.product_attribute_list?.some(row => [27, 1001466].includes(Number(row.attribute_id))), false);
  c('SKU dimensions copied from OpenAPI detail', [sku.length, sku.width, sku.height, sku.weight].join('|'), '31.1|29.5|14.7|2500');
  c('SAR cost preferred', sku.cost_info?.currency, 'SAR');
  c('SAR cost value copied', sku.cost_info?.cost_price, '124.44');
  c('copy draft defaults to scheduled shelf', payload.shelf_way, 2);
  c('copy draft schedules ten years later', payload.hope_on_sale_date, '2036-06-28 10:00:00');
  c('does not invent supplier_sku from skuCode', Object.hasOwn(sku, 'supplier_sku'), false);
  c('summary records OpenAPI detail source', summary.openApiDetail?.source, expected.source);
  c('summary preserves detailFetchedAt', summary.openApiDetail?.detailFetchedAt, expected.detailFetchedAt);
  c('summary records actual matched SPU', summary.openApiDetail?.matchedSpuName, SPU);
  c('summary records actual matched SKC', summary.openApiDetail?.matchedSkcName, SKC);
  c('summary source pointer records matched identity', summary.sourcePointers?.some(p => p.type === expected.source && p.spuName === SPU && p.skcName === SKC && p.detailFetchedAt === expected.detailFetchedAt), true);
  c('summary records applied payload fields', summary.openApiDetail?.appliedToPayload || [], v => v.includes('product_attribute_list') && v.includes('skc_list.sku_list'));
  c('structured mapping blockers empty', result.mappingBlockers.length, 0);
  c('summary structured mapping blockers empty', summary.mappingBlockers?.length || 0, 0);
  c('sourceDetailLock present', Boolean(result.sourceDetailLock), true);
  c('sourceDetailLock source', result.sourceDetailLock?.source, expected.source);
  c('sourceDetailLock matched SPU', result.sourceDetailLock?.matchedSpuName, SPU);
  c('sourceDetailLock matched SKC', result.sourceDetailLock?.matchedSkcName, SKC);
  c('sourceDetailLock detailFetchedAt', result.sourceDetailLock?.detailFetchedAt, expected.detailFetchedAt);
  c('sourceDetailLock content hash is sha256', result.sourceDetailLock?.detailContentSha256, value => /^[a-f0-9]{64}$/.test(String(value || '')));
  c('summary carries same sourceDetailLock', summary.sourceDetailLock?.detailContentSha256, result.sourceDetailLock?.detailContentSha256);
  return {checks, result, summary};
}

async function runFailClosed({name, detailResults, detailFallbackResults, fetchedAt, expectedMappingBlockers = []}) {
  const checks = [];
  const c = (label, actual, expectedValue) => check(checks, `${name}: ${label}`, actual, expectedValue);
  await writeDetailSnapshot({detailResults, detailFallbackResults, fetchedAt});
  const result = await buildDraft();
  const summary = summarizeDraftForExecutor(result);
  const expectedCodes = expectedMappingBlockers.map(blocker => blocker.code);
  const expectedMessages = expectedMappingBlockers.map(blocker => blocker.message);
  c('summary openApiDetail null', summary.openApiDetail, null);
  c('no false product type', result.openapiPublishPayloadDraft.product_type_id, undefined);
  c('no false detail applied', result.canonicalDraft.sourceSummary.hasOpenApiProductDetail, false);
  c('no openApiDetail source pointer', summary.sourcePointers?.some(p => p.type?.startsWith('openapi_product_detail')), false);
  c('ready false', result.readyForOpenApiSubmit, false);
  c('structured mapping blocker count', result.mappingBlockers.length, expectedMappingBlockers.length);
  c('structured mapping blocker codes', result.mappingBlockers.map(blocker => blocker.code).join(','), expectedCodes.join(','));
  c('structured mapping blocker messages', result.mappingBlockers.map(blocker => blocker.message).join('|'), expectedMessages.join('|'));
  c('mapping blocker message merged into blockers', expectedMessages.length ? result.blockers.includes(expectedMessages[0]) : true, true);
  c('summary structured mapping blocker codes', summary.mappingBlockers?.map(blocker => blocker.code).join(',') || '', expectedCodes.join(','));
  c('summary sourceDetailLock null', summary.sourceDetailLock, null);
  return {checks, result, summary};
}

async function cleanup() {
  for (const dir of fixtureRoots) {
    await fs.rm(dir, {recursive: true, force: true});
  }
}

try {
  await cleanup();
  await writeLinkFixture();
  const allChecks = [];

  // A. current detailResults exact SPU/SKC hit takes the snapshot source.
  const current = await runScenario({
    name: 'current hit',
    detailResults: [completeDetailEntry()],
    detailFallbackResults: [],
    expected: {
      productTypeId: 9851,
      source: 'openapi_product_detail_snapshot',
      detailFetchedAt: FETCHED_AT,
    },
  });
  allChecks.push(...current.checks);

  // B. detailResults=[] + fresh cached fallback entry: distinct source and
  //    preserved row-level detailFetchedAt.
  const fallback = await runScenario({
    name: 'fresh cached fallback',
    detailResults: [],
    detailFallbackResults: [fallbackEntry()],
    expected: {
      productTypeId: 9851,
      source: 'openapi_product_detail_cached_fallback',
      detailFetchedAt: FRESH_AT,
    },
  });
  allChecks.push(...fallback.checks);

  // C. current detailResults hit must win over a conflicting cached fallback.
  const fallbackEntryWithType = fallbackEntry();
  fallbackEntryWithType.info = {...fallbackEntryWithType.info, productTypeId: 6666};
  const priority = await runScenario({
    name: 'current priority over cached fallback',
    detailResults: [completeDetailEntry()],
    detailFallbackResults: [fallbackEntryWithType],
    expected: {
      productTypeId: 9851,
      source: 'openapi_product_detail_snapshot',
      detailFetchedAt: FETCHED_AT,
    },
  });
  allChecks.push(...priority.checks);

  // D. fallback with the same SPU but the wrong SKC must not false-match.
  const wrongSkcFallback = await runFailClosed({
    name: 'fallback same SPU wrong SKC',
    detailResults: [],
    detailFallbackResults: [fallbackEntry(withSkcName(completeDetailEntry(), 'sv-wrong-skc'))],
  });
  allChecks.push(...wrongSkcFallback.checks);

  // E. current same-SPU detail missing the target SKC is an identity conflict:
  //    fail closed even when a fresh exact cached fallback exists.
  const conflict = await runFailClosed({
    name: 'current same SPU missing target SKC with exact fallback',
    detailResults: [withSkcName(completeDetailEntry(), 'sv-current-wrong-skc')],
    detailFallbackResults: [fallbackEntry()],
    expectedMappingBlockers: [{
      code: 'SOURCE_DETAIL_CONFLICT_SAME_SPU_WRONG_SKC',
      message: `源详情快照存在 SPU ${SPU}，但该详情不含目标 SKC ${SKC}，身份冲突，禁止用缓存回退或按 SKC 误配。`,
    }],
  });
  allChecks.push(...conflict.checks);

  // F. expired fallback (older than 24h) fails closed.
  const expired = await runFailClosed({
    name: 'expired cached fallback',
    detailResults: [],
    detailFallbackResults: [fallbackEntry({detailFetchedAt: EXPIRED_AT})],
  });
  allChecks.push(...expired.checks);

  // G. missing row-level detailFetchedAt fails closed; a fresh payload-level
  //    fetchedAt must not masquerade as fallback freshness.
  const missing = await runFailClosed({
    name: 'missing row-level detailFetchedAt',
    detailResults: [],
    detailFallbackResults: [fallbackEntry({detailFetchedAt: undefined})],
    fetchedAt: FRESH_AT,
  });
  allChecks.push(...missing.checks);

  // H. future detailFetchedAt fails closed.
  const future = await runFailClosed({
    name: 'future cached fallback',
    detailResults: [],
    detailFallbackResults: [fallbackEntry({detailFetchedAt: FUTURE_AT})],
  });
  allChecks.push(...future.checks);

  // I. boundary-fresh fallback (exactly 24h before build) is accepted.
  const boundary = await runScenario({
    name: 'boundary 24h cached fallback',
    detailResults: [],
    detailFallbackResults: [fallbackEntry({detailFetchedAt: BOUNDARY_AT})],
    expected: {
      productTypeId: 9851,
      source: 'openapi_product_detail_cached_fallback',
      detailFetchedAt: BOUNDARY_AT,
    },
  });
  allChecks.push(...boundary.checks);

  // J. current entry with the exact SKC but a wrong SPU is an identity
  //    conflict: fail closed even when a fresh exact cached fallback exists.
  const wrongCurrentSpu = await runFailClosed({
    name: 'current exact SKC wrong SPU with exact fallback',
    detailResults: [withSpuName(completeDetailEntry(), 'v-wrong-spu')],
    detailFallbackResults: [fallbackEntry()],
    expectedMappingBlockers: [{
      code: 'SOURCE_DETAIL_CONFLICT_SAME_SKC_WRONG_SPU',
      message: `源详情快照存在目标 SKC ${SKC}，但所属 SPU 与目标 SPU ${SPU} 不一致，身份冲突，禁止误配发布。`,
    }],
  });
  allChecks.push(...wrongCurrentSpu.checks);

  // K. fallback entry with the exact SKC but a wrong SPU fails closed
  //    (double-exact required while normalizedRow provides the spuName).
  const wrongFallbackSpu = await runFailClosed({
    name: 'fallback exact SKC wrong SPU',
    detailResults: [],
    detailFallbackResults: [fallbackEntry(withSpuName(completeDetailEntry(), 'v-wrong-spu'))],
  });
  allChecks.push(...wrongFallbackSpu.checks);

  // L. detailContentSha256 hashes stable JSON of actual detail content: a
  //    title change must change the hash even though identity and freshness
  //    stay identical.
  const baseHash = current.result.sourceDetailLock?.detailContentSha256 || '';
  const variant = completeDetailEntry();
  variant.info = {
    ...variant.info,
    productMultiNameList: [
      {language: 'en', productName: 'Variant SMK 505 sewing machine'},
      ...variant.info.productMultiNameList.slice(1),
    ],
  };
  const contentVariant = await runScenario({
    name: 'content variant current hit',
    detailResults: [variant],
    detailFallbackResults: [],
    expected: {
      productTypeId: 9851,
      source: 'openapi_product_detail_snapshot',
      detailFetchedAt: FETCHED_AT,
    },
  });
  allChecks.push(...contentVariant.checks);
  check(allChecks, 'content hash: variant title changes detailContentSha256', contentVariant.result.sourceDetailLock?.detailContentSha256 !== baseHash, true);
  check(allChecks, 'content hash: base hash is stable sha256', baseHash, value => /^[a-f0-9]{64}$/.test(String(value || '')));

  const ok = allChecks.every(x => x.pass);
  console.log(JSON.stringify({ok, checks: allChecks}, null, 2));
  if (!ok) process.exit(1);
} finally {
  await cleanup();
  await fs.rm(tmpRoot, {recursive: true, force: true});
}
