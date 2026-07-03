#!/usr/bin/env node
/**
 * Fetch full API document details for all semi-trust (半托管, mode=5) interfaces.
 *
 * Outputs structured JSON per interface into outputs/shein-openapi-doc-catalog/api-details/
 * and a combined index at outputs/shein-openapi-doc-catalog/semi-trust-api-details.json
 *
 * Read-only: never calls SHEIN business OpenAPI, never reads/saves secrets.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORTAL_HOST = 'https://openapi-portal.sheincorp.com';
const OUT_DIR = path.join(ROOT, 'outputs', 'shein-openapi-doc-catalog', 'api-details');
const INDEX_OUT = path.join(ROOT, 'outputs', 'shein-openapi-doc-catalog', 'semi-trust-api-details.json');
const CATALOG_PATH = path.join(ROOT, 'outputs', 'shein-openapi-doc-catalog', 'official-capabilities.latest.json');

const SEMI_TRUST_MODE = 5;
const CONCURRENCY = 5;
const DELAY_MS = 200;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      accept: 'application/json, text/plain, */*',
      'user-agent': 'Mozilla/5.0 SHEIN-BI-OfficialCatalog/1.0',
      origin: 'https://open.sheincorp.com',
      referer: 'https://open.sheincorp.com/documents/apidoc/detail/3001359',
    },
  });
  const text = await res.text();
  return {status: res.status, data: JSON.parse(text), bytes: Buffer.byteLength(text)};
}

function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseSchemaTree(raw) {
  if (!raw) return null;
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return {raw: stripHtml(raw)}; }
  }
  function walk(node, depth = 0) {
    if (node == null || typeof node !== 'object') return node;
    const props = node.props || {};
    const children = Array.isArray(node.children) ? node.children : [];
    const result = {
      name: props.name || props.field || props.key || props.title || '',
      type: props.type || props.dataType || props.paramType || '',
      required: props.required ?? props.isRequired ?? props.require ?? props.must ?? null,
      description: stripHtml(props.description || props.desc || ''),
      defaultValue: props.defaultValue ?? props.default ?? '',
      example: props.example ?? '',
      label: props.label || '',
      multiple: props.multiple ?? null,
    };
    if (children.length) {
      result.children = children.map(c => walk(c, depth + 1)).filter(Boolean);
    }
    // Clean up empty values
    for (const key of Object.keys(result)) {
      if (result[key] === '' || result[key] === null || result[key] === undefined) delete result[key];
    }
    return result;
  }
  return walk(parsed);
}

function extractExample(raw) {
  if (!raw) return '';
  const text = stripHtml(raw);
  // Try to extract code block content
  const codeMatch = text.match(/(?:curl|{|\w+)\b[\s\S]*/);
  return codeMatch ? codeMatch[0].trim() : text;
}

async function fetchDetail(docId) {
  const url = `${PORTAL_HOST}/api/apiDoc/queryApiPublishDocDetailInfoById?id=${docId}&isLatest=true`;
  const {status, data} = await fetchJson(url);
  if (String(data?.code ?? '') !== '0') {
    return {docId, ok: false, error: `code=${data?.code} msg=${data?.msg}`, status};
  }
  const info = data.info || {};
  const vo = info.apiPublishDocVo || {};
  const detail = info.apiPublishDocDetailVo || {};
  const modes = Array.isArray(info.mode) ? info.mode : [];
  const modeNames = Array.isArray(info.modeNameList) ? info.modeNameList : [];

  return {
    docId: String(docId),
    ok: true,
    status,
    meta: {
      title: vo.title || vo.userDocName || '',
      userDocName: vo.userDocName || '',
      endpoint: vo.openPath || '',
      method: String(vo.method || '').toUpperCase(),
      docName: vo.docName || '',
      version: vo.version || 0,
      updateTime: vo.updateTime || '',
      changeContent: vo.changeContent || '',
      qpsContent: vo.qpsContent || '',
      modes,
      modeNames,
      isSemiTrust: modes.includes(SEMI_TRUST_MODE),
    },
    description: stripHtml(detail.description || ''),
    requestHeader: parseSchemaTree(detail.requestHeader),
    queryStrings: parseSchemaTree(detail.queryStrings),
    requestBody: parseSchemaTree(detail.requestBody),
    responseBody: parseSchemaTree(detail.responseBody),
    requestExample: extractExample(detail.requestExample),
    responseExample: extractExample(detail.responseExample),
    errorCode: detail.errorCode || null,
  };
}

async function main() {
  // Load existing catalog to get all API docIds
  const catalog = JSON.parse(await fs.readFile(CATALOG_PATH, 'utf8'));
  const apiCaps = catalog.capabilities.filter(c => c.documentKind === 'api');

  console.log(`Total API interfaces in catalog: ${apiCaps.length}`);

  // Fetch all details (we need mode info to filter semi-trust)
  const results = [];
  const errors = [];
  let fetched = 0;
  let semiTrustCount = 0;

  // Process in batches for concurrency control
  for (let i = 0; i < apiCaps.length; i += CONCURRENCY) {
    const batch = apiCaps.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(cap => fetchDetail(cap.docId).catch(err => ({
        docId: cap.docId,
        ok: false,
        error: err.message,
        endpoint: cap.endpoint,
      })))
    );
    for (const result of batchResults) {
      fetched++;
      if (!result.ok) {
        errors.push(result);
        console.error(`FAIL [${fetched}/${apiCaps.length}] docId=${result.docId}: ${result.error}`);
        continue;
      }
      if (result.isSemiTrust === false && !result.meta?.isSemiTrust) {
        // Not semi-trust, skip storing detail but count
        continue;
      }
      results.push(result);
      semiTrustCount++;
      console.log(`OK   [${fetched}/${apiCaps.length}] docId=${result.docId} ${result.meta.endpoint} modes=[${result.meta.modes.join(',')}]`);
    }
    if (i + CONCURRENCY < apiCaps.length) await sleep(DELAY_MS);
  }

  // Write individual detail files
  await fs.mkdir(OUT_DIR, {recursive: true});
  for (const result of results) {
    const file = path.join(OUT_DIR, `${result.docId}.json`);
    await fs.writeFile(file, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }

  // Write combined index
  const index = {
    schemaVersion: 'shein-openapi-api-details/v1',
    generatedAt: new Date().toISOString(),
    totalCount: apiCaps.length,
    semiTrustCount: results.length,
    errorCount: errors.length,
    interfaces: results.map(r => ({
      docId: r.docId,
      title: r.meta.title,
      endpoint: r.meta.endpoint,
      method: r.meta.method,
      modes: r.meta.modes,
      modeNames: r.meta.modeNames,
      qps: r.meta.qpsContent || '',
      hasRequestBody: Boolean(r.requestBody),
      hasResponseBody: Boolean(r.responseBody),
      hasRequestExample: Boolean(r.requestExample),
      hasResponseExample: Boolean(r.responseExample),
      requestFieldCount: r.requestBody?.children?.length || 0,
      responseFieldCount: r.responseBody?.children?.length || 0,
    })),
    errors: errors.map(e => ({docId: e.docId, error: e.error, endpoint: e.endpoint || ''})),
  };
  await fs.writeFile(INDEX_OUT, `${JSON.stringify(index, null, 2)}\n`, 'utf8');

  console.log(`\nDone: ${results.length} semi-trust interfaces, ${errors.length} errors`);
  console.log(`Details written to: ${path.relative(ROOT, OUT_DIR)}`);
  console.log(`Index written to: ${path.relative(ROOT, INDEX_OUT)}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
