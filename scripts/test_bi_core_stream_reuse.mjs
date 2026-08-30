#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {__testHooks} from './serve_bi_portal.mjs';

const {
  readBiPortalCoreEnvelope,
  resetBiPortalCoreEnvelopeCache,
  biPortalCoreEnvelopeScanCount,
} = __testHooks;

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

    console.log('test_bi_core_stream_reuse: passed (failure recovery, concurrent 16 singleflight, serial 5 reuse, atomic replacement generation update)');
  } finally {
    await fs.rm(tmpDir, {recursive: true, force: true}).catch(() => {});
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
