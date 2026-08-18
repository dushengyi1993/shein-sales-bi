#!/usr/bin/env node
/**
 * End-to-end success-path smoke for copy_product_draft.
 *
 * This starts:
 *   1) an isolated fake SHEIN OpenAPI HTTP server,
 *   2) an isolated BI portal with temporary auth/task/audit/openapi/whitelist
 *      files and safeWriteOperations enabled only inside the temp config.
 *
 * It proves the full success lifecycle without touching real SHEIN:
 *   create task -> attach JSON publish payload -> dry-run locks payload hash
 *   -> execute with SHEIN_OPENAPI_SUBMIT -> fake publish succeeds
 *   -> fake product query returns target supplier SKU/code
 *   -> task auto-closes as submitted_readback_matched/done.
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {sha256Utf8} from '../lib/link_ops_product_descriptions.mjs';
import {provisionBiSessionSecret} from './provision_bi_session_secret.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP_TEMP = process.argv.includes('--keep-temp');
const WEAK_READBACK_ONLY = process.argv.includes('--weak-readback');
const PREVALID_FAIL = process.argv.includes('--prevalid-fail');
const MISSING_SUCCESS = process.argv.includes('--missing-success');
const PREVALID_RETRY_REBIND = process.argv.includes('--prevalid-retry-rebind');
const PREVALID_RETRY = process.argv.includes('--prevalid-retry') || PREVALID_RETRY_REBIND;
const GENERIC_PRODUCT = process.argv.includes('--generic-product');
const CHAT_NATURAL = process.argv.includes('--chat-natural');
const SEARCH_PRODUCT_READBACK = process.argv.includes('--search-product-readback');
const ASSET_BINDING = process.argv.includes('--asset-binding');
const CONFIRM_TEXT = 'SHEIN_OPENAPI_SUBMIT';
const tmpBase = path.join(ROOT, 'tmp');
await fs.mkdir(tmpBase, {recursive: true});
const tmpRoot = await fs.mkdtemp(path.join(tmpBase, 'bi-ops-copy-success-smoke-'));
const testOutputDir = path.join(tmpRoot, 'outputs');
process.env.SHEIN_BI_OUTPUT_DIR = testOutputDir;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function writeJson(name, value) {
  const file = path.join(tmpRoot, name);
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
  return file;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function canonicalImageFields(images) {
  return asArray(images).map(row => ({
    name: String(row?.name || '').normalize('NFKC').trim(),
    role: String(row?.role || '').normalize('NFKC').trim(),
    imageType: Number(row?.imageType ?? row?.image_type ?? 0),
    imageUrl: String(row?.imageUrl || row?.image_url || '').trim(),
    sha256: String(row?.sha256 || '').trim().toLowerCase(),
  }));
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function expectedPersistedPublishAssetBindingResponse(task) {
  const binding = task?.publishAssetBinding && typeof task.publishAssetBinding === 'object'
    ? task.publishAssetBinding
    : {};
  const evidence = binding.evidence && typeof binding.evidence === 'object' && !Array.isArray(binding.evidence)
    ? JSON.parse(JSON.stringify(binding.evidence))
    : {};
  const publishPreparation = binding.publishPreparation && typeof binding.publishPreparation === 'object' && !Array.isArray(binding.publishPreparation)
    ? JSON.parse(JSON.stringify(binding.publishPreparation))
    : null;
  const images = canonicalImageFields(binding.images);
  return {
    ...evidence,
    targetStore: String(binding.targetStore || '').trim().toUpperCase(),
    bindingFingerprint: String(binding.bindingFingerprint || ''),
    sourceApproved: binding.sourceApproved === true,
    imageCount: images.length,
    boundImageCount: images.length,
    boundNames: images.map(row => row.name),
    publishPreparation,
    preflightInvalidated: evidence.preflightInvalidated === true,
  };
}

function b64Json(value) {
  return Buffer.from(JSON.stringify(value, null, 2), 'utf8').toString('base64');
}

function extractTaskId(json) {
  return json?.task?.id || json?.data?.tasks?.[0]?.id || '';
}

async function rawTaskById(id) {
  const data = JSON.parse(await fs.readFile(taskFile, 'utf8').catch(() => '{"tasks":[]}'));
  return asArray(data?.tasks).find(task => String(task?.id || '') === String(id || '')) || null;
}

async function updateRawTaskById(id, update) {
  const data = JSON.parse(await fs.readFile(taskFile, 'utf8').catch(() => '{"tasks":[]}'));
  const tasks = asArray(data?.tasks);
  const index = tasks.findIndex(task => String(task?.id || '') === String(id || ''));
  if (index < 0) throw new Error(`Task not found for test update: ${id}`);
  tasks[index] = update(tasks[index]);
  await fs.writeFile(taskFile, JSON.stringify({...data, tasks}, null, 2), 'utf8');
  return tasks[index];
}

function writeAuditFromExecute(json) {
  return json?.execution?.writeAudit || json?.task?.execution?.writeAudit || json?.task?.writeAudit || null;
}

function executorEvidenceFromAudit(writeAudit, storeKey = 'HL') {
  const key = String(storeKey || '').trim().toUpperCase();
  return asArray(writeAudit?.executorEvidence).find(row => String(row?.storeKey || '').trim().toUpperCase() === key) || null;
}

function taskLifecycle(json) {
  return json?.task?.lifecycle || json?.task?.execution?.lifecycle || null;
}

function requestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch {}
      resolve({text, json});
    });
    req.on('error', reject);
  });
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'});
  res.end(JSON.stringify(value));
}

const productCase = GENERIC_PRODUCT ? {
  targetSupplierCode: 'HL-GENERIC-COPY-SKC',
  targetSupplierSku: 'HL-GENERIC-COPY-SKU-001',
  command: '复制上品/补链接 SK-9000空气炸锅 到 HL',
  productRefs: ['SK-9000空气炸锅'],
  englishName: 'Generic copy smoke product',
  arName: 'منتج اختبار عام',
  zhName: 'SK-9000空气炸锅',
  productModel: 'SK-9000',
  requireInputCurrent: false,
} : {
  targetSupplierCode: 'HL-COPY-SUCCESS-SKC',
  targetSupplierSku: 'HL-COPY-SUCCESS-SKU-001',
  command: '复制上品/补链接 SM-505A缝纫机 到 HL',
  productRefs: ['SM-505A电动缝纫机', '505'],
  englishName: 'Copy success smoke product',
  arName: 'ماكينة خياطة اختبار',
  zhName: 'SM-505A电动缝纫机',
  productModel: 'TXSM-505A',
  requireInputCurrent: true,
};
const taskStandardGoodsSn = productCase.productRefs[0];
const targetSupplierCode = productCase.targetSupplierCode;
const targetSupplierSku = productCase.targetSupplierSku;
// Valid isSheinSkc source identity used ONLY for the task exact source lock and
// the source-store searchProduct/spu-info fixture. The NEW SKC returned by the
// publish endpoint stays 'sv-smoke-copy-product' and is used by the readback
// tests; the two identities must never be mixed.
const SOURCE_SKC = 'sv25082902871830770';
const SOURCE_SPU = 'v209901010000';
const SOURCE_SUPPLIER_CODE = productCase.requireInputCurrent ? 'SM-505A' : 'SRC-COPY-SUCCESS-CODE';
const SOURCE_DETAIL_AT = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const sourceLinkFixtureDir = path.join(testOutputDir, 'shein_links', 'DL');
const sourceOpenApiFixtureDir = path.join(testOutputDir, 'shein_openapi_products', 'DL');
async function writeSourceDetailFixtures() {
  await fs.mkdir(sourceLinkFixtureDir, {recursive: true});
  await fs.mkdir(sourceOpenApiFixtureDir, {recursive: true});
  await fs.writeFile(path.join(sourceLinkFixtureDir, '2099-01-01.json'), `${JSON.stringify({
    linkRows: [{
      storeKey: 'DL',
      skc: SOURCE_SKC,
      spu: SOURCE_SPU,
      standardGoodsSn: 'SM-505A',
      productNameCn: 'Copy success source SM-505A',
      rawGoodsSn: 'SOURCE-RAW-COPY-SUCCESS',
    }],
    inventoryRows: [],
    performanceRows: [],
  }, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(sourceOpenApiFixtureDir, 'latest.json'), `${JSON.stringify({
    schemaVersion: 'shein-openapi-product-basics/v1',
    storeKey: 'DL',
    fetchedAt: SOURCE_DETAIL_AT,
    normalizedRows: [{spu: SOURCE_SPU, skc: SOURCE_SKC}],
    detailResults: [{
      ok: true,
      detailFetchedAt: SOURCE_DETAIL_AT,
      info: {
        spuName: SOURCE_SPU,
        categoryId: 123456,
        productTypeId: 789,
        brandCode: 'BRAND_SMOKE',
        productMultiNameList: [
          {language: 'en', productName: 'Copy success source product'},
          {language: 'ar', productName: 'منتج مصدر النسخ'},
        ],
        productAttributeInfoList: [
          {attributeId: 1000546, attributeValueId: 0, attributeValue: 'TXSM-505A'},
        ],
        skcInfoList: [{
          skcName: SOURCE_SKC,
          supplierCode: SOURCE_SUPPLIER_CODE,
          skcImageInfoList: [
            {imageUrl: 'https://example.invalid/copy-main.jpg', imageType: 'MAIN'},
            {imageUrl: 'https://example.invalid/copy-detail.jpg', imageType: 'DETAIL'},
            {imageUrl: 'https://example.invalid/copy-square.jpg', imageType: 'SQUARE'},
          ],
          saleAttributeList: [{attributeId: 301, attributeValueId: 401}],
          skuInfoList: [{
            skuCode: 'SKU-SRC-COPY-SUCCESS',
            supplierSku: '',
            length: '31.10',
            width: '29.50',
            height: '14.70',
            weight: 2500,
            sellerSkuWeight: {length: '31.10', width: '29.50', height: '14.70', weight: 2500},
            mallState: 1,
            saleAttributeList: [{attributeId: 301, attributeValueId: 401}],
            costInfoList: [
              {currency: 'CNY', costPrice: 205.21},
              {currency: 'SAR', costPrice: 124.44},
            ],
          }],
        }],
      },
    }],
    detailFallbackResults: [],
  }, null, 2)}\n`, 'utf8');
}
async function removeSourceDetailFixtures() {
  await fs.rm(sourceLinkFixtureDir, {recursive: true, force: true});
  await fs.rm(sourceOpenApiFixtureDir, {recursive: true, force: true});
}
const publishTraceId = 'trace-copy-success-smoke';
const descriptionLines = {
  ar: ['نقطة مراجعة أولى', 'نقطة مراجعة ثانية', 'نقطة مراجعة ثالثة', 'نقطة مراجعة رابعة', 'نقطة مراجعة خامسة'],
  en: [
    `Reviewed long point ${'x'.repeat(360)}`,
    'Reviewed  point with preserved double spaces',
    'Reviewed point three',
    'Reviewed point four',
    'Reviewed point five',
  ],
  'zh-cn': ['审核卖点一', '审核卖点二', '审核卖点三', '审核卖点四', '审核卖点五'],
};
// Material update used by --prevalid-retry-rebind: same five-line shape, new
// English line one. The fake readback serves these lines after the rebind so
// the retry's description readback matches the newly bound material.
const reboundDescriptionLines = {
  ...descriptionLines,
  en: [`Reviewed rebound long point ${'r'.repeat(360)}`, ...descriptionLines.en.slice(1)],
};
const reboundSourceHtml = `<!doctype html><html><body><section id="s09">
<article class="card"><h3>英文</h3><code>${reboundDescriptionLines.en.join('\n')}</code></article>
<article class="card"><h3>阿文</h3><code>${reboundDescriptionLines.ar.join('\n')}</code></article>
<div class="displaybox">${reboundDescriptionLines['zh-cn'].map(line => `<div>${line}</div>`).join('')}</div>
</section></body></html>`;
const reboundSourceBytes = Buffer.from(reboundSourceHtml, 'utf8');
const reboundMaterial = {
  schemaVersion: 1,
  sourceLabel: 'copy-success-rebound.html',
  sourceFileSha256: sha256Utf8(reboundSourceBytes),
  rows: Object.fromEntries(Object.entries(reboundDescriptionLines).map(([language, lines]) => [language, {
    language,
    lines,
    sha256: sha256Utf8(lines.join('\n')),
  }])),
};
const descriptionSourceHtml = `<!doctype html><html><body><section id="s09">
<article class="card"><h3>英文</h3><code>${descriptionLines.en.join('\n')}</code></article>
<article class="card"><h3>阿文</h3><code>${descriptionLines.ar.join('\n')}</code></article>
<div class="displaybox">${descriptionLines['zh-cn'].map(line => `<div>${line}</div>`).join('')}</div>
</section></body></html>`;
const descriptionSourceBytes = Buffer.from(descriptionSourceHtml, 'utf8');
const descriptionMaterial = {
  schemaVersion: 1,
  sourceLabel: 'copy-success-reviewed.html',
  sourceFileSha256: sha256Utf8(descriptionSourceBytes),
  rows: Object.fromEntries(Object.entries(descriptionLines).map(([language, lines]) => [language, {
    language,
    lines,
    sha256: sha256Utf8(lines.join('\n')),
  }])),
};
const publishPayload = {
  category_id: 123456,
  product_type_id: 789,
  source_system: 'OpenAPI',
  brand_code: 'BRAND_SMOKE',
  site_list: [{main_site: 'shein', sub_site_list: ['shein-sa']}],
  multi_language_name_list: [
    {language: 'en', product_name: productCase.englishName},
    {language: 'ar', product_name: productCase.arName},
  ],
  product_attribute_list: [
    {attribute_id: 101, attribute_value_id: 202},
    {attribute_id: 1000546, attribute_value_id: 0, attribute_value: productCase.productModel},
    ...(productCase.requireInputCurrent ? [
      {attribute_id: 1000616, attribute_value_id: 1004580},
      {attribute_id: 1000462, attribute_value_id: 1006206},
      {attribute_id: 147, attribute_value_id: 1007239},
      {attribute_id: 1001466, attribute_value_id: 2535083},
    ] : []),
  ],
  shelf_way: 2,
  hope_on_sale_date: '2036-06-27 10:00:00',
  skc_list: [{
    supplier_code: targetSupplierCode,
    skc_name: productCase.targetSupplierCode,
    image_info: {
      image_info_list: [
        {
          image_type: 1,
          image_sort: 1,
          image_url: 'https://example.invalid/smoke-main.jpg',
        },
        {
          image_type: 5,
          image_sort: 1,
          image_url: 'https://example.invalid/smoke-square.jpg',
        },
      ],
    },
    sale_attribute: {attribute_id: 301, attribute_value_id: 401},
    sku_list: [{
      supplier_sku: targetSupplierSku,
      mall_state: 1,
      height: 10,
      length: 20,
      width: 30,
      weight: 1.5,
      cost_info: {currency: 'SAR', cost_price: '99.00'},
      stock_info_list: [{warehouse_id: 'WH-SMOKE', stock: 100}],
    }],
  }],
};

const fakeOpenApiPort = await getFreePort();
const fakeOpenApiCalls = [];
let publishAttemptCount = 0;
const fakeOpenApi = http.createServer(async (req, res) => {
  const body = await requestBody(req);
  fakeOpenApiCalls.push({method: req.method, path: req.url.split('?')[0], url: req.url, body: body.json || body.text, publishAttemptCount});
  const pathname = req.url.split('?')[0];
  const isDlCredential = String(req.headers['x-lt-openkeyid'] || '') === 'dummy-open-key-dl';
  if (pathname === '/open-api/openapi-business-backend/query-store-info') {
    return sendJson(res, {
      code: '0',
      msg: 'OK',
      info: {
        accountNo: isDlCredential ? 'GS5337922' : 'GS8313514',
        merchantId: isDlCredential ? '6720288' : '12224658',
        companyName: isDlCredential ? '地利' : '皓兰',
        shopName: isDlCredential ? 'Copy Success DL Source' : 'Copy Success HL',
      },
    });
  }
  if (pathname === '/open-api/goods/product/check-publish-permission') {
    return sendJson(res, {
      code: '0',
      msg: 'OK',
      info: {
        canPublishProduct: true,
        reason: '',
      },
    });
  }
  if (pathname === '/open-api/goods/query-site-list') {
    return sendJson(res, {
      code: '0',
      msg: 'OK',
      info: [{
        main_site: 'shein',
        main_site_name: 'SHEIN',
        sub_site_list: [{site_abbr: 'shein-sa', site_name: 'SHEIN Saudi Arabia', currency: 'SAR', site_status: 1}],
      }],
    });
  }
  if (pathname === '/open-api/goods/query-brand-list') {
    return sendJson(res, {
      code: '0',
      msg: 'OK',
      info: [{brand_code: 'BRAND_SMOKE', brand_name: 'Smoke Brand'}],
    });
  }
  if (pathname === '/open-api/msc/warehouse/list') {
    return sendJson(res, {
      code: '0',
      msg: 'OK',
      info: [{supplier_warehouse_id: 'WH-SMOKE', supplier_warehouse_name: 'Smoke Warehouse', status: 1}],
    });
  }
  if (pathname === '/open-api/goods/product/publishOrEdit') {
    publishAttemptCount += 1;
    const strongPayload = body.json || {};
    const defaultTitle = (strongPayload?.multi_language_name_list || []).find(row => String(row?.language || '').toLowerCase() === 'ar');
    if (!defaultTitle?.name) {
      return sendJson(res, {code: '400', msg: 'default ar title missing', traceId: publishTraceId}, 200);
    }
    if (Array.isArray(strongPayload?.skc_list?.[0]?.sale_attribute)) {
      return sendJson(res, {code: '400', msg: 'sale_attribute must be object, not array', traceId: publishTraceId}, 200);
    }
    const imageRows = strongPayload?.skc_list?.[0]?.image_info?.image_info_list || [];
    const allowedImageTypes = new Set([1, 2, 5, 6]);
    if (!imageRows.length || imageRows.some(row => !allowedImageTypes.has(Number(row?.image_type)))) {
      return sendJson(res, {code: '400', msg: 'SKC image_type must be one of 1/2/5/6', traceId: publishTraceId}, 200);
    }
    if (imageRows.filter(row => Number(row?.image_type) === 1).length !== 1 || Number(imageRows.find(row => Number(row?.image_type) === 1)?.image_sort) !== 1) {
      return sendJson(res, {code: '400', msg: 'SKC image main type must be exactly one and sort=1', traceId: publishTraceId}, 200);
    }
    const imageSorts = imageRows.map(row => Number(row?.image_sort));
    if (new Set(imageSorts).size !== imageSorts.length) {
      return sendJson(res, {code: '400', msg: 'SKC image_sort must be globally unique', traceId: publishTraceId}, 200);
    }
    if (strongPayload?.skc_list?.[0]?.supplier_code !== taskStandardGoodsSn) {
      return sendJson(res, {code: '400', msg: 'unexpected standard goods sn override', traceId: publishTraceId}, 200);
    }
    const attrs = strongPayload?.product_attribute_list || [];
    const inputCurrent = attrs.find(row => Number(row?.attribute_id) === 1002323);
    const inputVoltage = attrs.find(row => Number(row?.attribute_id) === 1002322);
    const hazardousClassification = attrs.find(row => Number(row?.attribute_id) === 1002328);
    const productModel = attrs.find(row => Number(row?.attribute_id) === 1000546);
    if (productCase.requireInputCurrent) {
      if (inputCurrent?.attribute_extra_value !== '1200' || Number(inputCurrent?.attribute_value_id) !== 304302428) {
        return sendJson(res, {code: '400', msg: 'manual input current override missing or malformed', traceId: publishTraceId}, 200);
      }
      if (inputVoltage?.attribute_extra_value !== '220-240' || Number(inputVoltage?.attribute_value_id) !== 301114341) {
        return sendJson(res, {code: '400', msg: 'Power Adapter input voltage missing or malformed', traceId: publishTraceId}, 200);
      }
      if (Number(hazardousClassification?.attribute_value_id) !== 316914660) {
        return sendJson(res, {code: '400', msg: 'hazardous materials classification missing or malformed', traceId: publishTraceId}, 200);
      }
    } else if (inputCurrent) {
      return sendJson(res, {code: '400', msg: 'generic product unexpectedly received SM-505 input current', traceId: publishTraceId}, 200);
    }
    if (productModel?.attribute_extra_value !== productCase.productModel || productModel?.attribute_value_id !== undefined || productModel?.attribute_value !== undefined) {
      return sendJson(res, {code: '400', msg: 'product model must remain the pure model value', traceId: publishTraceId}, 200);
    }
    if (Number(strongPayload?.shelf_way) !== 2 || !strongPayload?.hope_on_sale_date) {
      return sendJson(res, {code: '400', msg: 'new link must be scheduled ten years later at payload level', traceId: publishTraceId}, 200);
    }
    if (Number(strongPayload?.skc_list?.[0]?.shelf_way) !== 2 || !strongPayload?.skc_list?.[0]?.hope_on_sale_date) {
      return sendJson(res, {code: '400', msg: 'new link must be scheduled ten years later at skc level', traceId: publishTraceId}, 200);
    }
    if (MISSING_SUCCESS) {
      // code=0 with an info object that carries NO explicit success flag:
      // uncertainty, never an explicit pre-validation rejection.
      return sendJson(res, {
        code: '0',
        msg: 'OK',
        traceId: publishTraceId,
        info: {},
      });
    }
    if (PREVALID_FAIL || (PREVALID_RETRY && publishAttemptCount === 1)) {
      return sendJson(res, {
        code: '0',
        msg: 'OK',
        traceId: publishTraceId,
        info: {
          success: false,
          pre_valid_result: [
            {
              module: descriptionLines.en[2],
              form_name: descriptionLines.en[1],
              messages: ['商品标题不能为空', `echo:${descriptionLines.en[0]}`, `spacing:${descriptionLines.en[1]}`],
            },
            {module: 'attribute', form_name: '商品属性', messages: ['产品型号，为必填项']},
          ],
        },
      });
    }
    return sendJson(res, {
      code: '0',
      msg: 'OK',
      traceId: publishTraceId,
      info: {
        success: true,
        taskNo: 'PUB-SMOKE-001',
        spu_name: 'v-smoke-copy-product',
        skc_list: [{
          skc_name: 'sv-smoke-copy-product',
          sku_list: [{sku_code: 'sku-smoke-copy-product'}],
        }],
        version: 'SPMP-SMOKE-001',
      },
    });
  }
  if (pathname === '/open-api/goods/query-document-state') {
    const item = body.json?.spuList?.[0] || {};
    if (String(item.spuName || '').toLowerCase() === 'b2608062023343035' && item.version === 'SPMP260806300745650') {
      return sendJson(res, {code: '0', msg: 'OK', info: {data: [{spuName: 'b2608062023343035', version: 'SPMP260806300745650', skcList: [{skcName: 'sb260806202334303501938', documentState: 1}]}]}});
    }
    return sendJson(res, {code: '0', msg: 'OK', info: {data: []}});
  }
  if (pathname === '/open-api/goods/query-publish-fill-in-standard') {
    return sendJson(res, {
      code: '0',
      msg: 'OK',
      info: {
        default_language: 'ar',
        default_language_title_max_length: 325,
        language_title_max_length_list: [
          {language: 'ar', max_length: 325},
          {language: 'en', max_length: 250},
        ],
        currency: 'SAR',
        fill_in_standard_list: [],
      },
    });
  }
  if (pathname === '/open-api/goods/query-attribute-template') {
    return sendJson(res, {
      code: '0',
      msg: 'OK',
      info: {
        data: [{
          product_type_id: 789,
          attribute_infos: [
            {attribute_id: 1000546, attribute_name: 'Product Model', attribute_mode: 0, attribute_type: 4, attribute_status: 2, attribute_value_info_list: []},
            ...(productCase.requireInputCurrent ? [
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
                attribute_value_info_list: [{attribute_value_id: 2535083, attribute_value: 'UK Plug(220-240V)'}],
              },
              {
                attribute_id: 1000462,
                attribute_name: 'Hazard Category',
                attribute_mode: 1,
                attribute_type: 4,
                attribute_status: 2,
                attribute_value_info_list: [{attribute_value_id: 1006206, attribute_value: 'Others (Non-Transport Sensitive Items)'}],
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
            ] : []),
            {
              attribute_id: 1002323,
              attribute_name: 'Input current',
              attribute_mode: 4,
              attribute_type: 4,
              attribute_status: 2,
              attribute_value_info_list: [
                {attribute_value_id: 304302428, attribute_value: 'mA'},
                {attribute_value_id: 304301999, attribute_value: 'A'},
              ],
            },
          ],
        }],
      },
    });
  }
  if (pathname === '/open-api/goods/spu-info') {
    const requestedSpu = String(body.json?.spuName || '').trim();
    const searchProductAlreadyCalled = fakeOpenApiCalls.some(call => call.path === '/open-api/goods/searchProduct');
    const targetSearchProductAfterPublish = fakeOpenApiCalls.some(call => call.path === '/open-api/goods/searchProduct' && call.publishAttemptCount > 0);
    if (requestedSpu === 'v-smoke-copy-product'
      && publishAttemptCount > 0
      && !WEAK_READBACK_ONLY
      && (!SEARCH_PRODUCT_READBACK || targetSearchProductAfterPublish)) {
      return sendJson(res, {
        code: '0',
        msg: 'OK',
        info: {
          spuName: 'v-smoke-copy-product',
          productMultiDescList: [
            {language: 'ar', productDesc: descriptionLines.ar.join('\n')},
            {language: 'en', productDesc: descriptionLines.en.join('\n')},
          ],
          skcInfoList: [{
            skcName: 'sv-smoke-copy-product',
            supplierCode: taskStandardGoodsSn,
            skuInfoList: [{skuCode: 'sku-smoke-copy-product', supplierSku: taskStandardGoodsSn}],
          }],
        },
      });
    }
    if (requestedSpu === SOURCE_SPU
      && (publishAttemptCount === 0
        || (!WEAK_READBACK_ONLY && (!SEARCH_PRODUCT_READBACK || searchProductAlreadyCalled)))) {
      return sendJson(res, {
        code: '0',
        msg: 'OK',
        info: {
          spuName: SOURCE_SPU,
          productAttributeInfoList: [
            {attributeId: 1000546, attributeValueId: 0, attributeValue: productCase.productModel},
            ...(productCase.requireInputCurrent ? [{attributeId: 1002328, attributeValueId: 316914660}] : []),
          ],
          productMultiDescList: [
            {language: 'ar', productDesc: (PREVALID_RETRY_REBIND ? reboundDescriptionLines : descriptionLines).ar.join('\n')},
            {language: 'en', productDesc: (PREVALID_RETRY_REBIND ? reboundDescriptionLines : descriptionLines).en.join('\n')},
          ],
          skcInfoList: [{
            skcName: SOURCE_SKC,
            supplierCode: isDlCredential ? SOURCE_SUPPLIER_CODE : targetSupplierCode,
            skuInfoList: [{
              skuCode: 'sku-smoke-copy-product',
              supplierSku: targetSupplierSku,
            }],
            productMultiNameList: [
              {language: 'en', productName: productCase.englishName},
              {language: 'ar', productName: productCase.arabicName},
            ],
          }],
        },
      });
    }
    return sendJson(res, {
      code: '404',
      msg: `spu-info not found in smoke: ${requestedSpu}`,
      info: null,
    }, 200);
  }
  if (pathname === '/open-api/goods/searchProduct') {
    // Exact source SKC -> SPU resolution for bound-payload copies: the source
    // store searchProduct must resolve exactly one case-sensitive SPU.
    if (isDlCredential && asArray(body.json?.skcNameList).includes(SOURCE_SKC)) {
      return sendJson(res, {
        code: '0',
        msg: 'OK',
        info: {
          list: [{
            spuName: SOURCE_SPU,
            skcList: [{skcName: SOURCE_SKC, supplierCode: SOURCE_SUPPLIER_CODE}],
          }],
          count: 1,
        },
      });
    }
    if (SEARCH_PRODUCT_READBACK && publishAttemptCount > 0 && !WEAK_READBACK_ONLY && !isDlCredential) {
      const skcNames = asArray(body.json?.skcNameList).map(String);
      const spuNames = asArray(body.json?.spuNameList).map(String);
      const skuCodes = asArray(body.json?.skuCodeList).map(String);
      const supplierCodes = asArray(body.json?.skcSupplierCodeList).map(String);
      const supplierSkus = asArray(body.json?.supplierSkuList).map(String);
      const shouldMatch =
        spuNames.includes('v-smoke-copy-product') ||
        skcNames.includes('sv-smoke-copy-product') ||
        skuCodes.includes('sku-smoke-copy-product') ||
        supplierCodes.includes(targetSupplierCode) ||
        supplierSkus.includes(targetSupplierSku);
      if (shouldMatch) {
        return sendJson(res, {
          code: '0',
          msg: 'OK',
          info: {
            list: [{
              spuName: 'v-smoke-copy-product',
              spuShelfStatus: 2,
              skcList: [{
                skcName: 'sv-smoke-copy-product',
                skcShelfStatus: 2,
                supplierCode: targetSupplierCode,
                skuList: [{
                  skuCode: 'sku-smoke-copy-product',
                  supplierSku: targetSupplierSku,
                }],
              }],
            }],
            count: 1,
          },
        });
      }
    }
    return sendJson(res, {code: '0', msg: 'OK', info: {list: [], count: 0}});
  }
  if (pathname === '/open-api/openapi-business-backend/product/query') {
    return sendJson(res, {
      code: '0',
      msg: 'OK',
      info: {
        data: [{
          spuName: 'Smoke SPU',
          skcName: productCase.targetSupplierCode,
          ...(WEAK_READBACK_ONLY ? {} : {
            supplierCode: targetSupplierCode,
            supplierSku: targetSupplierSku,
          }),
          skuCodeList: ['PLATFORM-SKU-SMOKE'],
          productName: WEAK_READBACK_ONLY ? 'Copy source weak readback candidate' : productCase.englishName,
        }],
      },
    });
  }
  return sendJson(res, {code: '404', msg: `Unhandled fake endpoint: ${pathname}`}, 404);
});
await new Promise(resolve => fakeOpenApi.listen(fakeOpenApiPort, '127.0.0.1', resolve));

const authFile = await writeJson('auth.json', {
  users: [{
    username: 'owner_copy_success',
    password: 'owner-pass',
    displayName: 'Owner Copy Success',
    role: 'owner',
    readStores: ['*'],
    writeStores: ['*'],
    ownerKey: 'OWNER_COPY_SUCCESS',
  }, {
    username: 'operator_copy_success',
    password: 'operator-pass',
    displayName: 'Operator Copy Success',
    role: 'operator',
    readStores: ['*'],
    writeStores: ['HL'],
    ownerKey: 'OPERATOR_COPY_SUCCESS',
  }],
});
const accessRolesFile = await writeJson('access_roles.json', {
  defaults: {
    owner: {readStores: ['*'], writeStores: ['*']},
    operator: {readStores: ['*'], writeStores: []},
  },
});
const openapiConfigFile = await writeJson('openapi.json', {
  environment: 'copy-success-smoke',
  cooperationMode: '半托管',
  market: 'SA',
  apiBaseUrls: {
    prodSemiManaged: `http://127.0.0.1:${fakeOpenApiPort}`,
  },
  stores: [{
    storeKey: 'HL',
    shopName: 'Copy Success HL',
    enabled: true,
    openKeyId: 'dummy-open-key-hl',
    secretKey: 'dummy-secret-hl',
    authorizedAt: '2026-06-27T00:00:00.000+08:00',
  }, {
    // Read-only source-store credential for the exact source lock live
    // verification (searchProduct + spu-info against the same fake server).
    storeKey: 'DL',
    shopName: 'Copy Success DL Source',
    enabled: true,
    openKeyId: 'dummy-open-key-dl',
    secretKey: 'dummy-secret-dl',
    authorizedAt: '2026-06-27T00:00:00.000+08:00',
  }],
  safeWriteOperations: {
    enabled: true,
    requireDryRun: true,
    allowedOperations: ['copy_product_draft'],
    allowedStores: ['HL'],
  },
});
const whitelistFile = await writeJson('whitelist.json', {
  enabled: true,
  rules: [{
    id: 'owner-hl-copy-success',
    enabled: true,
    realSubmit: true,
    stores: ['HL'],
    operations: ['copy_product_draft'],
    allowedUsers: ['owner_copy_success'],
    allowedOwnerKeys: ['OWNER_COPY_SUCCESS'],
    allowedRoles: ['owner'],
  }],
});
const readProbeSummaryFile = await writeJson('read-probes.latest.json', {
  generatedAt: new Date().toISOString(),
  counts: {total: 1, readProbeOk: 1, pending: 0, failed: 0},
  results: [{storeKey: 'HL', ok: true, status: 'read_probe_ok'}],
});
await writeSourceDetailFixtures();
const htpasswdFile = path.join(tmpRoot, 'empty.htpasswd');
await fs.writeFile(htpasswdFile, '', 'utf8');
const stateFile = path.join(tmpRoot, 'action_state.json');
const taskFile = path.join(tmpRoot, 'tasks.json');
const chatFile = path.join(tmpRoot, 'chats.json');
const auditFile = path.join(tmpRoot, 'audit.jsonl');
const sessionSecretFile = path.join(tmpRoot, 'session_secret');
await provisionBiSessionSecret(sessionSecretFile);
const manualLoginStateFile = path.join(tmpRoot, 'manual_login.json');

const portalPort = await getFreePort();
const portal = spawn(process.execPath, [
  'scripts/serve_bi_portal.mjs',
  '--host', '127.0.0.1',
  '--port', String(portalPort),
  '--auth-file', authFile,
  '--access-roles-file', accessRolesFile,
  '--htpasswd-file', htpasswdFile,
  '--session-secret-file', sessionSecretFile,
  '--state-file', stateFile,
  '--link-ops-task-file', taskFile,
  '--link-ops-chat-file', chatFile,
  '--manual-login-state-file', manualLoginStateFile,
  '--audit-file', auditFile,
], {
  cwd: ROOT,
  env: {
    ...process.env,
    NODE_ENV: 'test',
    SHEIN_BI_TEST_ALLOW_FAKE_WEBHOOK_GATE: '1',
    SHEIN_BI_CORE_WARMUP_DISABLED: '1',
    SHEIN_OPENAPI_CONFIG_FILE: openapiConfigFile,
    SHEIN_BI_OPS_WRITE_WHITELIST_FILE: whitelistFile,
    SHEIN_OPENAPI_READ_PROBE_SUMMARY_FILE: readProbeSummaryFile,
    SHEIN_LINK_OPS_OPENAPI_EXECUTOR_TIMEOUT_MS: '5000',
    SHEIN_LINK_OPS_READBACK_MAX_PAGES: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let portalStdout = '';
let portalStderr = '';
portal.stdout.on('data', d => { portalStdout += d.toString(); });
portal.stderr.on('data', d => { portalStderr += d.toString(); });

const base = `http://127.0.0.1:${portalPort}`;
async function reqAt(baseUrl, pathname, {method = 'GET', cookie = '', body = undefined, signal = undefined} = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(body !== undefined ? {'Content-Type': 'application/json'} : {}),
      ...(cookie ? {Cookie: cookie} : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
    signal,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return {status: res.status, headers: res.headers, text, json};
}
const req = (pathname, options = {}) => reqAt(base, pathname, options);

function portalSpawnArgs(port) {
  return [
    'scripts/serve_bi_portal.mjs',
    '--host', '127.0.0.1',
    '--port', String(port),
    '--auth-file', authFile,
    '--access-roles-file', accessRolesFile,
    '--htpasswd-file', htpasswdFile,
    '--session-secret-file', sessionSecretFile,
    '--state-file', stateFile,
    '--link-ops-task-file', taskFile,
    '--link-ops-chat-file', chatFile,
    '--manual-login-state-file', manualLoginStateFile,
    '--audit-file', auditFile,
  ];
}

function portalSpawnEnv(extra = {}) {
  return {
    ...process.env,
    NODE_ENV: 'test',
    SHEIN_BI_TEST_ALLOW_FAKE_WEBHOOK_GATE: '1',
    SHEIN_BI_CORE_WARMUP_DISABLED: '1',
    SHEIN_OPENAPI_CONFIG_FILE: openapiConfigFile,
    SHEIN_BI_OPS_WRITE_WHITELIST_FILE: whitelistFile,
    SHEIN_OPENAPI_READ_PROBE_SUMMARY_FILE: readProbeSummaryFile,
    SHEIN_LINK_OPS_OPENAPI_EXECUTOR_TIMEOUT_MS: '5000',
    SHEIN_LINK_OPS_READBACK_MAX_PAGES: '1',
    ...extra,
  };
}

const auxiliaryPortals = [];
async function startAuxiliaryPortal(extraEnv = {}) {
  const port = await getFreePort();
  const proc = spawn(process.execPath, portalSpawnArgs(port), {
    cwd: ROOT,
    env: portalSpawnEnv(extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  auxiliaryPortals.push(proc);
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', d => { stdout += d.toString(); });
  proc.stderr.on('data', d => { stderr += d.toString(); });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`aux portal exited code=${proc.exitCode}\nstdout=${stdout}\nstderr=${stderr}`);
    try {
      const ready = await fetch(`${baseUrl}/login`, {redirect: 'manual'});
      if (ready.status >= 200 && ready.status < 500) break;
    } catch {}
    await sleep(200);
  }
  const loginResult = await reqAt(baseUrl, '/api/login', {
    method: 'POST',
    body: {username: 'owner_copy_success', password: 'owner-pass'},
  });
  const cookie = (loginResult.headers.get('set-cookie') || '').match(/bi_session=[^;]+/)?.[0] || '';
  if (loginResult.status !== 200 || !cookie) {
    throw new Error(`aux portal login failed status=${loginResult.status} body=${loginResult.text}\nstdout=${stdout}\nstderr=${stderr}`);
  }
  return {proc, baseUrl, cookie, logs: () => ({stdout, stderr})};
}

async function waitReady() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (portal.exitCode !== null) throw new Error(`portal exited code=${portal.exitCode}\nstdout=${portalStdout}\nstderr=${portalStderr}`);
    try {
      const r = await fetch(`${base}/login`, {redirect: 'manual'});
      if (r.status >= 200 && r.status < 500) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`portal not ready\nstdout=${portalStdout}\nstderr=${portalStderr}`);
}

async function login(username, password) {
  const r = await req('/api/login', {method: 'POST', body: {username, password}});
  const setCookie = r.headers.get('set-cookie') || '';
  const cookie = (setCookie.match(/bi_session=[^;]+/) || [''])[0];
  if (r.status !== 200 || !cookie) throw new Error(`login failed ${username}: status=${r.status} body=${r.text}`);
  return cookie;
}

const result = {ok: false, scenario: `${CHAT_NATURAL ? 'chat-natural-' : ''}${GENERIC_PRODUCT ? 'generic-product-' : ''}${WEAK_READBACK_ONLY ? 'weak-readback-only' : MISSING_SUCCESS ? 'missing-success' : PREVALID_FAIL ? 'prevalid-fail' : PREVALID_RETRY_REBIND ? 'prevalid-retry-rebind' : PREVALID_RETRY ? 'prevalid-retry' : 'strong-readback-success'}`, tmpRoot, fakeOpenApiPort, portalPort, summary: {}, checks: []};
function check(label, actual, expected) {
  const pass = typeof expected === 'function' ? expected(actual) : actual === expected;
  result.checks.push({label, actual, expected: typeof expected === 'function' ? expected.name || 'predicate' : expected, pass});
  return pass;
}

/**
 * Publish-assets single-task CAS scenario against the real HTTP endpoints.
 *
 * All writes here go through POST /api/link-ops-publish-assets and
 * /api/link-ops-prepare-descriptions on serve_bi_portal.mjs instances that
 * share the same JSON repository file (two independent gateways, one
 * repository). A dedicated pause portal waits at the CAS gate after preparing
 * the publish-assets binding, so the competing description binding commits
 * first at the same base revision and the paused request must observe a
 * repository-level 409 instead of silently overwriting.
 */
let casPortalProc = null;
async function runPublishAssetsCasScenario({cookie}) {
  const checkAt = (label, actual, expected) => check(`publish-assets CAS: ${label}`, actual, expected);

  const casCreate = await req('/api/link-ops-tasks', {
    method: 'POST',
    cookie,
    body: {
      source: 'publish_assets_cas_smoke',
      command: `CAS 冒烟：${productCase.command}`,
      targets: {
        stores: ['HL'],
        sourceStores: ['DL'],
        sourceSkc: SOURCE_SKC,
        productRefs: productCase.productRefs,
        standardGoodsSn: taskStandardGoodsSn,
      },
    },
  });
  const casTaskId = extractTaskId(casCreate.json);
  checkAt('race task create status', casCreate.status, 200);
  checkAt('race task id present', Boolean(casTaskId), true);
  const casUpload = await req('/api/link-ops-assets', {
    method: 'POST',
    cookie,
    body: {
      taskId: casTaskId,
      files: [{
        name: 'publish-payload.json',
        type: 'application/json',
        sourceApproved: true,
        approvalKind: 'human_reviewed_publish_payload',
        dataBase64: b64Json({publishPayload}),
      }],
    },
  });
  checkAt('race task payload upload status', casUpload.status, 200);
  const casRevision = Number((await rawTaskById(casTaskId))?.repositoryRevision || 0);
  checkAt('race task has repository revision', casRevision > 0, true);

  const casPortalPort = await getFreePort();
  const casMarker = path.join(tmpRoot, 'publish-assets-cas-ready');
  casPortalProc = spawn(process.execPath, portalSpawnArgs(casPortalPort), {
    cwd: ROOT,
    env: portalSpawnEnv({SHEIN_LINK_OPS_TEST_PUBLISH_ASSETS_CAS_READY_MARKER: casMarker}),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  auxiliaryPortals.push(casPortalProc);
  let casPortalStdout = '';
  let casPortalStderr = '';
  casPortalProc.stdout.on('data', d => { casPortalStdout += d.toString(); });
  casPortalProc.stderr.on('data', d => { casPortalStderr += d.toString(); });
  const casBaseUrl = `http://127.0.0.1:${casPortalPort}`;
  const casDeadline = Date.now() + 15000;
  let casPortalReady = false;
  while (Date.now() < casDeadline) {
    if (casPortalProc.exitCode !== null) throw new Error(`CAS portal exited code=${casPortalProc.exitCode}\nstdout=${casPortalStdout}\nstderr=${casPortalStderr}`);
    try {
      const r = await fetch(`${casBaseUrl}/login`, {redirect: 'manual'});
      if (r.status >= 200 && r.status < 500) { casPortalReady = true; break; }
    } catch {}
    await sleep(200);
  }
  checkAt('pause portal ready', casPortalReady, true);
  const casLogin = await reqAt(casBaseUrl, '/api/login', {method: 'POST', body: {username: 'owner_copy_success', password: 'owner-pass'}});
  const casCookie = (casLogin.headers.get('set-cookie') || '').match(/bi_session=[^;]+/)?.[0] || '';
  checkAt('pause portal login status', casLogin.status, 200);
  checkAt('pause portal cookie present', Boolean(casCookie), true);

  const casPublishBody = {
    taskId: casTaskId,
    store: 'HL',
    sourceApproved: true,
    publishPreparation: {
      standardGoodsSn: taskStandardGoodsSn,
      supplyPrice: 210,
      inventory: 100,
      titleAr: productCase.arName,
      titleEn: productCase.englishName,
    },
    bindings: [
      {name: '02-approved-main.png', role: 'mainCover', imageType: 1, imageUrl: 'https://img.shein.com/approved/main.png', width: 900, height: 1200, order: 1},
      {name: '05-approved-carousel.png', role: 'carouselSecondCover', imageType: 1, imageUrl: 'https://img.shein.com/approved/carousel.png', width: 900, height: 1200, order: 2},
      {name: '11-approved-15-speed.png', role: 'detail', imageType: 2, imageUrl: 'https://img.shein.com/approved/15-speed.png', width: 900, height: 1200, order: 3},
      {name: '12-approved-45db.png', role: 'detail', imageType: 2, imageUrl: 'https://img.shein.com/approved/45db.png', width: 900, height: 1200, order: 4},
      {name: '03-approved-square.png', role: 'squareImage', imageType: 5, imageUrl: 'https://img.shein.com/approved/square.png', width: 1254, height: 1254, order: 5},
    ],
  };
  const pausedPublish = reqAt(casBaseUrl, '/api/link-ops-publish-assets', {
    method: 'POST',
    cookie: casCookie,
    body: casPublishBody,
  });
  let pausedAtGate = false;
  for (let i = 0; i < 400; i += 1) {
    try { await fs.access(`${casMarker}.ready`); pausedAtGate = true; break; } catch {}
    await sleep(50);
  }
  checkAt('publish-assets paused at CAS gate', pausedAtGate, true);
  // Competing description binding against the SAME base revision, issued on
  // the main portal process (different per-process execution lock), sharing
  // the same JSON repository file.
  const casDescBind = await req('/api/link-ops-prepare-descriptions', {
    method: 'POST',
    cookie,
    body: {
      taskId: casTaskId,
      store: 'HL',
      sourceApproved: true,
      materialJson: descriptionMaterial,
      sourceFile: {name: 'cas-reviewed.html', dataBase64: descriptionSourceBytes.toString('base64')},
      expectedRevision: casRevision,
    },
  });
  await fs.writeFile(`${casMarker}.go`, `${new Date().toISOString()}\n`, 'utf8');
  const casPublishResult = await pausedPublish;
  checkAt('competing description binding succeeds', casDescBind.status, 200);
  checkAt('competing description binding read back', casDescBind.json?.bindingCommitted === true && casDescBind.json?.readbackVerified === true, true);
  checkAt('paused publish-assets loses with 409', casPublishResult.status, 409);
  checkAt('publish-assets 409 stable code', casPublishResult.json?.code || '', 'LINK_OPS_REVISION_CONFLICT');
  checkAt('publish-assets 409 retryable', casPublishResult.json?.retryable, true);
  let casRaw = await rawTaskById(casTaskId);
  checkAt('winner description binding persisted', casRaw?.descriptionMaterialBinding?.bindingRequestKey || '', casDescBind.json?.binding?.bindingRequestKey || '');
  checkAt('loser publish-assets persisted nothing', casRaw?.publishAssetBinding || null, null);
  const raceRevision = Number(casRaw?.repositoryRevision || 0);
  checkAt('winner binding bumped exactly one revision', raceRevision, Number(casRevision) + 1);

  // Fresh retry on the main portal: success CAS with strict readback.
  const casRetry = await req('/api/link-ops-publish-assets', {method: 'POST', cookie, body: casPublishBody});
  casRaw = await rawTaskById(casTaskId);
  checkAt('fresh publish-assets retry succeeds', casRetry.status, 200);
  checkAt('fresh publish-assets readback verified', casRetry.json?.readbackVerified, true);
  checkAt('fresh publish-assets persisted revision equals readback', casRetry.json?.persistedRevision || 0, Number(casRaw?.repositoryRevision || 0));
  checkAt('fresh publish-assets response task revision equals readback', casRetry.json?.task?.repositoryRevision || 0, Number(casRaw?.repositoryRevision || 0));
  checkAt('fresh publish-assets fingerprint persisted', casRaw?.publishAssetBinding?.bindingFingerprint || '', casRetry.json?.binding?.bindingFingerprint || '');
  checkAt('fresh publish-assets keeps unique write store', casRaw?.targets?.writeStores || [], xs => asArray(xs).length === 1 && String(xs[0]).toUpperCase() === 'HL');
  checkAt('fresh publish-assets locks standardGoodsSn', casRaw?.targets?.standardGoodsSn || '', taskStandardGoodsSn);
  checkAt('fresh publish-assets locks supplyPrice', casRaw?.targets?.supplyPrice, 210);
  checkAt('fresh publish-assets locks inventory', casRaw?.targets?.inventory, 100);
  checkAt('fresh publish-assets payload supplier_code', casRaw?.openapiPublishPayload?.skc_list?.[0]?.supplier_code || '', taskStandardGoodsSn);
  checkAt('fresh publish-assets payload cost_price', casRaw?.openapiPublishPayload?.skc_list?.[0]?.sku_list?.[0]?.cost_info?.cost_price || '', '210.00');
  checkAt('fresh publish-assets payload inventory applied', asArray(casRaw?.openapiPublishPayload?.skc_list?.[0]?.sku_list?.[0]?.stock_info_list), rows => asArray(rows).some(row => Number(row?.stock ?? row?.inventory_num) === 100));
  checkAt('fresh publish-assets keeps existing description binding', Boolean(casRaw?.descriptionMaterialBinding), true);

  // Old descriptionBindingLock projection must turn stale after publish-assets.
  const casTasks = await req('/api/link-ops-tasks?limit=50', {cookie});
  const casTaskProjection = (casTasks.json?.data?.tasks || []).find(row => row?.id === casTaskId) || {};
  checkAt('GET tasks status', casTasks.status, 200);
  checkAt('description binding lock stale after publish-assets', casTaskProjection.descriptionBindingLock, value => (
    value
    && value.ok === false
    && value.stale === true
    && value.baseTaskRevision === casRevision
    && value.currentRevision === Number(casRaw?.repositoryRevision || 0)
    && Object.keys(value).sort().join(',') === 'baseTaskRevision,currentRevision,ok,stale'
  ));

  // Old-revision description binding after publish-assets: 409, and the
  // winner publish-assets binding is not overwritten.
  const staleDescBind = await req('/api/link-ops-prepare-descriptions', {
    method: 'POST',
    cookie,
    body: {
      taskId: casTaskId,
      store: 'HL',
      sourceApproved: true,
      materialJson: descriptionMaterial,
      sourceFile: {name: 'cas-reviewed-old.html', dataBase64: descriptionSourceBytes.toString('base64')},
      expectedRevision: raceRevision,
    },
  });
  const casRawAfterStale = await rawTaskById(casTaskId);
  checkAt('old-revision description binding rejected with 409', staleDescBind.status, 409);
  checkAt('old-revision rejection stable code', staleDescBind.json?.code || '', 'LINK_OPS_REVISION_CONFLICT');
  checkAt('old-revision attempt keeps publish-assets fingerprint', casRawAfterStale?.publishAssetBinding?.bindingFingerprint || '', casRaw?.publishAssetBinding?.bindingFingerprint || '');
  checkAt('old-revision attempt does not bump revision', Number(casRawAfterStale?.repositoryRevision || 0), Number(casRaw?.repositoryRevision || 0));

  // Pure success CAS on a fresh task: publish-assets is the first mutation.
  const casOkCreate = await req('/api/link-ops-tasks', {
    method: 'POST',
    cookie,
    body: {
      source: 'publish_assets_cas_ok_smoke',
      command: `CAS 成功路径冒烟：${productCase.command}`,
      targets: {
        stores: ['HL'],
        sourceStores: ['DL'],
        sourceSkc: SOURCE_SKC,
        productRefs: productCase.productRefs,
        standardGoodsSn: taskStandardGoodsSn,
      },
    },
  });
  const casOkId = extractTaskId(casOkCreate.json);
  checkAt('success task create status', casOkCreate.status, 200);
  checkAt('success task id present', Boolean(casOkId), true);
  const casOkUpload = await req('/api/link-ops-assets', {
    method: 'POST',
    cookie,
    body: {
      taskId: casOkId,
      files: [{
        name: 'publish-payload.json',
        type: 'application/json',
        sourceApproved: true,
        approvalKind: 'human_reviewed_publish_payload',
        dataBase64: b64Json({publishPayload}),
      }],
    },
  });
  checkAt('success task payload upload status', casOkUpload.status, 200);
  const casOk = await req('/api/link-ops-publish-assets', {method: 'POST', cookie, body: {...casPublishBody, taskId: casOkId}});
  const casOkRaw = await rawTaskById(casOkId);
  checkAt('success CAS status', casOk.status, 200);
  checkAt('success CAS readback verified', casOk.json?.readbackVerified, true);
  checkAt('success CAS persisted revision equals readback', casOk.json?.persistedRevision || 0, Number(casOkRaw?.repositoryRevision || 0));
  checkAt('success CAS fingerprint persisted', casOkRaw?.publishAssetBinding?.bindingFingerprint || '', casOk.json?.binding?.bindingFingerprint || '');
  checkAt('success CAS keeps unique write store', casOkRaw?.targets?.writeStores || [], xs => asArray(xs).length === 1 && String(xs[0]).toUpperCase() === 'HL');
  checkAt('success CAS locks standardGoodsSn', casOkRaw?.targets?.standardGoodsSn || '', taskStandardGoodsSn);
  checkAt('success CAS locks supplyPrice', casOkRaw?.targets?.supplyPrice, 210);
  checkAt('success CAS locks inventory', casOkRaw?.targets?.inventory, 100);
  checkAt('success CAS payload supplier_code', casOkRaw?.openapiPublishPayload?.skc_list?.[0]?.supplier_code || '', taskStandardGoodsSn);
  checkAt('success CAS payload cost_price', casOkRaw?.openapiPublishPayload?.skc_list?.[0]?.sku_list?.[0]?.cost_info?.cost_price || '', '210.00');
  const casOkExpectedBindingResponse = expectedPersistedPublishAssetBindingResponse(casOkRaw);
  const casOkPersistedNames = asArray(casOkRaw?.publishAssetBinding?.images).map(row => String(row?.name || ''));
  checkAt('success response imageCount comes from persisted binding', casOk.json?.binding?.imageCount, casOkRaw?.publishAssetBinding?.imageCount);
  checkAt('success response boundImageCount comes from persisted binding', casOk.json?.binding?.boundImageCount, casOkRaw?.publishAssetBinding?.imageCount);
  checkAt('success response boundNames come from persisted binding', casOk.json?.binding?.boundNames || [], names => JSON.stringify(names) === JSON.stringify(casOkPersistedNames));
  const successAuditEntries = (await fs.readFile(auditFile, 'utf8'))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
  const casOkSuccessAudit = successAuditEntries.filter(entry => entry?.type === 'link-ops-publish-assets-bound' && entry?.task?.id === casOkId).at(-1) || {};
  checkAt('success audit imageCount comes from persisted binding', casOkSuccessAudit?.binding?.imageCount, casOkRaw?.publishAssetBinding?.imageCount);
  checkAt('success audit boundNames come from persisted binding', casOkSuccessAudit?.binding?.boundNames || [], names => JSON.stringify(names) === JSON.stringify(casOkPersistedNames));
  checkAt('success response every binding business field equals fresh persisted record', stableJson(casOk.json?.binding || {}), stableJson(casOkExpectedBindingResponse));
  checkAt('success audit every binding business field equals fresh persisted record', stableJson(casOkSuccessAudit?.binding || {}), stableJson(casOkExpectedBindingResponse));
  const casOkTasks = await req('/api/link-ops-tasks?limit=50', {cookie});
  const casOkProjection = (casOkTasks.json?.data?.tasks || []).find(row => row?.id === casOkId) || {};
  checkAt('success CAS task has no description binding lock', casOkProjection.descriptionBindingLock, null);

  // The deterministic CAS marker is test-only. A real production-mode portal
  // receives the same marker environment variable but must neither create the
  // .ready file nor pause. No production safety bypass is enabled here.
  const productionMarker = path.join(tmpRoot, 'publish-assets-production-marker');
  await fs.rm(`${productionMarker}.ready`, {force: true});
  await fs.rm(`${productionMarker}.go`, {force: true});
  const productionPortal = await startAuxiliaryPortal({
    NODE_ENV: 'production',
    SHEIN_BI_TEST_ALLOW_FAKE_WEBHOOK_GATE: '',
    SHEIN_LINK_OPS_TEST_PUBLISH_ASSETS_CAS_READY_MARKER: productionMarker,
  });
  const productionStartedAt = Date.now();
  const productionPublish = await reqAt(productionPortal.baseUrl, '/api/link-ops-publish-assets', {
    method: 'POST',
    cookie: productionPortal.cookie,
    body: {...casPublishBody, taskId: casOkId},
    signal: AbortSignal.timeout(7000),
  });
  checkAt('production portal with marker does not pause', productionPublish.status, 200);
  checkAt('production portal with marker completes promptly', Date.now() - productionStartedAt < 7000, true);
  checkAt('production portal with marker does not create ready file', fssync.existsSync(`${productionMarker}.ready`), false);

  // One test portal injects six deterministic fresh-read mutations after each
  // real CAS commit. Every request still reaches the production endpoint and
  // must return the stable READBACK_DRIFT code. The repository record itself
  // remains the actual committed task; only the verifier input is mutated.
  const driftModes = [
    'missing_image',
    'image_count',
    'image_name',
    'image_url',
    'image_sha256',
    'evidence_missing',
    'evidence_change',
    'publish_preparation_missing',
    'publish_preparation_change',
    'payload_hash',
  ];
  const driftPortal = await startAuxiliaryPortal({
    NODE_ENV: 'test',
    SHEIN_LINK_OPS_TEST_PUBLISH_ASSETS_READBACK_DRIFT_SEQUENCE: driftModes.join(','),
  });
  for (const mode of driftModes) {
    const driftResponse = await reqAt(driftPortal.baseUrl, '/api/link-ops-publish-assets', {
      method: 'POST',
      cookie: driftPortal.cookie,
      body: {...casPublishBody, taskId: casOkId},
    });
    checkAt(`${mode} readback drift status`, driftResponse.status, 409);
    checkAt(`${mode} readback drift stable code`, driftResponse.json?.code || '', 'LINK_OPS_PUBLISH_ASSETS_READBACK_DRIFT');
    checkAt(`${mode} readback drift reports durable bind`, driftResponse.json?.bound, true);
    checkAt(`${mode} readback drift carries evidence`, driftResponse.json?.drift || [], rows => asArray(rows).length > 0);
  }
  const casOkAfterDrift = await rawTaskById(casOkId);
  checkAt('readback drift injection does not alter persisted image array', canonicalImageFields(casOkAfterDrift?.publishAssetBinding?.images), rows => JSON.stringify(rows) === JSON.stringify(canonicalImageFields(casOkRaw?.publishAssetBinding?.images)));

  // The same production verifier also locks update_images imageEditPayload.
  const {__testHooks: publishAssetsHooks} = await import('./serve_bi_portal.mjs');
  const updateImagesTask = {
    id: 'lot_publish_assets_update_images_helper',
    repositoryRevision: 2,
    intents: ['update_images'],
    targets: {stores: ['HL'], writeStores: ['HL']},
    imageEditPayload: {
      spu_name: 'b2608062023343035',
      skc_list: [{skc_name: 'sb260806202334303501938', image_info: {image_info_list: [{image_type: 1, image_sort: 1, image_url: 'https://img.shein.com/approved/main.png'}]}}],
    },
    publishAssetBinding: {
      kind: 'update_images',
      targetStore: 'HL',
      imageCount: 1,
      images: [{name: 'main.png', role: 'mainCover', imageType: 1, imageUrl: 'https://img.shein.com/approved/main.png', sha256: 'a'.repeat(64)}],
    },
  };
  updateImagesTask.publishAssetBinding.bindingFingerprint = publishAssetsHooks.canonicalPublishAssetBindingFingerprint(updateImagesTask);
  const updateImagesPrepared = {
    task: JSON.parse(JSON.stringify(updateImagesTask)),
    binding: {targetStore: 'HL', bindingFingerprint: updateImagesTask.publishAssetBinding.bindingFingerprint},
  };
  const updateImagesFresh = JSON.parse(JSON.stringify(updateImagesTask));
  updateImagesFresh.imageEditPayload.skc_list[0].image_info.image_info_list[0].image_url = 'https://img.shein.com/approved/drift.png';
  const updateImagesPayloadDrift = publishAssetsHooks.verifyPersistedPublishAssetBindingReadback(updateImagesFresh, updateImagesPrepared);
  checkAt('update_images payload hash drift fails verifier', updateImagesPayloadDrift.ok, false);
  checkAt('update_images payload hash drift evidence', updateImagesPayloadDrift.drift || [], rows => asArray(rows).some(row => String(row).includes('imageEditPayload canonical hash')));

  return {casTaskId, casOkId};
}

try {
  if (PREVALID_RETRY && !CHAT_NATURAL) {
    throw new Error('--prevalid-retry is only meaningful with --chat-natural');
  }
  await waitReady();
  const cookie = await login('owner_copy_success', 'owner-pass');
  const operatorCookie = await login('operator_copy_success', 'operator-pass');
  await runPublishAssetsCasScenario({cookie});

  const caps = await req('/api/openapi-capabilities', {cookie});
  const hlRow = asArray(caps.json?.rows).find(row => row.storeKey === 'HL');
  const hlCopy = asArray(hlRow?.actionCapabilities).find(action => action.key === 'copy_product_draft');
  check('capabilities status', caps.status, 200);
  check('HL copy is confirmable in isolated pilot config', Boolean(hlCopy?.realSubmitSupported), true);

  let taskId = '';
  let chatSessionId = '';
  let created = null;
  if (CHAT_NATURAL) {
    const naturalCommand = GENERIC_PRODUCT
      ? '帮我给 HL 的 SK-9000空气炸锅补一条链接，直接复制所有店铺里流量最高的那条链接'
      : '帮我给 HL 的 505 缝纫机补一条链接，直接复制所有店铺里流量最高的那条链接';
    created = await req('/api/link-ops-chats', {
      method: 'POST',
      cookie,
      body: {message: naturalCommand, askAgent: false},
    });
    taskId = created.json?.autoTask?.id || '';
    chatSessionId = created.json?.session?.id || '';
    check('chat create status', created.status, 200);
    check('chat task id present', Boolean(taskId), true);
    check('chat session id present', Boolean(chatSessionId), true);
    check('chat created copy intent', created.json?.autoTask?.intents || [], xs => asArray(xs).includes('copy_product_draft'));
    check('chat created target HL only', created.json?.autoTask?.targets?.writeStores || created.json?.autoTask?.targets?.stores || [], xs => asArray(xs).length === 1 && String(xs[0]).toUpperCase() === 'HL');
    // The production copy contract requires an exact unique task source lock
    // (sourceStore + sourceSkc) even when the payload comes from a bound asset.
    await updateRawTaskById(taskId, task => ({
      ...task,
      targets: {...task.targets, sourceStores: ['DL'], sourceSkc: SOURCE_SKC},
    }));
  } else {
    created = await req('/api/link-ops-tasks', {
      method: 'POST',
      cookie,
      body: {
        source: 'copy_success_smoke',
        command: productCase.command,
        targets: {
          stores: ['HL'],
          sourceStores: ['DL'],
          sourceSkc: SOURCE_SKC,
          productRefs: productCase.productRefs,
          standardGoodsSn: taskStandardGoodsSn,
        },
      },
    });
    taskId = extractTaskId(created.json);
    check('create task status', created.status, 200);
    check('task id present', Boolean(taskId), true);
  }

  const uploaded = await req('/api/link-ops-assets', {
    method: 'POST',
    cookie,
    body: {
      taskId,
      files: [{
        name: 'publish-payload.json',
        type: 'application/json',
        sourceApproved: true,
        approvalKind: 'human_reviewed_publish_payload',
        dataBase64: b64Json({publishPayload}),
      }, ...(ASSET_BINDING ? [{
        name: 'approved-local-main.png',
        type: 'image/png',
        dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/ax2Z7kAAAAASUVORK5CYII=',
      }] : [])],
    },
  });
  check('upload payload status', uploaded.status, 200);
  check(ASSET_BINDING ? 'uploaded payload and raw image assets before same-task binding' : 'uploaded one payload asset', asArray(uploaded.json?.assets).length, ASSET_BINDING ? 2 : 1);

  if (ASSET_BINDING) {
    // Simulate an older task/template preference. The subsequently approved
    // package must override this AI/randomization preference and retain the
    // exact human-reviewed order through preflight and real execution.
    await updateRawTaskById(taskId, task => ({...task, shuffleImages: true}));
    const binding = await req('/api/link-ops-publish-assets', {
      method: 'POST',
      cookie,
      body: {
        taskId,
        store: 'HL',
        sourceApproved: true,
        publishPreparation: {
          standardGoodsSn: taskStandardGoodsSn,
          supplyPrice: 210,
          inventory: 100,
          titleAr: productCase.arName,
          titleEn: productCase.englishName,
        },
        bindings: [
          {name: '02-approved-main.png', role: 'mainCover', imageType: 1, imageUrl: 'https://img.shein.com/approved/main.png', width: 900, height: 1200, order: 1, sha256: 'a'.repeat(64)},
          {name: '05-approved-carousel.png', role: 'carouselSecondCover', imageType: 1, imageUrl: 'https://img.shein.com/approved/carousel.png', width: 900, height: 1200, order: 2, sha256: 'b'.repeat(64)},
          {name: '11-approved-15-speed.png', role: 'detail', imageType: 2, imageUrl: 'https://img.shein.com/approved/15-speed.png', width: 900, height: 1200, order: 3, sha256: 'c'.repeat(64)},
          {name: '12-approved-45db.png', role: 'detail', imageType: 2, imageUrl: 'https://img.shein.com/approved/45db.png', width: 900, height: 1200, order: 4, sha256: 'd'.repeat(64)},
          {name: '03-approved-square.png', role: 'squareImage', imageType: 5, imageUrl: 'https://img.shein.com/approved/square.png', width: 1254, height: 1254, order: 5, sha256: 'e'.repeat(64)},
        ],
      },
    });
    const boundRawTask = await rawTaskById(taskId);
    check('approved publish asset binding status', binding.status, 200);
    check('approved publish asset binding stays on task', binding.json?.task?.id, taskId);
    check('approved publish asset binding payload source', binding.json?.binding?.payloadSource, 'task');
    check('approved publish asset binding keeps all images', binding.json?.binding?.boundImageCount, 5);
    check('approved publish asset binding measures square', binding.json?.binding?.squareDimensions, '1254x1254');
    check('bound payload no longer uses source image', JSON.stringify(boundRawTask?.openapiPublishPayload || {}), text => !text.includes('example.invalid'));
    check('bound payload retains 15 speed image', JSON.stringify(boundRawTask?.openapiPublishPayload || {}), text => text.includes('15-speed.png'));
    check('bound payload retains 45dB image', JSON.stringify(boundRawTask?.openapiPublishPayload || {}), text => text.includes('45db.png'));
    check('bound payload locks supply price', boundRawTask?.openapiPublishPayload?.skc_list?.[0]?.sku_list?.[0]?.cost_info?.cost_price, '210.00');
    check('bound payload locks exact supplier code', boundRawTask?.openapiPublishPayload?.skc_list?.[0]?.supplier_code, taskStandardGoodsSn);

    const correctionSourceCreated = await req('/api/link-ops-tasks', {
      method: 'POST',
      cookie,
      body: {source: 'pending_correction_source_smoke', command: 'source publish task', targets: {stores: ['HL'], productRefs: [taskStandardGoodsSn]}},
    });
    const correctionSourceTaskId = extractTaskId(correctionSourceCreated.json);
    await updateRawTaskById(correctionSourceTaskId, task => ({
      ...task,
      status: 'done',
      intents: ['copy_product_draft'],
      targets: {...task.targets, stores: ['HL'], writeStores: ['HL']},
      openapiPublishPayload: boundRawTask.openapiPublishPayload,
      execution: {
        actualWriteSubmitted: true,
        writeAudit: {actualWriteSubmitted: true},
        openApiProductExecutors: [{
          publishResult: {code: '0', msg: 'OK', info: {success: true, version: 'SPMP260806300745650', spu_name: 'b2608062023343035', skc_list: [{skc_name: 'sb260806202334303501938', sku_list: [{sku_code: 'SKU-LIVE-SB-001'}]}]}},
        }],
      },
    }));
    const maintenanceCreated = await req('/api/link-ops-tasks', {
      method: 'POST',
      cookie,
      body: {
        source: 'maintenance_asset_binding_smoke',
        command: '将 HL 的既有链接替换为已审套图',
        targets: {stores: ['HL'], productRefs: ['B2608062023343035', 'SB260806202334303501938']},
      },
    });
    const maintenanceTaskId = extractTaskId(maintenanceCreated.json);
    await updateRawTaskById(maintenanceTaskId, task => ({
      ...task,
      status: 'waiting_review',
      intents: ['update_images'],
      targets: {...task.targets, stores: ['HL'], writeStores: ['HL'], productRefs: ['B2608062023343035', 'SB260806202334303501938']},
    }));
    const maintenanceBinding = await req('/api/link-ops-publish-assets', {
      method: 'POST',
      cookie,
      body: {
        taskId: maintenanceTaskId,
        store: 'HL',
        sourceApproved: true,
        sourceTaskId: correctionSourceTaskId,
        bindings: [
          {name: '02-approved-main.png', role: 'mainCover', imageType: 1, imageUrl: 'https://img.shein.com/approved/main.png', width: 900, height: 1200, order: 1, sha256: '1'.repeat(64)},
          {name: '05-approved-carousel.png', role: 'carouselSecondCover', imageType: 1, imageUrl: 'https://img.shein.com/approved/carousel.png', width: 900, height: 1200, order: 2, sha256: '2'.repeat(64)},
          {name: '11-approved-detail.png', role: 'detail', imageType: 2, imageUrl: 'https://img.shein.com/approved/detail.png', width: 900, height: 1200, order: 3, sha256: '3'.repeat(64)},
          {name: '03-approved-square.png', role: 'squareImage', imageType: 5, imageUrl: 'https://img.shein.com/approved/square.png', width: 1254, height: 1254, order: 4, sha256: '4'.repeat(64)},
        ],
      },
    });
    let maintenanceRawTask = await rawTaskById(maintenanceTaskId);
    check('approved update_images binding status', maintenanceBinding.status, 200);
    check('approved update_images binding uses task image payload', maintenanceBinding.json?.binding?.payloadSource, 'task.imageEditPayload');
    check('approved update_images binding prepares pending correction', maintenanceBinding.json?.binding?.pendingNewListingImageCorrection, true);
    check('approved update_images binding locks source publish task', maintenanceRawTask?.pendingNewListingImageCorrection?.sourceTaskId, correctionSourceTaskId);
    check('pending correction keeps full source title', maintenanceRawTask?.pendingNewListingImageCorrection?.republishPayload?.multi_language_name_list?.[0]?.name, boundRawTask?.openapiPublishPayload?.multi_language_name_list?.[0]?.name);
    check('approved update_images binding locks exact SB target', maintenanceRawTask?.imageEditPayload?.skc_list?.[0]?.skc_name, 'sb260806202334303501938');
    check('approved update_images binding does not create publish payload', 'openapiPublishPayload' in (maintenanceRawTask || {}), false);
    check('approved update_images binding touches no title or stock', JSON.stringify(maintenanceRawTask?.imageEditPayload || {}), text => !/multi_language_name_list|stock_info|cost_info|shopPrice|specialPrice/.test(text));
    const maintenanceExpectedBindingResponse = expectedPersistedPublishAssetBindingResponse(maintenanceRawTask);
    check('approved update_images response every binding business field equals fresh persisted record', stableJson(maintenanceBinding.json?.binding || {}), stableJson(maintenanceExpectedBindingResponse));
    const maintenanceAuditEntries = (await fs.readFile(auditFile, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => JSON.parse(line));
    const maintenanceSuccessAudit = maintenanceAuditEntries.filter(entry => entry?.type === 'link-ops-publish-assets-bound' && entry?.task?.id === maintenanceTaskId).at(-1) || {};
    check('approved update_images audit every binding business field equals fresh persisted record', stableJson(maintenanceSuccessAudit?.binding || {}), stableJson(maintenanceExpectedBindingResponse));
    const reusedCorrection = await req('/api/link-ops-publish-assets', {
      method: 'POST',
      cookie,
      body: {taskId: maintenanceTaskId, store: 'HL', sourceApproved: true, sourceTaskId: correctionSourceTaskId, reuseApprovedBinding: true},
    });
    maintenanceRawTask = await rawTaskById(maintenanceTaskId);
    check('existing approved binding can prepare correction without reupload', reusedCorrection.status, 200);
    check('reused correction keeps same approved image count', maintenanceRawTask?.publishAssetBinding?.imageCount, 4);
    check('reused correction keeps source task', maintenanceRawTask?.pendingNewListingImageCorrection?.sourceTaskId, correctionSourceTaskId);
    check('reused correction response every binding business field equals fresh persisted record', stableJson(reusedCorrection.json?.binding || {}), stableJson(expectedPersistedPublishAssetBindingResponse(maintenanceRawTask)));
    const maintenanceDryRun = await req('/api/link-ops-execute', {
      method: 'POST',
      cookie,
      body: {id: maintenanceTaskId, mode: 'dry-run', source: 'maintenance_asset_binding_smoke'},
    });
    const maintenanceDryRaw = await rawTaskById(maintenanceTaskId);
    const maintenanceExecutors = asArray(maintenanceDryRaw?.execution?.linkMaintenanceExecutors);
    check('approved update_images dry-run status', maintenanceDryRun.status, 200);
    check('approved update_images no longer reports missing image material', maintenanceDryRaw?.execution?.preflight?.blockers || [], rows => !asArray(rows).some(row => /缺少图片素材/.test(String(row))));
    check('approved update_images dry-run resolves one exact target', maintenanceExecutors?.[0]?.adapterEvidence?.matchedLinksCount, 1);
    check('approved update_images dry-run locks payload hash', Boolean(maintenanceExecutors?.[0]?.payload?.payloadHash), true);
    check('approved update_images without SKU image remains warning only', maintenanceExecutors?.[0]?.adapterEvidence?.imagePayloadInspection?.warnings || [], rows => asArray(rows).some(row => /未提供 SKU 图/.test(String(row))));
  }

  if (!ASSET_BINDING && productCase.requireInputCurrent) {
    const minimalApprovedBinding = await req('/api/link-ops-publish-assets', {
      method: 'POST',
      cookie,
      body: {
        taskId,
        store: 'HL',
        sourceApproved: true,
        publishPreparation: {
          standardGoodsSn: taskStandardGoodsSn,
          supplyPrice: 210,
          inventory: 100,
          titleAr: productCase.arName,
          titleEn: productCase.englishName,
        },
        bindings: [
          {name: '02-approved-main.png', role: 'mainCover', imageType: 1, imageUrl: 'https://img.shein.com/approved/main.png', width: 900, height: 1200, order: 1, sha256: 'a'.repeat(64)},
          {name: '05-approved-carousel.png', role: 'carouselSecondCover', imageType: 1, imageUrl: 'https://img.shein.com/approved/carousel.png', width: 900, height: 1200, order: 2, sha256: 'b'.repeat(64)},
          {name: '11-approved-15-speed.png', role: 'detail', imageType: 2, imageUrl: 'https://img.shein.com/approved/15-speed.png', width: 900, height: 1200, order: 3, sha256: 'c'.repeat(64)},
          {name: '12-approved-45db.png', role: 'detail', imageType: 2, imageUrl: 'https://img.shein.com/approved/45db.png', width: 900, height: 1200, order: 4, sha256: 'd'.repeat(64)},
          {name: '03-approved-square.png', role: 'squareImage', imageType: 5, imageUrl: 'https://img.shein.com/approved/square.png', width: 1254, height: 1254, order: 5, sha256: 'e'.repeat(64)},
        ],
      },
    });
    check('controlled attribute variants bind reviewed images before adoption', minimalApprovedBinding.status, 200);
  }

  // Descriptions are the final reviewed-material mutation: bind after any
  // approved image/publish preparation so the strict bound payload hash also
  // locks the current image structure.
  const fractionalRevisionBaseTask = await rawTaskById(taskId);
  const fractionalRevisionBind = await req('/api/link-ops-prepare-descriptions', {
    method: 'POST',
    cookie,
    body: {
      taskId,
      store: 'HL',
      sourceApproved: true,
      materialJson: {schemaVersion: 'deliberately-invalid'},
      sourceFile: {
        name: '',
        dataBase64: '%%%deliberately-invalid-base64%%%',
      },
      expectedRevision: Number(fractionalRevisionBaseTask?.repositoryRevision || 0) + 0.5,
    },
  });
  const fractionalRevisionAfterTask = await rawTaskById(taskId);
  check('fractional expectedRevision rejected', fractionalRevisionBind.status, 400);
  check('fractional expectedRevision stable code', fractionalRevisionBind.json?.code || '', 'LINK_OPS_REVISION_INVALID');
  check('fractional expectedRevision does not bump revision', Number(fractionalRevisionAfterTask?.repositoryRevision || 0), Number(fractionalRevisionBaseTask?.repositoryRevision || 0));
  check('fractional expectedRevision does not bind description', fractionalRevisionAfterTask?.descriptionMaterialBinding || null, fractionalRevisionBaseTask?.descriptionMaterialBinding || null);
  check('fractional expectedRevision does not alter publish binding', JSON.stringify(fractionalRevisionAfterTask?.publishAssetBinding || null), JSON.stringify(fractionalRevisionBaseTask?.publishAssetBinding || null));
  check('fractional expectedRevision with invalid source does not alter materialized publish payload', stableJson(fractionalRevisionAfterTask?.openapiPublishPayload || null), stableJson(fractionalRevisionBaseTask?.openapiPublishPayload || null));
  check('fractional expectedRevision with invalid source does not create material artifact metadata', stableJson(fractionalRevisionAfterTask?.descriptionPayloadMaterialization || null), stableJson(fractionalRevisionBaseTask?.descriptionPayloadMaterialization || null));
  check('fractional expectedRevision with invalid source does not append task history', asArray(fractionalRevisionAfterTask?.history).length, asArray(fractionalRevisionBaseTask?.history).length);
  const descriptionBindBaseTask = fractionalRevisionAfterTask;
  const descriptionBind = await req('/api/link-ops-prepare-descriptions', {
    method: 'POST',
    cookie,
    body: {
      taskId,
      store: 'HL',
      sourceApproved: true,
      materialJson: descriptionMaterial,
      sourceFile: {
        name: 'copy-success-reviewed.html',
        dataBase64: descriptionSourceBytes.toString('base64'),
      },
      expectedRevision: descriptionBindBaseTask?.repositoryRevision,
    },
  });
  check('reviewed descriptions bind to same task', descriptionBind.status, 200);
  check('reviewed description binding committed and read back', descriptionBind.json?.bindingCommitted === true && descriptionBind.json?.readbackVerified === true, true);
  check('reviewed description binding keeps task id', descriptionBind.json?.task?.id, taskId);
  check('reviewed description binding carries exact English hash', descriptionBind.json?.binding?.hashes?.en, descriptionMaterial.rows.en.sha256);

  if (productCase.requireInputCurrent) {
    const attributeBindBase = await rawTaskById(taskId);
    const attributeBind = await req('/api/link-ops-prepare-product-attribute', {
      method: 'POST',
      cookie,
      body: {
        taskId,
        store: 'HL',
        donorStore: 'DL',
        donorSkc: SOURCE_SKC,
        attributeId: 1002328,
        bindingMode: 'adopt_existing',
        expectedRevision: attributeBindBase?.repositoryRevision,
      },
    });
    check('controlled attribute flow adopts live same-product hazardous classification', attributeBind.status, 200);
    check('controlled attribute flow persists product attribute binding', Boolean((await rawTaskById(taskId))?.productAttributeBinding), true);
  }

  const dryRun = await req('/api/link-ops-execute', {
    method: 'POST',
    cookie,
    body: {id: taskId, mode: 'dry-run', source: 'copy_success_smoke'},
  });
  const dryRunTask = dryRun.json?.task || {};
  const dryRunRawTask = await rawTaskById(taskId);
  const dryRunEvidence = executorEvidenceFromAudit(dryRunRawTask?.execution?.writeAudit || dryRun?.json?.execution?.writeAudit || dryRunTask?.execution?.writeAudit, 'HL');
  const dryRunPayloadHash = dryRunEvidence?.payloadHash || dryRunRawTask?.execution?.openApiProductExecutors?.[0]?.payload?.payloadHash || dryRunTask?.execution?.openApiProductExecutors?.[0]?.payload?.payloadHash || '';
  check('dry-run status', dryRun.status, 200);
  check('dry-run task waiting_review', dryRunTask.status, 'waiting_review');
  check('dry-run locks payload hash', Boolean(dryRunPayloadHash), true);
  check('dry-run does not publish', Boolean((dryRun?.json?.execution?.writeAudit || dryRunRawTask?.execution?.writeAudit)?.sheinWriteAttempted), false);

  let rebindDryRunPayloadHash = '';
  let executed = CHAT_NATURAL
    ? await req('/api/link-ops-chats', {
      method: 'POST',
      cookie,
      body: {sessionId: chatSessionId, message: '干啊。', askAgent: false},
    })
    : await req('/api/link-ops-execute', {
      method: 'POST',
      cookie,
      body: {id: taskId, mode: 'execute', confirm: CONFIRM_TEXT, source: 'copy_success_smoke'},
    });
  if (PREVALID_RETRY) {
    const firstRetryRawTask = await rawTaskById(taskId);
    const firstRetryLifecycle = firstRetryRawTask?.lifecycle || firstRetryRawTask?.execution?.lifecycle || null;
    const firstRetryAnswer = asArray(executed.json?.session?.messages).at(-1)?.content || '';
    result.summary.firstRetryAnswer = firstRetryAnswer;
    result.summary.firstRetryStatus = firstRetryRawTask?.status || '';
    result.summary.firstRetryLifecycleStatus = firstRetryLifecycle?.status || firstRetryLifecycle?.lifecycleStatus || '';
    check('prevalid-retry first confirm status', executed.status, 200);
    check('prevalid-retry first confirm reaches pre-valid failure', firstRetryLifecycle?.status || firstRetryLifecycle?.lifecycleStatus || '', 'publish_pre_valid_failed');
    check('prevalid-retry first confirm does not close task', firstRetryRawTask?.status || '', 'waiting_review');
    check('prevalid-retry answer does not make operator guess platform fields', firstRetryAnswer, text => !/你也可以.*补|直接在聊天里补/i.test(String(text || '')));
    check('prevalid-retry answer explains automatic recheck before retry', firstRetryAnswer, text => /自动重新整理并检查|资料检查通过前不会再次提交/.test(String(text || '')));
    check('prevalid-retry answer redacts description echoes and keeps ordinary diagnostics', firstRetryAnswer, text => (
      /平台回显内容已脱敏/.test(String(text || ''))
      && !String(text || '').includes(descriptionLines.en[0].slice(0, 80))
      && !String(text || '').includes(descriptionLines.en[1].replace(/\s+/g, ' '))
      && !String(text || '').includes(descriptionLines.en[2])
      && /商品标题不能为空/.test(String(text || ''))
      && /产品型号，为必填项/.test(String(text || ''))
    ));
    if (PREVALID_RETRY_REBIND) {
      // Production recovery: after the explicit platform pre-validation
      // rejection (info.success=false, actualWriteSubmitted=false, no
      // identifiers), prepare-descriptions must be allowed to CAS-rebind the
      // SAME task once the material is updated. Before the fix this returned
      // 409 DESCRIPTION_BINDING_PRIOR_WRITE_EVIDENCE.
      const rebindBaseTask = await rawTaskById(taskId);
      await fs.writeFile(path.join(tmpRoot, 'rebind-time-task.json'), JSON.stringify(rebindBaseTask, null, 2), 'utf8');
      const rebind = await req('/api/link-ops-prepare-descriptions', {
        method: 'POST',
        cookie,
        body: {
          taskId,
          store: 'HL',
          sourceApproved: true,
          materialJson: reboundMaterial,
          sourceFile: {name: 'copy-success-rebound.html', dataBase64: reboundSourceBytes.toString('base64')},
          expectedRevision: Number(rebindBaseTask?.repositoryRevision || 0),
        },
      });
      result.summary.rebindStatus = rebind.status;
      result.summary.rebindError = rebind.json?.error || '';
      result.summary.rebindCode = rebind.json?.code || '';
      check('prevalid-rejected task permits same-task description rebind', rebind.status, 200);
      check('prevalid-rejected task rebind commits binding', rebind.json?.bindingCommitted, true);
      check('prevalid-rejected task rebind binds the new source label', rebind.json?.binding?.sourceLabel || '', 'copy-success-rebound.html');
      const rebindAfterRaw = await rawTaskById(taskId);
      check('prevalid-rejected task rebind resets lifecycle to needs_repreflight', rebindAfterRaw?.lifecycle?.lifecycleStatus || '', 'needs_repreflight');
      check('prevalid-rejected task rebind records the safe-recovery exception', String(rebindAfterRaw?.note || ''), text => /安全恢复例外/.test(String(text || '')) && /actualWriteSubmitted=false/.test(String(text || '')));
      check('prevalid-rejected task rebind clears executor write flags', rebindAfterRaw?.execution?.actualWriteSubmitted === false && rebindAfterRaw?.execution?.sheinWriteAttempted === false && rebindAfterRaw?.execution?.issuedExecuteToExecutor === false, true);
      // A fresh dry-run must lock the rebound payload hash before the retry.
      const rebindDryRun = await req('/api/link-ops-execute', {
        method: 'POST',
        cookie,
        body: {id: taskId, mode: 'dry-run', source: 'copy_success_smoke_rebind'},
      });
      const rebindDryRunRawTask = await rawTaskById(taskId);
      const rebindDryRunEvidence = executorEvidenceFromAudit(rebindDryRunRawTask?.execution?.writeAudit || rebindDryRun.json?.execution?.writeAudit || rebindDryRun.json?.task?.execution?.writeAudit, 'HL');
      rebindDryRunPayloadHash = rebindDryRunEvidence?.payloadHash || rebindDryRunRawTask?.execution?.openApiProductExecutors?.[0]?.payload?.payloadHash || rebindDryRun.json?.task?.execution?.openApiProductExecutors?.[0]?.payload?.payloadHash || '';
      check('prevalid-rejected task fresh dry-run locks the rebound payload hash', Boolean(rebindDryRunPayloadHash), true);
      check('prevalid-rejected task rebound payload hash differs from original', rebindDryRunPayloadHash !== dryRunPayloadHash, true);
    }
    executed = await req('/api/link-ops-chats', {
      method: 'POST',
      cookie,
      body: {sessionId: chatSessionId, message: '干吧', askAgent: false},
    });
  }
  const executedRawTask = await rawTaskById(taskId);
  const writeAudit = executedRawTask?.execution?.writeAudit || writeAuditFromExecute(executed.json);
  const lifecycle = executedRawTask?.lifecycle || executedRawTask?.execution?.lifecycle || taskLifecycle(executed.json);
  const execEvidence = executorEvidenceFromAudit(writeAudit, 'HL');
  const executedTask = executedRawTask || executed.json?.task || {};
  const executedProductRun = asArray(executedTask?.execution?.openApiProductExecutors)
    .find(row => String(row?.storeKey || '').trim().toUpperCase() === 'HL') || null;
  const chatAnswer = CHAT_NATURAL ? asArray(executed.json?.session?.messages).at(-1)?.content || '' : '';
  result.summary.executedStatus = executed.status;
  result.summary.chatAnswer = chatAnswer;
  result.summary.taskStatus = executedTask?.status || '';
  result.summary.lifecycleStatus = lifecycle?.status || lifecycle?.lifecycleStatus || '';
  result.summary.writeAudit = {
    requestedRealSubmit: Boolean(writeAudit?.requestedRealSubmit),
    executeAllowed: Boolean(writeAudit?.executeAllowed),
    issuedExecuteToExecutor: Boolean(writeAudit?.issuedExecuteToExecutor),
    sheinWriteAttempted: Boolean(writeAudit?.sheinWriteAttempted),
    actualWriteSubmitted: Boolean(writeAudit?.actualWriteSubmitted),
    lifecycleLocked: Boolean(writeAudit?.lifecycleLocked),
    requiresManualResolve: Boolean(writeAudit?.requiresManualResolve),
    blockerCount: Number(writeAudit?.blockerCount || 0),
  };
  result.summary.execEvidence = execEvidence;
  const evidenceSourceDetailLock = execEvidence?.payload?.sourceDetailLock || null;
  check('writeAudit executorEvidence preserves sourceDetailLock', Boolean(evidenceSourceDetailLock), true);
  check('writeAudit sourceDetailLock has exactly five fields', Object.keys(evidenceSourceDetailLock || {}).sort().join(','), ['detailContentSha256', 'detailFetchedAt', 'matchedSkcName', 'matchedSpuName', 'source'].sort().join(','));
  check('writeAudit sourceDetailLock source', evidenceSourceDetailLock?.source || '', 'openapi_product_detail_snapshot');
  check('writeAudit sourceDetailLock matched SPU', evidenceSourceDetailLock?.matchedSpuName || '', SOURCE_SPU);
  check('writeAudit sourceDetailLock matched SKC', evidenceSourceDetailLock?.matchedSkcName || '', SOURCE_SKC);
  check('writeAudit sourceDetailLock detailFetchedAt', evidenceSourceDetailLock?.detailFetchedAt || '', SOURCE_DETAIL_AT);
  check('writeAudit sourceDetailLock content hash', evidenceSourceDetailLock?.detailContentSha256 || '', value => /^[a-f0-9]{64}$/.test(String(value)));
  check('execute status', executed.status, 200);
  if (CHAT_NATURAL) {
    check('chat natural execute answers in conversation', chatAnswer, text => /收到，我按你这句|SHEIN 已返回|没有创建成功|需要补充|已完成/.test(String(text)));
    check('chat natural execute no internal confirm token', chatAnswer, text => !/SHEIN_OPENAPI_SUBMIT|payload hash|dry-run|查看审计|飞书|回到\s*BI|任务池|验证器/i.test(String(text)));
  }
  check('execute allowed', Boolean(writeAudit?.executeAllowed), true);
  check('execute issued to child executor', Boolean(writeAudit?.issuedExecuteToExecutor), true);
  check('execute attempted SHEIN write against fake server', Boolean(writeAudit?.sheinWriteAttempted), true);
  if (PREVALID_FAIL) {
    check('pre-valid actual write not submitted', Boolean(writeAudit?.actualWriteSubmitted), false);
    check('pre-valid task remains reviewable', executedTask?.status || '', 'waiting_review');
    check('pre-valid lifecycle status', lifecycle?.status || lifecycle?.lifecycleStatus || '', 'publish_pre_valid_failed');
    check('pre-valid lifecycle unlocked', Boolean(lifecycle?.locked), false);
    check('pre-valid no manual resolve needed', Boolean(lifecycle?.needsManualResolve), false);
    check('pre-valid final state', writeAudit?.finalState || '', 'publish_pre_valid_failed');
    check('pre-valid blocker recorded', Number(writeAudit?.blockerCount || 0), n => n >= 1);
    check('pre-valid executor evidence state', execEvidence?.state || '', 'publish_pre_valid_failed');
    check('pre-valid executor ok false', Boolean(execEvidence?.ok), false);
    check('pre-valid readback skipped', execEvidence?.readback?.status || '', 'planned_not_run');
    check('pre-valid stored evidence redacts echoed description text', JSON.stringify(executedRawTask?.execution || {}), text => (
      !text.includes(descriptionLines.en[0])
      && !text.includes(descriptionLines.en[0].slice(0, 200))
      && !text.includes(descriptionLines.en[1])
      && !text.includes(descriptionLines.en[1].replace(/\s+/g, ' '))
      && !text.includes(descriptionLines.en[2])
      && !text.includes(descriptionLines.ar[0])
      && text.includes('平台回显内容已脱敏')
    ));
  } else if (MISSING_SUCCESS) {
    check('missing-success actual write not submitted', Boolean(writeAudit?.actualWriteSubmitted), false);
    check('missing-success lifecycle is not publish_pre_valid_failed', lifecycle?.status || lifecycle?.lifecycleStatus || '', status => String(status || '') !== 'publish_pre_valid_failed');
    check('missing-success final state is blocked', writeAudit?.finalState || '', 'blocked');
    check('missing-success task remains reviewable', executedTask?.status || '', 'waiting_review');
    check('missing-success blocker recorded', Number(writeAudit?.blockerCount || 0), n => n >= 1);
    // code0/info{} is uncertainty, not rejection proof: the same-task
    // description rebind must stay blocked even though nothing was submitted.
    const missingSuccessBase = await rawTaskById(taskId);
    const missingSuccessBind = await req('/api/link-ops-prepare-descriptions', {
      method: 'POST',
      cookie,
      body: {
        taskId,
        store: 'HL',
        sourceApproved: true,
        materialJson: descriptionMaterial,
        sourceFile: {name: 'copy-success-reviewed.html', dataBase64: descriptionSourceBytes.toString('base64')},
        expectedRevision: Number(missingSuccessBase?.repositoryRevision || 0),
      },
    });
    result.summary.missingSuccessBindStatus = missingSuccessBind.status;
    result.summary.missingSuccessBindCode = missingSuccessBind.json?.code || '';
    check('missing-success task still blocks description rebind', missingSuccessBind.status, 409);
    check('missing-success rebind code is prior-write-evidence', missingSuccessBind.json?.code || '', 'DESCRIPTION_BINDING_PRIOR_WRITE_EVIDENCE');
  } else {
    check('execute actual write submitted flag', Boolean(writeAudit?.actualWriteSubmitted), true);
  }
  if (WEAK_READBACK_ONLY) {
    check('weak-only writeAudit lifecycle locked', Boolean(writeAudit?.lifecycleLocked), true);
    check('weak-only writeAudit requires manual resolve', Boolean(writeAudit?.requiresManualResolve), true);
    check('weak-only task needs manual resolve', executedTask?.status || '', 'needs_manual_resolve');
    check('weak-only lifecycle keeps pending-review semantics', lifecycle?.status || lifecycle?.lifecycleStatus || '', 'submitted_but_readback_pending');
    check('weak-only lifecycle transitions to manual resolve', lifecycle?.toStatus || '', 'needs_manual_resolve');
    check('weak-only lifecycle locked', Boolean(lifecycle?.locked), true);
    check('weak-only manual resolve required', Boolean(lifecycle?.needsManualResolve), true);
    check('weak-only executor readback not ok', Boolean(execEvidence?.readback?.ok), false);
    check('weak-only readback is pending review, not failed', execEvidence?.readback?.status || '', 'new_identity_pending_review_unverifiable');
    check('weak-only readback marks pending review', Boolean(execEvidence?.readback?.pendingReview), true);
    check('weak-only no strong matches', Number(execEvidence?.readback?.matchedCount || 0), 0);
    if (CHAT_NATURAL) {
      check('chat weak-readback answer says submitted but manual resolve', chatAnswer, text => /已返回创建成功|已返回提交成功/.test(String(text || '')) && /人工确认|人工核销|回读没有|自动回读/.test(String(text || '')) && /不会重复提交|避免重复/.test(String(text || '')));
      check('chat weak-readback answer includes returned ids', chatAnswer, text => /sv-smoke-copy-product/.test(String(text || '')) && /trace-copy-success-smoke/.test(String(text || '')));
      check('chat weak-readback answer does not promise background push', chatAnswer, text => !/确认后会直接/.test(String(text || '')));
      const publishCountBeforeLockedRetry = fakeOpenApiCalls.filter(call => call.path === '/open-api/goods/product/publishOrEdit').length;
      const lockedRetry = await req('/api/link-ops-chats', {
        method: 'POST',
        cookie,
        body: {sessionId: chatSessionId, message: '干吧', askAgent: false},
      });
      const lockedRetryRawTask = await rawTaskById(taskId);
      const lockedRetryAnswer = asArray(lockedRetry.json?.session?.messages).at(-1)?.content || '';
      result.summary.lockedRetryStatus = lockedRetry.status;
      result.summary.lockedRetryAnswer = lockedRetryAnswer;
      check('chat locked lifecycle retry status', lockedRetry.status, 200);
      check('chat locked lifecycle answer refuses duplicate submit', lockedRetryAnswer, text => /已经提交过|不会重新|人工确认|核销/.test(String(text || '')));
      check('chat locked lifecycle task remains manual resolve', lockedRetryRawTask?.status || '', 'needs_manual_resolve');
      check('chat locked lifecycle keeps pending-readback lifecycle', lockedRetryRawTask?.lifecycle?.lifecycleStatus || '', 'submitted_but_readback_pending');
      check('chat locked lifecycle no extra publish', fakeOpenApiCalls.filter(call => call.path === '/open-api/goods/product/publishOrEdit').length, publishCountBeforeLockedRetry);
    }
  } else if (!PREVALID_FAIL && !MISSING_SUCCESS) {
    check('executor projection keeps exact source store', execEvidence?.sourceStore || '', 'DL');
    check('executor projection keeps exact source skc', execEvidence?.sourceSkc || '', SOURCE_SKC);
    check('source resolve audited searchProduct and live spu-info', fakeOpenApiCalls.filter(call => call.path === '/open-api/goods/searchProduct').length >= 1 && fakeOpenApiCalls.filter(call => call.path === '/open-api/goods/spu-info').length >= 1, true);
    check('no blockers after matched readback', Number(writeAudit?.blockerCount || 0), 0);
    check('task auto done after strong readback', executedTask?.status || '', 'done');
    check('lifecycle matched strong readback', lifecycle?.status || lifecycle?.lifecycleStatus || '', 'submitted_readback_matched');
    check('lifecycle not locked', Boolean(lifecycle?.locked), false);
    check('no manual resolve needed', Boolean(lifecycle?.needsManualResolve), false);
    check('executor readback ok', Boolean(execEvidence?.readback?.ok), true);
    check('executor readback status strong matched', execEvidence?.readback?.status || '', status => ['matched_strong_fingerprint_in_product_query', 'matched_publish_spu_in_spu_info', 'matched_publish_identifier_in_search_product'].includes(String(status || '')));
    check('executor readback matched count', Number(execEvidence?.readback?.matchedCount || 0), 1);
    check('executor readback weak matched count', Number(execEvidence?.readback?.weakMatchedCount || 0), 0);
  }
  check('execute reused dry-run payload hash', execEvidence?.payloadHash || '', PREVALID_RETRY_REBIND ? rebindDryRunPayloadHash : dryRunPayloadHash);
  check('publish trace id retained', execEvidence?.publishResult?.traceId || '', publishTraceId);

  result.summary.fakeOpenApiCallPaths = fakeOpenApiCalls.map(call => call.path);
  check('fake publish endpoint called expected times', fakeOpenApiCalls.filter(call => call.path === '/open-api/goods/product/publishOrEdit').length, PREVALID_RETRY ? 2 : 1);
  check('fake readback endpoint called', fakeOpenApiCalls.some(call => call.publishAttemptCount > 0 && (call.path === '/open-api/openapi-business-backend/product/query' || call.path === '/open-api/goods/spu-info' || call.path === '/open-api/goods/searchProduct')), (PREVALID_FAIL || MISSING_SUCCESS) ? false : true);
  if (!PREVALID_FAIL && !WEAK_READBACK_ONLY) {
    check('fake publish-spu readback called first', fakeOpenApiCalls.some(call => call.path === '/open-api/goods/spu-info' && call.body?.spuName === 'v-smoke-copy-product'), true);
    if (SEARCH_PRODUCT_READBACK) {
      check('fake searchProduct readback matched', fakeOpenApiCalls.some(call => call.path === '/open-api/goods/searchProduct'), true);
      check('fake searchProduct uses official pageSize limit', fakeOpenApiCalls
        .filter(call => call.path === '/open-api/goods/searchProduct')
        .every(call => Number(call.body?.pageSize) <= 10), true);
      check('fake searchProduct strong readback carries an expected target identity', fakeOpenApiCalls
        .filter(call => call.path === '/open-api/goods/searchProduct' && call.publishAttemptCount > 0)
        .some(call => (
          asArray(call.body?.spuNameList).includes('v-smoke-copy-product')
          || asArray(call.body?.skcNameList).includes('sv-smoke-copy-product')
          || asArray(call.body?.skuCodeList).includes('sku-smoke-copy-product')
          || asArray(call.body?.skcSupplierCodeList).includes(taskStandardGoodsSn)
          || asArray(call.body?.supplierSkuList).includes(taskStandardGoodsSn)
        )), true);
      const mismatchReadbackResponse = await fetch(`http://127.0.0.1:${fakeOpenApiPort}/open-api/goods/searchProduct`, {
        method: 'POST',
        headers: {'content-type': 'application/json', 'x-lt-openKeyId': 'dummy-open-key-hl'},
        body: JSON.stringify({pageNum: 1, pageSize: 10, skcNameList: ['sv-deliberately-wrong']}),
      });
      const mismatchReadback = await mismatchReadbackResponse.json();
      check('fake searchProduct rejects wrong target identity', asArray(mismatchReadback?.info?.list).length, 0);
    }
  }
  const publishCall = fakeOpenApiCalls.filter(call => call.path === '/open-api/goods/product/publishOrEdit').at(-1);
  check('publish sale_attribute is object', Array.isArray(publishCall?.body?.skc_list?.[0]?.sale_attribute), false);
  check('publish supplier_code uses task standard goods sn', publishCall?.body?.skc_list?.[0]?.supplier_code, taskStandardGoodsSn);
  check('publish supplier_sku uses task standard goods sn', publishCall?.body?.skc_list?.[0]?.sku_list?.[0]?.supplier_sku, taskStandardGoodsSn);
  check('publish does not keep source supplier code as new-link goods sn', publishCall?.body?.skc_list?.[0]?.supplier_code === targetSupplierCode, false);
  check('publish skc image_type allowed', publishCall?.body?.skc_list?.[0]?.image_info?.image_info_list?.every(row => [1, 2, 5, 6].includes(Number(row?.image_type))), true);
  check('publish skc main image exactly one', publishCall?.body?.skc_list?.[0]?.image_info?.image_info_list?.filter(row => Number(row?.image_type) === 1).length, 1);
  const publishedImageSorts = asArray(publishCall?.body?.skc_list?.[0]?.image_info?.image_info_list).map(row => Number(row?.image_sort));
  check('publish skc image_sort globally unique', new Set(publishedImageSorts).size, publishedImageSorts.length);
  check('publish square image sort moved away from main sort', publishCall?.body?.skc_list?.[0]?.image_info?.image_info_list?.find(row => Number(row?.image_type) === 5)?.image_sort, value => Number(value) > 1);
  if (ASSET_BINDING) {
    const publishedApprovedImages = asArray(publishCall?.body?.skc_list?.[0]?.image_info?.image_info_list)
      .slice()
      .sort((a, b) => Number(a?.image_sort) - Number(b?.image_sort));
    const expectedApprovedImageOrder = [
      'https://img.shein.com/approved/main.png',
      'https://img.shein.com/approved/15-speed.png',
      'https://img.shein.com/approved/45db.png',
      'https://img.shein.com/approved/square.png',
    ];
    check(
      'approved image order remains locked despite legacy shuffle flag',
      publishedApprovedImages.map(row => row?.image_url),
      value => JSON.stringify(value) === JSON.stringify(expectedApprovedImageOrder),
    );
    check('executor records approved order lock', asArray(executedProductRun?.payload?.safeDefaults).includes('publish_asset_binding.approved_order_locked'), true);
    check('executor does not apply detail shuffle to approved package', asArray(executedProductRun?.payload?.safeDefaults).some(row => String(row).includes('detail_shuffle_sort')), false);
    check('executor audit marks approved image order locked', Boolean(execEvidence?.approvedImageOrderLocked), true);
  }
  const publishedAttrs = asArray(publishCall?.body?.product_attribute_list);
  const publishedInputCurrent = publishedAttrs.find(row => Number(row?.attribute_id) === 1002323);
  const publishedInputVoltage = publishedAttrs.find(row => Number(row?.attribute_id) === 1002322);
  const publishedHazardousClassification = publishedAttrs.find(row => Number(row?.attribute_id) === 1002328);
  const publishedProductModel = publishedAttrs.find(row => Number(row?.attribute_id) === 1000546);
  const publishedArName = asArray(publishCall?.body?.multi_language_name_list).find(row => String(row?.language || '').toLowerCase() === 'ar');
  check('publish default ar title copied', publishedArName?.name || '', productCase.arName);
  if (productCase.requireInputCurrent) {
    check('publish SM-505 input current applied', publishedInputCurrent?.attribute_extra_value || '', '1200');
    check('publish SM-505 input current unit value id from official template', Number(publishedInputCurrent?.attribute_value_id), 304302428);
    check('publish Power Adapter input voltage derived from Plug(Voltage)', publishedInputVoltage?.attribute_extra_value || '', '220-240');
    check('publish input voltage uses official Vac unit value id', Number(publishedInputVoltage?.attribute_value_id), 301114341);
    check('publish non-transport hazard category maps to non-dangerous classification', Number(publishedHazardousClassification?.attribute_value_id), 316914660);
  } else {
    check('publish generic product does not receive SM-505 input current', Boolean(publishedInputCurrent), false);
  }
  check('publish product model remains pure model', publishedProductModel?.attribute_extra_value || '', productCase.productModel);
  check('publish text attribute removes zero value id', publishedProductModel?.attribute_value_id, undefined);
  check('publish new link scheduled at payload level', publishCall?.body?.shelf_way, 2);
  check('publish new link schedule date present', Boolean(publishCall?.body?.hope_on_sale_date), true);
  check('publish skc shelf_way copied to skc level', publishCall?.body?.skc_list?.[0]?.shelf_way, 2);
  check('publish skc schedule date copied to skc level', Boolean(publishCall?.body?.skc_list?.[0]?.hope_on_sale_date), true);

  if (WEAK_READBACK_ONLY) {
    const operatorResolveDenied = await req('/api/link-ops-tasks', {
      method: 'PATCH',
      cookie: operatorCookie,
      body: {
        id: taskId,
        status: 'done',
        note: 'operator should not be able to resolve submitted_readback_failed',
        event: 'manual_lifecycle_resolve_smoke_operator_denied',
      },
    });
    result.summary.operatorResolveDeniedStatus = operatorResolveDenied.status;
    result.summary.operatorResolveDeniedError = operatorResolveDenied.json?.error || '';
    check('operator manual resolve denied status', operatorResolveDenied.status, 403);
    check('operator manual resolve denied reason', operatorResolveDenied.json?.error || '', text => /全店管理账号|人工核销|权限|其他 BI 账号/.test(String(text || '')));

    const ownerResolve = await req('/api/link-ops-tasks', {
      method: 'PATCH',
      cookie,
      body: {
        id: taskId,
        status: 'done',
        note: 'owner manually confirmed weak readback task should be closed in smoke',
        event: 'manual_lifecycle_resolve_smoke_owner_done',
      },
    });
    const ownerResolvedRawTask = await rawTaskById(taskId);
    result.summary.ownerResolveStatus = ownerResolve.status;
    result.summary.ownerResolvedTaskStatus = ownerResolvedRawTask?.status || ownerResolve.json?.task?.status || '';
    result.summary.ownerResolvedLifecycleStatus = ownerResolvedRawTask?.lifecycle?.status || ownerResolve.json?.task?.lifecycle?.status || '';
    result.summary.ownerResolvedBy = ownerResolvedRawTask?.lifecycle?.manualResolution?.user || '';
    check('owner manual resolve status', ownerResolve.status, 200);
    check('owner manual resolve task done', ownerResolvedRawTask?.status || ownerResolve.json?.task?.status || '', 'done');
    check('owner manual resolve lifecycle status', ownerResolvedRawTask?.lifecycle?.status || ownerResolve.json?.task?.lifecycle?.status || '', 'manual_resolved_done');
    check('owner manual resolve user recorded', ownerResolvedRawTask?.lifecycle?.manualResolution?.user || '', 'owner_copy_success');
    check('owner manual resolve execution history appended', asArray(ownerResolvedRawTask?.executionHistory).some(row => row.event === 'manual_lifecycle_resolve'), true);

    const audit = await req(`/api/link-ops-audit?taskId=${encodeURIComponent(taskId)}&limit=50`, {cookie});
    const auditTypes = asArray(audit.json?.entries).map(entry => entry.type);
    result.summary.auditTypes = auditTypes;
    check('audit query status', audit.status, 200);
    check('audit contains denied operator resolve', auditTypes.includes('link-ops-task-update-denied'), true);
    check('audit contains owner manual resolve update', auditTypes.includes('link-ops-task-update'), true);
  }

  const tasks = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  const auditText = fssync.existsSync(auditFile) ? await fs.readFile(auditFile, 'utf8') : '';
  result.summary.taskCount = Array.isArray(tasks.tasks) ? tasks.tasks.length : 0;
  result.summary.auditLines = auditText.trim() ? auditText.trim().split(/\r?\n/).length : 0;
  const storedTask = asArray(tasks.tasks).find(task => String(task?.id || '') === String(taskId)) || null;
  const preflightReadyHistory = asArray(storedTask?.history).filter(row => String(row?.event || '') === 'openapi_product_preflight_ready');
  const historyEvidenceLock = asArray(preflightReadyHistory.at(-1)?.writeAudit?.executorEvidence)
    .find(row => String(row?.storeKey || '').trim().toUpperCase() === 'HL')?.payload?.sourceDetailLock || null;
  const historyExecutorLock = asArray(preflightReadyHistory.at(-1)?.openApiProductExecutors)[0]?.payload?.sourceDetailLock || null;
  check('history writeAudit executorEvidence preserves sourceDetailLock', Boolean(historyEvidenceLock), true);
  check('history openApiProductExecutors preserves sourceDetailLock', Boolean(historyExecutorLock), true);
  check('history openApiProductExecutors lock matches writeAudit lock', historyExecutorLock?.detailContentSha256 || '', historyEvidenceLock?.detailContentSha256 || '');
  check('history lock matches writeAudit executor lock', historyEvidenceLock?.detailContentSha256 || '', evidenceSourceDetailLock?.detailContentSha256 || '');
  if (PREVALID_FAIL) {
    check('pre-valid audit redacts echoed description text', auditText, text => (
      !text.includes(descriptionLines.en[0]) && !text.includes(descriptionLines.ar[0])
    ));
  }
  check('task count', result.summary.taskCount, (ASSET_BINDING ? 3 : 1) + 2);
  check('audit lines >= expected', result.summary.auditLines, n => n >= (WEAK_READBACK_ONLY ? 8 : 5));

  result.ok = result.checks.every(x => x.pass);
} finally {
  portal.kill();
  for (const auxPortal of auxiliaryPortals) {
    if (auxPortal?.exitCode === null) auxPortal.kill();
  }
  await new Promise(resolve => fakeOpenApi.close(resolve));
  await sleep(300);
  await removeSourceDetailFixtures().catch(() => {});
}

console.log(JSON.stringify(result, null, 2));
if (result.ok && !KEEP_TEMP) {
  await fs.rm(tmpRoot, {recursive: true, force: true});
} else if (!result.ok) {
  console.error(`copy success smoke failed; temp files kept at ${tmpRoot}`);
}
if (!result.ok) process.exit(1);
