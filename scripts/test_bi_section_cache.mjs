#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {
  acceptsGzip,
  readBiSectionCache,
  readBiSectionCacheAnyGeneratedAt,
  readBiSectionCacheRaw,
  readBiSectionStaleRaw,
  writeBiSectionCache,
} from '../lib/bi_section_cache.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shein-bi-section-cache-'));
try {
  const rows = Array.from({length: 250}, (_, index) => ({index, label: `row-${index}`, value: index * 3}));
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
  const plainPayload = JSON.parse(plain.body.toString('utf8'));
  assert.equal(plainPayload.cacheHit, true);
  assert.equal(plain.headers['X-BI-Section-Mode'], 'raw-cache');

  const gzipped = await readBiSectionCacheRaw(root, 'sample', 'generation-1', false, {gzip: true});
  const gzipPayload = JSON.parse(gunzipSync(gzipped.body).toString('utf8'));
  assert.equal(gzipPayload.data.rows.length, rows.length);
  assert.equal(gzipped.headers['Content-Encoding'], 'gzip');
  assert.equal(gzipped.headers.Vary, 'Accept-Encoding');
  assert.ok((await fs.stat(path.join(root, 'sections', 'sample.json.gz'))).size > 0);

  const stale = await readBiSectionStaleRaw(root, 'sample', 'generation-2', {gzip: true, refreshScheduled: true});
  const stalePayload = JSON.parse(gunzipSync(stale.body).toString('utf8'));
  assert.equal(stalePayload.staleSection, true);
  assert.equal(stalePayload.cacheStale, true);
  assert.equal(stalePayload.refreshScheduled, true);
  assert.equal(stalePayload.coreGeneratedAt, 'generation-2');
  assert.equal(stale.headers['Cache-Control'], 'no-store');

  assert.equal(acceptsGzip('br, gzip, deflate'), true);
  assert.equal(acceptsGzip('br'), false);
  assert.equal(acceptsGzip('gzip;q=0, br'), false, 'q=0 explicitly rejects gzip');
  assert.equal(acceptsGzip('br, *;q=0.5'), true, 'wildcard accepts gzip when no explicit rule exists');
  assert.equal(acceptsGzip('gzip;q=0, *;q=1'), false, 'explicit gzip rule overrides wildcard');
  console.log('bi_section_cache: generation validation, raw/gzip serving, and stale metadata passed');
} finally {
  await fs.rm(root, {recursive: true, force: true});
}
