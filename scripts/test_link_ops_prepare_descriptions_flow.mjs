#!/usr/bin/env node
/**
 * Phase A integration smoke for reviewed-material description binding.
 *
 * Spins up an isolated fake SHEIN OpenAPI server and an isolated BI portal
 * (json store gateway) and proves:
 *   - copy_product_draft dry-run without bound descriptions is blocked;
 *   - /api/link-ops-prepare-descriptions binds ar/en 5-line descriptions to
 *     the same task, changes only multi_language_desc_list, keeps the image
 *     structure and image binding fingerprint identical, invalidates the old
 *     preflight/hash and resets ready/submit flags;
 *   - the write goes through the atomic single-task CAS (stale expected
 *     revision -> HTTP 409; gateway updateTaskRecord itself throws
 *     LinkOpsRevisionConflictError on a mismatched revision);
 *   - the task only becomes ready again after a fresh dry-run;
 *   - a fresh dry-run converges the top-level task preflight with the
 *     execution preflight in the same persisted record (ready and blocked
 *     cases), so the binding invalidation never outlives the new dry-run;
 *   - execute requires code=0 AND explicit info.success===true; a response
 *     without an explicit success flag is not treated as success;
 *   - live spu-info description readback must match the binding hashes
 *     byte-for-byte; drift yields submitted_readback_failed (needs manual
 *     resolve), never submitted_readback_matched;
 *   - audit/binding records carry hashes only, never full description text.
 */
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  extractTrilingualCoreSellingPoints,
  verifyDescriptionMaterialAgainstHtml,
} from '../lib/link_ops_description_material_extract.mjs';
import {
  buildDescriptionPayloadRows,
  describeDescriptionMaterial,
  sha256Utf8,
  validateDescriptionBindingLock,
} from '../lib/link_ops_product_descriptions.mjs';
import {writeOpenApiProductCacheAtomically} from '../lib/shein_openapi_product_cache.mjs';
import {linkOpsPayloadHash} from '../lib/link_ops_repository.mjs';
import {canonicalRecoveredPublishPayloadHash} from '../lib/link_ops_uploaded_asset_binding_recovery.mjs';
import {createConfiguredLinkOpsStoreGateway} from '../lib/link_ops_store_gateway.mjs';
import {__testHooks as portalHooks} from './serve_bi_portal.mjs';
import {provisionBiSessionSecret} from './provision_bi_session_secret.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = path.join(ROOT, 'tmp');
await fs.mkdir(tmpBase, {recursive: true});
const tmpRoot = await fs.mkdtemp(path.join(tmpBase, 'bi-ops-prepare-descriptions-'));
const testOutputDir = path.join(tmpRoot, 'outputs');
process.env.SHEIN_BI_OUTPUT_DIR = testOutputDir;
process.env.SHEIN_OPENAPI_PRODUCT_CACHE_DIR = path.join(testOutputDir, 'shein_openapi_products');
const CONFIRM_TEXT = 'SHEIN_OPENAPI_SUBMIT';
const SOURCE_STORE = 'NM';
const SOURCE_SPU = 'v20990101999999';
const SOURCE_DETAIL_AT = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const DESC_SUPPLIER_CODES = [
  'DESC-PURE-CHECK-REUSE',
  'DESC-CONCURRENT',
  'DESC-MATCH',
  'DESC-POST-COMMIT',
  'DESC-NO-SUCCESS',
  'DESC-DRIFT',
  'DESC-FALLBACK',
  'DESC-SEARCH-EXACT',
  'DESC-SEARCH-DRIFT',
  'DESC-PRODUCT-EXACT',
  'DESC-PRODUCT-DRIFT',
  'DESC-HISTORY-PAYLOAD',
  'DESC-UNAPPROVED-ASSET',
  'DESC-TAMPERED-ASSET',
  'DESC-NESTED-DEBUG-ASSET',
  'DESC-PRIOR-WRITE',
  'DESC-SUBMITTED-STATE',
  'DESC-HISTORY-WRITE',
  'DESC-AUDIT-HISTORY',
  'DESC-CLI',
  'DESC-CLI-UNCONFIRMED',
  'DESC-CLI-LEGACY-S9',
  'DESC-CLI-AUDIT-PENDING',
  'DESC-AUDIT-FAILURE',
  'DESC-DEEP-AUDIT-WRITE',
  'DESC-TOP-LEVEL-AUDIT-WRITE',
  'DESC-MALFORMED-AUDIT',
  'DESC-POST-BIND-BLOCKED',
  'DESC-REBIND',
  'DESC-REBIND-LOCKED',
  'DESC-LOCK-MATRIX',
  'DESC-EXPECTED-REVISION',
];
const SOURCE_LOCKED_CODES = new Set([
  'DESC-PURE-CHECK-REUSE',
  'DESC-MATCH',
  'DESC-POST-COMMIT',
  'DESC-NO-SUCCESS',
  'DESC-DRIFT',
  'DESC-FALLBACK',
  'DESC-SEARCH-EXACT',
  'DESC-SEARCH-DRIFT',
  'DESC-PRODUCT-EXACT',
  'DESC-PRODUCT-DRIFT',
  'DESC-CLI',
  'DESC-CLI-UNCONFIRMED',
  'DESC-CLI-LEGACY-S9',
  'DESC-CLI-AUDIT-PENDING',
  'DESC-POST-BIND-BLOCKED',
  'DESC-REBIND',
  'DESC-REBIND-LOCKED',
  'DESC-LOCK-MATRIX',
  'DESC-EXPECTED-REVISION',
]);
const sourceSkcFor = code => `sv20990101${String(DESC_SUPPLIER_CODES.indexOf(code)).padStart(6, '0')}`;
const descSourceLinkDir = path.join(testOutputDir, 'shein_links', SOURCE_STORE);
const descSourceOpenApiDir = path.join(testOutputDir, 'shein_openapi_products', SOURCE_STORE);
async function writeDescSourceFixtures() {
  await fs.mkdir(descSourceLinkDir, {recursive: true});
  await fs.mkdir(descSourceOpenApiDir, {recursive: true});
  const skcList = DESC_SUPPLIER_CODES.map(sourceSkcFor);
  const sourceNames = [
    {language: 'en', productName: 'Desc bind source product'},
    {language: 'ar', productName: 'منتج مصدر ربط الوصف'},
  ];
  await fs.writeFile(path.join(descSourceLinkDir, '2099-01-01.json'), `${JSON.stringify({
    linkRows: skcList.map(skc => ({
      storeKey: SOURCE_STORE,
      skc,
      spu: SOURCE_SPU,
      standardGoodsSn: 'SM-11004',
      productNameCn: 'SM-11004',
      rawGoodsSn: 'RAW-SM-11004',
    })),
    inventoryRows: [],
    performanceRows: [],
  }, null, 2)}\n`, 'utf8');
  await writeOpenApiProductCacheAtomically(path.join(descSourceOpenApiDir, 'latest.json'), {
    schemaVersion: 'shein-openapi-product-basics/v1',
    storeKey: SOURCE_STORE,
    fetchedAt: SOURCE_DETAIL_AT,
    normalizedRows: skcList.map(skc => ({spu: SOURCE_SPU, skc})),
    detailResults: [{
      ok: true,
      detailFetchedAt: SOURCE_DETAIL_AT,
      info: {
        spuName: SOURCE_SPU,
        categoryId: 123456,
        productTypeId: 789,
        brandCode: 'BRAND_SMOKE',
        productMultiNameList: sourceNames,
        productAttributeInfoList: [{attributeId: 1000546, attributeValueId: 0, attributeValue: 'SM-11004'}],
        skcInfoList: skcList.map(skc => ({
          skcName: skc,
          supplierCode: `SRC-${skc}`,
          productMultiNameList: sourceNames,
          skcImageInfoList: [
            {imageUrl: 'https://example.invalid/desc-main.jpg', imageType: 'MAIN'},
            {imageUrl: 'https://example.invalid/desc-detail.jpg', imageType: 'DETAIL'},
            {imageUrl: 'https://example.invalid/desc-square.jpg', imageType: 'SQUARE'},
          ],
          saleAttributeList: [{attributeId: 301, attributeValueId: 401}],
          skuInfoList: [{
            skuCode: `SKU-${skc}`,
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
        })),
      },
    }],
    detailFallbackResults: [],
  }, {storeKey: SOURCE_STORE, generatedAt: SOURCE_DETAIL_AT});
}
async function removeDescSourceFixtures() {
  await fs.rm(descSourceLinkDir, {recursive: true, force: true});
  await fs.rm(descSourceOpenApiDir, {recursive: true, force: true});
}

const enLines = ['EN selling point one', 'EN selling point two', 'EN selling point three', 'EN selling point four', 'EN selling point five'];
const arLines = ['سطر أول', 'سطر ثانٍ', 'سطر ثالث', 'سطر رابع', 'سطر خامس'];
const zhLines = ['中文卖点一', '中文卖点二', '中文卖点三', '中文卖点四', '中文卖点五'];
const code = lines => `<code>${lines.join('\n')}</code>`;
const htmlMaterial = `<!doctype html><html><body>
<section id="s09">
  <p>说明：英文、阿文、中文分别展示三语核心卖点，请逐字复制不要改写。</p>
  <article class="card"><h3>英文</h3>${code(enLines)}</article>
  <article class="card"><h3>阿文</h3>${code(arLines)}</article>
  <div class="displaybox">${zhLines.map(line => `<div>${line}</div>`).join('')}</div>
</section>
</body></html>`;
const sourceBytes = Buffer.from(htmlMaterial, 'utf8');
const material = verifyDescriptionMaterialAgainstHtml(htmlMaterial, sourceBytes, {
  sourceFileBasename: 'SK-11004-review.html',
  sourceFileSha256: '',
}).material;
const materialSummary = describeDescriptionMaterial(material);
const alternateEnLines = ['Alternate EN one', ...enLines.slice(1)];
const alternateHtmlMaterial = `<!doctype html><html><body>
<section id="s09">
  <article class="card"><h3>英文</h3>${code(alternateEnLines)}</article>
  <article class="card"><h3>阿文</h3>${code(arLines)}</article>
  <div class="displaybox">${zhLines.map(line => `<div>${line}</div>`).join('')}</div>
</section>
</body></html>`;
const alternateSourceBytes = Buffer.from(alternateHtmlMaterial, 'utf8');
const alternateMaterial = verifyDescriptionMaterialAgainstHtml(alternateHtmlMaterial, alternateSourceBytes, {
  sourceFileBasename: 'SK-11004-review-alternate.html',
  sourceFileSha256: '',
}).material;
const alternateMaterialSummary = describeDescriptionMaterial(alternateMaterial);
const legacyHtmlMaterial = `<!doctype html><html><body>
<section id="s9">
  <div class="note">英文卖点评分：97/100。5条按用户决策顺序排列。</div>
  <div class="copy-wrap"><div class="copybar"><button class="copy-btn" type="button">一键复制</button></div><pre class="copybox copytext" dir="ltr"><code>${enLines.join('\n')}</code></pre></div>
  <div class="note">阿文卖点评分：98/100。用词贴近沙特用户。</div>
  <div class="copy-wrap right"><div class="copybar"><button class="copy-btn" type="button">一键复制</button></div><pre class="copybox copytext right" dir="rtl"><code>${arLines.join('\n')}</code></pre></div>
  <div class="note">中文仅用于内部核对，逐行对应英文和阿文。</div>
  <div class="copy-wrap"><div class="copybar"><button class="copy-btn" type="button">一键复制</button></div><pre class="copybox copytext" dir="ltr"><code>${zhLines.join('\n')}</code></pre></div>
</section>
</body></html>`;
const legacySourceBytes = Buffer.from(legacyHtmlMaterial, 'utf8');

function publishPayloadFor(supplierCode) {
  return {
    category_id: 123456,
    product_type_id: 789,
    source_system: 'OpenAPI',
    brand_code: 'BRAND_SMOKE',
    site_list: [{main_site: 'shein', sub_site_list: ['shein-sa']}],
    multi_language_name_list: [
      {language: 'en', product_name: 'Desc bind smoke product'},
      {language: 'ar', product_name: 'منتج تجريبي'},
    ],
    product_attribute_list: [
      {attribute_id: 101, attribute_value_id: 202},
      {attribute_id: 1000546, attribute_value_id: 0, attribute_value: 'SM-11004'},
    ],
    shelf_way: 2,
    hope_on_sale_date: '2036-06-27 10:00:00',
    skc_list: [{
      supplier_code: supplierCode,
      skc_name: supplierCode,
      image_info: {
        image_info_list: [
          {image_type: 1, image_sort: 1, image_url: 'https://img.shein.com/main.jpg'},
          {image_type: 5, image_sort: 2, image_url: 'https://img.shein.com/square.jpg'},
        ],
      },
      sale_attribute: {attribute_id: 301, attribute_value_id: 401},
      sku_list: [{
        supplier_sku: `${supplierCode}-SKU`,
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
}

function validPublishAssetBindingFixture(task, supplierCode) {
  const images = [
    {name: 'desc-main.jpg', role: 'mainCover', imageType: 1, imageUrl: 'https://img.shein.com/main.jpg', width: 1000, height: 1000, sha256: crypto.createHash('sha256').update('desc-main-image').digest('hex')},
    {name: 'desc-square.jpg', role: 'squareImage', imageType: 5, imageUrl: 'https://img.shein.com/square.jpg', width: 800, height: 800, sha256: crypto.createHash('sha256').update('desc-square-image').digest('hex')},
  ];
  const binding = {
    schemaVersion: 1,
    kind: 'copy_product_draft',
    sourceApproved: true,
    authority: 'human_reviewed_source',
    targetStore: 'NM',
    boundAt: '2026-08-15T00:00:00.000Z',
    boundByUser: 'owner_desc_bind',
    imageCount: images.length,
    images,
    evidence: {payloadSource: 'task', preflightInvalidated: true},
    publishPreparation: {
      standardGoodsSn: supplierCode,
      supplierSku: `${supplierCode}-SKU`,
      supplyPrice: 99,
      inventory: 100,
      categoryId: 123456,
      titles: {en: 'Desc bind smoke product', ar: 'منتج تجريبي'},
      attributeOverrides: [],
    },
  };
  binding.bindingFingerprint = portalHooks.canonicalPublishAssetBindingFingerprint(task, {
    binding,
    images: binding.images,
    publishPreparation: binding.publishPreparation,
  });
  return binding;
}

function updatedPublishAssetBindingFixture(task, payload, {supplyPrice, mainImageUrl = '', boundAt = new Date().toISOString()} = {}) {
  const binding = JSON.parse(JSON.stringify(task?.publishAssetBinding || {}));
  binding.boundAt = boundAt;
  binding.publishPreparation = {
    ...(binding.publishPreparation || {}),
    ...(supplyPrice === undefined ? {} : {supplyPrice}),
  };
  if (mainImageUrl) {
    const main = asArray(binding.images).find(row => Number(row?.imageType) === 1);
    if (main) main.imageUrl = mainImageUrl;
  }
  const nextTask = {...task, openapiPublishPayload: payload, publishAssetBinding: binding};
  binding.bindingFingerprint = portalHooks.canonicalPublishAssetBindingFingerprint(nextTask, {
    binding,
    images: binding.images,
    publishPreparation: binding.publishPreparation,
  });
  return binding;
}

const checks = [];
function check(label, actual, expected) {
  const pass = typeof expected === 'function' ? expected(actual) : actual === expected;
  checks.push({label, actual, expected: typeof expected === 'function' ? (expected.name || 'predicate') : expected, pass});
  return pass;
}
async function checkRejects(label, fn) {
  let rejected = false;
  try { await fn(); } catch { rejected = true; }
  return check(label, rejected, true);
}
function asArray(value) { return Array.isArray(value) ? value : []; }

async function getFreePort() {
  return new Promise((resolve, reject) => {
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
function sendJson(res, value, status = 200) {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'});
  res.end(JSON.stringify(value));
}
function readBody(req) {
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
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// --- fake OpenAPI server ---
const fakeOpenApiCalls = [];
const descReadbackMode = {mode: 'exact'};
const publishSuccessMode = {mode: 'explicit_true'};
const readbackRouteMode = {mode: 'direct'};
const publishedIdentities = new Map();
const fakeOpenApiPort = await getFreePort();
const fakeOpenApi = http.createServer(async (req, res) => {
  const body = await readBody(req);
  fakeOpenApiCalls.push({path: req.url.split('?')[0], method: req.method, body: body.json || body.text});
  const pathname = req.url.split('?')[0];
  if (pathname === '/open-api/openapi-business-backend/query-store-info') {
    return sendJson(res, {code: '0', msg: 'OK', info: {accountNo: 'GS5159206', merchantId: '6745755', companyName: '南墨', shopName: 'Desc Bind NM'}});
  }
  if (pathname === '/open-api/goods/product/check-publish-permission') {
    return sendJson(res, {code: '0', msg: 'OK', info: {canPublishProduct: true, reason: ''}});
  }
  if (pathname === '/open-api/goods/query-site-list') {
    return sendJson(res, {code: '0', msg: 'OK', info: [{main_site: 'shein', main_site_name: 'SHEIN', sub_site_list: [{site_abbr: 'shein-sa', site_name: 'SHEIN Saudi Arabia', currency: 'SAR', site_status: 1}]}]});
  }
  if (pathname === '/open-api/goods/query-brand-list') {
    return sendJson(res, {code: '0', msg: 'OK', info: [{brand_code: 'BRAND_SMOKE', brand_name: 'Smoke Brand'}]});
  }
  if (pathname === '/open-api/msc/warehouse/list') {
    return sendJson(res, {code: '0', msg: 'OK', info: [{supplier_warehouse_id: 'WH-SMOKE', supplier_warehouse_name: 'Smoke Warehouse', status: 1}]});
  }
  if (pathname === '/open-api/goods/query-publish-fill-in-standard') {
    return sendJson(res, {code: '0', msg: 'OK', info: {default_language: 'ar', default_language_title_max_length: 325, language_title_max_length_list: [{language: 'ar', max_length: 325}, {language: 'en', max_length: 250}], currency: 'SAR', fill_in_standard_list: []}});
  }
  if (pathname === '/open-api/goods/query-attribute-template') {
    return sendJson(res, {code: '0', msg: 'OK', info: {data: [{product_type_id: 789, attribute_infos: []}]}});
  }
  if (pathname === '/open-api/goods/searchProduct') {
    if (publishSuccessMode.mode === 'success_without_spu') {
      return sendJson(res, {
        code: '0',
        msg: 'OK',
        info: {data: [{skcName: 'DESC-FALLBACK', supplierCode: 'DESC-FALLBACK', skuCodeList: ['DESC-FALLBACK-SKU-1']}]},
      });
    }
    if (readbackRouteMode.mode === 'search') {
      const requested = [
        ...asArray(body.json?.spuNameList),
        ...asArray(body.json?.skcNameList),
        ...asArray(body.json?.skuCodeList),
        ...asArray(body.json?.skcSupplierCodeList),
        ...asArray(body.json?.supplierSkuList),
      ].map(String);
      const identity = [...publishedIdentities.values()].find(row => requested.some(value => (
        value === row.spuName || value === row.skcName || value === row.skuCode || value === row.supplierCode || value === row.supplierSku
      )));
      if (identity) {
        return sendJson(res, {
          code: '0',
          msg: 'OK',
          info: {
            list: [{
              spuName: identity.spuName,
              skcList: [{
                skcName: identity.skcName,
                supplierCode: identity.supplierCode,
                skuList: [{skuCode: identity.skuCode, supplierSku: identity.supplierSku}],
              }],
            }],
            count: 1,
          },
        });
      }
    }
    return sendJson(res, {code: '0', msg: 'OK', info: null});
  }
  if (pathname === '/open-api/openapi-business-backend/product/query') {
    if (readbackRouteMode.mode === 'product_query') {
      const identity = [...publishedIdentities.values()].at(-1);
      if (identity) {
        return sendJson(res, {
          code: '0',
          msg: 'OK',
          info: {data: [{
            spuName: identity.spuName,
            skcName: identity.skcName,
            supplierCode: identity.supplierCode,
            supplierSku: identity.supplierSku,
            skuCodeList: [identity.skuCode],
            productName: 'Description readback product-query match',
          }]},
        });
      }
    }
    return sendJson(res, {code: '0', msg: 'OK', info: {data: []}});
  }
  if (pathname === '/open-api/goods/product/publishOrEdit') {
    const payload = body.json || {};
    const supplierCode = String(payload?.skc_list?.[0]?.supplier_code || '');
    if (publishSuccessMode.mode === 'no_success_flag') {
      return sendJson(res, {code: '0', msg: 'OK', traceId: 'trace-no-success', info: {version: 'SPMP-NO-SUCCESS'}});
    }
    if (publishSuccessMode.mode === 'success_without_spu') {
      return sendJson(res, {
        code: '0',
        msg: 'OK',
        traceId: 'trace-no-spu',
        info: {
          success: true,
          skc_list: [{skc_name: supplierCode, sku_list: [{sku_code: `${supplierCode}-SKU-1`}]}],
          version: 'SPMP-NO-SPU',
        },
      });
    }
    const spuName = `v-${supplierCode.toLowerCase()}`;
    publishedIdentities.set(spuName, {
      spuName,
      skcName: supplierCode,
      skuCode: `${supplierCode}-SKU-1`,
      supplierCode,
      supplierSku: `${supplierCode}-SKU`,
    });
    return sendJson(res, {
      code: '0',
      msg: 'OK',
      traceId: 'trace-desc-bind',
      info: {
        success: true,
        taskNo: 'PUB-DESC-001',
        spu_name: spuName,
        skc_list: [{skc_name: supplierCode, sku_list: [{sku_code: `${supplierCode}-SKU-1`}]}],
        version: 'SPMP-DESC-001',
      },
    });
  }
  if (pathname === '/open-api/goods/spu-info') {
    const spuName = String(body.json?.spuName || '');
    if (spuName === SOURCE_SPU && !publishedIdentities.has(spuName)) {
      return sendJson(res, {
        code: '0',
        msg: 'OK',
        info: {
          spuName: SOURCE_SPU,
          productMultiNameList: [
            {language: 'en', productName: 'Desc bind source product'},
            {language: 'ar', productName: 'منتج مصدر ربط الوصف'},
          ],
          skcInfoList: DESC_SUPPLIER_CODES.map(code => ({
            skcName: sourceSkcFor(code),
            productMultiNameList: [
              {language: 'en', productName: 'Desc bind source product'},
              {language: 'ar', productName: 'منتج مصدر ربط الوصف'},
            ],
            skuInfoList: [{skuCode: `SKU-${sourceSkcFor(code)}`, supplierSku: ''}],
          })),
        },
      });
    }
    const identity = publishedIdentities.get(spuName);
    const searchSeen = fakeOpenApiCalls.some(call => call.path === '/open-api/goods/searchProduct'
      && asArray(call.body?.spuNameList).map(String).includes(spuName));
    const productQuerySeen = fakeOpenApiCalls.some(call => call.path === '/open-api/openapi-business-backend/product/query');
    if (!identity
      || (readbackRouteMode.mode === 'search' && !searchSeen)
      || (readbackRouteMode.mode === 'product_query' && !productQuerySeen)) {
      return sendJson(res, {code: '404', msg: 'not ready for forced fallback', info: null});
    }
    const productMultiDescList = descReadbackMode.mode === 'drift'
      ? [
          {language: 'ar', productDesc: arLines.join('\n')},
          {language: 'en', productDesc: ['drifted first line', ...enLines.slice(1)].join('\n')},
        ]
      : [
          {language: 'ar', productDesc: arLines.join('\n')},
          {language: 'en', productDesc: enLines.join('\n')},
        ];
    return sendJson(res, {code: '0', msg: 'OK', info: {
      spuName,
      productMultiDescList,
      skcInfoList: [{
        skcName: identity.skcName,
        supplierCode: identity.supplierCode,
        skuInfoList: [{skuCode: identity.skuCode, supplierSku: identity.supplierSku}],
      }],
    }});
  }
  return sendJson(res, {code: '0', msg: 'OK', info: null});
});
await new Promise(resolve => fakeOpenApi.listen(fakeOpenApiPort, '127.0.0.1', resolve));

// --- portal config ---
const authFile = await writeJson('auth.json', {
  users: [{
    username: 'owner_desc_bind',
    password: 'owner-pass',
    displayName: 'Owner Desc Bind',
    role: 'owner',
    readStores: ['*'],
    writeStores: ['*'],
    ownerKey: 'OWNER_DESC_BIND',
  }],
});
const accessRolesFile = await writeJson('access_roles.json', {
  defaults: {owner: {readStores: ['*'], writeStores: ['*']}, operator: {readStores: ['*'], writeStores: []}},
});
const openapiConfigFile = await writeJson('openapi.json', {
  environment: 'desc-bind-smoke',
  cooperationMode: '半托管',
  market: 'SA',
  apiBaseUrls: {prodSemiManaged: `http://127.0.0.1:${fakeOpenApiPort}`},
  stores: [{
    storeKey: 'NM',
    shopName: 'Desc Bind NM',
    enabled: true,
    openKeyId: 'dummy-open-key-nm',
    secretKey: 'dummy-secret-nm',
    authorizedAt: '2026-06-27T00:00:00.000+08:00',
  }],
  safeWriteOperations: {
    enabled: true,
    requireDryRun: true,
    allowedOperations: ['copy_product_draft'],
    allowedStores: ['NM'],
  },
});
const whitelistFile = await writeJson('whitelist.json', {
  enabled: true,
  rules: [{
    id: 'owner-nm-desc-bind',
    enabled: true,
    realSubmit: true,
    stores: ['NM'],
    operations: ['copy_product_draft'],
    allowedUsers: ['owner_desc_bind'],
    allowedOwnerKeys: ['OWNER_DESC_BIND'],
    allowedRoles: ['owner'],
  }],
});
const readProbeSummaryFile = await writeJson('read-probes.latest.json', {
  generatedAt: new Date().toISOString(),
  counts: {total: 1, readProbeOk: 1, pending: 0, failed: 0},
  results: [{storeKey: 'NM', ok: true, status: 'read_probe_ok'}],
});
await writeDescSourceFixtures();
const htpasswdFile = path.join(tmpRoot, 'empty.htpasswd');
await fs.writeFile(htpasswdFile, '', 'utf8');
const stateFile = path.join(tmpRoot, 'action_state.json');
const taskFile = path.join(tmpRoot, 'tasks.json');
const chatFile = path.join(tmpRoot, 'chats.json');
const auditFile = path.join(tmpRoot, 'audit.jsonl');
const auditFailureMarker = path.join(tmpRoot, 'fail-description-audit.marker');
const executionAuditFailureMarker = path.join(tmpRoot, 'fail-execution-audit.marker');
const executionPostCommitFailureMarker = path.join(tmpRoot, 'fail-execution-post-commit.marker');
const sessionSecretFile = path.join(tmpRoot, 'session_secret');
await provisionBiSessionSecret(sessionSecretFile);
const manualLoginStateFile = path.join(tmpRoot, 'manual_login.json');
const portalDir = path.join(tmpRoot, 'portal');
await fs.mkdir(portalDir, {recursive: true});
await fs.writeFile(path.join(portalDir, 'index.html'), '<!doctype html><html><body>desc-bind-test-portal</body></html>', 'utf8');

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
  '--dir', portalDir,
], {
  cwd: ROOT,
  env: {
    ...process.env,
    NODE_ENV: 'test',
    SHEIN_LINK_OPS_STORE: 'json',
    SHEIN_WEBHOOK_REPOSITORY_ENABLED: '0',
    SHEIN_BI_LIVE_UPDATES_ENABLED: '0',
    SHEIN_BI_LIVE_ACCOUNTING_ENABLED: '0',
    SHEIN_BI_EXTERNAL_SECTION_QUEUE_ENABLED: '0',
    SHEIN_BI_TEST_ALLOW_FAKE_WEBHOOK_GATE: '1',
    SHEIN_BI_CORE_WARMUP_DISABLED: '1',
    SHEIN_BI_INTENT_PLANNER_ENABLED: '0',
    SHEIN_BI_JOB_WORKER_ENABLED: '0',
    SHEIN_OWNER_KNOWLEDGE_GIT_REPO_DIR: '',
    SHEIN_OPENAPI_CONFIG_FILE: openapiConfigFile,
    SHEIN_BI_OPS_WRITE_WHITELIST_FILE: whitelistFile,
    SHEIN_OPENAPI_READ_PROBE_SUMMARY_FILE: readProbeSummaryFile,
    SHEIN_LINK_OPS_OPENAPI_EXECUTOR_TIMEOUT_MS: '15000',
    SHEIN_LINK_OPS_READBACK_MAX_PAGES: '1',
    SHEIN_BI_TEST_DESCRIPTION_AUDIT_FAIL_FILE: auditFailureMarker,
    SHEIN_BI_TEST_EXECUTION_AUDIT_FAIL_FILE: executionAuditFailureMarker,
    SHEIN_BI_TEST_EXECUTION_POST_COMMIT_FAIL_FILE: executionPostCommitFailureMarker,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let portalStdout = '';
let portalStderr = '';
portal.stdout.on('data', d => { portalStdout += d.toString(); });
portal.stderr.on('data', d => { portalStderr += d.toString(); });
const base = `http://127.0.0.1:${portalPort}`;

// Rewrite proxy between the managed CLI and the portal. The portal always
// projects a canonical descriptionBindingLock; the proxy lets the tests inject
// malformed lock variants into the task-list response the CLI actually reads,
// while forwarding every other request untouched.
const lockInjection = {mode: 'passthrough', lock: null};
const lockProxyPort = await getFreePort();
const lockProxyBase = `http://127.0.0.1:${lockProxyPort}`;
const lockProxy = http.createServer((proxyReq, proxyRes) => {
  const chunks = [];
  proxyReq.on('data', chunk => chunks.push(chunk));
  proxyReq.on('end', async () => {
    const body = Buffer.concat(chunks);
    const outgoingHeaders = {...proxyReq.headers};
    delete outgoingHeaders.host;
    delete outgoingHeaders.connection;
    delete outgoingHeaders['content-length'];
    delete outgoingHeaders['transfer-encoding'];
    delete outgoingHeaders['content-encoding'];
    let forwarded;
    try {
      forwarded = await fetch(`${base}${proxyReq.url}`, {
        method: proxyReq.method,
        headers: outgoingHeaders,
        body: body.length ? body : undefined,
        redirect: 'manual',
      });
    } catch (error) {
      proxyRes.writeHead(502, {'Content-Type': 'text/plain'});
      proxyRes.end(`lock proxy upstream error: ${String(error?.message || error)}`);
      return;
    }
    const raw = Buffer.from(await forwarded.arrayBuffer());
    let rewritten = null;
    if (forwarded.status === 200 && proxyReq.method === 'GET'
      && String(proxyReq.url || '').startsWith('/api/link-ops-tasks')
      && lockInjection.mode !== 'passthrough') {
      try {
        const payload = JSON.parse(raw.toString('utf8'));
        for (const task of asArray(payload?.data?.tasks)) {
          const binding = task?.descriptionMaterialBinding && typeof task.descriptionMaterialBinding === 'object'
            ? task.descriptionMaterialBinding
            : null;
          if (!binding) continue;
          const baseRev = Number(binding.baseTaskRevision || 0);
          const liveRev = Number(task?.repositoryRevision || 0);
          const lock = typeof lockInjection.lock === 'function'
            ? lockInjection.lock({base: baseRev, live: liveRev, binding, task})
            : lockInjection.lock;
          if (lock === null) delete task.descriptionBindingLock;
          else task.descriptionBindingLock = lock;
        }
        rewritten = Buffer.from(JSON.stringify(payload));
      } catch {}
    }
    const responseHeaders = {...forwarded.headers};
    delete responseHeaders['content-encoding'];
    delete responseHeaders['transfer-encoding'];
    delete responseHeaders['content-length'];
    delete responseHeaders.connection;
    proxyRes.writeHead(forwarded.status, responseHeaders);
    proxyRes.end(rewritten || raw);
  });
});

async function req(pathname, {method = 'GET', cookie = '', body = undefined} = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(body !== undefined ? {'Content-Type': 'application/json'} : {}),
      ...(cookie ? {Cookie: cookie} : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return {status: res.status, headers: res.headers, text, json};
}
async function runCli(cliArgs, {baseUrl = base} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      'scripts/bi_ops_cli.mjs',
      '--base-url', baseUrl,
      '--session-file', path.join(tmpRoot, 'cli-session.json'),
      '--knowledge-cache-dir', path.join(tmpRoot, 'knowledge-cache'),
      ...cliArgs,
    ], {
      cwd: ROOT,
      env: {...process.env, NODE_ENV: 'test'},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI timeout: ${cliArgs[0] || ''}`));
    }, 30_000);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timer);
      let json = null;
      try { json = stdout.trim() ? JSON.parse(stdout) : null; } catch {}
      resolve({code, stdout, stderr, json});
    });
  });
}
async function waitReady() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const r = await req('/api/health');
      if (r.status === 200) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`portal not ready\nstdout=${portalStdout}\nstderr=${portalStderr}`);
}
async function login(username, password) {
  const r = await req('/api/login', {method: 'POST', body: {username, password}});
  const setCookie = r.headers.get('set-cookie') || '';
  const cookie = (setCookie.match(/bi_session=[^;]+/) || [''])[0];
  if (r.status !== 200 || !cookie) throw new Error(`login failed: status=${r.status}`);
  return cookie;
}
async function rawTaskById(id) {
  const data = JSON.parse(await fs.readFile(taskFile, 'utf8').catch(() => '{"tasks":[]}'));
  return asArray(data?.tasks).find(task => String(task?.id || '') === String(id || '')) || null;
}
async function bindDescriptions(cookie, taskId, {
  materialJson = material,
  sourceFileBytes = sourceBytes,
  sourceFileName = 'SK-11004-review.html',
  expectedRevision = null,
  includeSourceFile = true,
  section = 'auto',
} = {}) {
  const task = await rawTaskById(taskId);
  const revision = expectedRevision ?? Number(task?.repositoryRevision || 0);
  return req('/api/link-ops-prepare-descriptions', {
    method: 'POST',
    cookie,
    body: {
      taskId,
      store: 'NM',
      sourceApproved: true,
      materialJson,
      section,
      ...(includeSourceFile ? {sourceFile: {name: sourceFileName, dataBase64: Buffer.from(sourceFileBytes).toString('base64')}} : {}),
      expectedRevision: revision,
    },
  });
}
async function attachPayload(taskId, payload) {
  const data = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  const tasks = asArray(data.tasks);
  const index = tasks.findIndex(task => String(task?.id || '') === String(taskId || ''));
  if (index < 0) throw new Error(`task not found for attach: ${taskId}`);
  const task = tasks[index];
  const supplierCode = String(payload?.skc_list?.[0]?.supplier_code || '');
  tasks[index] = {
    ...task,
    note: 'NM 待绑定描述',
    openapiPublishPayload: JSON.parse(JSON.stringify(payload)),
    publishAssetBinding: validPublishAssetBindingFixture(task, supplierCode),
  };
  await fs.writeFile(taskFile, JSON.stringify({...data, tasks}, null, 2), 'utf8');
}
async function updateRawTaskById(taskId, update) {
  const data = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  const tasks = asArray(data.tasks);
  const index = tasks.findIndex(task => String(task?.id || '') === String(taskId || ''));
  if (index < 0) throw new Error(`task not found for update: ${taskId}`);
  tasks[index] = update(tasks[index]);
  await fs.writeFile(taskFile, JSON.stringify({...data, tasks}, null, 2), 'utf8');
  return tasks[index];
}
async function createTask(cookie, supplierCode) {
  const r = await req('/api/link-ops-tasks', {
    method: 'POST',
    cookie,
    body: {
      command: `复制上品/补链接 SM-11004 到 NM（描述绑定验收 ${supplierCode}）`,
      source: 'codex_desktop_cli_structured',
      intents: ['copy_product_draft'],
      targets: {
        stores: ['NM'],
        writeStores: ['NM'],
        standardGoodsSn: 'SM-11004',
        ...(SOURCE_LOCKED_CODES.has(supplierCode)
          ? {sourceStores: [SOURCE_STORE], sourceSkc: sourceSkcFor(supplierCode)}
          : {}),
        productRefs: [supplierCode],
      },
    },
  });
  if (r.status !== 200) throw new Error(`create task failed: ${r.status} ${r.text}`);
  const taskId = r.json?.task?.id || r.json?.data?.tasks?.[0]?.id || '';
  await updateRawTaskById(taskId, task => ({
    ...task,
    standardGoodsSn: supplierCode,
    targets: {...(task.targets || {}), standardGoodsSn: supplierCode, productRefs: [supplierCode]},
  }));
  return taskId;
}

let cleanupOnExit = false;
try {
  await waitReady();
  const cookie = await login('owner_desc_bind', 'owner-pass');

  // --- gateway updateTaskRecord atomic CAS unit check ---
  const gateway = createConfiguredLinkOpsStoreGateway({
    env: {...process.env, SHEIN_LINK_OPS_STORE: 'json'},
    rootDir: tmpRoot,
    taskFile: path.join(tmpRoot, 'cas-tasks.json'),
    sessionFile: path.join(tmpRoot, 'cas-chats.json'),
    actionFile: path.join(tmpRoot, 'cas-actions.json'),
    runtimeFile: path.join(tmpRoot, 'cas-runtime.json'),
  });
  const created = await gateway.repository.createTask({
    id: 'cas-task-1',
    status: 'draft',
    intents: ['copy_product_draft'],
    targets: {stores: ['NM'], writeStores: ['NM']},
  }, {ownerUser: 'owner_desc_bind', actorUser: 'owner_desc_bind'});
  let casConflict = false;
  try {
    await gateway.updateTaskRecord('cas-task-1', {...created, status: 'confirmed'}, {expectedRevision: 99, actorUser: 'owner_desc_bind'});
  } catch (error) {
    casConflict = error?.code === 'LINK_OPS_REVISION_CONFLICT';
  }
  check('gateway updateTaskRecord stale revision -> LINK_OPS_REVISION_CONFLICT', casConflict, true);
  const casUpdated = await gateway.updateTaskRecord('cas-task-1', {...created, status: 'confirmed'}, {expectedRevision: created.repositoryRevision, actorUser: 'owner_desc_bind'});
  check('gateway updateTaskRecord correct revision succeeds', casUpdated.repositoryRevision, created.repositoryRevision + 1);
  const concurrentCreated = await gateway.repository.createTask({
    id: 'cas-task-2',
    status: 'draft',
    intents: ['copy_product_draft'],
    targets: {stores: ['NM'], writeStores: ['NM']},
  }, {ownerUser: 'owner_desc_bind', actorUser: 'owner_desc_bind'});
  const concurrentWrites = await Promise.allSettled([
    gateway.updateTaskRecord('cas-task-2', {...concurrentCreated, note: 'writer-a'}, {expectedRevision: concurrentCreated.repositoryRevision, actorUser: 'owner_desc_bind'}),
    gateway.updateTaskRecord('cas-task-2', {...concurrentCreated, note: 'writer-b'}, {expectedRevision: concurrentCreated.repositoryRevision, actorUser: 'owner_desc_bind'}),
  ]);
  check('gateway concurrent CAS has exactly one winner', concurrentWrites.filter(result => result.status === 'fulfilled').length, 1);
  check('gateway concurrent CAS has exactly one conflict', concurrentWrites.filter(result => result.status === 'rejected' && result.reason?.code === 'LINK_OPS_REVISION_CONFLICT').length, 1);
  await gateway.close();

  // Two different reviewed sources racing on the same task/revision: exactly
  // one CAS may commit, the loser must get 409, and no mixed binding is valid.
  const concurrentTaskId = await createTask(cookie, 'DESC-CONCURRENT');
  await attachPayload(concurrentTaskId, publishPayloadFor('DESC-CONCURRENT'));
  const concurrentBaseRevision = Number((await rawTaskById(concurrentTaskId))?.repositoryRevision || 0);
  const [concurrentA, concurrentB] = await Promise.all([
    bindDescriptions(cookie, concurrentTaskId, {expectedRevision: concurrentBaseRevision}),
    bindDescriptions(cookie, concurrentTaskId, {
      materialJson: alternateMaterial,
      sourceFileBytes: alternateSourceBytes,
      sourceFileName: 'SK-11004-review-alternate.html',
      expectedRevision: concurrentBaseRevision,
    }),
  ]);
  check('concurrent different bindings produce one success', [concurrentA.status, concurrentB.status].filter(status => status === 200).length, 1);
  check('concurrent different bindings produce one CAS conflict', [concurrentA.status, concurrentB.status].filter(status => status === 409).length, 1);
  const concurrentRaw = await rawTaskById(concurrentTaskId);
  check('concurrent binding increments revision exactly once', concurrentRaw?.repositoryRevision, concurrentBaseRevision + 1);
  const winnerContentSha = concurrentA.status === 200 ? materialSummary.contentSha256 : alternateMaterialSummary.contentSha256;
  const winnerEnSha = concurrentA.status === 200 ? materialSummary.hashes.en : alternateMaterialSummary.hashes.en;
  check('concurrent binding keeps one complete content hash', concurrentRaw?.descriptionMaterialBinding?.contentSha256, winnerContentSha);
  check('concurrent binding keeps matching winner English hash', concurrentRaw?.descriptionMaterialBinding?.hashes?.en, winnerEnSha);

  // --- task 1: exact readback ---
  const taskId1 = await createTask(cookie, 'DESC-MATCH');
  await attachPayload(taskId1, publishPayloadFor('DESC-MATCH'));
  const rawBeforeBind = await rawTaskById(taskId1);
  const payloadHashBefore = linkOpsPayloadHash(rawBeforeBind.openapiPublishPayload);
  const imageFingerprintBefore = JSON.stringify(rawBeforeBind.openapiPublishPayload.skc_list.map(skc => skc.image_info));

  // pre-binding dry-run must be blocked by the missing-description gate
  const preBind = await req('/api/link-ops-execute', {method: 'POST', cookie, body: {id: taskId1, mode: 'dry-run', source: 'test'}});
  check('pre-bind dry-run blocked', preBind.json?.task?.execution?.state, 'blocked');
  check('pre-bind blocker mentions missing description', JSON.stringify(preBind.json?.task?.execution?.preflight?.blockers || []), text => text.includes('multi_language_desc_list'));

  // A self-consistent material/hash declaration without the actual reviewed
  // HTML bytes is never accepted by the server.
  const selfDeclaredOnly = await bindDescriptions(cookie, taskId1, {includeSourceFile: false});
  check('self-declared material without actual source bytes rejected', selfDeclaredOnly.status, 400);

  // Bind descriptions with actual HTML bytes and an exact CAS revision.
  const bind = await bindDescriptions(cookie, taskId1);
  check('bind status 200', bind.status, 200);
  check('bind committed and independently read back', bind.json?.bindingCommitted === true && bind.json?.readbackVerified === true, true);
  check('bind audit completed', bind.json?.auditPending, false);
  check('bind newPayloadHash present', String(bind.json?.binding?.newPayloadHash || '').length, 64);

  const rawAfterBind = await rawTaskById(taskId1);
  const boundPayload = rawAfterBind.openapiPublishPayload;
  check('bind stores fixed ar/en rows', boundPayload.multi_language_desc_list.map(row => row.language).join(','), 'ar,en');
  check('bind ar name joins 5 lines', boundPayload.multi_language_desc_list[0].name, arLines.join('\n'));
  check('bind en name joins 5 lines', boundPayload.multi_language_desc_list[1].name, enLines.join('\n'));
  check('bind newPayloadHash equals stored payload hash', bind.json?.binding?.newPayloadHash, linkOpsPayloadHash(boundPayload));
  const stripped = JSON.parse(JSON.stringify(boundPayload));
  delete stripped.multi_language_desc_list;
  check('bind changes only multi_language_desc_list', linkOpsPayloadHash(stripped), payloadHashBefore);
  check('bind keeps image structure identical', JSON.stringify(boundPayload.skc_list.map(skc => skc.image_info)), imageFingerprintBefore);
  check('bind keeps image binding fingerprint', String(rawAfterBind.publishAssetBinding?.bindingFingerprint || ''), String(rawBeforeBind.publishAssetBinding?.bindingFingerprint || ''));
  check('bind resets execution state', rawAfterBind.execution?.state, 'needs_repreflight');
  check('bind clears product executors', asArray(rawAfterBind.execution?.openApiProductExecutors).length, 0);
  check('bind resets top-level preflight', rawAfterBind.preflight?.ok, false);
  check('bind resets lifecycle status', rawAfterBind.lifecycle?.lifecycleStatus, 'needs_repreflight');
  check('bind resets writeAudit submitted flag', rawAfterBind.execution?.writeAudit?.submitted, false);
  check('bind resets writeAudit executeAllowed flag', rawAfterBind.execution?.writeAudit?.executeAllowed, false);
  check('bind resets execution actualWriteSubmitted', rawAfterBind.execution?.actualWriteSubmitted, false);
  check('bind appends reset to existing note without replacing context', String(rawAfterBind.note || ''), text => text.includes('缺 multi_language_desc_list') && text.includes('描述已绑定'));
  check('bind records descriptionMaterialBinding hashes', rawAfterBind.descriptionMaterialBinding?.hashes?.en, materialSummary.hashes.en);

  // audit entries must carry hashes only
  const auditText = await fs.readFile(auditFile, 'utf8');
  const boundAudit = auditText.split('\n').filter(line => line.includes('link-ops-prepare-descriptions-bound') && line.includes(taskId1));
  check('audit has bound entry', boundAudit.length, 1);
  check('audit never stores full description text', boundAudit.join(''), text => !text.includes('selling point') && !text.includes('سطر') && !text.includes('中文卖点'));

  // stale expectedRevision -> 409 CAS conflict
  const staleBind = await bindDescriptions(cookie, taskId1, {expectedRevision: 1});
  check('stale expectedRevision -> 409', staleBind.status, 409);
  check('stale expectedRevision code', staleBind.json?.code, 'LINK_OPS_REVISION_CONFLICT');

  // fresh dry-run makes the task ready again and locks the new payload hash
  const postBind = await req('/api/link-ops-execute', {method: 'POST', cookie, body: {id: taskId1, mode: 'dry-run', source: 'test'}});
  const postExec = postBind.json?.task?.execution || {};
  check('post-bind dry-run becomes ready', postExec.state, 'openapi_product_preflight_ready');
  check('post-bind dry-run ok', postExec.preflight?.ok, true);
  const postRun = postExec.openApiProductExecutors?.[0] || {};
  const executorSummary = postRun.payload?.summary || {};
  check('dry-run summary descriptionCount', executorSummary.descriptionCount, 2);
  check('dry-run summary descriptionLanguages', (executorSummary.descriptionLanguages || []).join(','), 'ar,en');
  check('dry-run summary descriptionHashes match material', executorSummary.descriptionHashes?.en, materialSummary.hashes.en);
  check('dry-run binding lock enabled', executorSummary.descriptionBindingLocked, true);
  const newDryRunHash = postRun.payload?.payloadHash || '';
  check('dry-run locks new payload hash', newDryRunHash.length, 64);
  // The fresh dry-run must converge top-level preflight with execution
  // preflight in the same persisted record, not keep the binding invalidation.
  const rawAfterFreshDryRun = await rawTaskById(taskId1);
  check('post-bind dry-run top-level preflight ok', rawAfterFreshDryRun.preflight?.ok, true);
  check('post-bind dry-run top-level blockers empty', asArray(rawAfterFreshDryRun.preflight?.blockers).length, 0);
  check('post-bind dry-run top-level ok matches execution', rawAfterFreshDryRun.preflight?.ok, rawAfterFreshDryRun.execution?.preflight?.ok);
  check('post-bind dry-run top-level blockers equal execution blockers', JSON.stringify(asArray(rawAfterFreshDryRun.preflight?.blockers).sort()), JSON.stringify(asArray(rawAfterFreshDryRun.execution?.preflight?.blockers).sort()));
  check('post-bind dry-run top-level warnings equal execution warnings', JSON.stringify(asArray(rawAfterFreshDryRun.preflight?.warnings).sort()), JSON.stringify(asArray(rawAfterFreshDryRun.execution?.preflight?.warnings).sort()));
  check('post-bind dry-run drops stale binding invalidation', JSON.stringify(asArray(rawAfterFreshDryRun.preflight?.blockers)), text => !text.includes('需要基于新 payload 重新预演'));
  check('post-bind dry-run projected preflight ok', postBind.json?.task?.preflight?.ok, true);
  check('post-bind dry-run projected preflight equals execution', JSON.stringify(postBind.json?.task?.preflight || null), JSON.stringify(postBind.json?.task?.execution?.preflight || null));

  // Real local check -> missing supply-price preparation -> same-task reuse.
  // The platform and Portal below are isolated fixtures, never production.
  const pureCheckId = await createTask(cookie, 'DESC-PURE-CHECK-REUSE');
  await attachPayload(pureCheckId, publishPayloadFor('DESC-PURE-CHECK-REUSE'));
  await updateRawTaskById(pureCheckId, task => {
    const preparation = {...task.publishAssetBinding.publishPreparation};
    delete preparation.supplyPrice;
    const binding = {...task.publishAssetBinding, publishPreparation: preparation};
    binding.evidence = {...binding.evidence, payloadHash: canonicalRecoveredPublishPayloadHash(task.openapiPublishPayload)};
    binding.bindingFingerprint = portalHooks.canonicalPublishAssetBindingFingerprint(task, {binding, publishPreparation: preparation});
    return {...task, publishPreparation: preparation, targets: {...task.targets, publishPreparation: preparation}, publishAssetBinding: binding};
  });
  check('pure check initial description bind', (await bindDescriptions(cookie, pureCheckId)).status, 200);
  await updateRawTaskById(pureCheckId, task => ({...task, publishAssetBinding: {
    ...task.publishAssetBinding,
    evidence: {...task.publishAssetBinding.evidence, payloadHash: canonicalRecoveredPublishPayloadHash(task.openapiPublishPayload)},
  }}));
  const pureCheck = await req('/api/link-ops-execute', {method: 'POST', cookie, body: {id: pureCheckId, mode: 'check', source: 'test'}});
  check('pure check HTTP 200', pureCheck.status, 200);
  const pureCheckRaw = await rawTaskById(pureCheckId);
  check('pure check missing supplyPrice lock reproduced', JSON.stringify(pureCheckRaw.execution?.preflight?.blockers), text => text.includes('supplyPrice') && text.includes('structured preparation lock'));
  check('pure check executor record exists', asArray(pureCheckRaw.execution?.openApiProductExecutors).length > 0, true);
  for (const field of ['actualWriteSubmitted', 'issuedExecuteToExecutor', 'sheinWriteAttempted']) {
    check(`pure check ${field} false`, pureCheckRaw.execution?.writeAudit?.[field], false);
  }
  check('pure check history is neutral', portalHooks.descriptionBindingExplicitPreValidRejectionEvidence(pureCheckRaw).neutral, true);
  const pureReuse = await req('/api/link-ops-publish-assets', {method: 'POST', cookie, body: {
    taskId: pureCheckId, store: 'NM', reuseApprovedBinding: true, sourceApproved: true, supplyPrice: 90, inventory: 100,
  }});
  check('pure check same-task reuse HTTP 200', pureReuse.status, 200);
  const pureReusedRaw = await rawTaskById(pureCheckId);
  check('pure check same-task identity preserved', pureReusedRaw.id, pureCheckId);
  check('pure check reuse increments revision once', pureReusedRaw.repositoryRevision, pureCheckRaw.repositoryRevision + 1);
  check('pure check reuse locks supply price', pureReusedRaw.publishPreparation?.supplyPrice, 90);
  check('pure check reuse locks inventory', pureReusedRaw.publishPreparation?.inventory, 100);
  const imageContent = task => asArray(task.publishAssetBinding?.images).map(({relativePath, ...image}) => image);
  const titleContent = task => asArray(task.openapiPublishPayload?.multi_language_name_list).map(row => ({language: row.language, name: row.name || row.product_name}));
  check('pure check reuse preserves approved images', JSON.stringify(imageContent(pureReusedRaw)), JSON.stringify(imageContent(pureCheckRaw)));
  check('pure check reuse preserves approved titles', JSON.stringify(titleContent(pureReusedRaw)), JSON.stringify(titleContent(pureCheckRaw)));
  check('pure check reuse invalidates preflight', pureReusedRaw.execution?.state, 'needs_repreflight');

  // Blocked case: tampering only the bound ar description bytes must block
  // the next fresh dry-run, and the persisted top-level preflight must again
  // converge exactly with the execution preflight blockers.
  const blockedTaskId = await createTask(cookie, 'DESC-POST-BIND-BLOCKED');
  await attachPayload(blockedTaskId, publishPayloadFor('DESC-POST-BIND-BLOCKED'));
  const blockedBind = await bindDescriptions(cookie, blockedTaskId);
  check('blocked-case bind status 200', blockedBind.status, 200);
  const blockedRawAfterBind = await rawTaskById(blockedTaskId);
  check('blocked-case bind invalidates top-level preflight', blockedRawAfterBind.preflight?.ok, false);
  check('blocked-case bind invalidates execution preflight', blockedRawAfterBind.execution?.preflight?.ok, false);
  check('blocked-case bind resets execution state', blockedRawAfterBind.execution?.state, 'needs_repreflight');
  await updateRawTaskById(blockedTaskId, task => {
    const payload = JSON.parse(JSON.stringify(task.openapiPublishPayload));
    payload.multi_language_desc_list = asArray(payload.multi_language_desc_list).map(row => (
      row?.language === 'ar'
        ? {...row, name: [...arLines.slice(0, 4), 'سطر عربي معدل لاختبار تغيير الربط'].join('\n')}
        : row
    ));
    return {...task, openapiPublishPayload: payload};
  });
  const blockedDryRun = await req('/api/link-ops-execute', {method: 'POST', cookie, body: {id: blockedTaskId, mode: 'dry-run', source: 'test'}});
  check('tampered post-bind dry-run responds ok', blockedDryRun.status, 200);
  const blockedRaw = await rawTaskById(blockedTaskId);
  check('tampered post-bind dry-run stays blocked', blockedRaw.execution?.state, 'blocked');
  check('tampered post-bind top-level preflight ok false', blockedRaw.preflight?.ok, false);
  check('tampered post-bind top-level ok matches execution', blockedRaw.preflight?.ok, blockedRaw.execution?.preflight?.ok);
  check('tampered post-bind top-level blockers equal execution blockers', JSON.stringify(asArray(blockedRaw.preflight?.blockers).sort()), JSON.stringify(asArray(blockedRaw.execution?.preflight?.blockers).sort()));
  check('tampered post-bind top-level warnings equal execution warnings', JSON.stringify(asArray(blockedRaw.preflight?.warnings).sort()), JSON.stringify(asArray(blockedRaw.execution?.preflight?.warnings).sort()));
  check('tampered post-bind drops stale binding invalidation', JSON.stringify(asArray(blockedRaw.preflight?.blockers)), text => !text.includes('需要基于新 payload 重新预演'));
  check('tampered post-bind carries description lock blocker', JSON.stringify(asArray(blockedRaw.preflight?.blockers)), text => (
    text.includes('hash 与审核资料绑定不一致')
      || text.includes('destination descriptions without a valid descriptionMaterialBinding lock')
  ));
  check('tampered post-bind projected preflight equals execution', JSON.stringify(blockedDryRun.json?.task?.preflight || null), JSON.stringify(blockedDryRun.json?.task?.execution?.preflight || null));

  // execute success requires code=0 AND explicit info.success===true
  const execute = await req('/api/link-ops-execute', {
    method: 'POST',
    cookie,
    body: {id: taskId1, mode: 'execute', confirm: CONFIRM_TEXT, source: 'test'},
  });
  check('execute response status 200', execute.status, 200);
  check('execute confirmed top-level remains ok', execute.json?.ok, true);
  check('execute response is a bounded single-task projection',
    execute.json?.data?.partial === true && execute.json?.data?.tasks?.length === 1, true);
  check('execute lifecycle submitted_readback_matched', execute.json?.task?.lifecycle?.lifecycleStatus, 'submitted_readback_matched');
  check('execute status done', execute.json?.task?.status, 'done');
  const executorRun = execute.json?.task?.execution?.openApiProductExecutors?.[0] || {};
  check('execute readback ok', executorRun.readback?.ok, true);
  check('execute readback description matched', executorRun.readback?.descriptionReadback?.status, 'description_readback_matched');
  check('execute readback projection carries hashes only', JSON.stringify(executorRun.readback?.descriptionReadback?.summary || {}), text => !text.includes('selling point') && !text.includes('سطر'));

  // A repository adapter can throw after its atomic write (for example a
  // transient Windows lock-file release error), and the external JSONL audit
  // can fail after that. The route must recover only from the exact persisted
  // revision+payload hash and return a committed/audit-pending stage; a caller
  // must never see a generic retryable 500 after a real SHEIN submission.
  const taskIdPostCommit = await createTask(cookie, 'DESC-POST-COMMIT');
  await attachPayload(taskIdPostCommit, publishPayloadFor('DESC-POST-COMMIT'));
  const postCommitBind = await bindDescriptions(cookie, taskIdPostCommit);
  check('post-commit recovery fixture binds', postCommitBind.status, 200);
  await req('/api/link-ops-execute', {method: 'POST', cookie, body: {id: taskIdPostCommit, mode: 'dry-run', source: 'test'}});
  await Promise.all([
    fs.writeFile(executionPostCommitFailureMarker, 'fail-after-commit', 'utf8'),
    fs.writeFile(executionAuditFailureMarker, 'fail-external-audit', 'utf8'),
  ]);
  let executePostCommit;
  try {
    executePostCommit = await req('/api/link-ops-execute', {
      method: 'POST',
      cookie,
      body: {id: taskIdPostCommit, mode: 'execute', confirm: CONFIRM_TEXT, source: 'test'},
    });
  } finally {
    await Promise.all([
      fs.rm(executionPostCommitFailureMarker, {force: true}),
      fs.rm(executionAuditFailureMarker, {force: true}),
    ]);
  }
  check('post-commit adapter error returns HTTP 200 exact recovery', executePostCommit.status, 200);
  check('post-commit adapter error is classified as recovered', executePostCommit.json?.commitRecovered, true);
  check('post-commit external audit error is explicit', executePostCommit.json?.auditPending, true);
  check('post-commit audit warning states persistence without overstating readback', executePostCommit.json?.warning,
    '执行结果已持久化，但外部审计暂待补写；请勿重复提交。');
  check('post-commit audit warning does not claim exact readback', executePostCommit.json?.warning,
    text => !text.includes('精确回读'));
  check('post-commit response blocks blind retry with exact stage', executePostCommit.json?.stage, 'execution_committed_audit_pending');
  check('post-commit response returns the persisted terminal task',
    executePostCommit.json?.task?.lifecycle?.lifecycleStatus, 'submitted_readback_matched');
  const postCommitPersisted = await rawTaskById(taskIdPostCommit);
  check('post-commit recovery persisted one terminal write',
    postCommitPersisted?.execution?.writeAudit?.actualWriteSubmitted, true);
  const postCommitRetry = await req('/api/link-ops-execute', {
    method: 'POST', cookie,
    body: {id: taskIdPostCommit, mode: 'execute', confirm: CONFIRM_TEXT, source: 'test-retry-must-block'},
  });
  check('post-commit lifecycle blocks a duplicate retry', postCommitRetry.status, 409);

  // code=0 without explicit success flag is not success
  publishSuccessMode.mode = 'no_success_flag';
  const taskId2 = await createTask(cookie, 'DESC-NO-SUCCESS');
  await attachPayload(taskId2, publishPayloadFor('DESC-NO-SUCCESS'));
  const bind2 = await bindDescriptions(cookie, taskId2);
  check('bind2 status 200', bind2.status, 200);
  await req('/api/link-ops-execute', {method: 'POST', cookie, body: {id: taskId2, mode: 'dry-run', source: 'test'}});
  const executeNoSuccess = await req('/api/link-ops-execute', {
    method: 'POST',
    cookie,
    body: {id: taskId2, mode: 'execute', confirm: CONFIRM_TEXT, source: 'test'},
  });
  check('code=0 without explicit success is not success', executeNoSuccess.json?.task?.execution?.writeAudit?.actualWriteSubmitted, false);
  check('code=0 without explicit success blocks', String(executeNoSuccess.json?.task?.execution?.state || ''), text => /blocked|publish_pre_valid/.test(text));

  // live description drift -> submitted but never submitted_readback_matched
  publishSuccessMode.mode = 'explicit_true';
  descReadbackMode.mode = 'drift';
  const taskId3 = await createTask(cookie, 'DESC-DRIFT');
  await attachPayload(taskId3, publishPayloadFor('DESC-DRIFT'));
  const bind3 = await bindDescriptions(cookie, taskId3);
  check('bind3 status 200', bind3.status, 200);
  await req('/api/link-ops-execute', {method: 'POST', cookie, body: {id: taskId3, mode: 'dry-run', source: 'test'}});
  const executeDrift = await req('/api/link-ops-execute', {
    method: 'POST',
    cookie,
    body: {id: taskId3, mode: 'execute', confirm: CONFIRM_TEXT, source: 'test'},
  });
  const driftLifecycle = executeDrift.json?.task?.lifecycle?.lifecycleStatus || '';
  check('drift response keeps HTTP 200 for committed result', executeDrift.status, 200);
  check('drift response preserves committed true', executeDrift.json?.committed, true);
  check('drift response top-level ok is false', executeDrift.json?.ok, false);
  check('drift response is explicitly partial', executeDrift.json?.partial, true);
  check('drift response outcome is unconfirmed', executeDrift.json?.outcome, 'unconfirmed');
  check('drift readback never submitted_readback_matched', driftLifecycle, text => text !== 'submitted_readback_matched');
  check('drift readback classified as failed/needs manual resolve', driftLifecycle, 'submitted_readback_failed');
  const driftRun = executeDrift.json?.task?.execution?.openApiProductExecutors?.[0] || {};
  check('drift readback ok false', driftRun.readback?.ok, false);
  check('drift readback status mismatch', driftRun.readback?.status, 'description_readback_mismatch');

  // A strong searchProduct match without a unique SPU must not bypass the
  // exact spu-info description readback requirement.
  publishSuccessMode.mode = 'success_without_spu';
  descReadbackMode.mode = 'exact';
  const taskId4 = await createTask(cookie, 'DESC-FALLBACK');
  await attachPayload(taskId4, publishPayloadFor('DESC-FALLBACK'));
  const bind4 = await bindDescriptions(cookie, taskId4);
  check('bind4 status 200', bind4.status, 200);
  await req('/api/link-ops-execute', {method: 'POST', cookie, body: {id: taskId4, mode: 'dry-run', source: 'test'}});
  const executeFallback = await req('/api/link-ops-execute', {
    method: 'POST',
    cookie,
    body: {id: taskId4, mode: 'execute', confirm: CONFIRM_TEXT, source: 'test'},
  });
  check('fallback identity without SPU never matches terminal readback', executeFallback.json?.task?.lifecycle?.lifecycleStatus, 'submitted_readback_failed');
  const fallbackRun = executeFallback.json?.task?.execution?.openApiProductExecutors?.[0] || {};
  check('fallback identity without SPU readback is false', fallbackRun.readback?.ok, false);
  check('fallback identity without SPU is unverifiable', fallbackRun.readback?.status, 'description_readback_unverifiable');

  async function executeFallbackMatrixCase(supplierCode, routeMode, descriptionMode) {
    publishSuccessMode.mode = 'explicit_true';
    readbackRouteMode.mode = routeMode;
    descReadbackMode.mode = descriptionMode;
    const taskId = await createTask(cookie, supplierCode);
    await attachPayload(taskId, publishPayloadFor(supplierCode));
    const bound = await bindDescriptions(cookie, taskId);
    await req('/api/link-ops-execute', {method: 'POST', cookie, body: {id: taskId, mode: 'dry-run', source: 'test'}});
    const executed = await req('/api/link-ops-execute', {
      method: 'POST',
      cookie,
      body: {id: taskId, mode: 'execute', confirm: CONFIRM_TEXT, source: 'test'},
    });
    return {bound, executed, task: await rawTaskById(taskId)};
  }

  const searchExact = await executeFallbackMatrixCase('DESC-SEARCH-EXACT', 'search', 'exact');
  const searchExactRun = searchExact.task?.execution?.openApiProductExecutors?.[0] || {};
  check('searchProduct fallback exact binding succeeds', searchExact.bound.status, 200);
  check('searchProduct fallback exact reaches matched lifecycle', searchExact.task?.lifecycle?.lifecycleStatus, 'submitted_readback_matched');
  check('searchProduct fallback exact identity status', searchExactRun.readback?.status, 'matched_publish_identifier_in_search_product');
  check('searchProduct fallback exact description status', searchExactRun.readback?.descriptionReadback?.status, 'description_readback_matched');

  const searchDrift = await executeFallbackMatrixCase('DESC-SEARCH-DRIFT', 'search', 'drift');
  const searchDriftRun = searchDrift.task?.execution?.openApiProductExecutors?.[0] || {};
  check('searchProduct fallback drift fails lifecycle', searchDrift.task?.lifecycle?.lifecycleStatus, 'submitted_readback_failed');
  check('searchProduct fallback drift description mismatch', searchDriftRun.readback?.status, 'description_readback_mismatch');

  const productQueryExact = await executeFallbackMatrixCase('DESC-PRODUCT-EXACT', 'product_query', 'exact');
  const productQueryExactRun = productQueryExact.task?.execution?.openApiProductExecutors?.[0] || {};
  check('product/query fallback exact reaches matched lifecycle', productQueryExact.task?.lifecycle?.lifecycleStatus, 'submitted_readback_matched');
  check('product/query fallback exact identity status', productQueryExactRun.readback?.status, 'matched_strong_fingerprint_in_product_query');
  check('product/query fallback exact description status', productQueryExactRun.readback?.descriptionReadback?.status, 'description_readback_matched');

  const productQueryDrift = await executeFallbackMatrixCase('DESC-PRODUCT-DRIFT', 'product_query', 'drift');
  const productQueryDriftRun = productQueryDrift.task?.execution?.openApiProductExecutors?.[0] || {};
  check('product/query fallback drift fails lifecycle', productQueryDrift.task?.lifecycle?.lifecycleStatus, 'submitted_readback_failed');
  check('product/query fallback drift description mismatch', productQueryDriftRun.readback?.status, 'description_readback_mismatch');
  readbackRouteMode.mode = 'direct';
  descReadbackMode.mode = 'exact';

  const historyPayloadTaskId = await createTask(cookie, 'DESC-HISTORY-PAYLOAD');
  await updateRawTaskById(historyPayloadTaskId, task => ({
    ...task,
    history: [...asArray(task.history), {event: 'debug_snapshot', debug: {publishPayload: publishPayloadFor('DESC-HISTORY-PAYLOAD')}}],
  }));
  const historyPayloadBind = await bindDescriptions(cookie, historyPayloadTaskId);
  check('payload-like object hidden in task history is never materialized', historyPayloadBind.status, 409);
  check('history payload rejection leaves root payload absent', Boolean((await rawTaskById(historyPayloadTaskId))?.openapiPublishPayload), false);

  const unapprovedAssetTaskId = await createTask(cookie, 'DESC-UNAPPROVED-ASSET');
  const unapprovedAssetUpload = await req('/api/link-ops-assets', {
    method: 'POST',
    cookie,
    body: {
      taskId: unapprovedAssetTaskId,
      files: [{
        name: 'unapproved-publish-payload.json',
        type: 'application/json',
        dataBase64: Buffer.from(JSON.stringify({publishPayload: publishPayloadFor('DESC-UNAPPROVED-ASSET')}), 'utf8').toString('base64'),
      }],
    },
  });
  check('unapproved payload asset upload fixture succeeds', unapprovedAssetUpload.status, 200);
  const unapprovedAssetBind = await bindDescriptions(cookie, unapprovedAssetTaskId);
  check('unapproved JSON asset provenance blocks materialization', unapprovedAssetBind.status, 409);
  check('unapproved JSON asset receives no description binding', Boolean((await rawTaskById(unapprovedAssetTaskId))?.descriptionMaterialBinding), false);

  const tamperedAssetTaskId = await createTask(cookie, 'DESC-TAMPERED-ASSET');
  const tamperedAssetUpload = await req('/api/link-ops-assets', {
    method: 'POST',
    cookie,
    body: {
      taskId: tamperedAssetTaskId,
      files: [{
        name: 'reviewed-publish-payload.json',
        type: 'application/json',
        sourceApproved: true,
        approvalKind: 'human_reviewed_publish_payload',
        dataBase64: Buffer.from(JSON.stringify({publishPayload: publishPayloadFor('DESC-TAMPERED-ASSET')}), 'utf8').toString('base64'),
      }],
    },
  });
  check('approved payload asset upload fixture succeeds', tamperedAssetUpload.status, 200);
  const tamperedAssetRaw = await rawTaskById(tamperedAssetTaskId);
  const tamperedAsset = asArray(tamperedAssetRaw?.assets)[0];
  await fs.writeFile(
    path.resolve(ROOT, String(tamperedAsset?.storedRelativePath || '')),
    JSON.stringify({publishPayload: publishPayloadFor('DESC-TAMPERED-ASSET-CHANGED')}),
    'utf8',
  );
  const tamperedAssetBind = await bindDescriptions(cookie, tamperedAssetTaskId);
  check('approved JSON asset with post-upload byte drift is rejected', tamperedAssetBind.status, 409);
  check('tampered JSON asset receives no description binding', Boolean((await rawTaskById(tamperedAssetTaskId))?.descriptionMaterialBinding), false);

  const nestedDebugAssetTaskId = await createTask(cookie, 'DESC-NESTED-DEBUG-ASSET');
  const nestedDebugAssetUpload = await req('/api/link-ops-assets', {
    method: 'POST',
    cookie,
    body: {
      taskId: nestedDebugAssetTaskId,
      files: [{
        name: 'reviewed-debug-envelope.json',
        type: 'application/json',
        sourceApproved: true,
        approvalKind: 'human_reviewed_publish_payload',
        dataBase64: Buffer.from(JSON.stringify({
          debug: {publishPayload: publishPayloadFor('DESC-NESTED-DEBUG-ASSET')},
        }), 'utf8').toString('base64'),
      }],
    },
  });
  check('approved nested-debug asset upload fixture succeeds', nestedDebugAssetUpload.status, 200);
  const nestedDebugAssetBind = await bindDescriptions(cookie, nestedDebugAssetTaskId);
  check('approved asset nested debug payload is never promoted', nestedDebugAssetBind.status, 409);
  check('nested debug asset receives no description binding', Boolean((await rawTaskById(nestedDebugAssetTaskId))?.descriptionMaterialBinding), false);

  // A malformed historical task that already carries any write-attempt
  // evidence must fail closed; binding may not erase it or reopen submission.
  const priorWriteTaskId = await createTask(cookie, 'DESC-PRIOR-WRITE');
  await attachPayload(priorWriteTaskId, publishPayloadFor('DESC-PRIOR-WRITE'));
  await updateRawTaskById(priorWriteTaskId, task => ({
    ...task,
    status: 'waiting_review',
    lifecycle: null,
    execution: {
      ...(task.execution || {}),
      actualWriteSubmitted: true,
      writeAudit: {actualWriteSubmitted: true, sheinWriteAttempted: true},
    },
  }));
  const priorWriteBind = await bindDescriptions(cookie, priorWriteTaskId);
  check('prior write evidence blocks description binding', priorWriteBind.status, 409);
  const priorWriteAfter = await rawTaskById(priorWriteTaskId);
  check('prior write actualWriteSubmitted remains true', priorWriteAfter?.execution?.actualWriteSubmitted, true);
  check('prior write audit evidence remains true', priorWriteAfter?.execution?.writeAudit?.sheinWriteAttempted, true);
  check('prior write task receives no description binding', Boolean(priorWriteAfter?.descriptionMaterialBinding), false);

  const submittedStateTaskId = await createTask(cookie, 'DESC-SUBMITTED-STATE');
  await attachPayload(submittedStateTaskId, publishPayloadFor('DESC-SUBMITTED-STATE'));
  await updateRawTaskById(submittedStateTaskId, task => ({
    ...task,
    status: 'waiting_review',
    lifecycle: null,
    execution: {state: 'submitted', actualWriteSubmitted: false, writeAudit: {actualWriteSubmitted: false}},
  }));
  const submittedStateBind = await bindDescriptions(cookie, submittedStateTaskId);
  check('execution.state submitted blocks binding even when booleans are false', submittedStateBind.status, 409);
  check('submitted execution state is not reset', (await rawTaskById(submittedStateTaskId))?.execution?.state, 'submitted');

  const historyWriteTaskId = await createTask(cookie, 'DESC-HISTORY-WRITE');
  await attachPayload(historyWriteTaskId, publishPayloadFor('DESC-HISTORY-WRITE'));
  await updateRawTaskById(historyWriteTaskId, task => ({
    ...task,
    status: 'waiting_review',
    lifecycle: null,
    execution: {state: 'blocked', actualWriteSubmitted: false, writeAudit: {actualWriteSubmitted: false}},
    history: [...asArray(task.history), {event: 'legacy_write_boundary', writeAudit: {actualWriteSubmitted: true}}],
  }));
  const historyWriteBind = await bindDescriptions(cookie, historyWriteTaskId);
  check('history writeAudit evidence blocks binding', historyWriteBind.status, 409);
  check('history write evidence is preserved', asArray((await rawTaskById(historyWriteTaskId))?.history).some(entry => entry?.writeAudit?.actualWriteSubmitted === true), true);

  const auditHistoryTaskId = await createTask(cookie, 'DESC-AUDIT-HISTORY');
  await attachPayload(auditHistoryTaskId, publishPayloadFor('DESC-AUDIT-HISTORY'));
  await fs.appendFile(auditFile, `${JSON.stringify({
    at: new Date().toISOString(),
    type: 'link-ops-execute',
    task: {id: auditHistoryTaskId, writeAudit: {actualWriteSubmitted: true, sheinWriteAttempted: true}},
  })}\n`, 'utf8');
  const auditHistoryBind = await bindDescriptions(cookie, auditHistoryTaskId);
  check('append-only historical audit write evidence blocks binding', auditHistoryBind.status, 409);
  check('audit-history blocked task receives no description binding', Boolean((await rawTaskById(auditHistoryTaskId))?.descriptionMaterialBinding), false);

  // --- 6863 pre-validation rejection predicate: direct fail-closed unit
  // checks against the portal test hook (fast; the end-to-end rebind matrix
  // runs in test_bi_ops_copy_product_success_flow.mjs --prevalid-retry-rebind
  // and keeps this harness test inside the deterministic per-test timeout).
  // Every execute/write attempt must prove its OWN explicit success=false. ---
  const rejectedRun = (overrides = {}) => ({
    storeKey: 'NM',
    mode: 'execute',
    state: 'publish_pre_valid_failed',
    ok: false,
    runId: 'lho-prevalid-unit',
    submittedPossibly: false,
    suspiciousWriteAttempted: false,
    readback: {ok: false, status: 'planned_not_run', pendingReview: false, matchedCount: 0},
    publishResult: {
      httpStatus: 200,
      code: '0',
      msg: 'OK',
      traceId: 'trace-prevalid-unit',
      info: {success: false, taskNo: '', spu_name: '', version: '', skc_list: []},
    },
    openapiCalls: [{name: 'publishOrEdit', path: '/open-api/goods/product/publishOrEdit'}],
    ...overrides,
  });
  const projectRunForAudit = run => ({
    ...run,
    runId: undefined,
    childRunId: run.runId,
    publishResult: run.publishResult ? {
      httpStatus: run.publishResult.httpStatus,
      code: run.publishResult.code,
      msg: run.publishResult.msg,
      traceId: run.publishResult.traceId,
      hasInfo: run.publishResult.info !== undefined && run.publishResult.info !== null,
      explicitSuccess: run.publishResult.info && typeof run.publishResult.info === 'object' && Object.hasOwn(run.publishResult.info, 'success')
        ? (run.publishResult.info.success === true ? true : run.publishResult.info.success === false ? false : undefined)
        : undefined,
    } : null,
  });
  const predicateTask = (runs = [rejectedRun()], extra = {}) => ({
    id: 'unit-prevalid-task',
    status: 'waiting_review',
    intents: ['copy_product_draft'],
    lifecycle: {
      lifecycleStatus: 'publish_pre_valid_failed',
      status: 'publish_pre_valid_failed',
      locked: false,
      terminal: false,
      needsManualResolve: false,
      submitted: false,
      submittedPossibly: false,
    },
    execution: {
      state: runs[0]?.state || 'publish_pre_valid_failed',
      actualWriteSubmitted: false,
      issuedExecuteToExecutor: true,
      sheinWriteAttempted: true,
      openApiProductExecutors: runs.map(run => ({...run})),
      writeAudit: {
        finalState: runs[0]?.state || 'publish_pre_valid_failed',
        submitted: false,
        actualWriteSubmitted: false,
        issuedExecuteToExecutor: true,
        sheinWriteAttempted: true,
        submittedPossibly: false,
        suspiciousWriteAttempted: false,
        executorEvidence: runs.map(projectRunForAudit),
      },
    },
    executionHistory: runs.map(run => ({
      event: 'controlled_execution_run',
      finalState: run.state,
      lifecycleStatus: run.state,
      submitted: false,
      actualWriteSubmitted: false,
      issuedExecuteToExecutor: true,
      sheinWriteAttempted: true,
      lifecycleLocked: false,
      needsManualResolve: false,
      executorRuns: [{
        storeKey: run.storeKey,
        mode: run.mode,
        state: run.state,
        ok: run.ok,
        runId: run.runId,
        publishCode: String(run.publishResult?.code ?? ''),
        publishTraceId: run.publishResult?.traceId || '',
        publishResult: run.publishResult ? {
          code: String(run.publishResult.code ?? ''),
          explicitSuccess: run.publishResult.info && Object.hasOwn(run.publishResult.info, 'success')
            ? (run.publishResult.info.success === true ? true : run.publishResult.info.success === false ? false : undefined)
            : undefined,
        } : null,
        readbackStatus: run.readback?.status || '',
        readbackOk: Boolean(run.readback?.ok),
      }],
    })),
    ...extra,
  });
  check('unit: portal strict boolean accepts own false', portalHooks.strictOwnBooleanField({success: false}, 'success'), false);
  for (const [label, value] of [['null', null], ['zero', 0], ['string', 'false']]) {
    check(`unit: portal strict boolean keeps ${label} unknown`, portalHooks.strictOwnBooleanField({success: value}, 'success'), undefined);
  }
  check('unit: portal strict boolean rejects inherited false', portalHooks.strictOwnBooleanField(Object.create({success: false}), 'success'), undefined);
  check('unit: portal publish success requires own exact true', portalHooks.linkOpsPublishResultSucceeded({code: '0', info: {success: true}}), true);
  check('unit: portal publish identifiers cannot replace missing success', portalHooks.linkOpsPublishResultSucceeded({code: '0', submitted: true, info: {spu_name: 'v1', skc_list: [{skc_name: 's1'}]}}), false);
  check('unit: portal publish string success is unknown', portalHooks.linkOpsPublishResultSucceeded({code: '0', info: {success: 'true', spu_name: 'v1'}}), false);
  check('unit: portal publish inherited success is unknown', portalHooks.linkOpsPublishResultSucceeded({code: '0', info: Object.create({success: true})}), false);
  check('unit: portal prevalid marker alone is not rejection proof', portalHooks.linkOpsExecutorExplicitPreValidFailure({state: 'publish_pre_valid_failed', publishResult: {code: '0', info: {}}}), false);
  check('unit: portal prevalid rejection requires own exact false', portalHooks.linkOpsExecutorExplicitPreValidFailure({state: 'publish_pre_valid_failed', publishResult: {code: '0', info: {success: false}}}), true);
  check('unit: portal prevalid string false is unknown', portalHooks.linkOpsExecutorExplicitPreValidFailure({state: 'publish_pre_valid_failed', publishResult: {code: '0', info: {success: 'false'}}}), false);
  check('unit: product submitted requires strict publish success', portalHooks.linkOpsProductExecutorSubmitted({state: 'submitted', publishResult: {code: '0', info: {success: true}}}), true);
  check('unit: product submitted state cannot replace missing success', portalHooks.linkOpsProductExecutorSubmitted({state: 'submitted', publishResult: {code: '0', info: {}}}), false);
  check('unit: maintenance submitted requires strict adapter evidence', portalHooks.linkOpsMaintenanceExecutorSubmitted({state: 'submitted', adapterKind: 'link_maintenance_openapi_executor', adapterEvidence: {realSubmit: true, writeAttempted: true, recoveryRequired: false}, publishResult: {code: '0'}}), true);
  check('unit: maintenance submitted state alone is insufficient', portalHooks.linkOpsMaintenanceExecutorSubmitted({state: 'submitted', publishResult: {code: '0'}}), false);
  const unconfirmedNoBlockerOutcome = portalHooks.linkOpsExecutionResponseOutcome({
    preflight: {ok: true, blockers: []},
    execution: {
      preflight: {ok: true, blockers: []},
      writeClaim: {state: 'unconfirmed'},
      linkMaintenanceExecutors: [{
        ok: false,
        state: 'submitted',
        adapterEvidence: {realSubmit: true},
        readback: {ok: false, status: 'product_identity_only_not_mutation_proof'},
        blockers: [],
      }],
    },
    lifecycle: {lifecycleStatus: 'submitted_readback_failed', needsManualResolve: true},
  }, {requestedExecute: true});
  check('unit: committed executor false without blockers is not top-level success', unconfirmedNoBlockerOutcome.ok, false);
  check('unit: committed executor false without blockers is unconfirmed', unconfirmedNoBlockerOutcome.outcome, 'unconfirmed');
  check('unit: explicit pre-valid rejection task passes the predicate', portalHooks.descriptionBindingExplicitPreValidRejectionEvidence(predicateTask()).ok, true);
  // YJ rev10 PostgreSQL export (2026-09-06): five blocked dry-runs,
  // including two pre-executor failures with empty child ids. Preserve the
  // full/history/audit projection topology with synthetic ids and no material.
  const yjRuns = ['fixture-first', 'fixture-recovered', '', '', 'fixture-attribute-check'].map(runId => ({
    runId, mode: 'dry-run', state: 'blocked', publishResult: null,
    ...(runId ? {readback: {ok: false, status: 'planned_not_run', matchedCount: 0}} : {}),
  }));
  const yjAudit = run => ({
    submitted: false, actualWriteSubmitted: false, issuedExecuteToExecutor: false, sheinWriteAttempted: false,
    executorEvidence: [{...structuredClone(run), runId: undefined, childRunId: run.runId}],
    lifecycleTransition: {status: 'preflight_blocked', submitted: false},
  });
  const yjHistoryTask = {
    status: 'waiting_review',
    execution: {
      mode: 'openapi_product_executor', state: 'blocked',
      openApiProductExecutors: [structuredClone(yjRuns[4])],
      hlOpenApiExecutor: structuredClone(yjRuns[4]), writeAudit: yjAudit(yjRuns[4]),
    },
    history: yjRuns.map(run => ({event: 'executor_blocked', openApiProductExecutors: [structuredClone(run)], writeAudit: yjAudit(run)})),
    executionHistory: yjRuns.map(run => ({event: 'controlled_execution_run', submitted: false, actualWriteSubmitted: false, issuedExecuteToExecutor: false, sheinWriteAttempted: false, executorRuns: [structuredClone(run)]})),
    lifecycle: {status: 'preflight_blocked', submitted: false},
  };
  check('unit: YJ PostgreSQL five-run history is neutral', portalHooks.descriptionBindingExplicitPreValidRejectionEvidence(yjHistoryTask).neutral, true);
  const yjUnknownHistory = structuredClone(yjHistoryTask);
  yjUnknownHistory.executionHistory[2].executorRuns[0].mode = 'execute';
  check('unit: YJ empty-id historical execute remains denied', portalHooks.descriptionBindingExplicitPreValidRejectionEvidence(yjUnknownHistory).ok, false);
  const yjUnknownResult = structuredClone(yjHistoryTask);
  yjUnknownResult.history[0].writeAudit.executorEvidence[0].publishResult = {code: 0};
  check('unit: YJ historical unknown result remains denied', portalHooks.descriptionBindingExplicitPreValidRejectionEvidence(yjUnknownResult).ok, false);
  for (const mode of ['dry-run', 'check']) {
    const precheckRun = {mode, state: 'blocked', publishResult: null};
    const precheckTask = {
      execution: {openApiProductExecutors: [precheckRun], writeAudit: {requestedMode: mode, actualWriteSubmitted: false, issuedExecuteToExecutor: false, sheinWriteAttempted: false}},
      history: [{execution: {openApiProductExecutors: [{...precheckRun, runId: 'earlier-local-check'}]}}],
    };
    const evidence = portalHooks.descriptionBindingExplicitPreValidRejectionEvidence(precheckTask);
    check(`unit: ${mode} records with history are neutral`, evidence.ok && evidence.neutral === true && evidence.proof.length === 0, true);
    for (const [label, change] of [
      ['execute mode', {mode: 'execute'}],
      ['unknown mode', {mode: 'unknown'}],
      ['missing mode', {mode: ''}],
      ['unknown state', {state: 'unknown'}],
      ['unknown result', {publishResult: {code: 0}}],
      ['submitted', {actualWriteSubmitted: true}],
      ['issued execute', {issuedExecuteToExecutor: true}],
      ['attempted write', {sheinWriteAttempted: true}],
      ['publish call', {openapiCalls: [{name: 'publishOrEdit'}]}],
      ['publish ids', {readbackFingerprint: {publishSpuNames: ['fixture-spu']}}],
      ['pending readback', {readback: {status: 'pending'}}],
    ]) {
      const unsafe = structuredClone(precheckTask);
      Object.assign(unsafe.execution.openApiProductExecutors[0], change);
      check(`unit: ${mode} cannot hide ${label}`, portalHooks.descriptionBindingExplicitPreValidRejectionEvidence(unsafe).ok, false);
    }
    const aggregateWrite = structuredClone(precheckTask);
    aggregateWrite.execution.writeAudit.issuedExecuteToExecutor = true;
    check(`unit: ${mode} cannot explain aggregate execute flag`, portalHooks.descriptionBindingExplicitPreValidRejectionEvidence(aggregateWrite).ok, false);
    const locked = structuredClone(precheckTask);
    locked.lifecycle = {locked: true};
    check(`unit: ${mode} cannot bypass lifecycle lock`, portalHooks.descriptionBindingExplicitPreValidRejectionEvidence(locked).ok, false);
  }
  check('unit: explicitSuccess=false audit projection also passes', portalHooks.descriptionBindingExplicitPreValidRejectionEvidence(predicateTask([rejectedRun()], {})).ok, true);
  check('unit: code0/info{} is never explicit rejection even with pre-valid markers', portalHooks.descriptionBindingExplicitPreValidRejectionEvidence(predicateTask([rejectedRun({publishResult: {httpStatus: 200, code: '0', msg: 'OK', info: {}}})])).ok, false);
  const submittedRun = rejectedRun({runId: 'lho-submitted-unit', state: 'submitted', publishResult: {httpStatus: 200, code: '0', msg: 'OK', traceId: 't', info: {success: true, taskNo: 'PUB-1', spu_name: 'v1', version: '', skc_list: []}}});
  check('unit: mixed rejected-then-submitted history blocks', portalHooks.descriptionBindingExplicitPreValidRejectionEvidence(predicateTask([rejectedRun(), submittedRun])).ok, false);
  check('unit: mixed submitted-then-rejected history blocks', portalHooks.descriptionBindingExplicitPreValidRejectionEvidence(predicateTask([submittedRun, rejectedRun()])).ok, false);
  const timeoutRun = rejectedRun({runId: 'lho-timeout-unit', state: 'timed_out', publishResult: null});
  check('unit: separate timeout attempt blocks even with one rejection', portalHooks.descriptionBindingExplicitPreValidRejectionEvidence(predicateTask([rejectedRun(), timeoutRun])).ok, false);
  const uncertainRun = rejectedRun({runId: 'lho-uncertain-unit', state: 'uncertain_write', publishResult: null});
  check('unit: separate uncertain_write attempt blocks', portalHooks.descriptionBindingExplicitPreValidRejectionEvidence(predicateTask([rejectedRun(), uncertainRun])).ok, false);
  const identifierRun = rejectedRun({runId: 'lho-ident-unit', publishResult: {httpStatus: 200, code: '0', msg: 'OK', traceId: 't', info: {success: false, taskNo: 'PUB-IDENT-001', spu_name: '', version: '', skc_list: []}}});
  check('unit: identifier-bearing explicit-false run still blocks', portalHooks.descriptionBindingExplicitPreValidRejectionEvidence(predicateTask([identifierRun])).ok, false);
  const successTrueRun = rejectedRun({runId: 'lho-true-unit', publishResult: {httpStatus: 200, code: '0', msg: 'OK', traceId: 't', info: {success: true}}});
  check('unit: info.success=true submission response blocks', portalHooks.descriptionBindingExplicitPreValidRejectionEvidence(predicateTask([successTrueRun])).ok, false);
  const legacyProjectionRun = rejectedRun({runId: 'lho-legacy-unit', publishResult: {httpStatus: 200, code: '0', msg: 'OK', traceId: 't', hasInfo: true}});
  check('unit: legacy hasInfo-only projection blocks (no explicit false)', portalHooks.descriptionBindingExplicitPreValidRejectionEvidence(predicateTask([legacyProjectionRun])).ok, false);
  const missingResultRun = rejectedRun({runId: 'lho-missing-unit', state: 'blocked', publishResult: undefined, openapiCalls: undefined});
  check('unit: missing publish result blocks', portalHooks.descriptionBindingExplicitPreValidRejectionEvidence(predicateTask([missingResultRun])).ok, false);
  const errorRun = rejectedRun({runId: 'lho-error-unit', state: 'error', publishResult: null});
  check('unit: error attempt without explicit false blocks', portalHooks.descriptionBindingExplicitPreValidRejectionEvidence(predicateTask([rejectedRun(), errorRun])).ok, false);
  const timeoutFalseRun = rejectedRun({runId: 'lho-timeout-false-unit', state: 'timed_out'});
  check('unit: timeout attempt blocks even with explicit false', portalHooks.descriptionBindingExplicitPreValidRejectionEvidence(predicateTask([timeoutFalseRun])).ok, false);
  const unknownFalseRun = rejectedRun({runId: 'lho-unknown-false-unit', state: 'unknown'});
  check('unit: unknown state blocks even with explicit false', portalHooks.descriptionBindingExplicitPreValidRejectionEvidence(predicateTask([unknownFalseRun])).ok, false);
  const unkeyedRun = rejectedRun({runId: ''});
  check('unit: unkeyed write attempt cannot borrow proof across representations', portalHooks.descriptionBindingExplicitPreValidRejectionEvidence(predicateTask([unkeyedRun])).ok, false);
  const sameRunLegacySibling = predicateTask([rejectedRun()]);
  sameRunLegacySibling.execution.writeAudit.executorEvidence.push({
    runId: 'lho-prevalid-unit',
    mode: 'execute',
    state: 'publish_pre_valid_failed',
    publishResult: {code: '0', hasInfo: true},
  });
  check('unit: same-run legacy projection cannot borrow strict false sibling proof', portalHooks.descriptionBindingExplicitPreValidRejectionEvidence(sameRunLegacySibling).ok, false);
  const sameRunTruncatedSibling = predicateTask([rejectedRun()]);
  sameRunTruncatedSibling.execution.writeAudit.executorEvidence.push({
    runId: 'lho-prevalid-unit',
    publishCode: '0',
    publishTraceId: 'trace-prevalid-unit',
  });
  const truncatedSiblingEvidence = portalHooks.descriptionBindingExplicitPreValidRejectionEvidence(sameRunTruncatedSibling);
  check('unit: same-run result-less truncated array member cannot borrow sibling proof', truncatedSiblingEvidence.ok, false);
  check('unit: truncated same-run member is counted as unknown result', truncatedSiblingEvidence.reasons, rows => rows.some(row => row.includes('write_without_own_explicit_false')));

  const artifactDir = path.join(ROOT, 'logs', 'link-ops-openapi-executor');
  const artifactRunId = `lho-artifact-unit-${process.pid}`;
  const artifactFile = path.join(artifactDir, `${artifactRunId}.local.json`);
  const artifactPayloadHash = 'a'.repeat(64);
  const artifactTraceId = 'trace-artifact-unit';
  const artifactBody = {
    runId: artifactRunId,
    mode: 'execute',
    state: 'publish_pre_valid_failed',
    storeKey: 'NM',
    payload: {payloadHash: artifactPayloadHash},
    publishResult: {
      code: '0',
      traceId: artifactTraceId,
      info: {success: false, taskNo: '', spu_name: '', version: '', skc_list: []},
    },
    readbackFingerprint: {publishSpuNames: [], publishSkcNames: [], publishSkuCodes: []},
    readback: {ok: false, status: 'planned_not_run', pendingReview: false, scannedRows: null, matchedCount: 0, weakMatchedCount: 0, matchedRows: [], weakMatchedRows: [], calls: []},
  };
  await fs.mkdir(artifactDir, {recursive: true});
  await fs.writeFile(artifactFile, `${JSON.stringify(artifactBody)}\n`, {encoding: 'utf8', mode: 0o600});
  try {
    const candidate = {
      runId: artifactRunId,
      savedTo: path.relative(ROOT, artifactFile),
      storeKey: 'NM',
      mode: 'execute',
      state: 'publish_pre_valid_failed',
      payloadHash: artifactPayloadHash,
      code: '0',
      traceId: artifactTraceId,
    };
    const artifactProof = await portalHooks.verifyLegacyPreValidArtifact(candidate);
    check('unit: exact controlled legacy artifact verifies', artifactProof.runId, artifactRunId);
    await checkRejects('unit: artifact payload drift blocks', () => portalHooks.verifyLegacyPreValidArtifact({...candidate, payloadHash: 'b'.repeat(64)}));
    await checkRejects('unit: artifact trace drift blocks', () => portalHooks.verifyLegacyPreValidArtifact({...candidate, traceId: 'wrong-trace'}));
    await checkRejects('unit: artifact store drift blocks', () => portalHooks.verifyLegacyPreValidArtifact({...candidate, storeKey: 'FY'}));
    await checkRejects('unit: artifact run drift blocks', () => portalHooks.verifyLegacyPreValidArtifact({...candidate, runId: 'lho-wrong-run'}));
    await checkRejects('unit: artifact state drift blocks', () => portalHooks.verifyLegacyPreValidArtifact({...candidate, state: 'blocked'}));
    await checkRejects('unit: artifact traversal blocks', () => portalHooks.verifyLegacyPreValidArtifact({...candidate, savedTo: '../outside.json'}));
    await fs.writeFile(artifactFile, `${JSON.stringify({...artifactBody, submittedPossibly: true})}\n`, {encoding: 'utf8', mode: 0o600});
    await checkRejects('unit: artifact positive submission contradiction blocks', () => portalHooks.verifyLegacyPreValidArtifact(candidate));
    await fs.writeFile(artifactFile, `${JSON.stringify({...artifactBody, lifecycle: {locked: true}})}\n`, {encoding: 'utf8', mode: 0o600});
    await checkRejects('unit: artifact lifecycle lock contradiction blocks', () => portalHooks.verifyLegacyPreValidArtifact(candidate));
    await fs.writeFile(artifactFile, `${JSON.stringify({...artifactBody, readbackFingerprint: {publishSpuNames: ['v-created-1'], publishSkcNames: [], publishSkuCodes: []}})}\n`, {encoding: 'utf8', mode: 0o600});
    await checkRejects('unit: artifact readback fingerprint identity blocks', () => portalHooks.verifyLegacyPreValidArtifact(candidate));
    await fs.writeFile(artifactFile, `${JSON.stringify({...artifactBody, readback: {...artifactBody.readback, matchedRows: [{spuName: 'v-created-1'}]}})}\n`, {encoding: 'utf8', mode: 0o600});
    await checkRejects('unit: artifact matched row identity blocks', () => portalHooks.verifyLegacyPreValidArtifact(candidate));
    const missingPendingReview = structuredClone(artifactBody);
    delete missingPendingReview.readback.pendingReview;
    await fs.writeFile(artifactFile, `${JSON.stringify(missingPendingReview)}\n`, {encoding: 'utf8', mode: 0o600});
    await checkRejects('unit: artifact missing own pendingReview false blocks', () => portalHooks.verifyLegacyPreValidArtifact(candidate));
    await fs.writeFile(artifactFile, `${JSON.stringify(artifactBody)}\n`, {encoding: 'utf8', mode: 0o600});
    const legacyTask = predicateTask([rejectedRun({runId: artifactRunId})]);
    const addExactArtifactTuple = (node, depth = 0) => {
      if (depth > 14 || !node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const entry of node) addExactArtifactTuple(entry, depth + 1);
        return;
      }
      if (String(node.childRunId || node.runId || '') === artifactRunId) {
        node.storeKey = 'NM';
        node.mode = 'execute';
        node.state = 'publish_pre_valid_failed';
        node.payloadHash = artifactPayloadHash;
        node.publishCode = '0';
        node.publishTraceId = artifactTraceId;
        if (node.publishResult && typeof node.publishResult === 'object') {
          node.publishResult.code = '0';
          node.publishResult.traceId = artifactTraceId;
        }
      }
      for (const entry of Object.values(node)) addExactArtifactTuple(entry, depth + 1);
    };
    addExactArtifactTuple(legacyTask);
    for (const run of legacyTask.execution.writeAudit.executorEvidence) {
      run.publishResult = {code: '0', hasInfo: true};
      run.publishResult.traceId = artifactTraceId;
    }
    const hydratedLegacy = portalHooks.hydrateLegacyPreValidProofs(legacyTask, [artifactProof]);
    check('unit: exact artifact hydrates only matching legacy attempt', portalHooks.descriptionBindingExplicitPreValidRejectionEvidence(hydratedLegacy).ok, true);
    const wrongStoreLegacy = structuredClone(legacyTask);
    wrongStoreLegacy.execution.writeAudit.executorEvidence[0].storeKey = 'FY';
    check('unit: same-run wrong-store projection cannot borrow artifact proof', portalHooks.descriptionBindingExplicitPreValidRejectionEvidence(portalHooks.hydrateLegacyPreValidProofs(wrongStoreLegacy, [artifactProof])).ok, false);
    const wrongHashLegacy = structuredClone(legacyTask);
    wrongHashLegacy.execution.writeAudit.executorEvidence[0].payloadHash = 'b'.repeat(64);
    check('unit: same-run wrong-hash projection cannot borrow artifact proof', portalHooks.descriptionBindingExplicitPreValidRejectionEvidence(portalHooks.hydrateLegacyPreValidProofs(wrongHashLegacy, [artifactProof])).ok, false);
    const missingTupleLegacy = structuredClone(legacyTask);
    delete missingTupleLegacy.execution.writeAudit.executorEvidence[0].payloadHash;
    check('unit: same-run incomplete projection cannot borrow artifact proof', portalHooks.descriptionBindingExplicitPreValidRejectionEvidence(portalHooks.hydrateLegacyPreValidProofs(missingTupleLegacy, [artifactProof])).ok, false);
    const resultlessTupleLegacy = structuredClone(legacyTask);
    delete resultlessTupleLegacy.execution.writeAudit.executorEvidence[0].payloadHash;
    delete resultlessTupleLegacy.execution.writeAudit.executorEvidence[0].publishResult;
    const resultlessTupleEvidence = portalHooks.descriptionBindingExplicitPreValidRejectionEvidence(portalHooks.hydrateLegacyPreValidProofs(resultlessTupleLegacy, [artifactProof]));
    check('unit: same-run result-less incomplete projection cannot borrow artifact proof', resultlessTupleEvidence.ok, false);
    check('unit: result-less artifact tuple mismatch is explicit', resultlessTupleEvidence.reasons, rows => rows.some(row => row.includes('legacy_artifact_tuple_mismatch')));
    const auditWithoutSavedTo = {
      task: {id: 'unit-prevalid-task'},
      execution: {executorEvidence: [{
        childRunId: artifactRunId,
        storeKey: 'FY',
        mode: 'execute',
        state: 'publish_pre_valid_failed',
        payloadHash: 'b'.repeat(64),
        publishResult: {code: '0', traceId: 'wrong-trace', hasInfo: true},
      }]},
    };
    const hydratedAuditWithoutSavedTo = portalHooks.hydrateLegacyPreValidProofs(auditWithoutSavedTo, [artifactProof]);
    check('unit: audit entry without savedTo and mismatched tuple remains unknown', hydratedAuditWithoutSavedTo.execution.executorEvidence[0].publishResult.explicitSuccess, undefined);
    const mismatchedAuditEvidence = portalHooks.descriptionBindingExplicitPreValidRejectionEvidence(hydratedAuditWithoutSavedTo);
    check('unit: audit entry without savedTo and mismatched tuple blocks', mismatchedAuditEvidence.ok, false);
    check('unit: audit mismatch exposes explicit tuple reason', mismatchedAuditEvidence.reasons, rows => rows.some(row => row.includes('legacy_artifact_tuple_mismatch')));
  } finally {
    await fs.rm(artifactFile, {force: true});
  }

  // Managed CLI source-only path: actual HTML bytes -> same task bind -> fresh
  // dry-run, with hash-only stdout and a nonzero exit on any incomplete lock.
  publishSuccessMode.mode = 'explicit_true';
  const cliLogin = await runCli(['login', '--username', 'owner_desc_bind', '--password', 'owner-pass']);
  check('managed CLI test login succeeds', cliLogin.code, 0);
  const cliSourceFile = path.join(tmpRoot, 'SK-11004-cli-source.html');
  await fs.writeFile(cliSourceFile, sourceBytes);
  const taskId5 = await createTask(cookie, 'DESC-CLI');
  await attachPayload(taskId5, publishPayloadFor('DESC-CLI'));
  const cliPrepare = await runCli([
    'prepare-descriptions',
    '--task-id', taskId5,
    '--store', 'NM',
    '--source-file', cliSourceFile,
  ]);
  check('managed CLI prepare-descriptions exits zero', cliPrepare.code, 0);
  check('managed CLI prepare-descriptions reports complete lock', cliPrepare.json?.ok, true);
  check('managed CLI returns 64-char dry-run payload hash', String(cliPrepare.json?.dryRun?.payloadHash || '').length, 64);
  check('managed CLI confirms description hash lock', cliPrepare.json?.dryRun?.descriptionBindingLocked, true);
  check('managed CLI stdout contains no description text or full source path', cliPrepare.stdout, text => (
    !text.includes(enLines[0])
    && !text.includes(arLines[0])
    && !text.includes(zhLines[0])
    && !text.includes(cliSourceFile)
  ));

  const cliUnconfirmedTaskId = await createTask(cookie, 'DESC-CLI-UNCONFIRMED');
  await attachPayload(cliUnconfirmedTaskId, publishPayloadFor('DESC-CLI-UNCONFIRMED'));
  const cliUnconfirmedBind = await bindDescriptions(cookie, cliUnconfirmedTaskId);
  check('managed CLI unconfirmed fixture binds', cliUnconfirmedBind.status, 200);
  const cliUnconfirmedDryRun = await req('/api/link-ops-execute', {
    method: 'POST',
    cookie,
    body: {id: cliUnconfirmedTaskId, mode: 'dry-run', source: 'test_cli_unconfirmed'},
  });
  check('managed CLI unconfirmed fixture dry-run ready', cliUnconfirmedDryRun.json?.task?.execution?.preflight?.ok, true);
  descReadbackMode.mode = 'drift';
  let cliUnconfirmed;
  try {
    cliUnconfirmed = await runCli([
      'execute',
      '--task-id', cliUnconfirmedTaskId,
      '--confirm', CONFIRM_TEXT,
    ]);
  } finally {
    descReadbackMode.mode = 'exact';
  }
  check('managed CLI unconfirmed execute exits nonzero', cliUnconfirmed.code, code => code !== 0);
  check('managed CLI unconfirmed execute prints top-level failure', cliUnconfirmed.json?.ok, false);
  check('managed CLI unconfirmed execute preserves committed true', cliUnconfirmed.json?.committed, true);
  check('managed CLI unconfirmed execute prints partial true', cliUnconfirmed.json?.partial, true);
  check('managed CLI unconfirmed execute prints outcome', cliUnconfirmed.json?.outcome, 'unconfirmed');
  check('managed CLI unconfirmed execute retains failed lifecycle', cliUnconfirmed.json?.task?.lifecycle?.lifecycleStatus, 'submitted_readback_failed');

  // --expected-revision is optional, but once supplied it must be a positive
  // Number.isSafeInteger. Exercise values exactly as parseArgs can produce
  // them through Number(argv[++i]); every invalid form must fail before any
  // binding or dry-run write. The fractional regression is pinned at live=42
  // so 42.9 cannot be silently truncated into a valid CAS at revision 42.
  const expectedRevisionTaskId = await createTask(cookie, 'DESC-EXPECTED-REVISION');
  await attachPayload(expectedRevisionTaskId, publishPayloadFor('DESC-EXPECTED-REVISION'));
  await updateRawTaskById(expectedRevisionTaskId, task => ({
    ...task,
    repositoryRevision: 42,
  }));
  const invalidExpectedRevisionCases = [
    ['fractional-42.9-at-live-42', '42.9'],
    ['zero', '0'],
    ['negative', '-1'],
    ['above-max-safe-integer', String(Number.MAX_SAFE_INTEGER + 1)],
    ['nan-token', 'NaN'],
  ];
  for (const [label, value] of invalidExpectedRevisionCases) {
    const attempt = await runCli([
      'prepare-descriptions',
      '--task-id', expectedRevisionTaskId,
      '--store', 'NM',
      '--source-file', cliSourceFile,
      '--expected-revision', value,
    ]);
    check(`expected revision ${label} is rejected`, attempt.code, code => code !== 0);
    check(`expected revision ${label} reports positive safe integer`, attempt.stderr, text => text.includes('正安全整数'));
    const after = await rawTaskById(expectedRevisionTaskId);
    check(`expected revision ${label} performs no binding write`, Boolean(after?.descriptionMaterialBinding), false);
    check(`expected revision ${label} performs no revision write`, Number(after?.repositoryRevision || 0), 42);
    check(`expected revision ${label} appends no binding event`, asArray(after?.history)
      .filter(entry => entry?.event === 'approved_description_material_bound').length, 0);
  }
  const omittedExpectedRevision = await runCli([
    'prepare-descriptions',
    '--task-id', expectedRevisionTaskId,
    '--store', 'NM',
    '--source-file', cliSourceFile,
  ]);
  check('omitted expected revision remains allowed', omittedExpectedRevision.code, 0);
  check('omitted expected revision binds at live revision 42', Number((await rawTaskById(expectedRevisionTaskId))
    ?.descriptionMaterialBinding?.baseTaskRevision || 0), 42);

  const cliLegacySourceFile = path.join(tmpRoot, 'SK-5110-cli-legacy-source.html');
  await fs.writeFile(cliLegacySourceFile, legacySourceBytes);
  const legacyTaskId = await createTask(cookie, 'DESC-CLI-LEGACY-S9');
  await attachPayload(legacyTaskId, publishPayloadFor('DESC-CLI-LEGACY-S9'));
  const cliLegacyPrepare = await runCli([
    'prepare-descriptions',
    '--task-id', legacyTaskId,
    '--store', 'NM',
    '--source-file', cliLegacySourceFile,
    '--section', 'auto',
  ]);
  check('managed CLI legacy s9 prepare exits zero', cliLegacyPrepare.code, 0);
  check('managed CLI legacy s9 description hash lock', cliLegacyPrepare.json?.dryRun?.descriptionBindingLocked, true);
  check('managed CLI legacy s9 records exact source proof', cliLegacyPrepare.json?.bound?.sourceProof, 'server_verified_html_section_s9');
  const legacyBoundTask = await rawTaskById(legacyTaskId);
  check('legacy s9 persisted exact source proof', legacyBoundTask?.descriptionMaterialBinding?.sourceProof, 'server_verified_html_section_s9');
  const forgedLegacyProof = JSON.parse(JSON.stringify(legacyBoundTask));
  forgedLegacyProof.descriptionMaterialBinding.sourceProof = 'server_verified_html_section_s09';
  const forgedProofGate = validateDescriptionBindingLock(forgedLegacyProof, forgedLegacyProof.openapiPublishPayload);
  check('legacy s9 source proof flip breaks immutable binding identity', forgedProofGate.ok, false);
  const legacyReplay = await runCli([
    'prepare-descriptions',
    '--task-id', legacyTaskId,
    '--store', 'NM',
    '--source-file', cliLegacySourceFile,
    '--section', 'auto',
  ]);
  check('managed CLI legacy s9 idempotent replay exits zero', legacyReplay.code, 0);
  check('managed CLI legacy s9 replay keeps source proof', legacyReplay.json?.bound?.sourceProof, 'server_verified_html_section_s9');

  const invalidSection = await runCli([
    'prepare-descriptions',
    '--task-id', legacyTaskId,
    '--store', 'NM',
    '--source-file', cliLegacySourceFile,
    '--section', 'typo',
  ]);
  check('managed CLI invalid section exits nonzero', invalidSection.code, code => code !== 0);
  const missingSourcePath = path.join(tmpRoot, 'private-materials', 'missing-reviewed-source.html');
  const cliMissingSource = await runCli([
    'prepare-descriptions',
    '--task-id', taskId5,
    '--store', 'NM',
    '--source-file', missingSourcePath,
  ]);
  check('managed CLI missing source exits nonzero', cliMissingSource.code, code => code !== 0);
  check('managed CLI missing source error redacts absolute path', cliMissingSource.stderr, text => (
    !text.includes(tmpRoot) && !text.includes(missingSourcePath) && text.includes('missing-reviewed-source.html')
  ));

  const cliAuditPendingTaskId = await createTask(cookie, 'DESC-CLI-AUDIT-PENDING');
  await attachPayload(cliAuditPendingTaskId, publishPayloadFor('DESC-CLI-AUDIT-PENDING'));
  const cliAuditPendingBaseRevision = Number((await rawTaskById(cliAuditPendingTaskId))?.repositoryRevision || 0);
  await fs.writeFile(auditFailureMarker, 'fail-cli-description-audit', 'utf8');
  let cliAuditPending;
  try {
    cliAuditPending = await runCli([
      'prepare-descriptions',
      '--task-id', cliAuditPendingTaskId,
      '--store', 'NM',
      '--source-file', cliSourceFile,
      '--expected-revision', String(cliAuditPendingBaseRevision),
    ]);
  } finally {
    await fs.rm(auditFailureMarker, {force: true});
  }
  check('managed CLI audit-pending exits nonzero', cliAuditPending.code, code => code !== 0);
  check('managed CLI audit-pending reports committed stage', cliAuditPending.json?.stage, 'binding_committed_audit_pending');
  check('managed CLI audit-pending preserves bindingCommitted true', cliAuditPending.json?.bindingCommitted, true);
  check('managed CLI audit-pending does not misreport binding_not_committed', cliAuditPending.json?.stage === 'binding_not_committed', false);
  const cliAuditPendingBeforeRetry = await rawTaskById(cliAuditPendingTaskId);
  const cliAuditPendingBoundAt = String(cliAuditPendingBeforeRetry?.descriptionMaterialBinding?.boundAt || '');
  const cliAuditPendingBindingRequestKey = String(cliAuditPendingBeforeRetry?.descriptionMaterialBinding?.bindingRequestKey || '');
  const cliAuditPendingBindHistoryCount = asArray(cliAuditPendingBeforeRetry?.history)
    .filter(entry => entry?.event === 'approved_description_material_bound').length;
  const cliAuditRetry = await runCli([
    'prepare-descriptions',
    '--task-id', cliAuditPendingTaskId,
    '--store', 'NM',
    '--source-file', cliSourceFile,
    '--expected-revision', String(cliAuditPendingBaseRevision),
  ]);
  check('managed CLI audit-pending real CLI retry succeeds', cliAuditRetry.code, 0);
  check('managed CLI audit-pending real CLI retry completes dry-run', cliAuditRetry.json?.ok === true && cliAuditRetry.json?.dryRun?.descriptionBindingLocked === true, true);
  const cliAuditPendingAfterRetry = await rawTaskById(cliAuditPendingTaskId);
  check('managed CLI audit retry preserves original boundAt', cliAuditPendingAfterRetry?.descriptionMaterialBinding?.boundAt, cliAuditPendingBoundAt);
  check('managed CLI audit retry does not append a second binding history event', asArray(cliAuditPendingAfterRetry?.history)
    .filter(entry => entry?.event === 'approved_description_material_bound').length, cliAuditPendingBindHistoryCount);
  check('managed CLI audit retry preserves original base revision', cliAuditPendingAfterRetry?.descriptionMaterialBinding?.baseTaskRevision, cliAuditPendingBaseRevision);
  check('managed CLI audit retry preserves original binding request key', cliAuditPendingAfterRetry?.descriptionMaterialBinding?.bindingRequestKey, cliAuditPendingBindingRequestKey);

  // External JSONL audit failure happens after the repository CAS commit.
  // The endpoint must report the exact committed stage (never a false
  // uncommitted error), preserve the task, and allow an idempotent audit retry.
  const auditFailureTaskId = await createTask(cookie, 'DESC-AUDIT-FAILURE');
  await attachPayload(auditFailureTaskId, publishPayloadFor('DESC-AUDIT-FAILURE'));
  const auditFailureBaseRevision = Number((await rawTaskById(auditFailureTaskId))?.repositoryRevision || 0);
  await fs.writeFile(auditFailureMarker, 'fail-next-description-audit', 'utf8');
  let auditFailureBind;
  try {
    auditFailureBind = await bindDescriptions(cookie, auditFailureTaskId, {expectedRevision: auditFailureBaseRevision});
  } finally {
    await fs.rm(auditFailureMarker, {force: true});
  }
  check('post-commit audit failure still returns HTTP 200 staged result', auditFailureBind.status, 200);
  check('post-commit audit failure reports binding committed', auditFailureBind.json?.bindingCommitted, true);
  check('post-commit audit failure reports exact readback verified', auditFailureBind.json?.readbackVerified, true);
  check('post-commit audit failure reports audit pending', auditFailureBind.json?.auditPending, true);
  const auditFailureRaw = await rawTaskById(auditFailureTaskId);
  check('post-commit audit failure preserved bound task', auditFailureRaw?.descriptionMaterialBinding?.bindingRequestKey, auditFailureBind.json?.binding?.bindingRequestKey);
  const auditRetry = await bindDescriptions(cookie, auditFailureTaskId, {expectedRevision: auditFailureBaseRevision});
  check('post-commit retry returns success', auditRetry.status, 200);
  check('post-commit retry is idempotent and records audit', auditRetry.json?.binding?.idempotentReplay === true && auditRetry.json?.auditPending === false, true);

  // material rows must be byte-exact against the actual HTML (extractor gate)
  const tampered = JSON.parse(JSON.stringify(material));
  tampered.rows.en.lines[0] = 'REWRITTEN line';
  const tamperedBind = await bindDescriptions(cookie, taskId2, {materialJson: tampered});
  check('tampered material sha mismatch rejected by server validation', tamperedBind.status, 400);
  const identicalReplay = await bindDescriptions(cookie, taskId2, {
    materialJson: JSON.parse(JSON.stringify(material)),
    expectedRevision: Number((await rawTaskById(taskId2))?.descriptionMaterialBinding?.baseTaskRevision || 0),
  });
  check('re-bind with identical material is idempotent', identicalReplay.status, 200);
  check('identical re-bind reports idempotent replay', identicalReplay.json?.binding?.idempotentReplay, true);

  // --- stale description binding after a legal prepare-publish mutation ---
  // A legal payload/price + approved-image mutation leaves the description
  // binding stale (same reviewed HTML/material identity, new payload hash and
  // image fingerprint, bumped repository revision). The CLI must never replay
  // the stale baseTaskRevision: the server projection exposes the lock state
  // and the CLI rebinds at the live revision, recomputing the binding
  // identity. A submitted/locked task rejects any rebind.
  // Revision accounting of a real prepare-descriptions CLI run: the CAS bind
  // write advances +1 and the mandatory fresh dry-run write advances +1, so
  // the task lands at base + 2; an idempotent retry only advances its own
  // dry-run write (+1) because the bind is replayed without a new CAS write.
  const rebindTaskId = await createTask(cookie, 'DESC-REBIND');
  await attachPayload(rebindTaskId, publishPayloadFor('DESC-REBIND'));
  const rebindPreBindRevision = Number((await rawTaskById(rebindTaskId))?.repositoryRevision || 0);
  const rebindInitial = await runCli([
    'prepare-descriptions',
    '--task-id', rebindTaskId,
    '--store', 'NM',
    '--source-file', cliSourceFile,
  ]);
  check('rebind flow initial CLI bind exits zero', rebindInitial.code, 0);
  check('rebind flow initial CLI bind locks descriptions', rebindInitial.json?.dryRun?.descriptionBindingLocked, true);
  const rebindRawInitial = await rawTaskById(rebindTaskId);
  const rebindBaseRevision = Number(rebindRawInitial?.descriptionMaterialBinding?.baseTaskRevision || 0);
  const rebindInitialRevision = Number(rebindRawInitial?.repositoryRevision || 0);
  const rebindInitialRequestKey = String(rebindRawInitial?.descriptionMaterialBinding?.bindingRequestKey || '');
  const rebindInitialBoundAt = String(rebindRawInitial?.descriptionMaterialBinding?.boundAt || '');
  check('rebind flow initial binding base revision is positive', rebindBaseRevision, value => Number(value) > 0);
  check('rebind flow initial binding locks the pre-bind revision', rebindBaseRevision, rebindPreBindRevision);
  check('rebind flow initial CLI run advances bind + dry-run writes', rebindInitialRevision, rebindPreBindRevision + 2);
  const rebindProjected = async () => (await req('/api/link-ops-tasks?limit=500', {cookie})).json?.data?.tasks
    ?.find(task => String(task?.id || '') === rebindTaskId) || {};
  const rebindLockInitial = await rebindProjected();
  check('rebind flow projection exposes compact lock after bind', rebindLockInitial.descriptionBindingLock, lock => (
    lock
    && Object.keys(lock).sort().join(',') === 'baseTaskRevision,currentRevision,ok,stale'
    && lock.baseTaskRevision === rebindBaseRevision
    && lock.currentRevision === rebindInitialRevision
    && !Object.prototype.hasOwnProperty.call(lock, 'newPayloadHash')
    && !Object.prototype.hasOwnProperty.call(lock, 'hashes')
    && !Object.prototype.hasOwnProperty.call(lock, 'descriptionMaterialBinding')
  ));
  check('rebind flow projection lock is current after bind', rebindLockInitial.descriptionBindingLock?.ok, true);
  check('rebind flow projection lock is not stale after bind', rebindLockInitial.descriptionBindingLock?.stale, false);
  const rebindBindHistoryCount = async taskId => asArray((await rawTaskById(taskId))?.history)
    .filter(entry => entry?.event === 'approved_description_material_bound').length;
  check('rebind flow initial bind records one binding event', await rebindBindHistoryCount(rebindTaskId), 1);

  // Legal prepare-publish mutation: price + approved image fingerprint change
  // and a repository revision bump. The reviewed description HTML is reused
  // verbatim, so the old binding's material identity still matches exactly.
  const rebindMutatedRevision = rebindInitialRevision + 7;
  const rebindMutatedPayload = JSON.parse(JSON.stringify(rebindRawInitial.openapiPublishPayload));
  rebindMutatedPayload.skc_list[0].sku_list[0].cost_info.cost_price = '129.00';
  rebindMutatedPayload.skc_list[0].image_info.image_info_list[0].image_url = 'https://img.shein.com/main-rebind-v2.jpg';
  let rebindNewFingerprint = '';
  await updateRawTaskById(rebindTaskId, task => {
    const publishAssetBinding = updatedPublishAssetBindingFixture(task, rebindMutatedPayload, {
      supplyPrice: 129,
      mainImageUrl: 'https://img.shein.com/main-rebind-v2.jpg',
    });
    rebindNewFingerprint = publishAssetBinding.bindingFingerprint;
    return {
      ...task,
      repositoryRevision: rebindMutatedRevision,
      openapiPublishPayload: rebindMutatedPayload,
      publishAssetBinding,
    };
  });
  check('rebind flow mutation keeps old material identity', (await rawTaskById(rebindTaskId))?.descriptionMaterialBinding?.bindingRequestKey, rebindInitialRequestKey);
  const rebindLockStale = await rebindProjected();
  check('rebind flow projection reports stale lock after mutation', rebindLockStale.descriptionBindingLock?.ok, false);
  check('rebind flow projection reports stale flag after mutation', rebindLockStale.descriptionBindingLock?.stale, true);
  check('rebind flow projection keeps original base revision when stale', rebindLockStale.descriptionBindingLock?.baseTaskRevision, rebindBaseRevision);
  check('rebind flow projection reports live revision when stale', rebindLockStale.descriptionBindingLock?.currentRevision, rebindMutatedRevision);

  // Replaying the stale base revision is exactly the old CLI bug: the server
  // CAS must reject it with 409 because the lock is no longer current.
  const rebindStaleHttp = await bindDescriptions(cookie, rebindTaskId, {expectedRevision: rebindBaseRevision});
  check('rebind flow stale expected revision -> 409', rebindStaleHttp.status, 409);
  check('rebind flow stale expected revision code', rebindStaleHttp.json?.code, 'LINK_OPS_REVISION_CONFLICT');
  check('rebind flow stale replay leaves binding untouched', (await rawTaskById(rebindTaskId))?.descriptionMaterialBinding?.baseTaskRevision, rebindBaseRevision);

  // The CLI must refuse an explicit stale revision instead of silently
  // reusing it, and then must rebind at the live revision.
  const rebindStaleCli = await runCli([
    'prepare-descriptions',
    '--task-id', rebindTaskId,
    '--store', 'NM',
    '--source-file', cliSourceFile,
    '--expected-revision', String(rebindBaseRevision),
  ]);
  check('rebind flow CLI rejects explicit stale revision', rebindStaleCli.code, code => code !== 0);
  check('rebind flow CLI stale error names the live revision', rebindStaleCli.stderr, text => text.includes(String(rebindMutatedRevision)));

  const rebindAtLive = await runCli([
    'prepare-descriptions',
    '--task-id', rebindTaskId,
    '--store', 'NM',
    '--source-file', cliSourceFile,
  ]);
  check('rebind flow CLI rebind at live revision exits zero', rebindAtLive.code, 0);
  check('rebind flow CLI rebind locks descriptions again', rebindAtLive.json?.dryRun?.descriptionBindingLocked, true);
  const rebindRawRebound = await rawTaskById(rebindTaskId);
  check('rebind flow recomputes baseTaskRevision', rebindRawRebound?.descriptionMaterialBinding?.baseTaskRevision, rebindMutatedRevision);
  check('rebind flow recomputes binding request key', rebindRawRebound?.descriptionMaterialBinding?.bindingRequestKey, value => (
    /^[a-f0-9]{64}$/.test(String(value)) && String(value) !== rebindInitialRequestKey
  ));
  check('rebind flow advances bind + dry-run writes from mutated revision', Number(rebindRawRebound?.repositoryRevision || 0), rebindMutatedRevision + 2);
  check('rebind flow recomputes image binding fingerprint', rebindRawRebound?.descriptionMaterialBinding?.imageBindingFingerprint, rebindNewFingerprint);
  check('rebind flow recomputes new payload hash for mutated payload', rebindRawRebound?.descriptionMaterialBinding?.newPayloadHash, linkOpsPayloadHash(rebindRawRebound?.openapiPublishPayload));
  check('rebind flow keeps identical description hashes', rebindRawRebound?.descriptionMaterialBinding?.hashes?.en, materialSummary.hashes.en);
  check('rebind flow records fresh boundAt', rebindRawRebound?.descriptionMaterialBinding?.boundAt, value => String(value) !== rebindInitialBoundAt);
  check('rebind flow rebind records a second binding event', await rebindBindHistoryCount(rebindTaskId), 2);
  check('rebind flow projection lock current again', (await rebindProjected()).descriptionBindingLock?.ok, true);

  // Identical current retry stays idempotent: same identity, same current
  // lock, no second binding write (only the retry's dry-run advances one
  // revision).
  const rebindIdempotent = await runCli([
    'prepare-descriptions',
    '--task-id', rebindTaskId,
    '--store', 'NM',
    '--source-file', cliSourceFile,
  ]);
  check('rebind flow identical current retry exits zero', rebindIdempotent.code, 0);
  const rebindRawIdempotent = await rawTaskById(rebindTaskId);
  check('rebind flow identical retry keeps binding request key', rebindRawIdempotent?.descriptionMaterialBinding?.bindingRequestKey, rebindRawRebound?.descriptionMaterialBinding?.bindingRequestKey);
  check('rebind flow identical retry keeps boundAt', rebindRawIdempotent?.descriptionMaterialBinding?.boundAt, rebindRawRebound?.descriptionMaterialBinding?.boundAt);
  check('rebind flow identical retry only advances its dry-run write', Number(rebindRawIdempotent?.repositoryRevision || 0), Number(rebindRawRebound?.repositoryRevision || 0) + 1);
  check('rebind flow identical retry appends no binding event', await rebindBindHistoryCount(rebindTaskId), 2);

  // A submitted/locked task rejects any rebind and keeps its binding identity.
  const rebindLockedTaskId = await createTask(cookie, 'DESC-REBIND-LOCKED');
  await attachPayload(rebindLockedTaskId, publishPayloadFor('DESC-REBIND-LOCKED'));
  const rebindLockedPreBindRevision = Number((await rawTaskById(rebindLockedTaskId))?.repositoryRevision || 0);
  const rebindLockedInitial = await runCli([
    'prepare-descriptions',
    '--task-id', rebindLockedTaskId,
    '--store', 'NM',
    '--source-file', cliSourceFile,
  ]);
  check('rebind flow locked task initial bind exits zero', rebindLockedInitial.code, 0);
  const rebindLockedRaw = await rawTaskById(rebindLockedTaskId);
  const rebindLockedRequestKey = String(rebindLockedRaw?.descriptionMaterialBinding?.bindingRequestKey || '');
  check('rebind flow locked task initial binding locks the pre-bind revision', Number(rebindLockedRaw?.descriptionMaterialBinding?.baseTaskRevision || 0), rebindLockedPreBindRevision);
  await updateRawTaskById(rebindLockedTaskId, task => ({
    ...task,
    status: 'waiting_review',
    lifecycle: {
      lifecycleStatus: 'submitted_readback_failed',
      status: 'submitted_readback_failed',
      locked: true,
      terminal: false,
      needsManualResolve: true,
    },
    execution: {
      ...(task.execution && typeof task.execution === 'object' ? task.execution : {}),
      state: 'submitted_readback_failed',
      actualWriteSubmitted: false,
      writeAudit: {
        ...(task.execution?.writeAudit && typeof task.execution.writeAudit === 'object' ? task.execution.writeAudit : {}),
        actualWriteSubmitted: false,
      },
    },
  }));
  // A real rebind attempt (with a fresh payload mutation) must be rejected by
  // the bind endpoint's lifecycle gate, never silently rewriting the binding
  // of a submitted/locked task.
  const rebindLockedMutatedRevision = Number(rebindLockedRaw?.repositoryRevision || 0) + 3;
  const rebindLockedMutatedPayload = JSON.parse(JSON.stringify(rebindLockedRaw.openapiPublishPayload));
  rebindLockedMutatedPayload.skc_list[0].sku_list[0].cost_info.cost_price = '139.00';
  await updateRawTaskById(rebindLockedTaskId, task => ({
    ...task,
    repositoryRevision: rebindLockedMutatedRevision,
    openapiPublishPayload: rebindLockedMutatedPayload,
    publishAssetBinding: {
      ...(task.publishAssetBinding && typeof task.publishAssetBinding === 'object' ? task.publishAssetBinding : {}),
      bindingFingerprint: crypto.createHash('sha256').update(`rebind-locked-images-${rebindLockedTaskId}`).digest('hex'),
    },
  }));
  const rebindLockedHttp = await bindDescriptions(cookie, rebindLockedTaskId, {expectedRevision: rebindLockedMutatedRevision});
  check('rebind flow submitted/locked task bind -> 409', rebindLockedHttp.status, 409);
  check('rebind flow locked task keeps binding identity after 409', (await rawTaskById(rebindLockedTaskId))?.descriptionMaterialBinding?.bindingRequestKey, rebindLockedRequestKey);
  const rebindLockedCli = await runCli([
    'prepare-descriptions',
    '--task-id', rebindLockedTaskId,
    '--store', 'NM',
    '--source-file', cliSourceFile,
  ]);
  check('rebind flow submitted/locked task rejects rebind', rebindLockedCli.code, code => code !== 0);
  check('rebind flow locked task keeps binding identity', (await rawTaskById(rebindLockedTaskId))?.descriptionMaterialBinding?.bindingRequestKey, rebindLockedRequestKey);
  check('rebind flow locked task keeps binding base revision', (await rawTaskById(rebindLockedTaskId))?.descriptionMaterialBinding?.baseTaskRevision, rebindLockedRaw?.descriptionMaterialBinding?.baseTaskRevision);

  // --- strict CLI lock validation: malformed server lock matrix ---
  // The managed CLI must treat descriptionBindingLock as KNOWN only when it is
  // exactly {baseTaskRevision,currentRevision,ok,stale} with boolean ok/stale
  // satisfying stale === !ok, positive safe-integer revisions, base equal to
  // the existing binding's baseTaskRevision and current equal to the live
  // repositoryRevision. The rewrite proxy injects malformed lock variants into
  // the task-list projection the CLI reads, so every deviation is UNKNOWN:
  // never idempotent, fail-closed without an explicit live revision, and
  // CAS-rebound only at an explicitly pinned live revision (never the old
  // base).
  const matrixTaskId = await createTask(cookie, 'DESC-LOCK-MATRIX');
  await attachPayload(matrixTaskId, publishPayloadFor('DESC-LOCK-MATRIX'));
  const matrixPreBindRevision = Number((await rawTaskById(matrixTaskId))?.repositoryRevision || 0);
  await new Promise(resolve => lockProxy.listen(lockProxyPort, '127.0.0.1', resolve));
  lockInjection.mode = 'passthrough';
  const matrixInitial = await runCli([
    'prepare-descriptions',
    '--task-id', matrixTaskId,
    '--store', 'NM',
    '--source-file', cliSourceFile,
  ], {baseUrl: lockProxyBase});
  check('lock matrix initial CLI bind exits zero', matrixInitial.code, 0);
  check('lock matrix initial CLI bind locks descriptions', matrixInitial.json?.dryRun?.descriptionBindingLocked, true);
  const matrixRawInitial = await rawTaskById(matrixTaskId);
  const matrixBase = Number(matrixRawInitial?.descriptionMaterialBinding?.baseTaskRevision || 0);
  const matrixRequestKey = String(matrixRawInitial?.descriptionMaterialBinding?.bindingRequestKey || '');
  const matrixBoundAt = String(matrixRawInitial?.descriptionMaterialBinding?.boundAt || '');
  const matrixLiveRevision = Number(matrixRawInitial?.repositoryRevision || 0);
  check('lock matrix initial binding locks the pre-bind revision', matrixBase, matrixPreBindRevision);
  check('lock matrix initial run advances bind + dry-run writes', matrixLiveRevision, matrixPreBindRevision + 2);
  const matrixProjected = async () => (await req('/api/link-ops-tasks?limit=500', {cookie})).json?.data?.tasks
    ?.find(task => String(task?.id || '') === matrixTaskId) || {};
  const matrixLockInitial = await matrixProjected();
  check('lock matrix real projection current after bind', matrixLockInitial.descriptionBindingLock?.ok, true);
  check('lock matrix real projection base matches binding', matrixLockInitial.descriptionBindingLock?.baseTaskRevision, matrixBase);
  check('lock matrix real projection current matches live', matrixLockInitial.descriptionBindingLock?.currentRevision, matrixLiveRevision);
  const matrixSnapshot = async () => {
    const raw = await rawTaskById(matrixTaskId);
    return {
      base: Number(raw?.descriptionMaterialBinding?.baseTaskRevision || 0),
      key: String(raw?.descriptionMaterialBinding?.bindingRequestKey || ''),
      boundAt: String(raw?.descriptionMaterialBinding?.boundAt || ''),
      revision: Number(raw?.repositoryRevision || 0),
      bindEvents: asArray(raw?.history).filter(entry => entry?.event === 'approved_description_material_bound').length,
    };
  };
  const matrixInject = lock => {
    lockInjection.mode = 'inject';
    lockInjection.lock = lock;
  };
  const malformedLockVariants = [
    ['missing-ok', ({base, live}) => ({stale: false, baseTaskRevision: base, currentRevision: live})],
    ['missing-stale', ({base, live}) => ({ok: true, baseTaskRevision: base, currentRevision: live})],
    ['missing-revisions', ({base, live}) => ({ok: true, stale: false})],
    ['only-ok', () => ({ok: true})],
    ['contradiction-both-true', ({base, live}) => ({ok: true, stale: true, baseTaskRevision: base, currentRevision: live})],
    ['contradiction-both-false', ({base, live}) => ({ok: false, stale: false, baseTaskRevision: base, currentRevision: live})],
    ['ok-not-boolean', ({base, live}) => ({ok: 'true', stale: false, baseTaskRevision: base, currentRevision: live})],
    ['stale-not-boolean', ({base, live}) => ({ok: true, stale: 0, baseTaskRevision: base, currentRevision: live})],
    ['base-string', ({base, live}) => ({ok: true, stale: false, baseTaskRevision: String(base), currentRevision: live})],
    ['current-string', ({base, live}) => ({ok: true, stale: false, baseTaskRevision: base, currentRevision: String(live)})],
    ['base-float', ({base, live}) => ({ok: true, stale: false, baseTaskRevision: base + 0.5, currentRevision: live})],
    ['extra-key', ({base, live}) => ({ok: true, stale: false, baseTaskRevision: base, currentRevision: live, extra: 1})],
    ['base-mismatch', ({base, live}) => ({ok: true, stale: false, baseTaskRevision: base + 1, currentRevision: live})],
    ['current-mismatch', ({base, live}) => ({ok: true, stale: false, baseTaskRevision: base, currentRevision: live - 1})],
    ['lock-array', ({base, live}) => [{ok: true, stale: false, baseTaskRevision: base, currentRevision: live}]],
    ['lock-null', () => null],
  ];
  const matrixBeforeMalformed = await matrixSnapshot();
  for (const [variant, makeLock] of malformedLockVariants) {
    matrixInject(makeLock);
    const attempt = await runCli([
      'prepare-descriptions',
      '--task-id', matrixTaskId,
      '--store', 'NM',
      '--source-file', cliSourceFile,
    ], {baseUrl: lockProxyBase});
    check(`lock matrix ${variant} fails closed without explicit revision`, attempt.code, code => code !== 0);
    check(`lock matrix ${variant} names unknown lock in error`, attempt.stderr, text => text.includes('无法区分幂等重放与过期重绑'));
    const after = await matrixSnapshot();
    check(`lock matrix ${variant} keeps binding request key`, after.key, matrixBeforeMalformed.key);
    check(`lock matrix ${variant} keeps binding base revision`, after.base, matrixBeforeMalformed.base);
    check(`lock matrix ${variant} keeps boundAt`, after.boundAt, matrixBeforeMalformed.boundAt);
    check(`lock matrix ${variant} makes no write`, after.revision, matrixBeforeMalformed.revision);
    check(`lock matrix ${variant} appends no binding event`, after.bindEvents, matrixBeforeMalformed.bindEvents);
  }

  // The named regression: a bare {ok:true} must never replay the old base.
  // With an explicit LIVE revision the CLI CAS-rebinds at live over a really
  // stale task state; with the OLD base pinned it is rejected as a revision
  // change before any write and must not touch the binding.
  const matrixStaleBase = matrixBeforeMalformed.base;
  const matrixStaleMutatedRevision = matrixBeforeMalformed.revision + 7;
  const matrixStalePayload = JSON.parse(JSON.stringify((await rawTaskById(matrixTaskId)).openapiPublishPayload));
  matrixStalePayload.skc_list[0].sku_list[0].cost_info.cost_price = '159.00';
  matrixStalePayload.skc_list[0].image_info.image_info_list[0].image_url = 'https://img.shein.com/main-lock-matrix-v2.jpg';
  await updateRawTaskById(matrixTaskId, task => ({
    ...task,
    repositoryRevision: matrixStaleMutatedRevision,
    openapiPublishPayload: matrixStalePayload,
    publishAssetBinding: updatedPublishAssetBindingFixture(task, matrixStalePayload, {
      supplyPrice: 159,
      mainImageUrl: 'https://img.shein.com/main-lock-matrix-v2.jpg',
    }),
  }));
  matrixInject(() => ({ok: true}));
  const matrixExplicitLive = await runCli([
    'prepare-descriptions',
    '--task-id', matrixTaskId,
    '--store', 'NM',
    '--source-file', cliSourceFile,
    '--expected-revision', String(matrixStaleMutatedRevision),
  ], {baseUrl: lockProxyBase});
  check('lock matrix {ok:true} with explicit live revision rebinds at live', matrixExplicitLive.code, 0);
  check('lock matrix {ok:true} explicit rebind locks descriptions', matrixExplicitLive.json?.dryRun?.descriptionBindingLocked, true);
  const matrixAfterExplicitLive = await rawTaskById(matrixTaskId);
  const matrixReboundBase = Number(matrixAfterExplicitLive?.descriptionMaterialBinding?.baseTaskRevision || 0);
  const matrixReboundKey = String(matrixAfterExplicitLive?.descriptionMaterialBinding?.bindingRequestKey || '');
  const matrixReboundRevision = Number(matrixAfterExplicitLive?.repositoryRevision || 0);
  check('lock matrix {ok:true} explicit rebind recomputes base at live', matrixReboundBase, matrixStaleMutatedRevision);
  check('lock matrix {ok:true} explicit rebind creates a fresh request key', matrixReboundKey, value => (
    /^[a-f0-9]{64}$/.test(String(value)) && String(value) !== matrixBeforeMalformed.key
  ));
  check('lock matrix {ok:true} explicit rebind advances bind + dry-run writes', matrixReboundRevision, matrixStaleMutatedRevision + 2);
  matrixInject(() => ({ok: true}));
  const matrixExplicitOldBase = await runCli([
    'prepare-descriptions',
    '--task-id', matrixTaskId,
    '--store', 'NM',
    '--source-file', cliSourceFile,
    '--expected-revision', String(matrixStaleBase),
  ], {baseUrl: lockProxyBase});
  check('lock matrix {ok:true} refuses old base pin', matrixExplicitOldBase.code, code => code !== 0);
  check('lock matrix {ok:true} old-base error names live revision', matrixExplicitOldBase.stderr, text => text.includes(String(matrixReboundRevision)));
  const matrixAfterOldBase = await matrixSnapshot();
  check('lock matrix {ok:true} old-base refusal keeps new base', matrixAfterOldBase.base, matrixReboundBase);
  check('lock matrix {ok:true} old-base refusal keeps request key', matrixAfterOldBase.key, matrixReboundKey);
  check('lock matrix {ok:true} old-base refusal makes no write', matrixAfterOldBase.revision, matrixReboundRevision);

  // Valid lock controls through the same harness: a fully current lock stays
  // idempotent and a well-formed stale lock (over a really stale task state)
  // rebinds at the live revision.
  matrixInject(({base, live}) => ({ok: true, stale: false, baseTaskRevision: base, currentRevision: live}));
  const matrixCurrentControl = await runCli([
    'prepare-descriptions',
    '--task-id', matrixTaskId,
    '--store', 'NM',
    '--source-file', cliSourceFile,
  ], {baseUrl: lockProxyBase});
  check('lock matrix valid current lock replays idempotently', matrixCurrentControl.code, 0);
  const matrixAfterCurrentControl = await rawTaskById(matrixTaskId);
  check('lock matrix valid current replay keeps request key', String(matrixAfterCurrentControl?.descriptionMaterialBinding?.bindingRequestKey || ''), matrixReboundKey);
  check('lock matrix valid current replay only advances its dry-run write', Number(matrixAfterCurrentControl?.repositoryRevision || 0), matrixReboundRevision + 1);
  const matrixCurrentLive = Number(matrixAfterCurrentControl?.repositoryRevision || 0);
  const matrixStaleControlMutatedRevision = matrixCurrentLive + 5;
  const matrixStaleControlPayload = JSON.parse(JSON.stringify(matrixAfterCurrentControl.openapiPublishPayload));
  matrixStaleControlPayload.skc_list[0].sku_list[0].cost_info.cost_price = '169.00';
  await updateRawTaskById(matrixTaskId, task => ({
    ...task,
    repositoryRevision: matrixStaleControlMutatedRevision,
    openapiPublishPayload: matrixStaleControlPayload,
    publishAssetBinding: updatedPublishAssetBindingFixture(task, matrixStaleControlPayload, {supplyPrice: 169}),
  }));
  matrixInject(({base, live}) => ({ok: false, stale: true, baseTaskRevision: base, currentRevision: live}));
  const matrixStaleControl = await runCli([
    'prepare-descriptions',
    '--task-id', matrixTaskId,
    '--store', 'NM',
    '--source-file', cliSourceFile,
  ], {baseUrl: lockProxyBase});
  check('lock matrix valid stale lock rebinds at live', matrixStaleControl.code, 0);
  const matrixAfterStaleControl = await rawTaskById(matrixTaskId);
  check('lock matrix valid stale rebind recomputes base at live', Number(matrixAfterStaleControl?.descriptionMaterialBinding?.baseTaskRevision || 0), matrixStaleControlMutatedRevision);
  check('lock matrix valid stale rebind advances bind + dry-run writes', Number(matrixAfterStaleControl?.repositoryRevision || 0), matrixStaleControlMutatedRevision + 2);
  lockInjection.mode = 'passthrough';

  // Historical production evidence must not age out behind a fixed audit-tail
  // window. Place the write before more than 10k unrelated entries and prove
  // description binding still fails closed.
  const deepAuditTaskId = await createTask(cookie, 'DESC-DEEP-AUDIT-WRITE');
  await attachPayload(deepAuditTaskId, publishPayloadFor('DESC-DEEP-AUDIT-WRITE'));
  const deepAuditRows = [
    JSON.stringify({
      at: new Date().toISOString(),
      type: 'link-ops-execute',
      task: {id: deepAuditTaskId, writeAudit: {actualWriteSubmitted: true}},
    }),
    ...Array.from({length: 10_001}, (_, index) => JSON.stringify({
      at: new Date().toISOString(),
      type: 'noise',
      task: {id: `unrelated-${index}`},
    })),
  ];
  await fs.appendFile(auditFile, `${deepAuditRows.join('\n')}\n`, 'utf8');
  const deepAuditBind = await bindDescriptions(cookie, deepAuditTaskId);
  check('write evidence older than 10k audit rows still blocks binding', deepAuditBind.status, 409);
  check('deep-audit blocked task receives no description binding', Boolean((await rawTaskById(deepAuditTaskId))?.descriptionMaterialBinding), false);

  const topLevelAuditTaskId = await createTask(cookie, 'DESC-TOP-LEVEL-AUDIT-WRITE');
  await attachPayload(topLevelAuditTaskId, publishPayloadFor('DESC-TOP-LEVEL-AUDIT-WRITE'));
  await fs.appendFile(auditFile, `${JSON.stringify({
    at: new Date().toISOString(),
    type: 'legacy-top-level-execute',
    taskId: topLevelAuditTaskId,
    execution: {state: 'submitted', actualWriteSubmitted: true},
  })}\n`, 'utf8');
  const topLevelAuditBind = await bindDescriptions(cookie, topLevelAuditTaskId);
  check('top-level audit execution evidence blocks binding', topLevelAuditBind.status, 409);
  check('top-level audit blocked task receives no description binding', Boolean((await rawTaskById(topLevelAuditTaskId))?.descriptionMaterialBinding), false);

  const malformedAuditTaskId = await createTask(cookie, 'DESC-MALFORMED-AUDIT');
  await attachPayload(malformedAuditTaskId, publishPayloadFor('DESC-MALFORMED-AUDIT'));
  await fs.appendFile(auditFile, '{malformed-jsonl\n', 'utf8');
  const malformedAuditBind = await bindDescriptions(cookie, malformedAuditTaskId);
  check('malformed non-empty audit row fails binding closed', malformedAuditBind.status, 503);
  check('malformed-audit task receives no description binding', Boolean((await rawTaskById(malformedAuditTaskId))?.descriptionMaterialBinding), false);

  const failed = checks.filter(row => !row.pass);
  for (const row of failed) console.error(`FAIL ${row.label}\n  expected: ${row.expected}\n  actual:   ${row.actual}`);
  console.log(`link_ops_prepare_descriptions_flow: ${checks.length - failed.length}/${checks.length} passed`);
  cleanupOnExit = failed.length === 0;
  if (failed.length) process.exitCode = 1;
} finally {
  const cleanupErrors = [];
  for (const [label, operation] of [
    ['stop isolated description portal', () => stopChild(portal, 'isolated description portal')],
    ['close lock rewrite proxy', () => closeServer(lockProxy, 'lock rewrite proxy')],
    ['close fake OpenAPI server', () => closeServer(fakeOpenApi, 'fake OpenAPI server')],
    ['remove description source detail fixtures', () => removeDescSourceFixtures()],
    ['remove isolated description files', async () => {
      await sleep(250);
      if (cleanupOnExit) await fs.rm(tmpRoot, {recursive: true, force: true});
    }],
  ]) {
    try {
      await operation();
    } catch (error) {
      cleanupErrors.push(new Error(`${label}: ${error?.message || error}`, {cause: error}));
    }
  }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'description flow cleanup failed');
}

async function stopChild(child, label, {graceMs = 5_000, killMs = 2_000} = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  if (await waitForChildExit(child, graceMs)) return;
  child.kill('SIGKILL');
  if (!await waitForChildExit(child, killMs)) {
    throw new Error(`${label} did not exit after SIGKILL`);
  }
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
  });
}

async function closeServer(server, label, {graceMs = 2_000, forceMs = 2_000} = {}) {
  if (!server?.listening) return;
  const closed = new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
  if (await waitForPromise(closed, graceMs)) return;
  server.closeAllConnections?.();
  if (!await waitForPromise(closed, forceMs)) {
    throw new Error(`${label} did not close after terminating connections`);
  }
}

async function waitForPromise(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
