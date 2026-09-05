#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
  __testHooks,
  createHttpRuntimeLifecycle,
  shutdownHttpRuntime,
  createPortalShutdownHooks,
} from './serve_bi_portal.mjs';
import {createLinkOpsJobWorker} from '../lib/link_ops_job_worker.mjs';
import {createSerialMutationQueue} from '../lib/portal_security.mjs';

// Startup latch: admission is closed by default so traffic cannot race a
// half-started runtime. Requests and upgrades are refused until openAdmission()
// is called explicitly after all components have started.
const latch = await createFixture();
const preOpenProbe = await requestAfterShutdown(latch.port);
assert.equal(preOpenProbe.status, 503,
  `before openAdmission the runtime must refuse traffic with 503: ${JSON.stringify(preOpenProbe)}`);
const preOpenUpgrade = fakeSocket();
assert.equal(latch.lifecycle.status().accepting, false, 'admission must default to closed');
assert.equal(latch.lifecycle.status().admissionOpened, false, 'admissionOpened must default to false');
assert.equal(latch.lifecycle.status().closeStarted, false, 'refusing pre-open traffic must not start close');
assert.equal(latch.lifecycle.admitUpgrade(preOpenUpgrade), false, 'upgrades must be refused before admission opens');
assert.equal(preOpenUpgrade.destroyed, true);
assert.equal(latch.lifecycle.openAdmission(), true, 'openAdmission must open the gate');
assert.equal(latch.lifecycle.status().accepting, true, 'accepting must be true after openAdmission');
assert.equal(latch.lifecycle.status().admissionOpened, true, 'admissionOpened must be tracked');
latch.setHandler(async (_req, res) => { res.end('latched'); });
const postOpen = await fetch(`http://127.0.0.1:${latch.port}/latched`, {headers: {connection: 'close'}});
assert.equal(postOpen.status, 200, 'a request after openAdmission must be admitted');
assert.equal(await postOpen.text(), 'latched');
await new Promise(resolve => latch.server.close(resolve));

const graceful = await createFixture();
const order = [];
let releaseSlow;
let markStarted;
const slowStarted = new Promise(resolve => { markStarted = resolve; });
const slowRelease = new Promise(resolve => { releaseSlow = resolve; });
graceful.setHandler(async (req, res) => {
  order.push('handler-start');
  markStarted();
  await slowRelease;
  res.writeHead(200, {'content-type': 'text/plain', connection: 'close'});
  res.end('completed');
  order.push('handler-complete');
});
graceful.lifecycle.openAdmission();

const slowResponsePromise = fetch(`http://127.0.0.1:${graceful.port}/slow`, {
  headers: {connection: 'close'},
}).then(async response => ({status: response.status, body: await response.text()}));
await slowStarted;
const shutdownPromise = shutdownHttpRuntime({
  lifecycle: graceful.lifecycle,
  timeoutMs: 2_000,
  onAdmissionClosed: () => order.push('admission-closed'),
  stopWorkers: async () => { order.push('workers-stopped'); },
  closeStores: async () => { order.push('stores-closed'); },
});
assert.equal(graceful.lifecycle.status().accepting, false,
  'shutdown must close admission synchronously before awaiting any worker');

const rejectedAfterSignal = await requestAfterShutdown(graceful.port);
assert.notEqual(rejectedAfterSignal.status, 200,
  `a new connection after shutdown admission closed must be refused/503: ${JSON.stringify(rejectedAfterSignal)}`);
assert.deepEqual(order, ['handler-start', 'admission-closed', 'workers-stopped'],
  'workers stop concurrently with the HTTP drain; store close must stay gated until both succeed');

const fakeUpgrade = fakeSocket();
assert.equal(graceful.lifecycle.admitUpgrade(fakeUpgrade), false,
  'new upgrades must be rejected as soon as shutdown begins');
assert.equal(fakeUpgrade.destroyed, true);

releaseSlow();
const [slowResponse, gracefulResult] = await Promise.all([slowResponsePromise, shutdownPromise]);
assert.deepEqual(slowResponse, {status: 200, body: 'completed'});
assert.equal(gracefulResult.ok, true, JSON.stringify(gracefulResult));
assert.deepEqual(order, [
  'handler-start',
  'admission-closed',
  'workers-stopped',
  'handler-complete',
  'stores-closed',
]);
assert.equal(gracefulResult.drain.timedOut, false);
assert.equal(gracefulResult.drain.activeHandlers, 0);

// A request that is active when close begins and later becomes an idle
// keep-alive connection must not consume the entire default 5s shutdown
// budget. Node's initial server.close()/closeIdleConnections() sweep does not
// catch this active-to-idle transition, so the lifecycle must close it when
// the response settles.
let activeToIdleKeepAliveWallMs = 0;
{
  const keepAlive = await createFixture();
  keepAlive.server.keepAliveTimeout = 5_000;
  const handlerGate = deferred();
  const handlerStarted = deferred();
  keepAlive.setHandler(async (_req, res) => {
    handlerStarted.resolve();
    await handlerGate.promise;
    res.writeHead(200, {'content-type': 'text/plain'});
    res.end('completed');
  });
  keepAlive.lifecycle.openAdmission();
  const agent = new http.Agent({keepAlive: true, maxSockets: 1});
  try {
    const responsePromise = new Promise((resolve, reject) => {
      const request = http.get({
        host: '127.0.0.1',
        port: keepAlive.port,
        path: '/active-then-idle',
        agent,
      }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.once('end', () => resolve({
          status: response.statusCode,
          body,
          connection: response.headers.connection || '',
        }));
      });
      request.once('error', reject);
    });
    await handlerStarted.promise;
    const shutdownStartedAt = Date.now();
    const keepAliveShutdown = shutdownHttpRuntime({
      lifecycle: keepAlive.lifecycle,
      timeoutMs: 5_000,
    });
    setTimeout(() => handlerGate.resolve(), 50);
    const [response, result] = await Promise.all([responsePromise, keepAliveShutdown]);
    activeToIdleKeepAliveWallMs = Date.now() - shutdownStartedAt;
    assert.deepEqual(response, {status: 200, body: 'completed', connection: 'close'});
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.drain.timedOut, false, JSON.stringify(result.drain));
    assert.equal(result.drain.forced, false, JSON.stringify(result.drain));
    assert.ok(activeToIdleKeepAliveWallMs < 2_000,
      `active-to-idle keep-alive drain must not wait 5s (got ${activeToIdleKeepAliveWallMs}ms)`);
  } finally {
    agent.destroy();
  }
}

const timed = await createFixture();
let timedStartedResolve;
const timedStarted = new Promise(resolve => { timedStartedResolve = resolve; });
timed.setHandler(async () => {
  timedStartedResolve();
  await new Promise(() => {});
});
timed.lifecycle.openAdmission();
const hangingClient = fetch(`http://127.0.0.1:${timed.port}/never`, {headers: {connection: 'close'}}).catch(error => error);
await timedStarted;
const timeoutOrder = [];
const timeoutStartedAt = Date.now();
const timedResult = await shutdownHttpRuntime({
  lifecycle: timed.lifecycle,
  timeoutMs: 200,
  stopWorkers: async () => timeoutOrder.push('workers-stopped'),
  closeStores: async () => timeoutOrder.push('stores-closed'),
});
const timeoutWallMs = Date.now() - timeoutStartedAt;
assert.equal(timedResult.ok, false);
assert.equal(timedResult.drain.timedOut, true);
assert.equal(timedResult.drain.forced, true);
// Counterexample A: an HTTP handler that never settles must NOT suppress the
// worker drain. stopWorkers runs concurrently with the drain, is independently
// bounded, and reports its genuine result -- never marked skipped merely
// because the drain failed. Store close is skipped because it is gated on
// BOTH the drain and the workers.
assert.equal(timedResult.workers.ok, true, JSON.stringify(timedResult.workers));
assert.equal(timedResult.workers.skipped, undefined, JSON.stringify(timedResult.workers));
assert.equal(timedResult.stores.skipped, true, JSON.stringify(timedResult.stores));
assert.equal(timedResult.stores.reason, 'http-drain-failed', JSON.stringify(timedResult.stores));
assert.deepEqual(timeoutOrder, ['workers-stopped'],
  'workers must still stop while the HTTP handler is stuck; only store close is skipped');
assert.ok(timeoutWallMs < 1_500, 'forced shutdown must remain bounded (got ' + timeoutWallMs + 'ms)');
await Promise.race([hangingClient, new Promise((_, reject) => setTimeout(() => reject(new Error('forced client close did not settle')), 1_000))]);

// Counterexample B: a child whose kill never produces close must still settle
// within a strict bound after SIGTERM -> killGrace -> SIGKILL -> final settle
// grace, returning explicit ambiguous-failure evidence (aborted, no close
// observed, ok=false) instead of hanging or faking success. The injection uses
// the internal-only options.spawnImpl seam; no external input can reach it.
// The fake child exposes no live child/process handle, so the ref'd bounded
// final-settle timer itself is what must produce the evidence; if that timer
// were unref'd the process could exit before the promise ever settles.
let childNeverClosesWallMs = 0;
{
  const fakeKillCalls = [];
  const controller = new AbortController();
  const fakeChild = {
    unrefCalled: false,
    kill(signalName) { fakeKillCalls.push(String(signalName)); return true; },
    unref() { this.unrefCalled = true; return this; },
    once() { return this; },
    off() { return this; },
    stdout: {setEncoding() {}, on() {}, off() {}, destroy() {}},
    stderr: {setEncoding() {}, on() {}, off() {}, destroy() {}},
    stdin: {on() {}, off() {}, destroy() {}},
  };
  const fakeStartedAt = Date.now();
  const pending = __testHooks.runChildProcess(process.execPath, ['-e', '0'], {
    signal: controller.signal,
    timeoutMs: 5_000,
    killGraceMs: 150,
    settleGraceMs: 250,
    spawnImpl: () => fakeChild,
  });
  // Spawn is synchronous inside the promise constructor, so aborting here is
  // guaranteed to run after the child is created and the listener attached.
  controller.abort(Object.assign(new Error('runtime cancelled fake executor'), {code: 'BI_RUNTIME_SHUTDOWN'}));
  const fakeResult = await Promise.race([
    pending,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('runChildProcess did not settle (killGrace=150 settleGrace=250)')),
      5_000,
    )),
  ]);
  childNeverClosesWallMs = Date.now() - fakeStartedAt;
  assert.equal(fakeResult.ok, false, JSON.stringify(fakeResult));
  assert.equal(fakeResult.aborted, true, JSON.stringify(fakeResult));
  assert.equal(fakeResult.code, null, JSON.stringify(fakeResult));
  assert.equal(fakeResult.terminationRequested, true, JSON.stringify(fakeResult));
  assert.deepEqual(fakeResult.terminationSignals, ['SIGTERM', 'SIGKILL'], JSON.stringify(fakeResult));
  assert.equal(fakeResult.terminationSignal, 'SIGKILL', JSON.stringify(fakeResult));
  assert.match(fakeResult.abortReason, /runtime cancelled fake executor/, JSON.stringify(fakeResult));
  assert.equal(fakeResult.closeNeverObserved, true,
    'the caller must get explicit evidence that the child was never observed closing');
  assert.deepEqual(fakeKillCalls, ['SIGTERM', 'SIGKILL'],
    'the fake child must receive the full escalation sequence');
  assert.equal(fakeChild.unrefCalled, true,
    'an unclosed child must be unrefed so the runtime is not held hostage');
  assert.ok(childNeverClosesWallMs >= 150 + 250 - 100,
    'final settle must wait for the full grace (got ' + childNeverClosesWallMs + 'ms)');
  assert.ok(childNeverClosesWallMs < 2_000,
    'runChildProcess must stay strictly bounded (got ' + childNeverClosesWallMs + 'ms)');
}

// Portal shutdown wiring (createPortalShutdownHooks): worker claim admission
// closes synchronously with HTTP admission, the already-entered iteration is
// drained inside stopWorkers, and store.close runs strictly after that drain.
// Re-running the admission-close and worker-stop hooks is idempotent.
{
  const portalFixture = await createFixture();
  const portalOrder = [];
  let markPortalHandlerBlocked;
  let releasePortalHandler;
  const portalHandlerBlocked = new Promise(resolve => { markPortalHandlerBlocked = resolve; });
  const portalHandlerGate = new Promise(resolve => { releasePortalHandler = resolve; });
  const portalCalls = {claim: 0};
  const portalJobs = new Map();
  const portalStore = {
    mode: 'json',
    async claimJob({workerId, leaseMs}) {
      portalCalls.claim += 1;
      const job = [...portalJobs.values()].find(candidate => candidate.status === 'queued');
      if (!job) return null;
      job.status = 'running';
      job.leaseOwner = workerId;
      job.leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
      job.repositoryRevision = Number(job.repositoryRevision || 1);
      return {...job};
    },
    async advanceJobWriteBoundary(jobId, writeBoundary) {
      const job = portalJobs.get(jobId);
      if (job) {
        job.writeBoundary = writeBoundary;
        job.repositoryRevision = Number(job.repositoryRevision || 1) + 1;
      }
      return {...(job || {})};
    },
    async heartbeatJob(jobId, {leaseMs} = {}) {
      const job = portalJobs.get(jobId);
      if (job) {
        job.repositoryRevision = Number(job.repositoryRevision || 1) + 1;
        if (leaseMs) job.leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
      }
      return {...(job || {})};
    },
    async finishJob(jobId, changes) {
      const job = portalJobs.get(jobId);
      if (job) {
        job.status = changes.status;
        job.result = changes.result ?? null;
        job.leaseOwner = null;
        job.leaseExpiresAt = null;
        job.repositoryRevision = Number(job.repositoryRevision || 1) + 1;
      }
      return {...(job || {})};
    },
    async getJob(jobId) { return {...(portalJobs.get(jobId) || null)}; },
    async close() { portalOrder.push('store-closed'); },
    enqueue(id) { portalJobs.set(id, {jobId: id, kind: 'intent_plan', payload: {}, status: 'queued', writeBoundary: 'none', attempt: 0, repositoryRevision: 1}); },
  };
  portalStore.enqueue('portal-job');
  const portalWorker = createLinkOpsJobWorker({
    store: portalStore,
    workerId: 'portal-worker',
    handlers: {
      intent_plan: async () => {
        markPortalHandlerBlocked();
        await portalHandlerGate;
        return {applied: true};
      },
    },
    onEvent: event => { if (event.event === 'succeeded') portalOrder.push('worker-drained'); },
  });
  const portalHooks = createPortalShutdownHooks({
    enqueueMutationRequest: createSerialMutationQueue({}),
    linkOpsJobWorker: portalWorker,
    webhookTaskReconciler: null,
    liveAccountingRefreshStop: () => {},
    biCoreWarmupWatcher: null,
    ownerKnowledgeReconcileTimer: null,
    liveUpdateBridge: null,
    linkOpsStoreGateway: portalStore,
    sheinWebhookRepository: null,
  });
  portalFixture.lifecycle.openAdmission();
  const portalRunPromise = portalWorker.runOnce();
  await portalHandlerBlocked;
  assert.equal(portalWorker.status().inFlight, true, 'the claim must be in-flight');
  const portalShutdownPromise = shutdownHttpRuntime({
    lifecycle: portalFixture.lifecycle,
    timeoutMs: 2_000,
    ...portalHooks,
  });
  // onAdmissionClosed runs synchronously with lifecycle.beginClose(), so the
  // worker's claim admission is closed at the same instant HTTP admission
  // closes -- not left open until the HTTP drain finishes.
  assert.equal(portalWorker.status().admissionClosed, true,
    'worker claim admission must close synchronously with HTTP admission');
  assert.equal(portalWorker.status().inFlight, true,
    'the already-entered iteration must remain in-flight and drain');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(portalOrder, [], 'store must stay open while the worker drains');
  portalStore.enqueue('late-job');
  releasePortalHandler();
  const portalResult = await portalShutdownPromise;
  await portalRunPromise;
  assert.equal(portalResult.ok, true, JSON.stringify(portalResult));
  assert.deepEqual(portalOrder, ['worker-drained', 'store-closed'],
    'store.close must run strictly after the worker drain');
  assert.equal(portalWorker.status().inFlight, false);
  assert.equal(portalCalls.claim, 1, 'only the in-flight claim may have happened');
  assert.equal((await portalStore.getJob('late-job')).status, 'queued',
    'a job enqueued after admission close must stay queued');
  assert.deepEqual(await portalWorker.runOnce(), {claimed: false, skipped: true},
    'the worker must refuse new claims once admission is closed');
  // Repeated admission-close and worker-stop are idempotent. (The portal's
  // own shutdown() additionally guards the whole sequence with one
  // shutdownPromise, so closeStores runs at most once in production.)
  await portalHooks.onAdmissionClosed();
  await portalHooks.stopWorkers();
  await portalHooks.stopWorkers();
}

// A canonical accounting freshness check that already started must drain
// before runtime stores close; shutdown also flips its synchronous stop gate so
// no post-stop queue persistence can begin.
{
  const accountingGate = deferred();
  const accountingOrder = [];
  const hooks = createPortalShutdownHooks({
    enqueueMutationRequest: createSerialMutationQueue({}),
    liveAccountingRefreshStop: () => accountingOrder.push('accounting-stopped'),
    liveAccountingRefreshDrain: async () => {
      accountingOrder.push('accounting-drain-started');
      await accountingGate.promise;
      accountingOrder.push('accounting-drained');
    },
    linkOpsStoreGateway: {async close() { accountingOrder.push('store-closed'); }},
  });
  hooks.onAdmissionClosed();
  const workers = hooks.stopWorkers();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(accountingOrder, ['accounting-stopped', 'accounting-drain-started']);
  accountingGate.resolve();
  await workers;
  await hooks.closeStores();
  assert.deepEqual(accountingOrder, [
    'accounting-stopped',
    'accounting-drain-started',
    'accounting-drained',
    'store-closed',
  ]);
}

// A shutdown that races an asynchronous startup phase must wait for that phase
// before stopping workers/bridges and closing stores. Otherwise a late start()
// continuation can reopen work after its store has already closed.
{
  const startupGate = deferred();
  const startupOrder = [];
  const hooks = createPortalShutdownHooks({
    enqueueMutationRequest: createSerialMutationQueue({}),
    waitForStartup: () => startupGate.promise,
    linkOpsJobWorker: {stopAdmitting() {}, async stop() { startupOrder.push('worker-stopped'); }},
    webhookTaskReconciler: null,
    liveUpdateBridge: null,
    linkOpsStoreGateway: {async close() { startupOrder.push('store-closed'); }},
  });
  const stopping = hooks.stopWorkers();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(startupOrder, [], 'worker stop must wait for the in-flight startup phase');
  startupGate.resolve();
  await stopping;
  await hooks.closeStores();
  assert.deepEqual(startupOrder, ['worker-stopped', 'store-closed']);
}

// A real long-running executor child is bound to the Portal-wide cancellation
// signal. Shutdown must synchronously abort it, drain its explicit evidence
// through the existing claim/lifecycle/CAS path, and only then close the store.
// The durable record must never retain an ordinary `claimed` state because a
// retry after an ambiguous remote write boundary would be unsafe.
let cancelledExecutorShutdownWallMs = 0;
{
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bi-runtime-executor-shutdown-'));
  const childStartedFile = path.join(tempDir, 'child-started.pid');
  const runtimeCancellationController = new AbortController();
  const claim = {
    schemaVersion: 1,
    claimId: 'wc_shutdown_test',
    nonce: 'a'.repeat(32),
    taskId: 'shutdown-write-task',
    storeKey: 'HL',
    operations: ['copy_product_draft'],
    expectedPayloadHash: 'b'.repeat(64),
    claimedAt: new Date().toISOString(),
    claimedBy: 'shutdown-test',
    state: 'claimed',
  };
  let durableTask = {
    id: claim.taskId,
    repositoryRevision: 2,
    repositoryPayloadHash: 'initial-claim-hash',
    status: 'waiting_review',
    progress: 70,
    note: 'write claim is durable before the executor starts',
    execution: {writeClaim: claim},
    lifecycle: null,
    executionHistory: [],
    history: [],
    updatedAt: new Date().toISOString(),
  };
  const shutdownOrder = [];
  const store = {
    async readTaskStore() {
      return {version: 1, updatedAt: durableTask.updatedAt, tasks: [structuredClone(durableTask)]};
    },
    async updateTaskRecord(taskId, next, {expectedRevision}) {
      assert.equal(taskId, claim.taskId);
      assert.equal(expectedRevision, durableTask.repositoryRevision,
        'final claim settlement must CAS the exact claimed revision');
      durableTask = {
        ...structuredClone(next),
        repositoryRevision: expectedRevision + 1,
        repositoryPayloadHash: `shutdown-result-${expectedRevision + 1}`,
      };
      shutdownOrder.push('claim-unconfirmed-persisted');
      return structuredClone(durableTask);
    },
    async close() { shutdownOrder.push('store-closed'); },
  };
  const fixture = await createFixture();
  const hooks = createPortalShutdownHooks({
    enqueueMutationRequest: createSerialMutationQueue({}),
    linkOpsStoreGateway: store,
    runtimeCancellationController,
  });
  let childResult = null;
  let executorRun = null;
  let handlerError = null;
  fixture.setHandler(async (_req, res) => {
    try {
      const childScript = [
        "import fs from 'node:fs';",
        "if (process.platform !== 'win32') process.on('SIGTERM', () => {});",
        "fs.writeSync(1, JSON.stringify({ok:true,state:'submitted'}));",
        `fs.writeFileSync(${JSON.stringify(childStartedFile)}, String(process.pid));`,
        'setInterval(() => {}, 1000);',
      ].join('');
      childResult = await __testHooks.runChildProcess(process.execPath, ['--input-type=module', '-e', childScript], {
        signal: runtimeCancellationController.signal,
        timeoutMs: 10_000,
        killGraceMs: 200,
      });
      executorRun = __testHooks.buildOpenApiExecutorChildOutcome({
        kind: 'product',
        storeKey: claim.storeKey,
        mode: 'execute',
        childResult,
        parsed: JSON.parse(childResult.stdout),
      });
      const claimState = __testHooks.resolveLinkOpsWriteClaimState({
        writeClaim: claim,
        productExecutors: [executorRun],
      });
      const lifecycle = __testHooks.classifyLinkOpsLifecycle({
        task: durableTask,
        requestedMode: 'execute',
        executorState: executorRun.result.state,
        submitted: false,
        suspiciousWriteAttempted: executorRun.result.suspiciousWriteAttempted === true,
        ok: true,
        executorResults: [executorRun.result],
        originalStatus: durableTask.status,
      });
      const next = {
        ...durableTask,
        status: lifecycle.toStatus,
        progress: 85,
        note: lifecycle.note,
        execution: {
          ...durableTask.execution,
          state: executorRun.result.state,
          writeClaim: {...claim, state: claimState},
          openApiProductExecutors: [{
            storeKey: claim.storeKey,
            mode: 'execute',
            ...executorRun.result,
          }],
        },
        lifecycle,
        updatedAt: new Date().toISOString(),
      };
      await __testHooks.persistClaimedLinkOpsExecutionResult({
        linkOpsStoreGateway: store,
      }, {
        taskId: claim.taskId,
        next,
        writeClaim: {...claim, revision: 2},
        actorUser: 'shutdown-test',
        now: next.updatedAt,
      });
      res.writeHead(200, {'content-type': 'application/json', connection: 'close'});
      res.end(JSON.stringify({ok: false, outcome: 'unconfirmed'}));
    } catch (error) {
      handlerError = error;
      res.statusCode = 500;
      res.end(String(error?.message || error));
    }
  });
  fixture.lifecycle.openAdmission();
  try {
    const responsePromise = fetch(`http://127.0.0.1:${fixture.port}/long-write`, {
      headers: {connection: 'close'},
    }).then(async response => ({status: response.status, body: await response.text()}));
    await waitForFile(childStartedFile, 2_000);
    assert.equal(durableTask.execution.writeClaim.state, 'claimed',
      'the durable claim must exist before shutdown cancellation');
    const childPid = Number(await fs.readFile(childStartedFile, 'utf8'));
    assert.ok(Number.isInteger(childPid) && childPid > 0, 'the fake write child must publish its pid');

    const shutdownStartedAt = Date.now();
    const stopping = shutdownHttpRuntime({
      lifecycle: fixture.lifecycle,
      timeoutMs: 3_000,
      ...hooks,
    });
    assert.equal(runtimeCancellationController.signal.aborted, true,
      'the shared executor signal must abort synchronously with admission close');
    const [response, result] = await Promise.all([responsePromise, stopping]);
    cancelledExecutorShutdownWallMs = Date.now() - shutdownStartedAt;

    assert.ifError(handlerError);
    assert.equal(response.status, 200, response.body);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(childResult?.aborted, true, JSON.stringify(childResult));
    assert.equal(childResult?.terminationRequested, true, JSON.stringify(childResult));
    assert.ok(childResult?.terminationSignals?.includes('SIGTERM'), JSON.stringify(childResult));
    if (process.platform !== 'win32') {
      assert.deepEqual(childResult?.terminationSignals, ['SIGTERM', 'SIGKILL'],
        'a child that ignores SIGTERM must be escalated to SIGKILL');
      assert.equal(childResult?.terminationSignal, 'SIGKILL');
    }
    assert.deepEqual(JSON.parse(childResult.stdout), {ok: true, state: 'submitted'},
      'the fake child must emit misleading parseable success before it is cancelled');
    assert.equal(executorRun?.result?.state, 'suspicious_write_attempted');
    assert.equal(executorRun?.result?.aborted, true);
    assert.equal(executorRun?.result?.submittedPossibly, true);
    assert.equal(durableTask.status, 'needs_manual_resolve');
    assert.equal(durableTask.lifecycle?.lifecycleStatus, 'suspicious_write_attempted');
    assert.equal(durableTask.lifecycle?.locked, true);
    assert.equal(durableTask.execution?.writeClaim?.state, 'unconfirmed');
    assert.deepEqual(findWriteClaimStates(durableTask), ['unconfirmed'],
      'no ordinary claimed write claim may survive terminal shutdown settlement');
    assert.equal(
      __testHooks.linkOpsExecutionResponseOutcome(durableTask, {requestedExecute: true}).outcome,
      'unconfirmed',
    );
    assert.deepEqual(shutdownOrder, ['claim-unconfirmed-persisted', 'store-closed'],
      'the cancelled claim must persist before the store closes');
    assert.ok(cancelledExecutorShutdownWallMs < 2_500,
      `executor cancellation shutdown must stay below budget (got ${cancelledExecutorShutdownWallMs}ms)`);
    assert.equal(processExists(childPid), false, 'the fake OpenAPI executor child must be dead after shutdown');

    const maintenanceRun = __testHooks.buildOpenApiExecutorChildOutcome({
      kind: 'maintenance',
      storeKey: 'HL',
      mode: 'execute',
      childResult,
    });
    assert.equal(__testHooks.resolveLinkOpsWriteClaimState({
      writeClaim: {...claim, operations: ['update_title']},
      maintenanceExecutors: [maintenanceRun],
    }), 'unconfirmed', 'maintenance executor cancellation must use the same conservative claim state');
  } finally {
    await fs.rm(tempDir, {recursive: true, force: true});
  }
}

console.log(JSON.stringify({
  ok: true,
  admissionClosedSynchronously: true,
  newHttpRejected: true,
  newUpgradeRejected: true,
  admittedRequestCompleted: true,
  activeToIdleKeepAliveClosedGracefully: true,
  activeToIdleKeepAliveWallMs,
  workerStoreOrder: order,
  timeoutForced: true,
  timeoutWallMs,
  workerStoppedWhileHttpDrainForced: true,
  storeCloseSkippedWhileHandlerActive: true,
  workerDrainStrictlyBeforeStoreClose: true,
  workerAdmissionClosedWithHttpAdmission: true,
  repeatedWorkerShutdownIdempotent: true,
  startupPhaseWaitedBeforeWorkerStop: true,
  openApiExecutorChildCancelled: true,
  childNeverClosesStillSettlesBoundedly: true,
  childNeverClosesWallMs,
  cancelledWriteClaimState: 'unconfirmed',
  cancelledExecutorShutdownWallMs,
}, null, 2));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return {promise, resolve, reject};
}

async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(file);
      return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for fake executor start marker: ${file}`);
}

function findWriteClaimStates(value, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (value.writeClaim && typeof value.writeClaim === 'object') {
    out.push(String(value.writeClaim.state || ''));
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    if (child && typeof child === 'object') findWriteClaimStates(child, out);
  }
  return [...new Set(out)];
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function createFixture() {
  let handler = async (_req, res) => { res.end('ok'); };
  const server = http.createServer();
  const lifecycle = createHttpRuntimeLifecycle(server);
  server.on('request', (req, res) => lifecycle.dispatchRequest(req, res, handler));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    server,
    lifecycle,
    port: typeof address === 'object' && address ? address.port : 0,
    setHandler(next) { handler = next; },
  };
}

async function requestAfterShutdown(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/after-shutdown`, {
      headers: {connection: 'close'},
      signal: AbortSignal.timeout(1_000),
    });
    return {status: response.status, body: await response.text()};
  } catch (error) {
    return {status: 0, error: String(error?.cause?.code || error?.name || error)};
  }
}

function fakeSocket() {
  const socket = new net.Socket();
  socket.writes = [];
  socket.write = value => { socket.writes.push(String(value)); return true; };
  socket.destroy = () => { socket.destroyed = true; return socket; };
  return socket;
}
