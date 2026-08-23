function queryErrorCode(error) {
  return String(error?.response?.code || error?.code || '').trim();
}

export function isIncompleteBiQueryError(error) {
  return queryErrorCode(error) === 'BI_QUERY_DATA_INCOMPLETE';
}

export function isBusyBiQueryError(error) {
  return Number(error?.status) === 429 && queryErrorCode(error) === 'QUERY_SURFACE_BUSY';
}

function retryDelayMs(error, fallbackMs) {
  const suggested = Number(error?.retryAfterMs || 0);
  return Math.max(fallbackMs, Math.min(30_000, Number.isFinite(suggested) ? suggested : 0));
}

export function biQueryRequestTimeoutMs(sections = [], env = process.env) {
  const requested = new Set((Array.isArray(sections) ? sections : [])
    .map(value => String(value || '').trim()).filter(Boolean));
  const fallback = requested.has('linksData') ? 60_000 : 30_000;
  const configured = Number(env.SHEIN_BI_QUERY_REQUEST_TIMEOUT_MS || fallback);
  return Math.max(10_000, Math.min(120_000, Number.isFinite(configured) ? configured : fallback));
}

export async function runBiQueryWithWait(request, options = {}) {
  if (typeof request !== 'function') throw new TypeError('request must be a function');
  const waitSeconds = Math.max(0, Math.min(300, Number(options.waitSeconds) || 0));
  const intervalMs = Math.max(10, Math.min(5_000, Number(options.intervalMs) || 1_000));
  const requestTimeoutMs = Math.max(10, Math.min(120_000, Number(options.requestTimeoutMs) || 30_000));
  const retryRequestTimeout = options.retryRequestTimeout === true;
  const now = options.now || Date.now;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const startedMs = now();
  const deadline = startedMs + waitSeconds * 1_000;
  let attempts = 0;
  let lastRetryableError = null;
  while (true) {
    const remainingMs = Math.max(0, deadline - now());
    if (lastRetryableError && waitSeconds > 0 && remainingMs < requestTimeoutMs) {
      lastRetryableError.queryAttempts = attempts;
      lastRetryableError.queryWaitedMs = Math.max(0, now() - startedMs);
      throw lastRetryableError;
    }
    attempts += 1;
    const attemptTimeoutMs = waitSeconds > 0
      ? Math.max(10, Math.min(requestTimeoutMs, remainingMs || requestTimeoutMs))
      : requestTimeoutMs;
    const controller = new AbortController();
    let requestTimedOut = false;
    const timer = setTimeout(() => {
      requestTimedOut = true;
      controller.abort();
    }, attemptTimeoutMs);
    try {
      const value = await request({signal: controller.signal, attempt: attempts, timeoutMs: attemptTimeoutMs});
      return {value, attempts, waitedMs: Math.max(0, now() - startedMs)};
    } catch (error) {
      if (requestTimedOut) {
        const waitedMs = Math.max(0, now() - startedMs);
        const timeout = new Error(`BI query request timed out after ${attemptTimeoutMs}ms`);
        timeout.code = 'BI_QUERY_REQUEST_TIMEOUT';
        timeout.queryAttempts = attempts;
        timeout.queryWaitedMs = waitedMs;
        if (retryRequestTimeout && now() < deadline
          && Math.max(0, deadline - now()) >= intervalMs + requestTimeoutMs) {
          await sleep(intervalMs);
          continue;
        }
        throw timeout;
      }
      const retryable = isIncompleteBiQueryError(error) || isBusyBiQueryError(error);
      if (!retryable) {
        error.queryAttempts = attempts;
        error.queryWaitedMs = Math.max(0, now() - startedMs);
        throw error;
      }
      lastRetryableError = error;
      const retryDelay = retryDelayMs(error, intervalMs);
      if (Math.max(0, deadline - now()) < retryDelay + requestTimeoutMs) {
        error.queryAttempts = attempts;
        error.queryWaitedMs = Math.max(0, now() - startedMs);
        throw error;
      }
      await sleep(retryDelay);
    } finally {
      clearTimeout(timer);
    }
  }
}
