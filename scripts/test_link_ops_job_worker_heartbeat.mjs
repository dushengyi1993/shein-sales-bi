#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createLinkOpsJobWorker} from '../lib/link_ops_job_worker.mjs';

console.log('Starting F3 definitive monotonic, anti-latency-revival & multi-worker tests...');

function createMockStore({initialLeaseMs = 600_000} = {}) {
  let now = 1_000_000;
  let jobState = {
    jobId: 'job-101',
    kind: 'intent_plan',
    status: 'pending',
    leaseOwner: null,
    leaseExpiresAt: new Date(Date.now() + initialLeaseMs).toISOString(),
    heartbeatAt: null,
    repositoryRevision: 1,
    writeBoundary: null,
    payloadHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    result: null,
    error: null,
  };

  const heartbeatLog = [];
  const finishLog = [];
  let hungHeartbeat = false;
  let delayHeartbeatMs = 0;

  return {
    getTime: () => now,
    advanceTime: (ms) => { now += ms; },
    getJobState: () => ({...jobState}),
    getHeartbeatLog: () => [...heartbeatLog],
    getFinishLog: () => [...finishLog],
    setHungHeartbeat: (val) => { hungHeartbeat = val; },
    setDelayHeartbeatMs: (ms) => { delayHeartbeatMs = ms; },
    expireJob: () => { jobState.leaseExpiresAt = new Date(Date.now() - 1_000).toISOString(); },

    async getJob(jobId) {
      if (jobId !== jobState.jobId) return null;
      return {...jobState};
    },

    async claimJob({workerId, leaseMs}) {
      if (jobState.status === 'running' && jobState.leaseExpiresAt && new Date(jobState.leaseExpiresAt).getTime() > Date.now()) {
        return null;
      }
      if (jobState.status !== 'pending' && jobState.status !== 'running') {
        return null;
      }
      jobState.status = 'running';
      jobState.leaseOwner = workerId;
      jobState.leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
      jobState.heartbeatAt = new Date().toISOString();
      jobState.repositoryRevision += 1;
      return {...jobState};
    },

    async advanceJobWriteBoundary(jobId, boundary, {leaseOwner, expectedRevision, payloadHash}) {
      assert.equal(jobId, jobState.jobId);
      if (jobState.status !== 'running' || jobState.leaseOwner !== leaseOwner || jobState.repositoryRevision !== expectedRevision || !jobState.leaseExpiresAt || new Date(jobState.leaseExpiresAt).getTime() <= Date.now()) {
        const err = new Error(`Revision conflict or lease expired for job ${jobId}`);
        err.code = 'REVISION_CONFLICT';
        throw err;
      }
      jobState.writeBoundary = boundary;
      jobState.heartbeatAt = new Date().toISOString();
      jobState.repositoryRevision += 1;
      return {...jobState};
    },

    async heartbeatJob(jobId, {leaseOwner, expectedRevision, leaseMs}) {
      assert.equal(jobId, jobState.jobId);
      if (hungHeartbeat) {
        return new Promise(() => {});
      }
      if (delayHeartbeatMs > 0) {
        await new Promise(r => setTimeout(r, delayHeartbeatMs));
      }
      if (jobState.status !== 'running' || jobState.leaseOwner !== leaseOwner || jobState.repositoryRevision !== expectedRevision) {
        const error = new Error(`Revision conflict or lease expired for job ${jobId}`);
        error.code = 'REVISION_CONFLICT';
        throw error;
      }
      jobState.heartbeatAt = new Date().toISOString();
      jobState.leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
      jobState.repositoryRevision += 1;
      heartbeatLog.push({at: Date.now(), revision: jobState.repositoryRevision, leaseExpiresAt: jobState.leaseExpiresAt});
      return {...jobState};
    },

    async finishJob(jobId, {status, leaseOwner, expectedRevision, result, error}) {
      assert.equal(jobId, jobState.jobId);
      if (jobState.status !== 'running' || jobState.leaseOwner !== leaseOwner || jobState.repositoryRevision !== expectedRevision) {
        const err = new Error(`Cannot finish job ${jobId}: lease expired or revision conflict`);
        err.code = 'FINISH_CONFLICT';
        throw err;
      }
      jobState.status = status;
      jobState.result = result;
      jobState.error = error;
      jobState.leaseOwner = '';
      jobState.leaseExpiresAt = null;
      jobState.repositoryRevision += 1;
      finishLog.push({status, revision: jobState.repositoryRevision, leaseOwner, result, error});
      return {...jobState};
    },
  };
}

// Test 1: Periodic heartbeat maintains lease across multiple intervals
{
  const store = createMockStore();
  let executionChecked = false;

  const worker = createLinkOpsJobWorker({
    store,
    workerId: 'worker-primary',
    leaseMs: 5_000,
    heartbeatIntervalMs: 100,
    handlers: {
      async intent_plan(job, context) {
        assert.equal(context.isLeaseActive(), true);
        context.checkLease();

        for (let i = 0; i < 3; i++) {
          await new Promise(r => setTimeout(r, 120));
          context.checkLease();
          assert.equal(context.signal.aborted, false);
        }

        executionChecked = true;
        return {executed: true, totalCycles: 3};
      }
    },
  });

  const result = await worker.runOnce();
  assert.equal(result.claimed, true);
  assert.equal(executionChecked, true);

  const heartbeats = store.getHeartbeatLog();
  assert.ok(heartbeats.length >= 2, `Expected at least 2 heartbeats, got ${heartbeats.length}`);
  const jobState = store.getJobState();
  assert.equal(jobState.status, 'succeeded');
  console.log('✓ Test 1 passed: Periodic heartbeat maintains lease and updates revision');
}

// Test 2: Wall-clock time roll-back does NOT trick monotonic performance.now() deadline
{
  const store = createMockStore();

  const originalDateNow = Date.now;
  try {
    const worker = createLinkOpsJobWorker({
      store,
      workerId: 'worker-monotonic-check',
      leaseMs: 5_000,
      heartbeatIntervalMs: 100,
      handlers: {
        async intent_plan(job, context) {
          Date.now = () => 1_000_000_000;

          const monoDeadline = context.getMonotonicDeadline();
          assert.ok(monoDeadline > performance.now(), 'Deadline must be ahead in monotonic time');

          context.checkLease();
          return {monotonicSafe: true};
        }
      },
    });

    const res = await worker.runOnce();
    assert.equal(res.claimed, true);
    assert.equal(store.getJobState().status, 'succeeded');
    console.log('✓ Test 2 passed: Wall-clock rollback does not affect monotonic deadline');
  } finally {
    Date.now = originalDateNow;
  }
}

// Test 3: Response latency approaching expiry & late heartbeat cannot revive lease
{
  const store = createMockStore();
  const workerEvents = [];
  let workerSideEffects = 0;
  let caughtAbort = false;

  const worker = createLinkOpsJobWorker({
    store,
    workerId: 'worker-latency-guard',
    leaseMs: 5_000,
    heartbeatIntervalMs: 100,
    handlers: {
      async intent_plan(job, context) {
        await new Promise(r => setTimeout(r, 120));

        store.setDelayHeartbeatMs(350);

        await new Promise(r => setTimeout(r, 450));

        assert.equal(context.isLeaseActive(), false);
        assert.equal(context.signal.aborted, true);

        try {
          context.checkLease();
          workerSideEffects += 1;
        } catch (err) {
          caughtAbort = true;
          assert.equal(err.code, 'JOB_LEASE_LOST');
        }

        return {shouldNotBeCommitted: true};
      }
    },
    onEvent: e => workerEvents.push(e),
  });

  await worker.runOnce();
  assert.equal(caughtAbort, true);
  assert.equal(workerSideEffects, 0, 'Side effects must remain 0 on latency expiration');
  assert.equal(store.getFinishLog().length, 0, 'Old owner must not commit finish on late response');
  console.log('✓ Test 3 passed: Response latency & late heartbeat cannot revive expired lease');
}

// Test 4: checkLeaseAsync serializes with background heartbeat and checks authoritative store
{
  const store = createMockStore();
  let asyncCheckPassed = false;

  const worker = createLinkOpsJobWorker({
    store,
    workerId: 'worker-async-fencing',
    leaseMs: 5_000,
    heartbeatIntervalMs: 100,
    handlers: {
      async intent_plan(job, context) {
        await context.checkLeaseAsync();
        asyncCheckPassed = true;
        return {asyncOk: true};
      }
    },
  });

  await worker.runOnce();
  assert.equal(asyncCheckPassed, true);
  console.log('✓ Test 4 passed: checkLeaseAsync serializes safely with heartbeat without self-conflict');
}

// Test 5: Multi-worker contention, second worker takeover, and old owner side-effect count = 0
{
  const store = createMockStore();
  let worker2Won = false;
  let worker1SideEffects = 0;

  const worker1 = createLinkOpsJobWorker({
    store,
    workerId: 'worker-1-loser',
    leaseMs: 5_000,
    heartbeatIntervalMs: 100,
    handlers: {
      async intent_plan(job, context) {
        await new Promise(r => setTimeout(r, 120));

        const failedClaim = await store.claimJob({workerId: 'worker-2-winner', leaseMs: 5_000});
        assert.equal(failedClaim, null, 'Worker 2 must not claim active lease');

        store.expireJob();
        const takeover = await store.claimJob({workerId: 'worker-2-winner', leaseMs: 5_000});
        assert.ok(takeover);
        assert.equal(takeover.leaseOwner, 'worker-2-winner');

        await store.advanceJobWriteBoundary(takeover.jobId, 'read_only', {
          leaseOwner: 'worker-2-winner',
          expectedRevision: takeover.repositoryRevision,
          payloadHash: takeover.payloadHash,
        });
        const current = store.getJobState();
        await store.finishJob(takeover.jobId, {
          status: 'succeeded',
          leaseOwner: 'worker-2-winner',
          expectedRevision: current.repositoryRevision,
          result: {winner: 'worker-2'},
        });
        worker2Won = true;

        await new Promise(r => setTimeout(r, 200));
        try {
          context.checkLease();
          worker1SideEffects += 1;
        } catch {}

        return {done: false};
      }
    },
  });

  await worker1.runOnce();
  assert.equal(worker2Won, true);
  assert.equal(worker1SideEffects, 0, 'Worker 1 side effects must be 0 after lease takeover');
  const finishLog = store.getFinishLog();
  assert.equal(finishLog.length, 1, 'Only worker 2 must finish job');
  assert.equal(finishLog[0].leaseOwner, 'worker-2-winner');
  console.log('✓ Test 5 passed: Multi-worker contention, clean takeover, zero side-effects on old owner');
}

// Test 6: advanceWriteBoundary sequential execution and serial heartbeat integration (E4 guard)
{
  const store = createMockStore();
  let advancedBoundary = null;
  let finalRevision = null;

  const worker = createLinkOpsJobWorker({
    store,
    workerId: 'worker-advance-test',
    leaseMs: 5_000,
    heartbeatIntervalMs: 100,
    handlers: {
      async intent_plan(job, context) {
        assert.equal(context.getCurrentRevision(), 3); // claim (rev 2) -> read_only (rev 3)

        // Handler advances boundary to inventory_guard_dispatched
        const updated = await context.advanceWriteBoundary('inventory_guard_dispatched');
        advancedBoundary = updated.writeBoundary;
        finalRevision = context.getCurrentRevision();
        assert.equal(advancedBoundary, 'inventory_guard_dispatched');
        assert.equal(finalRevision, 4); // rev bumped to 4

        // Wait for next heartbeat cycle to run on top of rev 4
        await new Promise(r => setTimeout(r, 150));
        assert.ok(context.getCurrentRevision() >= 5);

        return {advanced: true};
      }
    },
  });

  await worker.runOnce();
  assert.equal(advancedBoundary, 'inventory_guard_dispatched');
  assert.equal(store.getJobState().status, 'succeeded');
  console.log('✓ Test 6 passed: advanceWriteBoundary sequential revision update and serial heartbeat integration');
}

// Test 7: advanceWriteBoundary rejected when lease is lost or expired
{
  const store = createMockStore();
  let caughtAdvanceError = false;

  const worker = createLinkOpsJobWorker({
    store,
    workerId: 'worker-advance-lost',
    leaseMs: 5_000,
    heartbeatIntervalMs: 100,
    handlers: {
      async intent_plan(job, context) {
        // Forcibly expire job lease externally
        store.expireJob();

        try {
          await context.advanceWriteBoundary('inventory_guard_dispatched');
        } catch (err) {
          caughtAdvanceError = true;
          assert.equal(err.code, 'JOB_LEASE_LOST');
        }

        return {failedExpectedly: true};
      }
    },
  });

  await worker.runOnce();
  assert.equal(caughtAdvanceError, true, 'advanceWriteBoundary must reject when lease expired');
  assert.notEqual(store.getJobState().writeBoundary, 'inventory_guard_dispatched');
  assert.equal(store.getFinishLog().length, 0);
  console.log('✓ Test 7 passed: advanceWriteBoundary strictly rejected on expired lease');
}

// Test 8: advanceWriteBoundary delayed across heartbeatTimer does NOT race or self-conflict
{
  const store = createMockStore();
  let boundaryAdvanced = false;

  const originalAdvance = store.advanceJobWriteBoundary;
  store.advanceJobWriteBoundary = async function(jobId, boundary, opts) {
    if (boundary !== 'inventory_guard_dispatched') return originalAdvance.call(store, jobId, boundary, opts);
    // Delay advance by 140ms, crossing the 100ms heartbeatTimer tick without triggering 200ms timeout
    await new Promise(r => setTimeout(r, 140));
    return originalAdvance.call(store, jobId, boundary, opts);
  };

  const worker = createLinkOpsJobWorker({
    store,
    workerId: 'worker-lane-test',
    leaseMs: 5_000,
    heartbeatIntervalMs: 100,
    handlers: {
      async intent_plan(job, context) {
        const updated = await context.advanceWriteBoundary('inventory_guard_dispatched');
        assert.equal(updated.writeBoundary, 'inventory_guard_dispatched');
        boundaryAdvanced = true;
        // Wait for queued heartbeat behind advance to settle
        await new Promise(r => setTimeout(r, 200));
        return {done: true};
      }
    },
  });

  await worker.runOnce();
  assert.equal(boundaryAdvanced, true);
  assert.equal(store.getJobState().status, 'succeeded');
  console.log('✓ Test 8 passed: Single Promise serial lane prevents advance & heartbeat concurrency self-conflict');
}

// Test 9: advanceWriteBoundary late response crossing monotonic deadline is strictly rejected without revival
{
  const store = createMockStore();
  let caughtLateAdvance = false;

  const originalAdvance = store.advanceJobWriteBoundary;
  store.advanceJobWriteBoundary = async function(jobId, boundary, opts) {
    if (boundary === 'read_only') return originalAdvance.call(store, jobId, boundary, opts);
    // Late response: wait 450ms while store lease expires
    await new Promise(r => setTimeout(r, 450));
    return originalAdvance.call(store, jobId, boundary, opts);
  };

  const worker = createLinkOpsJobWorker({
    store,
    workerId: 'worker-late-advance',
    leaseMs: 5_000,
    heartbeatIntervalMs: 100,
    handlers: {
      async intent_plan(job, context) {
        await new Promise(r => setTimeout(r, 120));
        // Simulate external lease expiry during delayed advance
        store.expireJob();
        try {
          await context.advanceWriteBoundary('inventory_guard_dispatched');
        } catch (err) {
          caughtLateAdvance = true;
          assert.equal(err.code, 'JOB_LEASE_LOST');
        }
        return {done: false};
      }
    },
  });

  await worker.runOnce();
  assert.equal(caughtLateAdvance, true);
  assert.equal(store.getFinishLog().length, 0);
  console.log('✓ Test 9 passed: Late advanceWriteBoundary crossing deadline strictly rejected without revival');
}

// Test 10: Never-resolving initial read_only advance has strict upper-bound timeout, handler is never called, no finish
{
  const store = createMockStore();
  let handlerCalled = false;

  // Mock store where initial advance never resolves
  store.advanceJobWriteBoundary = function() {
    return new Promise(() => {}); // never resolving
  };

  const worker = createLinkOpsJobWorker({
    store,
    workerId: 'worker-hung-initial-advance',
    leaseMs: 5_000,
    heartbeatIntervalMs: 100, // heartbeatTimeout is 200ms
    handlers: {
      async intent_plan(job, context) {
        handlerCalled = true;
        return {mustNotRun: true};
      }
    },
  });

  const startMono = performance.now();
  const runRes = await worker.runOnce();
  const elapsedMs = performance.now() - startMono;

  assert.equal(runRes.claimed, true);
  assert.equal(handlerCalled, false, 'Handler must NEVER be called when initial advance hangs');
  assert.equal(store.getFinishLog().length, 0, 'No finishJob should be committed when initial advance hangs');

  // Strict mathematical upper bound evidence:
  // timeout is 200ms, elapsedMs must be bounded strictly under 1000ms
  assert.ok(elapsedMs < 1_000, `runOnce with hung initial advance must finish with bounded time, took ${elapsedMs}ms`);
  console.log(`✓ Test 10 passed: Never-resolving initial advance bounded at ${Math.round(elapsedMs)}ms (<1000ms), handler skipped, zero finish`);
}

// Test 11: Never-resolving getJob inside checkLeaseAsync has bounded timeout and triggers AbortSignal
{
  const store = createMockStore();
  let caughtAsyncTimeout = false;

  // Mock store where getJob hangs forever
  store.getJob = function() {
    return new Promise(() => {}); // never resolving
  };

  const worker = createLinkOpsJobWorker({
    store,
    workerId: 'worker-hung-getjob',
    leaseMs: 5_000,
    heartbeatIntervalMs: 100, // timeout is 200ms
    handlers: {
      async intent_plan(job, context) {
        const startMono = performance.now();
        try {
          await context.checkLeaseAsync();
        } catch (err) {
          const elapsedMs = performance.now() - startMono;
          caughtAsyncTimeout = true;
          assert.equal(err.code, 'JOB_LEASE_LOST');
          assert.ok(elapsedMs < 1_000, `checkLeaseAsync with hung getJob must timeout under bound, took ${elapsedMs}ms`);
          assert.equal(context.isLeaseActive(), false);
          assert.equal(context.signal.aborted, true);
        }
        return {done: true};
      }
    },
  });

  await worker.runOnce();
  assert.equal(caughtAsyncTimeout, true);
  assert.equal(store.getFinishLog().length, 0);
  console.log('✓ Test 11 passed: Never-resolving getJob inside checkLeaseAsync strictly bounded (<1000ms) with AbortSignal');
}

// Test 12: Inventory handler uncertainWrite contract properly commits uncertain_write status
{
  const store = createMockStore();
  const events = [];

  const worker = createLinkOpsJobWorker({
    store,
    workerId: 'worker-uncertain-write',
    leaseMs: 5_000,
    heartbeatIntervalMs: 100,
    handlers: {
      async intent_plan(job, context) {
        await context.advanceWriteBoundary('inventory_guard_dispatched');

        // Simulate exception after dispatch without strict proof
        const err = new Error('Inventory guard dispatch confirmation ambiguous');
        err.code = 'INVENTORY_GUARD_UNCERTAIN';
        err.uncertainWrite = true;
        throw err;
      }
    },
    onEvent: e => events.push(e),
  });

  await worker.runOnce();

  const finishLog = store.getFinishLog();
  assert.equal(finishLog.length, 1);
  assert.equal(finishLog[0].status, 'uncertain_write');
  assert.equal(finishLog[0].error.code, 'INVENTORY_GUARD_UNCERTAIN');
  assert.equal(finishLog[0].error.uncertainWrite, true);
  assert.equal(events.some(e => e.event === 'uncertain_write'), true);
  console.log('✓ Test 12 passed: inventory handler error.uncertainWrite commits uncertain_write status and preserves safeError');
}

console.log('All F3 definitive tests passed successfully!');
