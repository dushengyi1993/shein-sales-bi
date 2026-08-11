#!/usr/bin/env node
/**
 * Deterministic SHEIN pending-discuss runner.
 *
 * Daily automation may use `scan` only. `preflight` and `execute` are an
 * explicit, current-task approval path; execute is cloud-only for real SHEIN
 * hosts and never retries an uncertain write.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeJsonFileAtomic} from '../lib/atomic_file_publish.mjs';
import {acquireCrossProcessTicketLock} from '../lib/cross_process_ticket_lock.mjs';
import {
  PENDING_DISCUSS_CONFIRM_TEXT,
  PENDING_DISCUSS_PROCESS_ENDPOINT,
  PENDING_DISCUSS_QUERY_ENDPOINT,
  PENDING_DISCUSS_SAFE_WRITE_OPERATION,
  buildPreflightDocument,
  buildScanDocument,
  businessDateShanghai,
  extractDiscussPage,
  isRetryableReadFailure,
  normalizePendingDiscussRow,
  pendingDiscussKey,
  redactError,
  sha256Json,
  verifyLockedItem,
  verifyPreflightDocument,
  verifyTerminalItem,
} from '../lib/pending_discuss_batch.mjs';
import {SheinOpenApiClient, SHEIN_OPENAPI_BASE_URLS, isRealSheinOpenApiBaseUrl} from '../lib/shein_openapi_client.mjs';
import {
  openApiIdentityToStorageIdentity,
  storeIdentityMatchesMerchantOnly,
  validateStoreIdentity,
} from '../lib/shein_store_identity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG = process.env.SHEIN_OPENAPI_CONFIG_FILE || path.join(ROOT, 'config', 'shein_openapi.local.json');
const DEFAULT_STORES_CONFIG = path.join(ROOT, 'config', 'stores.json');
const DEFAULT_STORE_TRUTH = path.join(ROOT, 'config', 'store_account_truth.json');
const REAL_LOCK_PATH = '/run/lock/shein-pending-discuss-write.lock';
const DEFAULT_LOCK_PATH = process.env.SHEIN_PENDING_DISCUSS_LOCK_PATH
  || (process.platform === 'win32'
    ? path.join(os.tmpdir(), 'shein-pending-discuss-write.lock')
    : REAL_LOCK_PATH);
const QUERY_IDENTITY_ENDPOINT = '/open-api/openapi-business-backend/query-store-info';

function parseArgs(argv) {
  const args = {
    command: '', outDir: '', config: DEFAULT_CONFIG, storesConfig: DEFAULT_STORES_CONFIG,
    storeTruth: DEFAULT_STORE_TRUTH, decisions: '', preflight: '', batchHash: '', confirm: '',
    lockPath: DEFAULT_LOCK_PATH, pageSize: 200, readAttempts: 3, readDelayMs: 250,
    requestTimeoutMs: 20_000, terminalAttempts: 8, terminalDelayMs: 1_500,
    preflightMinutes: 15, expectedStoreCount: Number(process.env.SHEIN_PENDING_DISCUSS_EXPECTED_STORE_COUNT || 19), quiet: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('-') && !args.command) args.command = token;
    else if (token === '--out-dir') args.outDir = path.resolve(String(argv[++index] || ''));
    else if (token === '--config') args.config = path.resolve(String(argv[++index] || ''));
    else if (token === '--stores-config') args.storesConfig = path.resolve(String(argv[++index] || ''));
    else if (token === '--store-truth') args.storeTruth = path.resolve(String(argv[++index] || ''));
    else if (token === '--decisions') args.decisions = path.resolve(String(argv[++index] || ''));
    else if (token === '--preflight') args.preflight = path.resolve(String(argv[++index] || ''));
    else if (token === '--batch-hash') args.batchHash = String(argv[++index] || '').trim();
    else if (token === '--confirm') args.confirm = String(argv[++index] || '').trim();
    else if (token === '--lock-path') args.lockPath = path.resolve(String(argv[++index] || ''));
    else if (token === '--page-size') args.pageSize = Number(argv[++index]);
    else if (token === '--read-attempts') args.readAttempts = Number(argv[++index]);
    else if (token === '--read-delay-ms') args.readDelayMs = Number(argv[++index]);
    else if (token === '--request-timeout-ms') args.requestTimeoutMs = Number(argv[++index]);
    else if (token === '--terminal-attempts') args.terminalAttempts = Number(argv[++index]);
    else if (token === '--terminal-delay-ms') args.terminalDelayMs = Number(argv[++index]);
    else if (token === '--preflight-minutes') args.preflightMinutes = Number(argv[++index]);
    else if (token === '--expected-store-count') args.expectedStoreCount = Number(argv[++index]);
    else if (token === '--quiet') args.quiet = true;
    else if (token === '--help' || token === '-h') args.command = 'help';
    else throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

function help() {
  return `Usage:
  node scripts/pending_discuss_batch.mjs scan --out-dir <new-directory>
  node scripts/pending_discuss_batch.mjs preflight --decisions <decisions.json> --out-dir <new-directory>
  SHEIN_PENDING_DISCUSS_WRITE_ENABLED=1 node scripts/pending_discuss_batch.mjs execute \\
    --preflight <preflight.json> --batch-hash <hash> \\
    --confirm ${PENDING_DISCUSS_CONFIRM_TEXT} --out-dir <new-directory>

All commands accept --config, --stores-config and --store-truth. Execute also
accepts --lock-path. Real SHEIN calls are blocked on Windows by the shared
OpenAPI client. This runner never sends a group message or creates a schedule.`;
}

function requireInteger(value, label, {min = 0, max = Number.MAX_SAFE_INTEGER} = {}) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer between ${min} and ${max}`);
  return value;
}

function validateArgs(args) {
  if (args.command === 'help') return;
  if (!['scan', 'preflight', 'execute'].includes(args.command)) throw new Error('command must be scan, preflight or execute');
  if (!args.outDir) throw new Error('--out-dir is required');
  requireInteger(args.pageSize, '--page-size', {min: 1, max: 200});
  requireInteger(args.readAttempts, '--read-attempts', {min: 1, max: 8});
  requireInteger(args.readDelayMs, '--read-delay-ms', {min: 0, max: 60_000});
  requireInteger(args.requestTimeoutMs, '--request-timeout-ms', {min: 100, max: 120_000});
  requireInteger(args.terminalAttempts, '--terminal-attempts', {min: 1, max: 120});
  requireInteger(args.terminalDelayMs, '--terminal-delay-ms', {min: 0, max: 60_000});
  requireInteger(args.preflightMinutes, '--preflight-minutes', {min: 1, max: 60});
  requireInteger(args.expectedStoreCount, '--expected-store-count', {min: 1, max: 100});
  if (args.command === 'preflight' && !args.decisions) throw new Error('preflight requires --decisions');
  if (args.command === 'execute') {
    if (!args.preflight) throw new Error('execute requires --preflight');
    if (!args.batchHash) throw new Error('execute requires --batch-hash');
    if (args.confirm !== PENDING_DISCUSS_CONFIRM_TEXT) throw new Error(`execute requires --confirm ${PENDING_DISCUSS_CONFIRM_TEXT}`);
    if (process.env.SHEIN_PENDING_DISCUSS_WRITE_ENABLED !== '1') throw new Error('execute requires SHEIN_PENDING_DISCUSS_WRITE_ENABLED=1');
  }
}

async function readJson(file) {
  return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}

async function sha256File(file) {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

async function prepareOutDir(outDir) {
  const target = path.resolve(outDir);
  await fs.mkdir(path.dirname(target), {recursive: true, mode: 0o700});
  try {
    await fs.mkdir(target, {mode: 0o700});
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const entries = await fs.readdir(target);
    if (entries.length) throw new Error(`--out-dir must be new or empty: ${target}`);
  }
  try { await fs.chmod(target, 0o700); } catch {}
  return target;
}

async function writeArtifact(outDir, name, value) {
  const file = path.join(outDir, name);
  await writeJsonFileAtomic(file, value, {mode: 0o600});
  try { await fs.chmod(file, 0o600); } catch {}
  return file;
}

async function writeManifest(outDir, command, artifactFiles, metadata = {}) {
  const artifacts = [];
  for (const file of artifactFiles) {
    const stat = await fs.stat(file);
    artifacts.push({name: path.basename(file), bytes: stat.size, sha256: await sha256File(file)});
  }
  const manifest = {
    schemaVersion: 'pending-discuss-artifacts/v1', command, generatedAt: new Date().toISOString(),
    artifacts, outputOmitsCredentialsAndRawResponses: true, ...metadata,
  };
  const manifestFile = await writeArtifact(outDir, 'manifest.json', manifest);
  return {manifest, manifestFile, manifestHash: sha256Json(manifest)};
}

function normalizeConfiguredStores(config) {
  return Array.isArray(config?.stores)
    ? config.stores
    : Object.entries(config?.stores || {}).map(([storeKey, value]) => ({storeKey, ...(value || {})}));
}

function storeKey(value) {
  return String(value || '').trim().toUpperCase();
}

export async function loadPendingDiscussRuntime(args) {
  const [openApiConfig, storesConfig, truth] = await Promise.all([
    readJson(args.config), readJson(args.storesConfig), readJson(args.storeTruth),
  ]);
  const expectedStores = (storesConfig?.stores || []).filter(row => row?.enabled !== false)
    .map(row => storeKey(row.storeKey)).filter(Boolean);
  if (!expectedStores.length) throw new Error('stores config has no enabled stores');
  if (expectedStores.length !== args.expectedStoreCount) {
    throw Object.assign(new Error(`enabled store coverage mismatch: expected=${args.expectedStoreCount} configured=${expectedStores.length}`), {code: 'EXPECTED_STORE_COUNT_MISMATCH'});
  }
  const configured = new Map(normalizeConfiguredStores(openApiConfig).map(row => [storeKey(row.storeKey || row.key || row.store), row]));
  const baseUrl = openApiConfig?.apiBaseUrls?.prodSemiManaged || SHEIN_OPENAPI_BASE_URLS.prodSemiManaged;
  return {openApiConfig, storesConfig, truth, expectedStores, configured, baseUrl};
}

function createStoreClient(runtime, key, args) {
  const configuredStore = runtime.configured.get(key);
  if (!configuredStore) throw Object.assign(new Error(`${key} is missing from SHEIN OpenAPI config`), {code: 'STORE_CONFIG_MISSING'});
  if (configuredStore.enabled === false) throw Object.assign(new Error(`${key} is disabled in SHEIN OpenAPI config`), {code: 'STORE_CONFIG_DISABLED'});
  if (!configuredStore.openKeyId || !configuredStore.secretKey) throw Object.assign(new Error(`${key} OpenAPI authorization is incomplete`), {code: 'STORE_AUTH_INCOMPLETE'});
  if (!runtime.truth?.stores?.[key]) throw Object.assign(new Error(`${key} is missing from store_account_truth`), {code: 'STORE_TRUTH_MISSING'});
  const client = new SheinOpenApiClient({
    baseUrl: runtime.baseUrl, openKeyId: configuredStore.openKeyId,
    secretKey: configuredStore.secretKey, timeoutMs: args.requestTimeoutMs,
  });
  return {client, configuredStore};
}

function apiResponseError(label, response) {
  const code = String(response?.data?.code ?? '');
  // Platform messages are untrusted response data and may echo private IDs.
  const error = new Error(`${label} failed: http=${response?.status || 0} code=${code || '(missing)'}`);
  error.status = response?.status || 0;
  error.code = code || 'OPENAPI_READ_FAILED';
  return error;
}

function responseSucceeded(response) {
  return response?.ok === true && String(response?.data?.code ?? '') === '0';
}

function delay(ms) {
  return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
}

async function readWithRetry(operation, args, label) {
  let lastError = null;
  for (let attempt = 1; attempt <= args.readAttempts; attempt += 1) {
    try {
      const response = await operation();
      if (!responseSucceeded(response)) throw apiResponseError(label, response);
      return {response, attempts: attempt};
    } catch (error) {
      lastError = error;
      if (attempt >= args.readAttempts || !isRetryableReadFailure({status: error?.status, code: error?.code, message: error?.message, error})) throw error;
      await delay(args.readDelayMs * attempt);
    }
  }
  throw lastError || new Error(`${label} failed`);
}

export async function verifyStoreIdentity(runtime, key, args) {
  const {client, configuredStore} = createStoreClient(runtime, key, args);
  const {response, attempts} = await readWithRetry(
    () => client.request(QUERY_IDENTITY_ENDPOINT, {method: 'POST', body: {}, headers: {language: 'CN'}}),
    args, `${key} store identity`,
  );
  const identity = validateStoreIdentity({
    store: configuredStore,
    truth: runtime.truth.stores[key],
    storageIdentity: openApiIdentityToStorageIdentity(response.data),
    href: `openapi:${QUERY_IDENTITY_ENDPOINT}`,
    context: 'pending_discuss_batch',
  });
  const merchantOnly = !identity.ok && storeIdentityMatchesMerchantOnly(identity);
  if (!identity.ok && !merchantOnly) {
    // Do not persist raw merchant/account identifiers from the identity probe.
    const error = new Error(`${key} store identity does not match static truth`);
    error.code = 'STORE_IDENTITY_MISMATCH';
    throw error;
  }
  return {client, configuredStore, identity: {ok: true, match: merchantOnly ? 'merchant_only' : 'full'}, attempts};
}

export async function queryDiscussStatus(runtime, key, discussStatus, args, {client: suppliedClient} = {}) {
  const client = suppliedClient || createStoreClient(runtime, key, args).client;
  const rows = [];
  const pageHashes = new Set();
  let total = null;
  let attempts = 0;
  let pages = 0;
  for (let pageNum = 1; pageNum <= 1_000; pageNum += 1) {
    const result = await readWithRetry(
      () => client.request(PENDING_DISCUSS_QUERY_ENDPOINT, {
        method: 'POST', body: {discussStatus, pageNum, pageSize: args.pageSize}, headers: {language: 'CN'},
      }), args, `${key} discuss status=${discussStatus} page=${pageNum}`,
    );
    attempts += result.attempts;
    const page = extractDiscussPage(result.response.data);
    const normalizedPage = page.rows.map(row => normalizePendingDiscussRow(key, row));
    const offStatus = normalizedPage.filter(row => row.discussStatus !== Number(discussStatus));
    if (offStatus.length) throw Object.assign(new Error(`${key} query returned ${offStatus.length} rows outside discussStatus=${discussStatus}`), {code: 'QUERY_STATUS_MISMATCH'});
    const pageHash = sha256Json(normalizedPage);
    if (normalizedPage.length && pageHashes.has(pageHash)) throw Object.assign(new Error(`${key} repeated pagination page at pageNum=${pageNum}`), {code: 'REPEATED_PAGE'});
    pageHashes.add(pageHash);
    rows.push(...normalizedPage);
    pages = pageNum;
    if (page.total !== null) total = page.total;
    if (!normalizedPage.length) {
      if (total !== null && rows.length < total) throw Object.assign(new Error(`${key} pagination ended early: rows=${rows.length} total=${total}`), {code: 'PAGINATION_INCOMPLETE'});
      break;
    }
    if (total !== null && rows.length >= total) break;
    if (normalizedPage.length < args.pageSize) break;
    if (pageNum === 1_000) throw Object.assign(new Error(`${key} pagination exceeded 1000 pages`), {code: 'PAGINATION_LIMIT'});
  }
  if (total !== null && rows.length !== total) throw Object.assign(new Error(`${key} pagination count mismatch: rows=${rows.length} total=${total}`), {code: 'PAGINATION_COUNT_MISMATCH'});
  return {rows, pages, attempts, total};
}

export async function runPendingDiscussScan(args, runtime = null) {
  const loaded = runtime || await loadPendingDiscussRuntime(args);
  const storeResults = [];
  for (const key of loaded.expectedStores) {
    try {
      const identity = await verifyStoreIdentity(loaded, key, args);
      const query = await queryDiscussStatus(loaded, key, 1, args, {client: identity.client});
      storeResults.push({storeKey: key, ok: true, rows: query.rows, pages: query.pages, attempts: identity.attempts + query.attempts, identity: identity.identity});
    } catch (error) {
      storeResults.push({storeKey: key, ok: false, rows: [], error: redactError(error), identity: {ok: false}});
    }
  }
  return buildScanDocument({
    businessDate: businessDateShanghai(), expectedStores: loaded.expectedStores,
    storeResults, generatedAt: new Date().toISOString(),
  });
}

async function collectSourceHashes(args) {
  const files = {
    domainSource: path.join(ROOT, 'lib', 'pending_discuss_batch.mjs'),
    runnerSource: path.join(ROOT, 'scripts', 'pending_discuss_batch.mjs'),
    querySchema: path.join(ROOT, 'outputs', 'shein-openapi-doc-catalog', 'api-details', '3001891.json'),
    processSchema: path.join(ROOT, 'outputs', 'shein-openapi-doc-catalog', 'api-details', '3001892.json'),
    productAliases: path.join(ROOT, 'config', 'product_aliases.json'),
    productCatalog: path.join(ROOT, 'config', 'product_catalog.json'),
    storesConfig: args.storesConfig,
    storeTruth: args.storeTruth,
    openApiConfig: args.config,
    openApiClient: path.join(ROOT, 'lib', 'shein_openapi_client.mjs'),
    storeIdentity: path.join(ROOT, 'lib', 'shein_store_identity.mjs'),
    skuNormalizer: path.join(ROOT, 'lib', 'product_sku_normalizer.mjs'),
    ticketLock: path.join(ROOT, 'lib', 'cross_process_ticket_lock.mjs'),
    atomicPublish: path.join(ROOT, 'lib', 'atomic_file_publish.mjs'),
  };
  const output = {};
  for (const [key, file] of Object.entries(files)) output[key] = await sha256File(file);
  return output;
}

function compactScan(scan) {
  return {
    ok: scan.ok, businessDate: scan.businessDate, rowCount: scan.rowCount,
    coverage: scan.coverage, duplicateKeys: scan.duplicateKeys, scanHash: scan.scanHash,
    blockers: scan.blockers,
  };
}

async function runScanCommand(args, outDir) {
  const scan = await runPendingDiscussScan(args);
  const scanFile = await writeArtifact(outDir, 'scan.json', scan);
  const manifest = await writeManifest(outDir, 'scan', [scanFile], {businessDate: scan.businessDate, ok: scan.ok, scanHash: scan.scanHash});
  return {result: {...compactScan(scan), manifestFile: manifest.manifestFile, manifestHash: manifest.manifestHash}, exitCode: scan.ok ? 0 : 3};
}

async function runPreflightCommand(args, outDir) {
  const decisions = await readJson(args.decisions);
  const currentBusinessDate = businessDateShanghai();
  if (String(decisions?.businessDate || '') !== currentBusinessDate) throw new Error(`decisions businessDate must equal current Asia/Shanghai date ${currentBusinessDate}`);
  const [runtime, sourceHashes] = await Promise.all([loadPendingDiscussRuntime(args), collectSourceHashes(args)]);
  const scan = await runPendingDiscussScan(args, runtime);
  const scanFile = await writeArtifact(outDir, 'scan.json', scan);
  if (!scan.ok) {
    const manifest = await writeManifest(outDir, 'preflight', [scanFile], {businessDate: scan.businessDate, ok: false, scanHash: scan.scanHash});
    return {result: {...compactScan(scan), mode: 'preflight', manifestFile: manifest.manifestFile, manifestHash: manifest.manifestHash}, exitCode: 3};
  }
  const generatedAt = new Date();
  const preflight = buildPreflightDocument({
    scan, decisions, sourceHashes, generatedAt: generatedAt.toISOString(),
    expiresAt: new Date(generatedAt.getTime() + args.preflightMinutes * 60_000).toISOString(),
  });
  const preflightFile = await writeArtifact(outDir, 'preflight.json', preflight);
  const manifest = await writeManifest(outDir, 'preflight', [scanFile, preflightFile], {
    businessDate: preflight.businessDate, ok: true, batchHash: preflight.batchHash,
  });
  return {result: {
    ok: true, mode: 'preflight', businessDate: preflight.businessDate, itemCount: preflight.itemCount,
    storeCount: preflight.stores.length, unmatchedPendingCount: preflight.unmatchedPendingCount,
    storePayloadHashes: preflight.stores.map(store => ({storeKey: store.storeKey, payloadHash: store.payloadHash})),
    batchHash: preflight.batchHash, expiresAt: preflight.expiresAt,
    preflightFile, manifestFile: manifest.manifestFile, manifestHash: manifest.manifestHash,
  }, exitCode: 0};
}

function flattenPreflightItems(preflight) {
  return (preflight?.stores || []).flatMap(store => (store?.items || []).map(item => ({...item, storeKey: store.storeKey})))
    .sort((left, right) => left.storeKey.localeCompare(right.storeKey) || left.discussSn.localeCompare(right.discussSn));
}

function verifySafeWriteGate(runtime, preflight) {
  const source = runtime?.openApiConfig?.safeWriteOperations || {};
  const operations = [...new Set((source.allowedOperations || source.operations || []).map(value => String(value || '').trim().toLowerCase()).filter(Boolean))];
  const stores = [...new Set((source.allowedStores || source.stores || []).map(value => storeKey(value)).filter(Boolean))];
  const targetStores = [...new Set((preflight?.stores || []).map(row => storeKey(row.storeKey)).filter(Boolean))];
  const blockers = [];
  if (source.enabled !== true) blockers.push({code: 'SAFE_WRITE_GATE_DISABLED', message: 'safeWriteOperations.enabled must be true'});
  if (source.requireDryRun !== true) blockers.push({code: 'SAFE_WRITE_DRY_RUN_REQUIRED', message: 'safeWriteOperations.requireDryRun must be true'});
  if (operations.includes('*') || !operations.includes(PENDING_DISCUSS_SAFE_WRITE_OPERATION)) blockers.push({code: 'SAFE_WRITE_OPERATION_BLOCKED', message: `${PENDING_DISCUSS_SAFE_WRITE_OPERATION} is not explicitly allowed`});
  if (stores.includes('*')) blockers.push({code: 'SAFE_WRITE_WILDCARD_BLOCKED', message: 'safeWriteOperations.allowedStores cannot use *'});
  const missingStores = targetStores.filter(key => !stores.includes(key));
  if (missingStores.length) blockers.push({code: 'SAFE_WRITE_STORE_BLOCKED', message: `target stores are not allowlisted: ${missingStores.join(',')}`});
  return {ok: blockers.length === 0, blockers};
}

function verifyRealExecutionBoundary(runtime, args) {
  if (!isRealSheinOpenApiBaseUrl(runtime?.baseUrl)) return {ok: true, blockers: []};
  const blockers = [];
  if (process.platform !== 'linux' || path.resolve(ROOT) !== path.resolve('/opt/shein-bi/app')) {
    blockers.push({code: 'CLOUD_RUNTIME_REQUIRED', message: 'real pending-discuss execute is restricted to /opt/shein-bi/app on Linux'});
  }
  if (path.resolve(args.lockPath) !== path.resolve(REAL_LOCK_PATH)) {
    blockers.push({code: 'REAL_LOCK_PATH_REQUIRED', message: `real execute must use ${REAL_LOCK_PATH}`});
  }
  return {ok: blockers.length === 0, blockers};
}

async function pollTerminal(runtime, item, client, args) {
  const expectedStatus = item.action === 'accept' ? 3 : 4;
  const polls = [];
  for (let attempt = 1; attempt <= args.terminalAttempts; attempt += 1) {
    try {
      const query = await queryDiscussStatus(runtime, item.storeKey, expectedStatus, args, {client});
      const matches = query.rows.filter(row => row.discussSn === item.discussSn);
      if (matches.length > 1) return {ok: false, pending: false, blockers: [{code: 'TERMINAL_DUPLICATE', message: `${item.storeKey} ${item.discussSn} appeared more than once`}], polls};
      if (matches.length === 1) {
        const verified = verifyTerminalItem(item, matches[0]);
        polls.push({attempt, found: true, verified: verified.ok});
        if (verified.ok) return {...verified, polls};
      } else {
        polls.push({attempt, found: false, verified: false});
      }
    } catch (error) {
      polls.push({attempt, error: redactError(error)});
      return {ok: false, pending: true, blockers: [{code: 'TERMINAL_READ_FAILED', message: redactError(error).message}], polls};
    }
    if (attempt < args.terminalAttempts) await delay(args.terminalDelayMs);
  }
  return {ok: false, pending: true, blockers: [{code: 'TERMINAL_NOT_PROVEN', message: `${item.storeKey} ${item.discussSn} did not reach a proven terminal state`}], polls};
}

async function runExecuteCommand(args, outDir) {
  const preflight = await readJson(args.preflight);
  const [runtime, sourceHashes] = await Promise.all([loadPendingDiscussRuntime(args), collectSourceHashes(args)]);
  const verification = verifyPreflightDocument(preflight, {
    businessDate: businessDateShanghai(), now: new Date(), sourceHashes, batchHash: args.batchHash,
  });
  const safeWriteGate = verifySafeWriteGate(runtime, preflight);
  verification.blockers.push(...safeWriteGate.blockers);
  verification.blockers.push(...verifyRealExecutionBoundary(runtime, args).blockers);
  verification.ok = verification.blockers.length === 0;
  if (!verification.ok) {
    const execution = {schemaVersion: 'pending-discuss-execution/v1', ok: false, phase: 'preflight-verification', blockers: verification.blockers, executed: [], failed: [], uncertain: [], notAttempted: flattenPreflightItems(preflight).map(item => ({storeKey: item.storeKey, discussSn: item.discussSn, itemHash: item.itemHash}))};
    const executionFile = await writeArtifact(outDir, 'execution.json', execution);
    const manifest = await writeManifest(outDir, 'execute', [executionFile], {ok: false, batchHash: preflight?.batchHash || ''});
    return {result: {...execution, executionFile, manifestFile: manifest.manifestFile, manifestHash: manifest.manifestHash}, exitCode: 3};
  }
  const release = await acquireCrossProcessTicketLock(args.lockPath, {
    timeoutMs: 30_000, staleMs: 10 * 60_000,
    timeoutMessage: `pending discuss write lock timeout: ${args.lockPath}`,
    timeoutCode: 'PENDING_DISCUSS_LOCK_TIMEOUT',
  });
  const allItems = flattenPreflightItems(preflight);
  const executed = [];
  const failed = [];
  const uncertain = [];
  let stoppedAt = -1;
  let finalScan = null;
  try {
    for (let index = 0; index < allItems.length; index += 1) {
      const item = allItems[index];
      try {
        const currentSourceHashes = await collectSourceHashes(args);
        const currentGate = verifyPreflightDocument(preflight, {
          businessDate: businessDateShanghai(), now: new Date(), sourceHashes: currentSourceHashes,
          batchHash: args.batchHash,
        });
        const currentSafeWriteGate = verifySafeWriteGate(runtime, preflight);
        currentGate.blockers.push(...currentSafeWriteGate.blockers);
        currentGate.blockers.push(...verifyRealExecutionBoundary(runtime, args).blockers);
        currentGate.ok = currentGate.blockers.length === 0;
        if (!currentGate.ok) throw Object.assign(
          new Error(currentGate.blockers.map(row => `${row.code}:${row.message}`).join('; ')),
          {code: 'PREFLIGHT_DRIFT_BEFORE_ITEM'},
        );
        const identity = await verifyStoreIdentity(runtime, item.storeKey, args);
        const currentQuery = await queryDiscussStatus(runtime, item.storeKey, 1, args, {client: identity.client});
        const matches = currentQuery.rows.filter(row => row.discussSn === item.discussSn);
        if (matches.length !== 1) throw Object.assign(new Error(`${item.storeKey} ${item.discussSn} current pending match count=${matches.length}`), {code: 'CURRENT_OBJECT_MISSING_OR_DUPLICATE'});
        const locked = verifyLockedItem(item, matches[0]);
        if (!locked.ok) throw Object.assign(new Error(locked.blockers.map(row => `${row.code}:${row.message}`).join('; ')), {code: 'CURRENT_OBJECT_DRIFT'});
        let writeResponse;
        try {
          writeResponse = await identity.client.request(PENDING_DISCUSS_PROCESS_ENDPOINT, {
            method: 'POST', body: item.payload, headers: {language: 'CN'},
          });
        } catch (error) {
          uncertain.push({storeKey: item.storeKey, discussSn: item.discussSn, itemHash: item.itemHash, status: 'write_outcome_unknown', error: redactError(error)});
          stoppedAt = index;
          break;
        }
        const info = writeResponse?.data?.info || {};
        const successCount = Number(info.successCount);
        const failCount = Number(info.failCount);
        if (!responseSucceeded(writeResponse) || successCount !== 1 || failCount !== 0) {
          const error = apiResponseError(`${item.storeKey} process discuss`, writeResponse);
          const bucket = responseSucceeded(writeResponse) ? uncertain : failed;
          bucket.push({storeKey: item.storeKey, discussSn: item.discussSn, itemHash: item.itemHash, status: responseSucceeded(writeResponse) ? 'write_ack_ambiguous' : 'write_rejected', error: redactError(error), response: {httpStatus: writeResponse?.status || 0, code: String(writeResponse?.data?.code ?? ''), successCount: Number.isFinite(successCount) ? successCount : null, failCount: Number.isFinite(failCount) ? failCount : null}});
          stoppedAt = index;
          break;
        }
        const terminal = await pollTerminal(runtime, item, identity.client, args);
        if (!terminal.ok) {
          uncertain.push({storeKey: item.storeKey, discussSn: item.discussSn, itemHash: item.itemHash, status: 'submitted_readback_pending', blockers: terminal.blockers, polls: terminal.polls});
          stoppedAt = index;
          break;
        }
        executed.push({storeKey: item.storeKey, discussSn: item.discussSn, itemHash: item.itemHash, action: item.action, terminalStatus: terminal.terminal.discussStatus, terminalPriceProven: item.action === 'accept', polls: terminal.polls});
      } catch (error) {
        failed.push({storeKey: item.storeKey, discussSn: item.discussSn, itemHash: item.itemHash, status: 'stopped_before_write', error: redactError(error)});
        stoppedAt = index;
        break;
      }
    }
  } finally {
    try { finalScan = await runPendingDiscussScan(args, runtime); }
    catch (error) {
      finalScan = {ok: false, businessDate: businessDateShanghai(), rowCount: null, blockers: [{code: 'FINAL_SCAN_FAILED', message: redactError(error).message}], error: redactError(error)};
    }
    await release();
  }
  const completedHashes = new Set(executed.map(row => row.itemHash));
  const failedHashes = new Set([...failed, ...uncertain].map(row => row.itemHash));
  const notAttempted = allItems.filter(item => !completedHashes.has(item.itemHash) && !failedHashes.has(item.itemHash))
    .map(item => ({storeKey: item.storeKey, discussSn: item.discussSn, itemHash: item.itemHash, action: item.action}));
  const remainingTargetKeys = finalScan?.ok
    ? finalScan.rows.filter(row => allItems.some(item => pendingDiscussKey(item.lockedRow) === pendingDiscussKey(row))).map(pendingDiscussKey)
    : [];
  const blockers = [];
  if (failed.length) blockers.push({code: 'BATCH_ITEM_FAILED', message: `${failed.length} item(s) failed`});
  if (uncertain.length) blockers.push({code: 'BATCH_ITEM_UNCERTAIN', message: `${uncertain.length} item(s) lack a proven terminal state`});
  if (notAttempted.length) blockers.push({code: 'BATCH_STOPPED', message: `${notAttempted.length} later item(s) were not attempted`});
  if (!finalScan?.ok) blockers.push({code: 'FINAL_SCAN_INCOMPLETE', message: 'final all-store pending scan is incomplete'});
  if (remainingTargetKeys.length) blockers.push({code: 'TARGET_STILL_PENDING', message: `target keys still pending: ${remainingTargetKeys.join(',')}`});
  const execution = {
    schemaVersion: 'pending-discuss-execution/v1', ok: blockers.length === 0 && executed.length === allItems.length,
    businessDate: preflight.businessDate, startedFromBatchHash: preflight.batchHash,
    endedAt: new Date().toISOString(), targetCount: allItems.length, stoppedAtIndex: stoppedAt,
    executed, failed, uncertain, notAttempted, finalScan: compactScan(finalScan), blockers,
  };
  const executionFile = await writeArtifact(outDir, 'execution.json', execution);
  const finalScanFile = await writeArtifact(outDir, 'final-scan.json', finalScan);
  const manifest = await writeManifest(outDir, 'execute', [executionFile, finalScanFile], {
    businessDate: preflight.businessDate, ok: execution.ok, batchHash: preflight.batchHash,
  });
  return {result: {
    ok: execution.ok, mode: 'execute', businessDate: execution.businessDate, targetCount: execution.targetCount,
    executedCount: executed.length, failedCount: failed.length, uncertainCount: uncertain.length,
    notAttemptedCount: notAttempted.length, finalScan: execution.finalScan, blockers,
    executionFile, finalScanFile, manifestFile: manifest.manifestFile, manifestHash: manifest.manifestHash,
  }, exitCode: execution.ok ? 0 : 3};
}

export async function runCli(args) {
  if (args.command === 'help') return {result: {ok: true, help: help()}, exitCode: 0};
  if (!args.outDir) throw new Error('--out-dir is required');
  const outDir = await prepareOutDir(args.outDir);
  try {
    validateArgs(args);
    if (args.command === 'scan') return await runScanCommand(args, outDir);
    if (args.command === 'preflight') return await runPreflightCommand(args, outDir);
    return await runExecuteCommand(args, outDir);
  } catch (error) {
    const failure = {schemaVersion: 'pending-discuss-error/v1', ok: false, command: args.command, at: new Date().toISOString(), error: redactError(error)};
    const failureFile = await writeArtifact(outDir, 'error.json', failure).catch(() => '');
    const manifest = failureFile ? await writeManifest(outDir, args.command, [failureFile], {ok: false}).catch(() => null) : null;
    return {result: {...failure, failureFile, manifestFile: manifest?.manifestFile || '', manifestHash: manifest?.manifestHash || ''}, exitCode: 3};
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help') {
    console.log(help());
    return;
  }
  const outcome = await runCli(args);
  if (!args.quiet) console.log(JSON.stringify(outcome.result, null, 2));
  process.exitCode = outcome.exitCode;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch(error => {
    console.error(JSON.stringify({ok: false, error: redactError(error)}, null, 2));
    process.exitCode = 3;
  });
}
