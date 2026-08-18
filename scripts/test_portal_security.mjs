#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  PORTAL_SECURITY_HEADERS,
  createLoginRateLimiter,
  createSerialMutationQueue,
  MUTATION_QUEUE_REJECTIONS,
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

// Bounded serial mutation queue.
// capacity+1 counterexample: one running task plus capacity queued tasks are
// admitted; the next admission is saturated (portal maps this to 429).
{
  const bounded = createSerialMutationQueue({capacity: 1, deadlineMs: 5_000});
  const ran = [];
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const first = bounded(async () => { ran.push('first'); await firstGate; return 'first'; });
  await new Promise(resolve => setTimeout(resolve, 5));
  const second = bounded(async () => ran.push('second'));
  const third = await bounded(async () => ran.push('third')).then(
    () => ({rejected: false}),
    error => ({rejected: true, reason: error.reason, code: error.code}),
  );
  assert.equal(third.rejected, true, 'the capacity+1 mutation must be saturated');
  assert.equal(third.reason, 'saturated');
  assert.equal(third.code, MUTATION_QUEUE_REJECTIONS.SATURATED);
  releaseFirst();
  await first;
  await second;
  assert.deepEqual(ran, ['first', 'second']);
  assert.equal(bounded.status().rejected.saturated, 1);
}

// Queue deadline: a queued item that does not start before its deadline is
// dropped with deadline-exceeded; the running item is never killed by it.
{
  const bounded = createSerialMutationQueue({capacity: 4, deadlineMs: 60_000});
  const ran = [];
  let releaseBlocking;
  const blockingGate = new Promise(resolve => { releaseBlocking = resolve; });
  const blocking = bounded(async () => { ran.push('blocking'); await blockingGate; });
  await new Promise(resolve => setTimeout(resolve, 5));
  const queued = await bounded(async () => ran.push('never'), {deadlineMs: 30}).then(
    () => ({rejected: false}),
    error => ({rejected: true, reason: error.reason, code: error.code}),
  );
  assert.equal(queued.rejected, true, 'a queued item past its deadline must be dropped');
  assert.equal(queued.reason, 'deadline-exceeded');
  assert.equal(queued.code, MUTATION_QUEUE_REJECTIONS.DEADLINE_EXCEEDED);
  releaseBlocking();
  await blocking;
  assert.deepEqual(ran, ['blocking']);
}

// Shutdown cancels queued-but-not-started work (portal maps to 503), refuses
// new admissions, and drains the running task exactly once; a started task is
// never re-run (committed writes are not automatically retried).
{
  const bounded = createSerialMutationQueue({capacity: 4, deadlineMs: 60_000});
  const events = [];
  let releaseRunning;
  const runningGate = new Promise(resolve => { releaseRunning = resolve; });
  const running = bounded(async () => { events.push('run:start'); await runningGate; events.push('run:end'); return 'committed'; });
  await new Promise(resolve => setTimeout(resolve, 5));
  const queued = bounded(async () => events.push('queued:never'));
  const drain = bounded.shutdown();
  const queuedResult = await queued.then(
    () => ({rejected: false}),
    error => ({rejected: true, reason: error.reason, code: error.code}),
  );
  assert.equal(queuedResult.rejected, true, 'a queued task must be cancelled on shutdown');
  assert.equal(queuedResult.reason, 'shutdown');
  assert.equal(queuedResult.code, MUTATION_QUEUE_REJECTIONS.SHUTDOWN);
  const afterShutdown = await bounded(async () => events.push('after:never')).then(
    () => ({rejected: false}),
    error => ({rejected: true, reason: error.reason, code: error.code}),
  );
  assert.equal(afterShutdown.rejected, true, 'new admissions must be refused after shutdown');
  assert.equal(afterShutdown.reason, 'shutdown');
  releaseRunning();
  await drain;
  assert.equal(await running, 'committed');
  assert.deepEqual(events, ['run:start', 'run:end']);
  assert.equal(bounded.status().started, 1);
  assert.equal(bounded.status().completed, 1);
}

// No auto-retry: a started task runs exactly once even when it throws; a task
// rejected before start is never executed.
{
  let runs = 0;
  const bounded = createSerialMutationQueue({capacity: 2, deadlineMs: 1_000});
  await assert.rejects(bounded(async () => { runs += 1; throw new Error('committed-but-failed'); }), /committed-but-failed/);
  assert.equal(runs, 1, 'a started task must not be retried');
  assert.equal(await bounded(async () => { runs += 1; return 'ok'; }), 'ok');
  assert.equal(runs, 2);
}

// Per-actor bound: queued work per actor is limited independently of the
// global capacity.
{
  const bounded = createSerialMutationQueue({capacity: 10, perActorCapacity: 1, deadlineMs: 2_000});
  let releaseActor;
  const actorGate = new Promise(resolve => { releaseActor = resolve; });
  const runningActor = bounded(async () => { await actorGate; return 'a'; }, {actor: 'u1'});
  await new Promise(resolve => setTimeout(resolve, 5));
  const firstQueued = bounded(async () => 'b', {actor: 'u1'});
  const secondActor = await bounded(async () => 'c', {actor: 'u1'}).then(
    () => ({rejected: false}),
    error => ({rejected: true, reason: error.reason}),
  );
  assert.equal(secondActor.rejected, true, 'the second queued task for the same actor must be saturated');
  assert.equal(secondActor.reason, 'saturated');
  releaseActor();
  assert.equal(await firstQueued, 'b');
  await runningActor.catch(() => {});
}



const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverSource = fs.readFileSync(path.join(root, 'scripts', 'serve_bi_portal.mjs'), 'utf8');
const nginxSource = fs.readFileSync(path.join(root, 'infra', 'nginx', 'shein-bi.conf'), 'utf8');
const caddySource = fs.readFileSync(path.join(root, 'infra', 'caddy', 'Caddyfile.shein-bi'), 'utf8');
assert.match(serverSource, /const esc = value =>/);
assert.match(serverSource, /sameOriginUrl\(s\.openUrl\)/);
assert.doesNotMatch(serverSource, /data-token=/);
assert.match(serverSource, /filter\(session => !authRequired \|\| actorCanWriteStores/);
assert.match(serverSource, /handleManualLoginWsUpgrade\(req, socket, args, \{authRequired, authUsers, sessionSecret\}\)/);
assert.match(nginxSource, /server_name\s+sa\.dushengyi\.cc\b/);
assert.match(nginxSource, /proxy_set_header\s+X-Forwarded-Proto\s+\$http_x_forwarded_proto\s*;/);
assert.doesNotMatch(nginxSource, /proxy_set_header\s+X-Forwarded-Proto\s+\$scheme\s*;/);
assert.match(caddySource, /https:\/\/sa\.dushengyi\.cc:10443/);
assert.match(caddySource, /header_up\s+X-Forwarded-Proto\s+https/);

console.log('portal_security: headers, origin guard, login limiter, and mutation queue checks passed');
