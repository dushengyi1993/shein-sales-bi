#!/usr/bin/env node
/**
 * Try to restore SHEIN sub-system login through an existing Chrome profile.
 *
 * This script never reads or prints credential values. It only checks whether
 * text/password inputs have values and clicks the login button when possible.
 */
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORES_PATH = path.join(ROOT, 'config', 'stores.json');
const ORDER_URL = 'https://sso.geiwohuo.com/#/gsp/order-management/list';
const HOME_URL = 'https://sso.geiwohuo.com/#/gsp/home';
const SBN_URL = 'https://sso.geiwohuo.com/#/sbn/merchandise/details';
const encodeRedirect = url => Buffer.from(url, 'utf8').toString('base64');
const LOGIN_URLS = [
  `https://sso.geiwohuo.com/#/login/GMPSSO/${encodeRedirect(SBN_URL)}`,
  `https://sso.geiwohuo.com/#/login/GMPSSO/${encodeRedirect(ORDER_URL)}`,
  `https://sso.geiwohuo.com/#/login/GMPSSO/${encodeRedirect(HOME_URL)}`,
  SBN_URL,
  HOME_URL,
  ORDER_URL,
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const args = {visible: true, date: null, timeoutMs: 120000, checkOnly: false};
  const stores = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') args.date = argv[++i];
    else if (a === '--timeout-ms') args.timeoutMs = Number(argv[++i]);
    else if (a === '--headless') args.visible = false;
    else if (a === '--visible') args.visible = true;
    else if (a === '--check-only') args.checkOnly = true;
    else if (!a.startsWith('--')) stores.push(...a.split(',').map(s => s.trim().toUpperCase()).filter(Boolean));
  }
  args.stores = stores;
  if (!args.stores.length) throw new Error('Missing store key(s), e.g. DL or DL,DX');
  return args;
}

async function launchStore(storeKey, visible) {
  const args = [path.join(ROOT, 'scripts', 'launch_store_browser.mjs'), storeKey, visible ? '--visible' : '--headless'];
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', d => stderr += d);
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr || `launch failed ${code}`)));
  });
}

async function fetchCdpTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, {signal: AbortSignal.timeout(4000)});
  if (!res.ok) throw new Error(`CDP target list HTTP ${res.status}`);
  return await res.json();
}

async function waitForCdpTargets(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const targets = await fetchCdpTargets(port);
      if (Array.isArray(targets)) return targets;
      lastError = new Error('CDP target list is not an array');
    } catch (err) {
      lastError = err;
    }
    await sleep(1000);
  }
  throw new Error(`CDP port ${port} did not become ready within ${timeoutMs}ms: ${lastError?.message || 'unknown error'}`);
}

async function connectCdp(port, timeoutMs = 45_000) {
  const targets = await waitForCdpTargets(port, timeoutMs);
  const page = targets.find(t => t.type === 'page' && /geiwohuo|shein/i.test(t.url)) || targets.find(t => t.type === 'page');
  if (!page) throw new Error(`No page target on port ${port}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const {resolve, reject} = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
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
  await send('Runtime.enable');
  await send('Page.enable');
  return {send, ws};
}

async function evaluate(send, expression) {
  const result = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}

async function navigate(send, url, waitMs = 3500) {
  await send('Page.navigate', {url});
  await sleep(waitMs);
}

async function pageInfo(send) {
  return await evaluate(send, `(() => {
    const text = document.body?.innerText || '';
    return {
      href: location.href,
      title: document.title,
      textPreview: text.slice(0, 800),
      hasLoginText: text.includes('\\u767b\\u5f55') || /login/i.test(text),
      inputs: [...document.querySelectorAll('input')].map((el, i) => ({
        i,
        type: el.type || '',
        placeholder: el.placeholder || '',
        hasValue: !!el.value,
        visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
      }))
    };
  })()`);
}

async function apiProbe(send, date) {
  const d = date || new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return await evaluate(send, `(async () => {
    try {
      const res = await fetch('/gsp/orderPlus/listOrder', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json;Charset=utf-8',
          'Origin-Path': '/order-management/list',
          'Origin-Url': location.origin + '/#/gsp/order-management/list'
        },
        body: JSON.stringify({
          allocateTimeStart: '${d} 00:00:00',
          allocateTimeEnd: '${d} 23:59:59',
          excludeOrderType: 5,
          tabIndex: 1,
          page: 1,
          perPage: 10
        })
      });
      const json = await res.json();
      return {code: String(json.code), msg: String(json.msg || ''), count: json.info?.meta?.count ?? null, href: location.href, title: document.title};
    } catch (err) {
      return {error: String(err), href: location.href, title: document.title};
    }
  })()`);
}

async function sbnProbe(send) {
  await navigate(send, SBN_URL, 8000);
  return await evaluate(send, `(() => {
    const text = document.body?.innerText || '';
    return {
      href: location.href,
      title: document.title,
      ok: !/\\/login\\/GMPSSO\\//.test(location.href) && text.includes('\\u5546\\u54c1\\u5206\\u6790'),
      hasLoginText: text.includes('\\u8d26\\u53f7') && text.includes('\\u5bc6\\u7801') && text.includes('\\u767b\\u5f55'),
      textPreview: text.slice(0, 500)
    };
  })()`);
}

async function trySavedPassword(send) {
  // This only uses Chrome UI/autofill. It does not read or log values.
  return await evaluate(send, `(async () => {
    const visibleInputs = [...document.querySelectorAll('input')]
      .filter(el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const userInput = visibleInputs.find(el => (el.type || '').toLowerCase() !== 'password');
    if (userInput) {
      userInput.focus();
      userInput.dispatchEvent(new Event('focus', {bubbles: true}));
    }
    return {
      focused: !!userInput,
      hasTextValue: visibleInputs.some(el => (el.type || '').toLowerCase() !== 'password' && !!el.value),
      hasPasswordValue: visibleInputs.some(el => (el.type || '').toLowerCase() === 'password' && !!el.value),
      inputCount: visibleInputs.length
    };
  })()`);
}

async function closeModalIfAny(send) {
  return await evaluate(send, `(async () => {
    const visible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const buttons = [...document.querySelectorAll('button,[role=button]')].filter(visible);
    const ok = buttons.find(el => {
      const text = (el.innerText || el.textContent || '').trim();
      return text.includes('\\u77e5\\u9053\\u4e86') || /^OK$/i.test(text);
    });
    if (ok) {
      ok.click();
      await new Promise(r => setTimeout(r, 500));
      return true;
    }
    return false;
  })()`);
}

async function key(send, keyName) {
  await send('Input.dispatchKeyEvent', {type: 'keyDown', key: keyName});
  await send('Input.dispatchKeyEvent', {type: 'keyUp', key: keyName});
}

async function clickLogin(send) {
  return await evaluate(send, `(async () => {
    const visible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const candidates = [...document.querySelectorAll('button,[role=button],a,div,span')]
      .filter(visible)
      .map(el => {
        const r = el.getBoundingClientRect();
        return {el, text: (el.innerText || el.textContent || '').trim(), tag: el.tagName, area: r.width * r.height};
      })
      .filter(x => x.text && (x.text.includes('\\u767b\\u5f55') || /login/i.test(x.text)))
      .slice(0, 10);
    const target = candidates.find(x => x.tag === 'BUTTON' && x.text === '\\u767b\\u5f55')
      || candidates.find(x => x.tag === 'BUTTON' && x.text.length <= 20 && x.area > 1000)
      || candidates.find(x => x.text === '\\u767b\\u5f55')
      || candidates.find(x => x.text.length <= 20 && x.area > 1000)
      || candidates[0];
    if (!target) return {clicked: false, candidates: candidates.map(x => x.text)};
    target.el.click();
    return {clicked: true, text: target.text};
  })()`);
}

async function restoreOne(store, opts) {
  await launchStore(store.storeKey, opts.visible);
  const {send, ws} = await connectCdp(store.port, Math.min(opts.timeoutMs, 60_000));
  const started = Date.now();
  const steps = [];
  try {
    await navigate(send, ORDER_URL, 2500);
    let probe = await apiProbe(send, opts.date);
    steps.push({step: 'initial-probe', probe});
    if (probe.code === '0') {
      const sbn = await sbnProbe(send);
      steps.push({step: 'initial-sbn-probe', sbn});
      if (sbn.ok) return {storeKey: store.storeKey, ok: true, alreadyOk: true, steps};
    }
    if (opts.checkOnly) return {storeKey: store.storeKey, ok: false, reason: 'current_profile_not_logged_in', checkOnly: true, steps};

    for (const url of LOGIN_URLS) {
      if (Date.now() - started > opts.timeoutMs) break;
      await closeModalIfAny(send);
      await navigate(send, url, 4500);
      await closeModalIfAny(send);
      let info = await pageInfo(send);
      steps.push({step: 'navigate', url, info: {href: info.href, title: info.title, hasLoginText: info.hasLoginText, inputs: info.inputs}});

      const hasPasswordInput = info.inputs?.some(x => String(x.type).toLowerCase() === 'password' && x.visible);
      const looksLogin = info.hasLoginText || hasPasswordInput;
      if (looksLogin) {
        let fillState = await trySavedPassword(send);
        steps.push({step: 'autofill-state-1', fillState});
        if (!(fillState.hasTextValue && fillState.hasPasswordValue)) {
          await key(send, 'ArrowDown');
          await sleep(300);
          await key(send, 'Enter');
          await sleep(800);
          fillState = await trySavedPassword(send);
          steps.push({step: 'autofill-state-2', fillState});
        }
        const click = await clickLogin(send);
        steps.push({step: 'click-login', click});
        await sleep(6500);
      }

      await navigate(send, ORDER_URL, 3500);
      probe = await apiProbe(send, opts.date);
      steps.push({step: 'probe-after-url', url, probe});
      if (probe.code === '0') {
        const sbn = await sbnProbe(send);
        steps.push({step: 'sbn-probe-after-url', url, sbn});
        if (sbn.ok) return {storeKey: store.storeKey, ok: true, alreadyOk: false, steps};
      }
    }
    return {storeKey: store.storeKey, ok: false, reason: 'login_not_restored', steps};
  } finally {
    ws.close();
  }
}

const args = parseArgs(process.argv.slice(2));
const storesConfig = JSON.parse(await fs.readFile(STORES_PATH, 'utf8'));
const selected = args.stores.map(key => {
  const s = storesConfig.stores.find(x => x.storeKey.toUpperCase() === key);
  if (!s) throw new Error(`Unknown store: ${key}`);
  return s;
});

const results = [];
for (const store of selected) {
  try {
    const result = await restoreOne(store, args);
    results.push(result);
    console.log(JSON.stringify({storeKey: result.storeKey, ok: result.ok, alreadyOk: result.alreadyOk || false, reason: result.reason || null}));
  } catch (err) {
    results.push({storeKey: store.storeKey, ok: false, error: String(err?.stack || err)});
    console.log(JSON.stringify({storeKey: store.storeKey, ok: false, error: String(err?.message || err)}));
  }
}

const summary = {
  ok: results.every(r => r.ok),
  date: args.date || null,
  stores: results.map(r => r.storeKey),
  failedStores: results.filter(r => !r.ok).map(r => r.storeKey),
  results,
};
await fs.mkdir(path.join(ROOT, 'outputs', 'reports'), {recursive: true});
const reportFile = path.join(ROOT, 'outputs', 'reports', `auto-relogin-${Date.now()}.json`);
await fs.writeFile(reportFile, JSON.stringify(summary, null, 2), 'utf8');
console.log(JSON.stringify({...summary, results: undefined, reportFile: path.relative(ROOT, reportFile)}, null, 2));
process.exit(summary.ok ? 0 : 1);
