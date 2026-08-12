#!/usr/bin/env node
/**
 * Deterministic tests for the read-only OpenAPI bounded transient retry
 * (2026-08-12 21:45 undici `TypeError: fetch failed` incident class).
 *
 * Pins three contracts:
 * - transport failure then success is retried with bounded exponential backoff;
 * - exhausted retry budget still fails (never converts a failure into success);
 * - any received HTTP response, including a business code != 0, is returned
 *   unchanged without retry (business errors are never swallowed);
 * - the generic request() path used by write endpoints never retries.
 */
import assert from 'node:assert/strict';
import {isTransientFetchTransportError, SheinOpenApiClient} from '../lib/shein_openapi_client.mjs';

const CLIENT_OPTIONS = {
  baseUrl: 'http://127.0.0.1:9',
  openKeyId: 'test-open-key',
  secretKey: 'test-secret-key',
};

function transportError(message = 'fetch failed', causeCode = 'ECONNRESET') {
  return new TypeError(message, {cause: Object.assign(new Error(message), {code: causeCode})});
}

function sequencedFetch(sequence) {
  const calls = [];
  const impl = async (url, init) => {
    const next = sequence[Math.min(calls.length, sequence.length - 1)];
    calls.push({url, init});
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(url, init);
    return next;
  };
  return {impl, calls};
}

function captureSetTimeout() {
  const original = globalThis.setTimeout;
  const calls = [];
  globalThis.setTimeout = (fn, ms, ...rest) => {
    calls.push(ms);
    fn(...rest);
    return 0;
  };
  return {calls, restore: () => { globalThis.setTimeout = original; }};
}

const okResponse = {ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({code: '0', msg: 'success', info: {rows: []}})};
const businessErrorResponse = {ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({code: '1', msg: 'params invalid', traceId: 'tr-biz'})};
const http500Response = {ok: false, status: 500, statusText: 'Server Error', text: async () => JSON.stringify({code: '1', msg: 'server error'})};

const tests = [];

// 1. fail-then-success: bounded retry with exponential backoff, fresh signing per attempt.
{
  const timer = captureSetTimeout();
  try {
    const {impl, calls} = sequencedFetch([transportError(), transportError(), okResponse]);
    const client = new SheinOpenApiClient({...CLIENT_OPTIONS, fetchImpl: impl});
    const response = await client.requestReadOnly('/open-api/order/order-list', {body: {page: 1}});
    assert.equal(calls.length, 3, 'two transient failures then success must take exactly 3 attempts');
    assert.equal(response.data.code, '0');
    assert.deepEqual(timer.calls, [500, 1000], 'expected exponential backoff 500ms then 1000ms');
    assert.ok(calls.every(call => String(call.init.headers['x-lt-signature'] || '').length >= 5),
      'every retry attempt must carry a signed header');
    assert.ok(calls.every(call => String(call.url).includes('/open-api/order/order-list')),
      'every attempt must target the read-only endpoint');
  } finally {
    timer.restore();
  }
  tests.push('fail-then-success');
}

// 2. budget exhausted still fails with the original transport error.
{
  const timer = captureSetTimeout();
  try {
    const {impl, calls} = sequencedFetch([transportError('fetch failed', 'ETIMEDOUT')]);
    const client = new SheinOpenApiClient({...CLIENT_OPTIONS, fetchImpl: impl});
    await assert.rejects(
      client.requestReadOnly('/open-api/order/order-list', {body: {page: 1}}, {maxAttempts: 3, baseDelayMs: 100}),
      error => error instanceof TypeError && /fetch failed/.test(error.message),
    );
    assert.equal(calls.length, 3, 'exhausted budget must fail after exactly maxAttempts');
    assert.deepEqual(timer.calls, [100, 200], 'backoff must stay bounded');
  } finally {
    timer.restore();
  }
  tests.push('budget-exhausted-still-fails');
}

// 3. business non-zero error is not swallowed and is not retried.
{
  const timer = captureSetTimeout();
  try {
    const {impl, calls} = sequencedFetch([businessErrorResponse, okResponse]);
    const client = new SheinOpenApiClient({...CLIENT_OPTIONS, fetchImpl: impl});
    const response = await client.requestReadOnly('/open-api/openapi-business-backend/product/query', {body: {pageNum: 1}});
    assert.equal(calls.length, 1, 'business code != 0 must not retry');
    assert.equal(response.data.code, '1');
    assert.equal(response.data.traceId, 'tr-biz');
    assert.deepEqual(timer.calls, [], 'no backoff sleeps for business errors');
  } finally {
    timer.restore();
  }
  tests.push('business-error-not-swallowed');
}

// 4. an HTTP 5xx response is also not retried: retry is transport-only.
{
  const timer = captureSetTimeout();
  try {
    const {impl, calls} = sequencedFetch([http500Response, okResponse]);
    const client = new SheinOpenApiClient({...CLIENT_OPTIONS, fetchImpl: impl});
    const response = await client.requestReadOnly('/open-api/order/order-list', {body: {page: 1}});
    assert.equal(calls.length, 1, 'received HTTP responses must never be retried');
    assert.equal(response.status, 500);
    assert.equal(response.data.code, '1');
    assert.deepEqual(timer.calls, []);
  } finally {
    timer.restore();
  }
  tests.push('http-response-no-retry');
}

// 5. generic request() (write endpoints) never retries a transport failure.
{
  const timer = captureSetTimeout();
  try {
    const {impl, calls} = sequencedFetch([transportError(), okResponse]);
    const client = new SheinOpenApiClient({...CLIENT_OPTIONS, fetchImpl: impl});
    await assert.rejects(
      client.request('/open-api/stock/change-inventory/v2', {method: 'POST', body: {}}),
      error => error instanceof TypeError && /fetch failed/.test(error.message),
    );
    assert.equal(calls.length, 1, 'the generic write-path request must never retry');
    assert.deepEqual(timer.calls, [], 'no backoff on the generic path');
  } finally {
    timer.restore();
  }
  tests.push('write-path-no-retry');
}

// 6. retry configuration stays bounded regardless of caller input.
{
  const {impl, calls} = sequencedFetch([transportError()]);
  const client = new SheinOpenApiClient({...CLIENT_OPTIONS, fetchImpl: impl});
  await assert.rejects(client.requestReadOnly('/open-api/order/order-list', {}, {maxAttempts: 99, baseDelayMs: -1}));
  assert.equal(calls.length, 5, 'maxAttempts must be clamped to 5');
  tests.push('retry-config-bounded');
}

// 7. transient classification covers the incident class and rejects responses.
{
  assert.equal(isTransientFetchTransportError(transportError('fetch failed', 'UND_ERR_SOCKET')), true);
  assert.equal(isTransientFetchTransportError(new TypeError('fetch failed', {cause: new Error('connect ECONNREFUSED 10.0.0.1:443')})), true);
  assert.equal(isTransientFetchTransportError(new Error('SHEIN OpenAPI request timed out after 25ms: /x', {cause: new Error('aborted')})), false);
  assert.equal(isTransientFetchTransportError(new Error('openKeyId is required')), false);
  assert.equal(isTransientFetchTransportError(null), false);
  tests.push('transient-classification');
}

console.log(JSON.stringify({ok: true, tests}, null, 2));
