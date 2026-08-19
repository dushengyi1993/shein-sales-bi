#!/usr/bin/env node
import assert from 'node:assert/strict';

import {__testHooks} from './serve_bi_portal.mjs';

const {createProfitAccountingStateReader, profitAccountingStateCacheKey} = __testHooks;
const args = {distro: '', container: 'warehouse', database: 'bi', user: 'reader'};
const freshness = {
  factOrderMax: '2026-08-18',
  factUpdatedAt: '2026-08-19T06:00:00.000Z',
  orderFactUpdatedAt: '2026-08-19T06:00:00.000Z',
  accountingInputUpdatedAt: '2026-08-19T06:00:00.000Z',
  profitCacheMax: '2026-08-18',
  profitCacheRows: 1,
  metaRefreshedAt: '2026-08-19T06:00:00.000Z',
  costRunCompletedAt: '2026-08-19T06:00:00.000Z',
  costRunSourceCutoffAt: '2026-08-19T06:00:00.000Z',
  costAssignmentCoverageRequired: false,
};

let now = 1_000;
let calls = 0;
let releaseFirst;
const firstGate = new Promise(resolve => { releaseFirst = resolve; });
const reader = createProfitAccountingStateReader({
  ttlMs: 30_000,
  now: () => now,
  loadFreshness: async () => {
    calls += 1;
    if (calls === 1) await firstGate;
    return freshness;
  },
});

const concurrent = Array.from({length: 24}, () => reader.read(args, 'generation-a'));
await Promise.resolve();
assert.equal(calls, 1, 'concurrent homepage reads must share one warehouse freshness probe');
releaseFirst();
const results = await Promise.all(concurrent);
assert(results.every(result => result.minimumPublishedAt === freshness.metaRefreshedAt));

await reader.read(args, 'generation-a');
assert.equal(calls, 1, 'settled state must be reused within the bounded TTL');
await reader.read(args, 'generation-a', {forceFresh: true});
assert.equal(calls, 2, 'host-locked refresh must bypass a settled cached decision');

now += 30_001;
await reader.read(args, 'generation-a');
assert.equal(calls, 3, 'expired accounting state must be reprobed');
await reader.read(args, 'generation-b');
assert.equal(calls, 4, 'a new core generation must never reuse an older decision');
reader.invalidate();
await reader.read(args, 'generation-b');
assert.equal(calls, 5, 'live accounting invalidation must force an immediate recheck');

let failureCalls = 0;
const failingReader = createProfitAccountingStateReader({
  ttlMs: 30_000,
  loadFreshness: async () => {
    failureCalls += 1;
    if (failureCalls === 1) throw new Error('temporary database failure');
    return freshness;
  },
});
await assert.rejects(failingReader.read(args, 'generation-a'), /temporary database failure/);
await failingReader.read(args, 'generation-a');
assert.equal(failureCalls, 2, 'failed probes must not be negative-cached');

assert.notEqual(
  profitAccountingStateCacheKey(args, 'generation-a'),
  profitAccountingStateCacheKey({...args, database: 'other'}, 'generation-a'),
  'database identity must be part of the cache key',
);

console.log('PASS bi portal accounting state cache');
