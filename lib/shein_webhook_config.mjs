import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_SHEIN_WEBHOOK_STORE_KEYS = Object.freeze([
  'DL', 'DX', 'FY', 'LQ', 'NM', 'HL', 'JY', 'ZL', 'TS', 'MZ',
  'CX', 'YJ', 'XL', 'QY', 'QH', 'TZ', 'JSH', 'TZZ', 'XC', 'LG',
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
      return {
        appId,
        appSecretKey,
        validationStoreKey: clean(
          candidate?.webhookValidationStoreKey
          || candidate?.webhook_validation_store_key,
        ).toUpperCase(),
      };
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

function retiredAppHashes(config) {
  const values = config?.webhookRetiredAppIdSha256
    || config?.webhook?.retiredAppIdSha256
    || [];
  if (!Array.isArray(values)) throw new Error('Webhook retired app hash list must be an array');
  const hashes = new Set();
  for (const value of values) {
    const hash = clean(value).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Webhook retired app hash is invalid');
    hashes.add(hash);
  }
  return hashes;
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
  const retiredApps = retiredAppHashes(source);

  const primaryRows = storeRows(source);
  const extraRows = Array.isArray(source.webhookAdditionalAuthorizations) ? source.webhookAdditionalAuthorizations : [];
  const authorizations = new Map();
  const rows = [...primaryRows.map(row=>({row, additional:false})), ...extraRows.map(row=>({row, additional:true}))];
  for (const {row, additional} of rows) {
    if (row?.enabled === false) continue;
    const storeKey = clean(row?.storeKey || row?.key || row?.store).toUpperCase();
    if (!storeKey) continue;
    const app = resolveApp(source, row);
    const openKeyId = clean(row?.openKeyId || row?.open_key_id);
    if (!app || !openKeyId) continue;
    if (!additional && stores.has(storeKey)) throw new Error(`Store ${storeKey} appears more than once in private webhook config`);
    if (additional && !stores.has(storeKey)) throw new Error('Additional webhook authorization requires a primary store');
    const authorizationKey = `${storeKey}\0${app.appId}`;
    if (authorizations.has(authorizationKey)) throw new Error('Duplicate store/app webhook authorization');
    const priorApp = apps.get(app.appId);
    if (priorApp && priorApp.appSecretKey !== app.appSecretKey) {
      throw new Error(`App ${app.appId} has conflicting app secrets in private config`);
    }
    if (
      priorApp
      && app.validationStoreKey
      && priorApp.validationStoreKey
      && priorApp.validationStoreKey !== app.validationStoreKey
    ) {
      throw new Error(`App ${app.appId} has conflicting webhook validation store mappings`);
    }
    const appRecord = priorApp || {
      appId: app.appId,
      appSecretKey: app.appSecretKey,
      validationStoreKey: '',
      storeKeys: new Set(),
      openKeyIds: new Set(),
    };
    if (app.validationStoreKey) appRecord.validationStoreKey = app.validationStoreKey;
    appRecord.storeKeys.add(storeKey);
    appRecord.openKeyIds.add(openKeyId);
    apps.set(app.appId, appRecord);
    if (openKeys.has(openKeyId)) throw new Error('Webhook open key belongs to more than one authorization');
    const binding = {storeKey, appId:app.appId, openKeyId};
    openKeys.set(openKeyId, binding);
    authorizations.set(authorizationKey, binding);
    if (!additional) stores.set(storeKey, binding);
  }

  if (!stores.size) throw new Error('No enabled store has complete appId/appSecretKey/openKeyId webhook credentials');
  for (const app of apps.values()) {
    const activeAppHash = crypto.createHash('sha256').update(app.appId, 'utf8').digest('hex');
    if (retiredApps.has(activeAppHash)) {
      throw new Error(`Active webhook app ${app.appId} is also marked as retired`);
    }
    if (app.validationStoreKey && !app.storeKeys.has(app.validationStoreKey)) {
      throw new Error(`Webhook validation store ${app.validationStoreKey} is not authorized under its configured app`);
    }
  }
  if (expectedStoreKeys !== undefined) {
    const expected = new Set((Array.isArray(expectedStoreKeys) ? expectedStoreKeys : []).map(value => clean(value).toUpperCase()).filter(Boolean));
    const missing = [...expected].filter(storeKey => !stores.has(storeKey));
    const extra = [...stores.keys()].filter(storeKey => !expected.has(storeKey));
    if (missing.length || extra.length) {
      throw new Error(`Webhook store coverage mismatch: missing=${missing.join(',') || '-'} extra=${extra.join(',') || '-'}`);
    }
  }

  const dedupAppKey = clean(source.webhookDeduplicationAppKey);
  const dedupAppId = dedupAppKey ? clean(source.apps?.[dedupAppKey]?.appId) : '';
  if (dedupAppKey && (!dedupAppId || [...stores.keys()].some(key=>!authorizations.has(`${key}\0${dedupAppId}`)))) throw new Error('Canonical webhook deduplication app must authorize every store');

  function resolve(headers = {}) {
    const appId = clean(headers['x-lt-appid']);
    const openKeyId = clean(headers['x-lt-openkeyid']);
    const app = appId ? apps.get(appId) : null;
    const hintedBinding = openKeyId ? openKeys.get(openKeyId) : null;
    const hintedStore = hintedBinding?.storeKey || '';
    if (appId && !app) throw new Error('Unknown webhook app id');
    if (!appId && !hintedStore) throw new Error('Unknown webhook open key id');
    const effectiveApp = app || apps.get(hintedBinding?.appId);
    if (!effectiveApp) throw new Error('Webhook app credentials are unavailable');
    // SHEIN's subscription and debug probes use an app-signed, synthetic
    // openKeyId that is not one of the merchant authorization keys. The app
    // signature remains authoritative. Keep rejecting a *known* open key
    // that belongs to another app/store. An unknown hint is quarantined as an
    // app-only delivery and may use an explicitly configured validation store
    // solely to satisfy the non-null audit schema; it never enters business
    // handlers, store gates, task reconciliation, or Feishu alerts.
    if (hintedStore && (hintedBinding.appId !== effectiveApp.appId || !effectiveApp.storeKeys.has(hintedStore))) {
      throw new Error('Webhook app/open key identity mismatch');
    }
    const identityScope = hintedStore ? 'store' : 'app_only';
    let storeKey = hintedStore;
    if (!storeKey && effectiveApp.storeKeys.size === 1) storeKey = [...effectiveApp.storeKeys][0];
    if (!storeKey && effectiveApp.validationStoreKey) storeKey = effectiveApp.validationStoreKey;
    if (!storeKey) throw new Error('Webhook app maps to multiple stores and x-lt-openKeyId is required');
    const canonical = dedupAppId ? authorizations.get(`${storeKey}\0${dedupAppId}`) : null;
    return {appId: effectiveApp.appId, appSecretKey: effectiveApp.appSecretKey, openKeyId, storeKey, identityScope, credentialRole:stores.get(storeKey)?.appId===effectiveApp.appId?'primary':'backup', ...(canonical ? {deduplicationHeaders:{'x-lt-appid':canonical.appId,'x-lt-openkeyid':canonical.openKeyId}} : {})};
  }

  function isRetiredApp(headers = {}) {
    const appId = clean(headers['x-lt-appid']);
    if (!appId || !retiredApps.size) return false;
    return retiredApps.has(crypto.createHash('sha256').update(appId, 'utf8').digest('hex'));
  }

  return Object.freeze({
    resolve,
    isRetiredApp,
    summary: Object.freeze({
      appCount: apps.size,
      storeCount: stores.size,
      retiredAppCount: retiredApps.size,
      configFile: resolvedConfigFile,
    }),
  });
}
