#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import pathModule from 'node:path';
import {
  assertInventoryWriteAllowed,
  discoverInventoryJournalFiles,
  readInventoryIntentJournals,
} from './durable_inventory_write.mjs';
import {stableInventoryHash} from './inventory_replenishment_policy.mjs';
import {
  inventoryCutoverLockFile,
  requireCurrentInventoryCutoverActivation,
  withInventoryCutoverLock,
} from './inventory_write_cutover.mjs';

export const SHEIN_OPENAPI_BASE_URLS = Object.freeze({
  test: 'https://openapi-test01.sheincorp.cn',
  prodSemiManaged: 'https://openapi.sheincorp.com',
});

export const SHEIN_OPENAPI_AUTH_HOSTS = Object.freeze({
  test: 'openapi-sem-test01.dotfashion.cn',
  prod: 'openapi-sem.sheincorp.com',
});

export const SHEIN_OPENAPI_REAL_HOSTS = Object.freeze([
  'openapi.sheincorp.com',
  'openapi-test01.sheincorp.cn',
  'openapi-sem.sheincorp.com',
  'openapi-sem-test01.dotfashion.cn',
]);
const SHEIN_OPENAPI_REAL_HOST_SUFFIXES = Object.freeze([
  '.sheincorp.com',
  '.sheincorp.cn',
  '.dotfashion.cn',
]);

export const CONTENT_TYPE = 'application/json;charset=UTF-8';
export const DEFAULT_AES_IV_SEED = 'space-station-default-iv';
const RANDOM_KEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const DEFAULT_INVENTORY_JOURNAL_DIRECTORIES = Object.freeze([
  '/srv/shein-bi/runtime/daily-inventory-replenishment/results',
  '/srv/shein-bi/runtime/daily-inventory-replenishment/runs',
  '/srv/shein-bi/runtime/et-low-inventory-guard/results',
]);

export function normalizeApiPath(path) {
  if (!path || typeof path !== 'string') throw new Error('API path is required');
  if (/^https?:\/\//i.test(path)) {
    const u = new URL(path);
    return u.pathname;
  }
  return path.startsWith('/') ? path : `/${path}`;
}

export function createRandomKey(length = 5) {
  let out = '';
  const bytes = crypto.randomBytes(length);
  for (const b of bytes) out += RANDOM_KEY_ALPHABET[b % RANDOM_KEY_ALPHABET.length];
  return out;
}

export function nowTimestampMs() {
  return String(Date.now());
}

export function hmacSha256Hex(value, key) {
  return crypto.createHmac('sha256', Buffer.from(key, 'utf8')).update(String(value), 'utf8').digest('hex');
}

export function generateSheinSignature({openKeyId, secretKey, path, timestamp = nowTimestampMs(), randomKey = createRandomKey()}) {
  if (!openKeyId) throw new Error('openKeyId is required');
  if (!secretKey) throw new Error('secretKey is required');
  const apiPath = normalizeApiPath(path);
  const ts = String(timestamp);
  const rk = String(randomKey);
  if (rk.length !== 5) throw new Error('randomKey must be exactly 5 characters');
  const value = `${openKeyId}&${ts}&${apiPath}`;
  const key = `${secretKey}${rk}`;
  const hex = hmacSha256Hex(value, key);
  const base64 = Buffer.from(hex, 'utf8').toString('base64');
  return {
    signature: `${rk}${base64}`,
    hex,
    base64,
    value,
    key,
    path: apiPath,
    timestamp: ts,
    randomKey: rk,
  };
}

export function buildSignedHeaders({openKeyId, secretKey, path, timestamp = nowTimestampMs(), randomKey = createRandomKey()}) {
  const signed = generateSheinSignature({openKeyId, secretKey, path, timestamp, randomKey});
  return {
    headers: {
      'Content-Type': CONTENT_TYPE,
      'x-lt-openKeyId': String(openKeyId),
      'x-lt-timestamp': signed.timestamp,
      'x-lt-signature': signed.signature,
    },
    signed,
  };
}

export function buildGetByTokenHeaders({appId, appSecretKey, timestamp = nowTimestampMs(), randomKey = createRandomKey()}) {
  const path = '/open-api/auth/get-by-token';
  const signed = generateSheinSignature({openKeyId: appId, secretKey: appSecretKey, path, timestamp, randomKey});
  return {
    headers: {
      'Content-Type': CONTENT_TYPE,
      'x-lt-appid': String(appId),
      'x-lt-timestamp': signed.timestamp,
      'x-lt-signature': signed.signature,
    },
    signed,
  };
}

function aesKeyFromAppSecret(appSecretKey) {
  const buf = Buffer.alloc(16);
  Buffer.from(String(appSecretKey), 'utf8').copy(buf, 0, 0, 16);
  return buf;
}

function aesIvFromSeed(ivSeed = DEFAULT_AES_IV_SEED) {
  const ivBytes = Buffer.from(String(ivSeed), 'utf8');
  if (ivBytes.length < 16) throw new Error('ivSeed must be at least 16 bytes');
  return ivBytes.subarray(0, 16);
}

export function decryptSheinSecretKey(encryptedSecretKey, appSecretKey, {ivSeed = DEFAULT_AES_IV_SEED} = {}) {
  if (!encryptedSecretKey) throw new Error('encryptedSecretKey is required');
  if (!appSecretKey) throw new Error('appSecretKey is required');
  const decipher = crypto.createDecipheriv('aes-128-cbc', aesKeyFromAppSecret(appSecretKey), aesIvFromSeed(ivSeed));
  decipher.setAutoPadding(true);
  return Buffer.concat([
    decipher.update(Buffer.from(String(encryptedSecretKey), 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export function encryptSheinSecretKeyForTest(plainSecretKey, appSecretKey, {ivSeed = DEFAULT_AES_IV_SEED} = {}) {
  const cipher = crypto.createCipheriv('aes-128-cbc', aesKeyFromAppSecret(appSecretKey), aesIvFromSeed(ivSeed));
  cipher.setAutoPadding(true);
  return Buffer.concat([
    cipher.update(String(plainSecretKey), 'utf8'),
    cipher.final(),
  ]).toString('base64');
}

export function buildAuthorizationUrl({appId, redirectUrl, state, env = 'prod', authHost}) {
  if (!appId) throw new Error('appId is required');
  if (!redirectUrl) throw new Error('redirectUrl is required');
  const host = authHost || SHEIN_OPENAPI_AUTH_HOSTS[env];
  if (!host) throw new Error(`Unknown auth env: ${env}`);
  const encodedRedirect = Buffer.from(String(redirectUrl), 'utf8').toString('base64');
  const params = new URLSearchParams();
  params.set('appid', String(appId));
  params.set('redirectUrl', encodedRedirect);
  if (state) params.set('state', String(state));
  return `https://${host}/#/empower?${params.toString()}`;
}

function appendQuery(url, query) {
  if (!query || Object.keys(query).length === 0) return url;
  const u = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const v of value) u.searchParams.append(key, String(v));
    } else {
      u.searchParams.set(key, String(value));
    }
  }
  return u.toString();
}

export function isRealSheinOpenApiBaseUrl(baseUrl) {
  let host = '';
  try {
    host = new URL(String(baseUrl || '')).hostname.toLowerCase();
  } catch {
    return false;
  }
  return SHEIN_OPENAPI_REAL_HOSTS.includes(host)
    || SHEIN_OPENAPI_REAL_HOST_SUFFIXES.some(suffix => host.endsWith(suffix));
}

export function assertRealOpenApiAllowedForRuntime(baseUrl, {platform = process.platform} = {}) {
  if (String(platform || '').toLowerCase() !== 'win32') return;
  if (!isRealSheinOpenApiBaseUrl(baseUrl)) return;
  throw new Error(
    'Local Windows/Codex cannot call real SHEIN OpenAPI because this machine is outside the whitelist boundary. '
    + 'Use the shein-bi-tencent cloud executor for real upload/submit/readback, or point tests at a fake OpenAPI server.'
  );
}

const TRANSIENT_NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
]);

/**
 * Classifies only transport-level fetch failures (the 2026-08-12 undici
 * `TypeError: fetch failed` incident class). Any received HTTP response --
 * including business code != 0 -- is never classified as transient here, so
 * read-only retry can never swallow or mask a business error.
 */
export function isTransientFetchTransportError(error) {
  if (!error || typeof error !== 'object') return false;
  const message = String(error.message || '');
  if (error instanceof TypeError && /fetch failed/i.test(message)) return true;
  const cause = error?.cause;
  if (cause && typeof cause === 'object') {
    const code = String(cause.code || '');
    if (TRANSIENT_NETWORK_ERROR_CODES.has(code)) return true;
    if (/^UND_ERR_[A-Z0-9_]+$/.test(code)) return true;
    if (/fetch failed|socket hang up|connection reset|network|undici/i.test(String(cause.message || ''))) return true;
  }
  return false;
}

function isFormDataBody(value) {
  return typeof FormData !== 'undefined' && value instanceof FormData;
}

function removeHeaderCaseInsensitive(headers, name) {
  const target = String(name || '').toLowerCase();
  for (const key of Object.keys(headers || {})) {
    if (String(key).toLowerCase() === target) delete headers[key];
  }
}

export class SheinOpenApiClient {
  constructor({
    baseUrl = SHEIN_OPENAPI_BASE_URLS.test,
    openKeyId,
    secretKey,
    fetchImpl = globalThis.fetch,
    timeoutMs = Number(process.env.SHEIN_OPENAPI_REQUEST_TIMEOUT_MS || 0),
    inventoryStoreKey = '',
    inventoryJournalFile = '',
    inventoryJournalFiles = null,
    inventoryJournalDirectories = [],
    inventoryFenceReader = null,
    inventoryCutoverReader = null,
    inventoryCutoverAuthorityReader = null,
    inventoryCutoverActivationFile = '',
    inventoryCutoverActivationReceiptFile = '',
    inventoryCutoverLock = '',
  } = {}) {
    if (!fetchImpl) throw new Error('fetch is not available in this Node runtime');
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.openKeyId = openKeyId;
    this.secretKey = secretKey;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = Number.isFinite(Number(timeoutMs)) ? Math.max(0, Number(timeoutMs)) : 0;
    this.inventoryStoreKey = String(inventoryStoreKey || '').trim().toUpperCase();
    this.inventoryJournalFile = String(inventoryJournalFile || '').trim();
    this.inventoryJournalFiles = Array.isArray(inventoryJournalFiles)
      ? inventoryJournalFiles.map(file => String(file || '').trim()).filter(Boolean).map(file => pathModule.resolve(file))
      : null;
    this.inventoryJournalDirectories = Array.isArray(inventoryJournalDirectories)
      ? inventoryJournalDirectories.map(directory => String(directory || '').trim()).filter(Boolean)
      : [];
    this.inventoryFenceReader = typeof inventoryFenceReader === 'function' ? inventoryFenceReader : null;
    this.inventoryCutoverReader = typeof inventoryCutoverReader === 'function' ? inventoryCutoverReader : null;
    this.inventoryCutoverAuthorityReader = typeof inventoryCutoverAuthorityReader === 'function'
      ? inventoryCutoverAuthorityReader
      : null;
    this.inventoryCutoverActivationFile = String(inventoryCutoverActivationFile || '').trim();
    this.inventoryCutoverActivationReceiptFile = String(inventoryCutoverActivationReceiptFile || '').trim();
    this.inventoryCutoverLock = pathModule.resolve(inventoryCutoverLock || inventoryCutoverLockFile());
    // There is deliberately no caller-controlled disable switch. Every
    // change-inventory/v2 request passes through the same reader-first fence;
    // tests use an empty/injected journal domain rather than bypassing it.
  }

  inventoryJournalDomainDirectories() {
    return [...new Set(this.inventoryJournalDirectories
      .concat((this.inventoryJournalFiles || []).map(file => pathModule.dirname(file)))
      .concat(this.inventoryJournalFile ? [pathModule.dirname(pathModule.resolve(this.inventoryJournalFile))] : [])
      .concat(String(process.env.SHEIN_BI_INVENTORY_JOURNAL_DIRS || '')
        .split(pathModule.delimiter)
        .map(directory => directory.trim())
        .filter(Boolean))
      .concat([
        process.env.SHEIN_BI_INVENTORY_RUNTIME_ROOT,
        process.env.SHEIN_BI_ET_INVENTORY_RUNTIME_ROOT,
        process.env.SHEIN_BI_ET_LOW_INVENTORY_RUNTIME_ROOT,
      ].filter(Boolean).flatMap(directory => [pathModule.join(directory, 'results'), pathModule.join(directory, 'runs')]))
      .concat(DEFAULT_INVENTORY_JOURNAL_DIRECTORIES)
      .map(directory => pathModule.resolve(directory)))];
  }

  async readInventoryCutoverState(inventoryScope) {
    if (this.inventoryCutoverReader) return await this.inventoryCutoverReader({scope: inventoryScope});
    return requireCurrentInventoryCutoverActivation({
      ...(this.inventoryCutoverActivationFile ? {activationFile: this.inventoryCutoverActivationFile} : {}),
      ...(this.inventoryCutoverActivationReceiptFile
        ? {activationReceiptFile: this.inventoryCutoverActivationReceiptFile}
        : {}),
      ...(this.inventoryCutoverAuthorityReader ? {authorityReader: this.inventoryCutoverAuthorityReader} : {}),
    });
  }

  async readInventoryFenceDomain(inventoryScope, cutover) {
    if (this.inventoryFenceReader) {
      const injected = await this.inventoryFenceReader({scope: inventoryScope, cutover});
      if (injected && typeof injected === 'object' && Object.prototype.hasOwnProperty.call(injected, 'bundle')) {
        if (cutover?.activated && (!Array.isArray(injected.files) || injected.files.length === 0)) {
          const error = new Error('INVENTORY_WRITE_FENCE_DOMAIN_EMPTY:activated journal domain has no readable journal files');
          error.code = 'INVENTORY_WRITE_FENCE_DOMAIN_EMPTY';
          throw error;
        }
        return injected;
      }
      return {bundle: injected, files: Array.isArray(injected?.journalFiles) ? injected.journalFiles : []};
    }
    const directories = this.inventoryJournalDomainDirectories();
    const seeds = [...new Set([
      ...(this.inventoryJournalFiles || []),
      ...(this.inventoryJournalFile ? [pathModule.resolve(this.inventoryJournalFile)] : []),
    ])];
    const current = seeds[0] || pathModule.join(directories[0], 'inventory-fence-reader.journal.ndjson');
    let files;
    try {
      files = await discoverInventoryJournalFiles(current, {
        includeAll: true,
        additionalDirectories: directories,
      });
    } catch (error) {
      const wrapped = new Error(`INVENTORY_WRITE_FENCE_DOMAIN_UNAVAILABLE:${error?.code || error?.message || error}`);
      wrapped.code = 'INVENTORY_WRITE_FENCE_DOMAIN_UNAVAILABLE';
      throw wrapped;
    }
    for (const seed of seeds) {
      if (!files.includes(seed)) {
        const stat = await fs.lstat(seed).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
        if (stat?.isFile()) files.push(seed);
      }
    }
    files = [...new Set(files.map(file => pathModule.resolve(file)))].sort();
    if (cutover?.activated && files.length === 0) {
      const error = new Error('INVENTORY_WRITE_FENCE_DOMAIN_EMPTY:activated journal domain has no readable journal files');
      error.code = 'INVENTORY_WRITE_FENCE_DOMAIN_EMPTY';
      throw error;
    }
    let bundle;
    try {
      bundle = files.length
        ? await readInventoryIntentJournals(files, {allowMultiplePendingByScope: true})
        : null;
    } catch (error) {
      const wrapped = new Error(`INVENTORY_WRITE_FENCE_DOMAIN_INVALID:${error?.message || error}`);
      wrapped.code = 'INVENTORY_WRITE_FENCE_DOMAIN_INVALID';
      throw wrapped;
    }
    return {bundle, files};
  }

  async assertActivatedManualResolution(cutover, domain) {
    if (!cutover?.activated) return;
    const required = cutover.activation?.requiredManualResolution;
    const files = domain?.files || [];
    if (!required || !files.includes(pathModule.resolve(required.journalFile))) {
      const error = new Error('INVENTORY_WRITE_FENCE_REQUIRED_JOURNAL_MISSING:activated target journal is absent from full domain');
      error.code = 'INVENTORY_WRITE_FENCE_REQUIRED_JOURNAL_MISSING';
      throw error;
    }
    const event = [...(domain.bundle?.manualResolutions?.values?.() || [])]
      .find(row => row?.intentId === required.intentId && row?.scope?.scopeKey === required.scopeKey);
    if (!event) {
      const error = new Error('INVENTORY_WRITE_FENCE_REQUIRED_EVENT_MISSING:activated target manual-resolution fence is absent');
      error.code = 'INVENTORY_WRITE_FENCE_REQUIRED_EVENT_MISSING';
      throw error;
    }
    let receipt;
    try {
      receipt = JSON.parse(await fs.readFile(pathModule.resolve(required.receiptFile), 'utf8'));
    } catch (cause) {
      const error = new Error(`INVENTORY_WRITE_FENCE_REQUIRED_RECEIPT_MISSING:${cause?.code || cause?.message || cause}`);
      error.code = 'INVENTORY_WRITE_FENCE_REQUIRED_RECEIPT_MISSING';
      throw error;
    }
    const {receiptHash, ...receiptCore} = receipt || {};
    if (receipt?.schemaVersion !== 'inventory-manual-resolution-receipt/v1'
      || receipt?.kind !== 'manual_resolution_receipt'
      || receipt?.intentId !== required.intentId
      || receipt?.scopeKey !== required.scopeKey
      || receipt?.eventHash !== stableInventoryHash(event)
      || receipt?.sideEffects?.sheinPostCount !== 0
      || receipt?.sideEffects?.historicalLinesModified !== 0
      || receiptHash !== stableInventoryHash(receiptCore)) {
      const error = new Error('INVENTORY_WRITE_FENCE_REQUIRED_RECEIPT_INVALID:manual-resolution receipt binding failed');
      error.code = 'INVENTORY_WRITE_FENCE_REQUIRED_RECEIPT_INVALID';
      throw error;
    }
  }

  async assertInventoryFence(path, method, body, headers, inventoryScope) {
    if (String(method || 'POST').toUpperCase() !== 'POST'
      || path !== '/open-api/stock/change-inventory/v2') return;
    let requestBody = body;
    if (typeof requestBody === 'string') {
      try {
        requestBody = JSON.parse(requestBody);
      } catch {
        const error = new Error('INVENTORY_WRITE_FENCE_REQUEST_INVALID:invalid-json-body');
        error.code = 'INVENTORY_WRITE_FENCE_REQUEST_INVALID';
        throw error;
      }
    }
    const requests = requestBody?.updateSkuInventoryQuantityRequests;
    if (!Array.isArray(requests) || !requests.length) {
      const error = new Error('INVENTORY_WRITE_FENCE_REQUEST_INVALID:missing-updateSkuInventoryQuantityRequests');
      error.code = 'INVENTORY_WRITE_FENCE_REQUEST_INVALID';
      throw error;
    }
    const declaredStoreKey = String(inventoryScope?.storeKey || '').trim().toUpperCase();
    if (!this.inventoryStoreKey || (declaredStoreKey && declaredStoreKey !== this.inventoryStoreKey)) {
      const error = new Error('INVENTORY_WRITE_FENCE_STORE_IDENTITY_MISMATCH:request scope is not bound to the client store identity');
      error.code = 'INVENTORY_WRITE_FENCE_STORE_IDENTITY_MISMATCH';
      throw error;
    }
    const actualRequestPayloadHash = stableInventoryHash({
      pathname: path,
      method: String(method || 'POST').toUpperCase(),
      body: requestBody,
      headers: headers && typeof headers === 'object' && !Array.isArray(headers) ? headers : {},
    });
    const claimedRequestPayloadHash = String(inventoryScope?.requestPayloadHash || '').trim();
    if (claimedRequestPayloadHash && claimedRequestPayloadHash !== actualRequestPayloadHash) {
      const error = new Error('INVENTORY_WRITE_FENCE_REQUEST_HASH_MISMATCH:actual request does not match the durable intent binding');
      error.code = 'INVENTORY_WRITE_FENCE_REQUEST_HASH_MISMATCH';
      throw error;
    }
    const cutover = await this.readInventoryCutoverState(inventoryScope);
    const domain = await this.readInventoryFenceDomain(inventoryScope, cutover);
    await this.assertActivatedManualResolution(cutover, domain);
    const bundle = domain.bundle;
    // Before reader-first activation, a legacy producer may still run with no
    // durable domain. Once activation exists, empty/missing/unreadable state
    // has already failed above and can never be interpreted as a disable.
    if (!bundle && !cutover?.activated) return;
    if (!bundle) {
      const error = new Error('INVENTORY_WRITE_FENCE_UNAVAILABLE:durable inventory journal aggregate is unavailable');
      error.code = 'INVENTORY_WRITE_FENCE_UNAVAILABLE';
      throw error;
    }
    for (const request of requests) {
      if (!request || typeof request !== 'object' || Array.isArray(request)
        || !String(request.idempotencyKey || '').trim()
        || !String(request.skuCode || '').trim()
        || String(request.invType || '').trim().toUpperCase() !== 'VI') {
        const error = new Error('INVENTORY_WRITE_FENCE_REQUEST_INVALID:each request requires idempotencyKey, skuCode and invType=VI');
        error.code = 'INVENTORY_WRITE_FENCE_REQUEST_INVALID';
        throw error;
      }
      const scope = {
        ...(inventoryScope && typeof inventoryScope === 'object' ? inventoryScope : {}),
        storeKey: this.inventoryStoreKey,
        skuCode: request?.skuCode,
        warehouseCode: request?.warehouseCode || inventoryScope?.warehouseCode || '',
        invType: request?.invType || inventoryScope?.invType || 'VI',
      };
      assertInventoryWriteAllowed(bundle, {
        scope,
        idempotencyKey: request?.idempotencyKey,
        requestPayloadHash: actualRequestPayloadHash,
        intentId: inventoryScope?.intentId || '',
        logicalActionKey: inventoryScope?.logicalActionKey || '',
      });
    }
  }

  buildUrl(path, query) {
    const apiPath = normalizeApiPath(path);
    return appendQuery(`${this.baseUrl}${apiPath}`, query);
  }

  async request(path, {
    method = 'POST',
    query,
    body,
    openKeyId = this.openKeyId,
    secretKey = this.secretKey,
    timestamp,
    randomKey,
    headers = {},
    timeoutMs = this.timeoutMs,
    inventoryScope,
  } = {}) {
    assertRealOpenApiAllowedForRuntime(this.baseUrl);
    const apiPath = normalizeApiPath(path);
    const isInventoryWrite = String(method || 'POST').toUpperCase() === 'POST'
      && apiPath === '/open-api/stock/change-inventory/v2';
    if (isInventoryWrite) {
      let bodySnapshot;
      let headersSnapshot;
      let inventoryScopeSnapshot;
      try {
        bodySnapshot = JSON.parse(JSON.stringify(body));
        headersSnapshot = JSON.parse(JSON.stringify(headers || {}));
        inventoryScopeSnapshot = inventoryScope && typeof inventoryScope === 'object'
          ? JSON.parse(JSON.stringify(inventoryScope))
          : {};
      } catch (cause) {
        const error = new Error(`INVENTORY_WRITE_FENCE_REQUEST_INVALID:request boundary snapshot failed:${cause?.message || cause}`);
        error.code = 'INVENTORY_WRITE_FENCE_REQUEST_INVALID';
        throw error;
      }
      if (openKeyId !== this.openKeyId || secretKey !== this.secretKey) {
        const error = new Error('INVENTORY_WRITE_FENCE_CREDENTIAL_OVERRIDE_FORBIDDEN:inventory writes must use the client-bound store credentials');
        error.code = 'INVENTORY_WRITE_FENCE_CREDENTIAL_OVERRIDE_FORBIDDEN';
        throw error;
      }
      const forbiddenCredentialHeader = Object.keys(headersSnapshot).find(key => [
        'x-lt-openkeyid', 'x-lt-timestamp', 'x-lt-signature',
      ].includes(String(key).toLowerCase()));
      if (forbiddenCredentialHeader) {
        const error = new Error('INVENTORY_WRITE_FENCE_CREDENTIAL_HEADER_FORBIDDEN:inventory writes cannot override signed credential headers');
        error.code = 'INVENTORY_WRITE_FENCE_CREDENTIAL_HEADER_FORBIDDEN';
        throw error;
      }
      return withInventoryCutoverLock(async () => {
        await this.assertInventoryFence(apiPath, method, bodySnapshot, headersSnapshot, inventoryScopeSnapshot);
        return this.#requestUnlocked(apiPath, {
          method,
          query,
          body: bodySnapshot,
          openKeyId,
          secretKey,
          timestamp,
          randomKey,
          headers: headersSnapshot,
          timeoutMs,
        });
      }, {lockFile: this.inventoryCutoverLock});
    }
    return this.#requestUnlocked(apiPath, {method, query, body, openKeyId, secretKey, timestamp, randomKey, headers, timeoutMs});
  }

  async #requestUnlocked(apiPath, {
    method = 'POST',
    query,
    body,
    openKeyId = this.openKeyId,
    secretKey = this.secretKey,
    timestamp,
    randomKey,
    headers = {},
    timeoutMs = this.timeoutMs,
  } = {}) {
    const {headers: signedHeaders, signed} = buildSignedHeaders({openKeyId, secretKey, path: apiPath, timestamp, randomKey});
    const init = {
      method: String(method).toUpperCase(),
      headers: {...signedHeaders, ...headers},
    };
    if (body !== undefined && init.method !== 'GET') {
      if (isFormDataBody(body)) {
        removeHeaderCaseInsensitive(init.headers, 'content-type');
        init.body = body;
      } else {
        init.body = typeof body === 'string' ? body : JSON.stringify(body);
      }
    }
    const effectiveTimeoutMs = Number.isFinite(Number(timeoutMs)) ? Math.max(0, Number(timeoutMs)) : 0;
    const controller = effectiveTimeoutMs > 0 ? new AbortController() : null;
    const timeout = controller
      ? setTimeout(() => controller.abort(), effectiveTimeoutMs)
      : null;
    if (controller) init.signal = controller.signal;

    let response;
    let text = '';
    try {
      response = await this.fetchImpl(this.buildUrl(apiPath, query), init);
      // Keep the abort timer active until the response body is consumed. A
      // server can send headers and then stall forever while streaming JSON;
      // clearing the timer immediately after fetch() would not protect that
      // phase of the request.
      text = await response.text();
    } catch (error) {
      if (controller?.signal.aborted) {
        throw new Error(`SHEIN OpenAPI request timed out after ${effectiveTimeoutMs}ms: ${apiPath}`, {cause: error});
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    let data = null;
    if (text) {
      try { data = JSON.parse(text); }
      catch { data = text; }
    }
    return {ok: response.ok, status: response.status, statusText: response.statusText, data, text, signed};
  }

  async requestMultipart(path, {method = 'POST', query, formData, openKeyId = this.openKeyId, secretKey = this.secretKey, timestamp, randomKey, headers = {}} = {}) {
    if (!isFormDataBody(formData)) throw new Error('requestMultipart requires a FormData body');
    return await this.request(path, {
      method,
      query,
      body: formData,
      openKeyId,
      secretKey,
      timestamp,
      randomKey,
      headers,
    });
  }

  /**
   * Bounded transient retry for explicitly read-only endpoints only.
   *
   * Callers must opt in per endpoint; the generic request() (used by every
   * write endpoint) is intentionally left without retry. Retries apply only to
   * transport-level fetch failures (undici `TypeError: fetch failed` class);
   * once a response is received -- any HTTP status, any business code -- it is
   * returned unchanged without retry, so business errors are never swallowed.
   * Each attempt re-signs with a fresh timestamp.
   */
  async requestReadOnly(path, options = {}, {maxAttempts = 3, baseDelayMs = 500} = {}) {
    const attempts = Math.min(5, Math.max(1, Number.isFinite(Number(maxAttempts)) ? Math.floor(Number(maxAttempts)) : 3));
    const baseDelay = Math.max(0, Number.isFinite(Number(baseDelayMs)) ? Math.floor(Number(baseDelayMs)) : 500);
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.request(path, options);
      } catch (error) {
        lastError = error;
        if (!isTransientFetchTransportError(error) || attempt === attempts) throw error;
        await new Promise(resolve => setTimeout(resolve, baseDelay * (2 ** (attempt - 1))));
      }
    }
    throw lastError;
  }

  async getByToken({appId, appSecretKey, tempToken, baseUrl = this.baseUrl, timestamp, randomKey}) {
    if (!tempToken) throw new Error('tempToken is required');
    assertRealOpenApiAllowedForRuntime(baseUrl);
    const path = '/open-api/auth/get-by-token';
    const {headers, signed} = buildGetByTokenHeaders({appId, appSecretKey, timestamp, randomKey});
    const response = await this.fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({tempToken}),
    });
    const text = await response.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); }
      catch { data = text; }
    }
    if (data?.info?.secretKey) {
      data.info.encryptedSecretKey = data.info.secretKey;
      data.info.secretKey = decryptSheinSecretKey(data.info.secretKey, appSecretKey);
    }
    return {ok: response.ok, status: response.status, statusText: response.statusText, data, text, signed};
  }
}
