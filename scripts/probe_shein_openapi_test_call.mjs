#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SheinOpenApiClient, SHEIN_OPENAPI_BASE_URLS} from '../lib/shein_openapi_client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CRED_PATH = path.join(ROOT, 'tmp', 'shein-openapi-runtime', 'test-store-credentials.local.json');

function parseArgs(argv) {
  const args = {credPath: DEFAULT_CRED_PATH, outPath: path.join(ROOT, 'tmp', 'shein-openapi-runtime', 'test-api-call-results.local.json')};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cred') args.credPath = path.resolve(argv[++i]);
    else if (a === '--out') args.outPath = path.resolve(argv[++i]);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const cred = JSON.parse(await fs.readFile(args.credPath, 'utf8'));
if (!cred.openKeyId || !cred.secretKey) {
  throw new Error(`Missing openKeyId/secretKey in ${args.credPath}`);
}

const client = new SheinOpenApiClient({
  baseUrl: cred.baseUrl || SHEIN_OPENAPI_BASE_URLS.test,
  openKeyId: cred.openKeyId,
  secretKey: cred.secretKey,
});

const candidates = [
  {name: 'query-site-list', path: '/open-api/goods/query-site-list', method: 'POST', body: {}},
  {name: 'site-query-old', path: '/open-api/openapi-business-backend/site/query', method: 'POST', body: {}},
  {name: 'warehouse-list', path: '/open-api/msc/warehouse/list', method: 'POST', body: {}},
  {name: 'product-query', path: '/open-api/openapi-business-backend/product/query', method: 'POST', body: {pageNo: 1, pageSize: 10}},
  {name: 'order-list', path: '/open-api/order/order-list', method: 'POST', body: {pageNo: 1, pageSize: 10}},
];

const results = [];
for (const c of candidates) {
  try {
    const r = await client.request(c.path, {method: c.method, body: c.body});
    const body = r.data;
    results.push({
      name: c.name,
      path: c.path,
      httpStatus: r.status,
      code: body?.code ?? null,
      msg: body?.msg ?? null,
      hasInfo: body?.info != null,
      traceId: body?.traceId ?? null,
    });
    if (r.status === 200 && String(body?.code) === '0') break;
  } catch (err) {
    results.push({name: c.name, path: c.path, error: String(err?.message || err)});
  }
}

await fs.mkdir(path.dirname(args.outPath), {recursive: true});
await fs.writeFile(args.outPath, JSON.stringify({capturedAt: new Date().toISOString(), results}, null, 2), 'utf8');
console.log(JSON.stringify({savedTo: path.relative(ROOT, args.outPath).replace(/\\/g, '/'), results}, null, 2));
