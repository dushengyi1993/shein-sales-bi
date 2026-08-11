#!/usr/bin/env node
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shein-bi-marketing-snapshot-'));
const out = path.join(root, 'outputs', 'bi-portal', 'marketing-price-leads.json');
const script = path.join(process.cwd(), 'scripts', 'marketing', 'export_marketing_price_leads_for_bi.mjs');
const existing = {
  generatedAt: '2026-07-25T10:00:00.000Z',
  rowCount: 1,
  rows: [{store_key: 'DL', skc: 'sv-old', marketing_current_price_sar: 99}],
  sources: [{type: 'previous_live_scan'}],
};
try {
  await fs.mkdir(path.dirname(out), {recursive: true});
  await fs.writeFile(out, JSON.stringify(existing), 'utf8');

  const stale = spawnSync(process.execPath, [script, '--source-root', root, '--out', out], {encoding: 'utf8'});
  assert.equal(stale.status, 0, stale.stderr);
  let snapshot = JSON.parse(await fs.readFile(out, 'utf8'));
  assert.equal(snapshot.freshness.status, 'stale');
  assert.equal(snapshot.generatedAt, existing.generatedAt, 'a degraded check must not pretend the previous snapshot was regenerated');
  assert.deepEqual(snapshot.rows, existing.rows, 'a degraded check must preserve the last complete evidence rows');
  const staleRequired = spawnSync(process.execPath, [script, '--source-root', root, '--out', out, '--require-fresh'], {encoding: 'utf8'});
  assert.notEqual(staleRequired.status, 0, 'a freshness-gated BI publish must reject a stale preserved snapshot');
  snapshot = JSON.parse(await fs.readFile(out, 'utf8'));
  assert.equal(snapshot.freshness.status, 'stale', 'freshness-gated rejection must preserve stale metadata for diagnosis');
  assert.deepEqual(snapshot.rows, existing.rows, 'freshness-gated rejection must preserve the last complete rows');

  const emptyEvidenceDir = path.join(root, 'tmp', 'mbrs', 'marketing-stack-review-empty');
  await fs.mkdir(emptyEvidenceDir, {recursive: true});
  await fs.writeFile(path.join(emptyEvidenceDir, 'store-DL.json'), JSON.stringify({store: 'DL', rows: []}), 'utf8');
  const validButEmpty = spawnSync(process.execPath, [script, '--source-root', root, '--out', out], {encoding: 'utf8'});
  assert.equal(validButEmpty.status, 0, validButEmpty.stderr);
  snapshot = JSON.parse(await fs.readFile(out, 'utf8'));
  assert.equal(snapshot.freshness.status, 'stale', 'a readable source with zero effective rows is not proof of a fresh empty result');
  assert.deepEqual(snapshot.rows, existing.rows, 'zero effective rows must not erase the previous complete price evidence');
  assert.match(snapshot.freshness.reason, /没有形成任何有效价格行/);
  await fs.rm(path.join(root, 'tmp'), {recursive: true, force: true});

  const corruptDir = path.join(root, 'tmp', 'mbrs', 'marketing-stack-review-corrupt');
  await fs.mkdir(corruptDir, {recursive: true});
  await fs.writeFile(path.join(corruptDir, 'store-DL.json'), '{not json', 'utf8');
  const corrupt = spawnSync(process.execPath, [script, '--source-root', root, '--out', out], {encoding: 'utf8'});
  assert.equal(corrupt.status, 0, corrupt.stderr);
  snapshot = JSON.parse(await fs.readFile(out, 'utf8'));
  assert.equal(snapshot.freshness.status, 'error', 'a malformed evidence file must be visible as degraded metadata');
  assert.deepEqual(snapshot.rows, existing.rows, 'a malformed evidence file must not replace a complete prior snapshot with partial rows');
  const corruptRequired = spawnSync(process.execPath, [script, '--source-root', root, '--out', out, '--require-fresh'], {encoding: 'utf8'});
  assert.notEqual(corruptRequired.status, 0, 'a freshness-gated BI publish must reject malformed active evidence');
  snapshot = JSON.parse(await fs.readFile(out, 'utf8'));
  assert.equal(snapshot.freshness.status, 'error');
  assert.deepEqual(snapshot.rows, existing.rows);
  await fs.rm(path.join(root, 'tmp'), {recursive: true, force: true});

  const failed = spawnSync(process.execPath, [
    script,
    '--source-root', root,
    '--out', out,
    '--allow-empty-overwrite',
    '--inject-failure-before-write',
  ], {encoding: 'utf8'});
  assert.notEqual(failed.status, 0, 'an export failure must propagate to the refresh job');
  snapshot = JSON.parse(await fs.readFile(out, 'utf8'));
  assert.equal(snapshot.freshness.status, 'error');
  assert.deepEqual(snapshot.rows, existing.rows, 'an export error must preserve the last complete evidence rows');
  assert.match(snapshot.freshness.reason, /导出失败/);
} finally {
  await fs.rm(root, {recursive: true, force: true});
}

console.log('marketing_price_snapshot_health: stale/error metadata preserves old evidence and propagates real export failures');
