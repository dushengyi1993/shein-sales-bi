import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {readLimitedDiscountMutationEvidence} from '../lib/marketing_transaction_attempt_evidence.mjs';

const ROOT = process.cwd();
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-mutation-evidence-'));
const journalDir = path.join(tmpDir, 'journals');
await fs.mkdir(journalDir, {recursive: true});

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// 1. Prepare source rescue file
const storeKey = 'DX';
const sourceRescuePath = path.join(tmpDir, 'rescue-dx.json');
const sourceRescueContent = JSON.stringify({
  storeKey,
  rows: [{skc: 'skc-1', limitedDiscountPrice: 50}],
}, null, 2);
await fs.writeFile(sourceRescuePath, sourceRescueContent, 'utf8');
const sourceRescueHash = sha256(Buffer.from(sourceRescueContent, 'utf8'));
const txid = sha256(storeKey + '\n' + sourceRescueHash).slice(0, 24);
const journalPath = path.join(journalDir, `limited-discount-tx-${storeKey}-${txid}.json`);

// Test Case A: Missing journal -> unknown
const missingRes = await readLimitedDiscountMutationEvidence({
  root: ROOT,
  storeKey,
  sourceRescuePath,
  journalDir,
});
assert.equal(missingRes.state, 'unknown');
assert.equal(missingRes.verified, false);

// Test Case B: Tampered / mismatched journal binding -> unknown
await fs.writeFile(journalPath, JSON.stringify({
  schemaVersion: 1,
  transactionId: txid,
  storeKey: 'FY', // mismatch store
  rescueHash: sourceRescueHash,
  mutationsStarted: false,
  snapshots: [],
  removals: [],
}), 'utf8');
const tamperedRes = await readLimitedDiscountMutationEvidence({
  root: ROOT,
  storeKey,
  sourceRescuePath,
  journalDir,
});
assert.equal(tamperedRes.state, 'unknown');
assert.equal(tamperedRes.verified, false);
assert.match(tamperedRes.reason, /binding mismatch/);

// Test Case C: Valid journal, pre-mutation phase ('initialized' / 'dry_run') and no attempts -> not_started
await fs.writeFile(journalPath, JSON.stringify({
  schemaVersion: 1,
  transactionId: txid,
  storeKey,
  rescueHash: sourceRescueHash,
  phase: 'initialized',
  mutationsStarted: false,
  snapshots: [],
  removals: [],
  createAttempt: null,
}), 'utf8');
const notStartedRes = await readLimitedDiscountMutationEvidence({
  root: ROOT,
  storeKey,
  sourceRescuePath,
  journalDir,
});
assert.equal(notStartedRes.state, 'not_started');
assert.equal(notStartedRes.verified, true);
assert.equal(notStartedRes.transactionId, txid);

// Test Case D: Mixed new SKC with no old conflicts -> already_exactly_covered without mutation -> not_started
await fs.writeFile(journalPath, JSON.stringify({
  schemaVersion: 1,
  transactionId: txid,
  storeKey,
  rescueHash: sourceRescueHash,
  phase: 'completed',
  mutationsStarted: false,
  snapshots: [],
  removals: [],
  createAttempt: null,
  result: {
    status: 'already_exactly_covered',
    writeAttempted: false,
    mutationsStarted: false,
  },
}), 'utf8');
const alreadyCoveredRes = await readLimitedDiscountMutationEvidence({
  root: ROOT,
  storeKey,
  sourceRescuePath,
  journalDir,
});
assert.equal(alreadyCoveredRes.state, 'not_started');
assert.equal(alreadyCoveredRes.verified, true);

// Test Case E: Conflict exists, mutation started or create/delete attempted -> started
await fs.writeFile(journalPath, JSON.stringify({
  schemaVersion: 1,
  transactionId: txid,
  storeKey,
  rescueHash: sourceRescueHash,
  phase: 'create_started',
  mutationsStarted: true,
  snapshots: [{skc: 'skc-1'}],
  removals: [],
  createAttempt: {startedAt: new Date().toISOString()},
}), 'utf8');
const startedRes = await readLimitedDiscountMutationEvidence({
  root: ROOT,
  storeKey,
  sourceRescuePath,
  journalDir,
});
assert.equal(startedRes.state, 'started');
assert.equal(startedRes.verified, true);

// Clean up
await fs.rm(tmpDir, {recursive: true, force: true});

console.log(JSON.stringify({
  ok: true,
  test: 'test_marketing_transaction_mutation_evidence passed all scenarios',
}, null, 2));
