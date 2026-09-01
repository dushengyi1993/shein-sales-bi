#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';

import {
  CANONICAL_CLOUD_MAINTENANCE_FILE,
  CLOUD_MAINTENANCE_ABSENT_HASH,
  CLOUD_MAINTENANCE_CONTROL_DIR,
  CLOUD_MAINTENANCE_CONTROL_MODE,
  CLOUD_MAINTENANCE_EXIT_CODES,
  CLOUD_MAINTENANCE_MARKER_MODE,
  CLOUD_MAINTENANCE_SCHEMA_VERSION,
  CloudMaintenanceCasConflictError,
  CloudMaintenanceConfigurationError,
  CloudMaintenanceLockCleanupError,
  checkCloudMaintenance,
  cloudMaintenanceAncestorDirectorySafety,
  cloudMaintenanceCanonicalLockSafety,
  cloudMaintenanceCanonicalMarkerSafety,
  cloudMaintenanceStaleLockRecoveryMode,
  DEFAULT_CLOUD_MAINTENANCE_FILE,
  pauseCloudMaintenance,
  readCloudMaintenanceStatus,
  resumeCloudMaintenance,
} from '../lib/cloud_maintenance_mode.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'manage_cloud_maintenance_mode.mjs');
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shein-cloud-maintenance-test-'));
const markerFile = path.join(tempDir, 'cloud-maintenance.json');
const maintenanceSource = await fs.readFile(path.join(ROOT, 'lib', 'cloud_maintenance_mode.mjs'), 'utf8');

assert.equal(CLOUD_MAINTENANCE_CONTROL_DIR, '/var/lib/shein-bi-control');
assert.equal(CANONICAL_CLOUD_MAINTENANCE_FILE, '/var/lib/shein-bi-control/cloud-maintenance.json');
assert.equal(DEFAULT_CLOUD_MAINTENANCE_FILE, CANONICAL_CLOUD_MAINTENANCE_FILE);
assert.equal(CLOUD_MAINTENANCE_CONTROL_MODE, 0o755);
assert.equal(CLOUD_MAINTENANCE_MARKER_MODE, 0o644);
assert.match(maintenanceSource, /O_NOFOLLOW/);
assert.match(maintenanceSource, /handle\.stat\(\)/);
assert.match(maintenanceSource, /handle\.readFile/);
assert.match(maintenanceSource, /process\.getuid\(\) !== 0/);
assert.equal(cloudMaintenanceStaleLockRecoveryMode(CANONICAL_CLOUD_MAINTENANCE_FILE, {platform: 'linux'}), 'manual');
assert.equal(cloudMaintenanceStaleLockRecoveryMode(markerFile, {platform: 'linux'}), 'automatic');
assert.equal(cloudMaintenanceStaleLockRecoveryMode(CANONICAL_CLOUD_MAINTENANCE_FILE, {platform: 'win32'}), 'automatic');

const markerStat = {
  kind: 'file',
  symbolic: false,
  nlink: 1,
  uid: 0,
  gid: 0,
  mode: 0o100644,
  isFile() { return this.kind === 'file'; },
  isSymbolicLink() { return this.symbolic; },
};
assert.deepEqual(cloudMaintenanceCanonicalMarkerSafety(markerStat), []);
assert.match(cloudMaintenanceCanonicalMarkerSafety({...markerStat, symbolic: true}).join('; '), /symbolic link/);
assert.match(cloudMaintenanceCanonicalMarkerSafety({...markerStat, nlink: 2}).join('; '), /hard-link count/);
assert.match(cloudMaintenanceCanonicalMarkerSafety({...markerStat, uid: 1000}).join('; '), /uid must be root/);
assert.match(cloudMaintenanceCanonicalMarkerSafety({...markerStat, gid: 1000}).join('; '), /gid must be root/);
assert.match(cloudMaintenanceCanonicalMarkerSafety({...markerStat, mode: 0o100600}).join('; '), /exactly 0644/);

const lockStat = {...markerStat, mode: 0o100600};
assert.deepEqual(cloudMaintenanceCanonicalLockSafety(lockStat), []);
assert.match(cloudMaintenanceCanonicalLockSafety({...lockStat, nlink: 2}).join('; '), /hard-link count/);
assert.match(cloudMaintenanceCanonicalLockSafety({...lockStat, mode: 0o100644}).join('; '), /exactly 0600/);

const directoryStat = {
  kind: 'directory',
  symbolic: false,
  uid: 0,
  gid: 0,
  mode: 0o40755,
  isDirectory() { return this.kind === 'directory'; },
  isSymbolicLink() { return this.symbolic; },
};
assert.deepEqual(cloudMaintenanceAncestorDirectorySafety(directoryStat, {name: '/var'}), []);
assert.deepEqual(cloudMaintenanceAncestorDirectorySafety(directoryStat, {
  name: CLOUD_MAINTENANCE_CONTROL_DIR,
  exactMode: CLOUD_MAINTENANCE_CONTROL_MODE,
}), []);
assert.match(cloudMaintenanceAncestorDirectorySafety({...directoryStat, mode: 0o40777}, {name: '/var'}).join('; '),
  /group\/world writable/);
assert.match(cloudMaintenanceAncestorDirectorySafety({...directoryStat, mode: 0o40700}, {
  name: CLOUD_MAINTENANCE_CONTROL_DIR,
  exactMode: CLOUD_MAINTENANCE_CONTROL_MODE,
}).join('; '), /exactly 755/);

try {
  if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() !== 0) {
    await assert.rejects(
      pauseCloudMaintenance({
        mode: 'all',
        reason: 'must reject non-root canonical writer before filesystem mutation',
        requestedBy: 'runtime-test',
        expectedGeneration: 0,
        expectedHash: CLOUD_MAINTENANCE_ABSENT_HASH,
      }),
      error => error instanceof CloudMaintenanceConfigurationError && /requires uid 0/.test(error.message),
    );
  }

  const absent = await readCloudMaintenanceStatus(markerFile);
  assert.equal(absent.ok, true);
  assert.equal(absent.exists, false);
  assert.equal(absent.active, false);
  assert.equal(absent.generation, 0);
  assert.match(absent.hash, /^[a-f0-9]{64}$/);

  const guardlessPause = spawnSync(process.execPath, [
    CLI,
    'pause',
    '--file', markerFile,
    '--mode', 'all',
    '--reason', 'must fail before marker publication',
    '--requested-by', 'runtime-test',
    '--expected-generation', String(absent.generation),
    '--expected-hash', absent.hash,
    '--systemd-root', path.join(tempDir, 'missing-systemd'),
  ], {encoding: 'utf8'});
  assert.equal(guardlessPause.status, 1);
  assert.equal(JSON.parse(guardlessPause.stderr).errorCode, 'CLOUD_MAINTENANCE_GUARD_INSTALL_FAILED');
  assert.equal((await readCloudMaintenanceStatus(markerFile)).exists, false,
    'pause must not publish a marker when the effective guard files are absent');

  const business = await pauseCloudMaintenance({
    markerFile,
    mode: 'business',
    reason: 'bounded business maintenance',
    requestedBy: 'runtime-test',
    expectedGeneration: absent.generation,
    expectedHash: absent.hash,
    now: '2026-08-17T01:00:00.000Z',
  });
  assert.equal(business.schemaVersion, CLOUD_MAINTENANCE_SCHEMA_VERSION);
  assert.equal(business.generation, 1);
  assert.equal(business.mode, 'business');
  assert.equal(business.startedAt, '2026-08-17T01:00:00.000Z');
  if (process.platform !== 'win32') {
    const customMarkerStat = await fs.stat(markerFile);
    assert.equal(customMarkerStat.mode & 0o777, 0o600,
      'custom marker paths retain the private legacy mode');
    assert.equal(customMarkerStat.nlink, 1);
  }
  assert.equal((await checkCloudMaintenance({
    markerFile,
    unitClass: 'scheduled',
    unit: 'shein-bi-cloud-morning-chain.service',
  })).exitCode, CLOUD_MAINTENANCE_EXIT_CODES.skipped);
  assert.equal((await checkCloudMaintenance({
    markerFile,
    unitClass: 'infrastructure',
    unit: 'shein-bi-db-backup.service',
  })).exitCode, CLOUD_MAINTENANCE_EXIT_CODES.allowed);

  const systemdBusinessBlock = spawnSync(process.execPath, [
    CLI,
    'systemd-condition',
    '--file', markerFile,
    '--class', 'scheduled',
    '--unit', 'shein-bi-cloud-morning-chain.service',
  ], {encoding: 'utf8'});
  assert.equal(systemdBusinessBlock.status, CLOUD_MAINTENANCE_EXIT_CODES.skipped);
  assert.equal(JSON.parse(systemdBusinessBlock.stdout).command, 'systemd-condition');
  const systemdBusinessInfrastructure = spawnSync(process.execPath, [
    CLI,
    'systemd-condition',
    '--file', markerFile,
    '--class', 'infrastructure',
    '--unit', 'shein-bi-db-backup.service',
  ], {encoding: 'utf8'});
  assert.equal(systemdBusinessInfrastructure.status, CLOUD_MAINTENANCE_EXIT_CODES.allowed);
  assert.equal((await checkCloudMaintenance({
    markerFile,
    unitClass: 'always',
    unit: 'shein-bi-cloud-watchdog.service',
  })).exitCode, CLOUD_MAINTENANCE_EXIT_CODES.allowed);

  await assert.rejects(
    pauseCloudMaintenance({
      markerFile,
      mode: 'all',
      reason: 'stale writer',
      requestedBy: 'runtime-test',
      expectedGeneration: absent.generation,
      expectedHash: absent.hash,
      now: '2026-08-17T01:01:00.000Z',
    }),
    error => error instanceof CloudMaintenanceCasConflictError
      && error.code === 'CLOUD_MAINTENANCE_CAS_CONFLICT',
  );

  const allMode = await pauseCloudMaintenance({
    markerFile,
    mode: 'all',
    reason: 'full infrastructure maintenance',
    requestedBy: 'runtime-test',
    expectedGeneration: business.generation,
    expectedHash: business.hash,
    now: '2026-08-17T01:02:00.000Z',
  });
  assert.equal(allMode.generation, 2);
  assert.equal(allMode.mode, 'all');
  assert.equal(allMode.startedAt, business.startedAt, 'mode escalation preserves maintenance start');
  assert.equal((await checkCloudMaintenance({
    markerFile,
    unitClass: 'scheduled',
    unit: 'shein-bi-cloud-morning-chain.service',
  })).exitCode, CLOUD_MAINTENANCE_EXIT_CODES.skipped);
  assert.equal((await checkCloudMaintenance({
    markerFile,
    unitClass: 'infrastructure',
    unit: 'shein-bi-cloud-disk-maintenance.service',
  })).exitCode, CLOUD_MAINTENANCE_EXIT_CODES.skipped);

  const resumed = await resumeCloudMaintenance({
    markerFile,
    reason: 'maintenance complete',
    requestedBy: 'runtime-test',
    expectedGeneration: allMode.generation,
    expectedHash: allMode.hash,
    now: '2026-08-17T01:03:00.000Z',
  });
  assert.equal(resumed.generation, 3);
  assert.equal(resumed.active, false);
  assert.equal(resumed.mode, 'none');
  assert.equal(resumed.startedAt, business.startedAt);
  assert.equal(resumed.endedAt, '2026-08-17T01:03:00.000Z');
  assert.equal((await checkCloudMaintenance({
    markerFile,
    unitClass: 'scheduled',
    unit: 'shein-bi-cloud-morning-chain.service',
  })).exitCode, CLOUD_MAINTENANCE_EXIT_CODES.allowed);

  const staleMarkerFile = path.join(tempDir, 'stale-lock-maintenance.json');
  const staleAbsent = await readCloudMaintenanceStatus(staleMarkerFile);
  const exitedOwner = spawn(process.execPath, ['-e', 'process.exit(0)'], {stdio: 'ignore'});
  const exitedOwnerPid = exitedOwner.pid;
  await once(exitedOwner, 'exit');
  await fs.writeFile(`${staleMarkerFile}.lock`, `${JSON.stringify({
    pid: exitedOwnerPid,
    nonce: '00000000-0000-4000-8000-000000000001',
    processStart: '',
    createdAt: '2026-08-17T01:03:30.000Z',
  })}\n`, {encoding: 'utf8', mode: 0o600});
  const staleRecovered = await pauseCloudMaintenance({
    markerFile: staleMarkerFile,
    mode: 'business',
    reason: 'recover an orphaned transition lock',
    requestedBy: 'runtime-test',
    expectedGeneration: staleAbsent.generation,
    expectedHash: staleAbsent.hash,
    now: '2026-08-17T01:04:00.000Z',
  });
  assert.equal(staleRecovered.generation, 1);
  await assert.rejects(fs.lstat(`${staleMarkerFile}.lock`), error => error?.code === 'ENOENT');

  const activeMarkerFile = path.join(tempDir, 'active-lock-maintenance.json');
  const activeAbsent = await readCloudMaintenanceStatus(activeMarkerFile);
  await fs.writeFile(`${activeMarkerFile}.lock`, `${JSON.stringify({
    pid: process.pid,
    nonce: '00000000-0000-4000-8000-000000000002',
    processStart: '',
    createdAt: new Date().toISOString(),
  })}\n`, {encoding: 'utf8', mode: 0o600});
  await assert.rejects(
    pauseCloudMaintenance({
      markerFile: activeMarkerFile,
      mode: 'business',
      reason: 'must not steal a live transition lock',
      requestedBy: 'runtime-test',
      expectedGeneration: activeAbsent.generation,
      expectedHash: activeAbsent.hash,
    }),
    error => error instanceof CloudMaintenanceCasConflictError,
  );
  await fs.unlink(`${activeMarkerFile}.lock`);

  const exactReadbackMarkerFile = path.join(tempDir, 'exact-readback-maintenance.json');
  const exactReadbackAbsent = await readCloudMaintenanceStatus(exactReadbackMarkerFile);
  await assert.rejects(
    pauseCloudMaintenance({
      markerFile: exactReadbackMarkerFile,
      mode: 'business',
      reason: 'verify the complete committed marker',
      requestedBy: 'runtime-test',
      expectedGeneration: exactReadbackAbsent.generation,
      expectedHash: exactReadbackAbsent.hash,
      now: '2026-08-17T01:04:30.000Z',
      afterPublish: async ({marker, markerFile: target}) => {
        await fs.writeFile(target, `${JSON.stringify({...marker, reason: 'tampered after publish'}, null, 2)}\n`, 'utf8');
      },
    }),
    error => error instanceof CloudMaintenanceConfigurationError
      && /did not match committed bytes/.test(error.message)
      && error.detail.expectedGeneration === error.detail.actualGeneration
      && error.detail.expectedHash !== error.detail.actualHash,
  );
  const exactReadbackTampered = await readCloudMaintenanceStatus(exactReadbackMarkerFile);
  assert.equal(exactReadbackTampered.ok, true);
  assert.equal(exactReadbackTampered.generation, 1);
  assert.equal(exactReadbackTampered.reason, 'tampered after publish');
  await assert.rejects(fs.lstat(`${exactReadbackMarkerFile}.lock`), error => error?.code === 'ENOENT');

  const cleanupFailureMarkerFile = path.join(tempDir, 'cleanup-failure-maintenance.json');
  const cleanupFailureAbsent = await readCloudMaintenanceStatus(cleanupFailureMarkerFile);
  await assert.rejects(
    pauseCloudMaintenance({
      markerFile: cleanupFailureMarkerFile,
      mode: 'all',
      reason: 'surface an unconfirmed lock cleanup',
      requestedBy: 'runtime-test',
      expectedGeneration: cleanupFailureAbsent.generation,
      expectedHash: cleanupFailureAbsent.hash,
      now: '2026-08-17T01:04:45.000Z',
      afterPublish: async ({lockFile}) => {
        await fs.writeFile(lockFile, 'malformed-lock\n', 'utf8');
      },
    }),
    error => error instanceof CloudMaintenanceLockCleanupError
      && error.code === 'CLOUD_MAINTENANCE_LOCK_CLEANUP_UNCONFIRMED'
      && error.detail.transitionCommitted === true,
  );
  const cleanupFailureCommitted = await readCloudMaintenanceStatus(cleanupFailureMarkerFile);
  assert.equal(cleanupFailureCommitted.ok, true);
  assert.equal(cleanupFailureCommitted.generation, 1);
  assert.equal(cleanupFailureCommitted.active, true);
  await fs.unlink(`${cleanupFailureMarkerFile}.lock`);

  const stolenMarkerFile = path.join(tempDir, 'stolen-lock-maintenance.json');
  const stolenAbsent = await readCloudMaintenanceStatus(stolenMarkerFile);
  await assert.rejects(
    pauseCloudMaintenance({
      markerFile: stolenMarkerFile,
      mode: 'all',
      reason: 'detect lock ownership drift before commit',
      requestedBy: 'runtime-test',
      expectedGeneration: stolenAbsent.generation,
      expectedHash: stolenAbsent.hash,
      beforeCommit: async ({markerFile: target}) => {
        await fs.writeFile(`${target}.lock`, `${JSON.stringify({
          pid: process.pid,
          nonce: '00000000-0000-4000-8000-000000000003',
          processStart: '',
          createdAt: new Date().toISOString(),
        })}\n`, 'utf8');
      },
    }),
    error => error instanceof CloudMaintenanceCasConflictError
      && /ownership changed/.test(error.message),
  );
  assert.equal((await readCloudMaintenanceStatus(stolenMarkerFile)).exists, false,
    'lost lock ownership must be detected before publishing the marker');
  await fs.unlink(`${stolenMarkerFile}.lock`);

  await fs.writeFile(markerFile, '{"schemaVersion":"cloud-maintenance-mode/v1","broken":', 'utf8');
  const corrupt = await readCloudMaintenanceStatus(markerFile);
  assert.equal(corrupt.ok, false);
  assert.equal(corrupt.errorCode, 'MAINTENANCE_MARKER_INVALID_JSON');
  for (const [unitClass, unit] of [
    ['scheduled', 'shein-bi-cloud-morning-chain.service'],
    ['infrastructure', 'shein-bi-db-backup.service'],
  ]) {
    const decision = await checkCloudMaintenance({markerFile, unitClass, unit});
    assert.equal(decision.allowed, false);
    assert.equal(decision.exitCode, CLOUD_MAINTENANCE_EXIT_CODES.configuration);
  }
  assert.equal((await checkCloudMaintenance({
    markerFile,
    unitClass: 'always',
    unit: 'shein-bi-portal.service',
  })).exitCode, CLOUD_MAINTENANCE_EXIT_CODES.allowed);

  const cliCorrupt = spawnSync(process.execPath, [
    CLI,
    'check',
    '--file', markerFile,
    '--class', 'scheduled',
    '--unit', 'shein-bi-cloud-morning-chain.service',
  ], {encoding: 'utf8'});
  assert.equal(cliCorrupt.status, CLOUD_MAINTENANCE_EXIT_CODES.configuration);
  assert.equal(JSON.parse(cliCorrupt.stdout).reason, 'marker_invalid_fail_closed');

  const systemdCorrupt = spawnSync(process.execPath, [
    CLI,
    'systemd-condition',
    '--file', markerFile,
    '--class', 'scheduled',
    '--unit', 'shein-bi-cloud-morning-chain.service',
  ], {encoding: 'utf8'});
  assert.equal(systemdCorrupt.status, CLOUD_MAINTENANCE_EXIT_CODES.systemdConfiguration);
  assert.equal(JSON.parse(systemdCorrupt.stdout).exitCode, CLOUD_MAINTENANCE_EXIT_CODES.systemdConfiguration);

  const systemdClassMismatch = spawnSync(process.execPath, [
    CLI,
    'systemd-condition',
    '--file', markerFile,
    '--class', 'infrastructure',
    '--unit', 'shein-bi-cloud-morning-chain.service',
  ], {encoding: 'utf8'});
  assert.equal(systemdClassMismatch.status, CLOUD_MAINTENANCE_EXIT_CODES.systemdConfiguration);
  assert.equal(JSON.parse(systemdClassMismatch.stdout).reason, 'unit_policy_mismatch');

  const systemdMissingPolicy = spawnSync(process.execPath, [
    CLI,
    'systemd-condition',
    '--file', markerFile,
    '--class', 'scheduled',
    '--unit', 'shein-bi-unknown.service',
  ], {encoding: 'utf8'});
  assert.equal(systemdMissingPolicy.status, CLOUD_MAINTENANCE_EXIT_CODES.systemdConfiguration);
  assert.equal(JSON.parse(systemdMissingPolicy.stdout).reason, 'unit_policy_missing');

  await assert.rejects(
    pauseCloudMaintenance({
      markerFile,
      mode: 'business',
      reason: 'token=must-not-be-recorded',
      requestedBy: 'runtime-test',
      expectedGeneration: 'invalid',
      expectedHash: corrupt.hash,
    }),
    error => error.code === 'CLOUD_MAINTENANCE_CONFIGURATION_ERROR',
  );

  console.log(JSON.stringify({
    ok: true,
    checks: ['canonical_path_contract', 'canonical_marker_stat_contract', 'canonical_lock_stat_contract', 'canonical_ancestor_stat_contract', 'canonical_root_only_mutation', 'canonical_orphan_lock_manual_recovery', 'custom_marker_mode_0600', 'guard_installation_precedes_cli_pause', 'business_mode', 'all_mode', 'atomic_resume', 'cas_conflict', 'orphan_lock_recovery', 'live_lock_preserved', 'exact_marker_hash_readback', 'committed_lock_cleanup_failure', 'lock_ownership_drift', 'corrupt_fail_closed', 'cli_exit_0_1_64', 'systemd_condition_exit_0_1_255', 'secret_rejection'],
  }, null, 2));
} finally {
  await fs.rm(tempDir, {recursive: true, force: true});
}
