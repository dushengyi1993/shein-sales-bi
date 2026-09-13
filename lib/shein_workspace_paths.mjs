import fs from 'node:fs';
import path from 'node:path';

export const SHEIN_PRIMARY_WORKSPACE = 'E:/Codex WorkSpace/Shein销售统计';

export function resolveSheinPrimaryWorkspace({env = process.env, platform = process.platform, primaryWorkspace = ''} = {}) {
  const explicitRoot = String(primaryWorkspace || '').trim();
  if (explicitRoot) return path.resolve(explicitRoot);
  const configured = String(env.SHEIN_BI_PRIMARY_WORKSPACE || '').trim();
  if (configured) return path.resolve(configured);
  if (platform === 'win32') return path.resolve(SHEIN_PRIMARY_WORKSPACE);
  return path.resolve('/opt/shein-bi/app');
}

export function resolvePersistentStoreProfile(store, options = {}) {
  if (!store?.profileKey) throw new Error('Store profileKey is required');
  const root = resolveSheinPrimaryWorkspace(options);
  const profileDir = path.join(root, 'profiles', 'persistent-' + store.profileKey + '-profile');
  if (options.requireExistingRoot && !fs.existsSync(root)) throw new Error('Primary SHEIN workspace is unavailable: ' + root);
  return profileDir;
}

export function resolvePersistentMainProfile(options = {}) {
  const root = resolveSheinPrimaryWorkspace(options);
  if (options.requireExistingRoot && !fs.existsSync(root)) throw new Error('Primary SHEIN workspace is unavailable: ' + root);
  return path.join(root, 'profiles', 'persistent-shein-main-profile');
}
