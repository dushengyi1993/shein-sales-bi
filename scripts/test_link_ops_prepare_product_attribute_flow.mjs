#!/usr/bin/env node
/**
 * Integration smoke for the whitelisted product attribute repair
 * (prepare-product-attribute), the architect-approved two-step flow.
 *
 * Spins up an isolated fake SHEIN OpenAPI server and an isolated BI portal
 * (json store gateway, isolated alias/catalog registry copies) and proves:
 *   - a copy_product_draft dry-run whose template requires Hazardous
 *     materials classification(1002328) is blocked before the repair;
 *   - step 1 binds ONLY the verified whitelisted attribute through strict
 *     explicit alias equality (task raw 'SK-13015', donor raw
 *     'SK-13015杆式吸尘器', canonical 'SK-13015杆式吸尘器'), appends exactly
 *     one row to the SAME task, invalidates the old preflight and returns
 *     binding_committed_needs_description_rebind WITHOUT mutating the
 *     existing description binding;
 *   - titles, price, inventory, images and the description binding stay
 *     byte-identical (attribute-area fingerprint + binding fingerprints);
 *   - failure modes fail closed without any task write: alias mismatch
 *     (other product), unregistered descriptive variant, ignored alias,
 *     prefix-only inference, missing attribute, duplicate attribute,
 *     invalid attribute value, wrong donor store identity, missing/drifting
 *     Product Model(1000546), ambiguous/not-found/wrong-case search,
 *     unwhitelisted/string attributeId, invalid donor store/SKC, unknown
 *     body key, stale revision, missing attribute list, already-present
 *     target rows and multi-SKC payloads;
 *   - step 2: the existing prepare-descriptions command rebinds the SAME
 *     reviewed HTML at the current revision (no new task, no image
 *     re-upload), the attribute lock stays valid (description content
 *     pinning), and the dry-run then becomes ready;
 *   - the execution gate blocks dry-run on tampered donor-bound payloads,
 *     unbound whitelisted rows and alias registry drift;
 *   - the managed CLI exits 0 only when binding/readback/audit are verified,
 *     never claims dry-run readiness, replays idempotently and never
 *     publishes (no publishOrEdit call, no actualWriteSubmitted).
 */
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT,
  PRODUCT_ATTRIBUTE_BINDING_MODE_APPEND,
  PRODUCT_ATTRIBUTE_BINDING_SCHEMA_VERSION,
  PRODUCT_ATTRIBUTE_BINDING_SCHEMA_VERSION_V1,
  adoptablePayloadAttributeRow,
  bindProductAttributeToPayload,
  buildProductAliasContext,
  evaluateDonorProductAttributeEvidence,
  productAttributeAreaFingerprint,
  productAttributeBindingRequestKey,
  productAttributeBindingRequestKeyV2,
  productAttributeRefreshEventKey,
  productAttributeResignEventKey,
  productAttributeResignSanitizationEvidence,
  productAttributeTargetStandardGoodsSn,
  resolveExplicitProductAlias,
  sanitizeInvalidProductAttributeListRows,
  validateProductAttributeBindingLock,
  validateProductAttributeResignEvent,
  validateV1ProductAttributeHistory,
} from '../lib/link_ops_product_attribute_binding.mjs';
import {
  descriptionBindingRequestKey,
  sha256StableJson,
  sha256Utf8,
} from '../lib/link_ops_product_descriptions.mjs';
import {__testHooks as portalHooks} from './serve_bi_portal.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = path.join(ROOT, 'tmp');
await fs.mkdir(tmpBase, {recursive: true});
const tmpRoot = await fs.mkdtemp(path.join(tmpBase, 'bi-ops-prepare-product-attribute-'));

const TARGET_STORE = 'FY';
const DONOR_STORE = 'YJ';
const STANDARD_GOODS_SN = 'SK-13015';
const DONOR_FULL_CODE = 'SK-13015杆式吸尘器';
const OTHER_PRODUCT_CODE = 'SK-13014杆式吸尘器';
const SOURCE_SKC = 'sv260203191892816240982';
const DONOR_SKC = 'sv260202233956355340972';
const DONOR_SPU = 'v2602022339563553';
const SOURCE_SPU = 'v2602031918928162409';
const ATTRIBUTE_ID = 1002328;
const DONOR_VALUE_ID = 316914660;
const IMAGE_FINGERPRINT = crypto.createHash('sha256').update('attr-smoke-images').digest('hex');
const SOURCE_DETAIL_AT = new Date(Date.now() - 60 * 1000).toISOString();

const enLines = ['EN selling point one', 'EN selling point two', 'EN selling point three', 'EN selling point four', 'EN selling point five'];
const arLines = ['سطر أول', 'سطر ثانٍ', 'سطر ثالث', 'سطر رابع', 'سطر خامس'];
const zhLines = ['中文卖点一', '中文卖点二', '中文卖点三', '中文卖点四', '中文卖点五'];

const checks = [];
function check(label, actual, expected) {
  const pass = typeof expected === 'function' ? expected(actual) : actual === expected;
  checks.push({label, actual, expected: typeof expected === 'function' ? (expected.name || 'predicate') : expected, pass});
  return pass;
}
function asArray(value) { return Array.isArray(value) ? value : []; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

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

// Reviewed description material (same HTML reused by step 1 tasks and by the
// step-2 prepare-descriptions rebind).
const descSourceHtml = `<!doctype html><html><body>
<section id="s09">
  <p>说明：英文、阿文、中文分别展示三语核心卖点，请逐字复制不要改写。</p>
  <article class="card"><h3>英文</h3><code>${enLines.join('\n')}</code></article>
  <article class="card"><h3>阿文</h3><code>${arLines.join('\n')}</code></article>
  <div class="displaybox">${zhLines.map(line => `<div>${line}</div>`).join('')}</div>
</section>
</body></html>`;
const descSourceBytes = Buffer.from(descSourceHtml, 'utf8');
const descSourceFile = path.join(tmpRoot, 'SK-13015-review.html');
const descSourceSha = crypto.createHash('sha256').update(descSourceBytes).digest('hex');
const descContentSha = sha256Utf8([
  descSourceSha,
  sha256Utf8(arLines.join('\n')),
  sha256Utf8(enLines.join('\n')),
  sha256Utf8(zhLines.join('\n')),
].join('\n'));

const donorModes = {search: 'exact', attribute: 'present', identity: 'ok'};
const fakeOpenApiCalls = [];
let publishAttemptCount = 0;
const sourceLinkDir = path.join(ROOT, 'outputs', 'shein_links', 'DL');
const sourceOpenApiDir = path.join(ROOT, 'outputs', 'shein_openapi_products', 'DL');
async function writeSourceFixtures() {
  await fs.mkdir(sourceLinkDir, {recursive: true});
  await fs.mkdir(sourceOpenApiDir, {recursive: true});
  await fs.writeFile(path.join(sourceLinkDir, '2099-01-01.json'), `${JSON.stringify({
    linkRows: [{
      storeKey: 'DL',
      skc: SOURCE_SKC,
      spu: SOURCE_SPU,
      standardGoodsSn: STANDARD_GOODS_SN,
      productNameCn: STANDARD_GOODS_SN,
      rawGoodsSn: STANDARD_GOODS_SN,
    }],
    inventoryRows: [],
    performanceRows: [],
  }, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(sourceOpenApiDir, 'latest.json'), `${JSON.stringify({
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
          {language: 'en', productName: 'Attr bind source product'},
          {language: 'ar', productName: 'منتج مصدر'},
        ],
        productAttributeInfoList: [
          {attributeId: 1000546, attributeValueId: 0, attributeValue: STANDARD_GOODS_SN},
        ],
        skcInfoList: [{
          skcName: SOURCE_SKC,
          supplierCode: STANDARD_GOODS_SN,
          productMultiNameList: [
            {language: 'en', productName: 'Attr bind source product'},
            {language: 'ar', productName: 'منتج مصدر'},
          ],
          skcImageInfoList: [
            {imageUrl: 'https://example.invalid/attr-main.jpg', imageType: 'MAIN'},
            {imageUrl: 'https://example.invalid/attr-detail.jpg', imageType: 'DETAIL'},
            {imageUrl: 'https://example.invalid/attr-square.jpg', imageType: 'SQUARE'},
          ],
          saleAttributeList: [{attributeId: 301, attributeValueId: 401}],
          skuInfoList: [{
            skuCode: `SKU-${SOURCE_SKC}`,
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
async function removeSourceFixtures() {
  await fs.rm(sourceLinkDir, {recursive: true, force: true});
  await fs.rm(sourceOpenApiDir, {recursive: true, force: true});
}
const donorSupplierCode = () => {
  if (donorModes.search === 'alias-unregistered') return 'SK-13015迷你款';
  if (donorModes.search === 'alias-ignored') return 'p-DL-FZ-666';
  if (donorModes.search === 'alias-prefix') return 'SK-13015杆';
  if (donorModes.search === 'other-product') return OTHER_PRODUCT_CODE;
  return DONOR_FULL_CODE;
};
const donorResolvedSpu = () => donorModes.search === 'spu-remap' ? 'v-remapped-spu' : DONOR_SPU;
const donorAttributeRows = () => {
  const modelValue = donorModes.attribute === 'identitymissing' ? 'OTHER-MODEL' : STANDARD_GOODS_SN;
  const identity = {attributeId: 1000546, attributeValueId: 0, attributeValue: modelValue};
  const hazard = () => {
    if (donorModes.attribute === 'missing') return [];
    if (donorModes.attribute === 'adoptvalue') {
      return [{attributeId: ATTRIBUTE_ID, attributeValueId: 888888, attributeValue: 'Hazardous other value'}];
    }
    if (donorModes.attribute === 'duplicate') {
      return [
        {attributeId: ATTRIBUTE_ID, attributeValueId: DONOR_VALUE_ID, attributeValue: 'Not hazardous'},
        {attributeId: ATTRIBUTE_ID, attributeValueId: DONOR_VALUE_ID, attributeValue: 'Not hazardous'},
      ];
    }
    if (donorModes.attribute === 'valueinvalid') {
      return [{attributeId: ATTRIBUTE_ID, attributeValueId: 0, attributeValue: 'text only'}];
    }
    return [{attributeId: ATTRIBUTE_ID, attributeValueId: DONOR_VALUE_ID, attributeValue: 'Not hazardous'}];
  };
  return [identity, ...hazard()];
};

const fakeOpenApiPort = await getFreePort();
const fakeOpenApi = http.createServer(async (req, res) => {
  const body = await readBody(req);
  const pathname = req.url.split('?')[0];
  fakeOpenApiCalls.push({path: pathname, method: req.method, openKeyId: String(req.headers['x-lt-openkeyid'] || ''), body: body.json || body.text});
  if (pathname === '/open-api/openapi-business-backend/query-store-info') {
    const key = String(req.headers['x-lt-openkeyid'] || '').toLowerCase();
    const identityByStore = {
      'dummy-open-key-fy': {accountNo: 'GS6519274', merchantId: '6749531', companyName: '锋炎', shopName: 'FY'},
      'dummy-open-key-dl': {accountNo: 'GS5337922', merchantId: '6720288', companyName: '地利', shopName: 'DL'},
    };
    const yj = donorModes.identity === 'wrong'
      ? {accountNo: 'GS9999999', merchantId: '99999999', companyName: '错误店铺', shopName: 'WRONG'}
      : {accountNo: 'GS8146729', merchantId: '12225251', companyName: '永爵', shopName: 'YJ'};
    const identity = key === 'dummy-open-key-yj' ? yj : (identityByStore[key] || identityByStore['dummy-open-key-fy']);
    return sendJson(res, {code: '0', msg: 'OK', info: identity});
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
    return sendJson(res, {
      code: '0',
      msg: 'OK',
      info: {
        data: [{
          product_type_id: 789,
          attribute_infos: [
            {attribute_id: 101, attribute_name: 'Series', attribute_mode: 0, attribute_type: 1, attribute_status: 2, attribute_value_info_list: []},
            {attribute_id: 1000546, attribute_name: 'Product Model', attribute_mode: 0, attribute_type: 4, attribute_status: 2, attribute_value_info_list: []},
            {attribute_id: ATTRIBUTE_ID, attribute_name: 'Hazardous materials classification', attribute_mode: 0, attribute_type: 1, attribute_status: 3, attribute_value_info_list: [{attribute_value_id: DONOR_VALUE_ID, attribute_value: 'Not hazardous'}]},
          ],
        }],
      },
    });
  }
  if (pathname === '/open-api/goods/searchProduct') {
    const requestedSkcs = [
      ...asArray(body.json?.skcNameList),
      ...asArray(body.json?.skcSupplierCodeList),
    ].map(String);
    if (requestedSkcs.includes(SOURCE_SKC)) {
      return sendJson(res, {
        code: '0',
        msg: 'OK',
        info: {data: [{spuName: SOURCE_SPU, skcList: [{skcName: SOURCE_SKC, supplierCode: STANDARD_GOODS_SN, skuList: []}]}]},
      });
    }
    if (requestedSkcs.includes(DONOR_SKC)) {
      if (donorModes.search === 'notfound') return sendJson(res, {code: '0', msg: 'OK', info: {data: []}});
      if (donorModes.search === 'ambiguous') {
        return sendJson(res, {
          code: '0',
          msg: 'OK',
          info: {data: [
            {spuName: DONOR_SPU, skcList: [{skcName: DONOR_SKC, supplierCode: donorSupplierCode(), skuList: []}]},
            {spuName: 'v-other-spu', skcList: [{skcName: DONOR_SKC, supplierCode: donorSupplierCode(), skuList: []}]},
          ]},
        });
      }
      const skcName = donorModes.search === 'wrongcase' ? DONOR_SKC.toUpperCase() : DONOR_SKC;
      return sendJson(res, {
        code: '0',
        msg: 'OK',
        info: {data: [{spuName: donorResolvedSpu(), skcList: [{skcName, supplierCode: donorSupplierCode(), skuList: []}]}]},
      });
    }
    return sendJson(res, {code: '0', msg: 'OK', info: null});
  }
  if (pathname === '/open-api/goods/spu-info') {
    const spuName = String(body.json?.spuName || '');
    if (spuName === SOURCE_SPU) {
      return sendJson(res, {
        code: '0',
        msg: 'OK',
        info: {
          spuName: SOURCE_SPU,
          productMultiNameList: [
            {language: 'en', productName: 'Attr bind source product'},
            {language: 'ar', productName: 'منتج مصدر'},
          ],
          productAttributeInfoList: [{attributeId: 1000546, attributeValueId: 0, attributeValue: STANDARD_GOODS_SN}],
          skcInfoList: [{skcName: SOURCE_SKC, supplierCode: STANDARD_GOODS_SN, skuInfoList: []}],
        },
      });
    }
    if ((spuName === DONOR_SPU || spuName === 'v-remapped-spu') && donorModes.search !== 'notfound') {
      return sendJson(res, {
        code: '0',
        msg: 'OK',
        info: {
          spuName,
          productMultiNameList: [{language: 'en', productName: 'SK-13015 donor product'}],
          productAttributeInfoList: donorAttributeRows(),
          skcInfoList: [{skcName: DONOR_SKC, supplierCode: donorSupplierCode(), skuInfoList: [{skuCode: 'SKU-DONOR-1', supplierSku: ''}]}],
        },
      });
    }
    return sendJson(res, {code: '0', msg: 'OK', info: null});
  }
  if (pathname === '/open-api/goods/product/publishOrEdit') {
    publishAttemptCount += 1;
    return sendJson(res, {code: '500', msg: 'attribute smoke fake publish must never be reached', traceId: 'trace-attr-smoke'}, 200);
  }
  return sendJson(res, {code: '404', msg: `Unhandled fake endpoint: ${pathname}`}, 404);
});
await new Promise(resolve => fakeOpenApi.listen(fakeOpenApiPort, '127.0.0.1', resolve));

// --- isolated alias/catalog registry copies (env-overridden portal files) ---
const aliasFile = path.join(tmpRoot, 'product_aliases.json');
const catalogFile = path.join(tmpRoot, 'product_catalog.json');
await fs.copyFile(path.join(ROOT, 'config', 'product_aliases.json'), aliasFile);
await fs.copyFile(path.join(ROOT, 'config', 'product_catalog.json'), catalogFile);
const aliasBytes = await fs.readFile(aliasFile);
const catalogBytes = await fs.readFile(catalogFile);
const aliasRegistryFingerprint = crypto.createHash('sha256').update(aliasBytes).digest('hex');
const catalogFingerprint = crypto.createHash('sha256').update(catalogBytes).digest('hex');
const aliasBaselineText = aliasBytes.toString('utf8');
const catalogBaselineText = catalogBytes.toString('utf8');
async function driftAliasRegistry() {
  const registry = JSON.parse(await fs.readFile(aliasFile, 'utf8'));
  registry.aliases.push({canonical: 'SK-13015杆式吸尘器', aliases: ['SK-13015刷新漂移别名']});
  await fs.writeFile(aliasFile, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
}
async function driftCatalogRegistry() {
  const catalog = JSON.parse(await fs.readFile(catalogFile, 'utf8'));
  catalog.standards.push('SK-13015刷新漂移标准');
  await fs.writeFile(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
}
async function removeCanonicalFromCatalog() {
  const catalog = JSON.parse(await fs.readFile(catalogFile, 'utf8'));
  catalog.standards = catalog.standards.filter(value => value !== DONOR_FULL_CODE);
  await fs.writeFile(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
}
async function restoreAliasCatalogFiles() {
  await fs.writeFile(aliasFile, aliasBaselineText, 'utf8');
  await fs.writeFile(catalogFile, catalogBaselineText, 'utf8');
}

// --- portal config ---
const authFile = await writeJson('auth.json', {
  users: [{
    username: 'owner_attr_bind',
    password: 'owner-pass',
    displayName: 'Owner Attr Bind',
    role: 'owner',
    readStores: ['*'],
    writeStores: ['*'],
    ownerKey: 'OWNER_ATTR_BIND',
  }],
});
const accessRolesFile = await writeJson('access_roles.json', {
  defaults: {owner: {readStores: ['*'], writeStores: ['*']}, operator: {readStores: ['*'], writeStores: []}},
});
const openapiConfigFile = await writeJson('openapi.json', {
  environment: 'attr-bind-smoke',
  cooperationMode: '半托管',
  market: 'SA',
  apiBaseUrls: {prodSemiManaged: `http://127.0.0.1:${fakeOpenApiPort}`},
  stores: [
    {storeKey: TARGET_STORE, shopName: 'FY', enabled: true, openKeyId: 'dummy-open-key-fy', secretKey: 'dummy-secret-fy', authorizedAt: '2026-06-27T00:00:00.000+08:00'},
    {storeKey: DONOR_STORE, shopName: 'YJ', enabled: true, openKeyId: 'dummy-open-key-yj', secretKey: 'dummy-secret-yj', authorizedAt: '2026-06-27T00:00:00.000+08:00'},
    {storeKey: 'DL', shopName: 'DL', enabled: true, openKeyId: 'dummy-open-key-dl', secretKey: 'dummy-secret-dl', authorizedAt: '2026-06-27T00:00:00.000+08:00'},
  ],
  safeWriteOperations: {
    enabled: true,
    requireDryRun: true,
    allowedOperations: ['copy_product_draft'],
    allowedStores: [TARGET_STORE],
  },
});
const whitelistFile = await writeJson('whitelist.json', {
  enabled: true,
  rules: [{
    id: 'owner-fy-attr-bind',
    enabled: true,
    realSubmit: true,
    stores: [TARGET_STORE],
    operations: ['copy_product_draft'],
    allowedUsers: ['owner_attr_bind'],
    allowedOwnerKeys: ['OWNER_ATTR_BIND'],
    allowedRoles: ['owner'],
  }],
});
const readProbeSummaryFile = await writeJson('read-probes.latest.json', {
  generatedAt: new Date().toISOString(),
  counts: {total: 1, readProbeOk: 1, pending: 0, failed: 0},
  results: [{storeKey: TARGET_STORE, ok: true, status: 'read_probe_ok'}],
});
const htpasswdFile = path.join(tmpRoot, 'empty.htpasswd');
await fs.writeFile(htpasswdFile, '', 'utf8');
const stateFile = path.join(tmpRoot, 'action_state.json');
const taskFile = path.join(tmpRoot, 'tasks.json');
const chatFile = path.join(tmpRoot, 'chats.json');
const auditFile = path.join(tmpRoot, 'audit.jsonl');
const attributeAuditFailMarker = path.join(tmpRoot, 'fail-attribute-audit.marker');
const sessionSecretFile = path.join(tmpRoot, 'session_secret');
const manualLoginStateFile = path.join(tmpRoot, 'manual_login.json');
const portalDir = path.join(tmpRoot, 'portal');
await fs.mkdir(portalDir, {recursive: true});
await fs.writeFile(path.join(portalDir, 'index.html'), '<!doctype html><html><body>attr-bind-test-portal</body></html>', 'utf8');

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
    SHEIN_BI_TEST_ATTRIBUTE_AUDIT_FAIL_FILE: attributeAuditFailMarker,
    SHEIN_PRODUCT_ALIASES_FILE: aliasFile,
    SHEIN_PRODUCT_CATALOG_FILE: catalogFile,
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
async function login() {
  const r = await req('/api/login', {method: 'POST', body: {username: 'owner_attr_bind', password: 'owner-pass'}});
  const setCookie = r.headers.get('set-cookie') || '';
  const cookie = (setCookie.match(/bi_session=[^;]+/) || [''])[0];
  if (r.status !== 200 || !cookie) throw new Error(`login failed: status=${r.status}`);
  return cookie;
}
async function rawTaskById(id) {
  const data = JSON.parse(await fs.readFile(taskFile, 'utf8').catch(() => '{"tasks":[]}'));
  return asArray(data?.tasks).find(task => String(task?.id || '') === String(id || '')) || null;
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
async function createTask(cookie, code) {
  const r = await req('/api/link-ops-tasks', {
    method: 'POST',
    cookie,
    body: {
      command: `复制上品/补链接 ${STANDARD_GOODS_SN} 到 ${TARGET_STORE}（商品属性修复验收 ${code}）`,
      source: 'codex_desktop_cli_structured',
      intents: ['copy_product_draft'],
      targets: {
        stores: [TARGET_STORE],
        writeStores: [TARGET_STORE],
        productRefs: [STANDARD_GOODS_SN],
        sourceStores: ['DL'],
        sourceSkc: SOURCE_SKC,
      },
    },
  });
  if (r.status !== 200) throw new Error(`create task failed: ${r.status} ${r.text}`);
  return r.json?.task?.id || r.json?.data?.tasks?.[0]?.id || '';
}

function publishPayloadFor() {
  return {
    category_id: 123456,
    product_type_id: 789,
    source_system: 'OpenAPI',
    brand_code: 'BRAND_SMOKE',
    site_list: [{main_site: 'shein', sub_site_list: ['shein-sa']}],
    multi_language_name_list: [
      {language: 'en', product_name: 'Attr bind smoke product'},
      {language: 'ar', product_name: 'منتج تجريبي'},
    ],
    multi_language_desc_list: [
      {language: 'ar', name: arLines.join('\n')},
      {language: 'en', name: enLines.join('\n')},
    ],
    product_attribute_list: [
      {attribute_id: 101, attribute_value_id: 202},
      {attribute_id: 1000546, attribute_value_id: 0, attribute_value: STANDARD_GOODS_SN},
    ],
    shelf_way: 2,
    hope_on_sale_date: '2036-06-27 10:00:00',
    skc_list: [{
      supplier_code: STANDARD_GOODS_SN,
      skc_name: STANDARD_GOODS_SN,
      image_info: {
        image_info_list: [
          {image_type: 1, image_sort: 1, image_url: 'https://img.shein.com/main.jpg'},
          {image_type: 5, image_sort: 2, image_url: 'https://img.shein.com/square.jpg'},
        ],
      },
      sale_attribute: {attribute_id: 301, attribute_value_id: 401},
      sku_list: [{
        supplier_sku: `${STANDARD_GOODS_SN}-SKU`,
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

function descriptionBindingFor(taskId, payload, baseTaskRevision = 1, imageBindingFingerprint = IMAGE_FINGERPRINT) {
  const sourceProof = 'server_verified_html_section_s09';
  return {
    schemaVersion: 1,
    kind: 'copy_product_draft',
    sourceApproved: true,
    authority: 'human_reviewed_source',
    sourceProof,
    targetStore: TARGET_STORE,
    boundAt: '2026-08-15T00:00:00.000Z',
    boundByUser: 'owner_attr_bind',
    baseTaskRevision,
    bindingRequestKey: descriptionBindingRequestKey({
      taskId,
      targetStore: TARGET_STORE,
      baseTaskRevision,
      contentSha256: descContentSha,
      sourceProof,
    }),
    sourceLabel: 'SK-13015-review.html',
    sourceByteLength: descSourceBytes.byteLength,
    sourceFileSha256: descSourceSha,
    contentSha256: descContentSha,
    publishLanguages: ['ar', 'en'],
    lineCounts: {ar: 5, en: 5, 'zh-cn': 5},
    hashes: {
      ar: sha256Utf8(arLines.join('\n')),
      en: sha256Utf8(enLines.join('\n')),
      'zh-cn': sha256Utf8(zhLines.join('\n')),
    },
    newPayloadHash: sha256StableJson(payload),
    payloadHashAlgorithm: 'sha256-stable-json-v1',
    imageBindingFingerprint,
  };
}

function validPublishAssetBindingFixture(task) {
  const images = [
    {name: 'attr-main.jpg', role: 'main', imageType: 1, imageUrl: 'https://img.shein.com/main.jpg', width: 1000, height: 1000, sha256: crypto.createHash('sha256').update('attr-main-image').digest('hex')},
    {name: 'attr-square.jpg', role: 'square', imageType: 5, imageUrl: 'https://img.shein.com/square.jpg', width: 800, height: 800, sha256: crypto.createHash('sha256').update('attr-square-image').digest('hex')},
  ];
  const binding = {
    schemaVersion: 1,
    sourceApproved: true,
    authority: 'human_reviewed_source',
    targetStore: TARGET_STORE,
    boundAt: '2026-08-15T00:00:00.000Z',
    boundByUser: 'owner_attr_bind',
    imageCount: images.length,
    images,
    evidence: {payloadSource: 'task', preflightInvalidated: true},
    publishPreparation: {
      standardGoodsSn: STANDARD_GOODS_SN,
      supplyPrice: null,
      inventory: null,
      categoryId: null,
      titles: {},
      attributeOverrides: [],
    },
  };
  binding.bindingFingerprint = portalHooks.canonicalPublishAssetBindingFingerprint(task, {
    binding,
    images: binding.images,
  });
  return binding;
}

async function attachFullPayload(taskId, {skipDescription = false} = {}) {
  const payload = publishPayloadFor();
  await updateRawTaskById(taskId, task => ({
    ...task,
    note: `${TARGET_STORE} 待绑定缺失白名单商品属性`,
    openapiPublishPayload: JSON.parse(JSON.stringify(payload)),
    publishAssetBinding: {
      bindingFingerprint: IMAGE_FINGERPRINT,
      boundAt: '2026-08-15T00:00:00.000Z',
      payloadSource: 'task',
      imageCount: 2,
    },
    ...(skipDescription ? {} : {
      descriptionMaterialBinding: descriptionBindingFor(taskId, payload, Number(task?.repositoryRevision || 1)),
    }),
  }));
}

async function bindProductAttribute(cookie, taskId, {
  donorStore = DONOR_STORE,
  donorSkc = DONOR_SKC,
  attributeId = ATTRIBUTE_ID,
  bindingMode = null,
  expectedRevision = null,
  extraBody = {},
} = {}) {
  const task = await rawTaskById(taskId);
  const revision = expectedRevision ?? Number(task?.repositoryRevision || 0);
  return req('/api/link-ops-prepare-product-attribute', {
    method: 'POST',
    cookie,
    body: {
      taskId,
      store: TARGET_STORE,
      donorStore,
      donorSkc,
      attributeId,
      ...(bindingMode === null ? {} : {bindingMode}),
      expectedRevision: revision,
      ...extraBody,
    },
  });
}

async function attachFullPayloadWithRow(taskId, {valueId = DONOR_VALUE_ID, skipDescription = false} = {}) {
  const payload = publishPayloadFor();
  if (valueId !== null) {
    payload.product_attribute_list = [
      ...payload.product_attribute_list,
      {attribute_id: ATTRIBUTE_ID, attribute_value_id: valueId},
    ];
  }
  await updateRawTaskById(taskId, task => {
    const assetBinding = validPublishAssetBindingFixture(task);
    return {
      ...task,
      note: `${TARGET_STORE} 待 adopt 既有白名单商品属性`,
      openapiPublishPayload: JSON.parse(JSON.stringify(payload)),
      publishAssetBinding: assetBinding,
      ...(skipDescription ? {} : {
        descriptionMaterialBinding: descriptionBindingFor(
          taskId,
          payload,
          Number(task?.repositoryRevision || 1),
          String(assetBinding.bindingFingerprint || ''),
        ),
      }),
    };
  });
}

async function refreshBinding(cookie, taskId, {
  expectedRevision = null,
  expectedBindingRequestKey = '',
  extraBody = {},
} = {}) {
  const task = await rawTaskById(taskId);
  const revision = expectedRevision ?? Number(task?.repositoryRevision || 0);
  const bindingKey = expectedBindingRequestKey || String(task?.productAttributeBinding?.bindingRequestKey || '');
  return req('/api/link-ops-prepare-product-attribute', {
    method: 'POST',
    cookie,
    body: {
      taskId,
      store: TARGET_STORE,
      bindingMode: 'refresh_binding',
      expectedRevision: revision,
      expectedBindingRequestKey: bindingKey,
      ...extraBody,
    },
  });
}

async function downgradeBindingToV1(taskId, {explicitAppendMode = false} = {}) {
  await updateRawTaskById(taskId, task => {
    const binding = JSON.parse(JSON.stringify(task.productAttributeBinding));
    binding.schemaVersion = PRODUCT_ATTRIBUTE_BINDING_SCHEMA_VERSION_V1;
    if (explicitAppendMode) binding.bindingMode = PRODUCT_ATTRIBUTE_BINDING_MODE_APPEND;
    else delete binding.bindingMode;
    const v1Key = productAttributeBindingRequestKey({
      taskId: task.id,
      targetStore: binding.targetStore,
      baseTaskRevision: Number(binding.baseTaskRevision || 0),
      attributeId: binding.attributeId,
      attributeValueId: binding.attributeValueId,
      donorStore: binding.donor?.storeKey || '',
      donorSkc: binding.donor?.skc || '',
      donorSpu: binding.donor?.spu || '',
      evidenceSha256: String(binding.evidenceSha256 || ''),
    });
    binding.bindingRequestKey = v1Key;
    // A genuine v1 record's immutable original bound event also carries the
    // v1 request key; rewrite the matching event so the v1 history gate can
    // verify field-for-field equality.
    const history = asArray(task.history).map(entry => (
      entry?.event === 'product_attribute_bound'
        ? {...entry, bindingRequestKey: v1Key}
        : entry
    ));
    return {...task, productAttributeBinding: binding, history};
  });
}

async function currentAliasFingerprints() {
  const aliasBytesNow = await fs.readFile(aliasFile);
  const catalogBytesNow = await fs.readFile(catalogFile);
  return {
    alias: crypto.createHash('sha256').update(aliasBytesNow).digest('hex'),
    catalog: crypto.createHash('sha256').update(catalogBytesNow).digest('hex'),
  };
}

async function restoreTaskSnapshot(taskId, snapshot) {
  await updateRawTaskById(taskId, () => JSON.parse(JSON.stringify(snapshot)));
}

async function stopChild(child, label, {graceMs = 5_000, killMs = 2_000} = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  if (await waitForChildExit(child, graceMs)) return;
  child.kill('SIGKILL');
  if (!await waitForChildExit(child, killMs)) throw new Error(`${label} did not exit after SIGKILL`);
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
  const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (await Promise.race([Promise.resolve(closed).then(() => true), new Promise(resolve => setTimeout(() => resolve(false), graceMs))])) return;
  server.closeAllConnections?.();
  if (!await Promise.race([Promise.resolve(closed).then(() => true), new Promise(resolve => setTimeout(() => resolve(false), forceMs))])) {
    throw new Error(`${label} did not close after terminating connections`);
  }
}

let cleanupOnExit = false;
try {
  await writeSourceFixtures();
  await fs.writeFile(descSourceFile, descSourceBytes, 'utf8');
  await waitReady();
  const cookie = await login();

  // --- unit: lib gates (no I/O) ---
  const unitAliasContext = buildProductAliasContext({
    aliasRegistryJson: JSON.parse(aliasBytes.toString('utf8')),
    catalogJson: JSON.parse(catalogBytes.toString('utf8')),
    aliasRegistryFingerprint,
    catalogFingerprint,
    aliasRegistrySource: 'config/product_aliases.json',
    catalogSource: 'config/product_catalog.json',
  });
  // Focused exact-alias compatibility: the three user-confirmed codes must
  // resolve; near-miss and unregistered forms must never become exact
  // aliases (no prefix inference, no fuzzy matching).
  const unitAliasChecks = [
    ['SK-7025A', 'SK-7025A绞肉机'],
    ['SK-JFB-794', 'SK-JFB-794卷发钳和卷发棒'],
    ['SK-15032', 'SK-15032热风梳'],
    ['SK-15032热风梳', 'SK-15032热风梳'],
  ];
  for (const [raw, expectedCanonical] of unitAliasChecks) {
    const resolved = resolveExplicitProductAlias(unitAliasContext, raw);
    check(`unit: exact alias ${raw} resolves`, resolved.ok, true);
    check(`unit: exact alias ${raw} canonical`, resolved.canonical, expectedCanonical);
  }
  for (const raw of ['SK-7025A绞', 'SK-JFB-794卷', 'SK-15032热', 'SK-15032X', 'SK7025A', 'SK-JFB794']) {
    const resolved = resolveExplicitProductAlias(unitAliasContext, raw);
    check(`unit: near-miss ${raw} is not an exact alias`, resolved.ok, false);
    check(`unit: near-miss ${raw} code`, resolved.blockers.map(blocker => blocker.code)
      .includes('PRODUCT_ALIAS_NOT_FOUND'), true);
  }
  const unitEvidence = evaluateDonorProductAttributeEvidence({
    donorStore: DONOR_STORE,
    donorSkc: DONOR_SKC,
    attributeId: ATTRIBUTE_ID,
    aliasContext: unitAliasContext,
    taskRawCode: STANDARD_GOODS_SN,
    taskModelValue: STANDARD_GOODS_SN,
    identity: {ok: true, evidenceSha256: crypto.createHash('sha256').update('unit-identity').digest('hex')},
    searchEnvelope: {code: '0', msg: 'OK', info: {data: [{spuName: DONOR_SPU, skcList: [{skcName: DONOR_SKC, supplierCode: DONOR_FULL_CODE, skuList: []}]}]}},
    spuInfoEnvelope: {code: '0', msg: 'OK', info: {spuName: DONOR_SPU, productAttributeInfoList: donorAttributeRows(), skcInfoList: [{skcName: DONOR_SKC, supplierCode: DONOR_FULL_CODE, skuInfoList: []}]}},
    verifiedAt: new Date().toISOString(),
  });
  check('unit: donor evidence chain ok', unitEvidence.ok, true);
  check('unit: donor value id extracted', unitEvidence.attributeValueId, DONOR_VALUE_ID);
  check('unit: canonical identity', unitEvidence.evidence?.canonicalCode, DONOR_FULL_CODE);
  const unitMissing = evaluateDonorProductAttributeEvidence({
    donorStore: DONOR_STORE,
    donorSkc: DONOR_SKC,
    attributeId: ATTRIBUTE_ID,
    aliasContext: unitAliasContext,
    taskRawCode: STANDARD_GOODS_SN,
    taskModelValue: STANDARD_GOODS_SN,
    identity: {ok: true, evidenceSha256: crypto.createHash('sha256').update('x').digest('hex')},
    searchEnvelope: {code: '0', msg: 'OK', info: {data: [{spuName: DONOR_SPU, skcList: [{skcName: DONOR_SKC, supplierCode: DONOR_FULL_CODE}]}]}},
    spuInfoEnvelope: {code: '0', msg: 'OK', info: {spuName: DONOR_SPU, productAttributeInfoList: [{attributeId: 1000546, attributeValueId: 0, attributeValue: STANDARD_GOODS_SN}], skcInfoList: [{skcName: DONOR_SKC, supplierCode: DONOR_FULL_CODE}]}},
    verifiedAt: new Date().toISOString(),
  });
  check('unit: missing donor attribute fails', unitMissing.ok, false);
  check('unit: missing donor attribute code', unitMissing.blockers.map(b => b.code).includes('DONOR_ATTRIBUTE_MISSING'), true);
  const unitPayload = publishPayloadFor();
  const areaBefore = productAttributeAreaFingerprint(unitPayload);
  const boundUnit = JSON.parse(JSON.stringify(unitPayload));
  boundUnit.product_attribute_list = [...boundUnit.product_attribute_list, {attribute_id: ATTRIBUTE_ID, attribute_value_id: DONOR_VALUE_ID}];
  check('unit: attribute-area fingerprint unchanged by attribute-only edit', productAttributeAreaFingerprint(boundUnit), areaBefore);
  const multiSkc = JSON.parse(JSON.stringify(unitPayload));
  multiSkc.skc_list = [...multiSkc.skc_list, {...multiSkc.skc_list[0]}];
  check('unit: multi-SKC target identity rejected', productAttributeTargetStandardGoodsSn(multiSkc).ok, false);
  const dualUnitPayload = JSON.parse(JSON.stringify(unitPayload));
  dualUnitPayload.productAttributeList = dualUnitPayload.product_attribute_list;
  let dualBindCode = '';
  try {
    bindProductAttributeToPayload(dualUnitPayload, {attributeId: ATTRIBUTE_ID, attributeValueId: DONOR_VALUE_ID});
  } catch (error) {
    dualBindCode = String(error?.code || '');
  }
  check('unit: dual snake/camel lists rejected by bind', dualBindCode, 'PRODUCT_ATTRIBUTE_DUAL_LIST_PRESENT');
  const payloadPrototype = {kind: 'payload-prototype'};
  const rowPrototype = {kind: 'row-prototype'};
  const legalSaleRow = Object.assign(Object.create(rowPrototype), {attributeId: 301, attributeValueId: 401});
  const dirtyAttributeLists = Object.assign(Object.create(payloadPrototype), {
    keep: {title: 'unchanged', nested: [{value: 1}]},
    product_attribute_list: [
      {attribute_id: 0, value: 'drop-zero'},
      {attribute_id: -1, value: 'drop-negative'},
      {attribute_id: Number.MAX_SAFE_INTEGER + 1, value: 'drop-unsafe'},
      {attribute_id: 1000546, attribute_extra_value: 'MODEL-OK'},
    ],
    skc_list: [{
      sku_list: [{
        product_sku_attribute_list: [
          {attribute_id: '0', value: 'drop-nested-zero'},
          {attribute_id: '160', attribute_value_id: 62},
        ],
        ordinary_rows: [{attribute_id: 0, value: 'not-an-attribute-list-so-keep'}],
      }],
    }],
    saleAttributeList: [
      null,
      'not-an-object-row',
      [],
      {attributeId: 0, attributeValueId: 0},
      legalSaleRow,
    ],
    audit_attribute_list: [{attribute_id: 0, value: 'near-match-must-stay'}],
    customAttributeInfoList: [{attributeId: 0, value: 'custom-near-match-must-stay'}],
  });
  Object.defineProperty(dirtyAttributeLists, '__proto__', {
    value: {ownedDataField: true, nested: {value: 'preserve'}},
    enumerable: true,
    writable: true,
    configurable: true,
  });
  const sanitizedUnit = sanitizeInvalidProductAttributeListRows(dirtyAttributeLists);
  check('unit: sanitizer removes invalid rows only from exact allowlist fields', sanitizedUnit.removedCount, 8);
  check('unit: sanitizer keeps legal top-level attribute byte-for-byte', JSON.stringify(sanitizedUnit.payload.product_attribute_list), JSON.stringify([
    {attribute_id: 1000546, attribute_extra_value: 'MODEL-OK'},
  ]));
  check('unit: sanitizer keeps legal nested attribute byte-for-byte', JSON.stringify(sanitizedUnit.payload.skc_list[0].sku_list[0].product_sku_attribute_list), JSON.stringify([
    {attribute_id: '160', attribute_value_id: 62},
  ]));
  check('unit: sanitizer does not touch non-attribute-list arrays', JSON.stringify(sanitizedUnit.payload.skc_list[0].sku_list[0].ordinary_rows), JSON.stringify([
    {attribute_id: 0, value: 'not-an-attribute-list-so-keep'},
  ]));
  check('unit: sanitizer removes non-object rows from allowlisted list', sanitizedUnit.payload.saleAttributeList.length, 1);
  check('unit: sanitizer preserves legal row prototype', Object.getPrototypeOf(sanitizedUnit.payload.saleAttributeList[0]), rowPrototype);
  check('unit: sanitizer ignores audit near-match field', JSON.stringify(sanitizedUnit.payload.audit_attribute_list), JSON.stringify(dirtyAttributeLists.audit_attribute_list));
  check('unit: sanitizer ignores custom near-match field', JSON.stringify(sanitizedUnit.payload.customAttributeInfoList), JSON.stringify(dirtyAttributeLists.customAttributeInfoList));
  check('unit: sanitizer preserves payload prototype', Object.getPrototypeOf(sanitizedUnit.payload), payloadPrototype);
  check('unit: sanitizer preserves own __proto__ data field', Object.prototype.hasOwnProperty.call(sanitizedUnit.payload, '__proto__')
    && JSON.stringify(Object.getOwnPropertyDescriptor(sanitizedUnit.payload, '__proto__')) === JSON.stringify(Object.getOwnPropertyDescriptor(dirtyAttributeLists, '__proto__')), true);
  const expectedSanitizedPayload = Object.assign(Object.create(payloadPrototype), {
    keep: {title: 'unchanged', nested: [{value: 1}]},
    product_attribute_list: [{attribute_id: 1000546, attribute_extra_value: 'MODEL-OK'}],
    skc_list: [{sku_list: [{
      product_sku_attribute_list: [{attribute_id: '160', attribute_value_id: 62}],
      ordinary_rows: [{attribute_id: 0, value: 'not-an-attribute-list-so-keep'}],
    }]}],
    saleAttributeList: [Object.assign(Object.create(rowPrototype), {attributeId: 301, attributeValueId: 401})],
    audit_attribute_list: [{attribute_id: 0, value: 'near-match-must-stay'}],
    customAttributeInfoList: [{attributeId: 0, value: 'custom-near-match-must-stay'}],
  });
  Object.defineProperty(expectedSanitizedPayload, '__proto__', {
    value: {ownedDataField: true, nested: {value: 'preserve'}},
    enumerable: true,
    writable: true,
    configurable: true,
  });
  check('unit: sanitizer full payload differs only by exact invalid rows', isDeepStrictEqual(sanitizedUnit.payload, expectedSanitizedPayload), true);
  check('unit: sanitizer does not mutate input', dirtyAttributeLists.product_attribute_list.length, 4);
  check('unit: sanitizer does not mutate non-object source rows', dirtyAttributeLists.saleAttributeList.length, 5);

  // --- pre-binding dry-run is blocked by the required template attribute ---
  const preBlockedTaskId = await createTask(cookie, 'ATTR-PRE-BLOCKED');
  await attachFullPayload(preBlockedTaskId);
  const preBlockedDryRun = await req('/api/link-ops-execute', {
    method: 'POST',
    cookie,
    body: {id: preBlockedTaskId, mode: 'dry-run', source: 'codex_desktop_cli_prepare_product_attribute'},
  });
  check('pre-binding dry-run reaches the executor', preBlockedDryRun.status, 200);
  check('pre-binding dry-run blocked on required 1002328', asArray(preBlockedDryRun.json?.execution?.preflight?.blockers)
    .some(row => /1002328/.test(String(row))), true);

  // --- HTTP step-1 success path ---
  const successTaskId = await createTask(cookie, 'ATTR-HTTP');
  await attachFullPayload(successTaskId);
  const beforeRaw = await rawTaskById(successTaskId);
  const beforeRevision = Number(beforeRaw?.repositoryRevision || 0);
  const beforeSnapshot = {
    areaHash: productAttributeAreaFingerprint(beforeRaw.openapiPublishPayload),
    titles: JSON.stringify(beforeRaw.openapiPublishPayload.multi_language_name_list),
    descriptions: JSON.stringify(beforeRaw.openapiPublishPayload.multi_language_desc_list),
    cost: JSON.stringify(beforeRaw.openapiPublishPayload.skc_list[0].sku_list[0].cost_info),
    stock: JSON.stringify(beforeRaw.openapiPublishPayload.skc_list[0].sku_list[0].stock_info_list),
    imageFingerprint: String(beforeRaw.publishAssetBinding?.bindingFingerprint || ''),
    descriptionBinding: JSON.stringify(beforeRaw.descriptionMaterialBinding),
    publishAssetBinding: JSON.stringify(beforeRaw.publishAssetBinding),
  };
  const successHttp = await bindProductAttribute(cookie, successTaskId);
  check('success http status', successHttp.status, 200);
  check('success http bindingCommitted', successHttp.json?.bindingCommitted, true);
  check('success http readbackVerified', successHttp.json?.readbackVerified, true);
  check('success http auditPending', successHttp.json?.auditPending, false);
  check('success http needs-rebind stage', String(successHttp.json?.stage || ''), 'binding_committed_needs_description_rebind');
  check('success http next command', String(successHttp.json?.nextStep?.command || ''), 'prepare-descriptions');
  check('success http next realPublish false', successHttp.json?.nextStep?.realPublish, false);
  check('success http same task', String(successHttp.json?.task?.id || ''), successTaskId);
  check('success http bound attribute id', successHttp.json?.binding?.attributeId, ATTRIBUTE_ID);
  check('success http bound value id', successHttp.json?.binding?.attributeValueId, DONOR_VALUE_ID);
  check('success http donor provenance', successHttp.json?.binding?.donorStore, DONOR_STORE);
  check('success http donor skc exact case', successHttp.json?.binding?.donorSkc, DONOR_SKC);
  check('success http donor spu', successHttp.json?.binding?.donorSpu, DONOR_SPU);
  check('success http raw donor code', successHttp.json?.binding?.rawDonorCode, DONOR_FULL_CODE);
  check('success http raw task code', successHttp.json?.binding?.rawTaskCode, STANDARD_GOODS_SN);
  check('success http canonical', successHttp.json?.binding?.canonicalCode, DONOR_FULL_CODE);
  check('success http evidenceSha256 is sha256', /^[a-f0-9]{64}$/.test(String(successHttp.json?.binding?.evidenceSha256 || '')), true);
  const successRaw = await rawTaskById(successTaskId);
  check('success revision advanced exactly once', Number(successRaw?.repositoryRevision || 0), beforeRevision + 1);
  const successRows = asArray(successRaw?.openapiPublishPayload?.product_attribute_list)
    .filter(row => Number(row?.attribute_id) === ATTRIBUTE_ID);
  check('success payload has attribute exactly once', successRows.length, 1);
  check('success payload attribute value', Number(successRows[0]?.attribute_value_id), DONOR_VALUE_ID);
  check('success attribute-area fingerprint unchanged', productAttributeAreaFingerprint(successRaw.openapiPublishPayload), beforeSnapshot.areaHash);
  check('success titles unchanged', JSON.stringify(successRaw.openapiPublishPayload.multi_language_name_list), beforeSnapshot.titles);
  check('success descriptions unchanged', JSON.stringify(successRaw.openapiPublishPayload.multi_language_desc_list), beforeSnapshot.descriptions);
  check('success cost unchanged', JSON.stringify(successRaw.openapiPublishPayload.skc_list[0].sku_list[0].cost_info), beforeSnapshot.cost);
  check('success stock unchanged', JSON.stringify(successRaw.openapiPublishPayload.skc_list[0].sku_list[0].stock_info_list), beforeSnapshot.stock);
  check('success image binding fingerprint unchanged', String(successRaw.publishAssetBinding?.bindingFingerprint || ''), beforeSnapshot.imageFingerprint);
  check('success publish asset binding unchanged', JSON.stringify(successRaw.publishAssetBinding), beforeSnapshot.publishAssetBinding);
  check('success description binding untouched by step 1', JSON.stringify(successRaw.descriptionMaterialBinding), beforeSnapshot.descriptionBinding);
  const successLock = validateProductAttributeBindingLock(successRaw, successRaw.openapiPublishPayload);
  check('success persisted lock ok', successLock.ok, true);
  check('success lock pins old payload hash', /^[a-f0-9]{64}$/.test(String(successRaw?.productAttributeBinding?.oldPayloadHash || '')), true);
  check('success lock pins alias fingerprint', String(successRaw?.productAttributeBinding?.aliasRegistryFingerprint || ''), aliasRegistryFingerprint);
  check('success lock pins catalog fingerprint', String(successRaw?.productAttributeBinding?.catalogFingerprint || ''), catalogFingerprint);
  check('success append schema v2', Number(successRaw?.productAttributeBinding?.schemaVersion || 0), PRODUCT_ATTRIBUTE_BINDING_SCHEMA_VERSION);
  check('success append bindingMode', String(successRaw?.productAttributeBinding?.bindingMode || ''), PRODUCT_ATTRIBUTE_BINDING_MODE_APPEND);
  check('success append old!=new hash invariant', (() => {
    const binding = successRaw?.productAttributeBinding || {};
    return /^[a-f0-9]{64}$/.test(String(binding.oldPayloadHash || ''))
      && String(binding.oldPayloadHash) !== String(binding.newPayloadHash || '');
  })(), true);
  check('success append v2 request key', String(successRaw?.productAttributeBinding?.bindingRequestKey || ''), productAttributeBindingRequestKeyV2({
    schemaVersion: PRODUCT_ATTRIBUTE_BINDING_SCHEMA_VERSION,
    bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_APPEND,
    taskId: successTaskId,
    targetStore: TARGET_STORE,
    baseTaskRevision: Number(successRaw?.productAttributeBinding?.baseTaskRevision || 0),
    attributeId: ATTRIBUTE_ID,
    attributeValueId: DONOR_VALUE_ID,
    donorStore: DONOR_STORE,
    donorSkc: DONOR_SKC,
    donorSpu: DONOR_SPU,
    evidenceSha256: String(successRaw?.productAttributeBinding?.evidenceSha256 || ''),
    oldPayloadHash: String(successRaw?.productAttributeBinding?.oldPayloadHash || ''),
    newPayloadHash: String(successRaw?.productAttributeBinding?.newPayloadHash || ''),
  }));
  check('success preflight invalidated', String(successRaw?.execution?.state || ''), 'needs_repreflight');
  check('success actualWriteSubmitted false', Boolean(successRaw?.execution?.actualWriteSubmitted), false);
  check('success writeAudit reset', Boolean(successRaw?.execution?.writeAudit?.invalidatedByProductAttributeBinding), true);
  check('success history event once', asArray(successRaw?.history).filter(entry => entry?.event === 'product_attribute_bound').length, 1);
  check('success binding stores no raw account identity', JSON.stringify(successRaw?.productAttributeBinding || {}).includes('GS8146729'), false);

  // Step-1 dry-run is expected BLOCKED: the description lock is stale by
  // design; the attribute lock itself must pass (no PRODUCT_ATTRIBUTE
  // blockers), proving the attribute repair is intact.
  const step1DryRun = await req('/api/link-ops-execute', {
    method: 'POST',
    cookie,
    body: {id: successTaskId, mode: 'dry-run', source: 'codex_desktop_cli_prepare_product_attribute'},
  });
  check('step-1 dry-run blocked by stale description lock', String(step1DryRun.json?.execution?.state || ''), 'blocked');
  check('step-1 dry-run blocker mentions description drift', asArray(step1DryRun.json?.execution?.preflight?.blockers)
    .some(row => /newPayloadHash 与任务当前 openapiPublishPayload 不一致|hash 与审核资料绑定不一致/.test(String(row))), true);
  check('step-1 dry-run carries no attribute gate blocker', asArray(step1DryRun.json?.execution?.preflight?.blockers)
    .some(row => /PRODUCT_ATTRIBUTE/.test(String(row))), false);

  // --- HTTP adopt_existing success path ---
  const adoptTaskId = await createTask(cookie, 'ATTR-ADOPT-HTTP');
  await attachFullPayloadWithRow(adoptTaskId);
  const adoptBeforeRaw = await rawTaskById(adoptTaskId);
  const adoptBeforeRevision = Number(adoptBeforeRaw?.repositoryRevision || 0);
  const adoptBeforePayload = JSON.stringify(adoptBeforeRaw.openapiPublishPayload);
  const adoptBeforeDescription = JSON.stringify(adoptBeforeRaw.descriptionMaterialBinding);
  const adoptBeforeAssets = JSON.stringify(adoptBeforeRaw.publishAssetBinding);
  const adoptBeforeHash = sha256StableJson(adoptBeforeRaw.openapiPublishPayload);
  const adoptHttp = await bindProductAttribute(cookie, adoptTaskId, {bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT});
  check('adopt http status', adoptHttp.status, 200);
  check('adopt http stage verified', String(adoptHttp.json?.stage || ''), 'binding_committed_verified');
  check('adopt http next command preflight', String(adoptHttp.json?.nextStep?.command || ''), 'preflight');
  check('adopt http next realPublish false', adoptHttp.json?.nextStep?.realPublish, false);
  check('adopt http bindingMode', String(adoptHttp.json?.binding?.bindingMode || ''), PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT);
  check('adopt http schema v2', Number(adoptHttp.json?.binding?.schemaVersion || 0), PRODUCT_ATTRIBUTE_BINDING_SCHEMA_VERSION);
  check('adopt http bound value', adoptHttp.json?.binding?.attributeValueId, DONOR_VALUE_ID);
  check('adopt http old==new hash', (() => {
    const binding = adoptHttp.json?.binding || {};
    return binding.oldPayloadHash === adoptBeforeHash
      && binding.newPayloadHash === adoptBeforeHash
      && binding.oldPayloadHash === binding.newPayloadHash;
  })(), true);
  const adoptRaw = await rawTaskById(adoptTaskId);
  check('adopt revision advanced exactly once', Number(adoptRaw?.repositoryRevision || 0), adoptBeforeRevision + 1);
  check('adopt payload deep-equal unchanged', JSON.stringify(adoptRaw.openapiPublishPayload), adoptBeforePayload);
  check('adopt description binding byte-for-byte unchanged', JSON.stringify(adoptRaw.descriptionMaterialBinding), adoptBeforeDescription);
  check('adopt asset binding byte-for-byte unchanged', JSON.stringify(adoptRaw.publishAssetBinding), adoptBeforeAssets);
  check('adopt persisted lock ok', validateProductAttributeBindingLock(adoptRaw, adoptRaw.openapiPublishPayload).ok, true);
  check('adopt history event once', asArray(adoptRaw?.history).filter(entry => entry?.event === 'product_attribute_adopted').length, 1);
  check('adopt history keeps bound-event semantics', asArray(adoptRaw?.history).filter(entry => entry?.event === 'product_attribute_bound').length, 0);
  check('adopt actualWriteSubmitted false', Boolean(adoptRaw?.execution?.actualWriteSubmitted), false);
  check('adopt preflight invalidated', String(adoptRaw?.execution?.state || ''), 'needs_repreflight');
  const adoptDryRun = await req('/api/link-ops-execute', {
    method: 'POST',
    cookie,
    body: {id: adoptTaskId, mode: 'dry-run', source: 'test'},
  });
  check('adopt dry-run ready without rebind', String(adoptDryRun.json?.execution?.state || ''), 'openapi_product_preflight_ready');
  check('adopt dry-run no blockers', asArray(adoptDryRun.json?.execution?.preflight?.blockers).length, 0);
  check('adopt dry-run attribute count', Number(adoptDryRun.json?.execution?.openApiProductExecutors?.[0]?.payload?.summary?.productAttributeCount || 0), 3);
  check('adopt never publishes', publishAttemptCount, 0);

  async function makeStaleAppendResignTask(code, {withInvalidRows = true} = {}) {
    const taskId = await createTask(cookie, code);
    await attachFullPayload(taskId);
    await updateRawTaskById(taskId, task => {
      const assetBinding = validPublishAssetBindingFixture(task);
      return {
        ...task,
        publishAssetBinding: assetBinding,
        descriptionMaterialBinding: descriptionBindingFor(
          taskId,
          task.openapiPublishPayload,
          Number(task.repositoryRevision || 0),
          String(assetBinding.bindingFingerprint || ''),
        ),
      };
    });
    const initial = await bindProductAttribute(cookie, taskId);
    check(`${code} initial append binding 200`, initial.status, 200);
    await updateRawTaskById(taskId, task => {
      const payload = JSON.parse(JSON.stringify(task.openapiPublishPayload));
      if (withInvalidRows) {
        payload.product_attribute_list.splice(1, 0,
          {attribute_id: 0, attribute_value_id: 0, marker: 'legacy-top-zero'},
          {attribute_id: Number.MAX_SAFE_INTEGER + 1, attribute_value_id: 1, marker: 'legacy-top-unsafe'});
        const sku = payload.skc_list[0].sku_list[0];
        sku.product_sku_attribute_list = [
          {attribute_id: 0, attribute_value_id: 0, marker: 'legacy-nested-zero'},
          {attribute_id: 27, attribute_value_id: 536, marker: 'legal-nested'},
        ];
      }
      const assetBinding = JSON.parse(JSON.stringify(task.publishAssetBinding));
      return {
        ...task,
        repositoryRevision: Number(task.repositoryRevision || 0) + 1,
        openapiPublishPayload: payload,
        descriptionMaterialBinding: descriptionBindingFor(
          taskId,
          payload,
          Number(task.repositoryRevision || 0) + 1,
          String(assetBinding.bindingFingerprint || ''),
        ),
      };
    });
    return taskId;
  }

  // Same-identity stale append_missing binding: fresh live donor verification
  // may re-sign at the current revision. The only payload cleanup allowed is
  // recursive removal of invalid-ID rows from attribute-list fields.
  const resignAppendTaskId = await makeStaleAppendResignTask('ATTR-RESIGN-APPEND');
  const resignAppendBefore = await rawTaskById(resignAppendTaskId);
  const resignAppendRevision = Number(resignAppendBefore.repositoryRevision || 0);
  const resignAppendKey = String(resignAppendBefore.productAttributeBinding?.bindingRequestKey || '');
  const resignAppendSnapshot = {
    titles: JSON.stringify(resignAppendBefore.openapiPublishPayload.multi_language_name_list),
    descriptions: JSON.stringify(resignAppendBefore.openapiPublishPayload.multi_language_desc_list),
    images: JSON.stringify(resignAppendBefore.openapiPublishPayload.skc_list[0].image_info),
    cost: JSON.stringify(resignAppendBefore.openapiPublishPayload.skc_list[0].sku_list[0].cost_info),
    stock: JSON.stringify(resignAppendBefore.openapiPublishPayload.skc_list[0].sku_list[0].stock_info_list),
    assetBinding: JSON.stringify(resignAppendBefore.publishAssetBinding),
    descriptionBinding: JSON.stringify(resignAppendBefore.descriptionMaterialBinding),
    legalTopRows: JSON.stringify(resignAppendBefore.openapiPublishPayload.product_attribute_list
      .filter(row => Number.isSafeInteger(Number(row?.attribute_id)) && Number(row.attribute_id) > 0)),
  };
  const resignAppendSearchBefore = fakeOpenApiCalls.filter(call => call.path === '/open-api/goods/searchProduct'
    && String(call.body?.skcNameList || '').includes(DONOR_SKC)).length;
  const resignAppend = await bindProductAttribute(cookie, resignAppendTaskId, {bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_APPEND});
  check('stale append same-identity re-sign 200', resignAppend.status, 200);
  check('stale append re-sign stage needs description rebind', String(resignAppend.json?.stage || ''), 'binding_resigned_needs_description_rebind');
  check('stale append re-sign reports three removed rows', Number(resignAppend.json?.binding?.invalidAttributeRowsRemoved || 0), 3);
  const resignAppendRaw = await rawTaskById(resignAppendTaskId);
  const resignAppendHashBeforeSanitization = sha256StableJson(resignAppendBefore.openapiPublishPayload);
  const resignAppendHashAfterSanitization = sha256StableJson(resignAppendRaw.openapiPublishPayload);
  const resignAppendRemovedPaths = [
    '$.product_attribute_list[1]',
    '$.product_attribute_list[2]',
    '$.skc_list[0].sku_list[0].product_sku_attribute_list[0]',
  ];
  const expectedResignSanitization = productAttributeResignSanitizationEvidence({
    removedCount: 3,
    currentPayloadHashBeforeSanitization: resignAppendHashBeforeSanitization,
    currentPayloadHashAfterSanitization: resignAppendHashAfterSanitization,
    removedPathSummary: resignAppendRemovedPaths,
  });
  check('stale append records pre-sanitization current hash', String(resignAppend.json?.binding?.currentPayloadHashBeforeSanitization || ''), resignAppendHashBeforeSanitization);
  check('stale append records post-sanitization current hash', String(resignAppend.json?.binding?.currentPayloadHashAfterSanitization || ''), resignAppendHashAfterSanitization);
  check('stale append sanitation hashes differ when rows deleted', resignAppendHashBeforeSanitization !== resignAppendHashAfterSanitization, true);
  check('stale append persists deterministic sanitation evidence', JSON.stringify(resignAppendRaw.productAttributeBinding?.resignSanitization || {}), JSON.stringify(expectedResignSanitization));
  check('stale append re-sign revision +1', Number(resignAppendRaw.repositoryRevision || 0), resignAppendRevision + 1);
  check('stale append re-sign base revision current', Number(resignAppendRaw.productAttributeBinding?.baseTaskRevision || 0), resignAppendRevision);
  check('stale append re-sign request key changed', String(resignAppendRaw.productAttributeBinding?.bindingRequestKey || ''), value => /^[a-f0-9]{64}$/.test(String(value)) && value !== resignAppendKey);
  check('stale append re-sign current payload hash locked', String(resignAppendRaw.productAttributeBinding?.newPayloadHash || ''), sha256StableJson(resignAppendRaw.openapiPublishPayload));
  check('stale append re-sign lock valid', validateProductAttributeBindingLock(resignAppendRaw, resignAppendRaw.openapiPublishPayload).ok, true);
  check('stale append re-sign event valid', validateProductAttributeResignEvent(resignAppendRaw).ok, true);
  check('stale append re-sign deterministic event key', String(resignAppendRaw.productAttributeResignEvent?.eventKey || ''), productAttributeResignEventKey({
    taskId: resignAppendTaskId,
    previousBindingRequestKey: resignAppendKey,
    newBindingRequestKey: resignAppendRaw.productAttributeBinding?.bindingRequestKey,
    previousRepositoryRevision: resignAppendRevision,
    currentRepositoryRevision: resignAppendRevision + 1,
  }));
  check('stale append request key binds sanitation evidence', String(resignAppendRaw.productAttributeBinding?.bindingRequestKey || ''), productAttributeBindingRequestKeyV2({
    schemaVersion: PRODUCT_ATTRIBUTE_BINDING_SCHEMA_VERSION,
    bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_APPEND,
    taskId: resignAppendTaskId,
    targetStore: TARGET_STORE,
    baseTaskRevision: resignAppendRevision,
    attributeId: ATTRIBUTE_ID,
    attributeValueId: DONOR_VALUE_ID,
    donorStore: DONOR_STORE,
    donorSkc: DONOR_SKC,
    donorSpu: DONOR_SPU,
    evidenceSha256: resignAppendRaw.productAttributeBinding?.evidenceSha256,
    oldPayloadHash: resignAppendRaw.productAttributeBinding?.oldPayloadHash,
    newPayloadHash: resignAppendRaw.productAttributeBinding?.newPayloadHash,
    resignSanitization: expectedResignSanitization,
  }));
  for (const [label, mutate] of [
    ['removedCount', evidence => { evidence.removedCount += 1; }],
    ['beforeHash', evidence => { evidence.currentPayloadHashBeforeSanitization = 'a'.repeat(64); }],
    ['afterHash', evidence => { evidence.currentPayloadHashAfterSanitization = 'b'.repeat(64); }],
    ['removedPathSummary', evidence => { evidence.removedPathSummary[0] = '$.saleAttributeList[99]'; }],
  ]) {
    const tampered = JSON.parse(JSON.stringify(resignAppendRaw));
    mutate(tampered.productAttributeBinding.resignSanitization);
    check(`stale append sanitation tamper ${label} invalidates lock`, validateProductAttributeBindingLock(tampered, tampered.openapiPublishPayload).ok, false);
  }
  check('stale append removes top-level invalid IDs only', resignAppendRaw.openapiPublishPayload.product_attribute_list
    .some(row => !Number.isSafeInteger(Number(row?.attribute_id)) || Number(row.attribute_id) <= 0), false);
  check('stale append preserves all legal top-level rows', JSON.stringify(resignAppendRaw.openapiPublishPayload.product_attribute_list), resignAppendSnapshot.legalTopRows);
  check('stale append removes nested invalid ID', JSON.stringify(resignAppendRaw.openapiPublishPayload.skc_list[0].sku_list[0].product_sku_attribute_list), JSON.stringify([
    {attribute_id: 27, attribute_value_id: 536, marker: 'legal-nested'},
  ]));
  check('stale append preserves titles', JSON.stringify(resignAppendRaw.openapiPublishPayload.multi_language_name_list), resignAppendSnapshot.titles);
  check('stale append preserves descriptions', JSON.stringify(resignAppendRaw.openapiPublishPayload.multi_language_desc_list), resignAppendSnapshot.descriptions);
  check('stale append preserves payload images', JSON.stringify(resignAppendRaw.openapiPublishPayload.skc_list[0].image_info), resignAppendSnapshot.images);
  check('stale append preserves price', JSON.stringify(resignAppendRaw.openapiPublishPayload.skc_list[0].sku_list[0].cost_info), resignAppendSnapshot.cost);
  check('stale append preserves inventory', JSON.stringify(resignAppendRaw.openapiPublishPayload.skc_list[0].sku_list[0].stock_info_list), resignAppendSnapshot.stock);
  check('stale append preserves image binding', JSON.stringify(resignAppendRaw.publishAssetBinding), resignAppendSnapshot.assetBinding);
  check('stale append preserves description binding object', JSON.stringify(resignAppendRaw.descriptionMaterialBinding), resignAppendSnapshot.descriptionBinding);
  check('stale append history records one re-sign', asArray(resignAppendRaw.history).filter(row => row?.event === 'product_attribute_resigned').length, 1);
  const resignAppendAuditEntry = (await fs.readFile(auditFile, 'utf8')).split(/\r?\n/).filter(Boolean)
    .map(line => JSON.parse(line))
    .find(entry => entry?.type === 'link-ops-prepare-product-attribute-resigned'
      && entry?.eventKey === resignAppendRaw.productAttributeResignEvent?.eventKey);
  check('stale append external audit projects sanitation evidence', JSON.stringify(resignAppendAuditEntry?.binding?.resignSanitization || {}), JSON.stringify({
    removedCount: expectedResignSanitization.removedCount,
    currentPayloadHashBeforeSanitization: expectedResignSanitization.currentPayloadHashBeforeSanitization,
    currentPayloadHashAfterSanitization: expectedResignSanitization.currentPayloadHashAfterSanitization,
    removedPathDigest: expectedResignSanitization.removedPathDigest,
    evidenceSha256: expectedResignSanitization.evidenceSha256,
  }));
  const resignAppendSearchAfter = fakeOpenApiCalls.filter(call => call.path === '/open-api/goods/searchProduct'
    && String(call.body?.skcNameList || '').includes(DONOR_SKC)).length;
  check('stale append performs fresh donor verify', resignAppendSearchAfter, resignAppendSearchBefore + 1);
  const resignAppendDryRun = await req('/api/link-ops-execute', {
    method: 'POST', cookie, body: {id: resignAppendTaskId, mode: 'dry-run', source: 'test'},
  });
  check('stale append dry-run requires description rebind', asArray(resignAppendDryRun.json?.execution?.preflight?.blockers)
    .some(row => /newPayloadHash 与任务当前 openapiPublishPayload 不一致|hash 与审核资料绑定不一致/.test(String(row))), true);
  const resignAppendBindingKey = String(resignAppendRaw.productAttributeBinding?.bindingRequestKey || '');
  const resignAppendAfterStaleDryRun = await rawTaskById(resignAppendTaskId);
  const resignAppendRebind = await req('/api/link-ops-prepare-descriptions', {
    method: 'POST',
    cookie,
    body: {
      taskId: resignAppendTaskId,
      store: TARGET_STORE,
      sourceApproved: true,
      sourceFile: {name: path.basename(descSourceFile), dataBase64: descSourceBytes.toString('base64')},
      expectedRevision: Number(resignAppendAfterStaleDryRun.repositoryRevision || 0),
    },
  });
  check('stale append same reviewed HTML rebind succeeds', resignAppendRebind.status, 200);
  const resignAppendReboundRaw = await rawTaskById(resignAppendTaskId);
  check('stale append rebind keeps sanitized payload', sha256StableJson(resignAppendReboundRaw.openapiPublishPayload), sha256StableJson(resignAppendRaw.openapiPublishPayload));
  check('stale append rebind keeps attribute binding', String(resignAppendReboundRaw.productAttributeBinding?.bindingRequestKey || ''), resignAppendBindingKey);
  check('stale append rebind keeps image binding', JSON.stringify(resignAppendReboundRaw.publishAssetBinding), resignAppendSnapshot.assetBinding);
  check('stale append rebind keeps reviewed content', String(resignAppendReboundRaw.descriptionMaterialBinding?.contentSha256 || ''), descContentSha);
  const resignAppendFreshDryRun = await req('/api/link-ops-execute', {
    method: 'POST', cookie, body: {id: resignAppendTaskId, mode: 'dry-run', source: 'test'},
  });
  check('stale append fresh dry-run ready after same HTML rebind', String(resignAppendFreshDryRun.json?.execution?.state || ''), 'openapi_product_preflight_ready');
  check('stale append fresh dry-run has no blockers', asArray(resignAppendFreshDryRun.json?.execution?.preflight?.blockers).length, 0);
  check('stale append never publishes', publishAttemptCount, 0);

  // If CAS + repository readback succeeded but the external resign audit
  // append failed, an exact old-revision retry repairs only that audit. It
  // must not re-run donor verification, CAS, or history mutation; later
  // retries observe the one repair event and are idempotent.
  const resignAuditTaskId = await makeStaleAppendResignTask('ATTR-RESIGN-AUDIT-REPAIR');
  const resignAuditBefore = await rawTaskById(resignAuditTaskId);
  const resignAuditRevision = Number(resignAuditBefore.repositoryRevision || 0);
  const resignAuditSearchBefore = fakeOpenApiCalls.filter(call => call.path === '/open-api/goods/searchProduct'
    && String(call.body?.skcNameList || '').includes(DONOR_SKC)).length;
  await fs.writeFile(attributeAuditFailMarker, 'fail', 'utf8');
  const resignAuditCommit = await bindProductAttribute(cookie, resignAuditTaskId, {
    bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_APPEND,
    expectedRevision: resignAuditRevision,
  });
  await fs.rm(attributeAuditFailMarker, {force: true});
  check('resign audit failure still returns committed 200', resignAuditCommit.status, 200);
  check('resign audit failure reports pending', resignAuditCommit.json?.auditPending, true);
  check('resign audit failure reports ok false', resignAuditCommit.json?.ok, false);
  const resignAuditEventKey = String(resignAuditCommit.json?.eventKey || '');
  check('resign audit failure persists deterministic event key', resignAuditEventKey, value => /^[a-f0-9]{64}$/.test(String(value)));
  const resignAuditCommittedRaw = await rawTaskById(resignAuditTaskId);
  check('resign audit failure advances revision once', Number(resignAuditCommittedRaw.repositoryRevision || 0), resignAuditRevision + 1);
  check('resign audit failure repository event valid', validateProductAttributeResignEvent(resignAuditCommittedRaw).ok, true);
  const resignAuditRetry = await bindProductAttribute(cookie, resignAuditTaskId, {
    bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_APPEND,
    expectedRevision: resignAuditRevision,
  });
  check('resign audit exact retry succeeds', resignAuditRetry.status, 200);
  check('resign audit exact retry closes pending', resignAuditRetry.json?.auditPending, false);
  check('resign audit exact retry same event key', String(resignAuditRetry.json?.eventKey || ''), resignAuditEventKey);
  const resignAuditAfterRetry = await rawTaskById(resignAuditTaskId);
  check('resign audit retry does not CAS again', Number(resignAuditAfterRetry.repositoryRevision || 0), resignAuditRevision + 1);
  check('resign audit retry does not append history again', asArray(resignAuditAfterRetry.history).filter(entry => entry?.event === 'product_attribute_resigned').length, 1);
  const resignAuditRetryAgain = await bindProductAttribute(cookie, resignAuditTaskId, {
    bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_APPEND,
    expectedRevision: resignAuditRevision,
  });
  check('resign audit repeated retry idempotent 200', resignAuditRetryAgain.status, 200);
  check('resign audit repeated retry ok', resignAuditRetryAgain.json?.ok, true);
  check('resign audit repeated retry keeps revision', Number((await rawTaskById(resignAuditTaskId)).repositoryRevision || 0), resignAuditRevision + 1);
  const resignAuditRows = (await fs.readFile(auditFile, 'utf8')).split(/\r?\n/).filter(Boolean)
    .map(line => JSON.parse(line))
    .filter(entry => entry?.type === 'link-ops-prepare-product-attribute-resigned'
      && entry?.eventKey === resignAuditEventKey);
  check('resign audit repair appends exactly once', resignAuditRows.length, 1);
  check('resign audit repair projection marked repair', resignAuditRows[0]?.auditRepair, true);
  const resignAuditSearchAfter = fakeOpenApiCalls.filter(call => call.path === '/open-api/goods/searchProduct'
    && String(call.body?.skcNameList || '').includes(DONOR_SKC)).length;
  check('resign audit retries do not reverify donor', resignAuditSearchAfter, resignAuditSearchBefore + 1);
  check('resign audit repair never publishes', publishAttemptCount, 0);

  // Two stale re-sign requests against one revision: exactly one CAS may win;
  // the loser must conflict and cannot overwrite the winner.
  const resignRaceTaskId = await makeStaleAppendResignTask('ATTR-RESIGN-RACE');
  const resignRaceBefore = await rawTaskById(resignRaceTaskId);
  const resignRaceRevision = Number(resignRaceBefore.repositoryRevision || 0);
  const [resignRaceA, resignRaceB] = await Promise.all([
    bindProductAttribute(cookie, resignRaceTaskId, {bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_APPEND, expectedRevision: resignRaceRevision}),
    bindProductAttribute(cookie, resignRaceTaskId, {bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_APPEND, expectedRevision: resignRaceRevision}),
  ]);
  const resignRaceResults = [resignRaceA, resignRaceB];
  check('stale re-sign race exactly one winner', resignRaceResults.filter(result => result.status === 200).length, 1);
  check('stale re-sign race exactly one conflict', resignRaceResults.filter(result => result.status === 409).length, 1);
  const resignRaceWinner = resignRaceResults.find(result => result.status === 200);
  const resignRaceRaw = await rawTaskById(resignRaceTaskId);
  check('stale re-sign race revision advances once', Number(resignRaceRaw.repositoryRevision || 0), resignRaceRevision + 1);
  check('stale re-sign race loser cannot overwrite winner key', String(resignRaceRaw.productAttributeBinding?.bindingRequestKey || ''), String(resignRaceWinner?.json?.binding?.bindingRequestKey || ''));
  check('stale re-sign race records one resign event', asArray(resignRaceRaw.history).filter(entry => entry?.event === 'product_attribute_resigned').length, 1);
  check('stale re-sign race final lock valid', validateProductAttributeBindingLock(resignRaceRaw, resignRaceRaw.openapiPublishPayload).ok, true);
  check('stale re-sign race never publishes', publishAttemptCount, 0);

  // Same-identity stale adopt_existing binding: a valid current image-binding
  // replacement makes the old product-attribute lock stale, but a fresh donor
  // verification may re-sign it without changing the payload or description.
  const resignAdoptTaskId = await createTask(cookie, 'ATTR-RESIGN-ADOPT');
  await attachFullPayloadWithRow(resignAdoptTaskId);
  check('stale adopt initial binding 200', (await bindProductAttribute(cookie, resignAdoptTaskId, {bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT})).status, 200);
  await updateRawTaskById(resignAdoptTaskId, task => {
    const assetBinding = JSON.parse(JSON.stringify(task.publishAssetBinding));
    assetBinding.images = assetBinding.images.map((row, index) => ({
      ...row,
      name: `resign-${row.name}`,
      sha256: crypto.createHash('sha256').update(`resign-adopt-image-${index}`).digest('hex'),
    }));
    assetBinding.imageCount = assetBinding.images.length;
    assetBinding.bindingFingerprint = portalHooks.canonicalPublishAssetBindingFingerprint(task, {binding: assetBinding, images: assetBinding.images});
    const description = JSON.parse(JSON.stringify(task.descriptionMaterialBinding));
    description.imageBindingFingerprint = assetBinding.bindingFingerprint;
    return {
      ...task,
      repositoryRevision: Number(task.repositoryRevision || 0) + 1,
      publishAssetBinding: assetBinding,
      descriptionMaterialBinding: description,
    };
  });
  const resignAdoptBefore = await rawTaskById(resignAdoptTaskId);
  const resignAdoptRevision = Number(resignAdoptBefore.repositoryRevision || 0);
  const resignAdoptPayload = JSON.stringify(resignAdoptBefore.openapiPublishPayload);
  const resignAdoptDescription = JSON.stringify(resignAdoptBefore.descriptionMaterialBinding);
  const resignAdoptAssets = JSON.stringify(resignAdoptBefore.publishAssetBinding);
  const resignAdopt = await bindProductAttribute(cookie, resignAdoptTaskId, {bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT});
  check('stale adopt same-identity re-sign 200', resignAdopt.status, 200);
  check('stale adopt re-sign stage verified', String(resignAdopt.json?.stage || ''), 'binding_resigned_verified');
  check('stale adopt re-sign removed zero rows', Number(resignAdopt.json?.binding?.invalidAttributeRowsRemoved || 0), 0);
  const resignAdoptRaw = await rawTaskById(resignAdoptTaskId);
  check('stale adopt re-sign revision +1', Number(resignAdoptRaw.repositoryRevision || 0), resignAdoptRevision + 1);
  check('stale adopt payload unchanged', JSON.stringify(resignAdoptRaw.openapiPublishPayload), resignAdoptPayload);
  check('stale adopt description unchanged', JSON.stringify(resignAdoptRaw.descriptionMaterialBinding), resignAdoptDescription);
  check('stale adopt assets unchanged', JSON.stringify(resignAdoptRaw.publishAssetBinding), resignAdoptAssets);
  check('stale adopt binding pins current image fingerprint', String(resignAdoptRaw.productAttributeBinding?.imageBindingFingerprint || ''), String(resignAdoptRaw.publishAssetBinding?.bindingFingerprint || ''));
  check('stale adopt old==new current hash', String(resignAdoptRaw.productAttributeBinding?.oldPayloadHash || ''), sha256StableJson(resignAdoptRaw.openapiPublishPayload));
  check('stale adopt old==new invariant', String(resignAdoptRaw.productAttributeBinding?.oldPayloadHash || ''), String(resignAdoptRaw.productAttributeBinding?.newPayloadHash || ''));
  check('stale adopt re-sign lock valid', validateProductAttributeBindingLock(resignAdoptRaw, resignAdoptRaw.openapiPublishPayload).ok, true);
  check('stale adopt never publishes', publishAttemptCount, 0);

  // adopt_existing re-sign is payload-immutable. Even an otherwise valid
  // current image/description lock cannot authorize sanitizer deletions.
  const resignAdoptDirtyTaskId = await createTask(cookie, 'ATTR-RESIGN-ADOPT-DIRTY');
  await attachFullPayloadWithRow(resignAdoptDirtyTaskId);
  check('dirty adopt initial binding 200', (await bindProductAttribute(cookie, resignAdoptDirtyTaskId, {bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT})).status, 200);
  await updateRawTaskById(resignAdoptDirtyTaskId, task => {
    const payload = JSON.parse(JSON.stringify(task.openapiPublishPayload));
    payload.product_attribute_list.splice(1, 0, {attribute_id: 0, attribute_value_id: 0, marker: 'adopt-must-not-delete'});
    const revision = Number(task.repositoryRevision || 0) + 1;
    return {
      ...task,
      repositoryRevision: revision,
      openapiPublishPayload: payload,
      descriptionMaterialBinding: descriptionBindingFor(
        task.id,
        payload,
        revision,
        String(task.publishAssetBinding?.bindingFingerprint || ''),
      ),
    };
  });
  const resignAdoptDirtyBefore = await rawTaskById(resignAdoptDirtyTaskId);
  const resignAdoptDirtyPayload = JSON.stringify(resignAdoptDirtyBefore.openapiPublishPayload);
  const resignAdoptDirtyRevision = Number(resignAdoptDirtyBefore.repositoryRevision || 0);
  const resignAdoptDirtyKey = String(resignAdoptDirtyBefore.productAttributeBinding?.bindingRequestKey || '');
  const resignAdoptDirtySearchBefore = fakeOpenApiCalls.filter(call => call.path === '/open-api/goods/searchProduct'
    && String(call.body?.skcNameList || '').includes(DONOR_SKC)).length;
  const resignAdoptDirty = await bindProductAttribute(cookie, resignAdoptDirtyTaskId, {bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT});
  check('dirty stale adopt rejected', resignAdoptDirty.status, 409);
  check('dirty stale adopt sanitizer code', String(resignAdoptDirty.json?.code || ''), 'PRODUCT_ATTRIBUTE_RESIGN_ADOPT_SANITIZATION_REQUIRED');
  const resignAdoptDirtyRaw = await rawTaskById(resignAdoptDirtyTaskId);
  check('dirty stale adopt payload byte-identical', JSON.stringify(resignAdoptDirtyRaw.openapiPublishPayload), resignAdoptDirtyPayload);
  check('dirty stale adopt zero revision write', Number(resignAdoptDirtyRaw.repositoryRevision || 0), resignAdoptDirtyRevision);
  check('dirty stale adopt keeps old binding', String(resignAdoptDirtyRaw.productAttributeBinding?.bindingRequestKey || ''), resignAdoptDirtyKey);
  const resignAdoptDirtySearchAfter = fakeOpenApiCalls.filter(call => call.path === '/open-api/goods/searchProduct'
    && String(call.body?.skcNameList || '').includes(DONOR_SKC)).length;
  check('dirty stale adopt blocks before live donor', resignAdoptDirtySearchAfter, resignAdoptDirtySearchBefore);
  check('dirty stale adopt never publishes', publishAttemptCount, 0);

  // Re-sign negatives: different static identity/value/live identity, invalid
  // image/description locks and prior-write uncertainty all remain zero-write.
  const resignNegativeTaskId = await makeStaleAppendResignTask('ATTR-RESIGN-NEGATIVES', {withInvalidRows: false});
  await updateRawTaskById(resignNegativeTaskId, task => {
    const assetBinding = JSON.parse(JSON.stringify(task.publishAssetBinding));
    assetBinding.images = assetBinding.images.map((row, index) => ({
      ...row,
      name: `negative-${row.name}`,
      sha256: crypto.createHash('sha256').update(`negative-resign-image-${index}`).digest('hex'),
    }));
    assetBinding.imageCount = assetBinding.images.length;
    assetBinding.bindingFingerprint = portalHooks.canonicalPublishAssetBindingFingerprint(task, {binding: assetBinding, images: assetBinding.images});
    const description = JSON.parse(JSON.stringify(task.descriptionMaterialBinding));
    description.imageBindingFingerprint = assetBinding.bindingFingerprint;
    return {...task, publishAssetBinding: assetBinding, descriptionMaterialBinding: description};
  });
  const resignNegativeSnapshot = JSON.parse(JSON.stringify(await rawTaskById(resignNegativeTaskId)));
  const resignNegativeRevision = Number(resignNegativeSnapshot.repositoryRevision || 0);
  const expectResignRejected = async (label, requestOptions, expectedCode, mutate = null) => {
    await restoreTaskSnapshot(resignNegativeTaskId, resignNegativeSnapshot);
    if (mutate) await updateRawTaskById(resignNegativeTaskId, mutate);
    const res = await bindProductAttribute(cookie, resignNegativeTaskId, {
      bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_APPEND,
      ...requestOptions,
    });
    check(`${label} rejected`, res.status >= 400, true);
    check(`${label} code`, String(res.json?.code || ''), expectedCode);
    check(`${label} zero revision write`, Number((await rawTaskById(resignNegativeTaskId))?.repositoryRevision || 0), resignNegativeRevision);
    check(`${label} zero publish`, publishAttemptCount, 0);
  };
  await expectResignRejected('resign different donor store', {donorStore: 'DL'}, 'PRODUCT_ATTRIBUTE_EXISTING_BINDING_CONFLICT');
  await expectResignRejected('resign different donor SKC', {donorSkc: DONOR_SKC.toUpperCase()}, 'PRODUCT_ATTRIBUTE_EXISTING_BINDING_CONFLICT');
  await expectResignRejected('resign different mode', {bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT}, 'PRODUCT_ATTRIBUTE_EXISTING_BINDING_CONFLICT');
  await expectResignRejected('resign different attribute', {attributeId: 1002323}, 'PRODUCT_ATTRIBUTE_NOT_WHITELISTED');
  await expectResignRejected('resign different target store', {extraBody: {store: 'HL'}}, 'PRODUCT_ATTRIBUTE_EXISTING_BINDING_CONFLICT');
  await expectResignRejected('resign unknown schema', {}, 'PRODUCT_ATTRIBUTE_EXISTING_BINDING_CONFLICT', task => {
    const binding = JSON.parse(JSON.stringify(task.productAttributeBinding));
    binding.schemaVersion = 99;
    return {...task, productAttributeBinding: binding};
  });
  await expectResignRejected('resign v2 missing binding mode', {}, 'PRODUCT_ATTRIBUTE_EXISTING_BINDING_CONFLICT', task => {
    const binding = JSON.parse(JSON.stringify(task.productAttributeBinding));
    delete binding.bindingMode;
    return {...task, productAttributeBinding: binding};
  });
  await expectResignRejected('resign v2 empty binding mode', {}, 'PRODUCT_ATTRIBUTE_EXISTING_BINDING_CONFLICT', task => ({
    ...task,
    productAttributeBinding: {...task.productAttributeBinding, bindingMode: ''},
  }));
  await expectResignRejected('resign v2 unknown binding mode', {}, 'PRODUCT_ATTRIBUTE_EXISTING_BINDING_CONFLICT', task => ({
    ...task,
    productAttributeBinding: {...task.productAttributeBinding, bindingMode: 'unknown_mode'},
  }));
  await expectResignRejected('resign different payload value', {}, 'PRODUCT_ATTRIBUTE_EXISTING_BINDING_CONFLICT', task => {
    const payload = JSON.parse(JSON.stringify(task.openapiPublishPayload));
    for (const row of payload.product_attribute_list) {
      if (Number(row?.attribute_id) === ATTRIBUTE_ID) row.attribute_value_id = DONOR_VALUE_ID + 1;
    }
    const description = descriptionBindingFor(task.id, payload, Number(task.repositoryRevision || 0), String(task.publishAssetBinding?.bindingFingerprint || ''));
    return {...task, openapiPublishPayload: payload, descriptionMaterialBinding: description};
  });
  donorModes.attribute = 'adoptvalue';
  await expectResignRejected('resign changed live donor value', {}, 'PRODUCT_ATTRIBUTE_EXISTING_BINDING_CONFLICT');
  donorModes.attribute = 'present';
  donorModes.attribute = 'identitymissing';
  await expectResignRejected('resign changed live product identity', {}, 'DONOR_PRODUCT_MODEL_MISMATCH');
  donorModes.attribute = 'present';
  await expectResignRejected('resign invalid image binding', {}, 'PRODUCT_ATTRIBUTE_RESIGN_IMAGE_BINDING_INVALID', task => {
    const binding = JSON.parse(JSON.stringify(task.publishAssetBinding));
    binding.images[0].sha256 = 'f'.repeat(64);
    return {...task, publishAssetBinding: binding};
  });
  await expectResignRejected('resign invalid description binding', {}, 'PRODUCT_ATTRIBUTE_RESIGN_DESCRIPTION_INVALID', task => {
    const binding = JSON.parse(JSON.stringify(task.descriptionMaterialBinding));
    binding.hashes.en = 'f'.repeat(64);
    return {...task, descriptionMaterialBinding: binding};
  });
  await expectResignRejected('resign prior-write uncertainty', {}, 'PRODUCT_ATTRIBUTE_BINDING_PRIOR_WRITE_EVIDENCE', task => ({
    ...task,
    execution: {
      ...(task.execution && typeof task.execution === 'object' ? task.execution : {}),
      writeAudit: {
        ...(task.execution?.writeAudit && typeof task.execution.writeAudit === 'object' ? task.execution.writeAudit : {}),
        actualWriteSubmitted: true,
      },
    },
  }));
  await restoreTaskSnapshot(resignNegativeTaskId, resignNegativeSnapshot);

  // Genuine schema-v1 append_missing bindings may upgrade only when their
  // immutable v1 request key + original bound history prove the exact old
  // donor/attribute/value identity. The current donor is still revalidated
  // live and the CAS result must be a fresh schema-v2 lock.
  const resignV1TaskId = await makeStaleAppendResignTask('ATTR-RESIGN-V1-UPGRADE');
  await downgradeBindingToV1(resignV1TaskId, {explicitAppendMode: true});
  const resignV1Before = await rawTaskById(resignV1TaskId);
  check('v1 upgrade fixture schema exactly 1', resignV1Before.productAttributeBinding?.schemaVersion, PRODUCT_ATTRIBUTE_BINDING_SCHEMA_VERSION_V1);
  check('v1 upgrade fixture explicit append mode', String(resignV1Before.productAttributeBinding?.bindingMode || ''), PRODUCT_ATTRIBUTE_BINDING_MODE_APPEND);
  check('v1 upgrade fixture request key valid', String(resignV1Before.productAttributeBinding?.bindingRequestKey || ''), productAttributeBindingRequestKey({
    taskId: resignV1TaskId,
    targetStore: TARGET_STORE,
    baseTaskRevision: Number(resignV1Before.productAttributeBinding?.baseTaskRevision || 0),
    attributeId: Number(resignV1Before.productAttributeBinding?.attributeId),
    attributeValueId: Number(resignV1Before.productAttributeBinding?.attributeValueId),
    donorStore: String(resignV1Before.productAttributeBinding?.donor?.storeKey || ''),
    donorSkc: String(resignV1Before.productAttributeBinding?.donor?.skc || ''),
    donorSpu: String(resignV1Before.productAttributeBinding?.donor?.spu || ''),
    evidenceSha256: String(resignV1Before.productAttributeBinding?.evidenceSha256 || ''),
  }));
  check('v1 upgrade fixture original history valid', validateV1ProductAttributeHistory(resignV1Before, resignV1Before.productAttributeBinding).ok, true);
  const resignV1Revision = Number(resignV1Before.repositoryRevision || 0);
  const resignV1OldHash = String(resignV1Before.productAttributeBinding?.oldPayloadHash || '');
  const resignV1OldKey = String(resignV1Before.productAttributeBinding?.bindingRequestKey || '');
  const resignV1 = await bindProductAttribute(cookie, resignV1TaskId, {bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_APPEND});
  check('v1 same-identity upgrade 200', resignV1.status, 200);
  check('v1 upgrade response marks v1', resignV1.json?.binding?.upgradedFromV1, true);
  check('v1 upgrade removes legacy invalid rows', Number(resignV1.json?.binding?.invalidAttributeRowsRemoved || 0), 3);
  const resignV1Raw = await rawTaskById(resignV1TaskId);
  check('v1 upgrade persists schema 2', resignV1Raw.productAttributeBinding?.schemaVersion, PRODUCT_ATTRIBUTE_BINDING_SCHEMA_VERSION);
  check('v1 upgrade persists append mode', String(resignV1Raw.productAttributeBinding?.bindingMode || ''), PRODUCT_ATTRIBUTE_BINDING_MODE_APPEND);
  check('v1 upgrade revision +1', Number(resignV1Raw.repositoryRevision || 0), resignV1Revision + 1);
  check('v1 upgrade preserves original old hash', String(resignV1Raw.productAttributeBinding?.oldPayloadHash || ''), resignV1OldHash);
  check('v1 upgrade creates v2 request key', String(resignV1Raw.productAttributeBinding?.bindingRequestKey || ''), key => /^[a-f0-9]{64}$/.test(String(key)) && key !== resignV1OldKey);
  check('v1 upgrade locks current payload hash', String(resignV1Raw.productAttributeBinding?.newPayloadHash || ''), sha256StableJson(resignV1Raw.openapiPublishPayload));
  check('v1 upgrade final lock valid', validateProductAttributeBindingLock(resignV1Raw, resignV1Raw.openapiPublishPayload).ok, true);
  check('v1 upgrade history records source schema', asArray(resignV1Raw.history).some(entry => entry?.event === 'product_attribute_resigned'
    && Number(entry?.previousSchemaVersion) === PRODUCT_ATTRIBUTE_BINDING_SCHEMA_VERSION_V1
    && entry?.upgradedFromV1 === true), true);
  check('v1 upgrade never publishes', publishAttemptCount, 0);

  const resignV1NegativeTaskId = await makeStaleAppendResignTask('ATTR-RESIGN-V1-NEGATIVES');
  await downgradeBindingToV1(resignV1NegativeTaskId, {explicitAppendMode: true});
  const resignV1NegativeSnapshot = JSON.parse(JSON.stringify(await rawTaskById(resignV1NegativeTaskId)));
  const resignV1NegativeRevision = Number(resignV1NegativeSnapshot.repositoryRevision || 0);
  const expectV1UpgradeRejected = async (label, expectedCode, mutate = null, requestOptions = {}) => {
    await restoreTaskSnapshot(resignV1NegativeTaskId, resignV1NegativeSnapshot);
    if (mutate) await updateRawTaskById(resignV1NegativeTaskId, mutate);
    const result = await bindProductAttribute(cookie, resignV1NegativeTaskId, {
      bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_APPEND,
      ...requestOptions,
    });
    check(`${label} rejected`, result.status, 409);
    check(`${label} code`, String(result.json?.code || ''), expectedCode);
    check(`${label} zero revision write`, Number((await rawTaskById(resignV1NegativeTaskId))?.repositoryRevision || 0), resignV1NegativeRevision);
    check(`${label} zero publish`, publishAttemptCount, 0);
  };
  await expectV1UpgradeRejected('v1 upgrade missing original history', 'PRODUCT_ATTRIBUTE_REFRESH_V1_HISTORY_INVALID', task => ({
    ...task,
    history: asArray(task.history).filter(entry => entry?.event !== 'product_attribute_bound'),
  }));
  await expectV1UpgradeRejected('v1 upgrade duplicate complete history match', 'PRODUCT_ATTRIBUTE_REFRESH_V1_HISTORY_INVALID', task => {
    const matching = asArray(task.history).find(entry => entry?.event === 'product_attribute_bound');
    return {...task, history: [...asArray(task.history), JSON.parse(JSON.stringify(matching))]};
  });
  await expectV1UpgradeRejected('v1 upgrade matching plus conflicting scoped history', 'PRODUCT_ATTRIBUTE_REFRESH_V1_HISTORY_INVALID', task => {
    const matching = asArray(task.history).find(entry => entry?.event === 'product_attribute_bound');
    const conflicting = {
      ...JSON.parse(JSON.stringify(matching)),
      attributeValueId: Number(matching?.attributeValueId || 0) + 1,
    };
    return {...task, history: [...asArray(task.history), conflicting]};
  });
  await expectV1UpgradeRejected('v1 upgrade forged coordinated request key', 'PRODUCT_ATTRIBUTE_RESIGN_V1_BINDING_INVALID', task => {
    const forgedKey = 'f'.repeat(64);
    const binding = {...task.productAttributeBinding, bindingRequestKey: forgedKey};
    const history = asArray(task.history).map(entry => entry?.event === 'product_attribute_bound'
      ? {...entry, bindingRequestKey: forgedKey}
      : entry);
    return {...task, productAttributeBinding: binding, history};
  });
  await expectV1UpgradeRejected('v1 upgrade different payload value', 'PRODUCT_ATTRIBUTE_EXISTING_BINDING_CONFLICT', task => {
    const payload = JSON.parse(JSON.stringify(task.openapiPublishPayload));
    for (const row of payload.product_attribute_list) {
      if (Number(row?.attribute_id) === ATTRIBUTE_ID) row.attribute_value_id = DONOR_VALUE_ID + 1;
    }
    return {
      ...task,
      openapiPublishPayload: payload,
      descriptionMaterialBinding: descriptionBindingFor(
        task.id,
        payload,
        Number(task.repositoryRevision || 0),
        String(task.publishAssetBinding?.bindingFingerprint || ''),
      ),
    };
  });
  await expectV1UpgradeRejected('v1 upgrade different donor', 'PRODUCT_ATTRIBUTE_EXISTING_BINDING_CONFLICT', null, {donorStore: 'DL'});
  await expectV1UpgradeRejected('v1 adopt_existing impossible mode', 'PRODUCT_ATTRIBUTE_EXISTING_BINDING_CONFLICT', task => ({
    ...task,
    productAttributeBinding: {...task.productAttributeBinding, bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT},
  }), {bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT});
  await restoreTaskSnapshot(resignV1NegativeTaskId, resignV1NegativeSnapshot);

  // Adopt negative paths: all zero-write.
  const adoptNegatives = [
    ['ATTR-ADOPT-VALUE-MISMATCH', {search: 'exact', attribute: 'adoptvalue', identity: 'ok'}, 'PRODUCT_ATTRIBUTE_ADOPT_VALUE_MISMATCH'],
    ['ATTR-ADOPT-ROW-MISSING', {search: 'exact', attribute: 'present', identity: 'ok'}, 'PRODUCT_ATTRIBUTE_ADOPT_ROW_MISSING'],
  ];
  for (const [code, modes, expectedCode] of adoptNegatives) {
    donorModes.search = modes.search;
    donorModes.attribute = modes.attribute;
    donorModes.identity = modes.identity;
    const taskId = await createTask(cookie, code);
    if (code === 'ATTR-ADOPT-ROW-MISSING') await attachFullPayload(taskId);
    else await attachFullPayloadWithRow(taskId);
    const revisionBefore = Number((await rawTaskById(taskId))?.repositoryRevision || 0);
    const res = await bindProductAttribute(cookie, taskId, {bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT});
    check(`${code} rejected`, res.status, 409);
    check(`${code} code`, String(res.json?.code || ''), expectedCode);
    check(`${code} no binding persisted`, Boolean((await rawTaskById(taskId))?.productAttributeBinding), false);
    check(`${code} no revision write`, Number((await rawTaskById(taskId))?.repositoryRevision || 0), revisionBefore);
    check(`${code} never publishes`, publishAttemptCount, 0);
  }
  donorModes.search = 'exact';
  donorModes.attribute = 'present';
  donorModes.identity = 'ok';

  // Duplicate same/different rows and illegal value: zero write.
  for (const [code, rows, expectedCode] of [
    ['ATTR-ADOPT-DUP-SAME', [{attribute_id: ATTRIBUTE_ID, attribute_value_id: DONOR_VALUE_ID}, {attribute_id: ATTRIBUTE_ID, attribute_value_id: DONOR_VALUE_ID}], 'PRODUCT_ATTRIBUTE_ADOPT_ROW_DUPLICATE'],
    ['ATTR-ADOPT-DUP-DIFF', [{attribute_id: ATTRIBUTE_ID, attribute_value_id: DONOR_VALUE_ID}, {attribute_id: ATTRIBUTE_ID, attribute_value_id: 555555}], 'PRODUCT_ATTRIBUTE_ADOPT_ROW_DUPLICATE'],
    ['ATTR-ADOPT-ILLEGAL-VALUE', [{attribute_id: ATTRIBUTE_ID, attribute_value_id: 0}], 'PRODUCT_ATTRIBUTE_ADOPT_VALUE_INVALID'],
  ]) {
    const taskId = await createTask(cookie, code);
    await attachFullPayload(taskId);
    await updateRawTaskById(taskId, task => {
      const payload = JSON.parse(JSON.stringify(task.openapiPublishPayload));
      payload.product_attribute_list.push(...rows);
      return {...task, openapiPublishPayload: payload};
    });
    const revisionBefore = Number((await rawTaskById(taskId))?.repositoryRevision || 0);
    const res = await bindProductAttribute(cookie, taskId, {bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT});
    check(`${code} rejected`, res.status, 409);
    check(`${code} code`, String(res.json?.code || ''), expectedCode);
    check(`${code} no revision write`, Number((await rawTaskById(taskId))?.repositoryRevision || 0), revisionBefore);
    check(`${code} never publishes`, publishAttemptCount, 0);
  }

  // Adopt requires valid description and image bindings (fail before write).
  const adoptNoDescTaskId = await createTask(cookie, 'ATTR-ADOPT-NO-DESCRIPTION');
  await attachFullPayloadWithRow(adoptNoDescTaskId, {skipDescription: true});
  const adoptNoDescRevision = Number((await rawTaskById(adoptNoDescTaskId))?.repositoryRevision || 0);
  const adoptNoDescRes = await bindProductAttribute(cookie, adoptNoDescTaskId, {bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT});
  check('adopt missing description rejected', adoptNoDescRes.status, 409);
  check('adopt missing description code', String(adoptNoDescRes.json?.code || ''), 'PRODUCT_ATTRIBUTE_ADOPT_DESCRIPTION_INVALID');
  check('adopt missing description no write', Number((await rawTaskById(adoptNoDescTaskId))?.repositoryRevision || 0), adoptNoDescRevision);

  const adoptNoImageTaskId = await createTask(cookie, 'ATTR-ADOPT-NO-IMAGE');
  await attachFullPayloadWithRow(adoptNoImageTaskId);
  await updateRawTaskById(adoptNoImageTaskId, task => {
    const next = {...task};
    delete next.publishAssetBinding;
    return next;
  });
  const adoptNoImageRevision = Number((await rawTaskById(adoptNoImageTaskId))?.repositoryRevision || 0);
  const adoptNoImageRes = await bindProductAttribute(cookie, adoptNoImageTaskId, {bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT});
  check('adopt missing image binding rejected', adoptNoImageRes.status, 409);
  check('adopt missing image binding code', String(adoptNoImageRes.json?.code || ''), 'PRODUCT_ATTRIBUTE_ADOPT_IMAGE_BINDING_INVALID');
  check('adopt missing image binding no write', Number((await rawTaskById(adoptNoImageTaskId))?.repositoryRevision || 0), adoptNoImageRevision);

  // Image-binding tamper variants: every one keeps the old fingerprint and
  // must be rejected by the canonical validator, zero write.
  const imageTamperCases = [
    ['ATTR-ADOPT-IMG-REMOVED', binding => { binding.images = binding.images.slice(0, 1); }],
    ['ATTR-ADOPT-IMG-DELETED', binding => { delete binding.images; }],
    ['ATTR-ADOPT-IMG-SHA-DRIFT', binding => { binding.images[0].sha256 = 'f'.repeat(64); }],
    ['ATTR-ADOPT-IMG-SHA-INVALID', binding => { binding.images[0].sha256 = 'not-a-sha256'; }],
    ['ATTR-ADOPT-IMG-AUTHORITY', binding => { binding.authority = 'unknown_authority'; }],
    ['ATTR-ADOPT-IMG-UNAPPROVED', binding => { binding.sourceApproved = false; }],
    ['ATTR-ADOPT-IMG-EMPTY', binding => { binding.images = []; binding.imageCount = 0; }],
  ];
  for (const [code, mutate] of imageTamperCases) {
    const taskId = await createTask(cookie, code);
    await attachFullPayloadWithRow(taskId);
    const revisionBefore = Number((await rawTaskById(taskId))?.repositoryRevision || 0);
    await updateRawTaskById(taskId, task => {
      const binding = JSON.parse(JSON.stringify(task.publishAssetBinding));
      mutate(binding);
      return {...task, publishAssetBinding: binding};
    });
    const res = await bindProductAttribute(cookie, taskId, {bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT});
    check(`${code} rejected`, res.status, 409);
    check(`${code} code`, String(res.json?.code || ''), 'PRODUCT_ATTRIBUTE_ADOPT_IMAGE_BINDING_INVALID');
    check(`${code} no binding persisted`, Boolean((await rawTaskById(taskId))?.productAttributeBinding), false);
    check(`${code} no revision write`, Number((await rawTaskById(taskId))?.repositoryRevision || 0), revisionBefore);
    check(`${code} never publishes`, publishAttemptCount, 0);
  }

  // Downgrade attack: a valid v2 adopt binding mutated to v1 (bindingMode
  // removed, old v1 request key recomputed) must fail the lock (adopt is
  // old==new), block the real dry-run gate, and reject a default append
  // replay instead of silently defaulting to append.
  const downgradeTaskId = await createTask(cookie, 'ATTR-DOWNGRADE-ADOPT');
  await attachFullPayloadWithRow(downgradeTaskId);
  const downgradeAdopt = await bindProductAttribute(cookie, downgradeTaskId, {bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT});
  check('downgrade fixture adopt 200', downgradeAdopt.status, 200);
  const downgradePreRaw = await rawTaskById(downgradeTaskId);
  const downgradeBaseRevision = Number(downgradePreRaw?.productAttributeBinding?.baseTaskRevision || 0);
  await updateRawTaskById(downgradeTaskId, task => {
    const binding = JSON.parse(JSON.stringify(task.productAttributeBinding));
    binding.schemaVersion = PRODUCT_ATTRIBUTE_BINDING_SCHEMA_VERSION_V1;
    delete binding.bindingMode;
    binding.bindingRequestKey = productAttributeBindingRequestKey({
      taskId: task.id,
      targetStore: binding.targetStore,
      baseTaskRevision: Number(binding.baseTaskRevision || 0),
      attributeId: binding.attributeId,
      attributeValueId: binding.attributeValueId,
      donorStore: binding.donor?.storeKey || '',
      donorSkc: binding.donor?.skc || '',
      donorSpu: binding.donor?.spu || '',
      evidenceSha256: String(binding.evidenceSha256 || ''),
    });
    return {...task, productAttributeBinding: binding};
  });
  const downgradeRaw = await rawTaskById(downgradeTaskId);
  const downgradeLock = validateProductAttributeBindingLock(downgradeRaw, downgradeRaw.openapiPublishPayload);
  check('downgraded v2-adopt lock rejected', downgradeLock.ok, false);
  check('downgrade names v1 hash invariant', downgradeLock.blockers.map(blocker => blocker.code)
    .includes('PRODUCT_ATTRIBUTE_BINDING_V1_HASH_INVARIANT'), true);
  const downgradeDryRun = await req('/api/link-ops-execute', {
    method: 'POST',
    cookie,
    body: {id: downgradeTaskId, mode: 'dry-run', source: 'test'},
  });
  check('downgraded binding dry-run blocked', String(downgradeDryRun.json?.execution?.state || ''), 'blocked');
  check('downgraded dry-run names v1 invariant', asArray(downgradeDryRun.json?.execution?.preflight?.blockers)
    .some(row => /oldPayloadHash 必须 != newPayloadHash/.test(String(row))), true);
  const downgradeReplay = await bindProductAttribute(cookie, downgradeTaskId, {expectedRevision: downgradeBaseRevision});
  check('downgraded default append replay rejected', downgradeReplay.status, 409);
  check('downgraded default append replay code', String(downgradeReplay.json?.code || ''), 'LINK_OPS_REVISION_CONFLICT');
  check('downgrade never publishes', publishAttemptCount, 0);

  // Default append against an already-present row stays zero-write.
  const defaultAppendRowTaskId = await createTask(cookie, 'ATTR-DEFAULT-APPEND-ROW');
  await attachFullPayloadWithRow(defaultAppendRowTaskId);
  const defaultAppendRevision = Number((await rawTaskById(defaultAppendRowTaskId))?.repositoryRevision || 0);
  const defaultAppendRes = await bindProductAttribute(cookie, defaultAppendRowTaskId);
  check('default append with existing row 409', defaultAppendRes.status, 409);
  check('default append with existing row code', String(defaultAppendRes.json?.code || ''), 'PRODUCT_ATTRIBUTE_ALREADY_PRESENT');
  check('default append with existing row no write', Number((await rawTaskById(defaultAppendRowTaskId))?.repositoryRevision || 0), defaultAppendRevision);

  // --- negative paths: every one must fail closed without a task write ---
  const negativeCases = [
    ['ATTR-OTHER-PRODUCT', {search: 'other-product', attribute: 'present', identity: 'ok'}, 'DONOR_SUPPLIER_CODE_ALIAS_MISMATCH'],
    ['ATTR-ALIAS-UNREGISTERED', {search: 'alias-unregistered', attribute: 'present', identity: 'ok'}, 'DONOR_ALIAS_NOT_FOUND'],
    ['ATTR-ALIAS-IGNORED', {search: 'alias-ignored', attribute: 'present', identity: 'ok'}, 'DONOR_ALIAS_IGNORED'],
    ['ATTR-ALIAS-PREFIX', {search: 'alias-prefix', attribute: 'present', identity: 'ok'}, 'DONOR_ALIAS_NOT_FOUND'],
    ['ATTR-MISSING-ATTR', {search: 'exact', attribute: 'missing', identity: 'ok'}, 'DONOR_ATTRIBUTE_MISSING'],
    ['ATTR-DUP-ATTR', {search: 'exact', attribute: 'duplicate', identity: 'ok'}, 'DONOR_ATTRIBUTE_DUPLICATE'],
    ['ATTR-VALUE-INVALID', {search: 'exact', attribute: 'valueinvalid', identity: 'ok'}, 'DONOR_ATTRIBUTE_VALUE_INVALID'],
    ['ATTR-MODEL-MISMATCH', {search: 'exact', attribute: 'identitymissing', identity: 'ok'}, 'DONOR_PRODUCT_MODEL_MISMATCH'],
    ['ATTR-WRONG-STORE-IDENTITY', {search: 'exact', attribute: 'present', identity: 'wrong'}, 'DONOR_STORE_IDENTITY_UNVERIFIED'],
    ['ATTR-SEARCH-AMBIGUOUS', {search: 'ambiguous', attribute: 'present', identity: 'ok'}, 'DONOR_SKC_SEARCH_AMBIGUOUS'],
    ['ATTR-SEARCH-NOTFOUND', {search: 'notfound', attribute: 'present', identity: 'ok'}, 'DONOR_SKC_SEARCH_NOT_FOUND'],
    ['ATTR-SEARCH-WRONGCASE', {search: 'wrongcase', attribute: 'present', identity: 'ok'}, 'DONOR_SKC_SEARCH_NOT_FOUND'],
  ];
  for (const [code, modes, expectedCode] of negativeCases) {
    donorModes.search = modes.search;
    donorModes.attribute = modes.attribute;
    donorModes.identity = modes.identity;
    const taskId = await createTask(cookie, code);
    await attachFullPayload(taskId);
    const revisionBefore = Number((await rawTaskById(taskId))?.repositoryRevision || 0);
    const res = await bindProductAttribute(cookie, taskId);
    check(`${code} rejected`, res.status, 409);
    check(`${code} code`, String(res.json?.code || ''), expectedCode);
    check(`${code} no binding persisted`, Boolean((await rawTaskById(taskId))?.productAttributeBinding), false);
    check(`${code} no revision write`, Number((await rawTaskById(taskId))?.repositoryRevision || 0), revisionBefore);
    check(`${code} never publishes`, publishAttemptCount, 0);
  }
  donorModes.search = 'exact';
  donorModes.attribute = 'present';
  donorModes.identity = 'ok';

  // --- request validation failures (HTTP 400/409) ---
  const invalidTaskId = await createTask(cookie, 'ATTR-INVALID-REQUESTS');
  await attachFullPayload(invalidTaskId);
  const invalidRevision = Number((await rawTaskById(invalidTaskId))?.repositoryRevision || 0);
  const unsupportedAttr = await bindProductAttribute(cookie, invalidTaskId, {attributeId: 1002329});
  check('unsupported attribute 400', unsupportedAttr.status, 400);
  check('unsupported attribute code', String(unsupportedAttr.json?.code || ''), 'PRODUCT_ATTRIBUTE_NOT_WHITELISTED');
  const stringAttr = await req('/api/link-ops-prepare-product-attribute', {
    method: 'POST',
    cookie,
    body: {taskId: invalidTaskId, store: TARGET_STORE, donorStore: DONOR_STORE, donorSkc: DONOR_SKC, attributeId: '1002328', expectedRevision: invalidRevision},
  });
  check('string attributeId 400', stringAttr.status, 400);
  check('string attributeId code', String(stringAttr.json?.code || ''), 'PRODUCT_ATTRIBUTE_VALUE_INVALID');
  const badDonorStore = await bindProductAttribute(cookie, invalidTaskId, {donorStore: 'ZZ'});
  check('invalid donor store 400', badDonorStore.status, 400);
  check('invalid donor store code', String(badDonorStore.json?.code || ''), 'DONOR_STORE_INVALID');
  const badDonorSkc = await bindProductAttribute(cookie, invalidTaskId, {donorSkc: 'svabc'});
  check('invalid donor skc 400', badDonorSkc.status, 400);
  check('invalid donor skc code', String(badDonorSkc.json?.code || ''), 'DONOR_SKC_INVALID');
  const unknownKey = await bindProductAttribute(cookie, invalidTaskId, {extraBody: {publish: true}});
  check('unknown body key 400', unknownKey.status, 400);
  const staleRevision = await bindProductAttribute(cookie, invalidTaskId, {expectedRevision: invalidRevision + 100});
  check('stale revision 409', staleRevision.status, 409);
  check('stale revision code', String(staleRevision.json?.code || ''), 'LINK_OPS_REVISION_CONFLICT');
  check('invalid requests never write', Number((await rawTaskById(invalidTaskId))?.repositoryRevision || 0), invalidRevision);

  // --- payload shape failures ---
  const noAttrListTaskId = await createTask(cookie, 'ATTR-NO-LIST');
  await attachFullPayload(noAttrListTaskId);
  await updateRawTaskById(noAttrListTaskId, task => {
    const payload = JSON.parse(JSON.stringify(task.openapiPublishPayload));
    delete payload.product_attribute_list;
    return {...task, openapiPublishPayload: payload};
  });
  const noAttrListRes = await bindProductAttribute(cookie, noAttrListTaskId);
  check('missing attribute list 409', noAttrListRes.status, 409);
  check('missing attribute list code', String(noAttrListRes.json?.code || ''), 'PRODUCT_ATTRIBUTE_LIST_MISSING');

  const alreadyPresentTaskId = await createTask(cookie, 'ATTR-ALREADY-PRESENT');
  await attachFullPayload(alreadyPresentTaskId);
  await updateRawTaskById(alreadyPresentTaskId, task => {
    const payload = JSON.parse(JSON.stringify(task.openapiPublishPayload));
    payload.product_attribute_list.push({attribute_id: ATTRIBUTE_ID, attribute_value_id: DONOR_VALUE_ID});
    return {...task, openapiPublishPayload: payload};
  });
  const alreadyPresentRes = await bindProductAttribute(cookie, alreadyPresentTaskId);
  check('already-present attribute 409', alreadyPresentRes.status, 409);
  check('already-present attribute code', String(alreadyPresentRes.json?.code || ''), 'PRODUCT_ATTRIBUTE_ALREADY_PRESENT');

  const multiSkcTaskId = await createTask(cookie, 'ATTR-MULTI-SKC');
  await attachFullPayload(multiSkcTaskId);
  await updateRawTaskById(multiSkcTaskId, task => {
    const payload = JSON.parse(JSON.stringify(task.openapiPublishPayload));
    payload.skc_list = [...payload.skc_list, JSON.parse(JSON.stringify(payload.skc_list[0]))];
    return {...task, openapiPublishPayload: payload};
  });
  const multiSkcRes = await bindProductAttribute(cookie, multiSkcTaskId);
  check('multi-SKC payload 409', multiSkcRes.status, 409);
  check('multi-SKC payload code', String(multiSkcRes.json?.code || ''), 'PAYLOAD_SKC_COUNT_NOT_SINGLE');

  // Dual snake/camel attribute lists must be rejected BEFORE any mutation;
  // neither list may be silently deleted or preferred.
  const dualListTaskId = await createTask(cookie, 'ATTR-DUAL-LIST');
  await attachFullPayload(dualListTaskId);
  const dualRevision = Number((await rawTaskById(dualListTaskId))?.repositoryRevision || 0);
  await updateRawTaskById(dualListTaskId, task => {
    const payload = JSON.parse(JSON.stringify(task.openapiPublishPayload));
    payload.productAttributeList = payload.product_attribute_list;
    return {...task, openapiPublishPayload: payload};
  });
  const dualRes = await bindProductAttribute(cookie, dualListTaskId);
  check('dual snake/camel lists rejected', dualRes.status, 409);
  check('dual snake/camel lists code', String(dualRes.json?.code || ''), 'PRODUCT_ATTRIBUTE_DUAL_LIST_PRESENT');
  const dualRaw = await rawTaskById(dualListTaskId);
  check('dual snake/camel neither list deleted', (() => {
    const payload = dualRaw?.openapiPublishPayload || {};
    return Object.prototype.hasOwnProperty.call(payload, 'product_attribute_list')
      && Object.prototype.hasOwnProperty.call(payload, 'productAttributeList');
  })(), true);
  check('dual snake/camel no revision write', Number(dualRaw?.repositoryRevision || 0), dualRevision);
  check('dual snake/camel never publishes', publishAttemptCount, 0);

  // --- managed CLI end-to-end (step 1 -> step 2 -> ready) ---
  const cliLogin = await runCli(['login', '--username', 'owner_attr_bind', '--password', 'owner-pass']);
  check('managed CLI test login succeeds', cliLogin.code, 0);
  const cliTaskId = await createTask(cookie, 'ATTR-CLI');
  await attachFullPayload(cliTaskId);
  const cliBeforeRaw = await rawTaskById(cliTaskId);
  const cliBeforeSnapshot = {
    areaHash: productAttributeAreaFingerprint(cliBeforeRaw.openapiPublishPayload),
    imageFingerprint: String(cliBeforeRaw.publishAssetBinding?.bindingFingerprint || ''),
    descriptionBinding: JSON.stringify(cliBeforeRaw.descriptionMaterialBinding),
  };
  const cliRun = await runCli([
    'prepare-product-attribute',
    '--task-id', cliTaskId,
    '--store', TARGET_STORE,
    '--donor-store', DONOR_STORE,
    '--donor-skc', DONOR_SKC,
    '--attribute-id', String(ATTRIBUTE_ID),
  ]);
  check('cli step-1 exits zero', cliRun.code, 0);
  check('cli step-1 ok', cliRun.json?.ok, true);
  check('cli step-1 needs-rebind stage', String(cliRun.json?.stage || ''), 'binding_committed_needs_description_rebind');
  check('cli step-1 no ready claim', cliRun.json?.safety?.dryRunReadyClaimed, false);
  check('cli step-1 next command', String(cliRun.json?.nextStep?.command || ''), 'prepare-descriptions');
  check('cli step-1 same task', String(cliRun.json?.taskId || ''), cliTaskId);
  check('cli step-1 binding value', cliRun.json?.binding?.attributeValueId, DONOR_VALUE_ID);
  check('cli step-1 canonical', String(cliRun.json?.binding?.canonicalCode || ''), DONOR_FULL_CODE);
  check('cli step-1 dry-run expected blocked', String(cliRun.json?.dryRun?.state || ''), 'blocked');
  check('cli step-1 binding lock ok', cliRun.json?.dryRun?.bindingLocked, true);
  check('cli step-1 realPublishOccurred false', cliRun.json?.safety?.realPublishOccurred, false);
  const cliRaw = await rawTaskById(cliTaskId);
  check('cli area fingerprint unchanged', productAttributeAreaFingerprint(cliRaw.openapiPublishPayload), cliBeforeSnapshot.areaHash);
  check('cli image fingerprint unchanged', String(cliRaw.publishAssetBinding?.bindingFingerprint || ''), cliBeforeSnapshot.imageFingerprint);
  check('cli description binding untouched by step 1', JSON.stringify(cliRaw.descriptionMaterialBinding), cliBeforeSnapshot.descriptionBinding);
  check('cli actualWriteSubmitted false', Boolean(cliRaw?.execution?.actualWriteSubmitted), false);
  check('cli publish never called', publishAttemptCount, 0);
  const cliBindingKey = String(cliRaw?.productAttributeBinding?.bindingRequestKey || '');
  const cliBindEvents = asArray(cliRaw?.history).filter(entry => entry?.event === 'product_attribute_bound').length;
  check('cli binding request key sha256', /^[a-f0-9]{64}$/.test(cliBindingKey), true);
  const cliDescriptionKeyBefore = String(cliRaw?.descriptionMaterialBinding?.bindingRequestKey || '');
  const cliDescriptionBaseBefore = Number(cliRaw?.descriptionMaterialBinding?.baseTaskRevision || 0);

  // Step 2: the existing prepare-descriptions command rebinds the SAME
  // reviewed HTML at the current revision (no new task, no image re-upload).
  const cliStep2 = await runCli([
    'prepare-descriptions',
    '--task-id', cliTaskId,
    '--store', TARGET_STORE,
    '--source-file', descSourceFile,
  ]);
  check('cli step-2 exits zero', cliStep2.code, 0);
  check('cli step-2 ok', cliStep2.json?.ok, true);
  const cliStep2Raw = await rawTaskById(cliTaskId);
  check('step-2 rebases description binding revision', Number(cliStep2Raw?.descriptionMaterialBinding?.baseTaskRevision || 0) > cliDescriptionBaseBefore, true);
  check('step-2 description request key changed', String(cliStep2Raw?.descriptionMaterialBinding?.bindingRequestKey || ''), key => key !== cliDescriptionKeyBefore && /^[a-f0-9]{64}$/.test(String(key)));
  check('step-2 keeps description content hash', String(cliStep2Raw?.descriptionMaterialBinding?.contentSha256 || ''), descContentSha);
  check('step-2 attribute lock still ok after rebind', validateProductAttributeBindingLock(cliStep2Raw, cliStep2Raw.openapiPublishPayload).ok, true);
  check('step-2 attribute binding key unchanged', String(cliStep2Raw?.productAttributeBinding?.bindingRequestKey || ''), cliBindingKey);
  check('step-2 keeps image binding fingerprint', String(cliStep2Raw?.publishAssetBinding?.bindingFingerprint || ''), cliBeforeSnapshot.imageFingerprint);
  check('step-2 keeps task id', String(cliStep2Raw?.id || ''), cliTaskId);
  check('step-2 dry-run becomes ready', String(cliStep2.json?.dryRun?.state || ''), 'openapi_product_preflight_ready');
  check('step-2 dry-run description locked', cliStep2.json?.dryRun?.descriptionBindingLocked, true);
  check('step-2 never publishes', publishAttemptCount, 0);

  // --- managed CLI adopt_existing end-to-end ---
  const cliAdoptTaskId = await createTask(cookie, 'ATTR-ADOPT-CLI');
  await attachFullPayloadWithRow(cliAdoptTaskId);
  const cliAdoptBefore = await rawTaskById(cliAdoptTaskId);
  const cliAdoptBeforePayload = JSON.stringify(cliAdoptBefore.openapiPublishPayload);
  const cliAdoptBeforeDescription = JSON.stringify(cliAdoptBefore.descriptionMaterialBinding);
  const cliAdoptRun = await runCli([
    'prepare-product-attribute',
    '--adopt-existing',
    '--task-id', cliAdoptTaskId,
    '--store', TARGET_STORE,
    '--donor-store', DONOR_STORE,
    '--donor-skc', DONOR_SKC,
    '--attribute-id', String(ATTRIBUTE_ID),
  ]);
  check('cli adopt exits zero', cliAdoptRun.code, 0);
  check('cli adopt ok', cliAdoptRun.json?.ok, true);
  check('cli adopt mode', String(cliAdoptRun.json?.bindingMode || ''), PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT);
  check('cli adopt stage verified', String(cliAdoptRun.json?.stage || ''), 'binding_committed_verified');
  check('cli adopt dry-run ready without rebind', String(cliAdoptRun.json?.dryRun?.state || ''), 'openapi_product_preflight_ready');
  check('cli adopt binding locked', cliAdoptRun.json?.dryRun?.bindingLocked, true);
  check('cli adopt no ready claim override', cliAdoptRun.json?.safety?.realPublishOccurred, false);
  const cliAdoptRaw = await rawTaskById(cliAdoptTaskId);
  check('cli adopt payload unchanged', JSON.stringify(cliAdoptRaw.openapiPublishPayload), cliAdoptBeforePayload);
  check('cli adopt description unchanged', JSON.stringify(cliAdoptRaw.descriptionMaterialBinding), cliAdoptBeforeDescription);
  check('cli adopt old==new hash', (() => {
    const binding = cliAdoptRaw?.productAttributeBinding || {};
    return binding.oldPayloadHash === binding.newPayloadHash
      && binding.newPayloadHash === sha256StableJson(cliAdoptRaw.openapiPublishPayload);
  })(), true);
  check('cli adopt actualWriteSubmitted false', Boolean(cliAdoptRaw?.execution?.actualWriteSubmitted), false);
  check('cli adopt never publishes', publishAttemptCount, 0);
  const cliAdoptKey = String(cliAdoptRaw?.productAttributeBinding?.bindingRequestKey || '');
  const cliAdoptEvents = asArray(cliAdoptRaw?.history).filter(entry => entry?.event === 'product_attribute_adopted').length;
  check('cli adopt single adopted event', cliAdoptEvents, 1);
  const cliAdoptReplay = await runCli([
    'prepare-product-attribute',
    '--adopt-existing',
    '--task-id', cliAdoptTaskId,
    '--store', TARGET_STORE,
    '--donor-store', DONOR_STORE,
    '--donor-skc', DONOR_SKC,
    '--attribute-id', String(ATTRIBUTE_ID),
  ]);
  check('cli adopt replay exits zero', cliAdoptReplay.code, 0);
  check('cli adopt replay ok', cliAdoptReplay.json?.ok, true);
  const cliAdoptReplayRaw = await rawTaskById(cliAdoptTaskId);
  check('cli adopt replay keeps binding key', String(cliAdoptReplayRaw?.productAttributeBinding?.bindingRequestKey || ''), cliAdoptKey);
  check('cli adopt replay no new event', asArray(cliAdoptReplayRaw?.history).filter(entry => entry?.event === 'product_attribute_adopted').length, cliAdoptEvents);

  // CLI default append against an already-present row must fail without
  // touching the server task.
  const cliAppendRowTaskId = await createTask(cookie, 'ATTR-CLI-APPEND-ROW');
  await attachFullPayloadWithRow(cliAppendRowTaskId);
  const cliAppendRowRevision = Number((await rawTaskById(cliAppendRowTaskId))?.repositoryRevision || 0);
  const cliAppendRowRun = await runCli([
    'prepare-product-attribute',
    '--task-id', cliAppendRowTaskId,
    '--store', TARGET_STORE,
    '--donor-store', DONOR_STORE,
    '--donor-skc', DONOR_SKC,
    '--attribute-id', String(ATTRIBUTE_ID),
  ]);
  check('cli default append with row fails', cliAppendRowRun.code, code => code !== 0);
  check('cli default append with row code', cliAppendRowRun.stdout, text => text.includes('PRODUCT_ATTRIBUTE_ALREADY_PRESENT'));
  check('cli default append with row no write', Number((await rawTaskById(cliAppendRowTaskId))?.repositoryRevision || 0), cliAppendRowRevision);

  // --- evidence refresh ---
  // v2 append refresh happy path (post step-2 description rebind).
  const refreshAppendTaskId = await createTask(cookie, 'ATTR-REFRESH-APPEND-V2');
  await attachFullPayloadWithRow(refreshAppendTaskId, {valueId: null});
  check('refresh-append initial append 200', (await bindProductAttribute(cookie, refreshAppendTaskId)).status, 200);
  const refreshAppendStep2 = await runCli([
    'prepare-descriptions',
    '--task-id', refreshAppendTaskId,
    '--store', TARGET_STORE,
    '--source-file', descSourceFile,
  ]);
  check('refresh-append step2 rebind exits zero', refreshAppendStep2.code, 0);
  const refreshAppendPre = await rawTaskById(refreshAppendTaskId);
  const refreshAppendSnap = {
    payload: JSON.stringify(refreshAppendPre.openapiPublishPayload),
    description: JSON.stringify(refreshAppendPre.descriptionMaterialBinding),
    assets: JSON.stringify(refreshAppendPre.publishAssetBinding),
    schemaVersion: Number(refreshAppendPre.productAttributeBinding.schemaVersion),
    bindingMode: String(refreshAppendPre.productAttributeBinding.bindingMode),
    oldHash: String(refreshAppendPre.productAttributeBinding.oldPayloadHash),
    newHash: String(refreshAppendPre.productAttributeBinding.newPayloadHash),
    donor: JSON.stringify(refreshAppendPre.productAttributeBinding.donor),
    canonical: String(refreshAppendPre.productAttributeBinding.canonicalCode),
    evidence: String(refreshAppendPre.productAttributeBinding.evidenceSha256),
    key: String(refreshAppendPre.productAttributeBinding.bindingRequestKey),
    attributeValueId: Number(refreshAppendPre.productAttributeBinding.attributeValueId),
    revision: Number(refreshAppendPre.repositoryRevision),
  };
  await driftAliasRegistry();
  const refreshAppendDriftDryRun = await req('/api/link-ops-execute', {
    method: 'POST',
    cookie,
    body: {id: refreshAppendTaskId, mode: 'dry-run', source: 'test'},
  });
  check('refresh-append drift dry-run blocked', String(refreshAppendDriftDryRun.json?.execution?.state || ''), 'blocked');
  check('refresh-append drift names registry drift', asArray(refreshAppendDriftDryRun.json?.execution?.preflight?.blockers)
    .some(row => /别名注册表\/商品目录指纹/.test(String(row))), true);
  // The drift dry-run itself persists execution and advances the repository
  // revision; refresh must CAS exactly +1 from THAT current revision.
  refreshAppendSnap.revision = Number((await rawTaskById(refreshAppendTaskId))?.repositoryRevision || 0);
  const refreshAppendFingerprints = await currentAliasFingerprints();
  const refreshAppendSearchBefore = fakeOpenApiCalls.filter(call => call.path === '/open-api/goods/searchProduct'
    && String(call.body?.skcNameList || '').includes(DONOR_SKC)).length;
  const refreshAppendRes = await refreshBinding(cookie, refreshAppendTaskId);
  check('refresh-append 200', refreshAppendRes.status, 200);
  check('refresh-append stage needs dry run', String(refreshAppendRes.json?.stage || ''), 'binding_refreshed_needs_dry_run');
  check('refresh-append next command preflight', String(refreshAppendRes.json?.nextStep?.command || ''), 'preflight');
  check('refresh-append eventKey sha256', /^[a-f0-9]{64}$/.test(String(refreshAppendRes.json?.eventKey || '')), true);
  const refreshAppendRaw = await rawTaskById(refreshAppendTaskId);
  const refreshAppendBinding = refreshAppendRaw.productAttributeBinding;
  check('refresh-append payload deep-equal', JSON.stringify(refreshAppendRaw.openapiPublishPayload), refreshAppendSnap.payload);
  check('refresh-append description deep-equal', JSON.stringify(refreshAppendRaw.descriptionMaterialBinding), refreshAppendSnap.description);
  check('refresh-append assets deep-equal', JSON.stringify(refreshAppendRaw.publishAssetBinding), refreshAppendSnap.assets);
  check('refresh-append schema preserved', Number(refreshAppendBinding.schemaVersion), refreshAppendSnap.schemaVersion);
  check('refresh-append mode preserved', String(refreshAppendBinding.bindingMode), refreshAppendSnap.bindingMode);
  check('refresh-append old hash preserved', String(refreshAppendBinding.oldPayloadHash), refreshAppendSnap.oldHash);
  check('refresh-append new hash preserved', String(refreshAppendBinding.newPayloadHash), refreshAppendSnap.newHash);
  check('refresh-append donor preserved', JSON.stringify(refreshAppendBinding.donor), refreshAppendSnap.donor);
  check('refresh-append canonical preserved', String(refreshAppendBinding.canonicalCode), refreshAppendSnap.canonical);
  check('refresh-append attr value preserved', Number(refreshAppendBinding.attributeValueId), refreshAppendSnap.attributeValueId);
  check('refresh-append evidence re-signed', String(refreshAppendBinding.evidenceSha256), value => value !== refreshAppendSnap.evidence && /^[a-f0-9]{64}$/.test(String(value)));
  check('refresh-append request key changed', String(refreshAppendBinding.bindingRequestKey), value => value !== refreshAppendSnap.key && /^[a-f0-9]{64}$/.test(String(value)));
  check('refresh-append alias fingerprint current', String(refreshAppendBinding.aliasRegistryFingerprint), refreshAppendFingerprints.alias);
  check('refresh-append catalog fingerprint current', String(refreshAppendBinding.catalogFingerprint), refreshAppendFingerprints.catalog);
  check('refresh-append revision +1', Number(refreshAppendRaw.repositoryRevision), refreshAppendSnap.revision + 1);
  check('refresh-append lock ok', validateProductAttributeBindingLock(refreshAppendRaw, refreshAppendRaw.openapiPublishPayload).ok, true);
  const refreshAppendSearchAfter = fakeOpenApiCalls.filter(call => call.path === '/open-api/goods/searchProduct'
    && String(call.body?.skcNameList || '').includes(DONOR_SKC)).length;
  check('refresh-append performed fresh donor verify', refreshAppendSearchAfter, refreshAppendSearchBefore + 1);
  const refreshAppendDryRun = await req('/api/link-ops-execute', {
    method: 'POST',
    cookie,
    body: {id: refreshAppendTaskId, mode: 'dry-run', source: 'test'},
  });
  check('refresh-append dry-run ready after refresh', String(refreshAppendDryRun.json?.execution?.state || ''), 'openapi_product_preflight_ready');
  const refreshAppendPostReadyRevision = Number((await rawTaskById(refreshAppendTaskId))?.repositoryRevision || 0);
  check('refresh-append history event once', asArray(refreshAppendRaw?.history).filter(entry => entry?.event === 'product_attribute_binding_refreshed').length, 1);
  check('refresh-append never publishes', publishAttemptCount, 0);
  const refreshAppendAlready = await refreshBinding(cookie, refreshAppendTaskId);
  check('refresh-append already_current 200', refreshAppendAlready.status, 200);
  check('refresh-append already_current stage', String(refreshAppendAlready.json?.stage || ''), 'already_current');
  check('refresh-append already_current zero CAS', Number((await rawTaskById(refreshAppendTaskId))?.repositoryRevision || 0), refreshAppendPostReadyRevision);
  check('refresh-append already_current no new event', asArray((await rawTaskById(refreshAppendTaskId))?.history).filter(entry => entry?.event === 'product_attribute_binding_refreshed').length, 1);
  await restoreAliasCatalogFiles();

  // v2 adopt refresh happy path.
  const refreshAdoptTaskId = await createTask(cookie, 'ATTR-REFRESH-ADOPT-V2');
  await attachFullPayloadWithRow(refreshAdoptTaskId);
  check('refresh-adopt initial adopt 200', (await bindProductAttribute(cookie, refreshAdoptTaskId, {bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT})).status, 200);
  const refreshAdoptPre = await rawTaskById(refreshAdoptTaskId);
  const refreshAdoptSnap = {
    payload: JSON.stringify(refreshAdoptPre.openapiPublishPayload),
    description: JSON.stringify(refreshAdoptPre.descriptionMaterialBinding),
    assets: JSON.stringify(refreshAdoptPre.publishAssetBinding),
    oldHash: String(refreshAdoptPre.productAttributeBinding.oldPayloadHash),
    newHash: String(refreshAdoptPre.productAttributeBinding.newPayloadHash),
    mode: String(refreshAdoptPre.productAttributeBinding.bindingMode),
    revision: Number(refreshAdoptPre.repositoryRevision),
  };
  await driftAliasRegistry();
  const refreshAdoptRes = await refreshBinding(cookie, refreshAdoptTaskId);
  check('refresh-adopt 200', refreshAdoptRes.status, 200);
  const refreshAdoptRaw = await rawTaskById(refreshAdoptTaskId);
  check('refresh-adopt payload deep-equal', JSON.stringify(refreshAdoptRaw.openapiPublishPayload), refreshAdoptSnap.payload);
  check('refresh-adopt description deep-equal', JSON.stringify(refreshAdoptRaw.descriptionMaterialBinding), refreshAdoptSnap.description);
  check('refresh-adopt assets deep-equal', JSON.stringify(refreshAdoptRaw.publishAssetBinding), refreshAdoptSnap.assets);
  check('refresh-adopt mode preserved', String(refreshAdoptRaw.productAttributeBinding.bindingMode), refreshAdoptSnap.mode);
  check('refresh-adopt old==new preserved', String(refreshAdoptRaw.productAttributeBinding.oldPayloadHash), refreshAdoptSnap.oldHash);
  check('refresh-adopt new hash preserved', String(refreshAdoptRaw.productAttributeBinding.newPayloadHash), refreshAdoptSnap.newHash);
  check('refresh-adopt old==new invariant', String(refreshAdoptRaw.productAttributeBinding.oldPayloadHash), String(refreshAdoptRaw.productAttributeBinding.newPayloadHash));
  check('refresh-adopt revision +1', Number(refreshAdoptRaw.repositoryRevision), refreshAdoptSnap.revision + 1);
  check('refresh-adopt lock ok', validateProductAttributeBindingLock(refreshAdoptRaw, refreshAdoptRaw.openapiPublishPayload).ok, true);
  await restoreAliasCatalogFiles();

  // Catalog-only, both-drift and catalog-removal variants on one adopt task.
  const refreshDriftsTaskId = await createTask(cookie, 'ATTR-REFRESH-DRIFTS');
  await attachFullPayloadWithRow(refreshDriftsTaskId);
  check('refresh-drifts initial adopt 200', (await bindProductAttribute(cookie, refreshDriftsTaskId, {bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT})).status, 200);
  await driftCatalogRegistry();
  const catalogOnlyRefresh = await refreshBinding(cookie, refreshDriftsTaskId);
  check('catalog-only drift refresh 200', catalogOnlyRefresh.status, 200);
  check('catalog-only drift refresh stage', String(catalogOnlyRefresh.json?.stage || ''), 'binding_refreshed_needs_dry_run');
  await driftAliasRegistry();
  const bothDriftRefresh = await refreshBinding(cookie, refreshDriftsTaskId);
  check('both drift refresh 200', bothDriftRefresh.status, 200);
  check('both drift refresh stage', String(bothDriftRefresh.json?.stage || ''), 'binding_refreshed_needs_dry_run');
  // With the drifted files still in place the gate is current: a third
  // refresh call must be already_current with zero CAS/history/audit/donor.
  const driftsCurrentRevision = Number((await rawTaskById(refreshDriftsTaskId))?.repositoryRevision || 0);
  const driftsRefreshEvents = asArray((await rawTaskById(refreshDriftsTaskId))?.history)
    .filter(entry => entry?.event === 'product_attribute_binding_refreshed').length;
  const driftsSearchBefore = fakeOpenApiCalls.filter(call => call.path === '/open-api/goods/searchProduct'
    && String(call.body?.skcNameList || '').includes(DONOR_SKC)).length;
  const driftsAuditBefore = (await fs.readFile(auditFile, 'utf8').catch(() => ''))
    .split('\n')
    .filter(line => line.includes('link-ops-prepare-product-attribute-refreshed'))
    .length;
  const driftsAlreadyCurrent = await refreshBinding(cookie, refreshDriftsTaskId);
  check('multi-refresh already_current 200', driftsAlreadyCurrent.status, 200);
  check('multi-refresh already_current stage', String(driftsAlreadyCurrent.json?.stage || ''), 'already_current');
  check('multi-refresh already_current zero CAS', Number((await rawTaskById(refreshDriftsTaskId))?.repositoryRevision || 0), driftsCurrentRevision);
  check('multi-refresh already_current zero history', asArray((await rawTaskById(refreshDriftsTaskId))?.history)
    .filter(entry => entry?.event === 'product_attribute_binding_refreshed').length, driftsRefreshEvents);
  const driftsSearchAfter = fakeOpenApiCalls.filter(call => call.path === '/open-api/goods/searchProduct'
    && String(call.body?.skcNameList || '').includes(DONOR_SKC)).length;
  check('multi-refresh already_current zero donor', driftsSearchAfter, driftsSearchBefore);
  const driftsAuditAfter = (await fs.readFile(auditFile, 'utf8').catch(() => ''))
    .split('\n')
    .filter(line => line.includes('link-ops-prepare-product-attribute-refreshed'))
    .length;
  check('multi-refresh already_current zero audit', driftsAuditAfter, driftsAuditBefore);
  await restoreAliasCatalogFiles();
  const preRemovalRevision = Number((await rawTaskById(refreshDriftsTaskId))?.repositoryRevision || 0);
  await removeCanonicalFromCatalog();
  const catalogRemovalRefresh = await refreshBinding(cookie, refreshDriftsTaskId);
  check('catalog removal refresh rejected', catalogRemovalRefresh.status, 409);
  check('catalog removal refresh donor-rejected code', String(catalogRemovalRefresh.json?.code || ''), 'TASK_SUPPLIER_CODE_ALIAS_UNRESOLVED');
  check('catalog removal refresh zero write', Number((await rawTaskById(refreshDriftsTaskId))?.repositoryRevision || 0), preRemovalRevision);
  await restoreAliasCatalogFiles();

  // v1 append refresh happy path (genuine v1 history passes).
  const refreshV1TaskId = await createTask(cookie, 'ATTR-REFRESH-V1');
  await attachFullPayloadWithRow(refreshV1TaskId, {valueId: null});
  check('refresh-v1 initial append 200', (await bindProductAttribute(cookie, refreshV1TaskId)).status, 200);
  const refreshV1Step2 = await runCli([
    'prepare-descriptions',
    '--task-id', refreshV1TaskId,
    '--store', TARGET_STORE,
    '--source-file', descSourceFile,
  ]);
  check('refresh-v1 step2 rebind exits zero', refreshV1Step2.code, 0);
  await downgradeBindingToV1(refreshV1TaskId);
  const refreshV1Pre = await rawTaskById(refreshV1TaskId);
  const refreshV1Snap = {
    payload: JSON.stringify(refreshV1Pre.openapiPublishPayload),
    oldHash: String(refreshV1Pre.productAttributeBinding.oldPayloadHash),
    newHash: String(refreshV1Pre.productAttributeBinding.newPayloadHash),
    revision: Number(refreshV1Pre.repositoryRevision),
  };
  await driftAliasRegistry();
  const refreshV1Res = await refreshBinding(cookie, refreshV1TaskId);
  check('refresh-v1 200', refreshV1Res.status, 200);
  check('refresh-v1 stage', String(refreshV1Res.json?.stage || ''), 'binding_refreshed_needs_dry_run');
  const refreshV1Raw = await rawTaskById(refreshV1TaskId);
  const refreshV1Binding = refreshV1Raw.productAttributeBinding;
  check('refresh-v1 payload deep-equal', JSON.stringify(refreshV1Raw.openapiPublishPayload), refreshV1Snap.payload);
  check('refresh-v1 schema stays 1', Number(refreshV1Binding.schemaVersion), PRODUCT_ATTRIBUTE_BINDING_SCHEMA_VERSION_V1);
  check('refresh-v1 bindingMode absent', Object.prototype.hasOwnProperty.call(refreshV1Binding, 'bindingMode'), false);
  check('refresh-v1 old hash preserved', String(refreshV1Binding.oldPayloadHash), refreshV1Snap.oldHash);
  check('refresh-v1 new hash preserved', String(refreshV1Binding.newPayloadHash), refreshV1Snap.newHash);
  check('refresh-v1 old!=new preserved', String(refreshV1Binding.oldPayloadHash), value => value !== String(refreshV1Binding.newPayloadHash));
  check('refresh-v1 uses v1 request key', String(refreshV1Binding.bindingRequestKey), productAttributeBindingRequestKey({
    taskId: refreshV1TaskId,
    targetStore: TARGET_STORE,
    baseTaskRevision: Number(refreshV1Binding.baseTaskRevision || 0),
    attributeId: Number(refreshV1Binding.attributeId),
    attributeValueId: Number(refreshV1Binding.attributeValueId),
    donorStore: String(refreshV1Binding.donor?.storeKey || ''),
    donorSkc: String(refreshV1Binding.donor?.skc || ''),
    donorSpu: String(refreshV1Binding.donor?.spu || ''),
    evidenceSha256: String(refreshV1Binding.evidenceSha256 || ''),
  }));
  check('refresh-v1 revision +1', Number(refreshV1Raw.repositoryRevision), refreshV1Snap.revision + 1);
  check('refresh-v1 lock ok', validateProductAttributeBindingLock(refreshV1Raw, refreshV1Raw.openapiPublishPayload).ok, true);
  await restoreAliasCatalogFiles();

  // A second legitimate v1 refresh must extend the same unique chain. The
  // intervening dry-run advances task revision without changing the locked
  // payload/images/descriptions, matching real tasks that are re-preflighted
  // between registry releases.
  const refreshV1SecondDrift = await req('/api/link-ops-execute', {
    method: 'POST',
    cookie,
    body: {id: refreshV1TaskId, mode: 'dry-run', source: 'test'},
  });
  check('refresh-v1 second drift dry-run blocked', String(refreshV1SecondDrift.json?.execution?.state || ''), 'blocked');
  const refreshV1Second = await refreshBinding(cookie, refreshV1TaskId);
  check('refresh-v1 second refresh 200', refreshV1Second.status, 200);
  check('refresh-v1 second refresh stage', String(refreshV1Second.json?.stage || ''), 'binding_refreshed_needs_dry_run');
  const refreshV1Twice = await rawTaskById(refreshV1TaskId);
  check('refresh-v1 second refresh keeps schema 1', Number(refreshV1Twice.productAttributeBinding?.schemaVersion || 0), PRODUCT_ATTRIBUTE_BINDING_SCHEMA_VERSION_V1);
  check('refresh-v1 second refresh keeps two history hops', asArray(refreshV1Twice.history)
    .filter(entry => entry?.event === 'product_attribute_binding_refreshed').length, 2);
  check('refresh-v1 second refresh chain valid', validateV1ProductAttributeHistory(
    refreshV1Twice,
    refreshV1Twice.productAttributeBinding,
  ).ok, true);

  // Regression: a legitimately refreshed v1 binding can later become stale
  // when reviewed images/payload rows advance. The re-sign path must prove
  // original-bound -> refresh -> current-v1, sanitize only invalid attribute
  // rows, and upgrade to v2 without requiring the task revision to remain at
  // the historical refresh revision.
  await updateRawTaskById(refreshV1TaskId, task => {
    const payload = JSON.parse(JSON.stringify(task.openapiPublishPayload));
    payload.product_attribute_list.splice(1, 0,
      {attribute_id: 0, attribute_value_id: 0, marker: 'post-refresh-zero'},
      {attribute_id: Number.MAX_SAFE_INTEGER + 1, attribute_value_id: 1, marker: 'post-refresh-unsafe'});
    payload.skc_list[0].sku_list[0].product_sku_attribute_list = [
      {attribute_id: 0, attribute_value_id: 0, marker: 'post-refresh-nested-zero'},
      {attribute_id: 27, attribute_value_id: 536, marker: 'post-refresh-legal'},
    ];
    const assetBinding = JSON.parse(JSON.stringify(task.publishAssetBinding));
    assetBinding.images = assetBinding.images.map((row, index) => ({
      ...row,
      name: `post-refresh-${row.name}`,
      sha256: crypto.createHash('sha256').update(`post-refresh-image-${index}`).digest('hex'),
    }));
    assetBinding.imageCount = assetBinding.images.length;
    assetBinding.bindingFingerprint = portalHooks.canonicalPublishAssetBindingFingerprint(task, {
      binding: assetBinding,
      images: assetBinding.images,
    });
    const nextRevision = Number(task.repositoryRevision || 0) + 1;
    return {
      ...task,
      repositoryRevision: nextRevision,
      openapiPublishPayload: payload,
      publishAssetBinding: assetBinding,
      descriptionMaterialBinding: descriptionBindingFor(
        task.id,
        payload,
        nextRevision,
        String(assetBinding.bindingFingerprint || ''),
      ),
    };
  });
  const refreshedV1Stale = JSON.parse(JSON.stringify(await rawTaskById(refreshV1TaskId)));
  check('refreshed-v1 chain validates after later revision', validateV1ProductAttributeHistory(
    refreshedV1Stale,
    refreshedV1Stale.productAttributeBinding,
  ).ok, true);

  const chainNegative = (label, mutate) => {
    const task = mutate(JSON.parse(JSON.stringify(refreshedV1Stale)));
    check(`${label} fails closed`, validateV1ProductAttributeHistory(task, task.productAttributeBinding).ok, false);
  };
  chainNegative('refreshed-v1 missing original', task => ({
    ...task,
    history: asArray(task.history).filter(entry => entry?.event !== 'product_attribute_bound'),
  }));
  chainNegative('refreshed-v1 duplicate original', task => {
    const original = asArray(task.history).find(entry => entry?.event === 'product_attribute_bound');
    return {...task, history: [...asArray(task.history), JSON.parse(JSON.stringify(original))]};
  });
  chainNegative('refreshed-v1 missing refresh history', task => ({
    ...task,
    history: asArray(task.history).filter(entry => entry?.event !== 'product_attribute_binding_refreshed'),
  }));
  chainNegative('refreshed-v1 orphan history without current event', task => {
    delete task.productAttributeRefreshEvent;
    return task;
  });
  chainNegative('refreshed-v1 conflicting refresh history', task => {
    const refresh = asArray(task.history).find(entry => entry?.event === 'product_attribute_binding_refreshed');
    return {
      ...task,
      history: [...asArray(task.history), {...JSON.parse(JSON.stringify(refresh)), donor: {...refresh.donor, skc: `${refresh.donor.skc}-conflict`}}],
    };
  });
  chainNegative('refreshed-v1 previous key mismatch', task => ({
    ...task,
    productAttributeRefreshEvent: {...task.productAttributeRefreshEvent, previousBindingRequestKey: 'f'.repeat(64)},
  }));
  chainNegative('refreshed-v1 revision mismatch', task => ({
    ...task,
    productAttributeRefreshEvent: {
      ...task.productAttributeRefreshEvent,
      previousRepositoryRevision: Number(task.productAttributeRefreshEvent.previousRepositoryRevision || 0) + 1,
    },
  }));
  chainNegative('refreshed-v1 descending cross-hop revisions', task => {
    const rows = asArray(task.history)
      .filter(entry => entry?.event === 'product_attribute_binding_refreshed')
      .sort((a, b) => Number(a.currentRepositoryRevision || 0) - Number(b.currentRepositoryRevision || 0));
    const older = JSON.parse(JSON.stringify(rows[0]));
    const newer = JSON.parse(JSON.stringify(rows[1]));
    older.previousRepositoryRevision = Number(newer.previousRepositoryRevision || 0) + 5;
    older.currentRepositoryRevision = Number(older.previousRepositoryRevision) + 1;
    older.baseTaskRevision = Number(older.previousRepositoryRevision);
    older.newBindingRequestKey = productAttributeBindingRequestKey({
      taskId: task.id,
      targetStore: task.productAttributeBinding.targetStore,
      baseTaskRevision: older.baseTaskRevision,
      attributeId: older.attributeId,
      attributeValueId: older.attributeValueId,
      donorStore: older.donor?.storeKey || '',
      donorSkc: older.donor?.skc || '',
      donorSpu: older.donor?.spu || '',
      evidenceSha256: older.evidenceSha256,
    });
    older.eventKey = productAttributeRefreshEventKey({
      taskId: task.id,
      previousBindingRequestKey: older.previousBindingRequestKey,
      newBindingRequestKey: older.newBindingRequestKey,
    });
    newer.previousBindingRequestKey = older.newBindingRequestKey;
    newer.eventKey = productAttributeRefreshEventKey({
      taskId: task.id,
      previousBindingRequestKey: newer.previousBindingRequestKey,
      newBindingRequestKey: newer.newBindingRequestKey,
    });
    let refreshIndex = 0;
    const history = asArray(task.history).map(entry => {
      if (entry?.event !== 'product_attribute_binding_refreshed') return entry;
      const replacement = refreshIndex === 0 ? older : newer;
      refreshIndex += 1;
      return replacement;
    });
    return {
      ...task,
      history,
      productAttributeRefreshEvent: {
        ...task.productAttributeRefreshEvent,
        eventKey: newer.eventKey,
        previousBindingRequestKey: older.newBindingRequestKey,
        previousEvidenceSha256: older.evidenceSha256,
        previousBaseTaskRevision: older.baseTaskRevision,
      },
    };
  });
  chainNegative('refreshed-v1 current identity mismatch', task => ({
    ...task,
    productAttributeBinding: {...task.productAttributeBinding, canonicalCode: `${task.productAttributeBinding.canonicalCode}-conflict`},
  }));
  chainNegative('refreshed-v1 current payload mismatch', task => ({
    ...task,
    productAttributeBinding: {...task.productAttributeBinding, oldPayloadHash: 'f'.repeat(64)},
  }));

  const refreshedV1Revision = Number(refreshedV1Stale.repositoryRevision || 0);
  const refreshedV1Resign = await bindProductAttribute(cookie, refreshV1TaskId, {
    bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_APPEND,
  });
  check('refreshed-v1 re-sign 200', refreshedV1Resign.status, 200);
  check('refreshed-v1 upgrades from v1', refreshedV1Resign.json?.binding?.upgradedFromV1, true);
  check('refreshed-v1 removes invalid rows only', Number(refreshedV1Resign.json?.binding?.invalidAttributeRowsRemoved || 0), 3);
  const refreshedV1ResignedRaw = await rawTaskById(refreshV1TaskId);
  check('refreshed-v1 re-sign revision +1', Number(refreshedV1ResignedRaw.repositoryRevision || 0), refreshedV1Revision + 1);
  check('refreshed-v1 re-sign schema 2', Number(refreshedV1ResignedRaw.productAttributeBinding?.schemaVersion || 0), PRODUCT_ATTRIBUTE_BINDING_SCHEMA_VERSION);
  check('refreshed-v1 re-sign lock valid', validateProductAttributeBindingLock(
    refreshedV1ResignedRaw,
    refreshedV1ResignedRaw.openapiPublishPayload,
  ).ok, true);
  check('refreshed-v1 re-sign never publishes', publishAttemptCount, 0);

  // Coordinated image-binding swap on v1: swap the canonical asset binding
  // and synchronize both the description and attribute image fingerprints,
  // but leave the original immutable product_attribute_bound history
  // untouched. Refresh must reject on v1 history with zero write/publish.
  const swapTaskId = await createTask(cookie, 'ATTR-REFRESH-V1-IMAGE-SWAP');
  await attachFullPayloadWithRow(swapTaskId, {valueId: null});
  await bindProductAttribute(cookie, swapTaskId);
  await runCli(['prepare-descriptions', '--task-id', swapTaskId, '--store', TARGET_STORE, '--source-file', descSourceFile]);
  await downgradeBindingToV1(swapTaskId);
  const swapPreRevision = Number((await rawTaskById(swapTaskId))?.repositoryRevision || 0);
  await updateRawTaskById(swapTaskId, task => {
    const assetBinding = validPublishAssetBindingFixture(task);
    const images = assetBinding.images.map((row, index) => ({
      ...row,
      name: `swapped-${row.name}`,
      sha256: crypto.createHash('sha256').update(`swapped-image-${index}`).digest('hex'),
    }));
    assetBinding.images = images;
    assetBinding.imageCount = images.length;
    assetBinding.bindingFingerprint = portalHooks.canonicalPublishAssetBindingFingerprint(task, {
      binding: assetBinding,
      images: assetBinding.images,
    });
    const attrBinding = JSON.parse(JSON.stringify(task.productAttributeBinding));
    attrBinding.imageBindingFingerprint = assetBinding.bindingFingerprint;
    const description = JSON.parse(JSON.stringify(task.descriptionMaterialBinding));
    description.imageBindingFingerprint = assetBinding.bindingFingerprint;
    return {
      ...task,
      publishAssetBinding: assetBinding,
      productAttributeBinding: attrBinding,
      descriptionMaterialBinding: description,
    };
  });
  await driftAliasRegistry();
  const swapRefresh = await refreshBinding(cookie, swapTaskId);
  check('v1 image swap refresh rejected', swapRefresh.status, 409);
  check('v1 image swap refresh code', String(swapRefresh.json?.code || ''), 'PRODUCT_ATTRIBUTE_REFRESH_V1_HISTORY_INVALID');
  check('v1 image swap zero write', Number((await rawTaskById(swapTaskId))?.repositoryRevision || 0), swapPreRevision);
  check('v1 image swap zero publish', publishAttemptCount, 0);
  await restoreAliasCatalogFiles();

  // v1 history negatives: missing/conflicting history blocks with zero write.
  for (const [code, mutateHistory] of [
    ['ATTR-REFRESH-V1-HISTORY-MISSING', history => history.filter(entry => entry?.event !== 'product_attribute_bound')],
    ['ATTR-REFRESH-V1-HISTORY-CONFLICT', history => history.map(entry => (
      entry?.event === 'product_attribute_bound'
        ? {...entry, evidenceSha256: 'f'.repeat(64)}
        : entry
    ))],
  ]) {
    const taskId = await createTask(cookie, code);
    await attachFullPayloadWithRow(taskId, {valueId: null});
    await bindProductAttribute(cookie, taskId);
    await runCli(['prepare-descriptions', '--task-id', taskId, '--store', TARGET_STORE, '--source-file', descSourceFile]);
    await downgradeBindingToV1(taskId);
    await updateRawTaskById(taskId, task => ({...task, history: mutateHistory(asArray(task.history))}));
    const revisionBefore = Number((await rawTaskById(taskId))?.repositoryRevision || 0);
    await driftAliasRegistry();
    const res = await refreshBinding(cookie, taskId);
    check(`${code} refresh rejected`, res.status, 409);
    check(`${code} code`, String(res.json?.code || ''), 'PRODUCT_ATTRIBUTE_REFRESH_V1_HISTORY_INVALID');
    check(`${code} zero write`, Number((await rawTaskById(taskId))?.repositoryRevision || 0), revisionBefore);
    check(`${code} never publishes`, publishAttemptCount, 0);
    await restoreAliasCatalogFiles();
  }

  // Exact blocker set + drift/tamper negatives (zero write).
  const refreshNegativesTaskId = await createTask(cookie, 'ATTR-REFRESH-NEGATIVES');
  await attachFullPayloadWithRow(refreshNegativesTaskId);
  await bindProductAttribute(cookie, refreshNegativesTaskId, {bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT});
  const refreshNegativesSnapshot = JSON.parse(JSON.stringify(await rawTaskById(refreshNegativesTaskId)));
  const negativesBaseRevision = Number(refreshNegativesSnapshot?.repositoryRevision || 0);
  // payload row tamper -> lock invalid (zero write)
  await updateRawTaskById(refreshNegativesTaskId, task => {
    const payload = JSON.parse(JSON.stringify(task.openapiPublishPayload));
    for (const row of payload.product_attribute_list) {
      if (Number(row?.attribute_id) === ATTRIBUTE_ID) row.attribute_value_id = 777777;
    }
    return {...task, openapiPublishPayload: payload};
  });
  const tamperedLockRefresh = await refreshBinding(cookie, refreshNegativesTaskId);
  check('refresh payload tamper rejected', tamperedLockRefresh.status, 409);
  check('refresh payload tamper code', String(tamperedLockRefresh.json?.code || ''), 'PRODUCT_ATTRIBUTE_REFRESH_PAYLOAD_HASH_MISMATCH');
  await restoreTaskSnapshot(refreshNegativesTaskId, refreshNegativesSnapshot);
  // image binding tamper
  await updateRawTaskById(refreshNegativesTaskId, task => {
    const binding = JSON.parse(JSON.stringify(task.publishAssetBinding));
    binding.images[0].sha256 = 'f'.repeat(64);
    return {...task, publishAssetBinding: binding};
  });
  const tamperedImageRefresh = await refreshBinding(cookie, refreshNegativesTaskId);
  check('refresh image tamper rejected', tamperedImageRefresh.status, 409);
  check('refresh image tamper code', String(tamperedImageRefresh.json?.code || ''), 'PRODUCT_ATTRIBUTE_REFRESH_IMAGE_BINDING_INVALID');
  await restoreTaskSnapshot(refreshNegativesTaskId, refreshNegativesSnapshot);
  // description tamper
  await updateRawTaskById(refreshNegativesTaskId, task => {
    const description = JSON.parse(JSON.stringify(task.descriptionMaterialBinding));
    description.hashes.en = 'f'.repeat(64);
    return {...task, descriptionMaterialBinding: description};
  });
  const tamperedDescRefresh = await refreshBinding(cookie, refreshNegativesTaskId);
  check('refresh description tamper rejected', tamperedDescRefresh.status, 409);
  check('refresh description tamper code', String(tamperedDescRefresh.json?.code || ''), 'PRODUCT_ATTRIBUTE_REFRESH_DESCRIPTION_INVALID');
  await restoreTaskSnapshot(refreshNegativesTaskId, refreshNegativesSnapshot);
  // write evidence
  await updateRawTaskById(refreshNegativesTaskId, task => ({
    ...task,
    execution: {
      ...(task.execution && typeof task.execution === 'object' ? task.execution : {}),
      writeAudit: {
        ...(task.execution?.writeAudit && typeof task.execution.writeAudit === 'object' ? task.execution.writeAudit : {}),
        actualWriteSubmitted: true,
      },
    },
  }));
  const writeEvidenceRefresh = await refreshBinding(cookie, refreshNegativesTaskId);
  check('refresh write evidence rejected', writeEvidenceRefresh.status, 409);
  check('refresh write evidence code', String(writeEvidenceRefresh.json?.code || ''), 'PRODUCT_ATTRIBUTE_BINDING_PRIOR_WRITE_EVIDENCE');
  await restoreTaskSnapshot(refreshNegativesTaskId, refreshNegativesSnapshot);
  // registry unavailable -> unsupported blocker set
  await fs.rename(aliasFile, `${aliasFile}.unavailable`);
  const unavailableRefresh = await refreshBinding(cookie, refreshNegativesTaskId);
  await fs.rename(`${aliasFile}.unavailable`, aliasFile);
  check('refresh registry unavailable rejected', unavailableRefresh.status, 409);
  check('refresh registry unavailable code', String(unavailableRefresh.json?.code || ''), 'PRODUCT_ATTRIBUTE_REFRESH_GATE_BLOCKERS_UNSUPPORTED');
  // wrong expected key with drift active
  await driftAliasRegistry();
  const wrongKeyRefresh = await refreshBinding(cookie, refreshNegativesTaskId, {expectedBindingRequestKey: 'f'.repeat(64)});
  check('refresh wrong key rejected', wrongKeyRefresh.status, 409);
  check('refresh wrong key code', String(wrongKeyRefresh.json?.code || ''), 'PRODUCT_ATTRIBUTE_REFRESH_KEY_MISMATCH');
  // stale revision
  const staleRevisionRefresh = await refreshBinding(cookie, refreshNegativesTaskId, {expectedRevision: negativesBaseRevision + 100});
  check('refresh stale revision rejected', staleRevisionRefresh.status, 409);
  check('refresh stale revision code', String(staleRevisionRefresh.json?.code || ''), 'LINK_OPS_REVISION_CONFLICT');
  await restoreAliasCatalogFiles();
  check('refresh negatives zero write overall', Number((await rawTaskById(refreshNegativesTaskId))?.repositoryRevision || 0), negativesBaseRevision);
  check('refresh negatives never publish', publishAttemptCount, 0);

  // Donor mismatch during refresh (live ok but resolved SPU differs) and
  // alias failures during refresh.
  const donorMismatchTaskId = await createTask(cookie, 'ATTR-REFRESH-DONOR-MISMATCH');
  await attachFullPayloadWithRow(donorMismatchTaskId);
  await bindProductAttribute(cookie, donorMismatchTaskId, {bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT});
  const donorMismatchRevision = Number((await rawTaskById(donorMismatchTaskId))?.repositoryRevision || 0);
  await driftAliasRegistry();
  donorModes.search = 'spu-remap';
  const spuRemapRefresh = await refreshBinding(cookie, donorMismatchTaskId);
  check('refresh spu remap rejected', spuRemapRefresh.status, 409);
  check('refresh spu remap code', String(spuRemapRefresh.json?.code || ''), 'PRODUCT_ATTRIBUTE_REFRESH_DONOR_MISMATCH');
  donorModes.search = 'alias-unregistered';
  const aliasFailRefresh = await refreshBinding(cookie, donorMismatchTaskId);
  check('refresh alias unregistered rejected', aliasFailRefresh.status, 409);
  check('refresh alias unregistered code', String(aliasFailRefresh.json?.code || ''), 'DONOR_ALIAS_NOT_FOUND');
  donorModes.search = 'exact';
  await restoreAliasCatalogFiles();
  check('refresh donor negatives zero write', Number((await rawTaskById(donorMismatchTaskId))?.repositoryRevision || 0), donorMismatchRevision);

  // Binding missing / forbidden fields / CAS race / audit pending / CLI.
  const refreshMissingTaskId = await createTask(cookie, 'ATTR-REFRESH-MISSING');
  await attachFullPayloadWithRow(refreshMissingTaskId);
  const missingRefresh = await refreshBinding(cookie, refreshMissingTaskId);
  check('refresh binding missing rejected', missingRefresh.status, 409);
  check('refresh binding missing code', String(missingRefresh.json?.code || ''), 'PRODUCT_ATTRIBUTE_REFRESH_BINDING_MISSING');
  const forbiddenFieldsRefresh = await refreshBinding(cookie, refreshMissingTaskId, {extraBody: {donorSkc: DONOR_SKC}});
  check('refresh forbidden donorSkc rejected', forbiddenFieldsRefresh.status, 400);
  check('refresh forbidden donorSkc code', String(forbiddenFieldsRefresh.json?.code || ''), 'PRODUCT_ATTRIBUTE_REFRESH_FORBIDDEN_FIELDS');

  const raceRefreshTaskId = await createTask(cookie, 'ATTR-REFRESH-RACE');
  await attachFullPayloadWithRow(raceRefreshTaskId);
  await bindProductAttribute(cookie, raceRefreshTaskId, {bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT});
  const raceRefreshRevision = Number((await rawTaskById(raceRefreshTaskId))?.repositoryRevision || 0);
  await driftAliasRegistry();
  const [raceRefreshA, raceRefreshB] = await Promise.all([
    refreshBinding(cookie, raceRefreshTaskId, {expectedRevision: raceRefreshRevision}),
    refreshBinding(cookie, raceRefreshTaskId, {expectedRevision: raceRefreshRevision}),
  ]);
  check('refresh race one commit', [raceRefreshA.status, raceRefreshB.status].filter(status => status === 200).length, statusCount => statusCount >= 1);
  check('refresh race loser settles as replay or CAS conflict', [raceRefreshA.status, raceRefreshB.status].every(status => status === 200 || status === 409), true);
  const raceRefreshRaw = await rawTaskById(raceRefreshTaskId);
  check('refresh race revision +1', Number(raceRefreshRaw.repositoryRevision), raceRefreshRevision + 1);
  check('refresh race single refreshed event', asArray(raceRefreshRaw.history).filter(entry => entry?.event === 'product_attribute_binding_refreshed').length, 1);
  await restoreAliasCatalogFiles();

  const auditRefreshTaskId = await createTask(cookie, 'ATTR-REFRESH-AUDIT-PENDING');
  await attachFullPayloadWithRow(auditRefreshTaskId);
  await bindProductAttribute(cookie, auditRefreshTaskId, {bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT});
  const auditRefreshPre = await rawTaskById(auditRefreshTaskId);
  const auditRefreshRevision = Number(auditRefreshPre?.repositoryRevision || 0);
  const auditRefreshKey = String(auditRefreshPre?.productAttributeBinding?.bindingRequestKey || '');
  await driftAliasRegistry();
  await fs.writeFile(attributeAuditFailMarker, 'fail', 'utf8');
  const auditPendingRefresh = await refreshBinding(cookie, auditRefreshTaskId);
  await fs.rm(attributeAuditFailMarker, {force: true});
  check('refresh audit pending 200', auditPendingRefresh.status, 200);
  check('refresh audit pending committed', auditPendingRefresh.json?.bindingCommitted, true);
  check('refresh audit pending flag', auditPendingRefresh.json?.auditPending, true);
  check('refresh audit pending stage', String(auditPendingRefresh.json?.stage || ''), 'binding_committed_audit_pending');
  check('refresh audit pending ok false', auditPendingRefresh.json?.ok, false);
  const auditPendingEventKey = String(auditPendingRefresh.json?.eventKey || '');
  const auditRetry = await refreshBinding(cookie, auditRefreshTaskId, {
    expectedRevision: auditRefreshRevision,
    expectedBindingRequestKey: auditRefreshKey,
  });
  check('refresh audit retry ok', auditRetry.json?.ok, true);
  check('refresh audit retry same event key', String(auditRetry.json?.eventKey || ''), auditPendingEventKey);
  check('refresh audit retry zero CAS', Number((await rawTaskById(auditRefreshTaskId))?.repositoryRevision || 0), auditRefreshRevision + 1);
  check('refresh audit retry single refreshed event', asArray((await rawTaskById(auditRefreshTaskId))?.history).filter(entry => entry?.event === 'product_attribute_binding_refreshed').length, 1);
  const refreshedAuditLines = (await fs.readFile(auditFile, 'utf8').catch(() => ''))
    .split('\n')
    .filter(line => line.includes('link-ops-prepare-product-attribute-refreshed') && line.includes(auditPendingEventKey))
    .length;
  check('refresh audit retry appends audit exactly once', refreshedAuditLines, 1);
  await restoreAliasCatalogFiles();

  // Second-refresh audit failure lifecycle: the first refresh is durable;
  // a second refresh (new drift) commits with auditPending, and its retry
  // uses the current event key with zero repeated CAS/history, exactly one
  // audit append, and the earlier refresh history retained.
  const secondAuditTaskId = await createTask(cookie, 'ATTR-REFRESH-SECOND-AUDIT');
  await attachFullPayloadWithRow(secondAuditTaskId);
  await bindProductAttribute(cookie, secondAuditTaskId, {bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT});
  await driftAliasRegistry();
  const secondAuditFirst = await refreshBinding(cookie, secondAuditTaskId);
  check('second-audit first refresh 200', secondAuditFirst.status, 200);
  const secondAuditFirstKey = String(secondAuditFirst.json?.binding?.bindingRequestKey || '');
  const secondAuditFirstEventKey = String(secondAuditFirst.json?.eventKey || '');
  const secondAuditPreSecond = await rawTaskById(secondAuditTaskId);
  const secondAuditPreSecondRevision = Number(secondAuditPreSecond?.repositoryRevision || 0);
  await driftCatalogRegistry();
  await fs.writeFile(attributeAuditFailMarker, 'fail', 'utf8');
  const secondAuditCommit = await refreshBinding(cookie, secondAuditTaskId);
  await fs.rm(attributeAuditFailMarker, {force: true});
  check('second-audit commit 200', secondAuditCommit.status, 200);
  check('second-audit commit auditPending', secondAuditCommit.json?.auditPending, true);
  check('second-audit commit ok false', secondAuditCommit.json?.ok, false);
  const secondAuditEventKey = String(secondAuditCommit.json?.eventKey || '');
  check('second-audit event key changed', secondAuditEventKey, value => value !== secondAuditFirstEventKey && /^[a-f0-9]{64}$/.test(String(value)));
  const secondAuditRetry = await refreshBinding(cookie, secondAuditTaskId, {
    expectedRevision: secondAuditPreSecondRevision,
    expectedBindingRequestKey: secondAuditFirstKey,
  });
  check('second-audit retry ok', secondAuditRetry.json?.ok, true);
  check('second-audit retry current event key', String(secondAuditRetry.json?.eventKey || ''), secondAuditEventKey);
  check('second-audit retry zero CAS', Number((await rawTaskById(secondAuditTaskId))?.repositoryRevision || 0), secondAuditPreSecondRevision + 1);
  check('second-audit retry keeps earlier history', asArray((await rawTaskById(secondAuditTaskId))?.history)
    .filter(entry => entry?.event === 'product_attribute_binding_refreshed').length, 2);
  const secondAuditLines = (await fs.readFile(auditFile, 'utf8').catch(() => ''))
    .split('\n')
    .filter(line => line.includes('link-ops-prepare-product-attribute-refreshed') && line.includes(secondAuditEventKey))
    .length;
  check('second-audit retry appends exactly one audit', secondAuditLines, 1);
  const secondAuditFirstLines = (await fs.readFile(auditFile, 'utf8').catch(() => ''))
    .split('\n')
    .filter(line => line.includes('link-ops-prepare-product-attribute-refreshed') && line.includes(secondAuditFirstEventKey))
    .length;
  check('second-audit earlier audit retained', secondAuditFirstLines, 1);
  await restoreAliasCatalogFiles();

  // Forged refresh event on an already-current never-refreshed task must
  // fail closed with zero audit/CAS/history writes; the event key is always
  // recomputed and the missing immutable history event cannot be forged.
  const forgeTaskId = await createTask(cookie, 'ATTR-REFRESH-FORGED-EVENT');
  await attachFullPayloadWithRow(forgeTaskId);
  await bindProductAttribute(cookie, forgeTaskId, {bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT});
  const forgeRaw = await rawTaskById(forgeTaskId);
  const forgeCurrentKey = String(forgeRaw.productAttributeBinding.bindingRequestKey || '');
  const forgeRevision = Number(forgeRaw.repositoryRevision || 0);
  const forgedPreviousKey = 'f'.repeat(64);
  const forgedEventKey = productAttributeRefreshEventKey({
    taskId: forgeTaskId,
    previousBindingRequestKey: forgedPreviousKey,
    newBindingRequestKey: forgeCurrentKey,
  });
  await updateRawTaskById(forgeTaskId, task => ({
    ...task,
    productAttributeRefreshEvent: {
      eventKey: forgedEventKey,
      previousBindingRequestKey: forgedPreviousKey,
      newBindingRequestKey: forgeCurrentKey,
      previousRepositoryRevision: forgeRevision - 1,
      previousBaseTaskRevision: Number(task.productAttributeBinding.baseTaskRevision || 0),
      previousEvidenceSha256: String(task.productAttributeBinding.evidenceSha256 || ''),
      refreshedAt: new Date().toISOString(),
    },
  }));
  const forgeAuditLinesBefore = (await fs.readFile(auditFile, 'utf8').catch(() => ''))
    .split('\n')
    .filter(line => line.includes('link-ops-prepare-product-attribute-refreshed'))
    .length;
  const forgeRetry = await refreshBinding(cookie, forgeTaskId, {
    expectedRevision: forgeRevision - 1,
    expectedBindingRequestKey: forgedPreviousKey,
  });
  check('forged refresh event rejected', forgeRetry.status, 409);
  check('forged refresh event code', String(forgeRetry.json?.code || ''), 'PRODUCT_ATTRIBUTE_REFRESH_KEY_MISMATCH');
  check('forged refresh event zero CAS', Number((await rawTaskById(forgeTaskId))?.repositoryRevision || 0), forgeRevision);
  check('forged refresh event zero history', asArray((await rawTaskById(forgeTaskId))?.history).filter(entry => entry?.event === 'product_attribute_binding_refreshed').length, 0);
  const forgeAuditLinesAfter = (await fs.readFile(auditFile, 'utf8').catch(() => ''))
    .split('\n')
    .filter(line => line.includes('link-ops-prepare-product-attribute-refreshed'))
    .length;
  check('forged refresh event zero audit', forgeAuditLinesAfter, forgeAuditLinesBefore);
  check('forged refresh event never publishes', publishAttemptCount, 0);

  // CLI refresh end-to-end + forbidden combinations.
  const cliRefreshTaskId = await createTask(cookie, 'ATTR-REFRESH-CLI');
  await attachFullPayloadWithRow(cliRefreshTaskId);
  await bindProductAttribute(cookie, cliRefreshTaskId, {bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT});
  const cliRefreshBefore = await rawTaskById(cliRefreshTaskId);
  const cliRefreshPayloadBefore = JSON.stringify(cliRefreshBefore.openapiPublishPayload);
  await driftAliasRegistry();
  const cliRefreshRun = await runCli([
    'prepare-product-attribute',
    '--refresh-binding',
    '--task-id', cliRefreshTaskId,
    '--store', TARGET_STORE,
  ]);
  check('cli refresh exits zero', cliRefreshRun.code, 0);
  check('cli refresh ok', cliRefreshRun.json?.ok, true);
  check('cli refresh stage', String(cliRefreshRun.json?.stage || ''), 'binding_refreshed_needs_dry_run');
  check('cli refresh mode', String(cliRefreshRun.json?.bindingMode || ''), 'refresh_binding');
  check('cli refresh no ready claim', cliRefreshRun.json?.safety?.dryRunReadyClaimed, false);
  check('cli refresh payload not mutated', JSON.stringify((await rawTaskById(cliRefreshTaskId)).openapiPublishPayload), cliRefreshPayloadBefore);
  check('cli refresh never publishes', publishAttemptCount, 0);
  await restoreAliasCatalogFiles();
  const cliRefreshForbidden1 = await runCli([
    'prepare-product-attribute',
    '--refresh-binding',
    '--task-id', cliRefreshTaskId,
    '--store', TARGET_STORE,
    '--donor-skc', DONOR_SKC,
  ]);
  check('cli refresh forbids donor-skc', cliRefreshForbidden1.code, code => code !== 0);
  const cliRefreshForbidden2 = await runCli([
    'prepare-product-attribute',
    '--refresh-binding',
    '--adopt-existing',
    '--task-id', cliRefreshTaskId,
    '--store', TARGET_STORE,
  ]);
  check('cli refresh forbids adopt-existing', cliRefreshForbidden2.code, code => code !== 0);

  // --- execution gate: tampering must block dry-run ---
  const tamperRaw = await rawTaskById(cliTaskId);
  const tamperBaseRevision = Number(tamperRaw?.repositoryRevision || 0);
  const restoreTamper = async () => {
    const data = JSON.parse(await fs.readFile(taskFile, 'utf8'));
    const tasks = asArray(data.tasks);
    const index = tasks.findIndex(task => String(task?.id || '') === cliTaskId);
    if (index >= 0) {
      tasks[index] = tamperRaw;
      await fs.writeFile(taskFile, JSON.stringify({...data, tasks}, null, 2), 'utf8');
    }
  };
  // (a) remove the bound attribute row -> payload lock mismatch
  await updateRawTaskById(cliTaskId, task => {
    const payload = JSON.parse(JSON.stringify(task.openapiPublishPayload));
    payload.product_attribute_list = payload.product_attribute_list.filter(row => Number(row?.attribute_id) !== ATTRIBUTE_ID);
    return {...task, repositoryRevision: tamperBaseRevision + 1, openapiPublishPayload: payload};
  });
  const tamperedRowDryRun = await req('/api/link-ops-execute', {
    method: 'POST',
    cookie,
    body: {id: cliTaskId, mode: 'dry-run', source: 'test'},
  });
  check('gate blocks removed attribute row', String(tamperedRowDryRun.json?.execution?.state || ''), 'blocked');
  check('gate names payload mismatch', asArray(tamperedRowDryRun.json?.execution?.preflight?.blockers)
    .some(row => /恰好出现一次|恰好一次/.test(String(row))), true);
  await restoreTamper();
  // (b) donor provenance/value tampering -> lock invalid
  await updateRawTaskById(cliTaskId, task => {
    const binding = JSON.parse(JSON.stringify(task.productAttributeBinding));
    binding.attributeValueId = 123456;
    return {...task, repositoryRevision: tamperBaseRevision + 2, productAttributeBinding: binding};
  });
  const tamperedValueDryRun = await req('/api/link-ops-execute', {
    method: 'POST',
    cookie,
    body: {id: cliTaskId, mode: 'dry-run', source: 'test'},
  });
  check('gate blocks tampered donor value', String(tamperedValueDryRun.json?.execution?.state || ''), 'blocked');
  check('gate names value mismatch', asArray(tamperedValueDryRun.json?.execution?.preflight?.blockers)
    .some(row => /恰好出现一次|恰好一次/.test(String(row))), true);
  await restoreTamper();
  // (c) unbound whitelisted row (no binding) -> fail closed
  await updateRawTaskById(cliTaskId, task => {
    const payload = JSON.parse(JSON.stringify(task.openapiPublishPayload));
    const next = {...task, repositoryRevision: tamperBaseRevision + 3, openapiPublishPayload: payload};
    delete next.productAttributeBinding;
    return next;
  });
  const unboundDryRun = await req('/api/link-ops-execute', {
    method: 'POST',
    cookie,
    body: {id: cliTaskId, mode: 'dry-run', source: 'test'},
  });
  check('gate blocks unbound whitelisted row', String(unboundDryRun.json?.execution?.state || ''), 'blocked');
  check('gate names unbound rows', asArray(unboundDryRun.json?.execution?.preflight?.blockers)
    .some(row => /缺少 productAttributeBinding/.test(String(row))), true);
  await restoreTamper();
  // (d) alias registry drift -> fingerprint mismatch blocks
  const originalAliasText = await fs.readFile(aliasFile, 'utf8');
  const driftedAliases = JSON.parse(originalAliasText);
  driftedAliases.aliases.push({canonical: 'SK-13015杆式吸尘器', aliases: ['SK-13015漂移别名']});
  await fs.writeFile(aliasFile, `${JSON.stringify(driftedAliases, null, 2)}\n`, 'utf8');
  const registryDriftDryRun = await req('/api/link-ops-execute', {
    method: 'POST',
    cookie,
    body: {id: cliTaskId, mode: 'dry-run', source: 'test'},
  });
  check('gate blocks alias registry drift', String(registryDriftDryRun.json?.execution?.state || ''), 'blocked');
  check('gate names registry drift', asArray(registryDriftDryRun.json?.execution?.preflight?.blockers)
    .some(row => /别名注册表\/商品目录指纹/.test(String(row))), true);
  await fs.writeFile(aliasFile, originalAliasText, 'utf8');

  // Coordinated tamper: payload attribute value, binding.attributeValueId and
  // newPayloadHash are all mutated together while the OLD evidenceSha256 and
  // bindingRequestKey are preserved. The recomputed evidence/request-key
  // equalities must fail closed, and the actual dry-run gate must block.
  await restoreTamper();
  await updateRawTaskById(cliTaskId, task => {
    const payload = JSON.parse(JSON.stringify(task.openapiPublishPayload));
    for (const row of payload.product_attribute_list) {
      if (Number(row?.attribute_id) === ATTRIBUTE_ID) row.attribute_value_id = 555555;
    }
    const binding = JSON.parse(JSON.stringify(task.productAttributeBinding));
    binding.attributeValueId = 555555;
    binding.newPayloadHash = sha256StableJson(payload);
    return {
      ...task,
      repositoryRevision: tamperBaseRevision + 4,
      openapiPublishPayload: payload,
      productAttributeBinding: binding,
    };
  });
  const coordinatedRaw = await rawTaskById(cliTaskId);
  const coordinatedLock = validateProductAttributeBindingLock(coordinatedRaw, coordinatedRaw.openapiPublishPayload);
  check('coordinated tamper lock fails closed', coordinatedLock.ok, false);
  check('coordinated tamper evidence recompute drift', coordinatedLock.blockers.map(blocker => blocker.code)
    .includes('PRODUCT_ATTRIBUTE_BINDING_EVIDENCE_SHA_DRIFT'), true);
  check('coordinated tamper request key drift', coordinatedLock.blockers.map(blocker => blocker.code)
    .includes('PRODUCT_ATTRIBUTE_BINDING_REQUEST_KEY_DRIFT'), true);
  const coordinatedDryRun = await req('/api/link-ops-execute', {
    method: 'POST',
    cookie,
    body: {id: cliTaskId, mode: 'dry-run', source: 'test'},
  });
  check('coordinated tamper dry-run blocked', String(coordinatedDryRun.json?.execution?.state || ''), 'blocked');
  check('coordinated tamper names evidence drift in dry-run', asArray(coordinatedDryRun.json?.execution?.preflight?.blockers)
    .some(row => /evidenceSha256 与持久化|bindingRequestKey 与任务身份/.test(String(row))), true);
  await restoreTamper();

  // Legacy/malformed binding without donorModelValue cannot be recomputed
  // and must fail closed (never silently accepted).
  await updateRawTaskById(cliTaskId, task => {
    const binding = JSON.parse(JSON.stringify(task.productAttributeBinding));
    delete binding.donorModelValue;
    return {...task, repositoryRevision: tamperBaseRevision + 5, productAttributeBinding: binding};
  });
  const legacyBindingRaw = await rawTaskById(cliTaskId);
  const legacyBindingLock = validateProductAttributeBindingLock(legacyBindingRaw, legacyBindingRaw.openapiPublishPayload);
  check('legacy binding without donor model fails closed', legacyBindingLock.ok, false);
  check('legacy binding names donor model blocker', legacyBindingLock.blockers.map(blocker => blocker.code)
    .includes('PRODUCT_ATTRIBUTE_BINDING_DONOR_MODEL_INVALID'), true);
  await restoreTamper();

  // v1 append regression: a schema-v1 binding (old request-key algorithm,
  // no bindingMode field) remains valid and the gate/dry-run keep working.
  const v1BaseRaw = await rawTaskById(cliTaskId);
  await updateRawTaskById(cliTaskId, task => {
    const binding = JSON.parse(JSON.stringify(task.productAttributeBinding));
    binding.schemaVersion = PRODUCT_ATTRIBUTE_BINDING_SCHEMA_VERSION_V1;
    delete binding.bindingMode;
    binding.bindingRequestKey = productAttributeBindingRequestKey({
      taskId: task.id,
      targetStore: binding.targetStore,
      baseTaskRevision: Number(binding.baseTaskRevision || 0),
      attributeId: binding.attributeId,
      attributeValueId: binding.attributeValueId,
      donorStore: binding.donor?.storeKey || '',
      donorSkc: binding.donor?.skc || '',
      donorSpu: binding.donor?.spu || '',
      evidenceSha256: String(binding.evidenceSha256 || ''),
    });
    return {...task, repositoryRevision: tamperBaseRevision + 6, productAttributeBinding: binding};
  });
  const v1Raw = await rawTaskById(cliTaskId);
  check('v1 append binding lock ok', validateProductAttributeBindingLock(v1Raw, v1Raw.openapiPublishPayload).ok, true);
  const v1DryRun = await req('/api/link-ops-execute', {
    method: 'POST',
    cookie,
    body: {id: cliTaskId, mode: 'dry-run', source: 'test'},
  });
  check('v1 append binding dry-run ready', String(v1DryRun.json?.execution?.state || ''), 'openapi_product_preflight_ready');
  await restoreTamper();

  // Binding deletion still blocks (PRODUCT_ATTRIBUTE_UNBOUND_ROWS) and
  // re-adoption requires full fresh donor verification plus a new CAS.
  const recoverTaskId = await createTask(cookie, 'ATTR-ADOPT-RECOVER');
  await attachFullPayloadWithRow(recoverTaskId);
  const recoverAdopt = await bindProductAttribute(cookie, recoverTaskId, {bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT});
  check('recover initial adopt 200', recoverAdopt.status, 200);
  const recoverKey = String((await rawTaskById(recoverTaskId))?.productAttributeBinding?.bindingRequestKey || '');
  const donorSearchCallsBefore = fakeOpenApiCalls.filter(call => call.path === '/open-api/goods/searchProduct'
    && String(call.body?.skcNameList || '').includes(DONOR_SKC)).length;
  const deletedRevision = Number((await rawTaskById(recoverTaskId))?.repositoryRevision || 0);
  await updateRawTaskById(recoverTaskId, task => {
    const next = {...task, repositoryRevision: deletedRevision + 1};
    delete next.productAttributeBinding;
    return next;
  });
  const deletedDryRun = await req('/api/link-ops-execute', {
    method: 'POST',
    cookie,
    body: {id: recoverTaskId, mode: 'dry-run', source: 'test'},
  });
  check('deleted binding dry-run blocked unbound rows', String(deletedDryRun.json?.execution?.state || ''), 'blocked');
  check('deleted binding names unbound rows', asArray(deletedDryRun.json?.execution?.preflight?.blockers)
    .some(row => /缺少 productAttributeBinding/.test(String(row))), true);
  const preReAdoptRevision = Number((await rawTaskById(recoverTaskId))?.repositoryRevision || 0);
  const reAdopt = await bindProductAttribute(cookie, recoverTaskId, {bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT});
  check('re-adopt after deletion 200', reAdopt.status, 200);
  const reAdoptRaw = await rawTaskById(recoverTaskId);
  check('re-adopt creates fresh binding key', String(reAdoptRaw?.productAttributeBinding?.bindingRequestKey || ''), key => /^[a-f0-9]{64}$/.test(String(key)) && key !== recoverKey);
  check('re-adopt advances CAS revision once', Number(reAdoptRaw?.repositoryRevision || 0), preReAdoptRevision + 1);
  const donorSearchCallsAfter = fakeOpenApiCalls.filter(call => call.path === '/open-api/goods/searchProduct'
    && String(call.body?.skcNameList || '').includes(DONOR_SKC)).length;
  check('re-adopt performed fresh live donor verification', donorSearchCallsAfter, donorSearchCallsBefore + 1);
  check('re-adopt lock ok', validateProductAttributeBindingLock(reAdoptRaw, reAdoptRaw.openapiPublishPayload).ok, true);
  check('re-adopt never publishes', publishAttemptCount, 0);

  // CAS/idempotent race: two identical adopt requests at the same revision
  // produce exactly one committed adoption (one CAS write, one idempotent
  // replay, single history event).
  const raceTaskId = await createTask(cookie, 'ATTR-ADOPT-RACE');
  await attachFullPayloadWithRow(raceTaskId);
  const raceRevision = Number((await rawTaskById(raceTaskId))?.repositoryRevision || 0);
  const [raceA, raceB] = await Promise.all([
    bindProductAttribute(cookie, raceTaskId, {bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT, expectedRevision: raceRevision}),
    bindProductAttribute(cookie, raceTaskId, {bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT, expectedRevision: raceRevision}),
  ]);
  check('adopt race at least one commit', [raceA.status, raceB.status].some(status => status === 200), true);
  check('adopt race loser settles as replay or CAS conflict', [raceA.status, raceB.status].every(status => status === 200 || status === 409), true);
  const raceRaw = await rawTaskById(raceTaskId);
  check('adopt race advances revision exactly once', Number(raceRaw?.repositoryRevision || 0), raceRevision + 1);
  check('adopt race single adopted event', asArray(raceRaw?.history).filter(entry => entry?.event === 'product_attribute_adopted').length, 1);
  check('adopt race lock ok', validateProductAttributeBindingLock(raceRaw, raceRaw.openapiPublishPayload).ok, true);
  check('adopt race never publishes', publishAttemptCount, 0);

  // Audit pending semantics: when the audit append fails, the binding is
  // committed but the response is binding_committed_audit_pending; a replay
  // completes the audit without a second binding event.
  const auditTaskId = await createTask(cookie, 'ATTR-ADOPT-AUDIT-PENDING');
  await attachFullPayloadWithRow(auditTaskId);
  await fs.writeFile(attributeAuditFailMarker, 'fail', 'utf8');
  const auditPendingAdopt = await bindProductAttribute(cookie, auditTaskId, {bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT});
  await fs.rm(attributeAuditFailMarker, {force: true});
  check('audit pending adopt 200', auditPendingAdopt.status, 200);
  check('audit pending adopt committed', auditPendingAdopt.json?.bindingCommitted, true);
  check('audit pending adopt readback', auditPendingAdopt.json?.readbackVerified, true);
  check('audit pending adopt flag', auditPendingAdopt.json?.auditPending, true);
  check('audit pending adopt stage', String(auditPendingAdopt.json?.stage || ''), 'binding_committed_audit_pending');
  check('audit pending adopt ok false', auditPendingAdopt.json?.ok, false);
  const auditBaseRevision = Number((await rawTaskById(auditTaskId))?.productAttributeBinding?.baseTaskRevision || 0);
  const auditReplay = await bindProductAttribute(cookie, auditTaskId, {
    bindingMode: PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT,
    expectedRevision: auditBaseRevision,
  });
  check('audit replay completes', auditReplay.json?.ok, true);
  check('audit replay stage verified', String(auditReplay.json?.stage || ''), 'binding_committed_verified');
  check('audit replay single adopted event', asArray((await rawTaskById(auditTaskId))?.history).filter(entry => entry?.event === 'product_attribute_adopted').length, 1);
  check('audit pending never publishes', publishAttemptCount, 0);

  // Idempotent replay of step 1 after the registry was restored.
  const cliReplay = await runCli([
    'prepare-product-attribute',
    '--task-id', cliTaskId,
    '--store', TARGET_STORE,
    '--donor-store', DONOR_STORE,
    '--donor-skc', DONOR_SKC,
    '--attribute-id', String(ATTRIBUTE_ID),
  ]);
  check('cli replay exits zero', cliReplay.code, 0);
  check('cli replay ok', cliReplay.json?.ok, true);
  const cliReplayRaw = await rawTaskById(cliTaskId);
  check('cli replay keeps binding key', String(cliReplayRaw?.productAttributeBinding?.bindingRequestKey || ''), cliBindingKey);
  check('cli replay adds no binding event', asArray(cliReplayRaw?.history).filter(entry => entry?.event === 'product_attribute_bound').length, cliBindEvents);
  check('cli replay never publishes', publishAttemptCount, 0);

  // Payload drift after binding: a bare CLI rerun must fail closed instead of
  // rebinding an old base.
  const cliDriftRevision = Number(cliReplayRaw?.repositoryRevision || 0) + 5;
  await updateRawTaskById(cliTaskId, task => {
    const payload = JSON.parse(JSON.stringify(task.openapiPublishPayload));
    payload.skc_list[0].sku_list[0].cost_info.cost_price = '129.00';
    return {
      ...task,
      repositoryRevision: cliDriftRevision,
      openapiPublishPayload: payload,
      publishAssetBinding: {
        ...(task.publishAssetBinding && typeof task.publishAssetBinding === 'object' ? task.publishAssetBinding : {}),
        bindingFingerprint: crypto.createHash('sha256').update(`drifted-images-${cliTaskId}`).digest('hex'),
      },
    };
  });
  const cliDriftRun = await runCli([
    'prepare-product-attribute',
    '--task-id', cliTaskId,
    '--store', TARGET_STORE,
    '--donor-store', DONOR_STORE,
    '--donor-skc', DONOR_SKC,
    '--attribute-id', String(ATTRIBUTE_ID),
  ]);
  check('cli drifted payload run fails closed', cliDriftRun.code, code => code !== 0);
  check('cli drifted payload reports invalid current image binding', cliDriftRun.stdout, text => text.includes('PRODUCT_ATTRIBUTE_RESIGN_IMAGE_BINDING_INVALID'));
  const cliDriftRaw = await rawTaskById(cliTaskId);
  check('cli drifted payload keeps binding key', String(cliDriftRaw?.productAttributeBinding?.bindingRequestKey || ''), cliBindingKey);
  check('cli drifted payload no new binding event', asArray(cliDriftRaw?.history).filter(entry => entry?.event === 'product_attribute_bound').length, cliBindEvents);
  check('cli drifted payload never publishes', publishAttemptCount, 0);

  // CLI argument validation never touches the server.
  const validationTaskId = await createTask(cookie, 'ATTR-CLI-VALIDATION');
  await attachFullPayload(validationTaskId);
  const validationRevision = Number((await rawTaskById(validationTaskId))?.repositoryRevision || 0);
  const badSkcCli = await runCli([
    'prepare-product-attribute',
    '--task-id', validationTaskId,
    '--store', TARGET_STORE,
    '--donor-store', DONOR_STORE,
    '--donor-skc', 'not-a-skc',
    '--attribute-id', String(ATTRIBUTE_ID),
  ]);
  check('cli invalid donor skc fails', badSkcCli.code, code => code !== 0);
  const badAttrCli = await runCli([
    'prepare-product-attribute',
    '--task-id', validationTaskId,
    '--store', TARGET_STORE,
    '--donor-store', DONOR_STORE,
    '--donor-skc', DONOR_SKC,
    '--attribute-id', '1002329',
  ]);
  check('cli unwhitelisted attribute fails', badAttrCli.code, code => code !== 0);
  check('cli validation made no write', Number((await rawTaskById(validationTaskId))?.repositoryRevision || 0), validationRevision);

  // Audit ledger evidence for the successful binds.
  const auditText = await fs.readFile(auditFile, 'utf8').catch(() => '');
  check('audit records bound event', auditText.includes('link-ops-prepare-product-attribute-bound'), true);
  check('audit records donor rejection', auditText.includes('link-ops-prepare-product-attribute-donor-rejected'), true);
  check('audit never records a publish', auditText.includes('publishOrEdit'), false);

  const failed = checks.filter(row => !row.pass);
  for (const row of failed) console.error(`FAIL ${row.label}\n  expected: ${row.expected}\n  actual:   ${row.actual}`);
  console.log(`link_ops_prepare_product_attribute_flow: ${checks.length - failed.length}/${checks.length} passed`);
  cleanupOnExit = failed.length === 0;
  if (failed.length) process.exitCode = 1;
} finally {
  const cleanupErrors = [];
  for (const [label, operation] of [
    ['stop isolated attribute portal', () => stopChild(portal, 'isolated attribute portal')],
    ['close fake OpenAPI server', () => closeServer(fakeOpenApi, 'fake OpenAPI server')],
    ['remove source detail fixtures', () => removeSourceFixtures()],
    ['remove isolated attribute files', async () => {
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
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'attribute flow cleanup failed');
}
