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

function run(base, overlay, out) {
  return spawnSync(process.execPath, [
    'scripts/marketing/merge_current_marketing_price_scans.mjs',
    '--base', base,
    '--overlay', overlay,
    '--out', out,
  ], {cwd: process.cwd(), encoding: 'utf8'});
}

try {
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
  const out = path.join(tmp, 'merged.json');
  const mergedRun = run(base, overlay, out);
  assert.equal(mergedRun.status, 0, mergedRun.stderr || mergedRun.stdout);
  const merged = JSON.parse(await fs.readFile(out, 'utf8'));
  assert.deepEqual(merged.rows.map(row => row.skc), ['tz-new', 'jsh-keep']);
  assert.equal(merged.mergeEvidence.overlays[0].storeKey, 'TZ');

  const stale = await write('stale.json', snapshot({
    timestamp: '2026-07-16T07:59:59+08:00',
    stores: ['TZ'],
    rows: [{store_key: 'TZ', skc: 'stale'}],
  }));
  const staleRun = run(base, stale, path.join(tmp, 'stale-out.json'));
  assert.notEqual(staleRun.status, 0);
  assert.match(staleRun.stderr, /not newer than base/);

  const partial = await write('partial.json', snapshot({
    timestamp: '2026-07-16T10:00:00+08:00',
    stores: ['TZ'],
    rows: [{store_key: 'TZ', skc: 'partial'}],
    partial: true,
  }));
  const partialRun = run(base, partial, path.join(tmp, 'partial-out.json'));
  assert.notEqual(partialRun.status, 0);
  assert.match(partialRun.stderr, /completed successful scan/);

  const inconsistent = snapshot({
    timestamp: '2026-07-16T10:00:00+08:00',
    stores: ['TZ'],
    rows: [{store_key: 'TZ', skc: 'top-level'}],
  });
  inconsistent.stores[0].rows = [{store_key: 'TZ', skc: 'embedded-other'}];
  const inconsistentPath = await write('inconsistent.json', inconsistent);
  const inconsistentRun = run(base, inconsistentPath, path.join(tmp, 'inconsistent-out.json'));
  assert.notEqual(inconsistentRun.status, 0);
  assert.match(inconsistentRun.stderr, /embedded rows do not match/);

  console.log(JSON.stringify({
    ok: true,
    test: 'marketing_price_scan_merge_requires_newer_complete_consistent_snapshots',
  }));
} finally {
  await fs.rm(tmp, {recursive: true, force: true});
}
