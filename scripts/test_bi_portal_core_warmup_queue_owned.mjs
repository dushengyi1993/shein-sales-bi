#!/usr/bin/env node

// Portal-internal core warmup ownership by the managed external section queue,
// with durable per-section idempotency across Portal Restart=always.
//
// Incident: after removing the temporary SHEIN_BI_CORE_WARMUP_DISABLED=1
// drop-in, /api/health immediately showed biCoreWarmup status=running because
// the 60s watcher kept calling loadBiSection(force=true) directly -- heavy
// section generation outside run_host_heavy_job that repeatedly deferred the
// inventory host guard.  A systemctl is-active defer gate was rejected (the
// inactive->active polling race is unavoidable) in favor of explicit queue
// ownership, and in-process exactly-once was then rejected because Portal
// Restart=always loses process memory -- hence the durable per-section
// idempotency key + completed ledger in the managed queue.
//
// Design under test:
//   - ONLY the tracked portal unit sets SHEIN_BI_CORE_WARMUP_QUEUE_OWNED=1;
//     env unset (Linux/WSL/dev) preserves the exact legacy inline behavior;
//   - queue-owned scheduling never calls runBiPortalCoreWarmup/loadBiSection:
//     the complete configured warmup set is enqueued once per core generation
//     with deterministic idempotency key `core-warmup:<generatedAt>` through
//     the managed queue (single priority group), exactly-once in-process AND
//     across restarts (queue-side dedupe + completed tombstones);
//   - queue-owned=1 with the external queue disabled fails visibly, never
//     inline;
//   - health truthfully exposes status=queued and owner=external-section-queue.
//
// All behavior runs inside a WSL/Linux child with queue files redirected to
// temp paths; the Windows host runs unit/source contracts and the harness.

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {provisionBiSessionSecret} from './provision_bi_session_secret.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WARMUP_SECTIONS = ['profit', 'homeRankings', 'homeProfit', 'afterSales', 'orders', 'homeTrafficDaily', 'priceScatter'];
const WARMUP_PRIORITY = 10;
const RUN_SLOW_INTEGRATION = process.env.BI_PORTAL_WARMUP_SLOW_INTEGRATION === '1';

// Direct Windows invocations of an integration self-check must use the same
// WSL/Linux runtime as the normal harness; otherwise /tmp and Linux signals do
// not exist. Keep the relay bounded and preserve child stdout/stderr/status.
if (process.platform === 'win32'
  && process.env.BI_PORTAL_WARMUP_INTEGRATION_SELFCHECK === '1'
  && process.env.BI_PORTAL_WARMUP_WSL_RELAY !== '1') {
  const relayNames = [
    'BI_PORTAL_WARMUP_INTEGRATION_SELFCHECK',
    'BI_PORTAL_WARMUP_OWNED_ENV',
    'BI_PORTAL_WARMUP_EXTERNAL_OFF',
    'BI_PORTAL_WARMUP_INTEGRATION_CASE',
  ];
  const relayEnv = relayNames
    .filter(name => process.env[name] !== undefined)
    .map(name => `${name}=${process.env[name]}`);
  const result = spawnSync('wsl.exe', [
    '--cd', ROOT,
    '--exec', '/usr/bin/env',
    ...relayEnv,
    'BI_PORTAL_WARMUP_WSL_RELAY=1',
    '/usr/bin/node', 'scripts/test_bi_portal_core_warmup_queue_owned.mjs',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status === null) {
    console.error(`integration relay failed status=null signal=${result.signal} error=${result.error?.message || ''}`);
  }
  process.exit(result.status ?? 1);
}

// ---------------------------------------------------------------------------
// Hook self-check mode: WSL child, exact env under test, real enqueue script
// redirected to temp queue files.
// ---------------------------------------------------------------------------
if (process.env.BI_PORTAL_WARMUP_HOOK_SELFCHECK === '1') {
  process.env.SHEIN_BI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const {__testHooks} = await import('./serve_bi_portal.mjs');
  const manage = await import('./manage_bi_portal_section_queue.mjs');
  const sandbox = await fs.mkdtemp('/tmp/warmup-queue-owned-');
  const queueFile = path.join(sandbox, 'queue.json');
  const lockFile = path.join(sandbox, 'queue.lock');
  process.env.SHEIN_BI_PORTAL_SECTION_QUEUE_FILE = queueFile;
  process.env.SHEIN_BI_PORTAL_SECTION_QUEUE_LOCK_FILE = lockFile;
  const apiCore = async generatedAt => {
    await fs.writeFile(path.join(sandbox, 'data.json'),
      JSON.stringify({generatedAt, __sections: {mode: 'api'}}));
  };
  const queueEntries = async () => {
    try {
      const payload = JSON.parse(await fs.readFile(queueFile, 'utf8'));
      return payload.entries || [];
    } catch {
      return [];
    }
  };
  const sectionsGenerated = async () => {
    try {
      return (await fs.readdir(path.join(sandbox, 'sections'))).length;
    } catch {
      return 0;
    }
  };
  const completedCount = async () => {
    try {
      const payload = JSON.parse(await fs.readFile(queueFile, 'utf8'));
      return (payload.completedIdempotency || []).length;
    } catch {
      return 0;
    }
  };
  const writeTerminalArtifacts = async (rootDir, generatedAt, targetSections) => {
    await fs.mkdir(path.join(rootDir, 'sections'), {recursive: true});
    for (const section of targetSections) {
      const payload = section === 'profit'
        ? {section, generatedAt, ok: true, data: {dailyStoreProducts: []}}
        : section === 'homeProfit'
          ? {section, generatedAt, ok: true, data: {homeProfitSummary: {dailyScopes: [], sourceGeneratedAt: generatedAt, staleSource: false}}}
          : {section, generatedAt, ok: true, data: {}};
      await fs.writeFile(path.join(rootDir, 'sections', `${section}.json`), `${JSON.stringify(payload)}\n`);
    }
  };
  // Deterministic fake validator: on every invocation it counts up; once the
  // invocation count reaches FAKE_TERMINAL_FLIP_AFTER it rewrites the core to
  // G2, then honors --expected-generated-at exactly like the real script.
  const fakeValidatorSource = [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "const argv = process.argv.slice(2);",
    "const option = name => { const index = argv.indexOf('--' + name); return index >= 0 ? argv[index + 1] : ''; };",
    "const root = option('root');",
    "const section = option('section');",
    "const expected = option('expected-generated-at');",
    "const countFile = process.env.FAKE_TERMINAL_COUNT_FILE || '';",
    "const flipAfter = Number(process.env.FAKE_TERMINAL_FLIP_AFTER || 'Infinity');",
    "let count = 0;",
    "if (countFile) { try { count = Number(fs.readFileSync(countFile, 'utf8') || '0') || 0; } catch {} fs.writeFileSync(countFile, String(count + 1)); }",
    "if (count >= flipAfter) { fs.writeFileSync(path.join(root, 'data.json'), JSON.stringify({generatedAt: 'G2', __sections: {mode: 'api', generatedAt: 'G2'}})); }",
    "try {",
    "  const core = JSON.parse(fs.readFileSync(path.join(root, 'data.json'), 'utf8'));",
    "  const coreGeneratedAt = String(core.generatedAt || '');",
    "  if (expected && coreGeneratedAt !== expected) { console.log(JSON.stringify({ok: false, reason: 'core_generated_at_unexpected', section, coreGeneratedAt, expectedGeneratedAt: expected})); process.exit(1); }",
    "  const artifact = JSON.parse(fs.readFileSync(path.join(root, 'sections', section + '.json'), 'utf8'));",
    "  if (String(artifact.generatedAt || '') !== expected) { console.log(JSON.stringify({ok: false, reason: 'section_generated_at_mismatch', section, coreGeneratedAt, sectionGeneratedAt: String(artifact.generatedAt || '')})); process.exit(1); }",
    "  console.log(JSON.stringify({ok: true, section, coreGeneratedAt, sectionGeneratedAt: artifact.generatedAt, expectedGeneratedAt: expected}));",
    "  process.exit(0);",
    "} catch (error) {",
    "  console.log(JSON.stringify({ok: false, reason: 'section_file_missing', section, error: String((error && error.message) || error)}));",
    "  process.exit(1);",
    "}",
  ].join('\n');
  const caseName = String(process.env.BI_PORTAL_WARMUP_HOOK_CASE || '');
  try {
    let report = {};
    if (caseName === 'legacy-inline') {
      await apiCore('G1');
      const scheduled = await __testHooks.scheduleBiPortalCoreWarmup({}, sandbox, {allowGenerate: true});
      report = {
        ok: true,
        caseName,
        scheduleReason: scheduled.reason || 'scheduled',
        scheduled: scheduled.scheduled,
        state: __testHooks.biPortalCoreWarmupState.status,
        inFlight: Boolean(__testHooks.biPortalCoreWarmupState.inFlight),
      };
    } else if (caseName === 'queued') {
      await apiCore('G1');
      const first = await __testHooks.scheduleBiPortalCoreWarmup({}, sandbox, {allowGenerate: true});
      const entriesAfterFirst = await queueEntries();
      const second = await __testHooks.scheduleBiPortalCoreWarmup({}, sandbox, {allowGenerate: true});
      const entriesAfterSecond = await queueEntries();
      await apiCore('G2');
      const third = await __testHooks.scheduleBiPortalCoreWarmup({}, sandbox, {allowGenerate: true});
      const entriesAfterThird = await queueEntries();
      report = {
        ok: true,
        caseName,
        firstReason: first.reason,
        firstQueued: first.queued,
        firstSections: first.sections,
        secondReason: second.reason,
        thirdReason: third.reason,
        state: __testHooks.biPortalCoreWarmupState.status,
        owner: __testHooks.biPortalCoreWarmupState.owner || '',
        stateGeneratedAt: __testHooks.biPortalCoreWarmupState.generatedAt,
        sectionsGenerated: await sectionsGenerated(),
        firstSectionsInQueue: entriesAfterFirst.map(entry => entry.section).sort(),
        firstPriorities: [...new Set(entriesAfterFirst.map(entry => entry.priority))],
        firstIdempotencyKeys: [...new Set(entriesAfterFirst.map(entry => entry.idempotencyKey))],
        firstReasons: entriesAfterFirst.flatMap(entry => entry.reasons || []),
        sameAfterRepeat: JSON.stringify(entriesAfterFirst.map(entry => ({section: entry.section, requestRevision: entry.requestRevision, status: entry.status})))
          === JSON.stringify(entriesAfterSecond.map(entry => ({section: entry.section, requestRevision: entry.requestRevision, status: entry.status}))),
        thirdReasons: entriesAfterThird.flatMap(entry => entry.reasons || []),
        thirdIdempotencyKeys: [...new Set(entriesAfterThird.map(entry => entry.idempotencyKey))],
      };
    } else if (caseName === 'enqueue-fail-retry') {
      const t0 = Date.parse('2026-08-17T00:00:00.000Z');
      await apiCore('G1');
      process.env.SHEIN_BI_PORTAL_SECTION_QUEUE_LOCK_FILE = '/proc/shein-queue-test/queue.lock';
      const failed = await __testHooks.scheduleBiPortalCoreWarmup({}, sandbox, {allowGenerate: true, nowMs: t0});
      const stateAfterFail = {...__testHooks.biPortalCoreWarmupState};
      process.env.SHEIN_BI_PORTAL_SECTION_QUEUE_LOCK_FILE = lockFile;
      const suppressed = await __testHooks.scheduleBiPortalCoreWarmup({}, sandbox, {allowGenerate: true, nowMs: t0 + 999});
      process.env.SHEIN_BI_PORTAL_SECTION_QUEUE_LOCK_FILE = '/proc/shein-queue-test/queue.lock';
      const failedAgain = await __testHooks.scheduleBiPortalCoreWarmup({}, sandbox, {allowGenerate: true, nowMs: t0 + 1_000});
      process.env.SHEIN_BI_PORTAL_SECTION_QUEUE_LOCK_FILE = lockFile;
      const suppressedAgain = await __testHooks.scheduleBiPortalCoreWarmup({}, sandbox, {allowGenerate: true, nowMs: t0 + 2_999});
      const retried = await __testHooks.scheduleBiPortalCoreWarmup({}, sandbox, {allowGenerate: true, nowMs: t0 + 3_000});
      const stateAfterRetry = {...__testHooks.biPortalCoreWarmupState};
      const entriesAfterRetry = await queueEntries();

      await apiCore('G2');
      process.env.SHEIN_BI_PORTAL_SECTION_QUEUE_LOCK_FILE = '/proc/shein-queue-test/queue.lock';
      const generationFailed = await __testHooks.scheduleBiPortalCoreWarmup({}, sandbox, {allowGenerate: true, nowMs: t0 + 4_000});
      await apiCore('G3');
      process.env.SHEIN_BI_PORTAL_SECTION_QUEUE_LOCK_FILE = lockFile;
      const generationReset = await __testHooks.scheduleBiPortalCoreWarmup({}, sandbox, {allowGenerate: true, nowMs: t0 + 4_001});
      const stateAfterGenerationReset = {...__testHooks.biPortalCoreWarmupState};
      report = {
        ok: true,
        caseName,
        failedReason: failed.reason,
        failedError: failed.error || '',
        firstFailureCount: stateAfterFail.consecutiveFailures,
        firstLastFailureAt: stateAfterFail.lastFailureAt ? new Date(stateAfterFail.lastFailureAt).toISOString() : null,
        firstNextAttemptAt: stateAfterFail.nextAttemptAt ? new Date(stateAfterFail.nextAttemptAt).toISOString() : null,
        stateAfterFail: stateAfterFail.status,
        suppressedReason: suppressed.reason,
        suppressedFailures: suppressed.consecutiveFailures,
        failedAgainReason: failedAgain.reason,
        secondFailureCount: failedAgain.consecutiveFailures,
        secondNextAttemptAt: failedAgain.nextAttemptAt,
        suppressedAgainReason: suppressedAgain.reason,
        retriedReason: retried.reason,
        stateAfterRetry: stateAfterRetry.status,
        lastErrorAfterRetry: stateAfterRetry.lastError || '',
        failuresAfterRetry: stateAfterRetry.consecutiveFailures,
        nextAttemptAfterRetry: stateAfterRetry.nextAttemptAt || 0,
        lastFailureAfterRetry: stateAfterRetry.lastFailureAt || 0,
        generationFailedReason: generationFailed.reason,
        generationFailedCount: generationFailed.consecutiveFailures,
        generationResetReason: generationReset.reason,
        generationResetState: stateAfterGenerationReset.status,
        generationResetFailures: stateAfterGenerationReset.consecutiveFailures,
        generationResetNextAttemptAt: stateAfterGenerationReset.nextAttemptAt || 0,
        generationResetLastFailureAt: stateAfterGenerationReset.lastFailureAt || 0,
        retryEntries: entriesAfterRetry.map(entry => entry.section).sort(),
        sectionsGenerated: await sectionsGenerated(),
      };
    } else if (caseName === 'queued-tz') {
      // Production generatedAt carries a +08:00 offset whose '+' is outside
      // the manager's strict idempotency-key charset.  The scheduler derives a
      // deterministic sha256 base key, so the full warmup set enqueues without
      // QUEUE_IDEMPOTENCY_KEY_INVALID and health reports queued + external
      // owner.  A second, different +08:00 generation must produce distinct
      // keys (no collision on the digest derivation).
      const tzAt = '2026-08-16T22:44:17.313125+08:00';
      await apiCore(tzAt);
      const scheduled = await __testHooks.scheduleBiPortalCoreWarmup({}, sandbox, {allowGenerate: true});
      const entries = await queueEntries();
      const expectedDigest = createHash('sha256').update(tzAt).digest('hex');
      const expectedKeys = WARMUP_SECTIONS.map(section => `core-warmup:sha256:${expectedDigest}::${section}`).sort();
      const actualKeys = [...new Set(entries.map(entry => entry.idempotencyKey))].sort();
      await apiCore('2026-08-16T23:00:00.000+08:00');
      const second = await __testHooks.scheduleBiPortalCoreWarmup({}, sandbox, {allowGenerate: true});
      const entriesAfterSecond = await queueEntries();
      const secondKeys = [...new Set(entriesAfterSecond.map(entry => entry.idempotencyKey))];
      report = {
        ok: true,
        caseName,
        scheduleReason: scheduled.reason,
        queued: scheduled.queued,
        state: __testHooks.biPortalCoreWarmupState.status,
        owner: __testHooks.biPortalCoreWarmupState.owner || '',
        lastError: __testHooks.biPortalCoreWarmupState.lastError || '',
        sectionCount: entries.length,
        keysMatchExpected: JSON.stringify(actualKeys) === JSON.stringify(expectedKeys),
        keysMatchPattern: entries.every(entry => /^[A-Za-z0-9._:-]{1,120}$/.test(String(entry.idempotencyKey || ''))),
        baseKeyLengthOk: entries.every(entry => String(entry.idempotencyKey || '').length <= 120),
        reasons: [...new Set(entries.flatMap(entry => entry.reasons || []))],
        secondReason: second.reason,
        secondKeysDistinct: secondKeys.some(key => !actualKeys.includes(key)),
      };
    } else if (caseName === 'queued-long-safe') {
      // A LONG but charset-safe generatedAt (over the 64-char safe ceiling)
      // must be auto-digested: keeping it verbatim would push the full
      // core-warmup:<raw>::<section> key beyond the manager's 120-char bound.
      const longAt = 'A'.repeat(80);
      await apiCore(longAt);
      const scheduled = await __testHooks.scheduleBiPortalCoreWarmup({}, sandbox, {allowGenerate: true});
      const entries = await queueEntries();
      const expectedDigest = createHash('sha256').update(longAt).digest('hex');
      const expectedKeys = WARMUP_SECTIONS.map(section => `core-warmup:sha256:${expectedDigest}::${section}`).sort();
      const actualKeys = [...new Set(entries.map(entry => entry.idempotencyKey))].sort();
      report = {
        ok: true,
        caseName,
        scheduleReason: scheduled.reason,
        state: __testHooks.biPortalCoreWarmupState.status,
        owner: __testHooks.biPortalCoreWarmupState.owner || '',
        lastError: __testHooks.biPortalCoreWarmupState.lastError || '',
        sectionCount: entries.length,
        keysMatchExpected: JSON.stringify(actualKeys) === JSON.stringify(expectedKeys),
        allBaseKeysSafe: entries.every(entry => /^[A-Za-z0-9._:-]{1,120}$/.test(String(entry.idempotencyKey || ''))),
        allFullKeysWithinBound: entries.every(entry => String(entry.idempotencyKey || '').length <= 120),
        longestKeyLength: entries.reduce((max, entry) => Math.max(max, String(entry.idempotencyKey || '').length), 0),
      };
    } else if (caseName === 'queued-nul') {
      // A generatedAt carrying NUL, DEL and C1 control bytes must never reach
      // exec argv raw: the key is digested and the reason is %HH-encoded, so
      // the real scheduler->script->manager chain enqueues all seven sections
      // without "string without null bytes" or enqueue-failed.
      const nulAt = 'bad\u0000\u007F\u009Ftime';
      await apiCore(nulAt);
      const scheduled = await __testHooks.scheduleBiPortalCoreWarmup({}, sandbox, {allowGenerate: true});
      const entries = await queueEntries();
      const expectedDigest = createHash('sha256').update(nulAt).digest('hex');
      const expectedKeys = WARMUP_SECTIONS.map(section => `core-warmup:sha256:${expectedDigest}::${section}`).sort();
      const actualKeys = [...new Set(entries.map(entry => entry.idempotencyKey))].sort();
      const reasons = [...new Set(entries.flatMap(entry => entry.reasons || []))];
      report = {
        ok: true,
        caseName,
        scheduleReason: scheduled.reason,
        state: __testHooks.biPortalCoreWarmupState.status,
        owner: __testHooks.biPortalCoreWarmupState.owner || '',
        lastError: __testHooks.biPortalCoreWarmupState.lastError || '',
        sectionCount: entries.length,
        keysMatchExpected: JSON.stringify(actualKeys) === JSON.stringify(expectedKeys),
        reasons,
        reasonsEncoded: reasons.every(reason => reason === 'core-warmup-bad%00%7F%9Ftime'),
        reasonsControlFree: entries.every(entry => (entry.reasons || []).every(reason => !/[\u0000-\u001F\u007F-\u009F]/.test(String(reason)))),
        reasonLengthsOk: entries.every(entry => (entry.reasons || []).every(reason => String(reason).length <= 240)),
      };
    } else if (caseName === 'queued-long-reason') {
      // An over-long generatedAt must keep the readable encoded head plus a
      // sha256 digest tail (explicit truncation semantics) so the reason stays
      // <=240 and unique, and the full set still enqueues.
      const longAt = 'A'.repeat(300);
      await apiCore(longAt);
      const scheduled = await __testHooks.scheduleBiPortalCoreWarmup({}, sandbox, {allowGenerate: true});
      const entries = await queueEntries();
      const digest = createHash('sha256').update(longAt).digest('hex');
      const expectedReason = `core-warmup-${'A'.repeat(160)}..sha256:${digest.slice(0, 40)}`;
      const expectedKeyDigest = createHash('sha256').update(longAt).digest('hex');
      const expectedKeys = WARMUP_SECTIONS.map(section => `core-warmup:sha256:${expectedKeyDigest}::${section}`).sort();
      const actualKeys = [...new Set(entries.map(entry => entry.idempotencyKey))].sort();
      const reasons = [...new Set(entries.flatMap(entry => entry.reasons || []))];
      report = {
        ok: true,
        caseName,
        scheduleReason: scheduled.reason,
        state: __testHooks.biPortalCoreWarmupState.status,
        owner: __testHooks.biPortalCoreWarmupState.owner || '',
        lastError: __testHooks.biPortalCoreWarmupState.lastError || '',
        sectionCount: entries.length,
        keysMatchExpected: JSON.stringify(actualKeys) === JSON.stringify(expectedKeys),
        reasons,
        reasonMatch: reasons.every(reason => reason === expectedReason),
        longestReasonLength: reasons.reduce((max, reason) => Math.max(max, String(reason).length), 0),
        reasonHasDigestTail: reasons.every(reason => String(reason).includes(`..sha256:${digest.slice(0, 20)}`)),
      };
    } else if (caseName === 'queued-collision') {
      // Cross-namespace collision: raw '+' digests to a 64-char hex base key
      // under `core-warmup:sha256:`, while that exact hex string is itself a
      // verbatim-safe token under `core-warmup:`.  The domain label keeps the
      // two generations' seven-section key sets completely disjoint.
      const plusAt = '+';
      const hexAt = createHash('sha256').update('+').digest('hex');
      await apiCore(plusAt);
      const first = await __testHooks.scheduleBiPortalCoreWarmup({}, sandbox, {allowGenerate: true});
      const firstEntries = await queueEntries();
      await apiCore(hexAt);
      const second = await __testHooks.scheduleBiPortalCoreWarmup({}, sandbox, {allowGenerate: true});
      const secondEntries = await queueEntries();
      const plusDigest = createHash('sha256').update('+').digest('hex');
      const expectedPlusKeys = WARMUP_SECTIONS.map(section => `core-warmup:sha256:${plusDigest}::${section}`).sort();
      const expectedHexKeys = WARMUP_SECTIONS.map(section => `core-warmup:${hexAt}::${section}`).sort();
      const plusKeys = [...new Set(firstEntries.map(entry => entry.idempotencyKey))].sort();
      const hexKeys = [...new Set(secondEntries.map(entry => entry.idempotencyKey))].sort();
      report = {
        ok: true,
        caseName,
        firstReason: first.reason,
        secondReason: second.reason,
        firstQueued: first.queued,
        secondQueued: second.queued,
        state: __testHooks.biPortalCoreWarmupState.status,
        owner: __testHooks.biPortalCoreWarmupState.owner || '',
        lastError: __testHooks.biPortalCoreWarmupState.lastError || '',
        plusKeys,
        hexKeys,
        plusKeysExpected: JSON.stringify(plusKeys) === JSON.stringify(expectedPlusKeys),
        hexKeysExpected: JSON.stringify(hexKeys) === JSON.stringify(expectedHexKeys),
        disjoint: plusKeys.every(key => !hexKeys.includes(key)) && hexKeys.every(key => !plusKeys.includes(key)),
        plusCount: firstEntries.length,
        hexCount: secondEntries.length,
        longestKeyLength: Math.max(
          ...plusKeys.map(key => key.length),
          ...hexKeys.map(key => key.length),
        ),
      };
    } else if (caseName === 'contradiction') {
      await apiCore('G1');
      const scheduled = await __testHooks.scheduleBiPortalCoreWarmup({}, sandbox, {allowGenerate: true});
      report = {
        ok: true,
        caseName,
        scheduleReason: scheduled.reason,
        state: __testHooks.biPortalCoreWarmupState.status,
        lastError: __testHooks.biPortalCoreWarmupState.lastError || '',
        queueEntries: (await queueEntries()).length,
        sectionsGenerated: await sectionsGenerated(),
      };
    } else if (caseName === 'all-completed') {
      // Every requested section already has a completed tombstone but NO
      // terminal artifact: tombstones are receipts only, so the authoritative
      // verification fails and the invalid sections are atomically requeued.
      await apiCore('G1');
      const queue = {version: 1, updatedAt: '', nextSequence: 0, entries: [], completedIdempotency: []};
      manage.enqueueSections(queue, {sections: WARMUP_SECTIONS, priority: WARMUP_PRIORITY, idempotencyKey: 'core-warmup:G1', now: new Date()});
      for (let index = 0; index < WARMUP_SECTIONS.length; index += 1) {
        const claim = manage.claimNext(queue, {leaseSeconds: 60, leaseId: `lease-all-${index}`, now: new Date(Date.now() + index * 100)});
        assert.equal(claim.section, WARMUP_SECTIONS[index]);
        manage.completeClaim(queue, {section: claim.section, leaseId: `lease-all-${index}`, now: new Date(Date.now() + index * 100 + 50)});
      }
      await fs.writeFile(queueFile, `${JSON.stringify(queue, null, 2)}\n`);
      const scheduled = await __testHooks.scheduleBiPortalCoreWarmup({}, sandbox, {allowGenerate: true});
      report = {
        ok: true,
        caseName,
        scheduleReason: scheduled.reason,
        state: __testHooks.biPortalCoreWarmupState.status,
        owner: __testHooks.biPortalCoreWarmupState.owner || '',
        generatedAt: __testHooks.biPortalCoreWarmupState.generatedAt,
        inFlight: Boolean(__testHooks.biPortalCoreWarmupState.inFlight),
        lastError: __testHooks.biPortalCoreWarmupState.lastError || '',
        entriesAfter: (await queueEntries()).length,
        completedAfter: await completedCount(),
        sectionsGenerated: await sectionsGenerated(),
      };
    } else if (caseName === 'all-completed-terminal') {
      // All tombstones AND all real terminal current-generation artifacts:
      // authoritative verification passes => truthful done with zero entries.
      await apiCore('G1');
      await writeTerminalArtifacts(sandbox, 'G1', WARMUP_SECTIONS);
      const queue = {version: 1, updatedAt: '', nextSequence: 0, entries: [], completedIdempotency: []};
      manage.enqueueSections(queue, {sections: WARMUP_SECTIONS, priority: WARMUP_PRIORITY, idempotencyKey: 'core-warmup:G1', now: new Date()});
      for (let index = 0; index < WARMUP_SECTIONS.length; index += 1) {
        const claim = manage.claimNext(queue, {leaseSeconds: 60, leaseId: `lease-term-${index}`, now: new Date(Date.now() + index * 100)});
        manage.completeClaim(queue, {section: claim.section, leaseId: `lease-term-${index}`, now: new Date(Date.now() + index * 100 + 50)});
      }
      await fs.writeFile(queueFile, `${JSON.stringify(queue, null, 2)}\n`);
      const scheduled = await __testHooks.scheduleBiPortalCoreWarmup({}, sandbox, {allowGenerate: true});
      report = {
        ok: true,
        caseName,
        scheduleReason: scheduled.reason,
        state: __testHooks.biPortalCoreWarmupState.status,
        owner: __testHooks.biPortalCoreWarmupState.owner || '',
        generatedAt: __testHooks.biPortalCoreWarmupState.generatedAt,
        inFlight: Boolean(__testHooks.biPortalCoreWarmupState.inFlight),
        lastError: __testHooks.biPortalCoreWarmupState.lastError || '',
        entriesAfter: (await queueEntries()).length,
        sectionsGenerated: await sectionsGenerated(),
      };
    } else if (caseName === 'partial-invalid-terminal') {
      // Three valid terminal artifacts + four missing: only the four invalid
      // tombstones are removed and requeued; the valid tombstones stay.
      await apiCore('G1');
      const valid = WARMUP_SECTIONS.slice(0, 3);
      const invalid = WARMUP_SECTIONS.slice(3);
      await writeTerminalArtifacts(sandbox, 'G1', valid);
      const queue = {version: 1, updatedAt: '', nextSequence: 0, entries: [], completedIdempotency: []};
      manage.enqueueSections(queue, {sections: WARMUP_SECTIONS, priority: WARMUP_PRIORITY, idempotencyKey: 'core-warmup:G1', now: new Date()});
      for (let index = 0; index < WARMUP_SECTIONS.length; index += 1) {
        const claim = manage.claimNext(queue, {leaseSeconds: 60, leaseId: `lease-part2-${index}`, now: new Date(Date.now() + index * 100)});
        manage.completeClaim(queue, {section: claim.section, leaseId: `lease-part2-${index}`, now: new Date(Date.now() + index * 100 + 50)});
      }
      await fs.writeFile(queueFile, `${JSON.stringify(queue, null, 2)}\n`);
      const scheduled = await __testHooks.scheduleBiPortalCoreWarmup({}, sandbox, {allowGenerate: true});
      report = {
        ok: true,
        caseName,
        scheduleReason: scheduled.reason,
        state: __testHooks.biPortalCoreWarmupState.status,
        owner: __testHooks.biPortalCoreWarmupState.owner || '',
        lastError: __testHooks.biPortalCoreWarmupState.lastError || '',
        entriesAfter: (await queueEntries()).length,
        completedAfter: await completedCount(),
        sectionsGenerated: await sectionsGenerated(),
      };
    } else if (caseName === 'partial-completed') {
      // Three completed tombstones + four pending entries: mixed state must
      // report queued with the truthful outcome breakdown.
      await apiCore('G1');
      const queue = {version: 1, updatedAt: '', nextSequence: 0, entries: [], completedIdempotency: []};
      manage.enqueueSections(queue, {sections: WARMUP_SECTIONS, priority: WARMUP_PRIORITY, idempotencyKey: 'core-warmup:G1', now: new Date()});
      for (let index = 0; index < 3; index += 1) {
        const claim = manage.claimNext(queue, {leaseSeconds: 60, leaseId: `lease-part-${index}`, now: new Date(Date.now() + index * 100)});
        manage.completeClaim(queue, {section: claim.section, leaseId: `lease-part-${index}`, now: new Date(Date.now() + index * 100 + 50)});
      }
      await fs.writeFile(queueFile, `${JSON.stringify(queue, null, 2)}\n`);
      const scheduled = await __testHooks.scheduleBiPortalCoreWarmup({}, sandbox, {allowGenerate: true});
      report = {
        ok: true,
        caseName,
        scheduleReason: scheduled.reason,
        state: __testHooks.biPortalCoreWarmupState.status,
        owner: __testHooks.biPortalCoreWarmupState.owner || '',
        entriesAfter: (await queueEntries()).length,
        sectionsGenerated: await sectionsGenerated(),
      };
    } else if (caseName === 'malformed-output') {
      // The manager queue file is corrupt: the enqueue child fails and the
      // scheduler must surface the failure visibly (never claim queued/done).
      await apiCore('G1');
      await fs.writeFile(queueFile, '{this is not valid json\n');
      const scheduled = await __testHooks.scheduleBiPortalCoreWarmup({}, sandbox, {allowGenerate: true});
      report = {
        ok: true,
        caseName,
        scheduleReason: scheduled.reason,
        state: __testHooks.biPortalCoreWarmupState.status,
        lastError: __testHooks.biPortalCoreWarmupState.lastError || '',
      };
    } else if (caseName === 'core-gen-flip') {
      // Controlled mid-verification race: 7 real G1 artifacts and 7 G1
      // tombstones, but the fake validator flips the core G1 -> G2 after two
      // validators have already passed.  The expected-generation pin fails the
      // later checks, the authoritative re-read sees G2, and the scheduler
      // must NOT claim G1 done or mutate tombstones.
      await apiCore('G1');
      await writeTerminalArtifacts(sandbox, 'G1', WARMUP_SECTIONS);
      const artifactsBefore = await sectionsGenerated();
      const queue = {version: 1, updatedAt: '', nextSequence: 0, entries: [], completedIdempotency: []};
      manage.enqueueSections(queue, {sections: WARMUP_SECTIONS, priority: WARMUP_PRIORITY, idempotencyKey: 'core-warmup:G1', now: new Date()});
      for (let index = 0; index < WARMUP_SECTIONS.length; index += 1) {
        const claim = manage.claimNext(queue, {leaseSeconds: 60, leaseId: `lease-flip-${index}`, now: new Date(Date.now() + index * 100)});
        manage.completeClaim(queue, {section: claim.section, leaseId: `lease-flip-${index}`, now: new Date(Date.now() + index * 100 + 50)});
      }
      await fs.writeFile(queueFile, `${JSON.stringify(queue, null, 2)}\n`);
      const fakeValidator = path.join(sandbox, 'fake-validator.mjs');
      await fs.writeFile(fakeValidator, fakeValidatorSource);
      process.env.SHEIN_BI_TERMINAL_VALIDATOR = fakeValidator;
      process.env.FAKE_TERMINAL_COUNT_FILE = path.join(sandbox, 'validator-count.txt');
      process.env.FAKE_TERMINAL_FLIP_AFTER = '2';
      const scheduled = await __testHooks.scheduleBiPortalCoreWarmup({}, sandbox, {allowGenerate: true});
      const after = JSON.parse(await fs.readFile(queueFile, 'utf8'));
      const flipState = __testHooks.biPortalCoreWarmupState.status;
      const flipOwner = __testHooks.biPortalCoreWarmupState.owner || '';
      const flipGeneratedAt = __testHooks.biPortalCoreWarmupState.generatedAt;
      const flipLastError = __testHooks.biPortalCoreWarmupState.lastError || '';
      const next = await __testHooks.scheduleBiPortalCoreWarmup({}, sandbox, {allowGenerate: true});
      const afterNext = JSON.parse(await fs.readFile(queueFile, 'utf8'));
      report = {
        ok: true,
        caseName,
        scheduleReason: scheduled.reason,
        previousGeneratedAt: scheduled.previousGeneratedAt || '',
        state: flipState,
        owner: flipOwner,
        stateGeneratedAt: flipGeneratedAt,
        lastError: flipLastError,
        entriesAfter: (after.entries || []).length,
        completedAfter: (after.completedIdempotency || []).length,
        artifactsBefore,
        artifactsAfter: await sectionsGenerated(),
        nextState: __testHooks.biPortalCoreWarmupState.status,
        nextReason: next.reason,
        nextEntries: (afterNext.entries || []).length,
        nextKeys: [...new Set((afterNext.entries || []).map(entry => entry.idempotencyKey))],
      };
    } else if (caseName === 'requeue-superseded') {
      // G1 completed every section (tombstones); profit then gets a fresh G2
      // pending entry.  No terminal artifacts => the G1 requeue collides with
      // the G2-owned profit slot and must be a strict no-op classified
      // supersededByExisting; the scheduler re-reads and defers instead of
      // claiming G1 queued/done.
      await apiCore('G1');
      const queue = {version: 1, updatedAt: '', nextSequence: 0, entries: [], completedIdempotency: []};
      manage.enqueueSections(queue, {sections: WARMUP_SECTIONS, priority: WARMUP_PRIORITY, idempotencyKey: 'core-warmup:G1', now: new Date()});
      for (let index = 0; index < WARMUP_SECTIONS.length; index += 1) {
        const claim = manage.claimNext(queue, {leaseSeconds: 60, leaseId: `lease-sup-${index}`, now: new Date(Date.now() + index * 100)});
        manage.completeClaim(queue, {section: claim.section, leaseId: `lease-sup-${index}`, now: new Date(Date.now() + index * 100 + 50)});
      }
      manage.enqueueSections(queue, {sections: ['profit'], priority: WARMUP_PRIORITY, idempotencyKey: 'core-warmup:G2', now: new Date(Date.now() + 3_000)});
      const g2Before = JSON.stringify(queue.entries.find(entry => entry.section === 'profit'));
      await fs.writeFile(queueFile, `${JSON.stringify(queue, null, 2)}\n`);
      const scheduled = await __testHooks.scheduleBiPortalCoreWarmup({}, sandbox, {allowGenerate: true});
      const after = JSON.parse(await fs.readFile(queueFile, 'utf8'));
      const g2After = after.entries.find(entry => entry.section === 'profit');
      report = {
        ok: true,
        caseName,
        scheduleReason: scheduled.reason,
        state: __testHooks.biPortalCoreWarmupState.status,
        owner: __testHooks.biPortalCoreWarmupState.owner || '',
        stateGeneratedAt: __testHooks.biPortalCoreWarmupState.generatedAt,
        lastError: __testHooks.biPortalCoreWarmupState.lastError || '',
        supersededSections: scheduled.supersededSections || [],
        entriesAfter: (after.entries || []).length,
        completedAfter: (after.completedIdempotency || []).length,
        g2ByteIdentical: g2After ? JSON.stringify(g2After) === g2Before : false,
        g2Key: g2After?.idempotencyKey || '',
        sectionsGenerated: await sectionsGenerated(),
      };
    } else if (caseName === 'enqueue-child-hung') {
      // A fire-and-forget enqueue child that wedges must be terminated
      // (SIGTERM then SIGKILL after a bounded grace) and the in-process
      // pending key must be released ONLY after the child closes, never by
      // a blind timer that lets duplicate worker processes stack up.
      const fakeScript = path.join(sandbox, 'fake-enqueue-hang.mjs');
      const pidFile = path.join(sandbox, 'fake-enqueue-hang.pid');
      await fs.writeFile(fakeScript, [
        "import fs from 'node:fs';",
        "fs.writeFileSync(process.env.FAKE_ENQUEUE_PID_FILE, String(process.pid));",
        "process.on('SIGTERM', () => {});",
        "setInterval(() => {}, 1000);",
      ].join('\n'));
      process.env.FAKE_ENQUEUE_PID_FILE = pidFile;
      process.env.SHEIN_BI_SECTION_ENQUEUE_CHILD_SPEC = `node|${fakeScript}`;
      const waitForPidFile = async (previousPid) => {
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline) {
          try {
            const pid = String(await fs.readFile(pidFile, 'utf8')).trim();
            if (pid && (!previousPid || pid !== previousPid)) return pid;
          } catch {}
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        return '';
      };
      const processAlive = pid => {
        if (!/^[0-9]+$/.test(String(pid || ''))) return false;
        try { process.kill(Number(pid), 0); return true; } catch { return false; }
      };
      const firstEnqueued = __testHooks.enqueueHostLockedBiSection('orders', 'G1', {force: true, refreshToken: 'run-token-1'});
      const pendingAfterFirst = __testHooks.biExternalSectionQueuePendingSize();
      const pid1 = await waitForPidFile('');
      const aliveSoonAfterSpawn = processAlive(pid1);
      const secondWhileHung = __testHooks.enqueueHostLockedBiSection('orders', 'G1', {force: true, refreshToken: 'run-token-1'});
      const pendingWhileHung = __testHooks.biExternalSectionQueuePendingSize();
      const aliveWhilePending = processAlive(pid1);
      // Wait past the kill deadline (timeout + SIGKILL grace + buffer).
      await new Promise(resolve => setTimeout(resolve, 3_000));
      const aliveAfterKill = processAlive(pid1);
      const pendingAfterKill = __testHooks.biExternalSectionQueuePendingSize();
      // A released key + new run token must spawn a fresh child immediately.
      const thirdWithNewToken = __testHooks.enqueueHostLockedBiSection('orders', 'G1', {force: true, refreshToken: 'run-token-2'});
      const pendingAfterNewToken = __testHooks.biExternalSectionQueuePendingSize();
      const pid2 = await waitForPidFile(pid1);
      const aliveNewChild = processAlive(pid2);
      const newChildDifferent = Boolean(pid2) && pid2 !== pid1 && aliveNewChild && pendingAfterNewToken === 1;
      await new Promise(resolve => setTimeout(resolve, 3_000));
      const aliveAfterSecondKill = processAlive(pid2);
      const pendingAfterSecondKill = __testHooks.biExternalSectionQueuePendingSize();
      report = {
        ok: true,
        caseName,
        firstEnqueued: firstEnqueued === true,
        pendingAfterFirst,
        aliveSoonAfterSpawn,
        secondSameKeyNoop: secondWhileHung === true && pendingWhileHung === 1,
        pendingWhileHung,
        aliveWhilePending,
        aliveAfterKill,
        pendingAfterKill,
        thirdWithNewToken: thirdWithNewToken === true,
        pendingAfterNewToken,
        newChildDifferent,
        aliveNewChild,
        aliveAfterSecondKill,
        pendingAfterSecondKill,
      };
    } else {
      const scheduled = await __testHooks.scheduleBiPortalCoreWarmup({}, sandbox, {allowGenerate: true});
      report = {
        ok: true,
        caseName: 'unset-legacy',
        scheduleReason: scheduled.reason,
        queueOwned: __testHooks.BI_CORE_WARMUP_QUEUE_OWNED,
      };
    }
    console.log(JSON.stringify(report));
  } finally {
    await fs.rm(sandbox, {recursive: true, force: true});
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Portal integration mode: WSL child starts/restarts the REAL portal against
// a temp root with an API-mode core; queue files are redirected to temp paths.
// ---------------------------------------------------------------------------
if (process.env.BI_PORTAL_WARMUP_INTEGRATION_SELFCHECK === '1') {
  process.env.SHEIN_BI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const {spawn, spawnSync} = await import('node:child_process');
  const net = await import('node:net');
  const logIntegrationStage = (stage, detail = {}) => {
    process.stderr.write(`${JSON.stringify({event: 'warmup-integration-stage', stage, at: new Date().toISOString(), ...detail})}\n`);
  };
  logIntegrationStage('setup-start');
  const temp = await fs.mkdtemp('/tmp/portal-warmup-queue-owned-');
  await provisionBiSessionSecret(path.join(temp, 'session-secret'));
  const portalRoot = path.join(temp, 'portal');
  await fs.mkdir(portalRoot, {recursive: true});
  await fs.writeFile(path.join(portalRoot, 'index.html'), '<!doctype html><html><body>test portal</body></html>');
  await fs.writeFile(path.join(portalRoot, 'data.json'), JSON.stringify({generatedAt: 'G1', __sections: {mode: 'api'}}));
  const queueFile = path.join(temp, 'queue.json');
  const lockFile = path.join(temp, 'queue.lock');
  const freePort = () => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const {port: chosen} = server.address();
      server.close(() => resolve(chosen));
    }).on('error', reject);
  });
  const buildEnv = () => {
    const env = {
      ...process.env,
      SHEIN_BI_PORTAL_SECTION_QUEUE_FILE: queueFile,
      SHEIN_BI_PORTAL_SECTION_QUEUE_LOCK_FILE: lockFile,
      SHEIN_BI_LIVE_UPDATES_ENABLED: '0',
      SHEIN_WEBHOOK_REPOSITORY_ENABLED: '0',
      SHEIN_LINK_OPS_STORE: 'json',
      SHEIN_OWNER_KNOWLEDGE_GIT_REPO_DIR: '',
      SHEIN_BI_CORE_WARMUP_DISABLED: '',
      SHEIN_BI_PORTAL_SHUTDOWN_TIMEOUT_MS: '3000',
    };
    if (process.env.BI_PORTAL_WARMUP_OWNED_ENV !== 'unset') {
      env.SHEIN_BI_CORE_WARMUP_QUEUE_OWNED = '1';
    }
    if (process.env.BI_PORTAL_WARMUP_EXTERNAL_OFF === '1') {
      env.SHEIN_BI_EXTERNAL_SECTION_QUEUE_ENABLED = '0';
    }
    return env;
  };
  const startPortal = async () => {
    logIntegrationStage('portal-start-begin');
    const port = await freePort();
    const child = spawn(process.execPath, [
      path.join(ROOT, 'scripts', 'serve_bi_portal.mjs'),
      '--host', '127.0.0.1',
      '--port', String(port),
      '--dir', portalRoot,
      '--no-auth',
      '--state-file', path.join(temp, 'state.json'),
      '--link-ops-task-file', path.join(temp, 'tasks.json'),
      '--link-ops-chat-file', path.join(temp, 'chats.json'),
      '--link-ops-runtime-file', path.join(temp, 'runtime.json'),
      '--manual-login-state-file', path.join(temp, 'manual-login.json'),
      '--audit-file', path.join(temp, 'audit.jsonl'),
      '--htpasswd-file', path.join(temp, 'missing.htpasswd'),
      '--session-secret-file', path.join(temp, 'session-secret'),
      '--auth-file', path.join(temp, 'users.json'),
    ], {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: buildEnv()});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`portal exited before startup: ${stderr}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (response.status === 200) {
          logIntegrationStage('portal-start-ready', {port, pid: child.pid});
          return {child, port, stdout: () => stdout, stderr: () => stderr};
        }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    child.kill('SIGKILL');
    const forced = await waitForChildClose(child, 2_000);
    throw new Error(`portal startup timed out: forcedClosed=${forced.closed} exitCode=${forced.exitCode} signalCode=${forced.signalCode} stdout=${stdout.slice(-2000)} stderr=${stderr.slice(-2000)}`);
  };
  const waitForChildClose = (child, timeoutMs) => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({closed: true, exitCode: child.exitCode, signalCode: child.signalCode});
      return;
    }
    let timer;
    const onClose = (exitCode, signalCode) => {
      clearTimeout(timer);
      resolve({closed: true, exitCode, signalCode});
    };
    child.once('close', onClose);
    timer = setTimeout(() => {
      child.removeListener('close', onClose);
      resolve({closed: false, exitCode: child.exitCode, signalCode: child.signalCode});
    }, timeoutMs);
  });
  const stopPortal = async handle => {
    const startedAt = Date.now();
    logIntegrationStage('portal-stop-begin', {port: handle.port, pid: handle.child.pid});
    if (handle.child.exitCode === null && handle.child.signalCode === null) {
      handle.child.kill('SIGTERM');
      logIntegrationStage('portal-stop-sigterm', {port: handle.port, pid: handle.child.pid});
    }
    const graceful = await waitForChildClose(handle.child, 8_000);
    if (!graceful.closed) {
      handle.child.kill('SIGKILL');
      const forced = await waitForChildClose(handle.child, 2_000);
      throw new Error([
        `portal shutdown timed out after ${Date.now() - startedAt}ms; SIGKILL sent`,
        `forcedClosed=${forced.closed}`,
        `exitCode=${forced.exitCode}`,
        `signalCode=${forced.signalCode}`,
        `stdout=${handle.stdout().slice(-4000)}`,
        `stderr=${handle.stderr().slice(-4000)}`,
      ].join('\n'));
    }
    const shutdownRecords = handle.stdout().split(/\r?\n/).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(record => record?.event === 'shutdown' || record?.event === 'shutdown-complete');
    const completed = shutdownRecords.find(record => record.event === 'shutdown-complete');
    const evidence = {
      wallMs: Date.now() - startedAt,
      exitCode: graceful.exitCode,
      signalCode: graceful.signalCode,
      shutdownStarted: shutdownRecords.some(record => record.event === 'shutdown'),
      shutdownCompleted: Boolean(completed),
      forcedConnections: Boolean(completed?.forcedConnections),
      serviceWallMs: Number(completed?.wallMs || 0),
      stderr: handle.stderr().slice(-2000),
    };
    assert.equal(graceful.exitCode, 0, `portal shutdown was not graceful: ${JSON.stringify(evidence)}\nstdout=${handle.stdout().slice(-4000)}`);
    assert.equal(graceful.signalCode, null, `portal exited by signal instead of bounded shutdown: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.shutdownStarted, true, `portal did not acknowledge SIGTERM: ${handle.stdout().slice(-4000)}`);
    assert.equal(evidence.shutdownCompleted, true, `portal did not emit bounded shutdown completion: ${handle.stdout().slice(-4000)}`);
    logIntegrationStage('portal-stop-complete', evidence);
    return evidence;
  };
  const settleHealth = async port => {
    let health;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
      if (['queued', 'done'].includes(health.biCoreWarmup.status) || health.biCoreWarmup.lastError) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    return health;
  };
  const queueSnapshot = async () => {
    try {
      const payload = JSON.parse(await fs.readFile(queueFile, 'utf8'));
      return (payload.entries || []).map(entry => ({
        section: entry.section,
        requestRevision: entry.requestRevision,
        claimedRevision: entry.claimedRevision,
        attempts: entry.attempts,
        rerun: entry.rerun,
        idempotencyKey: entry.idempotencyKey || '',
        status: entry.status,
        leaseId: entry.leaseId || '',
      }));
    } catch {
      return [];
    }
  };
  const sectionsGenerated = async () => {
    try { return (await fs.readdir(path.join(portalRoot, 'sections'))).length; } catch { return 0; }
  };
  const writeTerminalArtifacts = async (targetSections) => {
    await fs.mkdir(path.join(portalRoot, 'sections'), {recursive: true});
    for (const section of targetSections) {
      const payload = section === 'profit'
        ? {section, generatedAt: 'G1', ok: true, data: {dailyStoreProducts: []}}
        : section === 'homeProfit'
          ? {section, generatedAt: 'G1', ok: true, data: {homeProfitSummary: {dailyScopes: [], sourceGeneratedAt: 'G1', staleSource: false}}}
          : {section, generatedAt: 'G1', ok: true, data: {}};
      await fs.writeFile(path.join(portalRoot, 'sections', `${section}.json`), `${JSON.stringify(payload)}\n`);
    }
  };
  const queueContent = async () => {
    try { return await fs.readFile(queueFile, 'utf8'); } catch { return ''; }
  };
  const queueDocument = async () => {
    try { return JSON.parse(await fs.readFile(queueFile, 'utf8')); } catch { return {entries: [], completedIdempotency: []}; }
  };
  const caseName = String(process.env.BI_PORTAL_WARMUP_INTEGRATION_CASE || '');
  const report = {ok: true, caseName};
  try {
    if (caseName === 'starvation-recheck') {
      // Hold the real profit worker lease while browsers repeatedly request
      // the same missing generation. Every HTTP path must use the warmup key,
      // so even enqueue subprocesses that run after the in-process guard has
      // cleared are durable no-ops and cannot supersede the worker revision.
      const handle = await startPortal();
      try {
        await settleHealth(handle.port);
        const claimRun = spawnSync(process.execPath, [
          'scripts/manage_bi_portal_section_queue.mjs', 'claim', '--lease-seconds', '60', '--file', queueFile,
        ], {cwd: ROOT, encoding: 'utf8'});
        assert.equal(claimRun.status, 0, `profit claim failed: ${claimRun.stderr}`);
        const claim = JSON.parse(claimRun.stdout);
        assert.equal(claim.entry?.section, 'profit', `expected the canonical profit claim: ${claimRun.stdout}`);
        const before = (await queueSnapshot()).find(entry => entry.section === 'profit');
        assert.equal(before?.status, 'running');
        assert.equal(before?.idempotencyKey, 'core-warmup:G1::profit');

        const statuses = [];
        for (let round = 0; round < 4; round += 1) {
          const batch = await Promise.all(Array.from({length: 12}, () => (
            fetch(`http://127.0.0.1:${handle.port}/api/bi/section/profit`).then(response => response.status)
          )));
          statuses.push(...batch);
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        // Give every fire-and-forget enqueue child time to take the queue lock
        // and prove its same-key request is a durable manager no-op.
        await new Promise(resolve => setTimeout(resolve, 750));
        const after = (await queueSnapshot()).find(entry => entry.section === 'profit');
        await writeTerminalArtifacts(['profit']);
        const completeRun = spawnSync(process.execPath, [
          'scripts/manage_bi_portal_section_queue.mjs', 'complete', '--section', claim.entry.section,
          '--lease-id', claim.entry.leaseId, '--file', queueFile,
        ], {cwd: ROOT, encoding: 'utf8'});
        assert.equal(completeRun.status, 0, `profit complete failed: ${completeRun.stderr}`);
        const complete = JSON.parse(completeRun.stdout);
        const terminal = await queueDocument();
        const ordersBefore = (await queueSnapshot()).find(entry => entry.section === 'orders');
        const forceOrders = async refreshToken => {
          const tokenQuery = refreshToken == null ? '' : `&refreshToken=${encodeURIComponent(refreshToken)}`;
          const statuses = await Promise.all(Array.from({length: 10}, () => fetch(
            `http://127.0.0.1:${handle.port}/api/bi/section/orders?refresh=1&async=1${tokenQuery}`,
          ).then(async response => {
            try { await response.arrayBuffer(); } catch {}
            return response.status;
          })));
          await new Promise(resolve => setTimeout(resolve, 500));
          return {
            statuses: [...new Set(statuses)].sort(),
            entry: (await queueSnapshot()).find(entry => entry.section === 'orders'),
          };
        };
        const forceTokenA = await forceOrders('manual-token-a');
        const forceTokenARepeat = await forceOrders('manual-token-a');
        const forceTokenB = await forceOrders('manual-token-b');
        const forceUntokened = await forceOrders(null);
        const forceUntokenedRepeat = await forceOrders(null);
        report.before = before;
        report.after = after;
        report.httpStatuses = [...new Set(statuses)].sort();
        report.requestRevisionUnchanged = Boolean(after
          && after.requestRevision === before.requestRevision
          && after.claimedRevision === before.claimedRevision);
        report.runningLeasePreserved = Boolean(after
          && after.status === 'running'
          && after.leaseId === before.leaseId
          && after.rerun === false);
        report.completed = complete.completed === true;
        report.profitEntryRemoved = !(terminal.entries || []).some(entry => entry.section === 'profit');
        report.completedKeyPresent = (terminal.completedIdempotency || []).some(
          entry => entry.idempotencyKey === 'core-warmup:G1::profit',
        );
        report.forceRevisions = {
          before: ordersBefore?.requestRevision,
          tokenA: forceTokenA.entry?.requestRevision,
          tokenARepeat: forceTokenARepeat.entry?.requestRevision,
          tokenB: forceTokenB.entry?.requestRevision,
          untokened: forceUntokened.entry?.requestRevision,
          untokenedRepeat: forceUntokenedRepeat.entry?.requestRevision,
        };
        report.forceStatuses = {
          tokenA: forceTokenA.statuses,
          tokenARepeat: forceTokenARepeat.statuses,
          tokenB: forceTokenB.statuses,
          untokened: forceUntokened.statuses,
          untokenedRepeat: forceUntokenedRepeat.statuses,
        };
        report.forceKeys = {
          tokenA: forceTokenA.entry?.idempotencyKey || '',
          tokenARepeat: forceTokenARepeat.entry?.idempotencyKey || '',
          tokenB: forceTokenB.entry?.idempotencyKey || '',
          untokened: forceUntokened.entry?.idempotencyKey || '',
          untokenedRepeat: forceUntokenedRepeat.entry?.idempotencyKey || '',
        };
      } finally {
        report.shutdown = await stopPortal(handle);
      }
    } else if (caseName === 'restart-idem') {
      // Start, enqueue G1, stop, and restart with the SAME core and queue
      // files: the durable idempotency key must prevent any revision change
      // or entry recreation across the Portal restart.
      const first = await startPortal();
      await settleHealth(first.port);
      const before = await queueSnapshot();
      await stopPortal(first);
      const second = await startPortal();
      await settleHealth(second.port);
      await fetch(`http://127.0.0.1:${second.port}/`);
      await settleHealth(second.port);
      const after = await queueSnapshot();
      report.before = before;
      report.after = after;
      report.unchanged = JSON.stringify(before) === JSON.stringify(after);
      report.sectionsGenerated = await sectionsGenerated();
      await stopPortal(second);
    } else if (caseName === 'restart-running') {
      // A running worker lease must survive the Portal restart: a fresh
      // process re-enqueue of the same key is a no-op (no revision bump, no
      // rerun) and the entry stays under its original lease.
      const first = await startPortal();
      await settleHealth(first.port);
      const claimRun = spawnSync(process.execPath, [
        'scripts/manage_bi_portal_section_queue.mjs', 'claim', '--lease-seconds', '60', '--file', queueFile,
      ], {cwd: ROOT, encoding: 'utf8'});
      const claim = JSON.parse(claimRun.stdout);
      const before = await queueSnapshot();
      await stopPortal(first);
      const second = await startPortal();
      await settleHealth(second.port);
      await fetch(`http://127.0.0.1:${second.port}/`);
      await settleHealth(second.port);
      const after = await queueSnapshot();
      const claimedBefore = before.find(entry => entry.section === claim.entry.section);
      const claimedAfter = after.find(entry => entry.section === claim.entry.section);
      report.claimedSection = claim.entry.section;
      report.before = before;
      report.after = after;
      report.revisionUnchanged = Boolean(claimedBefore && claimedAfter
        && claimedBefore.requestRevision === claimedAfter.requestRevision);
      report.rerunFalse = claimedAfter?.rerun === false;
      report.stillRunningWithLease = claimedAfter?.status === 'running' && Boolean(claimedAfter?.leaseId);
      report.sectionsGenerated = await sectionsGenerated();
      await stopPortal(second);
    } else if (caseName === 'restart-done') {
      // Complete every warmup section (all tombstones) but NO terminal
      // artifacts, stop, and restart: tombstones are receipts only, so the
      // fresh Portal must requeue the invalid sections and report queued.
      const first = await startPortal();
      await settleHealth(first.port);
      for (let index = 0; index < WARMUP_SECTIONS.length; index += 1) {
        const claimRun = spawnSync(process.execPath, [
          'scripts/manage_bi_portal_section_queue.mjs', 'claim', '--lease-seconds', '60', '--file', queueFile,
        ], {cwd: ROOT, encoding: 'utf8'});
        const claim = JSON.parse(claimRun.stdout);
        const completeRun = spawnSync(process.execPath, [
          'scripts/manage_bi_portal_section_queue.mjs', 'complete', '--section', claim.entry.section, '--lease-id', claim.entry.leaseId, '--file', queueFile,
        ], {cwd: ROOT, encoding: 'utf8'});
        assert.equal(completeRun.status, 0, completeRun.stderr);
      }
      await stopPortal(first);
      const second = await startPortal();
      const health = await settleHealth(second.port);
      report.health = {
        status: health.biCoreWarmup.status,
        owner: health.biCoreWarmup.owner || '',
        generatedAt: health.biCoreWarmup.generatedAt || '',
        inFlight: Boolean(health.biCoreWarmup.inFlight),
        lastError: health.biCoreWarmup.lastError || '',
      };
      report.entriesAfter = (await queueSnapshot()).length;
      report.sectionsGenerated = await sectionsGenerated();
      await stopPortal(second);
    } else if (caseName === 'restart-done-terminal') {
      // All tombstones AND all real terminal artifacts: the fresh Portal
      // verifies the current generation and reports truthful done with zero
      // queue entries.
      await writeTerminalArtifacts(WARMUP_SECTIONS);
      const first = await startPortal();
      await settleHealth(first.port);
      for (let index = 0; index < WARMUP_SECTIONS.length; index += 1) {
        const claimRun = spawnSync(process.execPath, [
          'scripts/manage_bi_portal_section_queue.mjs', 'claim', '--lease-seconds', '60', '--file', queueFile,
        ], {cwd: ROOT, encoding: 'utf8'});
        const claim = JSON.parse(claimRun.stdout);
        const completeRun = spawnSync(process.execPath, [
          'scripts/manage_bi_portal_section_queue.mjs', 'complete', '--section', claim.entry.section, '--lease-id', claim.entry.leaseId, '--file', queueFile,
        ], {cwd: ROOT, encoding: 'utf8'});
        assert.equal(completeRun.status, 0, completeRun.stderr);
      }
      await stopPortal(first);
      const second = await startPortal();
      const health = await settleHealth(second.port);
      report.health = {
        status: health.biCoreWarmup.status,
        owner: health.biCoreWarmup.owner || '',
        generatedAt: health.biCoreWarmup.generatedAt || '',
        inFlight: Boolean(health.biCoreWarmup.inFlight),
        lastError: health.biCoreWarmup.lastError || '',
      };
      report.entriesAfter = (await queueSnapshot()).length;
      report.sectionsGenerated = await sectionsGenerated();
      await stopPortal(second);
    } else {
      const handle = await startPortal();
      try {
        for (const pathname of ['/', '/index.html', '/%69ndex.html']) {
          const response = await fetch(`http://127.0.0.1:${handle.port}${pathname}`);
          report[pathname] = response.status;
        }
        const health = await settleHealth(handle.port);
        report.health = {
          status: health.biCoreWarmup.status,
          owner: health.biCoreWarmup.owner || '',
          generatedAt: health.biCoreWarmup.generatedAt || '',
          lastError: health.biCoreWarmup.lastError || '',
          consecutiveFailures: health.biCoreWarmup.consecutiveFailures,
          nextAttemptAt: health.biCoreWarmup.nextAttemptAt,
          lastFailureAt: health.biCoreWarmup.lastFailureAt,
        };
        const afterIndexes = await queueContent();
        report.sectionsGenerated = await sectionsGenerated();
        await fetch(`http://127.0.0.1:${handle.port}/`);
        await new Promise(resolve => setTimeout(resolve, 300));
        report.sameAfterRepeat = afterIndexes === await queueContent();
        report.queueHasWarmupSet = JSON.stringify(WARMUP_SECTIONS.slice().sort())
          === JSON.stringify([...new Set(
            (JSON.parse(afterIndexes || '{"entries":[]}').entries || []).map(entry => entry.section),
          )].sort());
        report.queuePriority = [...new Set(
          (JSON.parse(afterIndexes || '{"entries":[]}').entries || []).map(entry => entry.priority),
        )];
        report.hasCoreWarmupReason = /core-warmup-G1/.test(afterIndexes);
        logIntegrationStage('default-case-readback-complete', {port: handle.port});
      } finally {
        report.shutdown = await stopPortal(handle);
      }
    }
  } finally {
    logIntegrationStage('cleanup-start', {temp});
    await fs.rm(temp, {recursive: true, force: true});
    logIntegrationStage('cleanup-complete');
  }
  console.log(JSON.stringify(report));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Unit env contract: the tracked portal unit owns the exact ownership env.
// ---------------------------------------------------------------------------
const unitSource = await fs.readFile(path.join(ROOT, 'infra', 'systemd', 'shein-bi-portal.service'), 'utf8');
assert.match(
  unitSource,
  /Environment=SHEIN_BI_CORE_WARMUP_QUEUE_OWNED=1\n/,
  'the tracked portal unit must set the exact queue ownership env',
);

// ---------------------------------------------------------------------------
// Source contracts
// ---------------------------------------------------------------------------
const source = await fs.readFile(path.join(ROOT, 'scripts', 'serve_bi_portal.mjs'), 'utf8');
const manage = await fs.readFile(path.join(ROOT, 'scripts', 'manage_bi_portal_section_queue.mjs'), 'utf8');
const testSource = await fs.readFile(fileURLToPath(import.meta.url), 'utf8');

assert.match(source, /SHEIN_BI_CORE_WARMUP_QUEUE_OWNED \|\| ''\)\.trim\(\)\.toLowerCase\(\)/,
  'the ownership env must be read, trimmed and lowercased');
assert.match(source, /\[\'1\', \'true\', \'yes\', \'on\'\]\.includes\(raw\)\) return true;/,
  'explicit true values must enable queue ownership');
assert.match(source,
  /const sections = configuredBiPortalCoreWarmupSections\(\);[\s\S]*if \(BI_CORE_WARMUP_QUEUE_OWNED\) \{[\s\S]*const warmupIdempotencyKey = biPortalCoreWarmupIdempotencyKey\(generatedAt\);[\s\S]*persistHostLockedBiSectionPlan\(plan, generatedAt, \{\s*reason: biPortalCoreWarmupReason\(generatedAt\),\s*idempotencyKey: warmupIdempotencyKey,/,
  'queue-owned scheduling must enqueue with the deterministic core-warmup idempotency key');
assert.match(source,
  /function biPortalCoreWarmupIdempotencyKey\(generatedAt\) \{[\s\S]*if \(\/\^\[A-Za-z0-9._:-\]\{1,64\}\$\/\.test\(raw\)\) return `core-warmup:\$\{raw\}`;[\s\S]*createHash\('sha256'\)\.update\(raw\)\.digest\('hex'\)[\s\S]*return `core-warmup:sha256:\$\{digest\}`;/,
  'the key helper must preserve safe synthetic tokens and digest any other generation under a distinct sha256 domain label');
assert.match(source, /function sanitizeBiQueueReason\(text\) \{[\s\S]*%HH/,
  'the reason sanitizer must percent-encode control bytes');
assert.ok(source.includes('.replace(/[\\u0000-\\u001F\\u007F-\\u009F]/g,'),
  'the reason sanitizer must encode C0 control, NUL, DEL and C1 bytes');
assert.match(source, /function biPortalCoreWarmupReason\(generatedAt\) \{[\s\S]*const MAX_BODY = 240 - PREFIX\.length;[\s\S]*reason: biPortalCoreWarmupReason\(generatedAt\),[\s\S]*reason: biPortalCoreWarmupReason\(generatedAt\),[\s\S]*reason: biPortalCoreWarmupReason\(generatedAt\),/,
  'the warmup reason helper must be bounded to 240 and used by both persists and the queued log');
assert.match(source, /\.\.sha256:\$\{digest\.slice\(0, 40\)\}/,
  'over-long reasons must carry a digest tail with explicit truncation');
assert.match(source, /if \(biPortalCoreWarmupState\.status === 'queued' && biPortalCoreWarmupState\.generatedAt === generatedAt\) \{[\s\S]*reason: 'already-queued'/,
  'the same generation must be enqueued exactly once in-process');
assert.match(source, /reason: 'queue-owned-without-external-queue'/,
  'queue-owned without the external queue must fail visibly');
assert.match(source,
  /const allCompleted = completedCount === requestedCount && activeCount === 0;[\s\S]*biPortalCoreWarmupState\.owner = 'external-section-queue';[\s\S]*if \(allCompleted\) \{[\s\S]*verifyWarmupSectionsTerminal\(root, sections, generatedAt\)/,
  'health state must record queued (or done) with the external queue owner');
assert.match(source, /owner: biPortalCoreWarmupState\.owner \|\| ''/,
  '/api/health must expose the queue owner');
assert.match(source, /consecutiveFailures: biPortalCoreWarmupState\.consecutiveFailures[\s\S]*nextAttemptAt: biPortalCoreWarmupState\.nextAttemptAt \? new Date\(biPortalCoreWarmupState\.nextAttemptAt\)\.toISOString\(\) : null[\s\S]*lastFailureAt: biPortalCoreWarmupState\.lastFailureAt \? new Date\(biPortalCoreWarmupState\.lastFailureAt\)\.toISOString\(\) : null/,
  '/api/health must expose bounded enqueue-failure telemetry without claiming success');
assert.match(source, /SHEIN_BI_CORE_WARMUP_ENQUEUE_BACKOFF_BASE_MS[\s\S]*60_000[\s\S]*SHEIN_BI_CORE_WARMUP_ENQUEUE_BACKOFF_CAP_MS[\s\S]*15 \* 60_000/,
  'enqueue backoff defaults to 60s and caps at 15m while remaining env-configurable');
assert.match(source, /reason: 'enqueue-backoff'[\s\S]*consecutiveFailures[\s\S]*nextAttemptAt/,
  'an open per-generation circuit must suppress enqueue attempts and report the next attempt');
assert.match(source,
  /lifecycle\.beginClose\(\)[\s\S]*onAdmissionClosed\?\.\(\)[\s\S]*const drainPromise = lifecycle\.waitForDrain\([\s\S]*const workersPromise = runBoundedRuntimeClosePhase\(\s*'workers-and-bridges'[\s\S]*const \[drain, workers\] = await Promise\.all\(\[drainPromise, workersPromise\]\)[\s\S]*if \(drain\.ok && workers\.ok\)[\s\S]*runBoundedRuntimeClosePhase\(\s*'stores'/,
  'shutdown must close admission synchronously, then run the HTTP drain and worker/bridge stop concurrently within the same deadline, and close stores only after both succeed');
assert.doesNotMatch(source, /const drain = await lifecycle\.waitForDrain/,
  'the HTTP drain must never be awaited serially before the worker stop');
assert.match(source, /server\.close\(error => resolve[\s\S]*server\.closeIdleConnections\?\.\(\)[\s\S]*const forceClose = \(\) => \{[\s\S]*server\.closeAllConnections\?\.\(\)[\s\S]*const graceful = await Promise\.race[\s\S]*if \(graceful\.settled\)[\s\S]*forceClose\(\)/,
  'HTTP shutdown must close idle connections, wait for admitted work, then force all connections only after the explicit timeout');
assert.match(source, /SHEIN_BI_PORTAL_SHUTDOWN_TIMEOUT_MS[\s\S]*Math\.max\(100, Math\.min\(30_000/,
  'production shutdown timeout must be explicitly configured and clamped');
assert.doesNotMatch(source, /await new Promise\(resolve => server\.close\(resolve\)\)/,
  'production shutdown must never await server.close without a bound');
assert.match(testSource, /portal shutdown timed out after .*SIGKILL sent[\s\S]*throw new Error/,
  'the test harness must kill an over-time child only to clean up, then fail with evidence');
assert.doesNotMatch(source, /systemctl|biCoreWarmupDeferUnitActive|deferredReason|deferUnit|SHEIN_BI_CORE_WARMUP_DEFER_WHILE_UNIT_ACTIVE/,
  'no coordinator-unit probe or defer state may remain');
assert.match(source,
  /let biIndexPath = url\.pathname;[\s\S]*decodeURIComponent\(url\.pathname\)[\s\S]*biIndexPath === '\/' \|\| biIndexPath === '\/index\.html'/,
  'the normalized encoded index trigger must be preserved');
assert.match(source, /\['--idempotency-key', idempotencyKey\]/,
  'persistHostLockedBiSectionPlan must pass the idempotency key to the enqueue script');
assert.match(source, /\['--coalesce-key', coalesceKey\]/,
  'live accounting persistence must pass its generation coalesce key to the queue manager');
assert.match(source, /function enqueueHostLockedBiSection[\s\S]*biPortalCoreWarmupIdempotencyKey\(generatedAt\)[\s\S]*'--idempotency-key', idempotencyKey/,
  'ordinary cache misses must enqueue with the warmup-compatible generation key');
assert.match(source, /function enqueueHostLockedBiSection[\s\S]*biPortalGenerationCoalesceKey\(generatedAt\)[\s\S]*'--coalesce-key', coalesceKey/,
  'ordinary core warmup/cache-miss work must share the generation coalesce group');
assert.match(source, /detached: process\.platform !== 'win32'/,
  'the production enqueue child must own a process group so descendants can be terminated together');
assert.match(source, /process\.kill\(-pid, signal\)/,
  'the enqueue deadline must terminate the Linux process group, not only the shell parent');
// A force refresh without a token must fail closed: the 30-day completed
// tombstone of the managed queue would otherwise swallow a later business
// rerun of the same core generation. The idempotency function rejects the
// missing token, the HTTP route returns 400, and the host-locked enqueue
// refuses to mint an untokened key.
assert.match(source, /BI_FORCE_REFRESH_TOKEN_REQUIRED: host-locked force refresh requires a stable refreshToken/,
  'the force-refresh idempotency key must reject an absent token instead of minting an untokened key');
assert.match(source, /sectionRequiresHostLockedWorker\(section, options\) && !String\(options\.refreshToken \|\| ''\)\.trim\(\)[\s\S]*BI_SECTION_FORCE_REFRESH_TOKEN_REQUIRED/,
  'the host-locked force refresh route must reject a missing refreshToken with an explicit 400');
assert.match(source, /refusing force enqueue without refreshToken/,
  'the host-locked enqueue must fail closed when a force request has no refresh token');
assert.match(source, /persistHomepageAccountingCatchupOnce[\s\S]*const idempotencyKey = biPortalHomepageAccountingIdempotencyKey\(accountingState, generatedAt\);[\s\S]*const key = idempotencyKey;[\s\S]*idempotencyKey,/,
  'homepage accounting catch-up must persist its generatedAt/minimum/target identity');
assert.match(source, /persistHomepageAccountingCatchupOnce[\s\S]*coalesceKey: biPortalGenerationCoalesceKey\(generatedAt\)/,
  'homepage accounting catch-up must share the core generation coalesce group');
assert.match(source, /export async function executeBiLiveAccountingRefreshAttempt\(\{[\s\S]*?persistAccountingPlan,[\s\S]*?await persistAccountingPlan\(accountingQueue, generatedAt, \{[\s\S]*?idempotencyKey: biPortalLiveAccountingIdempotencyKey\(generatedAt, sourceEvent\),[\s\S]*?\}\);/,
  'live order/return accounting helper must carry a stable event-derived queue identity');
assert.match(source, /coalesceKey: biPortalGenerationCoalesceKey\(generatedAt\)/,
  'live order/return accounting must also carry one stable core-generation coalesce group');
assert.match(source, /persistAccountingPlan: async \(accountingQueue, generatedAt, options\) => \{[\s\S]*?persistHostLockedBiSectionPlan\(accountingQueue, generatedAt, \{[\s\S]*?\.\.\.options,/,
  'live order/return accounting must adapt the guarded helper to the host-locked queue');
assert.match(source, /accountingEventIdentities[\s\S]*biPortalLiveAccountingEventIdentity\(event\)[\s\S]*\.slice\(-64\)/,
  'a live burst must retain bounded distinct event identities for one coalesced rerun');
assert.match(source, /managerReport = null;[\s\S]*JSON\.parse\(stdoutLines\.slice\(index\)\.join\('\\n'\)\)[\s\S]*malformed manager output/,
  'persist must parse the manager stdout JSON and fail visibly on malformed output');
assert.match(source, /accounted\.size !== requested\.size[\s\S]*did not account for every requested section exactly once/,
  'persist must verify every requested section is accounted exactly once');
assert.match(source,
  /if \(allCompleted\) \{[\s\S]*const terminal = await verifyWarmupSectionsTerminal\(root, sections, generatedAt\);[\s\S]*const stillCurrent = await warmupCoreStillCurrent\(root, generatedAt\);[\s\S]*!stillCurrent\.current[\s\S]*reason: 'core-generation-changed'[\s\S]*if \(terminal\.ok\) \{[\s\S]*biPortalCoreWarmupState\.status = 'done';[\s\S]*biPortalCoreWarmupState\.status = 'queued';[\s\S]*terminal verification failed for sections/,
  'scheduler must re-read the core before done/requeue, report a cross-generation flip as stale, and only claim done when every completed section passes terminal verification');
assert.match(source, /reason: 'already-completed', generatedAt, sections, queued: false/,
  'the truthful already-completed outcome must exist');
assert.match(source, /'--expected-generated-at', expectedGeneratedAt/,
  'the scheduler must pin every validator child to the exact core generation');
assert.match(source, /const validatorScript = process\.env\.SHEIN_BI_TERMINAL_VALIDATOR[\s\S]*check_bi_portal_section_terminal\.mjs/,
  'the default validator must be the authoritative terminal check script');
assert.match(source, /requeued\.supersededByExisting[\s\S]*core-generation-superseded/,
  'a requeue superseded by a newer-generation entry must defer instead of claiming G1 queued/done');

assert.match(manage, /IDEMPOTENCY_KEY_PATTERN = \/\^\[A-Za-z0-9._:-\]\{1,120\}\$\/;[\s\S]*COMPLETED_LEDGER_MAX_ENTRIES = 2_048;[\s\S]*COMPLETED_LEDGER_MAX_AGE_MS = 30 \* 24 \* 60 \* 60 \* 1_000;/,
  'the idempotency key and completed ledger must be strictly bounded');
assert.match(manage, /const entryKey = key \? `\$\{key\}::\$\{section\}` : '';/,
  'the durable per-section key must be idempotencyKey::section');
assert.match(manage, /entry && entryKey && entry\.idempotencyKey === entryKey\) \{[\s\S]*outcome\.deduplicatedPending\.push\(section\);[\s\S]*continue;/,
  'an existing entry with the same key must be a strict no-op');
assert.match(manage, /entryKey && Array\.isArray\(queue\.completedIdempotency\)[\s\S]*completedIdempotency\.some\(record => record\.idempotencyKey === entryKey\)\) \{[\s\S]*outcome\.deduplicatedCompleted\.push\(section\);[\s\S]*continue;/,
  'a completed tombstone must not recreate the entry');
assert.match(manage, /if \(entry\.idempotencyKey\) \{[\s\S]*queue\.completedIdempotency\.push\(\{[\s\S]*idempotencyKey: entry\.idempotencyKey,[\s\S]*completedAt: now\.toISOString\(\)[\s\S]*trimCompletedIdempotency\(queue, now\);/,
  'final completion must tombstone the durable key');
assert.match(manage, /outcome\.mutated \? writeQueue\(options\.file, outcome\.queue\) : outcome\.queue/,
  'a fully deduplicated enqueue must not rewrite the queue document');
assert.match(manage, /'--idempotency-key'\) options\.idempotencyKey = validateIdempotencyKey\(next\(\)\);/,
  'the CLI must accept and strictly validate --idempotency-key');
assert.match(manage, /'--coalesce-key'\) options\.coalesceKey = validateIdempotencyKey\(next\(\)\);/,
  'the CLI must accept and strictly validate --coalesce-key');
assert.match(manage, /outcome\.supersededByExisting\.push\(section\);[\s\S]*continue;/,
  'a requeue colliding with a different-key existing entry must be a strict no-op');

const portalIdempotencyHooks = (await import('./serve_bi_portal.mjs')).__testHooks;
const forceA = portalIdempotencyHooks.biPortalForceRefreshIdempotencyKey('G1', 'manual-17');
assert.equal(forceA, portalIdempotencyHooks.biPortalForceRefreshIdempotencyKey('G1', 'manual-17'),
  'the same generation and refresh token must be exactly stable');
assert.notEqual(forceA, portalIdempotencyHooks.biPortalForceRefreshIdempotencyKey('G1', 'manual-18'),
  'a distinct explicit refresh token must form one distinct request');
// A missing token must be an explicit programming error, never a silent
// per-generation key that the 30-day completed tombstone can swallow.
assert.throws(() => portalIdempotencyHooks.biPortalForceRefreshIdempotencyKey('G1', ''), /BI_FORCE_REFRESH_TOKEN_REQUIRED/,
  'an empty refresh token must be rejected by the force-refresh idempotency key');
assert.throws(() => portalIdempotencyHooks.biPortalForceRefreshIdempotencyKey('G1'), /BI_FORCE_REFRESH_TOKEN_REQUIRED/,
  'an omitted refresh token must be rejected by the force-refresh idempotency key');
assert.throws(() => portalIdempotencyHooks.biPortalForceRefreshIdempotencyKey('G1', '   '), /BI_FORCE_REFRESH_TOKEN_REQUIRED/,
  'a blank refresh token must be rejected by the force-refresh idempotency key');
const accountingState = {
  minimumPublishedAt: '2026-08-17T05:00:00.000Z',
  freshness: {accountingInputUpdatedAt: '2026-08-17T05:01:00.000Z'},
};
assert.equal(
  portalIdempotencyHooks.biPortalHomepageAccountingIdempotencyKey(accountingState, 'G1'),
  portalIdempotencyHooks.biPortalHomepageAccountingIdempotencyKey(structuredClone(accountingState), 'G1'),
  'the same homepage accounting target must be stable',
);
assert.notEqual(
  portalIdempotencyHooks.biPortalHomepageAccountingIdempotencyKey(accountingState, 'G1'),
  portalIdempotencyHooks.biPortalHomepageAccountingIdempotencyKey({
    ...accountingState,
    freshness: {accountingInputUpdatedAt: '2026-08-17T05:02:00.000Z'},
  }, 'G1'),
  'a genuinely newer homepage accounting target must form one new request',
);
const liveOrder = {
  kind: 'order', storeKey: 'JSH', entityId: 'order-100', businessDate: '2026-08-17',
  orderStatus: 'paid', salesQuantity: 1, salesSar: 42, occurredAt: '2026-08-17T05:03:00.000Z',
};
const liveKey = portalIdempotencyHooks.biPortalLiveAccountingIdempotencyKey('G1', liveOrder);
const liveCoalesceKey = portalIdempotencyHooks.biPortalGenerationCoalesceKey('G1');
assert.equal(liveCoalesceKey, portalIdempotencyHooks.biPortalGenerationCoalesceKey('G1'),
  'one core generation must have one stable live-accounting coalesce group');
assert.notEqual(liveCoalesceKey, portalIdempotencyHooks.biPortalGenerationCoalesceKey('G2'),
  'a new core generation must not coalesce into the previous generation');
assert.equal(liveKey, portalIdempotencyHooks.biPortalLiveAccountingIdempotencyKey('G1', {...liveOrder}),
  'replaying the same live fact must be a no-op identity');
assert.notEqual(liveKey, portalIdempotencyHooks.biPortalLiveAccountingIdempotencyKey('G1', {
  ...liveOrder, orderStatus: 'cancelled', occurredAt: '2026-08-17T05:04:00.000Z',
}), 'a genuinely new order fact must preserve one coalesced rerun identity');
for (const key of [forceA, liveKey, liveCoalesceKey, portalIdempotencyHooks.biPortalHomepageAccountingIdempotencyKey(accountingState, 'G1')]) {
  assert.match(key, /^[A-Za-z0-9._:-]{1,101}$/,
    `Portal idempotency base must remain bounded before the manager appends ::section: ${key}`);
}

// ---------------------------------------------------------------------------
// Child harness (WSL stdin mode; Windows->WSL spawn env is unreliable).
// ---------------------------------------------------------------------------
function runBash(script, {timeoutMs = 30_000} = {}) {
  const command = process.platform === 'win32' ? 'wsl.exe' : 'bash';
  const commandArgs = process.platform === 'win32'
    ? ['--cd', ROOT, '--exec', '/bin/bash', '-s']
    : ['-s'];
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    input: script,
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `bash child failed status=${result.status} signal=${result.signal} error=${result.error?.message || ''}\nscript:\n${script}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

function hookCase(caseName, extraExports = []) {
  const exports = [
    ...extraExports,
    ['BI_PORTAL_WARMUP_HOOK_SELFCHECK', '1'],
    ['BI_PORTAL_WARMUP_HOOK_CASE', caseName],
  ].map(([key, value]) => `export ${key}='${value}'`).join('\n');
  const result = runBash(`set -e
${exports}
node scripts/test_bi_portal_core_warmup_queue_owned.mjs
`);
  const lines = String(result.stdout || '').trim().split('\n').filter(Boolean);
  const report = JSON.parse(lines[lines.length - 1]);
  assert.equal(report.ok, true, `hook case ${caseName} failed: ${result.stdout}\nstderr:\n${result.stderr}`);
  return report;
}

function integrationCase({ownedEnv, externalOff = false, integrationCaseName = ''}) {
  const exports = [
    ['BI_PORTAL_WARMUP_INTEGRATION_SELFCHECK', '1'],
    ['BI_PORTAL_WARMUP_OWNED_ENV', ownedEnv],
    ...(integrationCaseName ? [['BI_PORTAL_WARMUP_INTEGRATION_CASE', integrationCaseName]] : []),
    ...(externalOff ? [['BI_PORTAL_WARMUP_EXTERNAL_OFF', '1']] : []),
  ].map(([key, value]) => `export ${key}='${value}'`).join('\n');
  const result = runBash(`set -e
${exports}
node scripts/test_bi_portal_core_warmup_queue_owned.mjs
`);
  const lines = String(result.stdout || '').trim().split('\n').filter(Boolean);
  const report = JSON.parse(lines[lines.length - 1]);
  assert.equal(report.ok, true, `integration case failed: ${result.stdout}\nstderr:\n${result.stderr}`);
  return report;
}

// Hook-level behavior -------------------------------------------------------

const unset = hookCase('unset');
assert.equal(unset.queueOwned, false, 'unset env must leave queue ownership off');
assert.equal(unset.scheduleReason, 'not-api-mode', 'legacy scheduler path must be reached');

const legacyInline = hookCase('legacy-inline');
assert.equal(legacyInline.scheduled, true, 'legacy inline warmup must still schedule');
assert.equal(legacyInline.state, 'running', 'legacy inline warmup must actually run');
assert.equal(legacyInline.inFlight, true);

const queued = hookCase('queued', [['SHEIN_BI_CORE_WARMUP_QUEUE_OWNED', '1']]);
assert.equal(queued.firstReason, 'queued');
assert.equal(queued.firstQueued, true);
assert.deepEqual(queued.firstSections.slice().sort(), WARMUP_SECTIONS.slice().sort());
assert.equal(queued.secondReason, 'already-queued', 'same generation must not re-enqueue');
assert.equal(queued.sameAfterRepeat, true, 'queue content must not change on repeat');
assert.equal(queued.thirdReason, 'queued', 'a new generation must enqueue again');
assert.equal(queued.state, 'queued');
assert.equal(queued.owner, 'external-section-queue');
assert.equal(queued.stateGeneratedAt, 'G2');
assert.equal(queued.sectionsGenerated, 0, 'no section may be generated inline');
assert.deepEqual(queued.firstSectionsInQueue, WARMUP_SECTIONS.slice().sort(), 'the full warmup set must be in the queue');
assert.deepEqual(queued.firstPriorities, [WARMUP_PRIORITY], 'single priority group');
assert.deepEqual(queued.firstIdempotencyKeys, [`core-warmup:G1::profit`, `core-warmup:G1::homeRankings`, `core-warmup:G1::homeProfit`, `core-warmup:G1::afterSales`, `core-warmup:G1::orders`, `core-warmup:G1::homeTrafficDaily`, `core-warmup:G1::priceScatter`],
  'each section must carry the deterministic per-section idempotency key');
assert.ok(queued.firstReasons.some(reason => reason === 'core-warmup-G1'), 'deterministic reason with generatedAt');
assert.ok(queued.thirdReasons.some(reason => reason === 'core-warmup-G2'), 'new generation reason');
assert.ok(queued.thirdIdempotencyKeys.every(key => key.startsWith('core-warmup:G2::')), 'new generation idempotency keys');

// Production +08:00 generatedAt: the manager's strict key charset rejects '+',
// so the scheduler must derive a deterministic sha256 base key.  The full
// warmup set enqueues (7 sections), health reports queued + external owner
// with no QUEUE_IDEMPOTENCY_KEY_INVALID, and a different +08:00 generation
// produces distinct keys.
const queuedTz = hookCase('queued-tz', [['SHEIN_BI_CORE_WARMUP_QUEUE_OWNED', '1']]);
assert.equal(queuedTz.scheduleReason, 'queued', 'a +08:00 core generation must enqueue without key rejection');
assert.equal(queuedTz.state, 'queued');
assert.equal(queuedTz.owner, 'external-section-queue');
assert.equal(queuedTz.lastError, '', 'no QUEUE_IDEMPOTENCY_KEY_INVALID may surface as lastError');
assert.equal(queuedTz.sectionCount, 7, 'the full warmup set must be enqueued');
assert.equal(queuedTz.keysMatchExpected, true, 'per-section keys must be the deterministic digest key plus ::section');
assert.equal(queuedTz.keysMatchPattern, true, 'every per-section key must satisfy the manager charset');
assert.equal(queuedTz.baseKeyLengthOk, true, 'every base key must stay within the 120-char bound');
assert.ok(queuedTz.reasons.some(reason => reason === 'core-warmup-2026-08-16T22:44:17.313125+08:00'),
  'the human-readable reason keeps the original generation');
assert.equal(queuedTz.secondReason, 'queued', 'a second +08:00 generation must enqueue normally');
assert.equal(queuedTz.secondKeysDistinct, true, 'different generations must derive distinct digest keys');

// A LONG but charset-safe generatedAt (>64 chars) must be auto-digested so
// every full core-warmup key stays within the manager's 120-char bound even
// for the longest configured section suffix.
const queuedLongSafe = hookCase('queued-long-safe', [['SHEIN_BI_CORE_WARMUP_QUEUE_OWNED', '1']]);
assert.equal(queuedLongSafe.scheduleReason, 'queued');
assert.equal(queuedLongSafe.state, 'queued');
assert.equal(queuedLongSafe.owner, 'external-section-queue');
assert.equal(queuedLongSafe.lastError, '', 'no key-bound rejection may surface');
assert.equal(queuedLongSafe.sectionCount, 7, 'the full warmup set must be enqueued');
assert.equal(queuedLongSafe.keysMatchExpected, true, 'a safe-but-long generation must be digested deterministically');
assert.equal(queuedLongSafe.allBaseKeysSafe, true, 'every base key must satisfy the manager charset');
assert.equal(queuedLongSafe.allFullKeysWithinBound, true, 'every full core-warmup key must stay <= 120 chars');
assert.ok(queuedLongSafe.longestKeyLength <= 120, `longest key must respect the 120-char bound (got ${queuedLongSafe.longestKeyLength})`);

// A generatedAt carrying NUL+DEL control bytes must never reach exec argv raw:
// the idempotency key is digested and the queue reason %HH-encoded.  The real
// scheduler->script->manager chain enqueues all seven sections, health reports
// queued + external owner, and no enqueue-failed / null-byte error surfaces.
const queuedNul = hookCase('queued-nul', [['SHEIN_BI_CORE_WARMUP_QUEUE_OWNED', '1']]);
assert.equal(queuedNul.scheduleReason, 'queued', 'a NUL/DEL/C1 generation must enqueue, never enqueue-failed');
assert.equal(queuedNul.state, 'queued');
assert.equal(queuedNul.owner, 'external-section-queue');
assert.equal(queuedNul.lastError, '', 'no null-byte argv failure may surface as lastError');
assert.equal(queuedNul.sectionCount, 7, 'the full warmup set must enqueue');
assert.equal(queuedNul.keysMatchExpected, true, 'the NUL-containing generation must use its deterministic digest key');
assert.equal(queuedNul.reasonsEncoded, true, 'the reason must be core-warmup-bad%00%7F%9Ftime (NUL, DEL and C1 %HH-encoded)');
assert.equal(queuedNul.reasonsControlFree, true, 'no raw C0/DEL/C1 byte may survive in any queue reason');
assert.equal(queuedNul.reasonLengthsOk, true, 'every reason must stay within the 240-char bound');

// An over-long generatedAt (300 chars) keeps a readable encoded head plus a
// sha256 digest tail: explicit truncation semantics, deterministic, <=240,
// yet unique per generation.
const queuedLongReason = hookCase('queued-long-reason', [['SHEIN_BI_CORE_WARMUP_QUEUE_OWNED', '1']]);
assert.equal(queuedLongReason.scheduleReason, 'queued');
assert.equal(queuedLongReason.state, 'queued');
assert.equal(queuedLongReason.owner, 'external-section-queue');
assert.equal(queuedLongReason.lastError, '');
assert.equal(queuedLongReason.sectionCount, 7);
assert.equal(queuedLongReason.keysMatchExpected, true);
assert.equal(queuedLongReason.reasonMatch, true, 'the over-long reason must match the deterministic head+digest form');
assert.ok(queuedLongReason.longestReasonLength <= 240,
  `the longest reason must respect the 240-char bound (got ${queuedLongReason.longestReasonLength})`);
assert.equal(queuedLongReason.reasonHasDigestTail, true, 'the digest tail must bind the full generation uniquely');

// Cross-namespace collision regression: raw '+' must digest under the
// `core-warmup:sha256:` domain label while its own sha256 hex (a verbatim-safe
// token) stays under `core-warmup:` -- both generations enqueue seven distinct
// per-section keys with no overlap.
const queuedCollision = hookCase('queued-collision', [['SHEIN_BI_CORE_WARMUP_QUEUE_OWNED', '1']]);
assert.equal(queuedCollision.firstReason, 'queued', 'the digest-domain generation must enqueue');
assert.equal(queuedCollision.secondReason, 'queued', 'the verbatim hex-token generation must enqueue');
assert.equal(queuedCollision.state, 'queued');
assert.equal(queuedCollision.owner, 'external-section-queue');
assert.equal(queuedCollision.lastError, '');
assert.equal(queuedCollision.plusKeysExpected, true, 'raw "+" must use core-warmup:sha256:<digest>::section');
assert.equal(queuedCollision.hexKeysExpected, true, 'the hex token itself must use core-warmup:<hex>::section verbatim');
assert.equal(queuedCollision.disjoint, true, 'the digest-domain and verbatim keys must never collide');
assert.equal(queuedCollision.plusCount, 7);
assert.equal(queuedCollision.hexCount, 7);
assert.ok(queuedCollision.longestKeyLength <= 120,
  `every full key must stay within the 120-char bound (got ${queuedCollision.longestKeyLength})`);

const retry = hookCase('enqueue-fail-retry', [
  ['SHEIN_BI_CORE_WARMUP_QUEUE_OWNED', '1'],
  ['SHEIN_BI_CORE_WARMUP_ENQUEUE_BACKOFF_BASE_MS', '1000'],
  ['SHEIN_BI_CORE_WARMUP_ENQUEUE_BACKOFF_CAP_MS', '4000'],
]);
assert.equal(retry.failedReason, 'enqueue-failed');
assert.ok(retry.failedError, 'the enqueue error must be visible');
assert.equal(retry.stateAfterFail, 'error', 'a failed enqueue must remain visibly failed, never queued/done');
assert.equal(retry.firstFailureCount, 1);
assert.equal(retry.firstLastFailureAt, '2026-08-17T00:00:00.000Z');
assert.equal(retry.firstNextAttemptAt, '2026-08-17T00:00:01.000Z');
assert.equal(retry.suppressedReason, 'enqueue-backoff', 'same-generation ticks before the deadline must not enqueue');
assert.equal(retry.suppressedFailures, 1);
assert.equal(retry.failedAgainReason, 'enqueue-failed');
assert.equal(retry.secondFailureCount, 2, 'same-generation failures must increase exponentially');
assert.equal(retry.secondNextAttemptAt, '2026-08-17T00:00:03.000Z');
assert.equal(retry.suppressedAgainReason, 'enqueue-backoff');
assert.equal(retry.retriedReason, 'queued', 'the deadline tick may retry and succeed');
assert.equal(retry.stateAfterRetry, 'queued');
assert.equal(retry.lastErrorAfterRetry, '', 'the error must clear after success');
assert.equal(retry.failuresAfterRetry, 0, 'success must clear the consecutive failure count');
assert.equal(retry.nextAttemptAfterRetry, 0, 'success must close the circuit');
assert.equal(retry.lastFailureAfterRetry, 0, 'success must clear the last failure timestamp');
assert.deepEqual(retry.retryEntries, WARMUP_SECTIONS.slice().sort());
assert.equal(retry.sectionsGenerated, 0);
assert.equal(retry.generationFailedReason, 'enqueue-failed');
assert.equal(retry.generationFailedCount, 1);
assert.equal(retry.generationResetReason, 'queued', 'a new core generation must reset the old generation circuit immediately');
assert.equal(retry.generationResetState, 'queued');
assert.equal(retry.generationResetFailures, 0);
assert.equal(retry.generationResetNextAttemptAt, 0);
assert.equal(retry.generationResetLastFailureAt, 0);

const contradiction = hookCase('contradiction', [
  ['SHEIN_BI_CORE_WARMUP_QUEUE_OWNED', '1'],
  ['SHEIN_BI_EXTERNAL_SECTION_QUEUE_ENABLED', '0'],
]);
assert.equal(contradiction.scheduleReason, 'queue-owned-without-external-queue');
assert.match(contradiction.lastError, /requires the managed external section queue/);
assert.equal(contradiction.state, 'idle', 'contradiction must never fall back inline');
assert.equal(contradiction.queueEntries, 0);
assert.equal(contradiction.sectionsGenerated, 0);

// All tombstones but NO terminal artifacts: receipts only -- the invalid
// tombstones are atomically requeued and the state is queued, never done.
if (RUN_SLOW_INTEGRATION) {
  const allCompleted = hookCase('all-completed', [['SHEIN_BI_CORE_WARMUP_QUEUE_OWNED', '1']]);
  assert.equal(allCompleted.scheduleReason, 'queued');
  assert.equal(allCompleted.state, 'queued', 'missing terminal artifacts must never claim done');
  assert.equal(allCompleted.owner, 'external-section-queue');
  assert.equal(allCompleted.generatedAt, 'G1');
  assert.match(allCompleted.lastError, /terminal verification failed/);
  assert.equal(allCompleted.entriesAfter, 7, 'all invalid tombstones must be requeued as fresh entries');
  assert.equal(allCompleted.completedAfter, 0, 'all seven invalid tombstones must be removed');
  assert.equal(allCompleted.sectionsGenerated, 0);
}

// All tombstones AND all real terminal current-generation artifacts: done.
if (RUN_SLOW_INTEGRATION) {
  const allCompletedTerminal = hookCase('all-completed-terminal', [['SHEIN_BI_CORE_WARMUP_QUEUE_OWNED', '1']]);
  assert.equal(allCompletedTerminal.scheduleReason, 'already-completed');
  assert.equal(allCompletedTerminal.state, 'done');
  assert.equal(allCompletedTerminal.owner, 'external-section-queue');
  assert.equal(allCompletedTerminal.generatedAt, 'G1');
  assert.equal(allCompletedTerminal.inFlight, false);
  assert.equal(allCompletedTerminal.lastError, '');
  assert.equal(allCompletedTerminal.entriesAfter, 0, 'terminal tombstones must not recreate entries');
  assert.equal(allCompletedTerminal.sectionsGenerated, 7, 'the real terminal artifacts are present');
}

// Mixed: three valid artifacts + four missing => only the four invalid
// tombstones are requeued, the valid ones stay, state queued.
if (RUN_SLOW_INTEGRATION) {
  const partialInvalid = hookCase('partial-invalid-terminal', [['SHEIN_BI_CORE_WARMUP_QUEUE_OWNED', '1']]);
  assert.equal(partialInvalid.scheduleReason, 'queued');
  assert.equal(partialInvalid.state, 'queued');
  assert.match(partialInvalid.lastError, /terminal verification failed/);
  assert.equal(partialInvalid.entriesAfter, 4, 'exactly the four invalid sections must be requeued');
  assert.equal(partialInvalid.completedAfter, 3, 'the three valid tombstones must stay');
  assert.equal(partialInvalid.sectionsGenerated, 3);
}

// Mixed completed tombstones + pending entries: queued, never done.
const partial = hookCase('partial-completed', [['SHEIN_BI_CORE_WARMUP_QUEUE_OWNED', '1']]);
assert.equal(partial.scheduleReason, 'queued');
assert.equal(partial.state, 'queued');
assert.equal(partial.owner, 'external-section-queue');
assert.equal(partial.entriesAfter, 4, 'the four pending entries stay enqueued alongside the three tombstones');
assert.equal(partial.sectionsGenerated, 0);

// Malformed manager output: visible failure, never queued/done.
const malformed = hookCase('malformed-output', [['SHEIN_BI_CORE_WARMUP_QUEUE_OWNED', '1']]);

// A fire-and-forget enqueue child that wedges must be terminated and the
// pending key released only after the child closes -- never by a blind
// timer that would let duplicate worker processes stack up behind a
// never-cleared pending entry.
const enqueueChildHung = hookCase('enqueue-child-hung', [
  ['SHEIN_BI_SECTION_ENQUEUE_CHILD_TIMEOUT_MS', '1500'],
  ['SHEIN_BI_SECTION_ENQUEUE_CHILD_KILL_GRACE_MS', '500'],
]);
assert.equal(enqueueChildHung.ok, true, 'the enqueue-child-hung hook case must pass');
assert.equal(enqueueChildHung.firstEnqueued, true, 'the force enqueue with a token must be accepted');
assert.equal(enqueueChildHung.pendingAfterFirst, 1, 'the in-process pending key must be reserved immediately');
assert.equal(enqueueChildHung.aliveSoonAfterSpawn, true, 'the enqueue child must be alive right after spawn');
assert.equal(enqueueChildHung.secondSameKeyNoop, true, 'a same-key re-enqueue while the child is alive must stay a deduped no-op');
assert.equal(enqueueChildHung.aliveWhilePending, true, 'the child must still be alive while the pending key is held');
assert.equal(enqueueChildHung.pendingWhileHung, 1, 'the pending key must NOT be released by a blind timer while the child is still alive');
assert.equal(enqueueChildHung.aliveAfterKill, false, 'the wedged child must be terminated, not left running');
assert.equal(enqueueChildHung.pendingAfterKill, 0, 'the pending key must only be released after the child actually closes');
assert.equal(enqueueChildHung.thirdWithNewToken, true, 'after release, a new run token must enqueue again');
assert.equal(enqueueChildHung.pendingAfterNewToken, 1, 'the new run token must reserve the pending slot again');
assert.equal(enqueueChildHung.newChildDifferent, true, 'a new child must actually be spawned for the new run token');
assert.equal(enqueueChildHung.aliveAfterSecondKill, false, 'the second wedged child must also be terminated');
assert.equal(enqueueChildHung.pendingAfterSecondKill, 0, 'the pending key must release after the second child closes');
assert.equal(malformed.scheduleReason, 'enqueue-failed');
assert.ok(malformed.lastError, 'the manager failure must be visible');
assert.equal(malformed.state, 'error', 'malformed output must remain visibly failed, never queued/done');

// Controlled mid-verification core flip: two validators pass, then the fake
// validator flips the core G1 -> G2.  The generation pin fails the later
// checks, the authoritative re-read sees G2, and the scheduler reports
// stale/superseded with ZERO queue or tombstone mutation -- never G1 done or
// G1 requeue.  The next tick handles G2.
if (RUN_SLOW_INTEGRATION) {
  const coreGenFlip = hookCase('core-gen-flip', [['SHEIN_BI_CORE_WARMUP_QUEUE_OWNED', '1']]);
  assert.equal(coreGenFlip.scheduleReason, 'core-generation-changed');
  assert.equal(coreGenFlip.state, 'stale', 'a flipped core must never claim G1 done/queued');
  assert.equal(coreGenFlip.stateGeneratedAt, 'G2', 'the state must adopt the latest generation');
  assert.equal(coreGenFlip.previousGeneratedAt, 'G1');
  assert.match(coreGenFlip.lastError, /core generation changed during terminal verification/);
  assert.equal(coreGenFlip.entriesAfter, 0, 'no G1 entries may be created by the requeue race');
  assert.equal(coreGenFlip.completedAfter, 7, 'all G1 tombstones must stay untouched');
  assert.equal(coreGenFlip.artifactsAfter, coreGenFlip.artifactsBefore, 'no artifact may be generated inline');
  assert.equal(coreGenFlip.nextReason, 'queued', 'the next tick must process G2');
  assert.equal(coreGenFlip.nextEntries, 7, 'G2 must enqueue its full warmup set');
  assert.ok(coreGenFlip.nextKeys.every(key => String(key).startsWith('core-warmup:G2::')),
    'G2 must enqueue under its own per-section idempotency keys');

  const requeueSuperseded = hookCase('requeue-superseded', [['SHEIN_BI_CORE_WARMUP_QUEUE_OWNED', '1']]);
  assert.equal(requeueSuperseded.scheduleReason, 'core-generation-superseded');
  assert.equal(requeueSuperseded.state, 'stale');
  assert.deepEqual(requeueSuperseded.supersededSections, ['profit']);
  assert.match(requeueSuperseded.lastError, /superseded by existing newer-generation entry/);
  assert.equal(requeueSuperseded.g2Key, 'core-warmup:G2::profit', 'the newer key must never be adopted');
  assert.equal(requeueSuperseded.g2ByteIdentical, true, 'the G2 entry must stay byte-identical');
  assert.equal(requeueSuperseded.completedAfter, 1, 'only the G1 profit tombstone is retained');
  assert.equal(requeueSuperseded.entriesAfter, 7, 'six G1 requeues plus the untouched G2 entry');
  assert.equal(requeueSuperseded.sectionsGenerated, 0);
}

// Real Portal integration ---------------------------------------------------

if (RUN_SLOW_INTEGRATION) {
  const onOwned = integrationCase({ownedEnv: 'set'});
  assert.equal(onOwned['/'], 200);
  assert.equal(onOwned['/index.html'], 200);
  assert.equal(onOwned['/%69ndex.html'], 200);
  assert.equal(onOwned.health.status, 'queued');
  assert.equal(onOwned.health.owner, 'external-section-queue');
  assert.equal(onOwned.health.generatedAt, 'G1');
  assert.equal(onOwned.health.lastError, '');
  assert.equal(onOwned.health.consecutiveFailures, 0);
  assert.equal(onOwned.health.nextAttemptAt, null);
  assert.equal(onOwned.health.lastFailureAt, null);
  assert.equal(onOwned.sectionsGenerated, 0);
  assert.equal(onOwned.sameAfterRepeat, true, 'repeated index hits must not add revisions');
  assert.equal(onOwned.queueHasWarmupSet, true, 'the complete warmup set must be queued');
  assert.deepEqual(onOwned.queuePriority, [WARMUP_PRIORITY]);
  assert.equal(onOwned.hasCoreWarmupReason, true);

  const onUnset = integrationCase({ownedEnv: 'unset'});
  assert.equal(onUnset['/'], 200);
  assert.notEqual(onUnset.health.status, 'queued');
  assert.equal(onUnset.health.owner, '');
}

const onContradiction = integrationCase({ownedEnv: 'set', externalOff: true});
assert.equal(onContradiction['/'], 200);
assert.match(onContradiction.health.lastError, /requires the managed external section queue/);
assert.equal(onContradiction.health.status, 'idle');
assert.equal(onContradiction.sectionsGenerated, 0);
assert.equal(onContradiction.queueHasWarmupSet, false);
assert.equal(onContradiction.shutdown.exitCode, 0);
assert.equal(onContradiction.shutdown.signalCode, null);
assert.equal(onContradiction.shutdown.shutdownStarted, true);
assert.equal(onContradiction.shutdown.shutdownCompleted, true);
assert.equal(onContradiction.shutdown.forcedConnections, false);
assert.ok(onContradiction.shutdown.wallMs < 8_000,
  `contradiction shutdown must finish below the test bound: ${JSON.stringify(onContradiction.shutdown)}`);

const starvationRecheck = integrationCase({ownedEnv: 'set', integrationCaseName: 'starvation-recheck'});
assert.deepEqual(starvationRecheck.httpStatuses, [202],
  `missing profit rechecks must stay pending, not masquerade as success: ${JSON.stringify(starvationRecheck)}`);
assert.equal(starvationRecheck.requestRevisionUnchanged, true,
  `high-frequency page rechecks must not supersede a long profit build: ${JSON.stringify(starvationRecheck)}`);
assert.equal(starvationRecheck.runningLeasePreserved, true,
  'same-generation rechecks must preserve the active lease and leave rerun=false');
assert.equal(starvationRecheck.completed, true,
  'the original worker revision must complete instead of falling into a supersede loop');
assert.equal(starvationRecheck.profitEntryRemoved, true);
assert.equal(starvationRecheck.completedKeyPresent, true,
  'final completion must retain the warmup-compatible durable tombstone');
assert.deepEqual(starvationRecheck.forceRevisions, {
  before: 1,
  tokenA: 2,
  tokenARepeat: 2,
  tokenB: 3,
  untokened: 3,
  untokenedRepeat: 3,
}, 'each force token may add at most one revision; untokened force refreshes are rejected and leave the revision untouched');
assert.equal(starvationRecheck.forceKeys.tokenA, starvationRecheck.forceKeys.tokenARepeat);
assert.notEqual(starvationRecheck.forceKeys.tokenA, starvationRecheck.forceKeys.tokenB);
// An untokened host-locked force refresh must be rejected with an explicit
// 400 instead of silently minting a per-generation key that the 30-day
// completed tombstone can swallow on the next business rerun.
assert.deepEqual(starvationRecheck.forceStatuses.untokened, [400], 'untokened force refresh must return 400');
assert.deepEqual(starvationRecheck.forceStatuses.untokenedRepeat, [400], 'a repeated untokened force refresh must return 400');
assert.ok(starvationRecheck.forceStatuses.tokenA.every(status => status === 202), 'tokenized force refresh must be accepted (202)');
assert.ok(starvationRecheck.forceStatuses.tokenARepeat.every(status => status === 202), 'a repeat of the same run token must be accepted (202, queue-side dedupe)');
assert.ok(starvationRecheck.forceStatuses.tokenB.every(status => status === 202), 'a distinct run token must be accepted (202, new revision)');
assert.equal(starvationRecheck.forceKeys.untokened, starvationRecheck.forceKeys.tokenB, 'a rejected untokened force must leave the queue entry key untouched');
assert.equal(starvationRecheck.forceKeys.untokenedRepeat, starvationRecheck.forceKeys.tokenB, 'a rejected untokened force must leave the queue entry key untouched');
assert.equal(starvationRecheck.forceRevisions.untokened, starvationRecheck.forceRevisions.tokenB, 'a rejected untokened force must leave the queue entry revision untouched');
assert.equal(starvationRecheck.forceRevisions.untokenedRepeat, starvationRecheck.forceRevisions.tokenB, 'a rejected untokened force must leave the queue entry revision untouched');
assert.equal(starvationRecheck.shutdown.exitCode, 0);
assert.equal(starvationRecheck.shutdown.shutdownCompleted, true);

// Portal restart with the SAME core + queue files: durable idempotency keeps
// the entries untouched (no revision change, no recreation).
if (RUN_SLOW_INTEGRATION) {
  const restartIdem = integrationCase({ownedEnv: 'set', integrationCaseName: 'restart-idem'});
  assert.equal(restartIdem.unchanged, true,
    `queue entries must be unchanged across Portal restart\nbefore=${JSON.stringify(restartIdem.before)}\nafter=${JSON.stringify(restartIdem.after)}`);
  assert.ok(restartIdem.after.length >= WARMUP_SECTIONS.length, 'the warmup set must remain enqueued');
  assert.ok(restartIdem.after.every(entry => entry.idempotencyKey.startsWith('core-warmup:G1::')), 'entries must keep their durable keys');
  assert.equal(restartIdem.sectionsGenerated, 0);

  // Running worker lease supersession across restart: same key is a no-op,
  // preserving the original lease and revision.
  const restartRunning = integrationCase({ownedEnv: 'set', integrationCaseName: 'restart-running'});
  assert.equal(restartRunning.revisionUnchanged, true,
    `running entry revision must be unchanged across restart\nbefore=${JSON.stringify(restartRunning.before)}\nafter=${JSON.stringify(restartRunning.after)}`);
  assert.equal(restartRunning.rerunFalse, true, 'no rerun may be set across restart');
  assert.equal(restartRunning.stillRunningWithLease, true, 'the entry must stay under its original lease');
  assert.equal(restartRunning.sectionsGenerated, 0);

  const restartDone = integrationCase({ownedEnv: 'set', integrationCaseName: 'restart-done'});
  assert.equal(restartDone.health.status, 'queued', 'tombstones without terminal artifacts must never report done');
  assert.equal(restartDone.health.owner, 'external-section-queue');
  assert.equal(restartDone.health.generatedAt, 'G1');
  assert.match(restartDone.health.lastError, /terminal verification failed/);
  assert.equal(restartDone.entriesAfter, 7, 'the invalid tombstones must be requeued after restart');
  assert.equal(restartDone.sectionsGenerated, 0);

  const restartDoneTerminal = integrationCase({ownedEnv: 'set', integrationCaseName: 'restart-done-terminal'});
  assert.equal(restartDoneTerminal.health.status, 'done');
  assert.equal(restartDoneTerminal.health.owner, 'external-section-queue');
  assert.equal(restartDoneTerminal.health.generatedAt, 'G1');
  assert.equal(restartDoneTerminal.health.inFlight, false);
  assert.equal(restartDoneTerminal.health.lastError, '');
  assert.equal(restartDoneTerminal.entriesAfter, 0);
  assert.equal(restartDoneTerminal.sectionsGenerated, 7);
}

console.log('bi_portal_core_warmup_queue_owned: queue-owned mode enqueues the full warmup set once per generation with durable per-section idempotency (no inline generation, health queued+owner, retry on failure, contradiction fails visible, restart-safe with running-lease supersession); env unset preserves legacy inline behavior; encoded index paths trigger identically');
console.log(JSON.stringify({ok: true, slowIntegration: RUN_SLOW_INTEGRATION}, null, 2));
