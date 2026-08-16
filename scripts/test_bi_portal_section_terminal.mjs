#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

import {validateTerminalArtifact} from './check_bi_portal_section_terminal.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generatedAt = '2026-08-11T08:36:30.27274+08:00';

function makePortal(dir, {core = true, section, sectionGeneratedAt = generatedAt, extra = {}} = {}) {
  fs.mkdirSync(path.join(dir, 'sections'), {recursive: true});
  if (core) {
    fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({
      generatedAt,
      __sections: {mode: 'api', generatedAt},
    }));
  }
  if (section) {
    fs.writeFileSync(path.join(dir, 'sections', `${section}.json`), JSON.stringify({
      ok: true,
      section,
      generatedAt: sectionGeneratedAt,
      cachedAt: '2026-08-11T02:56:46.613Z',
      data: extra.data ?? {},
      run: {code: 0, timedOut: false, stderrTail: ''},
    }));
  }
}

// ---- Validator: current generation passes for ordinary, profit, homeProfit.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-terminal-current-'));
  try {
    makePortal(dir, {section: 'orders', extra: {data: {rows: []}}});
    const result = await validateTerminalArtifact({root: dir, section: 'orders'});
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.coreGeneratedAt, generatedAt);
    assert.equal(result.sectionGeneratedAt, generatedAt);

    makePortal(dir, {section: 'profit', extra: {data: {profit: {dailyStoreProducts: []}}}});
    assert.equal((await validateTerminalArtifact({root: dir, section: 'profit'})).ok, true, 'profit with dailyStoreProducts must be terminal');

    makePortal(dir, {
      section: 'homeProfit',
      extra: {data: {homeProfitSummary: {dailyScopes: [], source: 'profit_section_cache', sourceGeneratedAt: generatedAt, staleSource: false}}},
    });
    assert.equal((await validateTerminalArtifact({root: dir, section: 'homeProfit'})).ok, true, 'fresh homeProfit must be terminal');
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

// ---- Validator: stale generation is never terminal.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-terminal-stale-'));
  try {
    makePortal(dir, {section: 'orders', sectionGeneratedAt: '2026-08-10T08:36:30.27274+08:00'});
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
    makePortal(dir, {section: 'orders'});
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
    makePortal(dir, {
      section: 'homeProfit',
      extra: {data: {homeProfitSummary: {dailyScopes: [], sourceGeneratedAt: '2026-08-10T19:09:04.52205+08:00', staleSource: false}}},
    });
    assert.equal((await validateTerminalArtifact({root: dir, section: 'homeProfit'})).reason, 'home_profit_source_mismatch');

    makePortal(dir, {
      section: 'homeProfit',
      extra: {data: {homeProfitSummary: {dailyScopes: [], sourceGeneratedAt: generatedAt, staleSource: true}}},
    });
    assert.equal((await validateTerminalArtifact({root: dir, section: 'homeProfit'})).reason, 'home_profit_stale_source');

    makePortal(dir, {
      section: 'homeProfit',
      extra: {data: {homeProfitSummary: {sourceGeneratedAt: generatedAt, staleSource: false}}},
    });
    assert.equal((await validateTerminalArtifact({root: dir, section: 'homeProfit'})).reason, 'home_profit_daily_scopes_missing');

    makePortal(dir, {section: 'homeProfit', extra: {data: {other: true}}});
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
    makePortal(dir, {section: 'profit', extra: {data: {profit: {monthGroups: []}}}});
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
    makePortal(dir, {section: 'profit', extra: {data: {profit: {monthGroups: rows, dailyStoreProducts: []}}}});
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

    makePortal(dir, {core: false, section: 'orders'});
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
    makePortal(dir, {section: 'orders'});
    const script = path.join(root, 'scripts', 'check_bi_portal_section_terminal.mjs');
    const okRun = spawnSync(process.execPath, [script, '--root', dir, '--section', 'orders'], {encoding: 'utf8'});
    assert.equal(okRun.status, 0, okRun.stderr);
    assert.equal(JSON.parse(okRun.stdout).ok, true);

    makePortal(dir, {section: 'orders', sectionGeneratedAt: '2026-08-10T00:00:00.000Z'});
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
    makePortal(dir, {core: false, section: 'orders'});

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
  assert.match(worker, /X-BI-Section-\(Stale\|Refresh-Failed\):\[\[:space:\]\]\*true/,
    'worker must treat a stale or failed-refresh 2xx as a failed section');
  assert.match(worker, /check_bi_portal_section_terminal\.mjs[\s\S]*--root "\$PORTAL_ROOT" --section "\$SECTION"/,
    'worker must verify the terminal artifact before completing');
  assert.match(worker, /TERMINAL_STATUS" -eq 0[\s\S]*queue_command complete --section "\$SECTION" --lease-id "\$LEASE_ID"/,
    'worker may only complete after a passing terminal readback');
  assert.match(worker, /CLAIMED_SECTIONS=\(\)[\s\S]*--exclude-sections[\s\S]*CLAIMED_SECTIONS\+=\("\$SECTION"\)/,
    'one worker run must claim distinct sections so a hot entry cannot consume every bounded slot');
  assert.match(worker, /PROFIT_MIN_RUNTIME_SEC[\s\S]*REMAINING_SEC < PROFIT_MIN_RUNTIME_SEC[\s\S]*EXCLUDED_SECTIONS\+=\(profit\)/,
    'a short queue slot must not claim the profit section that cannot finish before its deadline');
  assert.match(worker, /HEAVY_SECTION_DEFERRED[\s\S]*queue_command status[\s\S]*PENDING_COUNT > 0[\s\S]*exit 75/,
    'a short slot that leaves heavy work pending must report a defer, never a false empty success');
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
    fs.writeFileSync(path.join(portalRoot, 'sections', `${section}.json`), JSON.stringify({
      ok: true,
      section,
      generatedAt: section === 'linksData' ? '2026-08-10T00:00:00.000Z' : generatedAt,
      cachedAt: '2026-08-11T02:56:46.613Z',
      data: terminalData,
    }));
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
    const posix = value => {
      const text = String(value).replace(/\\/g, '/');
      return /^[A-Za-z]:\//.test(text)
        ? `/mnt/${text[0].toLowerCase()}${text.slice(2)}`
        : text;
    };
    const shellQuote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
    const overrides = [
      ['SHEIN_BI_ROOT', posix(repoRoot)],
      ['SHEIN_BI_PORTAL_URL', 'http://127.0.0.1:9'],
      ['SHEIN_BI_PORTAL_ROOT', posix(portalRoot)],
      ['SHEIN_BI_PREWARM_LOG_DIR', posix(logDir)],
      ['SHEIN_BI_PORTAL_PREWARM_LOCK_FILE', lockFile],
      ['SHEIN_BI_PORTAL_PREWARM_SECTIONS', section],
      ['SHEIN_BI_PORTAL_PREWARM_ASYNC', '0'],
      ['SHEIN_BI_PORTAL_PREWARM_HOST_LOCKED', '1'],
      ['SHEIN_BI_PREWARM_SECTION_TIMEOUT_SECONDS', '15'],
    ].map(([key, value]) => `export ${key}=${shellQuote(value)}`).join('; ');
    const scriptPath = posix(path.join(repoRoot, 'scripts', 'prewarm_bi_portal_sections.sh'));
    const stubPath = posix(path.join(binDir, 'curl'));
    const stubBin = posix(binDir);
    const run = await spawnCapture('bash', ['-c',
      `mkdir -p ${shellQuote(lockDir)} && chmod 2770 ${shellQuote(lockDir)}; ` +
      `chmod +x ${shellQuote(stubPath)}; ${overrides}; PATH=${shellQuote(stubBin)}:"$PATH"; export PATH; ` +
      `exec ${shellQuote(scriptPath)}`], {timeout: 60_000});
    await spawnCapture('bash', ['-c',
      `rm -f ${shellQuote(lockFile)}; rmdir ${shellQuote(lockDir)} 2>/dev/null || true`], {timeout: 10_000});
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
