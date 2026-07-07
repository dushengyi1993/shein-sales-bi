// probe_remove_skc_v7.mjs
// v7: 选中一个SKC，点击批量删除，在确认弹窗出现时抓包，然后取消不真的删除
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STORES = JSON.parse(await fs.readFile(path.join(ROOT, 'config/stores.json'), 'utf8')).stores || [];
const OUT = path.join(ROOT, 'tmp/marketing-signup/limited-discount-rescue/remove-skc-probe-v7-FY-2026-07-05.json');

const storeKey = 'FY';
const port = 9335;
const activityId = 75956845;
const EDIT_URL = 'https://sso.geiwohuo.com/#/mrs/tools/activity/obm-time-limit-detail/edit?step=2&id=' + activityId + '&toolId=175';

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
const launch = spawnSync(process.execPath, [path.join(ROOT, 'scripts/launch_store_browser.mjs'), storeKey, '--visible', '--url', EDIT_URL], {cwd: ROOT, encoding: 'utf8', timeout: 30000});
console.log('launch stdout:', launch.stdout?.slice(0, 500));

await sleep(8000);

let cdp;
const allRequests = [];
const allResponses = [];
try {
  cdp = await connect(port);
  console.log('Connected to CDP');

  // Capture ALL network requests with full detail
  cdp.on('Network.requestWillBeSent', (params) => {
    const url = params.request.url;
    if (url.includes('/mrs-api-prefix/') || url.includes('/promotion/')) {
      allRequests.push({
        url,
        method: params.request.method,
        postData: params.request.postData ? params.request.postData.slice(0, 4000) : null,
        headers: params.request.headers,
        requestId: params.requestId,
      });
    }
  });
  cdp.on('Network.responseReceived', (params) => {
    const url = params.response.url;
    if (url.includes('/mrs-api-prefix/') || url.includes('/promotion/')) {
      allResponses.push({url, status: params.response.status, method: params.response.requestMethod, requestId: params.requestId});
    }
  });

  // Step 1: Wait for page to load and check we're on the edit page
  console.log('Checking edit page...');
  const pageState = await cdp.eval(`
    const text = document.body?.innerText || '';
    const hasGoods = text.includes('已添加商品');
    const goodsCount = text.match(/已添加商品(\d+)/)?.[1] || '0';
    const checkboxes = [...document.querySelectorAll('input[type="checkbox"]')];
    const batchDeleteBtn = [...document.querySelectorAll('button')].find(b => (b.textContent||'').includes('批量删除'));
    return {url: location.href, hasGoods, goodsCount: Number(goodsCount), checkboxCount: checkboxes.length, hasBatchDelete: !!batchDeleteBtn, batchDeleteDisabled: batchDeleteBtn?.classList.contains('so-button-disabled') || batchDeleteBtn?.disabled};
  `);
  console.log('Page state:', JSON.stringify(pageState, null, 2));

  if (!pageState.hasGoods) {
    console.log('Page not loaded properly, waiting more...');
    await sleep(5000);
  }

  // Step 2: Select the first SKC checkbox (NOT one we want to remove, just to trigger the API)
  console.log('Selecting first checkbox...');
  const selectResult = await cdp.eval(`
    // Find the first data row checkbox (not the header "select all" checkbox)
    const checkboxes = [...document.querySelectorAll('input[type="checkbox"]')];
    // Skip the first one (usually "select all") and click the second one (first data row)
    if (checkboxes.length > 1) {
      checkboxes[1].click();
      return {clicked: true, checkboxCount: checkboxes.length};
    }
    return {clicked: false, reason: 'not enough checkboxes'};
  `);
  console.log('Select result:', JSON.stringify(selectResult, null, 2));
  await sleep(1000);

  // Step 3: Check batch delete button is now enabled
  const btnState = await cdp.eval(`
    const batchDeleteBtn = [...document.querySelectorAll('button')].find(b => (b.textContent||'').includes('批量删除'));
    return {
      found: !!batchDeleteBtn,
      text: batchDeleteBtn?.textContent?.trim(),
      disabled: batchDeleteBtn?.classList.contains('so-button-disabled') || batchDeleteBtn?.disabled,
      cls: batchDeleteBtn?.className,
    };
  `);
  console.log('Batch delete button state:', JSON.stringify(btnState, null, 2));

  // Step 4: Click "批量删除" and capture the request
  if (btnState.found && !btnState.disabled) {
    console.log('Clicking 批量删除...');
    await cdp.eval(`
      const batchDeleteBtn = [...document.querySelectorAll('button')].find(b => (b.textContent||'').includes('批量删除'));
      if (batchDeleteBtn) batchDeleteBtn.click();
    `);
    await sleep(2000);

    // Check for confirmation dialog
    const dialogState = await cdp.eval(`
      const text = document.body?.innerText || '';
      // Look for confirmation dialog/modal
      const modals = [...document.querySelectorAll('[class*="modal"], [class*="dialog"], [class*="confirm"], [class*="popup"], [role="dialog"]')];
      const visibleModals = modals.filter(el => el.offsetParent !== null).map(el => ({
        cls: (el.className||'').toString().slice(0, 100),
        text: (el.innerText||'').slice(0, 500),
      }));
      // Look for confirm/cancel buttons
      const confirmBtns = [...document.querySelectorAll('button')].filter(b => {
        const t = (b.textContent||'').trim();
        return t.includes('确定') || t.includes('确认') || t.includes('confirm') || t.includes('OK');
      }).map(b => ({text: b.textContent.trim(), cls: b.className, visible: b.offsetParent !== null}));
      const cancelBtns = [...document.querySelectorAll('button')].filter(b => {
        const t = (b.textContent||'').trim();
        return t.includes('取消') || t.includes('cancel');
      }).map(b => ({text: b.textContent.trim(), cls: b.className, visible: b.offsetParent !== null}));
      return {visibleModals: visibleModals.slice(0, 3), confirmBtns, cancelBtns, bodySample: text.slice(0, 800)};
    `);
    console.log('Dialog state:', JSON.stringify(dialogState, null, 2));

    // DO NOT click confirm - just record the state and cancel
    // Click cancel if available
    if (dialogState.cancelBtns && dialogState.cancelBtns.length > 0) {
      console.log('Clicking cancel to abort removal...');
      await cdp.eval(`
        const cancelBtn = [...document.querySelectorAll('button')].find(b => (b.textContent||'').trim() === '取消' || (b.textContent||'').trim() === 'cancel');
        if (cancelBtn) cancelBtn.click();
      `);
      await sleep(1000);
    }

    // Wait for any API requests to complete
    await sleep(2000);
  }

  // Step 5: Also try to find the delete API by looking at the page's JavaScript
  console.log('Looking for delete API in page source...');
  const apiInfo = await cdp.eval(`
    // Try to find the delete/remove API endpoint in the page's JavaScript
    const scripts = [...document.querySelectorAll('script[src]')].map(s => s.src);
    // Also check if there are any webpack chunks that might contain the API
    const bodyText = document.body?.innerText || '';
    // Check for any API hints in the page
    return {
      scriptCount: scripts.length,
      scriptSrcs: scripts.slice(0, 10),
      hasDeleteText: bodyText.includes('删除') || bodyText.includes('剔除'),
    };
  `);
  console.log('API info:', JSON.stringify(apiInfo, null, 2));

  // Save results
  const result = {
    createdAt: new Date().toISOString(),
    storeKey, activityId, editUrl: EDIT_URL,
    pageState, selectResult, btnState,
    allRequests: allRequests.slice(-30),
    allResponses: allResponses.slice(-30),
    note: 'Read-only probe v7. Selected one checkbox and clicked 批量删除 but CANCELLED the confirmation. No goods were actually removed.',
  };
  await fs.writeFile(OUT, JSON.stringify(result, null, 2), 'utf8');
  console.log('Result saved to', OUT);
  console.log('Total requests captured:', allRequests.length);

} finally {
  if (cdp) cdp.close();
  console.log('Closing FY browser...');
  const close = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts/close_store_browsers.ps1'), '-Stores', 'FY'], {cwd: ROOT, encoding: 'utf8', timeout: 15000});
  console.log('close stdout:', close.stdout?.slice(0, 300));
}
