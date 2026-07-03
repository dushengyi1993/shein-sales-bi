#!/usr/bin/env node
/**
 * Isolated fake-OpenAPI smoke for link maintenance executor.
 * It verifies activate_link/retire_link/update_inventory/update_supply_price/update_product_price/update_title
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
    const okRetire = row.shelf_state === 2 && row.skc_name === 'sv-smoke-skc';
    const okActivate = row.shelf_state === 1 && row.skc_name === 'sv-smoke-inactive-skc';
    if (!okRetire && !okActivate) return sendJson(res, {code: '400', msg: 'bad shelf payload'}, 200);
    return sendJson(res, {code: '0', msg: 'OK', traceId: okActivate ? 'trace-activate' : 'trace-retire'});
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
  if (pathname === '/open-api/goods/save-certificate-pool-skc-bind') {
    if (body.json?.skc_name !== 'sv-smoke-skc' || body.json?.certificate_pool_id !== 'CERTPOOL-SMOKE') return sendJson(res, {code: '400', msg: 'bad certificate bind payload'}, 200);
    return sendJson(res, {code: '0', msg: 'OK', traceId: 'trace-certificate'});
  }
  if (pathname === '/open-api/stock/stock-query') {
    return sendJson(res, {code: '0', msg: 'OK', info: [{skuCode: 'sku-smoke-001', usableInventory: 100}]});
  }
  if (pathname === '/open-api/openapi-business-backend/product/query') {
    return sendJson(res, {code: '0', msg: 'OK', info: {data: [
      {skcName: 'sv-smoke-skc', spuName: 'spu-smoke', supplierCode: 'TEST-PRODUCT', skuCodeList: ['sku-smoke-001']},
      {skcName: 'sv-smoke-inactive-skc', spuName: 'spu-inactive-smoke', supplierCode: 'TEST-INACTIVE', skuCodeList: ['sku-smoke-002']},
    ]}});
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
    data: {storeLinks: [
      {store_key: 'SMK', skc: 'sv-smoke-skc', spu: 'spu-smoke', standard_goods_sn: 'TEST-PRODUCT', is_on_shelf: true, shelf_status_name: '已上架'},
      {store_key: 'SMK', skc: 'sv-smoke-inactive-skc', spu: 'spu-inactive-smoke', standard_goods_sn: 'TEST-INACTIVE', is_on_shelf: false, shelf_status_name: '已下架'},
    ]},
  });
  const productCacheDir = path.join(tmpRoot, 'products');
  await writeJson('products/SMK/latest.json', {
    normalizedRows: [
      {storeKey: 'SMK', skc: 'sv-smoke-skc', spu: 'spu-smoke', supplierCode: 'TEST-PRODUCT', skuCodes: '["sku-smoke-001"]', costSar: 70, sheinUsableInventory: 30},
      {storeKey: 'SMK', skc: 'sv-smoke-inactive-skc', spu: 'spu-inactive-smoke', supplierCode: 'TEST-INACTIVE', skuCodes: '["sku-smoke-002"]', costSar: 70, sheinUsableInventory: 0},
    ],
  });
  const task = {
    id: 'maintenance-smoke',
    status: 'waiting_review',
    command: '把 SMK 的 TEST-PRODUCT 下架，库存改成 100，供货价改成 80 SAR，售价改成 99 SAR，标题改成 Smoke Title，并换图',
    targets: {stores: ['SMK'], productRefs: ['TEST-PRODUCT']},
    partialEditPayload: {
      spu_name: 'spu-smoke',
      is_spu_pic: true,
      image_info: {
        image_group_code: 'G-spu-smoke',
        image_info_list: [{image_sort: 1, image_type: 1, image_url: 'http://imgdeal-test01.shein.com/images3_pi/smoke-spu-main.jpg'}],
      },
      skc_list: [{
        skc_name: 'sv-smoke-skc',
        image_info: {
          image_group_code: 'G-smoke',
          image_info_list: [
            {image_sort: 1, image_type: 1, image_url: 'http://imgdeal-test01.shein.com/images3_pi/smoke-main.jpg'},
            ...Array.from({length: 10}, (_, i) => ({
              image_sort: i + 2,
              image_type: 2,
              image_url: `http://imgdeal-test01.shein.com/images3_pi/smoke-detail-${i + 1}.jpg`,
            })),
            {image_sort: 12, image_type: 5, image_url: 'http://imgdeal-test01.shein.com/images3_pi/smoke-square.jpg'},
          ],
        },
        sku_list: [{
          sku_code: 'sku-smoke-001',
          image_info: {image_info_list: [{image_sort: 1, image_type: 1, image_url: 'https://img.ltwebstatic.com/v4/j/spmp/2026/07/02/80/high-resolution-sku-main.jpg'}]},
        }],
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
  check('dry-run records image payload inspection', dry.json?.payload?.summary?.imagePayloadInspection?.payloadCount, 1);
  check('dry-run records SPU image count', dry.json?.payload?.summary?.imagePayloadInspection?.totalSpuImages, 1);
  check('dry-run records SKC image count', dry.json?.payload?.summary?.imagePayloadInspection?.totalSkcImages, 12);
  check('dry-run records SKU image count', dry.json?.payload?.summary?.imagePayloadInspection?.totalSkuImages, 1);
  check('dry-run records total detail count', dry.json?.payload?.summary?.imagePayloadInspection?.totalDetailImages, 10);
  check('dry-run records image inspection evidence', dry.json?.adapterEvidence?.imagePayloadInspection?.payloads?.[0]?.skcImageCount, 12);
  check('dry-run does not misclassify CDN /80/ path as tiny SKU', dry.json?.blockers || [], xs => !asArray(xs).some(x => /high-resolution-sku-main/.test(String(x))));
  check('dry-run does not misclassify numeric 80 filename as tiny SKU', dry.json?.blockers || [], xs => !asArray(xs).some(x => /\/80\.jpg/.test(String(x))));
  check('dry-run does not call write endpoint', dryPaths.some(p => ['/open-api/goods/modify-skc-shelf','/open-api/stock/change-inventory/v2','/open-api/goods/update-cost','/open-api/openapi-business-backend/product/price/save','/open-api/goods/product/partialEdit'].includes(p)), false);

  const manyDetailTask = {
    id: 'many-detail-image-smoke',
    status: 'waiting_review',
    command: '给 SMK 的 TEST-PRODUCT 换图',
    targets: {stores: ['SMK'], productRefs: ['TEST-PRODUCT']},
    partialEditPayload: {
      spu_name: 'spu-smoke',
      is_spu_pic: true,
      image_info: {image_info_list: [{image_sort: 1, image_type: 1, image_url: 'http://imgdeal-test01.shein.com/images3_pi/many-spu-main.jpg'}]},
      skc_list: [{
        skc_name: 'sv-smoke-skc',
        image_info: {
          image_info_list: [
            {image_sort: 1, image_type: 1, image_url: 'http://imgdeal-test01.shein.com/images3_pi/many-main.jpg'},
            ...Array.from({length: 12}, (_, i) => ({
              image_sort: i + 2,
              image_type: 2,
              image_url: `http://imgdeal-test01.shein.com/images3_pi/many-detail-${i + 1}.jpg`,
            })),
          ],
        },
        sku_list: [{
          sku_code: 'sku-smoke-001',
          image_info: {image_info_list: [{image_sort: 1, image_type: 1, image_url: 'https://img.ltwebstatic.com/v4/j/spmp/2026/07/02/80.jpg'}]},
        }],
      }],
    },
    intents: ['update_images'],
  };
  const manyDetailTaskFile = await writeJson('task-many-detail-image.json', {version: 1, tasks: [manyDetailTask]});
  calls.length = 0;
  const manyDetailDry = await runNode([...commonArgs, '--task-id', 'many-detail-image-smoke', '--task-json', manyDetailTaskFile, '--dry-run']);
  check('many-detail image dry-run exits without exception', manyDetailDry.code, 0);
  check('many-detail image dry-run remains ready', manyDetailDry.json?.ok, true);
  check('many-detail image dry-run reports warning not blocker', manyDetailDry.json?.warnings || [], xs => asArray(xs).some(x => /细节图.*超过 11 张/.test(String(x))));
  check('many-detail image dry-run has no numeric 80 sku blocker', manyDetailDry.json?.blockers || [], xs => !asArray(xs).some(x => /80\.jpg/.test(String(x))));

  const badImageTask = {
    id: 'bad-image-smoke',
    status: 'waiting_review',
    command: '给 SMK 的 TEST-PRODUCT 换图',
    targets: {stores: ['SMK'], productRefs: ['TEST-PRODUCT']},
    partialEditPayload: {
      spu_name: 'spu-smoke',
      skc_list: [{
        skc_name: 'sv-smoke-skc',
        image_info: {image_group_code: 'G-smoke', image_info_list: [{image_sort: 1, image_type: 1, image_url: 'http://imgdeal-test01.shein.com/images3_pi/smoke-main.jpg'}]},
        sku_list: [{
          sku_code: 'sku-smoke-001',
          image_info: {image_info_list: [{image_sort: 1, image_type: 6, image_url: 'http://imgdeal-test01.shein.com/images3_pi/sku-80.png'}]},
        }],
      }],
    },
    intents: ['update_images'],
  };
  const badImageTaskFile = await writeJson('task-bad-image.json', {version: 1, tasks: [badImageTask]});
  calls.length = 0;
  const badImageDry = await runNode([...commonArgs, '--task-id', 'bad-image-smoke', '--task-json', badImageTaskFile, '--dry-run']);
  const badImagePaths = calls.map(c => c.path);
  check('bad image dry-run exits without exception', badImageDry.code, 0);
  check('bad image dry-run blocks unsafe payload', badImageDry.json?.ok, false);
  check('bad image dry-run state blocked', badImageDry.json?.state, 'blocked');
  check('bad image dry-run reports sku type blocker', badImageDry.json?.blockers || [], xs => asArray(xs).some(x => /SKU 图只允许主图 image_type=1/.test(String(x))));
  check('bad image dry-run reports tiny sku blocker', badImageDry.json?.blockers || [], xs => asArray(xs).some(x => /sku-80|80x80/.test(String(x))));
  check('bad image dry-run counts sku image', badImageDry.json?.payload?.summary?.imagePayloadInspection?.totalSkuImages, 1);
  check('bad image dry-run does not call partialEdit', badImagePaths.includes('/open-api/goods/product/partialEdit'), false);

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

  const activateTask = {
    id: 'activate-smoke',
    status: 'waiting_review',
    command: '把 SMK 的 TEST-INACTIVE 恢复上架',
    targets: {stores: ['SMK'], productRefs: ['TEST-INACTIVE']},
    intents: ['activate_link'],
  };
  const activateDryFile = await writeJson('task-activate-dry.json', {version: 1, tasks: [activateTask]});
  calls.length = 0;
  const activateDry = await runNode([...commonArgs, '--task-id', 'activate-smoke', '--task-json', activateDryFile, '--dry-run']);
  check('activate dry-run exits 0', activateDry.code, 0);
  check('activate dry-run ok', activateDry.json?.ok, true);
  check('activate dry-run operation', activateDry.json?.payload?.summary?.operations?.[0], 'activate_link');
  check('activate dry-run uses shelf state 1', activateDry.json?.payload?.submitPlan?.payloads?.[0]?.body?.skc_site_info_list?.[0]?.shelf_state, 1);
  check('activate dry-run does not write', calls.some(c => c.path === '/open-api/goods/modify-skc-shelf'), false);
  const activateHash = activateDry.json?.payload?.payloadHash || '';
  const activateExecFile = await writeJson('task-activate-exec.json', {version: 1, executionContext: {expectedPayloadHash: activateHash}, tasks: [activateTask]});
  calls.length = 0;
  const activateExec = await runNode([...commonArgs, '--task-id', 'activate-smoke', '--task-json', activateExecFile, '--execute', '--confirm', CONFIRM_TEXT]);
  check('activate execute exits 0', activateExec.code, 0);
  check('activate execute state submitted', activateExec.json?.state, 'submitted');
  check('activate execute calls shelf endpoint', calls.some(c => c.path === '/open-api/goods/modify-skc-shelf'), true);
  check('activate execute payload shelf state 1', calls.find(c => c.path === '/open-api/goods/modify-skc-shelf')?.body?.skc_site_info_list?.[0]?.shelf_state, 1);
  check('activate execute readback ok', activateExec.json?.readback?.ok, true);

  const certTask = {
    id: 'certificate-smoke',
    status: 'waiting_review',
    command: '给 SMK 的 TEST-PRODUCT 绑定证书池',
    targets: {stores: ['SMK'], productRefs: ['TEST-PRODUCT']},
    certificatePayloads: [{endpoint: '/open-api/goods/save-certificate-pool-skc-bind', body: {skc_name: 'sv-smoke-skc', certificate_pool_id: 'CERTPOOL-SMOKE'}}],
    intents: ['certificate_review'],
  };
  const certDryFile = await writeJson('task-cert-dry.json', {version: 1, tasks: [certTask]});
  calls.length = 0;
  const certDry = await runNode([...commonArgs, '--task-id', 'certificate-smoke', '--task-json', certDryFile, '--dry-run']);
  check('certificate dry-run exits 0', certDry.code, 0);
  check('certificate dry-run ok', certDry.json?.ok, true);
  check('certificate dry-run payload hash present', Boolean(certDry.json?.payload?.payloadHash), true);
  check('certificate dry-run does not write', calls.some(c => c.path === '/open-api/goods/save-certificate-pool-skc-bind'), false);
  const certHash = certDry.json?.payload?.payloadHash || '';
  const certExecFile = await writeJson('task-cert-exec.json', {version: 1, executionContext: {expectedPayloadHash: certHash}, tasks: [certTask]});
  calls.length = 0;
  const certExec = await runNode([...commonArgs, '--task-id', 'certificate-smoke', '--task-json', certExecFile, '--execute', '--confirm', CONFIRM_TEXT]);
  check('certificate execute exits 0', certExec.code, 0);
  check('certificate execute state submitted', certExec.json?.state, 'submitted');
  check('certificate execute publish code', certExec.json?.publishResult?.code, '0');
  check('certificate execute calls bind endpoint', calls.some(c => c.path === '/open-api/goods/save-certificate-pool-skc-bind'), true);
  check('certificate execute requires manual review', certExec.json?.readback?.status || '', s => String(s).includes('certificate_submitted_manual_review_required'));
  check('certificate execute not auto ok', certExec.json?.ok, false);
  ok = checks.every(c => c.pass);
} finally {
  await new Promise(resolve => fake.close(resolve));
}
const result = {ok, tmpRoot, checks, callPaths: calls.map(c => c.path)};
console.log(JSON.stringify(result, null, 2));
if (ok && !KEEP_TEMP) await fs.rm(tmpRoot, {recursive: true, force: true});
else if (!ok) console.error(`maintenance executor smoke failed; temp kept at ${tmpRoot}`);
if (!ok) process.exit(1);
