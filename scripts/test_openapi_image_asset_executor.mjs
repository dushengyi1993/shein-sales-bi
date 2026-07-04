#!/usr/bin/env node
/**
 * Fake OpenAPI smoke for image asset executor and adapters.
 * Never calls real SHEIN.
 */
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {SheinOpenApiClient} from '../lib/shein_openapi_client.mjs';
import {executeTransformPic} from '../lib/openapi_adapters/transform_pic.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = path.join(ROOT, 'tmp');
await fs.mkdir(tmpBase, {recursive: true});
const tmpRoot = await fs.mkdtemp(path.join(tmpBase, 'openapi-image-assets-smoke-'));
const checks = [];
function check(label, actual, expected) {
  const pass = typeof expected === 'function' ? expected(actual) : actual === expected;
  checks.push({label, actual, expected: typeof expected === 'function' ? 'predicate' : expected, pass});
  return pass;
}
function sendJson(res, value, status = 200) {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'});
  res.end(JSON.stringify(value));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
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
function runNode(args, {allowLocalOpenApiExecutor = true} = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, {cwd: ROOT, env: {...process.env, ...(allowLocalOpenApiExecutor ? {SHEIN_BI_ALLOW_LOCAL_OPENAPI_EXECUTOR: '1'} : {})}, stdio: ['ignore', 'pipe', 'pipe']});
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
async function writeJson(relPath, value) {
  const file = path.join(tmpRoot, relPath);
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}

const calls = [];
const port = await freePort();
const fake = http.createServer(async (req, res) => {
  const body = await readBody(req);
  const pathname = req.url.split('?')[0];
  const contentType = req.headers['content-type'] || '';
  calls.push({path: pathname, method: req.method, contentType, bodyLength: body.length, bodyPreview: body.toString('utf8', 0, Math.min(300, body.length))});
  if (pathname === '/open-api/openapi-business-backend/query-store-info') {
    return sendJson(res, {code: '0', msg: 'OK', info: {shopName: 'Smoke Store', merchantId: 'merchant-smoke', accountNo: 'GS123456'}});
  }
  if (pathname === '/open-api/goods/upload-pic') {
    const text = body.toString('utf8');
    if (!contentType.includes('multipart/form-data; boundary=')) return sendJson(res, {code: '400', msg: 'missing multipart boundary'});
    if (contentType.includes('application/json')) return sendJson(res, {code: '400', msg: 'bad content type'});
    if (!text.includes('name="image_type"') || !text.includes('name="file"')) return sendJson(res, {code: '400', msg: 'bad multipart fields'});
    return sendJson(res, {code: '0', msg: 'OK', traceId: 'trace-upload', info: {image_url: 'https://img.shein.test/uploaded.jpg', width: 1340, height: 1785, size: 1024, image_hex_type: 'jpg'}, bbl: null});
  }
  if (pathname === '/open-api/goods/transform-pic') {
    const json = JSON.parse(body.toString('utf8') || '{}');
    if (json.image_type !== 2 || json.original_url !== 'https://example.com/a.jpg') return sendJson(res, {code: '400', msg: 'bad transform payload'});
    return sendJson(res, {code: '0', msg: 'OK', traceId: 'trace-transform', info: {original: json.original_url, transformed: 'https://img.shein.test/transformed.jpg', failure_reason: ''}, bbl: null});
  }
  return sendJson(res, {code: '404', msg: `Unhandled ${pathname}`}, 404);
});
await new Promise(resolve => fake.listen(port, '127.0.0.1', resolve));

try {
  const configFile = await writeJson('openapi.json', {
    apiBaseUrls: {prodSemiManaged: `http://127.0.0.1:${port}`},
    stores: [{storeKey: 'SMK', openKeyId: 'dummy-open', secretKey: 'dummy-secret', merchantId: 'merchant-smoke'}],
  });
  const truthFile = await writeJson('store_truth.json', {stores: {SMK: {merchantId: 'merchant-smoke', accountNo: 'GS123456'}}});
  const imgFile = path.join(tmpRoot, 'test-image.jpg');
  const secretBinaryMarker = 'BINARY_SECRET_MARKER_SHOULD_NOT_APPEAR';
  await fs.writeFile(imgFile, Buffer.from(`\xff\xd8\xff${secretBinaryMarker}`));

  const cliDryRunUpload = await runNode(['scripts/bi_ops_cli.mjs', 'upload-pic', '--openapi-config', configFile, '--store', 'SMK', '--image-type', '2', '--file', imgFile]);
  check('CLI upload-pic dry-run exits 0', cliDryRunUpload.code, 0);
  check('CLI upload-pic dry-run ok', cliDryRunUpload.json?.ok, true);
  check('CLI upload-pic dry-run delegates without network', calls.length, 0);

  const blockedCliUpload = await runNode(['scripts/bi_ops_cli.mjs', 'upload-pic', '--openapi-config', configFile, '--store', 'SMK', '--image-type', '2', '--file', imgFile, '--mode', 'execute'], {allowLocalOpenApiExecutor: false});
  check('CLI upload-pic local execute blocks without explicit test override', blockedCliUpload.code !== 0, true);
  check('CLI upload-pic local execute block mentions cloud boundary', blockedCliUpload.stderr + blockedCliUpload.stdout, x => String(x).includes('cannot run local SHEIN OpenAPI through bi_ops_cli'));
  check('CLI upload-pic local execute block made no network', calls.length, 0);

  const dryRunUpload = await runNode(['scripts/openapi_image_asset_executor.mjs', 'upload-pic', '--config', configFile, '--store-truth', truthFile, '--store', 'SMK', '--image-type', '2', '--file', imgFile]);
  check('upload dry-run exits 0', dryRunUpload.code, 0);
  check('upload dry-run ok', dryRunUpload.json?.ok, true);
  check('upload dry-run does not call OpenAPI', calls.length, 0);
  check('upload dry-run omits binary marker', dryRunUpload.stdout.includes(secretBinaryMarker), false);

  const execUpload = await runNode(['scripts/openapi_image_asset_executor.mjs', 'upload-pic', '--config', configFile, '--store-truth', truthFile, '--store', 'SMK', '--image-type', '2', '--file', imgFile, '--mode', 'execute']);
  check('upload execute exits 0', execUpload.code, 0);
  check('upload execute ok', execUpload.json?.ok, true);
  check('upload execute returns imageUrl', execUpload.json?.adapterResult?.result?.imageUrl, 'https://img.shein.test/uploaded.jpg');
  check('upload execute does identity then upload', calls.map(c => c.path).join(','), '/open-api/openapi-business-backend/query-store-info,/open-api/goods/upload-pic');
  check('multipart content-type has boundary', calls.find(c => c.path === '/open-api/goods/upload-pic')?.contentType, v => /multipart\/form-data; boundary=/.test(v));
  check('multipart content-type omits json', calls.find(c => c.path === '/open-api/goods/upload-pic')?.contentType.includes('application/json'), false);
  check('upload execute stdout omits binary marker', execUpload.stdout.includes(secretBinaryMarker), false);

  const beforeBadStoreCalls = calls.length;
  const badStore = await runNode(['scripts/openapi_image_asset_executor.mjs', 'transform-pic', '--config', configFile, '--store-truth', truthFile, '--store', 'BAD', '--image-type', '2', '--url', 'https://example.com/a.jpg', '--mode', 'execute']);
  check('bad store blocks before network', badStore.code !== 0, true);
  check('bad store made no network calls', calls.length, beforeBadStoreCalls);

  calls.length = 0;
  const dryRunTransform = await runNode(['scripts/openapi_image_asset_executor.mjs', 'transform-pic', '--config', configFile, '--store-truth', truthFile, '--store', 'SMK', '--image-type', '2', '--url', 'https://example.com/a.jpg']);
  check('transform dry-run exits 0', dryRunTransform.code, 0);
  check('transform dry-run ok', dryRunTransform.json?.ok, true);
  check('transform dry-run no network', calls.length, 0);

  const execTransform = await runNode(['scripts/openapi_image_asset_executor.mjs', 'transform-pic', '--config', configFile, '--store-truth', truthFile, '--store', 'SMK', '--image-type', '2', '--url', 'https://example.com/a.jpg', '--mode', 'execute']);
  check('transform execute exits 0', execTransform.code, 0);
  check('transform execute ok', execTransform.json?.ok, true);
  check('transform execute transformed url', execTransform.json?.adapterResult?.result?.transformedUrl, 'https://img.shein.test/transformed.jpg');
  check('transform execute identity then transform', calls.map(c => c.path).join(','), '/open-api/openapi-business-backend/query-store-info,/open-api/goods/transform-pic');

  const directClient = new SheinOpenApiClient({baseUrl: `http://127.0.0.1:${port}`, openKeyId: 'dummy-open', secretKey: 'dummy-secret'});
  calls.length = 0;
  const directTransform = await executeTransformPic(directClient, {imageType: 2, originalUrl: 'https://example.com/a.jpg'}, {mode: 'execute'});
  check('adapter direct transform ok', directTransform.ok, true);
  check('adapter direct transform path', calls[0]?.path, '/open-api/goods/transform-pic');

  const failed = checks.filter(c => !c.pass);
  console.log(JSON.stringify({ok: failed.length === 0, checks, tmpRoot}, null, 2));
  process.exitCode = failed.length ? 1 : 0;
} finally {
  fake.close();
  await fs.rm(tmpRoot, {recursive: true, force: true}).catch(() => {});
}
