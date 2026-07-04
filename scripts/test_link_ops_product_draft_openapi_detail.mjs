#!/usr/bin/env node
/**
 * Smoke test: copy_product_draft can enrich a source link payload from the
 * store-level OpenAPI product detail cache (`goods/spu-info`).
 *
 * This uses temporary fixture files under outputs/ and removes them in finally;
 * it never calls SHEIN and never enables real writes.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildProductDraftFromSnapshots, summarizeDraftForExecutor} from '../lib/link_ops_product_draft_mapper.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORE = 'SMK';
const DATE = '2099-01-01';
const SKC = 'sv20990101000000001';
const SPU = 'v209901010000';
const checks = [];

function check(label, actual, expected) {
  const pass = typeof expected === 'function' ? expected(actual) : Object.is(actual, expected);
  checks.push({label, actual, expected: typeof expected === 'function' ? expected.toString() : expected, pass});
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

const fixtureRoots = [
  path.join(ROOT, 'outputs', 'shein_links', STORE),
  path.join(ROOT, 'outputs', 'shein_links_raw', STORE),
  path.join(ROOT, 'outputs', 'shein_openapi_products', STORE),
];

async function setup() {
  await writeJson(path.join(ROOT, 'outputs', 'shein_links', STORE, `${DATE}.json`), {
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
  await writeJson(path.join(ROOT, 'outputs', 'shein_openapi_products', STORE, 'latest.json'), {
    normalizedRows: [{store: STORE, spu: SPU, skc: SKC}],
    detailResults: [{
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
            saleAttributeList: [{attributeId: 27, attributeValueId: 536}],
            costInfoList: [
              {currency: 'CNY', costPrice: 205.21},
              {currency: 'SAR', costPrice: 124.44},
            ],
          }],
        }],
      },
    }],
  });
}

async function cleanup() {
  for (const dir of fixtureRoots) {
    await fs.rm(dir, {recursive: true, force: true});
  }
}

try {
  await cleanup();
  await setup();
  const result = await buildProductDraftFromSnapshots({
    sourceStore: STORE,
    sourceSkc: SKC,
    targetStore: STORE,
    date: DATE,
    now: new Date('2026-06-28T00:00:00+08:00'),
  });
  const payload = result.openapiPublishPayloadDraft;
  const skc = payload.skc_list?.[0] || {};
  const sku = skc.sku_list?.[0] || {};
  const summary = summarizeDraftForExecutor(result);
  check('ready for OpenAPI submit', result.readyForOpenApiSubmit, true);
  check('no mapping blockers', result.blockers.length, 0);
  check('product type from OpenAPI detail', payload.product_type_id, 9851);
  check('OpenAPI Arabic title copied', payload.multi_language_name_list?.find(row => row.language === 'ar')?.name, 'ماكينة خياطة اختبار');
  check('product attributes copied dynamically without sales attrs', payload.product_attribute_list?.length, 2);
  check('custom attribute value preserved as attribute_extra_value', payload.product_attribute_list?.[0]?.attribute_extra_value, 'TXSM-505A');
  check('custom attribute zero value id removed', payload.product_attribute_list?.[0]?.attribute_value_id, undefined);
  check('new-link supplier_code uses standard goods sn', skc.supplier_code, 'SMK-505');
  check('new-link supplier_code does not copy source OpenAPI supplierCode', skc.supplier_code === 'SOURCE-SKC-SUPPLIER-505', false);
  check('skc images copied from OpenAPI detail', skc.image_info?.image_info_list?.length, 3);
  check('skc image types mapped for publishOrEdit', skc.image_info?.image_info_list?.map(row => row.image_type).join(','), '1,2,5');
  check('main image sort remains first', skc.image_info?.image_info_list?.[0]?.image_sort, 1);
  check('sale attribute is object for publishOrEdit', Array.isArray(skc.sale_attribute), false);
  check('SKC sale attribute copied from OpenAPI detail', skc.sale_attribute?.attribute_id, 1001466);
  check('SKU sale attribute list copied from OpenAPI detail', sku.sale_attribute_list?.[0]?.attribute_id, 27);
  check('sales attrs are not mixed into product attrs', payload.product_attribute_list?.some(row => [27, 1001466].includes(Number(row.attribute_id))), false);
  check('SKU dimensions copied from OpenAPI detail', [sku.length, sku.width, sku.height, sku.weight].join('|'), '31.1|29.5|14.7|2500');
  check('SAR cost preferred', sku.cost_info?.currency, 'SAR');
  check('SAR cost value copied', sku.cost_info?.cost_price, '124.44');
  check('copy draft defaults to scheduled shelf', payload.shelf_way, 2);
  check('copy draft schedules ten years later', payload.hope_on_sale_date, '2036-06-28 10:00:00');
  check('does not invent supplier_sku from skuCode', Object.hasOwn(sku, 'supplier_sku'), false);
  check('summary records OpenAPI detail source', summary.openApiDetail?.source, 'openapi_product_detail_snapshot');
  check('summary records applied payload fields', summary.openApiDetail?.appliedToPayload || [], v => v.includes('product_attribute_list') && v.includes('skc_list.sku_list'));
  const ok = checks.every(x => x.pass);
  console.log(JSON.stringify({ok, checks}, null, 2));
  if (!ok) process.exit(1);
} finally {
  await cleanup();
}
