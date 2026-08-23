const IDEMPOTENT_FETCH_METHODS = new Set(['GET', 'HEAD']);
const TRANSIENT_FETCH_STATUS_CODES = new Set([429, 502, 503, 504]);
const TRANSIENT_FETCH_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);
const DEFAULT_IDEMPOTENT_FETCH_RETRY_DELAYS_MS = Object.freeze([125, 375, 875]);

function queryErrorCode(error) {
  return String(error?.response?.code || error?.code || '').trim();
}

function fetchErrorCodes(error) {
  const codes = [];
  let current = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const code = String(current?.code || '').trim().toUpperCase();
    if (code) codes.push(code);
    current = current?.cause;
  }
  return codes;
}

export function isTransientFetchNetworkError(error, {signal = null} = {}) {
  if (!error || signal?.aborted || error?.name === 'AbortError') return false;
  const codes = fetchErrorCodes(error);
  if (codes.length) return codes.every(code => TRANSIENT_FETCH_ERROR_CODES.has(code));
  return error?.name === 'TypeError' && /^fetch failed$/i.test(String(error?.message || '').trim());
}

function boundedRetryAfterMs(response) {
  const seconds = Number(response?.headers?.get?.('retry-after') || 0);
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(5_000, Math.ceil(seconds * 1_000))
    : 0;
}

function normalizedRetryDelays(value) {
  const source = Array.isArray(value) && value.length ? value : DEFAULT_IDEMPOTENT_FETCH_RETRY_DELAYS_MS;
  return source.map(delay => Math.max(0, Math.min(5_000, Number(delay) || 0)));
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('BI request cancelled');
  error.name = 'AbortError';
  throw error;
}

function fetchRequestMethod(input, init) {
  if (init?.method !== undefined) return String(init.method).trim().toUpperCase();
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return String(input.method || 'GET').trim().toUpperCase() || 'GET';
  }
  return 'GET';
}

/**
 * Retry only requests whose HTTP method is intrinsically idempotent. This is
 * deliberately shared by Partner CLI release checks, owner-knowledge checks
 * and ordinary GET readbacks. POST/PUT/PATCH/DELETE are attempted exactly once
 * because a lost response must never cause an automatic duplicate business
 * write.
 */
export async function fetchWithIdempotentNetworkRetry(fetchImpl, url, options = {}, retryOptions = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const method = fetchRequestMethod(url, options);
  const retryableMethod = IDEMPOTENT_FETCH_METHODS.has(method);
  const requestedAttempts = Math.trunc(Number(retryOptions.maxAttempts ?? 4));
  const maxAttempts = retryableMethod ? Math.max(1, Math.min(6, requestedAttempts || 1)) : 1;
  const delays = normalizedRetryDelays(retryOptions.delaysMs);
  const sleep = retryOptions.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfAborted(options?.signal);
    try {
      const response = await fetchImpl(url, options);
      const transientStatus = retryableMethod && TRANSIENT_FETCH_STATUS_CODES.has(Number(response?.status));
      if (!transientStatus || attempt >= maxAttempts) return response;
      try { await response?.body?.cancel?.(); } catch {}
      const delay = boundedRetryAfterMs(response) || delays[Math.min(attempt - 1, delays.length - 1)] || 0;
      if (delay > 0) await sleep(delay);
      continue;
    } catch (error) {
      lastError = error;
      if (!retryableMethod || attempt >= maxAttempts || !isTransientFetchNetworkError(error, {signal: options?.signal})) {
        if (retryableMethod && attempt >= maxAttempts && isTransientFetchNetworkError(error, {signal: options?.signal})) {
          const code = fetchErrorCodes(error)[0] || 'FETCH_FAILED';
          const exhausted = new Error(`BI 网络连接暂时中断（${code}），已尝试 ${attempt} 次仍未恢复；本次请求未获响应。`);
          exhausted.code = 'BI_TRANSIENT_NETWORK_RETRY_EXHAUSTED';
          exhausted.attempts = attempt;
          exhausted.cause = error;
          throw exhausted;
        }
        throw error;
      }
      const delay = delays[Math.min(attempt - 1, delays.length - 1)] || 0;
      if (delay > 0) await sleep(delay);
    }
  }
  throw lastError || new Error('BI request failed');
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
