import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ensureProfileName} from '../lib/chrome_profile_hygiene.mjs';

// A store profile created by ANY launcher must carry the store's visible
// Chrome profile name. The temporary manual-login window previously created
// the profile without the naming step, so a brand-new store (LG/HY) showed up
// as "Your Chrome" and the operator could not tell the windows apart.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempParent = path.resolve(process.env.SHEIN_TEST_TMP_ROOT || os.tmpdir());
const tempRoot = await fs.mkdtemp(path.join(tempParent, 'manual-login-profile-naming-'));
let checks = 0;
const ok = label => { checks += 1; console.log(`PASS ${label}`); };
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));

try {
  // 1. Derived name (“<storeKey> - <shopName>”) is written to all three places
  //    Chrome reads for the visible label.
  const profileDir = path.join(tempRoot, 'persistent-lg-profile');
  await fs.mkdir(path.join(profileDir, 'Profile 1'), {recursive: true});
  await fs.writeFile(path.join(profileDir, 'Profile 1', 'Preferences'),
    JSON.stringify({profile: {name: 'Your Chrome', is_using_default_name: true}, browser: {show_home_button: true}}), 'utf8');
  const derived = ensureProfileName(profileDir, {storeKey: 'LG', shopName: 'LOGE-SA'});
  assert.equal(derived, 'LG - LOGE-SA');
  const prefs = await readJson(path.join(profileDir, 'Profile 1', 'Preferences'));
  assert.equal(prefs.profile.name, 'LG - LOGE-SA');
  assert.equal(prefs.profile.is_using_default_name, false);
  assert.equal(prefs.browser.show_home_button, true, 'unrelated Preferences keys must survive');
  const localState = await readJson(path.join(profileDir, 'Local State'));
  assert.equal(localState.profile.info_cache['Profile 1'].name, 'LG - LOGE-SA');
  assert.equal(localState.profile.info_cache['Profile 1'].is_using_default_name, false);
  assert.equal(localState.profile.info_cache['Profile 1'].avatar_icon, 'chrome://theme/IDR_PROFILE_AVATAR_26');
  assert.equal(await fs.readFile(path.join(profileDir, 'PROFILE_NAME.txt'), 'utf8'), 'LG - LOGE-SA\n');
  ok('derived name is written to Preferences, Local State info_cache and PROFILE_NAME.txt');

  // 2. An explicit store.profileName wins over the derived form.
  const explicitDir = path.join(tempRoot, 'persistent-hy-profile');
  const explicit = ensureProfileName(explicitDir, {storeKey: 'HY', shopName: 'FANS YOUNG-SA', profileName: 'HY - 寰宇'});
  assert.equal(explicit, 'HY - 寰宇');
  assert.equal(await fs.readFile(path.join(explicitDir, 'PROFILE_NAME.txt'), 'utf8'), 'HY - 寰宇\n');
  ok('an explicit store.profileName is honoured');

  // 3. Repeated calls are idempotent and never regress an existing name.
  const again = ensureProfileName(profileDir, {storeKey: 'LG', shopName: 'LOGE-SA'});
  assert.equal(again, 'LG - LOGE-SA');
  assert.equal((await readJson(path.join(profileDir, 'Local State'))).profile.info_cache['Profile 1'].name, 'LG - LOGE-SA');
  ok('repeated naming is idempotent');

  // 4. A store without a key cannot silently produce an unnamed profile.
  assert.throws(() => ensureProfileName(path.join(tempRoot, 'unnamed'), {shopName: 'NO-KEY'}),
    /cannot be derived without a store key/);
  ok('a missing store key fails closed instead of writing a blank name');

  // 5. Contract: the manual-login window must apply the shared naming step
  //    before it spawns Chrome, and record the resulting name as evidence.
  const loginSource = await fs.readFile(path.join(ROOT, 'scripts', 'cloud_manual_login_session.mjs'), 'utf8');
  assert.match(loginSource, /import \{[^}]*ensureProfileName[^}]*\} from '\.\.\/lib\/chrome_profile_hygiene\.mjs';/s,
    'the manual-login window must import the shared profile-naming helper');
  assert.ok(loginSource.indexOf('ensureProfileName(prof, store)') > 0,
    'the manual-login window must name the profile it is about to create');
  assert.ok(loginSource.indexOf('ensureProfileName(prof, store)') < loginSource.indexOf('spawnDetached(chromePath()'),
    'naming must happen before Chrome is started');
  assert.match(loginSource, /profileName: session\.profileName \|\| ''/,
    'the session evidence must expose the profile name');
  ok('manual-login window applies naming before launching Chrome and records it');

  // 6. Contract: one implementation only. The store launcher must import the
  //    shared helper instead of keeping a private copy that can drift.
  for (const launcherName of ['launch_store_browser.mjs', 'launch_shein_main_browser.mjs']) {
    const launchSource = await fs.readFile(path.join(ROOT, 'scripts', launcherName), 'utf8');
    assert.match(launchSource, /import \{[^}]*ensureProfileName[^}]*\} from '\.\.\/lib\/chrome_profile_hygiene\.mjs';/s,
      `${launcherName} must import the shared naming helper`);
    assert.doesNotMatch(launchSource, /function ensureProfileName\(/,
      `${launcherName} must not keep a private copy of the naming logic`);
  }
  ok('every launcher shares one naming implementation');

  console.log(JSON.stringify({ok: true, checks}, null, 2));
} finally {
  await fs.rm(tempRoot, {recursive: true, force: true});
}
