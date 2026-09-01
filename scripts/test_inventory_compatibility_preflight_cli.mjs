#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {stableInventoryHash} from '../lib/inventory_replenishment_policy.mjs';
import {inventoryWriteScopeKey} from '../lib/durable_inventory_write.mjs';
import {DEFAULT_CLOUD_MAINTENANCE_FILE} from '../lib/cloud_maintenance_mode.mjs';
import {runInventoryCompatibilityCli} from './inventory/manage_inventory_writer_compatibility.mjs';

const SELF = fileURLToPath(import.meta.url);

async function child() {
  const authorityFile = process.env.TEST_AUTHORITY_FILE;
  const maintenanceFile = process.env.TEST_MAINTENANCE_FILE;
  const authorityReader = async () => ({
    ...JSON.parse(await fs.readFile(authorityFile, 'utf8')),
    // A real capture stamps every process independently. This is the original
    // reviewer counterexample: dry-run and execute can never share capturedAt.
    capturedAt: new Date().toISOString(),
  });
  const maintenanceReader = async () => JSON.parse(await fs.readFile(maintenanceFile, 'utf8'));
  try {
    const result = await runInventoryCompatibilityCli(process.argv.slice(3), {
      authorityReader,
      maintenanceReader,
      ...(process.env.TEST_CRASH_AFTER_APPEND === '1'
        ? {afterAppendHook: async () => { throw new Error('simulated-process-crash-after-registry-append'); }}
        : {}),
    });
    process.stdout.write(`${JSON.stringify({ok: true, ...result})}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ok: false, code: error.code || '', error: error.message})}\n`);
    process.exitCode = 1;
  }
}

async function spawnCli(args, env, {expectExit = 0} = {}) {
  const childProcess = spawn(process.execPath, [SELF, '--child', ...args], {
    env: {...process.env, ...env}, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  childProcess.stdout.on('data', chunk => { stdout += chunk; });
  childProcess.stderr.on('data', chunk => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    childProcess.once('error', reject);
    childProcess.once('exit', resolve);
  });
  assert.equal(exitCode, expectExit, `CLI exit mismatch\nstdout=${stdout}\nstderr=${stderr}`);
  return expectExit === 0 ? JSON.parse(stdout) : {stderr, stdout};
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function artifactArgs(command, artifactFile) {
  const bytes = await fs.readFile(artifactFile);
  const artifact = JSON.parse(bytes);
  return [command, '--execute', '--preflight-artifact', artifactFile,
    '--expected-artifact-sha256', sha256(bytes), '--expected-preflight-hash', artifact.preflightHash,
    '--confirm', {
      activate: 'ACTIVATE_INVENTORY_READER_FIRST_V1',
      'rotation-stage': 'STAGE_INVENTORY_COMPATIBILITY_ROTATION_V1',
      'rotation-finalize': 'FINALIZE_INVENTORY_COMPATIBILITY_ROTATION_V1',
    }[command]];
}

async function parent() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'inventory-compat-preflight-cli-'));
  try {
    const authorityFile = path.join(temp, 'authority.json');
    const maintenanceFile = path.join(temp, 'maintenance.json');
    const activationFile = path.join(temp, 'activation.ndjson');
    const activationReceiptFile = path.join(temp, 'activation.receipt.json');
    const compatibilityFile = path.join(temp, 'compatibility.ndjson');
    const compatibilityReceiptFile = path.join(temp, 'compatibility.receipt.json');
    const journalFile = path.join(temp, 'journal.ndjson');
    const manualReceiptFile = path.join(temp, 'manual.receipt.json');
    const lockFile = path.join(temp, 'cutover.lock');
    const env = {
      TEST_AUTHORITY_FILE: authorityFile,
      TEST_MAINTENANCE_FILE: maintenanceFile,
      SHEIN_BI_INVENTORY_GLOBAL_LOCK_FILE: lockFile,
    };
    const service = generationHash => [{unit: 'shein-bi-portal.service', generationHash}];
    const authorityN = {
      deployedCommit: 'a'.repeat(40), sourceFingerprint: 'b'.repeat(64), bundleSha256: 'c'.repeat(64),
      trackedSourceClean: true, releaseReceiptKind: 'formal', releaseReceiptHash: 'd'.repeat(64),
      releaseReceiptFile: path.join(temp, 'release-n.json'), writerServices: service('e'.repeat(64)),
    };
    const candidate = {
      deployedCommit: '1'.repeat(40), sourceFingerprint: '2'.repeat(64), bundleSha256: '3'.repeat(64),
      trackedSourceClean: true, releaseReceiptKind: 'formal', releaseReceiptHash: '4'.repeat(64),
      releaseReceiptFile: path.join(temp, 'release-n1.json'),
    };
    const maintenance = {ok: true, active: true, mode: 'all', generation: 19, hash: '9'.repeat(64)};
    await fs.writeFile(authorityFile, JSON.stringify(authorityN));
    await fs.writeFile(maintenanceFile, JSON.stringify(maintenance));
    const scopeKey = inventoryWriteScopeKey({
      storeKey: 'XL', skc: 'sb260606205087254179320', skuCode: 'I0mq2cw2khzt47',
      warehouseCode: 'PS0916742261', invType: 'VI',
    });
    const commonDry = [
      '--activation-registry', activationFile, '--activation-receipt', activationReceiptFile,
      '--compatibility-registry', compatibilityFile, '--compatibility-receipt', compatibilityReceiptFile,
      '--maintenance-file', maintenanceFile,
    ];
    const activationArtifact = path.join(temp, 'activate.preflight.json');
    const activationDry = await spawnCli(['activate', ...commonDry,
      '--journal', journalFile, '--manual-receipt', manualReceiptFile, '--scope-key', scopeKey,
      '--out', activationArtifact], env);

    const defaultMaintenanceArtifact = path.join(temp, 'activate.default-maintenance.preflight.json');
    await spawnCli(['activate',
      '--activation-registry', activationFile, '--activation-receipt', activationReceiptFile,
      '--compatibility-registry', compatibilityFile, '--compatibility-receipt', compatibilityReceiptFile,
      '--journal', journalFile, '--manual-receipt', manualReceiptFile, '--scope-key', scopeKey,
      '--out', defaultMaintenanceArtifact], env);
    const defaultMaintenancePreflight = JSON.parse(await fs.readFile(defaultMaintenanceArtifact, 'utf8'));
    assert.equal(defaultMaintenancePreflight.invocation.maintenanceFile, path.resolve(DEFAULT_CLOUD_MAINTENANCE_FILE));

    const tamperedFile = path.join(temp, 'activate.tampered.json');
    const tampered = JSON.parse(await fs.readFile(activationArtifact, 'utf8'));
    tampered.authority.sourceFingerprint = 'f'.repeat(64);
    await fs.writeFile(tamperedFile, `${JSON.stringify(tampered, null, 2)}\n`);
    let rejected = await spawnCli([
      'activate', '--execute', '--preflight-artifact', tamperedFile,
      '--expected-artifact-sha256', sha256(await fs.readFile(tamperedFile)),
      '--expected-preflight-hash', tampered.preflightHash,
      '--confirm', 'ACTIVATE_INVENTORY_READER_FIRST_V1',
    ], env, {expectExit: 1});
    assert.match(rejected.stderr, /PREFLIGHT_ARTIFACT_INVALID/);

    const forkedDomainFile = path.join(temp, 'activate.forked-domain.json');
    const forkedDomain = JSON.parse(await fs.readFile(activationArtifact, 'utf8'));
    const originalApprovalHash = forkedDomain.preflightHash;
    const forkedRoot = path.join(temp, 'forged-control-domain');
    for (const key of ['activationFile', 'activationReceiptFile', 'compatibilityFile', 'compatibilityReceiptFile', 'lockFile']) {
      forkedDomain.invocation[key] = path.join(forkedRoot, path.basename(forkedDomain.invocation[key]));
    }
    const {artifactHash: _forkedArtifactHash, ...forkedCore} = forkedDomain;
    forkedDomain.artifactHash = stableInventoryHash(forkedCore);
    await fs.writeFile(forkedDomainFile, `${JSON.stringify(forkedDomain, null, 2)}\n`);
    rejected = await spawnCli([
      'activate', '--execute', '--preflight-artifact', forkedDomainFile,
      '--expected-artifact-sha256', sha256(await fs.readFile(forkedDomainFile)),
      '--expected-preflight-hash', originalApprovalHash,
      '--confirm', 'ACTIVATE_INVENTORY_READER_FIRST_V1',
    ], env, {expectExit: 1});
    assert.match(rejected.stderr, /PREFLIGHT_ARTIFACT_INVALID/);
    await assert.rejects(fs.access(path.join(forkedRoot, path.basename(activationFile))));

    const expiredFile = path.join(temp, 'activate.expired.json');
    const expired = JSON.parse(await fs.readFile(activationArtifact, 'utf8'));
    expired.createdAt = '2026-01-01T00:00:00.000Z';
    expired.expiresAt = '2026-01-01T00:01:00.000Z';
    const {
      artifactHash: _oldArtifactHash,
      preflightHash: _oldApprovalHash,
      ...expiredApprovalCore
    } = expired;
    expired.preflightHash = stableInventoryHash(expiredApprovalCore);
    expired.artifactHash = stableInventoryHash({...expiredApprovalCore, preflightHash: expired.preflightHash});
    await fs.writeFile(expiredFile, `${JSON.stringify(expired, null, 2)}\n`);
    rejected = await spawnCli([
      'activate', '--execute', '--preflight-artifact', expiredFile,
      '--expected-artifact-sha256', sha256(await fs.readFile(expiredFile)),
      '--expected-preflight-hash', expired.preflightHash,
      '--confirm', 'ACTIVATE_INVENTORY_READER_FIRST_V1',
    ], env, {expectExit: 1});
    assert.match(rejected.stderr, /PREFLIGHT_ARTIFACT_EXPIRED/);

    for (const [label, mutate] of [
      ['source', value => ({...value, sourceFingerprint: '0'.repeat(64)})],
      ['receipt', value => ({...value, releaseReceiptHash: '8'.repeat(64)})],
    ]) {
      await fs.writeFile(authorityFile, JSON.stringify(mutate(authorityN)));
      rejected = await spawnCli(await artifactArgs('activate', activationArtifact), env, {expectExit: 1});
      assert.match(rejected.stderr, /PREFLIGHT_AUTHORITY_DRIFT/, `${label} drift must reject`);
      await fs.writeFile(authorityFile, JSON.stringify(authorityN));
    }
    await fs.writeFile(maintenanceFile, JSON.stringify({...maintenance, generation: 20}));
    rejected = await spawnCli(await artifactArgs('activate', activationArtifact), env, {expectExit: 1});
    assert.match(rejected.stderr, /PREFLIGHT_MAINTENANCE_DRIFT/);
    await fs.writeFile(maintenanceFile, JSON.stringify(maintenance));

    const activationExecuted = await spawnCli(await artifactArgs('activate', activationArtifact), env);
    assert.equal(activationExecuted.preflightHash, activationDry.preflightHash);
    assert.equal(activationExecuted.activation.activatedAt, activationDry.activation.activatedAt);

    const stageArtifact = path.join(temp, 'stage.preflight.json');
    await spawnCli(['rotation-stage', ...commonDry,
      '--candidate-commit', candidate.deployedCommit,
      '--candidate-source-fingerprint', candidate.sourceFingerprint,
      '--candidate-bundle-sha256', candidate.bundleSha256,
      '--candidate-release-receipt-kind', candidate.releaseReceiptKind,
      '--candidate-release-receipt-hash', candidate.releaseReceiptHash,
      '--candidate-release-receipt-file', candidate.releaseReceiptFile,
      '--out', stageArtifact], env);
    rejected = await spawnCli(await artifactArgs('rotation-stage', stageArtifact), {...env, TEST_CRASH_AFTER_APPEND: '1'}, {expectExit: 1});
    assert.match(rejected.stderr, /simulated-process-crash-after-registry-append/);
    const stageRecovered = await spawnCli(await artifactArgs('rotation-stage', stageArtifact), env);
    assert.equal(stageRecovered.state, 'rotation_stage_recovered');

    await fs.writeFile(authorityFile, JSON.stringify({...candidate, writerServices: service('5'.repeat(64))}));
    const finalizeArtifact = path.join(temp, 'finalize.preflight.json');
    await spawnCli(['rotation-finalize', ...commonDry, '--out', finalizeArtifact], env);
    rejected = await spawnCli(await artifactArgs('rotation-finalize', finalizeArtifact), {...env, TEST_CRASH_AFTER_APPEND: '1'}, {expectExit: 1});
    assert.match(rejected.stderr, /simulated-process-crash-after-registry-append/);
    const finalizeRecovered = await spawnCli(await artifactArgs('rotation-finalize', finalizeArtifact), env);
    assert.equal(finalizeRecovered.state, 'rotation_finalize_receipt_recovered');
    assert.equal((await fs.readFile(compatibilityFile, 'utf8')).trim().split(/\r?\n/u).length, 3);

    console.log(JSON.stringify({ok: true, checks: [
      'activation_dry_run_and_execute_are_distinct_cli_processes_with_captured_at_drift',
      'immutable_artifact_file_sha_internal_hash_and_expiry_fail_closed',
      'approval_hash_binds_exact_control_and_lock_domain_against_public_rehash',
      'source_receipt_and_maintenance_drift_fail_closed',
      'stage_two_process_exact_artifact_and_append_crash_recovery',
      'finalize_two_process_exact_artifact_and_append_crash_recovery',
      'recorded_at_and_proposed_record_are_reproduced_exactly',
    ]}, null, 2));
  } finally {
    await fs.rm(temp, {recursive: true, force: true});
  }
}

if (process.argv[2] === '--child') await child();
else await parent();
