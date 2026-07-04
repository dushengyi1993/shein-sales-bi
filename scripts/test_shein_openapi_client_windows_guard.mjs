#!/usr/bin/env node
/**
 * Bottom-level OpenAPI network guard.
 *
 * This is a pure local test: it does not call SHEIN. It verifies that the shared
 * client model treats official SHEIN OpenAPI hosts as forbidden from Windows
 * local runtime, while leaving fake localhost tests and cloud/Linux runtime
 * unaffected.
 */
import assert from 'node:assert/strict';
import {
  assertRealOpenApiAllowedForRuntime,
  isRealSheinOpenApiBaseUrl,
  SHEIN_OPENAPI_BASE_URLS,
} from '../lib/shein_openapi_client.mjs';

assert.equal(isRealSheinOpenApiBaseUrl(SHEIN_OPENAPI_BASE_URLS.prodSemiManaged), true);
assert.equal(isRealSheinOpenApiBaseUrl(SHEIN_OPENAPI_BASE_URLS.test), true);
assert.equal(isRealSheinOpenApiBaseUrl('https://openapi-sem.sheincorp.com'), true);
assert.equal(isRealSheinOpenApiBaseUrl('https://foo.openapi.sheincorp.com'), true);
assert.equal(isRealSheinOpenApiBaseUrl('http://127.0.0.1:18080'), false);
assert.equal(isRealSheinOpenApiBaseUrl('http://localhost:18080'), false);

assert.throws(
  () => assertRealOpenApiAllowedForRuntime(SHEIN_OPENAPI_BASE_URLS.prodSemiManaged, {platform: 'win32'}),
  /Local Windows\/Codex cannot call real SHEIN OpenAPI/,
);
assert.throws(
  () => assertRealOpenApiAllowedForRuntime(SHEIN_OPENAPI_BASE_URLS.test, {platform: 'win32'}),
  /outside the whitelist boundary/,
);
assert.doesNotThrow(
  () => assertRealOpenApiAllowedForRuntime(SHEIN_OPENAPI_BASE_URLS.prodSemiManaged, {platform: 'linux'}),
);
assert.doesNotThrow(
  () => assertRealOpenApiAllowedForRuntime('http://127.0.0.1:18080', {platform: 'win32'}),
);

console.log(JSON.stringify({
  ok: true,
  checked: [
    'official prod/test hosts are recognized as real SHEIN OpenAPI',
    'Windows local runtime is blocked before network calls',
    'fake localhost and cloud/Linux runtime remain allowed',
  ],
}, null, 2));
