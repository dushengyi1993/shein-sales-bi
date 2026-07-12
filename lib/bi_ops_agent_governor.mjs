export class BiOpsAgentGovernorError extends Error {
  constructor(message, {code = 'AGENT_UNAVAILABLE', status = 503, retryAfterSec = 0, details = {}} = {}) {
    super(message);
    this.name = 'BiOpsAgentGovernorError';
    this.code = code;
    this.status = status;
    this.retryAfterSec = retryAfterSec;
    this.details = details;
  }
}

function positiveInteger(value, fallback, minimum = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.floor(parsed)) : fallback;
}

function normalizeActorKey(value) {
  return String(value || '').trim().toLowerCase() || 'anonymous';
}

/**
 * In-process admission control for the shared Codex gateway.
 *
 * This governor intentionally does not persist business state. It only prevents a
 * shared OAuth-backed model process from being exhausted by concurrent users.
 * Business-task idempotency and locking must still be enforced by the task store.
 */
export function createBiOpsAgentGovernor(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const maxConcurrent = positiveInteger(options.maxConcurrent, 2);
  const maxQueue = positiveInteger(options.maxQueue, 12, 0);
  const maxConcurrentPerActor = positiveInteger(options.maxConcurrentPerActor, 1);
  const maxQueuedPerActor = positiveInteger(options.maxQueuedPerActor, 3, 0);
  const rateLimit = positiveInteger(options.rateLimit, 12);
  const rateWindowMs = positiveInteger(options.rateWindowMs, 10 * 60_000);
  const queueTimeoutMs = positiveInteger(options.queueTimeoutMs, 45_000);
  const failureThreshold = positiveInteger(options.failureThreshold, 4);
  const failureWindowMs = positiveInteger(options.failureWindowMs, 5 * 60_000);
  const circuitCooldownMs = positiveInteger(options.circuitCooldownMs, 2 * 60_000);
  const countsTowardCircuit = typeof options.countsTowardCircuit === 'function'
    ? options.countsTowardCircuit
    : error => {
      if (error instanceof BiOpsAgentGovernorError) return false;
      const status = Number(error?.status || error?.statusCode || 0);
      const code = String(error?.code || '').toUpperCase();
      const message = String(error?.message || error || '');
      return status === 429
        || status >= 500
        || /^(EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|UND_ERR_)/.test(code)
        || /timeout|timed out|network|authentication|unauthorized|token.*expired|codex gateway failed|model.*(?:unavailable|not found)/i.test(message);
    };

  const queue = [];
  const activeByActor = new Map();
  const startsByActor = new Map();
  let active = 0;
  let activeExclusive = 0;
  let sequence = 0;
  let circuitOpenUntil = 0;
  let recentFailures = [];

  function prune(currentTime = now()) {
    recentFailures = recentFailures.filter(ts => currentTime - ts < failureWindowMs);
    for (const [key, starts] of startsByActor) {
      const fresh = starts.filter(ts => currentTime - ts < rateWindowMs);
      if (fresh.length) startsByActor.set(key, fresh);
      else startsByActor.delete(key);
    }
  }

  function queuedForActor(actorKey) {
    return queue.reduce((count, entry) => count + (entry.actorKey === actorKey ? 1 : 0), 0);
  }

  function retryAfterForRate(starts, currentTime) {
    if (!starts.length) return 1;
    return Math.max(1, Math.ceil((starts[0] + rateWindowMs - currentTime) / 1000));
  }

  function circuitError(currentTime = now()) {
    return new BiOpsAgentGovernorError('智能运营服务正在短暂恢复，请稍后重试', {
      code: 'AGENT_CIRCUIT_OPEN',
      status: 503,
      retryAfterSec: Math.max(1, Math.ceil((circuitOpenUntil - currentTime) / 1000)),
    });
  }

  function rejectEntry(entry, error) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.reject(error);
  }

  function nextRunnableIndex() {
    if (activeExclusive > 0) return -1;
    for (let index = 0; index < queue.length; index += 1) {
      const entry = queue[index];
      if (entry.exclusive) return active === 0 ? index : -1;
      if ((activeByActor.get(entry.actorKey) || 0) < maxConcurrentPerActor) return index;
    }
    return -1;
  }

  function recordFailure(error) {
    if (!countsTowardCircuit(error)) return;
    const currentTime = now();
    prune(currentTime);
    recentFailures.push(currentTime);
    if (recentFailures.length >= failureThreshold) {
      circuitOpenUntil = Math.max(circuitOpenUntil, currentTime + circuitCooldownMs);
      recentFailures = [];
      while (queue.length) rejectEntry(queue.shift(), circuitError(currentTime));
    }
  }

  function drain() {
    const currentTime = now();
    prune(currentTime);
    if (circuitOpenUntil > currentTime) return;
    if (circuitOpenUntil) circuitOpenUntil = 0;

    while (active < maxConcurrent && queue.length) {
      const index = nextRunnableIndex();
      if (index < 0) return;
      const [entry] = queue.splice(index, 1);
      if (entry.timer) clearTimeout(entry.timer);
      active += 1;
      if (entry.exclusive) activeExclusive += 1;
      activeByActor.set(entry.actorKey, (activeByActor.get(entry.actorKey) || 0) + 1);
      const starts = startsByActor.get(entry.actorKey) || [];
      starts.push(currentTime);
      startsByActor.set(entry.actorKey, starts);

      Promise.resolve()
        .then(entry.task)
        .then(entry.resolve, error => {
          recordFailure(error);
          entry.reject(error);
        })
        .finally(() => {
          active -= 1;
          if (entry.exclusive) activeExclusive = Math.max(0, activeExclusive - 1);
          const actorActive = Math.max(0, (activeByActor.get(entry.actorKey) || 1) - 1);
          if (actorActive) activeByActor.set(entry.actorKey, actorActive);
          else activeByActor.delete(entry.actorKey);
          drain();
        });
    }
  }

  function run(actorValue, task, metadata = {}) {
    if (typeof task !== 'function') return Promise.reject(new TypeError('Agent task must be a function'));
    const actorKey = normalizeActorKey(actorValue);
    const currentTime = now();
    prune(currentTime);

    if (circuitOpenUntil > currentTime) return Promise.reject(circuitError(currentTime));
    const starts = startsByActor.get(actorKey) || [];
    if (starts.length >= rateLimit) {
      return Promise.reject(new BiOpsAgentGovernorError('你的智能运营请求过于频繁，请稍后再试', {
        code: 'AGENT_RATE_LIMITED',
        status: 429,
        retryAfterSec: retryAfterForRate(starts, currentTime),
        details: {actorKey, rateLimit, rateWindowMs},
      }));
    }
    if (queue.length >= maxQueue || queuedForActor(actorKey) >= maxQueuedPerActor) {
      return Promise.reject(new BiOpsAgentGovernorError('智能运营队列已满，请等待当前任务完成', {
        code: 'AGENT_QUEUE_FULL',
        status: 429,
        retryAfterSec: Math.max(1, Math.ceil(queueTimeoutMs / 1000)),
        details: {actorKey, queueDepth: queue.length},
      }));
    }

    return new Promise((resolve, reject) => {
      const entry = {
        id: ++sequence,
        actorKey,
        metadata,
        exclusive: metadata?.exclusive === true || ['deep', 'owner'].includes(String(metadata?.tier || '').toLowerCase()),
        task,
        resolve,
        reject,
        enqueuedAt: currentTime,
        timer: null,
      };
      entry.timer = setTimeout(() => {
        const index = queue.findIndex(item => item.id === entry.id);
        if (index < 0) return;
        queue.splice(index, 1);
        rejectEntry(entry, new BiOpsAgentGovernorError('等待智能运营服务超时，请稍后重试', {
          code: 'AGENT_QUEUE_TIMEOUT',
          status: 503,
          retryAfterSec: 5,
          details: {actorKey},
        }));
      }, queueTimeoutMs);
      entry.timer.unref?.();
      queue.push(entry);
      drain();
    });
  }

  function snapshot() {
    const currentTime = now();
    prune(currentTime);
    return {
      active,
      activeExclusive,
      queued: queue.length,
      maxConcurrent,
      maxQueue,
      activeByActor: Object.fromEntries(activeByActor),
      circuit: {
        open: circuitOpenUntil > currentTime,
        retryAfterSec: circuitOpenUntil > currentTime
          ? Math.max(1, Math.ceil((circuitOpenUntil - currentTime) / 1000))
          : 0,
      },
      rate: {limit: rateLimit, windowMs: rateWindowMs},
    };
  }

  return {run, snapshot};
}
