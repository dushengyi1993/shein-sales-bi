#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  buildAuthorizationUrl,
  SheinOpenApiClient,
  SHEIN_OPENAPI_BASE_URLS,
} from '../lib/shein_openapi_client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG = path.join(ROOT, 'config', 'shein_openapi.local.json');
const DEFAULT_REDIRECT_URL = 'https://open.sheincorp.com/backstage/home';

function parseArgs(argv) {
  const args = {
    config: DEFAULT_CONFIG,
    store: 'HL',
    port: 9360,
    timeoutSec: 600,
    redirectUrl: DEFAULT_REDIRECT_URL,
    open: true,
    tempToken: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') args.config = path.resolve(argv[++i]);
    else if (a === '--store') args.store = argv[++i];
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--timeout-sec') args.timeoutSec = Number(argv[++i]);
    else if (a === '--redirect-url') args.redirectUrl = argv[++i];
    else if (a === '--temp-token') args.tempToken = argv[++i];
    else if (a === '--no-open') args.open = false;
    else if (a === '--help' || a === '-h') {
      console.log(`Usage:
  node scripts/shein_openapi_authorize_hl.mjs [--store HL] [--port 9360]

Options:
  --config <path>        本机 OpenAPI 配置文件，默认 config/shein_openapi.local.json
  --store <storeKey>     店铺代号，默认 HL
  --port <cdpPort>       HL Chrome CDP 端口，默认 9360
  --timeout-sec <n>      等待授权跳转的秒数，默认 600
  --redirect-url <url>   授权完成后的跳转地址，默认 SHEIN 开放平台首页
  --temp-token <token>   已手工取得 tempToken 时直接换正式密钥
  --no-open              只打印授权链接，不自动打开浏览器标签页`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

function mask(value) {
  if (!value) return '';
  const s = String(value);
  if (s.length <= 10) return '***';
  return `${s.slice(0, 4)}***${s.slice(-4)}`;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, {encoding: 'utf8', mode: 0o600});
}

function randomState(storeKey) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `SHEIN-${storeKey}-${stamp}-${crypto.randomBytes(4).toString('hex')}`;
}

function extractQueryParam(urlText, name) {
  try {
    const url = new URL(urlText);
    if (url.searchParams.has(name)) return url.searchParams.get(name);
    const hash = url.hash || '';
    const hashQuery = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : hash.replace(/^#\/?/, '');
    if (hashQuery) {
      const params = new URLSearchParams(hashQuery);
      if (params.has(name)) return params.get(name);
    }
  } catch {
    // Ignore invalid browser-internal URLs.
  }
  return null;
}

async function openUrlViaCdp(port, url) {
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
  const wsUrl = version.webSocketDebuggerUrl;
  if (!wsUrl) throw new Error(`CDP browser websocket not found on port ${port}`);
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const {resolve, reject} = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, {once: true});
    ws.addEventListener('error', reject, {once: true});
  });
  function send(method, params = {}) {
    const id = ++seq;
    ws.send(JSON.stringify({id, method, params}));
    return new Promise((resolve, reject) => pending.set(id, {resolve, reject}));
  }
  const result = await send('Target.createTarget', {url, newWindow: false});
  ws.close();
  return result?.targetId;
}

async function listTabs(port) {
  return fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
}

async function waitForTempToken({port, expectedState, timeoutSec}) {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const tabs = await listTabs(port);
    for (const tab of tabs) {
      const url = tab.url || '';
      const tempToken = extractQueryParam(url, 'tempToken') || extractQueryParam(url, 'temp_token');
      if (!tempToken) continue;
      const state = extractQueryParam(url, 'state');
      if (expectedState && state && state !== expectedState) continue;
      return {tempToken, state, url};
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`等待授权跳转超时：${timeoutSec} 秒内没有在 Chrome 标签页中发现 tempToken`);
}

function upsertStore(config, storeKey, patch) {
  if (!Array.isArray(config.stores)) config.stores = [];
  let store = config.stores.find((s) => String(s.storeKey).toUpperCase() === String(storeKey).toUpperCase());
  if (!store) {
    store = {storeKey, enabled: true};
    config.stores.push(store);
  }
  Object.assign(store, patch);
  return store;
}

const args = parseArgs(process.argv.slice(2));
const config = await readJson(args.config);
const appId = config?.app?.appId;
const appSecretKey = config?.app?.appSecretKey;
if (!appId || !appSecretKey || /填写|不要提交/.test(`${appId}${appSecretKey}`)) {
  throw new Error(`请先在 ${path.relative(ROOT, args.config)} 写入真实 app.appId 和 app.appSecretKey`);
}

const state = randomState(args.store);
let tempToken = args.tempToken;
if (!tempToken) {
  try {
    const existing = await waitForTempToken({port: args.port, expectedState: null, timeoutSec: 2});
    tempToken = existing.tempToken;
    console.log(JSON.stringify({
      step: 'existing-temp-token-captured',
      storeKey: args.store,
      state: existing.state || null,
      tempToken: mask(tempToken),
    }, null, 2));
  } catch {
    // No existing tempToken tab; continue by opening a fresh authorization page.
  }
}

if (!tempToken) {
  const authUrl = buildAuthorizationUrl({
    env: 'prod',
    appId,
    redirectUrl: args.redirectUrl,
    state,
  });
  if (args.open) {
    const targetId = await openUrlViaCdp(args.port, authUrl);
    console.log(JSON.stringify({
      step: 'authorization-page-opened',
      cdpPort: args.port,
      targetId,
      storeKey: args.store,
      appId: mask(appId),
      note: '请在打开的 SHEIN 授权页完成授权；脚本会自动等待回跳并换取店铺密钥。',
    }, null, 2));
  } else {
    console.log(JSON.stringify({
      step: 'authorization-url-ready',
      storeKey: args.store,
      appId: mask(appId),
      url: authUrl,
    }, null, 2));
  }
  const captured = await waitForTempToken({port: args.port, expectedState: state, timeoutSec: args.timeoutSec});
  tempToken = captured.tempToken;
  console.log(JSON.stringify({
    step: 'temp-token-captured',
    storeKey: args.store,
    state: captured.state || null,
    tempToken: mask(tempToken),
  }, null, 2));
}

const client = new SheinOpenApiClient({baseUrl: SHEIN_OPENAPI_BASE_URLS.prodSemiManaged});
const exchanged = await client.getByToken({
  appId,
  appSecretKey,
  tempToken,
  baseUrl: SHEIN_OPENAPI_BASE_URLS.prodSemiManaged,
});

const body = exchanged.data;
if (!exchanged.ok || String(body?.code) !== '0' || !body?.info?.openKeyId || !body?.info?.secretKey) {
  console.log(JSON.stringify({
    step: 'exchange-failed',
    httpStatus: exchanged.status,
    code: body?.code ?? null,
    msg: body?.msg ?? null,
    traceId: body?.traceId ?? null,
  }, null, 2));
  process.exit(2);
}

config.environment = 'prod';
config.cooperationMode = config.cooperationMode || '半托管';
config.market = config.market || 'SA';
config.apiBaseUrls = config.apiBaseUrls || {};
config.apiBaseUrls.prodSemiManaged = SHEIN_OPENAPI_BASE_URLS.prodSemiManaged;
const savedStore = upsertStore(config, args.store, {
  storeKey: args.store,
  profileKey: args.store === 'HL' ? 'shein-main' : undefined,
  enabled: true,
  openKeyId: body.info.openKeyId,
  secretKey: body.info.secretKey,
  encryptedSecretKey: body.info.encryptedSecretKey || null,
  authorizedAt: new Date().toISOString(),
  authorizationState: state,
  notes: 'SHEIN 半托管生产环境授权；真实密钥仅保存在本机忽略配置。',
});

await writeJson(args.config, config);
console.log(JSON.stringify({
  ok: true,
  savedTo: path.relative(ROOT, args.config).replace(/\\/g, '/'),
  storeKey: savedStore.storeKey,
  openKeyId: mask(savedStore.openKeyId),
  authorizedAt: savedStore.authorizedAt,
}, null, 2));
