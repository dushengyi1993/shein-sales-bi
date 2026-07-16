#!/usr/bin/env node
/**
 * Read-only live scan for low-price overlap risks in coupon activity 34810.
 *
 * Project invariant:
 * Paired 15% coupon SKCs are evaluated by final price, not by overlap label.
 * Historical BI labels are only hints; this scanner uses the live seller-center
 * limited-discount list plus the live multi-level coupon enrolled list, then
 * compares limitedDiscountPrice * couponFactor against the audited
 * finalTargetPrice before producing any cancel candidate.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {
  PRICE_GUARD_TOLERANCE_SAR,
  classifyLimitedDiscountCouponStack,
  loadCouponTargetEligibilityPlan,
} from '../../lib/marketing_coupon_policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LIST_URL = 'https://sso.geiwohuo.com/#/mbrs/marketing/list';
const COUPON_DETAIL_URL = id => `https://sso.geiwohuo.com/#/mbrs/marketing/coupon/detail/${id}`;
const COUPON_GOODS_URL = (activityId, levelRuleId) => `https://sso.geiwohuo.com/#/mbrs/marketing/coupon/rule/goods/${activityId}/${levelRuleId}`;
const ACTIVITY_ID_DEFAULT = 34810;
const PLAN_PATH_DEFAULT = path.join(ROOT, 'tmp', 'marketing-signup', 'selection-plan-2026-06-03-ALL-ready.json');
const LEVEL_RULE_HINT_DEFAULT = path.join(ROOT, 'config', 'marketing_coupon_level_rules.json');
const ALLOWED_OVERLAP_DEFAULT = path.join(ROOT, 'config', 'marketing_allowed_limited_coupon_overlaps.json');
const OUT_DIR = path.join(ROOT, 'tmp', 'marketing-signup', 'low-price-overlap-risk');
const STORES_CONFIG = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'stores.json'), 'utf8'));
const STORES = STORES_CONFIG.stores || [];
const ACTIVE_COUPON_STATUSES = new Set(['0', '1']);
const ACTIVE_OR_FUTURE_LIMITED_STATES = new Set(['2', '3']);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function splitStores(value) {
  return String(value || '').split(',').map(x => x.trim()).filter(Boolean);
}

function parseArgs(argv) {
  const out = {
    stores: [],
    activityId: ACTIVITY_ID_DEFAULT,
    targetPlan: PLAN_PATH_DEFAULT,
    priceOverrides: [],
    levelRuleHints: LEVEL_RULE_HINT_DEFAULT,
    allowedOverlapList: ALLOWED_OVERLAP_DEFAULT,
    noLaunch: false,
    noClose: false,
    pageSize: 500,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--stores') out.stores.push(...splitStores(argv[++i]));
    else if (a === '--activity-id') out.activityId = Number(argv[++i]);
    else if (a === '--target-plan') out.targetPlan = argv[++i];
    else if (a === '--price-overrides' || a === '--coupon-price-overrides') out.priceOverrides.push(...splitStores(argv[++i]));
    else if (a === '--level-rule-hints') out.levelRuleHints = argv[++i];
    else if (a === '--allowed-overlap-list') out.allowedOverlapList = argv[++i];
    else if (a === '--no-allowed-overlap-list') out.allowedOverlapList = '';
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

function psSingleQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function closeExistingStoreChrome(store) {
  if (process.platform !== 'win32') return;
  const profileNeedle = `persistent-${store.profileKey}-profile`;
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$needle = ${psSingleQuote(profileNeedle)}`,
    "$procs = Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" | Where-Object { $_.CommandLine -like \"*$needle*\" }",
    'foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }',
  ].join('\n');
  spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ], {cwd: ROOT, stdio: 'ignore', timeout: 20_000});
}

function launchVisible(store, url) {
  const r = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'launch_store_browser.mjs'),
    store.storeKey,
    '--visible',
    '--url',
    url,
  ], {cwd: ROOT, encoding: 'utf8', timeout: 20_000});
  if (r.status !== 0) throw new Error(`launch visible failed for ${store.storeKey}: ${r.stderr || r.stdout}`);
}

async function httpJson(url, opts = {}) {
  const res = await fetch(url, {signal: AbortSignal.timeout(8000), ...opts});
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  return await res.json();
}

async function isCdpOpen(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {signal: AbortSignal.timeout(2500)});
    return res.ok;
  } catch {
    return false;
  }
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
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, {once: true});
      this.ws.addEventListener('error', reject, {once: true});
    });
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
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 120_000);
      this.pending.set(id, {resolve, reject, timer});
    });
  }
  async eval(body, arg = undefined) {
    const encoded = arg === undefined ? 'undefined' : JSON.stringify(arg).replace(/</g, '\\u003c');
    const expression = `(async () => { const __arg = ${encoded}; ${body} })()`;
    const res = await this.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text || JSON.stringify(res.exceptionDetails);
      throw new Error(desc);
    }
    return res.result?.value;
  }
  close() {
    try { this.ws?.close(); } catch {}
  }
}

async function connectStorePage(store) {
  const targets = await httpJson(`http://127.0.0.1:${store.port}/json/list`);
  const page = targets.find(t => t.type === 'page' && String(t.url || '').includes('sso.geiwohuo.com'))
    || targets.find(t => t.type === 'page');
  if (!page) throw new Error(`port ${store.port} no page target`);
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();
  return cdp;
}

async function clickLoginOnce(cdp) {
  const target = await cdp.eval(`
    const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const textOf = el => (el?.innerText || el?.textContent || '').trim();
    const buttons = [...document.querySelectorAll('button,[role=button],a')]
      .filter(visible)
      .map(el => ({el, text: textOf(el), disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true'}));
    const btn = buttons.find(x => !x.disabled && x.text === '我已知晓，继续登录')
      || buttons.find(x => !x.disabled && x.text.includes('继续登录') && x.text.length <= 20)
      || buttons.find(x => !x.disabled && x.text === '登录')
      || buttons.find(x => !x.disabled && x.text.includes('登录') && x.text.length <= 12);
    if (!btn) return {found: false, href: location.href, buttons: buttons.map(x => x.text).filter(Boolean).slice(0, 20), tail: (document.body?.innerText || '').slice(-800)};
    btn.el.scrollIntoView({block: 'center', inline: 'center'});
    const rect = btn.el.getBoundingClientRect();
    return {found: true, href: location.href, text: btn.text, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
  `);
  if (!target.found) return {clicked: false, ...target};
  await cdp.call('Input.dispatchMouseEvent', {type: 'mouseMoved', x: target.x, y: target.y, button: 'none'});
  await cdp.call('Input.dispatchMouseEvent', {type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1});
  await cdp.call('Input.dispatchMouseEvent', {type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1});
  return {clicked: true, ...target};
}

async function readPageLoginState(cdp) {
  return await cdp.eval(`
    const text = document.body?.innerText || '';
    return {
      href: location.href,
      isLogin: location.href.includes('/login/') || text.includes('请输入账号') || text.includes('请输入密码') || (text.includes('账号登录') && text.includes('密码') && text.includes('登录')),
      tail: text.slice(-1000),
    };
  `);
}

async function recoverLoginIfNeeded(cdp) {
  const before = await readPageLoginState(cdp);
  if (!before.isLogin) return {needed: false, before, after: before};

  const attempts = [];
  let after = before;
  for (let attemptNo = 1; attemptNo <= 4; attemptNo += 1) {
    const clicked = await clickLoginOnce(cdp);
    attempts.push({attemptNo, ...clicked});
    await sleep(String(clicked.text || '').includes('继续登录') ? 2000 : 5000);
    after = await readPageLoginState(cdp);
    if (!after.isLogin) break;
    if (attemptNo === 2) {
      await cdp.eval(`location.reload(); return {href: location.href};`);
      await sleep(2500);
      after = await readPageLoginState(cdp);
      if (!after.isLogin) break;
    }
  }
  return {needed: true, before, attempts, after};
}

async function gotoListPage(cdp) {
  await cdp.eval(`location.href = __arg.url; return {href: location.href};`, {url: LIST_URL});
  await sleep(2500);
  return await readPageLoginState(cdp);
}

async function snapshot(cdp) {
  return await cdp.eval(`
    const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const text = document.body?.innerText || '';
    const buttons = [...document.querySelectorAll('button,[role=button]')]
      .filter(visible)
      .map(b => ({text: (b.innerText || b.textContent || '').trim(), disabled: !!b.disabled || b.getAttribute('aria-disabled') === 'true'}))
      .filter(x => x.text);
    return {
      href: location.href,
      title: document.title,
      hasLogin: location.href.includes('/login/') || text.includes('请输入账号') || text.includes('请输入密码') || (text.includes('账号登录') && text.includes('密码') && text.includes('登录')),
      hasCouponDetail: location.href.includes('/marketing/coupon/detail/') || text.includes('优惠券活动管理') || text.includes('继续报名'),
      hasRuleSignup: location.href.includes('/marketing/coupon/rule/signup/'),
      buttons: buttons.slice(-60),
      tail: text.slice(-1500),
    };
  `);
}

async function gotoCouponDetail(cdp, activityId) {
  await cdp.eval(`location.href = __arg.url; return {href: location.href};`, {url: COUPON_DETAIL_URL(activityId)});
  const deadline = Date.now() + 35_000;
  let last = null;
  while (Date.now() < deadline) {
    await sleep(800);
    last = await snapshot(cdp).catch(() => null);
    if (last?.hasLogin || last?.hasCouponDetail || last?.hasRuleSignup) return last;
  }
  return last || await snapshot(cdp).catch(err => ({error: err.message}));
}

async function gotoCouponGoodsPage(cdp, activityId, levelRuleId) {
  await cdp.eval(`location.href = __arg.url; return {href: location.href};`, {url: COUPON_GOODS_URL(activityId, levelRuleId)});
  await sleep(2500);
  return await readPageLoginState(cdp);
}

async function clickContinueAndGetRuleId(cdp, activityId, discountMax = 15) {
  const info = await cdp.eval(`
    if (location.href.includes('/coupon/rule/signup/${activityId}/')) {
      return {found: true, href: location.href, alreadyOnSignup: true};
    }
    const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const textOf = el => (el?.innerText || el?.textContent || '').trim();
    const buttons = [...document.querySelectorAll('button,[role=button]')]
      .filter(visible)
      .map((el, index) => {
        let node = el;
        let ctx = '';
        for (let i = 0; i < 6 && node; i += 1) {
          ctx = textOf(node);
          if (ctx.length > 20 && ctx.length < 2500) break;
          node = node.parentElement;
        }
        return {el, index, text: textOf(el), ctx};
      })
      .filter(x => x.text === '继续报名' || x.text === '报名' || x.text === '去报名');
    if (!buttons.length) return {found: false, href: location.href, text: (document.body.innerText || '').slice(0, 3000)};
    const preferred = buttons.find(x => x.ctx.includes('15') || x.ctx.includes('1%-15') || x.ctx.includes('1%-15%')) || buttons[0];
    preferred.el.scrollIntoView({block: 'center', inline: 'center'});
    preferred.el.click();
    const started = Date.now();
    while (Date.now() - started < 25_000) {
      if (location.href.includes('/coupon/rule/signup/${activityId}/')) break;
      await new Promise(r => setTimeout(r, 500));
    }
    return {found: true, href: location.href, clickedText: preferred.text, clickedContext: preferred.ctx.slice(0, 1000), buttonCount: buttons.length};
  `);
  const m = String(info?.href || '').match(new RegExp(`/coupon/rule/signup/${activityId}/(\\d+)`));
  if (!m) throw new Error(`continue signup route not reached: ${JSON.stringify(info)}`);
  return {...info, levelRuleId: Number(m[1]), discountMax};
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(path.resolve(ROOT, file), 'utf8'));
}

async function loadPlan(planPath) {
  const absolute = path.resolve(ROOT, planPath);
  const doc = await readJson(absolute);
  const rows = [];
  async function addDoc(sourcePath, value) {
    if (Array.isArray(value?.ordinaryPlanPaths)) {
      for (const nested of value.ordinaryPlanPaths) {
        await addDoc(nested, await readJson(nested));
      }
      return;
    }
    const items = Array.isArray(value) ? value : (value?.items || []);
    for (const item of items) {
      if (!item?.storeKey || !item?.skc || item.selected === false) continue;
      rows.push({
        ...item,
        storeKey: String(item.storeKey).toUpperCase(),
        skc: String(item.skc).trim(),
        _sourcePlan: path.relative(ROOT, path.resolve(ROOT, sourcePath)),
      });
    }
  }
  await addDoc(absolute, doc);
  const byStore = new Map();
  for (const row of rows) {
    if (!byStore.has(row.storeKey)) byStore.set(row.storeKey, new Map());
    if (!byStore.get(row.storeKey).has(row.skc)) byStore.get(row.storeKey).set(row.skc, row);
  }
  return {path: absolute, rows, byStore};
}

async function loadLevelRuleHints(file) {
  const hints = new Map();
  if (file && fsSync.existsSync(path.resolve(ROOT, file))) {
    const doc = await readJson(file);
    for (const row of doc.checks || []) {
      if (row.store && row.levelRuleId) hints.set(String(row.store).toUpperCase(), Number(row.levelRuleId));
    }
    const configuredStores = doc?.activities?.[String(ACTIVITY_ID_DEFAULT)]?.stores || {};
    for (const [storeKey, row] of Object.entries(configuredStores)) {
      const levelRuleId = Number(row?.levelRuleId);
      if (Number.isFinite(levelRuleId) && levelRuleId > 0) hints.set(String(storeKey).toUpperCase(), levelRuleId);
    }
  }
  const resultDir = path.join(ROOT, 'tmp', 'marketing-signup', 'coupon-submit-results');
  if (fsSync.existsSync(resultDir)) {
    for (const entry of fsSync.readdirSync(resultDir, {withFileTypes: true})) {
      if (!entry.isFile()) continue;
      const m = entry.name.match(/^([A-Z]+)-34810\.json$/);
      if (!m) continue;
      const storeKey = m[1].toUpperCase();
      if (hints.has(storeKey)) continue;
      try {
        const result = JSON.parse(fsSync.readFileSync(path.join(resultDir, entry.name), 'utf8'));
        const levelRuleId = Number(result?.rule?.levelRuleId
          || result?.beforeEnrolled?.sample?.[0]?.levelRuleId
          || result?.afterEnrolled?.sample?.[0]?.levelRuleId);
        if (Number.isFinite(levelRuleId) && levelRuleId > 0) hints.set(storeKey, levelRuleId);
      } catch {}
    }
  }
  return hints;
}

async function loadAllowedOverlaps(file) {
  const allowed = new Map();
  if (!file) return allowed;
  const absolute = path.resolve(ROOT, file);
  if (!fsSync.existsSync(absolute)) return allowed;
  const doc = await readJson(absolute);
  for (const entry of doc.entries || []) {
    const activityId = Number(entry.limitedDiscountActivityId);
    if (!Number.isFinite(activityId) || activityId <= 0) continue;
    const validUntil = parseChinaDate(entry.validUntil);
    if (validUntil && validUntil.getTime() < Date.now()) continue;
    const storeKey = String(entry.storeKey || '*').toUpperCase();
    const skc = normalizeAllowedSkc(entry.skc) || '*';
    const key = allowedOverlapKey(storeKey, activityId, skc);
    allowed.set(key, {
      ...entry,
      storeKey,
      skc,
      limitedDiscountActivityId: activityId,
      validUntil: entry.validUntil || '',
      _source: path.relative(ROOT, absolute),
    });
  }
  return allowed;
}

function parseChinaDate(value) {
  if (!value) return null;
  const d = new Date(String(value).replace(' ', 'T') + '+08:00');
  return Number.isFinite(d.getTime()) ? d : null;
}

function normalizeAllowedSkc(value) {
  return String(value || '').trim();
}

function allowedOverlapKey(storeKey, limitedDiscountActivityId, skc = '*') {
  return [
    String(storeKey || '*').toUpperCase(),
    Number(limitedDiscountActivityId),
    normalizeAllowedSkc(skc) || '*',
  ].join('|');
}

function findAllowedOverlap(allowedOverlaps, storeKey, limitedDiscountActivityId, skc = '') {
  const activityId = Number(limitedDiscountActivityId);
  if (!Number.isFinite(activityId) || activityId <= 0) return null;
  const normalizedStore = String(storeKey).toUpperCase();
  const normalizedSkc = normalizeAllowedSkc(skc);
  return (normalizedSkc ? allowedOverlaps.get(allowedOverlapKey(normalizedStore, activityId, normalizedSkc)) : null)
    || (normalizedSkc ? allowedOverlaps.get(allowedOverlapKey('*', activityId, normalizedSkc)) : null)
    || allowedOverlaps.get(allowedOverlapKey(normalizedStore, activityId, '*'))
    || allowedOverlaps.get(allowedOverlapKey('*', activityId, '*'))
    || null;
}

function findApprovedBelowTargetOverlap(allowedOverlaps, row, args) {
  const entry = findAllowedOverlap(allowedOverlaps, row.storeKey, row.limitedDiscountActivityId, row.skc);
  if (!entry || entry.allowBelowTarget !== true) return null;
  if (!normalizeAllowedSkc(entry.skc)) return null;
  if (normalizeAllowedSkc(entry.skc) !== normalizeAllowedSkc(row.skc)) return null;
  if (Number(entry.couponActivityId) !== Number(args.activityId)) return null;
  if (Number(entry.levelRuleId) !== Number(row.levelRuleId)) return null;
  const approvedFinalWithCoupon = Number(entry.approvedFinalWithCoupon);
  const approvedTargetFinalPrice = Number(entry.approvedTargetFinalPrice);
  const maxApprovedLossSar = Number(entry.maxApprovedLossSar);
  if (!Number.isFinite(approvedFinalWithCoupon)
    || !Number.isFinite(approvedTargetFinalPrice)
    || !Number.isFinite(maxApprovedLossSar)) {
    return null;
  }
  const finalWithCoupon = Number(row.finalWithCoupon);
  const targetFinalPrice = Number(row.targetFinalPrice);
  if (!Number.isFinite(finalWithCoupon) || !Number.isFinite(targetFinalPrice)) return null;
  if (finalWithCoupon < approvedFinalWithCoupon - 0.01) return null;
  const liveLoss = Number((targetFinalPrice - finalWithCoupon).toFixed(2));
  if (liveLoss > maxApprovedLossSar + 0.01) return null;
  return {
    ...entry,
    approvedFinalWithCoupon,
    approvedTargetFinalPrice,
    maxApprovedLossSar,
    liveLoss,
  };
}

async function readLiveCouponAndLimited(cdp, args, levelRuleId) {
  return await cdp.eval(`
    const headers = {
      'content-type': 'application/json;charset=UTF-8',
      'Origin-Url': location.href,
      'x-bbl-route': location.hash.replace(/^#/, '') || '/mbrs/marketing/list',
      'x-req-zone-id': 'Asia/Shanghai',
      'x-lt-language': 'CN',
      'LAN': 'CN',
    };
    async function post(path, body, routeOverride = '') {
      const scopedHeaders = routeOverride ? {...headers, 'x-bbl-route': routeOverride} : headers;
      const res = await fetch('/mrs-api-prefix' + path, {
        method: 'POST',
        credentials: 'include',
        headers: scopedHeaders,
        body: JSON.stringify(body || {}),
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return {http: res.status, code: json?.code, msg: json?.msg || text.slice(0, 300), info: json?.info ?? json};
    }
    function arrayFrom(value) {
      if (Array.isArray(value)) return value;
      if (Array.isArray(value?.data)) return value.data;
      if (Array.isArray(value?.list)) return value.list;
      if (Array.isArray(value?.records)) return value.records;
      if (Array.isArray(value?.partake_goods_list)) return value.partake_goods_list;
      return [];
    }
    const bodyText = document.body?.innerText || '';
    const page = {href: location.href, title: document.title, loginLike: location.href.includes('/login/') || (bodyText.includes('账号登录') && bodyText.includes('密码') && bodyText.includes('登录'))};
    const limitedPageSize = 200;
    const limitedPackets = [];
    const limitedActivities = [];
    let limitedCode = '0';
    let limitedMsg = 'OK';
    let limitedTotal = null;
    for (let pageNum = 1; pageNum <= 20; pageNum += 1) {
      const limitedPacket = await post('/promotion/obm/query_obm_activity_list', {page_num:pageNum, page_size:limitedPageSize, system:'mrs', ref_tools_id:175}, '/mbrs/marketing/list');
      const list = arrayFrom(limitedPacket.info);
      const totalFromInfo = Number(limitedPacket.info?.total ?? limitedPacket.info?.total_count ?? limitedPacket.info?.page_info?.total ?? NaN);
      if (Number.isFinite(totalFromInfo)) limitedTotal = totalFromInfo;
      limitedPackets.push({pageNum, code: limitedPacket.code, msg: limitedPacket.msg, count: list.length, total: limitedTotal});
      if (limitedPacket.code !== '0') {
        limitedCode = limitedPacket.code;
        limitedMsg = limitedPacket.msg;
        break;
      }
      limitedActivities.push(...list);
      if (!list.length || (limitedTotal !== null && limitedActivities.length >= limitedTotal) || list.length < limitedPageSize) break;
    }
    const limitedDetails = [];
    for (const activity of limitedActivities) {
      const goodsPacket = await post('/promotion/simple_platform/query_activity_goods', {activity_id: activity.activity_id, page_num: 1, page_size: 1000}, '/mbrs/marketing/list');
      const goods = arrayFrom(goodsPacket.info);
      const goodsTotal = Number(goodsPacket.info?.total ?? goodsPacket.info?.total_count ?? goodsPacket.info?.page_info?.total ?? goods.length ?? NaN);
      limitedDetails.push({
        activity,
        goods,
        goodsCode: goodsPacket.code,
        goodsMsg: goodsPacket.msg,
        goodsTotal: Number.isFinite(goodsTotal) ? goodsTotal : null,
        goodsTruncated: Number.isFinite(goodsTotal) && goods.length < goodsTotal,
      });
    }
    const couponPackets = [];
    if (__arg.levelRuleId) {
      let pageNum = 1;
      let total = null;
      const goods = [];
      while (pageNum <= 20) {
        const couponRoute = '/mbrs/marketing/coupon/rule/goods/' + __arg.activityId + '/' + __arg.levelRuleId;
        const q = await post('/mbrs/activity/multi-level/goods/query?page_num=' + pageNum + '&page_size=' + __arg.pageSize, {
          activity_id: __arg.activityId,
          level_rule_id: __arg.levelRuleId,
          page: 'COUPON',
          page_module: 'MULTI_LEVEL_RULE_ENROLLED_GOODS',
          product_code_list: [],
          supplier_no_list: [],
        }, couponRoute);
        const list = arrayFrom(q.info?.partake_goods_list ?? q.info);
        total = Number(q.info?.total ?? total ?? list.length ?? 0);
        couponPackets.push({pageNum, http:q.http, code:q.code, msg:q.msg, total, count:list.length});
        if (q.code !== '0') break;
        goods.push(...list);
        if (!list.length || goods.length >= total || list.length < __arg.pageSize) break;
        pageNum += 1;
      }
      return {page, limitedCode, limitedMsg, limitedPackets, limitedDetails, couponPackets, couponGoods: goods};
    }
    return {page, limitedCode, limitedMsg, limitedPackets, limitedDetails, couponPackets, couponGoods: []};
  `, {activityId: args.activityId, levelRuleId, pageSize: args.pageSize});
}

async function scanStore(store, args, planBySkc, levelRuleId, allowedOverlaps) {
  const result = {
    store: store.storeKey,
    shopName: store.shopName,
    levelRuleId,
    ok: false,
    risks: [],
    warnings: [],
  };
  let cdp = null;
  let launched = false;
  try {
    const ensured = await ensureBrowser(store, args);
    launched = ensured.launched;
    cdp = await connectStorePage(store);
    result.loginRecovery = await recoverLoginIfNeeded(cdp);
    if (result.loginRecovery.after?.isLogin) {
      result.page = {
        href: result.loginRecovery.after.href,
        loginLike: true,
        tail: result.loginRecovery.after.tail,
      };
      result.reason = 'login page after automatic login recovery; skipped live scan';
      return result;
    }
    let effectiveLevelRuleId = levelRuleId;
    if (!effectiveLevelRuleId) {
      result.couponDetail = await gotoCouponDetail(cdp, args.activityId);
      if (result.couponDetail?.hasLogin) {
        result.detailLoginRecovery = await recoverLoginIfNeeded(cdp);
        if (result.detailLoginRecovery.after?.isLogin) {
          result.reason = 'coupon detail login page after automatic login recovery; skipped live scan';
          return result;
        }
        result.couponDetail = await gotoCouponDetail(cdp, args.activityId);
      }
      result.ruleDiscovery = await clickContinueAndGetRuleId(cdp, args.activityId, 15);
      effectiveLevelRuleId = result.ruleDiscovery.levelRuleId;
      result.levelRuleId = effectiveLevelRuleId;
    }

    result.listPage = await gotoListPage(cdp);
    if (result.listPage?.isLogin) {
      result.reason = 'login page after navigating to marketing list; skipped live scan';
      return result;
    }
    let live = await readLiveCouponAndLimited(cdp, args, effectiveLevelRuleId);
    if ((live.couponPackets || []).some(p => String(p.code) === '20302')) {
      result.couponLoginRetry = await recoverLoginIfNeeded(cdp);
      if (result.couponLoginRetry.after?.isLogin) {
        result.reason = 'coupon enrolled query returned 20302 and login recovery did not restore session';
        return result;
      }
      result.listPageAfterCouponRetry = await gotoListPage(cdp);
      live = await readLiveCouponAndLimited(cdp, args, effectiveLevelRuleId);
    }
    if ((live.couponPackets || []).some(p => String(p.code) === '20302')) {
      result.couponGoodsPageRetry = await gotoCouponGoodsPage(cdp, args.activityId, effectiveLevelRuleId);
      if (result.couponGoodsPageRetry?.isLogin) {
        result.couponGoodsLoginRecovery = await recoverLoginIfNeeded(cdp);
        if (result.couponGoodsLoginRecovery.after?.isLogin) {
          result.reason = 'coupon enrolled query returned 20302 and coupon goods page login recovery did not restore session';
          return result;
        }
        result.couponGoodsPageAfterLogin = await gotoCouponGoodsPage(cdp, args.activityId, effectiveLevelRuleId);
        if (result.couponGoodsPageAfterLogin?.isLogin) {
          result.reason = 'coupon enrolled query returned 20302 and coupon goods page still requires login after recovery';
          return result;
        }
      }
      live = await readLiveCouponAndLimited(cdp, args, effectiveLevelRuleId);
    }

    result.page = live.page;
    if (live.page?.loginLike) {
      result.reason = 'login page; skipped live scan';
      return result;
    }
    result.limited = {
      code: live.limitedCode,
      msg: live.limitedMsg,
      packets: live.limitedPackets || [],
    };
    if (String(live.limitedCode) !== '0') {
      result.reason = `limited-discount live list query failed: ${live.limitedCode || ''} ${live.limitedMsg || ''}`.trim();
      return result;
    }
    result.limitedActivityCount = live.limitedDetails?.length || 0;
    const badLimitedGoodsQueries = (live.limitedDetails || [])
      .filter(detail => String(detail.goodsCode) !== '0' || detail.goodsTruncated);
    if (badLimitedGoodsQueries.length) {
      result.limitedGoodsQueryFailures = badLimitedGoodsQueries.map(detail => ({
        activityId: detail.activity?.activity_id,
        activityName: detail.activity?.act_name || '',
        code: detail.goodsCode,
        msg: detail.goodsMsg,
        count: detail.goods?.length || 0,
        total: detail.goodsTotal,
        truncated: !!detail.goodsTruncated,
      })).slice(0, 20);
      result.reason = `limited-discount goods query incomplete; fail closed before coupon risk decision: ${badLimitedGoodsQueries.length} activities`;
      return result;
    }
    result.coupon = {
      levelRuleId: effectiveLevelRuleId,
      packets: live.couponPackets || [],
      enrolledCount: live.couponGoods?.length || 0,
    };
    const badCouponPackets = (live.couponPackets || []).filter(p => String(p.code) !== '0');
    if (effectiveLevelRuleId && badCouponPackets.length) {
      result.reason = `15% enrolled coupon query failed: ${badCouponPackets.map(p => `${p.code}:${p.msg}`).join('; ')}`;
      return result;
    }
    const couponActive = new Set((live.couponGoods || [])
      .filter(g => ACTIVE_COUPON_STATUSES.has(String(g.status ?? '')))
      .map(g => String(g.skc || '').trim())
      .filter(Boolean));
    result.coupon.activeCount = couponActive.size;

    const now = Date.now();
    const limitedBySkc = new Map();
    for (const detail of live.limitedDetails || []) {
      const activity = detail.activity || {};
      const state = String(activity.state ?? '');
      const endMs = activity.end_time ? Date.parse(String(activity.end_time).replace(' ', 'T') + '+08:00') : NaN;
      const activeOrFuture = ACTIVE_OR_FUTURE_LIMITED_STATES.has(state) && (!Number.isFinite(endMs) || endMs >= now);
      if (!activeOrFuture) continue;
      for (const good of detail.goods || []) {
        const skc = String(good.skc || '').trim();
        const planRow = planBySkc.get(skc);
        if (!planRow) continue;
        const hasActiveCoupon = couponActive.has(skc);
        const allowedOverlap = findAllowedOverlap(allowedOverlaps, store.storeKey, activity.activity_id, skc);
        const row = {
          storeKey: store.storeKey,
          activityId: args.activityId,
          levelRuleId: effectiveLevelRuleId,
          skc,
          supplierNo: good.sku_supplier_no || planRow.supplierNo || planRow.canonical || '',
          canonical: planRow.canonical || '',
          allowedOverlap: !!allowedOverlap,
          allowedOverlapReason: allowedOverlap?.reason || '',
          allowedOverlapSource: allowedOverlap?._source || '',
          hasActiveCoupon,
          limitedDiscountActivityId: activity.activity_id,
          limitedDiscountName: activity.act_name || '',
          limitedDiscountState: activity.state,
          limitedDiscountStart: activity.start_time || '',
          limitedDiscountEnd: activity.end_time || '',
          limitedDiscountPrice: Number(good.product_act_price ?? NaN),
          maxProductActPrice: Number(good.max_product_act_price ?? NaN),
          stockNum: Number(good.stock_num ?? NaN),
          attendNumSum: Number(good.attend_num_sum ?? NaN),
          ordinaryPlanActivityId: planRow.activityId || '',
          ordinaryPlanTargetPrice: planRow.targetPrice ?? '',
          targetPrice: planRow.targetPrice ?? '',
          planFinalTargetPrice: planRow.finalTargetPrice ?? '',
          planCouponFactor: planRow.couponFactor ?? '',
          priceEvidenceSource: planRow.sourcePriceOverride || planRow.sourcePlan || '',
        };
        row.priceGuard = classifyLimitedDiscountCouponStack(row, planRow, {
          fallbackDiscountPct: 15,
          priceToleranceSar: PRICE_GUARD_TOLERANCE_SAR,
        });
        row.couponFactor = row.priceGuard.couponFactor ?? '';
        row.currentBasePrice = row.priceGuard.limitedDiscountPrice ?? '';
        row.finalWithCoupon = row.priceGuard.finalWithCoupon ?? '';
        row.targetFinalPrice = row.priceGuard.finalTargetPrice ?? '';
        row.diff = row.priceGuard.diff ?? '';
        row.priceDecision = row.priceGuard.decision || '';
        row.shouldCancelCoupon = !!row.priceGuard.shouldCancelCoupon;
        row.belowTargetApproved = false;
        row.belowTargetApprovalReason = '';
        row.belowTargetApprovalSource = '';
        row.approvedValidUntil = '';
        row.approvedFinalWithCoupon = '';
        row.approvedTargetFinalPrice = '';
        row.maxApprovedLossSar = '';
        row.approvedLiveLossSar = '';
        const belowTargetApproval = row.shouldCancelCoupon
          ? findApprovedBelowTargetOverlap(allowedOverlaps, row, args)
          : null;
        if (belowTargetApproval) {
          row.belowTargetApproved = true;
          row.belowTargetApprovalReason = belowTargetApproval.reason || '';
          row.belowTargetApprovalSource = belowTargetApproval._source || '';
          row.approvedValidUntil = belowTargetApproval.validUntil || '';
          row.approvedFinalWithCoupon = belowTargetApproval.approvedFinalWithCoupon;
          row.approvedTargetFinalPrice = belowTargetApproval.approvedTargetFinalPrice;
          row.maxApprovedLossSar = belowTargetApproval.maxApprovedLossSar;
          row.approvedLiveLossSar = belowTargetApproval.liveLoss;
          row.shouldCancelCoupon = false;
        }
        row.riskReason = hasActiveCoupon
          ? (row.belowTargetApproved
            ? 'active_15pct_coupon_final_below_target_user_approved_loss_clearance'
            : (row.shouldCancelCoupon
            ? 'active_15pct_coupon_final_below_target_due_to_limited_discount'
            : (row.priceDecision.startsWith('missing_')
              ? 'active_15pct_coupon_limited_discount_overlap_missing_price_evidence'
              : 'active_15pct_coupon_limited_discount_overlap_price_guard_allows')))
          : 'planned_coupon_skc_has_active_or_future_limited_discount_but_coupon_not_active';

        const prev = limitedBySkc.get(skc);
        const rowPrice = Number.isFinite(row.limitedDiscountPrice) ? row.limitedDiscountPrice : Infinity;
        const prevPrice = Number.isFinite(prev?.limitedDiscountPrice) ? prev.limitedDiscountPrice : Infinity;
        if (!prev || rowPrice < prevPrice) limitedBySkc.set(skc, row);
      }
    }
    result.risks = [...limitedBySkc.values()];
    result.ok = true;
    result.reason = `live scan ok; active coupon=${couponActive.size}, active/future limited overlap=${result.risks.length}`;
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

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function toCsv(rows, headers) {
  return [
    headers.join(','),
    ...rows.map(row => headers.map(h => csvEscape(row[h])).join(',')),
  ].join('\r\n') + '\r\n';
}

await fs.mkdir(OUT_DIR, {recursive: true});
const args = parseArgs(process.argv.slice(2));
const plan = await loadCouponTargetEligibilityPlan({
  root: ROOT,
  planPath: args.targetPlan,
  priceOverridesPaths: args.priceOverrides,
  targetDiscountPct: 15,
});
const levelHints = await loadLevelRuleHints(args.levelRuleHints);
const allowedOverlaps = await loadAllowedOverlaps(args.allowedOverlapList);
const selectedStores = args.stores.map(key => {
  const store = STORES.find(s => String(s.storeKey).toUpperCase() === key);
  if (!store) throw new Error(`Unknown store ${key}`);
  return store;
});

const summary = {
  createdAt: new Date().toISOString(),
  activityId: args.activityId,
  targetPlan: path.relative(ROOT, plan.path),
  priceOverrideSources: plan.priceOverrideSources.map(p => path.relative(ROOT, p)),
  levelRuleHints: args.levelRuleHints ? path.relative(ROOT, path.resolve(ROOT, args.levelRuleHints)) : '',
  allowedOverlapList: args.allowedOverlapList ? path.relative(ROOT, path.resolve(ROOT, args.allowedOverlapList)) : '',
  allowedOverlapEntries: allowedOverlaps.size,
  priceGuardPolicy: 'cancel only when active coupon finalWithCoupon is below finalTargetPrice',
  priceToleranceSar: PRICE_GUARD_TOLERANCE_SAR,
  stores: [],
};

for (const store of selectedStores) {
  const storeKey = String(store.storeKey).toUpperCase();
  const planRows = (plan.rowsByStore.get(storeKey) || []).filter(row => row.allowed15);
  const planBySkc = new Map(planRows.map(row => [row.skc, row]));
  const levelRuleId = levelHints.get(String(store.storeKey).toUpperCase()) || null;
  console.log(`[${store.storeKey}] scan coupon/limited overlap: plan=${planBySkc.size}, levelRuleId=${levelRuleId || '-'}`);
  const result = await scanStore(store, args, planBySkc, levelRuleId, allowedOverlaps);
  summary.stores.push(result);
  console.log(`[${store.storeKey}] ${result.ok ? 'OK' : 'WARN'} risks=${result.risks?.length || 0} ${result.reason || ''}`);
}

const riskRows = summary.stores.flatMap(s => s.risks || []);
const priceDecisionCounts = {};
for (const row of riskRows) {
  const key = row.priceDecision || 'unknown';
  priceDecisionCounts[key] = (priceDecisionCounts[key] || 0) + 1;
}
const cancelRows = riskRows
  .filter(row => row.hasActiveCoupon && row.shouldCancelCoupon && row.levelRuleId)
  .map(row => ({
    storeKey: row.storeKey,
    activityId: args.activityId,
    levelRuleId: row.levelRuleId,
    skc: row.skc,
    supplierNo: row.supplierNo,
    reason: row.riskReason,
    riskReason: row.riskReason,
    shouldCancelCoupon: true,
    priceDecision: row.priceDecision,
    currentBasePrice: row.currentBasePrice,
    limitedDiscountPrice: row.limitedDiscountPrice,
    couponFactor: row.couponFactor,
    finalWithCoupon: row.finalWithCoupon,
    targetFinalPrice: row.targetFinalPrice,
    diff: row.diff,
    priceEvidenceSource: row.priceEvidenceSource,
    limitedDiscountActivityId: row.limitedDiscountActivityId,
    limitedDiscountName: row.limitedDiscountName,
    limitedDiscountEnd: row.limitedDiscountEnd,
  }));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const jsonFile = path.join(OUT_DIR, `coupon-low-price-overlap-live-${stamp}.json`);
const csvFile = path.join(OUT_DIR, `coupon-low-price-overlap-live-${stamp}.csv`);
const cancelFile = path.join(OUT_DIR, `coupon-low-price-overlap-cancel-list-${stamp}.json`);

summary.riskCount = riskRows.length;
summary.priceDecisionCounts = priceDecisionCounts;
summary.activeCouponOverlapCount = riskRows.filter(row => row.hasActiveCoupon).length;
summary.allowedActiveOverlapCount = riskRows.filter(row => row.hasActiveCoupon && row.allowedOverlap).length;
summary.activeCouponAllowedByPriceCount = riskRows.filter(row => row.hasActiveCoupon && row.priceGuard?.allowSubmit).length;
summary.activeCouponBelowTargetCount = riskRows.filter(row => row.hasActiveCoupon && row.shouldCancelCoupon).length;
summary.activeCouponBelowTargetApprovedCount = riskRows.filter(row => row.hasActiveCoupon && row.belowTargetApproved).length;
summary.activeCouponMissingPriceEvidenceCount = riskRows.filter(row => row.hasActiveCoupon && String(row.priceDecision || '').startsWith('missing_')).length;
summary.activeCouponRiskCount = cancelRows.length;
summary.cancelList = {
  path: path.relative(ROOT, cancelFile),
  rows: cancelRows.length,
};
await fs.writeFile(jsonFile, JSON.stringify(summary, null, 2), 'utf8');
await fs.writeFile(csvFile, toCsv(riskRows, [
  'storeKey', 'skc', 'supplierNo', 'canonical', 'riskReason', 'hasActiveCoupon',
  'allowedOverlap', 'allowedOverlapReason', 'belowTargetApproved',
  'belowTargetApprovalReason', 'approvedValidUntil', 'priceDecision', 'currentBasePrice',
  'couponFactor', 'finalWithCoupon', 'targetFinalPrice', 'diff', 'priceEvidenceSource',
  'levelRuleId', 'limitedDiscountActivityId', 'limitedDiscountName', 'limitedDiscountState',
  'limitedDiscountStart', 'limitedDiscountEnd', 'limitedDiscountPrice', 'ordinaryPlanActivityId',
  'ordinaryPlanTargetPrice', 'targetPrice', 'planFinalTargetPrice', 'planCouponFactor',
]), 'utf8');
await fs.writeFile(cancelFile, JSON.stringify({
  createdAt: summary.createdAt,
  mode: 'risk-cancel-price-below-target',
  riskCancel: true,
  purpose: 'cancel active 15pct coupon rows only when limitedDiscountPrice * couponFactor is below finalTargetPrice',
  priceGuardPolicy: summary.priceGuardPolicy,
  priceToleranceSar: PRICE_GUARD_TOLERANCE_SAR,
  ordinaryPlanPaths: plan.planSources.map(p => path.relative(ROOT, p)),
  priceOverrideSources: plan.priceOverrideSources.map(p => path.relative(ROOT, p)),
  sourceScan: path.relative(ROOT, jsonFile),
  rows: cancelRows,
}, null, 2), 'utf8');

console.log(`\nJSON ${jsonFile}`);
console.log(`CSV ${csvFile}`);
console.log(`CANCEL_LIST ${cancelFile}`);
console.log(`RISK_ROWS ${riskRows.length}`);
console.log(`ACTIVE_COUPON_RISK_ROWS ${cancelRows.length}`);
