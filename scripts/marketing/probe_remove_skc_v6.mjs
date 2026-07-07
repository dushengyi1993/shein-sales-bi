// probe_remove_skc_v6.mjs
// v6: 点击"剔除商品"按钮，抓包记录接口
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STORES = JSON.parse(await fs.readFile(path.join(ROOT, 'config/stores.json'), 'utf8')).stores || [];
const OUT = path.join(ROOT, 'tmp/marketing-signup/limited-discount-rescue/remove-skc-probe-v6-FY-2026-07-05.json');

const storeKey = 'FY';
const port = 9335;
const activityId = 75956845;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.seq = 0; this.pending = new Map(); this.handlers = {}; }
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
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout ' + method)); }, 60000);
      this.pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
    });
  }
  async eval(expression, arg) {
    const encoded = arg === undefined ? 'undefined' : JSON.stringify(arg).replace(/</g, '\\u003c');
    const res = await this.call('Runtime.evaluate', {
      expression: '(async()=>{ const __arg=' + encoded + '; ' + expression + ' })()',
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
  if (!res.ok) throw new Error(url + ' ' + res.status);
  return await res.json();
}

async function connect(port) {
  const pages = await httpJson('http://127.0.0.1:' + port + '/json/list');
  const page = pages.find(p => p.type === 'page' && String(p.url || '').includes('sso.geiwohuo.com')) || pages.find(p => p.type === 'page');
  if (!page) throw new Error('No page target at CDP port ' + port);
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();
  return cdp;
}

console.log('Launching FY browser...');
const launch = spawnSync(process.execPath, [path.join(ROOT, 'scripts/launch_store_browser.mjs'), storeKey, '--visible', '--url', 'https://sso.geiwohuo.com/#/mars/tools/list'], {cwd: ROOT, encoding: 'utf8', timeout: 30000});
console.log('launch stdout:', launch.stdout?.slice(0, 500));

await sleep(6000);

let cdp;
const allRequests = [];
const allResponses = [];
try {
  cdp = await connect(port);
  console.log('Connected to CDP');

  // Capture ALL network requests
  cdp.on('Network.requestWillBeSent', (params) => {
    const url = params.request.url;
    if (url.includes('/mrs-api-prefix/') || url.includes('/promotion/') || url.includes('/mbrs/') || url.includes('/mars/')) {
      allRequests.push({url, method: params.request.method, postData: params.request.postData ? params.request.postData.slice(0, 3000) : null, requestId: params.requestId});
    }
  });
  cdp.on('Network.responseReceived', (params) => {
    const url = params.response.url;
    if (url.includes('/mrs-api-prefix/') || url.includes('/promotion/') || url.includes('/mbrs/') || url.includes('/mars/')) {
      allResponses.push({url, status: params.response.status, method: params.response.requestMethod, requestId: params.requestId});
    }
  });

  // Step 1: Click "创建记录" tab
  console.log('Clicking 创建记录...');
  await cdp.eval(`
    const tabs = [...document.querySelectorAll('a, button, span, div, [class*="tab"]')];
    const createRecordTab = tabs.find(el => (el.textContent||'').trim() === '创建记录');
    if (createRecordTab) createRecordTab.click();
  `);
  await sleep(3000);

  // Step 2: Click "剔除商品" button for activity 75956845
  console.log('Clicking 剔除商品 for activity', activityId, '...');
  await cdp.eval(`
    const rows = [...document.querySelectorAll('table tr, .el-table__row, [class*="table"] [class*="row"]')];
    const targetRow = rows.find(r => (r.textContent||'').includes(String(__arg.activityId)));
    if (targetRow) {
      const btn = [...targetRow.querySelectorAll('button')].find(b => (b.textContent||'').includes('剔除商品'));
      if (btn) btn.click();
    }
  `, {activityId});
  await sleep(4000);

  // Step 3: Check what page/dialog appeared after clicking 剔除商品
  const afterClick = await cdp.eval(`
    const text = document.body?.innerText || '';
    // Check for modal/dialog
    const modals = [...document.querySelectorAll('[class*="modal"], [class*="dialog"], [class*="drawer"], [class*="popup"], [role="dialog"]')];
    const visibleModals = modals.filter(el => el.offsetParent !== null).map(el => ({
      tag: el.tagName,
      cls: (el.className||'').toString().slice(0, 100),
      text: (el.innerText||'').slice(0, 1000),
      visible: true,
    }));
    // Check for table with goods/SKCs
    const tableRows = [...document.querySelectorAll('table tr, .el-table__row, [class*="table"] [class*="row"]')].slice(0, 10).map(el => (el.textContent||'').trim().slice(0, 300));
    // Check for remove/delete buttons
    const removeButtons = [...document.querySelectorAll('button, a, [class*="icon"], [class*="operate"]')].filter(el => {
      const t = (el.textContent||'').trim().toLowerCase();
      const c = (el.className||'').toString().toLowerCase();
      const title = (el.title||'').toLowerCase();
      return t.includes('移除') || t.includes('删除') || t.includes('剔除') || t.includes('remove') || t.includes('delete') || c.includes('remove') || c.includes('delete') || title.includes('移除') || title.includes('删除') || title.includes('剔除');
    }).map(el => ({tag: el.tagName, text: (el.textContent||'').trim().slice(0,50), cls: (el.className||'').toString().slice(0,80), title: el.title||'', visible: el.offsetParent !== null}));
    // Check for checkboxes (select goods to remove)
    const checkboxes = document.querySelectorAll('input[type="checkbox"], [class*="checkbox"]').length;
    return {url: location.href, title: document.title, bodyLen: text.length, bodySample: text.slice(0, 1500), visibleModals: visibleModals.slice(0, 3), tableRows, removeButtons: removeButtons.slice(0, 20), checkboxes, tableRowCount: document.querySelectorAll('table tr, .el-table__row, [class*="table"] [class*="row"]').length};
  `);
  console.log('After click:', JSON.stringify(afterClick, null, 2));

  // Step 4: Wait a bit more and check for any new requests
  await sleep(2000);

  // Save results
  const result = {
    createdAt: new Date().toISOString(),
    storeKey, activityId,
    afterClick,
    allRequests: allRequests.slice(-50),
    allResponses: allResponses.slice(-50),
    note: 'Read-only probe v6. Clicked 剔除商品 button but did NOT confirm any removal. Only observed the UI and network requests.',
  };
  await fs.writeFile(OUT, JSON.stringify(result, null, 2), 'utf8');
  console.log('Result saved to', OUT);
  console.log('Total requests captured:', allRequests.length);
  console.log('Total responses captured:', allResponses.length);

} finally {
  if (cdp) cdp.close();
  console.log('Closing FY browser...');
  const close = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts/close_store_browsers.ps1'), '-Stores', 'FY'], {cwd: ROOT, encoding: 'utf8', timeout: 15000});
  console.log('close stdout:', close.stdout?.slice(0, 300));
}
