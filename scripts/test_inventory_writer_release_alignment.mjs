#!/usr/bin/env node

import assert from 'node:assert/strict';

import {
  assertInventoryWriterReleaseAligned,
  InventoryAlignmentError,
} from './inventory/assert_inventory_writer_release_aligned.mjs';

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

console.log('inventory_writer_release_alignment: aligned, commit drift, pending rotation, and source drift cases passed');
