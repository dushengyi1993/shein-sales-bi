// probe_remove_skc_v4.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STORES = JSON.parse(await fs.readFile(path.join(ROOT, 'config/stores.json'), 'utf8')).stores || [];
const OUT = path.join(ROOT, 'tmp/marketing-signup/limited-discount-rescue/remove-skc-probe-v4-FY-2026-07-05.json');

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
console.log('launch stderr:', launch.stderr?.slice(0, 500));

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

  // Step 1: Check what's on the mars/tools/list page
  console.log('Checking mars/tools/list page...');
  const toolsPage = await cdp.eval(`
    const text = document.body?.innerText || '';
    const allLinks = [...document.querySelectorAll('a, [class*="tool"], [class*="card"], [class*="item"]')];
    const discountLinks = allLinks.filter(el => {
      const t = (el.textContent||'').trim();
      const h = el.getAttribute?.('href') || '';
      return t.includes('限时折扣') || t.includes('限时') || t.includes('折扣') || h.includes('discount') || h.includes('flash') || h.includes('limited');
    }).map(el => ({tag: el.tagName, text: (el.textContent||'').trim().slice(0,100), href: el.getAttribute?.('href') || '', cls: (el.className||'').toString().slice(0,80), visible: el.offsetParent !== null}));
    return {url: location.href, title: document.title, bodyLen: text.length, bodySample: text.slice(0, 1200), discountLinks: discountLinks.slice(0, 20)};
  `);
  console.log('Tools page:', JSON.stringify(toolsPage, null, 2));

  // Step 2: Try common limited discount URLs based on /mars/ prefix
  const discountUrls = [
    'https://sso.geiwohuo.com/#/mars/tools/limited-discount/list',
    'https://sso.geiwohuo.com/#/mars/tools/limited-discount',
    'https://sso.geiwohuo.com/#/mars/limited-discount/list',
    'https://sso.geiwohuo.com/#/mars/limited-discount',
    'https://sso.geiwohuo.com/#/mars/tools/discount/list',
    'https://sso.geiwohuo.com/#/mars/tools/discount',
    'https://sso.geiwohuo.com/#/mars/discount/list',
    'https://sso.geiwohuo.com/#/mars/discount',
    'https://sso.geiwohuo.com/#/mars/tools/flash-sale/list',
    'https://sso.geiwohuo.com/#/mars/tools/flash-sale',
    'https://sso.geiwohuo.com/#/mbrs/marketing/tool/limited-discount',
    'https://sso.geiwohuo.com/#/mbrs/marketing/tool/discount',
  ];

  let foundUrl = null;
  let pageStates = [];
  for (const url of discountUrls) {
    console.log('Trying:', url);
    await cdp.eval('location.href = __arg.url; return {href: location.href};', {url});
    await sleep(3000);
    const state = await cdp.eval(`
      const text = document.body?.innerText || '';
      const hasActivity = text.includes('75956845') || text.includes('必备兜底') || text.includes('活动名称') || text.includes('活动ID');
      const removeTexts = [...document.querySelectorAll('button, a, span, div, i, [class*="icon"]')].filter(el => {
        const t = (el.textContent||'').trim().toLowerCase();
        const c = (el.className||'').toString().toLowerCase();
        const title = (el.title||'').toLowerCase();
        return t.includes('移除') || t.includes('删除') || t.includes('remove') || t.includes('delete') || c.includes('remove') || c.includes('delete') || title.includes('移除') || title.includes('删除');
      }).map(el => ({tag: el.tagName, text: (el.textContent||'').trim().slice(0,50), cls: (el.className||'').toString().slice(0,80), title: el.title||'', visible: el.offsetParent !== null}));
      const activityRows = [...document.querySelectorAll('table tr, .el-table__row, [class*="table"] [class*="row"], [class*="list-item"]')].slice(0, 5).map(el => (el.textContent||'').trim().slice(0, 200));
      return {url: location.href, title: document.title, bodyLen: text.length, bodySample: text.slice(0, 800), hasActivity, removeTexts: removeTexts.slice(0, 15), activityRows, tableRowCount: document.querySelectorAll('table tr, .el-table__row, [class*="table"] [class*="row"]').length};
    `);
    console.log('  bodyLen:', state.bodyLen, 'hasActivity:', state.hasActivity, 'remove:', state.removeTexts.length, 'rows:', state.tableRowCount);
    pageStates.push({url, state});
    if (state.hasActivity || (state.bodyLen > 200 && state.tableRowCount > 0)) {
      console.log('  >>> Found limited discount list page!');
      foundUrl = url;
      break;
    }
  }

  // Step 3: If we found the list page, look for activity 75956845 and edit/manage links
  if (foundUrl) {
    console.log('Looking for activity', activityId, 'on the list page...');
    const activityResult = await cdp.eval(`
      const text = document.body?.innerText || '';
      const hasActivity = text.includes(String(__arg.activityId));
      const allLinks = [...document.querySelectorAll('a, button, [class*="operate"], [class*="action"], [class*="edit"], [class*="manage"], [class*="config"]')];
      const activityLinks = allLinks.filter(el => {
        const t = (el.textContent||'').trim();
        const h = el.getAttribute?.('href') || '';
        return t.includes('编辑') || t.includes('管理') || t.includes('配置') || t.includes('查看') || t.includes('详情') || h.includes(String(__arg.activityId)) || h.includes('edit') || h.includes('manage') || h.includes('config') || h.includes('detail');
      }).map(el => ({tag: el.tagName, text: (el.textContent||'').trim().slice(0,50), href: el.getAttribute?.('href') || '', cls: (el.className||'').toString().slice(0,80), visible: el.offsetParent !== null}));
      return {hasActivity, activityLinks: activityLinks.slice(0, 20), bodySample: text.slice(0, 1500)};
    `, {activityId});
    console.log('Activity result:', JSON.stringify(activityResult, null, 2));

    if (activityResult.activityLinks && activityResult.activityLinks.length > 0) {
      const editLink = activityResult.activityLinks.find(l => l.text.includes('编辑') || l.text.includes('管理') || l.text.includes('配置'));
      if (editLink && editLink.href) {
        console.log('Clicking edit link:', editLink.href);
        await cdp.eval('location.href = __arg.url; return {href: location.href};', {url: 'https://sso.geiwohuo.com' + editLink.href});
        await sleep(4000);
        const editPage = await cdp.eval(`
          const text = document.body?.innerText || '';
          const removeTexts = [...document.querySelectorAll('button, a, span, div, i, [class*="icon"]')].filter(el => {
            const t = (el.textContent||'').trim().toLowerCase();
            const c = (el.className||'').toString().toLowerCase();
            const title = (el.title||'').toLowerCase();
            return t.includes('移除') || t.includes('删除') || t.includes('remove') || t.includes('delete') || c.includes('remove') || c.includes('delete') || title.includes('移除') || title.includes('删除');
          }).map(el => ({tag: el.tagName, text: (el.textContent||'').trim().slice(0,50), cls: (el.className||'').toString().slice(0,80), title: el.title||'', visible: el.offsetParent !== null}));
          const tableRows = [...document.querySelectorAll('table tr, .el-table__row, [class*="table"] [class*="row"]')].slice(0, 10).map(el => (el.textContent||'').trim().slice(0, 200));
          return {url: location.href, title: document.title, bodyLen: text.length, bodySample: text.slice(0, 1000), removeTexts: removeTexts.slice(0, 15), tableRows, tableRowCount: document.querySelectorAll('table tr, .el-table__row, [class*="table"] [class*="row"]').length};
        `);
        console.log('Edit page:', JSON.stringify(editPage, null, 2));
        pageStates.push({url: 'edit-page', state: editPage});
      }
    }
  }

  // Step 4: Check API for update/edit endpoints
  console.log('Checking API for update/edit endpoints...');
  const apiCheck = await cdp.eval(`
    const headers = {'content-type':'application/json;charset=UTF-8','Origin-Url':location.href,'x-req-zone-id':'Asia/Shanghai','x-lt-language':'CN','LAN':'CN'};
    async function post(url, body, route='') {
      const res = await fetch('/mrs-api-prefix' + url, {method:'POST',credentials:'include',headers: route ? {...headers,'x-bbl-route':route} : headers, body: JSON.stringify(body||{})});
      const text = await res.text(); let json; try{json=JSON.parse(text)}catch{json=null}
      return {http:res.status, code:json?.code, msg:json?.msg||text.slice(0,300), info:json?.info??json};
    }
    const detail = await post('/promotion/obm/query_obm_activity_detail', {activity_id: __arg.activityId, system: 'mrs'}, '/mbrs/marketing/list');
    return {detailCode: detail.code, detailMsg: detail.msg, detailInfo: detail.info ? 'has-info' : 'no-info', detailSample: JSON.stringify(detail.info).slice(0, 500)};
  `, {activityId});
  console.log('API check:', JSON.stringify(apiCheck, null, 2));

  const result = {createdAt: new Date().toISOString(), storeKey, activityId, toolsPage, pageStates, foundUrl, apiCheck, allRequests: allRequests.slice(0, 100), allResponses: allResponses.slice(0, 100), note: 'Read-only probe v4.'};
  await fs.writeFile(OUT, JSON.stringify(result, null, 2), 'utf8');
  console.log('Result saved to', OUT);
} finally {
  if (cdp) cdp.close();
  console.log('Closing FY browser...');
  const close = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts/close_store_browsers.ps1'), '-Stores', 'FY'], {cwd: ROOT, encoding: 'utf8', timeout: 15000});
  console.log('close stdout:', close.stdout?.slice(0, 300));
}
