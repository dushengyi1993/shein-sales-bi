#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import {SheinOpenApiClient, SHEIN_OPENAPI_BASE_URLS} from '../lib/shein_openapi_client.mjs';
import {
  buildProductMasterCandidateFromOpenApiSpuInfo,
  summarizeProductMasterCandidate,
} from '../lib/shein_product_master.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG = path.join(ROOT, 'config', 'shein_openapi.local.json');
const DEFAULT_OUT_DIR = path.join(ROOT, 'tmp', 'product-master-candidates');

function parseArgs(argv) {
  const args = {
    config: DEFAULT_CONFIG,
    store: 'HL',
    spuName: '',
    productPageSize: 20,
    out: '',
    outDir: DEFAULT_OUT_DIR,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') args.config = path.resolve(argv[++i]);
    else if (a === '--store') args.store = String(argv[++i] || '').trim().toUpperCase();
    else if (a === '--spu-name') args.spuName = String(argv[++i] || '').trim();
    else if (a === '--product-page-size') args.productPageSize = Number(argv[++i] || args.productPageSize);
    else if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--out-dir') args.outDir = path.resolve(argv[++i]);
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--help' || a === '-h') {
      console.log(`Usage:
  node scripts/link_ops_build_product_master_candidate_from_openapi.mjs --store HL [--spu-name <spuName>]

用途：
  用 SHEIN OpenAPI 读取源店商品详情，生成不含图片的商品资料母库候选。
  不调用 publishOrEdit，不写 SHEIN 后台。`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function stamp(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function mask(value) {
  const s = String(value || '');
  if (!s) return '';
  if (s.length <= 10) return '***';
  return `${s.slice(0, 4)}***${s.slice(-4)}`;
}

function firstStringByKeys(obj, keys) {
  const seen = new Set();
  const queue = [obj];
  while (queue.length) {
    const cur = queue.shift();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    if (Array.isArray(cur)) {
      queue.push(...cur);
      continue;
    }
    for (const key of keys) {
      const value = cur[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (Array.isArray(value)) {
        const found = value.find(v => typeof v === 'string' && v.trim());
        if (found) return found.trim();
      }
    }
    queue.push(...Object.values(cur));
  }
  return '';
}

async function call(client, {method = 'POST', path: pathText, body, query}) {
  const response = await client.request(pathText, {method, body, query, headers: {language: 'en'}});
  if (response.data?.code !== '0') {
    throw new Error(`${pathText} 返回 ${response.data?.code}: ${response.data?.msg || ''}`);
  }
  return response.data;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await readJson(args.config);
  const store = asArray(config.stores).find(s => String(s?.storeKey || '').toUpperCase() === args.store);
  if (!store?.openKeyId || !store?.secretKey) {
    throw new Error(`未在 ${path.relative(ROOT, args.config)} 找到 ${args.store} 的 openKeyId/secretKey。`);
  }
  const client = new SheinOpenApiClient({
    baseUrl: config.apiBaseUrls?.prodSemiManaged || SHEIN_OPENAPI_BASE_URLS.prodSemiManaged,
    openKeyId: store.openKeyId,
    secretKey: store.secretKey,
  });
  let spuName = args.spuName;
  let productQuery = null;
  if (!spuName) {
    productQuery = await call(client, {
      path: '/open-api/openapi-business-backend/product/query',
      body: {pageNum: 1, pageSize: args.productPageSize},
    });
    spuName = firstStringByKeys(productQuery, ['spuName']);
  }
  if (!spuName) throw new Error('OpenAPI 商品列表没有返回可用 spuName，请手动传 --spu-name。');
  const spuInfoResponse = await call(client, {
    path: '/open-api/goods/spu-info',
    body: {spuName, languageList: ['en', 'ar']},
  });
  const spuInfo = spuInfoResponse.info || {};
  const candidate = buildProductMasterCandidateFromOpenApiSpuInfo(spuInfo, {storeKey: args.store});
  const output = {
    ok: true,
    runId: `pmc_openapi_${stamp()}_${crypto.randomBytes(4).toString('hex')}`,
    state: candidate.reviewStatus === 'ready_candidate' ? 'candidate_ready' : 'candidate_needs_review',
    storeKey: args.store,
    openKeyId: mask(store.openKeyId),
    source: {
      type: 'shein_openapi',
      productQueryUsed: Boolean(productQuery),
      spuName,
    },
    summary: summarizeProductMasterCandidate(candidate),
    candidate,
  };
  const outPath = args.out || path.join(args.outDir, `${output.runId}.local.json`);
  await writeJson(outPath, output);
  output.savedTo = path.relative(ROOT, outPath).replace(/\\/g, '/');
  if (!args.quiet) console.log(JSON.stringify(output, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({ok: false, state: 'error', error: err?.stack || err?.message || String(err)}, null, 2));
  process.exit(1);
});
