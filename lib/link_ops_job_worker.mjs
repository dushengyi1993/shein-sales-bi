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
  onEvent = () => {},
} = {}) {
  if (!store || typeof store.claimJob !== 'function') throw new TypeError('A job-capable Link Ops store is required');
  const intervalMs = positiveInteger(pollMs, 1_500, {min: 100, max: 60_000});
  const leaseDurationMs = positiveInteger(leaseMs, 10 * 60_000, {min: 5_000, max: 86_400_000});
  let timer = null;
  let stopped = true;
  let running = null;

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

    try {
      job = await store.advanceJobWriteBoundary(job.jobId, 'read_only', {
        leaseOwner: workerId,
        expectedRevision: job.repositoryRevision,
        payloadHash: job.payloadHash,
      });
      await emit('started', {jobId: job.jobId, kind, taskId: job.taskId, chatSessionId: job.chatSessionId});
      const result = await handler(job, {workerId, leaseMs: leaseDurationMs});
      job = await store.finishJob(job.jobId, {
        status: 'succeeded',
        leaseOwner: workerId,
        expectedRevision: job.repositoryRevision,
        result: result && typeof result === 'object' && !Array.isArray(result) ? result : {value: result ?? null},
        actorUser: workerId,
      });
      await emit('succeeded', {jobId: job.jobId, kind, taskId: job.taskId, chatSessionId: job.chatSessionId});
    } catch (error) {
      const safe = safeError(error);
      try {
        await store.finishJob(job.jobId, {
          status: 'failed',
          leaseOwner: workerId,
          expectedRevision: job.repositoryRevision,
          error: safe,
          actorUser: workerId,
        });
      } catch (finishError) {
        await emit('finish-failed', {jobId: job.jobId, kind, error: safeError(finishError)});
        throw finishError;
      }
      await emit('failed', {jobId: job.jobId, kind, error: safe});
    }
  }

  async function runOnce() {
    if (running) return running;
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
    if (!stopped) return;
    stopped = false;
    schedule(0);
  }

  function wake() {
    if (stopped) return;
    schedule(0);
  }

  async function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    await running?.catch(() => {});
  }

  return Object.freeze({workerId, start, wake, stop, runOnce, isRunning: () => Boolean(running), isStopped: () => stopped});
}
