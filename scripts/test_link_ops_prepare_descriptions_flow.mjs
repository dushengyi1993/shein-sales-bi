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
import {linkOpsPayloadHash} from '../lib/link_ops_repository.mjs';
import {createConfiguredLinkOpsStoreGateway} from '../lib/link_ops_store_gateway.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = path.join(ROOT, 'tmp');
await fs.mkdir(tmpBase, {recursive: true});
const tmpRoot = await fs.mkdtemp(path.join(tmpBase, 'bi-ops-prepare-descriptions-'));
const CONFIRM_TEXT = 'SHEIN_OPENAPI_SUBMIT';

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

const checks = [];
function check(label, actual, expected) {
  const pass = typeof expected === 'function' ? expected(actual) : actual === expected;
  checks.push({label, actual, expected: typeof expected === 'function' ? (expected.name || 'predicate') : expected, pass});
  return pass;
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
const htpasswdFile = path.join(tmpRoot, 'empty.htpasswd');
await fs.writeFile(htpasswdFile, '', 'utf8');
const stateFile = path.join(tmpRoot, 'action_state.json');
const taskFile = path.join(tmpRoot, 'tasks.json');
const chatFile = path.join(tmpRoot, 'chats.json');
const auditFile = path.join(tmpRoot, 'audit.jsonl');
const auditFailureMarker = path.join(tmpRoot, 'fail-description-audit.marker');
const sessionSecretFile = path.join(tmpRoot, 'session_secret');
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
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return {status: res.status, headers: res.headers, text, json};
}
async function runCli(cliArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      'scripts/bi_ops_cli.mjs',
      '--base-url', base,
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
  tasks[index] = {
    ...tasks[index],
    note: 'NM 待绑定描述',
    openapiPublishPayload: JSON.parse(JSON.stringify(payload)),
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
      targets: {stores: ['NM'], writeStores: ['NM'], productRefs: [supplierCode]},
    },
  });
  if (r.status !== 200) throw new Error(`create task failed: ${r.status} ${r.text}`);
  return r.json?.task?.id || r.json?.data?.tasks?.[0]?.id || '';
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

  // execute success requires code=0 AND explicit info.success===true
  const execute = await req('/api/link-ops-execute', {
    method: 'POST',
    cookie,
    body: {id: taskId1, mode: 'execute', confirm: CONFIRM_TEXT, source: 'test'},
  });
  check('execute lifecycle submitted_readback_matched', execute.json?.task?.lifecycle?.lifecycleStatus, 'submitted_readback_matched');
  check('execute status done', execute.json?.task?.status, 'done');
  const executorRun = execute.json?.task?.execution?.openApiProductExecutors?.[0] || {};
  check('execute readback ok', executorRun.readback?.ok, true);
  check('execute readback description matched', executorRun.readback?.descriptionReadback?.status, 'description_readback_matched');
  check('execute readback projection carries hashes only', JSON.stringify(executorRun.readback?.descriptionReadback?.summary || {}), text => !text.includes('selling point') && !text.includes('سطر'));

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
    ['close fake OpenAPI server', () => closeServer(fakeOpenApi, 'fake OpenAPI server')],
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
