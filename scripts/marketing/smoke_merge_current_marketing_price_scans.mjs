#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-marketing-price-scans-'));

function snapshot({timestamp, stores, rows, ok = true, partial = false}) {
  return {
    ok,
    partial,
    createdAt: timestamp,
    stores: stores.map(store => ({
      store,
      ok: true,
      rows: rows.filter(row => row.store_key === store),
    })),
    rows,
    rowCount: rows.length,
  };
}

async function write(name, value) {
  const file = path.join(tmp, name);
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}

function run(base, overlays, out, storesConfig) {
  return spawnSync(process.execPath, [
    'scripts/marketing/merge_current_marketing_price_scans.mjs',
    '--base', base,
    ...overlays.flatMap(overlay => ['--overlay', overlay]),
    '--out', out,
    '--stores-config', storesConfig,
  ], {cwd: process.cwd(), encoding: 'utf8'});
}

try {
  const storesConfig = await write('stores-config.json', {
    stores: ['TZ', 'JSH'].map(storeKey => ({storeKey, enabled: true})),
  });
  const partialStoresConfig = await write('partial-stores-config.json', {
    stores: ['A', 'B', 'C'].map(storeKey => ({storeKey, enabled: true})),
  });
  const baseRows = [
    {store_key: 'TZ', skc: 'tz-old', marketing_price_evidence_type: 'current_limited_discount'},
    {store_key: 'JSH', skc: 'jsh-keep', marketing_price_evidence_type: 'future_ordinary'},
  ];
  const base = await write('base.json', snapshot({
    timestamp: '2026-07-16T08:00:00+08:00',
    stores: ['TZ', 'JSH'],
    rows: baseRows,
  }));
  const overlay = await write('overlay.json', snapshot({
    timestamp: '2026-07-16T09:00:00+08:00',
    stores: ['TZ'],
    rows: [{store_key: 'TZ', skc: 'tz-new', marketing_price_evidence_type: 'current_limited_discount'}],
  }));
  const newerOverlay = await write('newer-overlay.json', snapshot({
    timestamp: '2026-07-16T10:00:00+08:00',
    stores: ['TZ'],
    rows: [{store_key: 'TZ', skc: 'tz-newest', marketing_price_evidence_type: 'current_limited_discount'}],
  }));
  const out = path.join(tmp, 'merged.json');
  const mergedRun = run(base, [newerOverlay, overlay], out, storesConfig);
  assert.equal(mergedRun.status, 0, mergedRun.stderr || mergedRun.stdout);
  const merged = JSON.parse(await fs.readFile(out, 'utf8'));
  assert.deepEqual(merged.rows.map(row => row.skc), ['tz-newest', 'jsh-keep'],
    'the latest same-store overlay wins even when the older overlay appears later in argv');
  assert.equal(merged.mergeEvidence.businessDate, '2026-07-16');
  assert.match(merged.mergeEvidence.base.sha256, /^[a-f0-9]{64}$/);
  assert.match(merged.mergeEvidence.overlays[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(merged.mergeEvidence.overlays[0].storeKey, 'TZ');
  assert.equal(merged.mergeEvidence.overlays[0].source, newerOverlay);
  const reversedOut = path.join(tmp, 'merged-reversed.json');
  const reversedRun = run(base, [overlay, newerOverlay], reversedOut, storesConfig);
  assert.equal(reversedRun.status, 0, reversedRun.stderr || reversedRun.stdout);
  const reversed = JSON.parse(await fs.readFile(reversedOut, 'utf8'));
  assert.deepEqual(reversed.rows, merged.rows, 'overlay parameter order must not affect merged rows');
  assert.deepEqual(reversed.mergeEvidence.overlays, merged.mergeEvidence.overlays,
    'overlay parameter order must not affect selected overlay evidence');

  const partialBase = await write('partial-base.json', snapshot({
    timestamp: '2026-07-16T08:00:00+08:00',
    stores: ['A', 'B', 'C'],
    rows: [
      {store_key: 'A', skc: 'a-old'},
      {store_key: 'B', skc: 'b-old'},
      {store_key: 'C', skc: 'c-failed'},
    ],
    ok: false,
    partial: true,
  }));
  const partialBaseDoc = JSON.parse(await fs.readFile(partialBase, 'utf8'));
  partialBaseDoc.stores[2].ok = false;
  await fs.writeFile(partialBase, `${JSON.stringify(partialBaseDoc, null, 2)}\n`, 'utf8');
  const preciseSupplement = await write('same-day-precise-supplement.json', snapshot({
    timestamp: '2026-07-16T09:00:00+08:00',
    stores: ['C'],
    rows: [{store_key: 'C', skc: 'c-fixed'}],
  }));
  const supplementedOut = path.join(tmp, 'supplemented.json');
  const supplementedRun = run(partialBase, [preciseSupplement], supplementedOut, partialStoresConfig);
  assert.equal(supplementedRun.status, 0, supplementedRun.stderr || supplementedRun.stdout);
  const supplemented = JSON.parse(await fs.readFile(supplementedOut, 'utf8'));
  assert.deepEqual(supplemented.rows.map(row => row.skc), ['a-old', 'b-old', 'c-fixed']);
  assert.deepEqual(supplemented.mergeEvidence.storeKeys, ['A', 'B', 'C']);

  const oldDay = await write('old-day.json', snapshot({
    timestamp: '2026-07-15T09:00:00+08:00',
    stores: ['C'],
    rows: [{store_key: 'C', skc: 'old-day'}],
  }));
  const oldDayRun = run(partialBase, [oldDay], path.join(tmp, 'old-day-out.json'), partialStoresConfig);
  assert.notEqual(oldDayRun.status, 0);
  assert.match(oldDayRun.stderr, /business date mismatch/);

  const stale = await write('stale.json', snapshot({
    timestamp: '2026-07-16T07:59:59+08:00',
    stores: ['TZ'],
    rows: [{store_key: 'TZ', skc: 'stale'}],
  }));
  const staleRun = run(base, [stale], path.join(tmp, 'stale-out.json'), storesConfig);
  assert.notEqual(staleRun.status, 0);
  assert.match(staleRun.stderr, /not newer than base/);

  const partial = await write('partial.json', snapshot({
    timestamp: '2026-07-16T10:00:00+08:00',
    stores: ['TZ'],
    rows: [{store_key: 'TZ', skc: 'partial'}],
    partial: true,
  }));
  const partialRun = run(base, [partial], path.join(tmp, 'partial-out.json'), storesConfig);
  assert.notEqual(partialRun.status, 0);
  assert.match(partialRun.stderr, /completed successful scan/);

  const inconsistent = snapshot({
    timestamp: '2026-07-16T10:00:00+08:00',
    stores: ['TZ'],
    rows: [{store_key: 'TZ', skc: 'top-level'}],
  });
  inconsistent.stores[0].rows = [{store_key: 'TZ', skc: 'embedded-other'}];
  const inconsistentPath = await write('inconsistent.json', inconsistent);
  const inconsistentRun = run(base, [inconsistentPath], path.join(tmp, 'inconsistent-out.json'), storesConfig);
  assert.notEqual(inconsistentRun.status, 0);
  assert.match(inconsistentRun.stderr, /embedded rows do not match/);

  const missingStoreConfig = await write('missing-store-config.json', {
    stores: ['TZ', 'JSH', 'EXTRA'].map(storeKey => ({storeKey, enabled: true})),
  });
  const missingStoreRun = run(base, [overlay], path.join(tmp, 'missing-store-out.json'), missingStoreConfig);
  assert.notEqual(missingStoreRun.status, 0);
  assert.match(missingStoreRun.stderr, /merged store set mismatch: missing=EXTRA/);

  const unknownOverlay = await write('unknown-overlay.json', snapshot({
    timestamp: '2026-07-16T10:30:00+08:00',
    stores: ['UNKNOWN'],
    rows: [{store_key: 'UNKNOWN', skc: 'unknown'}],
  }));
  const unknownStoreRun = run(base, [unknownOverlay], path.join(tmp, 'unknown-store-out.json'), storesConfig);
  assert.notEqual(unknownStoreRun.status, 0);
  assert.match(unknownStoreRun.stderr, /contains unknown store UNKNOWN/);

  const unknownBase = await write('unknown-base.json', snapshot({
    timestamp: '2026-07-16T08:00:00+08:00',
    stores: ['TZ', 'UNKNOWN'],
    rows: [{store_key: 'TZ', skc: 'tz-old'}, {store_key: 'UNKNOWN', skc: 'unknown-old'}],
  }));
  const unknownBaseRun = run(unknownBase, [overlay], path.join(tmp, 'unknown-base-out.json'), storesConfig);
  assert.notEqual(unknownBaseRun.status, 0);
  assert.match(unknownBaseRun.stderr, /base contains unknown store\(s\): UNKNOWN/);

  console.log(JSON.stringify({
    ok: true,
    test: 'marketing_price_scan_merge_requires_same_day_precise_supplements',
  }));
} finally {
  await fs.rm(tmp, {recursive: true, force: true});
}
