#!/usr/bin/env node

/**
 * Deterministic report-scope contract for cloud_shein_session_manager.mjs.
 *
 * Regression: a single-store/partial invocation on 2026-08-16 overwrote
 * outputs/reports/cloud-session-manager-latest.json, replacing the prior
 * all-enabled-store evidence with partial coverage.
 *
 * Guarded invariants (no cloud, no browser, no SHEIN access):
 *  - every invocation keeps its timestamped report;
 *  - only an invocation whose covered store set exactly equals the current
 *    enabled-store set (unique, no missing, no extra) may atomically replace
 *    the canonical cloud-session-manager-latest.json/.md;
 *  - duplicate, extra (unknown/disabled) and empty selections are rejected
 *    before any probe, with no artifact written;
 *  - a missing-store (subset) run is a partial run: it writes explicit
 *    partial-scoped latest + timestamp artifacts and can never overwrite the
 *    canonical latest evidence; its artifacts fail any all-store
 *    strong-evidence predicate.
 *
 * Run directly:  node scripts/test_cloud_session_manager_latest_scope.mjs
 */

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodeBin = process.execPath;
const realReportDir = path.join(root, 'outputs', 'reports');
let passed = 0;

function ok(label) {
  passed += 1;
  console.log(`PASS ${label}`);
}

function listSessionArtifacts(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(name => name.startsWith('cloud-session-manager'))
    .sort();
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// The production enabled-store fixture.  The current config enables all 19
// stores; keeping the fixture explicit makes this test deterministic even if
// the config drifts.
const ENABLED = [
  'DL', 'DX', 'FY', 'LQ', 'NM', 'HL', 'JY', 'ZL', 'TS', 'MZ',
  'CX', 'YJ', 'XL', 'QY', 'QH', 'TZ', 'JSH', 'TZZ', 'XC',
];

function strongEvidencePredicate(report) {
  return report?.scope?.kind === 'all-enabled'
    && report.canonicalLatestUpdated === true
    && report.scope.canonicalLatestAllowed === true
    && report.scope.missingStoreKeys.length === 0
    && report.scope.extraStoreKeys.length === 0
    && report.scope.duplicateStoreKeys.length === 0
    && report.scope.coveredStoreKeys.length === report.scope.expectedStoreKeys.length;
}

function makeScopeReport({enabledStoreKeys, coveredStoreKeys, ok: reportOk = true} = {}) {
  const scope = mod.classifyStoreScope({enabledStoreKeys, coveredStoreKeys});
  return {
    ok: reportOk,
    generatedAt: new Date().toISOString(),
    date: '2026-08-16',
    mode: 'check',
    scope,
    canonicalLatestUpdated: scope.canonicalLatestAllowed,
    summary: {
      totalStores: scope.coveredStoreKeys.length,
      okStores: reportOk ? scope.coveredStoreKeys.length : 0,
      failedStores: reportOk ? [] : scope.coveredStoreKeys,
      profilesTotalBytes: 0,
      profilesTotalHuman: '0 B',
    },
    issues: reportOk ? [] : ['fixture failure'],
    warnings: [],
    results: scope.coveredStoreKeys.map(storeKey => ({
      storeKey,
      groupKey: 'TEST',
      shopName: storeKey,
      port: 1,
      ok: reportOk,
      mode: 'check',
      warnings: reportOk ? [] : ['fixture_row_failed'],
      profile: {
        path: `profiles/persistent-${storeKey.toLowerCase()}-profile`,
        sizeBytesBefore: 0,
        sizeBefore: '0 B',
        sizeBytesAfter: 0,
        sizeAfter: '0 B',
        cleanup: [],
      },
      sessions: {
        browser: {exists: true, sizeBytes: 0, updatedAt: null},
        webapi: {exists: true, sizeBytes: 0, updatedAt: null},
      },
      probe: {ok: reportOk, failedStores: [], reportFile: '', date: '2026-08-16'},
      exportSession: reportOk ? {stores: [{storeKey, webApiProbe: {ok: true}}]} : null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Importing the module must not execute main() (no report writes).
// ---------------------------------------------------------------------------

const before = listSessionArtifacts(realReportDir);
const mod = await import('./cloud_shein_session_manager.mjs');
const after = listSessionArtifacts(realReportDir);
assert.deepEqual(after, before,
  'importing cloud_shein_session_manager.mjs must not run main() or write reports');
ok('importing the manager module has no side effects (main() is direct-run gated)');

const {
  normalizeStoreKeyList,
  classifyStoreScope,
  assertSelectionWithinEnabled,
  writeSessionManagerArtifacts,
} = mod;

// ---------------------------------------------------------------------------
// normalizeStoreKeyList
// ---------------------------------------------------------------------------

{
  const got = normalizeStoreKeyList([' jsh ', 'JSH', 'DL', 'dl', '', '  ']);
  assert.deepEqual(got.unique, ['JSH', 'DL']);
  assert.deepEqual(got.duplicates, ['JSH', 'DL']);
  assert.deepEqual(normalizeStoreKeyList([]), {unique: [], duplicates: []});
  assert.deepEqual(normalizeStoreKeyList(null), {unique: [], duplicates: []});
  ok('normalizeStoreKeyList trims/case-folds/dedupes and reports duplicates');
}

// ---------------------------------------------------------------------------
// classifyStoreScope: exact enabled-set guard
// ---------------------------------------------------------------------------

{
  const shuffledMixedCase = ['XC', 'dl', 'TZZ', 'JSH', 'TZ', 'QH', 'QY', 'XL', 'YJ', 'CX', 'MZ', 'TS', 'ZL', 'JY', 'HL', 'NM', 'LQ', 'FY', 'DX'];
  const scope = classifyStoreScope({enabledStoreKeys: ENABLED, coveredStoreKeys: shuffledMixedCase});
  assert.equal(scope.kind, 'all-enabled');
  assert.equal(scope.canonicalLatestAllowed, true);
  assert.deepEqual(scope.missingStoreKeys, []);
  assert.deepEqual(scope.extraStoreKeys, []);
  assert.deepEqual(scope.duplicateStoreKeys, []);
  assert.deepEqual([...scope.coveredStoreKeys].sort(), [...ENABLED].sort());
  ok('classifyStoreScope: exact all-enabled set (any order/case) is all-enabled');
}

{
  const missing = classifyStoreScope({enabledStoreKeys: ENABLED, coveredStoreKeys: ENABLED.filter(k => k !== 'XC')});
  assert.equal(missing.kind, 'partial');
  assert.equal(missing.canonicalLatestAllowed, false);
  assert.deepEqual(missing.missingStoreKeys, ['XC']);
  assert.deepEqual(missing.extraStoreKeys, []);
  ok('classifyStoreScope: a missing enabled store is partial, never canonical');
}

{
  const extra = classifyStoreScope({enabledStoreKeys: ENABLED, coveredStoreKeys: [...ENABLED, 'ZZZ']});
  assert.equal(extra.kind, 'partial');
  assert.equal(extra.canonicalLatestAllowed, false);
  assert.deepEqual(extra.extraStoreKeys, ['ZZZ']);
  assert.deepEqual(extra.missingStoreKeys, []);
  ok('classifyStoreScope: an extra non-enabled store is partial, never canonical');
}

{
  const duplicated = classifyStoreScope({enabledStoreKeys: ENABLED, coveredStoreKeys: ['DL', 'DL', ...ENABLED.filter(k => k !== 'DL')]});
  assert.equal(duplicated.kind, 'partial');
  assert.equal(duplicated.canonicalLatestAllowed, false);
  assert.deepEqual(duplicated.duplicateStoreKeys, ['DL']);
  ok('classifyStoreScope: duplicate covered rows are rejected from the canonical path');
}

{
  const single = classifyStoreScope({enabledStoreKeys: ENABLED, coveredStoreKeys: ['DL']});
  assert.equal(single.kind, 'partial');
  assert.equal(single.canonicalLatestAllowed, false);
  assert.equal(single.missingStoreKeys.length, ENABLED.length - 1);
  ok('classifyStoreScope: a single-store run is partial with the full missing list');
}

{
  const emptyEnabled = classifyStoreScope({enabledStoreKeys: [], coveredStoreKeys: []});
  assert.equal(emptyEnabled.kind, 'partial');
  assert.equal(emptyEnabled.canonicalLatestAllowed, false, 'an empty enabled set must fail closed');
  ok('classifyStoreScope: empty enabled-store config fails closed');
}

{
  const emptyCovered = classifyStoreScope({enabledStoreKeys: ENABLED, coveredStoreKeys: []});
  assert.equal(emptyCovered.kind, 'partial');
  assert.equal(emptyCovered.canonicalLatestAllowed, false);
  assert.deepEqual(emptyCovered.missingStoreKeys, ENABLED);
  ok('classifyStoreScope: zero covered stores is partial with every store missing');
}

// ---------------------------------------------------------------------------
// assertSelectionWithinEnabled: duplicate / extra / missing selections
// ---------------------------------------------------------------------------

{
  const selected = assertSelectionWithinEnabled({selectedStoreKeys: ['dl', 'DX'], enabledStoreKeys: ENABLED});
  assert.deepEqual(selected, ['DL', 'DX']);
  ok('assertSelectionWithinEnabled accepts a valid in-scope selection');
}

{
  assert.throws(
    () => assertSelectionWithinEnabled({selectedStoreKeys: ['JSH', 'JSH'], enabledStoreKeys: ENABLED}),
    /Duplicate store selection rejected: JSH/,
  );
  ok('assertSelectionWithinEnabled rejects duplicate selections');
}

{
  assert.throws(
    () => assertSelectionWithinEnabled({selectedStoreKeys: ['DL', 'ZZZ'], enabledStoreKeys: ENABLED}),
    /Unknown or disabled store selection rejected: ZZZ/,
  );
  ok('assertSelectionWithinEnabled rejects extra (unknown/disabled) selections');
}

{
  assert.throws(
    () => assertSelectionWithinEnabled({selectedStoreKeys: [], enabledStoreKeys: ENABLED}),
    /Empty store selection/,
  );
  ok('assertSelectionWithinEnabled rejects empty selections');
}

// ---------------------------------------------------------------------------
// writeSessionManagerArtifacts: canonical vs partial artifact semantics
// ---------------------------------------------------------------------------

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'session-manager-scope-'));
try {
  const dir = path.join(sandbox, 'reports');
  const logDir = path.join(sandbox, 'logs');
  fs.mkdirSync(dir, {recursive: true});
  const canonicalJson = path.join(dir, 'cloud-session-manager-latest.json');
  const canonicalMd = path.join(dir, 'cloud-session-manager-latest.md');
  const fullName = '20260816-010203';
  const partialName = '20260816-020304';
  const secondFullName = '20260816-030405';

  // Seed canonical latest with old all-store evidence (the state a partial run
  // must never clobber).
  fs.writeFileSync(canonicalJson, JSON.stringify({sentinel: 'old-full-evidence'}), 'utf8');
  fs.writeFileSync(canonicalMd, '# old full evidence');

  // Full-set run: atomically replaces the canonical latest.
  const fullReport = makeScopeReport({enabledStoreKeys: ENABLED, coveredStoreKeys: ENABLED});
  const fullOut = await writeSessionManagerArtifacts({
    reportDir: dir, logDir, name: fullName, report: fullReport,
  });
  assert.equal(fullOut.partial, false);
  assert.equal(fullOut.canonicalLatestUpdated, true);
  assert.match(fullOut.reportFile, /cloud-session-manager-20260816-010203\.json$/);
  assert.match(fullOut.latestJson, /cloud-session-manager-latest\.json$/);
  assert.match(fullOut.latestMd, /cloud-session-manager-latest\.md$/);
  const canonical = readJson(canonicalJson);
  assert.equal(canonical.sentinel, undefined, 'canonical latest must be replaced, not appended');
  assert.equal(strongEvidencePredicate(canonical), true);
  assert.ok(fs.existsSync(canonicalMd));
  assert.ok(fs.existsSync(path.join(dir, 'cloud-session-manager-20260816-010203.json')));
  assert.ok(fs.existsSync(path.join(logDir, 'cloud-session-manager-20260816-010203.json')));
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.includes('.tmp-')), [],
    'no atomic-write temp files may be left behind');
  ok('full-set run atomically replaces canonical latest with all-enabled scope');

  // Partial run: canonical latest must be untouched; explicit partial-scoped
  // latest + timestamp artifacts must be written and must fail the
  // strong-evidence predicate.
  const partialReport = makeScopeReport({enabledStoreKeys: ENABLED, coveredStoreKeys: ['DL']});
  const partialOut = await writeSessionManagerArtifacts({
    reportDir: dir, logDir, name: partialName, report: partialReport,
  });
  assert.equal(partialOut.partial, true);
  assert.equal(partialOut.canonicalLatestUpdated, false);
  assert.match(partialOut.reportFile, /cloud-session-manager-partial-20260816-020304\.json$/);
  assert.match(partialOut.latestJson, /cloud-session-manager-latest-partial\.json$/);
  assert.match(partialOut.latestMd, /cloud-session-manager-latest-partial\.md$/);
  assert.equal(readJson(canonicalJson).scope.kind, 'all-enabled',
    'partial run must not overwrite canonical latest');
  assert.equal(strongEvidencePredicate(readJson(canonicalJson)), true,
    'canonical latest must still hold full-store evidence after a partial run');
  const partialLatest = readJson(path.join(dir, 'cloud-session-manager-latest-partial.json'));
  assert.equal(partialLatest.scope.kind, 'partial');
  assert.equal(partialLatest.scope.canonicalLatestAllowed, false);
  assert.equal(partialLatest.canonicalLatestUpdated, false);
  assert.deepEqual(partialLatest.scope.coveredStoreKeys, ['DL']);
  assert.deepEqual(partialLatest.scope.missingStoreKeys, ENABLED.filter(k => k !== 'DL'));
  assert.equal(strongEvidencePredicate(partialLatest), false,
    'a partial artifact must never satisfy the all-store strong-evidence check');
  assert.ok(fs.existsSync(path.join(dir, 'cloud-session-manager-latest-partial.md')));
  const partialTimestamped = readJson(path.join(dir, 'cloud-session-manager-partial-20260816-020304.json'));
  assert.equal(partialTimestamped.scope.kind, 'partial');
  assert.equal(partialTimestamped.canonicalLatestUpdated, false);
  assert.ok(fs.existsSync(path.join(logDir, 'cloud-session-manager-partial-20260816-020304.json')));
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.includes('.tmp-')), []);
  ok('partial run writes explicit partial-scoped latest + timestamp artifacts and cannot overwrite canonical latest');

  // A second full-set run replaces the canonical latest again atomically.
  const secondFull = makeScopeReport({enabledStoreKeys: ENABLED, coveredStoreKeys: [...ENABLED].reverse()});
  await writeSessionManagerArtifacts({
    reportDir: dir, logDir, name: secondFullName, report: secondFull,
  });
  assert.equal(readJson(canonicalJson).generatedAt, secondFull.generatedAt);
  assert.equal(readJson(canonicalJson).scope.kind, 'all-enabled');
  assert.equal(strongEvidencePredicate(readJson(canonicalJson)), true);
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.includes('.tmp-')), []);
  ok('a later full-set run atomically replaces canonical latest again');

  // Every invocation retains its timestamped report.
  const retained = listSessionArtifacts(dir);
  for (const expected of [
    'cloud-session-manager-20260816-010203.json',
    'cloud-session-manager-20260816-030405.json',
    'cloud-session-manager-partial-20260816-020304.json',
    'cloud-session-manager-latest.json',
    'cloud-session-manager-latest.md',
    'cloud-session-manager-latest-partial.json',
    'cloud-session-manager-latest-partial.md',
  ]) {
    assert.ok(retained.includes(expected), `expected artifact ${expected} to be retained`);
  }
  ok('all timestamped reports (full and partial) are retained and auditable');
} finally {
  fs.rmSync(sandbox, {recursive: true, force: true});
}

// ---------------------------------------------------------------------------
// CLI level: duplicate / extra / explicitly empty selections fail before any
// probe and write no artifacts.
// ---------------------------------------------------------------------------

{
  const rejectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-manager-reject-'));
  try {
    const cases = [
      {label: 'duplicate selection', args: ['--stores', 'JSH,JSH']},
      {label: 'extra (unknown) selection', args: ['--stores', 'DL,ZZZ']},
      {label: 'explicit empty selection', args: ['--stores', '']},
    ];
    for (const c of cases) {
      const result = spawnSync(nodeBin, [
        path.join(root, 'scripts', 'cloud_shein_session_manager.mjs'),
        '--restore=false',
        '--report-dir', rejectDir,
        '--log-dir', path.join(rejectDir, 'logs'),
        ...c.args,
      ], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
      });
      assert.equal(result.error, undefined, `CLI ${c.label} spawn failed: ${result.error}`);
      assert.notEqual(result.status, 0, `CLI ${c.label} must exit non-zero`);
      assert.deepEqual(listSessionArtifacts(rejectDir), [],
        `CLI ${c.label} must write no report artifacts`);
      ok(`CLI rejects ${c.label} before probing with no artifact written`);
    }
  } finally {
    fs.rmSync(rejectDir, {recursive: true, force: true});
  }
}

// ---------------------------------------------------------------------------
// Source wiring: main() must classify scope and route artifact writes through
// the guarded path (protects against accidental re-wiring regressions).
// ---------------------------------------------------------------------------

{
  const source = fs.readFileSync(new URL('./cloud_shein_session_manager.mjs', import.meta.url), 'utf8');
  assert.match(source, /const scope = classifyStoreScope\(\{/);
  assert.match(source, /coveredStoreKeys: results\.map/);
  assert.match(source, /scope,\s*\n\s*canonicalLatestUpdated: scope\.canonicalLatestAllowed/);
  assert.match(source, /writeSessionManagerArtifacts\(\{/);
  assert.match(source, /const isPartial = report\?\.scope\?\.canonicalLatestAllowed !== true/);
  assert.match(source, /cloud-session-manager-latest-partial/);
  assert.match(source, /fileURLToPath\(import\.meta\.url\) === path\.resolve\(process\.argv\[1\]\)/);
  ok('manager source wires classifyStoreScope + writeSessionManagerArtifacts with a direct-run gate');
}

console.log(JSON.stringify({ok: true, passed}, null, 2));
