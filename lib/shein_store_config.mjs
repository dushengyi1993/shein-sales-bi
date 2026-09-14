import fs from 'node:fs';
import path from 'node:path';

// Current operational store scope. Runtime callers should load config/stores.json
// and use this only as the compatibility fallback for a missing file.
export const DEFAULT_SHEIN_STORE_KEYS = Object.freeze([
  'CX', 'DL', 'DX', 'FY', 'HL', 'HY', 'JSH', 'JY', 'LG', 'LQ', 'MZ',
  'NM', 'QH', 'QY', 'TS', 'TZ', 'TZZ', 'XC', 'XL', 'YJ', 'ZL',
]);

export function enabledStoreKeysFromConfig(config) {
  const rows = Array.isArray(config?.stores) ? config.stores : [];
  const keys = [...new Set(rows
    .filter(row => row && row.enabled !== false && row.storeKey)
    .map(row => String(row.storeKey).trim().toUpperCase())
    .filter(Boolean))];
  return keys.length ? keys : [...DEFAULT_SHEIN_STORE_KEYS];
}

export function loadEnabledStoreKeysSync({root = process.cwd(), file = path.join(root, 'config', 'stores.json')} = {}) {
  try {
    return enabledStoreKeysFromConfig(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
  } catch (error) {
    if (error?.code === 'ENOENT') return [...DEFAULT_SHEIN_STORE_KEYS];
    throw error;
  }
}

export function enabledStoreCount(options = {}) {
  return loadEnabledStoreKeysSync(options).length;
}
