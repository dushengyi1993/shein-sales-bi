#!/usr/bin/env node
/**
 * SHEIN OpenAPI image asset utility executor.
 *
 * Supports guarded dry-run/execute for utility image endpoints:
 * - /open-api/goods/upload-pic (multipart local image upload)
 * - /open-api/goods/transform-pic (external URL conversion)
 *
 * This script is intentionally separate from bi_ops_cli.mjs. Daily local CLI
 * usage must not call real SHEIN OpenAPI from this Windows machine; bi_ops_cli
 * routes real image asset execution to the cloud BI service. This lower-level
 * executor is retained for shein-bi-tencent/cloud runtime and fake OpenAPI
 * smoke tests.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SheinOpenApiClient, SHEIN_OPENAPI_BASE_URLS} from '../lib/shein_openapi_client.mjs';
import {
  formatStoreIdentityError,
  openApiIdentityToStorageIdentity,
  storeIdentityMatchesMerchantOnly,
  validateStoreIdentity,
} from '../lib/shein_store_identity.mjs';
import {executeUploadPic} from '../lib/openapi_adapters/upload_pic.mjs';
import {executeTransformPic} from '../lib/openapi_adapters/transform_pic.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG = process.env.SHEIN_OPENAPI_CONFIG_FILE || path.join(ROOT, 'config', 'shein_openapi.local.json');
const DEFAULT_OUT_DIR = path.join(ROOT, 'logs', 'openapi-image-asset-executor');
const DEFAULT_STORE_TRUTH = path.join(ROOT, 'config', 'store_account_truth.json');

function parseArgs(argv) {
  const args = {
    action: '',
    mode: 'dry-run',
    config: DEFAULT_CONFIG,
    outDir: DEFAULT_OUT_DIR,
    store: '',
    imageType: 0,
    filePath: '',
    originalUrl: '',
    quiet: false,
    storeTruth: DEFAULT_STORE_TRUTH,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--action') args.action = String(argv[++i] || '').trim();
    else if (a === '--mode') args.mode = String(argv[++i] || 'dry-run').trim();
    else if (a === '--config') args.config = path.resolve(String(argv[++i] || ''));
    else if (a === '--out-dir') args.outDir = path.resolve(String(argv[++i] || ''));
    else if (a === '--store') args.store = String(argv[++i] || '').trim().toUpperCase();
    else if (a === '--image-type' || a === '--type') args.imageType = Number(argv[++i] || 0);
    else if (a === '--file' || a === '--file-path') args.filePath = path.resolve(String(argv[++i] || ''));
    else if (a === '--url' || a === '--original-url') args.originalUrl = String(argv[++i] || '').trim();
    else if (a === '--store-truth') args.storeTruth = path.resolve(String(argv[++i] || ''));
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--help' || a === '-h') {
      console.log(help());
      process.exit(0);
    } else if (!args.action) args.action = a;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function help() {
  return `Usage:
  node scripts/openapi_image_asset_executor.mjs upload-pic --store FY --image-type 2 --file <image.jpg> [--mode dry-run|execute]
  node scripts/openapi_image_asset_executor.mjs transform-pic --store FY --image-type 2 --url <https://...> [--mode dry-run|execute]

Safety:
  - default mode is dry-run;
  - execute validates store identity before calling SHEIN;
  - do not run real execute from the local Windows/Codex machine; use the cloud BI executor instead;
  - output never includes secretKey/openKeyId or raw file bytes.`;
}

function rel(file) { return path.relative(ROOT, file).replace(/\\/g, '/'); }
function normalizeStoreKey(value) { return String(value || '').trim().toUpperCase(); }

async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function loadClient(args) {
  const config = await readJson(args.config);
  const stores = Array.isArray(config.stores) ? config.stores : Object.entries(config.stores || {}).map(([storeKey, value]) => ({storeKey, ...value}));
  const store = stores.find(s => normalizeStoreKey(s.storeKey || s.key || s.store) === normalizeStoreKey(args.store));
  if (!store?.openKeyId || !store?.secretKey) throw new Error(`未在 ${rel(args.config)} 找到 ${args.store} 的 openKeyId/secretKey`);
  return {
    config,
    store,
    client: new SheinOpenApiClient({
      baseUrl: config.apiBaseUrls?.prodSemiManaged || SHEIN_OPENAPI_BASE_URLS.prodSemiManaged,
      openKeyId: store.openKeyId,
      secretKey: store.secretKey,
    }),
  };
}

async function verifyStoreIdentity(client, storeKey, configuredStore, truthFile) {
  const truthRoot = await readJson(truthFile);
  const truth = truthRoot.stores?.[storeKey];
  if (!truth) return {ok: true, skipped: true, reason: 'no store_account_truth entry'};
  const response = await client.request('/open-api/openapi-business-backend/query-store-info', {method: 'POST', body: {}, headers: {language: 'en'}});
  const identity = validateStoreIdentity({
    store: configuredStore,
    truth,
    storageIdentity: openApiIdentityToStorageIdentity(response.data),
    href: 'openapi:/open-api/openapi-business-backend/query-store-info',
    context: 'openapi_image_asset_executor',
  });
  if (identity.ok || storeIdentityMatchesMerchantOnly(identity)) return {ok: true, identity, httpStatus: response.status};
  return {ok: false, identity, httpStatus: response.status, error: formatStoreIdentityError(identity)};
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!['upload-pic', 'transform-pic'].includes(args.action)) throw new Error('action must be upload-pic or transform-pic');
  if (!['dry-run', 'execute'].includes(args.mode)) throw new Error('--mode must be dry-run or execute');
  if (!args.store) throw new Error('--store is required');
  const startedAt = new Date().toISOString();
  const {client, store} = await loadClient(args);
  const warnings = [];
  const blockers = [];
  let identity = {ok: true, skipped: args.mode !== 'execute', reason: args.mode !== 'execute' ? 'dry-run does not call SHEIN identity probe' : ''};
  if (args.mode === 'execute') {
    identity = await verifyStoreIdentity(client, args.store, store, args.storeTruth);
    if (!identity.ok) blockers.push(identity.error || 'store identity validation failed');
  }
  let adapterResult = null;
  if (!blockers.length) {
    if (args.action === 'upload-pic') adapterResult = await executeUploadPic(client, {imageType: args.imageType, filePath: args.filePath}, {mode: args.mode});
    else adapterResult = await executeTransformPic(client, {imageType: args.imageType, originalUrl: args.originalUrl}, {mode: args.mode});
    if (!adapterResult.ok) blockers.push(...(adapterResult.blockers || adapterResult.errors || ['adapter failed']));
  }
  const output = {
    ok: blockers.length === 0,
    action: args.action,
    mode: args.mode,
    storeKey: args.store,
    startedAt,
    endedAt: new Date().toISOString(),
    adapterResult,
    storeIdentity: identity.skipped ? {skipped: true, reason: identity.reason} : {ok: identity.ok, httpStatus: identity.httpStatus || null},
    blockers,
    warnings,
    safety: {
      dryRunDoesNotCallSheinUtilityEndpoint: args.mode !== 'execute',
      executeRequiresStoreIdentityProbe: true,
      outputOmitsSecretsAndFileBytes: true,
    },
  };
  const outPath = path.join(args.outDir, `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${args.action}-${args.store}.json`);
  await writeJson(outPath, output);
  output.savedTo = rel(outPath);
  if (!args.quiet) console.log(JSON.stringify(output, null, 2));
  if (!output.ok) process.exitCode = 1;
}

main().catch(err => {
  console.error(JSON.stringify({ok: false, error: err?.message || String(err)}, null, 2));
  process.exitCode = 1;
});
