// probe_remove_skc_v5.mjs
// v5: 从营销工具页面点击"创建记录"找到已有限时折扣活动管理入口
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STORES = JSON.parse(await fs.readFile(path.join(ROOT, 'config/stores.json'), 'utf8')).stores || [];
const OUT = path.join(ROOT, 'tmp/marketing-signup/limited-discount-rescue/remove-skc-probe-v5-FY-2026-07-05.json');

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

  cdp.on('Network.requestWillBeSent', (params) => {
    const url = params.request.url;
    if (url.includes('/mrs-api-prefix/') || url.includes('/promotion/') || url.includes('/mbrs/') || url.includes('/mars/')) {
      allRequests.push({url, method: params.request.method, postData: params.request.postData ? params.request.postData.slice(0, 2000) : null});
    }
  });
  cdp.on('Network.responseReceived', (params) => {
    const url = params.response.url;
    if (url.includes('/mrs-api-prefix/') || url.includes('/promotion/') || url.includes('/mbrs/') || url.includes('/mars/')) {
      allResponses.push({url, status: params.response.status, method: params.response.requestMethod});
    }
  });

  // Step 1: Click "创建记录" tab on the tools page
  console.log('Clicking 创建记录...');
  const clickResult = await cdp.eval(`
    // Find and click "创建记录" tab
    const tabs = [...document.querySelectorAll('a, button, span, div, [class*="tab"]')];
    const createRecordTab = tabs.find(el => (el.textContent||'').trim() === '创建记录');
    if (createRecordTab) {
      createRecordTab.click();
      return {clicked: true, text: createRecordTab.textContent, tag: createRecordTab.tagName};
    }
    return {clicked: false, reason: '创建记录 tab not found'};
  `);
  console.log('Click result:', JSON.stringify(clickResult, null, 2));
  await sleep(3000);

  // Step 2: Check the page after clicking 创建记录
  const recordPage = await cdp.eval(`
    const text = document.body?.innerText || '';
    const allLinks = [...document.querySelectorAll('a, button, [class*="operate"], [class*="action"], [class*="edit"], [class*="manage"]')];
    const activityLinks = allLinks.filter(el => {
      const t = (el.textContent||'').trim();
      const h = el.getAttribute?.('href') || '';
      return t.includes('编辑') || t.includes('管理') || t.includes('配置') || t.includes('查看') || t.includes('详情') || t.includes('移除') || t.includes('删除') || h.includes('edit') || h.includes('manage') || h.includes('config');
    }).map(el => ({tag: el.tagName, text: (el.textContent||'').trim().slice(0,50), href: el.getAttribute?.('href') || '', cls: (el.className||'').toString().slice(0,80), visible: el.offsetParent !== null}));
    const tableRows = [...document.querySelectorAll('table tr, .el-table__row, [class*="table"] [class*="row"]')].slice(0, 10).map(el => (el.textContent||'').trim().slice(0, 300));
    const hasActivity = text.includes(String(__arg.activityId)) || text.includes('必备兜底');
    return {url: location.href, title: document.title, bodyLen: text.length, bodySample: text.slice(0, 1500), hasActivity, activityLinks: activityLinks.slice(0, 20), tableRows, tableRowCount: document.querySelectorAll('table tr, .el-table__row, [class*="table"] [class*="row"]').length};
  `, {activityId});
  console.log('Record page:', JSON.stringify(recordPage, null, 2));

  // Step 3: Try to find activity 75956845 in the list and click edit
  if (recordPage.hasActivity || recordPage.tableRowCount > 0) {
    console.log('Looking for activity', activityId, '...');
    const findResult = await cdp.eval(`
      // Look for the activity ID in table rows
      const rows = [...document.querySelectorAll('table tr, .el-table__row, [class*="table"] [class*="row"]')];
      const targetRow = rows.find(r => (r.textContent||'').includes(String(__arg.activityId)));
      if (targetRow) {
        // Find edit/manage/remove buttons in this row
        const buttons = [...targetRow.querySelectorAll('button, a, [class*="operate"], [class*="action"], [class*="edit"]')];
        const rowButtons = buttons.map(b => ({tag: b.tagName, text: (b.textContent||'').trim().slice(0,50), cls: (b.className||'').toString().slice(0,80), href: b.getAttribute?.('href')||'', visible: b.offsetParent !== null}));
        return {found: true, rowText: (targetRow.textContent||'').trim().slice(0, 300), rowButtons};
      }
      return {found: false, reason: 'activity row not found', rowCount: rows.length};
    `, {activityId});
    console.log('Find result:', JSON.stringify(findResult, null, 2));

    // If we found the row, click edit/manage
    if (findResult.found && findResult.rowButtons) {
      const editBtn = findResult.rowButtons.find(b => b.text.includes('编辑') || b.text.includes('管理') || b.text.includes('配置'));
      if (editBtn) {
        console.log('Clicking edit button:', editBtn.text);
        // Set up Fetch interception before clicking
        await cdp.call('Fetch.enable', {patterns: [{urlPattern: '*', requestStage: 'Request'}], handleAuthRequests: false});
        const captured = [];
        cdp.on('Fetch.requestPaused', async (params) => {
          const url = params.request.url;
          if (url.includes('/promotion/') || url.includes('/mrs-api-prefix/') && (url.includes('delete') || url.includes('remove') || url.includes('del') || url.includes('update') || url.includes('edit') || url.includes('save') || url.includes('activity_goods'))) {
            let postData = params.request.postData;
            if (!postData && params.request.hasPostData) {
              try { const r = await cdp.call('Network.getRequestPostData', {requestId: params.requestId}); postData = r.postData; } catch {}
            }
            captured.push({url, method: params.request.method, postData: postData ? postData.slice(0, 2000) : null});
            console.log('CAPTURED:', params.request.method, url);
          }
          try { await cdp.call('Fetch.continueRequest', {requestId: params.requestId}); } catch {}
        });

        // Click the edit button
        await cdp.eval(`
          const rows = [...document.querySelectorAll('table tr, .el-table__row, [class*="table"] [class*="row"]')];
          const targetRow = rows.find(r => (r.textContent||'').includes(String(__arg.activityId)));
          if (targetRow) {
            const btn = [...targetRow.querySelectorAll('button, a')].find(b => (b.textContent||'').includes('编辑') || (b.textContent||'').includes('管理') || (b.textContent||'').includes('配置'));
            if (btn) btn.click();
          }
        `, {activityId});
        await sleep(4000);

        // Check what page we're on now
        const editPage = await cdp.eval(`
          const text = document.body?.innerText || '';
          const removeTexts = [...document.querySelectorAll('button, a, span, div, i, [class*="icon"]')].filter(el => {
            const t = (el.textContent||'').trim().toLowerCase();
            const c = (el.className||'').toString().toLowerCase();
            const title = (el.title||'').toLowerCase();
            return t.includes('移除') || t.includes('删除') || t.includes('remove') || t.includes('delete') || c.includes('remove') || c.includes('delete') || title.includes('移除') || title.includes('删除');
          }).map(el => ({tag: el.tagName, text: (el.textContent||'').trim().slice(0,50), cls: (el.className||'').toString().slice(0,80), title: el.title||'', visible: el.offsetParent !== null}));
          const tableRows = [...document.querySelectorAll('table tr, .el-table__row, [class*="table"] [class*="row"]')].slice(0, 5).map(el => (el.textContent||'').trim().slice(0, 200));
          return {url: location.href, title: document.title, bodyLen: text.length, bodySample: text.slice(0, 1000), removeTexts: removeTexts.slice(0, 15), tableRows, tableRowCount: document.querySelectorAll('table tr, .el-table__row, [class*="table"] [class*="row"]').length};
        `);
        console.log('Edit page:', JSON.stringify(editPage, null, 2));

        const result = {createdAt: new Date().toISOString(), storeKey, activityId, clickResult, recordPage, findResult, editPage, capturedRequests: captured, allRequests: allRequests.slice(0, 50), note: 'Read-only probe v5.'};
        await fs.writeFile(OUT, JSON.stringify(result, null, 2), 'utf8');
        console.log('Result saved to', OUT);
      }
    }
  }

  // Fallback: also try direct URL patterns for the activity edit page
  const editUrls = [
    'https://sso.geiwohuo.com/#/mars/tools/limited-discount/edit/' + activityId,
    'https://sso.geiwohuo.com/#/mars/tools/limited-discount/config/' + activityId,
    'https://sso.geiwohuo.com/#/mars/tools/limited-discount/manage/' + activityId,
    'https://sso.geiwohuo.com/#/mars/tools/limited-discount/detail/' + activityId,
    'https://sso.geiwohuo.com/#/mars/tools/discount/edit/' + activityId,
    'https://sso.geiwohuo.com/#/mars/tools/discount/config/' + activityId,
    'https://sso.geiwohuo.com/#/mars/tools/discount/manage/' + activityId,
    'https://sso.geiwohuo.com/#/mars/tools/discount/detail/' + activityId,
  ];
  for (const url of editUrls) {
    console.log('Trying edit URL:', url);
    await cdp.eval('location.href = __arg.url; return {href: location.href};', {url});
    await sleep(3000);
    const state = await cdp.eval(`
      const text = document.body?.innerText || '';
      const hasGoods = text.includes('商品') && (text.includes('SKC') || text.includes('供方货号') || text.includes('价格'));
      const removeTexts = [...document.querySelectorAll('button, a, span, div, i')].filter(el => {
        const t = (el.textContent||'').trim().toLowerCase();
        return t.includes('移除') || t.includes('删除') || t.includes('remove') || t.includes('delete');
      }).map(el => ({tag: el.tagName, text: (el.textContent||'').trim().slice(0,50), cls: (el.className||'').toString().slice(0,80), visible: el.offsetParent !== null}));
      return {url: location.href, bodyLen: text.length, bodySample: text.slice(0, 600), hasGoods, removeTexts: removeTexts.slice(0, 10), tableRowCount: document.querySelectorAll('table tr, .el-table__row, [class*="table"] [class*="row"]').length};
    `);
    console.log('  bodyLen:', state.bodyLen, 'hasGoods:', state.hasGoods, 'remove:', state.removeTexts.length, 'rows:', state.tableRowCount);
    if (state.hasGoods && state.removeTexts.length > 0) {
      console.log('  >>> FOUND edit page with remove buttons!');
      break;
    }
  }

  const result = {createdAt: new Date().toISOString(), storeKey, activityId, clickResult, recordPage, allRequests: allRequests.slice(0, 100), note: 'Read-only probe v5.'};
  await fs.writeFile(OUT, JSON.stringify(result, null, 2), 'utf8');
  console.log('Result saved to', OUT);
} finally {
  if (cdp) cdp.close();
  console.log('Closing FY browser...');
  const close = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts/close_store_browsers.ps1'), '-Stores', 'FY'], {cwd: ROOT, encoding: 'utf8', timeout: 15000});
  console.log('close stdout:', close.stdout?.slice(0, 300));
}
