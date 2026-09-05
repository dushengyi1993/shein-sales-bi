import os from 'node:os';

function positiveInteger(value, fallback, {min = 1, max = Number.MAX_SAFE_INTEGER} = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function safeError(error) {
  return {
    code: String(error?.code || 'JOB_HANDLER_FAILED').slice(0, 120),
    message: String(error?.message || error || 'Job handler failed').slice(0, 2_000),
    retryable: Boolean(error?.retryable),
    uncertainWrite: Boolean(error?.uncertainWrite),
  };
}

/**
 * One cooperative worker per portal process. PostgreSQL claimJob uses
 * FOR UPDATE SKIP LOCKED, so multiple service instances can safely coexist.
 */
export function createLinkOpsJobWorker({
  store,
  handlers = {},
  workerId = `portal:${os.hostname()}:${process.pid}`,
  pollMs = 1_500,
  leaseMs = 10 * 60_000,
  heartbeatIntervalMs = null,
  onEvent = () => {},
} = {}) {
  if (!store || typeof store.claimJob !== 'function') throw new TypeError('A job-capable Link Ops store is required');
  const intervalMs = positiveInteger(pollMs, 1_500, {min: 100, max: 60_000});
  const leaseDurationMs = positiveInteger(leaseMs, 10 * 60_000, {min: 5_000, max: 86_400_000});
  const maxAllowedHeartbeat = Math.max(100, Math.floor(leaseDurationMs / 2));
  const requestedHeartbeatMs = positiveInteger(heartbeatIntervalMs, null, {min: 100, max: 300_000});
  const defaultHeartbeatMs = Math.max(1_000, Math.min(60_000, Math.floor(leaseDurationMs / 3)));
  const heartbeatDurationMs = requestedHeartbeatMs !== null
    ? Math.min(requestedHeartbeatMs, maxAllowedHeartbeat)
    : Math.min(defaultHeartbeatMs, maxAllowedHeartbeat);
  let timer = null;
  let stopped = true;
  // Claim admission is separate from the started/stopped lifecycle flag.
  // A worker that is merely not started may still be driven with runOnce()
  // and must behave exactly as before; once stopAdmitting()/stop() is called
  // the admission flag makes new claims impossible while an already-entered
  // iteration keeps its lease and drains.
  let admissionClosed = false;
  let running = null;
  let drainPromise = null;

  async function emit(event, detail = {}) {
    try {
      await onEvent({event, workerId, at: new Date().toISOString(), ...detail});
    } catch {}
  }

  function jobKind(job) {
    return String(job?.kind || job?.type || job?.payload?.kind || '').trim();
  }

  async function processClaimedJob(claimed) {
    let job = claimed;
    const kind = jobKind(job);
    const handler = handlers[kind];
    if (typeof handler !== 'function') {
      const error = {code: 'UNSUPPORTED_JOB_KIND', message: `Unsupported job kind: ${kind || '(empty)'}`};
      await store.finishJob(job.jobId, {
        status: 'failed',
        leaseOwner: workerId,
        expectedRevision: job.repositoryRevision,
        error,
        actorUser: workerId,
      });
      await emit('failed', {jobId: job.jobId, kind, error});
      return;
    }

    let currentRevision = job.repositoryRevision;
    let lostLease = false;
    let leaseError = null;
    let heartbeatTimer = null;
    let heartbeatActive = false;
    let operationSeq = 0;
    const nowMono = () => performance.now();
    // 初始保守截止时间：严格基于 claimJob 已确认的 leaseExpiresAt 保守设定，绝不伪延长网络耗时
    let monotonicDeadline = nowMono();
    if (job?.leaseExpiresAt) {
      const remainingWallMs = new Date(job.leaseExpiresAt).getTime() - Date.now();
      monotonicDeadline = nowMono() + Math.max(0, remainingWallMs);
    } else {
      monotonicDeadline = nowMono() + leaseDurationMs;
    }
    const heartbeatTimeoutMs = Math.max(100, Math.min(heartbeatDurationMs * 2, Math.floor(leaseDurationMs / 2)));
    const abortController = new AbortController();

    function updateMonotonicDeadline(requestStartMono, confirmedJob) {
      const deadlineByRequest = requestStartMono + leaseDurationMs;
      let deadlineByConfirmed = deadlineByRequest;
      if (confirmedJob?.leaseExpiresAt) {
        const remainingWallMs = new Date(confirmedJob.leaseExpiresAt).getTime() - Date.now();
        if (Number.isFinite(remainingWallMs)) {
          deadlineByConfirmed = nowMono() + Math.max(0, remainingWallMs);
        }
      }
      monotonicDeadline = Math.min(deadlineByRequest, deadlineByConfirmed);
    }

    function checkCurrentLease() {
      if (lostLease) {
        const err = new Error(`Job ${job.jobId} lease lost: ${leaseError?.message || 'lease inactive'}`);
        err.code = 'JOB_LEASE_LOST';
        err.cause = leaseError;
        throw err;
      }
      if (nowMono() >= monotonicDeadline) {
        lostLease = true;
        leaseError = new Error(`Job ${job.jobId} lease expired by monotonic deadline`);
        leaseError.code = 'JOB_LEASE_EXPIRED';
        abortController.abort(leaseError);
        const err = new Error(`Job ${job.jobId} lease lost: expired by monotonic deadline`);
        err.code = 'JOB_LEASE_LOST';
        err.cause = leaseError;
        throw err;
      }
    }

    // 单一 Promise 串行通道（FIFO Serial Lane）：承载 heartbeat + advance + authoritative getJob
    let serialLane = Promise.resolve();
    function runInSerialLane(fn) {
      const resultPromise = serialLane.then(async () => {
        checkCurrentLease();
        return await fn();
      });
      serialLane = resultPromise.catch(() => {});
      return resultPromise;
    }

    async function performHeartbeat() {
      if (!heartbeatActive || lostLease) return;
      return runInSerialLane(async () => {
        if (!heartbeatActive || lostLease) return;
        const seq = ++operationSeq;
        const requestStartMono = nowMono();
        let timeoutId = null;
        try {
          const heartbeatPromise = store.heartbeatJob(job.jobId, {
            leaseOwner: workerId,
            expectedRevision: currentRevision,
            leaseMs: leaseDurationMs,
          });
          const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
              const err = new Error(`Heartbeat for job ${job.jobId} timed out after ${heartbeatTimeoutMs}ms`);
              err.code = 'HEARTBEAT_TIMEOUT';
              reject(err);
            }, heartbeatTimeoutMs);
          });
          const updated = await Promise.race([heartbeatPromise, timeoutPromise]);
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }

          // Anti-revival check: If lease was already lost or deadline passed, discard late response
          if (lostLease || seq !== operationSeq || nowMono() >= monotonicDeadline || !updated?.repositoryRevision) {
            lostLease = true;
            if (!leaseError) {
              leaseError = new Error(`Late heartbeat response for job ${job.jobId} rejected after lease expired`);
              leaseError.code = 'LATE_HEARTBEAT_REJECTED';
            }
            abortController.abort(leaseError);
            return;
          }

          currentRevision = updated.repositoryRevision;
          job.repositoryRevision = currentRevision;
          updateMonotonicDeadline(requestStartMono, updated);
        } catch (error) {
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          lostLease = true;
          leaseError = error;
          abortController.abort(error);
          await emit('lease-lost', {
            jobId: job.jobId,
            kind,
            expectedRevision: currentRevision,
            error: safeError(error),
          });
        }
      });
    }

    function scheduleNextHeartbeat() {
      if (!heartbeatActive || lostLease) return;
      heartbeatTimer = setTimeout(async () => {
        heartbeatTimer = null;
        try {
          await performHeartbeat();
        } catch {}
        if (heartbeatActive && !lostLease) {
          scheduleNextHeartbeat();
        }
      }, heartbeatDurationMs);
    }

    async function cleanupHeartbeat() {
      heartbeatActive = false;
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }
      try {
        await serialLane;
      } catch {}
    }

    try {
      checkCurrentLease();
      const advanceStartMono = nowMono();
      let initTimeoutId = null;
      try {
        const initAdvancePromise = store.advanceJobWriteBoundary(job.jobId, 'read_only', {
          leaseOwner: workerId,
          expectedRevision: job.repositoryRevision,
          payloadHash: job.payloadHash,
        });
        const initTimeoutPromise = new Promise((_, reject) => {
          initTimeoutId = setTimeout(() => {
            const err = new Error(`Initial read_only boundary advance for job ${job.jobId} timed out after ${heartbeatTimeoutMs}ms`);
            err.code = 'INITIAL_ADVANCE_TIMEOUT';
            reject(err);
          }, heartbeatTimeoutMs);
        });
        job = await Promise.race([initAdvancePromise, initTimeoutPromise]);
      } finally {
        if (initTimeoutId) {
          clearTimeout(initTimeoutId);
          initTimeoutId = null;
        }
      }
      if (nowMono() >= monotonicDeadline || !job?.repositoryRevision) {
        const err = new Error(`Job ${job.jobId} lease expired during initial read_only boundary advance`);
        err.code = 'INITIAL_ADVANCE_EXPIRED';
        throw err;
      }
      currentRevision = job.repositoryRevision;
      updateMonotonicDeadline(advanceStartMono, job);
      await emit('started', {jobId: job.jobId, kind, taskId: job.taskId, chatSessionId: job.chatSessionId});

      heartbeatActive = true;
      scheduleNextHeartbeat();

      async function advanceWriteBoundary(boundary) {
        const nextBoundary = String(boundary || '').trim();
        if (!nextBoundary) throw new Error('Write boundary name is required');
        return runInSerialLane(async () => {
          checkCurrentLease();
          const seq = ++operationSeq;
          const startMono = nowMono();
          let timeoutId = null;
          try {
            const advancePromise = store.advanceJobWriteBoundary(job.jobId, nextBoundary, {
              leaseOwner: workerId,
              expectedRevision: currentRevision,
              payloadHash: job.payloadHash,
            });
            const timeoutPromise = new Promise((_, reject) => {
              timeoutId = setTimeout(() => {
                const err = new Error(`advanceJobWriteBoundary for job ${job.jobId} timed out after ${heartbeatTimeoutMs}ms`);
                err.code = 'ADVANCE_BOUNDARY_TIMEOUT';
                reject(err);
              }, heartbeatTimeoutMs);
            });
            const updated = await Promise.race([advancePromise, timeoutPromise]);
            if (timeoutId) {
              clearTimeout(timeoutId);
              timeoutId = null;
            }

            // 迟到防复活严检：若单调 deadline 已过、已失租、或返回无效，坚决拒绝并丢弃
            if (lostLease || seq !== operationSeq || nowMono() >= monotonicDeadline || !updated?.repositoryRevision) {
              lostLease = true;
              if (!leaseError) {
                leaseError = new Error(`Late advanceWriteBoundary response for job ${job.jobId} rejected after lease expired`);
                leaseError.code = 'LATE_ADVANCE_REJECTED';
              }
              abortController.abort(leaseError);
              const err = new Error(`Job ${job.jobId} lease lost during advanceWriteBoundary: expired by monotonic deadline`);
              err.code = 'JOB_LEASE_LOST';
              err.cause = leaseError;
              throw err;
            }

            currentRevision = updated.repositoryRevision;
            job.repositoryRevision = currentRevision;
            job.writeBoundary = updated.writeBoundary || nextBoundary;
            updateMonotonicDeadline(startMono, updated);
            return updated;
          } catch (err) {
            if (timeoutId) {
              clearTimeout(timeoutId);
              timeoutId = null;
            }
            lostLease = true;
            leaseError = err;
            abortController.abort(err);
            const leaseLostErr = new Error(`Job ${job.jobId} lease lost during advanceWriteBoundary: ${err.message}`);
            leaseLostErr.code = 'JOB_LEASE_LOST';
            leaseLostErr.cause = err;
            throw leaseLostErr;
          }
        });
      }

      const context = {
        workerId,
        leaseMs: leaseDurationMs,
        signal: abortController.signal,
        checkLease: checkCurrentLease,
        advanceWriteBoundary,
        checkLeaseAsync: async () => {
          checkCurrentLease();
          if (typeof store.getJob !== 'function') {
            throw new Error(`Store does not support authoritative getJob for job ${job.jobId}`);
          }
          return runInSerialLane(async () => {
            checkCurrentLease();
            let getJobTimeoutId = null;
            let authoritative = null;
            try {
              const getJobPromise = store.getJob(job.jobId);
              const timeoutPromise = new Promise((_, reject) => {
                getJobTimeoutId = setTimeout(() => {
                  const err = new Error(`Authoritative getJob for job ${job.jobId} timed out after ${heartbeatTimeoutMs}ms`);
                  err.code = 'GET_JOB_TIMEOUT';
                  reject(err);
                }, heartbeatTimeoutMs);
              });
              authoritative = await Promise.race([getJobPromise, timeoutPromise]);
            } catch (err) {
              lostLease = true;
              leaseError = err;
              abortController.abort(err);
              const leaseLostErr = new Error(`Job ${job.jobId} lease lost: getJob failed: ${err.message}`);
              leaseLostErr.code = 'JOB_LEASE_LOST';
              leaseLostErr.cause = err;
              throw leaseLostErr;
            } finally {
              if (getJobTimeoutId) {
                clearTimeout(getJobTimeoutId);
                getJobTimeoutId = null;
              }
            }
            // 慢响应返回后必须再次校验单调 deadline！
            checkCurrentLease();
            if (!authoritative
              || authoritative.status !== 'running'
              || authoritative.leaseOwner !== workerId
              || authoritative.repositoryRevision !== currentRevision
              || !authoritative.leaseExpiresAt
              || new Date(authoritative.leaseExpiresAt).getTime() <= Date.now()) {
              lostLease = true;
              leaseError = new Error(`Authoritative store check failed for job ${job.jobId}`);
              leaseError.code = 'JOB_LEASE_LOST';
              abortController.abort(leaseError);
              throw leaseError;
            }
          });
        },
        isLeaseActive: () => !lostLease,
        getCurrentRevision: () => currentRevision,
        getMonotonicDeadline: () => monotonicDeadline,
      };

      const result = await handler(job, context);

      await cleanupHeartbeat();

      checkCurrentLease();

      if (lostLease) {
        await emit('finish-skipped-lost-lease', {
          jobId: job.jobId,
          kind,
          intendedStatus: 'succeeded',
          error: safeError(leaseError),
        });
        return;
      }

      job = await store.finishJob(job.jobId, {
        status: 'succeeded',
        leaseOwner: workerId,
        expectedRevision: currentRevision,
        result: result && typeof result === 'object' && !Array.isArray(result) ? result : {value: result ?? null},
        actorUser: workerId,
      });
      await emit('succeeded', {jobId: job.jobId, kind, taskId: job.taskId, chatSessionId: job.chatSessionId});
    } catch (error) {
      await cleanupHeartbeat();

      if (lostLease || error?.code === 'INITIAL_ADVANCE_TIMEOUT' || error?.code === 'INITIAL_ADVANCE_EXPIRED') {
        lostLease = true;
        if (!leaseError) leaseError = error;
        abortController.abort(leaseError);
        await emit('finish-skipped-lost-lease', {
          jobId: job.jobId,
          kind,
          intendedStatus: error?.uncertainWrite === true ? 'uncertain_write' : 'failed',
          error: safeError(leaseError || error),
        });
        return;
      }

      const safe = safeError(error);
      const finalStatus = error?.uncertainWrite === true ? 'uncertain_write' : 'failed';
      try {
        await store.finishJob(job.jobId, {
          status: finalStatus,
          leaseOwner: workerId,
          expectedRevision: currentRevision,
          error: safe,
          actorUser: workerId,
        });
      } catch (finishError) {
        await emit('finish-failed', {jobId: job.jobId, kind, error: safeError(finishError)});
        throw finishError;
      }
      await emit(finalStatus, {jobId: job.jobId, kind, error: safe});
    }
  }

  async function runOnce() {
    if (running) return running;
    // Synchronous claim admission guard: once admission is closed no new
    // claim may start. The flag check and the claimJob() invocation happen in
    // the same synchronous turn (no await between them), so a stop/stopAdmitting
    // either precedes this check (refusing the claim) or the claim is already
    // entered and is by definition in-flight.
    if (admissionClosed) return {claimed: false, skipped: true};
    running = (async () => {
      const claimed = await store.claimJob({workerId, leaseMs: leaseDurationMs});
      if (!claimed) return {claimed: false};
      await processClaimedJob(claimed);
      return {claimed: true, jobId: claimed.jobId};
    })();
    try {
      return await running;
    } finally {
      running = null;
    }
  }

  function schedule(delay = intervalMs) {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      try {
        const result = await runOnce();
        schedule(result.claimed ? 0 : intervalMs);
      } catch (error) {
        await emit('worker-error', {error: safeError(error)});
        schedule(intervalMs);
      }
    }, Math.max(0, delay));
    timer.unref?.();
  }

  function start() {
    // Admission close is terminal for this worker instance.  Re-opening the
    // same instance after shutdown would let a late startup continuation claim
    // work from a store that shutdown may already be draining/closing.
    if (!stopped || admissionClosed) return;
    stopped = false;
    schedule(0);
  }

  function wake() {
    if (stopped) return;
    schedule(0);
  }

  /**
   * Synchronously closes claim admission. After this returns, no worker
   * iteration that has not already entered runOnce()/claimJob() may start a
   * new claim: the pending poll timer is cancelled (so a later timer tick
   * cannot initiate a claim) and runOnce() refuses to begin while admission
   * is closed. An iteration that already entered claimJob() keeps its lease
   * and is treated as in-flight; await drain() to settle it. Idempotent.
   */
  function stopAdmitting() {
    if (admissionClosed) return;
    admissionClosed = true;
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  /**
   * Waits until every in-flight worker iteration has settled to a terminal
   * state (succeeded/failed/uncertain-write) or returned without a claim.
   * Idempotent: all callers share one drain promise. Because no new claim can
   * start once admission is closed, this resolves as soon as the current
   * iteration (if any) finishes. The store must only be closed after drain()
   * resolves — never while an in-flight iteration still owns a lease.
   */
  async function drain() {
    stopAdmitting();
    if (!drainPromise) {
      drainPromise = (async () => {
        // Once admission is closed there can be at most the iteration that
        // already entered runOnce().  Propagate its failure: swallowing a
        // claim/finish error would let Portal close the store and report a
        // graceful shutdown while a durable lease may still be unresolved.
        const inFlight = running;
        if (inFlight) await inFlight;
      })();
    }
    return drainPromise;
  }

  async function stop() {
    stopAdmitting();
    await drain();
  }

  return Object.freeze({
    workerId,
    start,
    wake,
    stop,
    stopAdmitting,
    drain,
    runOnce,
    isRunning: () => Boolean(running),
    isStopped: () => stopped,
    status: () => ({
      admitting: !admissionClosed,
      admissionClosed,
      stopped,
      running: Boolean(running),
      inFlight: Boolean(running),
      draining: Boolean(drainPromise),
    }),
  });
}
