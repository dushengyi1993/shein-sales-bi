#!/usr/bin/env node

import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {publishBiProfitBundleManifest, writeBiSectionArtifact, writeBiSectionCache} from '../lib/bi_section_cache.mjs';
import {validateTerminalArtifact} from './check_bi_portal_section_terminal.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WARMUP_SECTIONS = ['profit', 'homeRankings', 'homeProfit', 'afterSales', 'orders', 'homeTrafficDaily', 'priceScatter'];

if (process.platform === 'win32' && process.env.BI_PORTAL_EXTERNAL_QUEUE_RECONCILIATION_CHILD !== '1') {
  const result = spawnSync('wsl.exe', [
    '--cd', ROOT,
    '--exec', '/usr/bin/env',
    'BI_PORTAL_EXTERNAL_QUEUE_RECONCILIATION_CHILD=1',
    'SHEIN_BI_CORE_WARMUP_QUEUE_OWNED=1',
    'SHEIN_BI_EXTERNAL_SECTION_QUEUE_ENABLED=1',
    '/usr/bin/node', 'scripts/test_bi_portal_external_queue_reconciliation.mjs',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    killSignal: 'SIGKILL',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status === null) {
    throw new Error(`WSL reconciliation child did not exit: signal=${result.signal || ''} error=${result.error?.message || ''}`);
  }
  process.exit(result.status);
}

process.env.SHEIN_BI_CORE_WARMUP_QUEUE_OWNED = '1';
process.env.SHEIN_BI_EXTERNAL_SECTION_QUEUE_ENABLED = '1';
process.env.SHEIN_BI_ROOT = ROOT;

const shellSource = await fs.readFile(path.join(ROOT, 'scripts', 'cloud_bi_refresh.sh'), 'utf8');
assert.ok(shellSource.includes('portal_queue_identity'), 'cloud refresh must derive a bounded Portal queue identity from the generated core');
assert.ok(shellSource.includes('--idempotency-key "$PORTAL_QUEUE_IDEMPOTENCY_KEY"'),
  'every direct refresh enqueue must pass the stable generation idempotency key');
assert.ok(shellSource.includes('--coalesce-key "$PORTAL_QUEUE_COALESCE_KEY"'),
  'every direct refresh enqueue must pass the stable generation coalesce key');
assert.ok(shellSource.includes('--core-generated-at "$PORTAL_CORE_GENERATION"'),
  'every direct refresh enqueue must persist the explicit source/core generation');
assert.ok(shellSource.includes('core-warmup:sha256:${sha256(generatedAt)}'),
  'unsafe generations must use the same domain-separated digest identity as Portal warmup');
assert.ok(shellSource.includes('portal-generation:sha256:${sha256(JSON.stringify([generatedAt]))}'),
  'the coalesce identity must be bound to the exact core generation');
assert.ok(shellSource.includes('IFS=$\'\\t\' read -r PORTAL_CORE_GENERATION PORTAL_QUEUE_IDEMPOTENCY_KEY PORTAL_QUEUE_COALESCE_KEY'),
  'the generated core identity must be reused by all direct enqueue groups');

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bi-portal-external-reconcile-'));
const portalRoot = path.join(temp, 'portal');
const queueFile = path.join(temp, 'queue.json');
const queueLock = path.join(temp, 'queue.lock');
await fs.mkdir(path.join(portalRoot, 'sections'), {recursive: true});
process.env.SHEIN_BI_PORTAL_SECTION_QUEUE_FILE = queueFile;
process.env.SHEIN_BI_PORTAL_SECTION_QUEUE_LOCK_FILE = queueLock;
process.env.SHEIN_BI_PORTAL_DATA_PATH = path.join(portalRoot, 'data.json');

const {__testHooks} = await import('./serve_bi_portal.mjs');
const manage = await import('./manage_bi_portal_section_queue.mjs');

const writeCore = async generatedAt => {
  await fs.writeFile(path.join(portalRoot, 'data.json'), `${JSON.stringify({generatedAt, __sections: {mode: 'api', generatedAt}})}\n`);
};
const writeArtifacts = async (generatedAt, sections = WARMUP_SECTIONS) => {
  const run = {code: 0, timedOut: false, stderr: ''};
  const requested = new Set(sections);
  const profitBundleNeeded = requested.has('profit') || requested.has('homeProfit');
  if (profitBundleNeeded) {
    const profitData = {profit: {dailyStoreProducts: []}};
    await writeBiSectionCache(portalRoot, 'profit', generatedAt, profitData, run, {requireIntegrity: true});
    await writeBiSectionArtifact(portalRoot, 'profit.query', 'profit.query', generatedAt, profitData, run, {requireIntegrity: true});
    await writeBiSectionCache(portalRoot, 'homeProfit', generatedAt, {
      homeProfitSummary: {dailyScopes: [], sourceGeneratedAt: generatedAt, staleSource: false},
    }, run, {requireIntegrity: true});
    await publishBiProfitBundleManifest(portalRoot, generatedAt);
  }
  for (const section of sections) {
    if (section === 'profit' || section === 'homeProfit') continue;
    await writeBiSectionCache(portalRoot, section, generatedAt, {}, run, {requireIntegrity: true});
  }
};
const strictTerminalEvidence = async (section, generatedAt) => {
  const evidence = await validateTerminalArtifact({root: portalRoot, section, expectedGeneratedAt: generatedAt});
  assert.equal(evidence.ok, true, `strict terminal evidence failed for ${section}: ${JSON.stringify(evidence)}`);
  assert.equal(evidence.expectedGeneratedAt, generatedAt);
  assert.equal(evidence.generatedAt, generatedAt);
  assert.equal(evidence.sectionGeneratedAt, generatedAt);
  assert.match(evidence.generationIdentity, /^[a-f0-9]{64}$/u);
  return evidence;
};
const completeInMemoryWithTerminalEvidence = async (queue, claim, leaseId, now) => {
  const evidence = await strictTerminalEvidence(claim.section, claim.coreGeneratedAt);
  return manage.completeClaim(queue, {
    section: claim.section,
    leaseId,
    expectedGeneratedAt: evidence.expectedGeneratedAt,
    terminalGeneratedAt: evidence.generatedAt,
    terminalSectionGeneratedAt: evidence.sectionGeneratedAt,
    terminalGenerationIdentity: evidence.generationIdentity,
    requireTerminalEvidence: true,
    now,
  });
};
const readQueue = async () => JSON.parse(await fs.readFile(queueFile, 'utf8'));
const writeQueue = async queue => fs.writeFile(queueFile, `${JSON.stringify(queue, null, 2)}\n`);
const queueShell = path.join(ROOT, 'scripts', 'enqueue_bi_portal_sections.sh');
const queueShellSource = await fs.readFile(queueShell, 'utf8');
assert.doesNotMatch(queueShellSource, /process\.exit\(/,
  'implicit generation scan must not bypass explicit async handle close with process.exit');
const runQueueShell = (...args) => spawnSync('bash', [queueShell, ...args], {
  cwd: ROOT,
  env: process.env,
  encoding: 'utf8',
  timeout: 30_000,
});
const collectChild = child => new Promise(resolve => {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.once('close', (code, signal) => resolve({code, signal, stdout, stderr}));
});
const waitForFile = async (file, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await fs.access(file); return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${file}`);
};
const warmupKey = section => `core-warmup:G1::${section}`;
const completedQueue = () => ({
  version: 1,
  updatedAt: '',
  nextSequence: 0,
  entries: [],
  completedIdempotency: WARMUP_SECTIONS.map(section => ({
    idempotencyKey: warmupKey(section),
    section,
    coreGeneratedAt: 'G1',
    completedAt: new Date().toISOString(),
  })),
  generationCompletion: null,
});

try {
  await fs.writeFile(
    path.join(portalRoot, 'data.json'),
    `${JSON.stringify({padding: 'x'.repeat(128 * 1024), generatedAt: 'G-PADDED', __sections: {generatedAt: 'G-PADDED'}})}\n`,
  );
  const implicitGeneration = runQueueShell('--sections', 'orders', '--priority', '10', '--reason', 'padded-core');
  assert.equal(implicitGeneration.status, 0, implicitGeneration.stderr || implicitGeneration.stdout);
  assert.equal((await readQueue()).entries.find(entry => entry.section === 'orders')?.coreGeneratedAt, 'G-PADDED',
    'implicit enqueue must scan the bounded top-level generatedAt even when it appears after the first 64 KiB');
  await fs.rm(queueFile, {force: true});

  for (const invalidGeneratedAt of [true, 123, ['A', 'B'], ' G-PADDED ', 'G-PADDED\n']) {
    await fs.writeFile(
      path.join(portalRoot, 'data.json'),
      `${JSON.stringify({padding: 'x'.repeat(128 * 1024), generatedAt: invalidGeneratedAt})}\n`,
    );
    const invalidGeneration = runQueueShell('--sections', 'orders', '--priority', '10', '--reason', 'invalid-core-generation');
    assert.notEqual(invalidGeneration.status, 0,
      `implicit enqueue must reject non-exact generatedAt=${JSON.stringify(invalidGeneratedAt)}`);
    await assert.rejects(fs.access(queueFile),
      'invalid generatedAt must fail before creating or mutating the queue');
  }

  await writeCore('G1');
  await writeArtifacts('G1');

  // Seven fresh pre-generation tombstones can neither prove G1 complete nor
  // permanently swallow the first explicit G1 enqueue. The manager retires
  // only exact-key unknown records under the queue lock and creates fresh
  // generation-bound work without any manual queue cleanup.
  const legacyQueue = completedQueue();
  legacyQueue.completedIdempotency = legacyQueue.completedIdempotency.map(record => {
    const legacy = {...record};
    delete legacy.coreGeneratedAt;
    return legacy;
  });
  await writeQueue(legacyQueue);
  const legacyCannotComplete = await __testHooks.reconcileBiPortalCoreWarmupQueueOwned(
    portalRoot,
    WARMUP_SECTIONS,
    'G1',
  );
  assert.equal(legacyCannotComplete.status, 'queued');
  assert.deepEqual([...legacyCannotComplete.conflictingCompletedSections].sort(), [...WARMUP_SECTIONS].sort());
  const legacyRecovery = runQueueShell(
    '--sections', WARMUP_SECTIONS.join(','),
    '--priority', '10',
    '--reason', 'legacy-explicit-generation-recovery',
    '--idempotency-key', 'core-warmup:G1',
    '--coalesce-key', 'portal-generation:G1',
    '--core-generated-at', 'G1',
  );
  assert.equal(legacyRecovery.status, 0, legacyRecovery.stderr);
  const legacyRecoveryReport = JSON.parse(legacyRecovery.stdout);
  assert.deepEqual([...legacyRecoveryReport.retiredLegacyCompleted].sort(), [...WARMUP_SECTIONS].sort());
  const recoveredLegacyQueue = await readQueue();
  assert.equal(recoveredLegacyQueue.completedIdempotency.length, 0);
  assert.equal(recoveredLegacyQueue.entries.length, WARMUP_SECTIONS.length);
  assert.ok(recoveredLegacyQueue.entries.every(entry => entry.coreGeneratedAt === 'G1'));

  await writeQueue(completedQueue());

  const done = await __testHooks.reconcileBiPortalCoreWarmupQueueOwned(portalRoot, WARMUP_SECTIONS, 'G1');
  assert.equal(done.status, 'done', 'all current-generation receipts and terminal artifacts must reconcile done');
  assert.deepEqual(done.completedSections, WARMUP_SECTIONS);

  const completedReplay = runQueueShell(
    '--sections', 'profit',
    '--priority', '10',
    '--reason', 'same-generation-completed-replay',
    '--idempotency-key', 'core-warmup:G1',
    '--coalesce-key', 'portal-generation:G1',
    '--core-generated-at', 'G1',
  );
  assert.equal(completedReplay.status, 0, completedReplay.stderr);
  const completedReplayReport = JSON.parse(completedReplay.stdout);
  assert.deepEqual(completedReplayReport.deduplicatedCompleted, ['profit']);
  assert.equal(completedReplayReport.invalidatedGenerationCompletion, true,
    'a same-generation completed-key replay must invalidate receipt before returning');
  assert.equal((await readQueue()).generationCompletion, null);
  assert.equal((await __testHooks.resolveBiPortalCoreWarmupReceiptHealth(portalRoot, WARMUP_SECTIONS)).done, false);
  const replayReconciled = await __testHooks.reconcileBiPortalCoreWarmupQueueOwned(portalRoot, WARMUP_SECTIONS, 'G1');
  assert.equal(replayReconciled.status, 'done', 'a later full validation may safely restore the invalidated receipt');

  const activeQueue = completedQueue();
  activeQueue.entries.push({
    section: 'profit',
    status: 'running',
    idempotencyKey: warmupKey('profit'),
    coreGeneratedAt: 'G1',
    requestRevision: 2,
    claimedRevision: 1,
    rerun: true,
  });
  const activeBefore = JSON.stringify(activeQueue);
  await writeQueue(activeQueue);
  const active = await __testHooks.reconcileBiPortalCoreWarmupQueueOwned(portalRoot, WARMUP_SECTIONS, 'G1');
  assert.equal(active.status, 'queued', 'running work must never be treated as terminal');
  assert.equal(active.reason, 'queue-active');
  assert.deepEqual(active.newerRevisionSections, ['profit'], 'a newer requestRevision must remain visible');
  assert.equal(JSON.stringify(await readQueue()), activeBefore, 'reconciliation must not mutate or delete queue state');

  await writeQueue(completedQueue());
  await fs.rm(path.join(portalRoot, 'sections', 'profit.json'));
  const mismatch = await __testHooks.reconcileBiPortalCoreWarmupQueueOwned(portalRoot, WARMUP_SECTIONS, 'G1');
  assert.equal(mismatch.status, 'queued', 'a terminal artifact mismatch must remain queued');
  assert.equal(mismatch.reason, 'terminal-mismatch');
  assert.deepEqual([...mismatch.invalidSections].sort(), ['homeProfit', 'profit']);

  const missingReceiptQueue = completedQueue();
  missingReceiptQueue.completedIdempotency = missingReceiptQueue.completedIdempotency.slice(1);
  await writeQueue(missingReceiptQueue);
  const missingReceipt = await __testHooks.reconcileBiPortalCoreWarmupQueueOwned(portalRoot, WARMUP_SECTIONS, 'G1');
  assert.equal(missingReceipt.status, 'queued');
  assert.equal(missingReceipt.reason, 'terminal-receipt-missing');
  assert.equal(missingReceipt.missingCompletedSections[0], 'profit');

  // Exercise the real queue-owned scheduler in the Linux/WSL child: the
  // watcher starts queued, then a worker-style completion + artifact publish
  // is reconciled into done without a second enqueue or revision bump.
  await writeArtifacts('G1');
  await fs.rm(queueFile, {force: true});
  const first = await __testHooks.scheduleBiPortalCoreWarmup({}, portalRoot, {allowGenerate: true});
  assert.equal(first.reason, 'queued');
  const queuedQueue = await readQueue();
  for (let index = 0; index < WARMUP_SECTIONS.length; index += 1) {
    const claim = manage.claimNext(queuedQueue, {
      leaseSeconds: 60,
      leaseId: `reconcile-lease-${index}`,
      now: new Date(Date.now() + index * 100),
    });
    assert.ok(WARMUP_SECTIONS.includes(claim.section));
    assert.equal(await completeInMemoryWithTerminalEvidence(
      queuedQueue,
      claim,
      `reconcile-lease-${index}`,
      new Date(Date.now() + index * 100 + 50),
    ), true);
  }
  await writeQueue(queuedQueue);
  const reconciled = await __testHooks.scheduleBiPortalCoreWarmup({}, portalRoot, {allowGenerate: true});
  assert.equal(reconciled.reason, 'already-completed');
  assert.equal(__testHooks.biPortalCoreWarmupState.status, 'done');
  assert.equal(__testHooks.biPortalCoreWarmupState.inFlight, null);
  assert.ok(__testHooks.biPortalCoreWarmupState.finishedAt > 0);
  assert.equal(__testHooks.evaluateBiPortalCoreWarmupHealth().stalled, false);
  assert.equal((await readQueue()).generationCompletion?.coreGeneratedAt, 'G1',
    'terminal reconciliation must persist the generationCompletion receipt under the queue lock');

  const g2Enqueue = runQueueShell(
    '--sections', 'profit',
    '--priority', '10',
    '--reason', 'live-accounting-G2',
    '--idempotency-key', 'live-accounting:G2:event-1',
    '--coalesce-key', 'portal-generation:G2',
    '--core-generated-at', 'G2',
  );
  assert.equal(g2Enqueue.status, 0, g2Enqueue.stderr);
  const afterG2Enqueue = await readQueue();
  assert.equal(afterG2Enqueue.generationCompletion, null,
    'a G2 live/accounting enqueue must invalidate the G1 completion receipt in the same lock transaction');
  assert.equal(afterG2Enqueue.entries.find(entry => entry.section === 'profit')?.coreGeneratedAt, 'G2');
  const invalidatedReceiptHealth = await __testHooks.resolveBiPortalCoreWarmupReceiptHealth(portalRoot, WARMUP_SECTIONS);
  assert.equal(invalidatedReceiptHealth.done, false, 'G2 work must not leave G1 health done');
  const effectiveAfterInvalidation = __testHooks.effectiveBiPortalCoreWarmupStateFromReceipt(
    invalidatedReceiptHealth,
    {...__testHooks.biPortalCoreWarmupState, status: 'done', finishedAt: Date.now()},
  );
  assert.equal(effectiveAfterInvalidation.status, 'queued', 'receipt invalidation must downgrade stale in-memory done to queued');
  assert.equal(effectiveAfterInvalidation.finishedAt, 0);
  assert.equal(effectiveAfterInvalidation.inFlight, null);
  const queuedAgain = await __testHooks.scheduleBiPortalCoreWarmup({}, portalRoot, {allowGenerate: true});
  assert.equal(queuedAgain.reason, 'queued', 'a newer running revision must downgrade done back to queued');
  assert.equal(__testHooks.biPortalCoreWarmupState.status, 'queued');
  assert.equal(__testHooks.evaluateBiPortalCoreWarmupHealth().stalled, false);

  // Two-phase optimistic reconciliation: hold the first validator for more
  // than the worker's 10-second lock wait. A target G2 enqueue and an unrelated
  // worker completion must both commit while validation is still running; the
  // final G1 commit must then reject its stale snapshot and never false-green.
  const optimisticQueue = completedQueue();
  manage.enqueueSections(optimisticQueue, {
    sections: ['actions'],
    priority: 50,
    idempotencyKey: 'unrelated:G1',
    coreGeneratedAt: 'G1',
    now: new Date(),
  });
  const unrelatedClaim = manage.claimNext(optimisticQueue, {
    leaseSeconds: 60,
    leaseId: 'lease-unrelated-actions',
    now: new Date(),
  });
  assert.equal(unrelatedClaim.section, 'actions');
  await writeQueue(optimisticQueue);
  await writeArtifacts('G1', ['actions']);
  const actionsEvidence = await strictTerminalEvidence('actions', 'G1');
  const fakeValidator = path.join(temp, 'blocking-terminal-validator.mjs');
  const validatorMarker = path.join(temp, 'validator-started');
  const validatorRelease = path.join(temp, 'validator-release');
  await fs.writeFile(fakeValidator, [
    "import fs from 'node:fs';",
    "const args = process.argv.slice(2);",
    "const value = name => { const index = args.indexOf('--' + name); return index >= 0 ? args[index + 1] : ''; };",
    `const marker = ${JSON.stringify(validatorMarker)};`,
    `const release = ${JSON.stringify(validatorRelease)};`,
    "if (!fs.existsSync(marker)) {",
    "  fs.writeFileSync(marker, 'started');",
    "  const deadline = Date.now() + 25000;",
    "  const waitArray = new Int32Array(new SharedArrayBuffer(4));",
    "  while (!fs.existsSync(release) && Date.now() < deadline) Atomics.wait(waitArray, 0, 0, 20);",
    "  if (!fs.existsSync(release)) process.exit(70);",
    "}",
    "const section = value('section');",
    "const coreGeneratedAt = value('expected-generated-at');",
    "console.log(JSON.stringify({ok: true, section, coreGeneratedAt, sectionGeneratedAt: coreGeneratedAt}));",
  ].join('\n'));
  const priorValidator = process.env.SHEIN_BI_TERMINAL_VALIDATOR;
  process.env.SHEIN_BI_TERMINAL_VALIDATOR = fakeValidator;
  const validationStartedAt = Date.now();
  let firstScheduleSettled = false;
  const firstSchedulePromise = __testHooks.scheduleBiPortalCoreWarmup({}, portalRoot, {allowGenerate: true})
    .finally(() => { firstScheduleSettled = true; });
  await waitForFile(validatorMarker);
  const overlappingTick = await __testHooks.scheduleBiPortalCoreWarmup({}, portalRoot, {allowGenerate: true});
  assert.equal(overlappingTick.reason, 'already-running', 'a 60s watcher tick must not overlap reconciliation');
  const concurrentMutationStartedAt = Date.now();
  const concurrentEnqueueChild = spawn('bash', [
    queueShell,
    '--sections', 'profit',
    '--priority', '10',
    '--reason', 'live-accounting-G2-concurrent',
    '--idempotency-key', 'live-accounting:G2:event-2',
    '--core-generated-at', 'G2',
  ], {cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe']});
  const concurrentEnqueuePromise = collectChild(concurrentEnqueueChild);
  const concurrentCompleteChild = spawn('flock', [
    '-w', '10', queueLock,
    process.execPath,
    path.join(ROOT, 'scripts', 'manage_bi_portal_section_queue.mjs'),
    'complete', '--section', 'actions', '--lease-id', 'lease-unrelated-actions',
    '--expected-generated-at', actionsEvidence.expectedGeneratedAt,
    '--terminal-generated-at', actionsEvidence.generatedAt,
    '--terminal-section-generated-at', actionsEvidence.sectionGeneratedAt,
    '--terminal-generation-identity', actionsEvidence.generationIdentity,
    '--file', queueFile,
  ], {cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe']});
  const concurrentCompletePromise = collectChild(concurrentCompleteChild);
  const [concurrentEnqueueResult, concurrentCompleteResult] = await Promise.all([
    concurrentEnqueuePromise,
    concurrentCompletePromise,
  ]);
  assert.equal(concurrentEnqueueResult.code, 0, concurrentEnqueueResult.stderr);
  assert.equal(concurrentCompleteResult.code, 0, concurrentCompleteResult.stderr);
  assert.equal(JSON.parse(concurrentCompleteResult.stdout).completed, true);
  assert.ok(Date.now() - concurrentMutationStartedAt < 5_000,
    'enqueue and worker complete must not wait behind the long artifact validators');
  assert.equal(firstScheduleSettled, false, 'validation must still be running after concurrent queue mutations finish');
  const remainingHoldMs = 10_500 - (Date.now() - validationStartedAt);
  if (remainingHoldMs > 0) await new Promise(resolve => setTimeout(resolve, remainingHoldMs));
  await fs.writeFile(validatorRelease, 'release');
  const firstSchedule = await firstSchedulePromise;
  if (priorValidator === undefined) delete process.env.SHEIN_BI_TERMINAL_VALIDATOR;
  else process.env.SHEIN_BI_TERMINAL_VALIDATOR = priorValidator;
  assert.ok(Date.now() - validationStartedAt >= 10_000, 'simulated terminal validation must exceed the worker lock wait');
  assert.ok(['queued', 'already-queued'].includes(firstSchedule.reason));
  assert.ok(['queue-active', 'snapshot-changed'].includes(firstSchedule.reconciliationReason));
  const serializedQueue = await readQueue();
  assert.equal(serializedQueue.generationCompletion, null,
    'a target enqueue during validation must prevent stale generationCompletion publication');
  assert.equal(serializedQueue.entries.find(entry => entry.section === 'profit')?.coreGeneratedAt, 'G2');
  assert.equal(serializedQueue.entries.some(entry => entry.section === 'actions'), false,
    'worker complete must acquire the short queue lock and finish during validation');
  assert.ok(serializedQueue.entries.every(entry => typeof entry.coreGeneratedAt === 'string' && entry.coreGeneratedAt),
    'every persisted queue entry must carry an explicit coreGeneratedAt');
} finally {
  await fs.rm(temp, {recursive: true, force: true});
}

console.log('bi_portal_external_queue_reconciliation: generation-pinned receipts, terminal artifacts, active revisions, and stable direct-refresh identity passed');
