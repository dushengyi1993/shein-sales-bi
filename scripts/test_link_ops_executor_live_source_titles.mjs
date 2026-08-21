#!/usr/bin/env node
/**
 * Proves copy_product_draft can recover from a stale source product cache that
 * only contains an English title. The executor must read the source store's
 * official OpenAPI spu-info endpoint with languageList ['en','ar'] before
 * validating publishOrEdit payload requirements.
 *
 * This test uses:
 * - a fake local SHEIN OpenAPI server,
 * - a fake source store output directory under outputs/ that is removed in
 *   finally,
 * - dry-run mode only; it never calls publishOrEdit.
 */
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {writeOpenApiProductCacheAtomically} from '../lib/shein_openapi_product_cache.mjs';
import {buildProductDraftFromSnapshots} from '../lib/link_ops_product_draft_mapper.mjs';
import {
  DESCRIPTION_PAYLOAD_HASH_ALGORITHM,
  DESCRIPTION_SOURCE_PROOF,
  buildDescriptionPayloadRows,
  describeDescriptionMaterial,
  descriptionBindingRequestKey,
  sha256StableJson,
  sha256Utf8,
} from '../lib/link_ops_product_descriptions.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_STORE = 'Z9T';
const SOURCE_SKC = 'sv99999999999999';
const SOURCE_SPU = 'v99999999999999';
const SOURCE_DETAIL_AT = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const EN_TITLE = 'Live source English title';
const AR_TITLE = 'عنوان عربي من رابط المصدر';
const DESCRIPTION_SOURCE_BYTES = Buffer.from('reviewed live-source-title smoke fixture', 'utf8');
const DESCRIPTION_SOURCE_LABEL = 'live-source-title-reviewed-fixture.html';
const DESCRIPTION_SOURCE_FILE_SHA256 = sha256Utf8(DESCRIPTION_SOURCE_BYTES);
const DESCRIPTION_LINES = Object.freeze({
  ar: Object.freeze([
    'ميزة عربية تجريبية أولى',
    'ميزة عربية تجريبية ثانية',
    'ميزة عربية تجريبية ثالثة',
    'ميزة عربية تجريبية رابعة',
    'ميزة عربية تجريبية خامسة',
  ]),
  en: Object.freeze([
    'Reviewed English feature one',
    'Reviewed English feature two',
    'Reviewed English feature three',
    'Reviewed English feature four',
    'Reviewed English feature five',
  ]),
  'zh-cn': Object.freeze([
    '审核中文卖点一',
    '审核中文卖点二',
    '审核中文卖点三',
    '审核中文卖点四',
    '审核中文卖点五',
  ]),
});
const tmpBase = path.join(ROOT, 'tmp');
await fs.mkdir(tmpBase, {recursive: true});
const tmpRoot = await fs.mkdtemp(path.join(tmpBase, 'link-ops-live-source-title-'));
const testOutputDir = path.join(tmpRoot, 'outputs');
process.env.SHEIN_BI_OUTPUT_DIR = testOutputDir;
process.env.SHEIN_OPENAPI_PRODUCT_CACHE_DIR = testOutputDir;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

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

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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

function sourceSpuInfo({includeArabic = false} = {}) {
  const productMultiNameList = [
    {language: 'en', productName: EN_TITLE},
    ...(includeArabic ? [{language: 'ar', productName: AR_TITLE}] : []),
  ];
  return {
    spuName: SOURCE_SPU,
    categoryId: 123456,
    productTypeId: 789,
    brandCode: 'BRAND_SMOKE',
    productMultiNameList,
    productAttributeInfoList: [
      {attributeId: 1000546, attributeValueId: 0, attributeValue: 'LIVE-MODEL'},
    ],
    skcInfoList: [{
      skcName: SOURCE_SKC,
      supplierCode: 'SRC-LIVE-CODE',
      productMultiNameList,
      skcImageInfoList: [
        {imageType: 1, imageUrl: 'https://example.invalid/live-main.jpg'},
        {imageType: 2, imageUrl: 'https://example.invalid/live-detail.jpg'},
      ],
      saleAttributeList: [{attributeId: 301, attributeValueId: 401}],
      skuInfoList: [{
        supplierSku: 'SRC-LIVE-SKU-001',
        mallState: 1,
        height: 10,
        length: 20,
        width: 30,
        weight: 1.5,
        saleAttributeList: [{attributeId: 301, attributeValueId: 401}],
        costInfoList: [{currency: 'SAR', costPrice: '88.00'}],
      }],
    }],
  };
}

const sourceLinkDir = path.join(testOutputDir, 'shein_links', SOURCE_STORE);
const sourceOpenApiDir = path.join(testOutputDir, 'shein_openapi_products', SOURCE_STORE);

const fakeOpenApiPort = await getFreePort();
const fakeCalls = [];
const fakeOpenApi = http.createServer(async (req, res) => {
  const body = await requestBody(req);
  const pathname = req.url.split('?')[0];
  fakeCalls.push({method: req.method, path: pathname, body: body.json || body.text});
  if (pathname === '/open-api/openapi-business-backend/query-store-info') {
    return sendJson(res, {
      code: '0',
      msg: 'OK',
      info: {accountNo: 'GS8313514', merchantId: '12224658', companyName: '皓兰', shopName: 'HL Smoke'},
    });
  }
  if (pathname === '/open-api/goods/product/check-publish-permission') {
    return sendJson(res, {code: '0', msg: 'OK', info: {canPublishProduct: true, reason: ''}});
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
    return sendJson(res, {code: '0', msg: 'OK', info: [{brand_code: 'BRAND_SMOKE', brand_name: 'Smoke Brand'}]});
  }
  if (pathname === '/open-api/msc/warehouse/list') {
    return sendJson(res, {code: '0', msg: 'OK', info: [{supplier_warehouse_id: 'WH-SMOKE', supplier_warehouse_name: 'Smoke Warehouse'}]});
  }
  if (pathname === '/open-api/goods/spu-info') {
    return sendJson(res, {code: '0', msg: 'OK', info: sourceSpuInfo({includeArabic: true})});
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
          ],
        }],
      },
    });
  }
  if (pathname === '/open-api/goods/searchProduct') {
    return sendJson(res, {code: '0', msg: 'OK', info: {data: [], meta: {count: 0}}});
  }
  if (pathname === '/open-api/goods/product/publishOrEdit') {
    return sendJson(res, {code: '500', msg: 'dry-run test must not publish'}, 500);
  }
  return sendJson(res, {code: '404', msg: `Unhandled fake endpoint: ${pathname}`}, 404);
});

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => resolve({code, stdout, stderr}));
  });
}

const result = {ok: false, tmpRoot, checks: [], fakeOpenApiPort};
function check(label, actual, expected) {
  const pass = typeof expected === 'function' ? expected(actual) : actual === expected;
  result.checks.push({label, actual, expected: typeof expected === 'function' ? expected.name || 'predicate' : expected, pass});
  return pass;
}

try {
  await new Promise(resolve => fakeOpenApi.listen(fakeOpenApiPort, '127.0.0.1', resolve));
  await writeJson(path.join(sourceLinkDir, '2099-01-01.json'), {schemaVersion: 'test-empty-aggregate'});
  await writeOpenApiProductCacheAtomically(path.join(sourceOpenApiDir, 'latest.json'), {
    ok: true,
    schemaVersion: 'shein-openapi-product-basics/v1',
    storeKey: SOURCE_STORE,
    normalizedRows: [{spu: SOURCE_SPU, skc: SOURCE_SKC}],
    detailResults: [{ok: true, detailFetchedAt: SOURCE_DETAIL_AT, info: sourceSpuInfo({includeArabic: false})}],
    detailFallbackResults: [],
  }, {
    storeKey: SOURCE_STORE,
    generatedAt: '2026-08-20T00:00:00+08:00',
  });

  const descriptionMaterial = {
    schemaVersion: 1,
    sourceLabel: DESCRIPTION_SOURCE_LABEL,
    sourceFileSha256: DESCRIPTION_SOURCE_FILE_SHA256,
    rows: Object.fromEntries(Object.entries(DESCRIPTION_LINES).map(([language, lines]) => [language, {
      language,
      lines: [...lines],
      sha256: sha256Utf8(lines.join('\n')),
    }])),
  };
  const descriptionSummary = describeDescriptionMaterial(descriptionMaterial);
  const generatedDraft = await buildProductDraftFromSnapshots({
    sourceStore: SOURCE_STORE,
    sourceSkc: SOURCE_SKC,
    date: 'latest',
    targetStore: 'HL',
  });
  const openapiPublishPayload = {
    ...generatedDraft.openapiPublishPayloadDraft,
    multi_language_desc_list: buildDescriptionPayloadRows(descriptionMaterial),
  };
  const destinationPreparation = {
    targetStore: 'HL',
    titleGroup: 'title1',
    titleEn: EN_TITLE,
    standardGoodsSn: 'SRC-LIVE-CODE',
    supplierSku: 'SRC-LIVE-SKU-001',
    supplyPrice: 88,
    inventory: 100,
  };
  const destinationBindingFingerprint = 'a'.repeat(64);
  const destinationImages = [
    {name: 'live-destination-main.png', role: 'mainCover', imageType: 1, imageUrl: 'https://img.shein.com/live-destination-main.png', width: 900, height: 1200, order: 1},
    {name: 'live-destination-square.png', role: 'squareImage', imageType: 5, imageUrl: 'https://img.shein.com/live-destination-square.png', width: 1254, height: 1254, order: 2},
  ];
  openapiPublishPayload.skc_list[0].image_info = {
    image_info_list: destinationImages.map(row => ({
      image_url: row.imageUrl,
      image_type: row.imageType,
      image_sort: row.order,
    })),
  };
  const destinationImageBinding = {
    schemaVersion: 1,
    sourceApproved: true,
    authority: 'human_reviewed_source',
    targetStore: 'HL',
    boundAt: '2026-08-11T00:00:00.000Z',
    bindingFingerprint: destinationBindingFingerprint,
    imageCount: destinationImages.length,
    images: destinationImages,
    publishPreparation: destinationPreparation,
  };
  const baseTaskRevision = 1;
  const bindingRequestKey = descriptionBindingRequestKey({
    taskId: 'live_source_title_smoke',
    targetStore: 'HL',
    baseTaskRevision,
    contentSha256: descriptionSummary.contentSha256,
    sourceProof: DESCRIPTION_SOURCE_PROOF,
  });

  const configFile = path.join(tmpRoot, 'openapi.json');
  await writeJson(configFile, {
    environment: 'live-source-title-smoke',
    apiBaseUrls: {prodSemiManaged: `http://127.0.0.1:${fakeOpenApiPort}`},
    stores: [
      {storeKey: 'HL', enabled: true, openKeyId: 'dummy-open-key-hl', secretKey: 'dummy-secret-hl'},
      {storeKey: SOURCE_STORE, enabled: true, openKeyId: 'dummy-open-key-source', secretKey: 'dummy-secret-source'},
    ],
  });
  const taskFile = path.join(tmpRoot, 'task.json');
  await writeJson(taskFile, {
    tasks: [{
      id: 'live_source_title_smoke',
      status: 'waiting_review',
      command: `复制 ${SOURCE_STORE} ${SOURCE_SKC} 到 HL`,
      intents: ['copy_product_draft'],
      sourceStore: SOURCE_STORE,
      sourceSkc: SOURCE_SKC,
      repositoryRevision: baseTaskRevision + 1,
      openapiPublishPayload,
      publishAssetBinding: destinationImageBinding,
      descriptionMaterialBinding: {
        authority: 'human_reviewed_source',
        baseTaskRevision,
        bindingRequestKey,
        boundAt: '2026-08-11T00:00:00.000Z',
        boundByUser: 'test-user',
        contentSha256: descriptionSummary.contentSha256,
        hashes: descriptionSummary.hashes,
        imageBindingFingerprint: destinationBindingFingerprint,
        kind: 'copy_product_draft',
        lineCounts: descriptionSummary.lineCounts,
        newPayloadHash: sha256StableJson(openapiPublishPayload),
        payloadHashAlgorithm: DESCRIPTION_PAYLOAD_HASH_ALGORITHM,
        publishLanguages: descriptionSummary.publishLanguages,
        schemaVersion: descriptionSummary.schemaVersion,
        sourceApproved: true,
        sourceByteLength: DESCRIPTION_SOURCE_BYTES.byteLength,
        sourceFileSha256: DESCRIPTION_SOURCE_FILE_SHA256,
        sourceLabel: DESCRIPTION_SOURCE_LABEL,
        sourceProof: DESCRIPTION_SOURCE_PROOF,
        targetStore: 'HL',
      },
      targets: {
        stores: ['HL'],
        writeStores: ['HL'],
        sourceStores: [SOURCE_STORE],
        sourceSkc: SOURCE_SKC,
        productRefs: [SOURCE_SKC],
        publishPreparation: destinationPreparation,
      },
    }],
  });

  const run = await runNode([
    'scripts/link_ops_hl_openapi_executor.mjs',
    '--config', configFile,
    '--task-json', taskFile,
    '--store', 'HL',
    '--dry-run',
    '--out-dir', path.join(tmpRoot, 'logs'),
  ]);
  let output = null;
  try { output = JSON.parse(run.stdout); } catch {}
  check('executor exit code', run.code, 0);
  check('executor parsed output', Boolean(output), true);
  check('dry-run ready for submit', output?.state || '', 'ready_for_submit');
  check('live source spu-info called once', fakeCalls.filter(call => call.path === '/open-api/goods/spu-info').length, 1);
  check('live source request asks en/ar', fakeCalls.find(call => call.path === '/open-api/goods/spu-info')?.body?.languageList || [], value => {
    const xs = asArray(value).map(x => String(x).toLowerCase());
    return xs.includes('en') && xs.includes('ar');
  });
  check('publish endpoint not called in dry-run', fakeCalls.some(call => call.path === '/open-api/goods/product/publishOrEdit'), false);
  check('source live evidence ok', output?.evidence?.sourceLiveSpuInfo?.status || '', 'ok');
  check('exact source lock live SKC matched', output?.evidence?.sourceLiveSpuInfo?.sourceSkcMatched, true);
  check('source live evidence includes ar', output?.evidence?.sourceLiveSpuInfo?.languages || [], value => asArray(value).includes('ar'));
  check('safeDefaults records ar source merge', output?.payload?.safeDefaults || [], value => asArray(value).some(item => String(item).includes('multi_language_name_list.ar.from_source_spu_info')));
  check('payload has two language titles after enrichment', Number(output?.payload?.summary?.nameCount || 0), 2);
  check('publish standard default language is ar', output?.evidence?.publishFillInStandard?.defaultLanguage || '', 'ar');
  check('official call ledger includes source-spu-info-live', output?.openapi?.calls || [], value => asArray(value).some(call => call?.name === 'source-spu-info-live'));
  check('official call ledger includes attribute template', output?.openapi?.calls || [], value => asArray(value).some(call => call?.name === 'query-attribute-template'));
  check('official call ledger includes target duplicate guard', output?.openapi?.calls || [], value => asArray(value).some(call => call?.name === 'search-existing-target-by-supplier-code'));

  const dryRunPayloadHash = output?.payload?.payloadHash || '';
  const publishCallsBeforeExecute = fakeCalls.filter(call => call.path === '/open-api/goods/product/publishOrEdit').length;
  const taskStore = await fs.readFile(taskFile, 'utf8').then(JSON.parse);
  taskStore.executionContext = {expectedPayloadHash: dryRunPayloadHash};
  await writeJson(taskFile, taskStore);
  const executeRun = await runNode([
    'scripts/link_ops_hl_openapi_executor.mjs',
    '--config', configFile,
    '--task-json', taskFile,
    '--store', 'HL',
    '--execute',
    '--confirm', 'SHEIN_OPENAPI_SUBMIT',
    '--out-dir', path.join(tmpRoot, 'logs'),
  ]);
  let executeOutput = null;
  try { executeOutput = JSON.parse(executeRun.stdout); } catch {}
  check('execute regression has matching expected payload hash', dryRunPayloadHash, value => /^[a-f0-9]{64}$/i.test(String(value)));
  check('exact-source execute without productDraftLock is blocked', executeOutput?.state || '', 'blocked');
  check('missing productDraftLock blocker is explicit', executeOutput?.blockers || [], value => asArray(value).some(item => /productDraftLock|expectedPayloadHash/.test(String(item))));
  check('publishOrEdit not called without productDraftLock', fakeCalls.filter(call => call.path === '/open-api/goods/product/publishOrEdit').length, publishCallsBeforeExecute);

  result.stdout = run.stdout.slice(0, 1000);
  result.stderr = run.stderr.slice(0, 1000);
  result.ok = result.checks.every(row => row.pass);
} finally {
  await new Promise(resolve => fakeOpenApi.close(resolve));
  await fs.rm(sourceLinkDir, {recursive: true, force: true});
  await fs.rm(sourceOpenApiDir, {recursive: true, force: true});
}

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);
