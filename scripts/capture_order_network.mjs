#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const port = Number(process.argv[2] || 9333);
const seconds = Number(process.argv[3] || 10);
const outDir = process.argv[4] || 'outputs/captures';
const match = /\/gsp\/orderPlus\/(listOrder|listOrderItem|list\/statistics|list\/listCount)/i;

const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = pages.find(p => p.type === 'page');
if (!page) throw new Error(`No page target on port ${port}`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const requests = new Map();
const captured = [];

ws.addEventListener('message', async ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const {resolve, reject} = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
    return;
  }
  if (msg.method === 'Network.requestWillBeSent') {
    const {requestId, request} = msg.params;
    if (match.test(request.url)) {
      requests.set(requestId, {
        requestId,
        url: request.url,
        method: request.method,
        postData: request.postData || null,
        requestHeaders: request.headers || {},
        ts: Date.now(),
      });
    }
  }
  if (msg.method === 'Network.responseReceived') {
    const item = requests.get(msg.params.requestId);
    if (item) {
      item.status = msg.params.response.status;
      item.mimeType = msg.params.response.mimeType;
      item.responseHeaders = msg.params.response.headers;
    }
  }
  if (msg.method === 'Network.loadingFinished') {
    const item = requests.get(msg.params.requestId);
    if (item) {
      item.encodedDataLength = msg.params.encodedDataLength;
      captured.push(item);
    }
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
await send('Network.enable', {maxResourceBufferSize: 1024 * 1024 * 20, maxTotalBufferSize: 1024 * 1024 * 50});
await send('Page.enable');
await send('Page.reload', {ignoreCache: true});
await new Promise(r => setTimeout(r, seconds * 1000));

const results = [];
for (const item of captured) {
  try {
    const body = await send('Network.getResponseBody', {requestId: item.requestId});
    item.responseBody = body.base64Encoded ? '[base64 omitted]' : body.body;
  } catch (err) {
    item.responseBodyError = String(err.message || err);
  }
  results.push(item);
}
ws.close();
await fs.mkdir(outDir, {recursive: true});
const file = path.join(outDir, `dl-order-network-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await fs.writeFile(file, JSON.stringify({port, url: page.url, capturedAt: new Date().toISOString(), results}, null, 2), 'utf8');
console.log(JSON.stringify({file, count: results.length, endpoints: results.map(r => ({url: r.url, method: r.method, status: r.status, postData: r.postData, bodyPreview: (r.responseBody || '').slice(0, 500)}))}, null, 2));
