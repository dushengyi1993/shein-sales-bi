#!/usr/bin/env node
/**
 * Isolated smoke for BI automation chat -> maintenance OpenAPI precheck.
 *
 * This proves non-copy actions (inventory/price/title/shelf/image/certificate
 * maintenance family) enter the same natural-language chat state machine as
 * copy_product_draft. It uses a local fake OpenAPI server and never touches
 * real SHEIN.
 */
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = path.join(ROOT, 'tmp');
await fs.mkdir(tmpBase, {recursive: true});
const tmpRoot = await fs.mkdtemp(path.join(tmpBase, 'bi-ops-chat-maintenance-flow-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
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
      try { json = text ? JSON.parse(text) : null; } catch {}
      resolve({text, json});
    });
    req.on('error', reject);
  });
}

async function writeJson(relPath, value) {
  const file = path.join(tmpRoot, relPath);
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}

function b64Json(value) {
  return Buffer.from(JSON.stringify(value, null, 2), 'utf8').toString('base64');
}

async function req(baseUrl, urlPath, {method = 'GET', cookie = '', body = null} = {}) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      ...(cookie ? {cookie} : {}),
      ...(body ? {'content-type': 'application/json'} : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return {status: res.status, headers: res.headers, text, json};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

const fakeCalls = [];
const productRows = [
  {skcName: 'sv-maint-skc', spuName: 'spu-maint', supplierCode: 'SK-1234', skuCodeList: ['sku-maint-001']},
  {skcName: 'sv-maint-inactive-skc', spuName: 'spu-maint-inactive', supplierCode: 'SK-5678', skuCodeList: ['sku-maint-002']},
];
const fakePort = await freePort();
const fakeOpenApi = http.createServer(async (request, response) => {
  const body = await readBody(request);
  const pathname = request.url.split('?')[0];
  fakeCalls.push({method: request.method, path: pathname, body: body.json || body.text});
  if (pathname === '/open-api/openapi-business-backend/query-store-info') {
    return sendJson(response, {
      code: '0',
      msg: 'OK',
      info: {
        shopName: 'GS7676443',
        accountNo: 'GS7676443',
        merchantId: '6746928',
        supplierId: '6746928',
        companyName: '冬玺',
      },
    });
  }
  if (pathname === '/open-api/goods/query-site-list') {
    return sendJson(response, {
      code: '0',
      msg: 'OK',
      info: [{sub_site_list: [{site_abbr: 'shein-sa', currency: 'SAR'}]}],
    });
  }
  if (pathname === '/open-api/stock/change-inventory/v2') {
    return sendJson(response, {
      code: '0',
      msg: 'OK',
      traceId: 'fake-inventory-submit-trace',
      info: {submitted: true},
    });
  }
  if (pathname === '/open-api/goods/update-cost') {
    return sendJson(response, {
      code: '0',
      msg: 'OK',
      traceId: 'fake-supply-price-submit-trace',
      info: {submitted: true},
    });
  }
  if (pathname === '/open-api/openapi-business-backend/product/price/save') {
    return sendJson(response, {
      code: '0',
      msg: 'OK',
      traceId: 'fake-product-price-submit-trace',
      info: {submitted: true},
    });
  }
  if (pathname === '/open-api/goods/product/partialEdit') {
    return sendJson(response, {
      code: '0',
      msg: 'OK',
      traceId: 'fake-partial-edit-submit-trace',
      info: {submitted: true},
    });
  }
  if (pathname === '/open-api/goods/save-certificate-pool-skc-bind') {
    if (body.json?.skc_name !== 'sv-maint-skc' || body.json?.certificate_pool_id !== 'CERTPOOL-MAINT') {
      return sendJson(response, {code: '400', msg: 'bad certificate payload'}, 200);
    }
    return sendJson(response, {
      code: '0',
      msg: 'OK',
      traceId: 'fake-certificate-submit-trace',
      info: {submitted: true},
    });
  }
  if (pathname === '/open-api/goods/modify-skc-shelf') {
    return sendJson(response, {
      code: '0',
      msg: 'OK',
      traceId: 'fake-shelf-submit-trace',
      info: {submitted: true},
    });
  }
  if (pathname === '/open-api/stock/stock-query') {
    return sendJson(response, {
      code: '0',
      msg: 'OK',
      traceId: 'fake-stock-readback-trace',
      info: [{skuCode: 'sku-maint-001', availableInventory: 111}],
    });
  }
  if (pathname === '/open-api/openapi-business-backend/product/query') {
    return sendJson(response, {
      code: '0',
      msg: 'OK',
      traceId: 'fake-product-readback-trace',
      info: {data: productRows},
    });
  }
  return sendJson(response, {code: '404', msg: `Unexpected fake OpenAPI call: ${pathname}`}, 404);
});
await new Promise(resolve => fakeOpenApi.listen(fakePort, '127.0.0.1', resolve));

const result = {ok: false, tmpRoot, checks: [], summary: {}};
function check(label, actual, expected) {
  const pass = typeof expected === 'function' ? expected(actual) : actual === expected;
  result.checks.push({label, actual, expected: typeof expected === 'function' ? expected.name || 'predicate' : expected, pass});
  return pass;
}

let portal = null;
try {
  const authFile = await writeJson('auth.json', {
    users: [{
      username: 'owner_chat_maintenance',
      password: 'owner-chat-maintenance-pass',
      displayName: 'Owner Chat Maintenance',
      role: 'owner',
      readStores: ['*'],
      writeStores: ['*'],
      ownerKey: 'OWNER',
    }],
  });
  const accessRolesFile = await writeJson('access_roles.json', {
    defaults: {
      owner: {readStores: ['*'], writeStores: ['*']},
      operator: {readStores: ['*'], writeStores: []},
    },
    users: {},
  });
  const openapiConfigFile = await writeJson('openapi.json', {
    apiBaseUrls: {prodSemiManaged: `http://127.0.0.1:${fakePort}`},
    stores: [{
      storeKey: 'DX',
      enabled: true,
      openKeyId: 'dummy-open',
      secretKey: 'dummy-secret',
    }],
    safeWriteOperations: {
      enabled: true,
      requireDryRun: true,
      allowedOperations: [
        'update_inventory',
        'update_supply_price',
        'update_product_price',
        'update_title',
        'update_images',
        'retire_link',
        'activate_link',
        'certificate_review',
      ],
      allowedStores: ['DX'],
    },
  });
  const whitelistFile = await writeJson('whitelist.json', {
    enabled: true,
    rules: [{
      id: 'dx-owner-inventory-chat-smoke',
      enabled: true,
      realSubmit: true,
      stores: ['DX'],
      operations: [
        'update_inventory',
        'update_supply_price',
        'update_product_price',
        'update_title',
        'update_images',
        'retire_link',
        'activate_link',
        'certificate_review',
      ],
      allowedUsers: ['owner_chat_maintenance'],
      allowedOwnerKeys: ['OWNER'],
      allowedRoles: ['owner'],
      note: 'isolated fake OpenAPI smoke only',
    }],
  });
  const readProbeSummaryFile = await writeJson('read-probes.latest.json', {
    generatedAt: new Date().toISOString(),
    results: [{
      storeKey: 'DX',
      ok: true,
      status: 'read_probe_ok',
      domains: ['store_info', 'product', 'stock'],
    }],
    counts: {ok: 1, total: 1},
  });
  const htpasswdFile = path.join(tmpRoot, 'empty.htpasswd');
  await fs.writeFile(htpasswdFile, '', 'utf8');
  const portalDir = path.join(tmpRoot, 'portal');
  await fs.mkdir(portalDir, {recursive: true});
  await fs.writeFile(path.join(portalDir, 'index.html'), '<!doctype html><meta charset="utf-8"><title>BI Ops Test</title>', 'utf8');
  await writeJson('portal/data.json', {generatedAt: new Date().toISOString(), data: {}});
  await writeJson('portal/sections/linksData.json', {
    data: {
      storeLinks: [{
        store_key: 'DX',
        skc: 'sv-maint-skc',
        spu: 'spu-maint',
        standard_goods_sn: 'SK-1234',
        product_display_name: 'SK-1234',
        is_on_shelf: true,
        shelf_status_name: '已上架',
      }, {
        store_key: 'DX',
        skc: 'sv-maint-inactive-skc',
        spu: 'spu-maint-inactive',
        standard_goods_sn: 'SK-5678',
        product_display_name: 'SK-5678',
        is_on_shelf: false,
        shelf_status_name: '已下架',
      }],
    },
  });
  const productCacheDir = path.join(tmpRoot, 'products');
  await writeJson('products/DX/latest.json', {
    normalizedRows: [{
      storeKey: 'DX',
      skc: 'sv-maint-skc',
      spu: 'spu-maint',
      supplierCode: 'SK-1234',
      skuCodes: '["sku-maint-001"]',
      costSar: 70,
      sheinUsableInventory: 30,
    }, {
      storeKey: 'DX',
      skc: 'sv-maint-inactive-skc',
      spu: 'spu-maint-inactive',
      supplierCode: 'SK-5678',
      skuCodes: '["sku-maint-002"]',
      costSar: 80,
      sheinUsableInventory: 0,
    }],
  });
  const stateFile = path.join(tmpRoot, 'action_state.json');
  const taskFile = path.join(tmpRoot, 'tasks.json');
  const chatFile = path.join(tmpRoot, 'chats.json');
  const auditFile = path.join(tmpRoot, 'audit.jsonl');
  const sessionSecretFile = path.join(tmpRoot, 'session_secret');
  const manualLoginStateFile = path.join(tmpRoot, 'manual_login.json');
  const portalPort = await freePort();
  const baseUrl = `http://127.0.0.1:${portalPort}`;
  portal = spawn(process.execPath, [
    'scripts/serve_bi_portal.mjs',
    '--host', '127.0.0.1',
    '--port', String(portalPort),
    '--dir', portalDir,
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
      SHEIN_BI_CORE_WARMUP_DISABLED: '1',
      SHEIN_OPENAPI_CONFIG_FILE: openapiConfigFile,
      SHEIN_OPENAPI_READ_PROBE_SUMMARY_FILE: readProbeSummaryFile,
      SHEIN_OPENAPI_PRODUCT_CACHE_DIR: productCacheDir,
      SHEIN_BI_OPS_WRITE_WHITELIST_FILE: whitelistFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  portal.stdout.on('data', data => { stdout += data.toString(); });
  portal.stderr.on('data', data => { stderr += data.toString(); });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (portal.exitCode !== null) throw new Error(`portal exited code=${portal.exitCode}\nstdout=${stdout}\nstderr=${stderr}`);
    try {
      const ready = await fetch(`${baseUrl}/login`, {redirect: 'manual'});
      if (ready.status >= 200 && ready.status < 500) break;
    } catch {}
    await sleep(200);
  }
  const login = await req(baseUrl, '/api/login', {
    method: 'POST',
    body: {username: 'owner_chat_maintenance', password: 'owner-chat-maintenance-pass'},
  });
  const cookie = (login.headers.get('set-cookie') || '').match(/bi_session=[^;]+/)?.[0] || '';
  check('login status', login.status, 200);
  check('login cookie present', Boolean(cookie), true);

  const cases = [
    {
      label: 'inventory',
      message: '把 DX 的 SK-1234 库存改成 100',
      intent: 'update_inventory',
      answerRe: /维护动作：改库存/,
    },
    {
      label: 'supply price',
      message: '把 DX 的 SK-1234 供货价改成 80 SAR',
      intent: 'update_supply_price',
      answerRe: /维护动作：改供货价/,
    },
    {
      label: 'product price',
      message: '把 DX 的 SK-1234 售价改成 99 SAR',
      intent: 'update_product_price',
      answerRe: /维护动作：改商品售价/,
    },
  ];
  const summaries = [];
  for (const item of cases) {
    const chat = await req(baseUrl, '/api/link-ops-chats', {
      method: 'POST',
      cookie,
      body: {message: item.message, askAgent: false},
    });
    const autoTask = chat.json?.autoTask || {};
    const answer = asArray(chat.json?.session?.messages).at(-1)?.content || '';
    const executor = asArray(autoTask?.execution?.linkMaintenanceExecutors)[0] || {};
    summaries.push({
      label: item.label,
      chatStatus: chat.status,
      taskId: autoTask.id || '',
      taskStatus: autoTask.status || '',
      executionState: autoTask.execution?.state || '',
      intents: autoTask.intents || [],
      payloadFound: Boolean(executor?.payload?.found || executor?.payload?.payloadHash),
      operations: executor?.payload?.summary?.operations || [],
      answer,
    });

    check(`${item.label} chat status`, chat.status, 200);
    check(`${item.label} maintenance task created`, Boolean(autoTask.id), true);
    check(`${item.label} maintenance intent inferred`, autoTask.intents, xs => asArray(xs).includes(item.intent));
    check(`${item.label} maintenance precheck ready`, autoTask.execution?.state || '', 'link_maintenance_preflight_ready');
    check(`${item.label} maintenance precheck ok`, autoTask.execution?.preflight?.ok, true);
    check(`${item.label} maintenance payload prepared`, Boolean(executor?.payload?.found || executor?.payload?.payloadHash), true);
    check(`${item.label} maintenance operation in payload`, executor?.payload?.summary?.operations || [], xs => asArray(xs).includes(item.intent));
    check(`${item.label} chat answer mentions maintenance action`, answer, x => item.answerRe.test(String(x)));
    check(`${item.label} chat answer says material passed`, answer, x => /资料检查通过/.test(String(x)));
    check(`${item.label} chat answer is not copy-only wording`, answer, x => !/源链接/.test(String(x)));
  }
  const dryRunCalls = fakeCalls.slice();
  check('dry-run did not call write inventory endpoint', dryRunCalls.some(call => call.path === '/open-api/stock/change-inventory/v2'), false);
  check('dry-run did not call write supply-price endpoint', dryRunCalls.some(call => call.path === '/open-api/goods/update-cost'), false);
  check('dry-run did not call write product-price endpoint', dryRunCalls.some(call => call.path === '/open-api/openapi-business-backend/product/price/save'), false);

  const executeCases = [
    {
      label: 'execute inventory',
      message: '把 DX 的 SK-1234 库存改成 111',
      intent: 'update_inventory',
      endpoint: '/open-api/stock/change-inventory/v2',
      readbackEndpoint: '/open-api/stock/stock-query',
    },
    {
      label: 'execute supply price',
      message: '把 DX 的 SK-1234 供货价改成 80 SAR',
      intent: 'update_supply_price',
      endpoint: '/open-api/goods/update-cost',
      readbackEndpoint: '/open-api/openapi-business-backend/product/query',
    },
    {
      label: 'execute product price',
      message: '把 DX 的 SK-1234 售价改成 99 SAR',
      intent: 'update_product_price',
      endpoint: '/open-api/openapi-business-backend/product/price/save',
      readbackEndpoint: '/open-api/openapi-business-backend/product/query',
    },
    {
      label: 'execute title',
      message: '把 DX 的 SK-1234 标题改成 New Smoke Title',
      intent: 'update_title',
      endpoint: '/open-api/goods/product/partialEdit',
      readbackEndpoint: '/open-api/openapi-business-backend/product/query',
    },
    {
      label: 'execute image',
      message: '给 DX 的 SK-1234 换主图',
      intent: 'update_images',
      endpoint: '/open-api/goods/product/partialEdit',
      readbackEndpoint: '/open-api/openapi-business-backend/product/query',
      files: [{
        name: 'image-partial-edit.json',
        type: 'application/json',
        dataBase64: b64Json({
          partialEditPayload: {
            spu_name: 'spu-maint',
            skc_list: [{
              skc_name: 'sv-maint-skc',
              image_info: {
                image_group_code: 'G-maint',
                image_info_list: [{
                  image_sort: 1,
                  image_type: 1,
                  image_url: 'http://imgdeal-test01.shein.com/images3_pi/maint-main.jpg',
                }],
              },
            }],
          },
        }),
      }],
    },
    {
      label: 'execute retire',
      message: '把 DX 的 SK-1234 下架',
      intent: 'retire_link',
      endpoint: '/open-api/goods/modify-skc-shelf',
      readbackEndpoint: '/open-api/openapi-business-backend/product/query',
    },
    {
      label: 'execute activate',
      message: '把 DX 的 SK-5678 重新上架',
      intent: 'activate_link',
      endpoint: '/open-api/goods/modify-skc-shelf',
      readbackEndpoint: '/open-api/openapi-business-backend/product/query',
    },
    {
      label: 'execute certificate',
      message: '给 DX 的 SK-1234 补证书',
      intent: 'certificate_review',
      endpoint: '/open-api/goods/save-certificate-pool-skc-bind',
      readbackEndpoint: null,
      expectManualResolve: true,
      files: [{
        name: 'certificate-bind.json',
        type: 'application/json',
        dataBase64: b64Json({
          certificatePayloads: [{
            endpoint: '/open-api/goods/save-certificate-pool-skc-bind',
            body: {
              skc_name: 'sv-maint-skc',
              certificate_pool_id: 'CERTPOOL-MAINT',
            },
          }],
        }),
      }],
    },
  ];
  const executeSummaries = [];
  for (const item of executeCases) {
    const executeStart = await req(baseUrl, '/api/link-ops-chats', {
      method: 'POST',
      cookie,
      body: {message: item.message, askAgent: false},
    });
    const executeSessionId = String(executeStart.json?.session?.id || '');
    const executeTask = executeStart.json?.autoTask || {};
    let checkedStartTask = executeTask;
    if (item.files) {
      const upload = await req(baseUrl, '/api/link-ops-assets', {
        method: 'POST',
        cookie,
        body: {taskId: executeTask.id, files: item.files},
      });
      checkedStartTask = upload.json?.task || {};
      const uploadAnswer = asArray(upload.json?.session?.messages).at(-1)?.content || '';
      check(`${item.label} upload asset status`, upload.status, 200);
      check(`${item.label} upload stores one asset`, asArray(upload.json?.assets).length, item.files.length);
      check(`${item.label} upload triggers material recheck`, checkedStartTask.execution?.state || '', 'link_maintenance_preflight_ready');
      check(`${item.label} upload recheck answer is conversational`, uploadAnswer, text => /上传|资料检查|可以执行|提交吧|照做/.test(String(text)) && !/SHEIN_OPENAPI_SUBMIT|payload hash|dry-run|审计/.test(String(text)));
    }
    const executeCallsBefore = fakeCalls.length;
    const executeConfirm = await req(baseUrl, '/api/link-ops-chats', {
      method: 'POST',
      cookie,
      body: {sessionId: executeSessionId, message: '干吧', askAgent: false},
    });
    const confirmedTask = executeConfirm.json?.autoTask || {};
    const confirmAnswer = asArray(executeConfirm.json?.session?.messages).at(-1)?.content || '';
    const writeAudit = confirmedTask.execution?.writeAudit || {};
    const maintenanceRun = asArray(confirmedTask.execution?.linkMaintenanceExecutors || confirmedTask.execution?.linkMaintenancePrechecks)[0] || {};
    const callsAfterExecute = fakeCalls.slice(executeCallsBefore).map(call => call.path);
    const summary = {
      label: item.label,
      startStatus: executeStart.status,
      confirmStatus: executeConfirm.status,
      sessionId: executeSessionId,
      taskId: confirmedTask.id || executeTask.id || '',
      taskStatus: confirmedTask.status || '',
      lifecycleStatus: confirmedTask.lifecycle?.lifecycleStatus || confirmedTask.lifecycle?.status || '',
      executionState: confirmedTask.execution?.state || '',
      executeAllowed: Boolean(writeAudit.executeAllowed),
      issuedExecuteToExecutor: Boolean(writeAudit.issuedExecuteToExecutor),
      actualWriteSubmitted: Boolean(writeAudit.actualWriteSubmitted),
      sheinWriteAttempted: Boolean(writeAudit.sheinWriteAttempted),
      maintenanceMode: maintenanceRun.mode || '',
      maintenanceState: maintenanceRun.state || maintenanceRun.result?.state || '',
      operations: maintenanceRun.payload?.summary?.operations || maintenanceRun.result?.payload?.summary?.operations || [],
      callsAfterExecute,
      answer: confirmAnswer,
    };
    executeSummaries.push(summary);
    check(`${item.label} start chat status`, executeStart.status, 200);
    check(`${item.label} start created eligible task`, Boolean(executeTask.id), true);
    check(`${item.label} start has session id`, Boolean(executeSessionId), true);
    check(`${item.label} start task waiting review`, executeTask.status || '', 'waiting_review');
    if (!item.files) {
      check(`${item.label} start precheck ready`, executeTask.execution?.state || '', 'link_maintenance_preflight_ready');
    } else {
      check(`${item.label} start may wait for uploaded material`, ['link_maintenance_preflight_ready', 'link_maintenance_preflight_blocked', 'blocked'].includes(String(executeTask.execution?.state || '')), true);
      check(`${item.label} precheck ready after upload`, checkedStartTask.execution?.state || '', 'link_maintenance_preflight_ready');
    }
    check(`${item.label} natural execute chat status`, executeConfirm.status, 200);
    check(`${item.label} natural execute keeps same task`, confirmedTask.id || '', executeTask.id || '');
    check(`${item.label} issued execute to maintenance executor`, summary.issuedExecuteToExecutor, true);
    check(`${item.label} allowed by gates`, summary.executeAllowed, true);
    check(`${item.label} attempted fake SHEIN write`, summary.sheinWriteAttempted, true);
    check(`${item.label} submitted fake SHEIN write`, summary.actualWriteSubmitted, true);
    check(`${item.label} child mode execute`, summary.maintenanceMode, 'execute');
    check(`${item.label} child state submitted`, summary.maintenanceState, 'submitted');
    check(`${item.label} operation matches`, summary.operations, xs => asArray(xs).includes(item.intent));
    check(`${item.label} called fake write endpoint`, callsAfterExecute.some(path => path === item.endpoint), true);
    if (item.readbackEndpoint) {
      check(`${item.label} called fake readback endpoint`, callsAfterExecute.some(path => path === item.readbackEndpoint), true);
      check(`${item.label} completed by readback`, summary.lifecycleStatus, 'submitted_readback_matched');
      check(`${item.label} chat answer reports success`, confirmAnswer, text => /提交成功/.test(String(text)) && /回读/.test(String(text)));
    } else {
      check(`${item.label} no fake readback endpoint required`, item.expectManualResolve, true);
      check(`${item.label} remains manual resolve after submit`, summary.lifecycleStatus, 'submitted_readback_failed');
      check(`${item.label} chat answer reports submitted pending confirmation`, confirmAnswer, text => /提交成功/.test(String(text)) && /确认|核对|审核|回读/.test(String(text)));
    }
    check(`${item.label} chat answer is user-facing`, confirmAnswer, text => !/飞书|只读建议|回到 BI|SHEIN_OPENAPI_SUBMIT|确认文本|dry-run|payload hash|审计/.test(String(text)));
  }
  result.summary.executeCases = executeSummaries;
  result.summary = {...result.summary, cases: summaries, fakeCalls: fakeCalls.map(call => call.path)};
  result.ok = result.checks.every(row => row.pass);
} finally {
  if (portal) portal.kill('SIGTERM');
  await new Promise(resolve => fakeOpenApi.close(resolve));
  await sleep(200);
}

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);

