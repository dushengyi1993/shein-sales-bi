#!/usr/bin/env node
/**
 * SHEIN OpenAPI catalog-driven generic JSON executor.
 *
 * This is the broad fallback for official JSON OpenAPI abilities that do not yet
 * have a dedicated adapter. It is intentionally guarded:
 * - default dry-run never calls SHEIN;
 * - execute validates store identity;
 * - write execute requires confirm text and matching dry-run payload hash;
 * - multipart/file endpoints are blocked here and must use dedicated adapters.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SheinOpenApiClient, SHEIN_OPENAPI_BASE_URLS} from '../lib/shein_openapi_client.mjs';
import {formatStoreIdentityError, validateStoreIdentity} from '../lib/shein_store_identity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG = process.env.SHEIN_OPENAPI_CONFIG_FILE || path.join(ROOT, 'config', 'shein_openapi.local.json');
const DEFAULT_STORE_TRUTH = path.join(ROOT, 'config', 'store_account_truth.json');
const DEFAULT_CATALOG = path.join(ROOT, 'outputs', 'shein-openapi-doc-catalog', 'official-capabilities.latest.json');
const DEFAULT_OUT_DIR = path.join(ROOT, 'logs', 'openapi-catalog-executor');
const CONFIRM_TEXT = 'SHEIN_OPENAPI_GENERIC_WRITE_SUBMIT';

function parseArgs(argv) {
  const args = {docId: '', endpoint: '', bodyJson: '{}', bodyFile: '', mode: 'dry-run', confirm: '', payloadHash: '', store: '', config: DEFAULT_CONFIG, storeTruth: DEFAULT_STORE_TRUTH, catalog: DEFAULT_CATALOG, outDir: DEFAULT_OUT_DIR, quiet: false};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--doc-id' || a === '--docId') args.docId = String(argv[++i] || '').trim();
    else if (a === '--endpoint') args.endpoint = String(argv[++i] || '').trim();
    else if (a === '--body-json') args.bodyJson = String(argv[++i] || '{}');
    else if (a === '--body-file') args.bodyFile = path.resolve(String(argv[++i] || ''));
    else if (a === '--mode') args.mode = String(argv[++i] || 'dry-run').trim();
    else if (a === '--confirm') args.confirm = String(argv[++i] || '').trim();
    else if (a === '--payload-hash') args.payloadHash = String(argv[++i] || '').trim();
    else if (a === '--store') args.store = String(argv[++i] || '').trim().toUpperCase();
    else if (a === '--config') args.config = path.resolve(String(argv[++i] || ''));
    else if (a === '--store-truth') args.storeTruth = path.resolve(String(argv[++i] || ''));
    else if (a === '--catalog') args.catalog = path.resolve(String(argv[++i] || ''));
    else if (a === '--out-dir') args.outDir = path.resolve(String(argv[++i] || ''));
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--help' || a === '-h') { console.log(help()); process.exit(0); }
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function help() {
  return `Usage:
  node scripts/openapi_catalog_executor.mjs --doc-id 3001544 --store FY --body-json '{}'
  node scripts/openapi_catalog_executor.mjs --endpoint /open-api/goods/searchProduct --store FY --body-file payload.json

Write execute requires:
  --mode execute --confirm ${CONFIRM_TEXT} --payload-hash <dry-run hash>`;
}

function rel(file) { return path.relative(ROOT, file).replace(/\\/g, '/'); }
function safeString(value, max = 500) { return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max); }
function normalizeStoreKey(value) { return String(value || '').trim().toUpperCase(); }
function sha256(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function writeJson(file, data) { await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8'); }

async function parseBody(args) {
  if (args.bodyFile) return await readJson(args.bodyFile);
  try { return JSON.parse(args.bodyJson || '{}'); }
  catch (err) { throw new Error(`--body-json is not valid JSON: ${err.message}`); }
}

async function findCatalogEntry(args) {
  const catalog = await readJson(args.catalog);
  const rows = Array.isArray(catalog.items) ? catalog.items : Array.isArray(catalog.rows) ? catalog.rows : Array.isArray(catalog.capabilities) ? catalog.capabilities : [];
  const entry = rows.find(row => (args.docId && String(row.docId || '') === String(args.docId)) || (args.endpoint && String(row.endpoint || '') === String(args.endpoint)));
  if (!entry) throw new Error(`OpenAPI catalog entry not found for docId=${args.docId || '-'} endpoint=${args.endpoint || '-'}`);
  if (String(entry.documentKind || '').toLowerCase() === 'webhook' || String(entry.read_or_write || '').toLowerCase() === 'webhook') throw new Error('Webhook entries cannot be called by OpenAPI catalog executor');
  if (!entry.endpoint) throw new Error(`Catalog entry ${entry.docId || args.docId} has no endpoint`);
  return entry;
}

function isWriteEntry(entry) {
  const rw = String(entry.read_or_write || '').toLowerCase();
  if (rw === 'write') return true;
  if (rw === 'read') return false;
  const risk = String(entry.risk_level || '').toLowerCase();
  return risk === 'high' || /save|update|upload|create|modify|change|import|place|print|bind|process|cancel|sign/i.test(String(entry.endpoint || ''));
}

function blocksMultipart(entry) {
  const text = JSON.stringify(entry).toLowerCase();
  return text.includes('multipart') || text.includes('blob') || /upload-pic|upload.*file|file.*upload/i.test(String(entry.endpoint || ''));
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
async function verifyStoreIdentity(client, storeKey, configuredStore, truthFile, {strict = false} = {}) {
  const truthRoot = await readJson(truthFile);
  const truth = truthRoot.stores?.[storeKey];
  if (!truth) return strict ? {ok: false, skipped: true, reason: 'missing store_account_truth entry'} : {ok: true, skipped: true, reason: 'no store_account_truth entry'};
  const response = await client.request('/open-api/openapi-business-backend/query-store-info', {method: 'POST', body: {}, headers: {language: 'en'}});
  const identity = validateStoreIdentity({store: configuredStore, truth, storageIdentity: openApiIdentityToStorageIdentity(response.data), href: 'openapi:/open-api/openapi-business-backend/query-store-info', context: 'openapi_catalog_executor'});
  if (identity.ok || storeIdentityMatchesMerchantOnly(identity)) return {ok: true, identity, httpStatus: response.status};
  return {ok: false, identity, httpStatus: response.status, error: formatStoreIdentityError(identity)};
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.docId && !args.endpoint) throw new Error('--doc-id or --endpoint is required');
  if (!args.store) throw new Error('--store is required');
  if (!['dry-run', 'execute'].includes(args.mode)) throw new Error('--mode must be dry-run or execute');
  const startedAt = new Date().toISOString();
  const entry = await findCatalogEntry(args);
  const body = await parseBody(args);
  const write = isWriteEntry(entry);
  const blockers = [];
  if (blocksMultipart(entry)) blockers.push('multipart/file endpoint requires a dedicated adapter; catalog executor only supports JSON bodies');
  const plan = {docId: String(entry.docId || ''), endpoint: entry.endpoint, method: String(entry.method || 'POST').toUpperCase(), readOrWrite: write ? 'write' : 'read', body};
  const payloadHash = sha256(plan);
  if (args.mode === 'execute' && write) {
    if (args.confirm !== CONFIRM_TEXT) blockers.push(`write execute requires --confirm ${CONFIRM_TEXT}`);
    if (!args.payloadHash || args.payloadHash !== payloadHash) blockers.push('write execute requires --payload-hash matching dry-run payloadHash');
  }
  const {client, store} = await loadClient(args);
  let identity = {ok: true, skipped: args.mode !== 'execute', reason: args.mode !== 'execute' ? 'dry-run does not call SHEIN identity probe' : ''};
  let responseSummary = null;
  if (args.mode === 'execute' && !blockers.length) {
    identity = await verifyStoreIdentity(client, args.store, store, args.storeTruth, {strict: write});
    if (!identity.ok) blockers.push(identity.error || identity.reason || 'store identity validation failed');
  }
  if (args.mode === 'execute' && !blockers.length) {
    const resp = await client.request(entry.endpoint, {method: plan.method, body, headers: {language: 'zh-cn'}});
    const code = String(resp.data?.code ?? '');
    const ok = resp.ok && code === '0';
    responseSummary = {ok, httpStatus: resp.status, code, msg: resp.data?.msg || '', traceId: resp.data?.traceId || '', info: resp.data?.info ?? null};
    if (!ok) blockers.push(`${entry.endpoint} failed: code=${code || '(missing)'} msg=${resp.data?.msg || resp.statusText || ''}`);
  }
  const output = {ok: blockers.length === 0, mode: args.mode, storeKey: args.store, startedAt, endedAt: new Date().toISOString(), catalogEntry: {docId: entry.docId, title: entry.title || entry.userDocName || '', endpoint: entry.endpoint, method: entry.method || 'POST', projectStatus: entry.project_status || '', readOrWrite: write ? 'write' : 'read'}, plan, payloadHash, storeIdentity: identity.skipped ? {skipped: true, reason: identity.reason} : {ok: identity.ok, httpStatus: identity.httpStatus || null}, response: responseSummary, blockers, safety: {dryRunDoesNotCallShein: args.mode !== 'execute', writeExecuteRequiresConfirmAndHash: write, executeRequiresStoreIdentityProbe: true, catalogDrivenGenericJsonOnly: true, outputOmitsSecrets: true}};
  const outPath = path.join(args.outDir, `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${entry.docId || 'endpoint'}-${args.store}.json`);
  await writeJson(outPath, output);
  output.savedTo = rel(outPath);
  if (!args.quiet) console.log(JSON.stringify(output, null, 2));
  if (!output.ok) process.exitCode = 1;
}
main().catch(err => { console.error(JSON.stringify({ok: false, error: err?.message || String(err)}, null, 2)); process.exitCode = 1; });
