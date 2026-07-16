#!/usr/bin/env node
/**
 * Read-only live scan for old ordinary-marketing overlap observations in coupon activity 34810.
 *
 * Invariant:
 * Activity overlap is a candidate signal only. Real cancellation must be backed
 * by price-stack evidence that the final price is below target. This script
 * therefore writes observation rows, not an executable cancel list.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LIST_URL = 'https://sso.geiwohuo.com/#/mbrs/marketing/list';
const COUPON_GOODS_URL = (activityId, levelRuleId) => `https://sso.geiwohuo.com/#/mbrs/marketing/coupon/rule/goods/${activityId}/${levelRuleId}`;
const ACTIVITY_ID_DEFAULT = 34810;
const PLAN_PATH_DEFAULT = path.join(ROOT, 'tmp', 'marketing-signup', 'coupon-submit-results', 'coupon-extra-vs-ordinary-plan-2026-06-03.json');
const LEVEL_RULE_HINT_DEFAULT = path.join(ROOT, 'config', 'marketing_coupon_level_rules.json');
const OUT_DIR = path.join(ROOT, 'tmp', 'marketing-signup', 'old-ordinary-overlap-risk');
const STORES_CONFIG = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'stores.json'), 'utf8'));
const STORES = STORES_CONFIG.stores || [];
const ACTIVE_COUPON_STATUSES = new Set(['0', '1']);
const ACTIVE_OR_FUTURE_ACTIVITY_STATES = new Set(['2', '3']);

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function splitStores(value) { return String(value || '').split(',').map(x => x.trim()).filter(Boolean); }
function parseTime(value) {
  if (!value) return null;
  const d = new Date(String(value).replace(' ', 'T') + '+08:00');
  return Number.isFinite(d.getTime()) ? d : null;
}
function isCouponActivity(a) {
  const text = [a.name, a.label, a.backendCate, a.raw?.multi_level_coupon_activity ? 'coupon' : ''].filter(Boolean).join(' ');
  return Number(a.activityId) === ACTIVITY_ID_DEFAULT || /coupon|优惠券/i.test(text);
}
function isActiveOrFutureOrdinary(a) {
  if (isCouponActivity(a)) return false;
  const end = parseTime(a.eventEnd);
  if (end && end.getTime() < Date.now()) return false;
  const state = String(a.raw?.state ?? a.raw?.activity_state ?? '');
  if (state && !ACTIVE_OR_FUTURE_ACTIVITY_STATES.has(state)) return false;
  return true;
}
function normalizeActivity(a) {
  return {
    activityId: Number(a.activity_id),
    name: a.activity_name || '',
    backendCate: a.backend_cate,
    label: a.text_tag_content || '',
    signStart: a.activity_start_zone_time || '',
    signEnd: a.activity_end_zone_time || '',
    eventStart: a.start_zone_time || '',
    eventEnd: a.end_zone_time || '',
    allowGoodsNum: Number(a.allow_goods_num || 0),
    applyGoodsNum: Number(a.apply_goods_num || 0),
    raw: a,
  };
}
function parseArgs(argv) {
  const out = {
    stores: [],
    activityId: ACTIVITY_ID_DEFAULT,
    targetPlan: PLAN_PATH_DEFAULT,
    levelRuleHints: LEVEL_RULE_HINT_DEFAULT,
    noLaunch: false,
    noClose: false,
    pageSize: 500,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--stores') out.stores.push(...splitStores(argv[++i]));
    else if (a === '--activity-id') out.activityId = Number(argv[++i]);
    else if (a === '--target-plan') out.targetPlan = argv[++i];
    else if (a === '--level-rule-hints') out.levelRuleHints = argv[++i];
    else if (a === '--no-launch') out.noLaunch = true;
    else if (a === '--no-close' || a === '--keep-open') out.noClose = true;
    else if (a === '--page-size') out.pageSize = Number(argv[++i]);
    else if (!a.startsWith('--')) out.stores.push(...splitStores(a));
  }
  out.stores = [...new Set(out.stores.map(s => s.toUpperCase()))];
  if (!out.stores.length) out.stores = STORES.filter(s => s.enabled !== false).map(s => String(s.storeKey).toUpperCase());
  if (out.activityId !== ACTIVITY_ID_DEFAULT) throw new Error('Only coupon activity 34810 is verified for this scanner');
  if (!Number.isFinite(out.pageSize) || out.pageSize < 50) out.pageSize = 500;
  return out;
}
function psSingleQuote(value) { return `'${String(value).replaceAll("'", "''")}'`; }
function closeExistingStoreChrome(store) {
  if (process.platform !== 'win32') return;
  const profileNeedle = `persistent-${store.profileKey}-profile`;
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$needle = ${psSingleQuote(profileNeedle)}`,
    "$procs = Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" | Where-Object { $_.CommandLine -like \"*$needle*\" }",
    'foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }',
  ].join('\n');
  spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {cwd: ROOT, stdio: 'ignore', timeout: 20_000});
}
function launchVisible(store, url) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'launch_store_browser.mjs'), store.storeKey, '--visible', '--url', url], {cwd: ROOT, encoding: 'utf8', timeout: 20_000});
  if (r.status !== 0) throw new Error(`launch visible failed for ${store.storeKey}: ${r.stderr || r.stdout}`);
}
async function httpJson(url) {
  const res = await fetch(url, {signal: AbortSignal.timeout(8000)});
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  return await res.json();
}
async function isCdpOpen(port) {
  try { return (await fetch(`http://127.0.0.1:${port}/json/version`, {signal: AbortSignal.timeout(2500)})).ok; } catch { return false; }
}
async function ensureBrowser(store, args) {
  let launched = false;
  if (!args.noLaunch && !(await isCdpOpen(store.port))) {
    launchVisible(store, LIST_URL);
    launched = true;
    await sleep(6500);
  }
  return {launched};
}
class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.ws = null; this.id = 0; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => { this.ws.addEventListener('open', resolve, {once: true}); this.ws.addEventListener('error', reject, {once: true}); });
    this.ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const item = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(item.timer);
        msg.error ? item.reject(new Error(JSON.stringify(msg.error))) : item.resolve(msg.result);
      }
    });
    await this.call('Runtime.enable');
  }
  call(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({id, method, params}));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }
      }, 120_000);
      this.pending.set(id, {resolve, reject, timer});
    });
  }
  async eval(body, arg = undefined) {
    const encoded = arg === undefined ? 'undefined' : JSON.stringify(arg).replace(/</g, '\\u003c');
    const expression = `(async () => { const __arg = ${encoded}; ${body} })()`;
    const res = await this.call('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true, userGesture: true});
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || JSON.stringify(res.exceptionDetails));
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
async function readPageLoginState(cdp) {
  return await cdp.eval(`
    const text = document.body?.innerText || '';
    return {href: location.href, isLogin: location.href.includes('/login/') || text.includes('请输入账号') || text.includes('请输入密码') || (text.includes('账号登录') && text.includes('密码') && text.includes('登录')), tail: text.slice(-1000)};
  `);
}
async function gotoListPage(cdp) { await cdp.eval(`location.href = __arg.url; return {href: location.href};`, {url: LIST_URL}); await sleep(2500); return await readPageLoginState(cdp); }
async function gotoCouponGoodsPage(cdp, activityId, levelRuleId) { await cdp.eval(`location.href = __arg.url; return {href: location.href};`, {url: COUPON_GOODS_URL(activityId, levelRuleId)}); await sleep(2500); return await readPageLoginState(cdp); }
async function clickLoginOnce(cdp) {
  const target = await cdp.eval(`
    const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const textOf = el => (el?.innerText || el?.textContent || '').trim();
    const buttons = [...document.querySelectorAll('button,[role=button],a')].filter(visible).map(el => ({el, text: textOf(el), disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true'}));
    const btn = buttons.find(x => !x.disabled && x.text === '我已知晓，继续登录') || buttons.find(x => !x.disabled && x.text.includes('继续登录') && x.text.length <= 20) || buttons.find(x => !x.disabled && x.text === '登录') || buttons.find(x => !x.disabled && x.text.includes('登录') && x.text.length <= 12);
    if (!btn) return {found:false, href:location.href, buttons:buttons.map(x=>x.text).filter(Boolean).slice(0,20), tail:(document.body?.innerText||'').slice(-800)};
    btn.el.scrollIntoView({block:'center', inline:'center'});
    const rect = btn.el.getBoundingClientRect();
    return {found:true, href:location.href, text:btn.text, x:rect.left+rect.width/2, y:rect.top+rect.height/2};
  `);
  if (!target.found) return {clicked:false, ...target};
  await cdp.call('Input.dispatchMouseEvent', {type:'mouseMoved', x:target.x, y:target.y, button:'none'});
  await cdp.call('Input.dispatchMouseEvent', {type:'mousePressed', x:target.x, y:target.y, button:'left', clickCount:1});
  await cdp.call('Input.dispatchMouseEvent', {type:'mouseReleased', x:target.x, y:target.y, button:'left', clickCount:1});
  return {clicked:true, ...target};
}
async function recoverLoginIfNeeded(cdp) {
  const before = await readPageLoginState(cdp);
  if (!before.isLogin) return {needed:false, before, after:before};
  const attempts = [];
  let after = before;
  for (let attemptNo = 1; attemptNo <= 4; attemptNo += 1) {
    const clicked = await clickLoginOnce(cdp);
    attempts.push({attemptNo, ...clicked});
    await sleep(String(clicked.text || '').includes('继续登录') ? 2000 : 5000);
    after = await readPageLoginState(cdp);
    if (!after.isLogin) break;
    if (attemptNo === 2) { await cdp.eval(`location.reload(); return {href:location.href};`); await sleep(2500); after = await readPageLoginState(cdp); if (!after.isLogin) break; }
  }
  return {needed:true, before, attempts, after};
}
async function readJson(file) { return JSON.parse(await fs.readFile(path.resolve(ROOT, file), 'utf8')); }
async function loadPlan(planPath) {
  const absolute = path.resolve(ROOT, planPath);
  const doc = await readJson(absolute);
  const rows = [];
  async function addDoc(sourcePath, value) {
    if (Array.isArray(value?.ordinaryPlanPaths)) { for (const nested of value.ordinaryPlanPaths) await addDoc(nested, await readJson(nested)); return; }
    const items = Array.isArray(value) ? value : (value?.items || []);
    for (const item of items) {
      if (!item?.storeKey || !item?.skc || item.selected === false) continue;
      rows.push({...item, storeKey: String(item.storeKey).toUpperCase(), skc: String(item.skc).trim(), activityId: Number(item.activityId || 0), _sourcePlan: path.relative(ROOT, path.resolve(ROOT, sourcePath))});
    }
  }
  await addDoc(absolute, doc);
  const byStoreActivitySkc = new Set();
  const byStoreSkc = new Map();
  for (const row of rows) {
    byStoreActivitySkc.add(`${row.storeKey}|${row.activityId}|${row.skc}`);
    if (!byStoreSkc.has(row.storeKey)) byStoreSkc.set(row.storeKey, new Map());
    if (!byStoreSkc.get(row.storeKey).has(row.skc)) byStoreSkc.get(row.storeKey).set(row.skc, row);
  }
  return {path: absolute, rows, byStoreActivitySkc, byStoreSkc};
}
async function loadLevelRuleHints(file) {
  const hints = new Map();
  if (file && fsSync.existsSync(path.resolve(ROOT, file))) {
    const doc = await readJson(file);
    for (const row of doc.checks || []) if (row.store && row.levelRuleId) hints.set(String(row.store).toUpperCase(), Number(row.levelRuleId));
    const configuredStores = doc?.activities?.[String(ACTIVITY_ID_DEFAULT)]?.stores || {};
    for (const [storeKey, row] of Object.entries(configuredStores)) {
      const levelRuleId = Number(row?.levelRuleId);
      if (Number.isFinite(levelRuleId) && levelRuleId > 0) hints.set(String(storeKey).toUpperCase(), levelRuleId);
    }
  }
  const resultDir = path.join(ROOT, 'tmp', 'marketing-signup', 'coupon-submit-results');
  if (fsSync.existsSync(resultDir)) {
    for (const entry of fsSync.readdirSync(resultDir, {withFileTypes:true})) {
      if (!entry.isFile()) continue;
      const m = entry.name.match(/^([A-Z]+)-34810\.json$/);
      if (!m) continue;
      const storeKey = m[1].toUpperCase();
      if (hints.has(storeKey)) continue;
      try {
        const result = JSON.parse(fsSync.readFileSync(path.join(resultDir, entry.name), 'utf8'));
        const levelRuleId = Number(result?.rule?.levelRuleId || result?.beforeEnrolled?.sample?.[0]?.levelRuleId || result?.afterEnrolled?.sample?.[0]?.levelRuleId);
        if (Number.isFinite(levelRuleId) && levelRuleId > 0) hints.set(storeKey, levelRuleId);
      } catch {}
    }
  }
  return hints;
}
function bestActivityPrice(item) {
  const sku = Array.isArray(item.activity_sku_list) ? item.activity_sku_list[0] : null;
  const candidates = [item.activity_price, item.product_act_price, item.attend_price, item.price, item.activity_price_str, sku?.activity_price, sku?.product_act_price, sku?.attend_price];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
async function readLive(cdp, args, levelRuleId) {
  return await cdp.eval(`
    const baseHeaders = {'content-type':'application/json;charset=UTF-8','Origin-Url':location.href,'x-req-zone-id':'Asia/Shanghai','x-lt-language':'CN','LAN':'CN'};
    async function post(path, body, route='/mbrs/marketing/list'){
      const headers = {...baseHeaders, 'x-bbl-route': route};
      const res = await fetch('/mrs-api-prefix'+path,{method:'POST',credentials:'include',headers,body:JSON.stringify(body||{})});
      const text = await res.text(); let json=null; try{json=JSON.parse(text)}catch{};
      return {http:res.status, code:json?.code, msg:json?.msg || text.slice(0,300), info:json?.info ?? json};
    }
    function arrayFrom(v){ if(Array.isArray(v)) return v; if(Array.isArray(v?.data)) return v.data; if(Array.isArray(v?.list)) return v.list; if(Array.isArray(v?.records)) return v.records; if(Array.isArray(v?.partake_goods_list)) return v.partake_goods_list; return []; }
    const text = document.body?.innerText || '';
    const page = {href: location.href, title: document.title, loginLike: location.href.includes('/login/') || (text.includes('账号登录') && text.includes('密码') && text.includes('登录'))};
    const activities = [];
    const pages = [];
    for(let pageNum=1; pageNum<=20; pageNum++){
      const q = await post('/mbrs/activity/get_activity_list?page_num='+pageNum+'&page_size=100', {});
      const list = arrayFrom(q.info?.activity_detail_list ?? q.info);
      pages.push({pageNum,http:q.http,code:q.code,msg:q.msg,count:list.length});
      if(q.code !== '0') break;
      activities.push(...list);
      if(list.length < 100) break;
    }
    const couponRoute = '/mbrs/marketing/coupon/rule/goods/' + __arg.activityId + '/' + __arg.levelRuleId;
    const couponPackets = [];
    const couponGoods = [];
    for(let pageNum=1; pageNum<=50; pageNum++){
      const q = await post('/mbrs/activity/multi-level/goods/query?page_num='+pageNum+'&page_size='+__arg.pageSize, {activity_id:__arg.activityId, level_rule_id:__arg.levelRuleId, page:'COUPON', page_module:'MULTI_LEVEL_RULE_ENROLLED_GOODS', product_code_list:[], supplier_no_list:[]}, couponRoute);
      const list = arrayFrom(q.info?.partake_goods_list ?? q.info);
      const total = Number(q.info?.total ?? list.length ?? 0);
      couponPackets.push({pageNum,http:q.http,code:q.code,msg:q.msg,total,count:list.length});
      if(q.code !== '0') break;
      couponGoods.push(...list);
      if(!list.length || couponGoods.length >= total || list.length < __arg.pageSize) break;
    }
    const ordinaryPackets = [];
    const ordinaryGoods = [];
    for(const activity of __arg.activities){
      const route = '/mbrs/marketing/sign-up/config/' + activity.activityId;
      for(let pageNum=1; pageNum<=50; pageNum++){
        const q = await post('/mbrs/activity/get_partake_activity_goods_list?page_num='+pageNum+'&page_size='+__arg.pageSize, {activity_id_list:[activity.activityId], query_coupon:false, skc_list:[], audit_status:[0,1]}, route);
        const list = arrayFrom(q.info?.data ?? q.info);
        const total = Number(q.info?.meta?.total ?? q.info?.total ?? list.length ?? 0);
        ordinaryPackets.push({activityId:activity.activityId,pageNum,http:q.http,code:q.code,msg:q.msg,total,count:list.length});
        if(q.code !== '0') break;
        ordinaryGoods.push(...list.map(item => ({...item, __activity: activity})));
        if(!list.length || ordinaryGoods.filter(x=>Number(x.__activity.activityId)===Number(activity.activityId)).length >= total || list.length < __arg.pageSize) break;
      }
    }
    return {page, pages, activities, couponPackets, couponGoods, ordinaryPackets, ordinaryGoods};
  `, {activityId: args.activityId, levelRuleId, pageSize: args.pageSize, activities: args.__ordinaryActivities || []});
}
async function scanStore(store, args, plan, levelRuleId) {
  const result = {store: store.storeKey, shopName: store.shopName, levelRuleId, ok: false, risks: [], warnings: []};
  let cdp = null;
  let launched = false;
  try {
    const ensured = await ensureBrowser(store, args);
    launched = ensured.launched;
    cdp = await connectStorePage(store);
    result.loginRecovery = await recoverLoginIfNeeded(cdp);
    if (result.loginRecovery.after?.isLogin) { result.reason = 'login page after automatic login recovery; skipped live scan'; return result; }
    result.listPage = await gotoListPage(cdp);
    if (result.listPage?.isLogin) { result.reason = 'login page after navigating to marketing list; skipped live scan'; return result; }

    let firstLive = await readLive(cdp, {...args, __ordinaryActivities: []}, levelRuleId);
    const rawActivities = (firstLive.activities || []).map(normalizeActivity).filter(a => Number.isFinite(a.activityId) && isActiveOrFutureOrdinary(a));
    const ordinaryActivities = rawActivities;
    result.activityList = {pages: firstLive.pages || [], ordinaryActiveOrFuture: ordinaryActivities.length, sample: ordinaryActivities.slice(0, 10).map(a => ({activityId:a.activityId,name:a.name,eventStart:a.eventStart,eventEnd:a.eventEnd,signEnd:a.signEnd,applyGoodsNum:a.applyGoodsNum,allowGoodsNum:a.allowGoodsNum}))};

    let live = await readLive(cdp, {...args, __ordinaryActivities: ordinaryActivities}, levelRuleId);
    if ((live.couponPackets || []).some(p => String(p.code) === '20302')) {
      result.couponGoodsPageRetry = await gotoCouponGoodsPage(cdp, args.activityId, levelRuleId);
      if (result.couponGoodsPageRetry?.isLogin) {
        result.couponGoodsLoginRecovery = await recoverLoginIfNeeded(cdp);
        if (result.couponGoodsLoginRecovery.after?.isLogin) { result.reason = 'coupon goods page login recovery did not restore session'; return result; }
      }
      live = await readLive(cdp, {...args, __ordinaryActivities: ordinaryActivities}, levelRuleId);
    }
    result.page = live.page;
    if (live.page?.loginLike) { result.reason = 'login page; skipped live scan'; return result; }
    const badCouponPackets = (live.couponPackets || []).filter(p => String(p.code) !== '0');
    if (badCouponPackets.length) { result.coupon = {levelRuleId, packets: live.couponPackets || [], enrolledCount: live.couponGoods?.length || 0}; result.reason = `15% enrolled coupon query failed: ${badCouponPackets.map(p => `${p.code}:${p.msg}`).join('; ')}`; return result; }

    const couponActive = new Set((live.couponGoods || []).filter(g => ACTIVE_COUPON_STATUSES.has(String(g.status ?? ''))).map(g => String(g.skc || '').trim()).filter(Boolean));
    result.coupon = {levelRuleId, packets: live.couponPackets || [], enrolledCount: live.couponGoods?.length || 0, activeCount: couponActive.size};
    result.ordinaryPackets = live.ordinaryPackets || [];
    const badOrdinaryPackets = result.ordinaryPackets.filter(p => String(p.code) !== '0');
    if (badOrdinaryPackets.length) result.warnings.push({type:'ordinary_packet_errors', count: badOrdinaryPackets.length, sample: badOrdinaryPackets.slice(0, 10)});

    const seen = new Set();
    for (const item of live.ordinaryGoods || []) {
      const skc = String(item.skc || '').trim();
      const activity = item.__activity || {};
      const activityId = Number(item.activity_id || activity.activityId || 0);
      if (!skc || !activityId) continue;
      const key = `${store.storeKey}|${activityId}|${skc}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const hasActiveCoupon = couponActive.has(skc);
      const authorizedCurrentPlan = plan.byStoreActivitySkc.has(key);
      const planRow = plan.byStoreSkc.get(store.storeKey)?.get(skc) || null;
      if (!hasActiveCoupon && !authorizedCurrentPlan) continue;
      result.risks.push({
        storeKey: store.storeKey,
        activityId: args.activityId,
        levelRuleId,
        skc,
        supplierNo: item.supplier_no || item.supplierNo || item.sku_supplier_no || planRow?.supplierNo || planRow?.canonical || '',
        canonical: planRow?.canonical || '',
        riskReason: hasActiveCoupon
          ? (authorizedCurrentPlan ? 'authorized_active_15pct_coupon_overlaps_current_ordinary_plan' : 'active_15pct_coupon_overlaps_unplanned_old_ordinary_marketing_activity')
          : 'ordinary_activity_without_active_coupon',
        hasActiveCoupon,
        authorizedCurrentPlan,
        ordinaryMarketingActivityId: activityId,
        ordinaryMarketingActivityName: item.activity_name || activity.name || '',
        ordinaryMarketingStart: activity.eventStart || '',
        ordinaryMarketingEnd: activity.eventEnd || '',
        ordinaryMarketingSignEnd: activity.signEnd || '',
        ordinaryMarketingState: item.activity_state ?? activity.raw?.state ?? '',
        ordinaryMarketingPrice: bestActivityPrice(item),
        auditStatus: item.audit_status ?? '',
        goodsAuditStatus: item.goods_audit_status ?? '',
        ordinaryPlanActivityId: planRow?.activityId || '',
        ordinaryPlanTargetPrice: planRow?.targetPrice ?? '',
      });
    }
    result.ok = true;
    const cancelable = result.risks.filter(r => r.hasActiveCoupon && !r.authorizedCurrentPlan).length;
    result.reason = `ordinary overlap scan ok; active coupon=${couponActive.size}, ordinary rows=${seen.size}, cancelable=${cancelable}`;
    return result;
  } catch (err) {
    result.reason = err.message;
    result.stack = err.stack;
    return result;
  } finally {
    cdp?.close();
    if (launched && !args.noClose) closeExistingStoreChrome(store);
  }
}
function csvEscape(value) { const s = String(value ?? ''); return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; }
function toCsv(rows, headers) { return [headers.join(','), ...rows.map(row => headers.map(h => csvEscape(row[h])).join(','))].join('\r\n') + '\r\n'; }

await fs.mkdir(OUT_DIR, {recursive: true});
const args = parseArgs(process.argv.slice(2));
const plan = await loadPlan(args.targetPlan);
const levelHints = await loadLevelRuleHints(args.levelRuleHints);
const selectedStores = args.stores.map(key => { const store = STORES.find(s => String(s.storeKey).toUpperCase() === key); if (!store) throw new Error(`Unknown store ${key}`); return store; });
const summary = {createdAt: new Date().toISOString(), activityId: args.activityId, targetPlan: path.relative(ROOT, plan.path), levelRuleHints: args.levelRuleHints ? path.relative(ROOT, path.resolve(ROOT, args.levelRuleHints)) : '', stores: []};
for (const store of selectedStores) {
  const levelRuleId = levelHints.get(String(store.storeKey).toUpperCase()) || null;
  console.log(`[${store.storeKey}] scan coupon/old ordinary overlap: levelRuleId=${levelRuleId || '-'}`);
  if (!levelRuleId) { summary.stores.push({store: store.storeKey, ok:false, risks:[], reason:'missing 15% levelRuleId'}); continue; }
  const result = await scanStore(store, args, plan, levelRuleId);
  summary.stores.push(result);
  console.log(`[${store.storeKey}] ${result.ok ? 'OK' : 'WARN'} risks=${result.risks?.length || 0} ${result.reason || ''}`);
}
const riskRows = summary.stores.flatMap(s => s.risks || []);
const observationRows = riskRows.filter(row => row.hasActiveCoupon && !row.authorizedCurrentPlan && row.levelRuleId).map(row => ({
  storeKey: row.storeKey,
  activityId: args.activityId,
  levelRuleId: row.levelRuleId,
  skc: row.skc,
  supplierNo: row.supplierNo,
  reason: row.riskReason,
  riskReason: row.riskReason,
  ordinaryMarketingActivityId: row.ordinaryMarketingActivityId,
  ordinaryMarketingActivityName: row.ordinaryMarketingActivityName,
  ordinaryMarketingEnd: row.ordinaryMarketingEnd,
}));
const cancelRows = [];
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const jsonFile = path.join(OUT_DIR, `coupon-old-ordinary-overlap-live-${stamp}.json`);
const csvFile = path.join(OUT_DIR, `coupon-old-ordinary-overlap-live-${stamp}.csv`);
const cancelFile = path.join(OUT_DIR, `coupon-old-ordinary-overlap-cancel-list-${stamp}.json`);
summary.riskCount = riskRows.length;
summary.authorizedActiveOverlapCount = riskRows.filter(row => row.hasActiveCoupon && row.authorizedCurrentPlan).length;
summary.activeCouponObservationCount = observationRows.length;
summary.activeCouponRiskCount = cancelRows.length;
summary.cancelList = {path: path.relative(ROOT, cancelFile), rows: cancelRows.length};
await fs.writeFile(jsonFile, JSON.stringify(summary, null, 2), 'utf8');
await fs.writeFile(csvFile, toCsv(riskRows, ['storeKey','skc','supplierNo','canonical','riskReason','hasActiveCoupon','authorizedCurrentPlan','levelRuleId','ordinaryMarketingActivityId','ordinaryMarketingActivityName','ordinaryMarketingStart','ordinaryMarketingEnd','ordinaryMarketingPrice','auditStatus','goodsAuditStatus','ordinaryPlanActivityId','ordinaryPlanTargetPrice']), 'utf8');
await fs.writeFile(cancelFile, JSON.stringify({
  createdAt: summary.createdAt,
  mode: 'observation-only-old-ordinary-overlap',
  riskCancel: false,
  purpose: 'observe active 15pct coupon rows that overlap unplanned old ordinary marketing activity; do not cancel without price-stack evidence',
  ordinaryPlanPaths: Array.isArray((await readJson(args.targetPlan)).ordinaryPlanPaths) ? (await readJson(args.targetPlan)).ordinaryPlanPaths : [path.relative(ROOT, plan.path)],
  sourceScan: path.relative(ROOT, jsonFile),
  observationRows,
  rows: cancelRows,
}, null, 2), 'utf8');
console.log(`\nJSON ${jsonFile}`);
console.log(`CSV ${csvFile}`);
console.log(`CANCEL_LIST ${cancelFile}`);
console.log(`RISK_ROWS ${riskRows.length}`);
console.log(`AUTHORIZED_ACTIVE_OVERLAP_ROWS ${summary.authorizedActiveOverlapCount}`);
console.log(`ACTIVE_COUPON_OBSERVATION_ROWS ${observationRows.length}`);
console.log(`ACTIVE_COUPON_RISK_ROWS ${cancelRows.length}`);
