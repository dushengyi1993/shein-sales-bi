#!/usr/bin/env node
/** Fake OpenAPI smoke for read-only adapters and executor. Never calls real SHEIN. */
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = path.join(ROOT, 'tmp');
await fs.mkdir(tmpBase, {recursive: true});
const tmpRoot = await fs.mkdtemp(path.join(tmpBase, 'openapi-readonly-smoke-'));
const checks = [];
function check(label, actual, expected) { const pass = typeof expected === 'function' ? expected(actual) : actual === expected; checks.push({label, actual, expected: typeof expected === 'function' ? 'predicate' : expected, pass}); return pass; }
function sendJson(res, value, status = 200) { res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'}); res.end(JSON.stringify(value)); }
function readBody(req) { return new Promise((resolve, reject) => { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject); }); }
async function freePort() { return new Promise((resolve, reject) => { const server = net.createServer(); server.on('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); }); }
function runNode(args) { return new Promise(resolve => { const child = spawn(process.execPath, args, {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']}); let stdout = '', stderr = ''; child.stdout.on('data', d => { stdout += d.toString(); }); child.stderr.on('data', d => { stderr += d.toString(); }); child.on('close', code => { let json = null; try { json = stdout.trim() ? JSON.parse(stdout) : null; } catch {} resolve({code, stdout, stderr, json}); }); }); }
async function writeJson(relPath, value) { const file = path.join(tmpRoot, relPath); await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); return file; }

const calls = [];
const port = await freePort();
const fake = http.createServer(async (req, res) => {
  const body = await readBody(req);
  const pathname = req.url.split('?')[0];
  let json = {};
  try { json = JSON.parse(body.toString('utf8') || '{}'); } catch {}
  calls.push({path: pathname, method: req.method, contentType: req.headers['content-type'] || '', body: json});
  if (pathname === '/open-api/openapi-business-backend/query-store-info') return sendJson(res, {code: '0', msg: 'OK', info: {shopName: 'Smoke Store', merchantId: 'merchant-smoke', accountNo: 'GS123456'}});
  if (pathname === '/open-api/goods/query-document-state') {
    if (json.spuList?.[0]?.spuName !== 'SPU123') return sendJson(res, {code: '400', msg: 'bad audit payload'});
    return sendJson(res, {code: '0', msg: 'OK', traceId: 'trace-audit', info: {meta: {count: 1}, data: [{spuName: 'SPU123', version: 'v1', skcList: [{skcName: 'SKC123', documentSn: 'DOC1', documentState: 2, failedReason: []}]}]}});
  }
  if (pathname === '/open-api/goods/searchProduct') {
    if (json.pageSize !== 10 || json.skcSupplierCodeList?.[0] !== 'SK-5110') return sendJson(res, {code: '400', msg: 'bad search payload'});
    return sendJson(res, {code: '0', msg: 'OK', traceId: 'trace-search', info: {meta: {count: 1}, data: [{spuName: 'SPU123', spuShelfStatus: 1, categoryId: '12345', skcList: [{skcName: 'SKC123', skcShelfStatus: 1, supplierCode: 'SK-5110', skcMainPicUrl: 'https://img.test/main.jpg', skuList: [{skuCode: 'SKU123'}], skcTitle: [{language: 'en', title: 'Cooker'}]}]}]}});
  }
  if (pathname === '/open-api/goods/query-publish-fill-in-standard') {
    if (json.category_id !== 12345) return sendJson(res, {code: '400', msg: 'bad standard payload'});
    return sendJson(res, {code: '0', msg: 'OK', traceId: 'trace-standard', info: {currency: 'USD', default_language: 'en', default_language_title_max_length: 120, fill_in_standard_list: [{field_key: 'skc_title', module: '基本信息', required: true, show: true}], picture_config_list: [{field_key: 'spu_image', is_true: true}], weight_config: {is_required: true, available_units: ['kg']}, length_width_height_config: {is_required: 'true', available_units: ['cm']}, support_sale_attribute_sort: true}});
  }
  if (pathname === '/open-api/goods/query-shelf-quota') {
    return sendJson(res, {code: '0', msg: 'OK', traceId: 'trace-quota', info: {need: true, total_quota_count: 2000, on_shelf_count: 1990, remain_count: 10}});
  }
  return sendJson(res, {code: '404', msg: `Unhandled ${pathname}`}, 404);
});
await new Promise(resolve => fake.listen(port, '127.0.0.1', resolve));

try {
  const configFile = await writeJson('openapi.json', {apiBaseUrls: {prodSemiManaged: `http://127.0.0.1:${port}`}, stores: [{storeKey: 'SMK', openKeyId: 'dummy-open', secretKey: 'dummy-secret', merchantId: 'merchant-smoke'}]});
  const truthFile = await writeJson('store_truth.json', {stores: {SMK: {merchantId: 'merchant-smoke', accountNo: 'GS123456'}}});

  const cliDryAudit = await runNode(['scripts/bi_ops_cli.mjs', 'audit-status', '--openapi-config', configFile, '--store', 'SMK', '--spu', 'SPU123']);
  check('CLI audit-status dry-run exits 0', cliDryAudit.code, 0);
  check('CLI audit-status dry-run ok', cliDryAudit.json?.ok, true);
  check('CLI audit-status dry-run no network', calls.length, 0);

  const drySearch = await runNode(['scripts/openapi_readonly_executor.mjs', 'search-product', '--config', configFile, '--store-truth', truthFile, '--store', 'SMK', '--supplier-code', 'SK-5110']);
  check('search dry-run exits 0', drySearch.code, 0);
  check('search dry-run ok', drySearch.json?.ok, true);
  check('search dry-run no network', calls.length, 0);

  const execAudit = await runNode(['scripts/openapi_readonly_executor.mjs', 'audit-status', '--config', configFile, '--store-truth', truthFile, '--store', 'SMK', '--spu', 'SPU123', '--mode', 'execute']);
  check('audit execute exits 0', execAudit.code, 0);
  check('audit execute ok', execAudit.json?.ok, true);
  check('audit execute state label', execAudit.json?.adapterResult?.result?.data?.[0]?.skcList?.[0]?.documentStateLabel, '审批成功');
  check('audit identity then endpoint', calls.map(c => c.path).join(','), '/open-api/openapi-business-backend/query-store-info,/open-api/goods/query-document-state');

  calls.length = 0;
  const execSearchCli = await runNode(['scripts/bi_ops_cli.mjs', 'search-product', '--openapi-config', configFile, '--store-truth', truthFile, '--store', 'SMK', '--product', 'SK-5110', '--mode', 'execute']);
  check('CLI search-product execute exits 0', execSearchCli.code, 0);
  check('CLI search-product result supplier', execSearchCli.json?.adapterResult?.result?.data?.[0]?.skcList?.[0]?.supplierCode, 'SK-5110');
  check('CLI search-product identity then endpoint', calls.map(c => c.path).join(','), '/open-api/openapi-business-backend/query-store-info,/open-api/goods/searchProduct');

  calls.length = 0;
  const execStandardCli = await runNode(['scripts/bi_ops_cli.mjs', 'publish-standard', '--openapi-config', configFile, '--store-truth', truthFile, '--store', 'SMK', '--category', '12345', '--mode', 'execute']);
  check('CLI publish-standard execute exits 0', execStandardCli.code, 0);
  check('CLI publish-standard default language', execStandardCli.json?.adapterResult?.result?.defaultLanguage, 'en');
  check('CLI publish-standard picture config', execStandardCli.json?.adapterResult?.result?.pictureConfigList?.[0]?.is_true, true);
  check('CLI publish-standard identity then endpoint', calls.map(c => c.path).join(','), '/open-api/openapi-business-backend/query-store-info,/open-api/goods/query-publish-fill-in-standard');

  calls.length = 0;
  const execQuotaCli = await runNode(['scripts/bi_ops_cli.mjs', 'shelf-quota', '--openapi-config', configFile, '--store-truth', truthFile, '--store', 'SMK', '--mode', 'execute']);
  check('CLI shelf-quota execute exits 0', execQuotaCli.code, 0);
  check('CLI shelf-quota remain count', execQuotaCli.json?.adapterResult?.result?.remainCount, 10);
  check('CLI shelf-quota identity then endpoint', calls.map(c => c.path).join(','), '/open-api/openapi-business-backend/query-store-info,/open-api/goods/query-shelf-quota');

  const badInput = await runNode(['scripts/openapi_readonly_executor.mjs', 'search-product', '--config', configFile, '--store', 'SMK', '--page-size', '99']);
  check('bad page size blocked', badInput.code !== 0, true);
  check('bad page size message', badInput.stdout + badInput.stderr, x => String(x).includes('pageSize'));

  const failed = checks.filter(c => !c.pass);
  console.log(JSON.stringify({ok: failed.length === 0, checks, tmpRoot}, null, 2));
  process.exitCode = failed.length ? 1 : 0;
} finally {
  fake.close();
  await fs.rm(tmpRoot, {recursive: true, force: true}).catch(() => {});
}
