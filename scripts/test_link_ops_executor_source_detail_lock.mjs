#!/usr/bin/env node
/**
 * Executor source-detail-lock write gate smoke.
 *
 * The bound/reviewed payload path must keep the mapper-hydrated
 * sourceDetailLock through preflight and execute:
 *
 * 1. fresh (23h) preflight locks the scope-v3 hash and the lock; a fresh
 *    execute reusing the same preflight lock reaches publishOrEdit exactly once;
 * 2. 23h preflight -> 25h bound payload execute blocks before publishOrEdit
 *    with SOURCE_DETAIL_LOCK_EXPIRED (executor level: no publish call issued);
 * 3. same freshness but drifted detail content blocks with
 *    SOURCE_DETAIL_LOCK_CONTENT_DRIFT (scope-v3 hash also invalidates);
 * 4. drifted actual SKC in current detail produces the mapper identity
 *    conflict blocker in total blockers plus SOURCE_DETAIL_LOCK_MISSING, and
 *    no publish call is issued.
 * 5. drifted actual SPU in current detail produces the mapper
 *    SOURCE_DETAIL_CONFLICT_SAME_SKC_WRONG_SPU blocker in total blockers plus
 *    SOURCE_DETAIL_LOCK_MISSING, and no publish call is issued.
 * 6. copy_product_draft requires the current detail lock in BOTH dry-run and
 *    execute: a hash-only legacy preflight without sourceDetailLock forces
 *    re-preflight (SOURCE_DETAIL_LOCK_PREFLIGHT_MISSING); mapper hydration
 *    without a lock blocks both modes.
 * 7. bound hydration that throws (no link snapshot) blocks instead of
 *    continuing on a warning alone.
 *
 * Blocked executes must leave publishResult null and no publishOrEdit entry
 * in the executor call ledger: those two fields are exactly what the
 * Portal/CLI writeAudit uses to derive sheinWriteAttempted=false.
 *
 * Uses a fake local SHEIN OpenAPI server and temporary fixtures; it never
 * calls real SHEIN and never enables real writes.
 */
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  DESCRIPTION_PAYLOAD_HASH_ALGORITHM,
  DESCRIPTION_SOURCE_PROOF,
  buildDescriptionPayloadRows,
  describeDescriptionMaterial,
  descriptionBindingRequestKey,
  sha256StableJson,
  sha256Utf8,
} from '../lib/link_ops_product_descriptions.mjs';

process.env.SHEIN_LINK_OPS_EXECUTOR_SELF_TEST = '1';
const {__testHooks: executorHooks} = await import('../scripts/link_ops_hl_openapi_executor.mjs');
const {__testHooks: portalHooks} = await import('../scripts/serve_bi_portal.mjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_STORE = 'LKD';
const SOURCE_SKC = 'sv20990101000000009';
const SOURCE_SPU = 'v209901010009';
const STANDARD_GOODS_SN = 'LKD-505';
const DATE = '2099-01-01';
const EN_TITLE = 'Source detail lock smoke product';
const AR_TITLE = 'منتج اختبار قفل التفاصيل';
const DESCRIPTION_LINES = Object.freeze({
  ar: Object.freeze(['ميزة عربية أولى', 'ميزة عربية ثانية', 'ميزة عربية ثالثة', 'ميزة عربية رابعة', 'ميزة عربية خامسة']),
  en: Object.freeze(['Reviewed line one', 'Reviewed line two', 'Reviewed line three', 'Reviewed line four', 'Reviewed line five']),
  'zh-cn': Object.freeze(['审核卖点一', '审核卖点二', '审核卖点三', '审核卖点四', '审核卖点五']),
});
const DESCRIPTION_SOURCE_BYTES = Buffer.from('reviewed source-detail-lock smoke fixture', 'utf8');
const DESCRIPTION_SOURCE_LABEL = 'source-detail-lock-reviewed-fixture.html';
const sourceLinkDir = path.join(ROOT, 'outputs', 'shein_links', SOURCE_STORE);
const sourceOpenApiDir = path.join(ROOT, 'outputs', 'shein_openapi_products', SOURCE_STORE);
const tmpBase = path.join(ROOT, 'tmp');
await fs.mkdir(tmpBase, {recursive: true});
const tmpRoot = await fs.mkdtemp(path.join(tmpBase, 'link-ops-source-detail-lock-'));

const nowMs = Date.now();
const FRESH_AT = new Date(nowMs - 23 * 60 * 60 * 1000).toISOString();
const EXPIRED_AT = new Date(nowMs - 25 * 60 * 60 * 1000).toISOString();
const FUTURE_AT = new Date(nowMs + 60 * 60 * 1000).toISOString();

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

function detailInfo({titleSuffix = ''} = {}) {
  return {
    spuName: SOURCE_SPU,
    categoryId: 123456,
    productTypeId: 789,
    brandCode: 'BRAND_SMOKE',
    productMultiNameList: [
      {language: 'en', productName: `${EN_TITLE}${titleSuffix}`},
      {language: 'ar', productName: AR_TITLE},
    ],
    productAttributeInfoList: [
      {attributeId: 1000546, attributeValueId: 0, attributeValue: 'LKD-MODEL'},
    ],
    skcInfoList: [{
      skcName: SOURCE_SKC,
      supplierCode: 'SRC-LKD-CODE',
      skcImageInfoList: [
        {imageType: 1, imageUrl: 'https://example.invalid/lock-main.jpg'},
        {imageType: 2, imageUrl: 'https://example.invalid/lock-detail.jpg'},
        {imageType: 5, imageUrl: 'https://example.invalid/lock-square.jpg'},
      ],
      saleAttributeList: [{attributeId: 301, attributeValueId: 401}],
      skuInfoList: [{
        supplierSku: 'SRC-LKD-SKU-001',
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

function publishPayload() {
  return {
    category_id: 123456,
    product_type_id: 789,
    source_system: 'OpenAPI',
    brand_code: 'BRAND_SMOKE',
    site_list: [{main_site: 'shein', sub_site_list: ['shein-sa']}],
    multi_language_name_list: [
      {language: 'en', product_name: EN_TITLE},
      {language: 'ar', product_name: AR_TITLE},
    ],
    product_attribute_list: [
      {attribute_id: 101, attribute_value_id: 202},
      {attribute_id: 1000546, attribute_value_id: 0, attribute_value: 'LKD-MODEL'},
    ],
    shelf_way: 2,
    hope_on_sale_date: '2036-06-27 10:00:00',
    skc_list: [{
      supplier_code: 'HL-LOCK-SMOKE-SKC',
      image_info: {
        image_info_list: [
          {image_type: 1, image_sort: 1, image_url: 'https://example.invalid/smoke-main.jpg'},
          {image_type: 5, image_sort: 2, image_url: 'https://example.invalid/smoke-square.jpg'},
        ],
      },
      sale_attribute: {attribute_id: 301, attribute_value_id: 401},
      sku_list: [{
        supplier_sku: 'HL-LOCK-SMOKE-SKU-001',
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

const descriptionMaterial = {
  schemaVersion: 1,
  sourceLabel: DESCRIPTION_SOURCE_LABEL,
  sourceFileSha256: sha256Utf8(DESCRIPTION_SOURCE_BYTES),
  rows: Object.fromEntries(Object.entries(DESCRIPTION_LINES).map(([language, lines]) => [language, {
    language,
    lines: [...lines],
    sha256: sha256Utf8(lines.join('\n')),
  }])),
};
const descriptionSummary = describeDescriptionMaterial(descriptionMaterial);
const boundPayload = publishPayload();
boundPayload.multi_language_desc_list = buildDescriptionPayloadRows(descriptionMaterial);
const baseTaskRevision = 1;
const descriptionMaterialBinding = {
  authority: 'human_reviewed_source',
  baseTaskRevision,
  bindingRequestKey: descriptionBindingRequestKey({
    taskId: 'source_detail_lock_smoke',
    targetStore: 'HL',
    baseTaskRevision,
    contentSha256: descriptionSummary.contentSha256,
    sourceProof: DESCRIPTION_SOURCE_PROOF,
  }),
  boundAt: '2026-08-11T00:00:00.000Z',
  boundByUser: 'test-user',
  contentSha256: descriptionSummary.contentSha256,
  hashes: descriptionSummary.hashes,
  imageBindingFingerprint: '',
  kind: 'copy_product_draft',
  lineCounts: descriptionSummary.lineCounts,
  newPayloadHash: sha256StableJson(boundPayload),
  payloadHashAlgorithm: DESCRIPTION_PAYLOAD_HASH_ALGORITHM,
  publishLanguages: descriptionSummary.publishLanguages,
  schemaVersion: descriptionSummary.schemaVersion,
  sourceApproved: true,
  sourceByteLength: DESCRIPTION_SOURCE_BYTES.byteLength,
  sourceFileSha256: sha256Utf8(DESCRIPTION_SOURCE_BYTES),
  sourceLabel: DESCRIPTION_SOURCE_LABEL,
  sourceProof: DESCRIPTION_SOURCE_PROOF,
  targetStore: 'HL',
};

const fakeOpenApiPort = await getFreePort();
const fakeCalls = [];
let publishAttemptCount = 0;
const fakeOpenApi = http.createServer(async (req, res) => {
  const body = await requestBody(req);
  const pathname = req.url.split('?')[0];
  fakeCalls.push({method: req.method, path: pathname, body: body.json || body.text});
  if (pathname === '/open-api/openapi-business-backend/query-store-info') {
    return sendJson(res, {
      code: '0',
      msg: 'OK',
      info: {accountNo: 'GS8313514', merchantId: '12224658', companyName: '皓兰', shopName: 'Lock Smoke HL'},
    });
  }
  if (pathname === '/open-api/goods/product/check-publish-permission') {
    return sendJson(res, {code: '0', msg: 'OK', info: {canPublishProduct: true, reason: ''}});
  }
  if (pathname === '/open-api/goods/query-site-list') {
    return sendJson(res, {
      code: '0',
      msg: 'OK',
      info: [{main_site: 'shein', main_site_name: 'SHEIN', sub_site_list: [{site_abbr: 'shein-sa', site_name: 'SHEIN Saudi Arabia', currency: 'SAR', site_status: 1}]}],
    });
  }
  if (pathname === '/open-api/goods/query-brand-list') {
    return sendJson(res, {code: '0', msg: 'OK', info: [{brand_code: 'BRAND_SMOKE', brand_name: 'Smoke Brand'}]});
  }
  if (pathname === '/open-api/msc/warehouse/list') {
    return sendJson(res, {code: '0', msg: 'OK', info: [{supplier_warehouse_id: 'WH-SMOKE', supplier_warehouse_name: 'Smoke Warehouse', status: 1}]});
  }
  if (pathname === '/open-api/goods/spu-info') {
    return sendJson(res, {code: '0', msg: 'OK', info: detailInfo()});
  }
  if (pathname === '/open-api/goods/query-publish-fill-in-standard') {
    return sendJson(res, {
      code: '0',
      msg: 'OK',
      info: {
        default_language: 'ar',
        default_language_title_max_length: 325,
        language_title_max_length_list: [{language: 'ar', max_length: 325}, {language: 'en', max_length: 250}],
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
    publishAttemptCount += 1;
    return sendJson(res, {code: '500', msg: 'detail-lock smoke fake publish', traceId: 'trace-lock-smoke'}, 200);
  }
  return sendJson(res, {code: '404', msg: `Unhandled fake endpoint: ${pathname}`}, 404);
});

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SHEIN_LINK_OPS_EXECUTOR_SELF_TEST: '',
        NODE_ENV: 'test',
        SHEIN_BI_TEST_ALLOW_FAKE_WEBHOOK_GATE: '1',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => resolve({code, stdout, stderr}));
  });
}

async function writeDetail({detailFetchedAt = FRESH_AT, info = detailInfo(), detailResults = undefined} = {}) {
  await writeJson(path.join(sourceOpenApiDir, 'latest.json'), {
    schemaVersion: 'shein-openapi-product-basics/v1',
    storeKey: SOURCE_STORE,
    fetchedAt: detailFetchedAt,
    normalizedRows: [{spu: SOURCE_SPU, skc: SOURCE_SKC}],
    detailResults: detailResults === undefined ? [{ok: true, detailFetchedAt, info}] : detailResults,
    detailFallbackResults: [],
  });
}

function baseTask() {
  return {
    id: 'source_detail_lock_smoke',
    status: 'waiting_review',
    createdAt: '2026-08-11T00:00:00.000Z',
    command: `复制 ${SOURCE_STORE} ${SOURCE_SKC} 到 HL`,
    intents: ['copy_product_draft'],
    sourceStore: SOURCE_STORE,
    sourceSkc: SOURCE_SKC,
    openapiPublishPayload: JSON.parse(JSON.stringify(boundPayload)),
    descriptionMaterialBinding,
    targets: {
      stores: ['HL'],
      writeStores: ['HL'],
      sourceStores: [SOURCE_STORE],
      sourceSkc: SOURCE_SKC,
      productRefs: [SOURCE_SKC],
    },
  };
}

async function runExecutor({label, mode, executionContext = null, task = null, expectedPayloadHash = ''}) {
  const storeFile = path.join(tmpRoot, `task-${label.replace(/[^a-z0-9]+/gi, '-')}.json`);
  await writeJson(storeFile, {
    version: 1,
    updatedAt: null,
    ...(executionContext ? {executionContext} : {}),
    tasks: [task || baseTask()],
  });
  const args = [
    'scripts/link_ops_hl_openapi_executor.mjs',
    '--config', configFile,
    '--task-json', storeFile,
    '--store', 'HL',
    mode === 'execute' ? '--execute' : '--dry-run',
    ...(mode === 'execute' ? ['--confirm', 'SHEIN_OPENAPI_SUBMIT'] : []),
    '--out-dir', path.join(tmpRoot, `logs-${label.replace(/[^a-z0-9]+/gi, '-')}`),
  ];
  const run = await runNode(args);
  let output = null;
  try { output = JSON.parse(run.stdout); } catch {}
  return {run, output};
}

const result = {ok: false, tmpRoot, checks: [], fakeOpenApiPort};
function check(label, actual, expected) {
  const pass = typeof expected === 'function' ? expected(actual) : actual === expected;
  result.checks.push({label, actual, expected: typeof expected === 'function' ? expected.name || 'predicate' : expected, pass});
  return pass;
}

// Executor-level write-evidence assertions: publishResult null plus no
// publishOrEdit ledger entry is the exact signal the Portal/CLI layer uses to
// derive writeAudit.sheinWriteAttempted=false.
function checkNoPublishEvidence(prefix, output, beforeCount) {
  check(`${prefix} publishResult absent`, output?.publishResult ?? null, null);
  check(`${prefix} openapi calls exclude publishOrEdit`, (output?.openapi?.calls || []).some(call => call?.path === '/open-api/goods/product/publishOrEdit'), false);
  check(`${prefix} does not publish`, publishAttemptCount, beforeCount);
}

const configFile = path.join(tmpRoot, 'openapi.json');

try {
  await new Promise(resolve => fakeOpenApi.listen(fakeOpenApiPort, '127.0.0.1', resolve));
  await writeJson(configFile, {
    environment: 'source-detail-lock-smoke',
    apiBaseUrls: {prodSemiManaged: `http://127.0.0.1:${fakeOpenApiPort}`},
    stores: [
      {storeKey: 'HL', enabled: true, openKeyId: 'dummy-open-key-hl', secretKey: 'dummy-secret-hl'},
      {storeKey: SOURCE_STORE, enabled: true, openKeyId: 'dummy-open-key-source', secretKey: 'dummy-secret-source'},
    ],
  });
  await writeJson(path.join(sourceLinkDir, `${DATE}.json`), {
    linkRows: [{
      storeKey: SOURCE_STORE,
      skc: SOURCE_SKC,
      spu: SOURCE_SPU,
      standardGoodsSn: STANDARD_GOODS_SN,
      productNameCn: 'LKD锁测试',
      rawGoodsSn: 'SOURCE-RAW-LKD-505',
    }],
    inventoryRows: [],
    performanceRows: [],
  });

  // Unit checks for the gate itself (no I/O).
  const gate = executorHooks.validateSourceDetailLockForWrite;
  const baseLock = {
    source: 'openapi_product_detail_snapshot',
    matchedSpuName: SOURCE_SPU,
    matchedSkcName: SOURCE_SKC,
    detailFetchedAt: FRESH_AT,
    detailContentSha256: executorHooks.sha256Stable({info: {spuName: SOURCE_SPU}, matchedSkcName: SOURCE_SKC}),
  };
  check('gate inactive without preflight lock', gate({currentLock: baseLock, expectedLock: null}).gateActive, false);
  check('gate missing lock blocks', gate({currentLock: null, expectedLock: baseLock, sourceSkc: SOURCE_SKC}).blockers.map(b => b.code), codes => codes.includes('SOURCE_DETAIL_LOCK_MISSING'));
  check('gate expired blocks', gate({currentLock: {...baseLock, detailFetchedAt: EXPIRED_AT}, expectedLock: baseLock}).blockers.map(b => b.code), codes => codes.includes('SOURCE_DETAIL_LOCK_EXPIRED'));
  check('gate future blocks', gate({currentLock: {...baseLock, detailFetchedAt: new Date(Date.now() + 60_000).toISOString()}, expectedLock: baseLock}).blockers.map(b => b.code), codes => codes.includes('SOURCE_DETAIL_LOCK_FUTURE'));
  check('gate invalid timestamp blocks', gate({currentLock: {...baseLock, detailFetchedAt: 'not-a-date'}, expectedLock: baseLock}).blockers.map(b => b.code), codes => codes.includes('SOURCE_DETAIL_LOCK_TIMESTAMP_INVALID'));
  check('gate array timestamp blocks', gate({currentLock: {...baseLock, detailFetchedAt: [FRESH_AT]}, expectedLock: baseLock}).blockers.map(b => b.code), codes => codes.includes('SOURCE_DETAIL_LOCK_TIMESTAMP_INVALID'));
  check('gate object timestamp blocks', gate({currentLock: {...baseLock, detailFetchedAt: {value: FRESH_AT}}, expectedLock: baseLock}).blockers.map(b => b.code), codes => codes.includes('SOURCE_DETAIL_LOCK_TIMESTAMP_INVALID'));
  check('gate future expected timestamp blocks', gate({currentLock: baseLock, expectedLock: {...baseLock, detailFetchedAt: FUTURE_AT}, sourceStore: SOURCE_STORE, sourceSkc: SOURCE_SKC}).blockers.map(b => b.code), codes => codes.includes('SOURCE_DETAIL_LOCK_PREFLIGHT_FUTURE'));
  check('gate expired expected timestamp blocks', gate({currentLock: baseLock, expectedLock: {...baseLock, detailFetchedAt: EXPIRED_AT}, sourceStore: SOURCE_STORE, sourceSkc: SOURCE_SKC}).blockers.map(b => b.code), codes => codes.includes('SOURCE_DETAIL_LOCK_PREFLIGHT_EXPIRED'));
  check('gate content drift blocks', gate({currentLock: {...baseLock, detailContentSha256: 'f'.repeat(64)}, expectedLock: baseLock}).blockers.map(b => b.code), codes => codes.includes('SOURCE_DETAIL_LOCK_CONTENT_DRIFT'));
  check('gate SKC drift blocks', gate({currentLock: {...baseLock, matchedSkcName: 'sv-drifted'}, expectedLock: baseLock, sourceSkc: SOURCE_SKC}).blockers.map(b => b.code), codes => codes.includes('SOURCE_DETAIL_LOCK_IDENTITY_DRIFT'));
  check('gate fresh lock passes', gate({currentLock: baseLock, expectedLock: baseLock, sourceStore: SOURCE_STORE, sourceSkc: SOURCE_SKC}), value => value.ok === true && value.gateActive === true);
  const requiredGateScope = {required: true, sourceStore: SOURCE_STORE, sourceSkc: SOURCE_SKC, standardGoodsSn: STANDARD_GOODS_SN};
  check('gate required without expected allows fresh current lock', gate({currentLock: baseLock, expectedLock: null, ...requiredGateScope}), value => value.ok === true && value.gateActive === true && value.blockers.length === 0);
  check('gate required without current lock blocks', gate({currentLock: null, expectedLock: null, ...requiredGateScope}).blockers.map(b => b.code), codes => codes.includes('SOURCE_DETAIL_LOCK_MISSING'));
  check('gate requireExpectedLock without expected blocks', gate({currentLock: baseLock, expectedLock: null, requireExpectedLock: true, ...requiredGateScope}).blockers.map(b => b.code), codes => codes.includes('SOURCE_DETAIL_LOCK_PREFLIGHT_MISSING'));
  check('gate required expired without expected blocks', gate({currentLock: {...baseLock, detailFetchedAt: EXPIRED_AT}, expectedLock: null, ...requiredGateScope}).blockers.map(b => b.code), codes => codes.includes('SOURCE_DETAIL_LOCK_EXPIRED'));
  for (const [label, currentLock] of [
    ['missing source', {...baseLock, source: ''}],
    ['missing SPU', {...baseLock, matchedSpuName: ''}],
    ['missing SKC', {...baseLock, matchedSkcName: ''}],
    ['invalid content SHA', {...baseLock, detailContentSha256: 'not-sha256'}],
  ]) {
    check(`gate required ${label} blocks`, gate({currentLock, expectedLock: null, ...requiredGateScope}).blockers.map(b => b.code), codes => codes.includes('SOURCE_DETAIL_LOCK_SCOPE_INVALID'));
  }
  check('gate required missing sourceStore blocks', gate({currentLock: baseLock, expectedLock: null, ...requiredGateScope, sourceStore: ''}).blockers.map(b => b.code), codes => codes.includes('SOURCE_DETAIL_LOCK_SCOPE_INVALID'));
  check('gate required missing sourceSkc blocks', gate({currentLock: baseLock, expectedLock: null, ...requiredGateScope, sourceSkc: ''}).blockers.map(b => b.code), codes => codes.includes('SOURCE_DETAIL_LOCK_SCOPE_INVALID'));
  check('gate required missing standard goods number blocks', gate({currentLock: baseLock, expectedLock: null, ...requiredGateScope, standardGoodsSn: ''}).blockers.map(b => b.code), codes => codes.includes('SOURCE_DETAIL_LOCK_SCOPE_INVALID'));
  check('gate required malformed sourceStore blocks', gate({currentLock: baseLock, expectedLock: null, ...requiredGateScope, sourceStore: '???'}).blockers.map(b => b.code), codes => codes.includes('SOURCE_DETAIL_LOCK_SCOPE_INVALID'));
  check('gate required malformed sourceSkc blocks', gate({currentLock: baseLock, expectedLock: null, ...requiredGateScope, sourceSkc: 'not-a-skc'}).blockers.map(b => b.code), codes => codes.includes('SOURCE_DETAIL_LOCK_SCOPE_INVALID'));
  check('gate required malformed standard goods number blocks', gate({currentLock: baseLock, expectedLock: null, ...requiredGateScope, standardGoodsSn: '???'}).blockers.map(b => b.code), codes => codes.includes('SOURCE_DETAIL_LOCK_SCOPE_INVALID'));
  for (const [label, standardGoodsSn] of [
    ['array standard goods number', [STANDARD_GOODS_SN]],
    ['object standard goods number', {value: STANDARD_GOODS_SN}],
  ]) {
    check(`gate required ${label} blocks`, gate({currentLock: baseLock, expectedLock: null, ...requiredGateScope, standardGoodsSn}).blockers.map(b => b.code), codes => codes.includes('SOURCE_DETAIL_LOCK_SCOPE_INVALID'));
  }
  for (const codePoint of [0x09, 0x0a, 0x0d]) {
    const controlValue = `ABC${String.fromCharCode(codePoint)}DEF`;
    check(`gate required standard goods control U+${codePoint.toString(16).padStart(4, '0')} blocks`, gate({currentLock: baseLock, expectedLock: null, ...requiredGateScope, standardGoodsSn: controlValue}).blockers.map(b => b.code), codes => codes.includes('SOURCE_DETAIL_LOCK_SCOPE_INVALID'));
  }
  check('gate required malformed source enum blocks', gate({currentLock: {...baseLock, source: 'evil_source'}, expectedLock: null, ...requiredGateScope}).blockers.map(b => b.code), codes => codes.includes('SOURCE_DETAIL_LOCK_SCOPE_INVALID'));
  check('gate required malformed SPU blocks', gate({currentLock: {...baseLock, matchedSpuName: 'not-spu'}, expectedLock: null, ...requiredGateScope}).blockers.map(b => b.code), codes => codes.includes('SOURCE_DETAIL_LOCK_SCOPE_INVALID'));
  check('gate required malformed lock SKC blocks', gate({currentLock: {...baseLock, matchedSkcName: 'not-a-skc'}, expectedLock: null, ...requiredGateScope}).blockers.map(b => b.code), codes => codes.includes('SOURCE_DETAIL_LOCK_SCOPE_INVALID'));
  check('gate required sourceStore trailing LF blocks', gate({currentLock: baseLock, expectedLock: null, ...requiredGateScope, sourceStore: `${SOURCE_STORE}\n`}).blockers.map(b => b.code), codes => codes.includes('SOURCE_DETAIL_LOCK_SCOPE_INVALID'));
  check('gate required sourceSkc trailing LF blocks', gate({currentLock: baseLock, expectedLock: null, ...requiredGateScope, sourceSkc: `${SOURCE_SKC}\n`}).blockers.map(b => b.code), codes => codes.includes('SOURCE_DETAIL_LOCK_SCOPE_INVALID'));
  for (const [label, currentLock] of [
    ['source trailing LF', {...baseLock, source: `${baseLock.source}\n`}],
    ['SPU trailing LF', {...baseLock, matchedSpuName: `${baseLock.matchedSpuName}\n`}],
    ['SKC trailing LF', {...baseLock, matchedSkcName: `${baseLock.matchedSkcName}\n`}],
    ['SHA trailing LF', {...baseLock, detailContentSha256: `${baseLock.detailContentSha256}\n`}],
  ]) {
    check(`gate required ${label} blocks`, gate({currentLock, expectedLock: null, ...requiredGateScope}).blockers.map(b => b.code), codes => codes.includes('SOURCE_DETAIL_LOCK_SCOPE_INVALID'));
    check(`gate expected ${label} blocks`, gate({currentLock: baseLock, expectedLock: currentLock, ...requiredGateScope}).blockers.map(b => b.code), codes => codes.includes('SOURCE_DETAIL_LOCK_PREFLIGHT_INVALID'));
  }
  check('gate invalid expected lock blocks', gate({currentLock: baseLock, expectedLock: {...baseLock, source: ''}, ...requiredGateScope}).blockers.map(b => b.code), codes => codes.includes('SOURCE_DETAIL_LOCK_PREFLIGHT_INVALID'));
  check('gate source type drift blocks', gate({currentLock: baseLock, expectedLock: {...baseLock, source: 'different_source'}, ...requiredGateScope}).blockers.map(b => b.code), codes => codes.includes('SOURCE_DETAIL_LOCK_IDENTITY_DRIFT'));
  check('hash scope excludes observation timestamp', executorHooks.sourceDetailLockExecutionHashScope(baseLock), value => !Object.prototype.hasOwnProperty.call(value || {}, 'detailFetchedAt'));
  check('hash scope preserves source identity and content', executorHooks.sourceDetailLockExecutionHashScope(baseLock), value => value?.source === baseLock.source
    && value?.matchedSkcName === SOURCE_SKC
    && value?.matchedSpuName === SOURCE_SPU
    && value?.detailContentSha256 === baseLock.detailContentSha256);
  const baseExecutionScope = executorHooks.buildProductExecutionHashScope({
    payload: {category_id: 1},
    targetStore: 'HL',
    sourceStore: SOURCE_STORE,
    sourceSkc: SOURCE_SKC,
    standardGoodsSn: STANDARD_GOODS_SN,
    sourceDetailLock: baseLock,
  });
  const baseExecutionHash = executorHooks.sha256Stable(baseExecutionScope);
  check('scope-v3 schema is hash-domain separated', baseExecutionScope.schema, executorHooks.PRODUCT_EXECUTION_HASH_SCHEMA);
  check('scope-v3 algorithm constant', executorHooks.PRODUCT_EXECUTION_HASH_ALGORITHM, 'sha256-stable-json-scope-v3');
  const portalHashTask = algorithm => ({
    execution: {
      openApiProductExecutors: [{
        storeKey: 'HL',
        payload: {payloadHash: 'a'.repeat(64), payloadHashAlgorithm: algorithm},
      }],
    },
  });
  check('portal accepts current scope-v3 hash', portalHooks.payloadHashForStoreFromTaskExecution(portalHashTask('sha256-stable-json-scope-v3'), 'HL'), 'a'.repeat(64));
  check('portal rejects legacy scope-v2 hash', portalHooks.payloadHashForStoreFromTaskExecution(portalHashTask('sha256-stable-json-scope-v2'), 'HL'), '');
  check('portal rejects missing hash algorithm', portalHooks.payloadHashForStoreFromTaskExecution(portalHashTask(''), 'HL'), '');
  const portalMissingStoreTask = portalHashTask('sha256-stable-json-scope-v3');
  delete portalMissingStoreTask.execution.openApiProductExecutors[0].storeKey;
  check('portal rejects unique executor row missing storeKey', portalHooks.payloadHashForStoreFromTaskExecution(portalMissingStoreTask, 'HL'), '');
  for (const [label, mutate] of [
    ['payload hash array', task => { task.execution.openApiProductExecutors[0].payload.payloadHash = ['a'.repeat(64)]; }],
    ['payload hash object', task => { task.execution.openApiProductExecutors[0].payload.payloadHash = {value: 'a'.repeat(64)}; }],
    ['payload hash algorithm array', task => { task.execution.openApiProductExecutors[0].payload.payloadHashAlgorithm = ['sha256-stable-json-scope-v3']; }],
    ['payload hash algorithm object', task => { task.execution.openApiProductExecutors[0].payload.payloadHashAlgorithm = {value: 'sha256-stable-json-scope-v3'}; }],
  ]) {
    const pollutedTask = portalHashTask('sha256-stable-json-scope-v3');
    mutate(pollutedTask);
    check(`portal rejects ${label}`, portalHooks.payloadHashForStoreFromTaskExecution(pollutedTask, 'HL'), '');
  }
  const projectedHistoryEvidence = portalHooks.projectProductExecutorHistoryEvidence({
    mode: 'dry-run',
    result: {
      storeKey: 'HL',
      sourceStore: SOURCE_STORE,
      sourceSkc: SOURCE_SKC,
      payload: {
        found: true,
        payloadHash: 'a'.repeat(64),
        payloadHashAlgorithm: 'sha256-stable-json-scope-v3',
        sourceDetailLock: baseLock,
      },
    },
  });
  check('portal history projection preserves scope-v3 algorithm', projectedHistoryEvidence.payloadHashAlgorithm, 'sha256-stable-json-scope-v3');
  check('portal history projection preserves exact source store', projectedHistoryEvidence.sourceStore, SOURCE_STORE);
  check('portal history projection preserves exact source SKC', projectedHistoryEvidence.sourceSkc, SOURCE_SKC);
  check('portal history projection preserves full source lock', projectedHistoryEvidence.payload?.sourceDetailLock, value => value?.detailFetchedAt === baseLock.detailFetchedAt
    && value?.detailContentSha256 === baseLock.detailContentSha256
    && Object.keys(value || {}).length === 5);
  check('scope-v3 timestamp-only projection is stable', executorHooks.sha256Stable(executorHooks.buildProductExecutionHashScope({
    ...baseExecutionScope,
    sourceDetailLock: {...baseLock, detailFetchedAt: new Date().toISOString()},
  })), baseExecutionHash);
  const spaceStandardHash = executorHooks.sha256Stable(executorHooks.buildProductExecutionHashScope({...baseExecutionScope, standardGoodsSn: 'ABC DEF'}));
  const controlStandardHash = executorHooks.sha256Stable(executorHooks.buildProductExecutionHashScope({...baseExecutionScope, standardGoodsSn: 'ABC\nDEF'}));
  check('scope-v3 standard goods control cannot collide with space', controlStandardHash !== spaceStandardHash, true);
  const stringStandardHash = executorHooks.sha256Stable(executorHooks.buildProductExecutionHashScope({...baseExecutionScope, standardGoodsSn: STANDARD_GOODS_SN}));
  const arrayStandardHash = executorHooks.sha256Stable(executorHooks.buildProductExecutionHashScope({...baseExecutionScope, standardGoodsSn: [STANDARD_GOODS_SN]}));
  const objectStandardHash = executorHooks.sha256Stable(executorHooks.buildProductExecutionHashScope({...baseExecutionScope, standardGoodsSn: {value: STANDARD_GOODS_SN}}));
  check('scope-v3 array standard goods cannot collide with string', arrayStandardHash !== stringStandardHash, true);
  check('scope-v3 object standard goods cannot collide with string', objectStandardHash !== stringStandardHash, true);
  check('scope-v3 array and object standard goods cannot collide', arrayStandardHash !== objectStandardHash, true);
  for (const [label, scope] of [
    ['sourceStore control', {...baseExecutionScope, sourceStore: `${SOURCE_STORE}\n`}],
    ['sourceSkc control', {...baseExecutionScope, sourceSkc: `${SOURCE_SKC}\n`}],
    ['source type control', {...baseExecutionScope, sourceDetailLock: {...baseLock, source: `${baseLock.source}\n`}}],
    ['source SPU control', {...baseExecutionScope, sourceDetailLock: {...baseLock, matchedSpuName: `${SOURCE_SPU}\n`}}],
    ['source SKC control', {...baseExecutionScope, sourceDetailLock: {...baseLock, matchedSkcName: `${SOURCE_SKC}\n`}}],
    ['source SHA control', {...baseExecutionScope, sourceDetailLock: {...baseLock, detailContentSha256: `${baseLock.detailContentSha256}\n`}}],
  ]) {
    check(`scope-v3 ${label} cannot collide`, executorHooks.sha256Stable(executorHooks.buildProductExecutionHashScope(scope)) !== baseExecutionHash, true);
  }
  for (const [label, scope] of [
    ['body', {...baseExecutionScope, payload: {category_id: 2}}],
    ['targetStore', {...baseExecutionScope, targetStore: 'QH'}],
    ['sourceStore', {...baseExecutionScope, sourceStore: 'DIFFERENT'}],
    ['sourceSkc', {...baseExecutionScope, sourceSkc: 'sv-different'}],
    ['standardGoodsSn', {...baseExecutionScope, standardGoodsSn: 'DIFFERENT-GOODS'}],
    ['source type', {...baseExecutionScope, sourceDetailLock: {...baseLock, source: 'different_source'}}],
    ['source SPU', {...baseExecutionScope, sourceDetailLock: {...baseLock, matchedSpuName: 'v-different'}}],
    ['source SKC', {...baseExecutionScope, sourceDetailLock: {...baseLock, matchedSkcName: 'sv-different'}}],
    ['source content', {...baseExecutionScope, sourceDetailLock: {...baseLock, detailContentSha256: 'f'.repeat(64)}}],
  ]) {
    check(`scope-v3 ${label} drift changes hash`, executorHooks.sha256Stable(executorHooks.buildProductExecutionHashScope(scope)) !== baseExecutionHash, true);
  }

  // Preflight with a 23h-fresh detail locks scope-v3 + sourceDetailLock.
  await writeDetail({detailFetchedAt: FRESH_AT});
  const preflight = await runExecutor({label: 'preflight', mode: 'dry-run'});
  const preflightOutput = preflight.output;
  if (!preflightOutput) {
    result.debug = {stdout: preflight.run.stdout.slice(0, 4000), stderr: preflight.run.stderr.slice(0, 4000), code: preflight.run.code};
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  check('preflight exit code', preflight.run.code, 0);
  check('preflight parsed output', Boolean(preflightOutput), true);
  check('preflight ready for submit', preflightOutput?.state || '', 'ready_for_submit');
  check('preflight no blockers', preflightOutput?.blockers?.length || 0, 0);
  check('preflight locks scope-v3 hash', preflightOutput?.payload?.payloadHash || '', value => /^[a-f0-9]{64}$/.test(String(value)));
  check('preflight declares scope-v3 algorithm', preflightOutput?.payload?.payloadHashAlgorithm || '', 'sha256-stable-json-scope-v3');
  check('preflight payload carries sourceDetailLock', Boolean(preflightOutput?.payload?.sourceDetailLock), true);
  check('preflight lock matched SKC', preflightOutput?.payload?.sourceDetailLock?.matchedSkcName, SOURCE_SKC);
  check('preflight lock content hash is sha256', preflightOutput?.payload?.sourceDetailLock?.detailContentSha256 || '', value => /^[a-f0-9]{64}$/.test(String(value)));
  check('preflight structured mapping blockers empty', preflightOutput?.payload?.mappingBlockers?.length || 0, 0);
  check('publish not called in dry-run', publishAttemptCount, 0);

  const executeContext = {
    expectedPayloadHash: preflightOutput.payload.payloadHash,
    reusePreflightLock: true,
  };
  const executionRow = {
    storeKey: 'HL',
    state: 'preflight_ready',
    runId: preflightOutput.runId,
    result: preflightOutput,
  };
  const executeTask = () => {
    const task = baseTask();
    task.execution = {
      state: 'preflight_ready',
      preflight: {ok: true, blockers: [], warnings: []},
      openApiProductExecutors: [executionRow],
    };
    return task;
  };
  const resolvedCurrentLock = executorHooks.resolvePreflightProductLock(executeTask(), 'HL', {
    expectedPayloadHash: preflightOutput.payload.payloadHash,
  });
  check('current execution resolver restores v3 lock', resolvedCurrentLock, value => value?.payloadHashAlgorithm === 'sha256-stable-json-scope-v3'
    && value?.sourceDetailLock?.detailContentSha256 === preflightOutput.payload.sourceDetailLock.detailContentSha256);
  check('resolver rejects array expectedPayloadHash', executorHooks.resolvePreflightProductLock(executeTask(), 'HL', {
    expectedPayloadHash: [preflightOutput.payload.payloadHash],
  }), null);
  check('resolver rejects object expectedPayloadHash', executorHooks.resolvePreflightProductLock(executeTask(), 'HL', {
    expectedPayloadHash: {value: preflightOutput.payload.payloadHash},
  }), null);
  const currentMissingStoreTask = JSON.parse(JSON.stringify(executeTask()));
  delete currentMissingStoreTask.execution.openApiProductExecutors[0].storeKey;
  delete currentMissingStoreTask.execution.openApiProductExecutors[0].result.storeKey;
  check('current execution resolver rejects missing storeKey', executorHooks.resolvePreflightProductLock(currentMissingStoreTask, 'HL', {
    expectedPayloadHash: preflightOutput.payload.payloadHash,
  }), null);
  const beforeCurrentMissingStore = publishAttemptCount;
  const currentMissingStoreRun = await runExecutor({
    label: 'execute-current-missing-store-key',
    mode: 'execute',
    executionContext: executeContext,
    task: currentMissingStoreTask,
  });
  check('current missing storeKey execute blocked', currentMissingStoreRun.output?.state || '', 'blocked');
  check('current missing storeKey forces re-preflight', currentMissingStoreRun.output?.evidence?.sourceDetailLockGate?.blockers?.map(b => b.code) || [], codes => codes.includes('SOURCE_DETAIL_LOCK_PREFLIGHT_MISSING'));
  checkNoPublishEvidence('current missing storeKey', currentMissingStoreRun.output, beforeCurrentMissingStore);
  for (const [label, mutate] of [
    ['execution-state-array', task => { task.execution.state = ['preflight_ready']; }],
    ['row-state-array', task => { task.execution.openApiProductExecutors[0].state = ['ready_for_submit']; }],
    ['row-state-null-with-valid-result-fallback', task => { task.execution.openApiProductExecutors[0].state = null; task.execution.openApiProductExecutors[0].result.state = 'ready_for_submit'; }],
  ]) {
    const pollutedTask = JSON.parse(JSON.stringify(executeTask()));
    mutate(pollutedTask);
    check(`resolver rejects ${label}`, executorHooks.resolvePreflightProductLock(pollutedTask, 'HL', {
      expectedPayloadHash: preflightOutput.payload.payloadHash,
    }), null);
    const beforeMalformedState = publishAttemptCount;
    const malformedStateRun = await runExecutor({
      label: `execute-${label}`,
      mode: 'execute',
      executionContext: executeContext,
      task: pollutedTask,
    });
    check(`${label} execute blocked`, malformedStateRun.output?.state || '', 'blocked');
    check(`${label} forces re-preflight`, malformedStateRun.output?.evidence?.sourceDetailLockGate?.blockers?.map(b => b.code) || [], codes => codes.includes('SOURCE_DETAIL_LOCK_PREFLIGHT_MISSING'));
    checkNoPublishEvidence(label, malformedStateRun.output, beforeMalformedState);
  }
  for (const [label, malformedStoreKey] of [
    ['result-storeKey-array', []],
    ['result-storeKey-null', null],
    ['result-storeKey-false', false],
  ]) {
    const pollutedTask = JSON.parse(JSON.stringify(executeTask()));
    pollutedTask.execution.openApiProductExecutors[0].storeKey = 'HL';
    pollutedTask.execution.openApiProductExecutors[0].result.storeKey = malformedStoreKey;
    check(`resolver rejects ${label} despite valid wrapper fallback`, executorHooks.resolvePreflightProductLock(pollutedTask, 'HL', {
      expectedPayloadHash: preflightOutput.payload.payloadHash,
    }), null);
    const beforeMalformedResultStore = publishAttemptCount;
    const malformedResultStoreRun = await runExecutor({
      label: `execute-${label}`,
      mode: 'execute',
      executionContext: executeContext,
      task: pollutedTask,
    });
    check(`${label} execute blocked`, malformedResultStoreRun.output?.state || '', 'blocked');
    check(`${label} forces re-preflight`, malformedResultStoreRun.output?.evidence?.sourceDetailLockGate?.blockers?.map(b => b.code) || [], codes => codes.includes('SOURCE_DETAIL_LOCK_PREFLIGHT_MISSING'));
    checkNoPublishEvidence(label, malformedResultStoreRun.output, beforeMalformedResultStore);
  }
  for (const [label, malformedTopLock] of [
    ['top-level-lock-array', []],
    ['top-level-lock-null', null],
  ]) {
    const pollutedOutput = JSON.parse(JSON.stringify(preflightOutput));
    pollutedOutput.payload.generatedDraft ||= {};
    pollutedOutput.payload.generatedDraft.sourceDetailLock = JSON.parse(JSON.stringify(preflightOutput.payload.sourceDetailLock));
    pollutedOutput.payload.sourceDetailLock = malformedTopLock;
    const pollutedTask = baseTask();
    pollutedTask.execution = {
      state: 'preflight_ready',
      preflight: {ok: true, blockers: [], warnings: []},
      openApiProductExecutors: [{...executionRow, result: pollutedOutput}],
    };
    check(`resolver rejects ${label} despite valid generated fallback`, executorHooks.resolvePreflightProductLock(pollutedTask, 'HL', {
      expectedPayloadHash: preflightOutput.payload.payloadHash,
    }), null);
    const beforeMalformedTopLock = publishAttemptCount;
    const malformedTopLockRun = await runExecutor({
      label: `execute-${label}`,
      mode: 'execute',
      executionContext: executeContext,
      task: pollutedTask,
    });
    check(`${label} execute blocked`, malformedTopLockRun.output?.state || '', 'blocked');
    check(`${label} forces re-preflight`, malformedTopLockRun.output?.evidence?.sourceDetailLockGate?.blockers?.map(b => b.code) || [], codes => codes.includes('SOURCE_DETAIL_LOCK_PREFLIGHT_MISSING'));
    checkNoPublishEvidence(label, malformedTopLockRun.output, beforeMalformedTopLock);
  }
  for (const [label, detailFetchedAt] of [
    ['top-level-lock-future-timestamp', FUTURE_AT],
    ['top-level-lock-expired-timestamp', EXPIRED_AT],
  ]) {
    const pollutedOutput = JSON.parse(JSON.stringify(preflightOutput));
    pollutedOutput.payload.sourceDetailLock.detailFetchedAt = detailFetchedAt;
    const pollutedTask = baseTask();
    pollutedTask.execution = {
      state: 'preflight_ready',
      preflight: {ok: true, blockers: [], warnings: []},
      openApiProductExecutors: [{...executionRow, result: pollutedOutput}],
    };
    check(`resolver rejects ${label}`, executorHooks.resolvePreflightProductLock(pollutedTask, 'HL', {
      expectedPayloadHash: preflightOutput.payload.payloadHash,
    }), null);
    const beforeInvalidExpectedTimestamp = publishAttemptCount;
    const invalidExpectedTimestampRun = await runExecutor({
      label: `execute-${label}`,
      mode: 'execute',
      executionContext: executeContext,
      task: pollutedTask,
    });
    check(`${label} execute blocked`, invalidExpectedTimestampRun.output?.state || '', 'blocked');
    check(`${label} forces re-preflight`, invalidExpectedTimestampRun.output?.evidence?.sourceDetailLockGate?.blockers?.map(b => b.code) || [], codes => codes.includes('SOURCE_DETAIL_LOCK_PREFLIGHT_MISSING'));
    checkNoPublishEvidence(label, invalidExpectedTimestampRun.output, beforeInvalidExpectedTimestamp);
  }
  const historyRow = {
    storeKey: 'HL',
    state: 'ready_for_submit',
    ok: true,
    sourceStore: SOURCE_STORE,
    sourceSkc: SOURCE_SKC,
    payloadHash: preflightOutput.payload.payloadHash,
    payloadHashAlgorithm: preflightOutput.payload.payloadHashAlgorithm,
    payload: {sourceDetailLock: preflightOutput.payload.sourceDetailLock},
  };
  const historyWriteAuditTask = baseTask();
  historyWriteAuditTask.history = [{
    event: 'openapi_product_preflight_ready',
    writeAudit: {executorEvidence: [historyRow]},
  }];
  check('history writeAudit resolver restores v3 lock', executorHooks.resolvePreflightProductLock(historyWriteAuditTask, 'HL', {
    expectedPayloadHash: preflightOutput.payload.payloadHash,
  }), value => value?.payloadHashAlgorithm === 'sha256-stable-json-scope-v3'
    && value?.sourceStore === SOURCE_STORE
    && value?.sourceSkc === SOURCE_SKC);
  const historyExecutorTask = baseTask();
  historyExecutorTask.history = [{
    event: 'openapi_product_preflight_ready',
    openApiProductExecutors: [historyRow],
  }];
  check('history executor resolver restores v3 lock', executorHooks.resolvePreflightProductLock(historyExecutorTask, 'HL', {
    expectedPayloadHash: preflightOutput.payload.payloadHash,
  }), value => value?.payloadHashAlgorithm === 'sha256-stable-json-scope-v3'
    && value?.sourceStore === SOURCE_STORE
    && value?.sourceSkc === SOURCE_SKC);
  const historyEventArrayTask = JSON.parse(JSON.stringify(historyWriteAuditTask));
  historyEventArrayTask.history[0].event = ['openapi_product_preflight_ready'];
  check('history resolver rejects array event name', executorHooks.resolvePreflightProductLock(historyEventArrayTask, 'HL', {
    expectedPayloadHash: preflightOutput.payload.payloadHash,
  }), null);
  const beforeHistoryEventArray = publishAttemptCount;
  const historyEventArrayRun = await runExecutor({
    label: 'execute-history-event-array',
    mode: 'execute',
    executionContext: executeContext,
    task: historyEventArrayTask,
  });
  check('history event array execute blocked', historyEventArrayRun.output?.state || '', 'blocked');
  check('history event array forces re-preflight', historyEventArrayRun.output?.evidence?.sourceDetailLockGate?.blockers?.map(b => b.code) || [], codes => codes.includes('SOURCE_DETAIL_LOCK_PREFLIGHT_MISSING'));
  checkNoPublishEvidence('history event array', historyEventArrayRun.output, beforeHistoryEventArray);
  const historyWriteAuditOkFalseTask = JSON.parse(JSON.stringify(historyWriteAuditTask));
  historyWriteAuditOkFalseTask.history[0].writeAudit.executorEvidence[0].ok = false;
  check('history writeAudit resolver rejects ok=false row', executorHooks.resolvePreflightProductLock(historyWriteAuditOkFalseTask, 'HL', {
    expectedPayloadHash: preflightOutput.payload.payloadHash,
  }), null);
  const beforeHistoryOkFalse = publishAttemptCount;
  const historyOkFalseRun = await runExecutor({
    label: 'execute-history-write-audit-ok-false',
    mode: 'execute',
    executionContext: executeContext,
    task: historyWriteAuditOkFalseTask,
  });
  check('history writeAudit ok=false execute blocked', historyOkFalseRun.output?.state || '', 'blocked');
  check('history writeAudit ok=false forces re-preflight', historyOkFalseRun.output?.evidence?.sourceDetailLockGate?.blockers?.map(b => b.code) || [], codes => codes.includes('SOURCE_DETAIL_LOCK_PREFLIGHT_MISSING'));
  checkNoPublishEvidence('history writeAudit ok=false', historyOkFalseRun.output, beforeHistoryOkFalse);
  for (const [historyKind, taskFactory] of [
    ['writeAudit', () => JSON.parse(JSON.stringify(historyWriteAuditTask))],
    ['executor', () => JSON.parse(JSON.stringify(historyExecutorTask))],
  ]) {
    for (const tamper of [
      {label: 'blocked row state', apply: row => { row.state = 'blocked'; }},
      {label: 'error row state', apply: row => { row.state = 'error'; }},
      {label: 'missing row state', apply: row => { delete row.state; }},
      {label: 'array row state', apply: row => { row.state = ['ready_for_submit']; }},
      {label: 'explicit result null', apply: row => { row.result = null; }},
      {label: 'explicit result false', apply: row => { row.result = false; }},
      {label: 'inferredSource null', apply: row => { row.payload.inferredSource = null; }},
      {label: 'inferredSource false', apply: row => { row.payload.inferredSource = false; }},
      {label: 'inferredSource array', apply: row => { row.payload.inferredSource = []; }},
      {label: 'missing storeKey', apply: row => { delete row.storeKey; }},
      {label: 'sourceStore trailing LF', apply: row => { row.sourceStore = `${row.sourceStore}\n`; }},
      {label: 'sourceSkc trailing LF', apply: row => { row.sourceSkc = `${row.sourceSkc}\n`; }},
      {label: 'sourceStore trailing space', apply: row => { row.sourceStore = `${row.sourceStore} `; }},
      {label: 'sourceSkc trailing space', apply: row => { row.sourceSkc = `${row.sourceSkc} `; }},
      {label: 'source lock SPU trailing space', apply: row => { row.payload.sourceDetailLock.matchedSpuName = `${row.payload.sourceDetailLock.matchedSpuName} `; }},
      {label: 'sourceStore array', apply: row => { row.sourceStore = [SOURCE_STORE]; }},
      {label: 'sourceStore object', apply: row => { row.sourceStore = {value: SOURCE_STORE}; }},
      {label: 'sourceSkc array', apply: row => { row.sourceSkc = [SOURCE_SKC]; }},
      {label: 'sourceSkc object', apply: row => { row.sourceSkc = {value: SOURCE_SKC}; }},
      {label: 'source lock source array', apply: row => { row.payload.sourceDetailLock.source = [baseLock.source]; }},
      {label: 'source lock SPU object', apply: row => { row.payload.sourceDetailLock.matchedSpuName = {value: SOURCE_SPU}; }},
      {label: 'source lock SKC array', apply: row => { row.payload.sourceDetailLock.matchedSkcName = [SOURCE_SKC]; }},
      {label: 'source lock SHA object', apply: row => { row.payload.sourceDetailLock.detailContentSha256 = {value: baseLock.detailContentSha256}; }},
      {label: 'source lock future timestamp', apply: row => { row.payload.sourceDetailLock.detailFetchedAt = FUTURE_AT; }},
      {label: 'source lock expired timestamp', apply: row => { row.payload.sourceDetailLock.detailFetchedAt = EXPIRED_AT; }},
      {label: 'payloadHash array', apply: row => { row.payloadHash = [preflightOutput.payload.payloadHash]; }},
      {label: 'payloadHash object', apply: row => { row.payloadHash = {value: preflightOutput.payload.payloadHash}; }},
      {label: 'payloadHashAlgorithm array', apply: row => { row.payloadHashAlgorithm = ['sha256-stable-json-scope-v3']; }},
      {label: 'payloadHashAlgorithm object', apply: row => { row.payloadHashAlgorithm = {value: 'sha256-stable-json-scope-v3'}; }},
    ]) {
      const tamperedTask = taskFactory();
      const row = historyKind === 'writeAudit'
        ? tamperedTask.history[0].writeAudit.executorEvidence[0]
        : tamperedTask.history[0].openApiProductExecutors[0];
      tamper.apply(row);
      check(`${historyKind} history resolver rejects ${tamper.label}`, executorHooks.resolvePreflightProductLock(tamperedTask, 'HL', {
        expectedPayloadHash: preflightOutput.payload.payloadHash,
      }), null);
      const beforeTamperedHistory = publishAttemptCount;
      const tamperedHistoryRun = await runExecutor({
        label: `execute-${historyKind}-${tamper.label}-history`,
        mode: 'execute',
        executionContext: executeContext,
        task: tamperedTask,
      });
      check(`${historyKind} ${tamper.label} history execute blocked`, tamperedHistoryRun.output?.state || '', 'blocked');
      check(`${historyKind} ${tamper.label} history forces re-preflight`, tamperedHistoryRun.output?.evidence?.sourceDetailLockGate?.blockers?.map(b => b.code) || [], codes => codes.includes('SOURCE_DETAIL_LOCK_PREFLIGHT_MISSING'));
      checkNoPublishEvidence(`${historyKind} ${tamper.label} history`, tamperedHistoryRun.output, beforeTamperedHistory);
    }
  }
  for (const algorithm of ['sha256-stable-json-scope-v2', '']) {
    const legacyOutput = JSON.parse(JSON.stringify(preflightOutput));
    legacyOutput.payload.payloadHashAlgorithm = algorithm;
    const legacyTask = baseTask();
    legacyTask.execution = {
      state: 'preflight_ready',
      preflight: {ok: true, blockers: [], warnings: []},
      openApiProductExecutors: [{...executionRow, result: legacyOutput}],
    };
    check(`resolver rejects ${algorithm || 'missing'} algorithm`, executorHooks.resolvePreflightProductLock(legacyTask, 'HL', {
      expectedPayloadHash: preflightOutput.payload.payloadHash,
    }), null);
  }
  for (const [label, mutate] of [
    ['current payloadHash array', output => { output.payload.payloadHash = [preflightOutput.payload.payloadHash]; }],
    ['current payloadHash object', output => { output.payload.payloadHash = {value: preflightOutput.payload.payloadHash}; }],
    ['current payloadHashAlgorithm array', output => { output.payload.payloadHashAlgorithm = ['sha256-stable-json-scope-v3']; }],
    ['current payloadHashAlgorithm object', output => { output.payload.payloadHashAlgorithm = {value: 'sha256-stable-json-scope-v3'}; }],
  ]) {
    const pollutedOutput = JSON.parse(JSON.stringify(preflightOutput));
    mutate(pollutedOutput);
    const pollutedTask = baseTask();
    pollutedTask.execution = {
      state: 'preflight_ready',
      preflight: {ok: true, blockers: [], warnings: []},
      openApiProductExecutors: [{...executionRow, result: pollutedOutput}],
    };
    check(`resolver rejects ${label}`, executorHooks.resolvePreflightProductLock(pollutedTask, 'HL', {
      expectedPayloadHash: preflightOutput.payload.payloadHash,
    }), null);
    const beforePollutedCurrent = publishAttemptCount;
    const pollutedCurrentRun = await runExecutor({
      label: `execute-${label}`,
      mode: 'execute',
      executionContext: executeContext,
      task: pollutedTask,
    });
    check(`${label} execute blocked`, pollutedCurrentRun.output?.state || '', 'blocked');
    check(`${label} forces re-preflight`, pollutedCurrentRun.output?.evidence?.sourceDetailLockGate?.blockers?.map(b => b.code) || [], codes => codes.includes('SOURCE_DETAIL_LOCK_PREFLIGHT_MISSING'));
    checkNoPublishEvidence(label, pollutedCurrentRun.output, beforePollutedCurrent);
  }

  // A byte-identical source observed at a newer fresh timestamp must retain the
  // same confirmation hash. Execute still compares the full persisted locks,
  // including freshness and content, before publishOrEdit.
  const refreshedAt = new Date().toISOString();
  await writeDetail({detailFetchedAt: refreshedAt});
  const timestampRefresh = await runExecutor({label: 'preflight-timestamp-refresh', mode: 'dry-run'});
  check('timestamp-only refresh parsed output', Boolean(timestampRefresh.output), true);
  check('timestamp-only refresh keeps scope-v3 hash', timestampRefresh.output?.payload?.payloadHash || '', preflightOutput.payload.payloadHash);
  check('timestamp-only refresh updates full evidence timestamp', timestampRefresh.output?.payload?.sourceDetailLock?.detailFetchedAt || '', refreshedAt);
  check('timestamp-only refresh keeps content hash', timestampRefresh.output?.payload?.sourceDetailLock?.detailContentSha256 || '', preflightOutput.payload.sourceDetailLock.detailContentSha256);
  check('timestamp-only refresh does not publish', publishAttemptCount, 0);

  // Fresh execute: same content/identity with a refreshed timestamp and the
  // original preflight lock -> publishOrEdit once.
  const fresh = await runExecutor({label: 'execute-fresh', mode: 'execute', executionContext: executeContext, task: executeTask()});
  check('fresh execute parsed output', Boolean(fresh.output), true);
  check('fresh execute gate active and ok', fresh.output?.evidence?.sourceDetailLockGate, value => value?.gateActive === true && value?.ok === true);
  check('fresh execute reaches publishOrEdit once', publishAttemptCount, 1);
  check('fresh execute openapi calls include publishOrEdit once', (fresh.output?.openapi?.calls || []).filter(call => call?.path === '/open-api/goods/product/publishOrEdit').length, 1);
  check('fresh execute publishResult present', Boolean(fresh.output?.publishResult), true);
  for (const [label, expectedPayloadHash] of [
    ['array-expected-payload-hash', [preflightOutput.payload.payloadHash]],
    ['object-expected-payload-hash', {value: preflightOutput.payload.payloadHash}],
  ]) {
    const beforeInvalidExpectedHash = publishAttemptCount;
    const invalidExpectedHashRun = await runExecutor({
      label: `execute-${label}`,
      mode: 'execute',
      executionContext: {...executeContext, expectedPayloadHash},
      task: executeTask(),
    });
    check(`${label} execute blocked`, invalidExpectedHashRun.output?.state || '', 'blocked');
    check(`${label} reports invalid type`, invalidExpectedHashRun.output?.blockers || [], rows => rows.some(row => /expectedPayloadHash 类型或格式无效/.test(String(row))));
    checkNoPublishEvidence(label, invalidExpectedHashRun.output, beforeInvalidExpectedHash);
  }
  const beforeInvalidExpectedFallback = publishAttemptCount;
  const invalidExpectedFallbackRun = await runExecutor({
    label: 'execute-invalid-top-expected-with-valid-request-fallback',
    mode: 'execute',
    executionContext: {
      ...executeContext,
      expectedPayloadHash: [],
      request: {expectedPayloadHash: preflightOutput.payload.payloadHash},
    },
    task: executeTask(),
  });
  check('invalid top expected hash does not use valid request fallback', invalidExpectedFallbackRun.output?.state || '', 'blocked');
  check('invalid top expected hash reports invalid type', invalidExpectedFallbackRun.output?.blockers || [], rows => rows.some(row => /expectedPayloadHash 类型或格式无效/.test(String(row))));
  checkNoPublishEvidence('invalid top expected hash fallback', invalidExpectedFallbackRun.output, beforeInvalidExpectedFallback);

  for (const [label, detailFetchedAt] of [
    ['array-current-detail-timestamp', [new Date().toISOString()]],
    ['object-current-detail-timestamp', {value: new Date().toISOString()}],
  ]) {
    await writeDetail({detailFetchedAt});
    const beforeInvalidTimestamp = publishAttemptCount;
    const invalidTimestampRun = await runExecutor({
      label: `execute-${label}`,
      mode: 'execute',
      executionContext: executeContext,
      task: executeTask(),
    });
    check(`${label} execute blocked`, invalidTimestampRun.output?.state || '', 'blocked');
    check(`${label} stable code`, invalidTimestampRun.output?.evidence?.sourceDetailLockGate?.blockers?.map(b => b.code) || [], codes => codes.includes('SOURCE_DETAIL_LOCK_TIMESTAMP_INVALID'));
    checkNoPublishEvidence(label, invalidTimestampRun.output, beforeInvalidTimestamp);
  }
  if (publishAttemptCount !== 1) {
    result.freshDebug = {
      state: fresh.output?.state || null,
      ok: fresh.output?.ok ?? null,
      blockers: fresh.output?.blockers || [],
      warnings: (fresh.output?.warnings || []).slice(0, 10),
      gate: fresh.output?.evidence?.sourceDetailLockGate || null,
      payloadHash: fresh.output?.payload?.payloadHash || '',
      lock: fresh.output?.payload?.sourceDetailLock || null,
      mappingBlockers: fresh.output?.payload?.mappingBlockers || [],
    };
  }

  // 25h execute: TTL gate blocks before publishOrEdit.
  await writeDetail({detailFetchedAt: EXPIRED_AT});
  const beforeExpired = publishAttemptCount;
  const expired = await runExecutor({label: 'execute-expired', mode: 'execute', executionContext: executeContext, task: executeTask()});
  check('expired execute state blocked', expired.output?.state || '', 'blocked');
  check('expired gate blocked', expired.output?.evidence?.sourceDetailLockGate?.ok, false);
  check('expired gate code', expired.output?.evidence?.sourceDetailLockGate?.blockers?.map(b => b.code) || [], codes => codes.includes('SOURCE_DETAIL_LOCK_EXPIRED'));
  check('expired gate message in blockers', expired.output?.blockers || [], rows => rows.some(row => /已超过 24 小时/.test(String(row))));
  check('expired timestamp alone keeps scope-v3 hash', expired.output?.payload?.payloadHash || '', preflightOutput.payload.payloadHash);
  checkNoPublishEvidence('expired execute', expired.output, beforeExpired);

  // Content drift with fresh timestamp: content hash gate blocks.
  await writeDetail({detailFetchedAt: FRESH_AT, info: detailInfo({titleSuffix: '-drifted'})});
  const beforeDrift = publishAttemptCount;
  const drift = await runExecutor({label: 'execute-content-drift', mode: 'execute', executionContext: executeContext, task: executeTask()});
  check('content drift state blocked', drift.output?.state || '', 'blocked');
  check('content drift gate code', drift.output?.evidence?.sourceDetailLockGate?.blockers?.map(b => b.code) || [], codes => codes.includes('SOURCE_DETAIL_LOCK_CONTENT_DRIFT'));
  check('content drift message in blockers', drift.output?.blockers || [], rows => rows.some(row => /内容 hash 漂移/.test(String(row))));
  check('content drift hash invalidated', drift.output?.blockers || [], rows => rows.some(row => /payload hash 与 dry-run 锁定值不一致/.test(String(row))));
  checkNoPublishEvidence('content drift execute', drift.output, beforeDrift);

  // Actual SKC drift: mapper identity conflict merges into blockers; gate sees missing lock.
  const driftedSkcInfo = detailInfo();
  driftedSkcInfo.skcInfoList[0].skcName = 'sv-drifted-current-skc';
  await writeDetail({detailFetchedAt: FRESH_AT, info: driftedSkcInfo});
  const beforeSkcDrift = publishAttemptCount;
  const skcDrift = await runExecutor({label: 'execute-skc-drift', mode: 'execute', executionContext: executeContext, task: executeTask()});
  check('skc drift state blocked', skcDrift.output?.state || '', 'blocked');
  check('skc drift structured mapping blocker', skcDrift.output?.payload?.mappingBlockers?.map(b => b.code) || [], codes => codes.includes('SOURCE_DETAIL_CONFLICT_SAME_SPU_WRONG_SKC'));
  check('skc drift conflict message in total blockers', skcDrift.output?.blockers || [], rows => rows.some(row => /身份冲突/.test(String(row))));
  check('skc drift gate missing lock', skcDrift.output?.evidence?.sourceDetailLockGate?.blockers?.map(b => b.code) || [], codes => codes.includes('SOURCE_DETAIL_LOCK_MISSING'));
  checkNoPublishEvidence('skc drift execute', skcDrift.output, beforeSkcDrift);

  // Actual SPU drift: mapper identity conflict (same SKC wrong SPU) merges
  // into blockers; gate sees missing lock; no publish call is issued.
  const driftedSpuInfo = detailInfo();
  driftedSpuInfo.spuName = 'v-wrong-spu-current';
  await writeDetail({detailFetchedAt: FRESH_AT, info: driftedSpuInfo});
  const beforeSpuDrift = publishAttemptCount;
  const spuDrift = await runExecutor({label: 'execute-spu-drift', mode: 'execute', executionContext: executeContext, task: executeTask()});
  check('spu drift state blocked', spuDrift.output?.state || '', 'blocked');
  check('spu drift structured mapping blocker', spuDrift.output?.payload?.mappingBlockers?.map(b => b.code) || [], codes => codes.includes('SOURCE_DETAIL_CONFLICT_SAME_SKC_WRONG_SPU'));
  check('spu drift conflict message in total blockers', spuDrift.output?.blockers || [], rows => rows.some(row => /身份冲突/.test(String(row))));
  check('spu drift gate missing lock', spuDrift.output?.evidence?.sourceDetailLockGate?.blockers?.map(b => b.code) || [], codes => codes.includes('SOURCE_DETAIL_LOCK_MISSING'));
  checkNoPublishEvidence('spu drift execute', spuDrift.output, beforeSpuDrift);

  // Old v2 or algorithm-less preflight evidence must never be consumed by the
  // v3 executor, even when the 64-character hash text happens to match.
  await writeDetail({detailFetchedAt: FRESH_AT});
  for (const [label, algorithm] of [['v2', 'sha256-stable-json-scope-v2'], ['missing-algorithm', '']]) {
    const legacyAlgorithmOutput = JSON.parse(JSON.stringify(preflightOutput));
    legacyAlgorithmOutput.payload.payloadHashAlgorithm = algorithm;
    const legacyAlgorithmTask = baseTask();
    legacyAlgorithmTask.execution = {
      state: 'preflight_ready',
      preflight: {ok: true, blockers: [], warnings: []},
      openApiProductExecutors: [{...executionRow, result: legacyAlgorithmOutput}],
    };
    const beforeLegacyAlgorithm = publishAttemptCount;
    const legacyAlgorithmRun = await runExecutor({
      label: `execute-${label}-preflight`,
      mode: 'execute',
      executionContext: executeContext,
      task: legacyAlgorithmTask,
    });
    check(`${label} preflight state blocked`, legacyAlgorithmRun.output?.state || '', 'blocked');
    check(`${label} preflight forces v3 re-preflight`, legacyAlgorithmRun.output?.evidence?.sourceDetailLockGate?.blockers?.map(b => b.code) || [], codes => codes.includes('SOURCE_DETAIL_LOCK_PREFLIGHT_MISSING'));
    checkNoPublishEvidence(`${label} preflight`, legacyAlgorithmRun.output, beforeLegacyAlgorithm);
  }
  const malformedLockOutput = JSON.parse(JSON.stringify(preflightOutput));
  malformedLockOutput.payload.sourceDetailLock.source = 'evil_source';
  if (malformedLockOutput.payload?.generatedDraft?.sourceDetailLock) {
    malformedLockOutput.payload.generatedDraft.sourceDetailLock.source = 'evil_source';
  }
  const malformedLockTask = baseTask();
  malformedLockTask.execution = {
    state: 'preflight_ready',
    preflight: {ok: true, blockers: [], warnings: []},
    openApiProductExecutors: [{...executionRow, result: malformedLockOutput}],
  };
  const beforeMalformedLock = publishAttemptCount;
  const malformedLockRun = await runExecutor({
    label: 'execute-malformed-preflight-lock',
    mode: 'execute',
    executionContext: executeContext,
    task: malformedLockTask,
  });
  check('malformed preflight lock execute blocked', malformedLockRun.output?.state || '', 'blocked');
  check('malformed preflight lock forces re-preflight', malformedLockRun.output?.evidence?.sourceDetailLockGate?.blockers?.map(b => b.code) || [], codes => codes.includes('SOURCE_DETAIL_LOCK_PREFLIGHT_MISSING'));
  checkNoPublishEvidence('malformed preflight lock', malformedLockRun.output, beforeMalformedLock);
  const controlLockOutput = JSON.parse(JSON.stringify(preflightOutput));
  controlLockOutput.payload.sourceDetailLock.source = `${controlLockOutput.payload.sourceDetailLock.source}\n`;
  if (controlLockOutput.payload?.generatedDraft?.sourceDetailLock) {
    controlLockOutput.payload.generatedDraft.sourceDetailLock.source = `${controlLockOutput.payload.generatedDraft.sourceDetailLock.source}\n`;
  }
  const controlLockTask = baseTask();
  controlLockTask.execution = {
    state: 'preflight_ready',
    preflight: {ok: true, blockers: [], warnings: []},
    openApiProductExecutors: [{...executionRow, result: controlLockOutput}],
  };
  const beforeControlLock = publishAttemptCount;
  const controlLockRun = await runExecutor({
    label: 'execute-control-preflight-lock',
    mode: 'execute',
    executionContext: executeContext,
    task: controlLockTask,
  });
  check('control preflight lock execute blocked', controlLockRun.output?.state || '', 'blocked');
  check('control preflight lock forces re-preflight', controlLockRun.output?.evidence?.sourceDetailLockGate?.blockers?.map(b => b.code) || [], codes => codes.includes('SOURCE_DETAIL_LOCK_PREFLIGHT_MISSING'));
  checkNoPublishEvidence('control preflight lock', controlLockRun.output, beforeControlLock);
  const controlStandardTask = executeTask();
  controlStandardTask.standardGoodsSn = 'ABC\nDEF';
  const beforeControlStandard = publishAttemptCount;
  const controlStandardRun = await runExecutor({
    label: 'execute-control-standard-goods',
    mode: 'execute',
    executionContext: executeContext,
    task: controlStandardTask,
  });
  check('control standard goods execute blocked', controlStandardRun.output?.state || '', 'blocked');
  check('control standard goods stable code', controlStandardRun.output?.evidence?.sourceDetailLockGate?.blockers?.map(b => b.code) || [], codes => codes.includes('SOURCE_DETAIL_LOCK_SCOPE_INVALID'));
  checkNoPublishEvidence('control standard goods', controlStandardRun.output, beforeControlStandard);
  for (const [label, standardGoodsSn] of [
    ['array-standard-goods', [STANDARD_GOODS_SN]],
    ['object-standard-goods', {value: STANDARD_GOODS_SN}],
  ]) {
    const invalidTask = executeTask();
    invalidTask.standardGoodsSn = standardGoodsSn;
    const beforeInvalidStandard = publishAttemptCount;
    const invalidStandardRun = await runExecutor({
      label: `execute-${label}`,
      mode: 'execute',
      executionContext: executeContext,
      task: invalidTask,
    });
    check(`${label} execute blocked`, invalidStandardRun.output?.state || '', 'blocked');
    check(`${label} stable code`, invalidStandardRun.output?.evidence?.sourceDetailLockGate?.blockers?.map(b => b.code) || [], codes => codes.includes('SOURCE_DETAIL_LOCK_SCOPE_INVALID'));
    checkNoPublishEvidence(label, invalidStandardRun.output, beforeInvalidStandard);
  }

  for (const [label, mutate] of [
    ['task sourceSkc array', task => { task.targets.sourceSkc = [SOURCE_SKC]; }],
    ['task sourceSkc object', task => { task.targets.sourceSkc = {value: SOURCE_SKC}; }],
    ['task sourceStores nested array', task => { task.targets.sourceStores = [[SOURCE_STORE]]; }],
    ['task sourceStores object', task => { task.targets.sourceStores = {value: SOURCE_STORE}; }],
  ]) {
    const invalidTask = baseTask();
    mutate(invalidTask);
    const resolved = executorHooks.resolveLockedSourceScope({
      payloadFound: {payload: boundPayload, inferred: {sourceStore: SOURCE_STORE, sourceSkc: SOURCE_SKC}},
      task: invalidTask,
      intents: invalidTask.intents,
      targetStore: 'HL',
    });
    check(`${label} blocks exact source resolution`, resolved.blockers, rows => rows.some(row => /类型或格式无效/.test(String(row))));
  }

  // Old-version preflight: hash-only lock without sourceDetailLock must force
  // re-preflight; execute is blocked before publishOrEdit even though the
  // scope-v3 hash itself still matches.
  await writeDetail({detailFetchedAt: FRESH_AT});
  const oldPreflightOutput = JSON.parse(JSON.stringify(preflightOutput));
  delete oldPreflightOutput.payload.sourceDetailLock;
  if (oldPreflightOutput.payload?.generatedDraft) delete oldPreflightOutput.payload.generatedDraft.sourceDetailLock;
  const oldPreflightTask = baseTask();
  oldPreflightTask.execution = {
    state: 'preflight_ready',
    preflight: {ok: true, blockers: [], warnings: []},
    openApiProductExecutors: [{...executionRow, result: oldPreflightOutput}],
  };
  const beforeOldPreflight = publishAttemptCount;
  const oldPreflight = await runExecutor({label: 'execute-old-preflight-hash-only', mode: 'execute', executionContext: executeContext, task: oldPreflightTask});
  check('old preflight state blocked', oldPreflight.output?.state || '', 'blocked');
  check('old preflight gate code', oldPreflight.output?.evidence?.sourceDetailLockGate?.blockers?.map(b => b.code) || [], codes => codes.includes('SOURCE_DETAIL_LOCK_PREFLIGHT_MISSING'));
  check('old preflight message forces re-preflight', oldPreflight.output?.blockers || [], rows => rows.some(row => /重新 dry-run/.test(String(row))));
  checkNoPublishEvidence('old preflight execute', oldPreflight.output, beforeOldPreflight);

  // Mapper hydrates but produces no lock (empty detailResults): both dry-run
  // and execute must block; the fake publish endpoint sees no new calls.
  await writeDetail({detailResults: []});
  const beforeNoLockDry = publishAttemptCount;
  const noLockDry = await runExecutor({label: 'dry-run-no-lock', mode: 'dry-run', task: baseTask()});
  check('no-lock dry-run state blocked', noLockDry.output?.state || '', 'blocked');
  check('no-lock dry-run gate code', noLockDry.output?.evidence?.sourceDetailLockGate?.blockers?.map(b => b.code) || [], codes => codes.includes('SOURCE_DETAIL_LOCK_MISSING'));
  check('no-lock dry-run does not publish', publishAttemptCount, beforeNoLockDry);
  const beforeNoLockExec = publishAttemptCount;
  const noLockExec = await runExecutor({label: 'execute-no-lock', mode: 'execute', executionContext: executeContext, task: executeTask()});
  check('no-lock execute state blocked', noLockExec.output?.state || '', 'blocked');
  check('no-lock execute gate code', noLockExec.output?.evidence?.sourceDetailLockGate?.blockers?.map(b => b.code) || [], codes => codes.includes('SOURCE_DETAIL_LOCK_MISSING'));
  checkNoPublishEvidence('no-lock execute', noLockExec.output, beforeNoLockExec);

  // Bound hydration throws (no link snapshot at all): the catch path must not
  // continue on a warning alone; dry-run is blocked with the structured lock
  // blocker and the fake publish endpoint stays untouched.
  await fs.rm(sourceLinkDir, {recursive: true, force: true});
  const beforeHydrationFail = publishAttemptCount;
  const hydrationFail = await runExecutor({label: 'dry-run-hydration-fail', mode: 'dry-run', task: baseTask()});
  check('hydration-fail dry-run state blocked', hydrationFail.output?.state || '', 'blocked');
  check('hydration-fail gate code', hydrationFail.output?.evidence?.sourceDetailLockGate?.blockers?.map(b => b.code) || [], codes => codes.includes('SOURCE_DETAIL_LOCK_MISSING'));
  check('hydration-fail warning recorded but not passed', hydrationFail.output?.warnings || [], rows => rows.some(row => /无法从当前详情快照还原只读元数据/.test(String(row))));
  check('hydration-fail dry-run does not publish', publishAttemptCount, beforeHydrationFail);

  result.stdout = fresh.run.stdout.slice(0, 1000);
  result.stderr = fresh.run.stderr.slice(0, 1000);
  result.ok = result.checks.every(row => row.pass);
} finally {
  await new Promise(resolve => fakeOpenApi.close(resolve));
  await fs.rm(sourceLinkDir, {recursive: true, force: true});
  await fs.rm(sourceOpenApiDir, {recursive: true, force: true});
  await fs.rm(tmpRoot, {recursive: true, force: true});
}

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);
