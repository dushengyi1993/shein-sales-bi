#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

import {validateTerminalArtifact} from './check_bi_portal_section_terminal.mjs';
import {publishBiProfitBundleManifest, writeBiSectionArtifact, writeBiSectionCache} from '../lib/bi_section_cache.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generatedAt = '2026-08-11T08:36:30.27274+08:00';

async function makePortal(dir, {core = true, section, sectionGeneratedAt = generatedAt, extra = {}} = {}) {
  fs.mkdirSync(path.join(dir, 'sections'), {recursive: true});
  if (core) {
    fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({
      generatedAt,
      __sections: {mode: 'api', generatedAt},
    }));
  }
  if (section) {
    const run = {code: 0, timedOut: false, stderr: ''};
    if (['profit', 'homeProfit'].includes(section) && sectionGeneratedAt === generatedAt) {
      const profitData = section === 'profit'
        ? (extra.data ?? {})
        : {profit: {dailyStoreProducts: []}};
      await writeBiSectionCache(dir, 'profit', generatedAt, profitData, run, {requireIntegrity: true});
      await writeBiSectionArtifact(dir, 'profit.query', 'profit.query', generatedAt, profitData, run, {requireIntegrity: true});
      const homeProfitData = section === 'homeProfit'
        ? (extra.data ?? {})
        : {homeProfitSummary: {dailyScopes: [], source: 'profit_section_cache', sourceGeneratedAt: generatedAt, staleSource: false}};
      await writeBiSectionCache(dir, 'homeProfit', generatedAt, homeProfitData, run, {requireIntegrity: true});
      await publishBiProfitBundleManifest(dir, generatedAt);
      return;
    }
    await writeBiSectionCache(dir, section, sectionGeneratedAt, extra.data ?? {}, run, {requireIntegrity: true});
  }
}

// ---- Validator: current generation passes for ordinary, profit, homeProfit.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-terminal-current-'));
  try {
    await makePortal(dir, {section: 'orders', extra: {data: {rows: []}}});
    const result = await validateTerminalArtifact({root: dir, section: 'orders'});
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.coreGeneratedAt, generatedAt);
    assert.equal(result.sectionGeneratedAt, generatedAt);

    await makePortal(dir, {section: 'profit', extra: {data: {profit: {dailyStoreProducts: []}}}});
    assert.equal((await validateTerminalArtifact({root: dir, section: 'profit'})).ok, true, 'profit with dailyStoreProducts must be terminal');

    await makePortal(dir, {
      section: 'homeProfit',
      extra: {data: {homeProfitSummary: {dailyScopes: [], source: 'profit_section_cache', sourceGeneratedAt: generatedAt, staleSource: false}}},
    });
    assert.equal((await validateTerminalArtifact({root: dir, section: 'homeProfit'})).ok, true, 'fresh homeProfit must be terminal');

    const ordersFile = path.join(dir, 'sections', 'orders.json');
    const ordersRaw = fs.readFileSync(ordersFile);
    fs.writeFileSync(ordersFile, ordersRaw.subarray(0, Math.max(1, ordersRaw.length - 8)));
    const truncated = await validateTerminalArtifact({root: dir, section: 'orders'});
    assert.equal(truncated.ok, false, 'a truncated file with a valid metadata head must fail strict integrity');
    assert.equal(truncated.reason, 'section_integrity_unverified');
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

// ---- Validator: stale generation is never terminal.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-terminal-stale-'));
  try {
    await makePortal(dir, {section: 'orders', sectionGeneratedAt: '2026-08-10T08:36:30.27274+08:00'});
    const result = await validateTerminalArtifact({root: dir, section: 'orders'});
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'section_generated_at_mismatch');
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

// ---- Validator: --expected-generated-at pins the exact core generation.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-terminal-expected-'));
  const otherGeneration = '2026-08-10T00:00:00.000Z';
  try {
    await makePortal(dir, {section: 'orders'});
    const exact = await validateTerminalArtifact({
      root: dir,
      section: 'orders',
      expectedGeneratedAt: generatedAt,
    });
    assert.equal(exact.ok, true, JSON.stringify(exact));
    assert.equal(exact.expectedGeneratedAt, generatedAt, 'the report must carry the expected generation');

    const mismatch = await validateTerminalArtifact({
      root: dir,
      section: 'orders',
      expectedGeneratedAt: otherGeneration,
    });
    assert.equal(mismatch.ok, false, 'a different expected generation must never be terminal');
    assert.equal(mismatch.reason, 'core_generated_at_unexpected');
    assert.equal(mismatch.coreGeneratedAt, generatedAt);
    assert.equal(mismatch.expectedGeneratedAt, otherGeneration);

    // CLI parity: --expected-generated-at is accepted, output includes it,
    // and a mismatch exits non-zero while an invalid token is a usage error.
    const script = path.join(root, 'scripts', 'check_bi_portal_section_terminal.mjs');
    const okRun = spawnSync(process.execPath, [
      script,
      '--root', dir,
      '--section', 'orders',
      '--expected-generated-at', generatedAt,
    ], {encoding: 'utf8'});
    assert.equal(okRun.status, 0, okRun.stderr);
    assert.equal(JSON.parse(okRun.stdout).expectedGeneratedAt, generatedAt);
    assert.equal(JSON.parse(okRun.stdout).ok, true);

    const badRun = spawnSync(process.execPath, [
      script,
      '--root', dir,
      '--section', 'orders',
      '--expected-generated-at', otherGeneration,
    ], {encoding: 'utf8'});
    assert.equal(badRun.status, 1, 'an expected-generation mismatch must exit non-zero');
    assert.equal(JSON.parse(badRun.stdout).reason, 'core_generated_at_unexpected');

    const invalidToken = 'x'.repeat(2_000);
    const usageRun = spawnSync(process.execPath, [
      script,
      '--root', dir,
      '--section', 'orders',
      '--expected-generated-at', invalidToken,
    ], {encoding: 'utf8'});
    assert.equal(usageRun.status, 2, 'an over-long expected generation must be a usage error');
    assert.match(usageRun.stderr, /EXPECTED_GENERATED_AT_INVALID/);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

// ---- Validator: homeProfit source invariants fail closed.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-terminal-home-profit-'));
  try {
    await makePortal(dir, {
      section: 'homeProfit',
      extra: {data: {homeProfitSummary: {dailyScopes: [], sourceGeneratedAt: '2026-08-10T19:09:04.52205+08:00', staleSource: false}}},
    });
    assert.equal((await validateTerminalArtifact({root: dir, section: 'homeProfit'})).reason, 'home_profit_source_mismatch');

    await makePortal(dir, {
      section: 'homeProfit',
      extra: {data: {homeProfitSummary: {dailyScopes: [], sourceGeneratedAt: generatedAt, staleSource: true}}},
    });
    assert.equal((await validateTerminalArtifact({root: dir, section: 'homeProfit'})).reason, 'home_profit_stale_source');

    await makePortal(dir, {
      section: 'homeProfit',
      extra: {data: {homeProfitSummary: {sourceGeneratedAt: generatedAt, staleSource: false}}},
    });
    assert.equal((await validateTerminalArtifact({root: dir, section: 'homeProfit'})).reason, 'home_profit_daily_scopes_missing');

    await makePortal(dir, {section: 'homeProfit', extra: {data: {other: true}}});
    assert.equal((await validateTerminalArtifact({root: dir, section: 'homeProfit'})).reason, 'home_profit_summary_missing');
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

// ---- Validator: profit requires the dailyStoreProducts array even when
// production key ordering places it beyond the bounded metadata head.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-terminal-profit-'));
  try {
    await makePortal(dir, {section: 'profit', extra: {data: {profit: {monthGroups: []}}}});
    const result = await validateTerminalArtifact({root: dir, section: 'profit'});
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'profit_daily_store_products_missing');

    // A large prefix intentionally pushes dailyStoreProducts beyond the
    // default 64KB metadata head. The validator must find it with a
    // constant-memory streaming scan instead of assuming object key order.
    const rows = Array.from({length: 50_000}, (_, index) => ({
      date: '2026-08-10',
      store_key: 'JSH',
      standard_goods_sn: `ABC-${String(index).padStart(6, '0')}`,
      net_revenue_sar: index,
    }));
    await makePortal(dir, {section: 'profit', extra: {data: {profit: {monthGroups: rows, dailyStoreProducts: []}}}});
    const reordered = await validateTerminalArtifact({root: dir, section: 'profit'});
    assert.equal(reordered.ok, true, 'large reordered profit must validate via streaming key scan');
    assert.ok(reordered.profitScanBytes > 1024 * 1024,
      'fixture must place dailyStoreProducts beyond both the metadata head and the first scan chunk');
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

// ---- Validator: core and file presence failures.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-terminal-missing-'));
  try {
    fs.mkdirSync(path.join(dir, 'sections'), {recursive: true});
    fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({__sections: {mode: 'api'}}));
    assert.equal((await validateTerminalArtifact({root: dir, section: 'orders'})).reason, 'core_generated_at_missing');
    assert.equal((await validateTerminalArtifact({root: path.join(dir, 'nope'), section: 'orders'})).reason, 'core_file_missing');

    fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({generatedAt}));
    assert.equal((await validateTerminalArtifact({root: dir, section: 'orders'})).reason, 'section_file_missing');
    assert.equal((await validateTerminalArtifact({root: dir, section: '../escape'})).reason, 'section_invalid');

    await makePortal(dir, {core: false, section: 'orders'});
    fs.writeFileSync(path.join(dir, 'data.json'), `{"generatedAt":"${generatedAt}","corrupt":truX}`);
    assert.equal((await validateTerminalArtifact({root: dir, section: 'orders'})).reason, 'core_file_missing',
      'a structurally invalid unrequested core field must fail closed');
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

// ---- CLI exit codes: 0 terminal, 1 non-terminal, 2 usage.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-terminal-cli-'));
  try {
    await makePortal(dir, {section: 'orders'});
    const script = path.join(root, 'scripts', 'check_bi_portal_section_terminal.mjs');
    const okRun = spawnSync(process.execPath, [script, '--root', dir, '--section', 'orders'], {encoding: 'utf8'});
    assert.equal(okRun.status, 0, okRun.stderr);
    assert.equal(JSON.parse(okRun.stdout).ok, true);

    await makePortal(dir, {section: 'orders', sectionGeneratedAt: '2026-08-10T00:00:00.000Z'});
    const staleRun = spawnSync(process.execPath, [script, '--root', dir, '--section', 'orders'], {encoding: 'utf8'});
    assert.equal(staleRun.status, 1, 'a non-terminal artifact must exit non-zero');
    assert.equal(JSON.parse(staleRun.stdout).ok, false);

    const usageRun = spawnSync(process.execPath, [script, '--root', dir], {encoding: 'utf8'});
    assert.equal(usageRun.status, 2, 'missing --section must be a usage error');
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

// ---- A production-sized legacy core must stay bounded even when generatedAt
// is near the tail. The old readFileSync + JSON.parse path exhausted a small
// V8 heap before terminal readback could inspect the section artifact.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-terminal-large-core-'));
  const coreFile = path.join(dir, 'data.json');
  const oneMiB = Buffer.alloc(1024 * 1024, 0x78);
  let handle;
  try {
    fs.mkdirSync(path.join(dir, 'sections'), {recursive: true});
    handle = fs.openSync(coreFile, 'w');
    fs.writeSync(handle, '{"filler":"');
    for (let index = 0; index < 48; index += 1) fs.writeSync(handle, oneMiB);
    fs.writeSync(handle, `","generatedAt":"${generatedAt}","__sections":{"mode":"api","generatedAt":"${generatedAt}"}}`);
    fs.closeSync(handle);
    handle = undefined;
    await makePortal(dir, {core: false, section: 'orders'});

    const script = path.join(root, 'scripts', 'check_bi_portal_section_terminal.mjs');
    const boundedRun = spawnSync(process.execPath, [
      '--max-old-space-size=32',
      script,
      '--root', dir,
      '--section', 'orders',
    ], {encoding: 'utf8', timeout: 60_000});
    assert.equal(boundedRun.status, 0, boundedRun.stderr || boundedRun.error?.message);
    assert.equal(JSON.parse(boundedRun.stdout).coreGeneratedAt, generatedAt);
    assert.ok(fs.statSync(coreFile).size > 48 * 1024 * 1024,
      'fixture must be much larger than the constrained V8 heap');
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

// ---- Worker contract: only a clean HTTP 200 plus terminal readback may
// complete a lease; 202/non-200, stale markers, and non-terminal artifacts
// must fail instead; temp header files are trap-cleaned.
{
  const worker = fs.readFileSync(path.join(root, 'scripts', 'cloud_portal_section_queue_worker.sh'), 'utf8');
  assert.match(worker, /-w '%\{http_code\}'/, 'worker must capture the explicit HTTP status code');
  assert.doesNotMatch(worker, /curl -fsS/, 'worker must classify status codes explicitly instead of relying on curl -f');
  assert.match(worker, /\[\[ "\$HTTP_CODE" != "200" \]\]/, 'worker must reject every non-200 response');
  assert.match(worker, /queue_command fail --section "\$SECTION" --lease-id "\$LEASE_ID"[\s\S]*non-200 never completes/,
    'a 202/403/503/500 must fail the lease instead of completing it');
  assert.match(worker, /X-BI-Section-Refresh-Failed:\[\[:space:\]\]\*true/,
    'worker must detect a failed-refresh 2xx before generic non-200 handling');
  assert.match(worker, /response_header_value 'X-BI-Section-Refresh-Error' "\$REFRESH_ERROR_MAX_ENCODED"[\s\S]*response_header_value 'X-BI-Section-Refresh-Failed-At' 64/,
    'worker must extract the URL-encoded primary error and failure timestamp headers with bounded reads');
  assert.match(worker, /REFRESH_ERROR_MAX_ENCODED=12288[\s\S]*bounded_refresh_failure_reason[\s\S]*completeEncoded[\s\S]*TextDecoder[\s\S]*Array\.from\(safeError\)/,
    'worker must decode bounded complete escapes, preserve Unicode code points, sanitize to one line, and cap the persisted reason');
  for (const pattern of [/Authorization/u, /Basic\|Bearer/u, /Cookie\|Set-Cookie/u, /sensitiveKeys/u, /session_id/u, /access_token/u, /redactKeyValues/u, /consumeValue/u, /:\\\/\\\//u, /\[redacted\]/u]) {
    assert.match(worker, pattern,
      'worker must redact authorization, cookie/session/token/password, and URL/DSN credentials');
  }
  assert.match(worker, /queue_command fail --section "\$SECTION" --lease-id "\$LEASE_ID"[\s\S]*--error "\$REFRESH_FAILURE_REASON"/,
    'worker must persist the exact bounded decoded reason in the queue failure');
  assert.match(worker, /check_bi_portal_section_terminal\.mjs[\s\S]*--root "\$PORTAL_ROOT" --section "\$SECTION"/,
    'worker must verify the terminal artifact before completing');
  assert.match(worker, /timeout --signal=TERM --kill-after=1s "\$\{remaining_sec\}s"[\s\S]*check_bi_portal_section_terminal\.mjs/,
    'worker terminal validation must be bounded by the effective claim deadline');
  assert.match(worker, /TERMINAL_STATUS" -eq 0[\s\S]*queue_command complete --section "\$SECTION" --lease-id "\$LEASE_ID"/,
    'worker may only complete after a passing terminal readback');
  assert.match(worker, /--not-after-epoch "\$CLAIM_DEADLINE_EPOCH"/,
    'worker completion must pass the immutable slot/lease deadline to the manager');
  assert.match(worker, /if \[\[ "\$CURL_STATUS" -ne 0 \]\]; then\s*fail_terminal_claim "\$CURL_STATUS"/,
    'a transport failure must fail the lease without terminal reconciliation');
  assert.doesNotMatch(worker, /TERMINAL_RECONCILIATION|pre_request_terminal_probe|classify_terminal_report|--identity-only/,
    'worker must not retain transport reconciliation or a pre-request identity probe');
  assert.match(worker, /CLAIMED_SECTIONS=\(\)[\s\S]*--exclude-sections[\s\S]*CLAIMED_SECTIONS\+=\("\$SECTION"\)/,
    'one worker run must claim distinct sections so a hot entry cannot consume every bounded slot');
  assert.match(worker, /PROFIT_MIN_RUNTIME_SEC[\s\S]*REMAINING_SEC < PROFIT_MIN_RUNTIME_SEC[\s\S]*EXCLUDED_SECTIONS\+=\(profit\)/,
    'a short queue slot must not claim the profit section that cannot finish before its deadline');
  assert.match(worker, /HEAVY_SECTION_DEFERRED[\s\S]*queue_command status[\s\S]*PENDING_COUNT > 0[\s\S]*exit 75/,
    'a short slot that leaves heavy work pending must report a defer, never a false empty success');
  assert.match(worker, /HEAVY_ALLOWED="\$\{SHEIN_BI_PORTAL_SECTION_QUEUE_HEAVY_ALLOWED:-1\}"/,
    'the worker must receive an explicit heavy-section budget from the slot');
  assert.match(worker, /HEAVY_ALLOWED.*0[\s\S]*EXCLUDED_SECTIONS\+=\(profit homeRankings productSalesDaily\)/,
    'a short reserved slot must exclude every heavy section before claiming');
  assert.match(worker, /publishedRevision=\$PUBLISHED_REVISION follow-up pending/,
    'a successful claim with a newer request must report the published snapshot and follow-up');
  assert.match(worker, /Number\.isSafeInteger\(published\)[\s\S]*Number\.isSafeInteger\(desired\)[\s\S]*follow===true \? desired>published : follow===false && desired<=published/,
    'completion acceptance must validate both revisions and the exact follow-up relation');
  assert.match(worker, /if \[\[ "\$\{#FAILED_SECTIONS\[@\]\}" -gt 0 \]\]; then[\s\S]*failed sections=[\s\S]*exit 1/,
    'any failed lease must remain alert-worthy; an older terminal artifact cannot prove the requested revision recovered');
  assert.match(worker, /trap '\[\[ -n "\$\{HEADERS_FILE:-\}" \]\] && rm -f "\$HEADERS_FILE"' EXIT/,
    'worker must trap-clean the temp header file');
  assert.match(worker, /SHEIN_BI_PORTAL_ROOT:-/);
}

// ---- Prewarm contract: one homeProfit strictly after profit; critical sync
// lock conflicts exit 75 while async keeps skip 0; 200-only plus terminal
// readback; failures accumulate into FAILED_SECTIONS and exit 1.
{
  const prewarm = fs.readFileSync(path.join(root, 'scripts', 'prewarm_bi_portal_sections.sh'), 'utf8');
  const defaultSections = prewarm.match(/SHEIN_BI_PORTAL_PREWARM_SECTIONS:-([^\"]+)/)?.[1] || '';
  assert.ok(defaultSections.includes('profit') && defaultSections.includes('homeProfit'), 'default prewarm must cover profit and homeProfit');
  assert.equal(defaultSections.match(/homeProfit/g)?.length, 1, 'homeProfit must run exactly once');
  assert.ok(defaultSections.indexOf('profit') < defaultSections.indexOf('homeProfit'),
    'homeProfit must run strictly after profit so it never fails closed against a missing source');
  assert.match(prewarm, /homeProfit derives from the[\s\S]*current-generation profit cache[\s\S]*exactly once, strictly after profit/,
    'the SECTIONS comment must explain the single after-profit homeProfit ordering');

  assert.match(prewarm, /CRITICAL_SYNC_MODE/, 'prewarm must distinguish critical sync mode');
  assert.match(prewarm, /defer reason=prewarm_lock_busy_critical mode=sync[\s\S]*exit 75/,
    'a busy prewarm lock in critical sync mode must exit retryable 75');
  assert.match(prewarm, /another prewarm is running; skip[\s\S]*exit 0/,
    'a busy prewarm lock in async mode must keep the skip 0 behavior');
  assert.match(prewarm, /SHEIN_BI_PORTAL_PREWARM_REFRESH_TOKEN:-prewarm:/,
    'one prewarm invocation must own a stable refresh intent token');
  assert.match(prewarm, /\?refresh=1&refreshToken=\$\{REFRESH_RUN_TOKEN\}/,
    'every forced prewarm request must carry the run token required by host-locked sections');

  assert.match(prewarm, /-w '%\{http_code\}'/, 'prewarm must capture the explicit HTTP status code');
  assert.match(prewarm, /\[\[ "\$HTTP_CODE" != "200" \]\]/, 'prewarm must reject every non-200 response');
  assert.match(prewarm, /non-200; pending is never fresh[\s\S]*FAILED_SECTIONS\+\=/,
    'a 202 pending response must be recorded as a prewarm failure');
  assert.match(prewarm, /X-BI-Section-\(Stale\|Refresh-Failed\):\[\[:space:\]\]\*true[\s\S]*FAILED_SECTIONS\+\=/,
    'prewarm must record a stale or failed-refresh 2xx as a section failure');
  assert.match(prewarm, /check_bi_portal_section_terminal\.mjs[\s\S]*--root "\$PORTAL_ROOT" --section "\$SECTION"/,
    'prewarm must verify the terminal artifact before declaring a section ok');
  assert.match(prewarm, /FAILED_SECTIONS=\(\)[\s\S]*FAILED_SECTIONS\+=\("\$SECTION:\$STATUS"\)[\s\S]*exit 1/,
    'prewarm must return failure when any requested section is not terminal');
  assert.match(prewarm, /trap '\[\[ -n "\$\{HEADERS_FILE:-\}" \]\] && rm -f "\$HEADERS_FILE"' EXIT/,
    'prewarm must trap-clean the temp header file');
}

// ---- End-to-end prewarm against a deterministic curl stub. Requires
// bash/flock/mktemp/node (Linux or WSL); skipped cleanly on other hosts.
{
  const tools = spawnSync('bash', ['-lc', 'command -v flock >/dev/null && command -v mktemp >/dev/null && command -v node >/dev/null'], {encoding: 'utf8'});
  if (tools.status !== 0) {
    console.log('SKIP bi_portal_section_terminal: prewarm integration needs bash+flock+mktemp+node');
  } else {
    await runPrewarmStubTests(root);
    await runWorkerRefreshFailureHeaderTest(root);
  }
}

console.log('bi_portal_section_terminal: validator, worker/prewarm contract, and stubbed 202/200 gates passed');

async function runPrewarmStubTests(repoRoot) {
  const cases = [
    {section: 'orders', expectedExit: 0, marker: 'ok'},
    {section: 'homeProfit', expectedExit: 1, marker: 'stale/failed refresh marker'},
    {section: 'profit', expectedExit: 1, marker: 'non-200'},
    {section: 'linksData', expectedExit: 1, marker: 'terminal readback'},
    {section: 'afterSales', expectedExit: 1, marker: 'non-200'},
  ];
  for (const testCase of cases) {
    await runPrewarmCase(repoRoot, testCase);
  }
}

async function runWorkerRefreshFailureHeaderTest(repoRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-terminal-worker-refresh-error-'));
  const lockDir = `/tmp/bi-terminal-worker-${Date.now()}`;
  const lockFile = `${lockDir}/queue.lock`;
  const posix = value => {
    const text = String(value).replace(/\\/g, '/');
    return /^[A-Za-z]:\//.test(text)
      ? `/mnt/${text[0].toLowerCase()}${text.slice(2)}`
      : text;
  };
  const shellQuote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
  try {
    const binDir = path.join(dir, 'bin');
    const queueFile = path.join(dir, 'queue.json');
    fs.mkdirSync(binDir, {recursive: true});
    fs.writeFileSync(queueFile, `${JSON.stringify({
      version: 1,
      updatedAt: '',
      nextSequence: 1,
      entries: [{
        section: 'profit',
        sequence: 1,
        priority: 10,
        requestRevision: 1,
        claimedRevision: 0,
        rerun: false,
        rerunPriority: null,
        dependencyYield: false,
        idempotencyKey: 'core-warmup:G1::profit',
        coalesceKey: 'portal-generation:G1',
        coreGeneratedAt: 'G1',
        status: 'pending',
        requestedAt: '2026-08-22T07:31:00.000+08:00',
        updatedAt: '2026-08-22T07:31:00.000+08:00',
        reasons: ['core-warmup-G1'],
        attempts: 0,
        leaseId: '',
        leaseExpiresAt: '',
        nextAttemptAt: '',
        lastError: '',
      }],
      completedIdempotency: [],
      generationCompletion: null,
    }, null, 2)}\n`);
    const writeDate = deadlineEpoch => fs.writeFileSync(path.join(binDir, 'date'), `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  +%H) printf '07' ;;
  +%M) printf '32' ;;
  +%s) printf '1000' ;;
  +%Y-%m-%dT%H) printf '2026-08-22T07' ;;
  -d) printf '${deadlineEpoch}' ;;
  *) printf '2026-08-22T07:32:00+08:00' ;;
esac
`);
    writeDate(2000);
    const usefulError = '利润查询失败：字段 sku/day 缺失 🔥 Authorization: Bearer abc123 password=hunter postgres://dbuser:dbpass@db.example/profit ';
    let rawError = '';
    let encodedError = '';
    for (let pad = 0; pad < 12; pad += 1) {
      rawError = `${usefulError}${'x'.repeat(pad)}${'界'.repeat(2000)}`;
      encodedError = encodeURIComponent(rawError);
      if (/%(?:[0-9A-F])?$/u.test(encodedError.slice(0, 12_288))) break;
    }
    assert.ok(encodedError.length > 12_288, 'fixture must exceed the bounded encoded-header input');
    assert.match(encodedError.slice(0, 12_288), /%(?:[0-9A-F])?$/u,
      'fixture must cut through a percent escape to guard against decode-all fallback loss');
    const failedAt = '2026-08-22T07:32:31.125+08:00';
    const writeCurl = encoded => fs.writeFileSync(path.join(binDir, 'curl'), `#!/usr/bin/env bash
set -euo pipefail
headers=''
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    -D) headers="$2"; shift 2 ;;
    -o|-w|--max-time|-H) shift 2 ;;
    -sS) shift ;;
    *) shift ;;
  esac
done
{
  printf 'HTTP/1.1 200 OK\\r\\n'
  printf 'X-BI-Section-Refresh-Failed: true\\r\\n'
  printf 'X-BI-Section-Refresh-Failed-At: ${failedAt}\\r\\n'
  printf '%s\\r\\n' 'X-BI-Section-Refresh-Error: ${encoded}'
  printf '\\r\\n'
} > "$headers"
printf '200'
`);
    writeCurl(encodedError);
    const overrides = [
      ['SHEIN_BI_ROOT', posix(repoRoot)],
      ['SHEIN_BI_PORTAL_SECTION_QUEUE_FILE', posix(queueFile)],
      ['SHEIN_BI_PORTAL_SECTION_QUEUE_LOCK_FILE', lockFile],
      ['SHEIN_BI_PORTAL_SECTION_QUEUE_MAX_SECTIONS', '1'],
      ['SHEIN_BI_PORTAL_SECTION_QUEUE_SECTION_TIMEOUT_SEC', '10'],
      ['SHEIN_BI_PORTAL_SECTION_QUEUE_PROFIT_MIN_RUNTIME_SEC', '1'],
      ['SHEIN_BI_PORTAL_SECTION_QUEUE_PRODUCT_SALES_DAILY_MIN_RUNTIME_SEC', '31'],
      ['SHEIN_BI_PORTAL_SECTION_QUEUE_PRODUCT_SALES_DAILY_TIMEOUT_SEC', '1'],
      ['SHEIN_BI_PORTAL_SECTION_QUEUE_HOME_RANKINGS_MIN_RUNTIME_SEC', '1'],
      ['SHEIN_BI_PORTAL_SECTION_QUEUE_LEASE_SEC', '60'],
      ['SHEIN_BI_PORTAL_SECTION_QUEUE_SCHEDULED', '1'],
      ['SHEIN_BI_PORTAL_SECTION_QUEUE_DEADLINE_MINUTE', '59'],
    ].map(([key, value]) => `export ${key}=${shellQuote(value)}`).join('; ');
    const worker = posix(path.join(repoRoot, 'scripts', 'cloud_portal_section_queue_worker.sh'));
    const fakeBin = posix(binDir);
    const runWorker = () => spawnCapture('bash', ['-c',
      `mkdir -p ${shellQuote(lockDir)} && chmod 2770 ${shellQuote(lockDir)}; `
      + `chmod +x ${shellQuote(posix(path.join(binDir, 'date')))} ${shellQuote(posix(path.join(binDir, 'curl')))}; `
      + `${overrides}; PATH=${shellQuote(fakeBin)}:"$PATH"; export PATH; exec ${shellQuote(worker)}`],
    {timeout: 30_000});
    writeDate(1100);
    const guardRun = await runWorker();
    assert.equal(guardRun.status, 0,
      `worker must stop cleanly before a new claim below 120 seconds: ${guardRun.stderr}`);
    assert.match(`${guardRun.stdout}\n${guardRun.stderr}`,
      /stop before next section remainingSec=100 requiredSec=120/,
      'worker must report the generic minimum remaining-time guard');
    assert.equal(JSON.parse(fs.readFileSync(queueFile, 'utf8')).entries[0].status, 'pending',
      'the minimum remaining-time guard must leave the queue claimable');
    writeDate(2000);
    const run = await runWorker();
    const sanitizedError = rawError
      .replace(/Authorization: Bearer abc123/u, 'Authorization=[redacted]')
      .replace(/password=hunter/u, 'password=[redacted]')
      .replace(/postgres:\/\/dbuser:dbpass@/u, 'postgres://[redacted]@');
    const reasonPrefix = `portal refresh failed at=${failedAt} error=`;
    const expectedReason = reasonPrefix
      + Array.from(sanitizedError).slice(0, 900 - Array.from(reasonPrefix).length).join('');
    assert.equal(run.timedOut, false, `worker refresh-error case timed out: ${run.stderr}`);
    assert.equal(run.status, 1, `worker refresh-error case must remain alert-worthy: ${run.stdout}\n${run.stderr}`);
    const queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
    assert.equal(queue.entries[0].lastError, expectedReason,
      `queue_command fail must preserve the exact bounded decoded primary error and timestamp; stdout=${run.stdout}; stderr=${run.stderr}`);
    const expectedJournalReason = expectedReason.slice(0, 240);
    assert.match(run.stderr, new RegExp(expectedJournalReason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'journal output must carry the exact concise prefix of the primary reason');
    assert.doesNotMatch(`${queue.entries[0].lastError}\n${run.stderr}`, /abc123|topsecret|hunter|dbuser|dbpass/u,
      'queue and journal diagnostics must redact credentials');
    assert.doesNotMatch(`${run.stdout}\n${run.stderr}`, /response-body-secret/,
      'worker diagnostics must never include response body data');

    const secretError = 'Basic QWxhZGRpbjpvcGVu Authorization: Bearer bearer-value password=pw-value session_id=session-value token=token-value mysql://dbuser:dbpass@db.example/profit Cookie: sid=cookie-value';
    writeCurl(encodeURIComponent(secretError));
    queue.entries[0].status = 'pending';
    queue.entries[0].claimedRevision = 0;
    queue.entries[0].attempts = 0;
    queue.entries[0].leaseId = '';
    queue.entries[0].leaseExpiresAt = '';
    queue.entries[0].nextAttemptAt = '';
    queue.entries[0].lastError = '';
    fs.writeFileSync(queueFile, `${JSON.stringify(queue, null, 2)}\n`);
    const secretRun = await runWorker();
    assert.equal(secretRun.status, 1, secretRun.stderr);
    const secretQueue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
    const expectedSecretError = 'Basic [redacted] Authorization=[redacted] password=[redacted] session_id=[redacted] token=[redacted] mysql://[redacted]@db.example/profit Cookie=[redacted]';
    assert.equal(secretQueue.entries[0].lastError, `${reasonPrefix}${expectedSecretError}`,
      'all supported credential families must be redacted while preserving useful context');
    assert.doesNotMatch(`${secretQueue.entries[0].lastError}\n${secretRun.stderr}`,
      /QWxhZGRpb|bearer-value|pw-value|session-value|token-value|dbuser|dbpass|cookie-value/u,
      'credential values must not reach queue state or journal output');

    const resetQueue = () => {
      const current = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
      current.entries[0].status = 'pending';
      current.entries[0].claimedRevision = 0;
      current.entries[0].attempts = 0;
      current.entries[0].leaseId = '';
      current.entries[0].leaseExpiresAt = '';
      current.entries[0].nextAttemptAt = '';
      current.entries[0].lastError = '';
      fs.writeFileSync(queueFile, `${JSON.stringify(current, null, 2)}\n`);
    };
    const reviewerJsonFixture = '{"password":"review-password","passwd":"review-passwd","pwd":"review-pwd","token":"review-token","access_token":"review-access","refresh_token":"review-refresh","session":"review-session","session_id":"review-session-id","cookie":"review-cookie","authorization":"Bearer review-auth","api_key":"review-api","secret":"review-secret","message":"利润查询失败：保留中文"}';
    const sanitizerCases = [
      {
        name: 'reviewer-json',
        raw: reviewerJsonFixture,
        useful: '利润查询失败：保留中文',
        secrets: ['review-password', 'review-passwd', 'review-pwd', 'review-token', 'review-access', 'review-refresh', 'review-session', 'review-session-id', 'review-cookie', 'review-auth', 'review-api', 'review-secret'],
      },
      {
        name: 'nested-spacing-and-bare-values',
        raw: '{ "outer" : { "PaSsWoRd" : 4815162342, "TOKEN" : bare-token-value, "SESSION_ID" = nested-session-value }, "API_KEY" : 123456789, "message" : "利润嵌套错误仍可读" }',
        useful: '利润嵌套错误仍可读',
        secrets: ['4815162342', 'bare-token-value', 'nested-session-value', '123456789'],
      },
      {
        name: 'escaped-json',
        raw: '{\\"ACCESS_TOKEN\\":\\"escaped-access-value\\",\\"nested\\":{\\"refresh_token\\" : 987654321,\\"Authorization\\":\\"Basic escaped-auth-value\\",\\"cookie\\":\\"escaped-cookie-value\\"},\\"message\\":\\"中文转义原因保留\\"}',
        useful: '中文转义原因保留',
        secrets: ['escaped-access-value', '987654321', 'escaped-auth-value', 'escaped-cookie-value'],
      },
      {
        name: 'object-log-keys',
        raw: '中文日志上下文保留 PWD = log-pwd-value SECRET:log-secret-value session = 246813579 api_key: bare-api-value authorization: Bearer log-auth-value cookie: sid=log-cookie-value',
        useful: '中文日志上下文保留',
        secrets: ['log-pwd-value', 'log-secret-value', '246813579', 'bare-api-value', 'log-auth-value', 'log-cookie-value'],
      },
    ];
    for (const testCase of sanitizerCases) {
      writeCurl(encodeURIComponent(testCase.raw));
      resetQueue();
      const sanitizedRun = await runWorker();
      assert.equal(sanitizedRun.timedOut, false, `${testCase.name} timed out: ${sanitizedRun.stderr}`);
      assert.equal(sanitizedRun.status, 1, `${testCase.name} must fail the queue lease: ${sanitizedRun.stderr}`);
      const sanitizedQueue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
      const persistedReason = sanitizedQueue.entries[0].lastError;
      assert.match(persistedReason, new RegExp(testCase.useful, 'u'),
        `${testCase.name} must preserve useful nonsecret Unicode`);
      for (const secret of testCase.secrets) {
        for (const [surface, diagnostic] of [
          ['queue', persistedReason],
          ['journal', sanitizedRun.stderr],
          ['log', sanitizedRun.stdout],
        ]) {
          assert.equal(diagnostic.includes(secret), false,
            `${testCase.name} leaked a secret fixture to ${surface}`);
        }
      }
      assert.doesNotMatch(`${sanitizedRun.stdout}\n${sanitizedRun.stderr}`, /response-body-secret/u,
        `${testCase.name} must not log response body data`);
    }
  } finally {
    await spawnCapture('bash', ['-c',
      `rm -f ${shellQuote(lockFile)}; rmdir ${shellQuote(lockDir)} 2>/dev/null || true`], {timeout: 10_000});
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

function spawnCapture(command, args, {timeout = 60_000} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      resolve({status, signal, stdout, stderr, timedOut});
    });
  });
}

async function runPrewarmCase(repoRoot, {section, expectedExit, marker}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bi-terminal-prewarm-${section}-`));
  try {
    const portalRoot = path.join(dir, 'portal');
    const logDir = path.join(dir, 'logs');
    const binDir = path.join(dir, 'bin');
    fs.mkdirSync(portalRoot, {recursive: true});
    fs.mkdirSync(path.join(portalRoot, 'sections'), {recursive: true});
    fs.mkdirSync(logDir, {recursive: true});
    fs.mkdirSync(binDir, {recursive: true});
    const posixPath = value => {
      const text = String(value).replace(/\\/g, '/');
      return /^[A-Za-z]:\//.test(text)
        ? `/mnt/${text[0].toLowerCase()}${text.slice(2)}`
        : text;
    };
    const shellQuotePath = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
    fs.writeFileSync(path.join(binDir, 'curl'), `#!/usr/bin/env bash
set -euo pipefail
headers=''
url=''
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    -D) headers="$2"; shift 2 ;;
    -o|-w|--max-time|-H) shift 2 ;;
    -sS) shift ;;
    *) url="$1"; shift ;;
  esac
done
section="\${url#*/api/bi/section/}"
section="\${section%%\\?*}"
code=200
if [[ "$section" == 'profit' ]]; then code=202; fi
if [[ "$section" == 'afterSales' ]]; then code=503; fi
{
  printf 'HTTP/1.1 %s Test\\r\\n' "$code"
  printf 'X-BI-Section-Cache-Hit: true\\r\\n'
  if [[ "$section" == 'homeProfit' ]]; then
    printf 'X-BI-Section-Stale: true\\r\\n'
  fi
  printf '\\r\\n'
} > "$headers"
printf '%s' "$code"
`);
    // Terminal artifact matching the curl stub's responses.
    fs.writeFileSync(path.join(portalRoot, 'data.json'), JSON.stringify({generatedAt, __sections: {mode: 'api', generatedAt}}));
    const terminalData = section === 'profit'
      ? {profit: {dailyStoreProducts: []}}
      : section === 'homeProfit'
        ? {homeProfitSummary: {dailyScopes: [], sourceGeneratedAt: generatedAt, staleSource: false}}
        : {};
    const publishRun = {code: 0, timedOut: false, stderr: ''};
    const artifactGeneratedAt = section === 'linksData' ? '2026-08-10T00:00:00.000Z' : generatedAt;
    if (['profit', 'homeProfit'].includes(section) && artifactGeneratedAt === generatedAt) {
      const profitData = {profit: {dailyStoreProducts: []}};
      await writeBiSectionCache(portalRoot, 'profit', generatedAt, profitData, publishRun, {requireIntegrity: true});
      await writeBiSectionArtifact(portalRoot, 'profit.query', 'profit.query', generatedAt, profitData, publishRun, {requireIntegrity: true});
      await writeBiSectionCache(portalRoot, 'homeProfit', generatedAt, terminalData, publishRun, {requireIntegrity: true});
      await publishBiProfitBundleManifest(portalRoot, generatedAt);
    } else {
      await writeBiSectionCache(portalRoot, section, artifactGeneratedAt, terminalData, publishRun, {requireIntegrity: true});
    }
    if (process.platform === 'win32') {
      // The prewarm contract runs under WSL. Re-publish the fixture there so
      // Linux-side stat/inode bindings in the strict sidecar match the
      // validator; native Windows and WSL report different bindings for the
      // same drvfs file.
      const seedFile = path.join(binDir, 'seed_terminal_artifact.mjs');
      const cacheModule = posixPath(path.join(repoRoot, 'lib', 'bi_section_cache.mjs'));
      fs.writeFileSync(seedFile, `import {publishBiProfitBundleManifest, writeBiSectionArtifact, writeBiSectionCache} from ${JSON.stringify(cacheModule)};
const root = ${JSON.stringify(posixPath(portalRoot))};
const section = ${JSON.stringify(section)};
const generatedAt = ${JSON.stringify(generatedAt)};
const artifactGeneratedAt = ${JSON.stringify(artifactGeneratedAt)};
const data = ${JSON.stringify(terminalData)};
const run = {code: 0, timedOut: false, stderr: ''};
if (section === 'profit' || section === 'homeProfit') {
  const profitData = {profit: {dailyStoreProducts: []}};
  await writeBiSectionCache(root, 'profit', generatedAt, profitData, run, {requireIntegrity: true});
  await writeBiSectionArtifact(root, 'profit.query', 'profit.query', generatedAt, profitData, run, {requireIntegrity: true});
  await writeBiSectionCache(root, 'homeProfit', generatedAt, data, run, {requireIntegrity: true});
  await publishBiProfitBundleManifest(root, generatedAt);
} else {
  await writeBiSectionCache(root, section, artifactGeneratedAt, data, run, {requireIntegrity: true});
}
`);
      const seeded = await spawnCapture('bash', ['-c', `node ${shellQuotePath(posixPath(seedFile))}`], {timeout: 60_000});
      assert.equal(seeded.status, 0, `WSL strict-sidecar fixture seed failed: ${seeded.stderr}`);
    }
    // The prewarm runs under the host bash (WSL2 here, Linux on the cloud).
    // Windows drive paths must become /mnt/<drive>/... inside WSL; plain
    // POSIX paths (cloud checkout) pass through unchanged. WSL interop does
    // not forward arbitrary Windows environment variables, so the SHEIN_BI_*
    // overrides are exported inline in the bash command instead. The lock
    // file lives on the native Linux filesystem because drvfs (/mnt/e) cannot
    // honor the required 2770 directory mode; /tmp itself is 1777, so a
    // dedicated 2770 lock directory is created first.
    const lockDir = `/tmp/bi-terminal-prewarm-${Date.now()}-${section}`;
    const lockFile = `${lockDir}/prewarm.lock`;
    const overrides = [
      ['SHEIN_BI_ROOT', posixPath(repoRoot)],
      ['SHEIN_BI_PORTAL_URL', 'http://127.0.0.1:9'],
      ['SHEIN_BI_PORTAL_ROOT', posixPath(portalRoot)],
      ['SHEIN_BI_PREWARM_LOG_DIR', posixPath(logDir)],
      ['SHEIN_BI_PORTAL_PREWARM_LOCK_FILE', lockFile],
      ['SHEIN_BI_PORTAL_PREWARM_SECTIONS', section],
      ['SHEIN_BI_PORTAL_PREWARM_ASYNC', '0'],
      ['SHEIN_BI_PORTAL_PREWARM_HOST_LOCKED', '1'],
      ['SHEIN_BI_PREWARM_SECTION_TIMEOUT_SECONDS', '15'],
    ].map(([key, value]) => `export ${key}=${shellQuotePath(value)}`).join('; ');
    const scriptPath = posixPath(path.join(repoRoot, 'scripts', 'prewarm_bi_portal_sections.sh'));
    const stubPath = posixPath(path.join(binDir, 'curl'));
    const stubBin = posixPath(binDir);
    const run = await spawnCapture('bash', ['-c',
      `mkdir -p ${shellQuotePath(lockDir)} && chmod 2770 ${shellQuotePath(lockDir)}; ` +
      `chmod +x ${shellQuotePath(stubPath)}; ${overrides}; PATH=${shellQuotePath(stubBin)}:"$PATH"; export PATH; ` +
      `exec ${shellQuotePath(scriptPath)}`], {timeout: 60_000});
    await spawnCapture('bash', ['-c',
      `rm -f ${shellQuotePath(lockFile)}; rmdir ${shellQuotePath(lockDir)} 2>/dev/null || true`], {timeout: 10_000});
    assert.equal(run.timedOut, false, `${section}: prewarm timed out (stdout=${run.stdout} stderr=${run.stderr})`);
    const logs = fs.readdirSync(logDir).filter(name => name.endsWith('.log'));
    const log = logs.map(name => fs.readFileSync(path.join(logDir, name), 'utf8')).join('\n');
    assert.equal(run.status, expectedExit,
      `${section}: unexpected prewarm exit (stdout=${run.stdout} stderr=${run.stderr} log=${log})`);
    assert.match(log, new RegExp(`section=${section} .*${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      `${section}: expected log marker ${marker}; log:\n${log}`);
    fs.rmSync(dir, {recursive: true, force: true});
  } finally {
    if (fs.existsSync(dir)) fs.rmSync(dir, {recursive: true, force: true});
  }
}
