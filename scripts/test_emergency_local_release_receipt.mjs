#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

import {
  buildEmergencyLocalReleaseReceipt,
  createEmergencyLocalReleaseReceipt,
  emergencyLocalReleaseReceiptHash,
  hashEmergencyLocalReleaseBundle,
  readEmergencyLocalReleaseReceipt,
  validateEmergencyLocalReleaseReceipt,
  verifyEmergencyLocalReleaseReceipt,
  writeEmergencyLocalReleaseReceipt,
} from '../lib/emergency_local_release_receipt.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shein-emergency-local-release-'));
const createdAt = '2026-08-22T12:00:00.000Z';

function git(cwd, args) {
  return execFileSync('git', ['-c', `safe.directory=${cwd}`, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function writeReceipt(file, receipt) {
  fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function assertReceiptFileMetadata(file, parentGid, expectedUid) {
  if (process.platform === 'win32') return;
  const stat = fs.statSync(file);
  assert.equal(stat.gid, parentGid, 'receipt gid must inherit the parent directory gid');
  assert.equal(stat.uid, expectedUid, 'receipt uid must preserve the target uid');
  assert.equal(stat.mode & 0o777, 0o640, 'receipt mode must stay exactly 0640');
}

function makeSourceFixture() {
  const gitRoot = path.join(tempRoot, 'source');
  fs.mkdirSync(gitRoot);
  git(gitRoot, ['init', '-q', '-b', 'main']);
  git(gitRoot, ['config', 'user.email', 'codex-test@example.invalid']);
  git(gitRoot, ['config', 'user.name', 'Codex Test']);

  const tracked = path.join(gitRoot, 'tracked.txt');
  fs.writeFileSync(tracked, 'baseline\n', 'utf8');
  git(gitRoot, ['add', 'tracked.txt']);
  git(gitRoot, ['commit', '-q', '-m', 'test baseline']);
  const baseline = git(gitRoot, ['rev-parse', 'HEAD']);

  fs.writeFileSync(tracked, 'target\n', 'utf8');
  git(gitRoot, ['add', 'tracked.txt']);
  git(gitRoot, ['commit', '-q', '-m', 'test target']);
  const target = git(gitRoot, ['rev-parse', 'HEAD']);

  const validBundle = path.join(tempRoot, 'valid.bundle');
  git(gitRoot, ['bundle', 'create', validBundle, 'HEAD']);

  git(gitRoot, ['branch', 'unrelated', baseline]);
  const unrelatedBundle = path.join(tempRoot, 'unrelated-head.bundle');
  git(gitRoot, ['bundle', 'create', unrelatedBundle, 'refs/heads/unrelated']);

  git(gitRoot, ['checkout', '-q', 'main']);
  const nonAncestorBranch = 'non-ancestor';
  git(gitRoot, ['checkout', '-q', '--orphan', nonAncestorBranch]);
  fs.rmSync(tracked, {force: true});
  fs.writeFileSync(path.join(gitRoot, 'other.txt'), 'other root\n', 'utf8');
  git(gitRoot, ['add', '-A']);
  git(gitRoot, ['commit', '-q', '-m', 'non ancestor']);
  const nonAncestor = git(gitRoot, ['rev-parse', 'HEAD']);
  git(gitRoot, ['checkout', '-q', 'main']);
  fs.rmSync(path.join(gitRoot, 'other.txt'), {force: true});

  return Object.freeze({gitRoot, tracked, baseline, target, nonAncestor, validBundle, unrelatedBundle});
}

try {
  const fixture = makeSourceFixture();
  const expectedBundleSha = sha256File(fixture.validBundle);

  const created = createEmergencyLocalReleaseReceipt({
    bundleFile: fixture.validBundle,
    cwd: fixture.gitRoot,
    // A caller-supplied value is deliberately ignored; the module hashes the
    // bounded bundle bytes itself before building the receipt.
    bundleSha256: '0'.repeat(64),
    commit: fixture.target,
    baselineCommit: fixture.baseline,
    reason: 'GitHub CI unavailable; local bundle only',
    createdAt,
  });
  assert.equal(created.bundle.sha256, expectedBundleSha);
  assert.equal(created.receipt.bundleSha256, expectedBundleSha);
  assert.equal(created.bundle.gitBundleVerified, true);
  assert.equal(created.bundle.targetInHeads, true);
  assert.equal(created.bundle.bindingStable, true);
  assert.equal(created.source.commitMatches, true);
  assert.equal(created.source.baselineRelation, 'ancestor');
  assert.equal(created.receipt.receiptHash, emergencyLocalReleaseReceiptHash(created.receipt));
  assert.equal(validateEmergencyLocalReleaseReceipt(created.receipt).ok, true);

  const equalBaselineCreated = createEmergencyLocalReleaseReceipt({
    bundleFile: fixture.validBundle,
    cwd: fixture.gitRoot,
    commit: fixture.target,
    baselineCommit: fixture.target,
    reason: 'unchanged emergency fixture',
    createdAt,
  });
  assert.equal(equalBaselineCreated.source.baselineRelation, 'equal');
  assert.equal(equalBaselineCreated.source.baselineEqualTarget, true);

  const tampered = {...created.receipt, reason: 'tampered'};
  const tamperResult = validateEmergencyLocalReleaseReceipt(tampered);
  assert.equal(tamperResult.ok, false);
  assert.ok(tamperResult.issues.includes('receipt_hash_mismatch'));

  assert.throws(
    () => hashEmergencyLocalReleaseBundle(fixture.validBundle, {maxBytes: 2}),
    error => error?.code === 'EMERGENCY_BUNDLE_SIZE_INVALID',
    'bundle hashing must enforce a bounded path size',
  );

  const receiptFile = path.join(tempRoot, 'receipt.json');
  writeReceipt(receiptFile, created.receipt);
  const readResult = readEmergencyLocalReleaseReceipt(receiptFile);
  assert.equal(readResult.ok, true);
  assert.equal(readResult.receipt.commit, fixture.target);

  const cleanVerification = verifyEmergencyLocalReleaseReceipt({
    receiptFile,
    bundleFile: fixture.validBundle,
    cwd: fixture.gitRoot,
  });
  assert.equal(cleanVerification.ok, true, JSON.stringify(cleanVerification));
  assert.equal(cleanVerification.bundleVerified, true);
  assert.equal(cleanVerification.bundleVerification, 'verified');
  assert.equal(cleanVerification.bundle.bindingStable, true);
  assert.equal(cleanVerification.source.commitMatches, true);
  assert.equal(cleanVerification.source.baselineRelation, 'ancestor');

  const noBundleVerification = verifyEmergencyLocalReleaseReceipt({
    receiptFile,
    cwd: fixture.gitRoot,
  });
  assert.equal(noBundleVerification.ok, true, JSON.stringify(noBundleVerification));
  assert.equal(noBundleVerification.bundle, null);
  assert.equal(noBundleVerification.bundleVerified, false);
  assert.equal(noBundleVerification.bundleVerification, 'not-run');

  const atomicReceiptDir = path.join(tempRoot, 'atomic-receipts');
  fs.mkdirSync(atomicReceiptDir);
  const atomicReceiptFile = path.join(atomicReceiptDir, 'emergency_local_release.json');
  const atomicParentGid = process.platform === 'win32' ? null : fs.statSync(atomicReceiptDir).gid;
  const firstAtomicReceipt = await writeEmergencyLocalReleaseReceipt({
    bundleFile: fixture.validBundle,
    cwd: fixture.gitRoot,
    commit: fixture.target,
    baselineCommit: fixture.baseline,
    reason: 'atomic metadata fixture one',
    createdAt,
    receiptFile: atomicReceiptFile,
  });
  assert.equal(firstAtomicReceipt.readback.ok, true);
  assert.equal(readEmergencyLocalReleaseReceipt(atomicReceiptFile).ok, true);
  const firstAtomicUid = process.platform === 'win32' ? null : fs.statSync(atomicReceiptFile).uid;
  assertReceiptFileMetadata(atomicReceiptFile, atomicParentGid, firstAtomicUid);

  const secondAtomicReceipt = await writeEmergencyLocalReleaseReceipt({
    bundleFile: fixture.validBundle,
    cwd: fixture.gitRoot,
    commit: fixture.target,
    baselineCommit: fixture.baseline,
    reason: 'atomic metadata fixture two',
    createdAt,
    receiptFile: atomicReceiptFile,
  });
  assert.equal(secondAtomicReceipt.readback.ok, true);
  assert.equal(readEmergencyLocalReleaseReceipt(atomicReceiptFile).ok, true);
  assertReceiptFileMetadata(atomicReceiptFile, atomicParentGid, firstAtomicUid);

  const invalidBundle = path.join(tempRoot, 'invalid.bundle');
  fs.writeFileSync(invalidBundle, Buffer.from('not a git bundle\n', 'utf8'));
  const invalidReceipt = buildEmergencyLocalReleaseReceipt({
    commit: fixture.target,
    baselineCommit: fixture.baseline,
    bundleSha256: sha256File(invalidBundle),
    reason: 'invalid bundle fixture',
    createdAt,
  });
  const invalidReceiptFile = path.join(tempRoot, 'invalid-receipt.json');
  writeReceipt(invalidReceiptFile, invalidReceipt);
  const invalidVerification = verifyEmergencyLocalReleaseReceipt({
    receiptFile: invalidReceiptFile,
    bundleFile: invalidBundle,
    cwd: fixture.gitRoot,
  });
  assert.equal(invalidVerification.ok, false);
  assert.ok(invalidVerification.issues.includes('bundle_git_verify_failed'));
  assert.ok(invalidVerification.issues.includes('bundle_list_heads_failed'));

  const targetNotHeadReceipt = buildEmergencyLocalReleaseReceipt({
    commit: fixture.target,
    baselineCommit: fixture.baseline,
    bundleSha256: sha256File(fixture.unrelatedBundle),
    reason: 'target head binding fixture',
    createdAt,
  });
  const targetNotHeadFile = path.join(tempRoot, 'target-not-head-receipt.json');
  writeReceipt(targetNotHeadFile, targetNotHeadReceipt);
  const targetNotHeadVerification = verifyEmergencyLocalReleaseReceipt({
    receiptFile: targetNotHeadFile,
    bundleFile: fixture.unrelatedBundle,
    cwd: fixture.gitRoot,
  });
  assert.equal(targetNotHeadVerification.ok, false);
  assert.equal(targetNotHeadVerification.bundle.gitBundleVerified, true);
  assert.equal(targetNotHeadVerification.bundle.targetInHeads, false);
  assert.ok(targetNotHeadVerification.issues.includes('bundle_target_not_head'));

  const nonAncestorReceipt = buildEmergencyLocalReleaseReceipt({
    commit: fixture.target,
    baselineCommit: fixture.nonAncestor,
    bundleSha256: expectedBundleSha,
    reason: 'baseline ancestor fixture',
    createdAt,
  });
  const nonAncestorFile = path.join(tempRoot, 'non-ancestor-receipt.json');
  writeReceipt(nonAncestorFile, nonAncestorReceipt);
  const nonAncestorVerification = verifyEmergencyLocalReleaseReceipt({
    receiptFile: nonAncestorFile,
    bundleFile: fixture.validBundle,
    cwd: fixture.gitRoot,
  });
  assert.equal(nonAncestorVerification.ok, false);
  assert.equal(nonAncestorVerification.source.baselineRelation, 'not-ancestor');
  assert.equal(nonAncestorVerification.source.baselineIsAncestor, false);
  assert.ok(nonAncestorVerification.issues.includes('baseline_not_ancestor'));
  assert.ok(nonAncestorVerification.issues.includes('source_integrity_invalid'));

  const changedBundle = path.join(tempRoot, 'changed.bundle');
  fs.copyFileSync(fixture.validBundle, changedBundle);
  fs.appendFileSync(changedBundle, Buffer.from('changed bytes\n', 'utf8'));
  const changedVerification = verifyEmergencyLocalReleaseReceipt({
    receiptFile,
    bundleFile: changedBundle,
    cwd: fixture.gitRoot,
  });
  assert.equal(changedVerification.ok, false);
  assert.ok(changedVerification.issues.includes('bundle_hash_mismatch'));
  assert.equal(changedVerification.bundle.bindingStable, true);

  const mismatchReceipt = buildEmergencyLocalReleaseReceipt({
    commit: fixture.baseline,
    baselineCommit: fixture.baseline,
    bundleSha256: expectedBundleSha,
    reason: 'commit mismatch fixture',
    createdAt,
  });
  const mismatchFile = path.join(tempRoot, 'mismatch-receipt.json');
  writeReceipt(mismatchFile, mismatchReceipt);
  const mismatchVerification = verifyEmergencyLocalReleaseReceipt({
    receiptFile: mismatchFile,
    bundleFile: fixture.validBundle,
    cwd: fixture.gitRoot,
  });
  assert.equal(mismatchVerification.ok, false);
  assert.equal(mismatchVerification.source.commitMatches, false);
  assert.ok(mismatchVerification.issues.includes('source_integrity_invalid'));

  fs.writeFileSync(fixture.tracked, 'dirty\n', 'utf8');
  const dirtyVerification = verifyEmergencyLocalReleaseReceipt({
    receiptFile,
    bundleFile: fixture.validBundle,
    cwd: fixture.gitRoot,
  });
  assert.equal(dirtyVerification.ok, false);
  assert.ok(dirtyVerification.source.dirtyEntries.length > 0);
  assert.ok(dirtyVerification.issues.includes('source_integrity_invalid'));
  fs.writeFileSync(fixture.tracked, 'target\n', 'utf8');

  git(fixture.gitRoot, ['update-index', '--skip-worktree', '--', 'tracked.txt']);
  const hiddenVerification = verifyEmergencyLocalReleaseReceipt({
    receiptFile,
    bundleFile: fixture.validBundle,
    cwd: fixture.gitRoot,
  });
  assert.equal(hiddenVerification.ok, false);
  assert.ok(hiddenVerification.source.hiddenIndexEntries.length > 0);
  assert.ok(hiddenVerification.issues.includes('source_integrity_invalid'));
  git(fixture.gitRoot, ['update-index', '--no-skip-worktree', '--', 'tracked.txt']);

  fs.rmSync(fixture.tracked);
  const missingVerification = verifyEmergencyLocalReleaseReceipt({
    receiptFile,
    bundleFile: fixture.validBundle,
    cwd: fixture.gitRoot,
  });
  assert.equal(missingVerification.ok, false);
  assert.ok(missingVerification.source.missingTrackedFiles.includes('tracked.txt'));
  assert.ok(missingVerification.issues.includes('source_integrity_invalid'));
  fs.writeFileSync(fixture.tracked, 'target\n', 'utf8');
  git(fixture.gitRoot, ['checkout', '--', 'tracked.txt']);

  const cliReceipt = path.join(tempRoot, 'cli-receipt.json');
  const cliOutput = execFileSync(process.execPath, [
    'scripts/manage_emergency_local_release_receipt.mjs',
    'create',
    '--bundle', fixture.validBundle,
    '--commit', fixture.target,
    '--baseline-commit', fixture.baseline,
    '--reason', 'CLI bounded receipt fixture',
    '--created-at', createdAt,
    '--cwd', fixture.gitRoot,
    '--receipt-file', cliReceipt,
  ], {cwd: root, encoding: 'utf8'});
  const cliCreated = JSON.parse(cliOutput);
  assert.equal(cliCreated.ok, true, cliOutput);
  assert.equal(cliCreated.source.commitMatches, true);
  assert.equal(cliCreated.bundle.gitBundleVerified, true);
  assert.equal(cliCreated.bundle.targetInHeads, true);

  const cliVerify = spawnSync(process.execPath, [
    'scripts/manage_emergency_local_release_receipt.mjs',
    'verify',
    '--receipt-file', cliReceipt,
    '--bundle', fixture.validBundle,
    '--cwd', fixture.gitRoot,
  ], {cwd: root, encoding: 'utf8'});
  assert.equal(cliVerify.status, 0, cliVerify.stderr);
  const cliVerification = JSON.parse(cliVerify.stdout);
  assert.equal(cliVerification.ok, true, cliVerify.stdout);
  assert.equal(cliVerification.bundleVerified, true);
  assert.equal(cliVerification.bundleVerification, 'verified');

  const cliNoBundleVerify = spawnSync(process.execPath, [
    'scripts/manage_emergency_local_release_receipt.mjs',
    'verify',
    '--receipt-file', cliReceipt,
    '--cwd', fixture.gitRoot,
  ], {cwd: root, encoding: 'utf8'});
  assert.equal(cliNoBundleVerify.status, 0, cliNoBundleVerify.stderr);
  const cliNoBundle = JSON.parse(cliNoBundleVerify.stdout);
  assert.equal(cliNoBundle.ok, true, cliNoBundleVerify.stdout);
  assert.equal(cliNoBundle.bundleVerified, false);
  assert.equal(cliNoBundle.bundleVerification, 'not-run');

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'canonical_receipt_hash',
      'tamper_detection',
      'bounded_bundle_path_size',
      'real_git_bundle_verify',
      'bundle_sha256_is_collected_not_trusted',
      'bundle_rebind_size_and_sha',
      'receipt_readback',
      'atomic_receipt_metadata',
      'bundle_invalid_bytes',
      'bundle_target_must_be_head',
      'baseline_must_be_ancestor',
      'source_head_clean_hidden_and_missing_integrity',
      'cli_create_and_verify',
      'no_bundle_is_not_claimed_as_reverified',
    ],
  }, null, 2));
} finally {
  fs.rmSync(tempRoot, {recursive: true, force: true});
}
