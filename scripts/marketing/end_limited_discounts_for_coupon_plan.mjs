#!/usr/bin/env node
/**
 * End active/future limited-discount activities that price-stack evidence proves
 * would block planned 15% coupon signup.
 *
 * Project invariant:
 * Limited discounts are the lowest-priority promotion form. When a planned
 * ordinary-marketing + 15% coupon stack would be pushed below target by an
 * active/future limited discount, the limited discount must be removed or
 * adjusted before submitting the coupon. Mere overlap/riskReason is not enough:
 * input rows must carry `priceDecision=coupon_final_below_target`. The currently
 * verified safe write path is activity-level undo/end via
 * `/promotion/obm/undo_or_end_obm_activity`; this script records both target and
 * non-target goods in each ended activity for auditability.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import {loadCouponTargetEligibilityPlan} from '../../lib/marketing_coupon_policy.mjs';
import {resolveCurrentMarketingPlanPair} from '../../lib/marketing_plan_selector.mjs';
import {
  requireStoreIdentitySnapshot,
  storeIdentityEvalBody,
} from '../../lib/shein_store_identity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STORES_CONFIG = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'stores.json'), 'utf8'));
const STORES = STORES_CONFIG.stores || [];
const STORE_ACCOUNT_TRUTH = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'store_account_truth.json'), 'utf8'));
const OUT_DIR = path.join(ROOT, 'tmp', 'marketing-signup', 'limited-discount-end-results');
const LIST_URL = 'https://sso.geiwohuo.com/#/mbrs/marketing/list';
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function splitStores(value) { return String(value || '').split(',').map(x => x.trim()).filter(Boolean); }
function psSingleQuote(value) { return `'${String(value).replaceAll("'", "''")}'`; }

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizedPath(file) {
  return path.resolve(String(file || ''));
}

function relativeRootPath(file) {
  return path.relative(ROOT, normalizedPath(file)).replaceAll(path.sep, '/');
}

function assertHash(value, label) {
  const hash = String(value || '').trim().toLowerCase();
  if (!SHA256_PATTERN.test(hash)) throw new Error(`${label} must be a 64-character SHA-256 hex digest`);
  return hash;
}

async function readVerifiedRegularFile(file, expectedSha256, label) {
  const absolute = normalizedPath(file);
  let stat;
  try {
    stat = await fs.lstat(absolute);
  } catch (error) {
    throw new Error(`${label} is missing or unreadable: ${absolute}: ${error.message}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error(`${label} must be a regular non-symlink single-link file: ${absolute}`);
  }
  const bytes = await fs.readFile(absolute);
  const actualSha256 = sha256Bytes(bytes);
  const expected = assertHash(expectedSha256, `${label} expected SHA-256`);
  if (actualSha256 !== expected) {
    throw new Error(`${label} SHA-256 mismatch: expected=${expected} actual=${actualSha256}`);
  }
  return {absolute, bytes, sha256: actualSha256};
}

function readRegularSourceBinding(file, label) {
  const absolute = normalizedPath(file);
  let stat;
  try {
    stat = fsSync.lstatSync(absolute);
  } catch (error) {
    throw new Error(`${label} is missing or unreadable: ${absolute}: ${error.message}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error(`${label} must be a regular non-symlink single-link file: ${absolute}`);
  }
  const bytes = fsSync.readFileSync(absolute);
  return {path: relativeRootPath(absolute), sha256: sha256Bytes(bytes), bytes: bytes.length};
}

function sourceBindingEntries(value, label) {
  if (!Array.isArray(value) || !value.length) throw new Error(`${label} must be a non-empty array of path/hash bindings`);
  return value.map((entry, index) => {
    if (typeof entry === 'string') throw new Error(`${label}[${index}] is missing its SHA-256 binding`);
    const sourcePath = String(entry?.path || '').trim();
    if (!sourcePath) throw new Error(`${label}[${index}] path is missing`);
    return {path: sourcePath, sha256: assertHash(entry?.sha256, `${label}[${index}] SHA-256`)};
  });
}

function compareSourceBindings(actual, expected, label) {
  if (actual.length !== expected.length) {
    throw new Error(`${label} count mismatch: expected=${expected.length} actual=${actual.length}`);
  }
  for (let i = 0; i < expected.length; i += 1) {
    const actualPath = normalizedPath(path.resolve(ROOT, actual[i].path));
    const expectedPath = normalizedPath(path.resolve(ROOT, expected[i].path));
    if (actualPath !== expectedPath) throw new Error(`${label}[${i}] path mismatch: expected=${expected[i].path} actual=${actual[i].path}`);
    if (actual[i].sha256 !== expected[i].sha256) throw new Error(`${label}[${i}] SHA-256 mismatch: expected=${expected[i].sha256} actual=${actual[i].sha256}`);
  }
}

function comparePlanSelection(actual, current, label) {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) throw new Error(`${label} planSelection binding is missing`);
  const expected = {
    strategy: 'registry_current_baseline',
    registryFile: current.registryFile,
    registryHash: current.registryHash,
    selectionPlanPath: relativeRootPath(current.targetPlan),
    priceOverridesPath: relativeRootPath(current.priceOverrides),
    selectionPlanHash: current.selectionPlanHash,
    priceOverridesHash: current.priceOverridesHash,
    selectionPayloadHash: current.selectionPayloadHash,
    pricePayloadHash: current.pricePayloadHash,
    workFingerprint: current.workFingerprint,
  };
  for (const key of Object.keys(expected)) {
    const actualRaw = String(actual[key] || '').trim();
    const expectedRaw = String(expected[key] || '').trim();
    const actualValue = key.endsWith('File') || key.endsWith('Path')
      ? (actualRaw ? normalizedPath(key === 'registryFile' ? actualRaw : path.resolve(ROOT, actualRaw)) : '')
      : actualRaw.toLowerCase();
    const expectedValue = key.endsWith('File') || key.endsWith('Path')
      ? (expectedRaw ? normalizedPath(key === 'registryFile' ? expectedRaw : path.resolve(ROOT, expectedRaw)) : '')
      : expectedRaw.toLowerCase();
    if (!actualValue || actualValue !== expectedValue) throw new Error(`${label} planSelection.${key} mismatch: expected=${expected[key]} actual=${actual[key]}`);
  }
}

async function verifyScanBinding(scan) {
  const current = resolveCurrentMarketingPlanPair({root: ROOT});
  comparePlanSelection(scan?.planSelection, current, 'limited-discount scan artifact');
  const currentPlan = await loadCouponTargetEligibilityPlan({
    root: ROOT,
    planPath: current.targetPlan,
    priceOverridesPaths: [current.priceOverrides],
    targetDiscountPct: 15,
  });
  const expectedPlanSources = currentPlan.planSources.map((file, index) => readRegularSourceBinding(file, `current ordinary plan source[${index}]`));
  const expectedPriceSources = currentPlan.priceOverrideSources.map((file, index) => readRegularSourceBinding(file, `current price override source[${index}]`));
  const actualPlanSources = sourceBindingEntries(scan?.planSources, 'limited-discount scan ordinary plan sources');
  const actualPriceSources = sourceBindingEntries(scan?.priceOverrideSources, 'limited-discount scan price override sources');
  compareSourceBindings(actualPlanSources, expectedPlanSources, 'limited-discount scan ordinary plan sources');
  compareSourceBindings(actualPriceSources, expectedPriceSources, 'limited-discount scan price override sources');
  if (scan?.ordinaryPlanPaths !== undefined) {
    if (!Array.isArray(scan.ordinaryPlanPaths) || scan.ordinaryPlanPaths.length !== expectedPlanSources.length) {
      throw new Error('limited-discount scan ordinaryPlanPaths does not match the bound source set');
    }
    for (let i = 0; i < expectedPlanSources.length; i += 1) {
      if (normalizedPath(path.resolve(ROOT, scan.ordinaryPlanPaths[i])) !== normalizedPath(path.resolve(ROOT, expectedPlanSources[i].path))) {
        throw new Error(`limited-discount scan ordinaryPlanPaths[${i}] does not match the bound source path`);
      }
    }
  }
  if (scan?.priceOverrideSourcePaths !== undefined) {
    if (!Array.isArray(scan.priceOverrideSourcePaths) || scan.priceOverrideSourcePaths.length !== expectedPriceSources.length) {
      throw new Error('limited-discount scan priceOverrideSourcePaths does not match the bound source set');
    }
    for (let i = 0; i < expectedPriceSources.length; i += 1) {
      if (normalizedPath(path.resolve(ROOT, scan.priceOverrideSourcePaths[i])) !== normalizedPath(path.resolve(ROOT, expectedPriceSources[i].path))) {
        throw new Error(`limited-discount scan priceOverrideSourcePaths[${i}] does not match the bound source path`);
      }
    }
  }
  return {
    current,
    currentPlan,
    planSources: expectedPlanSources,
    priceOverrideSources: expectedPriceSources,
  };
}

function parseArgs(argv) {
  const out = {
    stores: [],
    scan: '',
    scanExplicit: false,
    expectedArtifactSha256: '',
    execute: false,
    noLaunch: false,
    noClose: false,
    pageSize: 1000,
    includeAllowedOverlap: false,
    allowMixedActivityEnd: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--stores') out.stores.push(...splitStores(argv[++i]));
    else if (a === '--scan' || a === '--artifact') {
      out.scan = argv[++i];
      out.scanExplicit = true;
    }
    else if (a === '--expected-artifact-sha256' || a === '--expected-artifact-sha' || a === '--expected-artifact-hash' || a === '--expected-scan-sha256' || a === '--expected-source-sha256' || a === '--expected-source-artifact-sha256' || a === '--scan-sha256') out.expectedArtifactSha256 = argv[++i];
    else if (a === '--execute') out.execute = true;
    else if (a === '--dry-run') out.execute = false;
    else if (a === '--no-launch') out.noLaunch = true;
    else if (a === '--no-close' || a === '--keep-open') out.noClose = true;
    else if (a === '--page-size') out.pageSize = Number(argv[++i]);
    else if (a === '--include-allowed-overlap') out.includeAllowedOverlap = true;
    else if (a === '--allow-mixed-activity-end') out.allowMixedActivityEnd = true;
    else if (!a.startsWith('--')) out.stores.push(...splitStores(a));
  }
  out.stores = [...new Set(out.stores.map(s => s.toUpperCase()))];
  if (!out.scanExplicit || !String(out.scan || '').trim()) {
    throw new Error('Limited-discount end requires an explicit --scan artifact path; mtime/newest discovery is disabled');
  }
  assertHash(out.expectedArtifactSha256, 'Limited-discount end requires --expected-artifact-sha256');
  if (!Number.isFinite(out.pageSize) || out.pageSize < 100) out.pageSize = 1000;
  return out;
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
  spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    cwd: ROOT,
    stdio: 'ignore',
    timeout: 20_000,
  });
}

function launchVisible(store, url) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'launch_store_browser.mjs'), store.storeKey, '--visible', '--url', url], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20_000,
  });
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

async function recoverLoginIfNeeded(cdp) {
  const state = await cdp.eval(`
    const text = document.body?.innerText || '';
    return {href: location.href, isLogin: location.href.includes('/login/') || text.includes('请输入账号') || text.includes('请输入密码') || (text.includes('账号登录') && text.includes('密码') && text.includes('登录')), tail: text.slice(-1000)};
  `);
  if (!state.isLogin) return {needed: false, before: state, after: state};
  const attempts = [];
  let after = state;
  for (let attemptNo = 1; attemptNo <= 4; attemptNo += 1) {
    const clicked = await cdp.eval(`
      const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      const textOf = el => (el?.innerText || el?.textContent || '').trim();
      const buttons = [...document.querySelectorAll('button,[role=button],a')].filter(visible).map(el => ({el, text: textOf(el), disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true'}));
      const btn = buttons.find(x => !x.disabled && x.text === '我已知晓，继续登录') || buttons.find(x => !x.disabled && x.text.includes('继续登录') && x.text.length <= 20) || buttons.find(x => !x.disabled && x.text === '登录') || buttons.find(x => !x.disabled && x.text.includes('登录') && x.text.length <= 12);
      if (!btn) return {found:false, href:location.href, buttons:buttons.map(x=>x.text).filter(Boolean).slice(0,20)};
      btn.el.click();
      return {found:true, href:location.href, text:btn.text};
    `);
    attempts.push({attemptNo, ...clicked});
    await sleep(String(clicked.text || '').includes('继续登录') ? 2000 : 5000);
    after = await cdp.eval(`
      const text = document.body?.innerText || '';
      return {href: location.href, isLogin: location.href.includes('/login/') || text.includes('请输入账号') || text.includes('请输入密码') || (text.includes('账号登录') && text.includes('密码') && text.includes('登录')), tail: text.slice(-1000)};
    `);
    if (!after.isLogin) break;
  }
  return {needed: true, before: state, attempts, after};
}

async function assertCurrentStoreIdentity(cdp, store, context) {
  const identitySnapshot = await cdp.eval(storeIdentityEvalBody());
  return requireStoreIdentitySnapshot({
    store,
    truth: STORE_ACCOUNT_TRUTH.stores?.[store.storeKey],
    snapshot: identitySnapshot,
    context,
  });
}

function parseChinaDate(value) {
  if (!value) return null;
  const d = new Date(String(value).replace(' ', 'T') + '+08:00');
  return Number.isFinite(d.getTime()) ? d : null;
}

function activeOrFuture(activity) {
  const state = Number(activity.state);
  const end = parseChinaDate(activity.end_time);
  return [2, 3].includes(state) && (!end || end.getTime() >= Date.now());
}

function loadTargets(scan, args) {
  const selected = args.stores.length ? new Set(args.stores) : null;
  const rows = (scan.stores || []).flatMap(s => s.risks || [])
    .filter(row => selected ? selected.has(String(row.storeKey).toUpperCase()) : true)
    .filter(row => args.includeAllowedOverlap || !row.allowedOverlap)
    .filter(row => row.riskReason === 'planned_coupon_skc_has_active_or_future_limited_discount_but_coupon_not_active')
    .filter(row => row.priceDecision === 'coupon_final_below_target' || row.priceGuard?.decision === 'coupon_final_below_target');
  const byStoreActivity = new Map();
  for (const row of rows) {
    const storeKey = String(row.storeKey).toUpperCase();
    const activityId = Number(row.limitedDiscountActivityId);
    if (!storeKey || !activityId || !row.skc) continue;
    const key = `${storeKey}|${activityId}`;
    if (!byStoreActivity.has(key)) {
      byStoreActivity.set(key, {
        storeKey,
        limitedDiscountActivityId: activityId,
        limitedDiscountName: row.limitedDiscountName || '',
        limitedDiscountEnd: row.limitedDiscountEnd || '',
        targetSkcs: new Set(),
        sourceRows: [],
      });
    }
    const entry = byStoreActivity.get(key);
    entry.targetSkcs.add(String(row.skc).trim());
    entry.sourceRows.push(row);
  }
  return [...byStoreActivity.values()].map(entry => ({...entry, targetSkcs: [...entry.targetSkcs].sort()}));
}

async function processStore(store, storeTargets, args) {
  const result = {
    storeKey: store.storeKey,
    shopName: store.shopName,
    execute: args.execute,
    targetActivityCount: storeTargets.length,
    targetSkcCount: storeTargets.reduce((n, t) => n + t.targetSkcs.length, 0),
    activities: [],
    ok: false,
  };
  let cdp = null;
  let launched = false;
  try {
    if (!storeTargets.length) {
      result.ok = true;
      result.reason = 'no limited-discount blockers for this store';
      return result;
    }
    const ensured = await ensureBrowser(store, args);
    launched = ensured.launched;
    cdp = await connectStorePage(store);
    await cdp.eval(`location.href = __arg.url; return {href: location.href};`, {url: LIST_URL});
    await sleep(2000);
    result.loginRecovery = await recoverLoginIfNeeded(cdp);
    if (result.loginRecovery.after?.isLogin) {
      result.reason = 'login page after automatic login recovery; skipped limited-discount end';
      return result;
    }
    result.identity = await assertCurrentStoreIdentity(cdp, store, 'end_limited_discounts_for_coupon_plan');

    const live = await cdp.eval(`
      const headers = {
        'content-type': 'application/json;charset=UTF-8',
        'Origin-Url': location.href,
        'x-bbl-route': '/mbrs/marketing/list',
        'x-req-zone-id': 'Asia/Shanghai',
        'x-lt-language': 'CN',
        'LAN': 'CN',
      };
      const post = async (url, body, routeOverride = '') => {
        const res = await fetch('/mrs-api-prefix' + url, {
          method: 'POST',
          credentials: 'include',
          headers: routeOverride ? {...headers, 'x-bbl-route': routeOverride} : headers,
          body: JSON.stringify(body || {}),
        });
        const text = await res.text();
        let json;
        try { json = JSON.parse(text); } catch { json = null; }
        return {http: res.status, code: json?.code, msg: json?.msg || text.slice(0, 300), info: json?.info ?? json, text: text.slice(0, 500)};
      };
      const arrayFrom = value => {
        if (Array.isArray(value)) return value;
        if (Array.isArray(value?.data)) return value.data;
        if (Array.isArray(value?.list)) return value.list;
        if (Array.isArray(value?.records)) return value.records;
        return [];
      };
      async function queryLimitedActivities() {
        const pageSize = 200;
        const packets = [];
        const activities = [];
        let code = '0';
        let msg = 'OK';
        let total = null;
        for (let pageNum = 1; pageNum <= 20; pageNum += 1) {
          const packet = await post('/promotion/obm/query_obm_activity_list', {page_num: pageNum, page_size: pageSize, system: 'mrs', ref_tools_id: 175}, '/mbrs/marketing/list');
          const list = arrayFrom(packet.info);
          const totalFromInfo = Number(packet.info?.total ?? packet.info?.total_count ?? packet.info?.page_info?.total ?? NaN);
          if (Number.isFinite(totalFromInfo)) total = totalFromInfo;
          packets.push({pageNum, code: packet.code, msg: packet.msg, count: list.length, total});
          if (packet.code !== '0') {
            code = packet.code;
            msg = packet.msg;
            break;
          }
          activities.push(...list);
          if (!list.length || (total !== null && activities.length >= total) || list.length < pageSize) break;
        }
        return {code, msg, packets, activities};
      }
      const limitedList = await queryLimitedActivities();
      const activities = limitedList.activities;
      const activityMap = new Map(activities.map(a => [Number(a.activity_id), a]));
      const out = [];
      for (const target of __arg.targets) {
        const activity = activityMap.get(Number(target.limitedDiscountActivityId)) || null;
        let goodsPacket = {code: 'SKIPPED', msg: 'activity not present in live limited-discount list', info: []};
        if (activity) {
          goodsPacket = await post('/promotion/simple_platform/query_activity_goods', {activity_id: target.limitedDiscountActivityId, page_num: 1, page_size: __arg.pageSize}, '/mbrs/marketing/list');
        }
        const goods = arrayFrom(goodsPacket.info);
        out.push({target, detail: activity, detailCode: limitedList.code, detailMsg: limitedList.msg, goodsCode: goodsPacket.code, goodsMsg: goodsPacket.msg, goods});
      }
      return {href: location.href, limitedCode: limitedList.code, limitedMsg: limitedList.msg, limitedPackets: limitedList.packets, limitedActivityCount: activities.length, activities: out};
    `, {targets: storeTargets, pageSize: args.pageSize});

    result.liveQuery = {
      limitedCode: live.limitedCode,
      limitedMsg: live.limitedMsg,
      limitedActivityCount: live.limitedActivityCount,
      limitedPackets: live.limitedPackets || [],
    };
    if (String(live.limitedCode) !== '0') {
      result.reason = `limited-discount live list query failed: ${live.limitedCode || ''} ${live.limitedMsg || ''}`.trim();
      return result;
    }

    for (const entry of live.activities || []) {
      const activity = entry.detail || {};
      const targetSet = new Set(entry.target.targetSkcs);
      const goods = entry.goods || [];
      const targetGoods = goods.filter(g => targetSet.has(String(g.skc || '').trim()));
      const extraGoods = goods.filter(g => !targetSet.has(String(g.skc || '').trim()));
      result.activities.push({
        activity_id: entry.target.limitedDiscountActivityId,
        act_name: activity.act_name || entry.target.limitedDiscountName || '',
        state: activity.state,
        start_time: activity.start_time || '',
        end_time: activity.end_time || entry.target.limitedDiscountEnd || '',
        activeOrFuture: activeOrFuture(activity),
        sourceTargetSkcCount: entry.target.targetSkcs.length,
        liveGoodsCount: goods.length,
        liveTargetGoodsCount: targetGoods.length,
        liveExtraGoodsCount: extraGoods.length,
        targetSkcs: entry.target.targetSkcs,
        extraSkcs: [...new Set(extraGoods.map(g => String(g.skc || '').trim()).filter(Boolean))].sort(),
        targetGoodsSample: targetGoods.slice(0, 20).map(g => ({skc: g.skc, supplierNo: g.sku_supplier_no, price: g.product_act_price})),
        extraGoodsSample: extraGoods.slice(0, 20).map(g => ({skc: g.skc, supplierNo: g.sku_supplier_no, price: g.product_act_price})),
        detailCode: entry.detailCode,
        goodsCode: entry.goodsCode,
      });
    }

    if (!args.execute) {
      result.ok = true;
      result.reason = 'dry-run only; no limited-discount activity ended';
      return result;
    }

    const unsafeMixedActivities = result.activities
      .filter(a => a.activeOrFuture && a.liveExtraGoodsCount > 0);
    if (unsafeMixedActivities.length && !args.allowMixedActivityEnd) {
      result.reason = `safety stop: ${unsafeMixedActivities.length} active/future limited-discount activities contain non-target SKCs; use --allow-mixed-activity-end only after manual approval or rebuild the activity without extra goods`;
      result.blockedMixedActivities = unsafeMixedActivities.map(a => ({
        activity_id: a.activity_id,
        act_name: a.act_name,
        liveTargetGoodsCount: a.liveTargetGoodsCount,
        liveExtraGoodsCount: a.liveExtraGoodsCount,
        extraSkcs: a.extraSkcs.slice(0, 20),
      }));
      return result;
    }

    const endTargets = result.activities
      .filter(a => a.activeOrFuture && String(a.goodsCode) === '0' && a.liveTargetGoodsCount > 0 && (args.allowMixedActivityEnd || a.liveExtraGoodsCount === 0))
      .map(a => ({activity_id: a.activity_id, state: Number(a.state)}));
    const ended = await cdp.eval(`
      const headers = {
        'content-type': 'application/json;charset=UTF-8',
        'Origin-Url': location.href,
        'x-bbl-route': '/mbrs/marketing/list',
        'x-req-zone-id': 'Asia/Shanghai',
        'x-lt-language': 'CN',
        'LAN': 'CN',
      };
      const post = async (url, body, routeOverride = '') => {
        const res = await fetch('/mrs-api-prefix' + url, {
          method: 'POST',
          credentials: 'include',
          headers: routeOverride ? {...headers, 'x-bbl-route': routeOverride} : headers,
          body: JSON.stringify(body || {}),
        });
        const text = await res.text();
        let json;
        try { json = JSON.parse(text); } catch { json = null; }
        return {http: res.status, code: json?.code, msg: json?.msg || text.slice(0, 300), info: json?.info ?? json, text: text.slice(0, 500)};
      };
      const arrayFrom = value => {
        if (Array.isArray(value)) return value;
        if (Array.isArray(value?.data)) return value.data;
        if (Array.isArray(value?.list)) return value.list;
        if (Array.isArray(value?.records)) return value.records;
        return [];
      };
      async function queryLimitedActivities() {
        const pageSize = 200;
        const packets = [];
        const activities = [];
        let code = '0';
        let msg = 'OK';
        let total = null;
        for (let pageNum = 1; pageNum <= 20; pageNum += 1) {
          const packet = await post('/promotion/obm/query_obm_activity_list', {page_num: pageNum, page_size: pageSize, system: 'mrs', ref_tools_id: 175}, '/mbrs/marketing/list');
          const list = arrayFrom(packet.info);
          const totalFromInfo = Number(packet.info?.total ?? packet.info?.total_count ?? packet.info?.page_info?.total ?? NaN);
          if (Number.isFinite(totalFromInfo)) total = totalFromInfo;
          packets.push({pageNum, code: packet.code, msg: packet.msg, count: list.length, total});
          if (packet.code !== '0') {
            code = packet.code;
            msg = packet.msg;
            break;
          }
          activities.push(...list);
          if (!list.length || (total !== null && activities.length >= total) || list.length < pageSize) break;
        }
        return {code, msg, packets, activities};
      }
      const ended = [];
      for (const t of __arg.endTargets) {
        const actionState = Number(t.state) === 3 ? 6 : 5;
        const packet = await post('/promotion/obm/undo_or_end_obm_activity', {activity_id: Number(t.activity_id), promotion_action_state: actionState}, '/mbrs/marketing/list');
        ended.push({activity_id: Number(t.activity_id), previous_state: Number(t.state), promotion_action_state: actionState, response: {code: packet.code, msg: packet.msg, info: packet.info}});
      }
      await new Promise(resolve => setTimeout(resolve, 1800));
      const limitedList = await queryLimitedActivities();
      const activities = limitedList.activities;
      const activityMap = new Map(activities.map(a => [Number(a.activity_id), a]));
      const after = __arg.endTargets.map(t => {
        const detail = activityMap.get(Number(t.activity_id)) || null;
        return {activity_id: Number(t.activity_id), code: limitedList.code, msg: limitedList.msg, state: detail?.state, start_time: detail?.start_time, end_time: detail?.end_time, presentInList: !!detail};
      });
      return {ended, after, limitedPackets: limitedList.packets};
    `, {endTargets});
    result.ended = ended.ended || [];
    result.after = ended.after || [];
    result.afterLimitedPackets = ended.limitedPackets || [];
    const failedWrites = result.ended.filter(x => String(x.response?.code) !== '0');
    const stillActive = result.after.filter(x => activeOrFuture(x));
    result.ok = failedWrites.length === 0 && stillActive.length === 0;
    result.reason = result.ok
      ? `ended ${result.ended.length} limited-discount activities`
      : `verification failed: failedWrites=${failedWrites.length} stillActive=${stillActive.length}`;
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

const args = parseArgs(process.argv.slice(2));
const scanArtifact = await readVerifiedRegularFile(
  path.resolve(ROOT, args.scan),
  args.expectedArtifactSha256,
  'limited-discount scan artifact',
);
let scan;
try {
  scan = JSON.parse(scanArtifact.bytes.toString('utf8').replace(/^\uFEFF/, ''));
} catch (error) {
  throw new Error(`limited-discount scan artifact JSON parse failed: ${error.message}`);
}
const scanBinding = await verifyScanBinding(scan);
await fs.mkdir(OUT_DIR, {recursive: true});
const scanFile = scanArtifact.absolute;
const targets = loadTargets(scan, args);
const targetStores = args.stores.length ? args.stores : [...new Set(targets.map(t => t.storeKey))].sort();
const selectedStores = targetStores.map(key => {
  const store = STORES.find(s => String(s.storeKey).toUpperCase() === key);
  if (!store) throw new Error(`Unknown store ${key}`);
  return store;
});

const summary = {
  createdAt: new Date().toISOString(),
  execute: args.execute,
  sourceScan: path.relative(ROOT, scanFile),
  sourceScanSha256: scanArtifact.sha256,
  planSelection: scan.planSelection,
  planSources: scanBinding.planSources,
  priceOverrideSources: scanBinding.priceOverrideSources,
  selectedStores: selectedStores.map(s => s.storeKey),
  targetActivityCount: targets.length,
  targetSkcCount: targets.reduce((n, t) => n + t.targetSkcs.length, 0),
  stores: [],
};

for (const store of selectedStores) {
  const storeTargets = targets.filter(t => t.storeKey === String(store.storeKey).toUpperCase());
  console.log(`[${store.storeKey}] limited discounts blocking planned coupons: activities=${storeTargets.length}, skcs=${storeTargets.reduce((n, t) => n + t.targetSkcs.length, 0)} ${args.execute ? 'EXECUTE' : 'DRY-RUN'}`);
  const result = await processStore(store, storeTargets, args);
  summary.stores.push(result);
  const extra = (result.activities || []).reduce((n, a) => n + Number(a.liveExtraGoodsCount || 0), 0);
  const ended = result.ended?.length || 0;
  console.log(`[${store.storeKey}] ${result.ok ? 'OK' : 'WARN'} activities=${result.activities?.length || 0} extraGoods=${extra} ended=${ended} ${result.reason || ''}`);
}

summary.okCount = summary.stores.filter(s => s.ok).length;
summary.failures = summary.stores.filter(s => !s.ok).map(s => ({storeKey: s.storeKey, reason: s.reason}));
summary.liveActivityCount = summary.stores.reduce((n, s) => n + (s.activities || []).filter(a => a.activeOrFuture).length, 0);
summary.liveTargetGoodsCount = summary.stores.reduce((n, s) => n + (s.activities || []).reduce((m, a) => m + Number(a.liveTargetGoodsCount || 0), 0), 0);
summary.liveExtraGoodsCount = summary.stores.reduce((n, s) => n + (s.activities || []).reduce((m, a) => m + Number(a.liveExtraGoodsCount || 0), 0), 0);
summary.endedActivityCount = summary.stores.reduce((n, s) => n + (s.ended?.length || 0), 0);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outFile = path.join(OUT_DIR, `limited-discount-end-${args.execute ? 'execute' : 'dry-run'}-${stamp}.json`);
await fs.writeFile(outFile, JSON.stringify(summary, null, 2), 'utf8');
console.log(`\nJSON ${outFile}`);
console.log(`OK ${summary.okCount}/${summary.stores.length}`);
console.log(`LIVE_ACTIVITIES ${summary.liveActivityCount}`);
console.log(`LIVE_TARGET_GOODS ${summary.liveTargetGoodsCount}`);
console.log(`LIVE_EXTRA_GOODS ${summary.liveExtraGoodsCount}`);
console.log(`ENDED_ACTIVITIES ${summary.endedActivityCount}`);
if (summary.failures.length) console.log(`FAILURES ${JSON.stringify(summary.failures)}`);
