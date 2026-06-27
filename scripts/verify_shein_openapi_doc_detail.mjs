#!/usr/bin/env node
/**
 * Read-only verifier for SHEIN OpenAPI official document detail pages.
 *
 * Purpose:
 * - Do NOT submit SHEIN writes.
 * - Do NOT print cookies/tokens.
 * - Convert a logged-in official doc detail response into a sanitized evidence
 *   artifact that can unblock a real-write adapter review.
 *
 * The SHEIN OpenAPI portal public backend currently exposes:
 *   GET https://openapi-portal.sheincorp.com/api/apiDoc/queryApiPublishDocDetailInfoById?id=<docId>&isLatest=true
 *
 * The script also accepts a cookie for compatibility with logged-in portal
 * sessions, but it does not print or save cookies/tokens.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DOCS = [
  {
    id: '3001253',
    intent: 'retire_link',
    expectedEndpoint: '/open-api/goods/modify-skc-shelf',
    expectedLabel: '商品上下架',
    expectedKeywords: ['shelf_state'],
  },
  {
    id: '3001812',
    intent: 'product_publish_or_edit',
    expectedEndpoint: '/open-api/goods/product/publishOrEdit',
    expectedLabel: '商品发布/编辑',
    expectedKeywords: [],
  },
  {
    id: '3001810',
    intent: 'partial_product_edit',
    expectedEndpoint: '/open-api/goods/product/partialEdit',
    expectedLabel: '商品局部编辑',
    expectedKeywords: [],
  },
  {
    id: '3001738',
    intent: 'update_inventory',
    expectedEndpoint: '/open-api/stock/change-inventory/v2',
    expectedLabel: '库存更新',
    expectedKeywords: [],
  },
  {
    id: '3001681',
    intent: 'update_supply_price',
    expectedEndpoint: '/open-api/goods/update-cost',
    expectedLabel: '供货价更新',
    expectedKeywords: [],
  },
  {
    id: '3001407',
    intent: 'update_product_price',
    expectedEndpoint: '/open-api/openapi-business-backend/product/price/save',
    expectedLabel: '商品售价更新',
    expectedKeywords: [],
  },
];

function parseArgs(argv) {
  const args = {
    docs: [],
    cookieFile: '',
    cookieEnv: 'SHEIN_OPENAPI_PORTAL_COOKIE',
    outPath: path.join(ROOT, 'tmp', 'shein-openapi-doc-detail', 'doc-detail-evidence.local.json'),
    portalHost: 'https://openapi-portal.sheincorp.com',
    requireVerified: false,
    fixturePath: '',
    pretty: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--doc-id') {
      const id = String(argv[++i] || '').trim();
      if (!id) throw new Error('--doc-id requires a value');
      args.docs.push({id});
    } else if (a === '--endpoint') {
      const endpoint = String(argv[++i] || '').trim();
      if (!endpoint) throw new Error('--endpoint requires a value');
      const last = args.docs[args.docs.length - 1] || {};
      last.expectedEndpoint = endpoint;
      if (!args.docs.length) args.docs.push(last);
    } else if (a === '--cookie-file') {
      args.cookieFile = path.resolve(argv[++i]);
    } else if (a === '--cookie-env') {
      args.cookieEnv = String(argv[++i] || '').trim();
    } else if (a === '--out') {
      args.outPath = path.resolve(argv[++i]);
    } else if (a === '--portal-host') {
      args.portalHost = String(argv[++i] || '').replace(/\/+$/, '');
    } else if (a === '--fixture') {
      args.fixturePath = path.resolve(argv[++i]);
    } else if (a === '--require-verified') {
      args.requireVerified = true;
    } else if (a === '--pretty') {
      args.pretty = true;
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!args.docs.length) args.docs = DEFAULT_DOCS;
  args.docs = args.docs.map(doc => {
    const known = DEFAULT_DOCS.find(x => String(x.id) === String(doc.id)) || {};
    return {...known, ...doc, id: String(doc.id)};
  });
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/verify_shein_openapi_doc_detail.mjs [options]

Examples:
  # No cookie: proves only whether the official portal detail endpoint is accessible.
  node scripts/verify_shein_openapi_doc_detail.mjs --pretty

  # Logged-in portal cookie from a private local file; the cookie is never printed.
  node scripts/verify_shein_openapi_doc_detail.mjs \\
    --doc-id 3001629 --endpoint /open-api/goods/modify-skc-shelf \\
    --cookie-file tmp/shein-openapi-doc-cookie.local.txt \\
    --out tmp/shein-openapi-doc-detail/modify-skc-shelf.local.json \\
    --require-verified --pretty

Options:
  --doc-id <id>          Official document id. May be repeated.
  --endpoint <path>     Expected OpenAPI endpoint for the preceding --doc-id.
  --cookie-file <file>  File containing the logged-in open.sheincorp.com Cookie header value.
  --cookie-env <name>   Env var containing the Cookie header value. Default SHEIN_OPENAPI_PORTAL_COOKIE.
  --out <file>          Sanitized evidence output. Default tmp/.../doc-detail-evidence.local.json.
  --fixture <file>      Offline JSON fixture for parser/smoke tests.
  --require-verified    Exit non-zero unless every requested doc is verified.
  --pretty              Human-readable summary.

Safety:
  This script is read-only. It never calls SHEIN OpenAPI business write endpoints.
  It never prints or saves cookies/tokens/secrets.`);
}

async function readCookie(args) {
  let raw = '';
  if (args.cookieFile) {
    raw = await fs.readFile(args.cookieFile, 'utf8');
  } else if (args.cookieEnv && process.env[args.cookieEnv]) {
    raw = process.env[args.cookieEnv];
  }
  return String(raw || '').trim();
}

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function safeJsonParse(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function flattenDocFields(value, prefix = '') {
  const out = [];
  const seen = new Set();
  function visit(node, pathParts) {
    if (node == null) return;
    if (typeof node === 'string') {
      const text = node.trim();
      if (text && /[\u4e00-\u9fa5A-Za-z0-9_/-]/.test(text)) {
        const key = `${pathParts.join('.')}:text:${text}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({path: pathParts.join('.'), text});
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, [...pathParts, String(index)]));
      return;
    }
    if (typeof node === 'object') {
      const fieldName = node.name ?? node.field ?? node.key ?? node.title ?? node.paramName ?? node.code;
      const title = node.title ?? node.name ?? node.desc ?? node.description ?? node.paramName ?? '';
      const type = node.type ?? node.dataType ?? node.paramType ?? '';
      const required = node.required ?? node.isRequired ?? node.require ?? node.must ?? null;
      if (fieldName || title || type) {
        const entry = {
          path: pathParts.join('.'),
          name: fieldName == null ? '' : String(fieldName),
          title: title == null ? '' : String(title),
          type: type == null ? '' : String(type),
          required,
        };
        const key = JSON.stringify(entry);
        if (!seen.has(key)) {
          seen.add(key);
          out.push(entry);
        }
      }
      for (const [k, v] of Object.entries(node)) {
        if (['children', 'childList', 'items', 'properties', 'params', 'data'].includes(k) || typeof v === 'object') {
          visit(v, [...pathParts, k]);
        }
      }
    }
  }
  visit(value, prefix ? [prefix] : []);
  return out;
}

function containsKeyword(value, keyword) {
  return JSON.stringify(value || '').toLowerCase().includes(String(keyword || '').toLowerCase());
}

function normalizePortalResponse(raw, doc) {
  const response = safeJsonParse(raw);
  const httpStatus = response?.httpStatus ?? response?.status ?? null;
  const body = response?.body ?? response;
  const code = body?.code ?? body?.retCode ?? body?.status ?? null;
  const msg = body?.msg ?? body?.message ?? body?.retMsg ?? '';
  const info = body?.info ?? body?.data?.info ?? body?.data ?? null;
  const apiPublishDocVo = info?.apiPublishDocVo ?? info?.apiDocVo ?? {};
  const apiPublishDocDetailVo = info?.apiPublishDocDetailVo ?? info?.apiDocDetailVo ?? {};
  const endpoint = apiPublishDocVo.openPath ?? apiPublishDocVo.path ?? apiPublishDocVo.url ?? '';
  const method = apiPublishDocVo.method ?? apiPublishDocDetailVo.method ?? '';
  const title = apiPublishDocVo.userDocName ?? apiPublishDocVo.title ?? apiPublishDocVo.name ?? '';
  const requestHeader = safeJsonParse(apiPublishDocDetailVo.requestHeader);
  const queryStrings = safeJsonParse(apiPublishDocDetailVo.queryStrings);
  const requestBody = safeJsonParse(apiPublishDocDetailVo.requestBody);
  const responseBody = safeJsonParse(apiPublishDocDetailVo.responseBody);
  const description = apiPublishDocDetailVo.description ?? '';
  const requestFields = [
    ...flattenDocFields(requestHeader, 'requestHeader'),
    ...flattenDocFields(queryStrings, 'queryStrings'),
    ...flattenDocFields(requestBody, 'requestBody'),
  ].slice(0, 500);
  const responseFields = flattenDocFields(responseBody, 'responseBody').slice(0, 500);
  const expectedEndpoint = doc.expectedEndpoint || '';
  const endpointMatches = expectedEndpoint ? endpoint === expectedEndpoint : Boolean(endpoint);
  const keywordChecks = (doc.expectedKeywords || []).map(keyword => ({
    keyword,
    present: containsKeyword({requestHeader, queryStrings, requestBody, responseBody, description}, keyword),
  }));
  const authRequired = Number(httpStatus) === 401
    || String(code) === '401'
    || /login|unauthori[sz]ed|未登录|登录/i.test(String(msg));
  const hasSchema = Boolean(endpoint && (requestFields.length || responseFields.length || description));
  const verified = Boolean(hasSchema && endpointMatches && keywordChecks.every(x => x.present));
  return {
    docId: doc.id,
    intent: doc.intent || '',
    expectedLabel: doc.expectedLabel || '',
    expectedEndpoint,
    status: verified ? 'verified' : (authRequired ? 'auth_required' : 'not_verified'),
    verified,
    authRequired,
    httpStatus,
    portalCode: code,
    portalMessage: msg ? String(msg).slice(0, 300) : '',
    title,
    endpoint,
    method,
    endpointMatches,
    keywordChecks,
    schemaHash: stableHash(JSON.stringify({endpoint, method, requestHeader, queryStrings, requestBody, responseBody})),
    requestFieldCount: requestFields.length,
    responseFieldCount: responseFields.length,
    requestFields,
    responseFields,
    capturedSections: {
      hasDescription: Boolean(description),
      hasRequestHeader: requestHeader != null,
      hasQueryStrings: queryStrings != null,
      hasRequestBody: requestBody != null,
      hasResponseBody: responseBody != null,
    },
  };
}

async function fetchDocDetail(args, doc, cookie) {
  const url = new URL('/api/apiDoc/queryApiPublishDocDetailInfoById', args.portalHost);
  url.searchParams.set('id', String(doc.id));
  url.searchParams.set('isLatest', 'true');
  const headers = {
    accept: 'application/json, text/plain, */*',
    'user-agent': 'Mozilla/5.0 SHEIN-BI-DocVerifier/1.0',
    origin: 'https://open.sheincorp.com',
    referer: `https://open.sheincorp.com/documents/apidoc/detail/${doc.id}`,
  };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(url, {
    method: 'GET',
    headers,
    redirect: 'manual',
  });
  const text = await res.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    body = {rawTextPreview: text.slice(0, 500)};
  }
  return {httpStatus: res.status, body};
}

async function loadFixture(args) {
  const fixture = JSON.parse(await fs.readFile(args.fixturePath, 'utf8'));
  if (Array.isArray(fixture)) return fixture;
  if (Array.isArray(fixture.responses)) return fixture.responses;
  return [fixture];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cookie = args.fixturePath ? '' : await readCookie(args);
  const responses = args.fixturePath ? await loadFixture(args) : [];
  const results = [];
  for (let i = 0; i < args.docs.length; i++) {
    const doc = args.docs[i];
    const raw = args.fixturePath ? (responses[i] || responses[0]) : await fetchDocDetail(args, doc, cookie);
    results.push(normalizePortalResponse(raw, doc));
  }
  const summary = {
    ok: results.every(x => x.verified),
    capturedAt: new Date().toISOString(),
    portalHost: args.portalHost,
    docsRequested: args.docs.map(x => ({id: x.id, intent: x.intent || '', expectedEndpoint: x.expectedEndpoint || ''})),
    cookieProvided: Boolean(cookie),
    cookieHash: cookie ? stableHash(cookie).slice(0, 12) : '',
    safety: {
      readOnly: true,
      sheinBusinessWriteCalled: false,
      cookieSaved: false,
      cookiePrinted: false,
    },
    results,
  };
  await fs.mkdir(path.dirname(args.outPath), {recursive: true});
  await fs.writeFile(args.outPath, JSON.stringify(summary, null, 2), 'utf8');
  const printable = args.pretty
    ? {
        ok: summary.ok,
        savedTo: path.relative(ROOT, args.outPath).replace(/\\/g, '/'),
        cookieProvided: summary.cookieProvided,
        results: results.map(x => ({
          docId: x.docId,
          intent: x.intent,
          status: x.status,
          endpoint: x.endpoint,
          expectedEndpoint: x.expectedEndpoint,
          endpointMatches: x.endpointMatches,
          keywordChecks: x.keywordChecks,
          requestFieldCount: x.requestFieldCount,
          responseFieldCount: x.responseFieldCount,
          blockers: x.verified ? [] : [
            x.authRequired ? '需要登录 open.sheincorp.com 后的 Cookie 才能读取官方详情' : '',
            x.endpointMatches ? '' : '官方详情 endpoint 与预期不一致或未返回',
            ...x.keywordChecks.filter(k => !k.present).map(k => `未找到关键字段 ${k.keyword}`),
          ].filter(Boolean),
        })),
      }
    : {ok: summary.ok, savedTo: path.relative(ROOT, args.outPath).replace(/\\/g, '/')};
  console.log(JSON.stringify(printable, null, 2));
  if (args.requireVerified && !summary.ok) process.exit(2);
}

main().catch(err => {
  console.error(JSON.stringify({ok: false, error: err?.message || String(err), stack: err?.stack || ''}, null, 2));
  process.exit(1);
});
