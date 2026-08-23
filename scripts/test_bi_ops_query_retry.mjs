#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  biQueryRequestTimeoutMs,
  fetchWithIdempotentNetworkRetry,
  isBusyBiQueryError,
  isIncompleteBiQueryError,
  isTransientFetchNetworkError,
  runBiQueryWithWait,
} from '../lib/bi_ops_query_retry.mjs';

assert.equal(biQueryRequestTimeoutMs(['linksData'], {}), 60_000);
assert.equal(biQueryRequestTimeoutMs(['orders'], {}), 30_000);
assert.equal(biQueryRequestTimeoutMs(['linksData'], {SHEIN_BI_QUERY_REQUEST_TIMEOUT_MS: '45000'}), 45_000);

assert.equal(isIncompleteBiQueryError({status: 503}), false);
assert.equal(isIncompleteBiQueryError({response: {code: 'BI_QUERY_DATA_INCOMPLETE'}}), true);
assert.equal(isIncompleteBiQueryError({status: 503, response: {code: 'UPSTREAM_UNAVAILABLE'}}), false);
assert.equal(isIncompleteBiQueryError({status: 401}), false);
assert.equal(isBusyBiQueryError({status: 429, response: {code: 'QUERY_SURFACE_BUSY'}}), true);
assert.equal(isBusyBiQueryError({status: 503, response: {code: 'QUERY_SURFACE_BUSY'}}), false);

let clock = 0;
let attempts = 0;
const completed = await runBiQueryWithWait(async () => {
  attempts += 1;
  if (attempts < 3) {
    const error = new Error('warming');
    error.status = 503;
    error.response = {code: 'BI_QUERY_DATA_INCOMPLETE'};
    throw error;
  }
  return {ok: true};
}, {
  waitSeconds: 5,
  intervalMs: 1_000,
  requestTimeoutMs: 1_000,
  now: () => clock,
  sleep: async ms => { clock += ms; },
});
assert.deepEqual(completed.value, {ok: true});
assert.equal(completed.attempts, 3);
assert.equal(completed.waitedMs, 2_000);

clock = 0;
let busyAttempts = 0;
const busyThenSuccess = await runBiQueryWithWait(async () => {
  busyAttempts += 1;
  if (busyAttempts === 1) {
    const error = new Error('query lane busy');
    error.status = 429;
    error.retryAfterMs = 2_000;
    error.response = {code: 'QUERY_SURFACE_BUSY'};
    throw error;
  }
  return {ok: true};
}, {
  waitSeconds: 5,
  intervalMs: 1_000,
  requestTimeoutMs: 1_000,
  now: () => clock,
  sleep: async ms => { clock += ms; },
});
assert.deepEqual(busyThenSuccess.value, {ok: true});
assert.equal(busyThenSuccess.attempts, 2);
assert.equal(busyThenSuccess.waitedMs, 2_000);

clock = 0;
let lateAttempts = 0;
const lateRequestTimeouts = [];
const finalIncompleteResponse = {
  code: 'BI_QUERY_DATA_INCOMPLETE',
  sections: {issues: [{section: 'linksData', reason: 'still warming'}]},
};
await assert.rejects(
  () => runBiQueryWithWait(async ({timeoutMs}) => {
    lateAttempts += 1;
    lateRequestTimeouts.push(timeoutMs);
    if (lateAttempts === 1) {
      clock = 297;
      const error = new Error('warming');
      error.status = 503;
      error.response = {code: 'BI_QUERY_DATA_INCOMPLETE'};
      throw error;
    }
    clock = 4_297;
    const error = new Error('final incomplete');
    error.status = 503;
    error.response = finalIncompleteResponse;
    throw error;
  }, {
    waitSeconds: 5,
    intervalMs: 1_000,
    requestTimeoutMs: 3_000,
    now: () => clock,
    sleep: async ms => { clock += ms; },
  }),
  error => {
    assert.equal(error.code, undefined);
    assert.equal(error.response, finalIncompleteResponse);
    assert.deepEqual(error.response.sections.issues, finalIncompleteResponse.sections.issues);
    assert.equal(error.queryAttempts, 2);
    assert.equal(error.queryWaitedMs, 4_297);
    assert.doesNotMatch(error.message, /after 703ms/);
    return true;
  },
);
assert.equal(lateAttempts, 2);
assert.deepEqual(lateRequestTimeouts, [3_000, 3_000]);

let timeoutRetryAttempts = 0;
const timeoutThenSuccess = await runBiQueryWithWait(({signal}) => new Promise((resolve, reject) => {
  timeoutRetryAttempts += 1;
  if (timeoutRetryAttempts === 1) {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'})), {once: true});
    return;
  }
  resolve({ok: true});
}), {
  waitSeconds: 1,
  requestTimeoutMs: 25,
  intervalMs: 10,
  retryRequestTimeout: true,
});
assert.deepEqual(timeoutThenSuccess.value, {ok: true});
assert.equal(timeoutThenSuccess.attempts, 2);

let nonRetryAttempts = 0;
await assert.rejects(
  () => runBiQueryWithWait(async () => {
    nonRetryAttempts += 1;
    const error = new Error('unauthorized');
    error.status = 401;
    throw error;
  }, {waitSeconds: 30}),
  error => error.queryAttempts === 1,
);
assert.equal(nonRetryAttempts, 1);

let upstreamAttempts = 0;
await assert.rejects(
  () => runBiQueryWithWait(async () => {
    upstreamAttempts += 1;
    const error = new Error('upstream unavailable');
    error.status = 503;
    error.response = {code: 'UPSTREAM_UNAVAILABLE'};
    throw error;
  }, {waitSeconds: 30}),
  error => error.queryAttempts === 1 && error.response?.code === 'UPSTREAM_UNAVAILABLE',
);
assert.equal(upstreamAttempts, 1);

await assert.rejects(
  () => runBiQueryWithWait(({signal}) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'})), {once: true});
  }), {waitSeconds: 0, requestTimeoutMs: 25}),
  error => error.code === 'BI_QUERY_REQUEST_TIMEOUT' && error.queryAttempts === 1,
);

function resetError() {
  return new TypeError('fetch failed', {cause: Object.assign(new Error('socket reset before TLS'), {code: 'ECONNRESET'})});
}

function expiredCertificateError() {
  return new TypeError('fetch failed', {cause: Object.assign(new Error('certificate expired'), {code: 'CERT_HAS_EXPIRED'})});
}

assert.equal(isTransientFetchNetworkError(resetError()), true);
assert.equal(isTransientFetchNetworkError(expiredCertificateError()), false);

let certificateAttempts = 0;
const certificateError = expiredCertificateError();
await assert.rejects(
  () => fetchWithIdempotentNetworkRetry(async () => {
    certificateAttempts += 1;
    throw certificateError;
  }, 'https://example.test/read', {method: 'GET'}, {maxAttempts: 4, delaysMs: [0], sleep: async () => {}}),
  error => error === certificateError,
);
assert.equal(certificateAttempts, 1);

let requestPostAttempts = 0;
const requestPostError = resetError();
const requestPost = new Request('https://example.test/read', {method: 'POST'});
await assert.rejects(
  () => fetchWithIdempotentNetworkRetry(async () => {
    requestPostAttempts += 1;
    throw requestPostError;
  }, requestPost, {}, {maxAttempts: 4, delaysMs: [0], sleep: async () => {}}),
  error => error === requestPostError,
);
assert.equal(requestPostAttempts, 1);

let requestOverrideAttempts = 0;
const requestOverrideResponse = await fetchWithIdempotentNetworkRetry(async () => {
  requestOverrideAttempts += 1;
  if (requestOverrideAttempts < 3) throw resetError();
  return new Response('{"ok":true}', {status: 200});
}, requestPost, {method: 'GET'}, {maxAttempts: 4, delaysMs: [0], sleep: async () => {}});
assert.equal(requestOverrideResponse.status, 200);
assert.equal(requestOverrideAttempts, 3);

let idempotentAttempts = 0;
const idempotentDelays = [];
const idempotentResponse = await fetchWithIdempotentNetworkRetry(async () => {
  idempotentAttempts += 1;
  if (idempotentAttempts < 3) throw resetError();
  return new Response('{"ok":true}', {status: 200, headers: {'content-type': 'application/json'}});
}, 'https://example.test/read', {method: 'GET'}, {
  maxAttempts: 4,
  delaysMs: [1, 2, 3],
  sleep: async ms => { idempotentDelays.push(ms); },
});
assert.equal(idempotentResponse.status, 200);
assert.equal(idempotentAttempts, 3);
assert.deepEqual(idempotentDelays, [1, 2]);

let transientStatusAttempts = 0;
let transientBodyCancelled = false;
const transientStatusResponse = await fetchWithIdempotentNetworkRetry(async () => {
  transientStatusAttempts += 1;
  if (transientStatusAttempts === 1) {
    return {
      status: 502,
      headers: new Headers(),
      body: {cancel: async () => { transientBodyCancelled = true; }},
    };
  }
  return new Response('{"ok":true}', {status: 200});
}, 'https://example.test/read', {}, {delaysMs: [0], sleep: async () => {}});
assert.equal(transientStatusResponse.status, 200);
assert.equal(transientStatusAttempts, 2);
assert.equal(transientBodyCancelled, true);

let writeAttempts = 0;
const writeError = resetError();
await assert.rejects(
  () => fetchWithIdempotentNetworkRetry(async () => {
    writeAttempts += 1;
    throw writeError;
  }, 'https://example.test/write', {method: 'POST', body: '{}'}, {maxAttempts: 4, sleep: async () => {}}),
  error => error === writeError,
);
assert.equal(writeAttempts, 1);

let exhaustedAttempts = 0;
await assert.rejects(
  () => fetchWithIdempotentNetworkRetry(async () => {
    exhaustedAttempts += 1;
    throw resetError();
  }, 'https://example.test/read', {}, {maxAttempts: 3, delaysMs: [0], sleep: async () => {}}),
  error => error.code === 'BI_TRANSIENT_NETWORK_RETRY_EXHAUSTED'
    && error.attempts === 3
    && error.cause?.cause?.code === 'ECONNRESET'
    && /已尝试 3 次/.test(error.message),
);
assert.equal(exhaustedAttempts, 3);

console.log(JSON.stringify({ok: true, checks: ['bounded_retry', 'busy_retry_after', 'retryable_error_boundary', 'timeout_retry', 'section_timeout_budget', 'non_target_503', 'non_retryable_error', 'idempotent_network_retry', 'transient_status_retry', 'non_idempotent_single_attempt', 'humanized_retry_exhaustion']}, null, 2));
