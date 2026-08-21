#!/usr/bin/env node
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';

import {
  createBiLiveUpdateBridge,
  executeBiCanonicalAccountingCatchupAttempt,
  executeBiLiveAccountingRefreshAttempt,
  normalizeBiLiveAccountingGeneration,
} from './serve_bi_portal.mjs';

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
    this.nextWriteResult = true;
    this.writableEnded = false;
    this.destroyed = false;
    this.ended = false;
  }

  write(value) {
    this.writes.push(String(value));
    const result = this.nextWriteResult;
    this.nextWriteResult = true;
    return result;
  }

  end() {
    this.ended = true;
    this.writableEnded = true;
  }

  destroy() {
    this.destroyed = true;
  }
}

const fixedNow = () => new Date('2026-08-18T12:00:00.000Z');
assert.equal(normalizeBiLiveAccountingGeneration({mode: 'api', generatedAt: '2026-08-18T19:59:00.000+08:00'}), '2026-08-18T19:59:00.000+08:00');
assert.equal(normalizeBiLiveAccountingGeneration({mode: 'legacy', generatedAt: '2026-08-18T19:59:00.000+08:00'}), '');
assert.equal(normalizeBiLiveAccountingGeneration({mode: 'api', generatedAt: ''}), '');
assert.equal(normalizeBiLiveAccountingGeneration({mode: 'api', generatedAt: 'not-a-generation'}), '');

for (const fixture of [
  {name: 'missing', meta: {mode: 'legacy', generatedAt: ''}},
  {name: 'invalid', meta: {mode: 'api', generatedAt: 'not-a-generation'}},
]) {
  const calls = {read: 0, generate: 0, persist: 0, publish: 0};
  await assert.rejects(() => executeBiLiveAccountingRefreshAttempt({
    sourceEvent: {kind: 'order', entityId: fixture.name},
    allowGenerateSections: true,
    readCoreMeta: async () => { calls.read += 1; return fixture.meta; },
    generateLiveProjection: async () => { calls.generate += 1; },
    clearLiveProjectionFailure: () => {},
    persistAccountingPlan: async () => { calls.persist += 1; },
    publish: () => { calls.publish += 1; },
    now: fixedNow,
  }), error => error.code === 'BI_LIVE_ACCOUNTING_GENERATION_MISSING');
  assert.deepEqual(calls, {read: 1, generate: 0, persist: 0, publish: 0},
    `${fixture.name} core generation must fail before projection, success SSE, or queue persistence`);
}

{
  const calls = {read: 0, generate: 0, persist: 0, publish: 0};
  await assert.rejects(() => executeBiLiveAccountingRefreshAttempt({
    sourceEvent: {kind: 'order'},
    allowGenerateSections: false,
    readCoreMeta: async () => { calls.read += 1; return {mode: 'api', generatedAt: '2026-08-18T19:59:00.000+08:00'}; },
    generateLiveProjection: async () => { calls.generate += 1; },
    persistAccountingPlan: async () => { calls.persist += 1; },
    publish: () => { calls.publish += 1; },
  }), error => error.code === 'BI_LIVE_ACCOUNTING_GENERATION_DISABLED');
  assert.deepEqual(calls, {read: 0, generate: 0, persist: 0, publish: 0},
    'read-only/disabled generation must not claim a refreshed projection');
}

{
  const calls = [];
  const result = await executeBiLiveAccountingRefreshAttempt({
    sourceEvent: {kind: 'return', entityId: 'valid-return', refreshHistoricalSections: true},
    allowGenerateSections: true,
    readCoreMeta: async () => ({mode: 'api', generatedAt: '2026-08-18T19:59:00.000+08:00'}),
    generateLiveProjection: async generatedAt => calls.push(['generate', generatedAt]),
    clearLiveProjectionFailure: () => calls.push(['clear']),
    persistAccountingPlan: async (plan, generatedAt, options) => calls.push(['persist', plan, generatedAt, options]),
    publish: event => calls.push(['publish', event]),
    now: fixedNow,
  });
  assert.equal(result.ok, true);
  assert.equal(result.accountingQueued, true);
  assert.equal(calls[0][0], 'generate');
  assert.equal(calls[1][0], 'clear');
  assert.equal(calls[2][0], 'publish');
  assert.equal(calls[2][1].liveProjectionRefreshed, true);
  assert.equal(calls[3][0], 'persist');
  assert.match(calls[3][3].idempotencyKey, /^portal-live:sha256:/);
  assert.match(calls[3][3].coalesceKey, /^portal-generation:sha256:/);
  assert.equal(calls[4][0], 'publish');
  assert.equal(calls[4][1].accountingQueued, true);
}

{
  const calls = [];
  const result = await executeBiLiveAccountingRefreshAttempt({
    sourceEvent: {
      kind: 'order',
      entityId: 'current-day-order',
      businessDate: '2026-08-18',
      occurredAt: '2026-08-18T12:00:00.000Z',
      receivedAt: '2026-08-18T12:00:01.000Z',
    },
    allowGenerateSections: true,
    readCoreMeta: async () => ({mode: 'api', generatedAt: '2026-08-18T19:59:00.000+08:00'}),
    generateLiveProjection: async generatedAt => calls.push(['generate', generatedAt]),
    clearLiveProjectionFailure: () => calls.push(['clear']),
    persistAccountingPlan: async () => { throw new Error('ordinary current-day order must not persist heavy accounting'); },
    publish: event => calls.push(['publish', event]),
    now: fixedNow,
  });
  assert.equal(result.ok, true);
  assert.equal(result.accountingQueued, false);
  assert.deepEqual(calls.map(call => call[0]), ['generate', 'clear', 'publish']);
  assert.equal(calls[2][1].liveProjectionRefreshed, true);
  assert.equal(calls[2][1].accountingQueued, undefined);
}

{
  const calls = [];
  const staleState = {decision: {fresh: false}, minimumPublishedAt: '2026-08-18T11:59:00.000Z'};
  const result = await executeBiCanonicalAccountingCatchupAttempt({
    allowGenerateSections: true,
    readCoreMeta: async () => ({mode: 'api', generatedAt: '2026-08-18T19:59:00.000+08:00'}),
    readAccountingState: async generatedAt => { calls.push(['read', generatedAt]); return staleState; },
    persistCatchup: async (state, generatedAt) => { calls.push(['persist', state, generatedAt]); return true; },
  });
  assert.equal(result.queued, true);
  assert.deepEqual(calls.map(call => call[0]), ['read', 'persist']);
  assert.equal(calls[1][1], staleState);
}

{
  let persisted = false;
  const result = await executeBiCanonicalAccountingCatchupAttempt({
    allowGenerateSections: true,
    readCoreMeta: async () => ({mode: 'api', generatedAt: '2026-08-18T19:59:00.000+08:00'}),
    readAccountingState: async () => ({decision: {fresh: true}}),
    persistCatchup: async () => { persisted = true; },
  });
  assert.equal(result.fresh, true);
  assert.equal(result.queued, false);
  assert.equal(persisted, false);
}

{
  let resolveAccountingState;
  let accountingReadStarted;
  const started = new Promise(resolve => { accountingReadStarted = resolve; });
  const accountingState = new Promise(resolve => { resolveAccountingState = resolve; });
  let running = true;
  let persisted = false;
  const attempt = executeBiCanonicalAccountingCatchupAttempt({
    allowGenerateSections: true,
    readCoreMeta: async () => ({mode: 'api', generatedAt: '2026-08-18T19:59:00.000+08:00'}),
    readAccountingState: async () => { accountingReadStarted(); return accountingState; },
    persistCatchup: async () => { persisted = true; },
    shouldContinue: () => running,
  });
  await started;
  running = false;
  resolveAccountingState({decision: {fresh: false}});
  const result = await attempt;
  assert.equal(result.skipped, 'stopped');
  assert.equal(persisted, false, 'shutdown during freshness read must prevent later queue persistence');
}

const bridge = createBiLiveUpdateBridge({
  env: {SHEIN_BI_LIVE_UPDATES_ENABLED: '0'},
  now: fixedNow,
  heartbeatMs: 0,
});
const slow = new FakeResponse();
const healthy = new FakeResponse();
bridge.addSseClient(slow);
bridge.addSseClient(healthy);
assert.equal(bridge.status().clients, 2);
slow.nextWriteResult = false;
const slowWritesBefore = slow.writes.length;
const healthyWritesBefore = healthy.writes.length;
bridge.publish({kind: 'order', entityId: 'first'});
assert.equal(slow.writes.length, slowWritesBefore + 1, 'the slow client receives only the write that exposed backpressure');
assert.equal(slow.ended || slow.destroyed, true, 'write=false must terminate the slow SSE response');
assert.equal(bridge.status().clients, 1, 'write=false must remove the client immediately');
assert.equal(healthy.writes.length, healthyWritesBefore + 1, 'a healthy client must still receive the same event');
bridge.publish({kind: 'order', entityId: 'second'});
assert.equal(slow.writes.length, slowWritesBefore + 1, 'removed client must never receive later events');
assert.equal(healthy.writes.length, healthyWritesBefore + 2);
healthy.emit('error', new Error('client gone'));
healthy.emit('close');
assert.equal(bridge.status().clients, 0, 'error/close cleanup must be idempotent and status-exact');
await bridge.stop();

const portalSource = await fs.readFile(new URL('./serve_bi_portal.mjs', import.meta.url), 'utf8');
assert.match(portalSource, /liveAccountingRefreshPendingEvent \|\|= sourceEvent/,
  'a failed guarded attempt must retain the event for the existing bounded retry');
assert.match(portalSource, /setTimeout\(runLiveAccountingRefresh, liveAccountingRetryMs\)/,
  'guard failures must use the configured bounded retry delay');
assert.match(portalSource, /!allowGenerateSections[\s\S]*return;/,
  'read-only Portal surfaces must not schedule live accounting generation');

console.log(JSON.stringify({
  ok: true,
  missingGenerationFailedClosed: true,
  invalidGenerationFailedClosed: true,
  generationDisabledFailedClosed: true,
  noSuccessPublishOrQueueWithoutGeneration: true,
  boundedRetryRetained: true,
  sseBackpressureDropsOnlySlowClient: true,
  sseStatusExact: true,
}, null, 2));
