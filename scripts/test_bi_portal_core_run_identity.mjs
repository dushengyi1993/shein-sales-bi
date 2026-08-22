#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repo, 'scripts', 'generate_bi_portal.mjs');
const runKey = '2026-08-22:2026-08-21:portal-core';
const fingerprint = 'a'.repeat(64);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const run = (outDir, extra = []) => spawnSync(process.execPath, [
  script,
  '--out-dir', outDir,
  '--source-run-key', runKey,
  '--input-fingerprint', fingerprint,
  ...extra,
], {cwd: repo, encoding: 'utf8', timeout: 20_000});

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'portal-core-identity-'));
try {
  const file = path.join(root, 'data.json');
  const generatedAt = '2026-08-22T07:31:22.123456+08:00';
  await fsp.writeFile(file, `${JSON.stringify({
    generatedAt,
    __sections: {mode: 'api', generatedAt},
    sourceCommit: {
      status: 'terminal',
      sourceRunKey: runKey,
      inputFingerprint: fingerprint,
      generatedAt,
    },
    stores: [],
  }, null, 2)}\n`);
  const beforeHash = hash(file);
  const beforeMtime = fs.statSync(file).mtimeMs;

  const replay = run(root);
  assert.equal(replay.status, 0, `${replay.stdout}\n${replay.stderr}`);
  assert.equal(JSON.parse(replay.stdout).reused, true, 'crash-after-core-commit replay must reuse terminal core');
  assert.equal(hash(file), beforeHash, 'terminal core replay must not rewrite data.json');
  assert.equal(fs.statSync(file).mtimeMs, beforeMtime, 'terminal core replay must preserve mtime');

  const mismatch = spawnSync(process.execPath, [
    script,
    '--out-dir', root,
    '--source-run-key', runKey,
    '--input-fingerprint', 'b'.repeat(64),
  ], {cwd: repo, encoding: 'utf8', timeout: 20_000});
  assert.notEqual(mismatch.status, 0, 'same run key with a changed fingerprint must fail closed');
  assert.match(`${mismatch.stdout}\n${mismatch.stderr}`, /PORTAL_CORE_SOURCE_IDENTITY_CONFLICT/);
  assert.equal(hash(file), beforeHash);

  const nonterminal = JSON.parse(fs.readFileSync(file, 'utf8'));
  nonterminal.sourceCommit.status = 'running';
  await fsp.writeFile(file, `${JSON.stringify(nonterminal, null, 2)}\n`);
  const nonterminalHash = hash(file);
  const ambiguous = run(root);
  assert.notEqual(ambiguous.status, 0, 'same-key nonterminal core must not masquerade as complete');
  assert.match(`${ambiguous.stdout}\n${ambiguous.stderr}`, /same_source_run_key_core_not_terminal/);
  assert.equal(hash(file), nonterminalHash);

  console.log(JSON.stringify({ok: true, checks: [
    'terminal_core_reused_after_crash_before_caller_receipt',
    'same_key_changed_fingerprint_fails_closed',
    'same_key_nonterminal_core_fails_closed',
    'generated_at_format_preserved',
  ]}, null, 2));
} finally {
  await fsp.rm(root, {recursive: true, force: true});
}
