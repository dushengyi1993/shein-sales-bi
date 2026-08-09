#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  cleanupOwnedChromeTmpDirectories,
  inspectChromeTmpDirectories,
} from '../lib/chrome_tmp_hygiene.mjs';

function fakeFs() {
  const entries = new Map([
    ['com.google.Chrome.owned', {uid: 1001, kind: 'dir'}],
    ['.com.google.Chrome.foreign', {uid: 1002, kind: 'dir'}],
    ['com.google.Chrome.symlink', {uid: 1001, kind: 'symlink'}],
    ['not-chrome', {uid: 1001, kind: 'dir'}],
  ]);
  const removed = [];
  return {
    removed,
    readdirSync() {
      return [...entries.keys()];
    },
    lstatSync(file) {
      const item = entries.get(path.basename(file));
      if (!item) throw Object.assign(new Error('missing'), {code: 'ENOENT'});
      return {
        uid: item.uid,
        isDirectory: () => item.kind === 'dir',
        isSymbolicLink: () => item.kind === 'symlink',
      };
    },
    rmSync(file) {
      const name = path.basename(file);
      removed.push(name);
      entries.delete(name);
    },
  };
}

{
  const fsImpl = fakeFs();
  const inspected = inspectChromeTmpDirectories({tmpRoot: '/tmp', ownerUid: 1001, fsImpl});
  assert.deepEqual(inspected.owned.map(item => path.basename(item.path)), ['com.google.Chrome.owned']);
  assert.deepEqual(inspected.foreign.map(item => path.basename(item.path)), ['.com.google.Chrome.foreign']);
  assert.deepEqual(inspected.unsafe.map(item => path.basename(item.path)), ['com.google.Chrome.symlink']);
  assert.deepEqual(inspected.foreignOwnerUids, {'1002': 1});
}

{
  const fsImpl = fakeFs();
  const result = cleanupOwnedChromeTmpDirectories({
    enabled: true,
    dryRun: false,
    liveCount: 0,
    tmpRoot: '/tmp',
    ownerUid: 1001,
    fsImpl,
  });
  assert.equal(result.beforeCount, 1);
  assert.equal(result.afterCount, 0);
  assert.equal(result.foreignCount, 1);
  assert.equal(result.unsafeCount, 1);
  assert.deepEqual(fsImpl.removed, ['com.google.Chrome.owned']);
}

{
  const fsImpl = fakeFs();
  const result = cleanupOwnedChromeTmpDirectories({
    enabled: true,
    liveCount: 1,
    tmpRoot: '/tmp',
    ownerUid: 1001,
    fsImpl,
  });
  assert.equal(result.skipped, 'live-chrome-processes');
  assert.equal(result.afterCount, 1);
  assert.deepEqual(fsImpl.removed, []);
}

{
  const fsImpl = fakeFs();
  const result = cleanupOwnedChromeTmpDirectories({
    enabled: true,
    liveCount: 0,
    tmpRoot: '/tmp',
    ownerUid: null,
    fsImpl,
  });
  assert.equal(result.skipped, 'owner-uid-unavailable');
  assert.deepEqual(fsImpl.removed, []);
}

console.log('test_chrome_tmp_hygiene: ok');
