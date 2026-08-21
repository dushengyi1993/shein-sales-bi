#!/usr/bin/env node
import assert from 'node:assert/strict';

import {__testHooks} from './serve_bi_portal.mjs';

const {BI_PORTAL_CORE_WARMUP_STALLED_AFTER_MS, evaluateBiPortalCoreWarmupHealth} = __testHooks;
const nowMs = Date.parse('2026-08-19T15:00:00.000Z');
const stalledAfterMs = 45 * 60_000;

assert.equal(BI_PORTAL_CORE_WARMUP_STALLED_AFTER_MS, 105 * 60_000,
  'default stall threshold must exceed the scheduled 90-minute reserved-hour gap');

assert.deepEqual(
  evaluateBiPortalCoreWarmupHealth({status: 'idle', owner: '', startedAt: 0, inFlight: null}, {nowMs, stalledAfterMs}),
  {ok: true, stalled: false, queuedAgeMs: 0, stalledAfterMs},
);
assert.equal(evaluateBiPortalCoreWarmupHealth({
  status: 'queued', owner: 'external-section-queue',
  startedAt: nowMs - 44 * 60_000, inFlight: null,
}, {nowMs, stalledAfterMs}).ok, true, 'a normal bounded queue wait must stay healthy');
assert.equal(evaluateBiPortalCoreWarmupHealth({
  status: 'queued', owner: 'external-section-queue',
  startedAt: nowMs - stalledAfterMs, inFlight: null,
}, {nowMs, stalledAfterMs}).stalled, true, 'a long unconsumed external queue must degrade health');
assert.equal(evaluateBiPortalCoreWarmupHealth({
  status: 'queued', owner: 'external-section-queue',
  startedAt: nowMs - 2 * stalledAfterMs, inFlight: Promise.resolve(),
}, {nowMs, stalledAfterMs}).ok, true, 'an in-flight consumer must not be reported as stalled');
assert.equal(evaluateBiPortalCoreWarmupHealth({
  status: 'queued', owner: 'inline',
  startedAt: nowMs - 2 * stalledAfterMs, inFlight: null,
}, {nowMs, stalledAfterMs}).ok, true, 'only the externally owned queue uses this stall detector');

console.log('bi_core_warmup_health: bounded queue waits stay healthy and abandoned external queues degrade');
