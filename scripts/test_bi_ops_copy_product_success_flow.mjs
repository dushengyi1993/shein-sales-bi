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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP_TEMP = process.argv.includes('--keep-temp');
const WEAK_READBACK_ONLY = process.argv.includes('--weak-readback');
const PREVALID_FAIL = process.argv.includes('--prevalid-fail');
const PREVALID_RETRY = process.argv.includes('--prevalid-retry');
const GENERIC_PRODUCT = process.argv.includes('--generic-product');
const CHAT_NATURAL = process.argv.includes('--chat-natural');
const SEARCH_PRODUCT_READBACK = process.argv.includes('--search-product-readback');
const ASSET_BINDING = process.argv.includes('--asset-binding');
const CONFIRM_TEXT = 'SHEIN_OPENAPI_SUBMIT';
const tmpBase = path.join(ROOT, 'tmp');
await fs.mkdir(tmpBase, {recursive: true});
const tmpRoot = await fs.mkdtemp(path.join(tmpBase, 'bi-ops-copy-success-smoke-'));
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
  if (pathname === '/open-api/openapi-business-backend/query-store-info') {
    return sendJson(res, {
      code: '0',
      msg: 'OK',
      info: {
        accountNo: 'GS8313514',
        merchantId: '12224658',
        companyName: '皓兰',
        shopName: 'Copy Success HL',
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
    if (requestedSpu === 'v-smoke-copy-product'
      && (publishAttemptCount === 0
        || (!WEAK_READBACK_ONLY && (!SEARCH_PRODUCT_READBACK || searchProductAlreadyCalled)))) {
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
            skcName: SOURCE_SKC,
            supplierCode: targetSupplierCode,
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
    if (asArray(body.json?.skcNameList).includes(SOURCE_SKC)) {
      return sendJson(res, {
        code: '0',
        msg: 'OK',
        info: {
          list: [{
            spuName: 'v-smoke-copy-product',
            skcList: [{skcName: SOURCE_SKC}],
          }],
          count: 1,
        },
      });
    }
    if (SEARCH_PRODUCT_READBACK && publishAttemptCount > 0 && !WEAK_READBACK_ONLY) {
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
const htpasswdFile = path.join(tmpRoot, 'empty.htpasswd');
await fs.writeFile(htpasswdFile, '', 'utf8');
const stateFile = path.join(tmpRoot, 'action_state.json');
const taskFile = path.join(tmpRoot, 'tasks.json');
const chatFile = path.join(tmpRoot, 'chats.json');
const auditFile = path.join(tmpRoot, 'audit.jsonl');
const sessionSecretFile = path.join(tmpRoot, 'session_secret');
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
async function req(pathname, {method = 'GET', cookie = '', body = undefined} = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(body !== undefined ? {'Content-Type': 'application/json'} : {}),
      ...(cookie ? {Cookie: cookie} : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return {status: res.status, headers: res.headers, text, json};
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

const result = {ok: false, scenario: `${CHAT_NATURAL ? 'chat-natural-' : ''}${GENERIC_PRODUCT ? 'generic-product-' : ''}${WEAK_READBACK_ONLY ? 'weak-readback-only' : PREVALID_FAIL ? 'prevalid-fail' : PREVALID_RETRY ? 'prevalid-retry' : 'strong-readback-success'}`, tmpRoot, fakeOpenApiPort, portalPort, summary: {}, checks: []};
function check(label, actual, expected) {
  const pass = typeof expected === 'function' ? expected(actual) : actual === expected;
  result.checks.push({label, actual, expected: typeof expected === 'function' ? expected.name || 'predicate' : expected, pass});
  return pass;
}

try {
  if (PREVALID_RETRY && !CHAT_NATURAL) {
    throw new Error('--prevalid-retry is only meaningful with --chat-natural');
  }
  await waitReady();
  const cookie = await login('owner_copy_success', 'owner-pass');
  const operatorCookie = await login('operator_copy_success', 'operator-pass');

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
          {name: '02-approved-main.png', role: 'mainCover', imageType: 1, imageUrl: 'https://img.shein.com/approved/main.png', width: 900, height: 1200, order: 1},
          {name: '05-approved-carousel.png', role: 'carouselSecondCover', imageType: 1, imageUrl: 'https://img.shein.com/approved/carousel.png', width: 900, height: 1200, order: 2},
          {name: '11-approved-15-speed.png', role: 'detail', imageType: 2, imageUrl: 'https://img.shein.com/approved/15-speed.png', width: 900, height: 1200, order: 3},
          {name: '12-approved-45db.png', role: 'detail', imageType: 2, imageUrl: 'https://img.shein.com/approved/45db.png', width: 900, height: 1200, order: 4},
          {name: '03-approved-square.png', role: 'squareImage', imageType: 5, imageUrl: 'https://img.shein.com/approved/square.png', width: 1254, height: 1254, order: 5},
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
          {name: '02-approved-main.png', role: 'mainCover', imageType: 1, imageUrl: 'https://img.shein.com/approved/main.png', width: 900, height: 1200, order: 1},
          {name: '05-approved-carousel.png', role: 'carouselSecondCover', imageType: 1, imageUrl: 'https://img.shein.com/approved/carousel.png', width: 900, height: 1200, order: 2},
          {name: '11-approved-detail.png', role: 'detail', imageType: 2, imageUrl: 'https://img.shein.com/approved/detail.png', width: 900, height: 1200, order: 3},
          {name: '03-approved-square.png', role: 'squareImage', imageType: 5, imageUrl: 'https://img.shein.com/approved/square.png', width: 1254, height: 1254, order: 4},
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
    const reusedCorrection = await req('/api/link-ops-publish-assets', {
      method: 'POST',
      cookie,
      body: {taskId: maintenanceTaskId, store: 'HL', sourceApproved: true, sourceTaskId: correctionSourceTaskId, reuseApprovedBinding: true},
    });
    maintenanceRawTask = await rawTaskById(maintenanceTaskId);
    check('existing approved binding can prepare correction without reupload', reusedCorrection.status, 200);
    check('reused correction keeps same approved image count', maintenanceRawTask?.publishAssetBinding?.imageCount, 4);
    check('reused correction keeps source task', maintenanceRawTask?.pendingNewListingImageCorrection?.sourceTaskId, correctionSourceTaskId);
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

  // Descriptions are the final reviewed-material mutation: bind after any
  // approved image/publish preparation so the strict bound payload hash also
  // locks the current image structure.
  const descriptionBindBaseTask = await rawTaskById(taskId);
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
    check('prevalid-retry answer keeps platform free text hash-only', firstRetryAnswer, text => (
      /平台回显内容已脱敏/.test(String(text || ''))
      && !/商品标题不能为空/.test(String(text || ''))
      && !String(text || '').includes(descriptionLines.en[0].slice(0, 80))
    ));
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
  } else if (!PREVALID_FAIL) {
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
  check('execute reused dry-run payload hash', execEvidence?.payloadHash || '', dryRunPayloadHash);
  check('publish trace id retained', execEvidence?.publishResult?.traceId || '', publishTraceId);

  result.summary.fakeOpenApiCallPaths = fakeOpenApiCalls.map(call => call.path);
  check('fake publish endpoint called expected times', fakeOpenApiCalls.filter(call => call.path === '/open-api/goods/product/publishOrEdit').length, PREVALID_RETRY ? 2 : 1);
  check('fake readback endpoint called', fakeOpenApiCalls.some(call => call.publishAttemptCount > 0 && (call.path === '/open-api/openapi-business-backend/product/query' || call.path === '/open-api/goods/spu-info' || call.path === '/open-api/goods/searchProduct')), PREVALID_FAIL ? false : true);
  if (!PREVALID_FAIL && !WEAK_READBACK_ONLY) {
    check('fake publish-spu readback called first', fakeOpenApiCalls.some(call => call.path === '/open-api/goods/spu-info' && call.body?.spuName === 'v-smoke-copy-product'), true);
    if (SEARCH_PRODUCT_READBACK) {
      check('fake searchProduct readback matched', fakeOpenApiCalls.some(call => call.path === '/open-api/goods/searchProduct'), true);
      check('fake searchProduct uses official pageSize limit', fakeOpenApiCalls
        .filter(call => call.path === '/open-api/goods/searchProduct')
        .every(call => Number(call.body?.pageSize) <= 10), true);
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
  if (PREVALID_FAIL) {
    check('pre-valid audit redacts echoed description text', auditText, text => (
      !text.includes(descriptionLines.en[0]) && !text.includes(descriptionLines.ar[0])
    ));
  }
  check('task count', result.summary.taskCount, ASSET_BINDING ? 3 : 1);
  check('audit lines >= expected', result.summary.auditLines, n => n >= (WEAK_READBACK_ONLY ? 8 : 5));

  result.ok = result.checks.every(x => x.pass);
} finally {
  portal.kill();
  await new Promise(resolve => fakeOpenApi.close(resolve));
  await sleep(300);
}

console.log(JSON.stringify(result, null, 2));
if (result.ok && !KEEP_TEMP) {
  await fs.rm(tmpRoot, {recursive: true, force: true});
} else if (!result.ok) {
  console.error(`copy success smoke failed; temp files kept at ${tmpRoot}`);
}
if (!result.ok) process.exit(1);
