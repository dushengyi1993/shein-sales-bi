#!/usr/bin/env node
/**
 * Read-only SHEIN current marketing price scanner for BI 主系统.
 *
 * It opens/uses each store's logged-in browser profile, reads current/future
 * ordinary marketing activity goods, active/future limited-discount goods, and
 * active coupon goods, then writes a compact evidence snapshot. It never submits,
 * edits, cancels, or uploads anything.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {recoverSheinLoginIfNeeded} from '../../lib/shein_login_recovery.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STORES_CONFIG = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'stores.json'), 'utf8'));
const STORES = STORES_CONFIG.stores || [];
const COUPON_LEVEL_RULES = JSON.parse(
  await fs.readFile(path.join(ROOT, 'config', 'marketing_coupon_level_rules.json'), 'utf8')
    .catch(() => '{"activities":{}}')
);
const LIST_URL = 'https://sso.geiwohuo.com/#/mbrs/marketing/list';
const DEFAULT_OUT_DIR = path.join(ROOT, 'tmp', 'marketing-signup', 'current-price-live');
const DEFAULT_COUPON_ACTIVITY_ID = 34810;
const ACTIVE_OR_FUTURE_STATES = new Set(['2', '3']);
const ACTIVE_COUPON_STATUSES = new Set(['0', '1']);

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function splitStores(value) { return String(value || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean); }
function parseArgs(argv) {
  const args = {
    stores: [],
    group: 'ALL',
    outDir: DEFAULT_OUT_DIR,
    out: '',
    couponActivityId: DEFAULT_COUPON_ACTIVITY_ID,
    levelRuleHints: '',
    noLaunch: false,
    noClose: false,
    headless: false,
    visible: false,
    pageSize: 500,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--stores') args.stores = splitStores(argv[++i]);
    else if (a === '--store') args.stores = [String(argv[++i] || '').trim().toUpperCase()].filter(Boolean);
    else if (a === '--group') args.group = String(argv[++i] || 'ALL').toUpperCase();
    else if (a === '--out-dir') args.outDir = path.resolve(argv[++i]);
    else if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--coupon-activity-id') args.couponActivityId = Number(argv[++i] || args.couponActivityId);
    else if (a === '--level-rule-hints') args.levelRuleHints = path.resolve(argv[++i]);
    else if (a === '--no-launch') args.noLaunch = true;
    else if (a === '--no-close') args.noClose = true;
    else if (a === '--headless') args.headless = true;
    else if (a === '--visible') args.visible = true;
    else if (a === '--page-size') args.pageSize = Number(argv[++i] || args.pageSize);
  }
  return args;
}
function selectedStores(args) {
  const enabled = STORES.filter(s => s.enabled !== false);
  const keys = args.stores.length ? args.stores : (STORES_CONFIG.groups?.[args.group] || STORES_CONFIG.groups?.ALL || enabled.map(s => s.storeKey));
  return keys.map(key => {
    const store = enabled.find(s => String(s.storeKey).toUpperCase() === String(key).toUpperCase());
    if (!store) throw new Error(`Unknown or disabled store: ${key}`);
    return store;
  }).sort((a,b)=>String(a.storeKey).localeCompare(String(b.storeKey)));
}
function dateMs(value) {
  const s = String(value || '').trim();
  if (!s) return NaN;
  const ms = Date.parse(s.replace(' ', 'T') + (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? '' : '+08:00'));
  return Number.isFinite(ms) ? ms : NaN;
}
function isActiveOrFuture(start, end, state) {
  const now = Date.now();
  const e = dateMs(end);
  if (Number.isFinite(e) && e < now) return false;
  const st = String(state ?? '');
  if (st && !ACTIVE_OR_FUTURE_STATES.has(st)) return false;
  return true;
}
function isCurrent(start, end) {
  const now = Date.now();
  const s = dateMs(start), e = dateMs(end);
  if (Number.isFinite(s) && now < s) return false;
  if (Number.isFinite(e) && now > e) return false;
  return Number.isFinite(s) || Number.isFinite(e);
}
function numberOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/)?.[0]);
  return Number.isFinite(n) ? n : null;
}
function launchVisible(store, args) {
  const mode = args.headless ? '--headless' : (args.visible ? '--visible' : '--background');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'launch_store_browser.mjs'), store.storeKey, mode, '--url', LIST_URL], {cwd: ROOT, encoding: 'utf8', timeout: 25_000});
  if (r.status !== 0) throw new Error(`launch browser failed for ${store.storeKey}: ${r.stderr || r.stdout}`);
}
function closeLaunchedStoreBrowser(store) {
  if (process.platform === 'win32') {
    spawnSync('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-File', path.join(ROOT, 'scripts', 'close_store_browsers.ps1'), '-Stores', store.storeKey], {cwd: ROOT, stdio:'ignore', timeout: 15_000});
    return;
  }
  spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'cleanup_shein_store_browsers.mjs'),
    '--store',
    store.storeKey,
    '--kill-after-sec',
    '5',
  ], {cwd: ROOT, stdio: 'ignore', timeout: 20_000});
}
async function httpJson(url) {
  const res = await fetch(url, {signal: AbortSignal.timeout(8000)});
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return await res.json();
}
async function isCdpOpen(port) {
  try { await httpJson(`http://127.0.0.1:${port}/json/version`); return true; } catch { return false; }
}
async function ensureBrowser(store, args) {
  let launched = false;
  if (!args.noLaunch && !(await isCdpOpen(store.port))) {
    launchVisible(store, args);
    launched = true;
    launchedStoreKeys.add(String(store.storeKey).toUpperCase());
    await sleep(6500);
  }
  return {launched};
}
class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.nextId = 1; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, {once: true});
      this.ws.addEventListener('error', reject, {once: true});
    });
    this.ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const {resolve, reject} = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
    await this.call('Runtime.enable');
    await this.call('Page.enable').catch(() => {});
  }
  call(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({id, method, params}));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 45_000);
      this.pending.set(id, {resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); }});
    });
  }
  async eval(expression, arg = {}) {
    const res = await this.call('Runtime.evaluate', {expression: `(async () => { const __arg = ${JSON.stringify(arg)}; ${expression} })()`, awaitPromise: true, returnByValue: true});
    if (res.exceptionDetails) {
      const ex = res.exceptionDetails.exception || {};
      throw new Error(ex.description || ex.value || res.exceptionDetails.text || JSON.stringify(res.exceptionDetails));
    }
    return res.result?.value;
  }
  close() { try { this.ws?.close(); } catch {} }
}
async function connectStorePage(store) {
  const targets = await httpJson(`http://127.0.0.1:${store.port}/json/list`);
  const page = targets.find(t => t.type === 'page' && String(t.url || '').includes('sso.geiwohuo.com')) || targets.find(t => t.type === 'page');
  if (!page) throw new Error(`port ${store.port} no page target`);
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();
  return cdp;
}
async function recoverLoginIfNeeded(cdp) {
  return await recoverSheinLoginIfNeeded({
    evaluate: (body, arg) => cdp.eval(body, arg),
    reload: () => cdp.call('Page.reload', {ignoreCache: true}).catch(() => cdp.eval(`location.reload(); return {href: location.href};`)),
    sleep,
    maxAttempts: 3,
  });
}
async function gotoMarketingList(cdp) {
  await cdp.eval(`location.href = __arg.url; return location.href;`, {url: LIST_URL});
  await sleep(2500);
  return await recoverLoginIfNeeded(cdp);
}
async function loadLevelRuleHints(file) {
  const hints = new Map();
  const configuredStores = COUPON_LEVEL_RULES?.activities?.[String(DEFAULT_COUPON_ACTIVITY_ID)]?.stores || {};
  for (const [storeKey, entry] of Object.entries(configuredStores)) {
    const id = Number(entry?.levelRuleId || entry?.level_rule_id || 0);
    if (Number.isFinite(id) && id > 0) hints.set(String(storeKey).toUpperCase(), id);
  }
  if (!file) return hints;
  try {
    const doc = JSON.parse(await fs.readFile(file, 'utf8'));
    for (const row of doc.checks || doc.rows || []) {
      const store = String(row.store || row.storeKey || '').toUpperCase();
      const id = Number(row.levelRuleId || row.level_rule_id);
      if (store && Number.isFinite(id) && id > 0) hints.set(store, id);
    }
  } catch {}
  return hints;
}
async function queryMarketing(cdp, args, levelRuleId) {
  return await cdp.eval(`
    const headers = {'content-type':'application/json;charset=UTF-8','Origin-Url':location.href,'x-req-zone-id':'Asia/Shanghai','x-lt-language':'CN','LAN':'CN'};
    async function post(path, body, route='/mbrs/marketing/list') {
      const res = await fetch('/mrs-api-prefix' + path, {method:'POST', credentials:'include', headers:{...headers,'x-bbl-route':route}, body: JSON.stringify(body || {})});
      const text = await res.text(); let json=null; try{json=JSON.parse(text)}catch{};
      return {http:res.status, code:json?.code, msg:json?.msg || text.slice(0,300), info:json?.info ?? json};
    }
    function arrayFrom(v){ if(Array.isArray(v)) return v; if(Array.isArray(v?.data)) return v.data; if(Array.isArray(v?.list)) return v.list; if(Array.isArray(v?.records)) return v.records; if(Array.isArray(v?.partake_goods_list)) return v.partake_goods_list; if(Array.isArray(v?.activity_detail_list)) return v.activity_detail_list; return []; }
    const activities = [];
    const activityPackets = [];
    for(let pageNum=1; pageNum<=20; pageNum++){
      const q = await post('/mbrs/activity/get_activity_list?page_num='+pageNum+'&page_size=100', {});
      const list = arrayFrom(q.info?.activity_detail_list ?? q.info);
      activityPackets.push({pageNum,http:q.http,code:q.code,msg:q.msg,count:list.length});
      if(q.code !== '0') break;
      activities.push(...list);
      if(list.length < 100) break;
    }
    const ordinaryRows = [];
    const ordinaryPackets = [];
    for(const activity of activities){
      const activityId = Number(activity.activity_id);
      const name = activity.activity_name || '';
      const label = activity.text_tag_content || '';
      const isCoupon = activityId === __arg.couponActivityId || /coupon|优惠券/i.test([name,label,activity.backend_cate,activity.multi_level_coupon_activity?'coupon':''].join(' '));
      const state = String(activity.state ?? activity.activity_state ?? '');
      const endTime = activity.end_zone_time || '';
      const endMs = endTime ? Date.parse(String(endTime).replace(' ','T') + '+08:00') : NaN;
      if(isCoupon || (state && !__arg.activeStates.includes(state)) || (Number.isFinite(endMs) && endMs < Date.now())) continue;
      for(let pageNum=1; pageNum<=50; pageNum++){
        const q = await post('/mbrs/activity/get_partake_activity_goods_list?page_num='+pageNum+'&page_size='+__arg.pageSize, {activity_id_list:[activityId], query_coupon:false, skc_list:[], audit_status:[0,1]}, '/mbrs/marketing/sign-up/config/' + activityId);
        const list = arrayFrom(q.info?.data ?? q.info);
        const total = Number(q.info?.meta?.total ?? q.info?.total ?? list.length ?? 0);
        ordinaryPackets.push({activityId,pageNum,http:q.http,code:q.code,msg:q.msg,total,count:list.length});
        if(q.code !== '0') break;
        for(const item of list) ordinaryRows.push({...item,__activity:{activityId,name,start:activity.start_zone_time||'',end:activity.end_zone_time||'',signEnd:activity.activity_end_zone_time||'',state}});
        if(!list.length || ordinaryRows.filter(x=>Number(x.__activity.activityId)===activityId).length >= total || list.length < __arg.pageSize) break;
      }
    }
    const limitedRows = [];
    const limitedPackets = [];
    for(let pageNum=1; pageNum<=20; pageNum++){
      const listPacket = await post('/promotion/obm/query_obm_activity_list', {page_num:pageNum, page_size:200, system:'mrs', ref_tools_id:175}, '/mbrs/marketing/list');
      const list = arrayFrom(listPacket.info);
      limitedPackets.push({pageNum,http:listPacket.http,code:listPacket.code,msg:listPacket.msg,count:list.length});
      if(listPacket.code !== '0') break;
      for(const activity of list){
        const state = String(activity.state ?? '');
        const endMs = activity.end_time ? Date.parse(String(activity.end_time).replace(' ','T') + '+08:00') : NaN;
        if(state && !__arg.activeStates.includes(state)) continue;
        if(Number.isFinite(endMs) && endMs < Date.now()) continue;
        const goodsPacket = await post('/promotion/simple_platform/query_activity_goods', {activity_id: activity.activity_id, page_num: 1, page_size: 1000}, '/mbrs/marketing/list');
        limitedPackets.push({activityId:activity.activity_id,http:goodsPacket.http,code:goodsPacket.code,msg:goodsPacket.msg,count:arrayFrom(goodsPacket.info).length});
        if(goodsPacket.code !== '0') continue;
        for(const good of arrayFrom(goodsPacket.info)) limitedRows.push({...good,__activity:{activityId:activity.activity_id,name:activity.act_name||'',start:activity.start_time||'',end:activity.end_time||'',state}});
      }
      if(list.length < 200) break;
    }
    const couponRows = [];
    const couponPackets = [];
    if(__arg.levelRuleId){
      for(let pageNum=1; pageNum<=50; pageNum++){
        const q = await post('/mbrs/activity/multi-level/goods/query?page_num='+pageNum+'&page_size='+__arg.pageSize, {activity_id:__arg.couponActivityId, level_rule_id:__arg.levelRuleId, page:'COUPON', page_module:'MULTI_LEVEL_RULE_ENROLLED_GOODS', product_code_list:[], supplier_no_list:[]}, '/mbrs/marketing/coupon/rule/goods/' + __arg.couponActivityId + '/' + __arg.levelRuleId);
        const list = arrayFrom(q.info?.partake_goods_list ?? q.info);
        const total = Number(q.info?.total ?? list.length ?? 0);
        couponPackets.push({pageNum,http:q.http,code:q.code,msg:q.msg,total,count:list.length});
        if(q.code !== '0') break;
        couponRows.push(...list);
        if(!list.length || couponRows.length >= total || list.length < __arg.pageSize) break;
      }
    }
    return {page:{href:location.href,title:document.title}, activityPackets, ordinaryPackets, ordinaryRows, limitedPackets, limitedRows, couponPackets, couponRows};
  `, {pageSize: args.pageSize, couponActivityId: args.couponActivityId, levelRuleId, activeStates: [...ACTIVE_OR_FUTURE_STATES]});
}
function bestActivityPrice(item) {
  const sku = Array.isArray(item.activity_sku_list) ? item.activity_sku_list[0] : null;
  const candidates = [item.activity_price, item.product_act_price, item.attend_price, item.price, item.activity_price_str, sku?.activity_price, sku?.product_act_price, sku?.attend_price];
  for (const c of candidates) { const n = numberOrNull(c); if (n !== null) return n; }
  return null;
}
function normalizeRows(store, live, levelRuleId, args) {
  const couponActive = new Set((live.couponRows || []).filter(g => ACTIVE_COUPON_STATUSES.has(String(g.status ?? ''))).map(g => String(g.skc || '').trim()).filter(Boolean));
  const rows = [];
  const rowsWithPriceLayer = new Set();
  for (const item of live.ordinaryRows || []) {
    const skc = String(item.skc || '').trim();
    if (!skc) continue;
    rowsWithPriceLayer.add(skc);
    const a = item.__activity || {};
    const current = isCurrent(a.start, a.end);
    rows.push({
      store_key: store.storeKey,
      skc,
      standard_goods_sn: item.supplier_no || item.supplierNo || item.sku_supplier_no || '',
      marketing_suggested_ordinary_price_sar: bestActivityPrice(item),
      marketing_ordinary_price_is_current: current ? true : '',
      marketing_activity_id: a.activityId || item.activity_id || '',
      marketing_activity_name: item.activity_name || a.name || '',
      marketing_activity_start: a.start || '',
      marketing_activity_end: a.end || '',
      marketing_coupon_factor: couponActive.has(skc) ? 0.85 : null,
      marketing_coupon_summary: couponActive.has(skc) ? '15%券' : '',
      marketing_price_evidence_type: current ? 'current_ordinary_marketing_live_scan' : 'future_ordinary_marketing_live_scan',
      marketing_price_source_rank: current ? 80 : 24,
      marketing_price_source_at: new Date().toISOString(),
    });
  }
  for (const good of live.limitedRows || []) {
    const skc = String(good.skc || '').trim();
    if (!skc) continue;
    rowsWithPriceLayer.add(skc);
    const a = good.__activity || {};
    const current = isCurrent(a.start, a.end);
    rows.push({
      store_key: store.storeKey,
      skc,
      standard_goods_sn: good.sku_supplier_no || '',
      marketing_limited_discount_price_sar: numberOrNull(good.product_act_price),
      marketing_limited_discount_is_current: current ? true : '',
      marketing_limited_discount_name: a.name || '',
      marketing_limited_discount_start: a.start || '',
      marketing_limited_discount_end: a.end || '',
      marketing_coupon_factor: couponActive.has(skc) ? 0.85 : null,
      marketing_coupon_summary: couponActive.has(skc) ? '15%券' : '',
      marketing_price_evidence_type: current ? 'current_limited_discount_live_scan' : 'future_limited_discount_live_scan',
      marketing_price_source_rank: current ? 82 : 24,
      marketing_price_source_at: new Date().toISOString(),
    });
  }
  for (const good of live.couponRows || []) {
    const skc = String(good.skc || '').trim();
    if (!skc || !ACTIVE_COUPON_STATUSES.has(String(good.status ?? '')) || rowsWithPriceLayer.has(skc)) continue;
    rows.push({
      store_key: store.storeKey,
      skc,
      standard_goods_sn: good.supplier_no || good.supplierNo || good.sku_supplier_no || '',
      marketing_coupon_factor: 0.85,
      marketing_coupon_summary: '15%券',
      marketing_coupon_activity_id: args.couponActivityId,
      marketing_coupon_level_rule_id: levelRuleId || '',
      marketing_price_evidence_type: 'current_coupon_only_live_scan',
      marketing_price_source_rank: 18,
      marketing_price_source_at: new Date().toISOString(),
    });
  }
  return rows;
}
async function scanStore(store, args, levelHints) {
  const result = {store: store.storeKey, shopName: store.shopName, ok: false, rows: [], warnings: []};
  let cdp = null;
  let launched = false;
  try {
    const ensured = await ensureBrowser(store, args);
    launched = ensured.launched;
    cdp = await connectStorePage(store);
    result.loginRecovery = await gotoMarketingList(cdp);
    // Only the post-recovery state is authoritative here. The page can start on
    // the login route, then a saved session / password-manager click can recover
    // it. Do not fail just because the pre-recovery page was a login page.
    if (result.loginRecovery.after?.isLogin) {
      result.reason = 'login page; skipped read-only price scan';
      return result;
    }
    const levelRuleId = levelHints.get(String(store.storeKey).toUpperCase()) || null;
    result.levelRuleId = levelRuleId;
    const live = await queryMarketing(cdp, args, levelRuleId);
    result.page = live.page;
    result.packets = {
      activity: live.activityPackets || [],
      ordinary: live.ordinaryPackets || [],
      limited: live.limitedPackets || [],
      coupon: live.couponPackets || [],
    };
    result.rows = normalizeRows(store, live, levelRuleId, args);
    result.ok = true;
    result.reason = `price scan ok; rows=${result.rows.length}; ordinary=${live.ordinaryRows?.length || 0}; limited=${live.limitedRows?.length || 0}; coupon=${live.couponRows?.length || 0}`;
    return result;
  } catch (err) {
    result.reason = err.message;
    result.stack = err.stack;
    return result;
  } finally {
    cdp?.close();
    if (launched && !args.noClose && !args.visible) {
      closeLaunchedStoreBrowser(store);
      launchedStoreKeys.delete(String(store.storeKey).toUpperCase());
    }
  }
}
function csvEscape(value) { const s = String(value ?? ''); return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; }
function toCsv(rows, headers) { return [headers.join(','), ...rows.map(row => headers.map(h => csvEscape(row[h])).join(','))].join('\r\n') + '\r\n'; }

const args = parseArgs(process.argv.slice(2));
const stores = selectedStores(args);
const levelHints = await loadLevelRuleHints(args.levelRuleHints);
await fs.mkdir(args.outDir, {recursive: true});
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const jsonPath = args.out || path.join(args.outDir, `current-marketing-price-live-${stamp}.json`);
const csvPath = jsonPath.replace(/\.json$/i, '.csv');
const csvHeaders = ['store_key','skc','standard_goods_sn','marketing_suggested_ordinary_price_sar','marketing_ordinary_price_is_current','marketing_limited_discount_price_sar','marketing_limited_discount_is_current','marketing_activity_id','marketing_activity_name','marketing_activity_start','marketing_activity_end','marketing_limited_discount_name','marketing_limited_discount_start','marketing_limited_discount_end','marketing_coupon_summary','marketing_coupon_activity_id','marketing_coupon_level_rule_id','marketing_price_evidence_type','marketing_price_source_rank','marketing_price_source_at'];
const summary = {
  ok: false,
  partial: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  mode: 'read_only_current_marketing_price_scan',
  stores: [],
};
const launchedStoreKeys = new Set();

function cleanupLaunchedBrowsers() {
  if (args.noClose || args.visible) return;
  for (const storeKey of [...launchedStoreKeys]) {
    const store = STORES.find(s => String(s.storeKey).toUpperCase() === storeKey);
    if (!store) continue;
    closeLaunchedStoreBrowser(store);
    launchedStoreKeys.delete(storeKey);
  }
}

async function writeSnapshot({final = false} = {}) {
  const rows = summary.stores.flatMap(s => s.rows || []);
  summary.updatedAt = new Date().toISOString();
  summary.partial = !final;
  summary.rowCount = rows.length;
  summary.currentRows = rows.filter(r => /^current_/.test(String(r.marketing_price_evidence_type))).length;
  summary.futureRows = rows.filter(r => /^future_/.test(String(r.marketing_price_evidence_type))).length;
  summary.ok = final && summary.stores.length === stores.length && summary.stores.every(s => s.ok);
  await fs.writeFile(jsonPath, JSON.stringify({...summary, rows}, null, 2), 'utf8');
  await fs.writeFile(csvPath, toCsv(rows, csvHeaders), 'utf8');
}

let terminating = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (terminating) return;
    terminating = true;
    summary.terminatedBy = signal;
    writeSnapshot({final: false})
      .catch(err => console.error(`failed to write partial marketing price scan snapshot on ${signal}: ${err.message}`))
      .finally(() => {
        cleanupLaunchedBrowsers();
        process.exit(signal === 'SIGTERM' ? 143 : 130);
      });
  });
}

for (const store of stores) {
  console.log(`scan ${store.storeKey} ...`);
  const result = await scanStore(store, args, levelHints);
  summary.stores.push(result);
  console.log(`${store.storeKey}: ${result.reason}`);
  await writeSnapshot({final: false});
}
await writeSnapshot({final: true});
console.log(JSON.stringify({ok: summary.ok, rowCount: summary.rowCount, currentRows: summary.currentRows, futureRows: summary.futureRows, jsonPath, csvPath}, null, 2));
if (!summary.ok) {
  const failedStores = summary.stores.filter(s => !s.ok).map(s => `${s.store}:${s.reason || 'unknown'}`);
  console.error(`marketing current price scan had failed stores: ${failedStores.join('; ')}`);
  process.exitCode = 1;
}
