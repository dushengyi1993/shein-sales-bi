#!/usr/bin/env node
/**
 * Executor source-detail-lock write gate smoke.
 *
 * The bound/reviewed payload path must keep the mapper-hydrated
 * sourceDetailLock through preflight and execute:
 *
 * 1. fresh (23h) preflight locks the scope-v2 hash and the lock; a fresh
 *    execute reusing the same preflight lock reaches publishOrEdit exactly once;
 * 2. 23h preflight -> 25h bound payload execute blocks before publishOrEdit
 *    with SOURCE_DETAIL_LOCK_EXPIRED (executor level: no publish call issued);
 * 3. same freshness but drifted detail content blocks with
 *    SOURCE_DETAIL_LOCK_CONTENT_DRIFT (scope-v2 hash also invalidates);
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_STORE = 'LKD';
const SOURCE_SKC = 'sv20990101000000009';
const SOURCE_SPU = 'v209901010009';
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
      standardGoodsSn: 'LKD-505',
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
  check('gate content drift blocks', gate({currentLock: {...baseLock, detailContentSha256: 'f'.repeat(64)}, expectedLock: baseLock}).blockers.map(b => b.code), codes => codes.includes('SOURCE_DETAIL_LOCK_CONTENT_DRIFT'));
  check('gate SKC drift blocks', gate({currentLock: {...baseLock, matchedSkcName: 'sv-drifted'}, expectedLock: baseLock, sourceSkc: SOURCE_SKC}).blockers.map(b => b.code), codes => codes.includes('SOURCE_DETAIL_LOCK_IDENTITY_DRIFT'));
  check('gate fresh lock passes', gate({currentLock: baseLock, expectedLock: baseLock, sourceStore: SOURCE_STORE, sourceSkc: SOURCE_SKC}), value => value.ok === true && value.gateActive === true);
  check('gate required without expected allows fresh current lock', gate({currentLock: baseLock, expectedLock: null, required: true, sourceStore: SOURCE_STORE, sourceSkc: SOURCE_SKC}), value => value.ok === true && value.gateActive === true && value.blockers.length === 0);
  check('gate required without current lock blocks', gate({currentLock: null, expectedLock: null, required: true, sourceStore: SOURCE_STORE, sourceSkc: SOURCE_SKC}).blockers.map(b => b.code), codes => codes.includes('SOURCE_DETAIL_LOCK_MISSING'));
  check('gate requireExpectedLock without expected blocks', gate({currentLock: baseLock, expectedLock: null, required: true, requireExpectedLock: true}).blockers.map(b => b.code), codes => codes.includes('SOURCE_DETAIL_LOCK_PREFLIGHT_MISSING'));
  check('gate required expired without expected blocks', gate({currentLock: {...baseLock, detailFetchedAt: EXPIRED_AT}, expectedLock: null, required: true}).blockers.map(b => b.code), codes => codes.includes('SOURCE_DETAIL_LOCK_EXPIRED'));

  // Preflight with a 23h-fresh detail locks scope-v2 + sourceDetailLock.
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
  check('preflight locks scope-v2 hash', preflightOutput?.payload?.payloadHash || '', value => /^[a-f0-9]{64}$/.test(String(value)));
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

  // Fresh execute: same fixture and preflight lock -> publishOrEdit once.
  const fresh = await runExecutor({label: 'execute-fresh', mode: 'execute', executionContext: executeContext, task: executeTask()});
  check('fresh execute parsed output', Boolean(fresh.output), true);
  check('fresh execute gate active and ok', fresh.output?.evidence?.sourceDetailLockGate, value => value?.gateActive === true && value?.ok === true);
  check('fresh execute reaches publishOrEdit once', publishAttemptCount, 1);
  check('fresh execute openapi calls include publishOrEdit once', (fresh.output?.openapi?.calls || []).filter(call => call?.path === '/open-api/goods/product/publishOrEdit').length, 1);
  check('fresh execute publishResult present', Boolean(fresh.output?.publishResult), true);
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
  check('expired scope-v2 hash invalidated', expired.output?.blockers || [], rows => rows.some(row => /payload hash 与 dry-run 锁定值不一致/.test(String(row))));
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

  // Old-version preflight: hash-only lock without sourceDetailLock must force
  // re-preflight; execute is blocked before publishOrEdit even though the
  // scope-v2 hash itself still matches.
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
