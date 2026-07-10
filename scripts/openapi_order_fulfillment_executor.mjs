#!/usr/bin/env node
/**
 * SHEIN OpenAPI order fulfillment executor.
 *
 * High-risk by design: dry-run is default. Execute requires:
 * - explicit --mode execute
 * - --confirm SHEIN_ORDER_FULFILLMENT_SUBMIT
 * - --payload-hash matching dry-run output
 * - store identity probe success
 *
 * Daily local Windows/Codex usage must not call real SHEIN OpenAPI; run real
 * fulfillment only inside shein-bi-tencent/cloud runtime or fake OpenAPI tests.
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
import {executeOrderFulfillment} from '../lib/openapi_adapters/order_fulfillment.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG = process.env.SHEIN_OPENAPI_CONFIG_FILE || path.join(ROOT, 'config', 'shein_openapi.local.json');
const DEFAULT_OUT_DIR = path.join(ROOT, 'logs', 'openapi-order-fulfillment-executor');
const DEFAULT_STORE_TRUTH = path.join(ROOT, 'config', 'store_account_truth.json');
const CONFIRM_TEXT = 'SHEIN_ORDER_FULFILLMENT_SUBMIT';

function splitList(value) { return String(value || '').split(/[\s,;/]+/).map(x => x.trim()).filter(Boolean); }
function normalizeStoreKey(value) { return String(value || '').trim().toUpperCase(); }
function rel(file) { return path.relative(ROOT, file).replace(/\\/g, '/'); }
async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function writeJson(file, data) { await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8'); }

function parseArgs(argv) {
  const args = {action: '', mode: 'dry-run', confirm: '', payloadHash: '', config: DEFAULT_CONFIG, outDir: DEFAULT_OUT_DIR, store: '', storeTruth: DEFAULT_STORE_TRUTH, orderNo: '', handleType: 1, expressCode: '', expressIdCode: '', expressChannelCode: '', goodsIds: [], goodsId: '', status: 2, preRequestId: '', packageNo: [], deliveryNo: '', quiet: false};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--action') args.action = String(argv[++i] || '').trim();
    else if (a === '--mode') args.mode = String(argv[++i] || 'dry-run').trim();
    else if (a === '--confirm') args.confirm = String(argv[++i] || '').trim();
    else if (a === '--payload-hash') args.payloadHash = String(argv[++i] || '').trim();
    else if (a === '--config') args.config = path.resolve(String(argv[++i] || ''));
    else if (a === '--out-dir') args.outDir = path.resolve(String(argv[++i] || ''));
    else if (a === '--store') args.store = String(argv[++i] || '').trim().toUpperCase();
    else if (a === '--store-truth') args.storeTruth = path.resolve(String(argv[++i] || ''));
    else if (a === '--order-no' || a === '--order') args.orderNo = String(argv[++i] || '').trim();
    else if (a === '--handle-type') args.handleType = Number(argv[++i] || 1);
    else if (a === '--express-code') args.expressCode = String(argv[++i] || '').trim();
    else if (a === '--express-id-code') args.expressIdCode = String(argv[++i] || '').trim();
    else if (a === '--express-channel-code') args.expressChannelCode = String(argv[++i] || '').trim();
    else if (a === '--goods-id') args.goodsId = String(argv[++i] || '').trim();
    else if (a === '--goods-ids') args.goodsIds.push(...splitList(argv[++i]));
    else if (a === '--status') args.status = Number(argv[++i] || 2);
    else if (a === '--pre-request-id') args.preRequestId = String(argv[++i] || '').trim();
    else if (a === '--package-no' || a === '--package-nos') args.packageNo.push(...splitList(argv[++i]));
    else if (a === '--delivery-no') args.deliveryNo = String(argv[++i] || '').trim();
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--help' || a === '-h') { console.log(help()); process.exit(0); }
    else if (!args.action) args.action = a;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function help() {
  return `Usage:
  node scripts/openapi_order_fulfillment_executor.mjs export-address --store FY --order-no <order> [--handle-type 1|2]
  node scripts/openapi_order_fulfillment_executor.mjs import-express --store FY --order-no <order> --goods-id <id> --express-code <no> --express-id-code <carrier>
  node scripts/openapi_order_fulfillment_executor.mjs place-express-order --store FY --order-no <order> --goods-ids <id,id> --express-channel-code <code> --pre-request-id <id>
  node scripts/openapi_order_fulfillment_executor.mjs print-express-info --store FY --order-no <order> --package-no <pkg>

Execute requires: --mode execute --confirm ${CONFIRM_TEXT} --payload-hash <dry-run hash>

Local boundary:
  do not run real execute from the local Windows/Codex machine; use the cloud BI executor instead.`;
}

async function loadClient(args) {
  const config = await readJson(args.config);
  const stores = Array.isArray(config.stores) ? config.stores : Object.entries(config.stores || {}).map(([storeKey, value]) => ({storeKey, ...value}));
  const store = stores.find(s => normalizeStoreKey(s.storeKey || s.key || s.store) === normalizeStoreKey(args.store));
  if (!store?.openKeyId || !store?.secretKey) throw new Error(`未在 ${rel(args.config)} 找到 ${args.store} 的 openKeyId/secretKey`);
  return {config, store, client: new SheinOpenApiClient({baseUrl: config.apiBaseUrls?.prodSemiManaged || SHEIN_OPENAPI_BASE_URLS.prodSemiManaged, openKeyId: store.openKeyId, secretKey: store.secretKey})};
}

async function verifyStoreIdentity(client, storeKey, configuredStore, truthFile) {
  const truthRoot = await readJson(truthFile);
  const truth = truthRoot.stores?.[storeKey];
  if (!truth) return {ok: false, skipped: true, reason: 'missing store_account_truth entry for high-risk order fulfillment'};
  const response = await client.request('/open-api/openapi-business-backend/query-store-info', {method: 'POST', body: {}, headers: {language: 'en'}});
  const identity = validateStoreIdentity({store: configuredStore, truth, storageIdentity: openApiIdentityToStorageIdentity(response.data), href: 'openapi:/open-api/openapi-business-backend/query-store-info', context: 'openapi_order_fulfillment_executor'});
  if (identity.ok || storeIdentityMatchesMerchantOnly(identity)) return {ok: true, identity, httpStatus: response.status};
  return {ok: false, identity, httpStatus: response.status, error: formatStoreIdentityError(identity)};
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.action) throw new Error('action is required');
  if (!['dry-run', 'execute'].includes(args.mode)) throw new Error('--mode must be dry-run or execute');
  if (!args.store) throw new Error('--store is required');
  const startedAt = new Date().toISOString();
  const {client, store} = await loadClient(args);
  const params = {orderNo: args.orderNo, handleType: args.handleType, expressCode: args.expressCode, expressIdCode: args.expressIdCode, expressChannelCode: args.expressChannelCode, goodsId: args.goodsId, goodsIds: args.goodsIds.length ? args.goodsIds : args.goodsId, status: args.status, preRequestId: args.preRequestId, packageNo: args.packageNo, deliveryNo: args.deliveryNo};
  const blockers = [];
  const dryPlan = await executeOrderFulfillment(client, args.action, params, {mode: 'dry-run'});
  if (!dryPlan.ok) blockers.push(...(dryPlan.blockers || ['payload validation failed']));
  if (args.mode === 'execute') {
    if (args.confirm !== CONFIRM_TEXT) blockers.push(`execute requires --confirm ${CONFIRM_TEXT}`);
    if (!args.payloadHash || args.payloadHash !== dryPlan.payloadHash) blockers.push('execute requires --payload-hash matching dry-run payloadHash');
  }
  let identity = {ok: true, skipped: args.mode !== 'execute', reason: args.mode !== 'execute' ? 'dry-run does not call SHEIN identity probe' : ''};
  if (args.mode === 'execute' && !blockers.length) {
    identity = await verifyStoreIdentity(client, args.store, store, args.storeTruth);
    if (!identity.ok) blockers.push(identity.error || identity.reason || 'store identity validation failed');
  }
  let adapterResult = dryPlan;
  if (args.mode === 'execute' && !blockers.length) {
    adapterResult = await executeOrderFulfillment(client, args.action, params, {mode: 'execute'});
    if (!adapterResult.ok) blockers.push(...(adapterResult.blockers || ['adapter failed']));
  }
  const output = {ok: blockers.length === 0, action: dryPlan.action || args.action, mode: args.mode, storeKey: args.store, startedAt, endedAt: new Date().toISOString(), adapterResult, storeIdentity: identity.skipped ? {skipped: true, reason: identity.reason} : {ok: identity.ok, httpStatus: identity.httpStatus || null}, blockers, safety: {dryRunDoesNotCallShein: args.mode !== 'execute', executeRequiresConfirmText: true, executeRequiresPayloadHash: true, executeRequiresStoreIdentityProbe: true, highRiskOrderFulfillment: true, outputOmitsSecrets: true}};
  const outPath = path.join(args.outDir, `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${output.action}-${args.store}.json`);
  await writeJson(outPath, output);
  output.savedTo = rel(outPath);
  if (!args.quiet) console.log(JSON.stringify(output, null, 2));
  if (!output.ok) process.exitCode = 1;
}

main().catch(err => { console.error(JSON.stringify({ok: false, error: err?.message || String(err)}, null, 2)); process.exitCode = 1; });
