#!/usr/bin/env node
/**
 * Reclaim disposable Chrome data from local SHEIN store profiles.
 *
 * Safety rules:
 * - dry-run by default; --apply is required to remove anything;
 * - an active profile is always skipped;
 * - Cookies, Login Data, Local/Session Storage and IndexedDB are never targets;
 * - only known cache/model directories below the configured profiles root are
 *   eligible for removal.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  disableChromeOnDeviceAiForProfile,
  readChromeOnDeviceAiSetting,
} from '../lib/chrome_profile_hygiene.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PROFILES_ROOT = path.join(ROOT, 'profiles');
const DEFAULT_CACHE_ROOT = path.join(process.env.LOCALAPPDATA || ROOT, 'SheinBI', 'browser-cache');
const CACHE_ROOT_MARKER = '.shein-bi-disposable-cache-root';
const CACHE_ROOT_MARKER_CONTENT = 'shein-bi-disposable-browser-cache-v1\n';

const PROFILE_CACHE_PATHS = [
  'OptGuideOnDeviceModel',
  'OptGuideOnDeviceClassifierModel',
  'optimization_guide_model_store',
  'component_crx_cache',
  'Crashpad',
  'ShaderCache',
  'GrShaderCache',
  'DawnCache',
  'GraphiteDawnCache',
  'cache',
  path.join('Profile 1', 'Cache'),
  path.join('Profile 1', 'Code Cache'),
  path.join('Profile 1', 'GPUCache'),
  path.join('Profile 1', 'DawnCache'),
  path.join('Profile 1', 'ShaderCache'),
  path.join('Profile 1', 'GrShaderCache'),
  path.join('Profile 1', 'GraphiteDawnCache'),
];

function parseArgs(argv) {
  const args = {
    apply: false,
    json: false,
    profilesRoot: DEFAULT_PROFILES_ROOT,
    cacheRoot: DEFAULT_CACHE_ROOT,
    stores: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--profiles-root') args.profilesRoot = path.resolve(argv[++i] || '');
    else if (arg === '--cache-root') args.cacheRoot = path.resolve(argv[++i] || '');
    else if (arg === '--store') args.stores.push(String(argv[++i] || '').trim().toLowerCase());
    else if (arg === '--stores') args.stores.push(...String(argv[++i] || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function validateDisposableCacheRoot(cacheRoot) {
  const resolved = path.resolve(cacheRoot);
  if (resolved === path.parse(resolved).root) {
    return {ok: false, reason: 'cache_root_is_filesystem_root', resolved};
  }
  if (path.basename(resolved).toLowerCase() !== 'browser-cache') {
    return {ok: false, reason: 'cache_root_basename_mismatch', resolved};
  }
  let rootStat;
  try {
    rootStat = await fsp.lstat(resolved);
  } catch (error) {
    return {ok: false, reason: error?.code === 'ENOENT' ? 'cache_root_missing' : 'cache_root_stat_failed', resolved};
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return {ok: false, reason: 'cache_root_not_real_directory', resolved};
  }
  const marker = path.join(resolved, CACHE_ROOT_MARKER);
  let markerStat;
  try {
    markerStat = await fsp.lstat(marker);
  } catch (error) {
    return {ok: false, reason: error?.code === 'ENOENT' ? 'cache_root_marker_missing' : 'cache_root_marker_stat_failed', resolved, marker};
  }
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
    return {ok: false, reason: 'cache_root_marker_not_real_file', resolved, marker};
  }
  const content = await fsp.readFile(marker, 'utf8').catch(() => null);
  if (content !== CACHE_ROOT_MARKER_CONTENT) {
    return {ok: false, reason: 'cache_root_marker_mismatch', resolved, marker};
  }
  return {ok: true, reason: 'verified', resolved, marker};
}

async function dirBytes(root) {
  let total = 0;
  let entries;
  try { entries = await fsp.readdir(root, {withFileTypes: true}); }
  catch { return 0; }
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) total += await dirBytes(file);
    else if (entry.isFile()) {
      try { total += (await fsp.stat(file)).size; } catch {}
    }
  }
  return total;
}

function activeProfilePaths(profilesRoot) {
  if (process.platform !== 'win32') return new Set();
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" |",
    "  Where-Object { $_.CommandLine -match '--user-data-dir=' } |",
    "  Select-Object -ExpandProperty CommandLine",
  ].join('\n');
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ], {encoding: 'utf8', timeout: 15_000, windowsHide: true});
  const root = path.resolve(profilesRoot).toLowerCase();
  const active = new Set();
  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    const match = line.match(/--user-data-dir=(?:"([^"]+)"|'([^']+)'|([^\s]+))/i);
    const value = path.resolve(match?.[1] || match?.[2] || match?.[3] || '').toLowerCase();
    if (value && (value === root || value.startsWith(`${root}${path.sep}`))) active.add(value);
  }
  return active;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const profilesRoot = path.resolve(args.profilesRoot);
  const active = activeProfilePaths(profilesRoot);
  const entries = await fsp.readdir(profilesRoot, {withFileTypes: true}).catch(() => []);
  const profiles = entries
    .filter(entry => entry.isDirectory() && /^persistent-.+-profile$/i.test(entry.name))
    .filter(entry => !args.stores.length || args.stores.some(store => entry.name.toLowerCase() === `persistent-${store}-profile` || entry.name.toLowerCase().includes(`-${store}-`)))
    .map(entry => path.join(profilesRoot, entry.name));

  const report = {
    ok: true,
    mode: args.apply ? 'apply' : 'dry-run',
    generatedAt: new Date().toISOString(),
    host: os.hostname(),
    profilesRoot,
    cacheRoot: args.cacheRoot,
    cacheRootValidation: null,
    profilesScanned: profiles.length,
    profilesSkippedActive: [],
    onDeviceAiSettings: [],
    targets: [],
    reclaimedBytes: 0,
    errors: [],
    preserved: ['Cookies', 'Login Data', 'Local Storage', 'Session Storage', 'IndexedDB'],
  };

  for (const profile of profiles) {
    if (active.has(path.resolve(profile).toLowerCase())) {
      report.profilesSkippedActive.push(path.basename(profile));
      continue;
    }
    const before = readChromeOnDeviceAiSetting(profile);
    const setting = args.apply ? disableChromeOnDeviceAiForProfile(profile) : before;
    report.onDeviceAiSettings.push({
      profile: path.basename(profile),
      disabled: args.apply ? setting.disabled : before.disabled,
      changed: args.apply ? setting.changed : false,
      previous: args.apply ? setting.previous : before.value,
    });
    for (const relative of PROFILE_CACHE_PATHS) {
      const target = path.resolve(profile, relative);
      if (!isWithin(profile, target) || !fs.existsSync(target)) continue;
      const bytes = await dirBytes(target);
      const item = {profile: path.basename(profile), path: target, bytes, removed: false};
      if (args.apply) {
        try {
          await fsp.rm(target, {recursive: true, force: true});
          item.removed = true;
          report.reclaimedBytes += bytes;
        } catch (error) {
          item.error = error?.code || error?.message || String(error);
          report.errors.push({path: target, error: item.error});
        }
      }
      report.targets.push(item);
    }
  }

  // The shared disposable cache has no login/session data. It may be reclaimed
  // only when no SHEIN store profile is active and its marker proves that the
  // caller did not redirect --cache-root to an arbitrary directory.
  if (active.size === 0 && fs.existsSync(args.cacheRoot)) {
    const validation = await validateDisposableCacheRoot(args.cacheRoot);
    report.cacheRootValidation = validation;
    if (!validation.ok) {
      report.errors.push({path: validation.resolved, error: validation.reason});
    } else {
      const bytes = await dirBytes(validation.resolved);
      const item = {profile: 'shared-browser-cache', path: validation.resolved, bytes, removed: false};
      if (args.apply) {
        try {
          await fsp.rm(validation.resolved, {recursive: true, force: true});
          item.removed = true;
          report.reclaimedBytes += bytes;
        } catch (error) {
          item.error = error?.code || error?.message || String(error);
          report.errors.push({path: validation.resolved, error: item.error});
        }
      }
      report.targets.push(item);
    }
  }

  report.ok = report.errors.length === 0;
  report.reclaimableBytes = report.targets.reduce((sum, item) => sum + Number(item.bytes || 0), 0);
  const output = JSON.stringify(report, null, 2);
  if (args.json) console.log(output);
  else {
    console.log(`[cleanup_local_shein_browser_profile_cache] mode=${report.mode} profiles=${report.profilesScanned} activeSkipped=${report.profilesSkippedActive.length} reclaimableMB=${(report.reclaimableBytes / 1024 / 1024).toFixed(1)} reclaimedMB=${(report.reclaimedBytes / 1024 / 1024).toFixed(1)} errors=${report.errors.length}`);
    if (report.profilesSkippedActive.length) console.log(`active profiles skipped: ${report.profilesSkippedActive.join(', ')}`);
  }
  if (!report.ok) process.exitCode = 1;
}

await main();
