#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireBrowserTaskLease,
  assessBrowserLease,
  browserLeasePath,
  heartbeatBrowserTaskLease,
  readBrowserLeases,
  reclaimStaleBrowserLeases,
  releaseBrowserTaskLease,
} from '../lib/browser_task_lease.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shein-browser-lease-smoke-'));
const hostname = 'lease-smoke-host';
const base = {root, task: 'marketing-live-guard', storeKey: 'DX', runId: 'run-a', hostname, ownerPid: process.pid, ttlSec: 60, nowMs: 1_000};
try {
  const acquired = acquireBrowserTaskLease(base);
  assert.equal(acquired.lease.storeKey, 'DX');
  assert.equal(readBrowserLeases({root, nowMs: 2_000, hostname}).at(0).valid, true);
  assert.throws(() => acquireBrowserTaskLease({...base, runId: 'run-b', nowMs: 2_000}), {code: 'LEASE_ACTIVE'});
  const renewed = heartbeatBrowserTaskLease({...base, nowMs: 10_000, ttlSec: 120});
  assert.equal(renewed.lease.heartbeatAt, new Date(10_000).toISOString());
  assert.equal(assessBrowserLease(renewed.lease, {nowMs: 200_000, hostname}).reason, 'expired');
  assert.equal(reclaimStaleBrowserLeases({root, nowMs: 200_000, hostname}).at(0).reason, 'expired');

  acquireBrowserTaskLease({...base, storeKey: 'TS', runId: 'dead-owner', ownerPid: 999_999, nowMs: 1_000});
  assert.equal(readBrowserLeases({root, nowMs: 2_000, hostname, isPidAlive: () => false}).at(0).reason, 'owner_dead');
  assert.equal(reclaimStaleBrowserLeases({root, nowMs: 2_000, hostname, isPidAlive: () => false}).at(0).reason, 'owner_dead');

  acquireBrowserTaskLease({...base, storeKey: 'JSH', runId: 'run-c'});
  assert.deepEqual(releaseBrowserTaskLease({...base, storeKey: 'JSH', runId: 'wrong'}), {released: false, reason: 'not_owner'});
  assert.equal(releaseBrowserTaskLease({...base, storeKey: 'JSH', runId: 'run-c'}).released, true);
  assert.equal(fs.existsSync(browserLeasePath({...base, storeKey: 'JSH'})), false);

  const longBase = {...base, storeKey: 'YJ', runId: 'six-hour-owner', ttlSec: 3000, nowMs: 1_000};
  acquireBrowserTaskLease(longBase);
  heartbeatBrowserTaskLease({...longBase, nowMs: 2_701_000});
  assert.throws(() => acquireBrowserTaskLease({...longBase, runId: 'run-after-3001s', nowMs: 3_002_000}),
    {code: 'LEASE_ACTIVE'}, 'a live heartbeating owner must not be reclaimed after the original 3000s TTL');
  for (let nowMs = 3_001_000; nowMs <= 21_601_000; nowMs += 300_000) {
    heartbeatBrowserTaskLease({...longBase, nowMs});
  }
  assert.throws(() => acquireBrowserTaskLease({...longBase, runId: 'second-six-hour-owner', nowMs: 21_602_000}),
    {code: 'LEASE_ACTIVE'}, 'the managed 300s heartbeat must cover the legal six-hour run contract');
  assert.equal(releaseBrowserTaskLease(longBase).released, true);
  console.log('browser task lease smoke: ok');
} finally {
  fs.rmSync(root, {recursive: true, force: true});
}
