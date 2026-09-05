#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  controlInventoryCutoverActivation,
  finalizeInventoryCompatibilityRotation,
  inventoryCompatibilityAuthority,
  inventoryCompatibilityStatus,
  readInventoryWriterServiceStates,
  requireCurrentInventoryCutoverActivation,
  stageInventoryCompatibilityRotation,
} from '../lib/inventory_write_cutover.mjs';
import {inventoryWriteScopeKey} from '../lib/durable_inventory_write.mjs';
import {stableInventoryHash} from '../lib/inventory_replenishment_policy.mjs';
import {runInventoryCompatibilityCli} from './inventory/manage_inventory_writer_compatibility.mjs';

const requestedOutputDir = String(process.env.INVENTORY_COMPATIBILITY_TEST_OUTPUT_DIR || '').trim();
const temp = requestedOutputDir
  ? path.resolve(requestedOutputDir)
  : await fs.mkdtemp(path.join(os.tmpdir(), 'inventory-compatibility-rotation-'));
if (requestedOutputDir) await fs.mkdir(temp);
const activationFile = path.join(temp, 'activation.ndjson');
const activationReceiptFile = path.join(temp, 'activation.receipt.json');
const compatibilityFile = path.join(temp, 'compatibility.ndjson');
const compatibilityReceiptFile = path.join(temp, 'compatibility.receipt.json');
const lockFile = path.join(temp, 'cutover.lock');
const journalFile = path.join(temp, 'journal.ndjson');
const manualReceiptFile = path.join(temp, 'manual.receipt.json');
const commonPaths = {activationFile, activationReceiptFile, compatibilityFile, compatibilityReceiptFile};
const maintenance = {ok: true, active: true, mode: 'all', generation: 19, hash: '9'.repeat(64)};
const quiescentServices = await readInventoryWriterServiceStates(
  ['shein-bi-daily-inventory-replenishment-guard.service'],
  {execFileImpl: async () => ({stdout: [
    'LoadState=loaded', 'ActiveState=inactive', 'SubState=dead', 'MainPID=0',
    'ExecMainStartTimestamp=', 'NRestarts=0', '',
  ].join('\n')})},
);
assert.equal(quiescentServices.length, 1);
assert.match(quiescentServices[0].generationHash, /^[a-f0-9]{64}$/u);
const service = generationHash => [
  {unit: 'shein-bi-daily-inventory-replenishment-guard.service', generationHash},
  {unit: 'shein-bi-et-low-inventory-guard.service', generationHash},
  {unit: 'shein-bi-et-low-inventory-recheck.service', generationHash},
];
const authorityN = {
  deployedCommit: 'a'.repeat(40), sourceFingerprint: 'b'.repeat(64), bundleSha256: 'c'.repeat(64),
  trackedSourceClean: true, releaseReceiptKind: 'formal', releaseReceiptHash: 'd'.repeat(64),
  releaseReceiptFile: path.join(temp, 'release-n.json'), writerServices: service('e'.repeat(64)),
  capturedAt: '2026-08-27T01:00:00.000Z',
};
const candidate = {
  deployedCommit: '1'.repeat(40), sourceFingerprint: '2'.repeat(64), bundleSha256: '3'.repeat(64),
  trackedSourceClean: true, releaseReceiptKind: 'formal', releaseReceiptHash: '4'.repeat(64),
  releaseReceiptFile: path.join(temp, 'release-n1.json'),
};
const authorityN1 = {
  ...candidate, sourceFingerprint: '8'.repeat(64),
  writerServices: service('5'.repeat(64)), capturedAt: '2026-08-27T01:20:00.000Z',
};
const requiredManualResolution = {
  intentId: 'e07f999c-96b2-460c-bfa9-fa924f410ec3',
  scopeKey: inventoryWriteScopeKey({
    storeKey: 'XL', skc: 'sb260606205087254179320', skuCode: 'I0mq2cw2khzt47',
    warehouseCode: 'PS0916742261', invType: 'VI',
  }),
  journalFile, receiptFile: manualReceiptFile,
};

const initialOptions = {
  ...commonPaths, requiredManualResolution, authorityReader: async () => authorityN,
  maintenanceReader: async () => maintenance, now: () => new Date('2026-08-27T01:01:00.000Z'), lockFile,
};
const initialDry = await controlInventoryCutoverActivation(initialOptions);
assert.equal(initialDry.mode, 'dry-run');
await assert.rejects(controlInventoryCutoverActivation({...initialOptions, mode: 'execute', expectedPreflightHash: 'f'.repeat(64)}), /PREFLIGHT_HASH_MISMATCH/);
const initial = await controlInventoryCutoverActivation({...initialOptions, mode: 'execute', expectedPreflightHash: initialDry.preflightHash});
assert.equal(initial.readback.compatibility.activeGeneration, 1);

const restartN = {...authorityN, writerServices: service('6'.repeat(64)), capturedAt: '2026-08-27T01:05:00.000Z'};
assert.equal((await requireCurrentInventoryCutoverActivation({...commonPaths, authorityReader: async () => restartN})).activated, true);

const fingerprintDriftN = {...restartN, sourceFingerprint: '9'.repeat(64)};
const stageOptions = {
  ...commonPaths, candidateAuthority: candidate, authorityReader: async () => fingerprintDriftN,
  maintenanceReader: async () => maintenance, now: () => new Date('2026-08-27T01:10:00.000Z'), lockFile,
};
const stageDry = await stageInventoryCompatibilityRotation(stageOptions);
let stageInterrupted = false;
await assert.rejects(stageInventoryCompatibilityRotation({
  ...stageOptions, mode: 'execute', expectedPreflightHash: stageDry.preflightHash,
  afterAppendHook: async () => { stageInterrupted = true; throw new Error('simulated-stage-crash'); },
}), /simulated-stage-crash/);
assert.equal(stageInterrupted, true);
const staged = await stageInventoryCompatibilityRotation({...stageOptions, mode: 'execute', expectedPreflightHash: stageDry.preflightHash});
assert.equal(staged.state, 'rotation_stage_recovered');
assert.equal(staged.record.candidateAuthority.sourceFingerprint, candidate.sourceFingerprint);
assert.equal((await requireCurrentInventoryCutoverActivation({...commonPaths, authorityReader: async () => restartN})).activated, true);
const stagedFromLiveCandidate = await stageInventoryCompatibilityRotation({
  ...stageOptions, authorityReader: async () => authorityN1,
});
assert.equal(stagedFromLiveCandidate.state, 'rotation_already_staged');
await assert.rejects(stageInventoryCompatibilityRotation({
  ...stageOptions,
  candidateAuthority: {...candidate, sourceFingerprint: '6'.repeat(64)},
  authorityReader: async () => authorityN1,
}), error => {
  assert.equal(error.code, 'INVENTORY_CUTOVER_ROTATION_ALREADY_STAGED');
  return true;
});
await assert.rejects(requireCurrentInventoryCutoverActivation({...commonPaths, authorityReader: async () => authorityN1}), /ROTATION_NOT_FINALIZED/);

const finalizeOptions = {
  ...commonPaths, authorityReader: async () => authorityN1, maintenanceReader: async () => maintenance,
  now: () => new Date('2026-08-27T01:21:00.000Z'), lockFile,
};
for (const [field, value] of [
  ['deployedCommit', '6'.repeat(40)],
  ['bundleSha256', '7'.repeat(64)],
  ['releaseReceiptKind', 'emergency'],
  ['releaseReceiptHash', 'a'.repeat(64)],
  ['releaseReceiptFile', path.join(temp, 'different-release.json')],
]) {
  await assert.rejects(finalizeInventoryCompatibilityRotation({
    ...finalizeOptions, authorityReader: async () => ({...authorityN1, [field]: value}),
  }), error => {
    assert.equal(error.code, 'INVENTORY_CUTOVER_ROTATION_CANDIDATE_NOT_DEPLOYED', field);
    return true;
  });
}
await assert.rejects(finalizeInventoryCompatibilityRotation({
  ...finalizeOptions, authorityReader: async () => ({...authorityN1, trackedSourceClean: false}),
}), error => {
  assert.equal(error.code, 'INVENTORY_CUTOVER_DEPLOYMENT_AUTHORITY_INVALID');
  return true;
});
const finalizeDry = await finalizeInventoryCompatibilityRotation(finalizeOptions);
assert.notEqual(candidate.sourceFingerprint, authorityN1.sourceFingerprint);
assert.equal(finalizeDry.record.authority.sourceFingerprint, authorityN1.sourceFingerprint);
let finalizeInterrupted = false;
await assert.rejects(finalizeInventoryCompatibilityRotation({
  ...finalizeOptions, mode: 'execute', expectedPreflightHash: finalizeDry.preflightHash,
  afterAppendHook: async () => { finalizeInterrupted = true; throw new Error('simulated-finalize-crash'); },
}), /simulated-finalize-crash/);
assert.equal(finalizeInterrupted, true);
const finalized = await finalizeInventoryCompatibilityRotation({...finalizeOptions, mode: 'execute', expectedPreflightHash: finalizeDry.preflightHash});
assert.equal(finalized.state, 'rotation_finalize_receipt_recovered');
assert.equal(finalized.record.authority.sourceFingerprint, authorityN1.sourceFingerprint);
await assert.rejects(requireCurrentInventoryCutoverActivation({...commonPaths, authorityReader: async () => restartN}), /ROLLBACK_OR_DEPLOYMENT_DRIFT/);
const fingerprintMismatchN1 = {...authorityN1, sourceFingerprint: candidate.sourceFingerprint};
assert.equal((await requireCurrentInventoryCutoverActivation({
  ...commonPaths,
  authorityReader: async () => fingerprintMismatchN1,
})).compatibility.activeGeneration, 2);
for (const [field, value] of [
  ['deployedCommit', 'f'.repeat(40)],
  ['bundleSha256', 'e'.repeat(64)],
  ['releaseReceiptKind', 'emergency'],
  ['releaseReceiptHash', 'd'.repeat(64)],
  ['releaseReceiptFile', path.join(temp, 'unexpected-release.json')],
]) {
  await assert.rejects(requireCurrentInventoryCutoverActivation({
    ...commonPaths,
    authorityReader: async () => ({...authorityN1, [field]: value}),
  }), /ROLLBACK_OR_DEPLOYMENT_DRIFT/);
}
await assert.rejects(requireCurrentInventoryCutoverActivation({
  ...commonPaths,
  authorityReader: async () => ({...authorityN1, trackedSourceClean: false}),
}), /INVENTORY_CUTOVER_DEPLOYMENT_AUTHORITY_INVALID/);
const restartN1 = {...authorityN1, writerServices: service('7'.repeat(64)), capturedAt: '2026-08-27T01:25:00.000Z'};
assert.equal((await requireCurrentInventoryCutoverActivation({...commonPaths, authorityReader: async () => restartN1})).compatibility.activeGeneration, 2);

const status = await inventoryCompatibilityStatus(commonPaths);
assert.equal(status.ok, true);
assert.equal(status.activeGeneration, 2);
assert.equal(status.pendingStage, null);
assert.deepEqual(status.activeAuthority, inventoryCompatibilityAuthority(authorityN1));
assert.equal((await fs.readFile(compatibilityFile, 'utf8')).trim().split(/\r?\n/u).length, 3);
const cliStatus = await runInventoryCompatibilityCli([
  'status', '--activation-registry', activationFile, '--activation-receipt', activationReceiptFile,
  '--compatibility-registry', compatibilityFile, '--compatibility-receipt', compatibilityReceiptFile,
]);
assert.equal(cliStatus.activeGeneration, 2);

// A release may have reached the checkout before the compatibility journal was
// rotated.  The exact current candidate must be stageable for recovery, while
// a different current release remains rejected.
const recoveryTemp = await fs.mkdtemp(path.join(os.tmpdir(), 'inventory-compatibility-recovery-'));
const recoveryPaths = {
  activationFile: path.join(recoveryTemp, 'activation.ndjson'),
  activationReceiptFile: path.join(recoveryTemp, 'activation.receipt.json'),
  compatibilityFile: path.join(recoveryTemp, 'compatibility.ndjson'),
  compatibilityReceiptFile: path.join(recoveryTemp, 'compatibility.receipt.json'),
};
const recoveryLockFile = path.join(recoveryTemp, 'cutover.lock');
const recoveryAuthority = {...authorityN, capturedAt: '2026-08-27T02:00:00.000Z'};
const recoveryCandidate = {
  ...candidate,
  sourceFingerprint: recoveryAuthority.sourceFingerprint,
  writerServices: service('5'.repeat(64)),
  capturedAt: '2026-08-27T02:01:00.000Z',
};
const recoveryActivationDry = await controlInventoryCutoverActivation({
  ...recoveryPaths,
  requiredManualResolution,
  authorityReader: async () => recoveryAuthority,
  maintenanceReader: async () => maintenance,
  now: () => new Date('2026-08-27T02:00:00.000Z'),
  lockFile: recoveryLockFile,
});
const recoveryActivation = await controlInventoryCutoverActivation({
  ...recoveryPaths,
  requiredManualResolution,
  authorityReader: async () => recoveryAuthority,
  maintenanceReader: async () => maintenance,
  now: () => new Date('2026-08-27T02:00:00.000Z'),
  lockFile: recoveryLockFile,
  mode: 'execute', expectedPreflightHash: recoveryActivationDry.preflightHash,
});
const recoveryStageDry = await stageInventoryCompatibilityRotation({
  ...recoveryPaths,
  candidateAuthority: recoveryCandidate,
  authorityReader: async () => recoveryCandidate,
  maintenanceReader: async () => maintenance,
  now: () => new Date('2026-08-27T02:01:00.000Z'),
  lockFile: recoveryLockFile,
});
assert.equal(recoveryActivation.mode, 'execute');
assert.equal(recoveryStageDry.state, 'rotation_stage_dry_run');
assert.equal(recoveryStageDry.authority.deployedCommit, recoveryCandidate.deployedCommit);
await assert.rejects(stageInventoryCompatibilityRotation({
  ...recoveryPaths,
  candidateAuthority: recoveryCandidate,
  authorityReader: async () => ({...recoveryCandidate, deployedCommit: 'f'.repeat(40)}),
  maintenanceReader: async () => maintenance,
  now: () => new Date('2026-08-27T02:01:00.000Z'),
  lockFile: recoveryLockFile,
}), error => {
  assert.equal(error.code, 'INVENTORY_CUTOVER_ROTATION_CURRENT_AUTHORITY_INVALID');
  return true;
});
await assert.rejects(stageInventoryCompatibilityRotation({
  ...recoveryPaths,
  candidateAuthority: recoveryCandidate,
  authorityReader: async () => ({...recoveryCandidate, sourceFingerprint: '9'.repeat(64)}),
  maintenanceReader: async () => maintenance,
  now: () => new Date('2026-08-27T02:01:00.000Z'),
  lockFile: recoveryLockFile,
}), error => {
  assert.equal(error.code, 'INVENTORY_CUTOVER_ROTATION_CURRENT_AUTHORITY_INVALID');
  return true;
});
await assert.rejects(runInventoryCompatibilityCli(['rotation-finalize', '--execute']), /CONFIRMATION_REQUIRED/);
await assert.rejects(runInventoryCompatibilityCli(['status', '--execute']), /status is read-only/);
await assert.rejects(runInventoryCompatibilityCli(['status', '--dry-run', '--execute']), /mutually exclusive/);

const validCompatibilityBytes = await fs.readFile(compatibilityFile);
const validCompatibilityRecords = validCompatibilityBytes.toString('utf8')
  .split(/\r?\n/u).filter(line => line.trim()).map(line => JSON.parse(line));
try {
  for (const kind of ['compatibility_rotation_staged', 'compatibility_rotation_finalized']) {
    const mutated = structuredClone(validCompatibilityRecords);
    const record = mutated.find(row => row.kind === kind);
    record.currentStateHash = 'not-a-hash';
    const {recordHash: _recordHash, ...core} = record;
    record.recordHash = stableInventoryHash(core);
    await fs.writeFile(compatibilityFile, `${mutated.map(row => JSON.stringify(row)).join('\n')}\n`);
    await assert.rejects(inventoryCompatibilityStatus(commonPaths), error => {
      assert.equal(error.code, 'INVENTORY_CUTOVER_COMPATIBILITY_RECORD_INVALID', kind);
      assert.match(error.message, new RegExp(kind === 'compatibility_rotation_staged' ? 'stage chain' : 'finalize chain'));
      return true;
    });
  }
} finally {
  await fs.writeFile(compatibilityFile, validCompatibilityBytes);
}


// --- Formal inventory authority rotation test with stable attestation receipt ---
const formalAttestationSha = 'e1'.repeat(32);
const formalBundleSha = 'e2'.repeat(32);
const formalCandidate = {
  deployedCommit: '3'.repeat(40),
  sourceFingerprint: '4'.repeat(64),
  bundleSha256: formalBundleSha,
  trackedSourceClean: true,
  releaseReceiptKind: 'formal',
  releaseReceiptHash: formalAttestationSha,
  releaseReceiptFile: path.join(temp, 'formal-release-attestation.json'),
};

// Stage the formal candidate
const formalStageDry = await stageInventoryCompatibilityRotation({
  ...commonPaths,
  candidateAuthority: formalCandidate,
  authorityReader: async () => restartN1,
  maintenanceReader: async () => maintenance,
  now: () => new Date('2026-08-27T02:00:00.000Z'),
  lockFile,
});
assert.equal(formalStageDry.state, 'rotation_stage_dry_run');
assert.equal(formalStageDry.record.candidateAuthority.releaseReceiptKind, 'formal');
assert.equal(formalStageDry.record.candidateAuthority.releaseReceiptHash, formalAttestationSha);
assert.equal(formalStageDry.record.candidateAuthority.bundleSha256, formalBundleSha);

const formalStaged = await stageInventoryCompatibilityRotation({
  ...commonPaths,
  candidateAuthority: formalCandidate,
  authorityReader: async () => restartN1,
  maintenanceReader: async () => maintenance,
  now: () => new Date('2026-08-27T02:00:00.000Z'),
  lockFile,
  mode: 'execute',
  expectedPreflightHash: formalStageDry.preflightHash,
});
assert.equal(formalStaged.state, 'rotation_staged');
assert.equal(formalStaged.record.candidateAuthority.releaseReceiptKind, 'formal');

// Live authority matches formalCandidate, with services
const formalLiveAuthority = {
  ...formalCandidate,
  writerServices: service('7'.repeat(64)),
  capturedAt: '2026-08-27T03:00:00.000Z',
};

// Finalize formal candidate
const formalFinalizeDry = await finalizeInventoryCompatibilityRotation({
  ...commonPaths,
  authorityReader: async () => formalLiveAuthority,
  maintenanceReader: async () => maintenance,
  now: () => new Date('2026-08-27T03:00:00.000Z'),
  lockFile,
});
assert.equal(formalFinalizeDry.state, 'rotation_finalize_dry_run');
assert.equal(formalFinalizeDry.record.authority.releaseReceiptKind, 'formal');
assert.equal(formalFinalizeDry.record.authority.releaseReceiptHash, formalAttestationSha);

const formalFinalized = await finalizeInventoryCompatibilityRotation({
  ...commonPaths,
  authorityReader: async () => formalLiveAuthority,
  maintenanceReader: async () => maintenance,
  now: () => new Date('2026-08-27T03:00:00.000Z'),
  lockFile,
  mode: 'execute',
  expectedPreflightHash: formalFinalizeDry.preflightHash,
});
assert.equal(formalFinalized.state, 'rotation_finalized');

// Verify active authority
const formalStatus = await inventoryCompatibilityStatus(commonPaths);
assert.equal(formalStatus.activeAuthority.releaseReceiptKind, 'formal');
assert.equal(formalStatus.activeAuthority.releaseReceiptHash, formalAttestationSha);
assert.equal(formalStatus.activeAuthority.bundleSha256, formalBundleSha);

// Verify activation requirement succeeds
const formalActivation = await requireCurrentInventoryCutoverActivation({
  ...commonPaths,
  authorityReader: async () => formalLiveAuthority,
});
assert.equal(formalActivation.activated, true);
assert.equal(formalActivation.activeAuthority.releaseReceiptKind, 'formal');
assert.equal(formalActivation.compatibility.activeGeneration, 3);


console.log(JSON.stringify({
  ok: true,
  checks: [
    'initial_activation_default_dry_run_exact_hash_and_readback',
    'same_commit_portal_restart_does_not_self_lock',
    'rotation_stage_append_crash_recovers_same_hash',
    'stage_binds_full_candidate_authority_and_live_candidate_recovers_by_release_identity',
    'stale_active_generation_recovers_only_with_exact_current_candidate',
    'staged_candidate_starts_but_writer_reader_fails_closed_until_finalize',
    'commit_bundle_receipt_and_clean_drift_rejected_before_finalize',
    'fingerprint_only_migration_finalizes_to_live_authority',
    'rotation_finalize_append_crash_recovers_same_hash',
    'generation_n_plus_one_finalizes_and_old_n_rolls_back_fail_closed',
    'finalized_active_authority_permits_fingerprint_mismatch_and_rejects_core_release_identity_drift',
    'new_generation_restart_remains_compatible',
    'compatibility_records_are_append_only_and_status_cli_reads_generation',
    'stage_and_finalize_current_state_hash_require_hex64',
    'execute_cli_requires_exact_confirmation',
    'status_is_read_only_and_cli_modes_are_mutually_exclusive',
    'formal_inventory_authority_rotation_stages_and_finalizes_with_stable_receipt',
  ],
}, null, 2));
