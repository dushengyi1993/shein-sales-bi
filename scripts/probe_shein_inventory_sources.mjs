#!/usr/bin/env node
/**
 * Read-only inventory source probe for an already logged-in SHEIN Chrome profile.
 *
 * It navigates several likely stock/inventory pages and captures request/response
 * shapes for endpoints that look stock-related.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {connectCdp} from '../lib/shein_browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'outputs', 'shein_inventory_probe');

const ROUTES = [
  {key: 'inventory-home', url: 'https://sso.geiwohuo.com/#/gsp/inventory-management'},
  {key: 'storage-age', url: 'https://sso.geiwohuo.com/#/gsp/inventory-management/storage-age'},
  {key: 'product-list', url: 'https://sso.geiwohuo.com/#/spmp/commdities/list'},
  {key: 'out-of-stock-goods', url: 'https://sso.geiwohuo.com/#/gsp/order-management/out-of-stock-goods'},
  {key: 'stockup', url: 'https://sso.geiwohuo.com/#/idms/stockup'},
];

function parseArgs(argv) {
  const args = {port: 9360, waitMs: 10000, outDir: OUT_DIR};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--wait-ms') args.waitMs = Number(argv[++i]);
    else if (a === '--out') args.outDir = path.resolve(argv[++i]);
  }
  return args;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function pad2(n) { return String(n).padStart(2, '0'); }
function stamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

async function evaluate(send, expression) {
  const result = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}

function parseMaybeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function hasStockSignal(url) {
  return /(stock|storage|inventory|warehouse|quantity|sku|goods-skc|query_msc_stock|out-of-stock)/i.test(url || '');
}

function summarizeShape(value, depth = 0) {
  if (depth > 3) return typeof value;
  if (Array.isArray(value)) {
    return {type: 'array', length: value.length, first: value.length ? summarizeShape(value[0], depth + 1) : null};
  }
  if (value && typeof value === 'object') {
    const out = {type: 'object', keys: Object.keys(value).slice(0, 100)};
    for (const [k, v] of Object.entries(value).slice(0, 30)) out[k] = summarizeShape(v, depth + 1);
    return out;
  }
  return {type: typeof value, sample: value};
}

function findArrays(value, pathName = '$', out = []) {
  if (Array.isArray(value)) {
    out.push({
      path: pathName,
      length: value.length,
      firstKeys: value[0] && typeof value[0] === 'object' ? Object.keys(value[0]).slice(0, 100) : [],
    });
    if (value[0]) findArrays(value[0], `${pathName}[0]`, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) findArrays(v, `${pathName}.${k}`, out);
  }
  return out;
}

function findStockLikeFields(value, pathName = '$', out = []) {
  if (Array.isArray(value)) {
    value.slice(0, 3).forEach((v, i) => findStockLikeFields(v, `${pathName}[${i}]`, out));
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (/(stock|storage|inventory|warehouse|quantity|qty|available|sku|skc|goods|total)/i.test(k)) {
        out.push({path: `${pathName}.${k}`, key: k, sample: typeof v === 'object' ? summarizeShape(v, 0) : v});
      }
      findStockLikeFields(v, `${pathName}.${k}`, out);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await fs.mkdir(args.outDir, {recursive: true});
  const cdp = await connectCdp(args.port);
  await cdp.send('Network.enable');
  const requests = new Map();
  const captures = [];

  cdp.on('Network.requestWillBeSent', ev => {
    const url = ev.request?.url || '';
    if (!hasStockSignal(url)) return;
    requests.set(ev.requestId, {
      requestId: ev.requestId,
      routeKey: currentRoute.key,
      routeUrl: currentRoute.url,
      url,
      method: ev.request.method,
      postData: ev.request.postData || '',
      timestamp: ev.timestamp,
    });
  });

  cdp.on('Network.responseReceived', ev => {
    const url = ev.response?.url || '';
    if (!hasStockSignal(url)) return;
    const meta = requests.get(ev.requestId) || {
      requestId: ev.requestId,
      routeKey: currentRoute.key,
      routeUrl: currentRoute.url,
      url,
    };
    captures.push({
      ...meta,
      status: ev.response.status,
      mimeType: ev.response.mimeType,
      resourceType: ev.type,
    });
  });

  let currentRoute = ROUTES[0];
  const pages = [];
  for (const route of ROUTES) {
    currentRoute = route;
    const startIndex = captures.length;
    await cdp.send('Page.navigate', {url: route.url});
    await sleep(args.waitMs);
    await evaluate(cdp.send, `window.scrollTo(0, document.body.scrollHeight)`).catch(() => null);
    await sleep(1500);
    const pageInfo = await evaluate(cdp.send, `(() => ({
      href: location.href,
      title: document.title,
      text: (document.body?.innerText || '').slice(0, 12000)
    }))()`);
    pages.push({
      key: route.key,
      url: route.url,
      pageInfo,
      captureCount: captures.length - startIndex,
      stockWords: (pageInfo.text || '').split(/\\n+/).filter(x => /库存|SKU|SKC|仓|数量|可售|缺货|商品编码/.test(x)).slice(0, 120),
    });
  }

  for (const cap of captures) {
    if (!/json|text|javascript/i.test(cap.mimeType || '')) continue;
    try {
      const body = await cdp.send('Network.getResponseBody', {requestId: cap.requestId});
      cap.responseTextPreview = body.body.slice(0, 1200);
      cap.responseJson = parseMaybeJson(body.body);
      cap.postJson = parseMaybeJson(cap.postData);
      cap.shape = summarizeShape(cap.responseJson ?? cap.responseTextPreview);
      cap.arrays = findArrays(cap.responseJson).slice(0, 20);
      cap.stockLikeFields = findStockLikeFields(cap.responseJson).slice(0, 120);
    } catch (err) {
      cap.bodyError = err.message;
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    port: args.port,
    routes: ROUTES,
    pages,
    captures,
  };
  const file = path.join(args.outDir, `inventory-sources-probe-${stamp()}.json`);
  await fs.writeFile(file, JSON.stringify(output, null, 2), 'utf8');

  const endpointSummary = [];
  for (const cap of captures) {
    const endpoint = new URL(cap.url).pathname;
    const existing = endpointSummary.find(x => x.endpoint === endpoint && x.routeKey === cap.routeKey);
    if (existing) {
      existing.count++;
      if (!existing.statuses.includes(cap.status)) existing.statuses.push(cap.status);
    } else {
      endpointSummary.push({
        routeKey: cap.routeKey,
        endpoint,
        method: cap.method,
        count: 1,
        statuses: [cap.status],
        hasJson: Boolean(cap.responseJson),
        arrays: (cap.arrays || []).filter(x => x.length).slice(0, 3),
        stockFields: (cap.stockLikeFields || []).slice(0, 8),
      });
    }
  }

  console.log(JSON.stringify({
    ok: true,
    file: path.relative(ROOT, file),
    pageSummaries: pages.map(p => ({
      key: p.key,
      href: p.pageInfo.href,
      captureCount: p.captureCount,
      hasPermissionText: /没有.*权限|无权限|请主账号/.test(p.pageInfo.text || ''),
      stockWords: p.stockWords.slice(0, 20),
    })),
    endpointSummary: endpointSummary.slice(0, 80),
  }, null, 2));

  cdp.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
