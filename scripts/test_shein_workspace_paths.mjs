import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {resolvePersistentMainProfile, resolvePersistentStoreProfile, resolveSheinPrimaryWorkspace, SHEIN_PRIMARY_WORKSPACE} from '../lib/shein_workspace_paths.mjs';

const store = {profileKey: 'demo'};
const root = path.resolve(SHEIN_PRIMARY_WORKSPACE);
assert.equal(resolveSheinPrimaryWorkspace({platform: 'win32', env: {}}), root);
assert.equal(resolvePersistentStoreProfile(store, {platform: 'win32', env: {}}), path.join(root, 'profiles', 'persistent-demo-profile'));
assert.equal(resolvePersistentMainProfile({platform: 'win32', env: {}}), path.join(root, 'profiles', 'persistent-shein-main-profile'));
assert.equal(resolvePersistentStoreProfile(store, {platform: 'win32', env: {SHEIN_BI_PRIMARY_WORKSPACE: 'E:/Codex WorkSpace/Shein销售统计'}}), path.join(root, 'profiles', 'persistent-demo-profile'));
assert.equal(resolveSheinPrimaryWorkspace({platform: 'linux', env: {}}), path.resolve('/opt/shein-bi/app'));
assert.equal(resolvePersistentStoreProfile(store, {platform: 'linux', env: {}}), path.resolve('/opt/shein-bi/app/profiles/persistent-demo-profile'));
assert.throws(() => resolvePersistentStoreProfile({}, {platform: 'win32', env: {}}), /profileKey/);
for (const file of [
  '../lib/chrome_profile_startup.mjs',
  './launch_store_browser.mjs',
  './cleanup_shein_store_browsers.mjs',
  './cloud_manual_login_session.mjs',
  './cloud_shein_session_manager.mjs',
  './launch_shein_main_browser.mjs',
]) {
  const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
  assert.match(source, /resolvePersistent(?:Store|Main)Profile/);
}
console.log('shein workspace path tests passed');
