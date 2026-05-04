#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const port = Number(process.argv[2] || 9333);
const endpoint = process.argv[3] || '/gsp/orderPlus/listOrderItem';
const payloadArg = process.argv[4] || '{}';
const outDir = process.argv[5] || 'outputs/probes';

let payloadSource = payloadArg;
if (payloadArg.startsWith('@')) {
  payloadSource = await fs.readFile(payloadArg.slice(1), 'utf8');
}
payloadSource = payloadSource.replace(/^\uFEFF/, '').trim();

let payload;
try {
  payload = JSON.parse(payloadSource);
} catch (err) {
  throw new Error(`Invalid JSON payload: ${err.message}`);
}

const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = pages.find(p => p.type === 'page');
if (!page) throw new Error(`No page target on port ${port}`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();

ws.addEventListener('message', ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const {resolve, reject} = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, {once: true});
  ws.addEventListener('error', reject, {once: true});
});

function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({id, method, params}));
  return new Promise((resolve, reject) => pending.set(id, {resolve, reject}));
}

await send('Runtime.enable');
const expression = `(() => {
  const endpoint = ${JSON.stringify(endpoint)};
  const payload = ${JSON.stringify(payload)};
  return fetch(endpoint, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json;Charset=utf-8',
      'Origin-Path': '/order-management/list',
      'Origin-Url': location.origin + '/#/gsp/order-management/list',
      'build-version': '2026-04-23 11:38'
    },
    body: JSON.stringify(payload)
  }).then(async res => {
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return {
      url: res.url,
      status: res.status,
      statusText: res.statusText,
      contentType: res.headers.get('content-type'),
      payload,
      text,
      json
    };
  });
})()`;

const result = await send('Runtime.evaluate', {
  expression,
  awaitPromise: true,
  returnByValue: true,
});
ws.close();

if (result.exceptionDetails) {
  console.error(JSON.stringify(result.exceptionDetails, null, 2));
  process.exit(1);
}

const value = result.result.value;
await fs.mkdir(outDir, {recursive: true});
const safeEndpoint = endpoint.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
const file = path.join(outDir, `${safeEndpoint}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');

let dataCount = null;
const info = value?.json?.info;
if (Array.isArray(info?.data)) dataCount = info.data.length;
else if (Array.isArray(info)) dataCount = info.length;

console.log(JSON.stringify({
  file,
  endpoint,
  status: value?.status,
  code: value?.json?.code,
  msg: value?.json?.msg,
  dataCount,
  textPreview: (value?.text || '').slice(0, 500),
}, null, 2));
