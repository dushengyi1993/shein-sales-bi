#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = path.join(root, 'tmp', `marketing-repair-queue-cas-${process.pid}`);
const queuePath = path.join(fixtureRoot, 'marketing-repair-queue.json');
const manager = 'scripts/marketing/manage_marketing_repair_queue.mjs';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stateSha256(bytes) {
  return sha256(bytes);
}

function pair(queue, queueStateSha256) {
  assert.match(String(queueStateSha256 || ''), /^[a-f0-9]{64}$/, 'fixture must carry exact queue state SHA-256');
  return [
    '--expected-queue-fingerprint', queue.queueFingerprint,
    '--expected-source-guard-hash', queue.sourceGuardHash,
    '--expected-queue-state-sha256', queueStateSha256,
  ];
}

function queueFixture({queueFingerprint, sourceGuardHash, status = 'pending', marker}) {
  return {
    schemaVersion: 1,
    date: '2026-08-24',
    status,
    sourceGuard: 'fixture-guard.json',
    sourceGuardHash,
    queueFingerprint,
    marker,
    counts: {totalRows: 1, totalGroups: 1},
    stages: {
      fallbackRepair: {
        status: 'pending',
        rows: 1,
        groups: 1,
        inputFingerprint: sha256(`input-${marker}`),
        workFingerprint: sha256(`work-${marker}`),
      },
    },
  };
}

async function writeQueue(queue) {
  await fs.mkdir(fixtureRoot, {recursive: true});
  const bytes = `${JSON.stringify(queue, null, 2)}\n`;
  await fs.writeFile(queuePath, bytes, 'utf8');
  return stateSha256(bytes);
}

function invoke(...args) {
  return spawnSync(process.execPath, [manager, ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

function invokeAsync(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [manager, ...args], {
      cwd: root,
      env: {...process.env, ...env},
      encoding: 'utf8',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', status => resolve({status, stdout, stderr}));
  });
}

function assertCasFailure(result, label) {
  assert.equal(result.status, 73, `${label} must fail with stable CAS exit 73`);
  assert.match(`${result.stdout}\n${result.stderr}`, /QUEUE_CAS_CONFLICT/);
  assert.match(`${result.stdout}\n${result.stderr}`, /Queue CAS conflict/);
}

const pairA = {
  queueFingerprint: sha256('queue-A'),
  sourceGuardHash: sha256('guard-A'),
};
const pairB = {
  queueFingerprint: sha256('queue-B'),
  sourceGuardHash: sha256('guard-B'),
};

try {
  const queueA = queueFixture({...pairA, marker: 'A'});
  const queueB = queueFixture({...pairB, marker: 'B'});
  const queueStateA = await writeQueue(queueA);

  const missingUpdatePair = invoke(
    'update-stage', '--queue', queuePath, '--stage', 'fallbackRepair', '--status', 'completed',
  );
  assert.equal(missingUpdatePair.status, 1, 'non-CAS validation errors must keep exit 1');
  assert.match(`${missingUpdatePair.stdout}\n${missingUpdatePair.stderr}`, /Missing --expected-queue-fingerprint/);

  // Simulate worker A reading its pair, then a publisher replacing the queue
  // with B before A attempts its stage update.
  const stalePairA = pair(queueA, queueStateA);
  const queueStateB = await writeQueue(queueB);
  const queueBBytesBeforeStaleUpdate = await fs.readFile(queuePath, 'utf8');
  const staleUpdate = invoke(
    'update-stage', '--queue', queuePath, '--stage', 'fallbackRepair', '--status', 'completed',
    '--readback-ok', 'true', ...stalePairA,
  );
  assertCasFailure(staleUpdate, 'stale update-stage');
  assert.equal(await fs.readFile(queuePath, 'utf8'), queueBBytesBeforeStaleUpdate, 'stale update must not rewrite queue B');
  assert.equal(JSON.parse(queueBBytesBeforeStaleUpdate).stages.fallbackRepair.status, 'pending');

  const normalUpdate = invoke(
    'update-stage', '--queue', queuePath, '--stage', 'fallbackRepair', '--status', 'completed',
    '--readback-ok', 'true', ...pair(queueB, queueStateB),
  );
  assert.equal(normalUpdate.status, 0, normalUpdate.stderr || normalUpdate.stdout);
  const queueAfterNormal = JSON.parse(await fs.readFile(queuePath, 'utf8'));
  const queueStateAfterNormal = stateSha256(await fs.readFile(queuePath));
  assert.equal(queueAfterNormal.stages.fallbackRepair.status, 'completed');
  assert.equal(queueAfterNormal.queueFingerprint, pairB.queueFingerprint, 'normal update preserves queue identity');
  assert.equal(queueAfterNormal.sourceGuardHash, pairB.sourceGuardHash, 'normal update preserves source guard identity');

  // A second managed writer cannot enter the queue mutation critical section
  // while the first writer is between its final read and atomic rename.
  const beforeRenameMarker = path.join(fixtureRoot, 'before-rename.marker');
  const concurrentArgs = [
    'update-stage', '--queue', queuePath, '--stage', 'fallbackRepair', '--status', 'blocked',
    '--readback-ok', 'false', ...pair(queueAfterNormal, queueStateAfterNormal),
  ];
  const firstConcurrent = invokeAsync(concurrentArgs, {
    NODE_ENV: 'test',
    SHEIN_MARKETING_REPAIR_QUEUE_TEST_HOLD_BEFORE_RENAME_MS: '350',
    SHEIN_MARKETING_REPAIR_QUEUE_TEST_BEFORE_RENAME_MARKER: beforeRenameMarker,
  });
  const markerDeadline = Date.now() + 3000;
  while (!await fs.access(beforeRenameMarker).then(() => true).catch(() => false)) {
    if (Date.now() >= markerDeadline) throw new Error('concurrent CAS fixture did not reach before-rename hold');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const concurrentSecond = invoke(...concurrentArgs);
  assert.equal(concurrentSecond.status, 75, 'concurrent queue writer must fail while mutation lock is held');
  const firstConcurrentResult = await firstConcurrent;
  assert.equal(firstConcurrentResult.status, 0, firstConcurrentResult.stderr || firstConcurrentResult.stdout);
  const queueBytesAfterConcurrent = await fs.readFile(queuePath);
  const queueAfterConcurrent = JSON.parse(queueBytesAfterConcurrent.toString('utf8'));
  const queueStateAfterConcurrent = stateSha256(queueBytesAfterConcurrent);
  assert.equal(queueAfterConcurrent.stages.fallbackRepair.status, 'blocked', 'first writer commits its stage exactly once');
  const staleAfterConcurrent = invoke(...concurrentArgs);
  assertCasFailure(staleAfterConcurrent, 'stale full-state CAS after concurrent commit');
  assert.equal(JSON.parse(await fs.readFile(queuePath, 'utf8')).stages.fallbackRepair.status, 'blocked');

  const queueAfterNormalUpdate = await fs.readFile(queuePath, 'utf8');
  const wrongSourceGuard = invoke(
    'update-stage', '--queue', queuePath, '--stage', 'fallbackRepair', '--status', 'blocked',
    '--readback-ok', 'false', '--expected-queue-fingerprint', pairB.queueFingerprint,
    '--expected-source-guard-hash', pairA.sourceGuardHash,
    '--expected-queue-state-sha256', queueStateAfterConcurrent,
  );
  assertCasFailure(wrongSourceGuard, 'wrong sourceGuardHash update-stage');
  assert.equal(await fs.readFile(queuePath, 'utf8'), queueAfterNormalUpdate, 'wrong sourceGuardHash must not rewrite queue');

  // Repeat the ABA check for the local handoff mutation.
  const handoffA = queueFixture({...pairA, marker: 'handoff-A'});
  const handoffB = queueFixture({...pairB, marker: 'handoff-B'});
  const handoffStateA = await writeQueue(handoffA);
  const missingHandoffPair = invoke('handoff-local', '--queue', queuePath, '--reason', 'fixture handoff');
  assert.equal(missingHandoffPair.status, 1, 'non-CAS validation errors must keep exit 1');
  assert.match(`${missingHandoffPair.stdout}\n${missingHandoffPair.stderr}`, /Missing --expected-queue-fingerprint/);
  const staleHandoffPairA = pair(handoffA, handoffStateA);
  const handoffStateB = await writeQueue(handoffB);
  const queueBBytesBeforeStaleHandoff = await fs.readFile(queuePath, 'utf8');
  const staleHandoff = invoke(
    'handoff-local', '--queue', queuePath, '--reason', 'fixture handoff', ...staleHandoffPairA,
  );
  assertCasFailure(staleHandoff, 'stale handoff-local');
  assert.equal(await fs.readFile(queuePath, 'utf8'), queueBBytesBeforeStaleHandoff, 'stale handoff must not rewrite queue B');
  assert.equal(JSON.parse(queueBBytesBeforeStaleHandoff).status, 'pending');

  const normalHandoff = invoke(
    'handoff-local', '--queue', queuePath, '--reason', 'fixture handoff', ...pair(handoffB, handoffStateB),
  );
  assert.equal(normalHandoff.status, 0, normalHandoff.stderr || normalHandoff.stdout);
  assert.equal(JSON.parse(await fs.readFile(queuePath, 'utf8')).status, 'deferred_to_local');

  console.log(JSON.stringify({
    ok: true,
    rejectsStaleUpdateAfterQueueReplacement: true,
    preservesQueueBBytesAndState: true,
    acceptsNormalUpdate: true,
    concurrentWriterCannotEnterMutationLock: true,
    rejectsStaleFullStateCasAfterConcurrentCommit: true,
    preservesExactQueueIdentityAfterNormalUpdate: true,
    rejectsWrongSourceGuardHash: true,
    rejectsStaleHandoffAfterQueueReplacement: true,
    acceptsNormalHandoff: true,
  }));
} finally {
  await fs.rm(fixtureRoot, {recursive: true, force: true});
}
