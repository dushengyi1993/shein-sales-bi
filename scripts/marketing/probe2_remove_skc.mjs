// probe2: navigate to marketing list page, find activity 75956845, click into it
// and intercept all promotion API calls to find the "remove SKC" endpoint
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STORES = JSON.parse(await fs.readFile(path.join(ROOT, 'config/stores.json'), 'utf8')).stores || [];
const OUT = path.join(ROOT, 'tmp/marketing-signup/limited-discount-rescue/remove-skc-probe2-FY-2026-07-05.json');

const storeKey = 'FY';
const port = 9335;
const activityId = 75956845;
const LIST_URL = 'https://sso.geiwohuo.com/#/mbrs/marketing/list';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl; this.seq = 0; this.pending = new Map(); this.handlers = {};
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const {resolve, reject} = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        const h = this.handlers[msg.method];
        if (h) h(msg.params);
      }
    });
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, {once: true});
      this.ws.addEventListener('error', reject, {once: true});
    });
    await this.call('Runtime.enable');
    await this.call('Page.enable');
    await this.call('Network.enable');
  }
  call(method, params = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({id, method, params}));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 60000);
      this.pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
    });
  }
  async eval(expression, arg) {
    const encoded = arg === undefined ? 'undefined' : JSON.stringify(arg).replace(/</g, '\\u003c');
    const res = await this.call('Runtime.evaluate', {
      expression: `(async()=>{ const __arg=${encoded}; ${expression} })()`,
      awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails, null, 2));
    return res.result.value;
  }
  on(method, handler) { this.handlers[method] = handler; }
  close() { try { this.ws.close(); } catch {} }
}

async function httpJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return await res.json();
}

async function connect(port) {
  const pages = await httpJson(`http://127.0.0.1:${port}/json/list`);
  const page = pages.find(p => p.type === 'page' && String(p.url || '').includes('sso.geiwohuo.com')) || pages.find(p => p.type === 'page');
  if (!page) throw new Error(`No page target at CDP port ${port}`);
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();
  return cdp;
}

console.log('Launching FY browser to list page...');
const launch = spawnSync(process.execPath, [path.join(ROOT, 'scripts/launch_store_browser.mjs'), storeKey, '--visible', '--url', LIST_URL], {cwd: ROOT, encoding: 'utf8', timeout: 30000});
console.log('launch ok');

await sleep(5000);

let cdp;
let allRequests = [];
let allResponses = [];
try {
  cdp = await connect(port);
  console.log('Connected to CDP');

  // Track ALL network requests/responses
  cdp.on('Network.requestWillBeSent', (params) => {
    const url = params.request.url;
    if (url.includes('/promotion/') || url.includes('/mrs-api-prefix/') || url.includes('/mbrs/')) {
      allRequests.push({
        url, method: params.request.method,
        postData: params.request.postData ? params.request.postData.slice(0, 2000) : null,
        requestId: params.requestId,
        timestamp: params.timestamp,
      });
    }
  });

  cdp.on('Network.responseReceived', (params) => {
    const url = params.response.url;
    if (url.includes('/promotion/') || url.includes('/mrs-api-prefix/') || url.includes('/mbrs/')) {
      allResponses.push({
        url, status: params.response.status, method: params.response.requestMethod,
        requestId: params.requestId,
      });
    }
  });

  // Navigate to list page
  await cdp.eval(`location.href = __arg.url; return {href: location.href};`, {url: LIST_URL});
  await sleep(5000);

  // Check page state - find activity 75956845
  const listState = await cdp.eval(`
    const text = document.body?.innerText || '';
    // Find activity rows
    const rows = [...document.querySelectorAll('tr, .el-table__row, [class*="table-row"]')];
    const activityRows = rows.filter(r => r.textContent && r.textContent.includes('75956845'));
    // Find all links/buttons that might go to detail
    const links = [...document.querySelectorAll('a, button')].filter(el => {
      const t = (el.textContent || '').trim();
      return t.includes('详情') || t.includes('查看') || t.includes('编辑') || t.includes('管理') || t.includes('商品');
    }).map(el => ({tag: el.tagName, text: el.textContent.trim().slice(0, 80), href: el.href || '', cls: (el.className||'').toString().slice(0, 80)}));
    return {
      url: location.href, title: document.title,
      bodyLen: text.length,
      has75956845: text.includes('75956845'),
      activityRowCount: activityRows.length,
      activityRowText: activityRows.map(r => r.textContent.trim().slice(0, 300)),
      links: links.slice(0, 20),
      bodySample: text.slice(0, 2000),
    };
  `);
  console.log('List state:', JSON.stringify(listState, null, 2));

  // Try to click into the activity detail
  // First try clicking the activity name or detail link
  const clickResult = await cdp.eval(`
    // Find the row containing 75956845 and click any clickable element in it
    const rows = [...document.querySelectorAll('tr, .el-table__row, [class*="table-row"]')];
    const targetRow = rows.find(r => r.textContent && r.textContent.includes('75956845'));
    if (!targetRow) return {ok: false, reason: 'row not found'};
    // Find clickable elements
    const clickables = [...targetRow.querySelectorAll('a, button, span[class*="link"], span[class*="btn"], [class*="operate"] *')];
    const info = clickables.map(el => ({tag: el.tagName, text: (el.textContent||'').trim().slice(0, 50), cls: (el.className||'').toString().slice(0, 80)}));
    // Try clicking "详情" or the activity name
    const detailBtn = clickables.find(el => (el.textContent||'').includes('详情') || (el.textContent||'').includes('查看') || (el.textContent||'').includes('管理'));
    if (detailBtn) { detailBtn.click(); return {ok: true, clicked: detailBtn.textContent.trim().slice(0, 50), info: info.slice(0, 15)}; }
    // Try clicking the activity name (usually a link)
    const nameLink = clickables.find(el => (el.textContent||'').includes('限时折扣') || (el.textContent||'').includes('必备兜底'));
    if (nameLink) { nameLink.click(); return {ok: true, clicked: nameLink.textContent.trim().slice(0, 50), info: info.slice(0, 15)}; }
    return {ok: false, reason: 'no clickable detail button found', info: info.slice(0, 15)};
  `);
  console.log('Click result:', JSON.stringify(clickResult, null, 2));

  await sleep(5000);

  // Check what page we're on now
  const afterClickState = await cdp.eval(`
    const text = document.body?.innerText || '';
    const removeBtns = [...document.querySelectorAll('button, a, span, i, [class*="icon"]')].filter(el => {
      const t = (el.textContent || '').trim().toLowerCase();
      const c = (el.className || '').toString().toLowerCase();
      const title = (el.title || '').toLowerCase();
      return t.includes('移除') || t.includes('删除') || t.includes('remove') || t.includes('delete')
        || c.includes('remove') || c.includes('delete') || c.includes('close')
        || title.includes('移除') || title.includes('删除');
    }).map(el => ({
      tag: el.tagName, text: (el.textContent||'').trim().slice(0, 80),
      cls: (el.className||'').toString().slice(0, 100), title: el.title||'',
      visible: el.offsetParent !== null,
    }));
    // Also find table rows with SKC info
    const tableRows = [...document.querySelectorAll('tr, .el-table__row')];
    const skcRows = tableRows.filter(r => r.textContent && (r.textContent.includes('SKC') || r.textContent.includes('sb') || r.textContent.includes('sv'))).length;
    return {
      url: location.href, title: document.title,
      bodyLen: text.length,
      removeBtnCount: removeBtns.length,
      removeBtns: removeBtns.slice(0, 15),
      tableRowCount: tableRows.length,
      skcRowCount: skcRows,
      bodySample: text.slice(0, 2000),
    };
  `);
  console.log('After click state:', JSON.stringify(afterClickState, null, 2));

  // Wait a bit more for any lazy-loaded content
  await sleep(3000);

  // Final check for remove buttons after full page load
  const finalState = await cdp.eval(`
    const text = document.body?.innerText || '';
    // Broader search for any delete/remove/cancel icons near SKC rows
    const allIcons = [...document.querySelectorAll('[class*="delete"], [class*="remove"], [class*="close"], [class*="cancel"], i.el-icon-delete, i.el-icon-close')];
    const allBtns = [...document.querySelectorAll('button')].filter(b => {
      const t = (b.textContent||'').trim().toLowerCase();
      return t.includes('移除') || t.includes('删除') || t.includes('取消') || t.includes('remove') || t.includes('delete');
    });
    // Check for hover-operated delete buttons in table rows
    const tableRows = [...document.querySelectorAll('.el-table__row, tr')];
    const rowOperations = tableRows.slice(0, 5).map(r => ({
      text: r.textContent.trim().slice(0, 200),
      hasDeleteIcon: !!r.querySelector('[class*="delete"], [class*="remove"], [class*="close"]'),
      buttons: [...r.querySelectorAll('button, [class*="operate"], [class*="action"]')].map(b => b.textContent.trim().slice(0, 30)),
    }));
    return {
      url: location.href,
      iconCount: allIcons.length,
      icons: allIcons.slice(0, 10).map(el => ({tag: el.tagName, cls: (el.className||'').toString().slice(0, 80), text: (el.textContent||'').trim().slice(0, 30)})),
      btnCount: allBtns.length,
      btns: allBtns.slice(0, 10).map(b => b.textContent.trim().slice(0, 50)),
      rowOperations,
      bodySample: text.slice(0, 3000),
    };
  `);
  console.log('Final state:', JSON.stringify(finalState, null, 2));

  // Save all captured network traffic
  const result = {
    createdAt: new Date().toISOString(),
    storeKey, activityId,
    listState, clickResult, afterClickState, finalState,
    allRequests: allRequests.slice(0, 100),
    allResponses: allResponses.slice(0, 100),
    note: 'Read-only probe. No remove/delete was executed. Only network traffic was observed.',
  };
  await fs.writeFile(OUT, JSON.stringify(result, null, 2), 'utf8');
  console.log('Result saved to', OUT);
  console.log('Total requests captured:', allRequests.length, 'responses:', allResponses.length);

} finally {
  if (cdp) cdp.close();
  console.log('Closing FY browser...');
  const close = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts/close_store_browsers.ps1'), '-Stores', 'FY'], {cwd: ROOT, encoding: 'utf8', timeout: 15000});
  console.log('close ok');
}
