#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {serializePortalData} from './generate_bi_portal.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repo, 'scripts', 'generate_bi_portal.mjs');
const runKey = '2026-08-22:2026-08-21:portal-core';
const fingerprint = 'a'.repeat(64);
const toPosixPath = value => {
  const text = String(value).replace(/\\/g, '/');
  return /^[A-Za-z]:\//u.test(text)
    ? `/mnt/${text[0].toLowerCase()}${text.slice(2)}`
    : text;
};
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const run = (outDir, extra = []) => spawnSync(process.execPath, [
  script,
  '--out-dir', outDir,
  '--source-run-key', runKey,
  '--input-fingerprint', fingerprint,
  ...extra,
], {cwd: repo, encoding: 'utf8', timeout: 20_000});
const generatorSource = fs.readFileSync(script, 'utf8');
assert.match(generatorSource, /const coreGeneratedAt = String\(\s*data\.generatedAt \|\| data\.__sections\?\.generatedAt \|\| ''/u,
  'the generator must bind core identity only from existing root/section generatedAt');
assert.doesNotMatch(generatorSource, /const coreGeneratedAt = String\([\s\S]*?new Date\(\)\.toISOString\(\)/u,
  'the generator must not invent a new core generation when identity is missing');
assert.throws(
  () => serializePortalData({kpi: {}}),
  /PORTAL_GENERATED_AT_REQUIRED/,
  'missing root and section identity must fail instead of creating a new generation',
);

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'portal-core-identity-'));
try {
  const file = path.join(root, 'data.json');
  const generatedAt = '2026-08-22T07:31:22.123456+08:00';
  const largeOrderedPayload = serializePortalData({
    kpi: 'x'.repeat(128 * 1024),
    generatedAt,
    __sections: {mode: 'api', generatedAt: 'stale-value'},
  }, {
    audit: {ok: true},
  });
  assert.equal(Object.keys(largeOrderedPayload)[0], 'generatedAt',
    'formal Portal data must serialize generatedAt as the first top-level field');
  assert.equal(largeOrderedPayload.__sections.generatedAt, generatedAt,
    'formal Portal data must bind __sections.generatedAt to root generatedAt');
  const largeSerialized = `${JSON.stringify(largeOrderedPayload, null, 2)}\n`;
  assert.ok(Buffer.byteLength(largeSerialized, 'utf8') > 64 * 1024,
    'the bounded identity regression must use a payload larger than 64 KiB');
  assert.match(largeSerialized, /^\{\s*"generatedAt"\s*:/u,
    'the formal JSON must begin with the root generatedAt property');
  fs.writeFileSync(path.join(root, 'large-data.json'), largeSerialized, 'utf8');
  const refreshShell = await fsp.readFile(path.join(repo, 'scripts', 'cloud_bi_refresh.sh'), 'utf8');
  const identityStart = refreshShell.indexOf('portal_queue_identity() {');
  const identityEnd = refreshShell.indexOf('\n}\n\nDATE="$(resolve_date', identityStart);
  assert.ok(identityStart >= 0 && identityEnd > identityStart,
    'the bounded identity function must remain extractable for deterministic testing');
  const identityFunction = refreshShell.slice(identityStart, identityEnd + 2);
  // Do not interpolate this function into `bash -c`: its Node heredoc and
  // shell-looking text contain backticks and ${...} which an outer shell can
  // expand before the actual scanner runs. A temporary script preserves the
  // production function byte-for-byte and passes only the data path as argv.
  const identityScriptFile = path.join(root, 'run-portal-identity.sh');
  await fsp.writeFile(identityScriptFile, [
    '#!/usr/bin/env bash',
    'set -Eeuo pipefail',
    'PORTAL_DATA_PATH="$1"',
    identityFunction,
    'portal_queue_identity',
    '',
  ].join('\n'), 'utf8');
  const runBoundedIdentity = file => spawnSync('bash', [toPosixPath(identityScriptFile), toPosixPath(file)], {
    cwd: repo,
    encoding: 'utf8',
  });
  const boundedScanAfterWrite = runBoundedIdentity(path.join(root, 'large-data.json'));
  assert.equal(boundedScanAfterWrite.status, 0,
    `the existing 64 KiB identity scan must recognize the ordered payload: ${boundedScanAfterWrite.stdout}\n${boundedScanAfterWrite.stderr}`);
  assert.equal(boundedScanAfterWrite.stdout.split('\t')[0], generatedAt);
  assert.match(refreshShell, /Buffer\.alloc\(64 \* 1024\)/,
    'the regression must retain the existing bounded scanner rather than widening it');
  assert.ok(refreshShell.includes('const match = /^\\s*\\{\\s*"generatedAt"'),
    'the consumer must anchor generatedAt to the first root property');
  for (const [name, payload] of [
    ['second-root-field', {other: 1, generatedAt}],
    ['nested-only', {nested: {generatedAt}}],
    ['non-string', {generatedAt: 123}],
  ]) {
    const badFile = path.join(root, `${name}.json`);
    await fsp.writeFile(badFile, `${JSON.stringify(payload)}\n`);
    const result = runBoundedIdentity(badFile);
    assert.equal(result.status, 64, `${name} must fail the bounded identity scan: ${result.stdout}\n${result.stderr}`);
  }
  const truncatedFile = path.join(root, 'truncated-generated-at.json');
  await fsp.writeFile(truncatedFile, '{"generatedAt":"2026-08-22T07:31:22.123456+08:00');
  const truncated = runBoundedIdentity(truncatedFile);
  assert.equal(truncated.status, 64,
    `a truncated root generatedAt string must fail closed: ${truncated.stdout}\n${truncated.stderr}`);
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
