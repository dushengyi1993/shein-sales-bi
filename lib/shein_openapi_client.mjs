#!/usr/bin/env node
import crypto from 'node:crypto';

export const SHEIN_OPENAPI_BASE_URLS = Object.freeze({
  test: 'https://openapi-test01.sheincorp.cn',
  prodSemiManaged: 'https://openapi.sheincorp.com',
});

export const SHEIN_OPENAPI_AUTH_HOSTS = Object.freeze({
  test: 'openapi-sem-test01.dotfashion.cn',
  prod: 'openapi-sem.sheincorp.com',
});

export const CONTENT_TYPE = 'application/json;charset=UTF-8';
export const DEFAULT_AES_IV_SEED = 'space-station-default-iv';
const RANDOM_KEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

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

export class SheinOpenApiClient {
  constructor({baseUrl = SHEIN_OPENAPI_BASE_URLS.test, openKeyId, secretKey, fetchImpl = globalThis.fetch} = {}) {
    if (!fetchImpl) throw new Error('fetch is not available in this Node runtime');
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.openKeyId = openKeyId;
    this.secretKey = secretKey;
    this.fetchImpl = fetchImpl;
  }

  buildUrl(path, query) {
    const apiPath = normalizeApiPath(path);
    return appendQuery(`${this.baseUrl}${apiPath}`, query);
  }

  async request(path, {method = 'POST', query, body, openKeyId = this.openKeyId, secretKey = this.secretKey, timestamp, randomKey, headers = {}} = {}) {
    const apiPath = normalizeApiPath(path);
    const {headers: signedHeaders, signed} = buildSignedHeaders({openKeyId, secretKey, path: apiPath, timestamp, randomKey});
    const init = {
      method: String(method).toUpperCase(),
      headers: {...signedHeaders, ...headers},
    };
    if (body !== undefined && init.method !== 'GET') {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const response = await this.fetchImpl(this.buildUrl(apiPath, query), init);
    const text = await response.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); }
      catch { data = text; }
    }
    return {ok: response.ok, status: response.status, statusText: response.statusText, data, text, signed};
  }

  async getByToken({appId, appSecretKey, tempToken, baseUrl = this.baseUrl, timestamp, randomKey}) {
    if (!tempToken) throw new Error('tempToken is required');
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
