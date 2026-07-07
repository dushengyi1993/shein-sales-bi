#!/usr/bin/env node
const port = Number(process.argv[2] || 9333);
const expr = process.argv.slice(3).join(' ') || '({title: document.title, url: location.href, text: document.body?.innerText?.slice(0, 2000)})';

const pagesResp = await fetch(`http://127.0.0.1:${port}/json/list`);
const pages = await pagesResp.json();
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
const result = await send('Runtime.evaluate', {
  expression: expr,
  awaitPromise: true,
  returnByValue: true,
});
ws.close();
if (result.exceptionDetails) {
  console.error(JSON.stringify(result.exceptionDetails, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(result.result.value, null, 2));
