#!/usr/bin/env node

import assert from 'node:assert/strict';

import {
  claimNext,
  completeClaim,
  enqueueSections,
  failClaim,
} from './manage_bi_portal_section_queue.mjs';

const queue = {version: 1, updatedAt: '', entries: []};
const start = new Date('2026-08-04T08:50:00.000Z');
enqueueSections(queue, {
  sections: ['profit', 'homeRankings'],
  priority: 50,
  reason: 'morning',
  now: start,
});
enqueueSections(queue, {
  sections: ['homeRankings', 'orders'],
  priority: 10,
  reason: 'live-return',
  now: new Date(start.getTime() + 1_000),
});
assert.equal(queue.entries.length, 3);
assert.equal(queue.entries.find(entry => entry.section === 'homeRankings').priority, 10);
assert.deepEqual(queue.entries.find(entry => entry.section === 'homeRankings').reasons, ['morning', 'live-return']);

const first = claimNext(queue, {
  leaseSeconds: 60,
  leaseId: 'lease-1',
  now: new Date(start.getTime() + 2_000),
});
assert.equal(first.section, 'homeRankings');
assert.equal(first.attempts, 1);
completeClaim(queue, {section: 'homeRankings', leaseId: 'lease-1'});
assert.equal(queue.entries.some(entry => entry.section === 'homeRankings'), false);

const second = claimNext(queue, {
  leaseSeconds: 60,
  leaseId: 'lease-2',
  now: new Date(start.getTime() + 3_000),
});
assert.equal(second.section, 'orders');
failClaim(queue, {
  section: 'orders',
  leaseId: 'lease-2',
  error: 'temporary',
  now: new Date(start.getTime() + 4_000),
});
assert.equal(queue.entries.find(entry => entry.section === 'orders').status, 'pending');

const retried = claimNext(queue, {
  leaseSeconds: 60,
  leaseId: 'lease-3',
  now: new Date(start.getTime() + 5_000),
});
assert.equal(retried.section, 'orders');
assert.equal(retried.attempts, 2);

const recovered = claimNext(queue, {
  leaseSeconds: 60,
  leaseId: 'lease-4',
  now: new Date(start.getTime() + 70_000),
});
assert.equal(recovered.section, 'orders');
assert.equal(recovered.attempts, 3);

assert.throws(() => enqueueSections(queue, {sections: ['../escape']}), /SECTION_INVALID/);
console.log(JSON.stringify({ok: true}));
