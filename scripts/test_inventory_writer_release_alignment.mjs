#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

import {
  assertInventoryWriterReleaseAligned,
  captureCheckoutSourceAuthority,
  InventoryAlignmentError,
} from './inventory/assert_inventory_writer_release_aligned.mjs';
import {captureInventoryCutoverDeploymentAuthority} from '../lib/inventory_write_cutover.mjs';
import {buildEmergencyLocalReleaseReceipt} from '../lib/emergency_local_release_receipt.mjs';
import {expectedAnnotatedTagMessage} from '../lib/source_release_attestation.mjs';

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const commit = 'a'.repeat(40);
const fingerprint = 'b'.repeat(64);
const bundle = 'c'.repeat(64);
const receiptHash = 'd'.repeat(64);
const receiptFile = '/srv/shein-bi/runtime/emergency_local_release.json';

function authority(overrides = {}) {
  return {
    deployedCommit: commit,
    sourceFingerprint: fingerprint,
    bundleSha256: bundle,
    trackedSourceClean: true,
    releaseReceiptKind: 'emergency',
    releaseReceiptHash: receiptHash,
    releaseReceiptFile: receiptFile,
    ...overrides,
  };
}

function dependencies({source = authority(), active = authority(), pendingStage = null} = {}) {
  return {
    authorityReader: async () => source,
    statusReader: async () => ({
      ok: true,
      activeGeneration: 54,
      activeAuthority: active,
      pendingStage,
    }),
  };
}

async function expectCode(run, code) {
  await assert.rejects(run, error => {
    assert.ok(error instanceof InventoryAlignmentError);
    assert.equal(error.code, code);
    return true;
  });
}

// 1. Basic unit cases
await assertInventoryWriterReleaseAligned({}, dependencies());

await expectCode(
  () => assertInventoryWriterReleaseAligned({}, dependencies({active: authority({deployedCommit: 'e'.repeat(40)})})),
  'INVENTORY_WRITER_RELEASE_ALIGNMENT_MISMATCH',
);

await expectCode(
  () => assertInventoryWriterReleaseAligned({}, dependencies({pendingStage: {generation: 55, recordHash: 'e'.repeat(64), candidateAuthority: authority()}})),
  'INVENTORY_WRITER_COMPATIBILITY_PENDING_ROTATION',
);

await expectCode(
  () => assertInventoryWriterReleaseAligned({}, dependencies({source: authority({trackedSourceClean: false})})),
  'INVENTORY_WRITER_RELEASE_ALIGNMENT_MISMATCH',
);

// 2. Integration / Authority reader tests with real Git repository and canonical files
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'inv-align-test-'));
try {
  function git(dir, args) {
    return execFileSync('git', ['-c', 'safe.directory=*', ...args], {cwd: dir, encoding: 'utf8'}).trim();
  }
  git(tmp, ['init', '-b', 'main']);
  git(tmp, ['config', 'user.name', 'Tester']);
  git(tmp, ['config', 'user.email', 'test@test.local']);
  git(tmp, ['remote', 'add', 'origin', 'https://github.com/dushengyi1993/shein-sales-bi.git']);
  await fs.writeFile(path.join(tmp, 'tracked.txt'), 'tracked content');
  git(tmp, ['add', 'tracked.txt']);
  git(tmp, ['commit', '-m', 'initial commit']);
  const realCommit = git(tmp, ['rev-parse', 'HEAD']);

  const policyDir = path.join(tmp, 'config');
  await fs.mkdir(policyDir, {recursive: true});
  const policyFile = path.join(policyDir, 'source_release_trust_policy.json');
  const realPolicyBytes = await fs.readFile(path.join(process.cwd(), 'config', 'source_release_trust_policy.json'));
  await fs.writeFile(policyFile, realPolicyBytes);
  const policySha256 = sha256Hex(realPolicyBytes);
  const policy = JSON.parse(realPolicyBytes.toString('utf8'));

  const attestationRoot = path.join(tmp, 'release-attestations');
  const attestationDir = path.join(attestationRoot, '2026.08.17.1');
  await fs.mkdir(attestationDir, {recursive: true});
  const attestationFile = path.join(attestationDir, 'release-attestation.json');
  const checksumFile = path.join(attestationDir, 'release-attestation.json.sha256');
  const attestationContent = JSON.stringify({
    schemaVersion: 3,
    repository: {id: 1228612468, fullName: 'dushengyi1993/shein-sales-bi'},
    version: '2026.08.17.1',
    tag: '2026.08.17.1',
    commit: realCommit,
    trustPolicySha256: policySha256,
    ci: {workflow: '.github/workflows/ci.yml', event: 'push', branch: 'main', runId: 101, runAttempt: 1, url: 'https://github.com/dushengyi1993/shein-sales-bi/actions/runs/101', completedAt: '2026-08-17T02:00:00Z', jobCount: 7, jobsSha256: 'e'.repeat(64)},
    sourceWorkflow: {path: '.github/workflows/source-release.yml'},
  }, null, 2);
  await fs.writeFile(attestationFile, attestationContent, 'utf8');
  const attestationSha = sha256Hex(Buffer.from(attestationContent, 'utf8'));
  await fs.writeFile(checksumFile, `${attestationSha}  release-attestation.json\n`, 'utf8');
  const checksumSha256 = sha256Hex(Buffer.from(`${attestationSha}  release-attestation.json\n`, 'utf8'));

  // Create real annotated tag
  const tagMessage = expectedAnnotatedTagMessage({
    tag: '2026.08.17.1',
    commit: realCommit,
    ci: {runId: 101, runAttempt: 1, completedAt: '2026-08-17T02:00:00Z'},
    attestationSha256: attestationSha,
  });
  git(tmp, ['tag', '-a', '2026.08.17.1', '-m', tagMessage]);
  const realTagObject = git(tmp, ['rev-parse', 'refs/tags/2026.08.17.1']);

  const validBundleSha = 'f'.repeat(64);
  const deployedMarkerFile = path.join(tmp, 'deployed_release.json');
  const baseMarker = {
    schemaVersion: 'shein-bi-deployed-release/v3',
    repository: 'dushengyi1993/shein-sales-bi',
    repositoryId: 1228612468,
    tag: '2026.08.17.1',
    commit: realCommit,
    tagObject: realTagObject,
    trustPolicy: {
      schemaVersion: 'shein-bi-source-release-trust-policy/v1',
      sha256: policySha256,
      ciWorkflowPath: '.github/workflows/ci.yml',
      sourceWorkflowPath: '.github/workflows/source-release.yml',
    },
    releaseAttestation: {
      sha256: attestationSha,
      checksumSha256: checksumSha256,
      schemaVersion: 3,
    },
    ci: {
      workflow: '.github/workflows/ci.yml',
      event: 'push',
      branch: 'main',
      runId: 101,
      runAttempt: 1,
      url: 'https://github.com/dushengyi1993/shein-sales-bi/actions/runs/101',
      completedAt: '2026-08-17T02:00:00Z',
      jobCount: 7,
      jobsSha256: 'e'.repeat(64),
    },
    sourceWorkflow: {path: '.github/workflows/source-release.yml'},
    remoteEvidence: {
      verifiedAt: '2026-08-17T02:05:00Z',
      releaseId: 501,
      releaseUrl: 'https://github.com/dushengyi1993/shein-sales-bi/releases/501',
      publishedAt: '2026-08-17T02:04:00Z',
      immutable: true,
      assets: [
        {name: 'release-attestation.json', id: 1, size: Buffer.byteLength(attestationContent), digest: `sha256:${attestationSha}`, bytesSha256: attestationSha},
        {name: 'release-attestation.json.sha256', id: 2, size: 64, digest: `sha256:${checksumSha256}`, bytesSha256: checksumSha256},
      ],
      warnings: [],
    },
    sourceFingerprint: fingerprint,
    recordedAt: '2026-08-17T02:10:00Z',
    inventoryWriterAuthority: {
      schemaVersion: 'shein-bi-inventory-writer-authority/v1',
      receiptFile: attestationFile,
      receiptSha256: attestationSha,
      bundleSha256: validBundleSha,
    },
  };
  await fs.writeFile(deployedMarkerFile, JSON.stringify(baseMarker, null, 2), 'utf8');

  // Emergency receipt for the same commit
  const emergencyReceiptFile = path.join(tmp, 'emergency_local_release.json');
  const emergencyReceipt = buildEmergencyLocalReleaseReceipt({
    commit: realCommit,
    baselineCommit: realCommit,
    bundleSha256: '9'.repeat(64),
    createdAt: '2026-08-17T01:00:00.000Z',
    reason: 'emergency-fix',
  });
  await fs.writeFile(emergencyReceiptFile, JSON.stringify(emergencyReceipt, null, 2), 'utf8');
  const emergencyReceiptHash = emergencyReceipt.receiptHash;

  const mockSourceInspector = () => ({
    ok: true,
    head: realCommit,
    expectedCommit: realCommit,
    sourceFingerprint: fingerprint,
    dirtyEntries: [],
    missingTrackedFiles: [],
    hiddenIndexEntries: [],
  });

  // Test 2a: Formal inventory authority takes precedence over emergency receipt
  const formalAuth = await captureCheckoutSourceAuthority({
    cwd: tmp,
    deploymentStateFile: deployedMarkerFile,
    emergencyReceiptFile,
    releaseAttestationRoot: attestationRoot,
    trustPolicyFile: policyFile,
    sourceInspector: mockSourceInspector,
  });
  assert.equal(formalAuth.deployedCommit, realCommit);
  assert.equal(formalAuth.releaseReceiptKind, 'formal');
  assert.equal(formalAuth.releaseReceiptHash, attestationSha);
  assert.equal(formalAuth.releaseReceiptFile, path.resolve(attestationFile));
  assert.equal(formalAuth.bundleSha256, validBundleSha);
  assert.equal(formalAuth.trackedSourceClean, true);

  // Test 2a-2: captureInventoryCutoverDeploymentAuthority also resolves formal authority
  const mockServiceReader = async () => [
    {unit: 'shein-bi-daily-inventory-replenishment-guard.service', generationHash: '1'.repeat(64)},
  ];
  const cutoverFormalAuth = await captureInventoryCutoverDeploymentAuthority({
    cwd: tmp,
    deploymentStateFile: deployedMarkerFile,
    emergencyReceiptFile,
    releaseAttestationRoot: attestationRoot,
    trustPolicyFile: policyFile,
    sourceInspector: mockSourceInspector,
    serviceStateReader: mockServiceReader,
    now: () => new Date('2026-08-17T02:10:00Z'),
  });
  assert.equal(cutoverFormalAuth.deployedCommit, realCommit);
  assert.equal(cutoverFormalAuth.releaseReceiptKind, 'formal');
  assert.equal(cutoverFormalAuth.releaseReceiptHash, attestationSha);
  assert.equal(cutoverFormalAuth.releaseReceiptFile, path.resolve(attestationFile));
  assert.equal(cutoverFormalAuth.bundleSha256, validBundleSha);
  assert.equal(cutoverFormalAuth.trackedSourceClean, true);

  // Test 2b: Re-recording marker with different recordedAt timestamp does NOT change authority
  const laterMarker = {
    ...baseMarker,
    recordedAt: '2026-08-17T03:45:00Z',
    remoteEvidence: {
      ...baseMarker.remoteEvidence,
      verifiedAt: '2026-08-17T03:45:00Z',
    },
  };
  await fs.writeFile(deployedMarkerFile, JSON.stringify(laterMarker, null, 2), 'utf8');
  const reRecordedAuth = await captureCheckoutSourceAuthority({
    cwd: tmp,
    deploymentStateFile: deployedMarkerFile,
    emergencyReceiptFile,
    releaseAttestationRoot: attestationRoot,
    trustPolicyFile: policyFile,
    sourceInspector: mockSourceInspector,
  });
  assert.deepEqual(formalAuth, reRecordedAuth);

  // Test 2c: Alignment with compatibility registry using formal authority succeeds
  const alignedResult = await assertInventoryWriterReleaseAligned(
    {},
    dependencies({source: formalAuth, active: formalAuth}),
  );
  assert.equal(alignedResult.ok, true);
  assert.equal(alignedResult.aligned, true);

  // Test 2d: Legacy fallback when formal marker lacks inventoryWriterAuthority
  const legacyMarkerFile = path.join(tmp, 'legacy_deployed_release.json');
  const {inventoryWriterAuthority: _ignored, ...legacyMarker} = baseMarker;
  await fs.writeFile(legacyMarkerFile, JSON.stringify(legacyMarker, null, 2), 'utf8');
  const legacyAuth = await captureCheckoutSourceAuthority({
    cwd: tmp,
    deploymentStateFile: legacyMarkerFile,
    emergencyReceiptFile,
    releaseAttestationRoot: attestationRoot,
    trustPolicyFile: policyFile,
    sourceInspector: mockSourceInspector,
  });
  assert.equal(legacyAuth.releaseReceiptKind, 'emergency');
  assert.equal(legacyAuth.releaseReceiptHash, emergencyReceiptHash);
  assert.equal(legacyAuth.bundleSha256, '9'.repeat(64));

  // Test 2e: Tampered attestation file content fails
  await fs.writeFile(attestationFile, '{"tampered":true}', 'utf8');
  await assert.rejects(
    () => captureCheckoutSourceAuthority({
      cwd: tmp,
      deploymentStateFile: deployedMarkerFile,
      emergencyReceiptFile,
      releaseAttestationRoot: attestationRoot,
      trustPolicyFile: policyFile,
      sourceInspector: mockSourceInspector,
    }),
    error => error?.code === 'INVENTORY_WRITER_AUTHORITY_INVALID'
  );
  // Restore attestation file
  await fs.writeFile(attestationFile, attestationContent, 'utf8');

  // Test 2f: Marker inventoryWriterAuthority receiptSha mismatch vs releaseAttestation.sha256 fails validation
  const invalidMarkerFile = path.join(tmp, 'invalid_authority_marker.json');
  const invalidMarker = {
    ...baseMarker,
    inventoryWriterAuthority: {
      ...baseMarker.inventoryWriterAuthority,
      receiptSha256: '0'.repeat(64),
    },
  };
  await fs.writeFile(invalidMarkerFile, JSON.stringify(invalidMarker, null, 2), 'utf8');

  // Test 2g: Combined valid emergency receipt + bad formal inventoryWriterAuthority
  // Emergency receipt must NOT mask or eat a defective formal authority!
  await assert.rejects(
    () => captureCheckoutSourceAuthority({
      cwd: tmp,
      deploymentStateFile: invalidMarkerFile,
      emergencyReceiptFile,
      releaseAttestationRoot: attestationRoot,
      trustPolicyFile: policyFile,
      sourceInspector: mockSourceInspector,
    }),
    error => error?.code === 'INVENTORY_WRITER_AUTHORITY_INVALID'
  );

  await assert.rejects(
    () => captureInventoryCutoverDeploymentAuthority({
      cwd: tmp,
      deploymentStateFile: invalidMarkerFile,
      emergencyReceiptFile,
      releaseAttestationRoot: attestationRoot,
      trustPolicyFile: policyFile,
      sourceInspector: mockSourceInspector,
      serviceStateReader: mockServiceReader,
      now: () => new Date('2026-08-17T02:10:00Z'),
    }),
    error => error?.message?.includes('INVENTORY_CUTOVER_AUTHORITY_INVALID')
  );

  // Test 2h: Non-canonical alternate receipt file path must be rejected
  const swappedPathMarkerFile = path.join(tmp, 'swapped_path_marker.json');
  const alternateAttestationFile = path.join(tmp, 'other-dir', 'release-attestation.json');
  await fs.mkdir(path.dirname(alternateAttestationFile), {recursive: true});
  await fs.writeFile(alternateAttestationFile, attestationContent, 'utf8');
  const swappedPathMarker = {
    ...baseMarker,
    inventoryWriterAuthority: {
      ...baseMarker.inventoryWriterAuthority,
      receiptFile: alternateAttestationFile,
    },
  };
  await fs.writeFile(swappedPathMarkerFile, JSON.stringify(swappedPathMarker, null, 2), 'utf8');
  await assert.rejects(
    () => captureCheckoutSourceAuthority({
      cwd: tmp,
      deploymentStateFile: swappedPathMarkerFile,
      emergencyReceiptFile,
      releaseAttestationRoot: attestationRoot,
      trustPolicyFile: policyFile,
      sourceInspector: mockSourceInspector,
    }),
    error => error?.code === 'INVENTORY_WRITER_AUTHORITY_INVALID'
  );

} finally {
  await fs.rm(tmp, {recursive: true, force: true});
}

console.log('inventory_writer_release_alignment: all unit and formal authority integration cases passed');
