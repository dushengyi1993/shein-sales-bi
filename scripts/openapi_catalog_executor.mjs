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
 *
 * Daily local CLI usage must not run real execute from this Windows/Codex
 * machine; real OpenAPI calls belong in shein-bi-tencent/cloud runtime or fake
 * OpenAPI smoke tests.
 */
import crypto from 'node:crypto';
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG = process.env.SHEIN_OPENAPI_CONFIG_FILE || path.join(ROOT, 'config', 'shein_openapi.local.json');
const DEFAULT_STORE_TRUTH = path.join(ROOT, 'config', 'store_account_truth.json');
const DEFAULT_CATALOG = path.join(ROOT, 'outputs', 'shein-openapi-doc-catalog', 'official-capabilities.latest.json');
const DEFAULT_OUT_DIR = path.join(ROOT, 'logs', 'openapi-catalog-executor');
const DEFAULT_DETAIL_DIR = path.join(ROOT, 'outputs', 'shein-openapi-doc-catalog', 'api-details');
const CONFIRM_TEXT = 'SHEIN_OPENAPI_GENERIC_WRITE_SUBMIT';
const INTEGRATED_STATUSES = new Set(['integrated_read_parallel', 'controlled_write_adapter', 'schema_ready_adapter_next']);

function parseArgs(argv) {
  const args = {command: 'call', docId: '', endpoint: '', bodyJson: '{}', bodyFile: '', queryJson: '', queryFile: '', mode: 'dry-run', confirm: '', payloadHash: '', store: '', config: DEFAULT_CONFIG, storeTruth: DEFAULT_STORE_TRUTH, catalog: DEFAULT_CATALOG, detailDir: DEFAULT_DETAIL_DIR, outDir: DEFAULT_OUT_DIR, out: '', format: 'json', quiet: false};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === 'plan' || a === 'call') args.command = a;
    else if (a === '--doc-id' || a === '--docId') args.docId = String(argv[++i] || '').trim();
    else if (a === '--endpoint') args.endpoint = String(argv[++i] || '').trim();
    else if (a === '--body-json') args.bodyJson = String(argv[++i] || '{}');
    else if (a === '--body-file') args.bodyFile = path.resolve(String(argv[++i] || ''));
    else if (a === '--query-json') args.queryJson = String(argv[++i] || '{}');
    else if (a === '--query-file') args.queryFile = path.resolve(String(argv[++i] || ''));
    else if (a === '--mode') args.mode = String(argv[++i] || 'dry-run').trim();
    else if (a === '--confirm') args.confirm = String(argv[++i] || '').trim();
    else if (a === '--payload-hash') args.payloadHash = String(argv[++i] || '').trim();
    else if (a === '--store') args.store = String(argv[++i] || '').trim().toUpperCase();
    else if (a === '--config') args.config = path.resolve(String(argv[++i] || ''));
    else if (a === '--store-truth') args.storeTruth = path.resolve(String(argv[++i] || ''));
    else if (a === '--catalog') args.catalog = path.resolve(String(argv[++i] || ''));
    else if (a === '--detail-dir') args.detailDir = path.resolve(String(argv[++i] || ''));
    else if (a === '--out-dir') args.outDir = path.resolve(String(argv[++i] || ''));
    else if (a === '--out') args.out = path.resolve(String(argv[++i] || ''));
    else if (a === '--format') args.format = String(argv[++i] || 'json').trim();
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--help' || a === '-h') { console.log(help()); process.exit(0); }
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function help() {
  return `Usage:
  node scripts/openapi_catalog_executor.mjs plan [--out catalog-plan.json]
  node scripts/openapi_catalog_executor.mjs --doc-id 3001544 --store FY --body-json '{}'
  node scripts/openapi_catalog_executor.mjs --endpoint /open-api/goods/searchProduct --store FY --body-file payload.json
  node scripts/openapi_catalog_executor.mjs --doc-id 3001621 --store FY --query-json '{"orderNo":"..."}'

GET endpoints use --query-json/--query-file. POST endpoints use --body-json/--body-file.

Write execute requires:
  --mode execute --confirm ${CONFIRM_TEXT} --payload-hash <dry-run hash>

Local boundary:
  do not run real execute from the local Windows/Codex machine; use the cloud BI executor instead.`;
}

function rel(file) { return path.relative(ROOT, file).replace(/\\/g, '/'); }
function normalizeStoreKey(value) { return String(value || '').trim().toUpperCase(); }
function sha256(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function readJsonIfExists(file) { try { return await readJson(file); } catch (err) { if (err?.code === 'ENOENT') return null; throw err; } }
async function writeJson(file, data) { await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8'); }

async function parseJsonInput({file, json, label}) {
  if (file) return await readJson(file);
  try { return JSON.parse(json || '{}'); }
  catch (err) { throw new Error(`${label} is not valid JSON: ${err.message}`); }
}
async function parseBody(args) { return await parseJsonInput({file: args.bodyFile, json: args.bodyJson, label: '--body-json'}); }
async function parseQuery(args) { return await parseJsonInput({file: args.queryFile, json: args.queryJson || '{}', label: '--query-json'}); }

function hasBlobLikeField(node, depth = 0) {
  if (!node || depth > 12) return false;
  if (Array.isArray(node)) return node.some(x => hasBlobLikeField(x, depth + 1));
  if (typeof node !== 'object') return false;
  const type = String(node.type || '').toLowerCase();
  const name = String(node.name || node.field || '').toLowerCase();
  const desc = String(node.description || node.desc || '').toLowerCase();
  if (['blob', 'file', 'binary'].includes(type)) return true;
  if (/multipart|form-data/.test(type) || /multipart|form-data/.test(desc)) return true;
  if (name === 'file' && /文件|图片|pdf|jpg|jpeg|png|xls|xlsx|csv|upload/.test(desc)) return true;
  return Object.values(node).some(value => hasBlobLikeField(value, depth + 1));
}

async function loadDetailIfAny(args, entry) {
  const docId = String(entry.docId || args.docId || '').trim();
  if (!docId) return null;
  try { return await readJson(path.join(args.detailDir, `${docId}.json`)); }
  catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

function catalogRows(catalog) {
  return Array.isArray(catalog.items) ? catalog.items : Array.isArray(catalog.rows) ? catalog.rows : Array.isArray(catalog.capabilities) ? catalog.capabilities : [];
}

async function findCatalogEntry(args) {
  const catalog = await readJson(args.catalog);
  const rows = catalogRows(catalog);
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

function blocksMultipart(entry, detail) {
  const text = JSON.stringify(entry).toLowerCase();
  if (text.includes('multipart') || text.includes('blob') || /upload-pic|upload.*file|file.*upload/i.test(String(entry.endpoint || ''))) return true;
  if (detail && hasBlobLikeField(detail.requestBody || detail.requestSchema || detail.requestFields || detail.requestExample || detail)) return true;
  return false;
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


function classifyPlanEntry(entry, detail) {
  const documentKind = String(entry.documentKind || '').toLowerCase();
  const rw = String(entry.read_or_write || '').toLowerCase();
  const status = String(entry.project_status || '').trim();
  const method = String(entry.method || 'POST').toUpperCase();
  const fileLike = blocksMultipart(entry, detail);
  const write = isWriteEntry(entry);
  let lane = 'catalog_json_call';
  let nextAction = '可用 openapi-call；本地只做离线计划/payload，真实 execute 需在云端并经过店铺身份探针。';
  if (documentKind === 'webhook' || rw === 'webhook') {
    lane = 'webhook_design_only';
    nextAction = '本轮不开发 receiver；未来先做验签、解密、幂等和落库。';
  } else if (fileLike) {
    lane = 'dedicated_file_adapter_required';
    nextAction = '不得走 openapi-call；需要 multipart/file 专用 adapter 和 fake OpenAPI 测试。';
  } else if (String(status) === 'official_available_out_of_current_scope') {
    lane = 'out_of_current_scope';
    nextAction = '官方有能力但当前 BI/运营主路径不接；按业务进入该域后另建 owner。';
  } else if (INTEGRATED_STATUSES.has(status)) {
    lane = 'dedicated_or_integrated';
    nextAction = '已有专用/并行层；保持现有受控链路，不用通用兜底替代高频路径。';
  } else if (write) {
    lane = 'catalog_json_guarded_write';
    nextAction = '低频 JSON 写可用 openapi-call 做离线预检；真实 execute 必须在云端满足确认文本 + payloadHash + 店铺身份探针。';
  } else if (method === 'GET') {
    lane = 'catalog_json_get_read';
    nextAction = '低频 GET 读可用 openapi-call --query-json/--query-file 组织参数；真实回读在云端执行。';
  }
  return {lane, nextAction, fileLike, write, method};
}

async function buildCatalogPlan(args) {
  const catalog = await readJson(args.catalog);
  const rows = catalogRows(catalog);
  const items = [];
  const counts = {total: rows.length, byLane: {}, byStatus: {}, getJsonCallable: 0, postJsonCallable: 0, webhookDesignOnly: 0, fileDedicatedRequired: 0};
  for (const entry of rows) {
    const detail = await loadDetailIfAny(args, entry);
    const classified = classifyPlanEntry(entry, detail);
    counts.byLane[classified.lane] = (counts.byLane[classified.lane] || 0) + 1;
    const status = String(entry.project_status || 'unknown');
    counts.byStatus[status] = (counts.byStatus[status] || 0) + 1;
    if (classified.lane === 'catalog_json_get_read') counts.getJsonCallable += 1;
    if (['catalog_json_call', 'catalog_json_guarded_write'].includes(classified.lane) && classified.method !== 'GET') counts.postJsonCallable += 1;
    if (classified.lane === 'webhook_design_only') counts.webhookDesignOnly += 1;
    if (classified.lane === 'dedicated_file_adapter_required') counts.fileDedicatedRequired += 1;
    items.push({
      category: entry.category || entry.apiCategory || '',
      docId: String(entry.docId || ''),
      title: entry.title || entry.userDocName || '',
      method: classified.method,
      endpoint: entry.endpoint || '',
      readOrWrite: classified.write ? 'write' : 'read',
      projectStatus: entry.project_status || '',
      riskLevel: entry.risk_level || '',
      lane: classified.lane,
      nextAction: classified.nextAction,
    });
  }
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    catalog: rel(args.catalog),
    detailDir: rel(args.detailDir),
    counts,
    safety: {
      localOnlyNoSheinNetwork: true,
      webhookReceiverEnabled: false,
      fileEndpointsBlockedFromGenericJsonCall: true,
      writeExecuteStillRequiresConfirmHashAndIdentityProbe: true,
    },
    items,
  };
}

function printPlanSummary(plan) {
  console.log(`OpenAPI catalog plan: ${plan.counts.total} interfaces`);
  console.log(`- generic JSON GET reads: ${plan.counts.getJsonCallable}`);
  console.log(`- generic JSON POST/read-write candidates: ${plan.counts.postJsonCallable}`);
  console.log(`- dedicated/file adapters required: ${plan.counts.fileDedicatedRequired}`);
  console.log(`- WebHook design-only: ${plan.counts.webhookDesignOnly}`);
  console.log(`- lanes: ${Object.entries(plan.counts.byLane).map(([k,v]) => `${k}=${v}`).join(', ')}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'plan') {
    const plan = await buildCatalogPlan(args);
    if (args.out) await writeJson(args.out, plan);
    if (!args.quiet) {
      if (args.format === 'summary') printPlanSummary(plan);
      else console.log(JSON.stringify({...plan, savedTo: args.out ? rel(args.out) : undefined}, null, 2));
    }
    return;
  }
  if (!args.docId && !args.endpoint) throw new Error('--doc-id or --endpoint is required');
  if (!args.store) throw new Error('--store is required');
  if (!['dry-run', 'execute'].includes(args.mode)) throw new Error('--mode must be dry-run or execute');
  const startedAt = new Date().toISOString();
  const entry = await findCatalogEntry(args);
  const detail = await loadDetailIfAny(args, entry);
  const method = String(entry.method || 'POST').toUpperCase();
  const body = method === 'GET' ? {} : await parseBody(args);
  const query = method === 'GET' ? await parseQuery(args) : {};
  const write = isWriteEntry(entry);
  const blockers = [];
  if (method === 'GET' && (args.bodyFile || (args.bodyJson && args.bodyJson !== '{}'))) blockers.push('GET endpoints must use --query-json/--query-file, not --body-json/--body-file');
  if (method !== 'GET' && (args.queryFile || args.queryJson)) blockers.push('Only GET endpoints may use --query-json/--query-file in catalog executor');
  if (blocksMultipart(entry, detail)) blockers.push('multipart/file endpoint requires a dedicated adapter; catalog executor only supports JSON bodies');
  const plan = {docId: String(entry.docId || ''), endpoint: entry.endpoint, method, readOrWrite: write ? 'write' : 'read', query, body};
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
    const resp = await client.request(entry.endpoint, {method: plan.method, query, body, headers: {language: 'zh-cn'}});
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
