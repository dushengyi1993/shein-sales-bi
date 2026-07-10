#!/usr/bin/env node
/**
 * Probe SHEIN inventory stock-age page with an already logged-in Chrome profile.
 *
 * Read-only. It captures `/gsp/storage/stockAge/list` request/response metadata
 * and stores a local JSON evidence file for field mapping.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {connectCdp} from '../lib/shein_browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'outputs', 'shein_inventory_probe');
const STOCK_AGE_URL = 'https://sso.geiwohuo.com/#/gsp/inventory-management/storage-age';

function parseArgs(argv) {
  const args = {port: 9360, waitMs: 9000, outDir: OUT_DIR};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--wait-ms') args.waitMs = Number(argv[++i]);
    else if (a === '--out') args.outDir = path.resolve(argv[++i]);
  }
  return args;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function stamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function evaluate(send, expression) {
  const result = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}

function parseMaybeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function summarizeShape(value, depth = 0) {
  if (depth > 3) return typeof value;
  if (Array.isArray(value)) {
    return {type: 'array', length: value.length, first: value.length ? summarizeShape(value[0], depth + 1) : null};
  }
  if (value && typeof value === 'object') {
    const out = {type: 'object', keys: Object.keys(value).slice(0, 80)};
    for (const [k, v] of Object.entries(value).slice(0, 20)) out[k] = summarizeShape(v, depth + 1);
    return out;
  }
  return {type: typeof value, sample: value};
}

function findArrays(value, pathName = '$', out = []) {
  if (Array.isArray(value)) {
    out.push({path: pathName, length: value.length, firstKeys: value[0] && typeof value[0] === 'object' ? Object.keys(value[0]).slice(0, 80) : []});
    if (value[0]) findArrays(value[0], `${pathName}[0]`, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) findArrays(v, `${pathName}.${k}`, out);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await fs.mkdir(args.outDir, {recursive: true});
  const cdp = await connectCdp(args.port);
  await cdp.send('Network.enable');
  const captures = [];
  const requestMeta = new Map();

  cdp.on('Network.requestWillBeSent', ev => {
    const url = ev.request?.url || '';
    if (!url.includes('/gsp/storage/stockAge/list')) return;
    requestMeta.set(ev.requestId, {
      requestId: ev.requestId,
      url,
      method: ev.request.method,
      postData: ev.request.postData || '',
      timestamp: ev.timestamp,
    });
  });
  cdp.on('Network.responseReceived', async ev => {
    const url = ev.response?.url || '';
    if (!url.includes('/gsp/storage/stockAge/list')) return;
    const meta = requestMeta.get(ev.requestId) || {requestId: ev.requestId, url};
    captures.push({
      ...meta,
      status: ev.response.status,
      mimeType: ev.response.mimeType,
    });
  });

  await cdp.send('Page.navigate', {url: STOCK_AGE_URL});
  await sleep(args.waitMs);

  for (const cap of captures) {
    try {
      const body = await cdp.send('Network.getResponseBody', {requestId: cap.requestId});
      cap.responseText = body.body;
      cap.responseJson = parseMaybeJson(body.body);
      cap.postJson = parseMaybeJson(cap.postData);
      cap.shape = summarizeShape(cap.responseJson ?? cap.responseText);
      cap.arrays = findArrays(cap.responseJson);
      if (cap.responseJson) {
        const arrays = findArrays(cap.responseJson).filter(x => x.length > 0);
        const firstArrayPath = arrays[0]?.path;
        cap.firstDataArrayPath = firstArrayPath || '';
      }
    } catch (err) {
      cap.bodyError = err.message;
    }
  }

  const pageInfo = await evaluate(cdp.send, `(() => ({
    href: location.href,
    title: document.title,
    text: (document.body?.innerText || '').slice(0, 6000)
  }))()`);
  const output = {
    generatedAt: new Date().toISOString(),
    port: args.port,
    pageInfo,
    requestCount: captures.length,
    captures,
  };
  const file = path.join(args.outDir, `stock-age-probe-${stamp()}.json`);
  await fs.writeFile(file, JSON.stringify(output, null, 2), 'utf8');
  console.log(JSON.stringify({
    ok: true,
    file: path.relative(ROOT, file),
    href: pageInfo.href,
    requestCount: captures.length,
    statuses: captures.map(c => c.status),
    permissionWarning: /没有当前功能的权限|请主账号|无权限/.test(pageInfo.text || ''),
    arrays: captures.flatMap(c => c.arrays || []).slice(0, 8),
  }, null, 2));
  cdp.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
