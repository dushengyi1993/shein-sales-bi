#!/usr/bin/env node

import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {enqueueSections} from './manage_bi_portal_section_queue.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generatedAt = 'G1';

const toPosixPath = value => {
  const text = String(value).replace(/\\/g, '/');
  return /^[A-Za-z]:\//u.test(text)
    ? `/mnt/${text[0].toLowerCase()}${text.slice(2)}`
    : text;
};
const shellQuote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;

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

function writeExecutable(file, source) {
  fs.writeFileSync(file, source, {encoding: 'utf8', mode: 0o770});
}

function makePortal(portalRoot, sections) {
  fs.mkdirSync(path.join(portalRoot, 'sections'), {recursive: true});
  fs.writeFileSync(path.join(portalRoot, 'data.json'), `${JSON.stringify({
    generatedAt,
    __sections: {mode: 'api', generatedAt},
  })}\n`);
  for (const section of sections) {
    const data = section === 'profit'
      ? {profit: {dailyStoreProducts: []}}
      : {};
    fs.writeFileSync(path.join(portalRoot, 'sections', `${section}.json`), `${JSON.stringify({
      ok: true,
      section,
      generatedAt,
      cachedAt: '2026-08-22T00:00:00.000Z',
      data,
      run: {code: 0, timedOut: false, stderrTail: ''},
    })}\n`);
  }
}

async function seedStrictPortalArtifacts(portalRoot, binDir, sections) {
  // The worker itself runs under bash/WSL in this focused integration test;
  // publish the raw/gzip/sidecar fixture in that same runtime so stat
  // bindings are comparable to the terminal validator.
  const seedFile = path.join(binDir, 'seed-portal.mjs');
  const cacheModule = toPosixPath(path.join(root, 'lib', 'bi_section_cache.mjs'));
  fs.writeFileSync(seedFile, `import {publishBiProfitBundleManifest, writeBiSectionArtifact, writeBiSectionCache} from ${JSON.stringify(cacheModule)};
const root = ${JSON.stringify(toPosixPath(portalRoot))};
const sections = ${JSON.stringify(sections)};
const generatedAt = ${JSON.stringify(generatedAt)};
const run = {code: 0, timedOut: false, stderr: ''};
if (sections.includes('profit')) {
  const profitData = {profit: {dailyStoreProducts: []}};
  await writeBiSectionCache(root, 'profit', generatedAt, profitData, run, {requireIntegrity: true});
  await writeBiSectionArtifact(root, 'profit.query', 'profit.query', generatedAt, profitData, run, {requireIntegrity: true});
  await writeBiSectionCache(root, 'homeProfit', generatedAt, {homeProfitSummary: {dailyScopes: [], sourceGeneratedAt: generatedAt, staleSource: false}}, run, {requireIntegrity: true});
  await publishBiProfitBundleManifest(root, generatedAt);
}
for (const section of sections) {
  if (section === 'profit') continue;
  await writeBiSectionCache(root, section, generatedAt, section === 'orders' ? {} : {}, run, {requireIntegrity: true});
}
`);
  const seeded = await spawnCapture('bash', ['-c', `node ${shellQuote(toPosixPath(seedFile))}`], {timeout: 60_000});
  assert.equal(seeded.status, 0, `strict portal fixture seed failed: ${seeded.stderr}`);
}

function makeQueue(queueFile, sections, now) {
  const queue = {version: 1, updatedAt: '', nextSequence: 0, entries: []};
  enqueueSections(queue, {
    sections,
    priority: 10,
    idempotencyKey: 'window-test',
    coalesceKey: 'window:G1',
    coreGeneratedAt: generatedAt,
    now,
  });
  fs.writeFileSync(queueFile, `${JSON.stringify(queue, null, 2)}\n`);
}

function makeDateStub(binDir, {
  hour,
  minute,
  nowEpoch,
  nowEpochs = [nowEpoch],
  deadlineEpoch,
  rolloverHour = '',
  rolloverDeadlineEpoch = deadlineEpoch,
}) {
  const epochValues = nowEpochs.map(value => Number(value));
  const epochLiteral = epochValues.join(' ');
  const secondState = toPosixPath(path.join(binDir, 'date-seconds.state'));
  const hourState = toPosixPath(path.join(binDir, 'date-hours.state'));
  writeExecutable(path.join(binDir, 'date'), `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  +%H) printf '%s' '${hour}' ;;
  +%M) printf '%s' '${minute}' ;;
  +%s)
    index=0
    if [[ -f '${secondState}' ]]; then index="$(< '${secondState}')"; fi
    values=(${epochLiteral})
    (( index < \${#values[@]} )) || index=\$((\${#values[@]} - 1))
    printf '%s' \$((index + 1)) > '${secondState}'
    printf '%s' "\${values[\$index]}"
    ;;
  +%Y-%m-%dT%H)
    index=0
    if [[ -f '${hourState}' ]]; then index="$(< '${hourState}')"; fi
    printf '%s' \$((index + 1)) > '${hourState}'
    if (( index == 0 )) || [[ -z '${rolloverHour}' ]]; then
      printf '%s' '2026-08-22T${hour}'
    else
      printf '%s' '2026-08-22T${rolloverHour}'
    fi
    ;;
  -d)
    hourCalls=0
    if [[ -f '${hourState}' ]]; then hourCalls="$(< '${hourState}')"; fi
    if (( hourCalls > 1 )) && [[ -n '${rolloverHour}' ]]; then
      printf '%s' '${rolloverDeadlineEpoch}'
    else
      printf '%s' '${deadlineEpoch}'
    fi
    ;;
  *) printf '%s' '2026-08-22T${hour}:${minute}:00+08:00' ;;
esac
`);
}

function makeCurlStub(binDir) {
  writeExecutable(path.join(binDir, 'curl'), `#!/usr/bin/env bash
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
if [[ "$section" == "profit" && "\${SHEIN_TEST_PROFIT_HTTP:-200}" != "200" ]]; then
  status="\${SHEIN_TEST_PROFIT_HTTP:-500}"
  {
    printf 'HTTP/1.1 %s Test Failure\\r\\n' "$status"
    printf '\\r\\n'
  } > "\${headers:?}"
  printf '%s\\n' "\${section}" >> "\${SHEIN_TEST_CURL_LOG:?}"
  printf '%s' "$status"
  exit 0
fi
{
  printf 'HTTP/1.1 200 OK\\r\\n'
  printf 'X-BI-Section-Cache-Hit: true\\r\\n'
  printf '\\r\\n'
} > "\${headers:?}"
printf '%s\\n' "\${section}" >> "\${SHEIN_TEST_CURL_LOG:?}"
if [[ "$section" == "profit" && "\${SHEIN_TEST_REQUEUE_PROFIT:-0}" == "1" ]]; then
  node "\${SHEIN_BI_ROOT:?}/scripts/manage_bi_portal_section_queue.mjs" enqueue \\
    --sections profit --priority 5 --reason test-follow-up \\
    --idempotency-key test-follow-up --coalesce-key window:G1 \\
    --core-generated-at G1 --file "\${SHEIN_BI_PORTAL_SECTION_QUEUE_FILE:?}" >/dev/null
fi
if [[ "$section" == "profit" && "\${SHEIN_TEST_REMOVE_PROFIT_BEFORE_COMPLETE:-0}" == "1" ]]; then
  node - "\${SHEIN_BI_PORTAL_SECTION_QUEUE_FILE:?}" <<'NODE'
const fs = req${'uire'}('node:fs');
const file = process.argv[2];
const queue = JSON.parse(fs.readFileSync(file, 'utf8'));
queue.entries = (queue.entries || []).filter(entry => entry.section !== 'profit');
 fs.writeFileSync(file, JSON.stringify(queue, null, 2) + '\\n');
NODE
fi
printf '200'
`);
}

async function runWindowCase({
  name,
  hour,
  minute,
  nowEpoch,
  deadlineEpoch,
  deadlineMinute = undefined,
  heavyAllowed,
  scheduled = '1',
  heavyFirst = 0,
  sections,
  maxSections,
  expectedStatus,
  profitHttp = '200',
  leaseSeconds = 60,
  nowEpochs = null,
  rolloverHour = '',
  rolloverDeadlineEpoch = deadlineEpoch,
  requeueProfit = false,
  removeProfitBeforeComplete = false,
  artifactSections = sections,
  queueSetup = null,
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bi-portal-section-window-${name}-`));
  const lockDir = `/tmp/bi-portal-section-window-${process.pid}-${Date.now()}-${name}`;
  const lockFile = `${lockDir}/queue.lock`;
  const portalRoot = path.join(dir, 'portal');
  const binDir = path.join(dir, 'bin');
  const queueFile = path.join(dir, 'queue.json');
  const curlLog = path.join(dir, 'curl.log');
  fs.mkdirSync(binDir, {recursive: true});
  makePortal(portalRoot, artifactSections);
  await seedStrictPortalArtifacts(portalRoot, binDir, artifactSections);
  makeQueue(queueFile, sections, new Date('2026-08-22T00:00:00.000Z'));
  if (queueSetup) {
    const queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
    queueSetup(queue);
    fs.writeFileSync(queueFile, `${JSON.stringify(queue, null, 2)}\n`);
  }
  const epochOffset = deadlineEpoch < 1_000_000_000
    ? Math.floor(Date.now() / 1_000) - nowEpoch
    : 0;
  makeDateStub(binDir, {
    hour,
    minute,
    nowEpoch: nowEpoch + epochOffset,
    nowEpochs: (nowEpochs || [nowEpoch]).map(value => value + epochOffset),
    deadlineEpoch: deadlineEpoch + epochOffset,
    rolloverHour,
    rolloverDeadlineEpoch: rolloverDeadlineEpoch + epochOffset,
  });
  makeCurlStub(binDir);

  const env = {
    SHEIN_BI_ROOT: toPosixPath(root),
    SHEIN_BI_PORTAL_ROOT: toPosixPath(portalRoot),
    SHEIN_BI_PORTAL_SECTION_QUEUE_FILE: toPosixPath(queueFile),
    SHEIN_BI_PORTAL_SECTION_QUEUE_LOCK_FILE: lockFile,
    SHEIN_BI_PORTAL_SECTION_QUEUE_MAX_SECTIONS: String(maxSections),
    SHEIN_BI_PORTAL_SECTION_QUEUE_SECTION_TIMEOUT_SEC: '10',
    SHEIN_BI_PORTAL_SECTION_QUEUE_PRODUCT_SALES_DAILY_TIMEOUT_SEC: '600',
    SHEIN_BI_PORTAL_SECTION_QUEUE_PROFIT_MIN_RUNTIME_SEC: '630',
    SHEIN_BI_PORTAL_SECTION_QUEUE_PRODUCT_SALES_DAILY_MIN_RUNTIME_SEC: '630',
    SHEIN_BI_PORTAL_SECTION_QUEUE_HOME_RANKINGS_MIN_RUNTIME_SEC: '630',
    SHEIN_BI_PORTAL_SECTION_QUEUE_RANKINGS_MIN_RUNTIME_SEC: '630',
    SHEIN_BI_PORTAL_SECTION_QUEUE_INVENTORY_TREND_MIN_RUNTIME_SEC: '630',
    SHEIN_BI_PORTAL_SECTION_QUEUE_POST_PROFIT_HOME_RANKINGS_MIN_RUNTIME_SEC: '60',
    SHEIN_BI_PORTAL_SECTION_QUEUE_MIN_REMAINING_RUNTIME_SEC: '120',
    SHEIN_BI_PORTAL_SECTION_QUEUE_LEASE_SEC: String(leaseSeconds),
    SHEIN_BI_PORTAL_SECTION_QUEUE_SCHEDULED: String(scheduled),
    SHEIN_BI_PORTAL_SECTION_QUEUE_DEADLINE_EPOCH: String(deadlineEpoch + epochOffset),
    ...(deadlineMinute !== undefined ? {SHEIN_BI_PORTAL_SECTION_QUEUE_DEADLINE_MINUTE: String(deadlineMinute)} : {}),
    SHEIN_BI_PORTAL_SECTION_QUEUE_HEAVY_ALLOWED: String(heavyAllowed),
    SHEIN_BI_PORTAL_SECTION_QUEUE_HEAVY_FIRST: String(heavyFirst),
    SHEIN_TEST_PROFIT_HTTP: String(profitHttp),
    SHEIN_TEST_REQUEUE_PROFIT: requeueProfit ? '1' : '0',
    SHEIN_TEST_REMOVE_PROFIT_BEFORE_COMPLETE: removeProfitBeforeComplete ? '1' : '0',
    SHEIN_TEST_CURL_LOG: toPosixPath(curlLog),
  };
  const assignments = Object.entries(env)
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join('; ');
  const worker = toPosixPath(path.join(root, 'scripts', 'cloud_portal_section_queue_worker.sh'));
  const fakeBin = toPosixPath(binDir);
  const command = [
    `mkdir -p ${shellQuote(lockDir)} && chmod 2770 ${shellQuote(lockDir)}`,
    `chmod +x ${shellQuote(toPosixPath(path.join(binDir, 'date')))} ${shellQuote(toPosixPath(path.join(binDir, 'curl')))} ${shellQuote(worker)}`,
    assignments,
    `PATH=${shellQuote(fakeBin)}:"$PATH"; export PATH; exec ${shellQuote(worker)}`,
  ].join('; ');

  try {
    const run = await spawnCapture('bash', ['-c', command], {timeout: 60_000});
    const queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
    const calls = fs.existsSync(curlLog)
      ? fs.readFileSync(curlLog, 'utf8').split(/\r?\n/u).filter(Boolean)
      : [];
    assert.equal(run.timedOut, false, `${name} worker timed out: ${run.stderr}`);
    assert.equal(run.status, expectedStatus,
      `${name} unexpected worker exit: stdout=${run.stdout} stderr=${run.stderr}`);
    return {run, queue, calls};
  } finally {
    await spawnCapture('bash', ['-c',
      `rm -f ${shellQuote(lockFile)}; rmdir ${shellQuote(lockDir)} 2>/dev/null || true`,
    ], {timeout: 10_000});
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

async function testLargeReconciliationReports() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-enqueue-large-'));
  const fixture = path.join(dir, 'root');
  fs.mkdirSync(path.join(fixture, 'scripts', 'lib'), {recursive: true});
  fs.copyFileSync(path.join(root, 'scripts', 'enqueue_bi_portal_sections.sh'),
    path.join(fixture, 'scripts', 'enqueue_bi_portal_sections.sh'));
  // The fixture owns all files and supplies only lock setup, never production configuration.
  fs.writeFileSync(path.join(fixture, 'scripts', 'lib', 'shared_lock.sh'),
    'prepare_shared_lock_file() { mkdir -p -- "$(dirname -- "$1")"; touch -- "$1"; }\n');
  fs.writeFileSync(path.join(fixture, 'scripts', 'manage_bi_portal_section_queue.mjs'), `
import fs from 'node:fs';
const args=process.argv.slice(2),get=key=>args[args.indexOf(key)+1];
const phase=get('--phase'),mode=process.env.FIXTURE_RECONCILE_MODE;
fs.appendFileSync(process.env.SHEIN_BI_ROOT+'/phases.txt',phase+'\\n');
const snapshotHash='a'.repeat(64),validationResult=Buffer.from('valid').toString('base64url');
const padding='x'.repeat(1024*1024);
if(phase==='snapshot') {
  if(mode==='malformed') console.log('{');
  else console.log(JSON.stringify({ok:true,readyForValidation:mode!=='queued',snapshotHash,padding}));
} else if(phase==='validate') {
  if(get('--snapshot-hash')!==snapshotHash) throw Error('snapshot hash drift');
  console.log(JSON.stringify({ok:true,validationResult,padding}));
} else if(phase==='commit') {
  if(get('--snapshot-hash')!==snapshotHash||get('--validation-result')!==validationResult) throw Error('validation binding drift');
  console.log(JSON.stringify({ok:true,completed:true}));
} else throw Error('unexpected phase');
`);
  try {
    for (const mode of ['ready', 'queued', 'malformed']) {
      fs.writeFileSync(path.join(fixture, 'phases.txt'), '');
      const command = `env SHEIN_BI_ROOT=${shellQuote(toPosixPath(fixture))} FIXTURE_RECONCILE_MODE=${shellQuote(mode)} bash ${shellQuote(toPosixPath(path.join(fixture, 'scripts', 'enqueue_bi_portal_sections.sh')))} reconcile-generation --sections orders --core-generated-at G1`;
      const run = await spawnCapture('bash', ['-c', command]);
      assert.equal(run.timedOut, false);
      assert.equal(run.status, mode === 'malformed' ? 70 : 0, `${mode}: ${run.stderr}`);
      assert.deepEqual(fs.readFileSync(path.join(fixture, 'phases.txt'), 'utf8').trim().split('\n'),
        mode === 'ready' ? ['snapshot', 'validate', 'commit'] : ['snapshot']);
      if (mode === 'ready') assert.equal(JSON.parse(run.stdout).completed, true);
      if (mode === 'queued') assert.equal(JSON.parse(run.stdout).readyForValidation, false);
    }
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert(path.basename(dir).startsWith('bi-enqueue-large-'));
    assert(!fs.lstatSync(dir).isSymbolicLink());
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

const tools = spawnSync('bash', ['-lc', 'command -v flock >/dev/null && command -v mktemp >/dev/null && command -v node >/dev/null && command -v timeout >/dev/null'], {encoding: 'utf8'});
if (tools.status !== 0) {
  console.log('SKIP bi_portal_section_queue_window: worker integration needs bash+flock+mktemp+node');
} else {
  await testLargeReconciliationReports();
  const unscheduledEntry = await runWindowCase({
    name: 'unscheduled-direct-entry',
    hour: '14',
    minute: '17',
    nowEpoch: 1_000,
    deadlineEpoch: 2_000,
    scheduled: '0',
    heavyAllowed: 1,
    sections: ['orders'],
    maxSections: 1,
    expectedStatus: 75,
  });
  assert.deepEqual(unscheduledEntry.calls, [],
    'direct unscheduled worker invocation must defer with exit 75');
  assert.match(`${unscheduledEntry.run.stdout}\n${unscheduledEntry.run.stderr}`,
    /reason=unscheduled_direct_entry/,
    'direct unscheduled worker invocation must report explicit unscheduled diagnostic');

  const arbitraryMinuteHeavy = await runWindowCase({
    name: 'arbitrary-minute-1417',
    hour: '14',
    minute: '17',
    nowEpoch: 1_000,
    deadlineEpoch: 2_000,
    heavyAllowed: 1,
    sections: ['profit'],
    maxSections: 1,
    expectedStatus: 0,
  });
  assert.deepEqual(arbitraryMinuteHeavy.calls, ['profit'],
    'at arbitrary minute (14:17) outside legacy :32 slots, worker runs heavy section when scheduled and budget sufficient');
  assert.equal(arbitraryMinuteHeavy.queue.entries.some(entry => entry.section === 'profit'), false);

  const lightWindow = await runWindowCase({
    name: 'light-02',
    hour: '06',
    minute: '02',
    nowEpoch: 1_000,
    deadlineEpoch: 1_600,
    deadlineMinute: 14,
    heavyAllowed: 0,
    sections: ['profit', 'homeRankings', 'productSalesDaily', 'rankings', 'inventoryTrend', 'orders', 'waybills', 'afterSales'],
    maxSections: 8,
    expectedStatus: 75,
  });
  assert.deepEqual(lightWindow.calls, ['orders', 'waybills', 'afterSales'],
    'the :02 light window may claim multiple light sections serially but never heavy sections');
  assert.equal(new Set(lightWindow.calls).size, lightWindow.calls.length,
    'the :02 batch must not claim any section twice or run parallel duplicate work');
  assert.equal(lightWindow.queue.entries.some(entry => entry.section === 'profit' && entry.status === 'pending'), true,
    'the :02 light window must leave heavy profit pending');
  assert.equal(lightWindow.queue.entries.some(entry => entry.section === 'homeRankings' && entry.status === 'pending'), true,
    'the :02 light window must leave heavy homeRankings pending');
  for (const section of ['productSalesDaily', 'rankings', 'inventoryTrend']) {
    assert.equal(lightWindow.queue.entries.some(entry => entry.section === section && entry.status === 'pending'), true,
      `the :02 light window must leave heavy ${section} pending`);
  }
  for (const section of ['orders', 'waybills', 'afterSales']) {
    assert.equal(lightWindow.queue.entries.some(entry => entry.section === section), false,
      `the :02 light window must complete the light section it claimed: ${section}`);
  }
  assert.match(`${lightWindow.run.stdout}\n${lightWindow.run.stderr}`,
    /reason=short_reserved_window/,
    'the :02 worker must report the explicit light-only heavy deferral');

  const heavyInsufficientBudget = await runWindowCase({
    name: 'heavy-insufficient-budget',
    hour: '06',
    minute: '32',
    nowEpoch: 1_000,
    deadlineEpoch: 1_500,
    deadlineMinute: 44,
    heavyAllowed: 1,
    sections: ['productSalesDaily', 'rankings', 'inventoryTrend'],
    maxSections: 1,
    expectedStatus: 75,
  });
  assert.deepEqual(heavyInsufficientBudget.calls, [],
    'a heavy slot with less than 630 seconds must not claim accounting-heavy sections');
  assert.equal(heavyInsufficientBudget.queue.entries.every(entry => entry.status === 'pending'), true);

  const heavyWindow = await runWindowCase({
    name: 'heavy-32',
    hour: '06',
    minute: '32',
    nowEpoch: 1_000,
    deadlineEpoch: 2_000,
    deadlineMinute: 44,
    heavyAllowed: 1,
    sections: ['profit'],
    maxSections: 1,
    expectedStatus: 0,
  });
  assert.deepEqual(heavyWindow.calls, ['profit'],
    'a dedicated :32 window with sufficient remaining time may claim profit');
  assert.equal(heavyWindow.queue.entries.some(entry => entry.section === 'profit'), false,
    'the heavy profit claim must complete in the sufficient window');

  const heavyBeatsLinksData = await runWindowCase({
    name: 'heavy-beats-links-data',
    hour: '06',
    minute: '32',
    nowEpoch: 1_000,
    deadlineEpoch: 2_000,
    deadlineMinute: 44,
    heavyAllowed: 1,
    heavyFirst: 1,
    sections: ['linksData', 'profit'],
    maxSections: 1,
    expectedStatus: 0,
  });
  assert.deepEqual(heavyBeatsLinksData.calls, ['profit'],
    'the dedicated heavy slot must not spend its first claim on linksData');

  const lightPrioritizesLinksData = await runWindowCase({
    name: 'light-prioritizes-links-data',
    hour: '06',
    minute: '02',
    nowEpoch: 1_000,
    deadlineEpoch: 1_600,
    deadlineMinute: 14,
    heavyAllowed: 0,
    heavyFirst: 0,
    sections: ['orders', 'linksData'],
    maxSections: 1,
    expectedStatus: 75,
  });
  assert.deepEqual(lightPrioritizesLinksData.calls, ['linksData'],
    'the light slot must keep the homepage linksData refresh responsive');

  const rolloverWindow = await runWindowCase({
    name: 'immutable-slot-rollover',
    hour: '06',
    minute: '32',
    nowEpoch: 1_000,
    nowEpochs: [1_000, 1_995, 1_995],
    deadlineEpoch: 2_000,
    deadlineMinute: 44,
    rolloverHour: '07',
    rolloverDeadlineEpoch: 3_000,
    leaseSeconds: 1_200,
    heavyAllowed: 1,
    sections: ['orders'],
    artifactSections: ['orders'],
    maxSections: 1,
    expectedStatus: 1,
  });
  assert.deepEqual(rolloverWindow.calls, [],
    'a later wall-clock hour must not extend the immutable startup slot');
  assert.match(rolloverWindow.queue.entries.find(entry => entry.section === 'orders')?.lastError || '',
    /insufficient deadline budget/,
    'the rollover case must fail inside the original slot budget');

  const leaseBase = Math.floor(Date.now() / 1_000);
  const leaseCapped = await runWindowCase({
    name: 'lease-capped-deadline',
    hour: '06',
    minute: '32',
    nowEpoch: leaseBase,
    nowEpochs: [leaseBase, leaseBase, leaseBase + 31],
    deadlineEpoch: leaseBase + 200,
    deadlineMinute: 44,
    leaseSeconds: 30,
    heavyAllowed: 1,
    sections: ['orders'],
    artifactSections: ['orders'],
    maxSections: 1,
    expectedStatus: 1,
  });
  assert.deepEqual(leaseCapped.calls, [],
    'a lease deadline earlier than the slot must cap the refresh budget');
  assert.match(leaseCapped.queue.entries.find(entry => entry.section === 'orders')?.lastError || '',
    /insufficient deadline budget/,
    'the lease-capped case must fail before starting work after lease expiry');

  const clean200Unchanged = await runWindowCase({
    name: 'clean-200-unchanged-terminal',
    hour: '06',
    minute: '32',
    nowEpoch: 1_000,
    deadlineEpoch: 2_000,
    deadlineMinute: 44,
    heavyAllowed: 1,
    sections: ['orders'],
    artifactSections: ['orders'],
    maxSections: 1,
    expectedStatus: 0,
  });
  assert.deepEqual(clean200Unchanged.calls, ['orders'],
    'a clean 200 must retain the ordinary single refresh path');
  assert.equal(clean200Unchanged.queue.entries.some(entry => entry.section === 'orders'), false,
    'a clean 200 with an unchanged pre-request terminal artifact must complete');

  const largeQueueJson = await runWindowCase({
    name: 'large-queue-json-over-argv-limit',
    hour: '06',
    minute: '32',
    nowEpoch: 1_000,
    deadlineEpoch: 2_000,
    deadlineMinute: 44,
    heavyAllowed: 1,
    sections: ['orders'],
    artifactSections: ['orders'],
    maxSections: 1,
    expectedStatus: 0,
    queueSetup: queue => {
      // status/claim/complete all serialize the durable entries list.  This
      // fixture is deliberately larger than Linux's argv budget so the test
      // proves the worker keeps those JSON responses on stdin.
      queue.entries.push(...Array.from({length: 4_200}, (_, index) => ({
        section: `legacy${index}`,
        status: 'pending',
        priority: 99,
        sequence: 10_000 + index,
        requestRevision: 1,
        claimedRevision: 0,
        idempotencyKey: `legacy-${index}`,
        coalesceKey: `legacy-${index}`,
        coreGeneratedAt: generatedAt,
        requestedAt: '2026-08-22T00:00:00.000Z',
        lastError: 'x'.repeat(256),
      })));
    },
  });
  assert.deepEqual(largeQueueJson.calls, ['orders'],
    'a large durable queue must still claim and complete the requested section');
  assert.equal(largeQueueJson.queue.entries.some(entry => entry.section === 'orders'), false,
    'large-queue JSON parsing must not fail before terminal completion');

  const quietSuccess = await runWindowCase({
    name: 'quiet-success-post-profit',
    hour: '06',
    minute: '32',
    nowEpoch: 1_000,
    deadlineEpoch: 2_000,
    deadlineMinute: 44,
    heavyAllowed: 1,
    sections: ['profit', 'homeRankings'],
    maxSections: 2,
    expectedStatus: 0,
  });
  assert.deepEqual(quietSuccess.calls, ['profit', 'homeRankings'],
    'quiet same-run profit success may schedule homeRankings');
  assert.match(`${quietSuccess.run.stdout}\n${quietSuccess.run.stderr}`,
    /same-run completion eligible for post-profit homeRankings budgetSec=60/,
    'quiet same-run profit success must enable the explicit short budget');
  assert.equal(quietSuccess.queue.publishedSnapshots.some(snapshot => snapshot.section === 'homeRankings'), true);

  const followUp = await runWindowCase({
    name: 'follow-up-normal-budget',
    hour: '06',
    minute: '32',
    nowEpoch: 1_000,
    deadlineEpoch: 2_000,
    deadlineMinute: 44,
    heavyAllowed: 1,
    sections: ['profit', 'homeRankings'],
    maxSections: 2,
    expectedStatus: 75,
    requeueProfit: true,
  });
  assert.deepEqual(followUp.calls, ['profit'],
    'a superseded successful profit claim must not run homeRankings in the same worker run');
  assert.match(`${followUp.run.stdout}\n${followUp.run.stderr}`,
    /follow-up pending/,
    'the superseded profit completion must remain visible as follow-up pending');
  assert.doesNotMatch(`${followUp.run.stdout}\n${followUp.run.stderr}`,
    /same-run completion eligible for post-profit homeRankings budgetSec=60/,
    'follow-up pending must not enable the short budget');
  const followUpProfit = followUp.queue.entries.find(entry => entry.section === 'profit');
  assert.equal(followUpProfit?.dependencyYield, true,
    'superseded profit must retain the manager dependencyYield contract');
  assert.equal(followUp.queue.entries.some(entry => entry.section === 'homeRankings' && entry.status === 'pending'), true,
    'follow-up pending must leave homeRankings pending for a later run');

  const followUpFreshRun = await runWindowCase({
    name: 'follow-up-fresh-run-normal-630-budget',
    hour: '06',
    minute: '32',
    nowEpoch: 1_000,
    deadlineEpoch: 1_635,
    deadlineMinute: 44,
    heavyAllowed: 1,
    sections: ['profit', 'homeRankings'],
    maxSections: 1,
    expectedStatus: 0,
    queueSetup: queue => {
      const profit = queue.entries.find(entry => entry.section === 'profit');
      const homeRankings = queue.entries.find(entry => entry.section === 'homeRankings');
      profit.status = 'pending';
      profit.dependencyYield = true;
      profit.priority = 5;
      profit.sequence = 2;
      profit.requestRevision = 2;
      profit.lastPublishedRevision = 1;
      homeRankings.status = 'pending';
      homeRankings.priority = 5;
      homeRankings.sequence = 1;
    },
  });
  assert.deepEqual(followUpFreshRun.calls, ['homeRankings'],
    'a later run may claim homeRankings after dependencyYield, before the queued profit follow-up');
  assert.doesNotMatch(`${followUpFreshRun.run.stdout}\n${followUpFreshRun.run.stderr}`,
    /post-profit homeRankings budgetSec=60/,
    'the later dependency-yield run must retain the normal 630-second budget');

  for (const failure of [
    {
      name: 'refresh-failure-blocks-home-rankings',
      profitHttp: '500',
      artifactSections: ['profit', 'homeRankings'],
    },
    {
      name: 'terminal-failure-blocks-home-rankings',
      profitHttp: '200',
      artifactSections: ['homeRankings'],
    },
    {
      name: 'completion-report-failure-blocks-home-rankings',
      profitHttp: '200',
      artifactSections: ['profit', 'homeRankings'],
      removeProfitBeforeComplete: true,
    },
  ]) {
    const failed = await runWindowCase({
      name: failure.name,
      hour: '06',
      minute: '32',
      nowEpoch: 1_000,
      deadlineEpoch: 2_000,
      deadlineMinute: 44,
      heavyAllowed: 1,
      sections: ['profit', 'homeRankings'],
      maxSections: 2,
      expectedStatus: 1,
      profitHttp: failure.profitHttp,
      removeProfitBeforeComplete: failure.removeProfitBeforeComplete || false,
      artifactSections: failure.artifactSections,
    });
    assert.deepEqual(failed.calls, ['profit'], `${failure.name}: failed profit must be the only refresh attempt`);
    assert.match(`${failed.run.stdout}\n${failed.run.stderr}`, /profit_attempt_incomplete|completion report was not accepted|terminal evidence mismatch/,
      `${failure.name}: the worker must record the local profit failure barrier`);
    assert.equal(failed.queue.entries.some(entry => entry.section === 'homeRankings'), true,
      `${failure.name}: homeRankings must remain pending`);
  }

  console.log('bi_portal_section_queue_window: arbitrary-time queue admission, deadline-epoch propagation, quiet-success budget, follow-up normal budget, and failed-profit HR barriers passed');
}
