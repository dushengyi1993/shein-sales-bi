#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  buildStockFailureSummary,
  fetchStock,
  isRetryableOpenapiFailure,
  parseArgs,
  sleepWithJitter,
} from './fetch_shein_openapi_products.mjs';

const okResponse = {ok: true, status: 200, data: {code: '0', msg: 'success', traceId: 'tr-ok', info: []}};
const tooMany = {ok: false, status: 429, data: {code: '429', msg: 'too many requests', traceId: 'tr-429'}};
const serverError = {ok: false, status: 500, data: {code: '1', msg: 'server error', traceId: 'tr-500'}};
const forbidden = {ok: false, status: 403, data: {code: '1', msg: 'forbidden', traceId: 'tr-403'}};
const businessError = {ok: false, status: 200, data: {code: '1', msg: 'params invalid', traceId: 'tr-biz'}};

function sequencedClient(sequence) {
  let calls = 0;
  return {
    async request() {
      const next = sequence[Math.min(calls, sequence.length - 1)];
      calls += 1;
      return next;
    },
    callCount: () => calls,
  };
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

function stubRandom(value) {
  const original = Math.random;
  Math.random = () => value;
  return () => { Math.random = original; };
}

const baseArgs = {
  skipStock: false,
  stockChunkSize: 2,
  stockRetryAttempts: 3,
  stockRetryBaseDelayMs: 1000,
};

const tests = [];

// 1. transient failures (429 -> 500) then success: retries with exponential
// backoff and stops on success.
{
  const timer = captureSetTimeout();
  const restoreRandom = stubRandom(0.5);
  try {
    const client = sequencedClient([tooMany, serverError, okResponse]);
    const responses = await fetchStock(client, ['S1', 'S2'], baseArgs);
    assert.equal(client.callCount(), 3);
    assert.equal(responses.length, 1);
    assert.equal(responses[0].ok, true);
    assert.equal(responses[0].attempts, 3);
    assert.equal(responses[0].chunkIndex, 0);
    assert.equal(responses[0].skuCount, 2);
    assert.equal(responses[0].data.code, '0');
    assert.deepEqual(timer.calls, [1000, 2000], 'expected exponential delays 1000ms then 2000ms');
  } finally {
    timer.restore();
    restoreRandom();
  }
  tests.push('transient-failure-then-success');
}

// 2. non-retryable failures do not loop, per-chunk independence preserved.
{
  const timer = captureSetTimeout();
  try {
    const client = sequencedClient([forbidden, okResponse]);
    const responses = await fetchStock(client, ['S1', 'S2', 'S3', 'S4'], baseArgs);
    assert.equal(client.callCount(), 2, 'non-retryable chunk must not loop');
    assert.equal(responses.length, 2);
    assert.equal(responses[0].ok, false);
    assert.equal(responses[0].attempts, 1);
    assert.equal(responses[0].chunkIndex, 0);
    assert.equal(responses[0].skuCount, 2);
    assert.equal(responses[0].httpStatus, 403);
    assert.equal('data' in responses[0], false, 'failed chunk must not carry the response body');
    assert.equal(responses[1].ok, true);
    assert.equal(responses[1].chunkIndex, 1);
    assert.deepEqual(timer.calls, [], 'no backoff sleeps for non-retryable failures');
  } finally {
    timer.restore();
  }
  tests.push('non-retryable-failure-no-loop');
}

// 2b. HTTP 200 with a business error code is also non-retryable.
{
  const client = sequencedClient([businessError, okResponse]);
  const responses = await fetchStock(client, ['S1', 'S2', 'S3', 'S4'], baseArgs);
  assert.equal(client.callCount(), 2);
  assert.equal(responses[0].ok, false);
  assert.equal(responses[0].attempts, 1);
  assert.equal(responses[0].code, '1');
  assert.equal(responses[1].ok, true);
  assert.equal(responses[1].chunkIndex, 1);
  tests.push('business-error-no-loop');
}

// 3. retry exhaustion: summary keeps only safe diagnostic metadata and never
// the full (potentially sensitive) response body.
{
  const timer = captureSetTimeout();
  const restoreRandom = stubRandom(0.5);
  try {
    const sensitiveBody = {
      code: '503',
      msg: 'unavailable',
      traceId: 'tr-503',
      info: [{secretToken: 'sk_live_abc123', rows: [1, 2, 3], payload: {password: 'p@ss'}}],
    };
    const serviceDown = {ok: false, status: 503, data: sensitiveBody};
    const client = sequencedClient([tooMany, serverError, serviceDown]);
    const responses = await fetchStock(client, ['S1', 'S2'], baseArgs);
    assert.equal(client.callCount(), 3);
    assert.equal(responses[0].ok, false);
    assert.equal(responses[0].attempts, 3);
    assert.equal(responses[0].httpStatus, 503);
    assert.equal(responses[0].chunkIndex, 0);
    assert.equal(responses[0].skuCount, 2);
    assert.equal(responses[0].code, '503');
    assert.equal('traceId' in responses[0], false);
    assert.equal(responses[0].failureClass, 'upstream_unavailable');
    assert.equal('data' in responses[0], false, 'failed chunk must not carry the response body');
    assert.deepEqual(timer.calls, [1000, 2000]);

    const summary = buildStockFailureSummary(responses);
    assert.deepEqual(Object.keys(summary[0]).sort(), [
      'attempts', 'chunkIndex', 'code', 'failureClass', 'httpStatus', 'skuCount',
    ]);
    assert.deepEqual(summary[0], {
      chunkIndex: 0,
      skuCount: 2,
      attempts: 3,
      httpStatus: 503,
      code: '503',
      failureClass: 'upstream_unavailable',
    });
    const serialized = JSON.stringify(summary);
    assert.equal(serialized.includes('secretToken'), false);
    assert.equal(serialized.includes('sk_live_abc123'), false);
    assert.equal(serialized.includes('password'), false);
    assert.equal(serialized.includes('"data"'), false);
  } finally {
    timer.restore();
    restoreRandom();
  }
  tests.push('retry-exhausted-summary-safe-metadata');
}

// 4. free-text and trace identifiers are omitted from persisted failures.
{
  const longMsg = `server exploded ${'x'.repeat(500)}`;
  const client = sequencedClient([{ok: false, status: 500, data: {code: '1', msg: longMsg, traceId: 'tr-long'}}]);
  const responses = await fetchStock(client, ['S1', 'S2'], baseArgs);
  assert.equal(responses[0].ok, false);
  assert.equal('msg' in responses[0], false);
  assert.equal('traceId' in responses[0], false);
  const summary = buildStockFailureSummary(responses);
  assert.equal(JSON.stringify(summary).includes(longMsg), false);
  tests.push('free-text-redaction');
}

// 5. transport exceptions are caught; timeout-style errors retry, hard errors do not.
{
  const timer = captureSetTimeout();
  const restoreRandom = stubRandom(0.5);
  try {
    let calls = 0;
    const flaky = {
      async request() {
        calls += 1;
        if (calls < 3) throw new Error('request timed out after 10s');
        return okResponse;
      },
    };
    const responses = await fetchStock(flaky, ['S1', 'S2'], baseArgs);
    assert.equal(calls, 3);
    assert.equal(responses[0].ok, true);
    assert.equal(responses[0].attempts, 3);
    assert.deepEqual(timer.calls, [1000, 2000]);

    let hardCalls = 0;
    const hard = {
      async request() {
        hardCalls += 1;
        throw new Error('ECONNREFUSED');
      },
    };
    const hardResponses = await fetchStock(hard, ['S1', 'S2'], baseArgs);
    assert.equal(hardCalls, 1, 'hard network error must not loop');
    assert.equal(hardResponses[0].ok, false);
    assert.equal(hardResponses[0].attempts, 1);
    assert.equal('error' in hardResponses[0], false);
    assert.equal(hardResponses[0].failureClass, 'transport_error');
    assert.equal('data' in hardResponses[0], false);
  } finally {
    timer.restore();
    restoreRandom();
  }
  tests.push('network-error-retry-classification');
}

// 6. retryable classification mirrors the detail semantics exactly.
{
  const retryable = [
    {httpStatus: 408},
    {httpStatus: 429},
    {httpStatus: 500},
    {httpStatus: 503},
    {code: '832213'},
    {msg: '触发限流'},
    {error: 'rate limit exceeded'},
    {error: 'request timed out'},
    {error: 'temporary failure'},
  ];
  const nonRetryable = [
    {httpStatus: 200, code: '0'},
    {httpStatus: 403},
    {httpStatus: 400},
    {code: '1'},
    {error: 'ECONNREFUSED'},
    {},
  ];
  for (const r of retryable) assert.equal(isRetryableOpenapiFailure(r), true, JSON.stringify(r));
  for (const r of nonRetryable) assert.equal(isRetryableOpenapiFailure(r), false, JSON.stringify(r));
  tests.push('retryable-classification');
}

// 7. jitter stays within +/-10% of the exponential delay.
{
  const timer = captureSetTimeout();
  try {
    let restore = stubRandom(0);
    await sleepWithJitter(1000);
    assert.equal(timer.calls.at(-1), 900);
    restore();
    restore = stubRandom(1);
    await sleepWithJitter(1000);
    assert.equal(timer.calls.at(-1), 1100);
    restore();
    restore = stubRandom(0.5);
    await sleepWithJitter(1000);
    assert.equal(timer.calls.at(-1), 1000);
    restore();
  } finally {
    timer.restore();
  }
  tests.push('jitter-bounds');
}

// 8. defaults: at most 3 attempts by default; flags and clamping work.
{
  const savedAttempts = process.env.SHEIN_OPENAPI_PRODUCT_STOCK_RETRY_ATTEMPTS;
  const savedBase = process.env.SHEIN_OPENAPI_PRODUCT_STOCK_RETRY_BASE_DELAY_MS;
  delete process.env.SHEIN_OPENAPI_PRODUCT_STOCK_RETRY_ATTEMPTS;
  delete process.env.SHEIN_OPENAPI_PRODUCT_STOCK_RETRY_BASE_DELAY_MS;
  try {
    assert.equal(parseArgs(['HL']).stockRetryAttempts, 3);
    assert.equal(parseArgs(['HL']).stockRetryBaseDelayMs, 1200);
    const tuned = parseArgs(['HL', '--stock-retry-attempts', '2', '--stock-retry-base-delay-ms', '500']);
    assert.equal(tuned.stockRetryAttempts, 2);
    assert.equal(tuned.stockRetryBaseDelayMs, 500);
    const clamped = parseArgs(['HL', '--stock-retry-attempts', '99', '--stock-retry-base-delay-ms', '10']);
    assert.equal(clamped.stockRetryAttempts, 6);
    assert.equal(clamped.stockRetryBaseDelayMs, 250);
  } finally {
    if (savedAttempts === undefined) delete process.env.SHEIN_OPENAPI_PRODUCT_STOCK_RETRY_ATTEMPTS;
    else process.env.SHEIN_OPENAPI_PRODUCT_STOCK_RETRY_ATTEMPTS = savedAttempts;
    if (savedBase === undefined) delete process.env.SHEIN_OPENAPI_PRODUCT_STOCK_RETRY_BASE_DELAY_MS;
    else process.env.SHEIN_OPENAPI_PRODUCT_STOCK_RETRY_BASE_DELAY_MS = savedBase;
  }
  tests.push('parse-args-defaults-and-flags');
}

// 9. skipped or empty stock input short-circuits without any request.
{
  let calls = 0;
  const client = {async request() { calls += 1; return okResponse; }};
  assert.deepEqual(await fetchStock(client, [], baseArgs), []);
  assert.deepEqual(await fetchStock(client, ['S1'], {...baseArgs, skipStock: true}), []);
  assert.equal(calls, 0);
  tests.push('skip-or-empty');
}

console.log(JSON.stringify({ok: true, tests}, null, 2));
