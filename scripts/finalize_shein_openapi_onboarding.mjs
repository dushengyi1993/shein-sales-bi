#!/usr/bin/env node
/**
 * Finish pending SHEIN OpenAPI authorizations after a human completes the
 * seller-center login/authorization in Chrome.
 *
 * This script only handles the OpenAPI authorization callback lifecycle:
 *   1. scan the configured Chrome debugging ports for tempToken callbacks;
 *   2. exchange tempToken for store-level OpenAPI credentials;
 *   3. write the private local config;
 *   4. optionally copy the private config to the cloud server and refresh the
 *      read-only probe ledger.
 *
 * It deliberately does not execute any SHEIN business write action.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {
  SheinOpenApiClient,
  SHEIN_OPENAPI_BASE_URLS,
} from '../lib/shein_openapi_client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG = path.join(ROOT, 'config', 'shein_openapi.local.json');
const DEFAULT_STORES = [
  {storeKey: 'JSH', port: 9349},
  {storeKey: 'TZ', port: 9348},
  {storeKey: 'ZL', port: 9340},
];
const DEFAULT_CLOUD = 'shein-bi-tencent';
const DEFAULT_CLOUD_APP_DIR = '/opt/shein-bi/app';
const DEFAULT_REDIRECT_URL = 'https://open.sheincorp.com/backstage/home';

function parseArgs(argv) {
  const args = {
    config: DEFAULT_CONFIG,
    stores: DEFAULT_STORES,
    syncCloud: true,
    cloudHost: DEFAULT_CLOUD,
    cloudAppDir: DEFAULT_CLOUD_APP_DIR,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--config') args.config = path.resolve(argv[++i]);
    else if (a === '--stores') args.stores = parseStores(argv[++i]);
    else if (a === '--store') args.stores = [parseStore(argv[++i])];
    else if (a === '--cloud-host') args.cloudHost = argv[++i];
    else if (a === '--cloud-app-dir') args.cloudAppDir = argv[++i];
    else if (a === '--no-cloud-sync') args.syncCloud = false;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') {
      console.log(`Usage:
  node scripts/finalize_shein_openapi_onboarding.mjs
  node scripts/finalize_shein_openapi_onboarding.mjs --stores JSH:9349,TZ:9348,ZL:9340

Options:
  --store <KEY[:PORT]>       Finish one store. Defaults ports: JSH=9349,TZ=9348,ZL=9340.
  --stores <KEY[:PORT],...>  Finish multiple stores.
  --no-cloud-sync            Only update local private config; do not copy to cloud.
  --dry-run                  Report callbacks and intended changes without saving.

The script only exchanges OpenAPI authorization tempToken callbacks and refreshes
read-only probes. It does not execute any SHEIN business write action.`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

function parseStores(text) {
  return String(text || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map(parseStore);
}

function parseStore(text) {
  const [rawKey, rawPort] = String(text || '').split(':');
  const storeKey = String(rawKey || '').trim().toUpperCase();
  if (!storeKey) throw new Error(`Invalid store spec: ${text}`);
  const known = DEFAULT_STORES.find((x) => x.storeKey === storeKey);
  const port = Number(rawPort || known?.port || 0);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Missing CDP port for store ${storeKey}; use ${storeKey}:<port>`);
  }
  return {storeKey, port};
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

function extractQueryParam(urlText, name) {
  const visited = new Set();
  const extractFrom = (text) => {
    if (!text || visited.has(text)) return null;
    visited.add(text);
    let url;
    try {
      url = new URL(text);
    } catch {
      try {
        url = new URL(text, DEFAULT_REDIRECT_URL);
      } catch {
        return null;
      }
    }
    if (url.searchParams.has(name)) return url.searchParams.get(name);
    const hash = url.hash || '';
    const hashQuery = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : hash.replace(/^#\/?/, '');
    if (hashQuery) {
      const params = new URLSearchParams(hashQuery);
      if (params.has(name)) return params.get(name);
    }
    const wrapped = url.searchParams.get('r');
    if (wrapped) {
      try {
        const decoded = Buffer.from(wrapped, 'base64').toString('utf8');
        const nested = extractFrom(decoded);
        if (nested) return nested;
      } catch {
        // Ignore malformed wrappers.
      }
    }
    return null;
  };
  return extractFrom(urlText);
}

async function listTabs(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`CDP ${port} returned HTTP ${response.status}`);
  return response.json();
}

async function findCallback(port, storeKey) {
  const tabs = await listTabs(port);
  const callbacks = [];
  for (const tab of tabs) {
    const url = tab.url || '';
    const tempToken = extractQueryParam(url, 'tempToken') || extractQueryParam(url, 'temp_token');
    if (!tempToken) continue;
    const state = extractQueryParam(url, 'state') || '';
    const stateStore = /^SHEIN-([A-Z0-9]+)-/.exec(state)?.[1] || '';
    if (stateStore && stateStore !== storeKey) continue;
    callbacks.push({tempToken, state, url, title: tab.title || '', targetId: tab.id || ''});
  }
  callbacks.sort((a, b) => String(b.state).localeCompare(String(a.state)));
  return callbacks[0] || null;
}

function resolveStoreAppCredentials(config, storeKey) {
  const key = String(storeKey || '').trim().toUpperCase();
  const store = Array.isArray(config.stores)
    ? config.stores.find((s) => String(s?.storeKey || '').trim().toUpperCase() === key)
    : null;
  const candidates = [
    {
      scope: 'store.app',
      appId: store?.app?.appId,
      appSecretKey: store?.app?.appSecretKey,
    },
    {
      scope: 'store',
      appId: store?.appId,
      appSecretKey: store?.appSecretKey,
    },
    store?.appKey && config?.apps?.[store.appKey] ? {
      scope: `apps.${store.appKey}`,
      appId: config.apps[store.appKey]?.appId,
      appSecretKey: config.apps[store.appKey]?.appSecretKey,
      appKey: store.appKey,
    } : null,
    config?.apps?.[key] ? {
      scope: `apps.${key}`,
      appId: config.apps[key]?.appId,
      appSecretKey: config.apps[key]?.appSecretKey,
      appKey: key,
    } : null,
    {
      scope: 'global',
      appId: config?.app?.appId,
      appSecretKey: config?.app?.appSecretKey,
    },
  ].filter(Boolean);
  const found = candidates.find((item) => {
    const appId = String(item.appId || '').trim();
    const appSecretKey = String(item.appSecretKey || '').trim();
    return appId && appSecretKey && !/填写|不要提交/.test(`${appId}${appSecretKey}`);
  });
  if (!found) return {scope: 'missing', appId: '', appSecretKey: '', appKey: ''};
  return {
    scope: found.scope,
    appId: String(found.appId || '').trim(),
    appSecretKey: String(found.appSecretKey || '').trim(),
    appKey: found.appKey || '',
  };
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

async function exchangeStore({config, storeKey, callback, dryRun}) {
  const appCreds = resolveStoreAppCredentials(config, storeKey);
  if (!appCreds.appId || !appCreds.appSecretKey) {
    return {storeKey, status: 'missing_app_credentials'};
  }
  if (dryRun) {
    return {
      storeKey,
      status: 'callback_found_dry_run',
      state: callback.state || null,
      appCredentialScope: appCreds.scope,
    };
  }
  const client = new SheinOpenApiClient({baseUrl: SHEIN_OPENAPI_BASE_URLS.prodSemiManaged});
  const exchanged = await client.getByToken({
    appId: appCreds.appId,
    appSecretKey: appCreds.appSecretKey,
    tempToken: callback.tempToken,
    baseUrl: SHEIN_OPENAPI_BASE_URLS.prodSemiManaged,
  });
  const body = exchanged.data;
  if (!exchanged.ok || String(body?.code) !== '0' || !body?.info?.openKeyId || !body?.info?.secretKey) {
    return {
      storeKey,
      status: 'exchange_failed',
      httpStatus: exchanged.status,
      code: body?.code ?? null,
      msg: body?.msg ?? null,
      traceId: body?.traceId ?? null,
    };
  }

  config.environment = 'prod';
  config.cooperationMode = config.cooperationMode || '半托管';
  config.market = config.market || 'SA';
  config.apiBaseUrls = config.apiBaseUrls || {};
  config.apiBaseUrls.prodSemiManaged = SHEIN_OPENAPI_BASE_URLS.prodSemiManaged;
  const saved = upsertStore(config, storeKey, {
    storeKey,
    enabled: true,
    appKey: appCreds.appKey || undefined,
    openKeyId: body.info.openKeyId,
    secretKey: body.info.secretKey,
    encryptedSecretKey: body.info.encryptedSecretKey || null,
    authorizedAt: new Date().toISOString(),
    authorizationState: callback.state || null,
    notes: 'SHEIN 半托管生产环境授权；真实密钥仅保存在本机忽略配置。',
  });
  return {
    storeKey,
    status: 'authorized',
    state: callback.state || null,
    appCredentialScope: appCreds.scope,
    openKeyId: mask(saved.openKeyId),
    authorizedAt: saved.authorizedAt,
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
  return {
    command,
    args,
    status: result.status,
    ok: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function summarizeProbeJson(text) {
  try {
    const parsed = JSON.parse(text);
    return {
      ok: Boolean(parsed.ok),
      counts: parsed.counts || null,
      storesOk: Array.isArray(parsed.results)
        ? parsed.results.filter((r) => r.ok).map((r) => r.storeKey)
        : [],
      failed: Array.isArray(parsed.results)
        ? parsed.results.filter((r) => r.status === 'read_probe_failed').map((r) => ({
          storeKey: r.storeKey,
          stderrTail: r.stderrTail || '',
          summary: r.summary || [],
        }))
        : [],
    };
  } catch {
    return {ok: false, parseError: true, tail: String(text || '').slice(-1200)};
  }
}

async function syncCloudAndProbe(args) {
  const localConfig = args.config;
  const remoteConfig = `${args.cloudHost}:${args.cloudAppDir}/config/shein_openapi.local.json`;
  const copy = run('scp', [localConfig, remoteConfig]);
  if (!copy.ok) return {sync: copy};
  const chmod = run('ssh', [
    args.cloudHost,
    `sudo chown sheinops:sheinops ${shellQuote(`${args.cloudAppDir}/config/shein_openapi.local.json`)} && sudo chmod 600 ${shellQuote(`${args.cloudAppDir}/config/shein_openapi.local.json`)}`,
  ]);
  const probe = run('ssh', [
    args.cloudHost,
    `cd ${shellQuote(args.cloudAppDir)} && node scripts/probe_shein_openapi_all_stores.mjs --only-configured`,
  ], {timeout: 180_000});
  return {
    sync: copy,
    chmod,
    probe: {...probe, parsed: summarizeProbeJson(probe.stdout)},
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

const args = parseArgs(process.argv.slice(2));
const config = await readJson(args.config);
const results = [];
let changed = false;
for (const item of args.stores) {
  try {
    const callback = await findCallback(item.port, item.storeKey);
    if (!callback) {
      results.push({
        storeKey: item.storeKey,
        port: item.port,
        status: 'waiting_for_authorization_callback',
      });
      continue;
    }
    const result = await exchangeStore({config, storeKey: item.storeKey, callback, dryRun: args.dryRun});
    result.port = item.port;
    if (result.status === 'authorized') changed = true;
    results.push(result);
  } catch (err) {
    results.push({
      storeKey: item.storeKey,
      port: item.port,
      status: 'error',
      error: String(err?.message || err),
    });
  }
}

if (changed && !args.dryRun) {
  await writeJson(args.config, config);
}

let cloud = null;
if (changed && args.syncCloud && !args.dryRun) {
  cloud = await syncCloudAndProbe(args);
}

console.log(JSON.stringify({
  ok: results.every((r) => ['authorized', 'waiting_for_authorization_callback', 'callback_found_dry_run'].includes(r.status)),
  changed,
  dryRun: args.dryRun,
  checkedAt: new Date().toISOString(),
  results,
  cloud,
}, null, 2));
