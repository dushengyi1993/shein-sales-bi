#!/usr/bin/env node
/**
 * Read-only SHEIN backend survey through an existing logged-in Chrome CDP session.
 *
 * The script intentionally stores only sanitized request metadata. It does not
 * persist cookies, tokens, request bodies, or response bodies.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_ROOT = path.join(ROOT, 'outputs', 'shein_backend_survey');
const SSO_ORIGIN = 'https://sso.geiwohuo.com';

const DEFAULT_ROUTES = [
  {key: 'home', url: `${SSO_ORIGIN}/#/home`, domain: 'home', name: '首页'},
  {key: 'gsp-order-list', url: `${SSO_ORIGIN}/#/gsp/order-management/list`, domain: 'gsp', name: '订单 / 我的订单'},
  {key: 'gsp-after-sales', url: `${SSO_ORIGIN}/#/gsp/order-management/after-sales-list`, domain: 'gsp', name: '订单 / 退货退款'},
  {key: 'gsp-waybill', url: `${SSO_ORIGIN}/#/gsp/order-management/deliver-waybill-list`, domain: 'gsp', name: '订单 / 发货面单'},
  {key: 'gsp-performance-setting', url: `${SSO_ORIGIN}/#/gsp/order-management/performance-setting`, domain: 'gsp', name: '订单 / 履约设置'},
  {key: 'gsp-inventory-storage-age', url: `${SSO_ORIGIN}/#/gsp/inventory-management/storage-age`, domain: 'gsp', name: '库存 / 库龄列表'},
  {key: 'gsp-out-of-stock-goods', url: `${SSO_ORIGIN}/#/gsp/order-management/out-of-stock-goods`, domain: 'gsp', name: '订单 / 缺货商品'},
  {key: 'spmp-product-publish', url: `${SSO_ORIGIN}/#/spmp/commoditiesCategory/followsales-pro/list`, domain: 'spmp', name: '商品 / 商品发布'},
  {key: 'spmp-product-list', url: `${SSO_ORIGIN}/#/spmp/commdities/list`, domain: 'spmp', name: '商品 / 商品列表'},
  {key: 'idms-stockup', url: `${SSO_ORIGIN}/#/idms/stockup`, domain: 'idms', name: '商品 / 备货'},
  {key: 'spmc-material-center', url: `${SSO_ORIGIN}/#/spmc/material-center`, domain: 'spmc', name: '商品 / 素材中心'},
  {key: 'spmp-product-diagnosis', url: `${SSO_ORIGIN}/#/spmp/commoditiesDiagnosis/list`, domain: 'spmp', name: '商品 / 商品诊断'},
  {key: 'pqmp-product-quality', url: `${SSO_ORIGIN}/#/pqmp/commoditiesQuality/list`, domain: 'pqmp', name: '商品 / 商品质量'},
  {key: 'mgs-product-feedback', url: `${SSO_ORIGIN}/#/mgs/store-management/product-feedback`, domain: 'mgs', name: '商品 / 商品评价'},
  {key: 'pgs-element-library', url: `${SSO_ORIGIN}/#/pgs/element-library`, domain: 'pgs', name: '商品 / 侵权元素'},
  {key: 'sbn-management-analysis', url: `${SSO_ORIGIN}/#/sbn/managementAnalysis/index`, domain: 'sbn', name: '数据 / 经营分析'},
  {key: 'sbn-merchandise', url: `${SSO_ORIGIN}/#/sbn/merchandise`, domain: 'sbn', name: '数据 / 商品分析'},
  {key: 'sbn-marketing', url: `${SSO_ORIGIN}/#/sbn/marketing`, domain: 'sbn', name: '数据 / 营销分析'},
  {key: 'mgs-performance-time-analysis', url: `${SSO_ORIGIN}/#/mgs/performance_time_analysis`, domain: 'mgs', name: '数据 / 履约分析'},
  {key: 'sbn-market-analysis', url: `${SSO_ORIGIN}/#/sbn/market-analysis`, domain: 'sbn', name: '数据 / 市场分析'},
  {key: 'pfmp-finance-list', url: `${SSO_ORIGIN}/#/pfmp/finance-management/list`, domain: 'pfmp', name: '财务 / 结算列表'},
  {key: 'sbn-service-quality', url: `${SSO_ORIGIN}/#/sbn/service/quality`, domain: 'sbn', name: '服务 / 服务质量'},
  {key: 'ssls-message', url: `${SSO_ORIGIN}/#/ssls/message`, domain: 'ssls', name: '消息'},
  {key: 'download-management', url: `${SSO_ORIGIN}/#/download-management/list`, domain: 'sso', name: '下载管理'},
];

function parseArgs(argv) {
  const args = {
    port: 9333,
    waitMs: 4500,
    routes: DEFAULT_ROUTES,
    outDir: path.join(OUT_ROOT, timestamp()),
    includeStatic: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--wait-ms') args.waitMs = Number(argv[++i]);
    else if (a === '--out') args.outDir = path.resolve(argv[++i]);
    else if (a === '--routes') {
      const keys = new Set(String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean));
      args.routes = DEFAULT_ROUTES.filter(r => keys.has(r.key));
    } else if (a === '--no-static') {
      args.includeStatic = false;
    }
  }
  return args;
}

function timestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function connectCdp(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, {signal: AbortSignal.timeout(3000)})).json();
  const page = targets.find(p => p.type === 'page' && /geiwohuo|shein/i.test(p.url)) || targets.find(p => p.type === 'page');
  if (!page) throw new Error(`No Chrome page target on port ${port}. 请先启动并登录该店铺浏览器。`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const {resolve, reject} = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    if (msg.method && listeners.has(msg.method)) {
      for (const fn of listeners.get(msg.method)) fn(msg.params || {});
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, {once: true});
    ws.addEventListener('error', reject, {once: true});
  });
  const send = (method, params = {}) => {
    const id = ++seq;
    ws.send(JSON.stringify({id, method, params}));
    return new Promise((resolve, reject) => pending.set(id, {resolve, reject}));
  };
  const on = (method, fn) => {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method).push(fn);
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');
  return {ws, send, on, page};
}

async function evaluate(send, expression) {
  const result = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}

function sanitizeUrl(raw) {
  try {
    const u = new URL(raw);
    const scrub = ['access_token', 'token', 'authorization', 'auth', 'sign', 'signature', 'x-gw-auth'];
    for (const key of [...u.searchParams.keys()]) {
      if (scrub.some(s => key.toLowerCase().includes(s))) u.searchParams.set(key, '<redacted>');
    }
    return u.toString();
  } catch {
    return String(raw || '').replace(/(access_token|token|authorization|auth|sign|signature)=([^&]+)/ig, '$1=<redacted>');
  }
}

function endpointKey(url) {
  try {
    const u = new URL(url, SSO_ORIGIN);
    return u.pathname;
  } catch {
    return String(url || '').split('?')[0];
  }
}

function cleanText(s, max = 4000) {
  return String(s || '').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

async function captureRoute(cdp, route, waitMs) {
  const requests = new Map();
  cdp.on('Network.requestWillBeSent', ev => {
    const req = ev.request || {};
    requests.set(ev.requestId, {
      requestId: ev.requestId,
      type: ev.type,
      method: req.method,
      url: sanitizeUrl(req.url),
      endpoint: endpointKey(req.url),
      resourceType: ev.type,
      hasPostData: Boolean(req.hasPostData || req.postData),
      timestamp: ev.timestamp,
    });
  });
  cdp.on('Network.responseReceived', ev => {
    const prev = requests.get(ev.requestId) || {requestId: ev.requestId};
    const res = ev.response || {};
    requests.set(ev.requestId, {
      ...prev,
      status: res.status,
      mimeType: res.mimeType,
      fromDiskCache: res.fromDiskCache,
      fromServiceWorker: res.fromServiceWorker,
    });
  });
  await cdp.send('Page.navigate', {url: route.url});
  await sleep(waitMs);
  const dom = await evaluate(cdp.send, `(() => {
    const visible = el => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s && s.display !== 'none' && s.visibility !== 'hidden' && r.width >= 1 && r.height >= 1;
    };
    const links = [...document.querySelectorAll('a,[role=menuitem],[data-menu-id]')]
      .filter(visible)
      .map(el => ({
        text: (el.innerText || el.textContent || el.getAttribute('title') || el.getAttribute('aria-label') || '').trim(),
        href: el.href || el.getAttribute('href') || '',
        dataMenuId: el.getAttribute('data-menu-id') || ''
      }))
      .filter(x => x.text || x.href || x.dataMenuId)
      .slice(0, 300);
    const scripts = performance.getEntriesByType('resource')
      .map(e => e.name)
      .filter(x => /\\.js(\\?|$)/i.test(x))
      .slice(-300);
    return {
      href: location.href,
      title: document.title,
      bodyText: (document.body?.innerText || '').slice(0, 12000),
      links,
      scripts,
      localStorageKeys: Object.keys(localStorage || {}).slice(0, 200)
    };
  })()`);
  const reqs = [...requests.values()]
    .filter(r => r.url && !/monitor-web|bizBeacon|srmdata|\.map(\?|$)/i.test(r.url))
    .map(({requestId, timestamp, ...rest}) => rest);
  return {route, capturedAt: new Date().toISOString(), dom: {...dom, bodyText: cleanText(dom?.bodyText || '', 12000)}, requests: reqs};
}

function extractStringsFromJs(text) {
  const endpoints = new Map();
  const routes = new Map();
  const labels = new Map();
  const endpointRe = /["'`]((?:\/|https?:\/\/)[A-Za-z0-9_./:#?&=%-]*(?:order|goods|skc|sku|spu|stock|storage|inventory|shelf|sale|sales|performance|analysis|diagnos|flow|market|marketing|logistics|quality|service|finance|refund|return|waybill|appeal|complaint|product|supplier|activity|promotion|overview|list|export)[A-Za-z0-9_./:#?&=%-]*)["'`]/ig;
  const routeRe = /(?:path|redirect|to|href)\s*[:=]\s*["'`]((?:\/|#\/)[A-Za-z0-9_./:-]+)["'`]/g;
  const cnLabelRe = /["'`]([\u4e00-\u9fa5][\u4e00-\u9fa5A-Za-z0-9_（）()、\/ -]{1,32})["'`]/g;
  let m;
  while ((m = endpointRe.exec(text))) endpoints.set(m[1], (endpoints.get(m[1]) || 0) + 1);
  while ((m = routeRe.exec(text))) routes.set(m[1], (routes.get(m[1]) || 0) + 1);
  while ((m = cnLabelRe.exec(text))) {
    const v = m[1].trim();
    if (/[\u4e00-\u9fa5]/.test(v) && !/[{};]/.test(v)) labels.set(v, (labels.get(v) || 0) + 1);
  }
  const asArray = map => [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value, count]) => ({value, count}));
  return {endpoints: asArray(endpoints), routes: asArray(routes), labels: asArray(labels).slice(0, 500)};
}

async function fetchStaticInventory(scriptUrls, outDir) {
  const unique = [...new Set(scriptUrls)].filter(u => /^https?:\/\//i.test(u));
  const all = [];
  const byScript = [];
  await fs.mkdir(path.join(outDir, 'static'), {recursive: true});
  for (const url of unique) {
    if (!/webassets|statics|static\.sheinassets|assets2\.dotfashion/i.test(url)) continue;
    try {
      const text = await (await fetch(url, {signal: AbortSignal.timeout(15000)})).text();
      const extracted = extractStringsFromJs(text);
      byScript.push({
        url: sanitizeUrl(url),
        bytes: text.length,
        endpointCount: extracted.endpoints.length,
        routeCount: extracted.routes.length,
        labelCount: extracted.labels.length,
        endpoints: extracted.endpoints.slice(0, 250),
        routes: extracted.routes.slice(0, 250),
        labels: extracted.labels.slice(0, 100),
      });
      for (const e of extracted.endpoints) all.push({source: url, ...e});
    } catch (err) {
      byScript.push({url: sanitizeUrl(url), error: err.message});
    }
  }
  const endpointCounts = new Map();
  for (const e of all) endpointCounts.set(e.value, (endpointCounts.get(e.value) || 0) + e.count);
  const endpoints = [...endpointCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value, count]) => ({value, count, domain: classifyEndpoint(value)}));
  await fs.writeFile(path.join(outDir, 'static-api-inventory.json'), JSON.stringify({generatedAt: new Date().toISOString(), scriptCount: unique.length, endpoints, byScript}, null, 2), 'utf8');
  return {scriptCount: unique.length, endpointCount: endpoints.length, endpoints};
}

function classifyEndpoint(value) {
  const v = String(value || '').toLowerCase();
  if (v.includes('/gsp/') || v.includes('orderplus') || /\/order\//.test(v)) return 'gsp/order';
  if (v.includes('/sbn/') || v.includes('/new_goods/') || v.includes('/goods/flowdiagnose') || v.includes('/stocking/')) return 'sbn/data';
  if (v.includes('/spmp') || v.includes('/product/')) return 'spmp/product';
  if (v.includes('/idms') || v.includes('/goods-skc/') || v.includes('/stockup')) return 'idms/stockup';
  if (v.includes('/storage/') || v.includes('stockage') || v.includes('inventory')) return 'gsp/inventory';
  if (v.includes('/mgs/') || v.includes('logistics')) return 'mgs/logistics';
  if (v.includes('/pfmp/') || v.includes('finance')) return 'pfmp/finance';
  return 'other';
}

function summarizeRouteCapture(routeCapture) {
  const endpoints = new Map();
  for (const req of routeCapture.requests || []) {
    if (!req.endpoint || /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?)$/i.test(req.endpoint)) continue;
    const key = `${req.method || ''} ${req.endpoint}`;
    const row = endpoints.get(key) || {method: req.method || '', endpoint: req.endpoint, count: 0, statuses: new Set(), types: new Set()};
    row.count++;
    if (req.status) row.statuses.add(req.status);
    if (req.mimeType) row.types.add(req.mimeType);
    endpoints.set(key, row);
  }
  return {
    routeKey: routeCapture.route.key,
    name: routeCapture.route.name,
    finalHref: routeCapture.dom?.href,
    title: routeCapture.dom?.title,
    bodyPreview: cleanText(routeCapture.dom?.bodyText || '', 1200),
    links: routeCapture.dom?.links || [],
    endpoints: [...endpoints.values()].map(x => ({...x, statuses: [...x.statuses], types: [...x.types]})),
    permissionWarning: /没有当前功能的权限|请主账号|无权限|permission|未授权/i.test(routeCapture.dom?.bodyText || ''),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await fs.mkdir(args.outDir, {recursive: true});
  const cdp = await connectCdp(args.port);
  const captures = [];
  for (const route of args.routes) {
    console.error(`[survey] ${route.key} ${route.url}`);
    try {
      const capture = await captureRoute(cdp, route, args.waitMs);
      captures.push(capture);
      await fs.writeFile(path.join(args.outDir, `route-${route.key}.json`), JSON.stringify(capture, null, 2), 'utf8');
    } catch (err) {
      captures.push({route, error: err.message, capturedAt: new Date().toISOString()});
    }
  }
  const allScripts = captures.flatMap(c => c.dom?.scripts || []);
  const staticInventory = args.includeStatic ? await fetchStaticInventory(allScripts, args.outDir) : null;
  const summary = {
    generatedAt: new Date().toISOString(),
    port: args.port,
    outDir: path.relative(ROOT, args.outDir),
    routes: captures.map(summarizeRouteCapture),
    staticInventory: staticInventory ? {
      scriptCount: staticInventory.scriptCount,
      endpointCount: staticInventory.endpointCount,
      topEndpoints: staticInventory.endpoints.slice(0, 150),
    } : null,
  };
  await fs.writeFile(path.join(args.outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log(JSON.stringify({
    ok: true,
    outDir: path.relative(ROOT, args.outDir),
    routes: summary.routes.length,
    staticEndpointCount: summary.staticInventory?.endpointCount || 0,
    permissionWarnings: summary.routes.filter(r => r.permissionWarning).map(r => r.routeKey),
  }, null, 2));
  cdp.ws.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
