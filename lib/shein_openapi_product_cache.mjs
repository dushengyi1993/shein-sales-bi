import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const OPENAPI_PRODUCT_CACHE_ENV = 'SHEIN_OPENAPI_PRODUCT_CACHE_DIR';
export const OPENAPI_PRODUCT_CACHE_MAX_AGE_ENV = 'SHEIN_OPENAPI_PRODUCT_CACHE_MAX_AGE_DAYS';
export const OPENAPI_PRODUCT_CACHE_RELATIVE_DIR = path.join('outputs', 'shein_openapi_products');
export const DEFAULT_OPENAPI_PRODUCT_CACHE_DIR = path.join(MODULE_ROOT, OPENAPI_PRODUCT_CACHE_RELATIVE_DIR);
export const OPENAPI_PRODUCT_CACHE_SCHEMA_VERSION = 'shein-openapi-product-basics/v1';
export const OPENAPI_PRODUCT_CACHE_METADATA_SCHEMA_VERSION = 'shein-openapi-product-cache-metadata/v1';
export const OPENAPI_PRODUCT_CACHE_HASH_ALGORITHM = 'sha256-stable-json-v1';
export const DEFAULT_OPENAPI_PRODUCT_CACHE_MAX_AGE_MS = 21 * 24 * 60 * 60 * 1000;

// Keep one-character fixture keys usable in local deterministic tests while
// still rejecting separators and traversal input. Production store validation
// remains owned by each business workflow.
const STORE_KEY_RE = /^[A-Z0-9]{1,8}$/;
const SHA256_RE = /^[a-f0-9]{64}$/i;

function text(value) {
  return String(value ?? '').trim();
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

export function sha256StableJson(value) {
  return crypto.createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

export function normalizeOpenApiProductStoreKey(value) {
  const storeKey = text(value).toUpperCase();
  if (!STORE_KEY_RE.test(storeKey)) {
    throw new Error(`Invalid OpenAPI product cache store key: ${text(value) || '(empty)'}`);
  }
  return storeKey;
}

function resolveRoot(rootDir = MODULE_ROOT) {
  return path.resolve(text(rootDir) || MODULE_ROOT);
}

export function resolveOpenApiProductCacheDir({env = process.env, rootDir = MODULE_ROOT, cacheDir = ''} = {}) {
  const root = resolveRoot(rootDir);
  const explicitCacheDir = text(cacheDir);
  if (explicitCacheDir) return path.resolve(root, explicitCacheDir);
  const configured = text(env?.[OPENAPI_PRODUCT_CACHE_ENV]);
  return path.resolve(root, configured || OPENAPI_PRODUCT_CACHE_RELATIVE_DIR);
}

export function resolveOpenApiProductCacheStoreDir(storeKey, options = {}) {
  return path.join(
    resolveOpenApiProductCacheDir(options),
    normalizeOpenApiProductStoreKey(storeKey),
  );
}

export function resolveOpenApiProductCacheFile(storeKey, {fileName = 'latest.json', ...options} = {}) {
  const name = text(fileName);
  if (!name || name !== path.basename(name) || name === '.' || name === '..') {
    throw new Error(`Invalid OpenAPI product cache file name: ${name || '(empty)'}`);
  }
  return path.join(resolveOpenApiProductCacheStoreDir(storeKey, options), name);
}

function cachePayloadWithoutMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const clone = {...value};
  delete clone.cacheMetadata;
  return clone;
}

function parseInstant(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : null;
}

function maxAgeMsFromOptions({maxAgeMs, env = process.env} = {}) {
  if (Number.isFinite(Number(maxAgeMs)) && Number(maxAgeMs) >= 0) return Number(maxAgeMs);
  const days = Number(env?.[OPENAPI_PRODUCT_CACHE_MAX_AGE_ENV]);
  if (Number.isFinite(days) && days >= 0) return days * 24 * 60 * 60 * 1000;
  return DEFAULT_OPENAPI_PRODUCT_CACHE_MAX_AGE_MS;
}

export class OpenApiProductCacheError extends Error {
  constructor(message, {code = 'OPENAPI_PRODUCT_CACHE_INVALID', details = {}} = {}) {
    super(message);
    this.name = 'OpenApiProductCacheError';
    this.code = code;
    this.details = details;
  }
}

function invalidCache(message, code, details = {}) {
  return new OpenApiProductCacheError(message, {code, details});
}

export function buildOpenApiProductCacheDocument(payload, {storeKey, generatedAt = ''} = {}) {
  const normalizedStore = normalizeOpenApiProductStoreKey(storeKey || payload?.storeKey);
  const source = cachePayloadWithoutMetadata(payload || {});
  const sourceStore = text(source.storeKey).toUpperCase();
  if (sourceStore && sourceStore !== normalizedStore) {
    throw invalidCache(
      `OpenAPI product cache store mismatch: payload=${sourceStore} expected=${normalizedStore}`,
      'OPENAPI_PRODUCT_CACHE_STORE_MISMATCH',
    );
  }
  const stamp = text(generatedAt || source.generatedAt || source.fetchedAt);
  if (!parseInstant(stamp)) {
    throw invalidCache('OpenAPI product cache requires a valid generatedAt/fetchedAt timestamp', 'OPENAPI_PRODUCT_CACHE_TIMESTAMP_MISSING');
  }
  const normalized = {
    ...source,
    schemaVersion: OPENAPI_PRODUCT_CACHE_SCHEMA_VERSION,
    ok: source.ok !== false,
    storeKey: normalizedStore,
    generatedAt: stamp,
    fetchedAt: text(source.fetchedAt || stamp),
  };
  const hash = sha256StableJson(normalized);
  return {
    ...normalized,
    cacheMetadata: {
      schemaVersion: OPENAPI_PRODUCT_CACHE_METADATA_SCHEMA_VERSION,
      storeKey: normalizedStore,
      generatedAt: stamp,
      hashAlgorithm: OPENAPI_PRODUCT_CACHE_HASH_ALGORITHM,
      hash,
    },
  };
}

async function syncDirectory(directory) {
  // Linux can persist the directory entry after rename. Windows does not
  // support opening a directory for fsync in the same way; the best portable
  // behaviour is to attempt it and ignore only that platform limitation.
  let handle = null;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch {
    // The file itself was already fsync'd; directory fsync is best effort on
    // platforms that reject opening directories.
  } finally {
    try { await handle?.close(); } catch {}
  }
}

export async function writeOpenApiProductCacheAtomically(file, payload, {storeKey, generatedAt = ''} = {}) {
  const target = path.resolve(file);
  const directory = path.dirname(target);
  await fs.mkdir(directory, {recursive: true});
  const document = buildOpenApiProductCacheDocument(payload, {storeKey, generatedAt});
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  let handle = null;
  try {
    handle = await fs.open(temporary, 'wx', 0o640);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    // Same-directory rename is the atomic publication boundary on both
    // Windows and Linux. Do not delete the destination before this call.
    await fs.rename(temporary, target);
    await syncDirectory(directory);
    return {file: target, hash: document.cacheMetadata.hash, metadata: document.cacheMetadata};
  } catch (error) {
    try { await handle?.close(); } catch {}
    try { await fs.rm(temporary, {force: true}); } catch {}
    throw error;
  }
}

function validateCacheShape(data, expectedStore) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw invalidCache('OpenAPI product cache root must be an object', 'OPENAPI_PRODUCT_CACHE_SCHEMA_INVALID');
  }
  if (data.schemaVersion !== OPENAPI_PRODUCT_CACHE_SCHEMA_VERSION) {
    throw invalidCache(`Unsupported OpenAPI product cache schemaVersion: ${text(data.schemaVersion) || '(missing)'}`, 'OPENAPI_PRODUCT_CACHE_SCHEMA_INVALID');
  }
  if (data.ok !== true) {
    throw invalidCache('OpenAPI product cache is not marked ok=true', 'OPENAPI_PRODUCT_CACHE_NOT_OK');
  }
  const store = normalizeOpenApiProductStoreKey(data.storeKey);
  if (expectedStore && store !== normalizeOpenApiProductStoreKey(expectedStore)) {
    throw invalidCache(`OpenAPI product cache store mismatch: cache=${store} expected=${expectedStore}`, 'OPENAPI_PRODUCT_CACHE_STORE_MISMATCH');
  }
  if (!Array.isArray(data.normalizedRows) || !Array.isArray(data.detailResults) || !Array.isArray(data.detailFallbackResults)) {
    throw invalidCache('OpenAPI product cache has an incomplete normalizedRows/detailResults/detailFallbackResults shape', 'OPENAPI_PRODUCT_CACHE_SCHEMA_INVALID');
  }
  const metadata = data.cacheMetadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw invalidCache('OpenAPI product cache is missing cacheMetadata', 'OPENAPI_PRODUCT_CACHE_METADATA_MISSING');
  }
  if (metadata.schemaVersion !== OPENAPI_PRODUCT_CACHE_METADATA_SCHEMA_VERSION) {
    throw invalidCache('OpenAPI product cache metadata schema is invalid', 'OPENAPI_PRODUCT_CACHE_SCHEMA_INVALID');
  }
  if (text(metadata.storeKey).toUpperCase() !== store) {
    throw invalidCache('OpenAPI product cache metadata store does not match the cache store', 'OPENAPI_PRODUCT_CACHE_STORE_MISMATCH');
  }
  if (metadata.hashAlgorithm !== OPENAPI_PRODUCT_CACHE_HASH_ALGORITHM || !SHA256_RE.test(text(metadata.hash))) {
    throw invalidCache('OpenAPI product cache metadata hash is missing or unsupported', 'OPENAPI_PRODUCT_CACHE_HASH_INVALID');
  }
  const generatedAt = text(metadata.generatedAt || data.generatedAt || data.fetchedAt);
  if (!parseInstant(generatedAt)) {
    throw invalidCache('OpenAPI product cache generatedAt is invalid', 'OPENAPI_PRODUCT_CACHE_TIMESTAMP_INVALID');
  }
  const actualHash = sha256StableJson(cachePayloadWithoutMetadata(data));
  if (actualHash !== text(metadata.hash).toLowerCase()) {
    throw invalidCache(`OpenAPI product cache hash mismatch: declared=${metadata.hash} actual=${actualHash}`, 'OPENAPI_PRODUCT_CACHE_HASH_MISMATCH', {declared: metadata.hash, actual: actualHash});
  }
  return {store, metadata, generatedAt, actualHash};
}

export async function readOpenApiProductCache(file, {
  expectedStore = '',
  env = process.env,
  maxAgeMs,
  now = new Date(),
} = {}) {
  let data;
  try {
    data = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    throw invalidCache(`Unable to read OpenAPI product cache ${file}: ${error?.message || String(error)}`, 'OPENAPI_PRODUCT_CACHE_READ_FAILED');
  }
  return validateOpenApiProductCacheData(data, {file, expectedStore, env, maxAgeMs, now});
}

export function validateOpenApiProductCacheData(data, {
  file = '',
  expectedStore = '',
  env = process.env,
  maxAgeMs,
  now = new Date(),
} = {}) {
  const validated = validateCacheShape(data, expectedStore);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now || ''));
  const generatedMs = parseInstant(validated.generatedAt);
  if (!Number.isFinite(nowMs) || generatedMs === null) {
    throw invalidCache('OpenAPI product cache freshness timestamp is invalid', 'OPENAPI_PRODUCT_CACHE_TIMESTAMP_INVALID');
  }
  const ageMs = nowMs - generatedMs;
  const allowedAgeMs = maxAgeMsFromOptions({maxAgeMs, env});
  if (ageMs < -5 * 60 * 1000) {
    throw invalidCache('OpenAPI product cache generatedAt is in the future', 'OPENAPI_PRODUCT_CACHE_TIMESTAMP_INVALID', {generatedAt: validated.generatedAt});
  }
  if (ageMs > allowedAgeMs) {
    throw invalidCache(`OpenAPI product cache is stale: ageMs=${ageMs} maxAgeMs=${allowedAgeMs}`, 'OPENAPI_PRODUCT_CACHE_STALE', {generatedAt: validated.generatedAt, ageMs, maxAgeMs: allowedAgeMs});
  }
  return {
    file,
    data,
    storeKey: validated.store,
    metadata: validated.metadata,
    generatedAt: validated.generatedAt,
    hash: validated.actualHash,
    ageMs,
    maxAgeMs: allowedAgeMs,
  };
}
