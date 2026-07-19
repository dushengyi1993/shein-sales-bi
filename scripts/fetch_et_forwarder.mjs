#!/usr/bin/env node
/**
 * Read-only ET forwarder / warehouse backend fetcher.
 *
 * It reuses the dedicated Chrome profile login state and only calls read-only
 * list/detail/export endpoints. It never clicks or submits write actions in the
 * ET backend.
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn, spawnSync} from 'node:child_process';
import {findChromeExecutable} from '../lib/chrome_executable.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {
    mode: 'daily',
    date: bjDate(0),
    startDate: '2020-01-01',
    baseUrl: 'http://47.90.12.162:9007',
    port: 9397,
    profileDir: path.join(ROOT, 'profiles', 'persistent-et-forwarder-profile'),
    outDir: path.join(ROOT, 'outputs', 'et-forwarder'),
    limit: 100,
    maxPages: 0,
    maxDetails: 0,
    detailOffset: 0,
    detailConcurrency: 1,
    detailNames: '',
    skipDetails: false,
    detailAll: false,
    dailyInitialPages: 3,
    shipLookbackDays: 7,
    overlapRows: 5,
    minPages: 1,
    waitMs: 250,
    launch: true,
    autoLogin: true,
    visible: false,
    statePath: path.join(ROOT, 'state', 'et_forwarder_sync_state.json'),
    endpoints: '',
    includeFinance: false,
    storageFeeOnly: false,
    updateState: true,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode') args.mode = argv[++i];
    else if (a === '--date') args.date = argv[++i];
    else if (a === '--start-date') args.startDate = argv[++i];
    else if (a === '--base-url') args.baseUrl = argv[++i].replace(/\/+$/, '');
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--profile-dir') args.profileDir = path.resolve(argv[++i]);
    else if (a === '--out-dir') args.outDir = path.resolve(argv[++i]);
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--max-pages') args.maxPages = Number(argv[++i]);
    else if (a === '--max-details') args.maxDetails = Number(argv[++i]);
    else if (a === '--detail-offset') args.detailOffset = Number(argv[++i]);
    else if (a === '--detail-concurrency') args.detailConcurrency = Number(argv[++i]);
    else if (a === '--detail-names') args.detailNames = argv[++i] || '';
    else if (a === '--skip-details') args.skipDetails = true;
    else if (a === '--detail-all') args.detailAll = true;
    else if (a === '--daily-initial-pages') args.dailyInitialPages = Number(argv[++i]);
    else if (a === '--ship-lookback-days') args.shipLookbackDays = Number(argv[++i]);
    else if (a === '--overlap-rows') args.overlapRows = Number(argv[++i]);
    else if (a === '--min-pages') args.minPages = Number(argv[++i]);
    else if (a === '--wait-ms') args.waitMs = Number(argv[++i]);
    else if (a === '--state-path') args.statePath = path.resolve(argv[++i]);
    else if (a === '--endpoints') args.endpoints = argv[++i] || '';
    else if (a === '--include-finance') args.includeFinance = true;
    else if (a === '--no-finance') args.includeFinance = false;
    else if (a === '--storage-fee-only') { args.storageFeeOnly = true; args.includeFinance = true; }
    else if (a === '--no-state-update') args.updateState = false;
    else if (a === '--update-state') args.updateState = true;
    else if (a === '--no-launch') args.launch = false;
    else if (a === '--auto-login') args.autoLogin = true;
    else if (a === '--no-auto-login') args.autoLogin = false;
    else if (a === '--visible') args.visible = true;
    else if (a === '--dry-run') args.dryRun = true;
  }
  args.limit = Math.max(1, Number(args.limit) || 100);
  args.maxPages = Math.max(0, Number(args.maxPages) || 0);
  args.maxDetails = Math.max(0, Number(args.maxDetails) || 0);
  args.detailOffset = Math.max(0, Number(args.detailOffset) || 0);
  args.detailConcurrency = Math.max(1, Math.min(8, Number(args.detailConcurrency) || 1));
  args.shipLookbackDays = Math.max(1, Number(args.shipLookbackDays) || 7);
  if (!['daily', 'backfill', 'smoke'].includes(args.mode)) {
    throw new Error(`Unsupported mode: ${args.mode}`);
  }
  if (args.mode === 'smoke') {
    args.maxPages = args.maxPages || 1;
    args.maxDetails = args.maxDetails || 2;
    args.waitMs = Math.max(args.waitMs, 120);
    args.updateState = false;
  } else if (args.mode === 'daily' && !args.maxDetails) {
    args.maxDetails = 50;
  }
  if (args.detailAll) args.maxDetails = 0;
  args.endpointList = String(args.endpoints || '')
    .split(/[,\s]+/)
    .map(s => s.trim())
    .filter(Boolean);
  args.detailNameList = String(args.detailNames || '')
    .split(/[,\s]+/)
    .map(s => s.trim())
    .filter(Boolean);
  return args;
}

function bjDate(offsetDays) {
  const d = new Date(Date.now() + 8 * 3600_000 + offsetDays * 86400_000);
  return d.toISOString().slice(0, 10);
}

export function addDays(date, offset) {
  // Calendar arithmetic must not round-trip a Beijing midnight through UTC:
  // 2026-07-19T00:00:00+08:00 serializes as 2026-07-18 in ISO UTC.
  const [year, month, day] = String(date).split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day + Number(offset)));
  return d.toISOString().slice(0, 10);
}

function firstDayOfMonth(date) {
  return `${date.slice(0, 7)}-01`;
}

export function firstDayOfPrevMonth(date) {
  const [year, month] = String(date).split('-').map(Number);
  const previousYear = month === 1 ? year - 1 : year;
  const previousMonth = month === 1 ? 12 : month - 1;
  return `${previousYear}-${String(previousMonth).padStart(2, '0')}-01`;
}

function safeName(value) {
  return String(value || '')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 160) || 'unnamed';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function pythonCandidates() {
  return [
    process.env.SHEIN_PYTHON,
    ...(process.platform === 'win32'
      ? [
        'C:\\Users\\dushengyi\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe',
        'python',
        'py',
      ]
      : [
        path.join(ROOT, '.venv-et', 'bin', 'python'),
        'python3',
        'python',
      ]),
  ].filter(Boolean);
}

function commandExists(command) {
  if (!command) return false;
  if (path.isAbsolute(command)) return fssync.existsSync(command);
  const result = process.platform === 'win32'
    ? spawnSync('where.exe', [command], {stdio: 'ignore', windowsHide: true})
    : spawnSync('sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', command], {stdio: 'ignore'});
  return result.status === 0;
}

async function runPythonJson(pyArgs, options = {}) {
  let lastError = null;
  for (const py of pythonCandidates()) {
    if (!commandExists(py)) continue;
    try {
      return await new Promise((resolve, reject) => {
        const child = spawn(py, pyArgs, {
          cwd: ROOT,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {...process.env, ...(options.env || {})},
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', d => { stdout += d.toString('utf8'); });
        child.stderr.on('data', d => { stderr += d.toString('utf8'); });
        child.on('error', reject);
        child.on('close', code => {
          const text = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || '';
          let parsed = null;
          try { parsed = JSON.parse(text); } catch {}
          if (code === 0 && parsed) resolve(parsed);
          else reject(new Error(parsed?.error || stderr.trim() || `python helper exited ${code}`));
        });
      });
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('No usable Python runtime found.');
}

async function httpJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

async function isCdpReady(port) {
  try {
    const info = await httpJson(`http://127.0.0.1:${port}/json/version`);
    return Boolean(info?.webSocketDebuggerUrl);
  } catch {
    return false;
  }
}

function findChrome() {
  return findChromeExecutable();
}

async function launchChrome(args) {
  const chrome = findChrome();
  if (!chrome) throw new Error('Cannot find Chrome/Chromium for ET forwarder profile.');
  await fs.mkdir(args.profileDir, {recursive: true});
  const chromeArgs = [
    `--remote-debugging-port=${args.port}`,
    `--user-data-dir=${args.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-popup-blocking',
    '--disable-dev-shm-usage',
    args.baseUrl + '/Home/Index',
  ];
  if (process.platform !== 'win32') {
    chromeArgs.splice(chromeArgs.length - 1, 0, '--no-sandbox');
    if (!args.visible) chromeArgs.splice(chromeArgs.length - 1, 0, '--headless=new', '--disable-gpu');
  }
  if (process.platform !== 'win32') {
    const child = spawn(chrome, chromeArgs, {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      env: {...process.env},
    });
    child.unref();
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (await isCdpReady(args.port)) return;
      await sleep(500);
    }
    throw new Error(`Chrome CDP did not become ready on port ${args.port}.`);
  }
  const psArgs = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    [
      '$ErrorActionPreference="Stop";',
      `Start-Process -FilePath ${psQuote(chrome)} -ArgumentList ${psQuote(chromeArgs.map(winArg).join(' '))} -WindowStyle ${args.visible ? 'Normal' : 'Hidden'}`,
    ].join(' '),
  ];
  await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', psArgs, {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr || `Chrome launch failed: ${code}`)));
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await isCdpReady(args.port)) return;
    await sleep(500);
  }
  throw new Error(`Chrome CDP did not become ready on port ${args.port}.`);
}

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function winArg(s) {
  const value = String(s);
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.seq = 1;
    this.pending = new Map();
    this.ws = null;
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    };
  }
  call(method, params = {}) {
    const id = this.seq++;
    this.ws.send(JSON.stringify({id, method, params}));
    return new Promise((resolve, reject) => this.pending.set(id, {resolve, reject}));
  }
  async eval(expression) {
    const result = await this.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  close() {
    try { this.ws?.close(); } catch {}
  }
}

async function getEtPage(args) {
  const pages = await httpJson(`http://127.0.0.1:${args.port}/json/list`);
  let page = pages.find(p => p.type === 'page' && p.url?.startsWith(args.baseUrl) && p.webSocketDebuggerUrl);
  if (!page) page = pages.find(p => p.type === 'page' && /et-global\.cn|47\.90\.12\.162/.test(p.url || '') && p.webSocketDebuggerUrl);
  if (!page) page = pages.find(p => p.type === 'page' && p.webSocketDebuggerUrl);
  if (!page) throw new Error('No Chrome page with CDP WebSocket found.');
  return page;
}

async function browserFetchJson(cdp, args, url) {
  const absolute = url.startsWith('http') ? url : args.baseUrl + url;
  const pathOrUrl = url.startsWith('http') ? absolute : url;
  const script = `(async()=>{` +
    `try{` +
    `const raw=${JSON.stringify(pathOrUrl)};` +
    `const sameOriginBase=(location&&/^https?:/.test(location.origin))?location.origin:${JSON.stringify(args.baseUrl)};` +
    `const target=/^https?:/i.test(raw)?raw:new URL(raw,sameOriginBase).href;` +
    `const r=await fetch(target, {credentials:'include', headers:{'X-Requested-With':'XMLHttpRequest','Accept':'application/json, text/javascript, */*; q=0.01'}});` +
    `const text=await r.text(); let json=null; try{json=JSON.parse(text)}catch(e){};` +
    `return {ok:r.ok,status:r.status,url:r.url,contentType:r.headers.get('content-type'),text:text.slice(0,400),json};` +
    `}catch(e){return {ok:false,status:0,url:${JSON.stringify(absolute)},contentType:'',text:String(e&&e.message||e),json:null,fetchError:String(e&&e.stack||e)}};` +
  `})()`;
  const out = await cdp.eval(script);
  if (!out.ok || !out.json) {
    throw new Error(`ET fetch failed status=${out.status} url=${absolute} head=${out.text}`);
  }
  return out.json;
}

async function browserPostJson(cdp, args, url, bodyParams = {}) {
  const absolute = url.startsWith('http') ? url : args.baseUrl + url;
  const pathOrUrl = url.startsWith('http') ? absolute : url;
  const script = `(async()=>{` +
    `try{` +
    `const raw=${JSON.stringify(pathOrUrl)};` +
    `const params=${JSON.stringify(bodyParams)};` +
    `const sameOriginBase=(location&&/^https?:/.test(location.origin))?location.origin:${JSON.stringify(args.baseUrl)};` +
    `const target=/^https?:/i.test(raw)?raw:new URL(raw,sameOriginBase).href;` +
    `const body=new URLSearchParams(); Object.entries(params||{}).forEach(([k,v])=>body.set(k,String(v==null?'':v)));` +
    `const r=await fetch(target,{method:'POST',credentials:'include',headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8','X-Requested-With':'XMLHttpRequest','Accept':'application/json, text/javascript, */*; q=0.01'},body});` +
    `const text=await r.text(); let json=null; try{json=JSON.parse(text)}catch(e){};` +
    `return {ok:r.ok,status:r.status,url:r.url,contentType:r.headers.get('content-type'),text:text.slice(0,400),json};` +
    `}catch(e){return {ok:false,status:0,url:${JSON.stringify(absolute)},contentType:'',text:String(e&&e.message||e),json:null,fetchError:String(e&&e.stack||e)}};` +
  `})()`;
  const out = await cdp.eval(script);
  if (!out.ok || !out.json) {
    throw new Error(`ET POST failed status=${out.status} url=${absolute} head=${out.text}`);
  }
  return out.json;
}

async function browserFetchText(cdp, args, url) {
  const absolute = url.startsWith('http') ? url : args.baseUrl + url;
  const pathOrUrl = url.startsWith('http') ? absolute : url;
  const script = `(async()=>{` +
    `try{` +
    `const raw=${JSON.stringify(pathOrUrl)};` +
    `const sameOriginBase=(location&&/^https?:/.test(location.origin))?location.origin:${JSON.stringify(args.baseUrl)};` +
    `const target=/^https?:/i.test(raw)?raw:new URL(raw,sameOriginBase).href;` +
    `const r=await fetch(target, {credentials:'include', headers:{'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'}});` +
    `const html=await r.text();` +
    `let text=html;` +
    `try{const doc=new DOMParser().parseFromString(html,'text/html'); text=(doc.body&&(doc.body.innerText||doc.body.textContent)||html)}catch(e){};` +
    `text=String(text||'').replace(/\\u00a0/g,' ').replace(/[ \\t]+/g,' ').replace(/\\n[ \\t]+/g,'\\n').trim();` +
    `return {ok:r.ok,status:r.status,url:r.url,contentType:r.headers.get('content-type'),text:text.slice(0,12000)};` +
    `}catch(e){return {ok:false,status:0,url:${JSON.stringify(absolute)},contentType:'',text:String(e&&e.message||e),fetchError:String(e&&e.stack||e)}};` +
  `})()`;
  const out = await cdp.eval(script);
  if (!out.ok) {
    throw new Error(`ET text fetch failed status=${out.status} url=${absolute} head=${String(out.text || '').slice(0, 400)}`);
  }
  return out;
}

async function probeEtHome(cdp, args) {
  return cdp.eval(`(async()=>{` +
    `try{` +
    `const sameOriginBase=(location&&/^https?:/.test(location.origin))?location.origin:${JSON.stringify(args.baseUrl)};` +
    `const r=await fetch(new URL('/Home/Index',sameOriginBase).href,{credentials:'include'});` +
    `const text=await r.text();` +
    `return {status:r.status,title:(text.match(/<title>([^<]+)/)||[])[1]||'',login:/Login|验证码|密码|登入/.test(text)&&!/易通天下物流端/.test(text)};` +
    `}catch(e){return {status:0,title:'',login:true,error:String(e&&e.message||e)}};` +
  `})()`);
}

async function readSavedEtCredentials(args) {
  const out = await runPythonJson([
    path.join(ROOT, 'scripts', 'et_login_helper.py'),
    'credentials',
    '--profile-dir',
    args.profileDir,
    '--base-url',
    args.baseUrl,
  ], {env: {ET_LOGIN_HELPER_ALLOW_SECRET: '1'}});
  if (!out?.ok || !out.username || !out.password) {
    throw new Error(`ET credentials are not available (${out?.error || 'unknown'}). On cloud, set ET_FORWARDER_USERNAME/ET_FORWARDER_PASSWORD or config/et_forwarder.local.json.`);
  }
  return {username: out.username, password: out.password, origin: out.origin};
}

async function fetchCaptchaToFile(cdp, args, attempt) {
  const out = await cdp.eval(`(async()=>{` +
    `const sameOriginBase=(location&&/^https?:/.test(location.origin))?location.origin:${JSON.stringify(args.baseUrl)};` +
    `const r=await fetch(new URL('/Login/GetAuthCode?t='+Date.now()+${JSON.stringify(`-${attempt}`)},sameOriginBase).href,{credentials:'include'});` +
    `const buf=await r.arrayBuffer();` +
    `let s=''; const bytes=new Uint8Array(buf);` +
    `for(let i=0;i<bytes.length;i+=0x8000){s+=String.fromCharCode.apply(null,bytes.subarray(i,i+0x8000));}` +
    `return {status:r.status,base64:btoa(s)};` +
  `})()`);
  if (!out?.base64 || out.status !== 200) throw new Error(`ET captcha fetch failed status=${out?.status}`);
  const dir = path.join(ROOT, 'tmp', 'et-captcha');
  await fs.mkdir(dir, {recursive: true});
  const file = path.join(dir, `captcha-${Date.now()}-${attempt}.png`);
  await fs.writeFile(file, Buffer.from(out.base64, 'base64'));
  return file;
}

async function recognizeEtCaptcha(imagePath) {
  const out = await runPythonJson([
    path.join(ROOT, 'scripts', 'et_login_helper.py'),
    'ocr',
    '--image',
    imagePath,
  ]);
  if (!out?.ok || !out.text) throw new Error(`ET captcha OCR failed (${out?.error || 'empty result'}).`);
  return String(out.text).replace(/[^0-9A-Za-z]/g, '').slice(0, 5);
}

async function postEtLogin(cdp, args, credentials, vercode) {
  return cdp.eval(`(async()=>{` +
    `const body=new URLSearchParams();` +
    `body.set('username',${JSON.stringify(credentials.username)});` +
    `body.set('password',${JSON.stringify(credentials.password)});` +
    `body.set('vercode',${JSON.stringify(vercode)});` +
    `body.set('redirectLink','');` +
    `const sameOriginBase=(location&&/^https?:/.test(location.origin))?location.origin:${JSON.stringify(args.baseUrl)};` +
    `const r=await fetch(new URL('/Login/CheckCustomerLogin?t='+Math.random(),sameOriginBase).href,{method:'POST',credentials:'include',headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8','X-Requested-With':'XMLHttpRequest','Accept':'application/json, text/javascript, */*; q=0.01'},body});` +
    `const text=await r.text(); let json=null; try{json=JSON.parse(text)}catch(e){};` +
    `return {status:r.status,json,text:text.slice(0,300)};` +
  `})()`);
}

async function autoLoginEt(cdp, args) {
  if (!args.autoLogin) return false;
  const credentials = await readSavedEtCredentials(args);
  let lastMessage = '';
  for (let attempt = 1; attempt <= 5; attempt++) {
    let captchaFile = '';
    try {
      captchaFile = await fetchCaptchaToFile(cdp, args, attempt);
      const code = await recognizeEtCaptcha(captchaFile);
      if (code.length < 4) {
        lastMessage = `captcha OCR returned too short result: ${code}`;
        continue;
      }
      const result = await postEtLogin(cdp, args, credentials, code);
      const state = result?.json?.state;
      if (state === 'success') {
        await cdp.call('Page.navigate', {url: args.baseUrl + '/Home/Index'}).catch(() => {});
        await sleep(1600);
        const home = await probeEtHome(cdp, args);
        if (home.status === 200 && !home.login) {
          console.log(JSON.stringify({ok: true, step: 'et_auto_login', username: credentials.username, origin: credentials.origin}));
          return true;
        }
        lastMessage = `login accepted but home still not ready title=${home.title || ''}`;
      } else {
        lastMessage = result?.json?.message || result?.text || `status=${result?.status}`;
      }
    } catch (err) {
      lastMessage = `attempt ${attempt}: ${err?.message || err}`;
      console.error(`[fetch_et_forwarder] WARN captcha/login attempt failed: ${lastMessage}`);
      await cdp.call('Page.navigate', {url: args.baseUrl + '/Login/Index'}).catch(() => {});
      await sleep(1200);
    } finally {
      if (captchaFile) fs.unlink(captchaFile).catch(() => {});
    }
    await sleep(500);
  }
  throw new Error(`ET auto login failed after captcha attempts: ${lastMessage}`);
}

function withParams(pathname, params) {
  const qs = new URLSearchParams();
  qs.set('t', String(Math.random()));
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    qs.set(k, String(v));
  }
  return `${pathname}?${qs.toString()}`;
}

const ENDPOINTS = {
  goods: {
    kind: 'snapshot',
    idFields: ['GoodsId', 'Barcode'],
    list: ctx => withParams('/Goods/Goods/GetGridJson', {page: ctx.page, limit: ctx.limit, state: -1, keyword: '', modelNumber: '', titleCn: '', titleEn: '', className: ''}),
  },
  sku_specification: {
    kind: 'snapshot',
    idFields: ['SkuId', 'Barcode'],
    list: ctx => withParams('/Goods/SkuSpecification/GetGridJson', {page: ctx.page, limit: ctx.limit, barcode: '', status: -1}),
  },
  store_stock: {
    kind: 'snapshot',
    idFields: ['FId', 'SkuId', 'Barcode', 'StoreroomId'],
    list: ctx => withParams('/Goods/StockSearch/GetStoreStockGridJson', {page: ctx.page, limit: ctx.limit, storeroomId: '', skuCode: '', title: ''}),
  },
  box_stock: {
    kind: 'snapshot',
    idFields: ['FId', 'BoxId', 'SkuId', 'Barcode'],
    list: ctx => withParams('/Goods/StockSearch/GetBoxStockGridJson', {page: ctx.page, limit: ctx.limit, storeroomId: '', barcode: '', skuCode: '', siteId: '', title: ''}),
  },
  stock_running: {
    kind: 'rolling',
    idFields: ['FId'],
    list: ctx => withParams('/Goods/StockSearch/GetStockRunningGridJson', {page: ctx.page, limit: ctx.limit, sort: '', storeroom: '', barcode: '', fromId: '', start: ctx.rollingStart, end: ctx.date, title: ''}),
  },
  ship_order: {
    kind: 'ship',
    idFields: ['ShipOrderId'],
    list: ctx => withParams('/Delivery/ShipOrder/GetGridJson', {page: ctx.page, limit: ctx.limit, storeroomId: '', transportId: '', status: '', shipOrderId: '', startTime: ctx.shipStart, endTime: ctx.date, barcode: '', skuCode: '', sType: '', keyWords: '', doSort: '', boxId: '', overDifference: -1, cod: -1}),
    details: [
      {name: 'ship_order_item', idField: 'ShipOrderId', url: (id, ctx) => withParams('/Delivery/ShipOrder/GetShipOrderDetailForm', {page: 1, limit: ctx.detailLimit, shipOrderId: id})},
      {name: 'ship_order_box', idField: 'ShipOrderId', url: (id, ctx) => withParams('/Delivery/ShipOrder/GetBoxDetailForm', {page: 1, limit: ctx.detailLimit, shipOrderId: id})},
      {name: 'ship_order_track', idField: 'ShipOrderId', method: 'post', url: (id, ctx) => withParams('/Delivery/ShipOrder/GetTrackDetailForm', {}), body: (id, ctx) => ({shipOrderId: id})},
    ],
  },
  box_list: {
    kind: 'ship',
    idFields: ['BoxId'],
    list: ctx => withParams('/Delivery/BoxList/GetGridJson', {page: ctx.page, limit: ctx.limit, shipOrderId: ''}),
    details: [
      {name: 'box_item', idField: 'BoxId', url: (id, ctx) => withParams('/Delivery/BoxList/GetDetailsGridJson', {page: 1, limit: ctx.detailLimit, boxId: id})},
    ],
  },
  outbound: {
    kind: 'rolling_no_date_filter',
    idFields: ['OutboundId'],
    list: ctx => withParams('/Delivery/Outbound/GetGridJson', {page: ctx.page, limit: ctx.limit, outboundId: '', status: '', fromId: '', barcode: '', boxId: '', remark: ''}),
    inWindow: row => dateInWindow(row.OutboundTime || row.Createtime, row.__ctx.rollingStart, row.__ctx.date),
    details: [
      {name: 'outbound_item', idField: 'OutboundId', url: (id, ctx) => withParams('/Delivery/Outbound/GetOutboundDetailViewGridJson', {page: 1, limit: ctx.detailLimit, outboundId: id})},
      {name: 'outbound_form', idField: 'OutboundId', type: 'html', dailyMaxDetails: 0, url: id => withParams('/Delivery/Outbound/DetailForm', {oId: id}), parse: parseOutboundDetailForm},
    ],
  },
  return_order: {
    kind: 'rolling',
    idFields: ['ReturnOrderId'],
    list: ctx => withParams('/Delivery/ReturnOrder/GetGridJson', {page: ctx.page, limit: ctx.limit, returnOrderId: '', rtv: '', shipmentNumber: '', reserveTimeRange: `${ctx.rollingStart} - ${ctx.date}`, storeroomIdIn: '', storeroomIdOut: '', status: ''}),
    details: [
      {name: 'return_order_item', idField: 'ReturnOrderId', url: (id, ctx) => withParams('/Delivery/ReturnOrder/GetDetailGridJson', {page: 1, limit: ctx.detailLimit, id})},
    ],
  },
  allocate: {
    kind: 'rolling',
    idFields: ['AllocateId'],
    list: ctx => withParams('/Delivery/Allocate/GetGridJson', {page: ctx.page, limit: ctx.limit, outStoreroom: '', inStoreroom: '', transport: '', allocateId: '', asn: '', status: '', barcode: '', sType: '', startTime: ctx.rollingStart, endTime: ctx.date, amzStatus: '', boxId: '', isReservation: '', logisticsNo: '', fbaStorageNumber: ''}),
    details: [
      {name: 'allocate_item', idField: 'AllocateId', url: (id, ctx) => withParams('/Delivery/Allocate/GetDetailGridJson', {page: 1, limit: ctx.detailLimit, id})},
    ],
  },
  store_receipt: {
    kind: 'rolling',
    idFields: ['ReceiptId'],
    list: ctx => withParams('/Delivery/StoreReceipt/GetGridJson', {page: ctx.page, limit: ctx.limit, receiptId: '', boxId: '', barcode: '', createtimeRange: `${ctx.rollingStart} - ${ctx.date}`, fromId: '', storeroomId: '', sort: ''}),
  },
  change_pack: {
    kind: 'rolling_no_date_filter',
    idFields: ['ChangeId'],
    list: ctx => withParams('/Delivery/ChangePack/GetGridJson', {page: ctx.page, limit: ctx.limit}),
    inWindow: row => dateInWindow(row.CreateTime || row.Createtime, row.__ctx.rollingStart, row.__ctx.date),
  },
  box_damaged: {
    kind: 'rolling',
    idFields: ['DLNO'],
    list: ctx => withParams('/Delivery/BoxDamaged/GetGridJson', {page: ctx.page, limit: ctx.limit, boxId: '', shipOrderId: '', overseaId: '', storeroomId: '', status: -1, barcode: '', createtimeRange: `${ctx.rollingStart} - ${ctx.date}`}),
  },
  income_bill: {
    kind: 'finance',
    idFields: ['IncomeBillId'],
    // sort=2 is ET's storage-fee bill filter. Keep the generic finance fetch
    // unchanged, but make --storage-fee-only a server-side filter rather than
    // downloading every income-bill category and filtering it locally.
    list: ctx => withParams('/Finance/IncomeBill/GetGridJson', {page: ctx.page, limit: ctx.limit, sort: ctx.storageFeeOnly ? 2 : '', status: '', cityId: '', overseaId: '', incomeBillId: '', start: ctx.financeStart, end: ctx.date, paySort: '', payStartTime: '', payEndTime: '', payId: '', sourceType: ''}),
    details: [
      {name: 'income_bill_item', idField: 'IncomeBillId', url: (id, ctx) => withParams('/Finance/IncomeBill/GetDetailGridJson', {page: 1, limit: ctx.detailLimit, id})},
    ],
  },
  income_summary: {
    kind: 'finance',
    idFields: ['Sort', 'SortName', 'CountryId'],
    list: ctx => withParams('/Finance/IncomeBill/GetSummaryGridJson', {page: ctx.page, limit: ctx.limit, start: ctx.financeStart, end: ctx.date}),
  },
  income_payment: {
    kind: 'finance',
    idFields: ['FId', 'PayId'],
    list: ctx => withParams('/Finance/IncomeBillDetail/GetGridJson', {page: ctx.page, limit: ctx.limit, incomeBillId: '', payId: '', paySort: '', money: '', creStartTime: ctx.financeStart, creEndTime: ctx.date, status: -1}),
  },
  freight_rate: {
    kind: 'snapshot',
    idFields: ['TransportId', 'CountryId', 'SortId'],
    list: ctx => withParams('/Finance/FreightQuery/GetGridJson', {page: ctx.page, limit: ctx.limit, keyword: '', countryId: '', sortId: ''}),
  },
};

function rowIdentity(row, idFields = []) {
  const parts = idFields.map(f => row?.[f]).filter(v => v !== undefined && v !== null && String(v) !== '');
  if (!parts.length) return '';
  return parts.map(v => String(v).trim()).join('|');
}

async function readState(statePath) {
  try {
    return JSON.parse(await fs.readFile(statePath, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return {version: 1, endpoints: {}};
    throw err;
  }
}

async function writeState(statePath, state) {
  await fs.mkdir(path.dirname(statePath), {recursive: true});
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
}

function dateInWindow(value, start, end) {
  const s = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && s >= start && s <= end;
}

function rowsFromJson(json) {
  return Array.isArray(json?.data) ? json.data : [];
}

const SHIPPER_NAMES = {
  DSY: '杜圣宜',
  LGM: '刘广梅',
  SWK: '史文凯',
  LGH: '刘广洪',
  CJY: '陈嘉茵',
  GTH: '龚天浩',
  YH: '杨欢',
  WW: '吴薇',
  LF: '罗芳',
};

function normalizedBodyText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .trim();
}

function parseShipperFromText(value) {
  const text = normalizedBodyText(value);
  for (const [code, name] of Object.entries(SHIPPER_NAMES)) {
    if (text.includes(name)) return {code, name, match: name};
  }
  const pattern = new RegExp(`(^|[^A-Z0-9])(${Object.keys(SHIPPER_NAMES).join('|')})(?=$|[^A-Z0-9])`, 'i');
  const m = text.toUpperCase().match(pattern);
  if (!m) return {code: '', name: '', match: ''};
  const code = m[2].toUpperCase();
  return {code, name: SHIPPER_NAMES[code] || '', match: m[2]};
}

function extractReceiveText(value) {
  const text = normalizedBodyText(value);
  if (!text) return '';
  const lines = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const focused = lines.find(line => /(收货信息|收货人|收件|收货地址)/.test(line));
  if (focused) return focused.slice(0, 800);
  return text.slice(0, 800);
}

function parseOutboundDetailForm(id, out) {
  const text = normalizedBodyText(out?.text);
  const shipper = parseShipperFromText(text);
  return {
    __parent_id: id,
    OutboundId: id,
    DetailUrl: out?.url || '',
    DetailStatus: out?.status ?? '',
    DetailContentType: out?.contentType || '',
    ReceiveText: extractReceiveText(text),
    ShipperCode: shipper.code,
    ShipperName: shipper.name,
    ShipperMatch: shipper.match,
    DetailTextHead: text.slice(0, 1200),
  };
}

function parseCsvText(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  const s = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') {
      cell += ch;
    }
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const header = (rows.shift() || []).map(h => String(h || '').trim());
  if (!header.length) return [];
  return rows
    .filter(r => r.some(v => String(v || '').trim() !== ''))
    .map(r => Object.fromEntries(header.map((h, i) => [h || `col_${i + 1}`, r[i] ?? ''])));
}

function isStorageFeeBill(row) {
  const sortName = String(row?.SortName || row?.sort_name || '').trim();
  if (sortName === '仓储费') return true;
  const sort = Number(row?.Sort);
  return Number.isFinite(sort) && sort >= 2 && sort <= 9 && /仓储/.test(sortName);
}

async function browserFetchStorageFeeCsv(cdp, args, incomeBillId) {
  const expression = `(${async function downloadStorageFeeCsv(id, baseUrl) {
    const sameOriginBase = (location && /^https?:/.test(location.origin)) ? location.origin : baseUrl;
    const body = new URLSearchParams();
    body.set('incomeBillId', id);
    const post = await fetch(new URL('/Finance/IncomeBill/ExportStoreFee?t=' + Math.random(), sameOriginBase).href, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
      },
      body,
    });
    const postText = await post.text();
    let postJson = null;
    try { postJson = JSON.parse(postText); } catch {}
    if (!postJson || postJson.state !== 'success' || !postJson.message) {
      return {ok: false, postStatus: post.status, postText: postText.slice(0, 800), postJson};
    }
    const fileUrl = new URL(postJson.message, sameOriginBase).href;
    const file = await fetch(fileUrl + (fileUrl.includes('?') ? '&' : '?') + 't=' + Math.random(), {
      credentials: 'include',
      headers: {'X-Requested-With': 'XMLHttpRequest'},
    });
    const buf = await file.arrayBuffer();
    let text = '';
    let encoding = 'gb18030';
    try {
      text = new TextDecoder('gb18030').decode(buf);
    } catch {
      encoding = 'utf-8';
      text = new TextDecoder('utf-8').decode(buf);
    }
    return {
      ok: file.ok,
      postStatus: post.status,
      postJson,
      fileStatus: file.status,
      fileUrl: file.url,
      contentType: file.headers.get('content-type') || '',
      contentDisposition: file.headers.get('content-disposition') || '',
      byteLength: buf.byteLength,
      encoding,
      text,
    };
  }})(${JSON.stringify(incomeBillId)}, ${JSON.stringify(args.baseUrl)})`;
  const out = await cdp.eval(expression);
  if (!out?.ok || typeof out.text !== 'string') {
    throw new Error(`ExportStoreFee failed for ${incomeBillId}: ${JSON.stringify(out).slice(0, 1200)}`);
  }
  return out;
}

async function fetchStorageFeeDetails(cdp, args, listRows) {
  const rows = [];
  const errors = [];
  if (args.skipDetails) return {rows, errors, totalParents: 0, parentCount: 0, detailOffset: 0, detailLimit: 0, skippedBefore: 0, skippedAfter: 0, skippedParents: 0};
  const ids = [];
  const parentById = new Map();
  for (const row of listRows.filter(isStorageFeeBill)) {
    const id = row?.IncomeBillId;
    if (!id || parentById.has(id)) continue;
    parentById.set(id, row);
    ids.push(id);
  }
  const start = args.detailOffset || 0;
  const end = args.maxDetails ? start + args.maxDetails : undefined;
  const limited = ids.slice(start, end);
  for (const id of limited) {
    const parent = parentById.get(id) || {};
    try {
      const file = await browserFetchStorageFeeCsv(cdp, args, id);
      const parsed = parseCsvText(file.text);
      rows.push(...parsed.map((r, i) => ({
        ...r,
        __parent_id: id,
        __source_row_no: i + 2,
        __download_url: file.fileUrl || '',
        __download_content_type: file.contentType || '',
        __download_content_disposition: file.contentDisposition || '',
        __download_byte_length: file.byteLength || 0,
        __download_encoding: file.encoding || '',
        __bill_sort_name: parent.SortName || '',
        __bill_ship_time: parent.ShipTime || '',
        __bill_create_time: parent.Createtime || '',
        __bill_other_income: parent.OtherIncome ?? '',
      })));
    } catch (err) {
      const message = err?.message || String(err);
      errors.push({incomeBillId: id, message});
      console.error(`[fetch_et_forwarder] WARN storage fee detail download failed incomeBillId=${id}: ${message}`);
    }
    await sleep(args.waitMs);
  }
  return {
    rows,
    errors,
    totalParents: ids.length,
    parentCount: limited.length,
    detailOffset: start,
    detailLimit: args.detailAll ? 0 : (args.maxDetails || 0),
    skippedBefore: Math.min(start, ids.length),
    skippedAfter: Math.max(0, ids.length - start - limited.length),
    skippedParents: Math.max(0, ids.length - limited.length),
  };
}

async function fetchPaged(cdp, args, endpointKey, def, ctx) {
  const allRows = [];
  const pages = [];
  let count = null;
  let overlapCount = 0;
  let stoppedByOverlap = false;
  let stoppedByDailyInitialCap = false;
  const previousIds = new Set(ctx.previousEndpointIds?.[endpointKey] || []);
  const canUseOverlapStop = args.mode === 'daily'
    && !['snapshot'].includes(def.kind)
    && previousIds.size > 0
    && def.idFields?.length;
  const canUseInitialCap = args.mode === 'daily'
    && !['snapshot'].includes(def.kind)
    && previousIds.size === 0
    && args.dailyInitialPages > 0;
  for (let page = 1; ; page++) {
    if (args.maxPages && page > args.maxPages) break;
    const pageCtx = {...ctx, page};
    const url = def.list(pageCtx);
    const json = await browserFetchJson(cdp, args, url);
    const rows = rowsFromJson(json);
    if (count === null) count = Number(json.count ?? rows.length);
    const pageOverlapCount = canUseOverlapStop
      ? rows.filter(r => previousIds.has(rowIdentity(r, def.idFields))).length
      : 0;
    overlapCount += pageOverlapCount;
    pages.push({page, url, count: json.count ?? null, rows: rows.length, msg: json.msg ?? ''});
    allRows.push(...rows.map(r => ({...r, __ctx: pageCtx})));
    if (!rows.length) break;
    if (rows.length < ctx.limit) break;
    if (count !== null && allRows.length >= count) break;
    if (canUseOverlapStop && page >= args.minPages && overlapCount >= args.overlapRows) {
      stoppedByOverlap = true;
      break;
    }
    if (canUseInitialCap && page >= args.dailyInitialPages) {
      stoppedByDailyInitialCap = true;
      break;
    }
    await sleep(args.waitMs);
  }
  const filteredRows = def.inWindow && args.mode === 'daily' ? allRows.filter(def.inWindow) : allRows;
  return {
    rows: filteredRows.map(({__ctx, ...r}) => r),
    rawRowCount: allRows.length,
    count,
    pages,
    overlapCount,
    stoppedByOverlap,
    stoppedByDailyInitialCap,
  };
}

async function fetchDetails(cdp, args, def, listRows, ctx) {
  const detailResults = {};
  if (args.skipDetails) return detailResults;
  const details = (def.details || []).filter(d => !args.detailNameList?.length || args.detailNameList.includes(d.name));
  for (const d of details) {
    const rows = [];
    const ids = [...new Set(listRows.map(r => r?.[d.idField]).filter(Boolean))];
    const start = args.detailOffset || 0;
    const effectiveMaxDetails = args.mode === 'daily' && Object.hasOwn(d, 'dailyMaxDetails')
      ? Math.max(0, Number(d.dailyMaxDetails) || 0)
      : args.maxDetails;
    const end = (args.detailAll || effectiveMaxDetails === 0) ? undefined : start + effectiveMaxDetails;
    const limited = ids.slice(start, end);
    let cursor = 0;
    async function worker() {
      for (;;) {
        const current = cursor++;
        if (current >= limited.length) return;
        const id = limited[current];
        if (d.type === 'html') {
          const out = await browserFetchText(cdp, args, d.url(id, ctx));
          rows.push(d.parse ? d.parse(id, out, ctx) : {...out, __parent_id: id});
        } else if (d.method === 'post') {
          const json = await browserPostJson(cdp, args, d.url(id, ctx), d.body ? d.body(id, ctx) : {});
          const base = json?.data && typeof json.data === 'object' ? json.data : {raw: json};
          rows.push({...base, __parent_id: id, __state: json?.state || '', __message: json?.message || ''});
        } else {
          const json = await browserFetchJson(cdp, args, d.url(id, ctx));
          rows.push(...rowsFromJson(json).map(r => ({...r, __parent_id: id})));
        }
        await sleep(args.waitMs);
      }
    }
    const workers = Array.from(
      {length: Math.min(args.detailConcurrency, limited.length || 1)},
      () => worker(),
    );
    await Promise.all(workers);
    detailResults[d.name] = {
      rows,
      totalParents: ids.length,
      parentCount: limited.length,
      detailOffset: start,
      detailLimit: (args.detailAll || effectiveMaxDetails === 0) ? 0 : effectiveMaxDetails,
      skippedBefore: Math.min(start, ids.length),
      skippedAfter: Math.max(0, ids.length - start - limited.length),
      skippedParents: Math.max(0, ids.length - limited.length),
    };
  }
  return detailResults;
}

export function buildContext(args) {
  const backfillStart = args.startDate || '2020-01-01';
  const shipStart = args.mode === 'backfill' ? backfillStart : addDays(args.date, -args.shipLookbackDays);
  return {
    date: args.date,
    rollingStart: args.mode === 'backfill' ? backfillStart : addDays(args.date, -2),
    shipStart,
    financeStart: args.mode === 'backfill' ? backfillStart : firstDayOfPrevMonth(args.date),
    currentMonthStart: firstDayOfMonth(args.date),
    limit: args.limit,
    detailLimit: Math.max(500, args.limit),
    storageFeeOnly: args.storageFeeOnly,
  };
}

function endpointKeysForMode(args) {
  const financeKeys = new Set(['income_bill', 'income_summary', 'income_payment', 'freight_rate']);
  const all = Object.keys(ENDPOINTS);
  let keys = args.mode === 'smoke'
    ? ['goods', 'sku_specification', 'store_stock', 'box_stock', 'stock_running', 'ship_order', 'outbound', 'return_order', 'box_damaged']
    : all.filter(k => args.includeFinance || !financeKeys.has(k));
  if (args.storageFeeOnly) keys = ['income_bill'];
  if (args.endpointList?.length) {
    const unknown = args.endpointList.filter(k => !ENDPOINTS[k]);
    if (unknown.length) throw new Error(`Unknown ET endpoints: ${unknown.join(', ')}`);
    keys = keys.filter(k => args.endpointList.includes(k));
  }
  return keys;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const state = await readState(args.statePath);
  if (!(await isCdpReady(args.port))) {
    if (!args.launch) throw new Error(`ET Chrome CDP is not ready on port ${args.port}.`);
    await launchChrome(args);
  }
  const page = await getEtPage(args);
  const cdp = new CdpClient(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.call('Page.enable').catch(() => {});
  if (!page.url?.startsWith(args.baseUrl)) {
    await cdp.call('Page.navigate', {url: args.baseUrl + '/Home/Index'});
    await sleep(1800);
  }
  let home = await probeEtHome(cdp, args);
  if (home.status !== 200 || home.login) {
    await autoLoginEt(cdp, args);
    home = await probeEtHome(cdp, args);
    if (home.status !== 200 || home.login) {
      cdp.close();
      throw new Error(`ET login state is not ready. status=${home.status} title=${home.title}`);
    }
  }

  const batchId = `et-${args.mode}-${args.date}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const batchDir = path.join(args.outDir, args.date, batchId);
  await fs.mkdir(batchDir, {recursive: true});
  const ctx = {
    ...buildContext(args),
    previousEndpointIds: Object.fromEntries(Object.entries(state.endpoints || {}).map(([key, value]) => [key, value.recentIds || []])),
  };
  const manifest = {
    batchId,
    mode: args.mode,
    targetDate: args.date,
    createdAt: new Date().toISOString(),
    baseUrl: args.baseUrl,
    profileDir: path.relative(ROOT, args.profileDir).replace(/\\/g, '/'),
    detailOptions: {
      skipDetails: args.skipDetails,
      detailOffset: args.detailOffset,
      maxDetails: args.maxDetails,
      detailAll: args.detailAll,
      includeFinance: args.includeFinance,
      storageFeeOnly: args.storageFeeOnly,
      detailConcurrency: args.detailConcurrency,
      detailNames: args.detailNameList,
    },
    windows: {
      rollingStart: ctx.rollingStart,
      shipStart: ctx.shipStart,
      financeStart: ctx.financeStart,
      date: ctx.date,
    },
    endpoints: {},
    files: {},
    ok: false,
  };
  try {
    for (const key of endpointKeysForMode(args)) {
      const def = ENDPOINTS[key];
      const result = await fetchPaged(cdp, args, key, def, ctx);
      const file = `${safeName(key)}.json`;
      await fs.writeFile(path.join(batchDir, file), JSON.stringify({
        endpoint: key,
        fetchedAt: new Date().toISOString(),
        count: result.count,
        rawRowCount: result.rawRowCount,
        rows: result.rows,
        pages: result.pages,
      }, null, 2), 'utf8');
      manifest.endpoints[key] = {
        kind: def.kind,
        count: result.count,
        rawRowCount: result.rawRowCount,
        rowCount: result.rows.length,
        pages: result.pages.length,
        overlapCount: result.overlapCount,
        stoppedByOverlap: result.stoppedByOverlap,
        stoppedByDailyInitialCap: result.stoppedByDailyInitialCap,
      };
      manifest.files[key] = file;

      if (def.details?.length && result.rows.length) {
        const detailMap = await fetchDetails(cdp, args, def, result.rows, ctx);
        for (const [detailKey, detailResult] of Object.entries(detailMap)) {
          const detailFile = `${safeName(detailKey)}.json`;
          await fs.writeFile(path.join(batchDir, detailFile), JSON.stringify({
            endpoint: detailKey,
            parentEndpoint: key,
            fetchedAt: new Date().toISOString(),
            totalParents: detailResult.totalParents,
            parentCount: detailResult.parentCount,
            detailOffset: detailResult.detailOffset,
            detailLimit: detailResult.detailLimit,
            skippedBefore: detailResult.skippedBefore,
            skippedAfter: detailResult.skippedAfter,
            skippedParents: detailResult.skippedParents,
            rows: detailResult.rows,
          }, null, 2), 'utf8');
          manifest.endpoints[detailKey] = {
            kind: 'detail',
            parent: key,
            rowCount: detailResult.rows.length,
            totalParents: detailResult.totalParents,
            parentCount: detailResult.parentCount,
            detailOffset: detailResult.detailOffset,
            detailLimit: detailResult.detailLimit,
            skippedBefore: detailResult.skippedBefore,
            skippedAfter: detailResult.skippedAfter,
            skippedParents: detailResult.skippedParents,
          };
          manifest.files[detailKey] = detailFile;
        }
      }
      if (key === 'income_bill' && result.rows.length && !args.skipDetails) {
        const detailResult = await fetchStorageFeeDetails(cdp, args, result.rows);
        const detailKey = 'storage_fee_product_detail';
        const detailFile = `${safeName(detailKey)}.json`;
        await fs.writeFile(path.join(batchDir, detailFile), JSON.stringify({
          endpoint: detailKey,
          parentEndpoint: key,
          fetchedAt: new Date().toISOString(),
          totalParents: detailResult.totalParents,
          parentCount: detailResult.parentCount,
          detailOffset: detailResult.detailOffset,
          detailLimit: detailResult.detailLimit,
          skippedBefore: detailResult.skippedBefore,
          skippedAfter: detailResult.skippedAfter,
          skippedParents: detailResult.skippedParents,
          errors: detailResult.errors,
          rows: detailResult.rows,
        }, null, 2), 'utf8');
        manifest.endpoints[detailKey] = {
          kind: 'detail_export',
          parent: key,
          rowCount: detailResult.rows.length,
          totalParents: detailResult.totalParents,
          parentCount: detailResult.parentCount,
          detailOffset: detailResult.detailOffset,
          detailLimit: detailResult.detailLimit,
          skippedBefore: detailResult.skippedBefore,
          skippedAfter: detailResult.skippedAfter,
          skippedParents: detailResult.skippedParents,
          errorCount: detailResult.errors.length,
        };
        manifest.files[detailKey] = detailFile;
      }
      await sleep(args.waitMs);
    }
    manifest.ok = true;
  } finally {
    cdp.close();
  }
  const manifestPath = path.join(batchDir, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  await fs.writeFile(path.join(args.outDir, 'latest-manifest.json'), JSON.stringify({...manifest, manifestPath: path.relative(ROOT, manifestPath).replace(/\\/g, '/')}, null, 2), 'utf8');
  if (args.updateState && manifest.ok && !args.dryRun) {
    const nextState = {
      ...state,
      version: 1,
      updatedAt: new Date().toISOString(),
      lastBatchId: batchId,
      endpoints: {...(state.endpoints || {})},
    };
    for (const [key, file] of Object.entries(manifest.files)) {
      if (!ENDPOINTS[key]) continue;
      const def = ENDPOINTS[key];
      const data = JSON.parse(await fs.readFile(path.join(batchDir, file), 'utf8'));
      const ids = [];
      const seen = new Set();
      for (const row of data.rows || []) {
        const id = rowIdentity(row, def.idFields);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
        if (ids.length >= 500) break;
      }
      nextState.endpoints[key] = {
        ...(nextState.endpoints[key] || {}),
        recentIds: ids,
        lastBatchId: batchId,
        lastFetchedAt: data.fetchedAt,
        lastRowCount: data.rows?.length || 0,
      };
    }
    await writeState(args.statePath, nextState);
  }
  console.log(JSON.stringify({
    ok: manifest.ok,
    batchId,
    manifestPath,
    rowCounts: Object.fromEntries(Object.entries(manifest.endpoints).map(([k, v]) => [k, v.rowCount])),
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(err?.stack || String(err));
    process.exit(1);
  });
}
