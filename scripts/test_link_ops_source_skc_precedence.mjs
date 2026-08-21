#!/usr/bin/env node
/**
 * Regression for exact sourceStore/sourceSkc precedence.
 *
 * A newly-created copy_product_draft can carry a shape-valid but incomplete
 * task.openapiPublishPayload.  That payload must not shadow a complete draft
 * regenerated from the locked source detail snapshot.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeOpenApiProductCacheAtomically} from '../lib/shein_openapi_product_cache.mjs';
import {
  DESCRIPTION_PAYLOAD_HASH_ALGORITHM,
  DESCRIPTION_SOURCE_PROOF,
  buildDescriptionPayloadRows,
  descriptionBindingRequestKey,
  describeDescriptionMaterial,
  sha256StableJson,
  sha256Utf8,
} from '../lib/link_ops_product_descriptions.mjs';

process.env.SHEIN_LINK_OPS_EXECUTOR_SELF_TEST = '1';
const {findOrBuildPublishPayload} = await import('./link_ops_hl_openapi_executor.mjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORE = 'SRC';
const DATE = '2099-01-02';
const SOURCE_SKC = 'sv20990102000000001';
const SPU = 'v209901020000';
const fixtureRoots = [
  path.join(ROOT, 'outputs', 'shein_links', STORE),
  path.join(ROOT, 'outputs', 'shein_links_raw', STORE),
  path.join(ROOT, 'outputs', 'shein_openapi_products', STORE),
];
const checks = [];

function check(label, actual, expected) {
  const pass = typeof expected === 'function' ? expected(actual) : Object.is(actual, expected);
  checks.push({label, actual, expected: typeof expected === 'function' ? expected.toString() : expected, pass});
  assert.equal(pass, true, label);
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function detail({complete = true, productTypeId = 9851} = {}) {
  const info = {
    spuName: SPU,
    categoryId: 13127,
    productTypeId: complete ? productTypeId : undefined,
    brandCode: '2a64l',
    productMultiNameList: [
      {language: 'en', productName: 'Source product EN'},
      {language: 'ar', productName: 'مصدر المنتج'},
    ],
    productAttributeInfoList: [
      {attributeId: 1000546, attributeValueId: 0, attributeValue: 'MODEL-SRC'},
      {attributeId: 160, attributeValueId: 62},
      {attributeId: 27, attributeValueId: 536},
    ],
    skcInfoList: [{
      skcName: SOURCE_SKC,
      skcImageInfoList: [
        {imageUrl: 'https://example.invalid/source-main.jpg', imageType: 'MAIN'},
        {imageUrl: 'https://example.invalid/source-detail.jpg', imageType: 'DETAIL'},
        {imageUrl: 'https://example.invalid/source-square.jpg', imageType: 'SQUARE'},
      ],
      skuInfoList: [{
        skuCode: 'SKU-SRC-001',
        length: '31.10',
        width: '29.50',
        height: '14.70',
        weight: 2500,
        mallState: 1,
        saleAttributeList: [{attributeId: 27, attributeValueId: 536}],
        costInfoList: [{currency: 'SAR', costPrice: 124.44}],
      }],
    }],
  };
  if (!complete) delete info.productTypeId;
  return {ok: true, info};
}

function taskWithPayload() {
  return {
    id: 'lot_source_precedence',
    status: 'draft',
    intents: ['copy_product_draft'],
    targets: {
      sourceStores: [STORE],
      sourceSkc: SOURCE_SKC,
      writeStores: ['HL'],
      stores: ['HL'],
      productRefs: ['DEST-REF'],
      publishPreparation: {
        standardGoodsSn: 'DEST-SN-001',
        supplyPrice: 222.22,
        inventory: 77,
        titleGroup: 'title1',
        titleAr: 'Destination title AR',
        titleEn: 'Destination title EN',
      },
    },
    // Shape-valid but intentionally incomplete payload from the reproduction.
    openapiPublishPayload: {
      category_id: 999,
      product_type_id: 1,
      product_attribute_list: [],
      multi_language_name_list: [
        {language: 'ar', name: 'Destination title AR'},
        {language: 'en', name: 'Destination title EN'},
      ],
      skc_list: [{sku_list: []}],
    },
  };
}

function withApprovedImages(task) {
  const binding = {
    schemaVersion: 1,
    sourceApproved: true,
    authority: 'human_reviewed_source',
    targetStore: 'HL',
    boundAt: '2026-08-21T10:00:00.000Z',
    bindingFingerprint: 'a'.repeat(64),
    imageCount: 2,
    images: [
      {name: 'main.png', role: 'mainCover', imageType: 1, imageUrl: 'https://img.shein.com/destination/main.png', width: 900, height: 1200, order: 1},
      {name: 'square.png', role: 'squareImage', imageType: 5, imageUrl: 'https://img.shein.com/destination/square.png', width: 1254, height: 1254, order: 2},
    ],
    publishPreparation: task.targets.publishPreparation,
  };
  const payload = JSON.parse(JSON.stringify(task.openapiPublishPayload));
  payload.skc_list[0] = {
    supplier_code: 'DEST-SN-001',
    image_info: {image_info_list: [
      {image_url: 'https://img.shein.com/destination/main.png', image_type: 1, image_sort: 1},
      {image_url: 'https://img.shein.com/destination/square.png', image_type: 5, image_sort: 2},
    ]},
    sku_list: [{
      supplier_sku: 'DEST-SN-001',
      cost_info: {currency: 'SAR', cost_price: '222.22'},
      stock_info_list: [{inventory_num: 77}],
    }],
  };
  return {...task, openapiPublishPayload: payload, publishAssetBinding: binding};
}

function withApprovedDescriptions(task) {
  const rows = {
    ar: ['AR one', 'AR two', 'AR three', 'AR four', 'AR five'],
    en: ['EN one', 'EN two', 'EN three', 'EN four', 'EN five'],
    'zh-cn': ['中一', '中二', '中三', '中四', '中五'],
  };
  const material = {
    schemaVersion: 1,
    sourceLabel: 'reviewed.html',
    sourceFileSha256: 'b'.repeat(64),
    rows: Object.fromEntries(Object.entries(rows).map(([language, lines]) => [language, {
      language,
      lines,
      sha256: sha256Utf8(lines.join('\n')),
    }])),
  };
  const summary = describeDescriptionMaterial(material);
  const payload = JSON.parse(JSON.stringify(task.openapiPublishPayload));
  payload.multi_language_desc_list = buildDescriptionPayloadRows(material);
  const binding = {
    schemaVersion: 1,
    kind: 'copy_product_draft',
    sourceApproved: true,
    authority: 'human_reviewed_source',
    sourceProof: DESCRIPTION_SOURCE_PROOF,
    targetStore: 'HL',
    boundAt: '2026-08-21T10:00:00.000Z',
    boundByUser: 'test-user',
    baseTaskRevision: 1,
    bindingRequestKey: descriptionBindingRequestKey({
      taskId: task.id,
      targetStore: 'HL',
      baseTaskRevision: 1,
      contentSha256: summary.contentSha256,
      sourceProof: DESCRIPTION_SOURCE_PROOF,
    }),
    sourceLabel: summary.sourceLabel,
    sourceByteLength: 1,
    sourceFileSha256: summary.sourceFileSha256,
    contentSha256: summary.contentSha256,
    publishLanguages: summary.publishLanguages,
    lineCounts: summary.lineCounts,
    hashes: summary.hashes,
    newPayloadHash: sha256StableJson(payload),
    payloadHashAlgorithm: DESCRIPTION_PAYLOAD_HASH_ALGORITHM,
    imageBindingFingerprint: task.publishAssetBinding?.bindingFingerprint || '',
  };
  return {...task, openapiPublishPayload: payload, descriptionMaterialBinding: binding};
}

async function setup() {
  await writeJson(path.join(ROOT, 'outputs', 'shein_links', STORE, `${DATE}.json`), {
    linkRows: [{
      storeKey: STORE,
      skc: SOURCE_SKC,
      spu: SPU,
      standardGoodsSn: 'SOURCE-SN',
      productNameCn: 'source fixture',
    }],
    inventoryRows: [],
    performanceRows: [],
  });
  await writeOpenApiProductCacheAtomically(path.join(ROOT, 'outputs', 'shein_openapi_products', STORE, 'latest.json'), {
    ok: true,
    storeKey: STORE,
    fetchedAt: new Date().toISOString(),
    normalizedRows: [{store: STORE, spu: SPU, skc: SOURCE_SKC}],
    detailResults: [detail()],
    detailFallbackResults: [],
  }, {storeKey: STORE, generatedAt: new Date().toISOString()});
}

async function cleanup() {
  for (const dir of fixtureRoots) await fs.rm(dir, {recursive: true, force: true});
}

try {
  await cleanup();
  await setup();

  const task = taskWithPayload();
  const result = await findOrBuildPublishPayload(task, {targetStore: 'HL'});
  const payload = result.payload;
  const sku = payload?.skc_list?.[0]?.sku_list?.[0] || {};

  check('exact locked source wins over task payload', result.source, 'webapi_snapshot_exact_source_lock');
  check('task payload is explicitly marked ignored', result.taskPayloadIgnored, true);
  check('exact source store reaches executor selection', result.inferred?.sourceStore, STORE);
  check('exact sourceSkc reaches executor selection unchanged', result.inferred?.sourceSkc, SOURCE_SKC);
  check('generated payload carries exact source_skc', payload.skc_list?.[0]?.source_skc, SOURCE_SKC);
  check('mapper product type replaces incomplete task value', payload.product_type_id, 9851);
  check('mapper full product attributes replace empty task list', payload.product_attribute_list?.length, 2);
  check('mapper dimensions survive precedence repair', [sku.length, sku.width, sku.height, sku.weight].join('|'), '31.1|29.5|14.7|2500');
  check('mapper source cost is present before explicit preparation', sku.cost_info?.currency, 'SAR');
  check('explicit destination supply price is preserved', sku.cost_info?.cost_price, '222.22');
  check('explicit destination inventory is preserved', sku.stock_info_list?.[0]?.inventory_num, 77);
  check('explicit destination standard goods code is preserved', payload.skc_list?.[0]?.supplier_code, 'DEST-SN-001');
  check('destination title group is preserved as structured projection', result.destinationProjection?.titleGroup, 'title1');
  check('destination title is preserved from structured preparation', payload.multi_language_name_list?.find(row => row.language === 'en')?.name, 'Destination title EN');

  const protectedTask = withApprovedDescriptions(withApprovedImages(taskWithPayload()));
  const protectedResult = await findOrBuildPublishPayload(protectedTask, {targetStore: 'HL'});
  const protectedPayload = protectedResult.payload;
  check('approved destination image binding is preserved', protectedPayload.skc_list?.[0]?.image_info?.image_info_list?.map(row => row.image_url).join('|'), 'https://img.shein.com/destination/main.png|https://img.shein.com/destination/square.png');
  check('approved destination descriptions are preserved', protectedPayload.multi_language_desc_list?.find(row => row.language === 'en')?.name, 'EN one\nEN two\nEN three\nEN four\nEN five');
  check('approved destination supplierSku is preserved', protectedPayload.skc_list?.[0]?.sku_list?.[0]?.supplier_sku, 'DEST-SN-001');

  const unboundTargetPayload = taskWithPayload();
  delete unboundTargetPayload.targets.publishPreparation;
  unboundTargetPayload.openapiPublishPayload = {
    ...unboundTargetPayload.openapiPublishPayload,
    skc_list: [{supplier_code: 'UNLOCKED-SN', sku_list: [{supplier_sku: 'UNLOCKED-SKU', cost_info: {currency: 'SAR', cost_price: '9.99'}, stock_info_list: [{inventory_num: 3}]}]}],
  };
  const unbound = await findOrBuildPublishPayload(unboundTargetPayload, {targetStore: 'HL'});
  check('unlocked destination fields fail closed', unbound.payload, null);
  check('unlocked destination fields report a structured-lock blocker', unbound.generationError, value => /structured|lock/i.test(String(value)));

  await writeOpenApiProductCacheAtomically(path.join(ROOT, 'outputs', 'shein_openapi_products', STORE, 'latest.json'), {
    ok: true,
    storeKey: STORE,
    fetchedAt: new Date().toISOString(),
    normalizedRows: [{store: STORE, spu: SPU, skc: SOURCE_SKC}],
    detailResults: [detail({productTypeId: 9852})],
    detailFallbackResults: [],
  }, {storeKey: STORE, generatedAt: new Date().toISOString()});
  const drifted = await findOrBuildPublishPayload(task, {
    targetStore: 'HL',
    preferredSource: {sourceDetailHash: result.sourceDetailHash},
  });
  check('cache source detail drift fails closed after preflight lock', drifted.payload, null);
  check('cache source detail drift has explicit source blocker', drifted.source, 'exact_source_cache_drifted');

  await writeOpenApiProductCacheAtomically(path.join(ROOT, 'outputs', 'shein_openapi_products', STORE, 'latest.json'), {
    ok: true,
    storeKey: STORE,
    fetchedAt: new Date().toISOString(),
    normalizedRows: [{store: STORE, spu: SPU, skc: SOURCE_SKC}],
    detailResults: [detail({complete: false})],
    detailFallbackResults: [],
  }, {storeKey: STORE, generatedAt: new Date().toISOString()});
  const blocked = await findOrBuildPublishPayload(taskWithPayload(), {targetStore: 'HL'});
  check('incomplete exact mapper draft fails closed', blocked.payload, null);
  check('incomplete exact mapper source is not task', blocked.source, 'exact_source_snapshot_incomplete');
  check('incomplete exact mapper reports a blocker', blocked.generationError, value => /incomplete|product/i.test(String(value)));

  console.log(`link_ops_source_skc_precedence: ${checks.length}/${checks.length} passed`);
} finally {
  await cleanup();
}
