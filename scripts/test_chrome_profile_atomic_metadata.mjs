#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  disableChromeOnDeviceAiForProfile,
  readJsonFileSync,
  writeJsonFileAtomicSync,
  writeTextFileAtomicSync,
} from '../lib/chrome_profile_hygiene.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shein-chrome-profile-atomic-'));
const tempNames = () => fs.readdirSync(root).filter(name => name.endsWith('.tmp'));
const statStamp = file => {
  const stat = fs.statSync(file, {bigint: true});
  return `${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`;
};

try {
  const preferences = path.join(root, 'Preferences');
  const first = writeJsonFileAtomicSync(preferences, {profile: {name: '原始名称'}});
  assert.equal(first.changed, true);
  const firstBytes = fs.readFileSync(preferences);
  const firstStamp = statStamp(preferences);
  const repeated = writeJsonFileAtomicSync(preferences, {profile: {name: '原始名称'}});
  assert.equal(repeated.changed, false, 'same JSON bytes must be an idempotent no-op');
  assert.deepEqual(fs.readFileSync(preferences), firstBytes);
  assert.equal(statStamp(preferences), firstStamp, 'same bytes must not change mtime/ctime');
  assert.deepEqual(tempNames(), [], 'idempotent publish must not leave temporary files');

  if (process.platform !== 'win32') {
    fs.chmodSync(preferences, 0o640);
    writeJsonFileAtomicSync(preferences, {profile: {name: 'mode-preserved'}});
    assert.equal(fs.statSync(preferences).mode & 0o777, 0o640,
      'a replacement must preserve the existing regular-file mode');
  }

  const beforeFailure = fs.readFileSync(preferences, 'utf8');
  assert.throws(
    () => writeJsonFileAtomicSync(preferences, {profile: {name: '故障中间态'}}, {
      beforeRename: () => { throw new Error('injected-before-rename'); },
    }),
    /injected-before-rename/,
  );
  assert.equal(fs.readFileSync(preferences, 'utf8'), beforeFailure,
    'a pre-rename failure must leave the previous complete file intact');
  assert.deepEqual(tempNames(), [], 'failed publish must clean its temporary file');

  const profileName = path.join(root, 'PROFILE_NAME.txt');
  writeTextFileAtomicSync(profileName, 'SHEIN\n');
  const profileNameStamp = statStamp(profileName);
  assert.equal(writeTextFileAtomicSync(profileName, 'SHEIN\n').changed, false);
  assert.equal(statStamp(profileName), profileNameStamp);

  const localState = path.join(root, 'Local State');
  fs.writeFileSync(localState, '{"optimization_guide":{"on_device_foundational_model_user_settings":false}}');
  const disabledAlreadyStamp = statStamp(localState);
  const disabledAlready = disableChromeOnDeviceAiForProfile(root);
  assert.equal(disabledAlready.disabled, true);
  assert.equal(disabledAlready.changed, false, 'already-disabled Local State must not be rewritten');
  assert.equal(statStamp(localState), disabledAlreadyStamp);

  const corrupt = Buffer.from('{"optimization_guide":');
  fs.writeFileSync(localState, corrupt);
  assert.throws(() => disableChromeOnDeviceAiForProfile(root), /JSON is invalid/,
    'malformed Local State must fail closed');
  assert.deepEqual(fs.readFileSync(localState), corrupt,
    'malformed Local State must never be replaced with an empty object');
  assert.deepEqual(tempNames(), [], 'malformed JSON failure must leave no temporary file');
  assert.throws(() => readJsonFileSync(localState), /JSON is invalid/);

  console.log(JSON.stringify({ok: true, root, checks: [
    'same-byte idempotence preserves content and timestamps',
    'pre-rename failure preserves the previous complete file',
    'malformed JSON fails closed',
    'temporary files are cleaned up',
  ]}, null, 2));
} finally {
  fs.rmSync(root, {recursive: true, force: true});
}
