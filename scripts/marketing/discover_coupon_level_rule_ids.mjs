#!/usr/bin/env node
/**
 * Read-only discovery of the per-store 15% coupon levelRuleId for one coupon
 * activity, for stores that have no verified value in
 * config/marketing_coupon_level_rules.json.
 *
 * The id is per store and must never be copied from another store (documented
 * rule), so it has to be read from the platform. This reuses the controlled
 * store launcher and the same discovery path the stack review already uses: open
 * the coupon activity detail page, click the 15% "continue signup" button, and
 * read the id from the resulting signup route. No signup, no submit, no coupon
 * mutation: it only reads the route.
 *
 * Usage:
 *   node scripts/marketing/discover_coupon_level_rule_ids.mjs --stores LG,HY \
 *     [--coupon-activity-id 34810] [--out <file>] [--keep-open]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COUPON_ACTIVITY_ID_DEFAULT = '34810';

function parseArgs(argv) {
  const out = {stores: [], couponActivityId: COUPON_ACTIVITY_ID_DEFAULT, out: '', keepOpen: false};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--stores') out.stores = String(argv[++index] || '').split(',').map(value => value.trim().toUpperCase()).filter(Boolean);
    else if (arg === '--coupon-activity-id') out.couponActivityId = String(argv[++index] || '').trim();
    else if (arg === '--out') out.out = String(argv[++index] || '').trim();
    else if (arg === '--keep-open') out.keepOpen = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!out.stores.length) throw new Error('--stores is required');
  if (!/^\d+$/.test(out.couponActivityId)) throw new Error('--coupon-activity-id must be numeric');
  return out;
}

const args = parseArgs(process.argv.slice(2));
const storesConfig = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'stores.json'), 'utf8'));
const storeByKey = new Map((storesConfig.stores || [])
  .map(store => [String(store.storeKey || store.store_key || store.key || '').toUpperCase(), store]));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function launchStore(store) {
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'launch_store_browser.mjs'),
    store.storeKey,
    // --headless is the mode the cloud repair lane uses successfully on this
    // host; --background did not raise a debug port here.
    '--headless',
    '--url',
    `https://sso.geiwohuo.com/#/mbrs/marketing/coupon/detail/${args.couponActivityId}`,
  ], {cwd: ROOT, encoding: 'utf8', timeout: 90_000});
  if (result.status !== 0) throw new Error(`launch failed for ${store.storeKey}: ${result.stderr || result.stdout}`);
}

async function httpJson(url) {
  const res = await fetch(url, {signal: AbortSignal.timeout(6000)});
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  return await res.json();
}

async function waitForCdpPort(store, timeoutMs = 30_000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started <= timeoutMs) {
    try { return await httpJson(`http://127.0.0.1:${store.port}/json/version`); }
    catch (error) { lastError = error; await sleep(800); }
  }
  throw new Error(`CDP not ready for ${store.storeKey}: ${lastError?.message || 'timeout'}`);
}

class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, {once: true});
      this.ws.addEventListener('error', reject, {once: true});
    });
    this.ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const {resolve, reject} = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
        else resolve(message.result);
      }
    });
  }
  call(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = {id, method, params};
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }
      }, 60_000);
    });
  }
  close() { try { this.ws?.close(); } catch {} }
}

async function evalJs(cdp, sessionId, body, arg) {
  const encoded = arg === undefined ? 'undefined' : JSON.stringify(arg).replace(/</g, '\\u003c');
  const res = await cdp.call('Runtime.evaluate', {
    expression: `(async () => { const __arg = ${encoded}; ${body} })()`,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'Runtime.evaluate failed');
  }
  return res.result?.value;
}

async function discover(store) {
  launchStore(store);
  const version = await waitForCdpPort(store);
  const cdp = new Cdp(version.webSocketDebuggerUrl);
  await cdp.connect();
  // Attach to the page the controlled launcher already opened (it is on the
  // coupon detail route). Creating a fresh target and then driving a hash-route
  // SPA navigation made the inspected target navigate away mid-evaluate.
  const targets = await cdp.call('Target.getTargets');
  const page = (targets.targetInfos || []).find(info => info.type === 'page' && /geiwohuo\.com/.test(String(info.url || '')))
    || (targets.targetInfos || []).find(info => info.type === 'page');
  if (!page) throw new Error('no page target found for the launched store');
  const targetId = page.targetId;
  const {sessionId} = await cdp.call('Target.attachToTarget', {targetId, flatten: true});
  await cdp.call('Page.enable', {}, sessionId);
  await cdp.call('Runtime.enable', {}, sessionId);
  try {
    return await evalJs(cdp, sessionId, `
      const activityId = Number(__arg.activityId);
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      const textOf = el => (el?.innerText || el?.textContent || '').trim();
      const waitFor = async (predicate, timeoutMs) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) { if (predicate()) return true; await sleep(500); }
        return false;
      };
      const detail = 'https://sso.geiwohuo.com/#/mbrs/marketing/coupon/detail/' + activityId;
      if (!location.href.includes('/mbrs/marketing/coupon/detail/' + activityId)) {
        location.href = detail;
        await waitFor(() => location.href.includes('/mbrs/marketing/coupon/detail/' + activityId), 30000);
        await sleep(2500);
      }
      const body = document.body?.innerText || '';
      if (/登录|密码|验证码/.test(body) && !/继续报名|报名/.test(body)) {
        return {ok: false, reason: 'store_not_logged_in', href: location.href, text: body.slice(0, 300)};
      }
      let match = String(location.href).match(new RegExp('/coupon/rule/signup/' + activityId + '/(\\d+)'));
      if (match) return {ok: true, levelRuleId: Number(match[1]), levelRuleIdSource: 'route', href: location.href};
      const buttons = [...document.querySelectorAll('button,[role=button]')]
        .filter(visible)
        .map(el => {
          let node = el; let ctx = '';
          for (let i = 0; i < 6 && node; i += 1) { ctx = textOf(node); if (ctx.length > 20 && ctx.length < 2500) break; node = node.parentElement; }
          return {el, text: textOf(el), ctx};
        })
        .filter(x => ['继续报名', '报名', '去报名'].includes(x.text));
      if (!buttons.length) return {ok: false, reason: 'continue_signup_button_not_found', href: location.href, text: body.slice(0, 400)};
      const preferred = buttons.find(x => /15/.test(x.ctx)) || buttons[0];
      preferred.el.scrollIntoView({block: 'center', inline: 'center'});
      preferred.el.click();
      await waitFor(() => location.href.includes('/mbrs/marketing/coupon/rule/signup/' + activityId + '/'), 30000);
      match = String(location.href).match(new RegExp('/coupon/rule/signup/' + activityId + '/(\\d+)'));
      if (!match) return {ok: false, reason: 'signup_route_not_reached', href: location.href};
      return {ok: true, levelRuleId: Number(match[1]), levelRuleIdSource: 'route', href: location.href};
    `, {activityId: args.couponActivityId});
  } finally {
    if (!args.keepOpen) {
      await cdp.call('Target.closeTarget', {targetId}).catch(() => {});
      cdp.close();
    }
  }
}

const results = [];
for (const storeKey of args.stores) {
  const store = storeByKey.get(storeKey);
  if (!store) { results.push({storeKey, ok: false, reason: 'store_not_in_config'}); continue; }
  try {
    const found = await discover(store);
    results.push({storeKey, activityId: args.couponActivityId, ...found});
  } catch (error) {
    results.push({storeKey, activityId: args.couponActivityId, ok: false, reason: String(error?.message || error)});
  }
}

const summary = {ok: results.every(row => row.ok === true), activityId: args.couponActivityId, results};
if (args.out) {
  const target = path.resolve(ROOT, args.out);
  await fs.mkdir(path.dirname(target), {recursive: true});
  await fs.writeFile(target, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
}
console.log(JSON.stringify(summary, null, 2));
if (!summary.ok) process.exitCode = 1;
