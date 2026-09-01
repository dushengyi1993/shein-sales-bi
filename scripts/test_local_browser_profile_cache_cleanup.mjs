#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shein-browser-cache-test-'));
const profiles = path.join(root, 'profiles');
const cacheRoot = path.join(root, 'SheinBI', 'browser-cache');
const cacheMarker = path.join(cacheRoot, '.shein-bi-disposable-cache-root');
const profile = path.join(profiles, 'persistent-dl-profile');
const disposable = [
  path.join(profile, 'OptGuideOnDeviceModel', 'model.bin'),
  path.join(profile, 'Profile 1', 'Cache', 'cache.bin'),
  path.join(profile, 'Profile 1', 'Code Cache', 'code.bin'),
  path.join(cacheRoot, 'dl', 'cache.bin'),
];
const preserved = [
  path.join(profile, 'Profile 1', 'Network', 'Cookies'),
  path.join(profile, 'Profile 1', 'Local Storage', 'leveldb', '000001.log'),
  path.join(profile, 'Profile 1', 'IndexedDB', 'store', '000001.log'),
  path.join(profile, 'Profile 1', 'Login Data'),
];
for (const file of [...disposable, ...preserved]) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, 'test');
}
await fs.writeFile(cacheMarker, 'shein-bi-disposable-browser-cache-v1\n');

const command = [
  'scripts/cleanup_local_shein_browser_profile_cache.mjs',
  '--profiles-root', profiles,
  '--cache-root', cacheRoot,
  '--apply', '--json',
];
const run = spawnSync(process.execPath, command, {cwd: process.cwd(), encoding: 'utf8'});
assert.equal(run.status, 0, run.stderr || run.stdout);
const report = JSON.parse(run.stdout);
assert.equal(report.ok, true);
assert.ok(report.reclaimedBytes > 0);
assert.deepEqual(report.onDeviceAiSettings.map(item => [item.profile, item.disabled]), [
  ['persistent-dl-profile', true],
]);
const localState = JSON.parse(await fs.readFile(path.join(profile, 'Local State'), 'utf8'));
assert.equal(localState.optimization_guide.on_device_foundational_model_user_settings, false);
for (const file of disposable) await assert.rejects(fs.stat(file));
for (const file of preserved) assert.equal((await fs.readFile(file, 'utf8')), 'test');

const unsafeCacheRoot = path.join(root, 'not-browser-cache');
const unsafeSentinel = path.join(unsafeCacheRoot, 'must-survive.txt');
await fs.mkdir(unsafeCacheRoot, {recursive: true});
await fs.writeFile(unsafeSentinel, 'preserved');
const unsafeRun = spawnSync(process.execPath, [
  'scripts/cleanup_local_shein_browser_profile_cache.mjs',
  '--profiles-root', profiles,
  '--cache-root', unsafeCacheRoot,
  '--apply', '--json',
], {cwd: process.cwd(), encoding: 'utf8'});
assert.equal(unsafeRun.status, 1, unsafeRun.stderr || unsafeRun.stdout);
const unsafeReport = JSON.parse(unsafeRun.stdout);
assert.equal(unsafeReport.ok, false);
assert.equal(unsafeReport.cacheRootValidation.reason, 'cache_root_basename_mismatch');
assert.equal(await fs.readFile(unsafeSentinel, 'utf8'), 'preserved');

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const launcher = await fs.readFile(path.join(scriptDir, 'launch_store_browser.mjs'), 'utf8');
const mainLauncher = await fs.readFile(path.join(scriptDir, 'launch_shein_main_browser.mjs'), 'utf8');
const etLauncher = await fs.readFile(path.join(scriptDir, 'fetch_et_forwarder.mjs'), 'utf8');
const manualLoginLauncher = await fs.readFile(path.join(scriptDir, 'cloud_manual_login_session.mjs'), 'utf8');
const hygiene = await fs.readFile(path.join(scriptDir, '..', 'lib', 'chrome_profile_hygiene.mjs'), 'utf8');
assert.match(launcher, /LOCALAPPDATA[\s\S]*SheinBI[\s\S]*browser-cache/);
assert.match(launcher, /\.shein-bi-disposable-cache-root/);
assert.match(launcher, /shein-bi-disposable-browser-cache-v1/);
assert.match(launcher, /--disk-cache-size=104857600/);
assert.match(hygiene, /return `--disable-features=/);
assert.match(hygiene, /OptimizationGuideOnDeviceModel/);
assert.match(hygiene, /on_device_foundational_model_user_settings/);
assert.match(hygiene, /openSync\(temporary, 'wx'/,
  'profile metadata publication must use an exclusive same-directory temporary');
assert.match(hygiene, /fs\.fsyncSync\(fd\)/,
  'profile metadata publication must fsync the completed temporary file');
assert.match(hygiene, /fs\.renameSync\(temporary, target\)/,
  'profile metadata publication must publish through atomic rename');
assert.match(hygiene, /Chrome profile metadata JSON is invalid/,
  'malformed profile JSON must fail closed instead of becoming an empty object');
assert.match(launcher, /LocalNetworkAccessChecks/);
for (const source of [launcher, mainLauncher, etLauncher, manualLoginLauncher]) {
  assert.match(source, /disableChromeOnDeviceAiForProfile/);
  assert.match(source, /chromeDisabledFeaturesArg/);
}
for (const source of [launcher, mainLauncher]) {
  assert.match(source, /writeJsonFileAtomicSync/,
    'launcher Preferences and Local State writes must use the synchronous atomic JSON helper');
  assert.match(source, /writeTextFileAtomicSync/,
    'launcher PROFILE_NAME.txt writes must use the synchronous atomic text helper');
  assert.doesNotMatch(source, /writeFileSync\(prefsPath|writeFileSync\(localStatePath/,
    'launcher must not directly overwrite Chrome JSON metadata');
}

await fs.rm(root, {recursive: true, force: true});
console.log(JSON.stringify({ok: true, preserved: preserved.length, removed: disposable.length}));
