#!/usr/bin/env node
/**
 * Isolated fake-OpenAPI smoke for link maintenance executor.
 * It verifies retire_link/update_inventory/update_supply_price/update_product_price/update_title
 * without touching real SHEIN.
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP_TEMP = process.argv.includes('--keep-temp');
const tmpBase = path.join(ROOT, 'tmp');
await fs.mkdir(tmpBase, {recursive: true});
const tmpRoot = await fs.mkdtemp(path.join(tmpBase, 'bi-ops-maintenance-executor-smoke-'));
const CONFIRM_TEXT = 'SHEIN_OPENAPI_SUBMIT';

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
function runNode(args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => {
      let json = null;
      try { json = stdout.trim() ? JSON.parse(stdout) : null; } catch {}
      resolve({code, stdout, stderr, json});
    });
  });
}
function asArray(v) { return Array.isArray(v) ? v : []; }
const checks = [];
function check(label, actual, expected) {
  const pass = typeof expected === 'function' ? expected(actual) : actual === expected;
  checks.push({label, actual, expected: typeof expected === 'function' ? (expected.name || 'predicate') : expected, pass});
  return pass;
}

const calls = [];
const port = await freePort();
const fake = http.createServer(async (req, res) => {
  const body = await readBody(req);
  const pathname = req.url.split('?')[0];
  calls.push({method: req.method, path: pathname, body: body.json || body.text});
  if (pathname === '/open-api/openapi-business-backend/query-store-info') {
    return sendJson(res, {code: '0', msg: 'OK', info: {shopName: 'Smoke Store'}});
  }
  if (pathname === '/open-api/goods/query-site-list') {
    return sendJson(res, {code: '0', msg: 'OK', info: [{sub_site_list: [{site_abbr: 'shein-sa', currency: 'SAR'}]}]});
  }
  if (pathname === '/open-api/goods/modify-skc-shelf') {
    const row = body.json?.skc_site_info_list?.[0] || {};
    if (row.shelf_state !== 2 || row.skc_name !== 'sv-smoke-skc') return sendJson(res, {code: '400', msg: 'bad retire payload'}, 200);
    return sendJson(res, {code: '0', msg: 'OK', traceId: 'trace-retire'});
  }
  if (pathname === '/open-api/stock/change-inventory/v2') {
    const row = body.json?.updateSkuInventoryQuantityRequests?.[0] || {};
    if (row.skuCode !== 'sku-smoke-001' || row.changeQuantity !== 100 || row.changeType !== 'OVERWRITE') return sendJson(res, {code: '400', msg: 'bad inventory payload'}, 200);
    return sendJson(res, {code: '0', msg: 'OK', traceId: 'trace-inventory'});
  }
  if (pathname === '/open-api/goods/update-cost') {
    const sku = body.json?.skc_info_list?.[0]?.sku_info_list?.[0] || {};
    if (sku.sku_code !== 'sku-smoke-001' || sku.cost !== 80 || sku.currency !== 'SAR') return sendJson(res, {code: '400', msg: 'bad supply payload'}, 200);
    return sendJson(res, {code: '0', msg: 'OK', traceId: 'trace-supply'});
  }
  if (pathname === '/open-api/openapi-business-backend/product/price/save') {
    const row = body.json?.productPriceList?.[0] || {};
    if (row.productCode !== 'sku-smoke-001' || row.shopPrice !== 99 || row.specialPrice !== 99 || row.site !== 'shein-sa') return sendJson(res, {code: '400', msg: 'bad product price payload'}, 200);
    return sendJson(res, {code: '0', msg: 'OK', traceId: 'trace-price'});
  }
  if (pathname === '/open-api/goods/product/partialEdit') {
    const isTitle = body.json?.spu_name === 'spu-smoke' && body.json?.multi_language_name_list?.[0]?.name === 'Smoke Title';
    const isImage = body.json?.spu_name === 'spu-smoke' && body.json?.skc_list?.[0]?.skc_name === 'sv-smoke-skc' && body.json?.skc_list?.[0]?.image_info?.image_info_list?.[0]?.image_url;
    if (!isTitle && !isImage) return sendJson(res, {code: '400', msg: 'bad partialEdit payload'}, 200);
    return sendJson(res, {code: '0', msg: 'OK', traceId: isImage ? 'trace-image' : 'trace-title'});
  }
  if (pathname === '/open-api/stock/stock-query') {
    return sendJson(res, {code: '0', msg: 'OK', info: [{skuCode: 'sku-smoke-001', usableInventory: 100}]});
  }
  if (pathname === '/open-api/openapi-business-backend/product/query') {
    return sendJson(res, {code: '0', msg: 'OK', info: {data: [{skcName: 'sv-smoke-skc', spuName: 'spu-smoke', supplierCode: 'TEST-PRODUCT', skuCodeList: ['sku-smoke-001']}]}});
  }
  return sendJson(res, {code: '404', msg: `Unhandled ${pathname}`}, 404);
});
await new Promise(resolve => fake.listen(port, '127.0.0.1', resolve));

let ok = false;
try {
  const configFile = await writeJson('openapi.json', {
    apiBaseUrls: {prodSemiManaged: `http://127.0.0.1:${port}`},
    stores: [{storeKey: 'SMK', enabled: true, openKeyId: 'dummy-open', secretKey: 'dummy-secret'}],
  });
  const biDir = path.join(tmpRoot, 'bi-portal');
  await writeJson('bi-portal/sections/linksData.json', {
    data: {storeLinks: [{store_key: 'SMK', skc: 'sv-smoke-skc', spu: 'spu-smoke', standard_goods_sn: 'TEST-PRODUCT', is_on_shelf: true, shelf_status_name: '已上架'}]},
  });
  const productCacheDir = path.join(tmpRoot, 'products');
  await writeJson('products/SMK/latest.json', {
    normalizedRows: [{storeKey: 'SMK', skc: 'sv-smoke-skc', spu: 'spu-smoke', supplierCode: 'TEST-PRODUCT', skuCodes: '["sku-smoke-001"]', costSar: 70, sheinUsableInventory: 30}],
  });
  const task = {
    id: 'maintenance-smoke',
    status: 'waiting_review',
    command: '把 SMK 的 TEST-PRODUCT 下架，库存改成 100，供货价改成 80 SAR，售价改成 99 SAR，标题改成 Smoke Title，并换图',
    targets: {stores: ['SMK'], productRefs: ['TEST-PRODUCT']},
    partialEditPayload: {
      spu_name: 'spu-smoke',
      skc_list: [{
        skc_name: 'sv-smoke-skc',
        image_info: {image_group_code: 'G-smoke', image_info_list: [{image_sort: 1, image_type: 1, image_url: 'http://imgdeal-test01.shein.com/images3_pi/smoke-main.jpg'}]},
      }],
    },
    intents: ['retire_link', 'update_inventory', 'update_supply_price', 'update_product_price', 'update_title', 'update_images'],
  };
  const taskFile = await writeJson('task-dry.json', {version: 1, tasks: [task]});
  const outDir = path.join(tmpRoot, 'out');
  const commonArgs = [
    'scripts/link_ops_maintenance_openapi_executor.mjs',
    '--config', configFile,
    '--task-id', 'maintenance-smoke',
    '--store', 'SMK',
    '--dir', biDir,
    '--product-cache-dir', productCacheDir,
    '--out-dir', outDir,
  ];
  const dry = await runNode([...commonArgs, '--task-json', taskFile, '--dry-run']);
  const dryPaths = calls.map(c => c.path);
  check('dry-run exits 0', dry.code, 0);
  check('dry-run ok', dry.json?.ok, true);
  check('dry-run state ready', dry.json?.state, 'ready_for_submit');
  check('dry-run payload hash present', Boolean(dry.json?.payload?.payloadHash), true);
  check('dry-run has 6 operations', asArray(dry.json?.payload?.summary?.operations).length, 6);
  check('dry-run does not call write endpoint', dryPaths.some(p => ['/open-api/goods/modify-skc-shelf','/open-api/stock/change-inventory/v2','/open-api/goods/update-cost','/open-api/openapi-business-backend/product/price/save','/open-api/goods/product/partialEdit'].includes(p)), false);

  const hash = dry.json?.payload?.payloadHash || '';
  const execTaskFile = await writeJson('task-exec.json', {version: 1, executionContext: {expectedPayloadHash: hash}, tasks: [task]});
  calls.length = 0;
  const exec = await runNode([...commonArgs, '--task-json', execTaskFile, '--execute', '--confirm', CONFIRM_TEXT]);
  const execPaths = calls.map(c => c.path);
  check('execute exits 0', exec.code, 0);
  check('execute state submitted', exec.json?.state, 'submitted');
  check('execute publishResult code', exec.json?.publishResult?.code, '0');
  check('execute readback ok', exec.json?.readback?.ok, true);
  check('execute readback includes stock', exec.json?.readback?.status || '', s => String(s).includes('matched_stock_query'));
  check('execute readback includes product', exec.json?.readback?.status || '', s => String(s).includes('matched_product_query'));
  for (const endpoint of ['/open-api/goods/modify-skc-shelf','/open-api/stock/change-inventory/v2','/open-api/goods/update-cost','/open-api/openapi-business-backend/product/price/save','/open-api/goods/product/partialEdit','/open-api/stock/stock-query','/open-api/openapi-business-backend/product/query']) {
    check(`execute called ${endpoint}`, execPaths.includes(endpoint), true);
  }
  check('execute called partialEdit twice for title and image', execPaths.filter(p => p === '/open-api/goods/product/partialEdit').length, 2);
  check('execute reused payload hash', exec.json?.payload?.payloadHash || '', hash);
  check('saved output file exists', fssync.existsSync(path.join(ROOT, exec.json?.savedTo || '')), true);
  ok = checks.every(c => c.pass);
} finally {
  await new Promise(resolve => fake.close(resolve));
}
const result = {ok, tmpRoot, checks, callPaths: calls.map(c => c.path)};
console.log(JSON.stringify(result, null, 2));
if (ok && !KEEP_TEMP) await fs.rm(tmpRoot, {recursive: true, force: true});
else if (!ok) console.error(`maintenance executor smoke failed; temp kept at ${tmpRoot}`);
if (!ok) process.exit(1);
