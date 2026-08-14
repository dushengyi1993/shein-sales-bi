import {CLOUD_ALWAYS_RUNNING_UNITS, CLOUD_TIMER_UNITS} from './cloud_runtime_inventory.mjs';

function text(value) {
  return String(value ?? '').trim();
}

function blocker(code, message, detail = {}) {
  return {code, message, ...detail};
}

export function buildCloudRuntimeSnapshot({
  generatedAt,
  releaseSourceState = {},
  deployedRelease = {},
  systemdSnapshot = {},
  portalHealth = {},
  webhookHealth = {},
} = {}) {
  const blockers = [];
  const units = systemdSnapshot.units || {};
  if (releaseSourceState.ok !== true) {
    blockers.push(blocker('RELEASE_SOURCE_NOT_CLEAN', 'deployed source does not match its recorded release'));
  }
  if (!text(deployedRelease.tag) || !text(deployedRelease.commit)) {
    blockers.push(blocker('DEPLOYMENT_MARKER_MISSING', 'deployment marker is missing tag or commit'));
  } else if (text(releaseSourceState.head) && text(releaseSourceState.head) !== text(deployedRelease.commit)) {
    blockers.push(blocker('DEPLOYMENT_MARKER_DRIFT', 'deployment marker commit differs from source HEAD'));
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
  const inactiveTimers = CLOUD_TIMER_UNITS.filter(name => {
    const unit = units[name];
    return unit?.LoadState !== 'not-found' && unit?.ActiveState !== 'active';
  });
  if (inactiveTimers.length) {
    blockers.push(blocker('SCHEDULE_TIMER_INACTIVE', 'one or more installed timers are inactive', {units: inactiveTimers}));
  }
  if (portalHealth.ok !== true || Number(portalHealth.httpStatus) !== 200) {
    blockers.push(blocker('PORTAL_HEALTH_FAILED', 'Portal health endpoint is not healthy'));
  }
  if (webhookHealth.ok !== true || Number(webhookHealth.httpStatus) !== 200) {
    blockers.push(blocker('WEBHOOK_HEALTH_FAILED', 'Webhook health endpoint is not healthy'));
  }
  const unknownUnits = Object.values(units).filter(unit => unit?.complete !== true).map(unit => unit.name).sort();
  if (unknownUnits.length) {
    blockers.push(blocker('SYSTEMD_SNAPSHOT_INCOMPLETE', 'systemd returned no state for requested units', {units: unknownUnits}));
  }
  return {
    schemaVersion: 'shein-cloud-runtime-snapshot/v1',
    ok: blockers.length === 0,
    generatedAt: text(generatedAt),
    deployedRelease: {
      tag: text(deployedRelease.tag),
      commit: text(deployedRelease.commit),
      recordedAt: text(deployedRelease.recordedAt),
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
      requestedUnitCount: Array.isArray(systemdSnapshot.requested) ? systemdSnapshot.requested.length : 0,
      inactiveAlwaysRunning,
      restartedAlwaysRunning,
      inactiveTimers,
      unknownUnits,
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
    },
    units,
    blockers,
  };
}
