#!/usr/bin/env node
/**
 * Launch a dedicated workspace-local Chrome profile for the SHEIN main account.
 *
 * This profile is intentionally separated from the existing 15 store profiles so
 * exploration with the main account does not affect scheduled sales/link jobs.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn, spawnSync} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_URL = 'https://sso.geiwohuo.com/#/gsp/inventory-management/storage-age';
const DEFAULT_PORT = 9360;
const PROFILE_NAME = 'SHEIN 主账号';

function chromeExecutablePath() {
  const candidates = [
    process.env.CHROME_PATH,
    'D:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return 'chrome.exe';
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

function ensureProfileName(profileDir) {
  const chromeProfileDir = path.join(profileDir, 'Profile 1');
  fs.mkdirSync(chromeProfileDir, {recursive: true});

  const prefsPath = path.join(chromeProfileDir, 'Preferences');
  const prefs = loadJson(prefsPath);
  prefs.profile ||= {};
  prefs.profile.name = PROFILE_NAME;
  prefs.profile.is_using_default_name = false;
  saveJson(prefsPath, prefs);

  const localStatePath = path.join(profileDir, 'Local State');
  const localState = loadJson(localStatePath);
  localState.profile ||= {};
  localState.profile.info_cache ||= {};
  localState.profile.info_cache['Profile 1'] ||= {};
  localState.profile.info_cache['Profile 1'].name = PROFILE_NAME;
  localState.profile.info_cache['Profile 1'].is_using_default_name = false;
  localState.profile.info_cache['Profile 1'].avatar_icon ||= 'chrome://theme/IDR_PROFILE_AVATAR_26';
  saveJson(localStatePath, localState);

  fs.writeFileSync(path.join(profileDir, 'PROFILE_NAME.txt'), `${PROFILE_NAME}\n`, 'utf8');
}

function parseArgs(argv) {
  const args = {
    url: DEFAULT_URL,
    port: DEFAULT_PORT,
    background: false,
    headless: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') args.url = argv[++i] || DEFAULT_URL;
    else if (a === '--port') args.port = Number(argv[++i] || DEFAULT_PORT);
    else if (a === '--headless') {
      args.headless = true;
      args.background = false;
    } else if (a === '--background') {
      args.background = true;
      args.headless = false;
    } else if (a === '--visible') {
      args.background = false;
      args.headless = false;
    } else if (!a.startsWith('--')) {
      args.url = a;
    }
  }
  return args;
}

const cliArgs = parseArgs(process.argv.slice(2));
const chrome = chromeExecutablePath();
const profileDir = path.join(ROOT, 'profiles', 'persistent-shein-main-profile');
const cacheDir = path.join(profileDir, 'cache');
const logDir = path.join(ROOT, 'logs');

fs.mkdirSync(profileDir, {recursive: true});
fs.mkdirSync(cacheDir, {recursive: true});
fs.mkdirSync(logDir, {recursive: true});
ensureProfileName(profileDir);

const chromeArgs = [
  `--user-data-dir=${profileDir}`,
  `--disk-cache-dir=${cacheDir}`,
  '--remote-debugging-address=127.0.0.1',
  `--remote-debugging-port=${cliArgs.port}`,
  '--profile-directory=Profile 1',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  ...(cliArgs.headless ? [
    '--headless=new',
    '--disable-gpu',
    '--mute-audio',
    '--window-size=1400,1000',
  ] : []),
  ...(cliArgs.background ? [
    '--start-minimized',
    '--window-position=-32000,-32000',
    '--window-size=1400,1000',
  ] : []),
  cliArgs.url,
];

function psSingleQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function quoteWindowsArg(value) {
  const s = String(value);
  if (!/[\s"]/.test(s)) return s;
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/g, '$&$&')}"`;
}

if (process.platform === 'win32') {
  const result = spawnSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from([
        "$ErrorActionPreference = 'Stop'",
        `$argsForChrome = ${psSingleQuote(chromeArgs.map(quoteWindowsArg).join(' '))}`,
        `Start-Process -FilePath ${psSingleQuote(chrome)} -ArgumentList $argsForChrome${cliArgs.background || cliArgs.headless ? ' -WindowStyle Minimized' : ''}`,
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
  const child = spawn(chrome, chromeArgs, {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

console.log(JSON.stringify({
  profileName: PROFILE_NAME,
  port: cliArgs.port,
  profileDir,
  cacheDir,
  url: cliArgs.url,
  mode: cliArgs.headless ? 'headless' : (cliArgs.background ? 'background' : 'visible'),
}, null, 2));
