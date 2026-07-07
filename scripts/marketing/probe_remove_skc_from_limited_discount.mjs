// probe_remove_skc_from_limited_discount.mjs
// 只读抓包：启动 FY 浏览器，导航到限时折扣活动编辑页，
// 用 CDP Fetch 拦截"移除/删除商品"的请求，抓到后 abort，不真的执行移除。
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STORES = JSON.parse(await fs.readFile(path.join(ROOT, 'config/stores.json'), 'utf8')).stores || [];
const OUT = path.join(ROOT, 'tmp/marketing-signup/limited-discount-rescue/remove-skc-probe-FY-2026-07-05.json');

const storeKey = 'FY';
const port = 9335;
const activityId = 75956845;
const EDIT_URL = `https://sso.geiwohuo.com/#/mbrs/marketing/sign-up/config/${activityId}`;
const store = STORES.find(s => s.storeKey === storeKey);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl; this.seq = 0; this.pending = new Map(); this.events = [];
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
        this.events.push(msg);
        // Call any registered handler
        const h = this.handlers?.[msg.method];
        if (h) h(msg.params);
      }
    });
    this.handlers = {};
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

// Step 1: Launch FY browser
console.log('Launching FY browser...');
const launch = spawnSync(process.execPath, [path.join(ROOT, 'scripts/launch_store_browser.mjs'), storeKey, '--visible', '--url', EDIT_URL], {cwd: ROOT, encoding: 'utf8', timeout: 30000});
console.log('launch stdout:', launch.stdout?.slice(0, 500));
console.log('launch stderr:', launch.stderr?.slice(0, 500));

await sleep(5000);

let cdp;
let captured = [];
try {
  cdp = await connect(port);
  console.log('Connected to CDP');

  // Navigate to edit page
  await cdp.eval(`location.href = __arg.url; return {href: location.href};`, {url: EDIT_URL});
  await sleep(4000);

  // Check login state
  const loginState = await cdp.eval(`
    const text = document.body?.innerText || '';
    const hasLogin = text.includes('登录') || text.includes('密码') || text.includes('继续登录');
    const hasActivity = text.includes('限时折扣') || text.includes('活动') || text.includes('商品');
    return {url: location.href, title: document.title, hasLogin, hasActivity, bodyLen: text.length, bodySample: text.slice(0, 800)};
  `);
  console.log('Login state:', JSON.stringify(loginState, null, 2));

  // Set up Fetch interception to capture delete/remove requests but abort them
  await cdp.call('Fetch.enable', {
    patterns: [
      {urlPattern: '*', requestStage: 'Request'},
    ],
    handleAuthRequests: false,
  });

  cdp.on('Fetch.requestPaused', async (params) => {
    const url = params.request.url;
    const method = params.request.request;
    // Only capture promotion-related requests, let others through
    if (url.includes('/promotion/') || url.includes('/mrs-api-prefix/') || url.includes('delete') || url.includes('remove') || url.includes('del') || url.includes('activity_goods') || url.includes('update_activity') || url.includes('save_activity') || url.includes('edit_activity')) {
      let postData = null;
      try {
        if (params.request.postData) {
          postData = params.request.postData;
        } else if (params.request.hasPostData) {
          // Try to get post data via Network.getRequestPostData
          try {
            const r = await cdp.call('Network.getRequestPostData', {requestId: params.requestId});
            postData = r.postData;
          } catch {}
        }
      } catch {}
      captured.push({
        url,
        method: params.request.method,
        headers: params.request.headers,
        postData: postData ? postData.slice(0, 2000) : null,
        resourceType: params.resourceType,
        requestId: params.requestId,
      });
      console.log(`CAPTURED: ${params.request.method} ${url} postData=${postData ? postData.slice(0, 300) : 'none'}`);
      // Abort this request to prevent any real write
      try {
        await cdp.call('Fetch.failRequest', {requestId: params.requestId, errorReason: 'Aborted'});
      } catch (e) {
        // If fail fails, try continue
        try { await cdp.call('Fetch.continueRequest', {requestId: params.requestId}); } catch {}
      }
    } else {
      // Let non-promotion requests through
      try {
        await cdp.call('Fetch.continueRequest', {requestId: params.requestId});
      } catch (e) {
        console.log('continueRequest error:', e.message);
      }
    }
  });

  // Also capture Network responses for context
  const networkRequests = [];
  cdp.on('Network.requestWillBeSent', (params) => {
    const url = params.request.url;
    if (url.includes('/promotion/') || url.includes('/mrs-api-prefix/')) {
      networkRequests.push({
        url,
        method: params.request.method,
        postData: params.request.postData ? params.request.postData.slice(0, 500) : null,
        requestId: params.requestId,
      });
    }
  });

  // Now try to find and click "remove/delete" button for a SKC on the page
  // First, let's see what's on the page
  const pageState = await cdp.eval(`
    // Find all buttons/links with remove/delete text
    const allElements = [...document.querySelectorAll('button, a, span, div, i')];
    const removeButtons = allElements.filter(el => {
      const text = (el.textContent || '').trim().toLowerCase();
      const cls = (el.className || '').toString().toLowerCase();
      const title = (el.title || '').toLowerCase();
      return text.includes('移除') || text.includes('删除') || text.includes('remove') || text.includes('delete')
        || cls.includes('remove') || cls.includes('delete') || title.includes('移除') || title.includes('删除');
    }).map(el => ({
      tag: el.tagName, text: (el.textContent || '').trim().slice(0, 100),
      cls: (el.className || '').toString().slice(0, 100),
      id: el.id || '', title: el.title || '',
      visible: el.offsetParent !== null,
      rect: el.getBoundingClientRect ? (() => { const r = el.getBoundingClientRect(); return {x: r.x, y: r.y, w: r.width, h: r.height}; })() : null,
    }));
    return {
      url: location.href,
      title: document.title,
      removeButtonCount: removeButtons.length,
      removeButtons: removeButtons.slice(0, 20),
      tableRows: document.querySelectorAll('table tr, .el-table__row, [class*="table"] [class*="row"]').length,
      bodySample: (document.body?.innerText || '').slice(0, 1500),
    };
  `);
  console.log('Page state:', JSON.stringify(pageState, null, 2));

  // Wait a bit and collect any captured requests
  await sleep(3000);

  // Save results
  const result = {
    createdAt: new Date().toISOString(),
    storeKey, activityId, editUrl: EDIT_URL,
    pageState,
    capturedFetchRequests: captured,
    networkRequests: networkRequests.slice(0, 50),
    note: 'Read-only probe. No remove/delete was actually executed. Fetch interception was set to abort promotion write requests.',
  };
  await fs.writeFile(OUT, JSON.stringify(result, null, 2), 'utf8');
  console.log('Result saved to', OUT);
  console.log('Captured', captured.length, 'fetch requests,', networkRequests.length, 'network requests');

} finally {
  if (cdp) cdp.close();
  // Close FY browser
  console.log('Closing FY browser...');
  const close = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts/close_store_browsers.ps1'), '-Stores', 'FY'], {cwd: ROOT, encoding: 'utf8', timeout: 15000});
  console.log('close stdout:', close.stdout?.slice(0, 300));
  console.log('close stderr:', close.stderr?.slice(0, 300));
}
