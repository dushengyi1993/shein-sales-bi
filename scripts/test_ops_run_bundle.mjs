#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

import {
  OPS_EXIT_CODES,
  buildOpsRun,
  compactOpsRun,
  exitCodeForOutcome,
  invalidateOpsRunManifest,
  verifyOpsRunManifest,
  writeOpsJsonArtifactAtomic,
  writeOpsRunManifest,
} from '../lib/ops_run_bundle.mjs';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'shein-ops-run-'));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  assert.equal(exitCodeForOutcome('succeeded'), OPS_EXIT_CODES.succeeded);
  assert.equal(exitCodeForOutcome('blocked'), OPS_EXIT_CODES.blocked);
  assert.equal(exitCodeForOutcome('incomplete'), OPS_EXIT_CODES.incomplete);

  const artifact = path.join(tmp, 'evidence.json');
  await fs.writeFile(artifact, '{"ok":true}\n', 'utf8');
  const run = buildOpsRun({
    runId: 'test-run',
    operation: 'test_evidence',
    mode: 'read',
    readOnly: true,
    outcome: 'succeeded',
    startedAt: '2026-08-11T00:00:00.000Z',
    finishedAt: '2026-08-11T00:00:01.000Z',
    source: {authority: 'deterministic_test', businessDate: '2026-08-11', asOf: '2026-08-11T00:00:01.000Z'},
    coverage: {expected: 19, succeeded: 19},
    summary: {rows: 0},
  });
  assert.equal(run.durationMs, 1000);
  assert.equal(run.ok, true);

  const compactArtifactFile = path.join(tmp, 'compact-evidence.json');
  const compactArtifact = await writeOpsJsonArtifactAtomic(compactArtifactFile, {ok: true, rows: [1, 2, 3]});
  compactArtifact.role = 'compact_evidence';
  assert.equal(await fs.readFile(compactArtifactFile, 'utf8'), '{"ok":true,"rows":[1,2,3]}\n');
  const compactManifestFile = path.join(tmp, 'compact-manifest.json');
  await writeOpsRunManifest({
    manifestFile: compactManifestFile,
    run,
    artifacts: [compactArtifact],
  });
  assert.equal((await verifyOpsRunManifest(compactManifestFile)).ok, true);

  const manifestFile = path.join(tmp, 'manifest.json');
  const written = await writeOpsRunManifest({
    manifestFile,
    run,
    artifacts: [{file: artifact, role: 'primary_evidence'}],
  });
  assert.match(written.manifestSha256, /^[a-f0-9]{64}$/);
  const verified = await verifyOpsRunManifest(manifestFile);
  assert.equal(verified.ok, true);
  assert.deepEqual(compactOpsRun(run, written).summary, {rows: 0});

  await fs.appendFile(artifact, 'tamper');
  const tampered = await verifyOpsRunManifest(manifestFile);
  assert.equal(tampered.ok, false);
  assert.ok(tampered.issues.some(issue => issue.startsWith('artifact_')));

  const inspected = spawnSync(process.execPath, ['scripts/inspect_ops_run.mjs', '--manifest', manifestFile], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const inspectedJson = JSON.parse(inspected.stdout);
  assert.equal(inspectedJson.ok, false);
  assert.equal(inspectedJson.runOk, true);
  assert.equal(inspectedJson.verified, false);

  await fs.writeFile(manifestFile, '{"old":true}\n', 'utf8');
  assert.equal((await invalidateOpsRunManifest(manifestFile)).invalidated, true);
  await assert.rejects(() => fs.stat(manifestFile), error => error.code === 'ENOENT');

  await assert.rejects(() => writeOpsRunManifest({manifestFile, run, artifacts: []}), /at least one artifact/);

  for (const key of ['accessToken', 'x-api-key', 'set-cookie', 'private-key', 'bearer-token']) {
    assert.throws(() => buildOpsRun({
      operation: 'bad', outcome: 'failed', startedAt: '2026-08-11T00:00:00Z', finishedAt: '2026-08-11T00:00:01Z',
      summary: {[key]: 'not-allowed'},
    }), /sensitive key/);
  }
} finally {
  await fs.rm(tmp, {recursive: true, force: true});
}

console.log(JSON.stringify({ok: true, checks: ['outcomes', 'single_pass_compact_artifact', 'manifest_hashes', 'tamper_detection', 'manifest_invalidation', 'verified_top_level_status', 'sensitive_key_rejection']}, null, 2));
