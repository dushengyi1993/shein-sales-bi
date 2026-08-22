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

function makeDateStub(binDir, {hour, minute, nowEpoch, deadlineEpoch}) {
  writeExecutable(path.join(binDir, 'date'), `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  +%H) printf '%s' '${hour}' ;;
  +%M) printf '%s' '${minute}' ;;
  +%s) printf '%s' '${nowEpoch}' ;;
  +%Y-%m-%dT%H) printf '%s' '2026-08-22T${hour}' ;;
  -d) printf '%s' '${deadlineEpoch}' ;;
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
{
  printf 'HTTP/1.1 200 OK\\r\\n'
  printf 'X-BI-Section-Cache-Hit: true\\r\\n'
  printf '\\r\\n'
} > "\${headers:?}"
printf '%s\\n' "\${section}" >> "\${SHEIN_TEST_CURL_LOG:?}"
printf '200'
`);
}

async function runWindowCase({
  name,
  hour,
  minute,
  nowEpoch,
  deadlineEpoch,
  deadlineMinute,
  heavyAllowed,
  sections,
  maxSections,
  expectedStatus,
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bi-portal-section-window-${name}-`));
  const lockDir = `/tmp/bi-portal-section-window-${process.pid}-${Date.now()}-${name}`;
  const lockFile = `${lockDir}/queue.lock`;
  const portalRoot = path.join(dir, 'portal');
  const binDir = path.join(dir, 'bin');
  const queueFile = path.join(dir, 'queue.json');
  const curlLog = path.join(dir, 'curl.log');
  fs.mkdirSync(binDir, {recursive: true});
  makePortal(portalRoot, sections);
  await seedStrictPortalArtifacts(portalRoot, binDir, sections);
  makeQueue(queueFile, sections, new Date('2026-08-22T00:00:00.000Z'));
  makeDateStub(binDir, {hour, minute, nowEpoch, deadlineEpoch});
  makeCurlStub(binDir);

  const env = {
    SHEIN_BI_ROOT: toPosixPath(root),
    SHEIN_BI_PORTAL_ROOT: toPosixPath(portalRoot),
    SHEIN_BI_PORTAL_SECTION_QUEUE_FILE: toPosixPath(queueFile),
    SHEIN_BI_PORTAL_SECTION_QUEUE_LOCK_FILE: lockFile,
    SHEIN_BI_PORTAL_SECTION_QUEUE_MAX_SECTIONS: String(maxSections),
    SHEIN_BI_PORTAL_SECTION_QUEUE_SECTION_TIMEOUT_SEC: '10',
    SHEIN_BI_PORTAL_SECTION_QUEUE_PROFIT_MIN_RUNTIME_SEC: '480',
    SHEIN_BI_PORTAL_SECTION_QUEUE_HOME_RANKINGS_MIN_RUNTIME_SEC: '540',
    SHEIN_BI_PORTAL_SECTION_QUEUE_MIN_REMAINING_RUNTIME_SEC: '120',
    SHEIN_BI_PORTAL_SECTION_QUEUE_LEASE_SEC: '60',
    SHEIN_BI_PORTAL_SECTION_QUEUE_SCHEDULED: '1',
    SHEIN_BI_PORTAL_SECTION_QUEUE_DEADLINE_MINUTE: String(deadlineMinute),
    SHEIN_BI_PORTAL_SECTION_QUEUE_HEAVY_ALLOWED: String(heavyAllowed),
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

const tools = spawnSync('bash', ['-lc', 'command -v flock >/dev/null && command -v mktemp >/dev/null && command -v node >/dev/null'], {encoding: 'utf8'});
if (tools.status !== 0) {
  console.log('SKIP bi_portal_section_queue_window: worker integration needs bash+flock+mktemp+node');
} else {
  const shortWindow = await runWindowCase({
    name: 'et-short',
    hour: '04',
    minute: '14',
    nowEpoch: 1_000,
    deadlineEpoch: 1_180,
    deadlineMinute: 17,
    heavyAllowed: 0,
    sections: ['profit', 'orders'],
    maxSections: 1,
    expectedStatus: 75,
  });
  assert.deepEqual(shortWindow.calls, ['orders'],
    'the ET :14 short window may claim the light section but never profit');
  assert.equal(shortWindow.queue.entries.some(entry => entry.section === 'profit' && entry.status === 'pending'), true,
    'the ET :14 short window must leave heavy profit pending');
  assert.equal(shortWindow.queue.entries.some(entry => entry.section === 'orders'), false,
    'the ET :14 short window must complete the light section it claimed');
  assert.equal(shortWindow.queue.publishedSnapshots.some(snapshot => snapshot.section === 'orders'), true,
    'the light section completion must still publish a durable snapshot');
  assert.match(`${shortWindow.run.stdout}\n${shortWindow.run.stderr}`,
    /reason=short_reserved_window/,
    'the ET :14 worker must report the explicit short-window heavy deferral');

  const longWindow = await runWindowCase({
    name: 'dedicated-long',
    hour: '04',
    minute: '44',
    nowEpoch: 1_000,
    deadlineEpoch: 2_000,
    deadlineMinute: 57,
    heavyAllowed: 1,
    sections: ['profit'],
    maxSections: 1,
    expectedStatus: 0,
  });
  assert.deepEqual(longWindow.calls, ['profit'],
    'a dedicated :44 window with sufficient remaining time may claim profit');
  assert.equal(longWindow.queue.entries.some(entry => entry.section === 'profit'), false,
    'the heavy profit claim must complete in the sufficient window');
  assert.equal(longWindow.queue.publishedSnapshots.some(snapshot => (
    snapshot.section === 'profit' && snapshot.publishedRevision === 1
  )), true, 'the heavy completion must record its publication revision');

  console.log('bi_portal_section_queue_window: ET short-window exclusion and sufficient-window heavy claim passed');
}
