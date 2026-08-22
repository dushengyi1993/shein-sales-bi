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
} from '../lib/emergency_local_release_receipt.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shein-emergency-local-release-'));
const commitA = 'a'.repeat(40);
const commitB = 'b'.repeat(40);
const commitC = 'c'.repeat(40);
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

try {
  const bundleFile = path.join(tempRoot, 'release.bundle');
  fs.writeFileSync(bundleFile, Buffer.from('local emergency bundle\n', 'utf8'));
  const expectedBundleSha = crypto.createHash('sha256').update(fs.readFileSync(bundleFile)).digest('hex');
  const created = createEmergencyLocalReleaseReceipt({
    bundleFile,
    // A caller-supplied value is deliberately ignored; the module hashes the
    // bounded bundle bytes itself before building the receipt.
    bundleSha256: '0'.repeat(64),
    commit: commitA,
    baselineCommit: commitB,
    reason: 'GitHub CI payment limit exhausted; local bundle only',
    createdAt,
  });
  assert.equal(created.bundle.sha256, expectedBundleSha);
  assert.equal(created.receipt.bundleSha256, expectedBundleSha);
  assert.equal(created.receipt.receiptHash, emergencyLocalReleaseReceiptHash(created.receipt));
  assert.equal(validateEmergencyLocalReleaseReceipt(created.receipt).ok, true);

  const tampered = {...created.receipt, reason: 'tampered'};
  const tamperResult = validateEmergencyLocalReleaseReceipt(tampered);
  assert.equal(tamperResult.ok, false);
  assert.ok(tamperResult.issues.includes('receipt_hash_mismatch'));

  assert.throws(
    () => hashEmergencyLocalReleaseBundle(bundleFile, {maxBytes: 2}),
    error => error?.code === 'EMERGENCY_BUNDLE_SIZE_INVALID',
    'bundle hashing must enforce a bounded path size',
  );

  const receiptFile = path.join(tempRoot, 'receipt.json');
  writeReceipt(receiptFile, created.receipt);
  const readResult = readEmergencyLocalReleaseReceipt(receiptFile);
  assert.equal(readResult.ok, true);
  assert.equal(readResult.receipt.commit, commitA);

  const gitRoot = path.join(tempRoot, 'source');
  fs.mkdirSync(gitRoot);
  git(gitRoot, ['init', '-q']);
  git(gitRoot, ['config', 'user.email', 'codex-test@example.invalid']);
  git(gitRoot, ['config', 'user.name', 'Codex Test']);
  const tracked = path.join(gitRoot, 'tracked.txt');
  fs.writeFileSync(tracked, 'clean\n', 'utf8');
  git(gitRoot, ['add', 'tracked.txt']);
  git(gitRoot, ['commit', '-q', '-m', 'test baseline']);
  const sourceHead = git(gitRoot, ['rev-parse', 'HEAD']);
  const sourceReceipt = buildEmergencyLocalReleaseReceipt({
    commit: sourceHead,
    baselineCommit: sourceHead,
    bundleSha256: expectedBundleSha,
    reason: 'bounded source verification fixture',
    createdAt,
  });
  const sourceReceiptFile = path.join(tempRoot, 'source-receipt.json');
  writeReceipt(sourceReceiptFile, sourceReceipt);
  const cleanVerification = verifyEmergencyLocalReleaseReceipt({
    receiptFile: sourceReceiptFile,
    bundleFile,
    cwd: gitRoot,
  });
  assert.equal(cleanVerification.ok, true, JSON.stringify(cleanVerification));
  assert.equal(cleanVerification.source.commitMatches, true);

  const mismatchReceipt = buildEmergencyLocalReleaseReceipt({
    commit: commitC,
    baselineCommit: sourceHead,
    bundleSha256: expectedBundleSha,
    reason: 'commit mismatch fixture',
    createdAt,
  });
  const mismatchFile = path.join(tempRoot, 'mismatch-receipt.json');
  writeReceipt(mismatchFile, mismatchReceipt);
  const mismatchVerification = verifyEmergencyLocalReleaseReceipt({
    receiptFile: mismatchFile,
    bundleFile,
    cwd: gitRoot,
  });
  assert.equal(mismatchVerification.ok, false);
  assert.equal(mismatchVerification.source.commitMatches, false);
  assert.ok(mismatchVerification.issues.includes('source_integrity_invalid'));

  fs.writeFileSync(tracked, 'dirty\n', 'utf8');
  const dirtyVerification = verifyEmergencyLocalReleaseReceipt({
    receiptFile: sourceReceiptFile,
    bundleFile,
    cwd: gitRoot,
  });
  assert.equal(dirtyVerification.ok, false);
  assert.ok(dirtyVerification.source.dirtyEntries.length > 0);
  assert.ok(dirtyVerification.issues.includes('source_integrity_invalid'));

  const cliReceipt = path.join(tempRoot, 'cli-receipt.json');
  const cliOutput = execFileSync(process.execPath, [
    'scripts/manage_emergency_local_release_receipt.mjs',
    'create',
    '--bundle', bundleFile,
    '--commit', commitA,
    '--baseline-commit', commitB,
    '--reason', 'CLI bounded receipt fixture',
    '--created-at', createdAt,
    '--receipt-file', cliReceipt,
  ], {cwd: root, encoding: 'utf8'});
  assert.equal(JSON.parse(cliOutput).ok, true);
  const cliVerify = spawnSync(process.execPath, [
    'scripts/manage_emergency_local_release_receipt.mjs',
    'verify',
    '--receipt-file', cliReceipt,
    '--bundle', bundleFile,
    '--cwd', gitRoot,
  ], {cwd: root, encoding: 'utf8'});
  assert.equal(cliVerify.status, 1, cliVerify.stderr);
  const cliVerification = JSON.parse(cliVerify.stdout);
  assert.equal(cliVerification.ok, false, 'CLI verify must fail closed on the intentional source commit mismatch');
  assert.ok(cliVerification.issues.includes('source_integrity_invalid'));

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'canonical_receipt_hash',
      'tamper_detection',
      'bounded_bundle_path_size',
      'bundle_hash_is_collected_not_trusted',
      'receipt_readback',
      'clean_source_head_and_integrity',
      'source_commit_mismatch',
      'dirty_source_fail_closed',
      'cli_create_and_verify',
    ],
  }, null, 2));
} finally {
  fs.rmSync(tempRoot, {recursive: true, force: true});
}
