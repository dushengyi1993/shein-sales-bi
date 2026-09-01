#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF_CHECK = 'BI_PORTAL_SECTION_ENQUEUE_COALESCING_SELFCHECK';

if (process.env[SELF_CHECK] !== '1') {
  const result = spawnSync('bash', ['-s'], {
    cwd: ROOT,
    input: `set -e
export ${SELF_CHECK}=1
node scripts/test_bi_portal_section_enqueue_coalescing.mjs
`,
    encoding: 'utf8',
    timeout: 90_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  process.stdout.write(String(result.stdout || ''));
  process.stderr.write(String(result.stderr || ''));
  assert.equal(result.status, 0, `Linux/WSL behavioral child failed with status ${result.status}`);
  process.exit(0);
}

process.env.SHEIN_BI_EXTERNAL_SECTION_QUEUE_ENABLED = '1';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-portal-section-enqueue-'));
const queueFile = path.join(sandbox, 'queue.json');
const fixtureFile = path.join(sandbox, 'enqueue-fixture.mjs');
const logFile = path.join(sandbox, 'enqueue.jsonl');
fs.writeFileSync(fixtureFile, `
import fs from 'node:fs';
fs.appendFileSync(process.env.BI_TEST_ENQUEUE_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
setTimeout(() => process.exit(0), 100);
`);
process.env.SHEIN_BI_PORTAL_SECTION_QUEUE_FILE = queueFile;
process.env.SHEIN_BI_SECTION_ENQUEUE_CHILD_SPEC = `${process.execPath}|${fixtureFile}`;
process.env.BI_TEST_ENQUEUE_LOG = logFile;

const {__testHooks} = await import('./serve_bi_portal.mjs');
const writeQueue = entries => fs.writeFileSync(queueFile, `${JSON.stringify({version: 1, entries}, null, 2)}\n`);
const queueEntry = (section, status, generatedAt) => ({
  section,
  status,
  idempotencyKey: `${__testHooks.biPortalCoreWarmupIdempotencyKey(generatedAt)}::${section}`,
  reasons: [`core-warmup-${generatedAt}`, `portal-cache-miss-${generatedAt}`],
});
const schedule = (section, generatedAt, options = {}) => __testHooks.scheduleBiSectionBackgroundGeneration(
  {},
  sandbox,
  section,
  generatedAt,
  options,
);
const rows = () => {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
};
const waitForRows = async expected => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (rows().length >= expected) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${expected} enqueue fixture rows; saw ${rows().length}`);
};
const waitForPendingClear = async () => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (__testHooks.biExternalSectionQueuePendingSize() === 0) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('enqueue child did not reach terminal close');
};

try {
  const generation = 'G1';

  fs.rmSync(queueFile, {force: true});
  assert.equal(schedule('orders', generation), true);
  assert.equal(schedule('orders', generation), true);
  await waitForRows(1);
  assert.equal(rows().length, 1, 'same section/generation must spawn once while the child is active');
  await waitForPendingClear();

  writeQueue([queueEntry('orders', 'pending', generation)]);
  __testHooks.resetBiExternalSectionQueuePending();
  assert.equal(schedule('orders', generation), true);
  assert.equal(rows().length, 1, 'current-generation pending queue entry must suppress respawn');

  __testHooks.resetBiExternalSectionQueuePending();
  writeQueue([queueEntry('orders', 'running', generation)]);
  assert.equal(schedule('orders', generation), true);
  assert.equal(rows().length, 1, 'current-generation running queue entry must suppress respawn');

  __testHooks.resetBiExternalSectionQueuePending();
  writeQueue([queueEntry('orders', 'completed', generation)]);
  assert.equal(schedule('orders', generation), true);
  await waitForRows(2);
  await waitForPendingClear();

  writeQueue([queueEntry('orders', 'pending', generation)]);
  assert.equal(schedule('orders', 'G2'), true);
  await waitForRows(3);
  await waitForPendingClear();

  writeQueue([queueEntry('orders', 'pending', generation)]);
  assert.equal(schedule('orders', generation, {force: true, refreshToken: 'force-1'}), true);
  await waitForRows(4);
  const forceArgs = rows()[3];
  assert.equal(forceArgs[forceArgs.indexOf('--priority') + 1], '0', 'force refresh must retain priority 0');
  await waitForPendingClear();

  fs.writeFileSync(queueFile, '{not-json');
  assert.equal(schedule('orders', generation), true);
  await waitForRows(5);
  await waitForPendingClear();

  fs.writeFileSync(queueFile, JSON.stringify({version: 1}));
  assert.equal(schedule('orders', generation), true);
  await waitForRows(6);
  await waitForPendingClear();

  fs.rmSync(queueFile, {force: true});
  assert.equal(schedule('orders', generation), true);
  await waitForRows(7);
  await waitForPendingClear();

  console.log('bi_portal_section_enqueue_coalescing: durable pending/running coalescing, completed/new-generation/force re-enqueue, and fail-open state handling passed');
} finally {
  __testHooks.resetBiExternalSectionQueuePending();
  fs.rmSync(sandbox, {recursive: true, force: true});
}
