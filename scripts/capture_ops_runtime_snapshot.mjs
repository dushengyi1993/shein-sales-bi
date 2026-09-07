#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

import {
  DEFAULT_CLOUD_MAINTENANCE_FILE,
  readCloudMaintenanceStatus,
} from '../lib/cloud_maintenance_mode.mjs';
import {buildCloudRuntimeSnapshot} from '../lib/cloud_runtime_snapshot.mjs';
import {
  CLOUD_EXPECTED_INSTALLED_UNITS,
  CLOUD_LEGACY_MASKED_UNIT_ALLOWLIST,
  CLOUD_RUNTIME_SNAPSHOT_UNITS,
} from '../lib/cloud_runtime_inventory.mjs';
import {buildOpsRun, compactOpsRun, writeOpsRunManifest} from '../lib/ops_run_bundle.mjs';
import {collectSystemdUnitSnapshot} from '../lib/systemd_unit_snapshot.mjs';
import {writeJsonFileAtomic} from '../lib/atomic_file_publish.mjs';
import {
  inspectRecordedDeploymentReleaseEvidence,
  inspectReleaseSourceState,
} from './check_release_source_state.mjs';
import {validateDailyOperatingRefresh} from './validate_daily_operating_refresh.mjs';
import {auditCloudMaintenanceGuards} from './manage_cloud_maintenance_mode.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const args = {
    root: ROOT,
    stateRoot: process.env.SHEIN_BI_STATE_ROOT || '/data/shein-bi/state',
    outputsRoot: process.env.SHEIN_BI_OUTPUTS_ROOT || '/data/shein-bi/outputs',
    outDir: '',
    expectedCommit: '',
    deploymentStateFile: process.env.SHEIN_BI_DEPLOYED_RELEASE_FILE || '/srv/shein-bi/runtime/deployed_release.json',
    releaseAttestationRoot: process.env.SHEIN_BI_RELEASE_ATTESTATION_ROOT
      || '/srv/shein-bi/runtime/release-attestations',
    maintenanceFile: DEFAULT_CLOUD_MAINTENANCE_FILE,
    portalUrl: 'http://127.0.0.1:8787/api/health',
    webhookUrl: 'http://127.0.0.1:8792/healthz',
    queryUrl: 'http://127.0.0.1:8791/api/health',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const value = () => String(argv[++i] || '').trim();
    if (argv[i] === '--root') args.root = path.resolve(value());
    else if (argv[i] === '--state-root') args.stateRoot = path.resolve(value());
    else if (argv[i] === '--outputs-root') args.outputsRoot = path.resolve(value());
    else if (argv[i] === '--out-dir') args.outDir = path.resolve(value());
    else if (argv[i] === '--expected-commit') args.expectedCommit = value();
    else if (argv[i] === '--deployment-state-file') args.deploymentStateFile = path.resolve(value());
    else if (argv[i] === '--release-attestation-root') args.releaseAttestationRoot = path.resolve(value());
    else if (argv[i] === '--maintenance-file') args.maintenanceFile = path.resolve(value());
    else if (argv[i] === '--portal-url') args.portalUrl = value();
    else if (argv[i] === '--webhook-url') args.webhookUrl = value();
    else if (argv[i] === '--query-url') args.queryUrl = value();
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.outDir) throw new Error('Usage: node scripts/capture_ops_runtime_snapshot.mjs --out-dir <new-directory> [--expected-commit <tag-or-sha>]');
  return args;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function fetchHealth(url, kind) {
  try {
    const response = await fetch(url, {signal: AbortSignal.timeout(5_000)});
    const json = await response.json();
    if (kind === 'query') {
      const partnerCliRelease = json.partnerCliRelease && typeof json.partnerCliRelease === 'object'
        ? json.partnerCliRelease
        : {};
      return {
        httpStatus: response.status,
        ok: json.ok === true,
        surface: String(json.surface || ''),
        sideEffectsStartedIsArray: Array.isArray(json.sideEffectsStarted),
        sideEffectsStarted: Array.isArray(json.sideEffectsStarted)
          ? json.sideEffectsStarted.map(value => String(value || ''))
          : null,
        partnerCliRelease: {
          ready: partnerCliRelease.ready === true,
          source: String(partnerCliRelease.source || ''),
          version: String(partnerCliRelease.version || ''),
          errorCode: String(partnerCliRelease.errorCode || ''),
        },
      };
    }
    if (kind === 'portal') {
      return {
        httpStatus: response.status,
        ok: json.ok === true,
        coreWarmupStatus: String(json.biCoreWarmup?.status || ''),
        liveUpdatesConnected: json.liveUpdates?.connected === true,
      };
    }
    return {httpStatus: response.status, ok: json.ok === true};
  } catch (error) {
    return {httpStatus: 0, ok: false, errorCode: String(error?.code || error?.name || 'FETCH_FAILED')};
  }
}

async function assertCloudRuntimeProbeSupported() {
  if (process.platform !== 'linux') {
    const error = new Error('cloud runtime snapshot requires Linux with systemctl; refusing to create a cloud-shaped snapshot on this platform');
    error.code = 'CLOUD_RUNTIME_SNAPSHOT_LINUX_REQUIRED';
    throw error;
  }
  try {
    await execFileAsync('systemctl', ['--version'], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
    });
  } catch (cause) {
    const error = new Error(`cloud runtime snapshot requires an available systemctl command: ${String(cause?.message || cause).slice(0, 300)}`);
    error.code = 'CLOUD_RUNTIME_SNAPSHOT_SYSTEMCTL_UNAVAILABLE';
    error.cause = cause;
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await assertCloudRuntimeProbeSupported();
  const startedAt = new Date().toISOString();
  try {
    await fs.mkdir(path.dirname(args.outDir), {recursive: true});
    await fs.mkdir(args.outDir, {recursive: false, mode: 0o750});
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`out-dir must be new: ${args.outDir}`);
    throw error;
  }
  const deployedRelease = await readJson(args.deploymentStateFile).catch(() => ({}));
  const deploymentEvidence = inspectRecordedDeploymentReleaseEvidence({
    cwd: args.root,
    marker: deployedRelease,
    releaseAttestationRoot: args.releaseAttestationRoot,
  });
  let releaseSourceState;
  try {
    releaseSourceState = inspectReleaseSourceState({
      cwd: args.root,
      expectedCommit: args.expectedCommit || deploymentEvidence.commit || '',
    });
  } catch (error) {
    releaseSourceState = {ok: false, errorCode: String(error?.code || 'SOURCE_INSPECTION_FAILED')};
  }
  const [systemdSnapshot, maintenanceStatus, maintenanceGuardAudit, portalHealth, webhookHealth, queryHealth] = await Promise.all([
    collectSystemdUnitSnapshot(CLOUD_RUNTIME_SNAPSHOT_UNITS, {
      expectedUnitFiles: CLOUD_EXPECTED_INSTALLED_UNITS,
      legacyMaskedAllowlist: CLOUD_LEGACY_MASKED_UNIT_ALLOWLIST,
    }),
    readCloudMaintenanceStatus(args.maintenanceFile),
    auditCloudMaintenanceGuards().catch(error => ({
      ok: false,
      policyCount: 0,
      unchanged: 0,
      issues: [{code: String(error?.code || 'MAINTENANCE_GUARD_AUDIT_FAILED'), message: String(error?.message || error).slice(0, 500)}],
    })),
    fetchHealth(args.portalUrl, 'portal'),
    fetchHealth(args.webhookUrl, 'webhook'),
    fetchHealth(args.queryUrl, 'query'),
  ]);
  // Canonical mutable paths are used even when this read-only probe runs
  // outside a service's bind namespace.
  const today = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const previousDate = new Date(Date.parse(`${today}T12:00:00+08:00`) - 86400000).toISOString().slice(0,10);
  const [morningMarker, sessionReport, manualLoginState, orderRecheckState] = await Promise.all([
    readJson(path.join(args.stateRoot,'pipeline-markers',today,'daily-operating-refresh.json')).catch(()=>null),
    readJson(path.join(args.outputsRoot,'reports/cloud-session-manager-latest.json')).catch(()=>null),
    readJson(process.env.SHEIN_MANUAL_LOGIN_STATE_FILE || '/srv/shein-bi/runtime/cloud_manual_login_sessions.json').catch(()=>null),
    readJson(path.join(args.stateRoot,'order_status_recheck_last.json')).catch(()=>null),
  ]);
  let morningMarkerEvidenceOk = false;
  if (morningMarker?.status === 'done') {
    try {
      await validateDailyOperatingRefresh({root:args.root,markerRoot:path.join(args.stateRoot,'pipeline-markers'),
        stateDir:path.join(args.stateRoot,'cloud_morning_chain'),
        inventoryRuntimeRoot:process.env.SHEIN_BI_INVENTORY_RUNTIME_ROOT || '/srv/shein-bi/runtime/daily-inventory-replenishment',
        runDate:today,businessDate:previousDate});
      morningMarkerEvidenceOk = true;
    } catch {}
  }
  const jobEvidence = {morningMarker,morningMarkerEvidenceOk,sessionReport,manualLoginState,orderRecheckState};
  const finishedAt = new Date().toISOString();
  const snapshot = buildCloudRuntimeSnapshot({
    generatedAt: finishedAt,
    jobEvidence,
    releaseSourceState,
    deployedRelease,
    deploymentEvidence,
    systemdSnapshot,
    maintenanceStatus,
    maintenanceGuardAudit,
    portalHealth,
    webhookHealth,
    queryHealth,
  });
  const snapshotFile = path.join(args.outDir, 'snapshot.json');
  await writeJsonFileAtomic(snapshotFile, snapshot, {mode: 0o600});
  const run = buildOpsRun({
    operation: 'cloud_runtime_snapshot', mode: 'read', readOnly: true,
    outcome: snapshot.ok ? 'succeeded' : 'incomplete', startedAt, finishedAt,
    source: {authority: 'cloud_runtime', asOf: finishedAt},
    scope: {deployedRelease: snapshot.deployedRelease.tag},
    coverage: {
      requestedUnits: snapshot.runtimeProbe.requestedUnitCount,
      unknownUnits: snapshot.runtimeProbe.unknownUnits.length,
      expectedUnitFiles: snapshot.unitFiles.expectedCount,
      installedUnitFiles: snapshot.unitFiles.installedCount,
      missingUnitFiles: snapshot.unitFiles.missing.length,
      unexpectedUnitFiles: snapshot.unitFiles.unexpected.length,
      healthEndpoints: 3,
    },
    summary: {
      releaseCommitMatches: snapshot.releaseSource.commitMatches,
      deploymentEvidenceOk: snapshot.deployedRelease.evidenceOk,
      businessReady: snapshot.businessReady,
      releaseAuditReady: snapshot.releaseAuditReady,
      infrastructureReady: snapshot.infrastructureReady,
      trackedDirtyCount: snapshot.releaseSource.dirtyCount,
      requiredServicesInactive: snapshot.runtimeProbe.inactiveAlwaysRunning.length,
      requiredServicesRestarted: snapshot.runtimeProbe.restartedAlwaysRunning.length,
      timersInactive: snapshot.runtimeProbe.inactiveTimers.length,
      timersMaintenanceInactive: snapshot.runtimeProbe.maintenanceInactiveTimers.length,
      portalHealthy: snapshot.health.portal.ok,
      webhookHealthy: snapshot.health.webhook.ok,
      queryHealthy: snapshot.health.query.ok,
      queryPartnerCliRelease: snapshot.health.query.partnerCliRelease,
      systemctlCommandCount: snapshot.runtimeProbe.systemctlCommandCount,
      maintenance: {
        ok: snapshot.maintenance.ok,
        active: snapshot.maintenance.active,
        mode: snapshot.maintenance.mode,
        generation: snapshot.maintenance.generation,
        hash: snapshot.maintenance.hash,
        startedAt: snapshot.maintenance.startedAt || null,
        errorCode: snapshot.maintenance.errorCode || null,
      },
      maintenanceGuardsOk: snapshot.maintenanceGuards.ok,
      effectiveRuntimeControlsOk: snapshot.effectiveControls.ok,
    },
    blockers: snapshot.blockers,
  });
  const manifest = await writeOpsRunManifest({
    manifestFile: path.join(args.outDir, 'manifest.json'),
    run,
    artifacts: [{file: snapshotFile, role: 'runtime_snapshot'}],
  });
  console.log(JSON.stringify({...compactOpsRun(run, manifest), savedTo: snapshotFile}, null, 2));
  process.exitCode = run.exitCode;
}

main().catch(error => {
  console.error(JSON.stringify({
    ok: false,
    outcome: 'failed',
    exitCode: 1,
    errorCode: String(error?.code || 'CLOUD_RUNTIME_SNAPSHOT_FAILED'),
    error: String(error?.message || error),
  }, null, 2));
  process.exitCode = 1;
});
