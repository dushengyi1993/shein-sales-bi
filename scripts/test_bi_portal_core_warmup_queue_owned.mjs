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
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WARMUP_SECTIONS = ['profit', 'homeRankings', 'homeProfit', 'afterSales', 'orders', 'homeTrafficDaily', 'priceScatter'];
const WARMUP_PRIORITY = 10;

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
      await apiCore('G1');
      process.env.SHEIN_BI_PORTAL_SECTION_QUEUE_LOCK_FILE = '/proc/shein-queue-test/queue.lock';
      const failed = await __testHooks.scheduleBiPortalCoreWarmup({}, sandbox, {allowGenerate: true});
      const stateAfterFail = __testHooks.biPortalCoreWarmupState.status;
      process.env.SHEIN_BI_PORTAL_SECTION_QUEUE_LOCK_FILE = lockFile;
      const retried = await __testHooks.scheduleBiPortalCoreWarmup({}, sandbox, {allowGenerate: true});
      const entriesAfterRetry = await queueEntries();
      report = {
        ok: true,
        caseName,
        failedReason: failed.reason,
        failedError: failed.error || '',
        stateAfterFail,
        retriedReason: retried.reason,
        stateAfterRetry: __testHooks.biPortalCoreWarmupState.status,
        lastErrorAfterRetry: __testHooks.biPortalCoreWarmupState.lastError || '',
        retryEntries: entriesAfterRetry.map(entry => entry.section).sort(),
        sectionsGenerated: await sectionsGenerated(),
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
  const temp = await fs.mkdtemp('/tmp/portal-warmup-queue-owned-');
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
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`portal exited before startup: ${stderr}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (response.status === 200) return {child, port, stderr: () => stderr};
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`portal startup timed out: ${stderr}`);
  };
  const stopPortal = async handle => {
    if (handle.child.exitCode === null && handle.child.signalCode === null) {
      handle.child.kill('SIGTERM');
      await new Promise(resolve => handle.child.on('close', resolve));
    }
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
  const caseName = String(process.env.BI_PORTAL_WARMUP_INTEGRATION_CASE || '');
  const report = {ok: true, caseName};
  try {
    if (caseName === 'restart-idem') {
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
      } finally {
        await stopPortal(handle);
      }
    }
  } finally {
    await fs.rm(temp, {recursive: true, force: true});
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

assert.match(source, /SHEIN_BI_CORE_WARMUP_QUEUE_OWNED \|\| ''\)\.trim\(\)\.toLowerCase\(\)/,
  'the ownership env must be read, trimmed and lowercased');
assert.match(source, /\[\'1\', \'true\', \'yes\', \'on\'\]\.includes\(raw\)\) return true;/,
  'explicit true values must enable queue ownership');
assert.match(source,
  /const sections = configuredBiPortalCoreWarmupSections\(\);[\s\S]*if \(BI_CORE_WARMUP_QUEUE_OWNED\) \{[\s\S]*const warmupIdempotencyKey = `core-warmup:\$\{generatedAt\}`;[\s\S]*persistHostLockedBiSectionPlan\(plan, generatedAt, \{\s*reason: `core-warmup-\$\{generatedAt\}`,\s*idempotencyKey: warmupIdempotencyKey,/,
  'queue-owned scheduling must enqueue with the deterministic core-warmup idempotency key');
assert.match(source, /if \(biPortalCoreWarmupState\.status === 'queued' && biPortalCoreWarmupState\.generatedAt === generatedAt\) \{[\s\S]*reason: 'already-queued'/,
  'the same generation must be enqueued exactly once in-process');
assert.match(source, /reason: 'queue-owned-without-external-queue'/,
  'queue-owned without the external queue must fail visibly');
assert.match(source,
  /const allCompleted = completedCount === requestedCount && activeCount === 0;[\s\S]*biPortalCoreWarmupState\.owner = 'external-section-queue';[\s\S]*if \(allCompleted\) \{[\s\S]*verifyWarmupSectionsTerminal\(root, sections, generatedAt\)/,
  'health state must record queued (or done) with the external queue owner');
assert.match(source, /owner: biPortalCoreWarmupState\.owner \|\| ''/,
  '/api/health must expose the queue owner');
assert.doesNotMatch(source, /systemctl|biCoreWarmupDeferUnitActive|deferredReason|deferUnit|SHEIN_BI_CORE_WARMUP_DEFER_WHILE_UNIT_ACTIVE/,
  'no coordinator-unit probe or defer state may remain');
assert.match(source,
  /let biIndexPath = url\.pathname;[\s\S]*decodeURIComponent\(url\.pathname\)[\s\S]*biIndexPath === '\/' \|\| biIndexPath === '\/index\.html'/,
  'the normalized encoded index trigger must be preserved');
assert.match(source, /\['--idempotency-key', idempotencyKey\]/,
  'persistHostLockedBiSectionPlan must pass the idempotency key to the enqueue script');
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
assert.match(manage, /outcome\.supersededByExisting\.push\(section\);[\s\S]*continue;/,
  'a requeue colliding with a different-key existing entry must be a strict no-op');

// ---------------------------------------------------------------------------
// Child harness (WSL stdin mode; Windows->WSL spawn env is unreliable).
// ---------------------------------------------------------------------------
function runBash(script, {timeoutMs = 150_000} = {}) {
  const result = spawnSync('bash', ['-s'], {
    cwd: ROOT,
    input: script,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `bash child failed\nscript:\n${script}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
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

const retry = hookCase('enqueue-fail-retry', [['SHEIN_BI_CORE_WARMUP_QUEUE_OWNED', '1']]);
assert.equal(retry.failedReason, 'enqueue-failed');
assert.ok(retry.failedError, 'the enqueue error must be visible');
assert.equal(retry.stateAfterFail, 'idle', 'a failed enqueue must not claim queued');
assert.equal(retry.retriedReason, 'queued', 'the next tick must retry and succeed');
assert.equal(retry.stateAfterRetry, 'queued');
assert.equal(retry.lastErrorAfterRetry, '', 'the error must clear after success');
assert.deepEqual(retry.retryEntries, WARMUP_SECTIONS.slice().sort());
assert.equal(retry.sectionsGenerated, 0);

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
const allCompleted = hookCase('all-completed', [['SHEIN_BI_CORE_WARMUP_QUEUE_OWNED', '1']]);
assert.equal(allCompleted.scheduleReason, 'queued');
assert.equal(allCompleted.state, 'queued', 'missing terminal artifacts must never claim done');
assert.equal(allCompleted.owner, 'external-section-queue');
assert.equal(allCompleted.generatedAt, 'G1');
assert.match(allCompleted.lastError, /terminal verification failed/);
assert.equal(allCompleted.entriesAfter, 7, 'all invalid tombstones must be requeued as fresh entries');
assert.equal(allCompleted.completedAfter, 0, 'all seven invalid tombstones must be removed');
assert.equal(allCompleted.sectionsGenerated, 0);

// All tombstones AND all real terminal current-generation artifacts: done.
const allCompletedTerminal = hookCase('all-completed-terminal', [['SHEIN_BI_CORE_WARMUP_QUEUE_OWNED', '1']]);
assert.equal(allCompletedTerminal.scheduleReason, 'already-completed');
assert.equal(allCompletedTerminal.state, 'done');
assert.equal(allCompletedTerminal.owner, 'external-section-queue');
assert.equal(allCompletedTerminal.generatedAt, 'G1');
assert.equal(allCompletedTerminal.inFlight, false);
assert.equal(allCompletedTerminal.lastError, '');
assert.equal(allCompletedTerminal.entriesAfter, 0, 'terminal tombstones must not recreate entries');
assert.equal(allCompletedTerminal.sectionsGenerated, 7, 'the real terminal artifacts are present');

// Mixed: three valid artifacts + four missing => only the four invalid
// tombstones are requeued, the valid ones stay, state queued.
const partialInvalid = hookCase('partial-invalid-terminal', [['SHEIN_BI_CORE_WARMUP_QUEUE_OWNED', '1']]);
assert.equal(partialInvalid.scheduleReason, 'queued');
assert.equal(partialInvalid.state, 'queued');
assert.match(partialInvalid.lastError, /terminal verification failed/);
assert.equal(partialInvalid.entriesAfter, 4, 'exactly the four invalid sections must be requeued');
assert.equal(partialInvalid.completedAfter, 3, 'the three valid tombstones must stay');
assert.equal(partialInvalid.sectionsGenerated, 3);

// Mixed completed tombstones + pending entries: queued, never done.
const partial = hookCase('partial-completed', [['SHEIN_BI_CORE_WARMUP_QUEUE_OWNED', '1']]);
assert.equal(partial.scheduleReason, 'queued');
assert.equal(partial.state, 'queued');
assert.equal(partial.owner, 'external-section-queue');
assert.equal(partial.entriesAfter, 4, 'the four pending entries stay enqueued alongside the three tombstones');
assert.equal(partial.sectionsGenerated, 0);

// Malformed manager output: visible failure, never queued/done.
const malformed = hookCase('malformed-output', [['SHEIN_BI_CORE_WARMUP_QUEUE_OWNED', '1']]);
assert.equal(malformed.scheduleReason, 'enqueue-failed');
assert.ok(malformed.lastError, 'the manager failure must be visible');
assert.equal(malformed.state, 'idle', 'malformed output must never claim queued/done');

// Controlled mid-verification core flip: two validators pass, then the fake
// validator flips the core G1 -> G2.  The generation pin fails the later
// checks, the authoritative re-read sees G2, and the scheduler reports
// stale/superseded with ZERO queue or tombstone mutation -- never G1 done or
// G1 requeue.  The next tick handles G2.
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

// Manager requeue conflict: G1 tombstone + existing G2 entry on the same
// section makes the G1 requeue a strict no-op classified supersededByExisting;
// the G2 entry stays byte-identical and the G1 tombstone is retained.  The
// core scheduler re-reads and reports stale/superseded, never G1 queued/done.
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

// Real Portal integration ---------------------------------------------------

const onOwned = integrationCase({ownedEnv: 'set'});
assert.equal(onOwned['/'], 200);
assert.equal(onOwned['/index.html'], 200);
assert.equal(onOwned['/%69ndex.html'], 200);
assert.equal(onOwned.health.status, 'queued');
assert.equal(onOwned.health.owner, 'external-section-queue');
assert.equal(onOwned.health.generatedAt, 'G1');
assert.equal(onOwned.health.lastError, '');
assert.equal(onOwned.sectionsGenerated, 0);
assert.equal(onOwned.sameAfterRepeat, true, 'repeated index hits must not add revisions');
assert.equal(onOwned.queueHasWarmupSet, true, 'the complete warmup set must be queued');
assert.deepEqual(onOwned.queuePriority, [WARMUP_PRIORITY]);
assert.equal(onOwned.hasCoreWarmupReason, true);

const onUnset = integrationCase({ownedEnv: 'unset'});
assert.equal(onUnset['/'], 200);
assert.notEqual(onUnset.health.status, 'queued');
assert.equal(onUnset.health.owner, '');

const onContradiction = integrationCase({ownedEnv: 'set', externalOff: true});
assert.equal(onContradiction['/'], 200);
assert.match(onContradiction.health.lastError, /requires the managed external section queue/);
assert.equal(onContradiction.health.status, 'idle');
assert.equal(onContradiction.sectionsGenerated, 0);
assert.equal(onContradiction.queueHasWarmupSet, false);

// Portal restart with the SAME core + queue files: durable idempotency keeps
// the entries untouched (no revision change, no recreation).
const restartIdem = integrationCase({ownedEnv: 'set', integrationCaseName: 'restart-idem'});
assert.equal(restartIdem.unchanged, true,
  `queue entries must be unchanged across Portal restart\nbefore=${JSON.stringify(restartIdem.before)}\nafter=${JSON.stringify(restartIdem.after)}`);
assert.ok(restartIdem.after.length >= WARMUP_SECTIONS.length, 'the warmup set must remain enqueued');
assert.ok(restartIdem.after.every(entry => entry.idempotencyKey.startsWith('core-warmup:G1::')), 'entries must keep their durable keys');
assert.equal(restartIdem.sectionsGenerated, 0);

// Running worker lease supersession across restart: same key is a no-op, the
// entry stays running under its original lease with the same revision.
const restartRunning = integrationCase({ownedEnv: 'set', integrationCaseName: 'restart-running'});
assert.equal(restartRunning.revisionUnchanged, true,
  `running entry revision must be unchanged across restart\nbefore=${JSON.stringify(restartRunning.before)}\nafter=${JSON.stringify(restartRunning.after)}`);
assert.equal(restartRunning.rerunFalse, true, 'no rerun may be set across restart');
assert.equal(restartRunning.stillRunningWithLease, true, 'the entry must stay under its original lease');
assert.equal(restartRunning.sectionsGenerated, 0);

// All seven sections completed but NO terminal artifacts, then a fresh Portal
// restart: health reports queued with seven requeued entries.
const restartDone = integrationCase({ownedEnv: 'set', integrationCaseName: 'restart-done'});
assert.equal(restartDone.health.status, 'queued', 'tombstones without terminal artifacts must never report done');
assert.equal(restartDone.health.owner, 'external-section-queue');
assert.equal(restartDone.health.generatedAt, 'G1');
assert.match(restartDone.health.lastError, /terminal verification failed/);
assert.equal(restartDone.entriesAfter, 7, 'the invalid tombstones must be requeued after restart');
assert.equal(restartDone.sectionsGenerated, 0);

// All seven sections completed WITH real terminal artifacts, then a fresh
// Portal restart: authoritative verification passes => truthful done.
const restartDoneTerminal = integrationCase({ownedEnv: 'set', integrationCaseName: 'restart-done-terminal'});
assert.equal(restartDoneTerminal.health.status, 'done');
assert.equal(restartDoneTerminal.health.owner, 'external-section-queue');
assert.equal(restartDoneTerminal.health.generatedAt, 'G1');
assert.equal(restartDoneTerminal.health.inFlight, false);
assert.equal(restartDoneTerminal.health.lastError, '');
assert.equal(restartDoneTerminal.entriesAfter, 0);
assert.equal(restartDoneTerminal.sectionsGenerated, 7);

console.log('bi_portal_core_warmup_queue_owned: queue-owned mode enqueues the full warmup set once per generation with durable per-section idempotency (no inline generation, health queued+owner, retry on failure, contradiction fails visible, restart-safe with running-lease supersession); env unset preserves legacy inline behavior; encoded index paths trigger identically');
console.log(JSON.stringify({ok: true}, null, 2));
