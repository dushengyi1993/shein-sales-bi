#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {writeFileAtomic, writeJsonFileAtomic} from '../lib/atomic_file_publish.mjs';

const sectionCacheSource = await fs.readFile(new URL('../lib/bi_section_cache.mjs', import.meta.url), 'utf8');
assert.match(sectionCacheSource, /writeFileAtomic\(file, raw\)/,
  'section JSON cache must use the durable atomic publisher');
assert.match(sectionCacheSource, /writeFileAtomic\(`\$\{file\}\.gz`, gzipped\)/,
  'section gzip cache must use the durable atomic publisher');

async function injectRenameFailures(codes, action) {
  const originalRename = fs.rename;
  let calls = 0;
  fs.rename = async (...args) => {
    const code = codes[calls++];
    if (code) {
      const error = new Error(`injected fs.rename ${code}`);
      error.code = code;
      throw error;
    }
    return originalRename(...args);
  };
  try {
    await action();
  } finally {
    fs.rename = originalRename;
  }
  return calls;
}

async function assertNoTempFiles(dir, message) {
  assert.equal((await fs.readdir(dir)).filter(name => name.endsWith('.tmp')).length, 0, message);
}

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shein-bi-atomic-publish-'));
const target = path.join(dir, 'data.json');
try {
  await fs.writeFile(target, '{"version":"old"}\n', 'utf8');
  await assert.rejects(
    () => writeFileAtomic(target, '{"version":"new"}\n', {
      encoding: 'utf8',
      beforeRename: async () => { throw new Error('injected rename boundary failure'); },
    }),
    /injected rename boundary failure/,
  );
  assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), {version: 'old'}, 'a failed publish must keep the prior complete artifact');
  await assertNoTempFiles(dir, 'failed temporary artifacts must be cleaned up');

  const transientCalls = await injectRenameFailures(['EPERM', 'EBUSY', 'EACCES'], () =>
    writeFileAtomic(target, '{"version":"retried"}\n', {encoding: 'utf8'}));
  assert.equal(transientCalls, 4, 'each allowed transient rename code must be retried before success');
  assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), {version: 'retried'}, 'a transient rename failure must eventually publish the complete artifact');
  await assertNoTempFiles(dir, 'successful retry must not leak its temporary artifact');

  await fs.writeFile(target, '{"version":"stable"}\n', 'utf8');
  const exhaustedCalls = await injectRenameFailures(['EPERM', 'EPERM', 'EPERM', 'EPERM'], () =>
    assert.rejects(
      () => writeFileAtomic(target, '{"version":"blocked"}\n', {encoding: 'utf8'}),
      error => error?.code === 'EPERM',
      'rename must fail with the final transient error after the bounded retry budget',
    ));
  assert.equal(exhaustedCalls, 4, 'rename retry budget must be four total attempts');
  assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), {version: 'stable'}, 'exhausted retries must preserve the prior complete artifact');
  await assertNoTempFiles(dir, 'exhausted retries must clean up the temporary artifact');

  const permanentCalls = await injectRenameFailures(['ENOSPC'], () =>
    assert.rejects(
      () => writeFileAtomic(target, '{"version":"permanent-error"}\n', {encoding: 'utf8'}),
      error => error?.code === 'ENOSPC',
      'permanent rename errors must surface without retry',
    ));
  assert.equal(permanentCalls, 1, 'permanent rename errors must not consume retry attempts');
  assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), {version: 'stable'}, 'permanent rename errors must preserve the prior complete artifact');
  await assertNoTempFiles(dir, 'permanent rename errors must clean up the temporary artifact');

  await writeJsonFileAtomic(target, {version: 'new', complete: true});
  assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), {version: 'new', complete: true}, 'a successful publish must expose one complete JSON artifact');

  await assert.rejects(
    () => writeFileAtomic(path.join(dir, 'uid-without-gid.json'), '{}\n', {uid: 0}),
    /uid and gid must be supplied together/,
  );
  await assert.rejects(
    () => writeFileAtomic(path.join(dir, 'gid-without-uid.json'), '{}\n', {gid: 0}),
    /uid and gid must be supplied together/,
  );

  if (process.platform !== 'win32') {
    const exactModeTarget = path.join(dir, 'exact-mode.json');
    let beforeRenameMode = null;
    const previousUmask = process.umask(0o077);
    try {
      await writeFileAtomic(exactModeTarget, '{"mode":"exact"}\n', {
        encoding: 'utf8',
        mode: 0o644,
        beforeRename: async tmp => {
          beforeRenameMode = (await fs.stat(tmp)).mode & 0o777;
        },
      });
    } finally {
      process.umask(previousUmask);
    }
    assert.equal(beforeRenameMode, 0o644,
      'the temporary artifact must already have exact mode 0644 before rename under umask 077');
    assert.equal((await fs.stat(exactModeTarget)).mode & 0o777, 0o644,
      'the published artifact must retain exact mode 0644 under umask 077');
  }
} finally {
  await fs.rm(dir, {recursive: true, force: true});
}

console.log('atomic_file_publish: durable exclusive-temp publish preserves complete bytes and exact metadata');
