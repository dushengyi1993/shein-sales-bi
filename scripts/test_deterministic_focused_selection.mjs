#!/usr/bin/env node
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const runnerFile = fileURLToPath(new URL('./run_deterministic_tests.mjs', import.meta.url));
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const firstRegistered = 'scripts/test_product_display_name.mjs';
const secondRegistered = 'scripts/test_product_sku_normalizer.mjs';

function runRunner(args) {
  return spawnSync(process.execPath, [runnerFile, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function assertRejected(args, expectedMessage) {
  const result = runRunner(args);
  assert.notEqual(result.status, 0, `runner must reject: ${args.join(' ')}`);
  assert.match(result.stderr || '', expectedMessage,
    `runner rejection must explain the invalid selection: ${args.join(' ')}`);
}

const legal = runRunner([
  '--files', `${secondRegistered},${firstRegistered}`,
  '--list',
]);
assert.equal(legal.status, 0, legal.stderr || legal.error?.message || 'legal focused selection failed');
assert.equal(legal.stderr, '', '--list must not emit execution diagnostics');
const legalManifest = JSON.parse(legal.stdout);
assert.equal(legalManifest.ok, true);
assert.equal(legalManifest.mode, 'files');
assert.equal(legalManifest.order, 'registered');
assert.deepEqual(legalManifest.requestedFiles, [secondRegistered, firstRegistered]);
assert.deepEqual(legalManifest.deduplicatedFiles, [secondRegistered, firstRegistered]);
assert.deepEqual(legalManifest.tests, [firstRegistered, secondRegistered],
  'focused selection must use deterministic registration order');

const duplicate = runRunner([
  '--files', `${secondRegistered},${secondRegistered},${firstRegistered},${secondRegistered}`,
  '--list',
]);
assert.equal(duplicate.status, 0, duplicate.stderr || duplicate.error?.message || 'duplicate selection failed');
const duplicateManifest = JSON.parse(duplicate.stdout);
assert.deepEqual(duplicateManifest.tests, [firstRegistered, secondRegistered],
  'duplicate registered paths must execute only once');
assert.equal(duplicateManifest.tests.length, new Set(duplicateManifest.tests).size);

assertRejected(['--files', 'scripts/test_not_registered.mjs', '--list'], /not registered/u);
assertRejected(['--files', '', '--list'], /non-empty/u);
assertRejected(['--files', ',', '--list'], /empty file paths/u);
assertRejected([
  '--files', 'scripts/../scripts/test_product_display_name.mjs',
  '--list',
], /path traversal/u);
assertRejected([
  '--files', firstRegistered,
  '--shard', '1/1',
  '--list',
], /cannot be combined with --shard/u);

const listOnly = runRunner(['--files', firstRegistered, '--list']);
assert.equal(listOnly.status, 0, listOnly.stderr || listOnly.error?.message || '--list failed');
assert.equal(listOnly.stderr, '', '--list must not start a child test');
assert.doesNotMatch(listOnly.stdout, /(?:START|PASS)\s/u, '--list must not execute a test');
assert.deepEqual(JSON.parse(listOnly.stdout).tests, [firstRegistered]);

console.log('Deterministic focused selection tests passed');
