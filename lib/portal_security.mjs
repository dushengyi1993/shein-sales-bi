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

export function createSerialMutationQueue() {
  let tail = Promise.resolve();
  return function enqueue(task) {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}
