import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SHEIN_WEBAPI_ORIGIN = 'https://sso.geiwohuo.com';
export const DEFAULT_SHEIN_WEBAPI_SESSION_DIR = path.join(ROOT, 'state', 'shein_webapi_sessions');

export function sheinWebApiSessionPath(storeKey, options = {}) {
  const sessionDir = path.resolve(options.sessionDir || process.env.SHEIN_WEBAPI_SESSION_DIR || DEFAULT_SHEIN_WEBAPI_SESSION_DIR);
  const key = String(storeKey || '').trim().toUpperCase();
  if (!key) throw new Error('Missing SHEIN store key for WebAPI session');
  return path.join(sessionDir, `${key}.local.json`);
}

export async function loadSheinWebApiSession(storeKey, options = {}) {
  const file = sheinWebApiSessionPath(storeKey, options);
  const session = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  if (!session?.cookieHeader) {
    throw new Error(`SHEIN WebAPI session has no cookieHeader: ${file}`);
  }
  return {
    ...session,
    storeKey: String(session.storeKey || storeKey || '').toUpperCase(),
    sourceFile: file,
    loadedFromFile: true,
  };
}

export function sheinWebApiHeaders(session, options = {}) {
  const originPath = options.originPath || '/order-management/list';
  const originUrl = options.originUrl || `${SHEIN_WEBAPI_ORIGIN}/#/gsp${originPath}`;
  const headers = {
    'User-Agent': session.userAgent || 'Mozilla/5.0',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': session.acceptLanguage || 'zh-CN,zh;q=0.9,en;q=0.8',
    'Content-Type': 'application/json;charset=UTF-8',
    'Origin': SHEIN_WEBAPI_ORIGIN,
    'Referer': `${SHEIN_WEBAPI_ORIGIN}/`,
    'Cookie': session.cookieHeader,
    'Origin-Path': originPath,
    'Origin-Url': originUrl,
    'build-version': options.buildVersion || '2026-04-23 11:38',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    ...(options.headers || {}),
  };
  if (session.clientHints?.secChUa) headers['sec-ch-ua'] = session.clientHints.secChUa;
  if (session.clientHints?.secChUaMobile) headers['sec-ch-ua-mobile'] = session.clientHints.secChUaMobile;
  if (session.clientHints?.secChUaPlatform) headers['sec-ch-ua-platform'] = session.clientHints.secChUaPlatform;
  return headers;
}

export async function fetchSheinWebApiJson(session, endpoint, payload = {}, options = {}) {
  const method = String(options.method || 'POST').toUpperCase();
  const url = /^https?:\/\//i.test(String(endpoint)) ? String(endpoint) : `${SHEIN_WEBAPI_ORIGIN}${endpoint}`;
  const res = await fetch(url, {
    method,
    credentials: 'omit',
    signal: AbortSignal.timeout(Number(options.timeoutMs || process.env.SHEIN_WEBAPI_FETCH_TIMEOUT_MS || 45_000)),
    headers: sheinWebApiHeaders(session, options),
    body: method === 'GET' ? undefined : JSON.stringify(payload ?? {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!json) {
    throw new Error(`Non-JSON SHEIN WebAPI response from ${endpoint}: http=${res.status} ${String(text || '').slice(0, 300)}`);
  }
  const code = String(json.code ?? json.status ?? '');
  if (code === '20302' || res.status === 401 || res.status === 403) {
    throw new Error(`${endpoint} SHEIN WebAPI auth failed: http=${res.status} code=${json.code ?? json.status ?? ''} msg=${json.msg || json.message || ''}`);
  }
  if (code && code !== '0') {
    throw new Error(`${endpoint} SHEIN WebAPI failed: http=${res.status} code=${json.code ?? json.status ?? ''} msg=${json.msg || json.message || ''}`);
  }
  return json;
}
