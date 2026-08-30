#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';

import {__testHooks} from './serve_bi_portal.mjs';

const {
  readBiPortalCoreEnvelope,
  resetBiPortalCoreEnvelopeCache,
  biPortalCoreEnvelopeScanCount,
  cleanupBiPortalCoreSnapshotResidue,
  createBiPortalCoreSnapshotCache,
  evaluateBiPortalCoreSnapshotLifecycleHealth,
} = __testHooks;

const MiB = 1024 * 1024;
const SNAPSHOT_PREFIX = 'shein-bi-portal-core-snapshot-v1-';

async function writeCore(file, generatedAt, payloadBytes) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const handle = await fs.open(file, 'w');
  try {
    await handle.write(Buffer.from(`{"generatedAt":${JSON.stringify(generatedAt)},"audit":null,"payload":"`));
    const chunk = Buffer.alloc(MiB, 0x78);
    let remaining = payloadBytes;
    while (remaining > 0) {
      const length = Math.min(remaining, chunk.length);
      await handle.write(chunk, 0, length);
      remaining -= length;
    }
    await handle.write(Buffer.from('"}'));
  } finally {
    await handle.close();
  }
}

async function waitFor(read, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function testSnapshotReuseAndLifecycle(tmpDir) {
  const cleanupRoot = path.join(tmpDir, 'cleanup-root');
  const cleanupDir = path.join(tmpDir, 'cleanup-snapshots');
  await fs.mkdir(cleanupDir, {recursive: true});
  const staleRaw = `${SNAPSHOT_PREFIX}stale.raw.json`;
  const staleGzip = `${SNAPSHOT_PREFIX}stale.gzip.json.gz`;
  const wrongSuffix = `${SNAPSHOT_PREFIX}preserve.txt`;
  await fs.writeFile(path.join(cleanupDir, staleRaw), 'stale');
  await fs.writeFile(path.join(cleanupDir, staleGzip), 'stale');
  await fs.writeFile(path.join(cleanupDir, wrongSuffix), 'preserve');
  await fs.writeFile(path.join(cleanupDir, 'unrelated.raw.json'), 'preserve');
  const startupCleanup = await cleanupBiPortalCoreSnapshotResidue(cleanupRoot, {snapshotDir: cleanupDir});
  assert.equal(startupCleanup.examined, 2);
  assert.equal(startupCleanup.removed, 2);
  assert.deepEqual(startupCleanup.failures, []);
  assert.deepEqual((await fs.readdir(cleanupDir)).sort(), [wrongSuffix, 'unrelated.raw.json'].sort(),
    'startup cleanup must remove only the exact snapshot prefix/suffix set');

  const generatedAt = '2026-08-30T12:00:00.000000+08:00';
  const largeRoot = path.join(tmpDir, 'large-root');
  const largeFile = path.join(largeRoot, 'data.json');
  const snapshotDir = path.join(tmpDir, 'large-snapshots');
  await writeCore(largeFile, generatedAt, 200 * MiB);
  const expectedBytes = 200 * MiB
    + Buffer.byteLength(`{"generatedAt":${JSON.stringify(generatedAt)},"audit":null,"payload":""}`);

  resetBiPortalCoreEnvelopeCache();
  for (let index = 0; index < 3; index += 1) {
    const envelope = await readBiPortalCoreEnvelope(largeRoot);
    assert.equal(envelope.generatedAt, generatedAt);
    assert.equal(envelope.byteLength, expectedBytes);
  }
  assert.equal(biPortalCoreEnvelopeScanCount(), 1,
    'serial metadata reads must share one bounded 200 MiB envelope scan');

  const manager = createBiPortalCoreSnapshotCache({root: largeRoot, snapshotDir});
  for (let index = 0; index < 9; index += 1) {
    const lease = await manager.acquire({gzip: index % 2 === 1, evidence: null});
    assert.equal(lease.rawByteLength, expectedBytes);
    assert.equal(manager.status().requestLeases, 1);
    lease.release();
    const afterRelease = manager.status();
    assert.equal(afterRelease.requestLeases, 0);
    assert.equal(afterRelease.active, 1, 'last request release must retain the current owner cache');
    assert.equal(afterRelease.openHandles, 2);
  }
  const largeStatus = manager.status();
  assert.equal(largeStatus.builds, 1,
    'unchanged 200 MiB generation must scan/build raw+gzip snapshot exactly once');
  assert.equal(biPortalCoreEnvelopeScanCount(), 1,
    'snapshot build must reuse the metadata scan for the unchanged generation');
  assert.deepEqual(
    (({active, retired, requestLeases, openHandles, closeFailures}) => (
      {active, retired, requestLeases, openHandles, closeFailures}
    ))(largeStatus),
    {active: 1, retired: 0, requestLeases: 0, openHandles: 2, closeFailures: 0},
  );
  assert.equal(evaluateBiPortalCoreSnapshotLifecycleHealth(largeStatus).ok, true);
  const largeShutdown = await manager.shutdown({timeoutMs: 5_000});
  assert.equal(largeShutdown.active, 0);
  assert.equal(largeShutdown.retired, 0);
  assert.equal(largeShutdown.openHandles, 0);

  const cacheHitSwapRoot = path.join(tmpDir, 'cache-hit-swap-root');
  const cacheHitSwapFile = path.join(cacheHitSwapRoot, 'data.json');
  const cacheHitSwapReplacement = path.join(cacheHitSwapRoot, 'data.replacement.json');
  const cacheHitGeneration1 = '2026-08-30T12:00:30.000000+08:00';
  const cacheHitGeneration2 = '2026-08-30T12:00:31.000000+08:00';
  await writeCore(cacheHitSwapFile, cacheHitGeneration1, MiB);
  let swapOnCacheHit = false;
  let cacheHitReadbacks = 0;
  const cacheHitSwapManager = createBiPortalCoreSnapshotCache({
    root: cacheHitSwapRoot,
    snapshotDir: path.join(tmpDir, 'cache-hit-swap-snapshots'),
    async onBeforeCacheHitIdentityReadback() {
      cacheHitReadbacks += 1;
      if (!swapOnCacheHit) return;
      swapOnCacheHit = false;
      await writeCore(cacheHitSwapReplacement, cacheHitGeneration2, MiB);
      await fs.rename(cacheHitSwapReplacement, cacheHitSwapFile);
    },
  });
  const firstCacheHitLease = await cacheHitSwapManager.acquire({evidence: null});
  assert.equal(firstCacheHitLease.generatedAt, cacheHitGeneration1);
  firstCacheHitLease.release();
  swapOnCacheHit = true;
  const replacedCacheHitLease = await cacheHitSwapManager.acquire({evidence: null});
  assert.equal(replacedCacheHitLease.generatedAt, cacheHitGeneration2,
    'cache-hit pathname replacement must rebuild instead of leasing the retired generation');
  assert.equal(cacheHitSwapManager.status().builds, 2);
  assert.equal(cacheHitReadbacks, 1, 'the deterministic swap seam must run only on the cache-hit path');
  replacedCacheHitLease.release();
  const cacheHitSwapShutdown = await cacheHitSwapManager.shutdown({timeoutMs: 5_000});
  assert.equal(cacheHitSwapShutdown.active, 0);
  assert.equal(cacheHitSwapShutdown.retired, 0);
  assert.equal(cacheHitSwapShutdown.openHandles, 0);

  const leasedRetirementRoot = path.join(tmpDir, 'leased-retirement-root');
  const leasedRetirementFile = path.join(leasedRetirementRoot, 'data.json');
  const leasedRetirementReplacement = path.join(leasedRetirementRoot, 'data.replacement.json');
  const leasedGeneration1 = '2026-08-30T12:00:40.000000+08:00';
  const leasedGeneration2 = '2026-08-30T12:00:41.000000+08:00';
  await writeCore(leasedRetirementFile, leasedGeneration1, MiB);
  const leasedRetirementManager = createBiPortalCoreSnapshotCache({
    root: leasedRetirementRoot,
    snapshotDir: path.join(tmpDir, 'leased-retirement-snapshots'),
  });
  const generation1Lease = await leasedRetirementManager.acquire({evidence: null});
  assert.equal(generation1Lease.generatedAt, leasedGeneration1);
  await writeCore(leasedRetirementReplacement, leasedGeneration2, MiB);
  await fs.rename(leasedRetirementReplacement, leasedRetirementFile);
  const generation2Lease = await leasedRetirementManager.acquire({evidence: null});
  assert.equal(generation2Lease.generatedAt, leasedGeneration2);
  generation2Lease.release();
  const leasedRetiredStatus = leasedRetirementManager.status();
  assert.deepEqual(
    (({
      active,
      retired,
      retiredWithLeases,
      retiredWithoutLeases,
      requestLeases,
      openHandles,
      closeFailures,
      retries,
    }) => ({
      active,
      retired,
      retiredWithLeases,
      retiredWithoutLeases,
      requestLeases,
      openHandles,
      closeFailures,
      retries,
    }))(leasedRetiredStatus),
    {
      active: 1,
      retired: 1,
      retiredWithLeases: 1,
      retiredWithoutLeases: 0,
      requestLeases: 1,
      openHandles: 4,
      closeFailures: 0,
      retries: 0,
    },
  );
  const leasedRetiredHealth = evaluateBiPortalCoreSnapshotLifecycleHealth(leasedRetiredStatus);
  assert.equal(leasedRetiredHealth.ok, true,
    'a retired generation protected by a live request lease must remain healthy');
  assert.equal(leasedRetiredHealth.expectedOwnerOpenHandles, 4);
  generation1Lease.release();
  const leasedRetirementRecovered = await waitFor(() => {
    const status = leasedRetirementManager.status();
    return status.active === 1 && status.retired === 0 && status.openHandles === 2 ? status : null;
  }, 'leased retired generation cleanup');
  assert.equal(evaluateBiPortalCoreSnapshotLifecycleHealth(leasedRetirementRecovered).ok, true);
  const leasedRetirementShutdown = await leasedRetirementManager.shutdown({timeoutMs: 5_000});
  assert.equal(leasedRetirementShutdown.retired, 0);
  assert.equal(leasedRetirementShutdown.openHandles, 0);

  const retryRoot = path.join(tmpDir, 'retry-root');
  await writeCore(path.join(retryRoot, 'data.json'), '2026-08-30T12:01:00.000000+08:00', MiB);
  let injectedFailures = 2;
  const retryManager = createBiPortalCoreSnapshotCache({
    root: retryRoot,
    snapshotDir: path.join(tmpDir, 'retry-snapshots'),
    retryBaseMs: 40,
    retryMaxMs: 40,
    maxRetries: 4,
    async closeHandle(handle) {
      if (injectedFailures > 0) {
        injectedFailures -= 1;
        const error = new Error('injected transient close failure');
        error.code = 'EIO';
        throw error;
      }
      await handle.close();
    },
  });
  const retryLease = await retryManager.acquire({evidence: null});
  retryLease.release();
  retryManager.stopAdmitting();
  const visibleFailure = await waitFor(() => {
    const status = retryManager.status();
    return status.closeFailures > 0 && status.retries > 0 ? status : null;
  }, 'retired close failure health');
  assert.equal(visibleFailure.retired, 1);
  assert.equal(visibleFailure.retiredWithLeases, 0);
  assert.equal(visibleFailure.retiredWithoutLeases, 1);
  assert.equal(visibleFailure.openHandles, 2);
  const visibleFailureHealth = evaluateBiPortalCoreSnapshotLifecycleHealth(visibleFailure);
  assert.equal(visibleFailureHealth.ok, false);
  assert.ok(visibleFailureHealth.issues.includes('retiredWithoutLeases'));
  assert.ok(visibleFailureHealth.issues.includes('openHandles'));
  assert.ok(visibleFailureHealth.issues.includes('closeFailures'));
  const retryShutdown = await retryManager.shutdown({timeoutMs: 1_000});
  assert.equal(retryShutdown.retired, 0);
  assert.equal(retryShutdown.openHandles, 0);
  assert.equal(retryShutdown.closeFailures, 0);
  assert.equal(retryShutdown.retries, 0);
  assert.ok(retryShutdown.closeFailureTotal >= 2);
  assert.ok(retryShutdown.retryTotal >= 1);
  const retryTotalAfterShutdown = retryManager.status().retryTotal;
  await delay(200);
  assert.equal(retryManager.status().retryTotal, retryTotalAfterShutdown,
    'successful shutdown must leave no timer able to schedule another retry');
}

async function main() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bi-core-stream-reuse-'));
  try {
    const gen1 = '2026-08-30T10:00:00.000000+08:00';
    const gen2 = '2026-08-30T11:00:00.000000+08:00';
    const dataFile = path.join(tmpDir, 'data.json');

    // Test invalid JSON first to verify failure map cleanup and recovery
    await fs.writeFile(dataFile, 'INVALID JSON CONTENT', 'utf8');
    resetBiPortalCoreEnvelopeCache();
    await assert.rejects(
      () => readBiPortalCoreEnvelope(tmpDir),
      err => err?.code === 'ROOT_NOT_OBJECT' || /JSON root must be an object/i.test(err?.message)
    );
    assert.equal(biPortalCoreEnvelopeScanCount(), 1, 'first failed scan counted');

    // Now write valid data.json -> next read recovers and succeeds
    await fs.writeFile(dataFile, JSON.stringify({
      generatedAt: gen1,
      __sections: {mode: 'full', generatedAt: gen1},
      audit: {ok: true},
    }, null, 2), 'utf8');

    // 1. Concurrent 16 reads on generation 1 -> exactly 1 additional scan (singleflight)
    const concurrent16 = await Promise.all(
      Array.from({length: 16}, () => readBiPortalCoreEnvelope(tmpDir))
    );
    assert.equal(concurrent16.length, 16);
    for (const env of concurrent16) {
      assert.equal(env.generatedAt, gen1);
    }
    assert.equal(biPortalCoreEnvelopeScanCount(), 2, '16 concurrent reads performed exactly 1 recovery scan');

    // 2. Serial 5 reads on generation 1 -> still 2 scans total (cache reuse)
    for (let i = 0; i < 5; i++) {
      const env = await readBiPortalCoreEnvelope(tmpDir);
      assert.equal(env.generatedAt, gen1);
    }
    assert.equal(biPortalCoreEnvelopeScanCount(), 2, '5 serial reads reused cached envelope');

    // 3. Atomic replacement of data.json -> next read triggers scan + 1 and reads new generation
    const tmpNewFile = path.join(tmpDir, 'data.json.tmp');
    await fs.writeFile(tmpNewFile, JSON.stringify({
      generatedAt: gen2,
      __sections: {mode: 'full', generatedAt: gen2},
      audit: {ok: true, v: 2},
    }, null, 2), 'utf8');
    await fs.rename(tmpNewFile, dataFile);

    const env2 = await readBiPortalCoreEnvelope(tmpDir);
    assert.equal(env2.generatedAt, gen2);
    assert.equal(biPortalCoreEnvelopeScanCount(), 3, 'replacement triggered exactly scan + 1');

    await testSnapshotReuseAndLifecycle(tmpDir);

    console.log('test_bi_core_stream_reuse: passed (failure recovery, envelope singleflight, 200MiB unchanged generation build=1, cache-hit path-swap rejection, leased retirement health, owner/lease separation, startup prefix cleanup, terminal autonomous close retry)');
  } finally {
    await fs.rm(tmpDir, {recursive: true, force: true}).catch(() => {});
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
