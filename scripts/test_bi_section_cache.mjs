#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {
  BI_SECTION_INTEGRITY_IN_FLIGHT_MAX,
  acceptsGzip,
  createUniqueKeyLimiter,
  readBiSectionCache,
  readBiSectionCacheAnyGeneratedAt,
  readBiSectionCacheRaw,
  readBiSectionStaleRaw,
  writeBiSectionCache,
} from '../lib/bi_section_cache.mjs';

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shein-bi-section-cache-'));
try {
  const rows = Array.from({length: 250}, (_, index) => ({index, label: 'row-' + index, value: index * 3}));
  const written = await writeBiSectionCache(root, 'sample', 'generation-1', {rows}, {
    code: 0,
    timedOut: false,
    stderr: 'safe diagnostic',
  });
  assert.equal(written.section, 'sample');
  assert.equal(written.data.rows.length, rows.length);

  const parsed = await readBiSectionCache(root, 'sample', 'generation-1');
  assert.equal(parsed.data.rows[249].value, 747);
  assert.equal(await readBiSectionCache(root, 'sample', 'generation-2'), null, 'generation mismatches are rejected');
  assert.equal((await readBiSectionCacheAnyGeneratedAt(root, 'sample')).generatedAt, 'generation-1');

  const plain = await readBiSectionCacheRaw(root, 'sample', 'generation-1', true);
  const plainPayload = JSON.parse((await collect(plain.stream)).toString('utf8'));
  assert.equal(plainPayload.cacheHit, true);
  assert.equal(plain.headers['X-BI-Section-Mode'], 'raw-cache');

  const gzipped = await readBiSectionCacheRaw(root, 'sample', 'generation-1', false, {gzip: true});
  const gzipPayload = JSON.parse(gunzipSync(await collect(gzipped.stream)).toString('utf8'));
  assert.equal(gzipPayload.data.rows.length, rows.length);
  assert.equal(gzipped.headers['Content-Encoding'], 'gzip');
  assert.equal(gzipped.headers.Vary, 'Accept-Encoding');
  assert.ok((await fs.stat(path.join(root, 'sections', 'sample.json.gz'))).size > 0);

  const stale = await readBiSectionStaleRaw(root, 'sample', 'generation-2', {
    gzip: true,
    refreshScheduled: true,
    extraFields: {
      refreshFailed: true,
      refreshFailedAt: '2026-07-26T12:00:00.000Z',
      refreshError: 'database timeout',
    },
  });
  const stalePayload = JSON.parse(gunzipSync(await collect(stale.stream)).toString('utf8'));
  assert.equal(stalePayload.staleSection, true);
  assert.equal(stalePayload.cacheStale, true);
  assert.equal(stalePayload.refreshScheduled, true);
  assert.equal(stalePayload.coreGeneratedAt, 'generation-2');
  assert.equal(stalePayload.refreshFailed, true);
  assert.equal(stalePayload.refreshFailedAt, '2026-07-26T12:00:00.000Z');
  assert.equal(stalePayload.refreshError, 'database timeout');
  assert.equal(stale.headers['Cache-Control'], 'no-store');

  assert.equal(acceptsGzip('br, gzip, deflate'), true);
  assert.equal(acceptsGzip('br'), false);
  assert.equal(acceptsGzip('gzip;q=0, br'), false, 'q=0 explicitly rejects gzip');
  assert.equal(acceptsGzip('br, *;q=0.5'), true, 'wildcard accepts gzip when no explicit rule exists');
  assert.equal(acceptsGzip('gzip;q=0, *;q=1'), false, 'explicit gzip rule overrides wildcard');

  // Integrity revalidation admission limiter, bound to the production
  // constant: BI_SECTION_INTEGRITY_IN_FLIGHT_MAX must equal 2 to keep
  // 30-100MB scan+hash+gzip revalidations across 20 Portal sections inside
  // the Portal resource budget. The cap holds before a real validation starts, the
  // third distinct key never starts before either admitted key settles, a repeated
  // key shares one promise, and failure frees the slot. Deterministic:
  // workers run synchronously on admission and promises are settled by
  // hand, so no wall-clock timing is involved.
  {
    assert.equal(BI_SECTION_INTEGRITY_IN_FLIGHT_MAX, 2,
      'production revalidation cap must stay locked to 2');
    const started = [];
    const inflight = [];
    const limiter = createUniqueKeyLimiter(BI_SECTION_INTEGRITY_IN_FLIGHT_MAX, key => {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      started.push(key);
      inflight.push({key, resolve, reject});
      return promise;
    });
    const pending = ['k1', 'k2', 'k3', 'k4'].map(key => limiter.submit(key, [key]));
    assert.deepEqual(started, ['k1', 'k2'],
      'the third distinct key must never start before either admitted key settles');
    assert.deepEqual(limiter.stats(), {active: 2, queued: 2, size: 4},
      'over-cap keys must be queued, not started, once the cap is reached');
    inflight[0].resolve('k1-ok');
    assert.equal(await pending[0], 'k1-ok');
    assert.deepEqual(started, ['k1', 'k2', 'k3'],
      'a freed slot must admit the next FIFO waiter');
    assert.deepEqual(limiter.stats(), {active: 2, queued: 1, size: 3});
    assert.ok(!started.includes('k4'), 'k4 must remain queued while the cap is full');
    inflight[1].resolve('k2-ok');
    await Promise.resolve();
    assert.ok(started.includes('k4'), 'k4 must start as soon as k2 frees a slot');
    inflight[2].resolve('k3-ok');
    inflight[3].resolve('k4-ok');
    assert.deepEqual(await Promise.all(pending), ['k1-ok', 'k2-ok', 'k3-ok', 'k4-ok']);
    assert.deepEqual(started, ['k1', 'k2', 'k3', 'k4'],
      'every queued key must run once a slot frees');
    assert.deepEqual(limiter.stats(), {active: 0, queued: 0, size: 0},
      'success paths must release every slot and entry');
  }

  // The same key shares one promise both while running and while queued.
  {
    const started = [];
    const inflight = [];
    const limiter = createUniqueKeyLimiter(1, key => {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      started.push(key);
      inflight.push({key, resolve, reject});
      return promise;
    });
    const running = limiter.submit('dup', ['dup']);
    const runningDup = limiter.submit('dup', ['dup']);
    assert.equal(running, runningDup, 'a running key must share the exact same promise');
    assert.deepEqual(started, ['dup'], 'duplicate submits must not start a second validation');
    const queued = limiter.submit('wait', ['wait']);
    const queuedDup = limiter.submit('wait', ['wait']);
    assert.equal(queued, queuedDup, 'a queued key must share the exact same promise');
    assert.deepEqual(started, ['dup']);
    assert.equal(limiter.stats().queued, 1);
    inflight[0].resolve('dup-ok');
    assert.equal(await running, 'dup-ok');
    assert.equal(await runningDup, 'dup-ok', 'a deduplicated awaiter observes the same outcome');
    assert.deepEqual(started, ['dup', 'wait'], 'the queued duplicate starts exactly once');
    inflight[1].resolve('wait-ok');
    assert.equal(await queued, 'wait-ok');
    assert.deepEqual(limiter.stats(), {active: 0, queued: 0, size: 0});
  }

  // A failed worker must release its slot so the next task can proceed.
  {
    const started = [];
    const inflight = [];
    const limiter = createUniqueKeyLimiter(1, key => {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      started.push(key);
      inflight.push({key, resolve, reject});
      return promise;
    });
    const failing = limiter.submit('boom', ['boom']);
    const queued = limiter.submit('after', ['after']);
    assert.deepEqual(started, ['boom']);
    assert.equal(limiter.stats().queued, 1);
    inflight[0].reject(new Error('integrity validation exploded'));
    await assert.rejects(failing, /integrity validation exploded/);
    assert.deepEqual(started, ['boom', 'after'],
      'a failed worker must release its slot to the next FIFO waiter');
    inflight[1].resolve('after-ok');
    assert.equal(await queued, 'after-ok');
    assert.deepEqual(limiter.stats(), {active: 0, queued: 0, size: 0},
      'a failure must not leave a pinning slot or entry behind');
 }

  // Illegal limits fail loudly and synchronously at construction -- before any
  // worker or queue exists -- so a bad cap can neither be coerced/clamped to 1
  // nor leave an over-cap queue permanently unadmitted (the NaN cap made the
  // admission predicate always false). Legal positive integers keep FIFO
  // admission, same-key promise sharing and success-path slot release.
  {
    const worker = () => Promise.resolve('ok');
    for (const bad of [NaN, Infinity, -Infinity, 0, -0, -1, 1.5, -2.5]) {
      assert.throws(() => createUniqueKeyLimiter(bad, worker), RangeError,
        'non-finite, non-positive or fractional limit must throw RangeError synchronously');
    }
    for (const bad of [null, undefined, '2', 2n, {}, [], true, 'abc']) {
      assert.throws(() => createUniqueKeyLimiter(bad, worker), TypeError,
        'non-number limit must throw TypeError synchronously');
    }
    for (const legal of [1, 2, 3, 64, Number.MAX_SAFE_INTEGER]) {
      assert.doesNotThrow(() => createUniqueKeyLimiter(legal, worker),
        'legal positive integers must still construct');
    }
    const limiter = createUniqueKeyLimiter(3, worker);
    assert.deepEqual(limiter.stats(), {active: 0, queued: 0, size: 0},
      'a legal cap starts with no active, queued or registered key');
    assert.equal(await limiter.submit('ok', ['ok']), 'ok');
    assert.deepEqual(limiter.stats(), {active: 0, queued: 0, size: 0},
      'a legal cap must keep success-path slot release working');
  }
  console.log('bi_section_cache: generation validation, raw/gzip serving, and stale metadata passed');
} finally {
  await fs.rm(root, {recursive: true, force: true});
}
