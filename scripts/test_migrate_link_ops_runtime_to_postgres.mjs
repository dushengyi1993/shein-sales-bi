#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'link-ops-migration-test-'));
const taskFile = path.join(temp, 'tasks.json');
const chatFile = path.join(temp, 'chats.json');
const actionFile = path.join(temp, 'actions.json');
const manifestFile = path.join(temp, 'manifest.json');

async function write(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function run(extra = []) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [
      'scripts/migrate_link_ops_runtime_to_postgres.mjs',
      '--dry-run',
      '--task-file', taskFile,
      '--chat-file', chatFile,
      '--action-file', actionFile,
      '--manifest-out', manifestFile,
      ...extra,
    ], {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('close', code => resolve({code, stdout, stderr}));
  });
}

try {
  await write(chatFile, {
    version: 1,
    sessions: [{
      id: 'session-1',
      requestedByUser: 'alice',
      status: 'chatting',
      messages: [{id: 'message-1', role: 'user', content: 'hello'}],
    }],
  });
  await write(taskFile, {
    version: 1,
    tasks: [{id: 'task-1', requestedByUser: 'alice', chatSessionId: 'session-1', status: 'draft'}],
  });
  await write(actionFile, {
    version: 1,
    actions: {'DL|inventory|SKU-1': {status: 'review', updatedByUser: 'alice'}},
  });

  const good = await run();
  assert.equal(good.code, 0, good.stderr);
  const output = JSON.parse(good.stdout);
  assert.equal(output.mode, 'dry-run');
  assert.deepEqual(output.manifest.counts, {tasks: 1, sessions: 1, messages: 1, actions: 1});
  assert.deepEqual(output.manifest.sourceCounts, {tasks: 1, sessions: 1, messages: 1, actions: 1});
  assert.deepEqual(output.manifest.skippedLegacyConversations, {enabled: false, tasks: 0, sessions: 0, messages: 0});
  assert.deepEqual(output.manifest.owners, ['alice']);
  assert.deepEqual(output.manifest.quarantine, {ownerUser: 'quarantine:legacy-runtime', tasks: 0, sessions: 0, messages: 0, actions: 0});
  assert.deepEqual(output.manifest.detachedOrphanSessions, {tasks: 0, uniqueSessions: 0, taskIds: []});
  assert.match(output.manifest.manifestHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse(await fs.readFile(manifestFile, 'utf8')), output.manifest);

  const fresh = await run(['--skip-legacy-conversations']);
  assert.equal(fresh.code, 0, fresh.stderr);
  const freshManifest = JSON.parse(fresh.stdout).manifest;
  assert.deepEqual(freshManifest.counts, {tasks: 0, sessions: 0, messages: 0, actions: 1});
  assert.deepEqual(freshManifest.sourceCounts, {tasks: 1, sessions: 1, messages: 1, actions: 1});
  assert.deepEqual(freshManifest.skippedLegacyConversations, {enabled: true, tasks: 1, sessions: 1, messages: 1});
  assert.deepEqual(freshManifest.owners, ['alice']);

  await write(taskFile, {
    version: 1,
    tasks: [{id: 'task-legacy', requestedByUser: '127.0.0.1', status: 'draft'}],
  });
  const quarantined = await run();
  assert.equal(quarantined.code, 0, quarantined.stderr);
  const quarantineManifest = JSON.parse(quarantined.stdout).manifest;
  assert.deepEqual(quarantineManifest.owners.sort(), ['alice', 'quarantine:legacy-runtime']);
  assert.equal(quarantineManifest.quarantine.tasks, 1);

  const unsafeFallback = await run(['--default-owner', 'owner-user']);
  assert.notEqual(unsafeFallback.code, 0);
  assert.match(unsafeFallback.stderr, /removed because it could assign anonymous history/);

  const unsafeQuarantineName = await run(['--quarantine-owner', 'owner-user']);
  assert.notEqual(unsafeQuarantineName.code, 0);
  assert.match(unsafeQuarantineName.stderr, /quarantine:<name>/);

  await write(taskFile, {
    version: 1,
    tasks: [{id: 'task-orphan', requestedByUser: 'alice', chatSessionId: 'missing-session'}],
  });
  const orphan = await run();
  assert.equal(orphan.code, 0, orphan.stderr);
  const orphanManifest = JSON.parse(orphan.stdout).manifest;
  assert.deepEqual(orphanManifest.detachedOrphanSessions, {tasks: 1, uniqueSessions: 1, taskIds: ['task-orphan']});

  console.log('migrate_link_ops_runtime_to_postgres: strict dry-run manifest, owner quarantine, hashes, and FK validation passed');
} finally {
  await fs.rm(temp, {recursive: true, force: true});
}
