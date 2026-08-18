#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createLinkOpsJobWorker} from '../lib/link_ops_job_worker.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return {promise, resolve, reject};
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitUntil(condition, {timeoutMs = 3_000, intervalMs = 5} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) throw new Error('waitUntil timed out');
    await sleep(intervalMs);
  }
}

/**
 * Deterministic job store with real lease fields (status/leaseOwner/
 * leaseExpiresAt) so assertions can prove that a drained in-flight iteration
 * leaves no running or failed lease behind. Optional claim gating
 * (blockClaimAfter) parks every claim after the given ordinal on one deferred
 * so tests can hold a claimJob() await in flight and release it later.
 */
function createFakeJobStore({blockClaimAfter = -1} = {}) {
  const jobs = new Map();
  const calls = {claim: 0, advance: 0, finish: 0, close: 0, blockedClaims: 0};
  let gate = null;
  const store = {
    mode: 'json',
    async claimJob({workerId, leaseMs}) {
      calls.claim += 1;
      if (blockClaimAfter >= 0 && calls.claim > blockClaimAfter) {
        calls.blockedClaims += 1;
        if (!gate) gate = deferred();
        await gate.promise;
      }
      const job = [...jobs.values()].find(candidate => candidate.status === 'queued');
      if (!job) return null;
      job.status = 'running';
      job.leaseOwner = workerId;
      job.leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
      job.startedAt = new Date().toISOString();
      return {...job};
    },
    async advanceJobWriteBoundary(jobId, writeBoundary) {
      calls.advance += 1;
      const job = jobs.get(jobId);
      if (job) job.writeBoundary = writeBoundary;
      return {...(job || {})};
    },
    async finishJob(jobId, changes) {
      calls.finish += 1;
      const job = jobs.get(jobId);
      if (job) {
        job.status = changes.status;
        job.result = changes.result ?? null;
        job.error = changes.error ?? null;
        job.leaseOwner = null;
        job.leaseExpiresAt = null;
        job.finishedAt = new Date().toISOString();
      }
      return {...(job || {})};
    },
    async getJob(jobId) { return {...(jobs.get(jobId) || null)}; },
    async close() { calls.close += 1; },
    enqueue(id, kind = 'intent_plan', payload = {}) {
      jobs.set(id, {jobId: id, id, kind, payload, status: 'queued', writeBoundary: 'none', attempt: 0, repositoryRevision: 1, payloadHash: 'fake'});
    },
    job(id) { return {...(jobs.get(id) || null)}; },
  };
  return {
    store,
    calls,
    releaseBlockedClaims: () => { if (gate) gate.resolve(); },
    hasBlockedClaims: () => Boolean(gate),
  };
}

// (1) close-admission 后不再新 claim：stopAdmitting() 同步关闭入场，
// 之后既有 timer 不再触发新 claim，手动 runOnce() 也会被拒绝。
{
  const {store, calls} = createFakeJobStore();
  store.enqueue('j1', 'intent_plan', {});
  const worker = createLinkOpsJobWorker({store, workerId: 'shutdown-t1', handlers: {intent_plan: async () => ({applied: true})}});
  // 未 start 也可手动驱动（非 shutdown 行为不回归）。
  assert.deepEqual(await worker.runOnce(), {claimed: true, jobId: 'j1'});
  assert.equal((await store.getJob('j1')).status, 'succeeded');
  assert.equal(calls.claim, 1);
  assert.equal(worker.status().admissionClosed, false);

  worker.stopAdmitting();
  assert.equal(worker.status().admissionClosed, true);
  assert.equal(worker.status().inFlight, false);

  // Admission close is terminal for this instance. A late startup
  // continuation must not reopen polling against a closing store.
  worker.start();
  assert.equal(worker.status().admissionClosed, true);
  assert.equal(worker.status().stopped, true);

  // 关闭入场后即使有新任务排队，也不能发起新 claim。
  store.enqueue('j2', 'intent_plan', {});
  assert.deepEqual(await worker.runOnce(), {claimed: false, skipped: true});
  assert.equal(calls.claim, 1);
  assert.equal((await store.getJob('j2')).status, 'queued');
  await worker.drain();
  assert.equal(calls.claim, 1);
}

// (1b) close-admission 后 timer 不再触发新 claim：停止前已在等待的 poll
// timer 会被清除，等待超过轮询间隔也不会发生新 claim。
{
  const {store, calls} = createFakeJobStore();
  store.enqueue('j1', 'intent_plan', {});
  const worker = createLinkOpsJobWorker({store, workerId: 'shutdown-t1b', pollMs: 100, handlers: {intent_plan: async () => ({applied: true})}});
  worker.start();
  await waitUntil(async () => (await store.getJob('j1')).status === 'succeeded');
  await sleep(60); // let the worker settle back onto its poll timer
  store.enqueue('j2', 'intent_plan', {});
  worker.stopAdmitting();
  const claimsAtAdmissionClose = calls.claim;
  await sleep(300); // far beyond pollMs=100
  assert.equal(calls.claim, claimsAtAdmissionClose, 'no claim may start after admission close');
  assert.equal((await store.getJob('j2')).status, 'queued');
  assert.equal(worker.status().admissionClosed, true);
  await worker.drain();
  assert.equal(calls.claim, claimsAtAdmissionClose);
}

// (2) 与异步 claim 交错：claimJob() 仍在等待时 shutdown，该已进入 claim 的
// iteration 被归类为 in-flight 并被 drain 到终态，且不遗留 running lease。
{
  const {store, calls, releaseBlockedClaims, hasBlockedClaims} = createFakeJobStore({blockClaimAfter: 0});
  store.enqueue('j1', 'intent_plan', {});
  const worker = createLinkOpsJobWorker({store, workerId: 'shutdown-t2', handlers: {intent_plan: async () => ({applied: true})}});
  const runPromise = worker.runOnce(); // 同步进入 claimJob 并停在 gate 上
  assert.equal(worker.status().inFlight, true, 'an iteration that entered claim must be in-flight');
  assert.equal(hasBlockedClaims(), true);

  let drained = false;
  const drainPromise = worker.stop().then(() => { drained = true; });
  await sleep(40);
  assert.equal(drained, false, 'drain must wait while the in-flight claim is pending');
  assert.equal(worker.status().admissionClosed, true);

  releaseBlockedClaims();
  assert.equal(await drainPromise, undefined);
  assert.equal((await runPromise).claimed, true);
  const terminal = await store.getJob('j1');
  assert.equal(terminal.status, 'succeeded');
  assert.equal(terminal.leaseOwner, null, 'no leftover running lease');
  assert.equal(terminal.leaseExpiresAt, null);
  assert.equal(worker.status().inFlight, false);
}

// (2b) 与异步 handler 交错：handler 仍在执行时 shutdown，in-flight iteration
// 被 drain 并在失败路径写入终态，不遗留 running/failed lease。
{
  const {store} = createFakeJobStore();
  store.enqueue('j1', 'intent_plan', {});
  const handlerGate = deferred();
  const worker = createLinkOpsJobWorker({
    store,
    workerId: 'shutdown-t2b',
    handlers: {
      intent_plan: async () => {
        await handlerGate.promise;
        throw Object.assign(new Error('boom'), {code: 'MODEL_FAILED'});
      },
    },
  });
  const runPromise = worker.runOnce();
  assert.equal(worker.status().inFlight, true);

  worker.stopAdmitting();
  let drained = false;
  const drainPromise = worker.drain().then(() => { drained = true; });
  await sleep(30);
  assert.equal(drained, false, 'drain must wait while the in-flight handler is running');

  handlerGate.resolve();
  await drainPromise;
  await runPromise;
  const terminal = await store.getJob('j1');
  assert.equal(terminal.status, 'failed');
  assert.equal(terminal.error.code, 'MODEL_FAILED');
  assert.equal(terminal.leaseOwner, null, 'no leftover running/failed lease');
  assert.equal(terminal.leaseExpiresAt, null);
  assert.equal(worker.status().inFlight, false);
}

// (2c) A durable terminal-write failure is a failed drain, not a graceful
// shutdown. Propagate it so Portal skips store close and exits non-zero.
{
  const {store} = createFakeJobStore();
  store.enqueue('j1', 'intent_plan', {});
  const finishError = Object.assign(new Error('terminal write unavailable'), {code: 'STORE_WRITE_FAILED'});
  store.finishJob = async () => { throw finishError; };
  const handlerGate = deferred();
  const worker = createLinkOpsJobWorker({
    store,
    workerId: 'shutdown-t2c',
    handlers: {intent_plan: async () => { await handlerGate.promise; return {applied: true}; }},
  });
  const runPromise = worker.runOnce();
  const stopPromise = worker.stop();
  handlerGate.resolve();
  await assert.rejects(stopPromise, error => error === finishError);
  await assert.rejects(runPromise, error => error === finishError);
  assert.equal((await store.getJob('j1')).status, 'running',
    'a failed terminal write must remain visible as unresolved, never reported drained');
}

// (4) 重复 shutdown 幂等：并发/重复 stop()、drain()、stopAdmitting() 安全且只 drain 一次。
{
  const {store, calls} = createFakeJobStore();
  store.enqueue('j1', 'intent_plan', {});
  const worker = createLinkOpsJobWorker({store, workerId: 'shutdown-t4', handlers: {intent_plan: async () => ({applied: true})}});
  const firstRun = worker.runOnce();
  assert.equal(worker.status().inFlight, true);
  const [a, b, c, d] = await Promise.all([worker.stop(), worker.stop(), worker.drain(), worker.drain()]);
  assert.equal(a, undefined);
  assert.equal(b, undefined);
  assert.equal(c, undefined);
  assert.equal(d, undefined);
  await firstRun;
  assert.equal((await store.getJob('j1')).status, 'succeeded');

  worker.stopAdmitting();
  worker.stopAdmitting();
  store.enqueue('j2', 'intent_plan', {});
  assert.deepEqual(await worker.runOnce(), {claimed: false, skipped: true});
  assert.equal(calls.claim, 1, 'repeated admission close must still refuse new claims');
  await worker.stop();
  await worker.drain();
  assert.equal(worker.status().admissionClosed, true);
}


// (5) 正常非 shutdown 行为不回归：start() 轮询按序处理任务、wake() 安全、
// stop() 收尾后状态干净（用确定性 fake store，避免 Windows 文件系统抖动）。
{
  const {store, calls} = createFakeJobStore();
  store.enqueue('poll-1', 'intent_plan', {});
  store.enqueue('poll-2', 'intent_plan', {});
  const workerEvents = [];
  const worker = createLinkOpsJobWorker({
    store,
    workerId: 'shutdown-real',
    pollMs: 100,
    handlers: {intent_plan: async () => ({applied: true})},
    onEvent: event => { workerEvents.push(`${event.event}:${event.jobId}`); },
  });
  worker.start();
  await waitUntil(async () => (await store.getJob('poll-1')).status === 'succeeded', {timeoutMs: 5_000});
  await waitUntil(async () => (await store.getJob('poll-2')).status === 'succeeded', {timeoutMs: 5_000});
  worker.wake();
  await worker.stop();
  assert.equal(worker.status().admissionClosed, true);
  for (const id of ['poll-1', 'poll-2']) {
    const terminal = await store.getJob(id);
    assert.ok(!terminal.leaseOwner, `no leftover running lease on ${id}`);
    assert.equal(terminal.leaseExpiresAt, null, `lease expiry must be cleared on ${id}`);
  }
  assert.deepEqual(workerEvents, ['started:poll-1', 'succeeded:poll-1', 'started:poll-2', 'succeeded:poll-2'],
    `worker events must show both jobs drained in order: ${JSON.stringify(workerEvents)}`);
  assert.equal(calls.claim, 2, 'normal polling must claim each queued job exactly once');
}
console.log(JSON.stringify({
  ok: true,
  admissionCloseRefusesNewClaim: true,
  timerNoLongerClaimsAfterAdmissionClose: true,
  inFlightClaimDrainedToTerminal: true,
  inFlightHandlerFailedDrainedToTerminal: true,
  noLeftoverRunningOrFailedLease: true,
  repeatedShutdownIdempotent: true,
  restartAfterAdmissionCloseRefused: true,
  terminalWriteFailurePropagated: true,
  normalPollingNotRegressed: true,
}, null, 2));
