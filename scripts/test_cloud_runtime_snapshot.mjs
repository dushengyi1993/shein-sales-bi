#!/usr/bin/env node
import assert from 'node:assert/strict';

import {buildCloudRuntimeSnapshot} from '../lib/cloud_runtime_snapshot.mjs';
import {CLOUD_ALWAYS_RUNNING_UNITS, CLOUD_RUNTIME_UNITS, CLOUD_TIMER_UNITS} from '../lib/cloud_runtime_inventory.mjs';

function healthyUnits() {
  return Object.fromEntries(CLOUD_RUNTIME_UNITS.map(name => [name, {
    name,
    ok: true,
    complete: true,
    LoadState: 'loaded',
    ActiveState: name.endsWith('.timer') || CLOUD_ALWAYS_RUNNING_UNITS.includes(name) ? 'active' : 'inactive',
    SubState: name.endsWith('.timer') ? 'waiting' : 'dead',
    Result: 'success',
    ...(name.endsWith('.service') ? {NRestarts: '0'} : {}),
  }]));
}

const base = {
  generatedAt: '2026-08-11T12:00:00.000Z',
  releaseSourceState: {
    ok: true,
    head: 'abc123',
    expectedCommit: 'abc123',
    commitMatches: true,
    dirtyEntries: [],
    hiddenIndexEntries: [],
    missingTrackedFiles: [],
    trackedFileCount: 1121,
  },
  deployedRelease: {tag: '2026.08.11.5', commit: 'abc123', recordedAt: '2026-08-11T11:59:00Z'},
  systemdSnapshot: {commandCount: 1, requested: CLOUD_RUNTIME_UNITS, units: healthyUnits()},
  portalHealth: {httpStatus: 200, ok: true, coreWarmupStatus: 'done', liveUpdatesConnected: true},
  webhookHealth: {httpStatus: 200, ok: true},
};

const healthy = buildCloudRuntimeSnapshot(base);
assert.equal(healthy.ok, true);
assert.equal(healthy.runtimeProbe.systemctlCommandCount, 1);
assert.equal(healthy.runtimeProbe.requestedUnitCount, CLOUD_RUNTIME_UNITS.length);
assert.equal(healthy.runtimeProbe.inactiveTimers.length, 0);
assert.equal(healthy.runtimeProbe.restartedAlwaysRunning.length, 0);

const brokenUnits = healthyUnits();
brokenUnits[CLOUD_ALWAYS_RUNNING_UNITS[0]].ActiveState = 'inactive';
brokenUnits[CLOUD_TIMER_UNITS[0]].ActiveState = 'inactive';
const broken = buildCloudRuntimeSnapshot({
  ...base,
  releaseSourceState: {...base.releaseSourceState, ok: false, commitMatches: false},
  systemdSnapshot: {...base.systemdSnapshot, units: brokenUnits},
  portalHealth: {httpStatus: 503, ok: false},
});
assert.equal(broken.ok, false);
assert.ok(broken.blockers.some(row => row.code === 'RELEASE_SOURCE_NOT_CLEAN'));
assert.ok(broken.blockers.some(row => row.code === 'REQUIRED_SERVICE_INACTIVE'));
assert.ok(broken.blockers.some(row => row.code === 'SCHEDULE_TIMER_INACTIVE'));
assert.ok(broken.blockers.some(row => row.code === 'PORTAL_HEALTH_FAILED'));

const flappingUnits = healthyUnits();
flappingUnits[CLOUD_ALWAYS_RUNNING_UNITS[0]].NRestarts = '3';
const flapping = buildCloudRuntimeSnapshot({
  ...base,
  systemdSnapshot: {...base.systemdSnapshot, units: flappingUnits},
});
assert.equal(flapping.ok, false);
assert.deepEqual(flapping.runtimeProbe.restartedAlwaysRunning, [{name: CLOUD_ALWAYS_RUNNING_UNITS[0], restarts: 3}]);
assert.ok(flapping.blockers.some(row => row.code === 'REQUIRED_SERVICE_RESTARTED'));

console.log(JSON.stringify({ok: true, checks: ['healthy_snapshot', 'source_drift', 'service_and_timer_health', 'restart_loop', 'endpoint_health']}, null, 2));
