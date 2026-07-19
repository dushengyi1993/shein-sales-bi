import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_SHEIN_WEBHOOK_STORE_KEYS = Object.freeze([
  'DL', 'DX', 'FY', 'LQ', 'NM', 'HL', 'JY', 'ZL', 'TS', 'MZ',
  'CX', 'YJ', 'XL', 'QY', 'QH', 'TZ', 'JSH', 'TZZ', 'XC',
]);

function clean(value) {
  return String(value ?? '').trim();
}

function storeRows(config) {
  if (Array.isArray(config?.stores)) return config.stores;
  if (config?.stores && typeof config.stores === 'object') {
    return Object.entries(config.stores).map(([storeKey, row]) => ({storeKey, ...(row || {})}));
  }
  return [];
}

function appCandidates(config, store) {
  const appKey = clean(store?.appKey);
  return [
    store?.app,
    store,
    appKey ? config?.apps?.[appKey] : null,
    config?.app,
  ].filter(Boolean);
}

function resolveApp(config, store) {
  for (const candidate of appCandidates(config, store)) {
    const appId = clean(candidate?.appId || candidate?.app_id);
    const appSecretKey = clean(candidate?.appSecretKey || candidate?.app_secret_key || candidate?.appSecret);
    if (appId && appSecretKey && !/不要提交|填写/.test(`${appId}${appSecretKey}`)) {
      return {appId, appSecretKey};
    }
  }
  return null;
}

function addUnique(map, key, value, conflictLabel) {
  const existing = map.get(key);
  if (!existing) {
    map.set(key, value);
    return;
  }
  if (existing !== value) throw new Error(`${conflictLabel} has conflicting mappings`);
}

/**
 * Loads the private OpenAPI config into a lookup that never serializes secrets.
 * Webhook signatures use app credentials; x-lt-openKeyId is only a store identity hint.
 */
export async function loadSheinWebhookCredentialRegistry({configFile, config, expectedStoreKeys} = {}) {
  const resolvedConfigFile = configFile ? path.resolve(configFile) : '';
  const source = config || JSON.parse(await fs.readFile(resolvedConfigFile, 'utf8'));
  const apps = new Map();
  const openKeys = new Map();
  const stores = new Map();

  for (const row of storeRows(source)) {
    if (row?.enabled === false) continue;
    const storeKey = clean(row?.storeKey || row?.key || row?.store).toUpperCase();
    if (!storeKey) continue;
    const app = resolveApp(source, row);
    const openKeyId = clean(row?.openKeyId || row?.open_key_id);
    if (!app || !openKeyId) continue;
    if (stores.has(storeKey)) throw new Error(`Store ${storeKey} appears more than once in private webhook config`);
    const priorApp = apps.get(app.appId);
    if (priorApp && priorApp.appSecretKey !== app.appSecretKey) {
      throw new Error(`App ${app.appId} has conflicting app secrets in private config`);
    }
    const appRecord = priorApp || {appId: app.appId, appSecretKey: app.appSecretKey, storeKeys: new Set(), openKeyIds: new Set()};
    appRecord.storeKeys.add(storeKey);
    appRecord.openKeyIds.add(openKeyId);
    apps.set(app.appId, appRecord);
    addUnique(openKeys, openKeyId, storeKey, `openKeyId ${openKeyId}`);
    stores.set(storeKey, {storeKey, appId: app.appId, openKeyId});
  }

  if (!stores.size) throw new Error('No enabled store has complete appId/appSecretKey/openKeyId webhook credentials');
  if (expectedStoreKeys !== undefined) {
    const expected = new Set((Array.isArray(expectedStoreKeys) ? expectedStoreKeys : []).map(value => clean(value).toUpperCase()).filter(Boolean));
    const missing = [...expected].filter(storeKey => !stores.has(storeKey));
    const extra = [...stores.keys()].filter(storeKey => !expected.has(storeKey));
    if (missing.length || extra.length) {
      throw new Error(`Webhook store coverage mismatch: missing=${missing.join(',') || '-'} extra=${extra.join(',') || '-'}`);
    }
  }

  function resolve(headers = {}) {
    const appId = clean(headers['x-lt-appid']);
    const openKeyId = clean(headers['x-lt-openkeyid']);
    const app = appId ? apps.get(appId) : null;
    const hintedStore = openKeyId ? openKeys.get(openKeyId) : '';
    if (appId && !app) throw new Error('Unknown webhook app id');
    if (!appId && !hintedStore) throw new Error('Unknown webhook open key id');
    const effectiveApp = app || apps.get(stores.get(hintedStore)?.appId);
    if (!effectiveApp) throw new Error('Webhook app credentials are unavailable');
    if (openKeyId && !effectiveApp.openKeyIds.has(openKeyId)) throw new Error('Webhook app/open key identity mismatch');
    let storeKey = hintedStore;
    if (!storeKey && effectiveApp.storeKeys.size === 1) storeKey = [...effectiveApp.storeKeys][0];
    if (!storeKey) throw new Error('Webhook app maps to multiple stores and x-lt-openKeyId is required');
    return {appId: effectiveApp.appId, appSecretKey: effectiveApp.appSecretKey, openKeyId, storeKey};
  }

  return Object.freeze({
    resolve,
    summary: Object.freeze({appCount: apps.size, storeCount: stores.size, configFile: resolvedConfigFile}),
  });
}
