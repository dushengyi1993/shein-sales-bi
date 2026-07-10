#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  PORTAL_SECURITY_HEADERS,
  createLoginRateLimiter,
  createSerialMutationQueue,
  loginRateKey,
  mutationOriginAllowed,
} from '../lib/portal_security.mjs';

assert.match(PORTAL_SECURITY_HEADERS['Content-Security-Policy'], /frame-ancestors 'self'/);
assert.equal(PORTAL_SECURITY_HEADERS['X-Frame-Options'], 'SAMEORIGIN');
assert.equal(PORTAL_SECURITY_HEADERS['Strict-Transport-Security'], 'max-age=31536000');

const sameOriginRequest = {
  method: 'POST',
  headers: {host: 'sa.dushengyi.cc', origin: 'https://sa.dushengyi.cc', 'x-forwarded-proto': 'https'},
  socket: {remoteAddress: '127.0.0.1'},
};
assert.equal(mutationOriginAllowed(sameOriginRequest), true);
assert.equal(mutationOriginAllowed({...sameOriginRequest, headers: {...sameOriginRequest.headers, origin: 'https://evil.example'}}), false);
assert.equal(mutationOriginAllowed({...sameOriginRequest, headers: {...sameOriginRequest.headers, origin: undefined, 'sec-fetch-site': 'cross-site'}}), false);
assert.equal(mutationOriginAllowed({...sameOriginRequest, method: 'GET'}), true);

let nowMs = 1_000;
const limiter = createLoginRateLimiter({limit: 3, windowMs: 1_000, lockMs: 5_000, now: () => nowMs});
const key = loginRateKey({...sameOriginRequest, headers: {...sameOriginRequest.headers, 'x-forwarded-for': '203.0.113.8'}}, 'Admin');
assert.equal(limiter.inspect(key).allowed, true);
assert.equal(limiter.fail(key).allowed, true);
assert.equal(limiter.fail(key).allowed, true);
assert.equal(limiter.fail(key).allowed, false);
nowMs += 5_001;
assert.equal(limiter.inspect(key).allowed, true);
limiter.success(key);
assert.equal(limiter.size(), 0);

const enqueue = createSerialMutationQueue();
const order = [];
await Promise.all([
  enqueue(async () => { order.push('a:start'); await new Promise(resolve => setTimeout(resolve, 20)); order.push('a:end'); }),
  enqueue(async () => { order.push('b:start'); order.push('b:end'); }),
]);
assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end']);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverSource = fs.readFileSync(path.join(root, 'scripts', 'serve_bi_portal.mjs'), 'utf8');
assert.match(serverSource, /const esc = value =>/);
assert.match(serverSource, /sameOriginUrl\(s\.openUrl\)/);
assert.doesNotMatch(serverSource, /data-token=/);
assert.match(serverSource, /filter\(session => !authRequired \|\| actorCanWriteStores/);
assert.match(serverSource, /handleManualLoginWsUpgrade\(req, socket, args, \{authRequired, authUsers, sessionSecret\}\)/);

console.log('portal_security: headers, origin guard, login limiter, and mutation queue checks passed');
