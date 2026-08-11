#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

import {
  claimNext,
  completeClaim,
  enqueueSections,
  failClaim,
} from './manage_bi_portal_section_queue.mjs';

const start = new Date('2026-08-04T08:50:00.000Z');
const at = offsetMs => new Date(start.getTime() + offsetMs);

// ---- Same-priority batches are ordered by sequence (enqueue order), not by
// section name: a profit,homeProfit batch must always claim profit first so
// the homepage summary never derives from a missing or stale source.
{
  const queue = {version: 1, updatedAt: '', entries: []};
  enqueueSections(queue, {sections: ['profit', 'homeProfit'], priority: 50, reason: 'morning', now: at(0)});
  assert.equal(queue.entries.length, 2);
  const first = claimNext(queue, {leaseSeconds: 60, leaseId: 'lease-profit-1', now: at(1_000)});
  assert.equal(first.section, 'profit', 'profit must be claimed before homeProfit in the same batch');
  assert.equal(first.sequence < queue.entries.find(entry => entry.section === 'homeProfit').sequence, true);
  completeClaim(queue, {section: 'profit', leaseId: 'lease-profit-1', now: at(2_000)});
  const second = claimNext(queue, {leaseSeconds: 60, leaseId: 'lease-home-profit-1', now: at(3_000)});
  assert.equal(second.section, 'homeProfit');
}

// ---- Aging must not invert the profit -> homeProfit dependency. An old
// homeProfit request may age, but a newly queued dependency at priority 5
// still runs first; homeProfit would otherwise fail closed and waste a slot.
{
  const queue = {version: 1, updatedAt: '', entries: []};
  enqueueSections(queue, {sections: ['homeProfit'], priority: 10, now: at(0)});
  enqueueSections(queue, {sections: ['profit'], priority: 5, now: at(2 * 60 * 60_000)});
  const claim = claimNext(queue, {leaseSeconds: 60, leaseId: 'lease-profit-aged-dependency', now: at(2 * 60 * 60_000 + 1_000)});
  assert.equal(claim.section, 'profit', 'an aged homeProfit entry must never overtake its newly queued profit dependency');
}

// ---- Sequence tie-break beats section-name alphabetical order.
{
  const queue = {version: 1, updatedAt: '', entries: []};
  enqueueSections(queue, {sections: ['zeta', 'alpha'], priority: 50, now: at(0)});
  const claim = claimNext(queue, {leaseSeconds: 60, leaseId: 'lease-seq-1', now: at(1_000)});
  assert.equal(claim.section, 'zeta', 'same-priority entries must claim by sequence, not section name');
}

// ---- A failed section backs off deterministically; the next claim must go
// to another section and the failed one must stay unclaimable until
// nextAttemptAt.
{
  const queue = {version: 1, updatedAt: '', entries: []};
  enqueueSections(queue, {sections: ['profit', 'homeProfit'], priority: 50, now: at(0)});
  const profitClaim = claimNext(queue, {leaseSeconds: 60, leaseId: 'lease-profit-2', now: at(1_000)});
  assert.equal(profitClaim.section, 'profit');
  failClaim(queue, {
    section: 'profit',
    leaseId: 'lease-profit-2',
    error: 'refresh failed',
    now: at(2_000),
    backoffSeconds: 60,
  });
  const failed = queue.entries.find(entry => entry.section === 'profit');
  assert.equal(failed.status, 'pending');
  assert.equal(failed.nextAttemptAt, at(62_000).toISOString(), 'fail must set a deterministic nextAttemptAt');
  const next = claimNext(queue, {leaseSeconds: 60, leaseId: 'lease-home-profit-2', now: at(3_000)});
  assert.equal(next.section, 'homeProfit', 'a backed-off section must not block other work');
  assert.equal(claimNext(queue, {leaseSeconds: 60, leaseId: 'lease-none', now: at(4_000)}), null,
    'the failed section must not be immediately re-claimed by the same worker');
  const retried = claimNext(queue, {leaseSeconds: 60, leaseId: 'lease-profit-3', now: at(62_000)});
  assert.equal(retried.section, 'profit');
  assert.equal(retried.attempts, 2, 'backoff must not reset the attempt counter');
}

// ---- An explicit re-enqueue of a pending failed section is a fresh request
// and must override the old failure backoff immediately.
{
  const queue = {version: 1, updatedAt: '', entries: []};
  enqueueSections(queue, {sections: ['profit'], priority: 50, now: at(0)});
  claimNext(queue, {leaseSeconds: 60, leaseId: 'lease-profit-4', now: at(1_000)});
  failClaim(queue, {
    section: 'profit',
    leaseId: 'lease-profit-4',
    error: 'refresh failed',
    now: at(2_000),
    backoffSeconds: 60,
  });
  assert.equal(queue.entries[0].nextAttemptAt, at(62_000).toISOString());
  enqueueSections(queue, {sections: ['profit'], priority: 0, reason: 'operator retry', now: at(3_000)});
  assert.equal(queue.entries[0].nextAttemptAt, '', 'fresh re-enqueue must clear an earlier failure backoff');
  const retry = claimNext(queue, {leaseSeconds: 60, leaseId: 'lease-profit-5', now: at(4_000)});
  assert.equal(retry.section, 'profit');
  assert.equal(retry.requestRevision, 2);
}

// ---- A re-enqueue while running bumps requestRevision, keeps the lease, and
// complete for the old revision must release back to pending instead of
// deleting the newer request.
{
  const queue = {version: 1, updatedAt: '', entries: []};
  enqueueSections(queue, {sections: ['orders'], priority: 50, now: at(0)});
  const claim = claimNext(queue, {leaseSeconds: 60, leaseId: 'lease-orders-1', now: at(1_000)});
  assert.equal(claim.requestRevision, 1);
  assert.equal(claim.claimedRevision, 1);
  enqueueSections(queue, {sections: ['orders'], priority: 0, reason: 'force', now: at(2_000)});
  const running = queue.entries.find(entry => entry.section === 'orders');
  assert.equal(running.requestRevision, 2, 'running re-enqueue must bump requestRevision');
  assert.equal(running.rerun, true, 'running re-enqueue must mark the rerun');
  assert.equal(running.status, 'running', 'running re-enqueue must keep the active lease');
  const completed = completeClaim(queue, {section: 'orders', leaseId: 'lease-orders-1', now: at(3_000)});
  assert.equal(completed, false, 'complete of a superseded revision must not delete the entry');
  const afterComplete = queue.entries.find(entry => entry.section === 'orders');
  assert.ok(afterComplete, 'the entry must survive a superseded complete');
  assert.equal(afterComplete.status, 'pending', 'superseded complete must clear the lease back to pending');
  assert.equal(afterComplete.leaseId, '');
  assert.equal(afterComplete.nextAttemptAt, '', 'superseded complete must allow an immediate rerun');
  const rerun = claimNext(queue, {leaseSeconds: 60, leaseId: 'lease-orders-2', now: at(4_000)});
  assert.equal(rerun.requestRevision, 2, 'the rerun claim must process the newest revision');
  assert.equal(rerun.attempts, 2);
  assert.equal(rerun.rerun, false, 'claim of the newest revision must clear the rerun marker');
  assert.equal(completeClaim(queue, {section: 'orders', leaseId: 'lease-orders-2', now: at(5_000)}), true);
  assert.equal(queue.entries.some(entry => entry.section === 'orders'), false);
}

// ---- A re-enqueue while running also overrides fail backoff: the rerun is
// immediately claimable.
{
  const queue = {version: 1, updatedAt: '', entries: []};
  enqueueSections(queue, {sections: ['linksData'], priority: 50, now: at(0)});
  claimNext(queue, {leaseSeconds: 60, leaseId: 'lease-links-1', now: at(1_000)});
  enqueueSections(queue, {sections: ['linksData'], now: at(2_000)});
  failClaim(queue, {
    section: 'linksData',
    leaseId: 'lease-links-1',
    error: 'temporary',
    now: at(3_000),
    backoffSeconds: 60,
  });
  const entry = queue.entries.find(candidate => candidate.section === 'linksData');
  assert.equal(entry.nextAttemptAt, '', 'a newer requestRevision received during the lease must allow an immediate rerun');
  const rerun = claimNext(queue, {leaseSeconds: 60, leaseId: 'lease-links-2', now: at(4_000)});
  assert.equal(rerun.section, 'linksData');
  assert.equal(rerun.requestRevision, 2);
}

// ---- Legacy queue.json entries (no sequence/requestRevision/claimedRevision/
// nextAttemptAt) keep working through the CLI normalization path, including
// an in-flight lease left by the old code.
{
  const legacyTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-portal-section-queue-legacy-'));
  try {
    const legacyFile = path.join(legacyTemp, 'queue.json');
    fs.writeFileSync(legacyFile, JSON.stringify({
      version: 1,
      updatedAt: '',
      entries: [
        {
          section: 'orders',
          priority: 10,
          status: 'pending',
          requestedAt: at(0).toISOString(),
          updatedAt: at(0).toISOString(),
          reasons: ['legacy'],
          attempts: 1,
          leaseId: '',
          leaseExpiresAt: '',
          lastError: '',
        },
        {
          section: 'profit',
          priority: 10,
          status: 'running',
          requestedAt: at(0).toISOString(),
          updatedAt: at(0).toISOString(),
          reasons: ['legacy'],
          attempts: 1,
          leaseId: 'legacy-lease',
          leaseExpiresAt: '2099-01-01T00:00:00.000Z',
          lastError: '',
        },
      ],
    }, null, 2));
    const run = (...args) => spawnSync(process.execPath, [
      path.join(process.cwd(), 'scripts', 'manage_bi_portal_section_queue.mjs'),
      ...args,
      '--file', legacyFile,
    ], {cwd: process.cwd(), encoding: 'utf8'});
    const status = run('status');
    assert.equal(status.status, 0, status.stderr);
    const normalized = JSON.parse(status.stdout).entries;
    assert.ok(normalized.every(entry => Number.isSafeInteger(entry.sequence) && entry.sequence > 0),
      'legacy entries must receive a deterministic sequence');
    assert.equal(normalized.find(entry => entry.section === 'orders').requestRevision, 1);
    assert.equal(normalized.find(entry => entry.section === 'profit').claimedRevision, 1,
      'a legacy running entry must be treated as processing requestRevision 1');
    const claim = run('claim', '--lease-seconds', '60');
    assert.equal(claim.status, 0, claim.stderr);
    assert.equal(JSON.parse(claim.stdout).entry.section, 'orders', 'legacy entries must remain claimable in sequence order');
    const fail = run('fail', '--section', 'profit', '--lease-id', 'legacy-lease', '--backoff-seconds', '60');
    assert.equal(fail.status, 0, fail.stderr);
    const failedProfit = JSON.parse(fail.stdout).entries.find(entry => entry.section === 'profit');
    assert.equal(failedProfit.status, 'pending');
    assert.ok(Date.parse(failedProfit.nextAttemptAt) > Date.now(), 'a legacy failed entry must honor backoff');
    const empty = run('claim', '--lease-seconds', '60');
    assert.equal(empty.status, 75, 'no claimable entry may remain while the failed legacy entry backs off');
  } finally {
    fs.rmSync(legacyTemp, {recursive: true, force: true});
  }
}

// ---- Existing aging and priority semantics stay intact: aged background work
// must not starve, explicit owner priority beats an aged tie, and priority-0
// operator refresh stays ahead of everything.
{
  const queue = {version: 1, updatedAt: '', entries: []};
  enqueueSections(queue, {sections: ['profit', 'homeRankings'], priority: 50, reason: 'morning', now: at(0)});
  enqueueSections(queue, {sections: ['homeRankings', 'orders'], priority: 10, reason: 'live-return', now: at(1_000)});
  assert.equal(queue.entries.length, 3);
  assert.equal(queue.entries.find(entry => entry.section === 'homeRankings').priority, 10);
  assert.deepEqual(queue.entries.find(entry => entry.section === 'homeRankings').reasons, ['morning', 'live-return']);

  const first = claimNext(queue, {leaseSeconds: 60, leaseId: 'lease-1', now: at(2_000)});
  assert.equal(first.section, 'homeRankings');
  assert.equal(first.attempts, 1);
  completeClaim(queue, {section: 'homeRankings', leaseId: 'lease-1', now: at(2_500)});
  assert.equal(queue.entries.some(entry => entry.section === 'homeRankings'), false);

  const second = claimNext(queue, {leaseSeconds: 60, leaseId: 'lease-2', now: at(3_000)});
  assert.equal(second.section, 'orders');
  failClaim(queue, {section: 'orders', leaseId: 'lease-2', error: 'temporary', now: at(4_000), backoffSeconds: 0});
  assert.equal(queue.entries.find(entry => entry.section === 'orders').status, 'pending');

  const retried = claimNext(queue, {leaseSeconds: 60, leaseId: 'lease-3', now: at(5_000)});
  assert.equal(retried.section, 'orders');
  assert.equal(retried.attempts, 2);

  // Let the lease expire without completing: recovery must re-issue it.
  const recovered = claimNext(queue, {leaseSeconds: 60, leaseId: 'lease-4', now: at(70_000)});
  assert.equal(recovered.section, 'orders');
  assert.equal(recovered.attempts, 3);

  const defaultLeaseQueue = {version: 1, updatedAt: '', entries: []};
  enqueueSections(defaultLeaseQueue, {sections: ['orders'], now: at(0)});
  const defaultLease = claimNext(defaultLeaseQueue, {now: at(1_000)});
  assert.match(defaultLease.leaseId, /^[0-9a-f-]{36}$/i);
}

// ---- Starvation, effective-priority tie, and forced priority-0 semantics.
{
  const starvationQueue = {version: 1, updatedAt: '', entries: []};
  enqueueSections(starvationQueue, {sections: ['oldBackground'], priority: 50, now: at(0)});
  enqueueSections(starvationQueue, {sections: ['freshAccounting'], priority: 10, now: at(100 * 60_000)});
  const agedClaim = claimNext(starvationQueue, {
    leaseSeconds: 60,
    leaseId: 'lease-aged',
    now: at(101 * 60_000),
  });
  assert.equal(agedClaim.section, 'oldBackground', 'aged background work must not starve behind recurring fresh accounting work');

  const tieQueue = {version: 1, updatedAt: '', entries: []};
  enqueueSections(tieQueue, {sections: ['olderBackground'], priority: 50, now: at(0)});
  enqueueSections(tieQueue, {sections: ['newerOwnerView'], priority: 10, now: at(80 * 60_000)});
  const tieClaim = claimNext(tieQueue, {
    leaseSeconds: 60,
    leaseId: 'lease-tie',
    now: at(100 * 60_000),
  });
  assert.equal(tieClaim.section, 'newerOwnerView', 'when effective priorities tie, explicit owner priority must beat older background priority');

  const forcedQueue = {version: 1, updatedAt: '', entries: []};
  enqueueSections(forcedQueue, {sections: ['veryOldBackground'], priority: 50, now: at(0)});
  enqueueSections(forcedQueue, {sections: ['ownerForced'], priority: 0, now: at(10 * 60 * 60_000)});
  const forcedClaim = claimNext(forcedQueue, {
    leaseSeconds: 60,
    leaseId: 'lease-forced',
    now: at(10 * 60 * 60_000 + 1_000),
  });
  assert.equal(forcedClaim.section, 'ownerForced', 'explicit owner refresh must remain ahead of aged background work');
}

// ---- Lease mismatch and section-name validation stay fail-closed.
{
  const queue = {version: 1, updatedAt: '', entries: []};
  enqueueSections(queue, {sections: ['orders'], now: at(0)});
  claimNext(queue, {leaseSeconds: 60, leaseId: 'lease-ok', now: at(1_000)});
  assert.throws(() => completeClaim(queue, {section: 'orders', leaseId: 'lease-wrong'}), /QUEUE_LEASE_MISMATCH/);
  assert.throws(() => failClaim(queue, {section: 'orders', leaseId: 'lease-wrong'}), /QUEUE_LEASE_MISMATCH/);
  assert.throws(() => enqueueSections(queue, {sections: ['../escape']}), /SECTION_INVALID/);
}

// ---- CLI round trip: enqueue, claim, superseded complete, fail with
// backoff, status repair of a broken lease.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-portal-section-queue-'));
try {
  const queueFile = path.join(temp, 'queue.json');
  const run = (...args) => spawnSync(process.execPath, [
    path.join(process.cwd(), 'scripts', 'manage_bi_portal_section_queue.mjs'),
    ...args,
    '--file', queueFile,
  ], {cwd: process.cwd(), encoding: 'utf8'});
  const enqueue = run('enqueue', '--sections', 'orders');
  assert.equal(enqueue.status, 0, enqueue.stderr);
  assert.equal(JSON.parse(enqueue.stdout).entries[0].requestRevision, 1);
  const claim = run('claim', '--lease-seconds', '60');
  assert.equal(claim.status, 0, claim.stderr);
  const claimPayload = JSON.parse(claim.stdout);
  assert.match(claimPayload.entry.leaseId, /^[0-9a-f-]{36}$/i);
  const leaseId = claimPayload.entry.leaseId;

  const reenqueue = run('enqueue', '--sections', 'orders', '--priority', '0');
  assert.equal(reenqueue.status, 0, reenqueue.stderr);
  const superseded = run('complete', '--section', 'orders', '--lease-id', leaseId);
  assert.equal(superseded.status, 0, superseded.stderr);
  const supersededPayload = JSON.parse(superseded.stdout);
  assert.equal(supersededPayload.completed, false, 'CLI complete of a superseded revision must report not completed');
  assert.equal(supersededPayload.entries[0].status, 'pending');
  assert.equal(supersededPayload.entries[0].requestRevision, 2);

  const claimAgain = run('claim', '--lease-seconds', '60');
  assert.equal(claimAgain.status, 0, claimAgain.stderr);
  const fail = run('fail', '--section', 'orders', '--lease-id', JSON.parse(claimAgain.stdout).entry.leaseId, '--backoff-seconds', '60');
  assert.equal(fail.status, 0, fail.stderr);
  const failedEntry = JSON.parse(fail.stdout).entries[0];
  assert.equal(failedEntry.status, 'pending');
  assert.ok(Date.parse(failedEntry.nextAttemptAt) > Date.now(), 'CLI fail must persist a future nextAttemptAt');

  const emptyClaim = run('claim', '--lease-seconds', '60');
  assert.equal(emptyClaim.status, 75, 'a backed-off queue must report no claimable entry');

  const broken = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
  broken.entries[0].status = 'running';
  broken.entries[0].leaseId = '';
  broken.entries[0].leaseExpiresAt = '2099-01-01T00:00:00.000Z';
  broken.entries[0].nextAttemptAt = '';
  fs.writeFileSync(queueFile, `${JSON.stringify(broken, null, 2)}\n`);
  const status = run('status');
  assert.equal(status.status, 0, status.stderr);
  const repaired = JSON.parse(status.stdout);
  assert.equal(repaired.entries[0].status, 'pending');
  assert.equal(repaired.entries[0].leaseExpiresAt, '');
} finally {
  fs.rmSync(temp, {recursive: true, force: true});
}

console.log('bi_portal_section_queue: sequence/revision/backoff reliability invariants passed');
