import {assessSystemdOneshotResult, assessBusinessRecovery} from './cloud_watchdog_recovery.mjs';
import {assessSessionManagerManualRecovery} from './cloud_manual_login_recovery.mjs';
import {maintenanceBlocksClass, CLOUD_MAINTENANCE_SCHEMA_VERSION} from './cloud_maintenance_mode.mjs';
import {
  CLOUD_ALWAYS_RUNNING_UNITS,
  CLOUD_TIMER_MAINTENANCE_POLICY,
  CLOUD_TIMER_UNITS,
  validateInventoryWriterCompatibilityEffectiveGuards,
  validateCloudMaintenanceEffectiveGuards,
} from './cloud_runtime_inventory.mjs';
import {
  CLOUD_RUNTIME_PATH_POLICY_BY_SERVICE,
  cloudRuntimePathEffectiveDirectives,
} from './cloud_runtime_path_policy.mjs';
import {validateDeployedReleaseMarker} from './source_release_attestation.mjs';

function text(value) {
  return String(value ?? '').trim();
}

function blocker(code, message, detail = {}) {
  return {code, message, ...detail};
}

const RELEASE_AUDIT_BLOCKER_CODES = new Set([
  'RELEASE_SOURCE_NOT_CLEAN',
  'DEPLOYMENT_MARKER_INVALID',
  'DEPLOYMENT_EVIDENCE_INVALID',
  'DEPLOYMENT_MARKER_DRIFT',
  'PARTNER_CLI_RELEASE_UNMANAGED',
]);

const INFRASTRUCTURE_BLOCKER_CODES = new Set([
  'SYSTEMD_UNIT_FILE_INVENTORY_INCOMPLETE',
  'SYSTEMD_EXPECTED_UNIT_MISSING',
  'SYSTEMD_UNEXPECTED_UNIT_INSTALLED',
  'SYSTEMD_UNIT_FILE_STATE_UNKNOWN',
  'CLOUD_MAINTENANCE_STATUS_INVALID',
  'CLOUD_MAINTENANCE_ACTIVE',
  'MAINTENANCE_GUARD_INSTALLATION_DRIFT',
  'RUNTIME_PATH_EFFECTIVE_ISOLATION_DRIFT',
  'MAINTENANCE_GUARD_EFFECTIVE_DRIFT',
  'INVENTORY_WRITER_COMPATIBILITY_GUARD_EFFECTIVE_DRIFT',
  'REQUIRED_SERVICE_INACTIVE',
  'REQUIRED_SERVICE_RESTARTED',
  'SCHEDULE_TIMER_INACTIVE',
  'PORTAL_HEALTH_FAILED',
  'WEBHOOK_HEALTH_FAILED',
  'QUERY_HEALTH_FAILED',
  'SYSTEMD_SNAPSHOT_INCOMPLETE',
]);

function propertyTokens(value, {bind = false} = {}) {
  return [...new Set(String(value || '').trim().split(/\s+/u).filter(Boolean).map(token => {
    if (!bind) return token;
    const fields = token.split(':');
    return fields.length === 3 && fields[2] === 'rbind' ? fields.slice(0, 2).join(':') : token;
  }))].sort();
}

function sameTokens(actual, expected, options = {}) {
  const left = propertyTokens(actual, options);
  const right = [...new Set(expected || [])].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function validateCloudRuntimeEffectiveControls(units = {}) {
  const issues = [];
  for (const [service, policy] of Object.entries(CLOUD_RUNTIME_PATH_POLICY_BY_SERVICE)) {
    const unit = units?.[service] || {};
    if (unit.complete !== true || unit.LoadState === 'not-found') {
      issues.push({kind: 'snapshot', service, code: 'SERVICE_EFFECTIVE_PROPERTIES_UNAVAILABLE'});
      continue;
    }
    const expected = cloudRuntimePathEffectiveDirectives(service, policy);
    for (const [property, values, options] of [
      ['BindPaths', expected.bindPaths, {bind: true}],
      ['BindReadOnlyPaths', expected.bindReadOnlyPaths, {bind: true}],
      ['InaccessiblePaths', expected.inaccessiblePaths, {}],
      ['ReadOnlyPaths', expected.readOnlyPaths, {}],
    ]) {
      if (!sameTokens(unit[property], values, options)) {
        issues.push({
          kind: 'runtime-path', service, property,
          code: 'RUNTIME_PATH_EFFECTIVE_PROPERTY_MISMATCH',
          expected: [...values], actual: propertyTokens(unit[property], options),
        });
      }
    }
    const required = new Set(propertyTokens(unit.RequiresMountsFor));
    const missingMounts = expected.requiresMountsFor.filter(value => !required.has(value));
    if (missingMounts.length) {
      issues.push({
        kind: 'runtime-path', service, property: 'RequiresMountsFor',
        code: 'RUNTIME_PATH_REQUIRED_MOUNT_MISSING', missing: missingMounts,
      });
    }
  }
  issues.push(...validateCloudMaintenanceEffectiveGuards(units).issues);
  issues.push(...validateInventoryWriterCompatibilityEffectiveGuards(units).issues);
  return Object.freeze({
    ok: issues.length === 0,
    checkedServiceCount: Object.keys(CLOUD_RUNTIME_PATH_POLICY_BY_SERVICE).length,
    issues: Object.freeze(issues),
  });
}

function normalizeMaintenanceStatus(status = {}) {
  return {
    schemaVersion: text(status.schemaVersion) || CLOUD_MAINTENANCE_SCHEMA_VERSION,
    ok: status.ok === true,
    exists: status.exists === true,
    active: status.active === true ? true : status.active === false ? false : null,
    mode: text(status.mode) || 'unknown',
    generation: Number.isSafeInteger(status.generation) ? status.generation : null,
    hash: text(status.hash),
    reason: text(status.reason),
    requestedBy: text(status.requestedBy),
    startedAt: text(status.startedAt),
    updatedAt: text(status.updatedAt),
    endedAt: text(status.endedAt),
    markerFile: text(status.markerFile),
    errorCode: text(status.errorCode),
    issues: Array.isArray(status.issues) ? status.issues.map(text).filter(Boolean).slice(0, 20) : [],
  };
}

export function buildCloudRuntimeSnapshot({
  generatedAt,
  releaseSourceState = {},
  deployedRelease = {},
  deploymentEvidence = {},
  systemdSnapshot = {},
  maintenanceStatus = {},
  maintenanceGuardAudit = {},
  portalHealth = {},
  webhookHealth = {},
  queryHealth = {},
  jobEvidence = {},
} = {}) {
  const blockers = [];
  const units = systemdSnapshot.units || {};
  const unitFileInventory = systemdSnapshot.unitFileInventory || {};
  const unitFileComparison = systemdSnapshot.unitFileComparison || null;
  const maintenance = normalizeMaintenanceStatus(maintenanceStatus);
  const deploymentMarkerValidation = validateDeployedReleaseMarker(deployedRelease, {requireV3: true});
  const effectiveControls = validateCloudRuntimeEffectiveControls(units);
  if (releaseSourceState.ok !== true) {
    blockers.push(blocker('RELEASE_SOURCE_NOT_CLEAN', 'deployed source does not match its recorded release'));
  }
  if (!deploymentMarkerValidation.ok) {
    blockers.push(blocker(
      'DEPLOYMENT_MARKER_INVALID',
      'deployment marker is missing or does not bind the required v3 source release receipt',
      {issues: deploymentMarkerValidation.issues},
    ));
  } else if (deploymentEvidence.ok !== true) {
    blockers.push(blocker(
      'DEPLOYMENT_EVIDENCE_INVALID',
      'deployment marker is not backed by the local attestation files and annotated tag',
      {issues: Array.isArray(deploymentEvidence.issues) ? deploymentEvidence.issues : ['deployment_evidence_unavailable']},
    ));
  } else if (text(releaseSourceState.head) && text(releaseSourceState.head) !== text(deployedRelease.commit)) {
    blockers.push(blocker('DEPLOYMENT_MARKER_DRIFT', 'deployment marker commit differs from source HEAD'));
  }
  if (unitFileInventory.complete !== true || !unitFileComparison) {
    blockers.push(blocker(
      'SYSTEMD_UNIT_FILE_INVENTORY_INCOMPLETE',
      'systemd list-unit-files inventory is incomplete or was not compared to the expected inventory',
    ));
  }
  if (unitFileComparison?.missing?.length) {
    blockers.push(blocker(
      'SYSTEMD_EXPECTED_UNIT_MISSING',
      'one or more expected systemd unit files are not installed',
      {units: [...unitFileComparison.missing]},
    ));
  }
  if (unitFileComparison?.unexpected?.length) {
    blockers.push(blocker(
      'SYSTEMD_UNEXPECTED_UNIT_INSTALLED',
      'one or more unexpected systemd unit files are installed',
      {units: unitFileComparison.unexpected.map(row => ({name: row.name, state: row.state}))},
    ));
  }
  if (unitFileComparison?.unknownState?.length) {
    blockers.push(blocker(
      'SYSTEMD_UNIT_FILE_STATE_UNKNOWN',
      'one or more installed systemd unit files have an unknown state',
      {units: unitFileComparison.unknownState.map(row => ({name: row.name, state: row.state}))},
    ));
  }
  if (!maintenance.ok) {
    blockers.push(blocker(
      'CLOUD_MAINTENANCE_STATUS_INVALID',
      'cloud maintenance marker is invalid; scheduled and infrastructure work fail closed',
      {errorCode: maintenance.errorCode || 'MAINTENANCE_MARKER_STATUS_MISSING'},
    ));
  } else if (maintenance.active) {
    blockers.push(blocker(
      'CLOUD_MAINTENANCE_ACTIVE',
      'cloud maintenance mode is active',
      {mode: maintenance.mode, generation: maintenance.generation, startedAt: maintenance.startedAt},
    ));
  }
  if (maintenanceGuardAudit.ok !== true) {
    blockers.push(blocker(
      'MAINTENANCE_GUARD_INSTALLATION_DRIFT',
      'maintenance guard files are not fully installed from the reviewed policy',
      {issues: Array.isArray(maintenanceGuardAudit.issues) ? maintenanceGuardAudit.issues : []},
    ));
  }
  const runtimePathIssues = effectiveControls.issues.filter(issue => issue.kind === 'runtime-path' || issue.kind === 'snapshot');
  const effectiveGuardIssues = effectiveControls.issues.filter(issue => issue.kind === 'maintenance-guard');
  const inventoryWriterGuardIssues = effectiveControls.issues.filter(issue => issue.kind === 'inventory-writer-guard');
  if (runtimePathIssues.length) {
    blockers.push(blocker(
      'RUNTIME_PATH_EFFECTIVE_ISOLATION_DRIFT',
      'one or more services do not have the reviewed effective runtime path namespace',
      {issues: runtimePathIssues},
    ));
  }
  if (effectiveGuardIssues.length) {
    blockers.push(blocker(
      'MAINTENANCE_GUARD_EFFECTIVE_DRIFT',
      'one or more services do not have the reviewed effective maintenance ExecCondition',
      {issues: effectiveGuardIssues},
    ));
  }
  if (inventoryWriterGuardIssues.length) {
    blockers.push(blocker(
      'INVENTORY_WRITER_COMPATIBILITY_GUARD_EFFECTIVE_DRIFT',
      'one or more inventory-capable services do not have the checkout-independent pre-start guard',
      {issues: inventoryWriterGuardIssues},
    ));
  }
  const inactiveAlwaysRunning = CLOUD_ALWAYS_RUNNING_UNITS.filter(name => units[name]?.ActiveState !== 'active');
  if (inactiveAlwaysRunning.length) {
    blockers.push(blocker('REQUIRED_SERVICE_INACTIVE', 'one or more always-running services are inactive', {units: inactiveAlwaysRunning}));
  }
  const restartedAlwaysRunning = CLOUD_ALWAYS_RUNNING_UNITS
    .filter(name => Number(units[name]?.NRestarts || 0) > 0)
    .map(name => ({name, restarts: Number(units[name].NRestarts)}));
  if (restartedAlwaysRunning.length) {
    blockers.push(blocker('REQUIRED_SERVICE_RESTARTED', 'one or more always-running services restarted unexpectedly since activation', {units: restartedAlwaysRunning}));
  }
  const jobRecoveries = [], failedScheduledJobs = [];
  for (const [name, unit] of Object.entries(units)) {
    if (!name.endsWith('.service') || CLOUD_ALWAYS_RUNNING_UNITS.includes(name)
      || unit.complete !== true || unit.LoadState === 'not-found') continue;
    const result = assessSystemdOneshotResult(unit);
    if (!result.abnormalState && !result.abnormalExit) continue;
    const recovery = name === 'shein-bi-cloud-session-manager.service'
      ? assessSessionManagerManualRecovery({sessionReport: jobEvidence.sessionReport, manualLoginState: jobEvidence.manualLoginState, unitStatus: unit})
      : assessBusinessRecovery(name, unit, {...jobEvidence, nowMs: Date.parse(generatedAt) || Date.now()});
    if (recovery.recovered) jobRecoveries.push({unit: name, ...recovery});
    else failedScheduledJobs.push({unit: name, result: unit.Result, exitStatus: result.exitStatus});
  }
  if (failedScheduledJobs.length) blockers.push(blocker(
    'SCHEDULED_JOB_FAILED', 'scheduled jobs failed without verified later recovery', {jobs: failedScheduledJobs},
  ));
  const inactiveTimers = [];
  const maintenanceInactiveTimers = [];
  for (const name of CLOUD_TIMER_UNITS) {
    const unit = units[name];
    if (unit?.LoadState === 'not-found' || unit?.ActiveState === 'active') continue;
    const unitClass = CLOUD_TIMER_MAINTENANCE_POLICY[name];
    if (maintenanceBlocksClass(maintenance, unitClass) === true) {
      maintenanceInactiveTimers.push({
        name,
        class: unitClass,
        reason: maintenance.ok ? `maintenance_${maintenance.mode}` : 'invalid_marker_fail_closed',
      });
    } else {
      inactiveTimers.push(name);
    }
  }
  if (inactiveTimers.length) {
    blockers.push(blocker('SCHEDULE_TIMER_INACTIVE', 'one or more installed timers are inactive', {units: inactiveTimers}));
  }
  if (portalHealth.ok !== true || Number(portalHealth.httpStatus) !== 200) {
    blockers.push(blocker('PORTAL_HEALTH_FAILED', 'Portal health endpoint is not healthy'));
  }
  if (webhookHealth.ok !== true || Number(webhookHealth.httpStatus) !== 200) {
    blockers.push(blocker('WEBHOOK_HEALTH_FAILED', 'Webhook health endpoint is not healthy'));
  }
  const querySideEffectsStarted = Array.isArray(queryHealth.sideEffectsStarted)
    ? queryHealth.sideEffectsStarted.map(text)
    : null;
  const queryPartnerCliRelease = {
    ready: queryHealth.partnerCliRelease?.ready === true,
    source: text(queryHealth.partnerCliRelease?.source),
    version: text(queryHealth.partnerCliRelease?.version),
    errorCode: text(queryHealth.partnerCliRelease?.errorCode),
  };
  const queryBusinessHealthy = queryHealth.ok === true
    && Number(queryHealth.httpStatus) === 200
    && text(queryHealth.surface) === 'query'
    && queryHealth.sideEffectsStartedIsArray === true
    && querySideEffectsStarted !== null
    && querySideEffectsStarted.length === 0;
  const queryHealthy = queryBusinessHealthy
    && queryPartnerCliRelease.ready === true
    && ['managed', 'fallback'].includes(queryPartnerCliRelease.source)
    && /^\d{4}\.\d{2}\.\d{2}\.\d+$/u.test(queryPartnerCliRelease.version);
  if (!queryHealthy) {
    blockers.push(blocker(
      'QUERY_HEALTH_FAILED',
      'query-only health endpoint is unhealthy or violates the no-side-effects contract',
      {
        httpStatus: Number(queryHealth.httpStatus) || 0,
        surface: text(queryHealth.surface),
        sideEffectsStarted: querySideEffectsStarted,
        partnerCliRelease: queryPartnerCliRelease,
      },
    ));
  }
  if (queryPartnerCliRelease.ready === true && queryPartnerCliRelease.source !== 'managed') {
    blockers.push(blocker(
      'PARTNER_CLI_RELEASE_UNMANAGED',
      'Partner CLI is served from an emergency fallback rather than the managed release store',
      {source: queryPartnerCliRelease.source, version: queryPartnerCliRelease.version},
    ));
  }
  const unknownUnits = Object.values(units).filter(unit => unit?.complete !== true).map(unit => unit.name).sort();
  if (unknownUnits.length) {
    blockers.push(blocker('SYSTEMD_SNAPSHOT_INCOMPLETE', 'systemd returned no state for requested units', {units: unknownUnits}));
  }
  const partnerCliReleaseAuditReady = queryPartnerCliRelease.ready === true
    && queryPartnerCliRelease.source === 'managed'
    && /^\d{4}\.\d{2}\.\d{2}\.\d+$/u.test(queryPartnerCliRelease.version);
  const isReleaseOnlyBlocker = row => RELEASE_AUDIT_BLOCKER_CODES.has(row.code)
    || (row.code === 'QUERY_HEALTH_FAILED' && queryBusinessHealthy);
  const releaseAuditBlockers = blockers.filter(isReleaseOnlyBlocker);
  const infrastructureBlockers = blockers.filter(row => INFRASTRUCTURE_BLOCKER_CODES.has(row.code) && !isReleaseOnlyBlocker(row));
  const businessBlockers = blockers.filter(row => !isReleaseOnlyBlocker(row));
  const businessReady = businessBlockers.length === 0;
  const infrastructureReady = infrastructureBlockers.length === 0;
  const releaseAuditReady = partnerCliReleaseAuditReady && releaseAuditBlockers.length === 0;
  return {
    schemaVersion: 'shein-cloud-runtime-snapshot/v1',
    jobs: {failed: failedScheduledJobs, recovered: jobRecoveries},
    ok: blockers.length === 0,
    businessReady,
    releaseAuditReady,
    infrastructureReady,
    readiness: {
      businessReady,
      releaseAuditReady,
      infrastructureReady,
      businessBlockers,
      releaseAuditBlockers,
      infrastructureBlockers,
    },
    generatedAt: text(generatedAt),
    deployedRelease: {
      schemaVersion: text(deployedRelease.schemaVersion),
      markerOk: deploymentMarkerValidation.ok,
      markerIssues: deploymentMarkerValidation.issues,
      repository: text(deployedRelease.repository),
      tag: text(deployedRelease.tag),
      commit: text(deployedRelease.commit),
      tagObject: text(deployedRelease.tagObject),
      attestationSha256: text(deployedRelease.releaseAttestation?.sha256),
      attestationChecksumSha256: text(deployedRelease.releaseAttestation?.checksumSha256),
      ciRunId: Number.isInteger(deployedRelease.ci?.runId) ? deployedRelease.ci.runId : null,
      ciRunAttempt: Number.isInteger(deployedRelease.ci?.runAttempt) ? deployedRelease.ci.runAttempt : null,
      recordedAt: text(deployedRelease.recordedAt),
      evidenceOk: deploymentEvidence.ok === true,
      evidenceIssues: Array.isArray(deploymentEvidence.issues) ? deploymentEvidence.issues.map(text) : [],
    },
    releaseSource: {
      ok: releaseSourceState.ok === true,
      head: text(releaseSourceState.head),
      expectedCommit: text(releaseSourceState.expectedCommit),
      commitMatches: releaseSourceState.commitMatches === true,
      dirtyCount: Array.isArray(releaseSourceState.dirtyEntries) ? releaseSourceState.dirtyEntries.length : null,
      hiddenIndexCount: Array.isArray(releaseSourceState.hiddenIndexEntries) ? releaseSourceState.hiddenIndexEntries.length : null,
      missingTrackedCount: Array.isArray(releaseSourceState.missingTrackedFiles) ? releaseSourceState.missingTrackedFiles.length : null,
      trackedFileCount: Number(releaseSourceState.trackedFileCount) || 0,
    },
    runtimeProbe: {
      systemctlCommandCount: Number(systemdSnapshot.commandCount) || 0,
      systemctlShowCommandCount: Number(systemdSnapshot.showCommandCount) || 0,
      systemctlListUnitFilesCommandCount: Number(systemdSnapshot.listUnitFilesCommandCount) || 0,
      requestedUnitCount: Array.isArray(systemdSnapshot.requested) ? systemdSnapshot.requested.length : 0,
      inactiveAlwaysRunning,
      restartedAlwaysRunning,
      inactiveTimers,
      maintenanceInactiveTimers,
      unknownUnits,
    },
    unitFiles: {
      complete: unitFileInventory.complete === true,
      commandCode: Number.isInteger(unitFileInventory.commandCode) ? unitFileInventory.commandCode : null,
      expectedCount: Array.isArray(unitFileComparison?.expected) ? unitFileComparison.expected.length : 0,
      installedCount: Array.isArray(unitFileComparison?.installed) ? unitFileComparison.installed.length : 0,
      missing: Array.isArray(unitFileComparison?.missing) ? [...unitFileComparison.missing] : [],
      unexpected: Array.isArray(unitFileComparison?.unexpected)
        ? unitFileComparison.unexpected.map(row => ({name: row.name, state: row.state}))
        : [],
      unknownState: Array.isArray(unitFileComparison?.unknownState)
        ? unitFileComparison.unknownState.map(row => ({name: row.name, state: row.state}))
        : [],
      allowedLegacyMasked: Array.isArray(unitFileComparison?.allowedLegacyMasked)
        ? unitFileComparison.allowedLegacyMasked.map(row => ({name: row.name, state: row.state}))
        : [],
    },
    maintenance,
    maintenanceGuards: {
      ok: maintenanceGuardAudit.ok === true,
      policyCount: Number(maintenanceGuardAudit.policyCount) || 0,
      unchanged: Number(maintenanceGuardAudit.unchanged) || 0,
      issues: Array.isArray(maintenanceGuardAudit.issues) ? maintenanceGuardAudit.issues : [],
    },
    effectiveControls: {
      ok: effectiveControls.ok,
      checkedServiceCount: effectiveControls.checkedServiceCount,
      issues: effectiveControls.issues,
    },
    health: {
      portal: {
        httpStatus: Number(portalHealth.httpStatus) || 0,
        ok: portalHealth.ok === true,
        coreWarmupStatus: text(portalHealth.coreWarmupStatus),
        liveUpdatesConnected: portalHealth.liveUpdatesConnected === true,
      },
      webhook: {
        httpStatus: Number(webhookHealth.httpStatus) || 0,
        ok: webhookHealth.ok === true,
      },
      query: {
        httpStatus: Number(queryHealth.httpStatus) || 0,
        ok: queryHealthy,
        surface: text(queryHealth.surface),
        sideEffectsStarted: querySideEffectsStarted,
        partnerCliRelease: queryPartnerCliRelease,
      },
    },
    units,
    blockers,
  };
}
