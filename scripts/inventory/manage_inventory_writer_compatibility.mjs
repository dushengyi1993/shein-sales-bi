#!/usr/bin/env node

import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  assertInventoryCompatibilityPreflightFreshFacts,
  buildInventoryCompatibilityPreflightArtifact,
  captureInventoryCutoverDeploymentAuthority,
  controlInventoryCutoverActivation,
  finalizeInventoryCompatibilityRotation,
  inventoryCompatibilityStatus,
  inventoryCutoverLockFile,
  readInventoryCompatibilityPreflightArtifact,
  stageInventoryCompatibilityRotation,
  writeInventoryCompatibilityPreflightArtifact,
} from '../../lib/inventory_write_cutover.mjs';
import {
  DEFAULT_CLOUD_MAINTENANCE_FILE,
  readCloudMaintenanceStatus,
} from '../../lib/cloud_maintenance_mode.mjs';
import {INVENTORY_MANUAL_RESOLUTION_INTENT_ID} from '../../lib/durable_inventory_write.mjs';
import {stableInventoryHash} from '../../lib/inventory_replenishment_policy.mjs';

const CONFIRM = Object.freeze({
  activate: 'ACTIVATE_INVENTORY_READER_FIRST_V1',
  'rotation-stage': 'STAGE_INVENTORY_COMPATIBILITY_ROTATION_V1',
  'rotation-finalize': 'FINALIZE_INVENTORY_COMPATIBILITY_ROTATION_V1',
});

function text(value) { return String(value ?? '').trim(); }
function next(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`INVENTORY_COMPATIBILITY_CLI_ARGUMENT_MISSING:${option}`);
  return value;
}

function parseArgs(argv) {
  const args = {
    command: text(argv[0]), mode: 'dry-run', expectedPreflightHash: '', confirm: '',
    modeOption: '',
    activationFile: '', activationReceiptFile: '', compatibilityFile: '', compatibilityReceiptFile: '',
    maintenanceFile: '', recordedAt: '', journalFile: '', manualReceiptFile: '', scopeKey: '',
    outFile: '', preflightArtifactFile: '', expectedArtifactSha256: '', bindingOptionSeen: false,
    candidateCommit: '', candidateSourceFingerprint: '', candidateBundleSha256: '',
    candidateReleaseReceiptKind: '', candidateReleaseReceiptHash: '', candidateReleaseReceiptFile: '',
  };
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--execute' || option === '--dry-run') {
      const selected = option === '--execute' ? 'execute' : 'dry-run';
      if (args.modeOption && args.modeOption !== selected) {
        throw new Error('INVENTORY_COMPATIBILITY_CLI_MODE_INVALID:--dry-run and --execute are mutually exclusive');
      }
      args.mode = selected;
      args.modeOption = selected;
    }
    else if (option === '--expected-preflight-hash') { args.expectedPreflightHash = next(argv, index, option); index += 1; }
    else if (option === '--confirm') { args.confirm = next(argv, index, option); index += 1; }
    else if (option === '--expected-artifact-sha256') { args.expectedArtifactSha256 = next(argv, index, option); index += 1; }
    else if (option === '--preflight-artifact') { args.preflightArtifactFile = path.resolve(next(argv, index, option)); index += 1; }
    else if (option === '--out') { args.outFile = path.resolve(next(argv, index, option)); index += 1; }
    else if (option === '--activation-registry') { args.activationFile = path.resolve(next(argv, index, option)); args.bindingOptionSeen = true; index += 1; }
    else if (option === '--activation-receipt') { args.activationReceiptFile = path.resolve(next(argv, index, option)); args.bindingOptionSeen = true; index += 1; }
    else if (option === '--compatibility-registry') { args.compatibilityFile = path.resolve(next(argv, index, option)); args.bindingOptionSeen = true; index += 1; }
    else if (option === '--compatibility-receipt') { args.compatibilityReceiptFile = path.resolve(next(argv, index, option)); args.bindingOptionSeen = true; index += 1; }
    else if (option === '--maintenance-file') { args.maintenanceFile = path.resolve(next(argv, index, option)); args.bindingOptionSeen = true; index += 1; }
    else if (option === '--recorded-at') { args.recordedAt = next(argv, index, option); args.bindingOptionSeen = true; index += 1; }
    else if (option === '--journal') { args.journalFile = path.resolve(next(argv, index, option)); args.bindingOptionSeen = true; index += 1; }
    else if (option === '--manual-receipt') { args.manualReceiptFile = path.resolve(next(argv, index, option)); args.bindingOptionSeen = true; index += 1; }
    else if (option === '--scope-key') { args.scopeKey = next(argv, index, option); args.bindingOptionSeen = true; index += 1; }
    else if (option === '--candidate-commit') { args.candidateCommit = next(argv, index, option); args.bindingOptionSeen = true; index += 1; }
    else if (option === '--candidate-source-fingerprint') { args.candidateSourceFingerprint = next(argv, index, option); args.bindingOptionSeen = true; index += 1; }
    else if (option === '--candidate-bundle-sha256') { args.candidateBundleSha256 = next(argv, index, option); args.bindingOptionSeen = true; index += 1; }
    else if (option === '--candidate-release-receipt-kind') { args.candidateReleaseReceiptKind = next(argv, index, option); args.bindingOptionSeen = true; index += 1; }
    else if (option === '--candidate-release-receipt-hash') { args.candidateReleaseReceiptHash = next(argv, index, option); args.bindingOptionSeen = true; index += 1; }
    else if (option === '--candidate-release-receipt-file') { args.candidateReleaseReceiptFile = path.resolve(next(argv, index, option)); args.bindingOptionSeen = true; index += 1; }
    else throw new Error(`INVENTORY_COMPATIBILITY_CLI_ARGUMENT_INVALID:${option}`);
  }
  if (!['activate', 'rotation-stage', 'rotation-finalize', 'status'].includes(args.command)) {
    throw new Error('INVENTORY_COMPATIBILITY_CLI_COMMAND_REQUIRED:activate|rotation-stage|rotation-finalize|status');
  }
  if (args.command === 'status' && args.mode === 'execute') {
    throw new Error('INVENTORY_COMPATIBILITY_CLI_MODE_INVALID:status is read-only');
  }
  if (args.mode === 'execute' && args.confirm !== CONFIRM[args.command]) {
    throw new Error(`INVENTORY_COMPATIBILITY_CLI_CONFIRMATION_REQUIRED:${CONFIRM[args.command] || ''}`);
  }
  if (args.command !== 'status' && args.mode === 'dry-run' && !args.outFile) {
    throw new Error('INVENTORY_COMPATIBILITY_CLI_PREFLIGHT_OUT_REQUIRED:dry-run requires --out immutable-artifact.json');
  }
  if (args.mode === 'execute' && (!args.preflightArtifactFile
    || !/^[a-f0-9]{64}$/u.test(args.expectedArtifactSha256))) {
    throw new Error('INVENTORY_COMPATIBILITY_CLI_PREFLIGHT_ARTIFACT_REQUIRED:execute requires --preflight-artifact and --expected-artifact-sha256');
  }
  if (args.mode === 'execute' && args.bindingOptionSeen) {
    throw new Error('INVENTORY_COMPATIBILITY_CLI_EXECUTE_ARTIFACT_ONLY:execute bindings come only from the immutable preflight artifact');
  }
  delete args.modeOption;
  return args;
}

function common(args) {
  return {
    ...(args.activationFile ? {activationFile: args.activationFile} : {}),
    ...(args.activationReceiptFile ? {activationReceiptFile: args.activationReceiptFile} : {}),
    ...(args.compatibilityFile ? {compatibilityFile: args.compatibilityFile} : {}),
    ...(args.compatibilityReceiptFile ? {compatibilityReceiptFile: args.compatibilityReceiptFile} : {}),
    ...(args.maintenanceFile ? {maintenanceFile: args.maintenanceFile} : {}),
    ...(args.recordedAt ? {now: () => new Date(args.recordedAt)} : {}),
  };
}

function invocationFromDryRun(args, result) {
  return {
    cwd: path.resolve(process.cwd()),
    activationFile: result.paths.activationFile,
    activationReceiptFile: result.paths.activationReceiptFile,
    compatibilityFile: result.paths.compatibilityFile,
    compatibilityReceiptFile: result.paths.compatibilityReceiptFile,
    maintenanceFile: path.resolve(args.maintenanceFile || process.env.SHEIN_BI_MAINTENANCE_FILE || DEFAULT_CLOUD_MAINTENANCE_FILE),
    lockFile: inventoryCutoverLockFile(),
    ...(args.command === 'activate' ? {requiredManualResolution: {
      intentId: INVENTORY_MANUAL_RESOLUTION_INTENT_ID,
      scopeKey: args.scopeKey,
      journalFile: args.journalFile,
      receiptFile: args.manualReceiptFile,
    }} : {}),
    ...(args.command === 'rotation-stage' ? {candidateAuthority: result.record.candidateAuthority} : {}),
  };
}

function optionsFromInvocation(invocation) {
  return {
    activationFile: invocation.activationFile,
    activationReceiptFile: invocation.activationReceiptFile,
    compatibilityFile: invocation.compatibilityFile,
    compatibilityReceiptFile: invocation.compatibilityReceiptFile,
    maintenanceFile: invocation.maintenanceFile,
    lockFile: invocation.lockFile,
    authorityOptions: {cwd: invocation.cwd},
  };
}

export async function runInventoryCompatibilityCli(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv);
  if (args.command === 'status') return inventoryCompatibilityStatus(common(args));
  const authorityReader = dependencies.authorityReader || captureInventoryCutoverDeploymentAuthority;
  const maintenanceReader = dependencies.maintenanceReader || readCloudMaintenanceStatus;
  const clock = dependencies.now || (() => new Date());
  if (args.mode === 'execute') {
    const loaded = await readInventoryCompatibilityPreflightArtifact(args.preflightArtifactFile, {
      expectedFileSha256: args.expectedArtifactSha256,
      expectedPreflightHash: args.expectedPreflightHash,
      command: args.command,
      now: clock(),
    });
    const artifact = loaded.artifact;
    const freshAuthorityReader = async authorityOptions => {
      const fresh = await authorityReader(authorityOptions);
      assertInventoryCompatibilityPreflightFreshFacts(artifact, {authority: fresh, maintenance: artifact.maintenance});
      return artifact.authority;
    };
    const freshMaintenanceReader = async maintenanceFile => {
      const fresh = await maintenanceReader(maintenanceFile);
      assertInventoryCompatibilityPreflightFreshFacts(artifact, {authority: artifact.authority, maintenance: fresh});
      return fresh;
    };
    const executeOptions = {
      ...optionsFromInvocation(artifact.invocation), mode: 'execute',
      expectedPreflightHash: artifact.controllerPreflightHash,
      now: () => new Date(artifact.recordedAt),
      authorityReader: freshAuthorityReader,
      maintenanceReader: freshMaintenanceReader,
      ...(dependencies.afterAppendHook ? {afterAppendHook: dependencies.afterAppendHook} : {}),
      ...(dependencies.receiptWriteOptions ? {receiptWriteOptions: dependencies.receiptWriteOptions} : {}),
    };
    let result;
    if (args.command === 'activate') {
      result = await controlInventoryCutoverActivation({...executeOptions, requiredManualResolution: artifact.invocation.requiredManualResolution});
    } else if (args.command === 'rotation-stage') {
      result = await stageInventoryCompatibilityRotation({...executeOptions, candidateAuthority: artifact.invocation.candidateAuthority});
    } else {
      result = await finalizeInventoryCompatibilityRotation(executeOptions);
    }
    const actualRecord = result.activation || result.record;
    if (stableInventoryHash(actualRecord) !== stableInventoryHash(artifact.proposedRecord)) {
      throw new Error('INVENTORY_CUTOVER_PREFLIGHT_RESULT_DRIFT:executed record differs from immutable artifact');
    }
    return {
      ...result,
      controllerPreflightHash: result.preflightHash,
      preflightHash: artifact.preflightHash,
      preflightArtifactFile: loaded.file,
      preflightArtifactFileSha256: loaded.fileSha256,
      artifactHash: artifact.artifactHash,
    };
  }
  const controlled = {
    ...common(args), mode: 'dry-run', authorityReader, maintenanceReader,
    authorityOptions: {cwd: path.resolve(process.cwd())},
    now: args.recordedAt ? () => new Date(args.recordedAt) : clock,
  };
  let result;
  if (args.command === 'activate') {
    if (!args.journalFile || !args.manualReceiptFile || !/^[a-f0-9]{64}$/u.test(args.scopeKey)) {
      throw new Error('INVENTORY_COMPATIBILITY_CLI_ACTIVATION_BINDING_REQUIRED:journal/manual-receipt/scope-key');
    }
    result = await controlInventoryCutoverActivation({
      ...controlled,
      requiredManualResolution: {
        intentId: INVENTORY_MANUAL_RESOLUTION_INTENT_ID,
        scopeKey: args.scopeKey,
        journalFile: args.journalFile,
        receiptFile: args.manualReceiptFile,
      },
    });
  } else if (args.command === 'rotation-stage') {
    result = await stageInventoryCompatibilityRotation({
      ...controlled,
      candidateAuthority: {
        deployedCommit: args.candidateCommit,
        sourceFingerprint: args.candidateSourceFingerprint,
        bundleSha256: args.candidateBundleSha256,
        trackedSourceClean: true,
        releaseReceiptKind: args.candidateReleaseReceiptKind,
        releaseReceiptHash: args.candidateReleaseReceiptHash,
        releaseReceiptFile: args.candidateReleaseReceiptFile,
      },
    });
  } else {
    result = await finalizeInventoryCompatibilityRotation(controlled);
  }
  const artifact = buildInventoryCompatibilityPreflightArtifact({
    command: args.command,
    invocation: invocationFromDryRun(args, result),
    authority: result.authority,
    maintenance: result.maintenance,
    currentStateHash: result.currentStateHash,
    preflightHash: result.preflightHash,
    proposedRecord: result.activation || result.record,
    recordedAt: result.recordedAt,
    createdAt: clock().toISOString(),
  });
  const written = await writeInventoryCompatibilityPreflightArtifact(args.outFile, artifact);
  return {
    ...result,
    controllerPreflightHash: result.preflightHash,
    preflightHash: artifact.preflightHash,
    preflightArtifactFile: written.file,
    preflightArtifactFileSha256: written.fileSha256,
    artifactHash: artifact.artifactHash,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify({ok: true, ...(await runInventoryCompatibilityCli())}, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ok: false, code: error.code || 'INVENTORY_COMPATIBILITY_CLI_FAILED', error: error.message}, null, 2));
    process.exitCode = 1;
  }
}
