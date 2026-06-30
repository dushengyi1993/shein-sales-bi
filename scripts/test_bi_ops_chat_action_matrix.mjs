#!/usr/bin/env node
/**
 * Natural-language action matrix for the BI automation workbench.
 *
 * This is deliberately not a 505 regression. It proves the real frontend path
 * (`askAgent:true`) routes every supported OpenAPI operation family into the
 * same BI chat state machine with explicit write-store boundaries.
 *
 * The smoke starts an isolated portal with fake OpenAPI metadata and temporary
 * auth/task/chat files. It never talks to SHEIN and never enables real writes.
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
const tmpRoot = await fs.mkdtemp(path.join(tmpBase, 'bi-ops-chat-action-matrix-'));
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

function includesStore(value, store) {
  return asArray(value).map(x => String(x).toUpperCase()).includes(store);
}

function includesIntent(value, intent) {
  return asArray(value).map(x => String(x)).includes(intent);
}

const fakeCalls = [];
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
      username: 'owner_action_matrix',
      password: 'owner-action-matrix-pass',
      displayName: 'Owner Action Matrix',
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
    safeWriteOperations: {enabled: false, requireDryRun: true, allowedOperations: [], allowedStores: []},
  });
  const whitelistFile = await writeJson('whitelist.json', {enabled: false, rules: []});
  const htpasswdFile = path.join(tmpRoot, 'empty.htpasswd');
  await fs.writeFile(htpasswdFile, '', 'utf8');
  const portalDir = path.join(tmpRoot, 'portal');
  await fs.mkdir(portalDir, {recursive: true});
  await fs.writeFile(path.join(portalDir, 'index.html'), '<!doctype html><meta charset="utf-8"><title>BI Ops Test</title>', 'utf8');
  await writeJson('portal/data.json', {generatedAt: new Date().toISOString(), data: {}});
  await writeJson('portal/sections/linksData.json', {
    data: {
      storeLinks: [
        {
          store_key: 'DX',
          skc: 'sv-matrix-main',
          spu: 'spu-matrix-main',
          standard_goods_sn: 'SK-8888',
          product_display_name: 'SK-8888测试咖啡机',
          is_on_shelf: true,
          shelf_status_name: '已上架',
        },
        {
          store_key: 'DX',
          skc: 'sv-matrix-inactive',
          spu: 'spu-matrix-inactive',
          standard_goods_sn: 'SK-5678',
          product_display_name: 'SK-5678测试空气炸锅',
          is_on_shelf: false,
          shelf_status_name: '已下架',
        },
      ],
    },
  });
  const productCacheDir = path.join(tmpRoot, 'products');
  await writeJson('products/DX/latest.json', {
    normalizedRows: [
      {
        storeKey: 'DX',
        skc: 'sv-matrix-main',
        spu: 'spu-matrix-main',
        supplierCode: 'SK-8888',
        skuCodes: '["sku-matrix-001"]',
        costSar: 70,
        sheinUsableInventory: 30,
      },
      {
        storeKey: 'DX',
        skc: 'sv-matrix-inactive',
        spu: 'spu-matrix-inactive',
        supplierCode: 'SK-5678',
        skuCodes: '["sku-matrix-002"]',
        costSar: 80,
        sheinUsableInventory: 0,
      },
    ],
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
  let ready = false;
  while (Date.now() < deadline) {
    if (portal.exitCode !== null) throw new Error(`portal exited code=${portal.exitCode}\nstdout=${stdout}\nstderr=${stderr}`);
    try {
      const res = await fetch(`${baseUrl}/login`, {redirect: 'manual'});
      if (res.status >= 200 && res.status < 500) {
        ready = true;
        break;
      }
    } catch {}
    await sleep(200);
  }
  check('portal ready', ready, true);
  const login = await req(baseUrl, '/api/login', {
    method: 'POST',
    body: {username: 'owner_action_matrix', password: 'owner-action-matrix-pass'},
  });
  const cookie = (login.headers.get('set-cookie') || '').match(/bi_session=[^;]+/)?.[0] || '';
  check('login status', login.status, 200);
  check('login cookie present', Boolean(cookie), true);

  const cases = [
    {
      label: 'copy product draft',
      message: '帮我给 DX 的 SK-8888 咖啡机补一条链接，复制所有店铺里流量最高的那条链接',
      expected: ['copy_product_draft'],
      forbidden: ['update_title', 'update_inventory', 'certificate_review'],
    },
    {
      label: 'retire link',
      message: '把 DX 的 SK-8888 已上架链接下架',
      expected: ['retire_link'],
      forbidden: ['copy_product_draft', 'activate_link'],
    },
    {
      label: 'activate link',
      message: '把 DX 的 SK-5678 重新上架',
      expected: ['activate_link'],
      forbidden: ['copy_product_draft', 'retire_link'],
    },
    {
      label: 'update title',
      message: '把 DX 的 SK-8888 标题改成 Premium Coffee Maker',
      expected: ['update_title'],
      forbidden: ['copy_product_draft'],
    },
    {
      label: 'update image',
      message: '给 DX 的 SK-8888 换主图',
      expected: ['update_images'],
      forbidden: ['copy_product_draft'],
    },
    {
      label: 'update inventory',
      message: '把 DX 的 SK-8888 补库存到 100',
      expected: ['update_inventory'],
      forbidden: ['copy_product_draft'],
    },
    {
      label: 'update supply price',
      message: '把 DX 的 SK-8888 供货价改成 80 SAR',
      expected: ['update_supply_price'],
      forbidden: ['copy_product_draft', 'update_product_price'],
    },
    {
      label: 'update product price',
      message: '把 DX 的 SK-8888 售价改成 99 SAR',
      expected: ['update_product_price'],
      forbidden: ['copy_product_draft', 'update_supply_price'],
    },
    {
      label: 'certificate review',
      message: '给 DX 的 SK-8888 补证书',
      expected: ['certificate_review'],
      forbidden: ['copy_product_draft'],
    },
  ];

  const summaries = [];
  for (const item of cases) {
    const chat = await req(baseUrl, '/api/link-ops-chats', {
      method: 'POST',
      cookie,
      body: {message: item.message, askAgent: true},
    });
    const autoTask = chat.json?.autoTask || {};
    const messages = asArray(chat.json?.session?.messages);
    const answer = messages[messages.length - 1]?.content || '';
    const targets = autoTask.targets || {};
    summaries.push({
      label: item.label,
      status: chat.status,
      taskId: autoTask.id || '',
      intents: autoTask.intents || [],
      stores: targets.stores || [],
      writeStores: targets.writeStores || [],
      answer,
    });
    check(`${item.label} chat status`, chat.status, 200);
    check(`${item.label} created current-session task`, Boolean(autoTask.id), true);
    check(`${item.label} task preview does not persist chat prose`, autoTask?.preview?.agentAnswer || '', '');
    check(`${item.label} task preview does not persist structured prose`, autoTask?.preview?.structuredAnswer || '', '');
    for (const intent of item.expected) {
      check(`${item.label} includes ${intent}`, autoTask.intents, xs => includesIntent(xs, intent));
    }
    for (const intent of item.forbidden) {
      check(`${item.label} excludes ${intent}`, autoTask.intents, xs => !includesIntent(xs, intent));
    }
    check(`${item.label} target store DX`, targets.stores, xs => includesStore(xs, 'DX'));
    check(`${item.label} write store DX explicit`, targets.writeStores, xs => includesStore(xs, 'DX'));
    check(`${item.label} product ref not 505-only`, targets.productRefs, xs => asArray(xs).some(v => /SK-(?:8888|5678)/i.test(String(v))));
    check(`${item.label} bypasses old read-only/Feishu wording`, answer, x => !/飞书|只读建议|回到 BI|缺 OpenAPI 发布 payload|SHEIN_OPENAPI_SUBMIT|输入“确认”|查看审计/.test(String(x)));
    check(`${item.label} answer stays conversational`, answer, x => /收到|资料|检查|补|处理|继续|缺/.test(String(x)));
  }
  const tasks = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  result.summary = {cases: summaries, taskCount: asArray(tasks.tasks).length, fakeCalls: fakeCalls.map(call => call.path)};
  check('one task per independent command', asArray(tasks.tasks).length, cases.length);
  check('dry-run matrix never called write endpoints', fakeCalls.some(call => [
    '/open-api/goods/modify-skc-shelf',
    '/open-api/stock/change-inventory/v2',
    '/open-api/goods/update-cost',
    '/open-api/openapi-business-backend/product/price/save',
    '/open-api/goods/product/partialEdit',
    '/open-api/goods/save-certificate-pool-skc-bind',
    '/open-api/goods/publishOrEdit',
  ].includes(call.path)), false);
  result.ok = result.checks.every(row => row.pass);
} finally {
  if (portal) portal.kill('SIGTERM');
  await new Promise(resolve => fakeOpenApi.close(resolve));
  await sleep(200);
}

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);
