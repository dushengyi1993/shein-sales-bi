const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const PORTAL_SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "form-action 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "frame-src 'self'",
    "worker-src 'self' blob:",
  ].join('; '),
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Referrer-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
});

export function portalResponseHeaders(extra = {}) {
  return {
    ...PORTAL_SECURITY_HEADERS,
    ...extra,
  };
}

export function isMutationMethod(method) {
  return MUTATION_METHODS.has(String(method || '').toUpperCase());
}

function firstHeaderValue(value) {
  return String(value || '').split(',')[0].trim();
}

function expectedRequestOrigin(req) {
  const host = firstHeaderValue(req?.headers?.['x-forwarded-host'] || req?.headers?.host);
  if (!host) return '';
  const protocol = firstHeaderValue(req?.headers?.['x-forwarded-proto'])
    || (req?.socket?.encrypted ? 'https' : 'http');
  return `${protocol}://${host}`;
}

export function mutationOriginAllowed(req, {trustedInternal = false} = {}) {
  if (!isMutationMethod(req?.method) || trustedInternal) return true;
  const fetchSite = String(req?.headers?.['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite === 'cross-site') return false;

  const expected = expectedRequestOrigin(req);
  if (!expected) return true;
  for (const candidate of [req?.headers?.origin, req?.headers?.referer]) {
    if (!candidate) continue;
    try {
      if (new URL(String(candidate)).origin !== expected) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function requestClientAddress(req) {
  return firstHeaderValue(req?.headers?.['x-forwarded-for'])
    || firstHeaderValue(req?.headers?.['x-real-ip'])
    || String(req?.socket?.remoteAddress || 'unknown');
}

export function loginRateKey(req, username) {
  return `${requestClientAddress(req)}\u0000${String(username || '').trim().toLowerCase() || '-'}`;
}

export function createLoginRateLimiter({limit = 8, windowMs = 15 * 60_000, lockMs = 15 * 60_000, now = () => Date.now()} = {}) {
  const attempts = new Map();

  function inspect(key) {
    const currentTime = now();
    const state = attempts.get(key);
    if (!state) return {allowed: true, remaining: limit, retryAfterSec: 0};
    if (state.lockUntil > currentTime) {
      return {allowed: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil((state.lockUntil - currentTime) / 1000))};
    }
    if (currentTime - state.windowStartedAt >= windowMs) {
      attempts.delete(key);
      return {allowed: true, remaining: limit, retryAfterSec: 0};
    }
    return {allowed: true, remaining: Math.max(0, limit - state.count), retryAfterSec: 0};
  }

  function fail(key) {
    const currentTime = now();
    const previous = attempts.get(key);
    const state = !previous || currentTime - previous.windowStartedAt >= windowMs
      ? {count: 0, windowStartedAt: currentTime, lockUntil: 0}
      : {...previous};
    state.count += 1;
    if (state.count >= limit) state.lockUntil = currentTime + lockMs;
    attempts.set(key, state);
    return inspect(key);
  }

  function success(key) {
    attempts.delete(key);
  }

  return {inspect, fail, success, size: () => attempts.size};
}

export function createSerialMutationQueue(options) {
  return createBoundedSerialMutationQueue(options);
}

export const MUTATION_QUEUE_REJECTIONS = Object.freeze({
  SATURATED: 'QUEUE_SATURATED',
  DEADLINE_EXCEEDED: 'QUEUE_DEADLINE_EXCEEDED',
  SHUTDOWN: 'QUEUE_SHUTDOWN',
  CANCELLED: 'QUEUE_CANCELLED',
});

const MUTATION_QUEUE_REASON_DETAILS = Object.freeze({
  saturated: {
    code: MUTATION_QUEUE_REJECTIONS.SATURATED,
    message: 'Mutation queue is saturated; the request was not accepted',
  },
  'deadline-exceeded': {
    code: MUTATION_QUEUE_REJECTIONS.DEADLINE_EXCEEDED,
    message: 'Mutation queue deadline exceeded before execution started; nothing was written',
  },
  shutdown: {
    code: MUTATION_QUEUE_REJECTIONS.SHUTDOWN,
    message: 'Mutation queue is shutting down; queued work was cancelled before it started and was not retried',
  },
  cancelled: {
    code: MUTATION_QUEUE_REJECTIONS.CANCELLED,
    message: 'Mutation queue work was cancelled before it started',
  },
});

/**
 * Bounded, fail-closed serial mutation queue.
 *
 * Invariants:
 * - Strict serial execution: at most one task runs at a time, appended onto a
 *   promise tail exactly like the legacy infinite-tail queue.
 * - Bounded capacity: capacity limits queued-but-not-started work. The
 *   running task is not counted against it, so a queue at capacity holds one
 *   running task plus capacity queued tasks and rejects the next admission.
 * - Optional per-actor bound: pass actor when enqueuing and set
 *   perActorCapacity to bound queued work per actor.
 * - Queue deadline: an item that does not start before deadlineMs (or the
 *   per-item options.deadlineMs) is rejected with deadline-exceeded.
 * - Shutdown: enqueue.shutdown() rejects every queued-but-not-started item
 *   with shutdown, refuses all new admissions, lets the running task settle
 *   exactly once, and resolves when the queue drains.
 * - No auto-retry: a started task runs exactly once whether it succeeds or
 *   throws; a task rejected before start is never run. Committed writes are
 *   never automatically retried.
 *
 * Rejections are Error instances carrying error.reason and error.code
 * (see MUTATION_QUEUE_REJECTIONS), plus error.queueRejected = true so HTTP
 * surfaces can map saturated/deadline to 429 and shutdown/cancelled to 503.
 */
function createBoundedSerialMutationQueue({
  capacity = 256,
  perActorCapacity = 0,
  deadlineMs = 30_000,
  now = () => Date.now(),
} = {}) {
  const maxQueued = positiveInteger(capacity);
  const maxPerActor = positiveInteger(perActorCapacity);
  const queueDeadlineMs = positiveInteger(deadlineMs);
  const currentTime = typeof now === 'function' ? now : () => Date.now();

  let tailPromise = Promise.resolve();
  let runningCount = 0;
  let shuttingDown = false;
  let drainHandle = null;
  let drainResolve = null;
  const pending = new Set();
  const actorPending = new Map();
  const counters = {
    enqueued: 0,
    started: 0,
    completed: 0,
    rejected: {saturated: 0, deadlineExceeded: 0, shutdown: 0, cancelled: 0},
  };

  function rejection(reason, actorKey) {
    const details = MUTATION_QUEUE_REASON_DETAILS[reason] || {
      code: 'QUEUE_REJECTED',
      message: 'Mutation queue rejected the request',
    };
    const error = new Error(details.message);
    error.reason = reason;
    error.code = details.code;
    error.queueRejected = true;
    if (actorKey !== undefined) error.actor = actorKey;
    return error;
  }

  function releasePending(item) {
    if (item.released) return;
    item.released = true;
    pending.delete(item);
    if (item.actorKey !== undefined && maxPerActor > 0) {
      const remaining = (actorPending.get(item.actorKey) || 1) - 1;
      if (remaining <= 0) actorPending.delete(item.actorKey);
      else actorPending.set(item.actorKey, remaining);
    }
  }

  function settleDrain() {
    if (!drainResolve) return;
    if (runningCount === 0 && pending.size === 0) {
      const resolve = drainResolve;
      drainResolve = null;
      drainHandle = null;
      resolve();
    }
  }

  function cancelQueued(item, reason) {
    if (item.started || item.canceled) return;
    item.canceled = reason;
    if (item.cleanup) item.cleanup();
    releasePending(item);
    counters.rejected[reasonCounter(reason)] += 1;
    item.rejectOnce(rejection(reason, item.actorKey));
    settleDrain();
  }

  const runQueued = async item => {
    if (item.canceled) {
      // Already rejected before start (deadline/signal/shutdown); never run.
      releasePending(item);
      return undefined;
    }
    if (shuttingDown) {
      // Shutdown raced exactly as the item reached the head of the chain.
      item.canceled = 'shutdown';
      if (item.cleanup) item.cleanup();
      releasePending(item);
      counters.rejected.shutdown += 1;
      item.rejectOnce(rejection('shutdown', item.actorKey));
      settleDrain();
      return undefined;
    }
    item.started = true;
    if (item.cleanup) item.cleanup();
    releasePending(item);
    runningCount += 1;
    counters.started += 1;
    try {
      return await item.task();
    } finally {
      runningCount -= 1;
      counters.completed += 1;
      settleDrain();
    }
  };

  function enqueue(task, options = {}) {
    if (typeof task !== 'function') {
      return Promise.reject(Object.assign(new TypeError('Mutation queue task must be a function'), {
        code: 'QUEUE_INVALID_TASK',
        reason: 'invalid-task',
        queueRejected: true,
      }));
    }
    const actorKey = options?.actor === undefined || options?.actor === null
      ? undefined
      : String(options.actor);
    const perTaskDeadlineMs = positiveInteger(options?.deadlineMs);
    const effectiveDeadlineMs = perTaskDeadlineMs > 0 ? perTaskDeadlineMs : queueDeadlineMs;

    if (shuttingDown) {
      counters.rejected.shutdown += 1;
      return Promise.reject(rejection('shutdown', actorKey));
    }
    if (maxQueued > 0 && pending.size >= maxQueued) {
      counters.rejected.saturated += 1;
      return Promise.reject(rejection('saturated', actorKey));
    }
    if (actorKey !== undefined && maxPerActor > 0 && (actorPending.get(actorKey) || 0) >= maxPerActor) {
      counters.rejected.saturated += 1;
      return Promise.reject(rejection('saturated', actorKey));
    }
    if (options?.signal?.aborted) {
      counters.rejected.cancelled += 1;
      return Promise.reject(rejection('cancelled', actorKey));
    }

    const item = {
      task,
      actorKey,
      canceled: null,
      started: false,
      released: false,
      deadlineAt: effectiveDeadlineMs > 0 ? currentTime() + effectiveDeadlineMs : Infinity,
      timer: null,
      cleanup: null,
      rejectOnce: null,
      resolveOnce: null,
    };
    pending.add(item);
    if (actorKey !== undefined && maxPerActor > 0) {
      actorPending.set(actorKey, (actorPending.get(actorKey) || 0) + 1);
    }
    counters.enqueued += 1;

    const promise = new Promise((resolve, reject) => {
      let settled = false;
      item.rejectOnce = error => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      item.resolveOnce = value => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      item.cleanup = () => {
        if (item.timer !== null) {
          clearTimeout(item.timer);
          item.timer = null;
        }
        if (options?.signal) options.signal.removeEventListener('abort', item.onAbort, {once: true});
      };
      item.onAbort = () => cancelQueued(item, 'cancelled');
      if (effectiveDeadlineMs > 0) {
        const remaining = item.deadlineAt - currentTime();
        if (remaining <= 0) {
          cancelQueued(item, 'deadline-exceeded');
        } else {
          item.timer = setTimeout(() => cancelQueued(item, 'deadline-exceeded'), remaining);
        }
      }
      if (options?.signal) {
        if (options.signal.aborted) {
          cancelQueued(item, 'cancelled');
        } else {
          options.signal.addEventListener('abort', item.onAbort, {once: true});
        }
      }
    });

    const chained = tailPromise.then(
      () => runQueued(item),
      () => runQueued(item),
    );
    tailPromise = chained.then(() => undefined, () => undefined);
    chained.then(
      value => item.resolveOnce(value),
      error => item.rejectOnce(error),
    );
    return promise;
  }

  enqueue.status = () => ({
    capacity: maxQueued,
    perActorCapacity: maxPerActor,
    deadlineMs: queueDeadlineMs,
    queued: pending.size,
    running: runningCount,
    shuttingDown,
    enqueued: counters.enqueued,
    started: counters.started,
    completed: counters.completed,
    rejected: {...counters.rejected},
  });
  enqueue.shutdown = () => {
    if (drainHandle) return drainHandle;
    shuttingDown = true;
    drainHandle = new Promise(resolve => { drainResolve = resolve; });
    for (const item of [...pending]) cancelQueued(item, 'shutdown');
    settleDrain();
    return drainHandle;
  };
  enqueue.size = () => pending.size + runningCount;
  return enqueue;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function reasonCounter(reason) {
  return reason === 'deadline-exceeded' ? 'deadlineExceeded' : reason;
}
