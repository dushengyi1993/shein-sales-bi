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
import {
  applyApprovedImageBindingsToPublishPayload,
  normalizeApprovedImageBindingProjection,
  normalizePublishPayloadImageProjection,
} from '../lib/link_ops_publish_asset_binding.mjs';

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

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function fullApprovedImages() {
  const detailRows = Array.from({length: 10}, (_, index) => ({
    name: `qh-detail-${String(index + 1).padStart(2, '0')}.png`,
    role: 'detail',
    imageType: 2,
    imageUrl: `https://img.shein.com/destination/qh-detail-${String(index + 1).padStart(2, '0')}.png`,
    width: 900,
    height: 1200,
    order: index + 3,
  }));
  return [
    {name: 'qh-main.png', role: 'mainCover', imageType: 1, imageUrl: 'https://img.shein.com/destination/qh-main.png', width: 900, height: 1200, order: 1},
    {name: 'qh-carousel.png', role: 'carouselSecondCover', imageType: 1, imageUrl: 'https://img.shein.com/destination/qh-carousel.png', width: 900, height: 1200, order: 2},
    ...detailRows,
    {name: 'qh-square.png', role: 'squareImage', imageType: 5, imageUrl: 'https://img.shein.com/destination/qh-square.png', width: 1254, height: 1254, order: 13},
    {name: 'qh-sku.png', role: 'skuImage', imageType: 1, imageUrl: 'https://img.shein.com/destination/qh-sku.png', width: 900, height: 1200, order: 14},
  ];
}

function camelizeImageInfo(container) {
  const imageInfo = container?.image_info;
  if (!imageInfo || typeof imageInfo !== 'object') return container;
  return {
    imageInfo: {
      imageInfoList: (imageInfo.image_info_list || []).map(row => ({
        imageType: row.image_type,
        imageSort: row.image_sort,
        imageUrl: row.image_url,
      })),
    },
  };
}

function camelizeImagePayload(payload) {
  const next = cloneJson(payload);
  next.skcList = (next.skc_list || []).map(skc => {
    const converted = {...skc, ...camelizeImageInfo(skc)};
    delete converted.image_info;
    converted.skuList = (skc.sku_list || []).map(sku => {
      const skuConverted = {...sku, ...camelizeImageInfo(sku)};
      delete skuConverted.image_info;
      return skuConverted;
    });
    delete converted.sku_list;
    return converted;
  });
  delete next.skc_list;
  if (next.image_info) {
    next.imageInfo = camelizeImageInfo(next).imageInfo;
    delete next.image_info;
  }
  if (Object.hasOwn(next, 'is_spu_pic')) {
    next.isSpuPic = next.is_spu_pic;
    delete next.is_spu_pic;
  }
  return next;
}

function withFullApprovedImages(task, {camelCase = false, reorderPayload = false, targetStore = 'HL'} = {}) {
  const images = fullApprovedImages();
  const payload = cloneJson(task.openapiPublishPayload);
  payload.skc_list = [{
    supplier_code: 'DEST-SN-001',
    image_info: {image_info_list: []},
    sku_list: [{
      supplier_sku: 'DEST-SN-001',
      cost_info: {currency: 'SAR', cost_price: '222.22'},
      stock_info_list: [{inventory_num: 77}],
    }],
  }];
  const applied = applyApprovedImageBindingsToPublishPayload(payload, images, {sourceApproved: true});
  let nextPayload = applied.payload;
  if (reorderPayload) {
    const rows = nextPayload.skc_list[0].image_info.image_info_list;
    nextPayload.skc_list[0].image_info.image_info_list = [...rows].reverse();
  }
  if (camelCase) nextPayload = camelizeImagePayload(nextPayload);
  const binding = {
    schemaVersion: 1,
    sourceApproved: true,
    authority: 'human_reviewed_source',
    targetStore,
    boundAt: '2026-08-21T10:00:00.000Z',
    bindingFingerprint: 'c'.repeat(64),
    imageCount: images.length,
    images: cloneJson(images),
    publishPreparation: cloneJson(task.targets.publishPreparation),
  };
  return {
    ...task,
    targets: {
      ...task.targets,
      writeStores: [targetStore],
      stores: [targetStore],
    },
    openapiPublishPayload: nextPayload,
    publishAssetBinding: binding,
  };
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

function clearStructuredTitleLocks(task) {
  const next = cloneJson(task);
  for (const preparation of [
    next.publishPreparation,
    next.metadata?.publishPreparation,
    next.targets?.publishPreparation,
    next.publishAssetBinding?.publishPreparation,
    next.metadata?.publishAssetBinding?.publishPreparation,
  ]) {
    if (!preparation || typeof preparation !== 'object') continue;
    for (const key of ['titleGroup', 'titleAr', 'titleEn', 'titles']) delete preparation[key];
  }
  return next;
}

function withTargetStore(task, targetStore) {
  const next = cloneJson(task);
  next.targets = {
    ...next.targets,
    writeStores: [targetStore],
    stores: [targetStore],
  };
  return next;
}

function setPayloadTitles(task, {ar, en}) {
  const next = cloneJson(task);
  next.openapiPublishPayload.multi_language_name_list = [
    {language: 'ar', name: ar},
    {language: 'en', name: en},
  ];
  return next;
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

  // FY legacy tasks may already carry titles in the old payload while their
  // structured title lock is absent. Payload text is evidence of drift, not
  // approval; the same task only becomes eligible after prepare-publish
  // explicitly supplies the destination titles and materializes the lock.
  const fyLegacy = withTargetStore(clearStructuredTitleLocks(taskWithPayload()), 'FY');
  const fyWithoutTitleLock = await findOrBuildPublishPayload(fyLegacy, {targetStore: 'FY'});
  check('FY legacy payload title without structured lock fails closed', fyWithoutTitleLock.payload, null);
  check('FY legacy payload title is not trusted automatically', fyWithoutTitleLock.generationError, value => /title|structured|lock/i.test(String(value)));

  const fyPrepared = withTargetStore(clearStructuredTitleLocks(taskWithPayload()), 'FY');
  fyPrepared.targets.publishPreparation = {
    ...fyPrepared.targets.publishPreparation,
    targetStore: 'FY',
    titleGroup: 'title3',
    titleAr: 'FY explicit Arabic title',
    titleEn: 'FY explicit English title',
  };
  const fyPreparedPayload = setPayloadTitles(fyPrepared, {
    ar: 'FY explicit Arabic title',
    en: 'FY explicit English title',
  });
  const fyPreparedResult = await findOrBuildPublishPayload(fyPreparedPayload, {targetStore: 'FY'});
  check('FY explicit prepare-publish title fills the same task lock', fyPreparedResult.payload?.multi_language_name_list?.find(row => row.language === 'en')?.name, 'FY explicit English title');
  check('FY explicit title lock is projected structurally', fyPreparedResult.destinationProjection?.titleGroup, 'title3');

  // An old approved binding can retain an earlier preparation snapshot. Root
  // task/targets fields must not silently outrank that historical binding: the
  // portal must materialize the current explicit prepare-publish input into the
  // binding before the executor can trust it.
  const fyBound = setPayloadTitles(withFullApprovedImages(fyPrepared, {targetStore: 'FY'}), {
    ar: 'FY explicit Arabic title',
    en: 'FY explicit English title',
  });
  fyBound.publishAssetBinding.publishPreparation = {
    standardGoodsSn: 'DEST-SN-001',
    supplyPrice: 222.22,
    inventory: 77,
    titleGroup: 'title1',
    titleAr: 'old binding Arabic title',
    titleEn: 'old binding English title',
  };
  const fyBoundResult = await findOrBuildPublishPayload(fyBound, {targetStore: 'FY'});
  check('FY root preparation cannot outrank old binding evidence', fyBoundResult.payload, null);
  check('FY old binding conflict fails closed', fyBoundResult.generationError, value => /title|structured|lock/i.test(String(value)));
  fyBound.publishAssetBinding.publishPreparation = cloneJson(fyBound.targets.publishPreparation);
  const fyReboundResult = await findOrBuildPublishPayload(fyBound, {targetStore: 'FY'});
  check('FY same-task explicit prepare-publish materialized in binding passes', fyReboundResult.payload?.multi_language_name_list?.find(row => row.language === 'en')?.name, 'FY explicit English title');

  const protectedTask = withApprovedDescriptions(withApprovedImages(taskWithPayload()));
  const protectedResult = await findOrBuildPublishPayload(protectedTask, {targetStore: 'HL'});
  const protectedPayload = protectedResult.payload;
  check('approved destination image binding is preserved', protectedPayload.skc_list?.[0]?.image_info?.image_info_list?.map(row => row.image_url).join('|'), 'https://img.shein.com/destination/main.png|https://img.shein.com/destination/square.png');
  check('approved destination descriptions are preserved', protectedPayload.multi_language_desc_list?.find(row => row.language === 'en')?.name, 'EN one\nEN two\nEN three\nEN four\nEN five');
  check('approved destination supplierSku is preserved', protectedPayload.skc_list?.[0]?.sku_list?.[0]?.supplier_sku, 'DEST-SN-001');

  // QH's legal 14-image layout is split across three payload locations:
  // twelve SKC images, one top-level carousel image, and one nested SKU image.
  // The protected comparison must preserve all three locations, including a
  // camelCase payload read from a legacy task snapshot.
  const qhTask = withFullApprovedImages(taskWithPayload(), {targetStore: 'QH', camelCase: true});
  const qhResult = await findOrBuildPublishPayload(qhTask, {targetStore: 'QH'});
  const qhBindingProjection = normalizeApprovedImageBindingProjection(qhTask.publishAssetBinding.images, {sourceApproved: true});
  const qhPayloadProjection = normalizePublishPayloadImageProjection(qhTask.openapiPublishPayload);
  check('QH legal 14-image protected projection passes', qhResult.payload !== null, true);
  check('QH approved image projection contains 14 rows', qhBindingProjection.length, 14);
  check('QH payload projection contains 14 rows', qhPayloadProjection.length, 14);
  check('QH payload projection matches approved binding', JSON.stringify(qhPayloadProjection), JSON.stringify(qhBindingProjection));
  check('QH top carousel remains outside SKC projection', qhPayloadProjection.some(row => row.role === 'carouselSecondCover'), true);
  check('QH nested SKU image remains in SKU projection', qhPayloadProjection.some(row => row.role === 'skuImage'), true);

  async function expectProtectedImageDrift(label, mutate) {
    const driftedTask = withFullApprovedImages(taskWithPayload(), {targetStore: 'QH'});
    mutate(driftedTask.openapiPublishPayload);
    const driftedResult = await findOrBuildPublishPayload(driftedTask, {targetStore: 'QH'});
    check(`${label} protected image drift fails closed`, driftedResult.payload, null);
    check(`${label} protected image drift names binding mismatch`, driftedResult.generationError, value => /image|binding/i.test(String(value)));
  }

  await expectProtectedImageDrift('QH URL', payload => {
    payload.image_info.image_info_list[0].image_url = 'https://img.shein.com/destination/qh-carousel-drift.png';
  });
  await expectProtectedImageDrift('QH role', payload => {
    payload.skc_list[0].image_info.image_info_list[0].image_type = 2;
  });
  await expectProtectedImageDrift('QH count', payload => {
    payload.skc_list[0].sku_list[0].image_info = {image_info_list: []};
  });
  await expectProtectedImageDrift('QH order', payload => {
    payload.skc_list[0].image_info.image_info_list[1].image_sort = 0;
  });
  await expectProtectedImageDrift('QH missing order', payload => {
    delete payload.skc_list[0].image_info.image_info_list[1].image_sort;
  });
  await expectProtectedImageDrift('QH boolean type', payload => {
    payload.skc_list[0].image_info.image_info_list[0].image_type = true;
  });
  await expectProtectedImageDrift('QH boolean order', payload => {
    payload.skc_list[0].image_info.image_info_list[0].image_sort = true;
  });
  await expectProtectedImageDrift('QH dual type aliases', payload => {
    payload.skc_list[0].image_info.image_info_list[0].imageType = 1;
  });
  await expectProtectedImageDrift('QH dual image containers', payload => {
    payload.skc_list[0].imageInfo = cloneJson(payload.skc_list[0].image_info);
  });
  await expectProtectedImageDrift('QH missing URL', payload => {
    delete payload.skc_list[0].image_info.image_info_list[0].image_url;
  });
  await expectProtectedImageDrift('QH non-object image row', payload => {
    payload.skc_list[0].image_info.image_info_list.push(null);
  });

  const qhMultiSku = withFullApprovedImages(taskWithPayload(), {targetStore: 'QH'});
  const firstSku = qhMultiSku.openapiPublishPayload.skc_list[0].sku_list[0];
  qhMultiSku.openapiPublishPayload.skc_list[0].sku_list.push(cloneJson(firstSku));
  const qhMultiSkuResult = await findOrBuildPublishPayload(qhMultiSku, {targetStore: 'QH'});
  check('QH legal repeated SKU image across multiple SKUs passes', qhMultiSkuResult.payload !== null, true);
  const qhMultiSkuDrift = cloneJson(qhMultiSku);
  qhMultiSkuDrift.openapiPublishPayload.skc_list[0].sku_list[1].image_info.image_info_list[0].image_url = 'https://img.shein.com/destination/qh-sku-drift.png';
  const qhMultiSkuDriftResult = await findOrBuildPublishPayload(qhMultiSkuDrift, {targetStore: 'QH'});
  check('QH one-of-many SKU image drift fails closed', qhMultiSkuDriftResult.payload, null);

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
