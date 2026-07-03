#!/usr/bin/env node
/**
 * SHEIN OpenAPI read-only utility executor.
 *
 * Supports guarded dry-run/execute for readback and schema helper endpoints:
 * - /open-api/goods/query-document-state
 * - /open-api/goods/searchProduct
 * - /open-api/goods/query-publish-fill-in-standard
 *
 * It never submits SHEIN writes. Execute validates store identity before reading.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SheinOpenApiClient, SHEIN_OPENAPI_BASE_URLS} from '../lib/shein_openapi_client.mjs';
import {formatStoreIdentityError, validateStoreIdentity} from '../lib/shein_store_identity.mjs';
import {executeQueryDocumentState} from '../lib/openapi_adapters/query_document_state.mjs';
import {executeSearchProduct} from '../lib/openapi_adapters/search_product.mjs';
import {executeQueryPublishFillInStandard} from '../lib/openapi_adapters/query_publish_fill_in_standard.mjs';
import {executeQueryShelfQuota} from '../lib/openapi_adapters/query_shelf_quota.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG = process.env.SHEIN_OPENAPI_CONFIG_FILE || path.join(ROOT, 'config', 'shein_openapi.local.json');
const DEFAULT_OUT_DIR = path.join(ROOT, 'logs', 'openapi-readonly-executor');
const DEFAULT_STORE_TRUTH = path.join(ROOT, 'config', 'store_account_truth.json');

function splitList(value) { return String(value || '').split(/[\s,;/]+/).map(x => x.trim()).filter(Boolean); }
function normalizeStoreKey(value) { return String(value || '').trim().toUpperCase(); }
function safeString(value, max = 500) { return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max); }
function rel(file) { return path.relative(ROOT, file).replace(/\\/g, '/'); }
async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function writeJson(file, data) { await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8'); }

function parseArgs(argv) {
  const args = {action: '', mode: 'dry-run', config: DEFAULT_CONFIG, outDir: DEFAULT_OUT_DIR, store: '', storeTruth: DEFAULT_STORE_TRUTH, spu: [], skc: [], skuCode: [], supplierCode: [], supplierSku: [], categoryIds: [], pageNum: 1, pageSize: 10, language: [], categoryId: '', version: '', quiet: false};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--action') args.action = String(argv[++i] || '').trim();
    else if (a === '--mode') args.mode = String(argv[++i] || 'dry-run').trim();
    else if (a === '--config') args.config = path.resolve(String(argv[++i] || ''));
    else if (a === '--out-dir') args.outDir = path.resolve(String(argv[++i] || ''));
    else if (a === '--store') args.store = String(argv[++i] || '').trim().toUpperCase();
    else if (a === '--store-truth') args.storeTruth = path.resolve(String(argv[++i] || ''));
    else if (a === '--spu' || a === '--spu-name') args.spu.push(...splitList(argv[++i]));
    else if (a === '--skc' || a === '--skc-name') args.skc.push(...splitList(argv[++i]));
    else if (a === '--sku-code') args.skuCode.push(...splitList(argv[++i]));
    else if (a === '--supplier-code' || a === '--product-ref') args.supplierCode.push(...splitList(argv[++i]));
    else if (a === '--supplier-sku') args.supplierSku.push(...splitList(argv[++i]));
    else if (a === '--category' || a === '--category-id') { const v = String(argv[++i] || '').trim(); args.categoryId = v; args.categoryIds.push(v); }
    else if (a === '--page' || a === '--page-num') args.pageNum = Number(argv[++i] || 1);
    else if (a === '--page-size' || a === '--limit') args.pageSize = Number(argv[++i] || 10);
    else if (a === '--language' || a === '--languages') args.language.push(...splitList(argv[++i]));
    else if (a === '--version') args.version = String(argv[++i] || '').trim();
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--help' || a === '-h') { console.log(help()); process.exit(0); }
    else if (!args.action) args.action = a;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function help() {
  return `Usage:
  node scripts/openapi_readonly_executor.mjs audit-status --store FY --spu <SPU> [--mode dry-run|execute]
  node scripts/openapi_readonly_executor.mjs search-product --store FY [--spu <SPU>|--skc <SKC>|--supplier-code <货号>] [--mode dry-run|execute]
  node scripts/openapi_readonly_executor.mjs publish-standard --store FY [--category <id>] [--mode dry-run|execute]
  node scripts/openapi_readonly_executor.mjs shelf-quota --store FY [--mode dry-run|execute]

Safety:
  - default mode is dry-run;
  - execute validates store identity before reading SHEIN;
  - this executor does not submit write endpoints.`;
}

function openApiIdentityToStorageIdentity(value) {
  const target = {accountNos: new Set(), userNames: new Set(), mainUserNames: new Set(), supplierUserNames: new Set(), supplierIds: new Set(), externalIds: new Set(), rawSources: new Set()};
  function add(setName, candidate) { const value = safeString(candidate, 160); if (value) target[setName].add(value); }
  function walk(node, source = 'openapi', depth = 0) {
    if (!node || depth > 8) return;
    if (Array.isArray(node)) { node.forEach((x, i) => walk(x, `${source}[${i}]`, depth + 1)); return; }
    if (typeof node !== 'object') return;
    add('rawSources', source);
    for (const [key, raw] of Object.entries(node)) {
      const k = String(key || '').toLowerCase();
      if (raw && typeof raw === 'object') { walk(raw, `${source}.${key}`, depth + 1); continue; }
      const v = safeString(raw, 160); if (!v) continue;
      if (/^GS\d+$/i.test(v) || /(accountno|account_no|account|storeaccount|gsaccount|supplieraccount)/i.test(k)) add('accountNos', v.toUpperCase());
      if (/(username|user_name|name|shopname|shop_name)/i.test(k)) add('userNames', v);
      if (/mainusername|main_user_name/i.test(k)) add('mainUserNames', v);
      if (/supplierusername|supplier_user_name/i.test(k)) add('supplierUserNames', v);
      if (/(supplierid|supplier_id|merchantid|merchant_id)/i.test(k)) add('supplierIds', v);
      if (/(externalid|external_id)/i.test(k)) add('externalIds', v);
    }
  }
  walk(value);
  return Object.fromEntries(Object.entries(target).map(([k, set]) => [k, [...set]]));
}

function storeIdentityMatchesMerchantOnly(identityCheck) {
  const expected = String(identityCheck?.expectedMerchantId || '').trim();
  const candidates = [...(identityCheck?.identity?.supplierIds || []), ...(identityCheck?.identity?.externalIds || []), ...(identityCheck?.storageIdentity?.supplierIds || []), ...(identityCheck?.storageIdentity?.externalIds || [])].map(x => String(x || '').trim()).filter(Boolean);
  const accountCandidates = [...(identityCheck?.identity?.accountNos || []), ...(identityCheck?.storageIdentity?.accountNos || [])].map(x => String(x || '').trim()).filter(Boolean);
  return Boolean(expected) && candidates.includes(expected) && !accountCandidates.some(x => /^GS\d+$/i.test(x));
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
  if (!truth) return {ok: true, skipped: true, reason: 'no store_account_truth entry'};
  const response = await client.request('/open-api/openapi-business-backend/query-store-info', {method: 'POST', body: {}, headers: {language: 'en'}});
  const identity = validateStoreIdentity({store: configuredStore, truth, storageIdentity: openApiIdentityToStorageIdentity(response.data), href: 'openapi:/open-api/openapi-business-backend/query-store-info', context: 'openapi_readonly_executor'});
  if (identity.ok || storeIdentityMatchesMerchantOnly(identity)) return {ok: true, identity, httpStatus: response.status};
  return {ok: false, identity, httpStatus: response.status, error: formatStoreIdentityError(identity)};
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!['audit-status', 'search-product', 'publish-standard', 'shelf-quota'].includes(args.action)) throw new Error('action must be audit-status, search-product, publish-standard or shelf-quota');
  if (!['dry-run', 'execute'].includes(args.mode)) throw new Error('--mode must be dry-run or execute');
  if (!args.store) throw new Error('--store is required');
  const startedAt = new Date().toISOString();
  const {client, store} = await loadClient(args);
  const blockers = [];
  let identity = {ok: true, skipped: args.mode !== 'execute', reason: args.mode !== 'execute' ? 'dry-run does not call SHEIN identity probe' : ''};
  if (args.mode === 'execute') {
    identity = await verifyStoreIdentity(client, args.store, store, args.storeTruth);
    if (!identity.ok) blockers.push(identity.error || 'store identity validation failed');
  }
  let adapterResult = null;
  if (!blockers.length) {
    if (args.action === 'audit-status') adapterResult = await executeQueryDocumentState(client, {spuNameList: args.spu, version: args.version}, {mode: args.mode});
    else if (args.action === 'search-product') adapterResult = await executeSearchProduct(client, {pageNum: args.pageNum, pageSize: args.pageSize, spuNameList: args.spu, skcNameList: args.skc, skuCodeList: args.skuCode, skcSupplierCodeList: args.supplierCode, supplierSkuList: args.supplierSku, categoryIds: args.categoryIds, languageList: args.language}, {mode: args.mode});
    else if (args.action === 'shelf-quota') adapterResult = await executeQueryShelfQuota(client, {}, {mode: args.mode});
    else adapterResult = await executeQueryPublishFillInStandard(client, {categoryId: args.categoryId, spuName: args.spu[0] || ''}, {mode: args.mode});
    if (!adapterResult.ok) blockers.push(...(adapterResult.blockers || ['adapter failed']));
  }
  const output = {ok: blockers.length === 0, action: args.action, mode: args.mode, storeKey: args.store, startedAt, endedAt: new Date().toISOString(), adapterResult, storeIdentity: identity.skipped ? {skipped: true, reason: identity.reason} : {ok: identity.ok, httpStatus: identity.httpStatus || null}, blockers, safety: {dryRunDoesNotCallShein: args.mode !== 'execute', executeRequiresStoreIdentityProbe: true, readOnlyUtilityExecutor: true, outputOmitsSecrets: true}};
  const outPath = path.join(args.outDir, `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${args.action}-${args.store}.json`);
  await writeJson(outPath, output);
  output.savedTo = rel(outPath);
  if (!args.quiet) console.log(JSON.stringify(output, null, 2));
  if (!output.ok) process.exitCode = 1;
}

main().catch(err => { console.error(JSON.stringify({ok: false, error: err?.message || String(err)}, null, 2)); process.exitCode = 1; });
