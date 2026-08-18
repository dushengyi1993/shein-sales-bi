#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  biQueryRequestTimeoutMs,
  isBusyBiQueryError,
  isIncompleteBiQueryError,
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
  now: () => clock,
  sleep: async ms => { clock += ms; },
});
assert.deepEqual(busyThenSuccess.value, {ok: true});
assert.equal(busyThenSuccess.attempts, 2);
assert.equal(busyThenSuccess.waitedMs, 2_000);

clock = 0;
await assert.rejects(
  () => runBiQueryWithWait(async () => {
    const error = new Error('still warming');
    error.status = 503;
    error.response = {code: 'BI_QUERY_DATA_INCOMPLETE'};
    throw error;
  }, {
    waitSeconds: 1,
    intervalMs: 1_000,
    now: () => clock,
    sleep: async ms => { clock += ms; },
  }),
  error => error.queryAttempts === 2 && error.queryWaitedMs === 1_000,
);

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

console.log(JSON.stringify({ok: true, checks: ['bounded_retry', 'busy_retry_after', 'deadline_abort', 'timeout_retry', 'section_timeout_budget', 'non_target_503', 'non_retryable_error']}, null, 2));
