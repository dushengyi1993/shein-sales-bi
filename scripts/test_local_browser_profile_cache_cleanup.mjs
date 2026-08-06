#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shein-browser-cache-test-'));
const profiles = path.join(root, 'profiles');
const cacheRoot = path.join(root, 'shared-cache');
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
for (const file of disposable) await assert.rejects(fs.stat(file));
for (const file of preserved) assert.equal((await fs.readFile(file, 'utf8')), 'test');

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const launcher = await fs.readFile(path.join(scriptDir, 'launch_store_browser.mjs'), 'utf8');
assert.match(launcher, /LOCALAPPDATA[\s\S]*SheinBI[\s\S]*browser-cache/);
assert.match(launcher, /--disk-cache-size=104857600/);
assert.equal((launcher.match(/--disable-features=/g) || []).length, 1, 'all disabled Chrome features must share one switch');
assert.match(launcher, /OptimizationGuideOnDeviceModel/);
assert.match(launcher, /LocalNetworkAccessChecks/);

await fs.rm(root, {recursive: true, force: true});
console.log(JSON.stringify({ok: true, preserved: preserved.length, removed: disposable.length}));
