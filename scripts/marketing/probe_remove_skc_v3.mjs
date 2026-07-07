// probe_remove_skc_v3.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STORES = JSON.parse(await fs.readFile(path.join(ROOT, 'config/stores.json'), 'utf8')).stores || [];
const OUT = path.join(ROOT, 'tmp/marketing-signup/limited-discount-rescue/remove-skc-probe-v3-FY-2026-07-05.json');

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
const launch = spawnSync(process.execPath, [path.join(ROOT, 'scripts/launch_store_browser.mjs'), storeKey, '--visible', '--url', 'https://sso.geiwohuo.com/#/mbrs/marketing/list'], {cwd: ROOT, encoding: 'utf8', timeout: 30000});
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
    if (url.includes('/mrs-api-prefix/') || url.includes('/promotion/') || url.includes('/mbrs/')) {
      allRequests.push({url, method: params.request.method, postData: params.request.postData ? params.request.postData.slice(0, 1000) : null});
    }
  });
  cdp.on('Network.responseReceived', (params) => {
    const url = params.response.url;
    if (url.includes('/mrs-api-prefix/') || url.includes('/promotion/') || url.includes('/mbrs/')) {
      allResponses.push({url, status: params.response.status, method: params.response.requestMethod});
    }
  });

  // Query limited discount activities via API
  console.log('Querying limited discount activities via API...');
  const ldList = await cdp.eval(`
    const headers = {'content-type':'application/json;charset=UTF-8','Origin-Url':location.href,'x-req-zone-id':'Asia/Shanghai','x-lt-language':'CN','LAN':'CN'};
    async function post(url, body, route='') {
      const res = await fetch('/mrs-api-prefix' + url, {method:'POST',credentials:'include',headers: route ? {...headers,'x-bbl-route':route} : headers, body: JSON.stringify(body||{})});
      const text = await res.text(); let json; try{json=JSON.parse(text)}catch{json=null}
      return {http:res.status, code:json?.code, msg:json?.msg||text.slice(0,300), info:json?.info??json, text:text.slice(0,500)};
    }
    function arrayFrom(v){if(Array.isArray(v))return v;if(Array.isArray(v?.data))return v.data;if(Array.isArray(v?.list))return v.list;if(Array.isArray(v?.records))return v.records;return []}
    const activities = [];
    for(let pageNum=1; pageNum<=5; pageNum++){
      const packet = await post('/promotion/obm/query_obm_activity_list', {page_num:pageNum, page_size:200, system:'mrs', ref_tools_id:175}, '/mbrs/marketing/list');
      const list = arrayFrom(packet.info);
      activities.push(...list);
      if(list.length < 200) break;
    }
    const target = activities.find(a => Number(a.activity_id) === __arg.activityId);
    return {
      totalActivities: activities.length,
      targetFound: !!target,
      target: target ? {id: target.activity_id, name: target.act_name, state: target.state, start: target.start_time, end: target.end_time} : null,
      allActivities: activities.map(a => ({id: a.activity_id, name: a.act_name, state: a.state})),
    };
  `, {activityId});
  console.log('LD list:', JSON.stringify(ldList, null, 2));

  // Query goods
  let goodsInfo = null;
  if (ldList.targetFound) {
    goodsInfo = await cdp.eval(`
      const headers = {'content-type':'application/json;charset=UTF-8','Origin-Url':location.href,'x-req-zone-id':'Asia/Shanghai','x-lt-language':'CN','LAN':'CN'};
      async function post(url, body, route='') {
        const res = await fetch('/mrs-api-prefix' + url, {method:'POST',credentials:'include',headers: route ? {...headers,'x-bbl-route':route} : headers, body: JSON.stringify(body||{})});
        const text = await res.text(); let json; try{json=JSON.parse(text)}catch{json=null}
        return {http:res.status, code:json?.code, msg:json?.msg||text.slice(0,300), info:json?.info??json};
      }
      function arrayFrom(v){if(Array.isArray(v))return v;if(Array.isArray(v?.data))return v.data;if(Array.isArray(v?.list))return v.list;if(Array.isArray(v?.records))return v.records;return []}
      const goodsPacket = await post('/promotion/simple_platform/query_activity_goods', {activity_id: __arg.activityId, page_num:1, page_size:1000}, '/mbrs/marketing/list');
      const goods = arrayFrom(goodsPacket.info);
      return {code: goodsPacket.code, goodsCount: goods.length, goodsSample: goods.slice(0,5).map(g=>({skc:g.skc,supplier:g.sku_supplier_no,price:g.product_act_price,id:g.id,goods_state:g.goods_state}))};
    `, {activityId});
    console.log('Goods:', JSON.stringify(goodsInfo, null, 2));
  }

  // Try various URLs for the management page
  const urlsToTry = [
    'https://sso.geiwohuo.com/#/mbrs/marketing/discount/config/' + activityId,
    'https://sso.geiwohuo.com/#/mbrs/marketing/discount/detail/' + activityId,
    'https://sso.geiwohuo.com/#/mbrs/marketing/discount/edit/' + activityId,
    'https://sso.geiwohuo.com/#/mbrs/marketing/discount/manage/' + activityId,
    'https://sso.geiwohuo.com/#/mbrs/marketing/tool/limited-discount/config/' + activityId,
    'https://sso.geiwohuo.com/#/mbrs/marketing/tool/limited-discount/detail/' + activityId,
    'https://sso.geiwohuo.com/#/mbrs/marketing/tool/limited-discount/edit/' + activityId,
    'https://sso.geiwohuo.com/#/mbrs/marketing/tool/limited-discount/manage/' + activityId,
  ];

  let pageStates = [];
  for (const url of urlsToTry) {
    console.log('Trying:', url);
    await cdp.eval('location.href = __arg.url; return {href: location.href};', {url});
    await sleep(3000);
    const state = await cdp.eval(`
      const text = document.body?.innerText || '';
      const removeTexts = [...document.querySelectorAll('button, a, span, div, i')].filter(el => {
        const t = (el.textContent||'').trim().toLowerCase();
        return t.includes('移除') || t.includes('删除') || t.includes('remove') || t.includes('delete');
      }).map(el => ({tag: el.tagName, text: (el.textContent||'').trim().slice(0,50), cls: (el.className||'').toString().slice(0,80), visible: el.offsetParent !== null}));
      return {url: location.href, title: document.title, bodyLen: text.length, bodySample: text.slice(0, 600), removeTexts: removeTexts.slice(0, 10), tableRows: document.querySelectorAll('table tr, .el-table__row, [class*="table"] [class*="row"]').length};
    `);
    console.log('  bodyLen:', state.bodyLen, 'remove:', state.removeTexts.length, 'rows:', state.tableRows);
    pageStates.push({url, state});
    if (state.removeTexts.length > 0 && state.bodyLen > 100) break;
  }

  // Look for menu links
  await cdp.eval('location.href = "https://sso.geiwohuo.com/#/mbrs/marketing/list"; return {href: location.href};');
  await sleep(3000);
  const menuResult = await cdp.eval(`
    const allLinks = [...document.querySelectorAll('a, [class*="menu"], [class*="nav"]')];
    const marketingLinks = allLinks.filter(el => {
      const text = (el.textContent||'').trim();
      const href = el.getAttribute?.('href') || '';
      return text.includes('营销工具') || text.includes('限时折扣') || text.includes('限时') || text.includes('折扣') || href.includes('discount') || href.includes('tool') || href.includes('flash');
    }).map(el => ({tag: el.tagName, text: (el.textContent||'').trim().slice(0, 100), href: el.getAttribute?.('href') || '', cls: (el.className||'').toString().slice(0, 80), visible: el.offsetParent !== null}));
    return {marketingLinks: marketingLinks.slice(0, 20)};
  `);
  console.log('Menu:', JSON.stringify(menuResult, null, 2));

  const result = {createdAt: new Date().toISOString(), storeKey, activityId, limitedDiscountList: ldList, goodsInfo, pageStates, menuResult, allRequests: allRequests.slice(0, 100), allResponses: allResponses.slice(0, 100), note: 'Read-only probe v3.'};
  await fs.writeFile(OUT, JSON.stringify(result, null, 2), 'utf8');
  console.log('Result saved to', OUT);
} finally {
  if (cdp) cdp.close();
  console.log('Closing FY browser...');
  const close = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts/close_store_browsers.ps1'), '-Stores', 'FY'], {cwd: ROOT, encoding: 'utf8', timeout: 15000});
  console.log('close stdout:', close.stdout?.slice(0, 300));
}
