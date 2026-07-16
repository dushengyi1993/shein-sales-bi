#!/usr/bin/env node
import assert from 'node:assert/strict';
import {SheinOpenApiClient} from '../lib/shein_openapi_client.mjs';

let observedSignal = null;
const fetchImpl = async (_url, init) => {
  observedSignal = init.signal || null;
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => await new Promise((resolve, reject) => {
      if (!init.signal) return resolve('{}');
      if (init.signal.aborted) return reject(new Error('aborted before body read'));
      init.signal.addEventListener('abort', () => reject(new Error('body read aborted')), {once: true});
    }),
  };
};

const client = new SheinOpenApiClient({
  baseUrl: 'http://127.0.0.1:9',
  openKeyId: 'test-open-key',
  secretKey: 'test-secret-key',
  fetchImpl,
  timeoutMs: 25,
});

const startedAt = Date.now();
await assert.rejects(
  client.request('/open-api/test/body-stall', {method: 'POST', body: {test: true}}),
  /timed out after 25ms.*body-stall/,
);
const elapsedMs = Date.now() - startedAt;
assert.ok(observedSignal, 'timeout-enabled request must pass an AbortSignal');
assert.equal(observedSignal.aborted, true, 'signal must abort while the response body is stalled');
assert.ok(elapsedMs < 1000, `timeout must fail promptly, elapsed=${elapsedMs}ms`);

console.log(JSON.stringify({ok: true, test: 'openapi_timeout_covers_response_body', elapsedMs}));
