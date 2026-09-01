#!/usr/bin/env node
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CLOUD_TIMER_UNITS} from '../lib/cloud_runtime_inventory.mjs';

const script = fs.readFileSync(new URL('./cloud_disk_maintenance.sh', import.meta.url), 'utf8');
const service = fs.readFileSync(new URL('../infra/systemd/shein-bi-cloud-disk-maintenance.service', import.meta.url), 'utf8');
const timer = fs.readFileSync(new URL('../infra/systemd/shein-bi-cloud-disk-maintenance.timer', import.meta.url), 'utf8');
const journal = fs.readFileSync(new URL('../infra/systemd/90-shein-bi-journald-disk-cap.conf', import.meta.url), 'utf8');
const watchdog = fs.readFileSync(new URL('./cloud_ops_watchdog.mjs', import.meta.url), 'utf8');
const scriptPath = fileURLToPath(new URL('./cloud_disk_maintenance.sh', import.meta.url));

assert.match(script, /PROFILE_CACHE_THRESHOLD_PERCENT:-80/);
assert.match(script, /OUTPUT_RETENTION_DAYS:-30/);
assert.match(script, /TMP_RETENTION_DAYS:-7/);
assert.match(script, /SHEIN_BI_BACKUP_OFFSITE_ENABLED:-1/);
assert.match(script, /invalid SHEIN_BI_BACKUP_OFFSITE_ENABLED=.*expected 0 or 1/);
assert.match(script, /readBrowserLeases[\s\S]*filter\(x=>x\.valid\)/);
assert.match(script, /pgrep -f 'chrome\|chromium\|playwright'/);
assert.match(script, /CacheStorage/);
assert.doesNotMatch(script, /['"](?:Cookies|Local Storage|IndexedDB)['"]/,
  'login and durable browser state must never be cleanup targets');
assert.match(script, /mountpoint -q "\$COS_MOUNT"/);
assert.match(script, /gzip -t "\$partial_archive"/);
assert.match(script, /tarfile\.open[\s\S]*actual != expected/);
assert.match(script, /changed_since_archive/);
assert.match(script, /target\.relative_to\(outputs\)/);
assert.match(script, /skip COS archive in local-only mode; old outputs retained/,
  'local-only disk maintenance must explicitly retain old outputs');
assert.ok(
  script.indexOf('skip COS archive in local-only mode') < script.indexOf('first_old=') &&
    script.indexOf('skip COS archive in local-only mode') < script.indexOf('if ! cos_ready'),
  'local-only mode must skip COS probing and archive/deletion selection before either path runs',
);
assert.ok(script.indexOf('mv -- "$partial_archive" "$archive"') < script.indexOf('target.unlink()'),
  'verified COS archive must exist before local output deletion');

assert.match(service, /^User=root$/m);
assert.match(service, /^Group=sheinops$/m);
assert.match(service, /^IOSchedulingClass=idle$/m);
assert.match(service, /^NoNewPrivileges=true$/m);
assert.match(service, /SHEIN_BI_PROFILE_CACHE_THRESHOLD_PERCENT=75/);
assert.match(service, /SHEIN_BI_BACKUP_OFFSITE_ENABLED=0/,
  'production disk maintenance must pin local-only mode');
assert.doesNotMatch(service, /SHEIN_BI_COS_(?:MOUNT|ARCHIVE_ROOT)=/,
  'local-only disk maintenance must not configure COS paths');
assert.match(service, /^Slice=shein-host-heavy-bi\.slice$/m);
assert.match(service, /^ExecStart=.*run_host_heavy_job\.sh.*--deadline-at 00:27.*cloud_disk_maintenance\.sh$/m);
assert.match(timer, /^OnCalendar=\*-\*-\* 00:10:00 Asia\/Shanghai$/m);
assert.match(timer, /^Persistent=false$/m);
assert.match(journal, /^SystemMaxUse=1G$/m);
assert.match(journal, /^SystemKeepFree=5G$/m);
assert.ok(CLOUD_TIMER_UNITS.includes('shein-bi-cloud-disk-maintenance.timer'));
assert.match(watchdog, /usedPercent >= 93/);
assert.match(watchdog, /usedPercent >= 88/);
assert.match(watchdog, /usedPercent >= 80/);
assert.match(watchdog, /服务器硬盘快满了/);

const windows = process.platform === 'win32';
const bash = [
  process.env.SHEIN_BI_TEST_BASH,
  ...(windows
    ? ['D:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe']
    : ['/bin/bash', '/usr/bin/bash']),
].find((candidate) => candidate && fs.existsSync(candidate));
assert.ok(bash, 'a real Bash runtime is required for dynamic disk-maintenance fixtures');

function runBash(command, args = [], options = {}) {
  const result = spawnSync(bash, ['-lc', command, '_', ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function toBashPath(value) {
  if (!windows) return value;
  const result = runBash('cygpath -u -- "$1"', [value]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shein-cloud-disk-contract-'));
const appRoot = path.join(fixtureRoot, 'app');
const outputRoot = path.join(appRoot, 'outputs');
const profilesRoot = path.join(appRoot, 'profiles');
const tmpRoot = path.join(appRoot, 'tmp');
const outsideRoot = path.join(fixtureRoot, 'outside');
const logRoot = path.join(fixtureRoot, 'logs');
const binRoot = path.join(fixtureRoot, 'bin');
const scriptFixture = path.join(appRoot, 'scripts');
const libFixture = path.join(scriptFixture, 'lib');
const rootLibFixture = path.join(appRoot, 'lib');
const lockRoot = path.join(appRoot, 'state', 'locks');
const cosRoot = path.join(fixtureRoot, 'cos');
fs.mkdirSync(outputRoot, {recursive: true});
fs.mkdirSync(profilesRoot, {recursive: true});
fs.mkdirSync(tmpRoot, {recursive: true});
fs.mkdirSync(outsideRoot, {recursive: true});
fs.mkdirSync(logRoot, {recursive: true});
fs.mkdirSync(binRoot, {recursive: true});
fs.mkdirSync(libFixture, {recursive: true});
fs.mkdirSync(rootLibFixture, {recursive: true});
fs.mkdirSync(lockRoot, {recursive: true});
fs.copyFileSync(new URL('./lib/shared_lock.sh', import.meta.url), path.join(libFixture, 'shared_lock.sh'));
fs.copyFileSync(new URL('../lib/browser_task_lease.mjs', import.meta.url), path.join(rootLibFixture, 'browser_task_lease.mjs'));
fs.writeFileSync(path.join(binRoot, 'flock'), '#!/usr/bin/env bash\nexit 0\n', 'utf8');
fs.writeFileSync(path.join(binRoot, 'pgrep'), '#!/usr/bin/env bash\nexit 1\n', 'utf8');
const testPython = process.env.SHEIN_BI_TEST_PYTHON
  || (windows
    ? 'C:\\Users\\dushengyi\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe'
    : '/usr/bin/python3');
assert.ok(fs.existsSync(testPython), `a real Python runtime is required for dynamic disk fixtures: ${testPython}`);
fs.writeFileSync(path.join(binRoot, 'python3'), `#!/usr/bin/env bash\nexec "${toBashPath(testPython)}" "$@"\n`, 'utf8');
fs.writeFileSync(path.join(binRoot, 'stat'), [
  '#!/usr/bin/env bash',
  'if [[ "${1:-}" == "-c" && "${2:-}" == "%a" ]]; then',
  '  target="${@: -1}"',
  '  [[ "$target" == *"maintenance.lock" ]] && printf "660\\n" || printf "2770\\n"',
  '  exit 0',
  'fi',
  'exec /usr/bin/stat "$@"',
  '',
].join('\n'), 'utf8');
fs.chmodSync(path.join(binRoot, 'flock'), 0o755);
fs.chmodSync(path.join(binRoot, 'pgrep'), 0o755);
fs.chmodSync(path.join(binRoot, 'python3'), 0o755);
fs.chmodSync(path.join(binRoot, 'stat'), 0o755);

function oldFile(file, ageDays, value = 'fixture') {
  fs.writeFileSync(file, value, 'utf8');
  const old = new Date(Date.now() - ageDays * 24 * 3600 * 1000);
  fs.utimesSync(file, old, old);
}

function diskEnv(overrides = {}) {
  const env = {
    ...process.env,
    PATH: `${toBashPath(binRoot)}${windows ? ';' : ':'}${process.env.PATH || ''}`,
    SHEIN_BI_ROOT: toBashPath(appRoot),
    SHEIN_BI_OUTPUT_DIR: toBashPath(outputRoot),
    SHEIN_BI_PROFILES_DIR: toBashPath(profilesRoot),
    SHEIN_BI_COS_MOUNT: toBashPath(path.join(fixtureRoot, 'missing-cos-mount')),
    SHEIN_BI_COS_ARCHIVE_ROOT: toBashPath(cosRoot),
    SHEIN_BI_DISK_MAINTENANCE_LOG_DIR: toBashPath(logRoot),
    SHEIN_BI_DISK_MAINTENANCE_LOCK_FILE: toBashPath(path.join(lockRoot, 'maintenance.lock')),
    SHEIN_BI_OUTPUT_RETENTION_DAYS: '30',
    SHEIN_BI_TMP_RETENTION_DAYS: '7',
    SHEIN_BI_PROFILE_CACHE_THRESHOLD_PERCENT: '0',
    SHEIN_BI_BACKUP_OFFSITE_ENABLED: '0',
    SHEIN_BI_SHARED_LOCK_GROUP: 'missing-sheinops-group',
    ...overrides,
  };
  return env;
}

function runDisk(args = [], options = {}) {
  return runBash('PATH="$1:$PATH"; export PATH; shift; script="$1"; shift; bash "$script" "$@"', [
    toBashPath(binRoot),
    toBashPath(scriptPath),
    ...args,
  ], options);
}

try {
  // Positive local-only run: profile cache and stale tmp are reclaimed, while
  // old outputs and the absent COS tree remain untouched.
  const oldOutput = path.join(outputRoot, 'old-output.json');
  const oldTmp = path.join(tmpRoot, 'old.tmp');
  const cacheDir = path.join(profilesRoot, 'Default', 'Cache');
  fs.mkdirSync(path.dirname(cacheDir), {recursive: true});
  fs.mkdirSync(cacheDir, {recursive: true});
  fs.writeFileSync(path.join(cacheDir, 'cache.bin'), 'reclaimable', 'utf8');
  oldFile(oldOutput, 31, 'must remain local');
  oldFile(oldTmp, 8, 'stale tmp');
  const localRun = runDisk([], {env: diskEnv()});
  assert.equal(localRun.status, 0, `${localRun.stderr}\nstdout:\n${localRun.stdout}`);
  assert.match(localRun.stdout, /\[outputs\] skip COS archive in local-only mode; old outputs retained/);
  assert.ok(fs.existsSync(oldOutput), 'local-only mode must retain old outputs');
  assert.equal(fs.existsSync(oldTmp), false, 'local-only mode must continue controlled tmp cleanup');
  assert.equal(fs.existsSync(cacheDir), false, 'local-only mode must continue profile cache cleanup');
  assert.equal(fs.existsSync(cosRoot), false, 'local-only mode must not create a COS archive root');

  // Dry-run is a positive no-delete path for the remaining local maintenance.
  const dryTmp = path.join(tmpRoot, 'dry-run.tmp');
  oldFile(dryTmp, 8, 'dry-run retained');
  const dryRun = runDisk(['--dry-run'], {env: diskEnv()});
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.ok(fs.existsSync(dryTmp), 'dry-run must retain selected tmp files');

  // Invalid offsite values fail before any cleanup work.
  const invalidBool = runDisk([], {
    env: diskEnv({SHEIN_BI_BACKUP_OFFSITE_ENABLED: 'maybe'}),
  });
  assert.equal(invalidBool.status, 64, invalidBool.stderr);
  assert.match(invalidBool.stderr, /invalid SHEIN_BI_BACKUP_OFFSITE_ENABLED=.*expected 0 or 1/);
  assert.ok(fs.existsSync(dryTmp), 'invalid mode must not run cleanup');

  // Lexical path boundaries remain fail-closed even though local-only output
  // archiving is skipped: paths outside ROOT must not be accepted as cleanup
  // domains.
  const outsideOutput = path.join(outsideRoot, 'outside-output');
  fs.mkdirSync(outsideOutput, {recursive: true});
  const outsideFile = path.join(outsideOutput, 'must-remain');
  oldFile(outsideFile, 31, 'outside fixture');
  const outsideRun = runDisk([], {
    env: diskEnv({SHEIN_BI_OUTPUT_DIR: toBashPath(outsideOutput)}),
  });
  assert.equal(outsideRun.status, 73, outsideRun.stderr);
  assert.ok(fs.existsSync(outsideFile), 'an output path outside ROOT must never be touched');
} finally {
  fs.rmSync(fixtureRoot, {recursive: true, force: true});
}

console.log(JSON.stringify({ok: true, checks: 36}, null, 2));
