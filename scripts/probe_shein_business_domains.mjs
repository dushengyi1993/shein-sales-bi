#!/usr/bin/env node
/**
 * Read-only SHEIN business-domain probe.
 *
 * Goal:
 * - Move from "page was visited" to "API field shape was confirmed".
 * - Capture only response shapes and small redacted samples.
 * - Do not persist cookies, tokens, request headers, or full response bodies.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {connectCdp} from '../lib/shein_browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_ROOT = path.join(ROOT, 'outputs', 'shein_business_probe');
const SSO_ORIGIN = 'https://sso.geiwohuo.com';

const ROUTES = [
  {key: 'home', domain: '经营首页', url: `${SSO_ORIGIN}/#/home`},
  {key: 'orders', domain: '订单销售', url: `${SSO_ORIGIN}/#/gsp/order-management/list`},
  {key: 'after-sales', domain: '退货退款', url: `${SSO_ORIGIN}/#/gsp/order-management/after-sales-list`},
  {key: 'waybill', domain: '发货履约', url: `${SSO_ORIGIN}/#/gsp/order-management/deliver-waybill-list`},
  {key: 'out-of-stock', domain: '缺货订单', url: `${SSO_ORIGIN}/#/gsp/order-management/out-of-stock-goods`},
  {key: 'inventory-storage-age', domain: '库存库龄', url: `${SSO_ORIGIN}/#/gsp/inventory-management/storage-age`},
  {key: 'product-list', domain: '商品链接', url: `${SSO_ORIGIN}/#/spmp/commdities/list`},
  {key: 'stockup', domain: '备货标签', url: `${SSO_ORIGIN}/#/idms/stockup`},
  {key: 'diagnosis', domain: '商品诊断', url: `${SSO_ORIGIN}/#/spmp/commoditiesDiagnosis/list`},
  {key: 'quality', domain: '商品质量', url: `${SSO_ORIGIN}/#/pqmp/commoditiesQuality/list`},
  {key: 'feedback', domain: '商品评价', url: `${SSO_ORIGIN}/#/mgs/store-management/product-feedback`},
  {key: 'management-analysis', domain: '经营分析', url: `${SSO_ORIGIN}/#/sbn/managementAnalysis/index`},
  {key: 'merchandise-analysis', domain: '商品分析', url: `${SSO_ORIGIN}/#/sbn/merchandise`},
  {key: 'marketing', domain: '营销分析', url: `${SSO_ORIGIN}/#/sbn/marketing`},
  {key: 'fulfillment-analysis', domain: '履约分析', url: `${SSO_ORIGIN}/#/mgs/performance_time_analysis`},
  {key: 'market-analysis', domain: '市场机会', url: `${SSO_ORIGIN}/#/sbn/market-analysis`},
  {key: 'finance', domain: '财务结算', url: `${SSO_ORIGIN}/#/pfmp/finance-management/list`},
  {key: 'service-quality', domain: '服务质量', url: `${SSO_ORIGIN}/#/sbn/service/quality`},
  {key: 'message', domain: '消息预警', url: `${SSO_ORIGIN}/#/ssls/message`},
  {key: 'download', domain: '下载中心', url: `${SSO_ORIGIN}/#/download-management/list`},
];

function parseArgs(argv) {
  const args = {
    port: 9360,
    waitMs: 8000,
    outDir: path.join(OUT_ROOT, timestamp()),
    routeKeys: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--wait-ms') args.waitMs = Number(argv[++i]);
    else if (a === '--out') args.outDir = path.resolve(argv[++i]);
    else if (a === '--routes') args.routeKeys = new Set(String(argv[++i] || '').split(',').map(x => x.trim()).filter(Boolean));
  }
  return args;
}

function timestamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


async function evaluate(send, expression) {
  const res = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
  if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails));
  return res.result?.value;
}

function endpointPath(raw) {
  try { return new URL(raw, SSO_ORIGIN).pathname; } catch { return String(raw || '').split('?')[0]; }
}

function isBusinessEndpoint(raw) {
  const p = endpointPath(raw).toLowerCase();
  if (/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|map)$/.test(p)) return false;
  return (
    p.includes('/gsp/') ||
    p.includes('/sbn/') ||
    p.includes('/mgs') ||
    p.includes('/pfmp/') ||
    p.includes('/spmp') ||
    p.includes('/spmc') ||
    p.includes('/pqmp') ||
    p.includes('/pgs') ||
    p.includes('/idms/') ||
    p.includes('/ssls/') ||
    p.includes('/sso/common/fileexport')
  );
}

function parseJsonMaybe(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function redactScalar(v) {
  if (typeof v !== 'string') return v;
  if (v.length > 120) return `${v.slice(0, 120)}…`;
  if (/token|authorization|cookie|session|jwt/i.test(v)) return '<redacted>';
  return v;
}

function compactSample(value, depth = 0) {
  if (depth > 3) return Array.isArray(value) ? `[array:${value.length}]` : typeof value;
  if (Array.isArray(value)) return value.slice(0, 2).map(x => compactSample(x, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 40)) {
      if (/token|authorization|cookie|session|password|secret|sign/i.test(k)) out[k] = '<redacted>';
      else out[k] = compactSample(v, depth + 1);
    }
    return out;
  }
  return redactScalar(value);
}

function summarizeShape(value, depth = 0) {
  if (depth > 4) return typeof value;
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      first: value.length ? summarizeShape(value[0], depth + 1) : null,
    };
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    const out = {type: 'object', keys: keys.slice(0, 100)};
    for (const k of keys.slice(0, 30)) out[k] = summarizeShape(value[k], depth + 1);
    return out;
  }
  return {type: typeof value, sample: redactScalar(value)};
}

function findArrays(value, pathName = '$', out = []) {
  if (Array.isArray(value)) {
    out.push({
      path: pathName,
      length: value.length,
      firstKeys: value[0] && typeof value[0] === 'object' ? Object.keys(value[0]).slice(0, 120) : [],
      firstSample: compactSample(value[0] ?? null, 0),
    });
    if (value[0] && out.length < 80) findArrays(value[0], `${pathName}[0]`, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (out.length >= 80) break;
      findArrays(v, `${pathName}.${k}`, out);
    }
  }
  return out;
}

function findInterestingFields(value, pathName = '$', out = []) {
  if (Array.isArray(value)) {
    value.slice(0, 2).forEach((v, i) => findInterestingFields(v, `${pathName}[${i}]`, out));
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (/(order|bill|refund|return|after|stock|inventory|quantity|sku|skc|spu|goods|sale|amount|price|fee|settle|finance|payment|warehouse|waybill|logistics|delivery|cancel|status|reason|comment|quality|activity|campaign|uv|click|pay|rate|profit|cost|currency|date|time)/i.test(k)) {
        out.push({path: `${pathName}.${k}`, key: k, sample: compactSample(v, 0)});
      }
      if (out.length < 160) findInterestingFields(v, `${pathName}.${k}`, out);
    }
  }
  return out;
}

function domainOfEndpoint(endpoint) {
  const p = endpoint.toLowerCase();
  if (p.includes('aftersales') || p.includes('refund') || p.includes('return')) return '退货退款';
  if (p.includes('orderplus') || p.includes('/order')) return '订单销售';
  if (p.includes('waybill') || p.includes('deliver') || p.includes('logistics') || p.includes('estimate')) return '发货履约';
  if (p.includes('stock') || p.includes('storage') || p.includes('inventory') || p.includes('warehouse')) return '库存';
  if (p.includes('/pfmp/') || p.includes('finance') || p.includes('settle')) return '财务';
  if (p.includes('/sbn/marketing') || p.includes('campaign') || p.includes('activity')) return '营销';
  if (p.includes('/sbn/market')) return '市场机会';
  if (p.includes('/sbn/') || p.includes('analysis') || p.includes('indicator')) return '数据分析';
  if (p.includes('/spmp') || p.includes('/spmc') || p.includes('/idms') || p.includes('goods-skc') || p.includes('product')) return '商品链接';
  if (p.includes('/mgs-api-prefix/goods/comment')) return '商品评价';
  if (p.includes('/pqmp')) return '商品质量';
  if (p.includes('/ssls')) return '消息预警';
  if (p.includes('fileexport')) return '下载中心';
  return '其他';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const routes = args.routeKeys ? ROUTES.filter(r => args.routeKeys.has(r.key)) : ROUTES;
  await fs.mkdir(args.outDir, {recursive: true});
  const cdp = await connectCdp(args.port);
  await cdp.send('Network.enable');
  const captures = [];
  let currentRoute = routes[0] || ROUTES[0];

  cdp.on('Network.requestWillBeSent', ev => {
    const url = ev.request?.url || '';
    if (!isBusinessEndpoint(url)) return;
    captures.push({
      requestId: ev.requestId,
      routeKey: currentRoute.key,
      routeDomain: currentRoute.domain,
      routeUrl: currentRoute.url,
      method: ev.request?.method || '',
      endpoint: endpointPath(url),
      hasPostData: Boolean(ev.request?.postData),
      postDataSample: ev.request?.postData ? compactSample(parseJsonMaybe(ev.request.postData) ?? ev.request.postData, 0) : null,
      startedAt: ev.wallTime || ev.timestamp,
    });
  });

  cdp.on('Network.responseReceived', ev => {
    const idx = captures.findIndex(x => x.requestId === ev.requestId);
    if (idx < 0) return;
    captures[idx] = {
      ...captures[idx],
      status: ev.response?.status,
      mimeType: ev.response?.mimeType,
      responseUrl: ev.response?.url ? endpointPath(ev.response.url) : captures[idx].endpoint,
      resourceType: ev.type,
    };
  });

  const pages = [];
  for (const route of routes) {
    currentRoute = route;
    const before = captures.length;
    console.error(`[probe] ${route.key} ${route.url}`);
    await cdp.send('Page.navigate', {url: route.url});
    await sleep(args.waitMs);
    await evaluate(cdp.send, `window.scrollTo(0, document.body.scrollHeight)`).catch(() => null);
    await sleep(1000);
    const info = await evaluate(cdp.send, `(() => ({
      href: location.href,
      title: document.title,
      text: (document.body?.innerText || '').slice(0, 15000)
    }))()`);
    pages.push({
      ...route,
      finalHref: info.href,
      title: info.title,
      capturedRequests: captures.length - before,
      bodyPreview: String(info.text || '').replace(/\s+/g, ' ').slice(0, 1200),
      visibleSignals: String(info.text || '').split(/\n+/).filter(x => /订单|退货|退款|发货|面单|库存|结算|财务|金额|销量|曝光|点击|活动|履约|售后|评价|质量|SKU|SKC|状态|原因/.test(x)).slice(0, 100),
    });
  }

  for (const cap of captures) {
    if (!/json|text/i.test(cap.mimeType || '')) continue;
    try {
      const body = await cdp.send('Network.getResponseBody', {requestId: cap.requestId});
      const text = body.body || '';
      const json = parseJsonMaybe(text);
      cap.responsePreview = text.slice(0, 600);
      cap.responseCode = json?.code ?? json?.status ?? null;
      cap.responseMsg = json?.msg ?? json?.message ?? null;
      cap.domain = domainOfEndpoint(cap.endpoint);
      cap.shape = summarizeShape(json ?? text);
      cap.arrays = findArrays(json).slice(0, 20);
      cap.interestingFields = findInterestingFields(json).slice(0, 120);
      cap.responseSample = compactSample(json, 0);
    } catch (err) {
      cap.bodyError = err.message;
    }
  }

  const endpointMap = new Map();
  for (const cap of captures) {
    const key = `${cap.method} ${cap.endpoint}`;
    const row = endpointMap.get(key) || {
      method: cap.method,
      endpoint: cap.endpoint,
      domain: domainOfEndpoint(cap.endpoint),
      routeDomains: new Set(),
      count: 0,
      statuses: new Set(),
      responseCodes: new Set(),
      arrayPaths: new Map(),
      fieldKeys: new Set(),
      sampleCapture: null,
    };
    row.count++;
    row.routeDomains.add(cap.routeDomain);
    if (cap.status !== undefined) row.statuses.add(cap.status);
    if (cap.responseCode !== undefined && cap.responseCode !== null) row.responseCodes.add(String(cap.responseCode));
    for (const a of cap.arrays || []) row.arrayPaths.set(a.path, Math.max(row.arrayPaths.get(a.path) || 0, a.length));
    for (const f of cap.interestingFields || []) row.fieldKeys.add(f.key);
    if (!row.sampleCapture && cap.shape) {
      row.sampleCapture = {
        routeKey: cap.routeKey,
        responseMsg: cap.responseMsg,
        shape: cap.shape,
        arrays: (cap.arrays || []).slice(0, 8),
        interestingFields: (cap.interestingFields || []).slice(0, 30),
        postDataSample: cap.postDataSample,
      };
    }
    endpointMap.set(key, row);
  }
  const endpoints = [...endpointMap.values()].map(r => ({
    ...r,
    routeDomains: [...r.routeDomains],
    statuses: [...r.statuses],
    responseCodes: [...r.responseCodes],
    arrayPaths: [...r.arrayPaths.entries()].map(([pathName, length]) => ({path: pathName, length})),
    fieldKeys: [...r.fieldKeys].slice(0, 160),
  })).sort((a, b) => a.domain.localeCompare(b.domain, 'zh') || b.count - a.count || a.endpoint.localeCompare(b.endpoint));

  const byDomain = {};
  for (const e of endpoints) {
    if (!byDomain[e.domain]) byDomain[e.domain] = {endpointCount: 0, endpoints: []};
    byDomain[e.domain].endpointCount++;
    byDomain[e.domain].endpoints.push({
      method: e.method,
      endpoint: e.endpoint,
      count: e.count,
      statuses: e.statuses,
      responseCodes: e.responseCodes,
      arrayPaths: e.arrayPaths.slice(0, 8),
      fieldKeys: e.fieldKeys.slice(0, 60),
    });
  }

  const output = {
    generatedAt: new Date().toISOString(),
    port: args.port,
    outDir: path.relative(ROOT, args.outDir),
    pages,
    endpoints,
    byDomain,
    captures,
  };
  await fs.writeFile(path.join(args.outDir, 'business-domain-probe.json'), JSON.stringify(output, null, 2), 'utf8');
  await fs.writeFile(path.join(args.outDir, 'business-domain-summary.json'), JSON.stringify({
    generatedAt: output.generatedAt,
    port: output.port,
    outDir: output.outDir,
    pageCount: pages.length,
    endpointCount: endpoints.length,
    pages: pages.map(p => ({key: p.key, domain: p.domain, finalHref: p.finalHref, capturedRequests: p.capturedRequests, signals: p.visibleSignals.slice(0, 20)})),
    byDomain,
  }, null, 2), 'utf8');

  console.log(JSON.stringify({
    ok: true,
    outDir: output.outDir,
    pages: pages.length,
    endpoints: endpoints.length,
    domains: Object.fromEntries(Object.entries(byDomain).map(([k, v]) => [k, v.endpointCount])),
  }, null, 2));
  cdp.close();
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
