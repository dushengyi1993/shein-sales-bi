#!/usr/bin/env node
/**
 * Set SHEIN multi-level coupon site budget for activity 34810.
 *
 * For multi-level coupon activity 34810, `modify_coupon_usage_limit` only
 * changes the top-level activity limit. The actual shein-sa weekly site budget
 * shown on the coupon detail page is updated through:
 *   POST /mrs-api-prefix/mbrs/activity/multi-level/partake
 * with `partake_rule.site_budget_list`.
 *
 * This script is intentionally write-guarded: it only mutates when --execute is
 * supplied, and verifies both coupon budget-info and usage-list readbacks.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {
  requireStoreIdentitySnapshot,
  storeIdentityEvalBody,
} from '../../lib/shein_store_identity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STORES_CONFIG = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'stores.json'), 'utf8'));
const STORES = STORES_CONFIG.stores || [];
const STORE_ACCOUNT_TRUTH = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'store_account_truth.json'), 'utf8'));
const OUT_DIR = path.join(ROOT, 'tmp', 'marketing-signup', 'coupon-budget-results');
const ACTIVITY_ID_DEFAULT = 34810;
const LIST_URL = 'https://sso.geiwohuo.com/#/mbrs/marketing/list';
const DETAIL_URL = activityId => `https://sso.geiwohuo.com/#/mbrs/marketing/coupon/detail/${activityId}`;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function splitStores(value) { return String(value || '').split(',').map(x => x.trim()).filter(Boolean); }
function psSingleQuote(value) { return `'${String(value).replaceAll("'", "''")}'`; }

function parseArgs(argv) {
  const out = {
    stores: [],
    activityId: ACTIVITY_ID_DEFAULT,
    budget: 1000,
    site: 'shein-sa',
    currency: 'SAR',
    execute: false,
    readOnly: false,
    noLaunch: false,
    noClose: false,
    alsoSetActivityLimit: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--stores') out.stores.push(...splitStores(argv[++i]));
    else if (a === '--activity-id') out.activityId = Number(argv[++i]);
    else if (a === '--budget') out.budget = Number(argv[++i]);
    else if (a === '--site') out.site = argv[++i];
    else if (a === '--currency') out.currency = argv[++i];
    else if (a === '--execute') out.execute = true;
    else if (a === '--dry-run') out.execute = false;
    else if (a === '--read-only' || a === '--verify-only') {
      out.readOnly = true;
      out.execute = false;
    }
    else if (a === '--no-launch') out.noLaunch = true;
    else if (a === '--no-close' || a === '--keep-open') out.noClose = true;
    else if (a === '--no-activity-limit') out.alsoSetActivityLimit = false;
    else if (!a.startsWith('--')) out.stores.push(...splitStores(a));
  }
  out.stores = [...new Set(out.stores.map(s => s.toUpperCase()))];
  if (!out.stores.length) out.stores = STORES.filter(s => s.enabled !== false).map(s => String(s.storeKey).toUpperCase());
  if (out.readOnly && out.execute) throw new Error('--read-only/--verify-only cannot be combined with --execute');
  if (out.activityId !== ACTIVITY_ID_DEFAULT) throw new Error('Only coupon activity 34810 is verified for this workflow');
  if (!Number.isFinite(out.budget) || out.budget < 100) throw new Error('--budget must be >= 100 for coupon site budget');
  if (!out.site) throw new Error('--site is required');
  if (!out.currency) throw new Error('--currency is required');
  return out;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fieldMatches(value, expected) {
  return value === undefined || value === null || value === '' || String(value) === String(expected);
}

function summarizeReadbackBudget(before, args) {
  const budgetInfoSite = before?.budgetInfoSite || null;
  const usageSite = before?.usageSite || null;
  const budgetInfoValue = num(budgetInfoSite?.coupon_usage_upper_limit);
  const usageValue = num(usageSite?.coupon_usage_upper_limit);
  const budgetInfoUsedAmount = num(budgetInfoSite?.coupon_used_amount);
  const usageUsedAmount = num(usageSite?.coupon_used_amount);
  const budgetInfoState = num(budgetInfoSite?.site_budget_state);
  const usageState = num(usageSite?.site_budget_state);
  const failures = [];
  if (String(before?.budgetInfoCode) !== '0') failures.push(`budgetInfoCode=${before?.budgetInfoCode ?? 'missing'}`);
  if (String(before?.usageCode) !== '0') failures.push(`usageCode=${before?.usageCode ?? 'missing'}`);
  if (!budgetInfoSite) failures.push(`budgetInfo site ${args.site} missing`);
  if (!usageSite) failures.push(`usage site ${args.site} missing`);
  if (budgetInfoSite && !fieldMatches(budgetInfoSite.site, args.site)) failures.push(`budgetInfo site mismatch: ${budgetInfoSite.site}`);
  if (usageSite && !fieldMatches(usageSite.site, args.site)) failures.push(`usage site mismatch: ${usageSite.site}`);
  if (budgetInfoSite && !fieldMatches(budgetInfoSite.currency, args.currency)) failures.push(`budgetInfo currency mismatch: ${budgetInfoSite.currency}`);
  if (usageSite && !fieldMatches(usageSite.currency, args.currency)) failures.push(`usage currency mismatch: ${usageSite.currency}`);
  if (budgetInfoValue === null) failures.push('budgetInfo coupon_usage_upper_limit missing');
  if (usageValue === null) failures.push('usage coupon_usage_upper_limit missing');
  if (budgetInfoValue !== null && usageValue !== null && budgetInfoValue !== usageValue) failures.push(`budget mismatch budgetInfo=${budgetInfoValue} usage=${usageValue}`);
  if (budgetInfoValue !== null && budgetInfoValue < Number(args.budget)) failures.push(`budgetInfo below target: ${budgetInfoValue}<${args.budget}`);
  if (usageValue !== null && usageValue < Number(args.budget)) failures.push(`usage below target: ${usageValue}<${args.budget}`);
  return {
    ok: failures.length === 0,
    targetBudget: Number(args.budget),
    budgetInfoValue,
    usageValue,
    budgetInfoUsedAmount,
    usageUsedAmount,
    budgetInfoState,
    usageState,
    failures,
  };
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
    launchVisible(store, DETAIL_URL(args.activityId));
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
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || JSON.stringify(res.exceptionDetails));
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
  const state = await cdp.eval(`
    const text = document.body?.innerText || '';
    return {
      href: location.href,
      isLogin: location.href.includes('/login/') || text.includes('请输入账号') || text.includes('请输入密码') || (text.includes('账号登录') && text.includes('密码') && text.includes('登录')),
      tail: text.slice(-1000),
    };
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
      if (!btn) return {found:false, buttons:buttons.map(x=>x.text).filter(Boolean).slice(0,20), href:location.href};
      btn.el.click();
      return {found:true, text:btn.text, href:location.href};
    `);
    attempts.push({attemptNo, ...clicked});
    await sleep(String(clicked.text || '').includes('继续登录') ? 2000 : 5000);
    after = await cdp.eval(`
      const text = document.body?.innerText || '';
      return {href: location.href, isLogin: location.href.includes('/login/') || text.includes('请输入账号') || text.includes('请输入密码') || (text.includes('账号登录') && text.includes('密码') && text.includes('登录')), tail: text.slice(-1000)};
    `);
    if (!after.isLogin) break;
    if (attemptNo === 2) {
      await cdp.eval(`location.reload(); return true;`);
      await sleep(2500);
    }
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

function siteBudgetFromBudgetInfo(info, site) {
  const detail = (info?.coupon_activity_budget_detail_list || [])[0] || {};
  return (detail.coupon_site_budget_info_list || []).find(x => x.site === site) || null;
}

function siteBudgetFromUsage(info, site) {
  const detail = (info?.coupon_activity_usage_detail_list || [])[0] || {};
  return (detail.coupon_site_usage_info_list || []).find(x => x.site === site) || null;
}

async function setStoreBudget(store, args) {
  const result = {
    storeKey: store.storeKey,
    shopName: store.shopName,
    activityId: args.activityId,
    site: args.site,
    currency: args.currency,
    requestedBudget: args.budget,
    execute: args.execute,
    readOnly: args.readOnly,
    writeAttempted: false,
    writeEndpointCalls: 0,
    ok: false,
  };
  let cdp = null;
  let launched = false;
  try {
    const ensured = await ensureBrowser(store, args);
    launched = ensured.launched;
    cdp = await connectStorePage(store);
    await cdp.eval(`location.href = __arg.url; return {href: location.href};`, {url: DETAIL_URL(args.activityId)});
    await sleep(2500);
    result.loginRecovery = await recoverLoginIfNeeded(cdp);
    if (result.loginRecovery.after?.isLogin) {
      result.reason = 'login page after automatic login recovery; skipped budget update';
      return result;
    }
    result.identity = await assertCurrentStoreIdentity(cdp, store, 'set_coupon_site_budget');

    const live = await cdp.eval(`
      const post = async (url, body) => {
        const res = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify(body || {}),
        });
        const text = await res.text();
        let json;
        try { json = JSON.parse(text); } catch { json = {rawText: text}; }
        return {http: res.status, ...json};
      };
      const activityId = __arg.activityId;
      const couponList = await post('/mrs-api-prefix/mbrs/coupon/query_activity_coupon_list?page_num=1&page_size=500', {activity_id: activityId});
      const budgetInfo = await post('/mrs-api-prefix/mbrs/coupon/query_coupon_activity_budget_info', {activity_ids: [activityId]});
      const usage = await post('/mrs-api-prefix/mbrs/coupon/query_coupon_activity_usage_List?page_num=1&page_size=1', {activity_ids: [activityId], query_status: 0});
      return {href: location.href, couponList, budgetInfo, usage};
    `, args);

    result.before = {
      couponListCode: live.couponList?.code,
      budgetInfoCode: live.budgetInfo?.code,
      usageCode: live.usage?.code,
      budgetInfoSite: siteBudgetFromBudgetInfo(live.budgetInfo?.info, args.site),
      usageSite: siteBudgetFromUsage(live.usage?.info, args.site),
      activityLimit: live.usage?.info?.coupon_activity_usage_detail_list?.[0]?.coupon_usage_upper_limit ?? null,
      activityUsed: live.usage?.info?.coupon_activity_usage_detail_list?.[0]?.coupon_used_amount ?? null,
    };
    if (String(live.couponList?.code) !== '0') {
      result.reason = `query_activity_coupon_list failed: ${live.couponList?.code}:${live.couponList?.msg}`;
      return result;
    }
    const rules = live.couponList?.info?.data || live.couponList?.info || [];
    const rule = rules.find(r => Number(r?.coupon_range?.max_rate) === 15) || rules.find(r => Number(r?.level_rule_id) > 0);
    const levelRuleId = Number(rule?.level_rule_id || 0);
    result.levelRuleId = levelRuleId;
    if (!levelRuleId) {
      result.reason = '15% level_rule_id not found from query_activity_coupon_list';
      return result;
    }

    if (args.readOnly) {
      result.readback = summarizeReadbackBudget(result.before, args);
      result.ok = result.readback.ok;
      result.reason = result.ok
        ? `read-only current site budget is at or above ${args.budget} ${args.currency}`
        : `read-only current site budget evidence failed: ${result.readback.failures.join('; ')}`;
      return result;
    }

    if (!args.execute) {
      result.ok = true;
      result.reason = 'dry-run only; no budget update submitted';
      return result;
    }

    result.writeAttempted = true;
    result.writeEndpointCalls = args.alsoSetActivityLimit ? 2 : 1;
    const write = await cdp.eval(`
      const post = async (url, body) => {
        const res = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify(body || {}),
        });
        const text = await res.text();
        let json;
        try { json = JSON.parse(text); } catch { json = {rawText: text}; }
        return {http: res.status, ...json};
      };
      const activityId = __arg.activityId;
      const budget = __arg.budget;
      const site = __arg.site;
      const currency = __arg.currency;
      const levelRuleId = __arg.levelRuleId;
      const activityLimit = __arg.alsoSetActivityLimit
        ? await post('/mrs-api-prefix/mbrs/coupon/modify_coupon_usage_limit', {
            activity_id: activityId,
            coupon_usage_upper_limit: budget,
            currency,
            usage_upper_limit_flag: 1,
          })
        : null;
      const siteBudget = await post('/mrs-api-prefix/mbrs/activity/multi-level/partake', {
        activity_id: activityId,
        partake_rule: {
          partake_rule_id: levelRuleId,
          site_budget_list: [{site, currency, budget_limit: budget}],
        },
      });
      await new Promise(resolve => setTimeout(resolve, 1200));
      const budgetInfo = await post('/mrs-api-prefix/mbrs/coupon/query_coupon_activity_budget_info', {activity_ids: [activityId]});
      const usage = await post('/mrs-api-prefix/mbrs/coupon/query_coupon_activity_usage_List?page_num=1&page_size=1', {activity_ids: [activityId], query_status: 0});
      return {activityLimit, siteBudget, budgetInfo, usage, href: location.href};
    `, {...args, levelRuleId});

    result.write = {
      activityLimit: write.activityLimit ? {code: write.activityLimit.code, msg: write.activityLimit.msg} : null,
      siteBudget: {code: write.siteBudget?.code, msg: write.siteBudget?.msg, info: write.siteBudget?.info || null},
    };
    result.after = {
      budgetInfoCode: write.budgetInfo?.code,
      usageCode: write.usage?.code,
      budgetInfoSite: siteBudgetFromBudgetInfo(write.budgetInfo?.info, args.site),
      usageSite: siteBudgetFromUsage(write.usage?.info, args.site),
      activityLimit: write.usage?.info?.coupon_activity_usage_detail_list?.[0]?.coupon_usage_upper_limit ?? null,
      activityUsed: write.usage?.info?.coupon_activity_usage_detail_list?.[0]?.coupon_used_amount ?? null,
    };
    const budgetInfoOk = Number(result.after.budgetInfoSite?.coupon_usage_upper_limit) === Number(args.budget);
    const usageOk = Number(result.after.usageSite?.coupon_usage_upper_limit) === Number(args.budget);
    const writeOk = String(result.write.siteBudget.code) === '0' && (!args.alsoSetActivityLimit || String(result.write.activityLimit?.code) === '0');
    result.ok = writeOk && budgetInfoOk && usageOk;
    result.reason = result.ok
      ? `site budget set to ${args.budget} ${args.currency}`
      : `verification failed: writeOk=${writeOk} budgetInfoOk=${budgetInfoOk} usageOk=${usageOk}`;
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

await fs.mkdir(OUT_DIR, {recursive: true});
const args = parseArgs(process.argv.slice(2));
const selectedStores = args.stores.map(key => {
  const store = STORES.find(s => String(s.storeKey).toUpperCase() === key);
  if (!store) throw new Error(`Unknown store ${key}`);
  return store;
});

const summary = {
  createdAt: new Date().toISOString(),
  activityId: args.activityId,
  site: args.site,
  currency: args.currency,
  budget: args.budget,
  targetBudget: args.budget,
  mode: args.readOnly ? 'readback' : (args.execute ? 'execute' : 'dry-run'),
  execute: args.execute,
  readOnly: args.readOnly,
  writeAttempted: args.execute,
  writeEndpointCalls: 0,
  stores: [],
};

for (const store of selectedStores) {
  console.log(`[${store.storeKey}] set coupon site budget ${args.site}=${args.budget}${args.readOnly ? ' READ-ONLY' : (args.execute ? ' EXECUTE' : ' DRY-RUN')}`);
  const result = await setStoreBudget(store, args);
  summary.stores.push(result);
  summary.writeEndpointCalls += Number(result.writeEndpointCalls || 0);
  console.log(`[${store.storeKey}] ${result.ok ? 'OK' : 'WARN'} before=${result.before?.usageSite?.coupon_usage_upper_limit ?? '-'} after=${result.after?.usageSite?.coupon_usage_upper_limit ?? '-'} ${result.reason || ''}`);
}

summary.okCount = summary.stores.filter(s => s.ok).length;
summary.failures = summary.stores.filter(s => !s.ok).map(s => ({storeKey: s.storeKey, reason: s.reason}));
summary.updatedCount = summary.stores.filter(s => Number(s.after?.usageSite?.coupon_usage_upper_limit) === Number(args.budget)).length;
summary.verifiedAtTargetCount = summary.stores.filter(s => s.readback?.ok === true || Number(s.after?.usageSite?.coupon_usage_upper_limit) === Number(args.budget)).length;

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outFile = path.join(OUT_DIR, `coupon-site-budget-${args.readOnly ? 'readback' : (args.execute ? 'execute' : 'dry-run')}-${stamp}.json`);
await fs.writeFile(outFile, JSON.stringify(summary, null, 2), 'utf8');
console.log(`\nJSON ${outFile}`);
console.log(`OK ${summary.okCount}/${summary.stores.length}`);
console.log(`UPDATED_TO_BUDGET ${summary.updatedCount}/${summary.stores.length}`);
if (summary.failures.length) console.log(`FAILURES ${JSON.stringify(summary.failures)}`);
