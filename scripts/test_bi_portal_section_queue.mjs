#!/usr/bin/env node

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

import {
  claimNext,
  completeClaim,
  enqueueSections as enqueueSectionsWithGeneration,
  failClaim,
} from './manage_bi_portal_section_queue.mjs';

const start = new Date('2026-08-04T08:50:00.000Z');
const at = offsetMs => new Date(start.getTime() + offsetMs);
const enqueueSections = (queue, options = {}) => enqueueSectionsWithGeneration(queue, {
  coreGeneratedAt: 'G1',
  ...options,
});
const terminalEvidenceArgs = (generatedAt, identity = 'a'.repeat(64)) => [
  '--expected-generated-at', generatedAt,
  '--terminal-generated-at', generatedAt,
  '--terminal-section-generated-at', generatedAt,
  '--terminal-generation-identity', identity,
];

function queueFileSnapshot(file) {
  const bytes = fs.readFileSync(file);
  return {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function assertQueueFileUnchanged(file, before, label) {
  const after = queueFileSnapshot(file);
  assert.deepEqual(after.bytes, before.bytes, `${label}: queue bytes changed`);
  assert.equal(after.sha256, before.sha256, `${label}: queue hash changed`);
}

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
  enqueueSections(queue, {sections: ['orders', 'afterSales'], priority: 10, now: at(0)});
  enqueueSections(queue, {sections: ['productSalesDaily'], priority: 50, now: at(1_000)});
  const heavy = claimNext(queue, {
    leaseSeconds: 60,
    leaseId: 'lease-heavy-first-product-sales-daily',
    preferSections: ['profit', 'productSalesDaily', 'homeRankings'],
    now: at(2_000),
  });
  assert.equal(heavy.section, 'productSalesDaily',
    'the :32 heavy slot must be able to claim productSalesDaily before hot light accounting work');
  failClaim(queue, {section: 'productSalesDaily', leaseId: heavy.leaseId, now: at(3_000)});
  const backedOff = queue.entries.find(entry => entry.section === 'productSalesDaily');
  assert.equal(backedOff.status, 'pending');
  assert.ok(Date.parse(backedOff.nextAttemptAt) > at(3_000).getTime(),
    'a failed heavy claim must back off instead of causing a same-slot retry storm');
  const light = claimNext(queue, {
    leaseSeconds: 60,
    leaseId: 'lease-light-after-heavy-failure',
    excludeSections: ['profit', 'productSalesDaily', 'homeRankings'],
    preferSections: ['profit', 'productSalesDaily', 'homeRankings'],
    now: at(4_000),
  });
  assert.equal(light.section, 'orders',
    'the light slot exclusion must still beat heavy-first preference');
}

// ---- Sequence tie-break beats section-name alphabetical order.
{
  const queue = {version: 1, updatedAt: '', entries: []};
  enqueueSections(queue, {sections: ['zeta', 'alpha'], priority: 50, now: at(0)});
  const claim = claimNext(queue, {leaseSeconds: 60, leaseId: 'lease-seq-1', now: at(1_000)});
  assert.equal(claim.section, 'zeta', 'same-priority entries must claim by sequence, not section name');
}

// ---- A failed profit section backs off deterministically and keeps its
// dependent homepage section blocked until canonical accounting succeeds.
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
  assert.equal(claimNext(queue, {leaseSeconds: 60, leaseId: 'lease-none', now: at(3_000)}), null,
    'a backed-off profit refresh must keep homeProfit fail-closed');
  const retried = claimNext(queue, {leaseSeconds: 60, leaseId: 'lease-profit-3', now: at(62_000)});
  assert.equal(retried.section, 'profit');
  assert.equal(retried.attempts, 2, 'backoff must not reset the attempt counter');
  completeClaim(queue, {section: 'profit', leaseId: 'lease-profit-3', now: at(62_500)});
  const next = claimNext(queue, {leaseSeconds: 60, leaseId: 'lease-home-profit-2', now: at(63_000)});
  assert.equal(next.section, 'homeProfit', 'homeProfit may continue after canonical profit completes');
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
// a successful old revision is published while exactly one newer follow-up
// remains pending instead of being discarded as "complete superseded".
{
  const queue = {version: 1, updatedAt: '', entries: []};
  enqueueSections(queue, {sections: ['orders'], priority: 50, now: at(0)});
  const claim = claimNext(queue, {leaseSeconds: 60, leaseId: 'lease-orders-1', now: at(1_000)});
  assert.equal(claim.requestRevision, 1);
  assert.equal(claim.claimedRevision, 1);
  enqueueSections(queue, {sections: ['orders'], priority: 0, reason: 'force', now: at(2_000)});
  for (let index = 0; index < 20; index += 1) {
    enqueueSections(queue, {sections: ['orders'], priority: 0, reason: `burst-${index}`, now: at(2_100 + index)});
  }
  const running = queue.entries.find(entry => entry.section === 'orders');
  assert.equal(running.requestRevision, 2, 'running re-enqueue must bump requestRevision');
  assert.equal(running.rerun, true, 'running re-enqueue must mark the rerun');
  assert.equal(running.reasons.length, 21, 'coalesced events retain audit reasons without creating more rerun revisions');
  assert.equal(running.status, 'running', 'running re-enqueue must keep the active lease');
  const completed = completeClaim(queue, {section: 'orders', leaseId: 'lease-orders-1', now: at(3_000)});
  assert.equal(completed, true, 'a successful superseded revision must still be recorded as published');
  const afterComplete = queue.entries.find(entry => entry.section === 'orders');
  assert.ok(afterComplete, 'the newer follow-up entry must survive the published complete');
  assert.equal(afterComplete.status, 'pending', 'published complete must clear the lease back to pending');
  assert.equal(afterComplete.leaseId, '');
  assert.equal(afterComplete.leaseExpiresAt, '');
  assert.equal(afterComplete.claimedRevision, 0, 'a pending follow-up must not retain the completed claim revision');
  assert.equal(afterComplete.claimedIdempotencyKey, '', 'a pending follow-up must not retain the completed claim key');
  assert.equal(afterComplete.claimedCoreGeneratedAt, '', 'a pending follow-up must not retain the completed claim generation');
  assert.equal(afterComplete.nextAttemptAt, '', 'published complete must allow an immediate rerun');
  assert.equal(afterComplete.lastPublishedRevision, 1, 'the claimed revision must be the last published snapshot');
  assert.equal(afterComplete.requestRevision, 2, 'the newer request remains the desired revision');
  assert.equal(queue.publishedSnapshots.some(snapshot => (
    snapshot.section === 'orders' && snapshot.publishedRevision === 1
  )), true, 'the successful claimed revision must be durable publication evidence');
  assert.equal(queue.completedIdempotency.length, 0, 'an unkeyed published snapshot must not invent an idempotency tombstone');
  const rerun = claimNext(queue, {leaseSeconds: 60, leaseId: 'lease-orders-2', now: at(4_000)});
  assert.equal(rerun.requestRevision, 2, 'the rerun claim must process the newest revision');
  assert.equal(rerun.attempts, 2);
  assert.equal(rerun.rerun, false, 'claim of the newest revision must clear the rerun marker');
  assert.equal(rerun.lastPublishedRevision, 1);
  assert.equal(completeClaim(queue, {section: 'orders', leaseId: 'lease-orders-2', now: at(5_000)}), true);
  assert.equal(queue.entries.some(entry => entry.section === 'orders'), false);
  assert.equal(queue.publishedSnapshots.find(snapshot => snapshot.section === 'orders')?.publishedRevision, 2);
}

// ---- A changed request key during a running claim must tombstone only the
// claimed request, preserve one coalesced follow-up, and expose the published
// versus desired revision split in status/health.
{
  const queue = {version: 1, updatedAt: '', entries: [], completedIdempotency: []};
  enqueueSections(queue, {
    sections: ['orders'], priority: 10, idempotencyKey: 'run:A', coalesceKey: 'live:G1', now: at(0),
  });
  const claim = claimNext(queue, {leaseSeconds: 60, leaseId: 'lease-publish-A', now: at(1_000)});
  enqueueSections(queue, {
    sections: ['orders'], priority: 10, idempotencyKey: 'run:B', coalesceKey: 'live:G1', now: at(2_000),
  });
  const published = completeClaim(queue, {section: 'orders', leaseId: claim.leaseId, now: at(3_000)});
  assert.equal(published, true);
  assert.equal(queue.entries.length, 1, 'publication must leave one, not multiple, follow-up entries');
  const followUp = queue.entries[0];
  assert.equal(followUp.requestRevision, 2);
  assert.equal(followUp.lastPublishedRevision, 1);
  assert.equal(followUp.status, 'pending');
  assert.equal(followUp.leaseId, '');
  assert.equal(followUp.leaseExpiresAt, '');
  assert.equal(followUp.claimedRevision, 0);
  assert.equal(followUp.claimedIdempotencyKey, '');
  assert.equal(followUp.claimedCoreGeneratedAt, '');
  assert.equal(followUp.idempotencyKey, 'run:B::orders', 'the follow-up retains its own idempotency identity');
  assert.equal(queue.completedIdempotency.some(record => record.idempotencyKey === 'run:A::orders'), true,
    'the successfully claimed request must be tombstoned independently');
  assert.equal(queue.completedIdempotency.some(record => record.idempotencyKey === 'run:B::orders'), false,
    'the pending follow-up must not be tombstoned before it runs');
  const coalesced = enqueueSections(queue, {
    sections: ['orders'], priority: 5, idempotencyKey: 'run:C', coalesceKey: 'live:G1', now: at(4_000),
  });
  assert.deepEqual(coalesced.deduplicatedPending, ['orders']);
  assert.equal(queue.entries.length, 1);
  assert.equal(queue.entries[0].requestRevision, 2, 'a pending follow-up must coalesce further same-generation events');

  const statusTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-portal-section-status-'));
  try {
    const statusFile = path.join(statusTemp, 'queue.json');
    fs.writeFileSync(statusFile, `${JSON.stringify(queue, null, 2)}\n`);
    const status = spawnSync(process.execPath, [
      path.join(process.cwd(), 'scripts', 'manage_bi_portal_section_queue.mjs'),
      'status', '--file', statusFile,
    ], {cwd: process.cwd(), encoding: 'utf8'});
    assert.equal(status.status, 0, status.stderr);
    const payload = JSON.parse(status.stdout);
    const health = payload.health.sections.find(section => section.section === 'orders');
    assert.equal(payload.lastPublishedRevisions.orders, 1);
    assert.equal(payload.desiredRevisions.orders, 2);
    assert.equal(health.lastPublishedRevision, 1);
    assert.equal(health.requestRevision, 2);
    assert.equal(health.desiredRevision, 2);
    assert.equal(health.claimedRevision, 0, 'pending follow-up health must show no active claimed revision');
    assert.ok(health.desiredRevision > health.lastPublishedRevision,
      'pending follow-up health must distinguish desired from last published revision');
    assert.equal(health.pendingFollowUp, true);
    assert.equal(payload.entries[0].claimedRevision, 0);
    assert.equal(payload.entries[0].claimedIdempotencyKey, '');
    assert.equal(payload.entries[0].claimedCoreGeneratedAt, '');
    assert.equal(payload.entries[0].lastPublishedRevision, 1);
    assert.equal(payload.entries[0].desiredRevision, 2);
  } finally {
    fs.rmSync(statusTemp, {recursive: true, force: true});
  }
}

// ---- A newer generation starts a fresh revision epoch. Historical snapshots
// remain available for audit, but must not make requestRevision=1 appear
// already published in status/health.
{
  const queue = {version: 1, updatedAt: '', entries: []};
  enqueueSections(queue, {sections: ['orders'], coreGeneratedAt: 'G1', now: at(0)});
  const first = claimNext(queue, {leaseSeconds: 60, leaseId: 'lease-generation-1', now: at(1_000)});
  completeClaim(queue, {section: 'orders', leaseId: first.leaseId, now: at(2_000)});
  enqueueSections(queue, {sections: ['orders'], coreGeneratedAt: 'G2', now: at(3_000)});
  const statusTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-portal-section-generation-status-'));
  try {
    const statusFile = path.join(statusTemp, 'queue.json');
    fs.writeFileSync(statusFile, `${JSON.stringify(queue, null, 2)}\n`);
    const status = spawnSync(process.execPath, [
      path.join(process.cwd(), 'scripts', 'manage_bi_portal_section_queue.mjs'),
      'status', '--file', statusFile,
    ], {cwd: process.cwd(), encoding: 'utf8'});
    assert.equal(status.status, 0, status.stderr);
    const payload = JSON.parse(status.stdout);
    const health = payload.health.sections.find(section => section.section === 'orders');
    assert.equal(payload.lastPublishedRevisions.orders, 0,
      'a new generation must not inherit the old generation numeric revision');
    assert.equal(payload.desiredRevisions.orders, 1);
    assert.equal(health.lastPublishedRevision, 0);
    assert.equal(health.desiredRevision, 1);
    assert.equal(health.pendingFollowUp, true);
    assert.equal(payload.publishedSnapshots.length, 1,
      'the historical published snapshot remains auditable');
  } finally {
    fs.rmSync(statusTemp, {recursive: true, force: true});
  }
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
  assert.equal(first.section, 'orders', 'unrelated owner-visible work keeps its normal priority');
  assert.equal(first.attempts, 1);
  failClaim(queue, {section: 'orders', leaseId: 'lease-1', error: 'temporary', now: at(2_500), backoffSeconds: 0});
  assert.equal(queue.entries.find(entry => entry.section === 'orders').status, 'pending');

  const retried = claimNext(queue, {leaseSeconds: 60, leaseId: 'lease-2', now: at(3_000)});
  assert.equal(retried.section, 'orders');
  assert.equal(retried.attempts, 2);

  // Let the lease expire without completing: recovery must re-issue it.
  const recovered = claimNext(queue, {leaseSeconds: 60, leaseId: 'lease-3', now: at(64_000)});
  assert.equal(recovered.section, 'orders');
  assert.equal(recovered.attempts, 3);
  completeClaim(queue, {section: 'orders', leaseId: 'lease-3', now: at(64_500)});

  const profit = claimNext(queue, {leaseSeconds: 60, leaseId: 'lease-profit', now: at(65_000)});
  assert.equal(profit.section, 'profit', 'homeRankings remains blocked until its background profit dependency runs');
  completeClaim(queue, {section: 'profit', leaseId: 'lease-profit', now: at(65_500)});
  const rankings = claimNext(queue, {leaseSeconds: 60, leaseId: 'lease-rankings', now: at(66_000)});
  assert.equal(rankings.section, 'homeRankings');
  completeClaim(queue, {section: 'homeRankings', leaseId: 'lease-rankings', now: at(66_500)});

  const defaultLeaseQueue = {version: 1, updatedAt: '', entries: []};
  enqueueSections(defaultLeaseQueue, {sections: ['orders'], now: at(0)});
  const defaultLease = claimNext(defaultLeaseQueue, {now: at(1_000)});
  assert.match(defaultLease.leaseId, /^[0-9a-f-]{36}$/i);
}

// ---- Profit is a hard dependency for historical homepage artifacts. A force
// refresh must not republish homeRankings/homeProfit from an older cache while
// canonical accounting is pending or backing off.
{
  const queue = {version: 1, updatedAt: '', entries: []};
  enqueueSections(queue, {sections: ['homeRankings', 'homeProfit'], priority: 0, reason: 'operator-force', now: at(0)});
  enqueueSections(queue, {sections: ['profit'], priority: 5, reason: 'live-order', now: at(1_000)});
  enqueueSections(queue, {sections: ['orders'], priority: 10, reason: 'independent', now: at(2_000)});

  const profit = claimNext(queue, {leaseSeconds: 60, leaseId: 'profit-lease', now: at(3_000)});
  assert.equal(profit.section, 'profit', 'profit dependency must beat priority-0 homepage dependents');
  failClaim(queue, {section: 'profit', leaseId: 'profit-lease', error: 'temporary', now: at(4_000), backoffSeconds: 60});

  const independent = claimNext(queue, {leaseSeconds: 60, leaseId: 'orders-lease', now: at(5_000)});
  assert.equal(independent.section, 'orders', 'unrelated work may proceed while profit is backing off');
  completeClaim(queue, {section: 'orders', leaseId: 'orders-lease', now: at(5_500)});
  assert.equal(claimNext(queue, {leaseSeconds: 60, leaseId: 'blocked-lease', now: at(6_000)}), null,
    'homepage dependents must remain blocked for the full profit backoff');

  const profitRetry = claimNext(queue, {leaseSeconds: 60, leaseId: 'profit-retry', now: at(65_000)});
  assert.equal(profitRetry.section, 'profit');
  completeClaim(queue, {section: 'profit', leaseId: 'profit-retry', now: at(65_500)});
  const rankings = claimNext(queue, {leaseSeconds: 60, leaseId: 'rankings-lease', now: at(66_000)});
  assert.equal(rankings.section, 'homeRankings', 'homeRankings may run only after profit completes');
  completeClaim(queue, {section: 'homeRankings', leaseId: 'rankings-lease', now: at(66_500)});
  const homeProfit = claimNext(queue, {leaseSeconds: 60, leaseId: 'home-profit-lease', now: at(67_000)});
  assert.equal(homeProfit.section, 'homeProfit', 'homeProfit follows the refreshed historical sales baseline');
}

// ---- Continuous order bursts cannot keep claiming only profit forever. A
// successful claimed revision moves behind homeRankings while its one
// follow-up remains pending; the dependency-safe published snapshot prevents
// a revision livelock.
{
  const queue = {version: 1, updatedAt: '', entries: []};
  enqueueSections(queue, {sections: ['profit', 'homeRankings', 'homeProfit'], priority: 5, reason: 'live-order', now: at(0)});
  const claims = [];
  for (let round = 0; round < 3; round += 1) {
    const leaseId = `continuous-${round}`;
    const claimed = claimNext(queue, {leaseSeconds: 60, leaseId, now: at(1_000 + round * 2_000)});
    claims.push(claimed.section);
    enqueueSections(queue, {
      sections: ['profit', 'homeRankings', 'homeProfit'],
      priority: 5,
      reason: `live-order-${round}`,
      now: at(1_500 + round * 2_000),
    });
    assert.equal(completeClaim(queue, {section: claimed.section, leaseId, now: at(2_000 + round * 2_000)}), true);
  }
  assert.deepEqual(claims, ['profit', 'homeRankings', 'profit'],
    'superseded canonical work must yield round-robin instead of livelocking on profit');
  assert.equal(queue.entries.find(entry => entry.section === 'homeProfit').status, 'pending',
    'homeProfit remains fail-closed until one profit revision completes quietly');
  assert.equal(queue.entries.find(entry => entry.section === 'profit').priority, 5,
    'a coalesced rerun keeps only the priority of requests that actually arrived during its lease');
}

// ---- A failed claim is not a completed accounting snapshot. It must keep
// homeRankings behind profit even though a newer revision is waiting.
{
  const queue = {version: 1, updatedAt: '', entries: []};
  enqueueSections(queue, {sections: ['profit', 'homeRankings', 'homeProfit'], priority: 5, now: at(0)});
  const profit = claimNext(queue, {leaseSeconds: 60, leaseId: 'failed-profit', now: at(1_000)});
  enqueueSections(queue, {sections: ['profit', 'homeRankings', 'homeProfit'], priority: 5, now: at(1_500)});
  failClaim(queue, {section: 'profit', leaseId: 'failed-profit', error: 'refresh failed', now: at(2_000), backoffSeconds: 60});
  const failedProfit = queue.entries.find(entry => entry.section === 'profit');
  assert.equal(failedProfit.dependencyYield, false,
    'a failed profit lease must never advertise a successful dependency snapshot');
  assert.equal(failedProfit.claimedRevision, 0, 'a failed lease must not leave a claimed revision on pending work');
  assert.equal(failedProfit.claimedIdempotencyKey, '');
  assert.equal(failedProfit.claimedCoreGeneratedAt, '');
  assert.equal(failedProfit.lastPublishedRevision, 0,
    'a failed claim must not advance lastPublishedRevision');
  assert.equal(queue.publishedSnapshots.length, 0, 'a failed claim must not create publication evidence');
  assert.equal(claimNext(queue, {leaseSeconds: 60, leaseId: 'failed-profit-retry', now: at(2_500)}).section, 'profit',
    'profit must retry before either homepage dependent after a failed claim');
}

// A one-time operator force request must not poison a continuously coalesced
// entry at priority 0 forever. Once that lease is superseded, only the newer
// request priority carries into the rerun.
{
  const queue = {version: 1, updatedAt: '', entries: []};
  enqueueSections(queue, {sections: ['orders'], priority: 0, now: at(0)});
  claimNext(queue, {leaseSeconds: 60, leaseId: 'forced-once', now: at(1_000)});
  enqueueSections(queue, {sections: ['orders'], priority: 10, now: at(1_500)});
  completeClaim(queue, {section: 'orders', leaseId: 'forced-once', now: at(2_000)});
  const pending = queue.entries.find(entry => entry.section === 'orders');
  assert.equal(pending.priority, 10, 'superseded rerun priority must reset to the newer request priority');
  assert.equal(pending.rerunPriority, null);
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

  const distinctSlotQueue = {version: 1, updatedAt: '', entries: []};
  enqueueSections(distinctSlotQueue, {sections: ['orders', 'profit', 'rankings'], priority: 0, now: at(0)});
  const firstDistinct = claimNext(distinctSlotQueue, {leaseId: 'slot-orders', now: at(1_000)});
  assert.equal(firstDistinct.section, 'orders');
  enqueueSections(distinctSlotQueue, {sections: ['orders'], priority: 0, now: at(1_500)});
  completeClaim(distinctSlotQueue, {section: 'orders', leaseId: 'slot-orders', now: at(2_000)});
  const secondDistinct = claimNext(distinctSlotQueue, {
    leaseId: 'slot-profit',
    now: at(2_500),
    excludeSections: ['orders'],
  });
  assert.equal(secondDistinct.section, 'profit',
    'one bounded worker run must not consume two slots on the same hot section');
}

// ---- Heavy preferred sections rotate durably across bounded slots. A hot
// priority-5 profit section that repeatedly fails or consumes the :32 slot must
// not starve a priority-50 productSalesDaily refresh forever; the next heavy
// claim after profit advances to the cursor's successor.
{
  const heavySections = ['profit', 'productSalesDaily', 'homeRankings'];
  const queue = {version: 1, updatedAt: '', entries: []};
  enqueueSections(queue, {sections: ['profit'], priority: 5, now: at(0)});
  enqueueSections(queue, {sections: ['productSalesDaily'], priority: 50, now: at(1_000)});

  const profit = claimNext(queue, {
    leaseSeconds: 60,
    leaseId: 'heavy-profit-1',
    preferSections: heavySections,
    now: at(2_000),
  });
  assert.equal(profit.section, 'profit');
  assert.equal(queue.fairnessCursor, 'profit', 'claiming a heavy preferred section must persist the cursor');
  failClaim(queue, {section: 'profit', leaseId: 'heavy-profit-1', now: at(3_000), backoffSeconds: 0});

  const productSales = claimNext(queue, {
    leaseSeconds: 60,
    leaseId: 'heavy-product-sales-1',
    preferSections: heavySections,
    now: at(4_000),
  });
  assert.equal(productSales.section, 'productSalesDaily',
    'the next heavy slot must select the cursor successor instead of retrying fixed lower-priority profit first');
  assert.equal(queue.fairnessCursor, 'productSalesDaily');
  completeClaim(queue, {section: 'productSalesDaily', leaseId: 'heavy-product-sales-1', now: at(5_000)});

  const profitAgain = claimNext(queue, {
    leaseSeconds: 60,
    leaseId: 'heavy-profit-2',
    preferSections: heavySections,
    now: at(6_000),
  });
  assert.equal(profitAgain.section, 'profit', 'after productSalesDaily completes, remaining heavy work continues normally');
}

// ---- Heavy cursor is persisted through the CLI queue file and does not leak
// into the light slot, where heavy sections are explicitly excluded.
{
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-heavy-fairness-'));
  try {
    const queueFile = path.join(temp, 'queue.json');
    const run = (...args) => spawnSync(process.execPath, [
      path.join(process.cwd(), 'scripts', 'manage_bi_portal_section_queue.mjs'),
      ...args,
      '--file', queueFile,
    ], {cwd: process.cwd(), encoding: 'utf8'});
    let result = run('enqueue', '--sections', 'profit', '--priority', '5', '--core-generated-at', 'G1');
    assert.equal(result.status, 0, result.stderr);
    result = run('enqueue', '--sections', 'productSalesDaily', '--priority', '50', '--core-generated-at', 'G1');
    assert.equal(result.status, 0, result.stderr);
    result = run('enqueue', '--sections', 'orders', '--priority', '10', '--core-generated-at', 'G1');
    assert.equal(result.status, 0, result.stderr);

    result = run('claim', '--lease-seconds', '60', '--prefer-sections', 'profit,productSalesDaily,homeRankings');
    assert.equal(result.status, 0, result.stderr);
    const first = JSON.parse(result.stdout).entry;
    assert.equal(first.section, 'profit');

    result = run('fail', '--section', 'profit', '--lease-id', first.leaseId, '--backoff-seconds', '0');
    assert.equal(result.status, 0, result.stderr);
    let persisted = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
    assert.equal(persisted.fairnessCursor, 'profit');

    result = run('claim', '--lease-seconds', '60', '--prefer-sections', 'profit,productSalesDaily,homeRankings');
    assert.equal(result.status, 0, result.stderr);
    const second = JSON.parse(result.stdout).entry;
    assert.equal(second.section, 'productSalesDaily');
    persisted = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
    assert.equal(persisted.fairnessCursor, 'productSalesDaily', 'cursor must survive process restart through queue.json');
    result = run('fail', '--section', 'productSalesDaily', '--lease-id', second.leaseId, '--backoff-seconds', '60');
    assert.equal(result.status, 0, result.stderr);

    result = run('claim', '--lease-seconds', '60', '--exclude-sections', 'profit,productSalesDaily,homeRankings',
      '--prefer-sections', 'profit,productSalesDaily,homeRankings');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).entry.section, 'orders', 'light slot exclusions must still beat the heavy fairness cursor');
  } finally {
    fs.rmSync(temp, {recursive: true, force: true});
  }
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

// ---- completeClaim owns publication only while its lease and caller deadline are valid.
{
  const evidence = {
    expectedGeneratedAt: 'G1', terminalGeneratedAt: 'G1', terminalSectionGeneratedAt: 'G1',
    terminalGenerationIdentity: 'f'.repeat(64), requireTerminalEvidence: true,
  };
  const fixture = leaseId => {
    const queue = {version: 1, updatedAt: '', entries: []};
    enqueueSections(queue, {sections: ['orders'], idempotencyKey: `lease:${leaseId}`, now: at(0)});
    const claim = claimNext(queue, {leaseSeconds: 60, leaseId, now: at(1_000)});
    return {queue, claim, expiresAt: Date.parse(claim.leaseExpiresAt)};
  };
  const complete = (state, now, options = {}) => completeClaim(state.queue, {
    section: 'orders', leaseId: state.claim.leaseId, now, ...evidence, ...options,
  });
  const rejectUnchanged = (state, now, error, options = {}) => {
    const before = structuredClone(state.queue);
    assert.throws(() => complete(state, now, options), error);
    assert.deepEqual(state.queue, before);
  };

  const valid = fixture('before-expiry');
  assert.equal(complete(valid, new Date(valid.expiresAt - 1)), true);
  assert.deepEqual([valid.queue.entries.length, valid.queue.publishedSnapshots.length,
    valid.queue.completedIdempotency.length], [0, 1, 1]);
  const expired = fixture('expired');
  rejectUnchanged(expired, new Date(expired.expiresAt), /QUEUE_LEASE_EXPIRED/);
  rejectUnchanged(expired, new Date(expired.expiresAt + 1), /QUEUE_LEASE_EXPIRED/);
  const invalid = fixture('invalid');
  invalid.queue.entries[0].leaseExpiresAt = 'invalid';
  rejectUnchanged(invalid, at(2_000), /QUEUE_LEASE_INVALID/);

  const deadlineEpoch = Math.floor(at(10_000).getTime() / 1_000);
  assert.equal(complete(fixture('deadline-before'), new Date(deadlineEpoch * 1_000 - 1), {notAfterEpoch: deadlineEpoch}), true);
  for (const offset of [0, 1]) {
    rejectUnchanged(fixture(`deadline-${offset}`), new Date(deadlineEpoch * 1_000 + offset), /QUEUE_NOT_AFTER_EPOCH_EXPIRED/, {notAfterEpoch: deadlineEpoch});
  }
  rejectUnchanged(fixture('deadline-invalid'), at(2_000), /QUEUE_NOT_AFTER_EPOCH_INVALID/, {notAfterEpoch: 0});
}

// ---- CLI shares the guard; rejected calls must not rewrite queue bytes.
{
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-portal-section-lease-boundary-'));
  try {
    const manager = path.join(process.cwd(), 'scripts', 'manage_bi_portal_section_queue.mjs');
    const fixture = (name, expiry) => {
      const now = new Date();
      const queue = {version: 1, updatedAt: '', entries: []};
      enqueueSections(queue, {sections: ['orders'], idempotencyKey: `cli-lease:${name}`, now});
      const claim = claimNext(queue, {leaseSeconds: 60, leaseId: `cli-${name}`, now});
      queue.entries[0].leaseExpiresAt = expiry(now);
      const file = path.join(temp, `${name}.json`);
      fs.writeFileSync(file, `${JSON.stringify(queue, null, 2)}\n`);
      return {file, claim};
    };
    const run = (state, ...extra) => spawnSync(process.execPath, [
      manager, 'complete', '--section', 'orders', '--lease-id', state.claim.leaseId,
      ...terminalEvidenceArgs('G1', 'e'.repeat(64)), ...extra, '--file', state.file,
    ], {cwd: process.cwd(), encoding: 'utf8'});

    const future = fixture('future', now => new Date(now.getTime() + 60_000).toISOString());
    const success = run(future, '--not-after-epoch', String(Math.floor(Date.now() / 1_000) + 60));
    assert.equal(success.status, 0, success.stderr);
    const published = JSON.parse(fs.readFileSync(future.file, 'utf8'));
    assert.deepEqual([published.entries.length, published.publishedSnapshots.length,
      published.completedIdempotency.length], [0, 1, 1]);
    for (const [name, expiry, error] of [['past', now => new Date(now.getTime() - 1_000).toISOString(), /QUEUE_LEASE_EXPIRED/],
      ['invalid', () => 'invalid', /QUEUE_LEASE_INVALID/]]) {
      const state = fixture(name, expiry);
      const before = queueFileSnapshot(state.file);
      const rejected = run(state);
      assert.equal(rejected.status, 1);
      assert.match(rejected.stderr, error);
      assertQueueFileUnchanged(state.file, before, name);
    }
    for (const [name, deadline] of [['deadline-at', Math.floor(Date.now() / 1_000)],
      ['deadline-past', Math.floor(Date.now() / 1_000) - 1]]) {
      const state = fixture(name, now => new Date(now.getTime() + 60_000).toISOString());
      const before = queueFileSnapshot(state.file);
      const rejected = run(state, '--not-after-epoch', String(deadline));
      assert.equal(rejected.status, 1);
      assert.match(rejected.stderr, /QUEUE_NOT_AFTER_EPOCH_EXPIRED/);
      assertQueueFileUnchanged(state.file, before, name);
    }
  } finally {
    fs.rmSync(temp, {recursive: true, force: true});
  }
}

// ---- CLI round trip: enqueue, claim, published old revision with a pending
// follow-up, fail with backoff, status repair of a broken lease.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-portal-section-queue-'));
try {
  const queueFile = path.join(temp, 'queue.json');
  const run = (...args) => spawnSync(process.execPath, [
    path.join(process.cwd(), 'scripts', 'manage_bi_portal_section_queue.mjs'),
    ...args,
    '--file', queueFile,
  ], {cwd: process.cwd(), encoding: 'utf8'});
  const enqueue = run('enqueue', '--sections', 'orders', '--core-generated-at', 'G1');
  assert.equal(enqueue.status, 0, enqueue.stderr);
  assert.equal(JSON.parse(enqueue.stdout).entries[0].requestRevision, 1);
  const claim = run('claim', '--lease-seconds', '60');
  assert.equal(claim.status, 0, claim.stderr);
  const claimPayload = JSON.parse(claim.stdout);
  assert.match(claimPayload.entry.leaseId, /^[0-9a-f-]{36}$/i);
  const leaseId = claimPayload.entry.leaseId;

  const reenqueue = run('enqueue', '--sections', 'orders', '--priority', '0', '--core-generated-at', 'G2');
  assert.equal(reenqueue.status, 0, reenqueue.stderr);
  const beforeRejectedComplete = queueFileSnapshot(queueFile);
  const evidencePairs = [
    ['--expected-generated-at', 'G1'],
    ['--terminal-generated-at', 'G1'],
    ['--terminal-section-generated-at', 'G1'],
    ['--terminal-generation-identity', 'a'.repeat(64)],
  ];
  for (const [missingFlag] of evidencePairs) {
    const incompleteEvidence = evidencePairs
      .filter(([flag]) => flag !== missingFlag)
      .flat();
    const missing = run('complete', '--section', 'orders', '--lease-id', leaseId, ...incompleteEvidence);
    assert.notEqual(missing.status, 0, `${missingFlag} omission must fail`);
    assert.match(missing.stderr, /QUEUE_TERMINAL_EVIDENCE_REQUIRED/);
    assertQueueFileUnchanged(queueFile, beforeRejectedComplete, `${missingFlag} omission`);
  }

  const newerEvidence = run(
    'complete', '--section', 'orders', '--lease-id', leaseId,
    '--expected-generated-at', 'G1',
    '--terminal-generated-at', 'G2',
    '--terminal-section-generated-at', 'G2',
    '--terminal-generation-identity', 'b'.repeat(64),
  );
  assert.notEqual(newerEvidence.status, 0, 'G2 terminal evidence must not complete a G1 claim');
  assert.match(newerEvidence.stderr, /QUEUE_TERMINAL_GENERATION_MISMATCH/);
  assertQueueFileUnchanged(queueFile, beforeRejectedComplete, 'G1 claim with G2 terminal evidence');

  const superseded = run(
    'complete', '--section', 'orders', '--lease-id', leaseId,
    ...terminalEvidenceArgs('G1', 'c'.repeat(64)),
  );
  assert.equal(superseded.status, 0, superseded.stderr);
  const supersededPayload = JSON.parse(superseded.stdout);
  assert.equal(supersededPayload.completed, true, 'CLI complete must report the successful claimed publication');
  assert.equal(supersededPayload.published, true);
  assert.equal(supersededPayload.followUpPending, true);
  assert.equal(supersededPayload.publishedRevision, 1);
  assert.equal(supersededPayload.desiredRevision, 2,
    'complete must expose the scalar desired revision instead of the status map');
  assert.equal(supersededPayload.entries[0].status, 'pending');
  assert.equal(supersededPayload.entries[0].requestRevision, 2);
  assert.equal(supersededPayload.entries[0].claimedRevision, 0);
  assert.equal(supersededPayload.entries[0].claimedIdempotencyKey, '');
  assert.equal(supersededPayload.entries[0].claimedCoreGeneratedAt, '');
  assert.equal(supersededPayload.entries[0].lastPublishedRevision, 1);
  assert.equal(
    supersededPayload.health.sections.find(section => section.section === 'orders').claimedRevision,
    0,
  );

  const claimAgain = run('claim', '--lease-seconds', '60');
  assert.equal(claimAgain.status, 0, claimAgain.stderr);
  const fail = run('fail', '--section', 'orders', '--lease-id', JSON.parse(claimAgain.stdout).entry.leaseId, '--backoff-seconds', '60');
  assert.equal(fail.status, 0, fail.stderr);
  const failedEntry = JSON.parse(fail.stdout).entries[0];
  assert.equal(failedEntry.status, 'pending');
  assert.ok(Date.parse(failedEntry.nextAttemptAt) > Date.now(), 'CLI fail must persist a future nextAttemptAt');

  const excludedClaim = run('claim', '--lease-seconds', '60', '--exclude-sections', 'orders');
  assert.equal(excludedClaim.status, 75, 'CLI exclusions must prevent a same-run re-claim');

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

// ---- Production CLI completion cannot fall back to mutable coreGeneratedAt
// when the immutable claim generation is unknown.
{
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-complete-unknown-cli-'));
  const queueFile = path.join(temp, 'queue.json');
  const run = (...args) => spawnSync(process.execPath, [
    path.join(process.cwd(), 'scripts', 'manage_bi_portal_section_queue.mjs'),
    ...args,
    '--file', queueFile,
  ], {cwd: process.cwd(), encoding: 'utf8'});
  try {
    let result = run('enqueue', '--sections', 'orders', '--core-generated-at', 'unknown');
    assert.equal(result.status, 0, result.stderr);
    result = run('claim', '--lease-seconds', '60');
    assert.equal(result.status, 0, result.stderr);
    const claim = JSON.parse(result.stdout).entry;
    assert.equal(claim.claimedCoreGeneratedAt, 'unknown');
    const before = queueFileSnapshot(queueFile);
    result = run(
      'complete', '--section', claim.section, '--lease-id', claim.leaseId,
      ...terminalEvidenceArgs('G1', 'd'.repeat(64)),
    );
    assert.notEqual(result.status, 0, 'unknown immutable claim generation must fail CLI completion');
    assert.match(result.stderr, /QUEUE_CLAIMED_GENERATION_UNKNOWN/);
    assertQueueFileUnchanged(queueFile, before, 'unknown immutable claim generation');
  } finally {
    fs.rmSync(temp, {recursive: true, force: true});
  }
}

// ---- Durable per-section idempotency: same key preserves queue semantics,
// but every replay is still a durable enqueue intent revision so an existing
// generationCompletion receipt cannot survive it.
{
  const queue = {version: 1, updatedAt: '', nextSequence: 0, entries: [], completedIdempotency: []};
  const key = 'core-warmup:2026-08-17T03:00:00.000Z';
  let outcome = enqueueSections(queue, {sections: ['profit', 'homeRankings'], priority: 10, idempotencyKey: key, now: at(0)});
  assert.equal(outcome.mutated, true);
  assert.deepEqual(outcome.deduplicated, []);
  assert.equal(queue.entries[0].idempotencyKey, `${key}::profit`);
  assert.equal(queue.entries[1].idempotencyKey, `${key}::homeRankings`);

  const claim = claimNext(queue, {leaseSeconds: 60, leaseId: 'lease-ip-1', now: at(1_000)});
  assert.equal(claim.section, 'profit');
  assert.equal(claim.requestRevision, 1);

  // Re-enqueue the same key while running: queue-entry no-op, intent revision.
  outcome = enqueueSections(queue, {sections: ['profit'], priority: 0, idempotencyKey: key, reason: 'force', now: at(2_000)});
  assert.equal(outcome.mutated, true);
  assert.deepEqual(outcome.deduplicated, ['profit']);
  const running = queue.entries.find(e => e.section === 'profit');
  assert.equal(running.requestRevision, 1, 'same-key re-enqueue must not bump revision');
  assert.equal(running.rerun, false, 'same-key re-enqueue must not mark rerun');
  assert.equal(running.leaseId, 'lease-ip-1', 'lease must not be reset');
  assert.equal(running.attempts, 1);

  // Final completion tombstones the durable key.
  assert.equal(completeClaim(queue, {section: 'profit', leaseId: 'lease-ip-1', now: at(3_000)}), true);
  assert.equal(queue.entries.some(e => e.section === 'profit'), false);
  assert.ok(queue.completedIdempotency.some(r => r.idempotencyKey === `${key}::profit` && r.section === 'profit'));

  // Re-enqueue the same key after completion: no entry recreation, but the
  // enqueue intent invalidates a prior generation receipt before returning.
  queue.generationCompletion = {version: 1, coreGeneratedAt: 'G1', sections: ['profit']};
  const intentRevisionBeforeReplay = queue.sectionIntentRevisions.profit;
  outcome = enqueueSections(queue, {sections: ['profit'], priority: 10, idempotencyKey: key, now: at(4_000)});
  assert.equal(outcome.mutated, true);
  assert.deepEqual(outcome.deduplicated, ['profit']);
  assert.equal(outcome.invalidatedGenerationCompletion, true);
  assert.equal(queue.generationCompletion, null);
  assert.ok(queue.sectionIntentRevisions.profit > intentRevisionBeforeReplay);
  assert.equal(queue.entries.some(e => e.section === 'profit'), false, 'tombstoned key must not recreate the entry');

  // Pending section with the same key deduplicates too.
  outcome = enqueueSections(queue, {sections: ['homeRankings'], priority: 10, idempotencyKey: key, now: at(4_000)});
  assert.equal(outcome.mutated, true);
  assert.deepEqual(outcome.deduplicated, ['homeRankings']);

  // A new generation key enqueues a normal fresh revision.
  const key2 = 'core-warmup:2026-08-17T04:00:00.000Z';
  outcome = enqueueSections(queue, {sections: ['profit'], priority: 10, idempotencyKey: key2, now: at(5_000)});
  assert.equal(outcome.mutated, true);
  const fresh = queue.entries.find(e => e.section === 'profit');
  assert.equal(fresh.idempotencyKey, `${key2}::profit`);
  assert.equal(fresh.requestRevision, 1);

  // Legacy enqueue without a key keeps the old bumping behavior.
  const legacy = {version: 1, updatedAt: '', nextSequence: 0, entries: [], completedIdempotency: []};
  enqueueSections(legacy, {sections: ['orders'], priority: 50, now: at(0)});
  claimNext(legacy, {leaseSeconds: 60, leaseId: 'lease-legacy-1', now: at(1_000)});
  enqueueSections(legacy, {sections: ['orders'], priority: 0, reason: 'force', now: at(2_000)});
  assert.equal(legacy.entries.find(e => e.section === 'orders').requestRevision, 2, 'legacy enqueue must keep bumping revision');
  assert.equal('idempotencyKey' in legacy.entries.find(e => e.section === 'orders'), false, 'legacy entries must not gain the key field');
}

// ---- Idempotency key validation and bounded completed ledger.
{
  assert.throws(
    () => enqueueSections({version: 1, entries: [], completedIdempotency: []}, {sections: ['profit'], idempotencyKey: '../evil'}),
    /QUEUE_IDEMPOTENCY_KEY_INVALID/,
  );
  assert.throws(
    () => enqueueSections({version: 1, entries: [], completedIdempotency: []}, {sections: ['profit'], idempotencyKey: 'x'.repeat(121)}),
    /QUEUE_IDEMPOTENCY_KEY_INVALID/,
  );

  const queue = {version: 1, updatedAt: '', nextSequence: 0, entries: [], completedIdempotency: []};
  for (let i = 0; i < 2050; i += 1) {
    const k = `cap:${String(i).padStart(4, '0')}`;
    enqueueSections(queue, {sections: ['profit'], priority: 50, idempotencyKey: k, now: at(i)});
    const claimed = claimNext(queue, {leaseSeconds: 60, leaseId: `lease-cap-${i}`, now: at(i)});
    assert.equal(claimed.section, 'profit');
    completeClaim(queue, {section: 'profit', leaseId: `lease-cap-${i}`, now: at(i + 1)});
  }
  assert.ok(queue.completedIdempotency.length <= 2048, `ledger must be bounded, got ${queue.completedIdempotency.length}`);
  assert.equal(queue.completedIdempotency[0].idempotencyKey, 'cap:2049::profit', 'newest completions must be kept');

  const aged = {version: 1, updatedAt: '', nextSequence: 0, entries: [], completedIdempotency: []};
  const day = 24 * 60 * 60 * 1_000;
  enqueueSections(aged, {sections: ['profit'], priority: 50, idempotencyKey: 'old:key', now: at(0)});
  claimNext(aged, {leaseSeconds: 60, leaseId: 'lease-aged', now: at(1_000)});
  completeClaim(aged, {section: 'profit', leaseId: 'lease-aged', now: at(2_000)});
  assert.equal(aged.completedIdempotency.length, 1);
  enqueueSections(aged, {sections: ['profit'], priority: 50, idempotencyKey: 'new:key', now: at(31 * day)});
  claimNext(aged, {leaseSeconds: 60, leaseId: 'lease-new', now: at(31 * day + 1_000)});
  completeClaim(aged, {section: 'profit', leaseId: 'lease-new', now: at(31 * day + 2_000)});
  assert.equal(aged.completedIdempotency.some(r => r.idempotencyKey === 'old:key::profit'), false, '>30d tombstones must be dropped');
  assert.equal(aged.completedIdempotency.some(r => r.idempotencyKey === 'new:key::profit'), true);
}

// ---- G1 -> G2 race: a running G1 claim keeps immutable claimedCoreGeneratedAt
// even after the queue entry adopts G2. Terminal evidence for G2 must reject
// completion of the G1 lease; only the existing follow-up claim may publish G2.
{
  const queue = {version: 1, updatedAt: '', entries: []};
  enqueueSections(queue, {sections: ['profit'], idempotencyKey: 'core:G1', coreGeneratedAt: 'G1', now: at(0)});
  const g1 = claimNext(queue, {leaseSeconds: 60, leaseId: 'lease-race-g1', now: at(1_000)});
  assert.equal(g1.claimedCoreGeneratedAt, 'G1');
  enqueueSections(queue, {sections: ['profit'], idempotencyKey: 'core:G2', coreGeneratedAt: 'G2', now: at(2_000)});
  const running = queue.entries.find(entry => entry.section === 'profit');
  assert.equal(running.coreGeneratedAt, 'G2');
  assert.equal(running.claimedCoreGeneratedAt, 'G1', 'a newer request must not rewrite the immutable claim generation');
  assert.throws(
    () => completeClaim(queue, {
      section: 'profit',
      leaseId: g1.leaseId,
      expectedGeneratedAt: 'G1',
      terminalGeneratedAt: 'G2',
      terminalSectionGeneratedAt: 'G2',
      terminalGenerationIdentity: 'a'.repeat(64),
      now: at(3_000),
    }),
    /QUEUE_TERMINAL_GENERATION_MISMATCH/,
    'G2 terminal evidence must never be recorded as a G1 publication',
  );
  assert.equal(queue.publishedSnapshots.length, 0);
  failClaim(queue, {section: 'profit', leaseId: g1.leaseId, error: 'G1 superseded by G2', now: at(4_000), backoffSeconds: 0});
  const g2 = claimNext(queue, {leaseSeconds: 60, leaseId: 'lease-race-g2', now: at(5_000)});
  assert.equal(g2.claimedCoreGeneratedAt, 'G2');
  assert.equal(completeClaim(queue, {
    section: 'profit',
    leaseId: g2.leaseId,
    expectedGeneratedAt: 'G2',
    terminalGeneratedAt: 'G2',
    terminalSectionGeneratedAt: 'G2',
    terminalGenerationIdentity: 'b'.repeat(64),
    now: at(6_000),
  }), true);
  assert.deepEqual(queue.publishedSnapshots.map(snapshot => snapshot.coreGeneratedAt), ['G2']);
}

// ---- Structured outcomes + tombstone-first precedence: replaying a
// completed G1 is a strict no-op even when the current entry is a newer G2.
{
  const queue = {version: 1, updatedAt: '', nextSequence: 0, entries: [], completedIdempotency: []};
  const keyG1 = 'core-warmup:G1';
  const keyG2 = 'core-warmup:G2';
  // G1 completed (tombstone) and G2 pending on the SAME section.
  enqueueSections(queue, {sections: ['profit'], priority: 10, idempotencyKey: keyG1, now: at(0)});
  const g1Claim = claimNext(queue, {leaseSeconds: 60, leaseId: 'lease-g1', now: at(1_000)});
  completeClaim(queue, {section: 'profit', leaseId: 'lease-g1', now: at(2_000)});
  enqueueSections(queue, {sections: ['profit'], priority: 10, idempotencyKey: keyG2, coreGeneratedAt: 'G2', now: at(3_000)});
  const g2Entry = queue.entries.find(e => e.section === 'profit');
  const g2Before = JSON.stringify({key: g2Entry.idempotencyKey, revision: g2Entry.requestRevision, status: g2Entry.status});

  // Replay G1: tombstone check precedes the existing-entry logic.
  const replay = enqueueSections(queue, {sections: ['profit'], priority: 0, idempotencyKey: keyG1, reason: 'replay', now: at(4_000)});
  assert.deepEqual(replay.deduplicatedCompleted, ['profit'], 'completed replay must be reported as deduplicatedCompleted');
  assert.deepEqual(replay.deduplicatedPending, [], 'a completed key is never a pending dedupe');
  assert.deepEqual(replay.newlyQueued, []);
  assert.deepEqual(replay.updatedRevision, [], 'the G2 entry must not be bumped or re-keyed');
  assert.deepEqual(replay.deduplicated, ['profit'], 'legacy aggregate must stay consistent');
  const g2After = queue.entries.find(e => e.section === 'profit');
  assert.equal(JSON.stringify({key: g2After.idempotencyKey, revision: g2After.requestRevision, status: g2After.status}), g2Before,
    'replaying completed G1 must leave the G2 entry key/revision/status untouched');

  // 31-day DIRECT replay with no intervening completion: the expired G1
  // tombstone is trimmed at enqueue start and the request enqueues fresh.
  const day = 24 * 60 * 60 * 1_000;
  const replayExpired = enqueueSections(queue, {sections: ['profit'], priority: 10, idempotencyKey: keyG1, now: at(31 * day)});
  assert.equal(queue.completedIdempotency.some(r => r.idempotencyKey === `${keyG1}::profit`), false,
    'the expired G1 tombstone must be trimmed before lookup');
  assert.deepEqual(replayExpired.deduplicatedCompleted, [], 'expired tombstone no longer deduplicates');
  assert.deepEqual(replayExpired.updatedRevision, ['profit'], 'the expired G1 replay is a fresh request on the existing section entry');
  assert.equal(queue.entries.find(e => e.section === 'profit').idempotencyKey, `${keyG1}::profit`, 'the entry adopts the fresh G1 key');
}

// ---- Trim-only mutation is persisted: expired tombstones removed even when
// no entry changes.
{
  const queue = {version: 1, updatedAt: '', nextSequence: 0, entries: [], completedIdempotency: []};
  const day = 24 * 60 * 60 * 1_000;
  enqueueSections(queue, {sections: ['orders'], priority: 50, idempotencyKey: 'old:key', now: at(0)});
  const claim = claimNext(queue, {leaseSeconds: 60, leaseId: 'lease-old', now: at(1_000)});
  completeClaim(queue, {section: 'orders', leaseId: 'lease-old', now: at(2_000)});
  assert.equal(queue.completedIdempotency.length, 1);
  const outcome = enqueueSections(queue, {sections: [], now: at(31 * day)});
  assert.equal(outcome.mutated, true, 'trimmed expired tombstones must report mutation');
  assert.equal(queue.completedIdempotency.length, 0);
}

// ---- Narrow requeue of completed sections: only the listed invalid
// tombstones are removed atomically; valid tombstones stay; entries recreate.
{
  const queue = {version: 1, updatedAt: '', nextSequence: 0, entries: [], completedIdempotency: []};
  const key = 'core-warmup:G1';
  // Complete profit and orders.
  enqueueSections(queue, {sections: ['profit', 'orders'], priority: 10, idempotencyKey: key, now: at(0)});
  for (const [section, leaseId] of [['profit', 'lease-rq-p'], ['orders', 'lease-rq-o']]) {
    claimNext(queue, {leaseSeconds: 60, leaseId, now: at(1_000)});
    completeClaim(queue, {section, leaseId, now: at(2_000)});
  }
  assert.equal(queue.completedIdempotency.length, 2);

  // Requeue ONLY profit: its tombstone is removed and the entry recreated;
  // the orders tombstone is untouched.
  const requeued = enqueueSections(queue, {sections: ['profit', 'orders'], priority: 10, idempotencyKey: key, requeueCompletedSections: ['profit'], now: at(3_000)});
  assert.deepEqual(requeued.requeuedCompleted, ['profit'], 'the invalid tombstone must be removed and requeued');
  assert.deepEqual(requeued.newlyQueued, ['profit'], 'the requeued section must create a fresh entry');
  assert.equal(queue.entries.some(e => e.section === 'profit'), true);
  assert.equal(queue.entries.find(e => e.section === 'profit').idempotencyKey, `${key}::profit`);
  assert.equal(queue.completedIdempotency.some(r => r.idempotencyKey === `${key}::profit`), false, 'invalid tombstone must be gone');
  assert.equal(queue.completedIdempotency.some(r => r.idempotencyKey === `${key}::orders`), true, 'valid tombstone must stay');

  // Validation: requeue requires a non-empty idempotency key and a requested
  // subset.
  assert.throws(
    () => enqueueSections(queue, {sections: ['profit'], requeueCompletedSections: ['profit']}),
    /QUEUE_REQUEUE_REQUIRES_IDEMPOTENCY_KEY/,
  );
  assert.throws(
    () => enqueueSections(queue, {sections: ['profit'], idempotencyKey: key, requeueCompletedSections: ['orders']}),
    /QUEUE_REQUEUE_NOT_REQUESTED/,
  );
}

// ---- Coalesced rerun: a different key on an already-rerun running entry
// with an unchanged numeric revision classifies coalescedRerun, never
// updatedRevision.
{
  const queue = {version: 1, updatedAt: '', nextSequence: 0, entries: [], completedIdempotency: []};
  enqueueSections(queue, {sections: ['orders'], priority: 50, idempotencyKey: 'gen:A', now: at(0)});
  const claim = claimNext(queue, {leaseSeconds: 60, leaseId: 'lease-coalesce', now: at(1_000)});
  assert.equal(claim.requestRevision, 1);
  const firstBump = enqueueSections(queue, {sections: ['orders'], priority: 0, idempotencyKey: 'gen:B', now: at(2_000)});
  assert.deepEqual(firstBump.updatedRevision, ['orders'], 'the first different key on a fresh running entry bumps the revision');
  assert.deepEqual(firstBump.coalescedRerun, []);
  assert.equal(queue.entries.find(e => e.section === 'orders').requestRevision, 2);
  const coalesced = enqueueSections(queue, {sections: ['orders'], priority: 0, idempotencyKey: 'gen:C', now: at(3_000)});
  assert.deepEqual(coalesced.coalescedRerun, ['orders'], 'an already-rerun running entry with an unchanged revision must be coalescedRerun');
  assert.deepEqual(coalesced.updatedRevision, [], 'no updatedRevision claim when the revision did not increase');
  assert.equal(queue.entries.find(e => e.section === 'orders').requestRevision, 2, 'the revision must stay unchanged');
  assert.equal(queue.entries.find(e => e.section === 'orders').rerun, true);
}

// ---- Generation-group coalescing: a pending materialization reads the
// latest database state, and a running materialization needs at most one
// rerun. A different generation group still supersedes normally.
{
  const queue = {version: 1, updatedAt: '', nextSequence: 0, entries: [], completedIdempotency: []};
  const first = enqueueSections(queue, {
    sections: ['profit'], priority: 5, idempotencyKey: 'event:A', coalesceKey: 'livegen:G1', now: at(0),
  });
  assert.deepEqual(first.newlyQueued, ['profit']);
  const pending = enqueueSections(queue, {
    sections: ['profit'], priority: 5, idempotencyKey: 'event:B', coalesceKey: 'livegen:G1', now: at(1_000),
  });
  assert.deepEqual(pending.deduplicatedPending, ['profit']);
  assert.equal(queue.entries[0].requestRevision, 1, 'same-generation pending events must not chase revisions');
  assert.equal(queue.entries[0].idempotencyKey, 'event:A::profit', 'the pending request keeps its original tombstone identity');

  const claim = claimNext(queue, {leaseSeconds: 60, leaseId: 'lease-livegen', now: at(2_000)});
  const runningBump = enqueueSections(queue, {
    sections: ['profit'], priority: 5, idempotencyKey: 'event:C', coalesceKey: 'livegen:G1', now: at(3_000),
  });
  assert.deepEqual(runningBump.updatedRevision, ['profit']);
  assert.equal(queue.entries[0].requestRevision, claim.claimedRevision + 1, 'the first event after a running snapshot requests one rerun');
  const runningCoalesced = enqueueSections(queue, {
    sections: ['profit'], priority: 5, idempotencyKey: 'event:D', coalesceKey: 'livegen:G1', now: at(4_000),
  });
  assert.deepEqual(runningCoalesced.coalescedRerun, ['profit']);
  assert.equal(queue.entries[0].requestRevision, claim.claimedRevision + 1, 'further same-generation events must share that rerun');

  completeClaim(queue, {section: 'profit', leaseId: 'lease-livegen', now: at(5_000)});
  assert.equal(queue.entries[0].status, 'pending');
  const pendingAgain = enqueueSections(queue, {
    sections: ['profit'], priority: 5, idempotencyKey: 'event:E', coalesceKey: 'livegen:G1', now: at(6_000),
  });
  assert.deepEqual(pendingAgain.deduplicatedPending, ['profit']);
  assert.equal(queue.entries[0].requestRevision, claim.claimedRevision + 1);

  const newGeneration = enqueueSections(queue, {
    sections: ['profit'], priority: 5, idempotencyKey: 'event:F', coalesceKey: 'livegen:G2', coreGeneratedAt: 'G2', now: at(7_000),
  });
  assert.deepEqual(newGeneration.updatedRevision, ['profit']);
  assert.equal(queue.entries[0].coalesceKey, 'livegen:G2');
}

// ---- CLI-level durable idempotency across process invocations (restart).
{
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-idem-cli-'));
  const queueFile = path.join(temp, 'queue.json');
  const run = (...args) => spawnSync(
    process.execPath,
    ['scripts/manage_bi_portal_section_queue.mjs', ...args, '--file', queueFile],
    {cwd: process.cwd(), encoding: 'utf8'},
  );
  const key = 'core-warmup:2026-08-17T03:00:00.000Z';
  try {
    let r = run('enqueue', '--sections', 'profit,orders', '--priority', '10', '--idempotency-key', key, '--core-generated-at', 'G1');
    assert.equal(r.status, 0, r.stderr);
    let queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
    const firstRevision = queue.entries.map(e => [e.section, e.requestRevision]);
    assert.deepEqual(queue.entries.map(e => e.idempotencyKey), [`${key}::profit`, `${key}::orders`]);
    // Structured CLI schema: every outcome array is present and the legacy
    // aggregate stays consistent.
    const enqueueOut = JSON.parse(r.stdout);
    assert.deepEqual(enqueueOut.newlyQueued, ['profit', 'orders']);
    assert.deepEqual(enqueueOut.updatedRevision, []);
    assert.deepEqual(enqueueOut.deduplicatedPending, []);
    assert.deepEqual(enqueueOut.deduplicatedCompleted, []);
    assert.deepEqual(enqueueOut.coalescedRerun, []);
    assert.deepEqual(enqueueOut.requeuedCompleted, []);
    assert.deepEqual(enqueueOut.supersededByExisting, []);
    assert.deepEqual(enqueueOut.deduplicated, []);

    // Claim one (running), then a FRESH process invocation re-enqueues the
    // same key: deduplicated, no revision change, no rerun.
    r = run('claim', '--lease-seconds', '60');
    assert.equal(r.status, 0, r.stderr);
    const claim = JSON.parse(r.stdout);
    assert.equal(claim.claimed, true);
    r = run('enqueue', '--sections', 'profit,orders', '--priority', '10', '--idempotency-key', key, '--core-generated-at', 'G1');
    assert.equal(r.status, 0, r.stderr);
    const dedupOut = JSON.parse(r.stdout);
    assert.deepEqual(dedupOut.deduplicatedPending, ['profit', 'orders'], 'fresh process must report deduplicatedPending');
    assert.deepEqual(dedupOut.deduplicatedCompleted, []);
    assert.deepEqual(dedupOut.supersededByExisting, []);
    assert.deepEqual(dedupOut.deduplicated, ['profit', 'orders'], 'legacy aggregate must stay consistent');
    queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
    assert.deepEqual(queue.entries.map(e => [e.section, e.requestRevision]), firstRevision, 'no revision change across process invocation');
    assert.equal(queue.entries.find(e => e.section === claim.entry.section).rerun, false, 'no rerun across process invocation');

    // Complete the running claim, then a FRESH process re-enqueues: tombstone
    // no-op, the entry is not recreated.
    r = run(
      'complete', '--section', claim.entry.section, '--lease-id', claim.entry.leaseId,
      ...terminalEvidenceArgs(claim.entry.claimedCoreGeneratedAt, 'e'.repeat(64)),
    );
    assert.equal(r.status, 0, r.stderr);
    r = run('enqueue', '--sections', claim.entry.section, '--priority', '10', '--idempotency-key', key, '--core-generated-at', 'G1');
    assert.equal(r.status, 0, r.stderr);
    queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
    assert.equal(queue.entries.some(e => e.section === claim.entry.section), false, 'completed key must not be recreated');
    assert.ok(queue.completedIdempotency.some(rec => rec.idempotencyKey === `${key}::${claim.entry.section}`), 'tombstone must persist');

    // A new generation key enqueues normally in the same queue document.
    r = run('enqueue', '--sections', 'profit', '--priority', '10', '--idempotency-key', 'core-warmup:2026-08-17T04:00:00.000Z', '--core-generated-at', 'G2');
    assert.equal(r.status, 0, r.stderr);
    queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
    assert.equal(queue.entries.find(e => e.section === 'profit').requestRevision, 1);
  } finally {
    fs.rmSync(temp, {recursive: true, force: true});
  }
}

// ---- Requeue conflict: a completed G1 whose requeue collides with an entry
// bound to a different nonempty key (a newer G2) is a strict no-op classified
// supersededByExisting -- the G1 tombstone stays and the G2 entry stays
// byte-identical.  Same-key/no-entry requeues proceed normally.
{
  const queue = {version: 1, updatedAt: '', nextSequence: 0, entries: [], completedIdempotency: []};
  const keyG1 = 'core-warmup:G1';
  const keyG2 = 'core-warmup:G2';
  // G1 completes profit (tombstone) and orders (tombstone); profit then gets a
  // fresh G2 pending entry (a newer generation already owns the slot).
  enqueueSections(queue, {sections: ['profit', 'orders'], priority: 10, idempotencyKey: keyG1, now: at(0)});
  for (const [section, leaseId] of [['profit', 'lease-sc-p'], ['orders', 'lease-sc-o']]) {
    claimNext(queue, {leaseSeconds: 60, leaseId, now: at(1_000)});
    completeClaim(queue, {section, leaseId, now: at(2_000)});
  }
  assert.equal(queue.completedIdempotency.length, 2);
  enqueueSections(queue, {sections: ['profit'], priority: 10, idempotencyKey: keyG2, coreGeneratedAt: 'G2', now: at(3_000)});
  const g2Entry = queue.entries.find(e => e.section === 'profit');
  const g2Before = JSON.stringify({
    key: g2Entry.idempotencyKey,
    revision: g2Entry.requestRevision,
    rerun: g2Entry.rerun,
    status: g2Entry.status,
    priority: g2Entry.priority,
  });

  // Requeue G1 for BOTH completed sections: profit is superseded by the G2
  // entry, orders requeues normally.
  const conflicted = enqueueSections(queue, {
    sections: ['profit', 'orders'],
    priority: 10,
    idempotencyKey: keyG1,
    requeueCompletedSections: ['profit', 'orders'],
    now: at(4_000),
  });
  assert.deepEqual(conflicted.supersededByExisting, ['profit'], 'the G2-owned slot must classify supersededByExisting');
  assert.deepEqual(conflicted.requeuedCompleted, ['orders'], 'only the non-conflicting invalid tombstone is requeued');
  assert.deepEqual(conflicted.newlyQueued, ['orders'], 'the non-conflicting section recreates a fresh entry');
  // Every requested section is accounted exactly once across the structured
  // outcomes.
  const accounted = [
    ...conflicted.newlyQueued,
    ...conflicted.updatedRevision,
    ...conflicted.deduplicatedPending,
    ...conflicted.deduplicatedCompleted,
    ...conflicted.coalescedRerun,
    ...conflicted.supersededByExisting,
  ].slice().sort();
  assert.deepEqual(accounted, ['orders', 'profit'], 'requested sections must be accounted exactly once');

  const g2After = queue.entries.find(e => e.section === 'profit');
  assert.equal(JSON.stringify({
    key: g2After.idempotencyKey,
    revision: g2After.requestRevision,
    rerun: g2After.rerun,
    status: g2After.status,
    priority: g2After.priority,
  }), g2Before, 'the G2 entry must stay byte-identical under the G1 requeue');
  assert.equal(g2After.idempotencyKey, `${keyG2}::profit`, 'the newer key must never be adopted');
  assert.equal(
    queue.completedIdempotency.some(record => record.idempotencyKey === `${keyG1}::profit`),
    true,
    'the G1 profit tombstone must be retained',
  );
  assert.equal(
    queue.completedIdempotency.some(record => record.idempotencyKey === `${keyG1}::orders`),
    false,
    'the G1 orders tombstone is removed because orders requeued normally',
  );
  assert.equal(queue.entries.find(e => e.section === 'orders').idempotencyKey, `${keyG1}::orders`);

  // Same-key existing entry requeues normally (deduplicated pending).
  const sameKey = enqueueSections(queue, {
    sections: ['orders'],
    priority: 10,
    idempotencyKey: keyG1,
    requeueCompletedSections: ['orders'],
    now: at(5_000),
  });
  assert.deepEqual(sameKey.supersededByExisting, [], 'a same-key entry is never superseded');
  assert.deepEqual(sameKey.deduplicatedPending, ['orders'], 'the same-key entry deduplicates as pending');
}

console.log('bi_portal_section_queue: sequence/revision/backoff reliability invariants passed');
