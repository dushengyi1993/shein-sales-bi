#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  CLOUD_MAINTENANCE_ABSENT_HASH,
  CLOUD_MAINTENANCE_SCHEMA_VERSION,
  DEFAULT_CLOUD_MAINTENANCE_FILE,
} from '../lib/cloud_maintenance_mode.mjs';
import {buildCloudRuntimeSnapshot} from '../lib/cloud_runtime_snapshot.mjs';
import {
  DEPLOYED_RELEASE_SCHEMA_VERSION,
  DEPLOYED_RELEASE_SCHEMA_VERSION_V3,
} from '../lib/source_release_attestation.mjs';
import {
  CLOUD_ALWAYS_RUNNING_UNITS,
  CLOUD_EXPECTED_INSTALLED_UNITS,
  CLOUD_MAINTENANCE_POLICY_BY_SERVICE,
  CLOUD_RUNTIME_SNAPSHOT_UNITS,
  CLOUD_TIMER_MAINTENANCE_POLICY,
  CLOUD_TIMER_UNITS,
} from '../lib/cloud_runtime_inventory.mjs';
import {
  CLOUD_RUNTIME_PATH_POLICY_BY_SERVICE,
  cloudRuntimePathEffectiveDirectives,
} from '../lib/cloud_runtime_path_policy.mjs';

function healthyUnits() {
  return Object.fromEntries(CLOUD_RUNTIME_SNAPSHOT_UNITS.map(name => [name, {
    name,
    ok: true,
    complete: true,
    LoadState: 'loaded',
    ActiveState: name.endsWith('.timer') || CLOUD_ALWAYS_RUNNING_UNITS.includes(name) ? 'active' : 'inactive',
    SubState: name.endsWith('.timer') ? 'waiting' : 'dead',
    Result: 'success',
    ...(name.endsWith('.service') ? (() => {
      const directives = cloudRuntimePathEffectiveDirectives(name, CLOUD_RUNTIME_PATH_POLICY_BY_SERVICE[name]);
      const unitClass = CLOUD_MAINTENANCE_POLICY_BY_SERVICE[name];
      return {
        NRestarts: '0',
        ExecCondition: unitClass === 'always' ? '' : `/usr/bin/node /opt/shein-bi/app/scripts/manage_cloud_maintenance_mode.mjs systemd-condition --class ${unitClass} --unit ${name}`,
        RequiresMountsFor: directives.requiresMountsFor.join(' '),
        BindPaths: directives.bindPaths.join(' '),
        BindReadOnlyPaths: directives.bindReadOnlyPaths.join(' '),
        InaccessiblePaths: directives.inaccessiblePaths.join(' '),
        ReadOnlyPaths: directives.readOnlyPaths.join(' '),
      };
    })() : {}),
  }]));
}

function healthyMaintenance(overrides = {}) {
  return {
    schemaVersion: CLOUD_MAINTENANCE_SCHEMA_VERSION,
    ok: true,
    exists: false,
    active: false,
    mode: 'none',
    generation: 0,
    hash: CLOUD_MAINTENANCE_ABSENT_HASH,
    reason: '',
    requestedBy: '',
    startedAt: null,
    updatedAt: null,
    endedAt: null,
    markerFile: DEFAULT_CLOUD_MAINTENANCE_FILE,
    errorCode: '',
    issues: [],
    ...overrides,
  };
}

function unitFileComparison(overrides = {}) {
  return {
    ok: true,
    expected: [...CLOUD_EXPECTED_INSTALLED_UNITS].sort(),
    installed: [...CLOUD_EXPECTED_INSTALLED_UNITS].sort(),
    missing: [],
    unexpected: [],
    unknownState: [],
    allowedLegacyMasked: [],
    ...overrides,
  };
}

const deployedCommit = 'a'.repeat(40);
const deployedV3Marker = {
  schemaVersion: DEPLOYED_RELEASE_SCHEMA_VERSION_V3,
  repository: 'example/shein-bi',
  repositoryId: 1228612468,
  tag: '2026.08.11.5',
  commit: deployedCommit,
  tagObject: 'b'.repeat(40),
  trustPolicy: {
    schemaVersion: 'shein-bi-source-release-trust-policy/v1',
    sha256: 'e'.repeat(64),
    ciWorkflowPath: '.github/workflows/ci.yml',
    sourceWorkflowPath: '.github/workflows/source-release.yml',
  },
  releaseAttestation: {
    sha256: 'c'.repeat(64),
    checksumSha256: 'd'.repeat(64),
    schemaVersion: 3,
  },
  ci: {
    workflow: '.github/workflows/ci.yml',
    event: 'push',
    branch: 'main',
    runId: 123,
    runAttempt: 1,
    url: 'https://github.com/example/shein-bi/actions/runs/123',
    completedAt: '2026-08-11T11:30:00Z',
    jobCount: 2,
    jobsSha256: 'f'.repeat(64),
  },
  sourceWorkflow: {path: '.github/workflows/source-release.yml'},
  remoteEvidence: {
    verifiedAt: '2026-08-11T11:45:00Z',
    releaseId: 700,
    releaseUrl: 'https://github.com/example/shein-bi/releases/tag/2026.08.11.5',
    publishedAt: '2026-08-11T11:44:30Z',
    immutable: true,
    warnings: [],
    assets: [
      {name: 'release-attestation.json', id: 701, size: 210, digest: `sha256:${'c'.repeat(64)}`, bytesSha256: 'c'.repeat(64)},
      {name: 'release-attestation.json.sha256', id: 702, size: 91, digest: `sha256:${'d'.repeat(64)}`, bytesSha256: 'd'.repeat(64)},
    ],
  },
  sourceFingerprint: '0'.repeat(64),
  recordedAt: '2026-08-11T11:59:00Z',
};
const deployedV2Marker = {
  schemaVersion: DEPLOYED_RELEASE_SCHEMA_VERSION,
  repository: 'example/shein-bi',
  tag: '2026.08.11.5',
  commit: deployedCommit,
  tagObject: 'b'.repeat(40),
  releaseAttestation: {
    sha256: 'c'.repeat(64),
    checksumSha256: 'd'.repeat(64),
    schemaVersion: 2,
  },
  ci: {
    workflow: '.github/workflows/ci.yml',
    event: 'push',
    branch: 'main',
    runId: 123,
    runAttempt: 1,
    url: 'https://github.com/example/shein-bi/actions/runs/123',
    completedAt: '2026-08-11T11:30:00Z',
  },
  sourceWorkflow: {path: '.github/workflows/source-release.yml'},
  recordedAt: '2026-08-11T11:59:00Z',
};
const base = {
  generatedAt: '2026-08-11T12:00:00.000Z',
  releaseSourceState: {
    ok: true,
    head: deployedCommit,
    expectedCommit: deployedCommit,
    commitMatches: true,
    dirtyEntries: [],
    hiddenIndexEntries: [],
    missingTrackedFiles: [],
    trackedFileCount: 1121,
  },
  deployedRelease: deployedV3Marker,
  deploymentEvidence: {ok: true, issues: [], commit: deployedCommit},
  systemdSnapshot: {
    commandCount: 2,
    showCommandCount: 1,
    listUnitFilesCommandCount: 1,
    requested: CLOUD_RUNTIME_SNAPSHOT_UNITS,
    units: healthyUnits(),
    unitFileInventory: {complete: true, commandCode: 0},
    unitFileComparison: unitFileComparison(),
  },
  maintenanceStatus: healthyMaintenance(),
  maintenanceGuardAudit: {ok: true, policyCount: 27, unchanged: 27, issues: []},
  portalHealth: {httpStatus: 200, ok: true, coreWarmupStatus: 'done', liveUpdatesConnected: true},
  webhookHealth: {httpStatus: 200, ok: true},
  queryHealth: {
    httpStatus: 200,
    ok: true,
    surface: 'query',
    sideEffectsStartedIsArray: true,
    sideEffectsStarted: [],
  },
};

const healthy = buildCloudRuntimeSnapshot(base);
assert.equal(healthy.ok, true, JSON.stringify(healthy.blockers, null, 2));
assert.equal(healthy.runtimeProbe.systemctlCommandCount, 2);
assert.equal(healthy.runtimeProbe.requestedUnitCount, CLOUD_RUNTIME_SNAPSHOT_UNITS.length);
assert.equal(healthy.runtimeProbe.inactiveTimers.length, 0);
assert.equal(healthy.runtimeProbe.maintenanceInactiveTimers.length, 0);
assert.equal(healthy.runtimeProbe.restartedAlwaysRunning.length, 0);
assert.equal(healthy.unitFiles.expectedCount, CLOUD_EXPECTED_INSTALLED_UNITS.length);
assert.equal(healthy.maintenance.active, false);
assert.equal(healthy.deployedRelease.markerOk, true);
assert.equal(healthy.deployedRelease.attestationSha256, 'c'.repeat(64));
assert.deepEqual(CLOUD_ALWAYS_RUNNING_UNITS, [
  'shein-bi-portal.service',
  'shein-bi-webhook.service',
  'shein-bi-query.service',
]);
assert.deepEqual(healthy.health.query, {
  httpStatus: 200,
  ok: true,
  surface: 'query',
  sideEffectsStarted: [],
});

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

const legacyDeploymentMarker = buildCloudRuntimeSnapshot({
  ...base,
  deployedRelease: {schemaVersion: 'shein-bi-deployed-release/v1', tag: '2026.08.11.5', commit: deployedCommit},
});
assert.equal(legacyDeploymentMarker.ok, false);
assert.ok(legacyDeploymentMarker.blockers.some(row => row.code === 'DEPLOYMENT_MARKER_INVALID'));
const runtimeRejectsV2 = buildCloudRuntimeSnapshot({
  ...base,
  deployedRelease: deployedV2Marker,
});
assert.equal(runtimeRejectsV2.ok, false, 'runtime health must require a v3 deployment receipt');
assert.ok(runtimeRejectsV2.blockers.some(row => row.code === 'DEPLOYMENT_MARKER_INVALID'));
assert.deepEqual(
  runtimeRejectsV2.blockers.find(row => row.code === 'DEPLOYMENT_MARKER_INVALID').issues,
  ['schema_version_invalid'],
  'a well-formed legacy v2 marker must fail only on the schema requirement',
);

const unbackedDeploymentMarker = buildCloudRuntimeSnapshot({
  ...base,
  deploymentEvidence: {ok: false, issues: ['tagObject_evidence_mismatch'], commit: ''},
});
assert.equal(unbackedDeploymentMarker.ok, false);
assert.ok(unbackedDeploymentMarker.blockers.some(row => row.code === 'DEPLOYMENT_EVIDENCE_INVALID'));

const guardFileDrift = buildCloudRuntimeSnapshot({
  ...base,
  maintenanceGuardAudit: {ok: false, policyCount: 27, unchanged: 26, issues: [{service: 'shein-bi-cloud-yesterday.service', action: 'install'}]},
});
assert.equal(guardFileDrift.ok, false);
assert.ok(guardFileDrift.blockers.some(row => row.code === 'MAINTENANCE_GUARD_INSTALLATION_DRIFT'));

const namespaceUnits = healthyUnits();
namespaceUnits['shein-bi-query.service'].BindReadOnlyPaths = '';
const namespaceDrift = buildCloudRuntimeSnapshot({
  ...base,
  systemdSnapshot: {...base.systemdSnapshot, units: namespaceUnits},
});
assert.equal(namespaceDrift.ok, false);
assert.ok(namespaceDrift.blockers.some(row => row.code === 'RUNTIME_PATH_EFFECTIVE_ISOLATION_DRIFT'));

const readOnlyOmissionUnits = healthyUnits();
readOnlyOmissionUnits['shein-bi-query.service'].ReadOnlyPaths = '';
const readOnlyOmissionDrift = buildCloudRuntimeSnapshot({
  ...base,
  systemdSnapshot: {...base.systemdSnapshot, units: readOnlyOmissionUnits},
});
assert.equal(readOnlyOmissionDrift.ok, false);
assert.ok(readOnlyOmissionDrift.blockers.some(row => row.code === 'RUNTIME_PATH_EFFECTIVE_ISOLATION_DRIFT'));
assert.ok(readOnlyOmissionDrift.blockers.some(row => row.code === 'RUNTIME_PATH_EFFECTIVE_ISOLATION_DRIFT' && (row.issues || []).some(issue => issue.kind === 'runtime-path' && issue.property === 'ReadOnlyPaths')));

const readOnlyExtraUnits = healthyUnits();
readOnlyExtraUnits['shein-bi-query.service'].ReadOnlyPaths = '/data/shein-bi/state /data/shein-bi/outputs /data/shein-bi/profiles';
const readOnlyExtraDrift = buildCloudRuntimeSnapshot({
  ...base,
  systemdSnapshot: {...base.systemdSnapshot, units: readOnlyExtraUnits},
});
assert.equal(readOnlyExtraDrift.ok, false);
assert.ok(readOnlyExtraDrift.blockers.some(row => row.code === 'RUNTIME_PATH_EFFECTIVE_ISOLATION_DRIFT' && (row.issues || []).some(issue => issue.kind === 'runtime-path' && issue.property === 'ReadOnlyPaths')));

const effectiveGuardUnits = healthyUnits();
effectiveGuardUnits['shein-bi-cloud-yesterday.service'].ExecCondition = '';
const effectiveGuardDrift = buildCloudRuntimeSnapshot({
  ...base,
  systemdSnapshot: {...base.systemdSnapshot, units: effectiveGuardUnits},
});
assert.equal(effectiveGuardDrift.ok, false);
assert.ok(effectiveGuardDrift.blockers.some(row => row.code === 'MAINTENANCE_GUARD_EFFECTIVE_DRIFT'));

const extraEffectiveConditionUnits = healthyUnits();
const guardedService = 'shein-bi-cloud-yesterday.service';
const expectedCondition = extraEffectiveConditionUnits[guardedService].ExecCondition;
extraEffectiveConditionUnits[guardedService].ExecCondition = [
  `{ path=/usr/bin/node ; argv[]=${expectedCondition} ; ignore_errors=no }`,
  '{ path=/bin/false ; argv[]=/bin/false ; ignore_errors=no }',
].join(' ');
const extraEffectiveConditionDrift = buildCloudRuntimeSnapshot({
  ...base,
  systemdSnapshot: {...base.systemdSnapshot, units: extraEffectiveConditionUnits},
});
assert.equal(extraEffectiveConditionDrift.ok, false,
  'an additional ExecCondition must not be hidden by a matching guard substring');
assert.ok(extraEffectiveConditionDrift.blockers.some(row => row.code === 'MAINTENANCE_GUARD_EFFECTIVE_DRIFT'));

const queryWrongSurface = buildCloudRuntimeSnapshot({
  ...base,
  queryHealth: {...base.queryHealth, surface: 'portal'},
});
assert.equal(queryWrongSurface.ok, false);
assert.ok(queryWrongSurface.blockers.some(row => row.code === 'QUERY_HEALTH_FAILED'));
const queryStartedSideEffect = buildCloudRuntimeSnapshot({
  ...base,
  queryHealth: {...base.queryHealth, sideEffectsStarted: ['job-worker']},
});
assert.equal(queryStartedSideEffect.ok, false);
assert.ok(queryStartedSideEffect.blockers.some(row => row.code === 'QUERY_HEALTH_FAILED'));
const queryMissingSideEffectsArray = buildCloudRuntimeSnapshot({
  ...base,
  queryHealth: {...base.queryHealth, sideEffectsStartedIsArray: false, sideEffectsStarted: null},
});
assert.equal(queryMissingSideEffectsArray.ok, false);
assert.ok(queryMissingSideEffectsArray.blockers.some(row => row.code === 'QUERY_HEALTH_FAILED'));

const unexpectedUnit = buildCloudRuntimeSnapshot({
  ...base,
  systemdSnapshot: {
    ...base.systemdSnapshot,
    unitFileComparison: unitFileComparison({
      ok: false,
      installed: [...CLOUD_EXPECTED_INSTALLED_UNITS, 'shein-bi-unexpected.service'].sort(),
      unexpected: [{name: 'shein-bi-unexpected.service', state: 'enabled'}],
    }),
  },
});
assert.equal(unexpectedUnit.ok, false);
assert.ok(unexpectedUnit.blockers.some(row => row.code === 'SYSTEMD_UNEXPECTED_UNIT_INSTALLED'));

const flappingUnits = healthyUnits();
flappingUnits[CLOUD_ALWAYS_RUNNING_UNITS[0]].NRestarts = '3';
const flapping = buildCloudRuntimeSnapshot({
  ...base,
  systemdSnapshot: {...base.systemdSnapshot, units: flappingUnits},
});
assert.equal(flapping.ok, false);
assert.deepEqual(flapping.runtimeProbe.restartedAlwaysRunning, [{name: CLOUD_ALWAYS_RUNNING_UNITS[0], restarts: 3}]);
assert.ok(flapping.blockers.some(row => row.code === 'REQUIRED_SERVICE_RESTARTED'));

const businessUnits = healthyUnits();
for (const [timer, unitClass] of Object.entries(CLOUD_TIMER_MAINTENANCE_POLICY)) {
  if (unitClass === 'scheduled') businessUnits[timer].ActiveState = 'inactive';
}
const businessMaintenance = buildCloudRuntimeSnapshot({
  ...base,
  systemdSnapshot: {...base.systemdSnapshot, units: businessUnits},
  maintenanceStatus: healthyMaintenance({
    exists: true,
    active: true,
    mode: 'business',
    generation: 4,
    hash: 'b'.repeat(64),
    reason: 'business maintenance',
    requestedBy: 'runtime-test',
    startedAt: '2026-08-11T11:00:00.000Z',
    updatedAt: '2026-08-11T11:00:00.000Z',
  }),
});
assert.equal(businessMaintenance.ok, false);
assert.ok(businessMaintenance.blockers.some(row => row.code === 'CLOUD_MAINTENANCE_ACTIVE'));
assert.ok(!businessMaintenance.blockers.some(row => row.code === 'SCHEDULE_TIMER_INACTIVE'));
assert.equal(
  businessMaintenance.runtimeProbe.maintenanceInactiveTimers.length,
  Object.values(CLOUD_TIMER_MAINTENANCE_POLICY).filter(value => value === 'scheduled').length,
);

const allUnits = healthyUnits();
for (const [timer, unitClass] of Object.entries(CLOUD_TIMER_MAINTENANCE_POLICY)) {
  if (unitClass !== 'always') allUnits[timer].ActiveState = 'inactive';
}
const allMaintenanceStatus = healthyMaintenance({
  exists: true,
  active: true,
  mode: 'all',
  generation: 5,
  hash: 'c'.repeat(64),
  reason: 'all maintenance',
  requestedBy: 'runtime-test',
  startedAt: '2026-08-11T11:00:00.000Z',
  updatedAt: '2026-08-11T11:05:00.000Z',
});
const allMaintenance = buildCloudRuntimeSnapshot({
  ...base,
  systemdSnapshot: {...base.systemdSnapshot, units: allUnits},
  maintenanceStatus: allMaintenanceStatus,
});
assert.ok(!allMaintenance.blockers.some(row => row.code === 'SCHEDULE_TIMER_INACTIVE'));
assert.equal(
  allMaintenance.runtimeProbe.maintenanceInactiveTimers.length,
  Object.values(CLOUD_TIMER_MAINTENANCE_POLICY).filter(value => value !== 'always').length,
);
assert.equal(allUnits['shein-bi-cloud-watchdog.timer'].ActiveState, 'active');

const allWithRequiredServiceDown = healthyUnits();
allWithRequiredServiceDown['shein-bi-query.service'].ActiveState = 'inactive';
const allRequiredServiceCheck = buildCloudRuntimeSnapshot({
  ...base,
  systemdSnapshot: {...base.systemdSnapshot, units: allWithRequiredServiceDown},
  maintenanceStatus: allMaintenanceStatus,
});
assert.ok(allRequiredServiceCheck.blockers.some(row => row.code === 'REQUIRED_SERVICE_INACTIVE'));
assert.ok(allRequiredServiceCheck.runtimeProbe.inactiveAlwaysRunning.includes('shein-bi-query.service'));

const corruptMarkerUnits = healthyUnits();
for (const [timer, unitClass] of Object.entries(CLOUD_TIMER_MAINTENANCE_POLICY)) {
  if (unitClass !== 'always') corruptMarkerUnits[timer].ActiveState = 'inactive';
}
const corruptMarker = buildCloudRuntimeSnapshot({
  ...base,
  systemdSnapshot: {...base.systemdSnapshot, units: corruptMarkerUnits},
  maintenanceStatus: healthyMaintenance({
    ok: false,
    exists: true,
    active: null,
    mode: 'unknown',
    generation: null,
    hash: 'd'.repeat(64),
    errorCode: 'MAINTENANCE_MARKER_INVALID_JSON',
    issues: ['marker is not valid JSON'],
  }),
});
assert.ok(corruptMarker.blockers.some(row => row.code === 'CLOUD_MAINTENANCE_STATUS_INVALID'));
assert.ok(!corruptMarker.blockers.some(row => row.code === 'SCHEDULE_TIMER_INACTIVE'));

console.log(JSON.stringify({
  ok: true,
  checks: [
    'healthy_snapshot',
    'source_drift',
    'service_and_timer_health',
    'restart_loop',
    'endpoint_health',
    'query_surface_no_side_effects_contract',
    'deployment_evidence_readback',
    'runtime_rejects_v2_receipt',
    'maintenance_guard_file_and_effective_readback',
    'runtime_namespace_effective_readback',
    'readonly_paths_effective_readback',
    'readonly_paths_omission_drift',
    'unexpected_installed_unit',
    'business_maintenance',
    'all_maintenance',
    'corrupt_marker_fail_closed',
    'always_service_required',
  ],
}, null, 2));
