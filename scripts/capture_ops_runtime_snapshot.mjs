#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {buildCloudRuntimeSnapshot} from '../lib/cloud_runtime_snapshot.mjs';
import {CLOUD_RUNTIME_UNITS} from '../lib/cloud_runtime_inventory.mjs';
import {buildOpsRun, compactOpsRun, writeOpsRunManifest} from '../lib/ops_run_bundle.mjs';
import {collectSystemdUnitSnapshot} from '../lib/systemd_unit_snapshot.mjs';
import {writeJsonFileAtomic} from '../lib/atomic_file_publish.mjs';
import {inspectReleaseSourceState} from './check_release_source_state.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {
    root: ROOT,
    outDir: '',
    expectedCommit: '',
    deploymentStateFile: process.env.SHEIN_BI_DEPLOYED_RELEASE_FILE || '/srv/shein-bi/runtime/deployed_release.json',
    portalUrl: 'http://127.0.0.1:8787/api/health',
    webhookUrl: 'http://127.0.0.1:8792/healthz',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const value = () => String(argv[++i] || '').trim();
    if (argv[i] === '--root') args.root = path.resolve(value());
    else if (argv[i] === '--out-dir') args.outDir = path.resolve(value());
    else if (argv[i] === '--expected-commit') args.expectedCommit = value();
    else if (argv[i] === '--deployment-state-file') args.deploymentStateFile = path.resolve(value());
    else if (argv[i] === '--portal-url') args.portalUrl = value();
    else if (argv[i] === '--webhook-url') args.webhookUrl = value();
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  try {
    await fs.mkdir(path.dirname(args.outDir), {recursive: true});
    await fs.mkdir(args.outDir, {recursive: false, mode: 0o750});
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`out-dir must be new: ${args.outDir}`);
    throw error;
  }
  const deployedRelease = await readJson(args.deploymentStateFile).catch(() => ({}));
  let releaseSourceState;
  try {
    releaseSourceState = inspectReleaseSourceState({
      cwd: args.root,
      expectedCommit: args.expectedCommit || deployedRelease.commit || '',
    });
  } catch (error) {
    releaseSourceState = {ok: false, errorCode: String(error?.code || 'SOURCE_INSPECTION_FAILED')};
  }
  const [systemdSnapshot, portalHealth, webhookHealth] = await Promise.all([
    collectSystemdUnitSnapshot(CLOUD_RUNTIME_UNITS),
    fetchHealth(args.portalUrl, 'portal'),
    fetchHealth(args.webhookUrl, 'webhook'),
  ]);
  const finishedAt = new Date().toISOString();
  const snapshot = buildCloudRuntimeSnapshot({
    generatedAt: finishedAt,
    releaseSourceState,
    deployedRelease,
    systemdSnapshot,
    portalHealth,
    webhookHealth,
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
      healthEndpoints: 2,
    },
    summary: {
      releaseCommitMatches: snapshot.releaseSource.commitMatches,
      trackedDirtyCount: snapshot.releaseSource.dirtyCount,
      requiredServicesInactive: snapshot.runtimeProbe.inactiveAlwaysRunning.length,
      requiredServicesRestarted: snapshot.runtimeProbe.restartedAlwaysRunning.length,
      timersInactive: snapshot.runtimeProbe.inactiveTimers.length,
      portalHealthy: snapshot.health.portal.ok,
      webhookHealthy: snapshot.health.webhook.ok,
      systemctlCommandCount: snapshot.runtimeProbe.systemctlCommandCount,
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
  console.error(JSON.stringify({ok: false, outcome: 'failed', exitCode: 1, error: String(error?.message || error)}, null, 2));
  process.exitCode = 1;
});
