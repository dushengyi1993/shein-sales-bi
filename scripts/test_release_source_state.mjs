#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {inspectReleaseSourceState} from './check_release_source_state.mjs';

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'shein-release-state-'));
try {
  git(tmp, ['init', '-q']);
  git(tmp, ['config', 'user.name', 'Release State Test']);
  git(tmp, ['config', 'user.email', 'release-state@example.invalid']);
  await fs.writeFile(path.join(tmp, 'tracked.txt'), 'v1\n');
  git(tmp, ['add', 'tracked.txt']);
  git(tmp, ['commit', '-q', '-m', 'fixture']);
  const head = git(tmp, ['rev-parse', 'HEAD']);

  const clean = inspectReleaseSourceState({cwd: tmp, expectedCommit: head});
  assert.equal(clean.ok, true);

  git(tmp, ['update-index', '--skip-worktree', '--', 'tracked.txt']);
  await fs.rm(path.join(tmp, 'tracked.txt'));
  const hiddenMissing = inspectReleaseSourceState({cwd: tmp, expectedCommit: head});
  assert.equal(hiddenMissing.ok, false);
  assert.deepEqual(hiddenMissing.hiddenIndexEntries, ['tracked.txt']);
  assert.deepEqual(hiddenMissing.missingTrackedFiles, ['tracked.txt']);

  git(tmp, ['update-index', '--no-skip-worktree', '--', 'tracked.txt']);
  git(tmp, ['checkout', '--', 'tracked.txt']);
  await fs.writeFile(path.join(tmp, 'tracked.txt'), 'dirty\n');
  const dirty = inspectReleaseSourceState({cwd: tmp, expectedCommit: head});
  assert.equal(dirty.ok, false);
  assert.equal(dirty.dirtyEntries.length, 1);

  console.log(JSON.stringify({ok: true}, null, 2));
} finally {
  await fs.rm(tmp, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
}
