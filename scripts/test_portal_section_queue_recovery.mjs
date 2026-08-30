#!/usr/bin/env node

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  claimNext,
  completeClaim,
  enqueueSections,
} from './manage_bi_portal_section_queue.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 1) Status durably recovers an expired lease so a later process sees pending
// work instead of the stale running owner.
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-queue-recovery-'));
  const queueFile = path.join(tmpDir, 'queue.json');
  try {
    const initialContent = JSON.stringify({
      version: 1,
      updatedAt: '2026-08-30T00:00:00.000Z',
      nextSequence: 1,
      entries: [
        {
          section: 'orders',
          status: 'running',
          leaseId: 'expired-lease-123',
          leaseExpiresAt: '2026-08-30T00:01:00.000Z',
          requestRevision: 1,
          claimedRevision: 1,
          coreGeneratedAt: 'G1',
        },
      ],
      publishedSnapshots: [],
    }, null, 2) + '\n';

    fs.writeFileSync(queueFile, initialContent, 'utf8');
    const first = spawnSync('node', [
      path.join(root, 'scripts', 'manage_bi_portal_section_queue.mjs'),
      'status',
      '--file',
      queueFile,
    ], {encoding: 'utf8'});
    assert.equal(first.status, 0, `first status command failed: ${first.stderr}`);
    const firstStatus = JSON.parse(first.stdout);
    assert.equal(firstStatus.entries[0].status, 'pending');
    assert.equal(firstStatus.entries[0].leaseId, '');

    const persisted = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
    assert.equal(persisted.entries[0].status, 'pending', 'recovery must be written to disk');
    assert.equal(persisted.entries[0].leaseId, '');

    const second = spawnSync('node', [
      path.join(root, 'scripts', 'manage_bi_portal_section_queue.mjs'),
      'status',
      '--file',
      queueFile,
    ], {encoding: 'utf8'});
    assert.equal(second.status, 0, `second status command failed: ${second.stderr}`);
    assert.equal(JSON.parse(second.stdout).entries[0].status, 'pending');
  } finally {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
}

// 2) Production unit points to canonical /data/shein-bi/state/portal-section-queue/queue.json
{
  const unitFile = path.join(root, 'infra', 'systemd', 'shein-bi-cloud-portal-section-queue.service');
  const unitText = fs.readFileSync(unitFile, 'utf8');
  assert.match(unitText, /Environment=SHEIN_BI_PORTAL_SECTION_QUEUE_FILE=\/data\/shein-bi\/state\/portal-section-queue\/queue\.json/,
    'production unit must point to canonical /data/shein-bi/state/portal-section-queue/queue.json');
}

// 3) Heavy productSalesDaily gets >=360s useful budget and leaves >=30s terminal readback.
{
  const workerFile = path.join(root, 'scripts', 'cloud_portal_section_queue_worker.sh');
  const workerText = fs.readFileSync(workerFile, 'utf8');
  assert.match(workerText, /PRODUCT_SALES_DAILY_MIN_RUNTIME_SEC=.*360/,
    'worker must configure productSalesDaily budget >=360s');
  assert.match(workerText, /defer heavy section=productSalesDaily/,
    'worker must enforce productSalesDaily runtime budget');
  assert.match(workerText, /MAX_CURL_RUNTIME=\$\(\(\s*REMAINING_SEC\s*-\s*30\s*\)\)/,
    'worker must reserve >=30s for terminal readback and completion before deadline');
}

// 4) Idempotency / Crash Recovery: no duplicate same revision execution.
{
  const queue = {version: 1, updatedAt: '', nextSequence: 0, entries: [], publishedSnapshots: []};
  enqueueSections(queue, {
    sections: ['orders'],
    priority: 10,
    coreGeneratedAt: 'G1',
  });

  const claim1 = claimNext(queue, {leaseSeconds: 60, now: new Date('2026-08-30T00:00:00.000Z')});
  assert.equal(claim1?.section, 'orders');
  assert.equal(claim1?.claimedRevision, 1);

  // Simulate publish & complete
  completeClaim(queue, {
    section: 'orders',
    leaseId: claim1.leaseId,
    expectedGeneratedAt: 'G1',
    now: new Date('2026-08-30T00:00:05.000Z'),
  });
  assert.equal(queue.publishedSnapshots.length, 1);
  assert.equal(queue.publishedSnapshots[0].section, 'orders');
  assert.equal(queue.publishedSnapshots[0].publishedRevision, 1);

  // Suppose an old pending entry with revision 1 exists or is recovered after crash
  queue.entries.push({
    section: 'orders',
    status: 'pending',
    requestRevision: 1,
    lastPublishedRevision: 1,
    coreGeneratedAt: 'G1',
  });

  // Next claim must not duplicate the already-published revision
  const claim2 = claimNext(queue, {leaseSeconds: 60, now: new Date('2026-08-30T00:01:00.000Z')});
  assert.equal(claim2, null, 'claimNext must prune/skip already-published revisions and avoid duplicate execution');
  assert.equal(queue.publishedSnapshots.length, 1, 'durable publication audit must remain after pruning the stale active copy');
}

console.log('test_portal_section_queue_recovery: all 4 contracts verified successfully');
