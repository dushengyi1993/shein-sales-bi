#!/usr/bin/env node
/**
 * Launch Windows Chrome for one SHEIN store using a workspace-local profile.
 *
 * Usage:
 *   node scripts/launch_store_browser.mjs DL
 *   node scripts/launch_store_browser.mjs DL --headless
 *   node scripts/launch_store_browser.mjs DL --visible
 *   node scripts/launch_store_browser.mjs DL --background
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn, spawnSync} from 'node:child_process';
import http from 'node:http';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'D:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
];
const CHROME = CHROME_CANDIDATES.find(p => fs.existsSync(p)) || 'chrome.exe';
const ORDER_URL = 'https://sso.geiwohuo.com/#/gsp/order-management/list';
const storesConfig = JSON.parse(await fsp.readFile(path.join(ROOT, 'config', 'stores.json'), 'utf8'));

function getStore(key) {
  const store = storesConfig.stores.find(s => s.storeKey.toUpperCase() === key.toUpperCase());
  if (!store) throw new Error(`Unknown store key: ${key}`);
  return store;
}

function loadJson(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return text.trim() ? JSON.parse(text) : {};
}

function saveJson(file, obj) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

function ensureProfileName(profileDir, store) {
  const profileName = store.profileName || `${store.storeKey} - ${store.shopName}`;
  const chromeProfileDir = path.join(profileDir, 'Profile 1');
  fs.mkdirSync(chromeProfileDir, {recursive: true});

  const prefsPath = path.join(chromeProfileDir, 'Preferences');
  const prefs = loadJson(prefsPath);
  prefs.profile ||= {};
  prefs.profile.name = profileName;
  prefs.profile.is_using_default_name = false;
  saveJson(prefsPath, prefs);

  const localStatePath = path.join(profileDir, 'Local State');
  const localState = loadJson(localStatePath);
  localState.profile ||= {};
  localState.profile.info_cache ||= {};
  localState.profile.info_cache['Profile 1'] ||= {};
  localState.profile.info_cache['Profile 1'].name = profileName;
  localState.profile.info_cache['Profile 1'].is_using_default_name = false;
  localState.profile.info_cache['Profile 1'].avatar_icon ||= 'chrome://theme/IDR_PROFILE_AVATAR_26';
  saveJson(localStatePath, localState);

  fs.writeFileSync(path.join(profileDir, 'PROFILE_NAME.txt'), `${profileName}\n`, 'utf8');
  return profileName;
}

function parseArgs(argv) {
  const args = {
    storeKey: null,
    url: ORDER_URL,
    background: false,
    headless: false,
    allowLocalNetworkAssets: false,
    port: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') args.url = argv[++i] || ORDER_URL;
    else if (a === '--port') args.port = Number(argv[++i] || 0);
    else if (a === '--headless') {
      args.headless = true;
      args.background = false;
    }
    else if (a === '--background') {
      args.background = true;
      args.headless = false;
    }
    else if (a === '--allow-local-network-assets') {
      args.allowLocalNetworkAssets = true;
    }
    else if (a === '--visible') {
      args.background = false;
      args.headless = false;
    }
    else if (a.startsWith('--')) throw new Error(`Unknown argument: ${a}`);
    else if (!args.storeKey) args.storeKey = a;
    else args.url = a;
  }
  return args;
}

const cliArgs = parseArgs(process.argv.slice(2));
const storeKey = cliArgs.storeKey;
const customUrl = cliArgs.url || ORDER_URL;
if (!storeKey) throw new Error('Missing store key, e.g. DL');
if (CHROME !== 'chrome.exe' && !fs.existsSync(CHROME)) throw new Error(`Chrome not found: ${CHROME}`);

const store = getStore(storeKey);
if (cliArgs.port !== null) {
  if (!Number.isInteger(cliArgs.port) || cliArgs.port < 1024 || cliArgs.port > 65535) {
    throw new Error(`Invalid --port: ${cliArgs.port}`);
  }
  store.port = cliArgs.port;
}
const profileDir = path.join(ROOT, 'profiles', `persistent-${store.profileKey}-profile`);
// Keep disposable browser cache outside the persistent login profile.  The old
// layout placed it below every store profile and allowed Chromium to grow an
// unbounded copy per store.  Login state (Cookies/Local Storage/IndexedDB)
// remains in profileDir; only cache lives in the disposable root.
const localCacheRoot = process.env.SHEIN_BI_LOCAL_BROWSER_CACHE_ROOT
  ? path.resolve(process.env.SHEIN_BI_LOCAL_BROWSER_CACHE_ROOT)
  : path.join(process.env.LOCALAPPDATA || ROOT, 'SheinBI', 'browser-cache');
const cacheRootMarker = path.join(localCacheRoot, '.shein-bi-disposable-cache-root');
const cacheRootMarkerContent = 'shein-bi-disposable-browser-cache-v1\n';
const cacheDir = process.platform === 'win32'
  ? path.join(localCacheRoot, String(store.profileKey || store.storeKey).toLowerCase())
  : path.join(profileDir, 'cache');
const logDir = path.join(ROOT, 'logs');
fs.mkdirSync(profileDir, {recursive: true});
if (process.platform === 'win32') {
  if (localCacheRoot === path.parse(localCacheRoot).root || path.basename(localCacheRoot).toLowerCase() !== 'browser-cache') {
    throw new Error(`Unsafe SHEIN_BI_LOCAL_BROWSER_CACHE_ROOT: ${localCacheRoot}`);
  }
  fs.mkdirSync(localCacheRoot, {recursive: true});
  const rootStat = fs.lstatSync(localCacheRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Disposable browser cache root must be a real directory: ${localCacheRoot}`);
  }
  if (fs.existsSync(cacheRootMarker)) {
    const markerStat = fs.lstatSync(cacheRootMarker);
    const markerContent = markerStat.isFile() && !markerStat.isSymbolicLink()
      ? fs.readFileSync(cacheRootMarker, 'utf8')
      : '';
    if (markerContent !== cacheRootMarkerContent) {
      throw new Error(`Disposable browser cache marker mismatch: ${cacheRootMarker}`);
    }
  } else {
    fs.writeFileSync(cacheRootMarker, cacheRootMarkerContent, {encoding: 'utf8', flag: 'wx'});
  }
}
fs.mkdirSync(cacheDir, {recursive: true});
fs.mkdirSync(logDir, {recursive: true});
const profileName = ensureProfileName(profileDir, store);
const disabledFeatures = [
  'OptimizationGuideOnDeviceModel',
  'OptimizationGuideModelDownloading',
  'OptimizationGuideModelExecution',
  'PromptAPIForGeminiNano',
  'SummarizationAPIForGeminiNano',
  'WriterAPIForGeminiNano',
  'RewriterAPIForGeminiNano',
  ...(cliArgs.allowLocalNetworkAssets ? ['LocalNetworkAccessChecks'] : []),
];

const args = [
  `--user-data-dir=${profileDir}`,
  `--disk-cache-dir=${cacheDir}`,
  '--disk-cache-size=104857600',
  '--remote-debugging-address=127.0.0.1',
  `--remote-debugging-port=${store.port}`,
  '--profile-directory=Profile 1',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  // SHEIN automation does not use Chrome's on-device AI.  Disabling these
  // components prevents multi-gigabyte model copies from being downloaded
  // independently into every persistent store profile.
  // Some SHEIN CDN hostnames resolve through the local proxy address space;
  // when requested, LocalNetworkAccessChecks joins the same switch so a
  // duplicate --disable-features argument cannot overwrite the model guards.
  `--disable-features=${disabledFeatures.join(',')}`,
  ...(!cliArgs.background && !cliArgs.headless ? [
    '--start-maximized',
  ] : []),
  ...(process.platform !== 'win32' ? [
    '--disable-dev-shm-usage',
    ...(typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : []),
  ] : []),
  ...(cliArgs.headless ? [
    '--headless=new',
    '--disable-gpu',
    '--mute-audio',
    '--window-size=1200,900',
  ] : []),
  ...(cliArgs.background ? [
    '--start-minimized',
    '--window-position=-32000,-32000',
    '--window-size=1200,900',
  ] : []),
  customUrl,
];

function psSingleQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function quoteWindowsArg(value) {
  const s = String(value);
  if (!/[\s"]/.test(s)) return s;
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/g, '$&$&')}"`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForDebugPort(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const pages = await getDebugPages(port);
      if (Array.isArray(pages)) return {ok: true, pageCount: pages.length};
      lastError = 'debug port returned non-array page list';
    } catch (error) {
      lastError = error?.message || String(error);
    }
    await sleep(500);
  }
  return {ok: false, error: lastError || `debug port ${port} not ready within ${timeoutMs}ms`};
}

async function getDebugPages(port) {
  return await new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1',
      port,
      path: '/json/list',
      timeout: 1500,
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('debug port timeout')));
    req.on('error', reject);
  });
}

async function forceRefreshMarketingPage(port, maxAttempts = 3) {
  let lastState = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const pages = await getDebugPages(port);
    const page = pages.find(item => item.type === 'page' && String(item.url || '').includes('sso.geiwohuo.com/#/mbrs/'))
      || pages.find(item => item.type === 'page' && String(item.url || '').includes('sso.geiwohuo.com'))
      || pages.find(item => item.type === 'page');
    if (!page?.webSocketDebuggerUrl) {
      throw new Error(`Chrome page target missing on port ${port}`);
    }
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const pending = new Map();
    let nextId = 0;
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`WebSocket open timeout on port ${port}`)), 10_000);
        ws.addEventListener('open', () => {
          clearTimeout(timer);
          resolve();
        }, {once: true});
        ws.addEventListener('error', error => {
          clearTimeout(timer);
          reject(error);
        }, {once: true});
      });
    } catch (error) {
      ws.close();
      throw error;
    }
    ws.addEventListener('message', event => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!message.id || !pending.has(message.id)) return;
      const item = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(item.timer);
      message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result);
    });
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 20_000);
      pending.set(id, {resolve, reject, timer});
      ws.send(JSON.stringify({id, method, params}));
    });
    try {
      await call('Page.enable');
      await call('Runtime.enable');
      await call('Page.reload', {ignoreCache: true});
      await sleep(3500);
      const evaluated = await call('Runtime.evaluate', {
        expression: `({
          href: location.href,
          text: String(document.body?.innerText || '').slice(0, 4000),
          readyState: document.readyState
        })`,
        returnByValue: true,
      });
      lastState = evaluated?.result?.value || null;
    } finally {
      ws.close();
    }
    const text = String(lastState?.text || '');
    const renderFailed = /渲染异常|LOADING_SOURCE_CODE|Failed to load app|Failed to load script/i.test(text);
    if (!renderFailed) {
      return {ok: true, attempts: attempt, state: lastState};
    }
    await sleep(1200);
  }
  return {ok: false, attempts: maxAttempts, state: lastState};
}

if (process.platform === 'win32') {
  const result = spawnSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from([
        "$ErrorActionPreference = 'Stop'",
        `$argsForChrome = ${psSingleQuote(args.map(quoteWindowsArg).join(' '))}`,
        `Start-Process -FilePath ${psSingleQuote(CHROME)} -ArgumentList $argsForChrome${cliArgs.background || cliArgs.headless ? ' -WindowStyle Minimized' : ''}`,
      ].join('\n'), 'utf16le').toString('base64'),
    ], {
    cwd: ROOT,
    stdio: 'ignore',
    windowsHide: cliArgs.background || cliArgs.headless,
    timeout: 15000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`PowerShell Start-Process failed with exit code ${result.status}`);
} else {
  const child = spawn(CHROME, args, {
    cwd: ROOT,
    detached: false,
    stdio: 'ignore',
  });
  child.unref();
}

const debugPort = await waitForDebugPort(store.port);
if (!debugPort.ok) {
  throw new Error(`Chrome remote debugging port not ready for ${store.storeKey} port=${store.port}: ${debugPort.error}`);
}
const marketingRefresh = customUrl.includes('/#/mbrs/')
  ? await (async () => {
      await sleep(2000);
      return await forceRefreshMarketingPage(store.port);
    })()
  : null;
if (marketingRefresh && !marketingRefresh.ok) {
  throw new Error(`Marketing page still failed after ${marketingRefresh.attempts} forced refresh attempts for ${store.storeKey}`);
}

console.log(JSON.stringify({
  storeKey: store.storeKey,
  shopName: store.shopName,
  profileName,
  port: store.port,
  profileDir,
  cacheDir,
  url: customUrl,
  mode: cliArgs.headless ? 'headless' : (cliArgs.background ? 'background' : 'visible'),
  headless: cliArgs.headless,
  background: cliArgs.background,
  debugPort,
  marketingRefresh: marketingRefresh ? {
    ok: marketingRefresh.ok,
    attempts: marketingRefresh.attempts,
    readyState: marketingRefresh.state?.readyState || '',
    href: marketingRefresh.state?.href || '',
  } : null,
}, null, 2));
