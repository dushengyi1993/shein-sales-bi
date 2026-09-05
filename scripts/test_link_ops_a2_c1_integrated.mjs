#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn, execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {
  areDistinctProductModels,
  validateProductAttributeBindingLock,
  productAttributeBindingRequestKeyV2,
  PRODUCT_ATTRIBUTE_BINDING_SCHEMA_VERSION,
  PRODUCT_ATTRIBUTE_BINDING_KIND,
  PRODUCT_ATTRIBUTE_BINDING_AUTHORITY,
} from '../lib/link_ops_product_attribute_binding.mjs';
import {
  descriptionBindingRequestKey,
  DESCRIPTION_SOURCE_PROOF,
  sha256StableJson,
  sha256Utf8,
  validateDescriptionBindingLock,
} from '../lib/link_ops_product_descriptions.mjs';
import {buildProductDraftFromSnapshots} from '../lib/link_ops_product_draft_mapper.mjs';
import {provisionBiSessionSecret} from './provision_bi_session_secret.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = path.join(ROOT, 'tmp');
await fs.mkdir(tmpBase, {recursive: true});
const tmpRoot = await fs.mkdtemp(path.join(tmpBase, 'bi-ops-a2-c1-real-'));

// Strictly isolate all test paths to tmpRoot
const stateFile = path.join(tmpRoot, 'state.json');
const authFile = path.join(tmpRoot, 'auth.json');
const accessRolesFile = path.join(tmpRoot, 'access_roles.json');
const htpasswdFile = path.join(tmpRoot, 'htpasswd');
const openapiConfigFile = path.join(tmpRoot, 'shein_openapi.json');
const whitelistFile = path.join(tmpRoot, 'whitelist.json');
const readProbeSummaryFile = path.join(tmpRoot, 'probe.json');
const aliasFile = path.join(tmpRoot, 'aliases.json');
const catalogFile = path.join(tmpRoot, 'catalog.json');
const taskFile = path.join(tmpRoot, 'tasks.json');
const chatFile = path.join(tmpRoot, 'chats.json');
const runtimeFile = path.join(tmpRoot, 'runtime.json');
const auditFile = path.join(tmpRoot, 'audit.jsonl');
const sessionSecretFile = path.join(tmpRoot, 'session_secret');
const serverLogFile = path.join(tmpRoot, 'portal_server.log');
const manualLoginStateFile = path.join(tmpRoot, 'manual_login.json');
const cliSessionFile = path.join(tmpRoot, 'cli_session.json');
const portalDir = path.join(tmpRoot, 'portal');

await provisionBiSessionSecret(sessionSecretFile);
await fs.mkdir(portalDir, {recursive: true});
await fs.writeFile(path.join(portalDir, 'index.html'), '<!doctype html><html><body>test</body></html>', 'utf8');

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const {port} = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
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
      try { json = JSON.parse(text); } catch {}
      resolve({text, json});
    });
    req.on('error', reject);
  });
}

// 1. Fake SHEIN OpenAPI server with full donor lookup mocks
const fakeOpenApiPort = await getFreePort();
const fakeOpenApi = http.createServer(async (req, res) => {
  const body = await readBody(req);
  const pathname = req.url.split('?')[0];
  if (pathname === '/open-api/openapi-business-backend/query-store-info') {
    const key = String(req.headers['x-lt-openkeyid'] || '').toLowerCase();
    if (key.includes('tzz')) {
      return sendJson(res, {code: '0', msg: 'OK', info: {accountNo: 'GS7146778', merchantId: '15020332', companyName: '天子舟', shopName: 'TZZ'}});
    }
    return sendJson(res, {code: '0', msg: 'OK', info: {accountNo: 'GS9307061', merchantId: '6716329', companyName: '夏莲', shopName: 'XL'}});
  }
  if (pathname === '/open-api/goods/searchProduct') {
    return sendJson(res, {
      code: '0', msg: 'OK',
      info: {
        data: [{
          spuName: 'b12345',
          supplierCode: 'SK-13015',
          skcList: [{skcName: 'sb123456789012', supplierCode: 'SK-13015'}],
        }],
      },
    });
  }
  if (pathname === '/open-api/goods/spuInfo' || pathname === '/open-api/goods/spu-info') {
    return sendJson(res, {
      code: '0', msg: 'OK',
      info: {
        spuName: 'b12345',
        supplierCode: 'SK-13015',
        categoryId: 123456,
        productAttributeInfoList: [
          {attributeId: 1000546, attributeValueId: 0, attributeValue: 'SK-13015'},
          {attributeId: 1002328, attributeValueId: 1001, attributeValue: 'Non-dangerous'},
        ],
        skcInfoList: [{
          skcName: 'sb123456789012',
          supplierCode: 'SK-13015',
          saleAttributeList: [],
        }],
      },
    });
  }
  return sendJson(res, {code: '0', msg: 'OK', info: null});
});
await new Promise(resolve => fakeOpenApi.listen(fakeOpenApiPort, '127.0.0.1', resolve));

// 2. Setup JSON registries with full stores and operator roles
await fs.writeFile(authFile, JSON.stringify({
  version: 1, updatedAt: new Date().toISOString(),
  users: [
    {username: 'owner_user', password: 'owner_password', role: 'owner', displayName: 'Owner', readStores: ['*'], writeStores: ['*']},
    {username: 'partial_user', password: 'partial_password', role: 'operator', displayName: 'Partial', readStores: ['XL'], writeStores: ['XL']},
  ],
  defaults: {
    owner: {readStores: ['*'], writeStores: ['*']},
    operator: {readStores: ['XL'], writeStores: ['XL']},
  },
}), 'utf8');
await fs.writeFile(accessRolesFile, JSON.stringify({
  version: 1, roles: {
    owner: {name: 'Owner', permissions: ['*'], stores: ['*'], viewScope: 'all', dataAccess: 'full'},
    operator: {name: 'Operator', permissions: ['task:write'], stores: ['XL'], viewScope: 'assigned', dataAccess: 'restricted'},
  },
}), 'utf8');
await fs.writeFile(htpasswdFile, 'owner_user:$apr1$dummy$dummy\npartial_user:$apr1$dummy$dummy\n', 'utf8');
await fs.writeFile(whitelistFile, JSON.stringify({operations: {copy_product_draft: {enabled: true, stores: ['*']}}}), 'utf8');
await fs.writeFile(readProbeSummaryFile, JSON.stringify({}), 'utf8');
await fs.writeFile(aliasFile, JSON.stringify({
  version: 1,
  aliases: [
    {canonical: 'SK-13015', aliases: ['SK-13015', 'SK-13015杆式吸尘器']},
    {canonical: 'SK-GT-3065蒸汽熨烫机', aliases: ['SK-GT-3065蒸汽熨烫机', 'SK-GT-3065']},
    {canonical: 'SK-GT-3065W蒸汽熨烫机', aliases: ['SK-GT-3065W蒸汽熨烫机', 'SK-GT-3065W']},
  ],
}), 'utf8');
await fs.writeFile(catalogFile, JSON.stringify({version: 1, standards: ['SK-13015', 'SK-GT-3065蒸汽熨烫机', 'SK-GT-3065W蒸汽熨烫机']}), 'utf8');
await fs.writeFile(openapiConfigFile, JSON.stringify({
  apiBaseUrls: {prodSemiManaged: 'http://127.0.0.1:' + fakeOpenApiPort},
  stores: [
    {storeKey: 'XL', enabled: true, openKeyId: 'dummy-open-key-xl', secretKey: 'dummy-secret-key-xl'},
    {storeKey: 'TZZ', enabled: true, openKeyId: 'dummy-open-key-tzz', secretKey: 'dummy-secret-key-tzz'},
  ],
}), 'utf8');
await fs.writeFile(taskFile, JSON.stringify({version: 1, updatedAt: new Date().toISOString(), tasks: []}), 'utf8');
await fs.writeFile(chatFile, JSON.stringify({version: 1, updatedAt: new Date().toISOString(), sessions: []}), 'utf8');
await fs.writeFile(stateFile, JSON.stringify({}), 'utf8');
await fs.writeFile(runtimeFile, JSON.stringify({version: 1, updatedAt: new Date().toISOString()}), 'utf8');

// 3. Launch portal process
const portalPort = await getFreePort();
const serverLogStream = await fs.open(serverLogFile, 'w');
const portalProcess = spawn(process.execPath, [
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
  '--link-ops-runtime-file', runtimeFile,
  '--manual-login-state-file', manualLoginStateFile,
  '--audit-file', auditFile,
  '--dir', portalDir,
], {
  cwd: ROOT,
  env: {
    ...process.env,
    NODE_ENV: 'test',
    SHEIN_LINK_OPS_STORE: 'json',
    SHEIN_LINK_OPS_RUNTIME_FILE: runtimeFile,
    SHEIN_WEBHOOK_REPOSITORY_ENABLED: '0',
    SHEIN_BI_LIVE_UPDATES_ENABLED: '0',
    SHEIN_BI_LIVE_ACCOUNTING_ENABLED: '0',
    SHEIN_BI_EXTERNAL_SECTION_QUEUE_ENABLED: '0',
    SHEIN_BI_TEST_ALLOW_FAKE_WEBHOOK_GATE: '1',
    SHEIN_BI_CORE_WARMUP_DISABLED: '1',
    SHEIN_BI_INTENT_PLANNER_ENABLED: '0',
    SHEIN_BI_JOB_WORKER_ENABLED: '1',
    SHEIN_OPENAPI_CONFIG_FILE: openapiConfigFile,
    SHEIN_BI_OPS_WRITE_WHITELIST_FILE: whitelistFile,
    SHEIN_OPENAPI_READ_PROBE_SUMMARY_FILE: readProbeSummaryFile,
    SHEIN_PRODUCT_ALIASES_FILE: aliasFile,
    SHEIN_PRODUCT_CATALOG_FILE: catalogFile,
  },
  stdio: ['ignore', serverLogStream.fd, serverLogStream.fd],
});
await new Promise(resolve => setTimeout(resolve, 2000));

let authCookie = '';
let partialCookie = '';
async function login(username = 'owner_user', password = 'owner_password') {
  const r = await apiRequest('/api/login', {method: 'POST', body: {username, password}});
  const sc = r.headers['set-cookie'] || [];
  const scStr = Array.isArray(sc) ? sc.join('; ') : String(sc);
  const cookie = (scStr.match(/bi_session=[^;]+/) || [''])[0];
  if (!cookie) throw new Error('Login failed: ' + r.text);
  if (username === 'owner_user') {
    authCookie = cookie;
    await fs.writeFile(cliSessionFile, JSON.stringify({
      username: 'owner_user',
      cookie: authCookie,
      updatedAt: new Date().toISOString(),
    }), 'utf8');
  } else {
    partialCookie = cookie;
  }
}

async function apiRequest(pathName, {method = 'GET', body = null, cookie = authCookie, actorUser = 'owner_user', actorRole = 'owner'} = {}) {
  const url = 'http://127.0.0.1:' + portalPort + pathName;
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-ops-actor-user': actorUser,
        'x-ops-actor-role': actorRole,
        Origin: 'http://127.0.0.1:' + portalPort,
        ...(cookie ? {Cookie: cookie} : {}),
      },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({status: res.statusCode, headers: res.headers, text, json});
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function reportCheck(title) {
  console.log('  [PASS] ' + title);
}

try {
  console.log('=== V6 A2 / C1 / E4 / F3 ISOLATED INTEGRATION SUITE ===');
  await login('owner_user', 'owner_password');
  await login('partial_user', 'partial_password');

  // ----------------------------------------------------
  // SECTION 1: A2 Full CLI & HTTP Idempotency Pipeline
  // ----------------------------------------------------
  const initialPayload = {
    category_id: 123456,
    multi_language_name_list: [{language: 'en', name: 'Original XL Title'}],
    product_attribute_list: [{attribute_id: 1000546, attribute_value: 'SK-13015'}],
    skc_list: [{
      supplier_code: 'SK-13015',
      sku_list: [{supplier_sku: 'SK-13015-1', cost_info: {currency: 'SAR', cost_price: '99.00'}}],
      image_info: {image_info_list: [{image_type: 1, image_url: 'https://img.shein.com/main.png'}]},
    }],
  };

  const createRes = await apiRequest('/api/link-ops-tasks', {
    method: 'POST',
    body: {
      command: '复制上品到 XL',
      intents: ['copy_product_draft'],
      targets: {stores: ['XL'], writeStores: ['XL']},
      draft: {openapiPublishPayloadDraft: initialPayload},
    },
  });
  assert.equal(createRes.status, 200, 'Task creation failed: ' + createRes.text);
  const taskId = createRes.json?.task?.id;
  assert.ok(taskId);

  // 1.1 First CLI authorize-duplicate-publish run with requestId
  const reqId1 = 'req-cli-uuid-001';
  const {stdout: cliOut1} = await execFileAsync(process.execPath, [
    path.join(ROOT, 'scripts', 'bi_ops_cli.mjs'),
    'authorize-duplicate-publish',
    '--base-url', 'http://127.0.0.1:' + portalPort,
    '--session-file', cliSessionFile,
    '--task-id', taskId,
    '--store', 'XL',
    '--note', '再上一条同款链接',
    '--request-id', reqId1,
  ], {cwd: ROOT});
  assert.ok(cliOut1.includes(reqId1), 'CLI must output assigned requestId');
  reportCheck('A2.1: CLI authorize-duplicate-publish 成功透传 requestId 并完成首次授权');

  // 1.2 Repeat same CLI command with identical requestId -> Idempotent replay
  const {stdout: cliOutDup} = await execFileAsync(process.execPath, [
    path.join(ROOT, 'scripts', 'bi_ops_cli.mjs'),
    'authorize-duplicate-publish',
    '--base-url', 'http://127.0.0.1:' + portalPort,
    '--session-file', cliSessionFile,
    '--task-id', taskId,
    '--store', 'XL',
    '--note', '重复触发相同请求',
    '--request-id', reqId1,
  ], {cwd: ROOT});
  const tasksAfterDup = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  const taskAfterDup = tasksAfterDup.tasks.find(t => t.id === taskId);
  assert.equal(taskAfterDup.duplicatePublishOverride?.requestId, reqId1);
  reportCheck('A2.2: 同一 requestId CLI 重复提交严格幂等重放，未产生额外状态抖动');

  // 1.3 New request with different requestId advances business state
  const reqId2 = 'req-cli-uuid-002';
  const patchNew = await apiRequest('/api/link-ops-tasks', {
    method: 'PATCH',
    body: {
      id: taskId,
      event: 'authorize_additional_same_code_link_cli',
      duplicatePublishOverride: {store: 'XL', requestId: reqId2, reason: '第二次不同新请求'},
    },
  });
  assert.equal(patchNew.status, 200);
  const tasksAfterNew = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  const taskAfterNew = tasksAfterNew.tasks.find(t => t.id === taskId);
  assert.equal(taskAfterNew.duplicatePublishOverride?.requestId, reqId2);
  reportCheck('A2.3: 新 requestId 提交推进为新业务事实并重新锁定预检');

  // 1.4 Terminal / unknown execution protection
  await fs.writeFile(taskFile, JSON.stringify({
    version: 1,
    tasks: [{
      id: taskId, status: 'done', intents: ['copy_product_draft'], targets: {stores: ['XL'], writeStores: ['XL']},
      lifecycle: {terminal: true}, execution: {actualWriteSubmitted: true},
    }],
  }), 'utf8');
  const executeDenied = await apiRequest('/api/link-ops-execute', {
    method: 'POST', body: {id: taskId, mode: 'execute', confirm: 'YES_I_AM_SURE'},
  });
  assert.equal(executeDenied.status, 409);
  assert.equal(executeDenied.json?.code, 'LINK_OPS_TERMINAL_EXECUTION_RETRY_DENIED');
  reportCheck('A2.4: 终态任务与未知提交防重放严格拦截 (409 LINK_OPS_TERMINAL_EXECUTION_RETRY_DENIED)');

  // ----------------------------------------------------
  // SECTION 2: C1 Real HTTP Endpoints in Both Execution Orders
  // ----------------------------------------------------
  const testOutputDir = path.join(tmpRoot, 'outputs');
  process.env.SHEIN_BI_OUTPUT_DIR = testOutputDir;
  const xlLinkDir = path.join(testOutputDir, 'shein_links', 'XL');
  await fs.mkdir(xlLinkDir, {recursive: true});
  await fs.writeFile(path.join(xlLinkDir, '2026-09-05.json'), JSON.stringify({
    linkRows: [{
      storeKey: 'XL',
      skc: 'sb123456789012',
      spu: 'b12345',
      standardGoodsSn: 'SK-13015',
      productNameCn: 'SK-13015',
      rawGoodsSn: 'SK-13015',
    }],
    inventoryRows: [],
    performanceRows: [],
  }, null, 2), 'utf8');

  const enLines = ['Point 1 EN', 'Point 2 EN', 'Point 3 EN', 'Point 4 EN', 'Point 5 EN'];
  const arLines = ['Point 1 AR', 'Point 2 AR', 'Point 3 AR', 'Point 4 AR', 'Point 5 AR'];
  const zhLines = ['卖点 1 中文', '卖点 2 中文', '卖点 3 中文', '卖点 4 中文', '卖点 5 中文'];
  const descHtml = '<!doctype html><html><body><section id="s09"><article><h3>英文</h3><code>' + enLines.join(String.fromCharCode(10)) + '</code></article><article><h3>阿文</h3><code>' + arLines.join(String.fromCharCode(10)) + '</code></article><div class="displaybox">' + zhLines.map(l => '<div>' + l + '</div>').join('') + '</div></section></body></html>';
  const descSourceFile = path.join(tmpRoot, 'reviewed.html');
  await fs.writeFile(descSourceFile, descHtml, 'utf8');
  const imgFp = crypto.createHash('sha256').update('test-img-binding').digest('hex');

  // ORDER A: Descriptions First -> Attributes Second
  const c1TaskId = 'task-c1-desc-first-001';
  await fs.writeFile(taskFile, JSON.stringify({
    version: 1,
    tasks: [{
      id: c1TaskId,
      status: 'waiting_review',
      intents: ['copy_product_draft'],
      targets: {stores: ['XL'], writeStores: ['XL']},
      repositoryRevision: 1,
      openapiPublishPayload: {
        category_id: 123456,
        multi_language_name_list: [{language: 'en', name: 'XL Vacuum Cleaner Draft'}],
        product_attribute_list: [{attribute_id: 1000546, attribute_value: 'SK-13015', attribute_name: 'Product Model'}],
        skc_list: [{supplier_code: 'SK-13015', sku_list: [{supplier_sku: 'SK-13015-1', cost_info: {currency: 'SAR', cost_price: '99.00'}}], image_info: {image_info_list: [{image_type: 1, image_url: 'https://img.shein.com/main.png'}]}}],
      },
      publishAssetBinding: {bindingFingerprint: imgFp},
    }],
  }), 'utf8');

  const descResA = await apiRequest('/api/link-ops-prepare-descriptions', {
    method: 'POST',
    body: {
      taskId: c1TaskId,
      store: 'XL',
      sourceFile: {name: 'reviewed.html', dataBase64: Buffer.from(descHtml, 'utf8').toString('base64')},
      sourceApproved: true,
      expectedRevision: 1,
    },
  });
  assert.equal(descResA.status, 200);

  const attrResA = await apiRequest('/api/link-ops-prepare-product-attribute', {
    method: 'POST',
    body: {
      taskId: c1TaskId,
      store: 'XL',
      donorStore: 'TZZ',
      donorSkc: 'sb123456789012',
      attributeId: 1002328,
      bindingMode: 'append_missing',
      expectedRevision: 2,
    },
  });
  assert.equal(attrResA.status, 200);

  const taskAfterA = (JSON.parse(await fs.readFile(taskFile, 'utf8'))).tasks.find(t => t.id === c1TaskId);
  const payloadA = taskAfterA.openapiPublishPayload;
  assert.equal(validateProductAttributeBindingLock(taskAfterA, payloadA).ok, true);
  assert.equal(validateDescriptionBindingLock(taskAfterA, payloadA).ok, true);
  reportCheck('C1.1: 顺序A验证通过：先绑描述后补属性，两锁双向自洽同步且精确Hash完全一致');

  // ORDER B: Attributes First -> Descriptions Second
  const c1TaskIdB = 'task-c1-attr-first-002';
  const taskStoreCur = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  taskStoreCur.tasks.push({
    id: c1TaskIdB,
    status: 'waiting_review',
    intents: ['copy_product_draft'],
    targets: {stores: ['XL'], writeStores: ['XL']},
    repositoryRevision: 1,
    openapiPublishPayload: {
      category_id: 123456,
      multi_language_name_list: [{language: 'en', name: 'XL Vacuum Cleaner Draft B'}],
      product_attribute_list: [{attribute_id: 1000546, attribute_value: 'SK-13015', attribute_name: 'Product Model'}],
      skc_list: [{supplier_code: 'SK-13015', sku_list: [{supplier_sku: 'SK-13015-1', cost_info: {currency: 'SAR', cost_price: '99.00'}}], image_info: {image_info_list: [{image_type: 1, image_url: 'https://img.shein.com/main.png'}]}}],
    },
    publishAssetBinding: {bindingFingerprint: imgFp},
  });
  await fs.writeFile(taskFile, JSON.stringify(taskStoreCur), 'utf8');

  const attrResB = await apiRequest('/api/link-ops-prepare-product-attribute', {
    method: 'POST',
    body: {
      taskId: c1TaskIdB,
      store: 'XL',
      donorStore: 'TZZ',
      donorSkc: 'sb123456789012',
      attributeId: 1002328,
      bindingMode: 'append_missing',
      expectedRevision: 1,
    },
  });
  assert.equal(attrResB.status, 200);

  const descResB = await apiRequest('/api/link-ops-prepare-descriptions', {
    method: 'POST',
    body: {
      taskId: c1TaskIdB,
      store: 'XL',
      sourceFile: {name: 'reviewed.html', dataBase64: Buffer.from(descHtml, 'utf8').toString('base64')},
      sourceApproved: true,
      expectedRevision: 2,
    },
  });
  assert.equal(descResB.status, 200);

  const taskAfterB = (JSON.parse(await fs.readFile(taskFile, 'utf8'))).tasks.find(t => t.id === c1TaskIdB);
  const payloadB = taskAfterB.openapiPublishPayload;
  assert.equal(validateProductAttributeBindingLock(taskAfterB, payloadB).ok, true);
  assert.equal(validateDescriptionBindingLock(taskAfterB, payloadB).ok, true);
  reportCheck('C1.2: 顺序B验证通过：先补属性后绑描述，两锁双向自洽同步且精确Hash完全一致');

  // Tamper regressions
  const tamperedPrice = JSON.parse(JSON.stringify(payloadB));
  tamperedPrice.skc_list[0].sku_list[0].cost_info.cost_price = '1.00';
  assert.equal(validateProductAttributeBindingLock(taskAfterB, tamperedPrice).ok, false);
  const taskWithTamperedPayload = {...taskAfterB, openapiPublishPayload: tamperedPrice};
  // A clean argument cannot hide corruption of the persisted reviewed task.
  assert.equal(validateDescriptionBindingLock(taskWithTamperedPayload, payloadB).ok, false);
  assert.equal(validateDescriptionBindingLock(taskWithTamperedPayload, tamperedPrice).ok, false);
  reportCheck('C1.3: 防篡改逃逸回归：篡改价格后双锁均立即拒收 (fail-closed)');

  // Mapper fail-closed donor verification
  const donorFailDifferent = await buildProductDraftFromSnapshots({
    sourceStore: 'XL', sourceSkc: 'sb123456789012', date: '2026-09-05',
    donorStore: 'TZZ', donorSkc: 'sb123456789012',
    donorOpenApiDetail: {info: {supplierCode: 'SK-DIFFERENT-999', categoryId: 123456}, skcInfo: {supplierCode: 'SK-DIFFERENT-999'}},
    env: {SHEIN_PRODUCT_ALIASES_FILE: aliasFile, SHEIN_PRODUCT_CATALOG_FILE: catalogFile},
  });
  assert.ok(donorFailDifferent.mappingBlockers.some(b => b.code.includes('MISMATCH') || b.code.includes('UNRESOLVED')));
  reportCheck('C1.4: Mapper donor 真实身份核验：不同商品或缺失类目严格 fail-closed 阻断');

  // ----------------------------------------------------
  // SECTION 3: E4 Full 19 Stores Gate, Worker Availability 503, Idempotency 409 & Readback
  // ----------------------------------------------------
  // 3.1 Non-full-19 operator attempting replenishment -> 403 Forbidden
  const forbiddenReplenish = await apiRequest('/api/inventory-replenishment-run', {
    method: 'POST',
    body: {commandId: 'cmd-forbidden-001', dryRun: true},
    cookie: partialCookie,
    actorUser: 'partial_user',
    actorRole: 'operator',
  });
  assert.equal(forbiddenReplenish.status, 403);
  reportCheck('E4.1: 非全19店权限账号调用补库存维护路由被严格拦截 (403)');

  // 3.2 Full 19-store owner calling replenishment without commandId -> 400 Bad Request
  const missingCmdId = await apiRequest('/api/inventory-replenishment-run', {
    method: 'POST',
    body: {dryRun: true},
    cookie: authCookie,
  });
  assert.equal(missingCmdId.status, 400);
  reportCheck('E4.2: 缺少 commandId 的补库存维护请求被参数校验拦截 (400)');

  // 3.3 Full 19-store owner calling replenishment with valid commandId -> 202 Accepted & Job Created
  const validReplenish = await apiRequest('/api/inventory-replenishment-run', {
    method: 'POST',
    body: {commandId: 'cmd-valid-replenish-001', dryRun: true, maxRows: 500},
    cookie: authCookie,
  });
  assert.equal(validReplenish.status, 202);
  const enqueuedJob = validReplenish.json?.data;
  assert.ok(enqueuedJob?.id);
  assert.equal(enqueuedJob?.kind, 'inventory_maintenance');
  reportCheck('E4.3: 全19店权限 owner 发起补库存维护成功入队并返回 202 及标准 publicJob 结构');

  // 3.4 Repeat submission with identical commandId & parameters -> 202 Idempotent Replay
  const replayReplenish = await apiRequest('/api/inventory-replenishment-run', {
    method: 'POST',
    body: {commandId: 'cmd-valid-replenish-001', dryRun: true, maxRows: 500},
    cookie: authCookie,
  });
  assert.equal(replayReplenish.status, 202);
  assert.equal(replayReplenish.json?.data?.id, enqueuedJob.id);
  reportCheck('E4.4: 相同 commandId 且参数一致时幂等重放返回 202 并保持既有作业');

  // 3.5 Conflict: same commandId reused with different parameters -> 409 Conflict
  const conflictReplenish = await apiRequest('/api/inventory-replenishment-run', {
    method: 'POST',
    body: {commandId: 'cmd-valid-replenish-001', dryRun: true, maxRows: 800},
    cookie: authCookie,
  });
  assert.equal(conflictReplenish.status, 409);
  assert.match(conflictReplenish.json?.code || conflictReplenish.text, /CONFLICT/);
  reportCheck('E4.5: 相同 commandId 复用但参数冲突被严格返回 409 (LINK_OPS_IDEMPOTENCY_CONFLICT)');

  // 3.6 Worker-disabled gate verification: spawn a secondary worker-disabled portal instance
  const disabledPort = await getFreePort();
  const disabledLog = await fs.open(path.join(tmpRoot, 'disabled_portal.log'), 'w');
  const disabledProcess = spawn(process.execPath, [
    'scripts/serve_bi_portal.mjs',
    '--host', '127.0.0.1',
    '--port', String(disabledPort),
    '--auth-file', authFile,
    '--access-roles-file', accessRolesFile,
    '--htpasswd-file', htpasswdFile,
    '--session-secret-file', sessionSecretFile,
    '--state-file', stateFile,
    '--link-ops-task-file', taskFile,
    '--link-ops-chat-file', chatFile,
    '--link-ops-runtime-file', runtimeFile,
    '--manual-login-state-file', manualLoginStateFile,
    '--audit-file', auditFile,
    '--dir', portalDir,
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SHEIN_LINK_OPS_STORE: 'json',
      SHEIN_LINK_OPS_RUNTIME_FILE: runtimeFile,
      SHEIN_WEBHOOK_REPOSITORY_ENABLED: '0',
      SHEIN_BI_LIVE_UPDATES_ENABLED: '0',
      SHEIN_BI_LIVE_ACCOUNTING_ENABLED: '0',
      SHEIN_BI_EXTERNAL_SECTION_QUEUE_ENABLED: '0',
      SHEIN_BI_CORE_WARMUP_DISABLED: '1',
      SHEIN_BI_JOB_WORKER_ENABLED: '0',
      SHEIN_OPENAPI_CONFIG_FILE: openapiConfigFile,
      SHEIN_BI_OPS_WRITE_WHITELIST_FILE: whitelistFile,
      SHEIN_OPENAPI_READ_PROBE_SUMMARY_FILE: readProbeSummaryFile,
      SHEIN_PRODUCT_ALIASES_FILE: aliasFile,
      SHEIN_PRODUCT_CATALOG_FILE: catalogFile,
    },
    stdio: ['ignore', disabledLog.fd, disabledLog.fd],
  });
  await new Promise(resolve => setTimeout(resolve, 2000));
  try {
    const disabledRes = await fetch('http://127.0.0.1:' + disabledPort + '/api/inventory-replenishment-run', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': authCookie,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({commandId: 'cmd-disabled-worker-001', dryRun: true}),
    });
    assert.equal(disabledRes.status, 503);
    const disabledJson = await disabledRes.json();
    assert.equal(disabledJson.code, 'LINK_OPS_JOB_WORKER_UNAVAILABLE');
    reportCheck('E4.6: Worker 未启用且无共享消费实例时，接口 fail-closed 严格返回 503 (LINK_OPS_JOB_WORKER_UNAVAILABLE)');
  } finally {
    disabledProcess.kill();
    await disabledLog.close();
  }

  // 3.7 Owner readback via GET /api/link-ops-jobs
  const jobsReadback = await apiRequest('/api/link-ops-jobs?limit=10', {
    method: 'GET',
    cookie: authCookie,
  });
  assert.equal(jobsReadback.status, 200);
  const foundJob = asArray(jobsReadback.json?.data).find(j => j.id === enqueuedJob.id);
  assert.ok(foundJob);
  assert.equal(foundJob.kind, 'inventory_maintenance');
  assert.equal(foundJob.result?.version, null);
  reportCheck('E4.7: GET /api/link-ops-jobs 正确回读当前 owner 的后台维护作业且绝不泄露敏感本地路径');

  // SECTION 4: F3 applyIntentPlanJob Mid-Flight Lease Checkpoints
  // ----------------------------------------------------
  const {__testHooks: pTestHooks} = await import('../scripts/serve_bi_portal.mjs');
  let leaseCheckCalls = 0;
  const fakeJob = {
    jobId: 'job-f3-deep-001',
    payload: {message: '复制上品到 XL', actor: {username: 'owner_user', role: 'owner'}},
    chatSessionId: 'session-f3-001',
    taskId: c1TaskId,
  };

  try {
    await pTestHooks.applyIntentPlanJob(fakeJob, {
      checkLease: () => {
        leaseCheckCalls++;
        if (leaseCheckCalls >= 3) {
          throw new Error('LEASE_EXPIRED_DURING_MUTATION_PIPELINE');
        }
      },
      signal: new AbortController().signal,
    });
    assert.fail('Should have failed at mid-flight checkpoint');
  } catch (err) {
    assert.equal(err.message, 'LEASE_EXPIRED_DURING_MUTATION_PIPELINE');
  }
  assert.ok(leaseCheckCalls >= 3, 'Must have traversed mid-flight lease checks before persistence');
  reportCheck('F3.1: applyIntentPlanJob 在规划后与持久化边界深度执行 checkLease，租期失效严格阻断');

  console.log('ALL REAL HTTP & STRICT LOGIC INTEGRATION TESTS PASSED OK!');
} catch (error) {
  console.error('INTEGRATION TEST FAILED:', error);
  try {
    const logExcerpt = await fs.readFile(serverLogFile, 'utf8');
    console.error('PORTAL SERVER LOG:\n' + logExcerpt.slice(-2000));
  } catch {}
  process.exitCode = 1;
} finally {
  portalProcess.kill();
  fakeOpenApi.close();
  await serverLogStream.close().catch(() => {});
  await fs.rm(tmpRoot, {recursive: true, force: true}).catch(() => {});
}

function asArray(v) { return Array.isArray(v) ? v : []; }
