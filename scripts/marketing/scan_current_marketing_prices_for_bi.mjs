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
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {recoverSheinLoginIfNeeded} from '../../lib/shein_login_recovery.mjs';
import {connectCdp} from '../../lib/shein_browser.mjs';
import {loadSheinBrowserSession, sheinSessionPostJson} from '../../lib/shein_session_http.mjs';

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
const launchedStoreKeys = new Set();
const USAGE = `
Usage:
  node scripts/marketing/scan_current_marketing_prices_for_bi.mjs [options]

Read-only scan of current/future marketing prices. The default group is ALL.

Options:
  --store <KEY>                 Scan one store
  --stores <KEY,...>            Scan a comma-separated store list
  --group <NAME>                Scan a configured store group (default: ALL)
  --out-dir <PATH>              Snapshot output directory
  --out <FILE.json>             Snapshot JSON path
  --coupon-activity-id <ID>     Coupon activity ID (default: 34810)
  --level-rule-hints <FILE>     Optional level-rule hint JSON
  --page-size <N>               API page size, 1-1000 (default: 500)
  --store-attempts <N>          Attempts per store, 1-5 (default: 3)
  --session-http                Use session-manager cookies without launching Chrome
  --session-concurrency <N>     Concurrent session HTTP stores, 1-6 (default: 3)
  --no-launch                   Do not launch missing store browsers
  --no-close                    Keep browsers launched by this command open
  --headless                    Launch missing browsers headlessly
  --visible                     Launch missing browsers visibly
  -h, --help                    Show this help and exit without scanning
`;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function splitStores(value) { return String(value || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean); }
function optionValue(argv, index, option) {
  const value = argv[index + 1];
  if (value == null || String(value).startsWith('-')) throw new Error(`Missing value for ${option}`);
  return value;
}
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
    storeAttempts: 3,
    sessionHttp: false,
    sessionConcurrency: 3,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const takeValue = () => {
      const value = optionValue(argv, i, a);
      i += 1;
      return value;
    };
    if (a === '--stores') args.stores = splitStores(takeValue());
    else if (a === '--store') args.stores = [String(takeValue()).trim().toUpperCase()].filter(Boolean);
    else if (a === '--group') args.group = String(takeValue()).toUpperCase();
    else if (a === '--out-dir') args.outDir = path.resolve(takeValue());
    else if (a === '--out') args.out = path.resolve(takeValue());
    else if (a === '--coupon-activity-id') args.couponActivityId = Number(takeValue());
    else if (a === '--level-rule-hints') args.levelRuleHints = path.resolve(takeValue());
    else if (a === '--no-launch') args.noLaunch = true;
    else if (a === '--no-close') args.noClose = true;
    else if (a === '--headless') args.headless = true;
    else if (a === '--visible') args.visible = true;
    else if (a === '--page-size') args.pageSize = Number(takeValue());
    else if (a === '--store-attempts') args.storeAttempts = Number(takeValue());
    else if (a === '--session-http') args.sessionHttp = true;
    else if (a === '--session-concurrency') args.sessionConcurrency = Number(takeValue());
    else throw new Error(`Unknown option: ${a}`);
  }
  if (args.headless && args.visible) throw new Error('--headless and --visible cannot be used together');
  if (!Number.isInteger(args.pageSize) || args.pageSize < 1 || args.pageSize > 1000) throw new Error('--page-size must be an integer from 1 to 1000');
  if (!Number.isInteger(args.storeAttempts) || args.storeAttempts < 1 || args.storeAttempts > 5) throw new Error('--store-attempts must be an integer from 1 to 5');
  if (!Number.isInteger(args.sessionConcurrency) || args.sessionConcurrency < 1 || args.sessionConcurrency > 6) throw new Error('--session-concurrency must be an integer from 1 to 6');
  if (!Number.isInteger(args.couponActivityId) || args.couponActivityId < 1) throw new Error('--coupon-activity-id must be a positive integer');
  return args;
}
function selectedStores(args) {
  const enabled = STORES.filter(s => s.enabled !== false);
  const groupStores = STORES_CONFIG.groups?.[args.group];
  if (!args.stores.length && !Array.isArray(groupStores)) throw new Error(`Unknown store group: ${args.group}`);
  const keys = args.stores.length ? args.stores : groupStores;
  return keys.map(key => {
    const store = enabled.find(s => String(s.storeKey).toUpperCase() === String(key).toUpperCase());
    if (!store) throw new Error(`Unknown or disabled store: ${key}`);
    return store;
  }).sort((a,b)=>String(a.storeKey).localeCompare(String(b.storeKey)));
}
function dateMs(value) {
  const raw = String(value || '').trim();
  if (!raw) return NaN;
  const dateOnly = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  const normalized = dateOnly
    ? `${dateOnly[1]}-${String(dateOnly[2]).padStart(2, '0')}-${String(dateOnly[3]).padStart(2, '0')}T00:00:00`
    : raw.replace(' ', 'T');
  const ms = Date.parse(/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(normalized) ? normalized : `${normalized}+08:00`);
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
async function connectStorePage(store) {
  const connection = await connectCdp(store.port, {pageUrlPattern: /sso\.geiwohuo\.com/i, commandTimeoutMs: 45_000});
  const call = (method, params = {}) => connection.send(method, params);
  const evalPage = async (expression, arg = {}) => {
    const res = await call('Runtime.evaluate', {expression: `(async () => { const __arg = ${JSON.stringify(arg)}; ${expression} })()`, awaitPromise: true, returnByValue: true});
    if (res.exceptionDetails) {
      const ex = res.exceptionDetails.exception || {};
      throw new Error(ex.description || ex.value || res.exceptionDetails.text || JSON.stringify(res.exceptionDetails));
    }
    return res.result?.value;
  };
  return {...connection, call, eval: evalPage};
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

function arrayFrom(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.list)) return value.list;
  if (Array.isArray(value?.records)) return value.records;
  if (Array.isArray(value?.partake_goods_list)) return value.partake_goods_list;
  if (Array.isArray(value?.activity_detail_list)) return value.activity_detail_list;
  return [];
}

function marketingPacketOk(packet) {
  return packet && (packet.code === '0' || packet.code === 0);
}

function assertCompleteMarketingPackets(live) {
  const failures = [];
  for (const [domain, packets] of Object.entries({
    activity: live.activityPackets || [],
    ordinary: live.ordinaryPackets || [],
    limited: live.limitedPackets || [],
    coupon: live.couponPackets || [],
  })) {
    for (const packet of packets) {
      if (!marketingPacketOk(packet)) {
        failures.push(`${domain}:${packet.activityId || packet.pageNum || '-'}:http=${packet.http || '-'}:code=${packet.code ?? '-'}:${String(packet.msg || '').slice(0, 120)}`);
      }
    }
  }
  if (!(live.activityPackets || []).length) failures.push('activity:no-packet');
  if (!(live.limitedPackets || []).length) failures.push('limited:no-packet');
  if (failures.length) {
    throw new Error(`marketing price evidence incomplete: ${failures.slice(0, 8).join('; ')}`);
  }
}

async function queryMarketingViaSessionHttp(store, args, levelRuleId) {
  const session = await loadSheinBrowserSession(ROOT, store.storeKey);
  const headers = route => ({
    'Origin-Url': LIST_URL,
    'x-req-zone-id': 'Asia/Shanghai',
    'x-lt-language': 'CN',
    LAN: 'CN',
    'x-bbl-route': route,
  });
  const post = async (apiPath, body, route = '/mbrs/marketing/list') => {
    const json = await sheinSessionPostJson(session, `/mrs-api-prefix${apiPath}`, body, {
      timeoutMs: 20_000,
      headers: headers(route),
    });
    return {
      http: 200,
      code: json?.code,
      msg: json?.msg || '',
      info: json?.info ?? json,
    };
  };

  const activities = [];
  const activityPackets = [];
  for (let pageNum = 1; pageNum <= 20; pageNum += 1) {
    const packet = await post(`/mbrs/activity/get_activity_list?page_num=${pageNum}&page_size=100`, {});
    const list = arrayFrom(packet.info?.activity_detail_list ?? packet.info);
    activityPackets.push({pageNum, http: packet.http, code: packet.code, msg: packet.msg, count: list.length});
    if (!marketingPacketOk(packet)) break;
    activities.push(...list);
    if (list.length < 100) break;
  }

  const ordinaryRows = [];
  const ordinaryPackets = [];
  for (const activity of activities) {
    const activityId = Number(activity.activity_id);
    const name = activity.activity_name || '';
    const label = activity.text_tag_content || '';
    const isCoupon = activityId === args.couponActivityId
      || /coupon|优惠券/i.test([name, label, activity.backend_cate, activity.multi_level_coupon_activity ? 'coupon' : ''].join(' '));
    const state = String(activity.state ?? activity.activity_state ?? '');
    const endTime = activity.end_zone_time || '';
    const endMs = dateMs(endTime);
    if (isCoupon || (state && !ACTIVE_OR_FUTURE_STATES.has(state)) || (Number.isFinite(endMs) && endMs < Date.now())) continue;
    let collected = 0;
    for (let pageNum = 1; pageNum <= 50; pageNum += 1) {
      const packet = await post(
        `/mbrs/activity/get_partake_activity_goods_list?page_num=${pageNum}&page_size=${args.pageSize}`,
        {activity_id_list: [activityId], query_coupon: false, skc_list: [], audit_status: [0, 1]},
        `/mbrs/marketing/sign-up/config/${activityId}`,
      );
      const list = arrayFrom(packet.info?.data ?? packet.info);
      const total = Number(packet.info?.meta?.total ?? packet.info?.total ?? list.length ?? 0);
      ordinaryPackets.push({activityId, pageNum, http: packet.http, code: packet.code, msg: packet.msg, total, count: list.length});
      if (!marketingPacketOk(packet)) break;
      for (const item of list) {
        ordinaryRows.push({...item, __activity: {
          activityId,
          name,
          start: activity.start_zone_time || '',
          end: activity.end_zone_time || '',
          signEnd: activity.activity_end_zone_time || '',
          state,
        }});
      }
      collected += list.length;
      if (!list.length || collected >= total || list.length < args.pageSize) break;
    }
  }

  const limitedRows = [];
  const limitedPackets = [];
  for (let pageNum = 1; pageNum <= 20; pageNum += 1) {
    const listPacket = await post('/promotion/obm/query_obm_activity_list', {
      page_num: pageNum,
      page_size: 200,
      system: 'mrs',
      ref_tools_id: 175,
    });
    const list = arrayFrom(listPacket.info);
    limitedPackets.push({pageNum, http: listPacket.http, code: listPacket.code, msg: listPacket.msg, count: list.length});
    if (!marketingPacketOk(listPacket)) break;
    for (const activity of list) {
      const state = String(activity.state ?? '');
      const endMs = dateMs(activity.end_time);
      if (state && !ACTIVE_OR_FUTURE_STATES.has(state)) continue;
      if (Number.isFinite(endMs) && endMs < Date.now()) continue;
      const goodsPacket = await post('/promotion/simple_platform/query_activity_goods', {
        activity_id: activity.activity_id,
        page_num: 1,
        page_size: 1000,
      });
      const goods = arrayFrom(goodsPacket.info);
      limitedPackets.push({activityId: activity.activity_id, http: goodsPacket.http, code: goodsPacket.code, msg: goodsPacket.msg, count: goods.length});
      if (!marketingPacketOk(goodsPacket)) continue;
      for (const good of goods) {
        limitedRows.push({...good, __activity: {
          activityId: activity.activity_id,
          name: activity.act_name || '',
          start: activity.start_time || '',
          end: activity.end_time || '',
          state,
        }});
      }
    }
    if (list.length < 200) break;
  }

  const couponRows = [];
  const couponPackets = [];
  if (levelRuleId) {
    for (let pageNum = 1; pageNum <= 50; pageNum += 1) {
      const packet = await post(
        `/mbrs/activity/multi-level/goods/query?page_num=${pageNum}&page_size=${args.pageSize}`,
        {
          activity_id: args.couponActivityId,
          level_rule_id: levelRuleId,
          page: 'COUPON',
          page_module: 'MULTI_LEVEL_RULE_ENROLLED_GOODS',
          product_code_list: [],
          supplier_no_list: [],
        },
        `/mbrs/marketing/coupon/rule/goods/${args.couponActivityId}/${levelRuleId}`,
      );
      const list = arrayFrom(packet.info?.partake_goods_list ?? packet.info);
      const total = Number(packet.info?.total ?? list.length ?? 0);
      couponPackets.push({pageNum, http: packet.http, code: packet.code, msg: packet.msg, total, count: list.length});
      if (!marketingPacketOk(packet)) break;
      couponRows.push(...list);
      if (!list.length || couponRows.length >= total || list.length < args.pageSize) break;
    }
  }

  return {
    page: {href: LIST_URL, title: 'session-http', source: path.relative(ROOT, session.sessionFile)},
    activityPackets,
    ordinaryPackets,
    ordinaryRows,
    limitedPackets,
    limitedRows,
    couponPackets,
    couponRows,
  };
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
      marketing_limited_discount_activity_id: a.activityId || good.activity_id || '',
      marketing_limited_discount_name: a.name || '',
      marketing_limited_discount_start: a.start || '',
      marketing_limited_discount_end: a.end || '',
      marketing_limited_discount_attend_num_sum: numberOrNull(good.attend_num_sum),
      marketing_limited_discount_stock_num: numberOrNull(good.stock_num),
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
function isTransientMarketingScanError(error) {
  return /fetch failed|failed to fetch|networkerror|load failed|timed?\s*out|timeout|econnreset|socket hang up|cdp websocket|target closed|browser has been closed/i.test(String(error?.message || error || ''));
}
async function scanStoreViaSessionHttp(store, args, levelHints) {
  const result = {store: store.storeKey, shopName: store.shopName, ok: false, rows: [], warnings: [], attempts: 0, transport: 'session_http'};
  for (let attempt = 1; attempt <= args.storeAttempts; attempt += 1) {
    result.attempts = attempt;
    try {
      const levelRuleId = levelHints.get(String(store.storeKey).toUpperCase()) || null;
      result.levelRuleId = levelRuleId;
      const live = await queryMarketingViaSessionHttp(store, args, levelRuleId);
      assertCompleteMarketingPackets(live);
      result.page = live.page;
      result.packets = {
        activity: live.activityPackets || [],
        ordinary: live.ordinaryPackets || [],
        limited: live.limitedPackets || [],
        coupon: live.couponPackets || [],
      };
      result.rows = normalizeRows(store, live, levelRuleId, args);
      result.ok = true;
      result.reason = `session price scan ok; rows=${result.rows.length}; ordinary=${live.ordinaryRows?.length || 0}; limited=${live.limitedRows?.length || 0}; coupon=${live.couponRows?.length || 0}; attempts=${attempt}`;
      return result;
    } catch (err) {
      result.reason = err.message;
      result.stack = err.stack;
      if (attempt < args.storeAttempts && isTransientMarketingScanError(err)) {
        result.warnings.push(`transient session scan failure on attempt ${attempt}: ${String(err.message || err).slice(0, 500)}`);
        await sleep(1500);
        continue;
      }
      return result;
    }
  }
  return result;
}
async function scanStore(store, args, levelHints) {
  if (args.sessionHttp) return scanStoreViaSessionHttp(store, args, levelHints);
  const result = {store: store.storeKey, shopName: store.shopName, ok: false, rows: [], warnings: [], attempts: 0};
  let launched = false;
  try {
    const ensured = await ensureBrowser(store, args);
    launched = ensured.launched;
    for (let attempt = 1; attempt <= args.storeAttempts; attempt += 1) {
      result.attempts = attempt;
      let cdp = null;
      try {
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
        assertCompleteMarketingPackets(live);
        result.page = live.page;
        result.packets = {
          activity: live.activityPackets || [],
          ordinary: live.ordinaryPackets || [],
          limited: live.limitedPackets || [],
          coupon: live.couponPackets || [],
        };
        result.rows = normalizeRows(store, live, levelRuleId, args);
        result.ok = true;
        result.reason = `price scan ok; rows=${result.rows.length}; ordinary=${live.ordinaryRows?.length || 0}; limited=${live.limitedRows?.length || 0}; coupon=${live.couponRows?.length || 0}; attempts=${attempt}`;
        return result;
      } catch (err) {
        result.reason = err.message;
        result.stack = err.stack;
        if (attempt < args.storeAttempts && isTransientMarketingScanError(err)) {
          result.warnings.push(`transient scan failure on attempt ${attempt}: ${String(err.message || err).slice(0, 500)}`);
          await sleep(1500);
          continue;
        }
        return result;
      } finally {
        cdp?.close();
      }
    }
    return result;
  } finally {
    if (launched && !args.noClose && !args.visible) {
      closeLaunchedStoreBrowser(store);
      launchedStoreKeys.delete(String(store.storeKey).toUpperCase());
    }
  }
}
function csvEscape(value) { const s = String(value ?? ''); return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; }
function toCsv(rows, headers) { return [headers.join(','), ...rows.map(row => headers.map(h => csvEscape(row[h])).join(','))].join('\r\n') + '\r\n'; }

const csvHeaders = ['store_key','skc','standard_goods_sn','marketing_suggested_ordinary_price_sar','marketing_ordinary_price_is_current','marketing_limited_discount_price_sar','marketing_limited_discount_is_current','marketing_activity_id','marketing_activity_name','marketing_activity_start','marketing_activity_end','marketing_limited_discount_activity_id','marketing_limited_discount_name','marketing_limited_discount_start','marketing_limited_discount_end','marketing_limited_discount_attend_num_sum','marketing_limited_discount_stock_num','marketing_coupon_summary','marketing_coupon_activity_id','marketing_coupon_level_rule_id','marketing_price_evidence_type','marketing_price_source_rank','marketing_price_source_at'];

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE.trim());
    return;
  }
  const args = parseArgs(argv);
  const stores = selectedStores(args);
  const levelHints = await loadLevelRuleHints(args.levelRuleHints);
  await fs.mkdir(args.outDir, {recursive: true});
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = args.out || path.join(args.outDir, `current-marketing-price-live-${stamp}.json`);
  const csvPath = jsonPath.replace(/\.json$/i, '.csv');
  const summary = {
    ok: false,
    partial: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mode: args.sessionHttp
      ? 'read_only_current_marketing_price_scan_session_http'
      : 'read_only_current_marketing_price_scan_browser',
    stores: [],
  };

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

  try {
    if (args.sessionHttp) {
      for (let offset = 0; offset < stores.length; offset += args.sessionConcurrency) {
        const batch = stores.slice(offset, offset + args.sessionConcurrency);
        console.log(`scan session batch ${Math.floor(offset / args.sessionConcurrency) + 1}: ${batch.map(store => store.storeKey).join(',')} ...`);
        const results = await Promise.all(batch.map(store => scanStore(store, args, levelHints)));
        for (const result of results) {
          summary.stores.push(result);
          console.log(`${result.store}: ${result.reason}`);
        }
        await writeSnapshot({final: false});
      }
    } else {
      for (const store of stores) {
        console.log(`scan ${store.storeKey} ...`);
        const result = await scanStore(store, args, levelHints);
        summary.stores.push(result);
        console.log(`${store.storeKey}: ${result.reason}`);
        await writeSnapshot({final: false});
      }
    }
    await writeSnapshot({final: true});
    console.log(JSON.stringify({ok: summary.ok, rowCount: summary.rowCount, currentRows: summary.currentRows, futureRows: summary.futureRows, jsonPath, csvPath}, null, 2));
    if (!summary.ok) {
      const failedStores = summary.stores.filter(s => !s.ok).map(s => `${s.store}:${s.reason || 'unknown'}`);
      console.error(`marketing current price scan had failed stores: ${failedStores.join('; ')}`);
      process.exitCode = 1;
    }
  } finally {
    cleanupLaunchedBrowsers();
  }
}

main(process.argv.slice(2)).catch(error => {
  console.error(`[scan_current_marketing_prices_for_bi] ${error.message}`);
  process.exitCode = 1;
});
