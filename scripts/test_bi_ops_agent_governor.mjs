#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  BiOpsAgentGovernorError,
  createBiOpsAgentGovernor,
} from '../lib/bi_ops_agent_governor.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

{
  const governor = createBiOpsAgentGovernor({
    maxConcurrent: 2,
    maxConcurrentPerActor: 1,
    maxQueue: 8,
    maxQueuedPerActor: 4,
    rateLimit: 20,
    queueTimeoutMs: 2_000,
  });
  let active = 0;
  let peak = 0;
  const events = [];
  const task = (actor, id) => governor.run(actor, async () => {
    active += 1;
    peak = Math.max(peak, active);
    events.push(`${id}:start`);
    await sleep(25);
    events.push(`${id}:end`);
    active -= 1;
    return id;
  });
  assert.deepEqual(await Promise.all([
    task('alice', 'a1'),
    task('alice', 'a2'),
    task('bob', 'b1'),
  ]), ['a1', 'a2', 'b1']);
  assert.equal(peak, 2);
  assert.ok(events.indexOf('a1:end') < events.indexOf('a2:start'), 'same actor must stay serial');
  assert.equal(governor.snapshot().active, 0);
}

{
  const governor = createBiOpsAgentGovernor({
    maxConcurrent: 2,
    rateLimit: 20,
    queueTimeoutMs: 2_000,
  });
  const events = [];
  let releaseFast;
  const fast = governor.run('alice', () => new Promise(resolve => {
    events.push('fast:start');
    releaseFast = () => { events.push('fast:end'); resolve('fast'); };
  }), {tier: 'fast'});
  await sleep(5);
  const deep = governor.run('owner', async () => {
    events.push('deep:start');
    await sleep(10);
    events.push('deep:end');
    return 'deep';
  }, {tier: 'deep'});
  const laterFast = governor.run('bob', async () => {
    events.push('later:start');
    return 'later';
  }, {tier: 'fast'});
  await sleep(5);
  assert.equal(events.includes('deep:start'), false, 'deep waits for active fast request');
  assert.equal(events.includes('later:start'), false, 'requests behind queued deep cannot bypass it');
  releaseFast();
  assert.deepEqual(await Promise.all([fast, deep, laterFast]), ['fast', 'deep', 'later']);
  assert.ok(events.indexOf('fast:end') < events.indexOf('deep:start'));
  assert.ok(events.indexOf('deep:end') < events.indexOf('later:start'));
}

{
  let nowMs = 10_000;
  const governor = createBiOpsAgentGovernor({
    maxConcurrent: 1,
    rateLimit: 2,
    rateWindowMs: 1_000,
    now: () => nowMs,
  });
  await governor.run('alice', async () => 'one');
  await governor.run('alice', async () => 'two');
  await assert.rejects(
    governor.run('alice', async () => 'three'),
    error => error instanceof BiOpsAgentGovernorError && error.code === 'AGENT_RATE_LIMITED' && error.status === 429,
  );
  nowMs += 1_001;
  assert.equal(await governor.run('alice', async () => 'four'), 'four');
}

{
  let nowMs = 50_000;
  const governor = createBiOpsAgentGovernor({
    maxConcurrent: 1,
    failureThreshold: 2,
    failureWindowMs: 1_000,
    circuitCooldownMs: 5_000,
    rateLimit: 20,
    now: () => nowMs,
  });
  await assert.rejects(governor.run('alice', async () => { throw Object.assign(new Error('upstream 1'), {status: 503}); }), /upstream 1/);
  nowMs += 10;
  await assert.rejects(governor.run('bob', async () => { throw Object.assign(new Error('upstream 2'), {status: 503}); }), /upstream 2/);
  assert.equal(governor.snapshot().circuit.open, true);
  await assert.rejects(
    governor.run('carol', async () => 'blocked'),
    error => error instanceof BiOpsAgentGovernorError && error.code === 'AGENT_CIRCUIT_OPEN',
  );
  nowMs += 5_001;
  assert.equal(await governor.run('carol', async () => 'recovered'), 'recovered');
}

{
  const governor = createBiOpsAgentGovernor({
    maxConcurrent: 1,
    maxQueue: 1,
    maxQueuedPerActor: 1,
    rateLimit: 20,
    queueTimeoutMs: 2_000,
  });
  let release;
  const blocker = governor.run('alice', () => new Promise(resolve => { release = resolve; }));
  await sleep(5);
  const queued = governor.run('bob', async () => 'queued');
  await assert.rejects(
    governor.run('carol', async () => 'overflow'),
    error => error instanceof BiOpsAgentGovernorError && error.code === 'AGENT_QUEUE_FULL',
  );
  release('done');
  assert.equal(await blocker, 'done');
  assert.equal(await queued, 'queued');
}

console.log('bi_ops_agent_governor: concurrency, per-user serialization, rate limit, queue cap, and circuit breaker passed');
