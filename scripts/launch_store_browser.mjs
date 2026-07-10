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
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') args.url = argv[++i] || ORDER_URL;
    else if (a === '--headless') {
      args.headless = true;
      args.background = false;
    }
    else if (a === '--background') {
      args.background = true;
      args.headless = false;
    }
    else if (a === '--visible') {
      args.background = false;
      args.headless = false;
    }
    else if (!args.storeKey) args.storeKey = a;
    else if (!a.startsWith('--')) args.url = a;
  }
  return args;
}

const cliArgs = parseArgs(process.argv.slice(2));
const storeKey = cliArgs.storeKey;
const customUrl = cliArgs.url || ORDER_URL;
if (!storeKey) throw new Error('Missing store key, e.g. DL');
if (CHROME !== 'chrome.exe' && !fs.existsSync(CHROME)) throw new Error(`Chrome not found: ${CHROME}`);

const store = getStore(storeKey);
const profileDir = path.join(ROOT, 'profiles', `persistent-${store.profileKey}-profile`);
const cacheDir = path.join(profileDir, 'cache');
const logDir = path.join(ROOT, 'logs');
fs.mkdirSync(profileDir, {recursive: true});
fs.mkdirSync(cacheDir, {recursive: true});
fs.mkdirSync(logDir, {recursive: true});
const profileName = ensureProfileName(profileDir, store);

const args = [
  `--user-data-dir=${profileDir}`,
  `--disk-cache-dir=${cacheDir}`,
  '--remote-debugging-address=127.0.0.1',
  `--remote-debugging-port=${store.port}`,
  '--profile-directory=Profile 1',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
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
      const pages = await new Promise((resolve, reject) => {
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
      if (Array.isArray(pages)) return {ok: true, pageCount: pages.length};
      lastError = 'debug port returned non-array page list';
    } catch (error) {
      lastError = error?.message || String(error);
    }
    await sleep(500);
  }
  return {ok: false, error: lastError || `debug port ${port} not ready within ${timeoutMs}ms`};
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

console.log(JSON.stringify({
  storeKey: store.storeKey,
  shopName: store.shopName,
  profileName,
  port: store.port,
  profileDir,
  url: customUrl,
  mode: cliArgs.headless ? 'headless' : (cliArgs.background ? 'background' : 'visible'),
  headless: cliArgs.headless,
  background: cliArgs.background,
  debugPort,
}, null, 2));
