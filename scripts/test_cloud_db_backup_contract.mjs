#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fs.readFileSync(new URL('./cloud_db_backup.sh', import.meta.url), 'utf8');
const service = fs.readFileSync(new URL('../infra/systemd/shein-bi-db-backup.service', import.meta.url), 'utf8');
const scriptPath = fileURLToPath(new URL('./cloud_db_backup.sh', import.meta.url));

assert.match(script, /BACKUP_RETENTION_DAYS:-7/);
assert.match(script, /--prune-only/);
assert.match(script, /SHEIN_BI_MANUAL_LIMITED_DISCOUNT_REGISTRY:-\/srv\/shein-bi\/runtime\/marketing_manual_limited_discount_overrides\.json/);
assert.match(script, /marketing_manual_limited_discount_overrides\.json/);
assert.match(script, /SHEIN_BI_BROWSER_STATE_BACKUP_ENABLED:-1/);
assert.match(script, /SHEIN_BI_BROWSER_STATE_LIMIT_TOTAL_BYTES:-8g/);
assert.match(script, /--limit-total-bytes "\$BROWSER_STATE_LIMIT_TOTAL_BYTES"/);
assert.match(script, /node \"\$MANAGE_BROWSER_STATE\" create/);
assert.match(script, /node \"\$MANAGE_BROWSER_STATE\" verify/);
assert.match(script, /--source "profiles=\$BROWSER_PROFILE_ROOT"/);
assert.match(script, /--source \"state\/shein_webapi_sessions=\$BROWSER_SESSION_ROOT\"/);
assert.equal(script.includes('--optional-source \"state/shein_webapi_sessions'), false,
  'the WebAPI session root must be a mandatory source in production');
assert.match(script, /browser session root missing: \$BROWSER_SESSION_ROOT/,
  'a missing session root must abort with a non-zero exit before any success marker');
assert.match(script, /verify_browser_state_receipt \"\$OUT_STAGING\/browser-state\.create\.json\"/,
  'create receipts must be validated before the backup can continue');
assert.ok(
  script.indexOf('\"$MANAGE_BROWSER_STATE\" create')
    < script.indexOf('\"$MANAGE_BROWSER_STATE\" verify'),
  'encrypted profile creation must be followed by full authenticated verification',
);
assert.match(script, /find \. -mindepth 1 -maxdepth 1 -type f ! -name 'SHA256SUMS\.txt'/,
  'all backup artifacts and receipts must enter the outer checksum manifest');
assert.match(script, /mountpoint -q "\$COS_MOUNT"/);
assert.match(script, /find \. -mindepth 1 -maxdepth 1 -type f ! -name 'SHA256SUMS\.txt' -printf '%P\\0'/,
  'new checksum manifests must contain sorted top-level relative paths');
assert.match(script, /sha256sum -c -- SHA256SUMS\.txt/,
  'the local backup must pass its relative checksum manifest before archiving');
assert.match(script, /verify_archive_payload "\$archive" "\$base" "\$source_dir\/SHA256SUMS\.txt"/,
  'an existing archive must receive full per-entry content verification');
assert.match(script, /member\.isreg\(\)/,
  'archive members other than the root directory must be regular files');
assert.match(script, /archive inventory mismatch/,
  'missing and extra archive members must fail closed');
assert.match(script, /archive member checksum mismatch/,
  'archive member bytes must be hashed against the embedded manifest');
assert.match(script, /O_NOFOLLOW/,
  'archive verification must not follow a symlink archive path');
assert.match(script, /retention skipped: COS unavailable; local backups preserved/);
assert.ok(script.includes("printf '%s  %s\\n' \"$archive_digest\" \"$(basename \"$archive\")\""),
  'the COS sidecar is written from the verification digest');
assert.ok(
  script.indexOf("printf '%s  %s\\n' \"$archive_digest\" \"$(basename \"$archive\")\"") < script.indexOf('rm -rf -- "$quarantine"'),
  'the COS sidecar must be written before any local backup deletion',
);
const manifestCreation = 'xargs -0 -r sha256sum -- > SHA256SUMS.txt';
assert.notEqual(script.indexOf(manifestCreation), -1, 'relative manifest creation command must exist');
assert.ok(
  script.indexOf('archive_verified "$OUT_DIR" 0') > script.indexOf(manifestCreation),
  'the same-day backup must be mirrored offsite only after its complete checksum manifest exists',
);
assert.match(script, /same-day offsite terminal=exhausted.*reason=cos-unavailable.*local-preserved=/,
  'COS exhaustion must preserve the local backup and end non-successfully');
assert.match(service, /SHEIN_BI_BACKUP_RETENTION_DAYS=7/);
assert.match(script, /SHEIN_BI_REMOTE_VERIFY_CMD/);
assert.match(script, /independent remote verifier not configured; persistence gate fails closed reason=remote-verifier-missing/,
  'without an independent verifier the complete persistence gate fails closed');
assert.match(script, /remote-ok \$digest \$size/, 'the independent remote verifier contract must be explicit');
assert.match(script, /verify_independent_remote/, 'the local-deletion gate must call the independent remote verifier');
assert.match(script, /verify_independent_remote_with_retry/, 'same-run remote confirmation must have a bounded retry loop');
assert.match(script, /SHEIN_BI_REMOTE_VERIFY_MAX_ATTEMPTS:-3/, 'remote verification defaults to a small bounded attempt count');
assert.match(script, /SHEIN_BI_REMOTE_VERIFY_RETRY_INTERVAL_SEC:-30/, 'remote verification has a configurable retry interval');
assert.match(script, /SHEIN_BI_REMOTE_VERIFY_TIMEOUT_SEC:-600/, 'each verifier command has a 600s bounded default timeout matching the hard cap');
assert.match(script, /SHEIN_BI_REMOTE_VERIFY_KILL_AFTER_SEC:-5/, 'a verifier ignoring TERM receives a bounded hard-kill grace period');
assert.match(script, /REMOTE_VERIFY_HARD_MAX_ATTEMPTS=10/, 'operator configuration itself must remain bounded');
assert.match(script, /REMOTE_VERIFY_HARD_MAX_TIMEOUT_SEC=600/);
assert.match(script, /REMOTE_VERIFY_HARD_MAX_KILL_AFTER_SEC=60/);
assert.match(script, /REMOTE_VERIFY_EXHAUSTED_STATUS=74/, 'retry exhaustion must use a real service failure status');
assert.match(script, /REMOTE_VERIFY_CONFIG_STATUS=78/, 'missing verifier configuration must be a distinct service failure');
assert.ok(
  script.indexOf('command_status == REMOTE_VERIFY_CONFIG_STATUS')
    < script.indexOf('reason=remote-verifier-output-flood'),
  'the 78 config check must run BEFORE the stdout flood gate so a config 78 (even with noisy stdout) is never downgraded or flooded',
);
assert.match(script, /Calls are foreground and serial/, 'retry attempts must remain serial under the existing outer locks');
assert.match(script, /timeout --foreground --signal=TERM[\s\S]*--kill-after=/,
  'every external verifier call must have foreground TERM/KILL bounds');
assert.match(script, /SHEIN_BI_REMOTE_VERIFY_CMD[\s\S]*2>\/dev\/null/,
  'verifier diagnostics must never be copied to service logs');
assert.match(script, /normalize_bounded_decimal_config/);
assert.match(script, /normalized=\$\(\(10#\$raw\)\)/,
  'validated decimals must be explicitly normalized as base 10');
assert.match(script, /RETENTION_HARD_MAX_DAYS=3650/);
assert.match(script, /STALE_STAGING_HARD_MAX_MINUTES=10080/);
assert.ok(script.indexOf('validate_numeric_config || exit $?') < script.indexOf('cleanup_stale_staging()'),
  'numeric environment values must be rejected before cleanup arithmetic or find');
assert.match(script, /capture_dir_identity/, 'publish/delete must bind the COS mount identity');
assert.match(script, /\.mount-id/, 'the publish-time mount identity must be persisted for later delete runs');
assert.match(script, /\.pending-/, 'staging directories are name-scoped under .pending-');
assert.equal(script.includes('mkdir -p \"$OUT_DIR\"'), false, 'an intermediate run must never create the final OUT_DIR early');
assert.match(script, /cleanup_stale_staging/, 'failed-run staging cleanup must be bounded');
assert.match(script, /trap cleanup_current_staging EXIT/, 'an abnormal exit must remove the current staging dir');
assert.match(script, /STAGING_PUBLISHED=1/, 'publication must be atomic after every stage passes');
assert.ok(script.includes('echo "[cloud_db_backup] final backup collision: $OUT_DIR" >&2'),
  'an existing final backup directory must fail closed instead of receiving a nested staging directory');
assert.ok(script.includes('mv -T -- "$OUT_STAGING" "$OUT_DIR"'),
  'local backup publication must treat OUT_DIR as the exact target, never as a container directory');
assert.ok(script.includes(`staging_identity="$(stat -c '%d:%i' -- "$OUT_STAGING")"`),
  'local backup publication must bind the exact staging dev:ino before rename');
assert.ok(script.includes(`"$(stat -c '%d:%i' -- "$OUT_DIR" 2>/dev/null)" != "$staging_identity"`),
  'local backup publication must read back the exact staging dev:ino at the final path');
assert.match(script, /--test-check-receipt/);
assert.match(script, /--test-staging-cleanup/);
assert.match(script, /--test-staging-trap/);
assert.match(script, /tar -C \"\$root_real\" -cf \"\$partial\" \"\$base\"/,
  'already-compressed dump members must not be gzipped a second time');
assert.equal(script.includes(' -czf '), false, 'the COS archive must never re-gzip already-compressed members');
assert.match(script, /archive=\"\$archive_dir\/\$base\.tar\"/, 'the store archive uses the .tar suffix');
assert.match(script, /mode=\"r:\"/);
const remoteReadbackCall = /verify_independent_remote_with_retry "\$rel" "\$archive_digest" "\$remote_size" (?:post-publish|pre-delete)/g;
const remoteReadbackCalls = [...script.matchAll(remoteReadbackCall)];
assert.equal(remoteReadbackCalls.length, 2, 'remove_after=1 must have a distinct final independent remote readback');
assert.ok(remoteReadbackCalls[1].index > script.lastIndexOf('! validate_local_backup "$source_dir"'),
  'the pre-delete remote readback must follow the slow local full-content validation');
assert.ok(remoteReadbackCalls[1].index < script.indexOf('rm -rf -- "$quarantine"'),
  'the second independent readback must be the final remote deletion gate');

// The local deletion path must quarantine first, then re-verify the locked
// identity, then remove only the re-verified quarantine.  A path swap that
// lands after the final identity check can therefore never delete either the
// originally verified directory or the replacement.
assert.ok(script.includes('quarantine="$root_real/.quarantine-$base-$STAMP-$$"'),
  'deletion must atomically rename through a unique hidden quarantine in the same parent');
assert.ok(script.includes('mv -T -- "$source_dir" "$quarantine"'),
  'quarantine rename must treat its destination as an exact path, never as an existing directory container');
assert.ok(script.includes('reason=quarantine-rename-failed'),
  'a failed quarantine rename must fail closed and preserve the source');
assert.ok(script.includes('reason=quarantine-identity-drift'),
  'the quarantine must be re-verified against the locked inode/content identity');
assert.ok(script.includes('quarantined_manifest_digest'),
  'the quarantined checksum manifest must be re-checked after the rename');
assert.ok(script.includes('rm -rf -- "$quarantine"'),
  'only the re-verified quarantine may be removed');
const gatedSourceDrift = script.indexOf('reason=source-identity-drifted-at-final-delete-gate');
const gatedParentCheck = script.indexOf('reason=delete-parent-not-secure');
const gatedHookCall = script.indexOf('after_final_identity_before_quarantine "$source_dir"');
const gatedQuarantineName = script.indexOf('quarantine="$root_real/.quarantine-');
const gatedQuarantineDrift = script.indexOf('reason=quarantine-identity-drift');
const gatedFinalRemove = script.indexOf('rm -rf -- "$quarantine"');
assert.ok(gatedSourceDrift !== -1 && gatedSourceDrift < gatedParentCheck,
  'the final source-identity gate must run before the parent-security gate');
assert.ok(gatedParentCheck < gatedHookCall,
  'the parent-security gate must run before the test-only path-swap hook');
assert.ok(gatedHookCall < gatedQuarantineName,
  'the after-final-identity-before-quarantine hook must land after final identity and before the quarantine rename');
assert.ok(gatedQuarantineName < gatedQuarantineDrift,
  'the quarantine rename must precede its re-verification');
assert.ok(gatedQuarantineDrift < gatedFinalRemove,
  'only a re-verified quarantine may be removed');

// The retention root must be root-owned with group/other non-writable bits;
// the octal comparison must be explicit so stat strings never enter a
// decimal/unguarded arithmetic context.
assert.ok(script.includes('delete-parent-not-secure'),
  'deletion must fail closed when the retention root is not root-owned or is group/other-writable');
assert.ok(script.includes('8# 22') || script.includes('8#22'),
  'parent permission bits must be compared in explicit octal');
assert.ok(script.includes('8#$mode'),
  'the parent mode must be parsed with an explicit octal base');
assert.ok(script.includes('SHEIN_BI_BACKUP_TEST_ALLOW_INSECURE_DELETE_PARENT'),
  'the parent-security bypass must be an explicit test-only escape');
assert.ok(script.includes('after_final_identity_before_quarantine'),
  'the after-final-identity-before-quarantine test hook must exist');
assert.ok(script.includes('SHEIN_BI_BACKUP_TEST_SWAP_AFTER_FINAL_IDENTITY'),
  'the path-swap hook trigger must be explicit and test-scoped');
assert.ok(script.includes('SHEIN_BI_BACKUP_TEST_MODE:-0'),
  'the path-swap hook must be gated behind the existing test mode');
// The existing unit treats 75 as successful, so every terminal remote failure
// from this script must be 74/78 (or another ordinary failure), never 75.
assert.doesNotMatch(script, /\b(?:exit|return)\s+75\b/,
  'cloud_db_backup.sh must never self-defer with service-success status 75');
assert.match(script, /set -Eeuo pipefail/, 'any stage failure must be a real non-zero exit');
assert.match(service, /SuccessExitStatus=75/, 'the unchanged unit still makes status selection security-relevant');
assert.doesNotMatch(service, /SuccessExitStatus=.*(?:74|78)/, '74 and 78 must remain service failures');
assert.match(service, /run_host_heavy_job\.sh --domain db-backup[\s\S]*flock[\s\S]*cloud_db_backup\.sh/,
  'the one foreground script invocation must remain under host/project/domain and maintenance locks');
assert.match(service, /Environment=SHEIN_BI_REMOTE_VERIFY_CMD=\/opt\/shein-bi\/app\/scripts\/verify_cos_backup_remote\.sh/,
  'production service now wires the repository launcher as the independent verifier');
assert.match(service, /SHEIN_BI_BACKUP_COS_MOUNT=\/lhcos-data/);
assert.match(service, /SHEIN_BI_BACKUP_COS_ARCHIVE_ROOT=\/lhcos-data\/shein-bi-db-backups/);
assert.match(service, /SHEIN_BI_BROWSER_STATE_BACKUP_ENABLED=1/);
assert.match(service, /SHEIN_BI_BROWSER_STATE_BACKUP_KEY_FILE=\/srv\/shein-bi\/secrets\/browser-state-backup\.key/);
assert.match(service, /SHEIN_BI_BROWSER_STATE_LIMIT_TOTAL_BYTES=8g/);
assert.match(service, /SHEIN_BI_BROWSER_PROFILE_ROOT=\/data\/shein-bi\/profiles/);
assert.match(service, /SHEIN_BI_BROWSER_SESSION_ROOT=\/data\/shein-bi\/state\/shein_webapi_sessions/);

const windows = process.platform === 'win32';
const bash = [
  process.env.SHEIN_BI_TEST_BASH,
  ...(windows
    ? ['D:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe']
    : ['/bin/bash', '/usr/bin/bash']),
].find((candidate) => candidate && fs.existsSync(candidate));
assert.ok(bash, 'a real Bash runtime is required for dynamic cloud backup contract fixtures');
const python = process.env.SHEIN_BI_TEST_PYTHON
  || (windows
    ? 'C:\\Users\\dushengyi\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe'
    : '/usr/bin/python3');
assert.ok(fs.existsSync(python), 'a real Python runtime is required for dynamic archive verification');

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

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function manifestFor(entries) {
  return Object.entries(entries)
    .sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
    .map(([name, value]) => `${sha256(value)}  ${name}\n`)
    .join('');
}

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shein-cloud-backup-contract-'));
const backupRoot = path.join(fixtureRoot, 'backups');
const cosRoot = path.join(fixtureRoot, 'cos');
fs.mkdirSync(backupRoot, { recursive: true });
fs.mkdirSync(cosRoot, { recursive: true });

const bashScriptPath = toBashPath(scriptPath);
const bashBackupRoot = toBashPath(backupRoot);
const bashCosRoot = toBashPath(cosRoot);
const bashPython = toBashPath(python);

const remoteStore = path.join(fixtureRoot, 'remote-store');
const verifierRoot = path.join(fixtureRoot, 'verifier');
fs.mkdirSync(remoteStore, { recursive: true });
fs.mkdirSync(verifierRoot, { recursive: true });
const bashRemoteStore = toBashPath(remoteStore);

// A fake independent remote verifier.  It reads a SEPARATE storage tree
// (remoteStore) -- never the local FUSE write path (cosRoot) -- and confirms
// the expected sha256 + size, printing the 'remote-ok' contract line.  This
// is exactly the independent validator the production hook must provide;
// without it the deletion gate fails closed.
const verifierScript = [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  'rel="$1"; expected="$2"; expected_size="$3"',
  'counter_file="${REMOTE_VERIFY_COUNTER_FILE:-}"',
  'if [[ -n "$counter_file" ]]; then',
  '  if [[ -n "${REMOTE_VERIFY_OVERLAP_FILE:-}" ]]; then',
  '  active_dir="${counter_file}.active"',
  '  if ! mkdir -- "$active_dir"; then',
  '    [[ -n "${REMOTE_VERIFY_OVERLAP_FILE:-}" ]] && printf "overlap\\n" > "$REMOTE_VERIFY_OVERLAP_FILE"',
  '    exit 91',
  '  fi',
  '  cleanup_active() { rmdir -- "$active_dir"; }',
  '  trap cleanup_active EXIT',
  '  fi',
  '  count=0',
  '  [[ ! -s "$counter_file" ]] || read -r count < "$counter_file"',
  '  count=$(( count + 1 ))',
  '  printf "%s\\n" "$count" > "$counter_file"',
  '  [[ "${REMOTE_VERIFY_HOLD_SEC:-0}" == "0" ]] || sleep "$REMOTE_VERIFY_HOLD_SEC"',
  '  if (( count <= ${REMOTE_VERIFY_HANG_UNTIL:-0} )); then',
  '    echo "hung-verifier-secret-fixture" >&2',
  '    trap "" TERM',
  '    while :; do sleep 1; done',
  '  fi',
  '  if (( count <= ${REMOTE_VERIFY_FAIL_UNTIL:-0} )); then',
  '    echo "signed-url-secret-fixture" >&2',
  '    exit 42',
  '  fi',
  'fi',
  'mode="${REMOTE_VERIFY_FIXTURE_MODE:-}"',
  'if [[ "$mode" == "config78" ]]; then',
  '  echo "config-error-secret-fixture" >&2',
  '  exit 78',
  'fi',
  'if [[ "$mode" == "config78-noise" ]]; then',
  '  echo "noise-before-config-error"',
  '  echo "config-error-secret-fixture" >&2',
  '  exit 78',
  'fi',
  'if [[ "$mode" == "exhaust" ]]; then',
  '  echo "exhausted-verifier-secret-fixture" >&2',
  '  exit 1',
  'fi',
  'object="$REMOTE_COS_STORE/$rel"',
  'if [[ ! -s "$object" ]]; then echo "remote object missing: $rel" >&2; exit 1; fi',
  'actual="$(sha256sum -- "$object" | cut -d" " -f1)"',
  'actual_size="$(stat -c %s -- "$object")"',
  '[[ "$actual" == "$expected" && "$actual_size" == "$expected_size" ]] || { echo "remote object mismatch: $rel" >&2; exit 1; }',
  'if [[ "$mode" == "leading-noise" ]]; then',
  '  printf "leading-noise-line\\n"',
  'fi',
  'if [[ "$mode" == "flood" ]]; then',
  '  head -c 4096 /dev/zero | tr "\\0" "x"',
  'fi',
  'echo "remote-ok $expected $expected_size"',
  'if [[ -n "${REMOTE_VERIFY_SWAP_SOURCE_DIR:-}" ]] && [[ -n "$counter_file" ]] && (( count == ${REMOTE_VERIFY_SWAP_AFTER_COUNT:-0} )); then',
  '  mv -- "$REMOTE_VERIFY_SWAP_SOURCE_DIR" "$REMOTE_VERIFY_SWAP_SOURCE_DIR.swap-orig"',
  '  cp -a -- "$REMOTE_VERIFY_SWAP_SOURCE_CLONE" "$REMOTE_VERIFY_SWAP_SOURCE_DIR"',
  'fi',
  'if [[ "$mode" == "trailing-blank" ]]; then',
  '  printf "\\n"',
  'fi',
  'if [[ -n "$counter_file" ]] && (( count == ${REMOTE_VERIFY_DRIFT_AFTER_COUNT:-0} )); then',
  '  printf "remote-object-drift-after-confirmation" > "$object"',
  'fi',
].join('\n');
const verifierPath = path.join(verifierRoot, 'remote-verify.sh');
fs.writeFileSync(verifierPath, verifierScript, 'utf8');
fs.chmodSync(verifierPath, 0o755);
const bashVerifier = toBashPath(verifierPath);
// A stub lets the prune/retention path pass the cos_ready gate deterministically
// on every host. Only used when the prune scenario sets it.
const mountpointStub = path.join(verifierRoot, 'mountpoint');
fs.writeFileSync(mountpointStub, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
fs.chmodSync(mountpointStub, 0o755);
const bashMountpointStub = toBashPath(verifierRoot);

function createSource(name, entries, manifest = manifestFor(entries)) {
  const source = path.join(backupRoot, name);
  fs.mkdirSync(source);
  for (const [fileName, value] of Object.entries(entries)) {
    fs.writeFileSync(path.join(source, fileName), value);
  }
  fs.writeFileSync(path.join(source, 'SHA256SUMS.txt'), manifest, 'ascii');
  return source;
}
function envFor({
  remote = true,
  maxAttempts = '3',
  intervalSec = '0',
  timeoutSec = '5',
  killAfterSec = '1',
  counterFile = '',
  failUntil = '0',
  hangUntil = '0',
  driftAfterCount = '0',
  overlapFile = '',
  holdSec = '0',
  fixtureMode = '',
  pruneMountOkay = false,
  swapSourceDir = '',
  swapClone = '',
  swapAfterCount = '0',
  testSwapAfterFinalIdentity = false,
  allowInsecureDeleteParent = true,
} = {}) {
  const env = {
    ...process.env,
    SHEIN_BI_BACKUP_TEST_MODE: '1',
    SHEIN_BI_BACKUP_ROOT: bashBackupRoot,
    SHEIN_BI_BACKUP_COS_ARCHIVE_ROOT: bashCosRoot,
    SHEIN_BI_BACKUP_COS_MOUNT: bashCosRoot,
    SHEIN_BI_TZ: 'Asia/Shanghai',
    SHEIN_BI_BACKUP_PYTHON: bashPython,
    SHEIN_BI_BACKUP_RETENTION_DAYS: '7',
    SHEIN_BI_BACKUP_STALE_STAGING_MINUTES: '30',
    SHEIN_BI_REMOTE_VERIFY_MAX_ATTEMPTS: maxAttempts,
    SHEIN_BI_REMOTE_VERIFY_RETRY_INTERVAL_SEC: intervalSec,
    SHEIN_BI_REMOTE_VERIFY_TIMEOUT_SEC: timeoutSec,
    SHEIN_BI_REMOTE_VERIFY_KILL_AFTER_SEC: killAfterSec,
  };
  delete env.SHEIN_BI_REMOTE_VERIFY_CMD;
  delete env.REMOTE_COS_STORE;
  delete env.REMOTE_VERIFY_COUNTER_FILE;
  delete env.REMOTE_VERIFY_FAIL_UNTIL;
  delete env.REMOTE_VERIFY_HANG_UNTIL;
  delete env.REMOTE_VERIFY_DRIFT_AFTER_COUNT;
  delete env.REMOTE_VERIFY_OVERLAP_FILE;
  delete env.REMOTE_VERIFY_HOLD_SEC;
  delete env.REMOTE_VERIFY_FIXTURE_MODE;
  delete env.REMOTE_VERIFY_SWAP_SOURCE_DIR;
  delete env.REMOTE_VERIFY_SWAP_SOURCE_CLONE;
  delete env.REMOTE_VERIFY_SWAP_AFTER_COUNT;
  delete env.SHEIN_BI_BACKUP_TEST_ALLOW_INSECURE_DELETE_PARENT;
  delete env.SHEIN_BI_BACKUP_TEST_SWAP_AFTER_FINAL_IDENTITY;
  if (remote) {
    env.SHEIN_BI_REMOTE_VERIFY_CMD = bashVerifier;
    env.REMOTE_COS_STORE = bashRemoteStore;
  }
  if (counterFile) env.REMOTE_VERIFY_COUNTER_FILE = toBashPath(counterFile);
  if (counterFile) env.REMOTE_VERIFY_FAIL_UNTIL = String(failUntil);
  if (counterFile) env.REMOTE_VERIFY_HANG_UNTIL = String(hangUntil);
  if (counterFile) env.REMOTE_VERIFY_DRIFT_AFTER_COUNT = String(driftAfterCount);
  if (overlapFile) env.REMOTE_VERIFY_OVERLAP_FILE = toBashPath(overlapFile);
  if (counterFile) env.REMOTE_VERIFY_HOLD_SEC = String(holdSec);
  if (fixtureMode) env.REMOTE_VERIFY_FIXTURE_MODE = fixtureMode;
  if (swapSourceDir) env.REMOTE_VERIFY_SWAP_SOURCE_DIR = swapSourceDir;
  if (swapClone) env.REMOTE_VERIFY_SWAP_SOURCE_CLONE = swapClone;
  if (swapAfterCount) env.REMOTE_VERIFY_SWAP_AFTER_COUNT = String(swapAfterCount);
  env.SHEIN_BI_BACKUP_TEST_ALLOW_INSECURE_DELETE_PARENT = allowInsecureDeleteParent ? '1' : '0';
  if (testSwapAfterFinalIdentity) env.SHEIN_BI_BACKUP_TEST_SWAP_AFTER_FINAL_IDENTITY = '1';
  if (pruneMountOkay) {
    const sep = process.platform === 'win32' ? ';' : ':';
    env.PATH = bashMountpointStub + sep + (env.PATH || '');
  }
  return env;
}

function runArchiveVerification(source, removeAfter = '0', options = {}) {
  return runBash('bash "$1" --test-archive-verified "$2" "$3"', [
    bashScriptPath,
    toBashPath(source),
    removeAfter,
  ], { env: options.env || envFor() });
}

function runScriptFlag(flag, args = [], env = envFor()) {
  const result = runBash(`bash "$1" ${flag} ${args.join(' ')}`, [bashScriptPath], { env });
  return result;
}

// Copy the just-published FUSE-path object into the INDEPENDENT remote store
// that the fake verifier reads.  This models the provider-side upload having
// been persisted outside the local mount.
function copyToRemoteStore(relPath) {
  const from = path.join(cosRoot, relPath);
  const to = path.join(remoteStore, relPath);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function relDayFor(archivePath) {
  return path.relative(cosRoot, path.dirname(archivePath)).split(path.sep).join('/');
}

function findArchive(base) {
  const matches = [];
  for (const day of fs.readdirSync(cosRoot)) {
    const candidate = path.join(cosRoot, day, `${base}.tar`);
    if (fs.existsSync(candidate)) matches.push(candidate);
  }
  assert.equal(matches.length, 1, `expected exactly one archive for ${base}`);
  return matches[0];
}

function archiveRelativePath(archive) {
  return `${relDayFor(archive)}/${path.basename(archive)}`;
}

function archiveIdentity(archive) {
  const stats = fs.statSync(archive, { bigint: true });
  return {
    dev: stats.dev.toString(),
    ino: stats.ino.toString(),
    size: stats.size.toString(),
    mtimeNs: stats.mtimeNs.toString(),
    sha256: sha256(fs.readFileSync(archive)),
  };
}

function publishFailClosedWithoutVerifier(source) {
  const result = runArchiveVerification(source, '0', { env: envFor({ remote: false }) });
  assert.equal(result.status, 78, result.stderr);
  assert.notEqual(result.status, 75, 'missing verifier must not be service-success status 75');
  assert.match(result.stderr, /reason=remote-verifier-missing/);
  assert.match(result.stderr, /remote-verify phase=post-publish terminal=config-error .*status=78/);
  assert.doesNotMatch(result.stdout, /offsite-verified|removed=/);
  assert.ok(fs.existsSync(source), 'missing verifier must preserve the local backup directory');
  const archive = findArchive(path.basename(source));
  assert.ok(fs.existsSync(archive), 'missing verifier must preserve the locally mounted archive');
  assert.ok(fs.existsSync(`${archive}.sha256`), 'missing verifier keeps the verified digest sidecar');
  assert.ok(fs.existsSync(`${archive}.mount-id`), 'missing verifier keeps the bound mount identity sidecar');
  return { archive, rel: archiveRelativePath(archive), result };
}

function replaceArchive(archive, base, entries, manifest, { extraFile = false, symlink = false } = {}) {
  const buildRoot = fs.mkdtempSync(path.join(fixtureRoot, 'archive-build-'));
  const bundleRoot = path.join(buildRoot, base);
  fs.mkdirSync(bundleRoot);
  for (const [fileName, value] of Object.entries(entries)) {
    fs.writeFileSync(path.join(bundleRoot, fileName), value);
  }
  fs.writeFileSync(path.join(bundleRoot, 'SHA256SUMS.txt'), manifest, 'ascii');
  if (extraFile) fs.writeFileSync(path.join(bundleRoot, 'unlisted.bin'), 'not in manifest');
  fs.rmSync(archive, { force: true });
  if (symlink) {
    const pythonResult = spawnSync(python, [
      '-c',
      [
        'import sys, tarfile',
        'archive, root, base = sys.argv[1:]',
        'with tarfile.open(archive, "w:") as bundle:',
        '    bundle.add(root, arcname=base)',
        '    link = tarfile.TarInfo(f"{base}/linked.dump")',
        '    link.type = tarfile.SYMTYPE',
        '    link.linkname = "payload.dump"',
        '    bundle.addfile(link)',
      ].join('\n'),
      archive,
      bundleRoot,
      base,
    ], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(pythonResult.status, 0, pythonResult.stderr);
    return;
  }
  const tarResult = runBash('tar -C "$1" -cf "$2" "$3"', [
    toBashPath(buildRoot),
    toBashPath(archive),
    base,
  ]);
  assert.equal(tarResult.status, 0, tarResult.stderr);
}

const dynamicScenarios = [];
try {
  const healthyEntries = {
    'browser-state.sheinenc': Buffer.from('encrypted browser state fixture'),
    'shein_bi.dump': Buffer.from('database dump fixture'),
  };

  // 1) Missing verifier is a deterministic deployment blocker. The archive
  //    and its local source survive, status 78 is not systemd-success 75.
  const retrySource = createSource('20260817-retry-success', healthyEntries);
  const retryPublished = publishFailClosedWithoutVerifier(retrySource);
  dynamicScenarios.push('missing-verifier-status-78-preserves-source-and-archive');
  const archiveBytes = fs.readFileSync(retryPublished.archive);
  assert.notEqual(archiveBytes[0], 0x1f, 'store archive must not carry the gzip magic');
  assert.notEqual(archiveBytes[1], 0x8b, 'store archive must not carry the gzip magic');

  // 2) The same foreground invocation retries only the independent verifier.
  //    It succeeds on attempt 3, never overlaps attempts and never republishes
  //    the already verified archive.
  copyToRemoteStore(retryPublished.rel);
  const retryCounter = path.join(verifierRoot, 'retry-success.count');
  const retryOverlap = path.join(verifierRoot, 'retry-success.overlap');
  const retryIdentityBefore = archiveIdentity(retryPublished.archive);
  const retryResult = runArchiveVerification(retrySource, '0', {
    env: envFor({
      maxAttempts: '3',
      intervalSec: '0',
      counterFile: retryCounter,
      failUntil: '2',
      overlapFile: retryOverlap,
      holdSec: '0.01',
    }),
  });
  assert.equal(retryResult.status, 0, retryResult.stderr);
  assert.match(retryResult.stdout, /remote-verify phase=post-publish attempt=1\/3/);
  assert.match(retryResult.stdout, /remote-verify phase=post-publish attempt=2\/3/);
  assert.match(retryResult.stdout, /remote-verify phase=post-publish attempt=3\/3/);
  assert.match(retryResult.stdout, /remote-verify phase=post-publish terminal=confirmed attempt=3/);
  assert.equal(fs.readFileSync(retryCounter, 'utf8').trim(), '3');
  assert.equal(fs.existsSync(retryOverlap), false, 'foreground verifier attempts must not overlap');
  assert.doesNotMatch(retryResult.stdout + retryResult.stderr, /signed-url-secret-fixture/,
    'verifier diagnostics that could contain secrets must not enter service logs');
  assert.deepEqual(archiveIdentity(retryPublished.archive), retryIdentityBefore,
    'remote verifier retries must not rewrite or duplicate the archive');
  assert.ok(fs.existsSync(retrySource), 'remove_after=0 must preserve the local source after confirmation');
  dynamicScenarios.push('two-failures-then-success-serial-no-republish-no-log-leak');

  // 3) A subsequent independently confirmed deletion may remove only the
  //    local backup directory; the mounted archive and sidecars remain.  The
  //    first post-publish and final pre-delete confirmations are distinct.
  const retryDeleteCounter = path.join(verifierRoot, 'retry-delete.count');
  const retryDelete = runArchiveVerification(retrySource, '1', {
    env: envFor({
      maxAttempts: '1',
      intervalSec: '0',
      counterFile: retryDeleteCounter,
    }),
  });
  assert.equal(retryDelete.status, 0, retryDelete.stderr);
  assert.match(retryDelete.stdout, /remote-verify phase=post-publish terminal=confirmed attempt=1/);
  assert.match(retryDelete.stdout, /remote-verify phase=pre-delete terminal=confirmed attempt=1/);
  assert.equal(fs.readFileSync(retryDeleteCounter, 'utf8').trim(), '2',
    'successful deletion must require two independent verifier calls');
  assert.match(retryDelete.stdout, /archived=.*removed=/);
  assert.equal(fs.existsSync(retrySource), false, 'independently confirmed archive may pass the deletion gate');
  assert.ok(fs.existsSync(retryPublished.archive));
  assert.ok(fs.existsSync(`${retryPublished.archive}.sha256`));
  assert.ok(fs.existsSync(`${retryPublished.archive}.mount-id`));
  dynamicScenarios.push('confirmed-delete-two-readbacks-removes-source-only');

  // 4) Exhaustion is status 74 (never 75), preserves every local artifact,
  //    executes exactly the configured attempt count and remains serial.
  const exhausted = createSource('20260817-exhausted', healthyEntries);
  const exhaustedPublished = publishFailClosedWithoutVerifier(exhausted);
  copyToRemoteStore(exhaustedPublished.rel);
  const exhaustedCounter = path.join(verifierRoot, 'exhausted.count');
  const exhaustedOverlap = path.join(verifierRoot, 'exhausted.overlap');
  const exhaustedIdentityBefore = archiveIdentity(exhaustedPublished.archive);
  const exhaustedResult = runArchiveVerification(exhausted, '1', {
    env: envFor({
      maxAttempts: '2',
      intervalSec: '0',
      counterFile: exhaustedCounter,
      failUntil: '99',
      overlapFile: exhaustedOverlap,
      holdSec: '0.01',
    }),
  });
  assert.equal(exhaustedResult.status, 74, exhaustedResult.stderr);
  assert.notEqual(exhaustedResult.status, 75, 'retry exhaustion must remain a service failure');
  assert.match(exhaustedResult.stderr, /remote-verify phase=post-publish terminal=exhausted attempts=2 status=74 .*local-preserved=1/);
  assert.equal(fs.readFileSync(exhaustedCounter, 'utf8').trim(), '2');
  assert.equal(fs.existsSync(exhaustedOverlap), false, 'exhausted verifier attempts must not overlap');
  assert.doesNotMatch(exhaustedResult.stdout + exhaustedResult.stderr, /signed-url-secret-fixture/);
  assert.ok(fs.existsSync(exhausted), 'exhaustion must preserve the local backup directory');
  assert.ok(fs.existsSync(exhaustedPublished.archive), 'exhaustion must preserve the mounted archive');
  assert.ok(fs.existsSync(`${exhaustedPublished.archive}.sha256`));
  assert.ok(fs.existsSync(`${exhaustedPublished.archive}.mount-id`));
  assert.deepEqual(archiveIdentity(exhaustedPublished.archive), exhaustedIdentityBefore,
    'exhausted retries must not rewrite or duplicate the archive');
  dynamicScenarios.push('retry-exhaustion-status-74-preserves-all-artifacts');

  // 5) A verifier that ignores TERM is hard-killed within the configured
  //    bound.  Each timeout enters the existing serial retry loop; exhaustion
  //    is 74, and no verifier output, re-archive or local deletion is allowed.
  const hung = createSource('20260817-hung-verifier', healthyEntries);
  const hungPublished = publishFailClosedWithoutVerifier(hung);
  copyToRemoteStore(hungPublished.rel);
  const hungCounter = path.join(verifierRoot, 'hung.count');
  const hungIdentityBefore = archiveIdentity(hungPublished.archive);
  const hungStartedAt = Date.now();
  const hungResult = runArchiveVerification(hung, '1', {
    env: envFor({
      maxAttempts: '2',
      intervalSec: '0',
      timeoutSec: '1',
      killAfterSec: '1',
      counterFile: hungCounter,
      hangUntil: '99',
    }),
  });
  const hungElapsedMs = Date.now() - hungStartedAt;
  assert.equal(hungResult.status, 74, hungResult.stderr);
  assert.notEqual(hungResult.status, 75);
  assert.ok(hungElapsedMs < 10_000, `hung verifier exceeded hard test bound: ${hungElapsedMs}ms`);
  assert.equal(fs.readFileSync(hungCounter, 'utf8').trim(), '2',
    'every timed-out attempt must be consumed by the bounded foreground retry loop');
  assert.match(hungResult.stderr, /remote-verify phase=post-publish terminal=exhausted attempts=2 status=74/);
  assert.doesNotMatch(hungResult.stdout + hungResult.stderr, /hung-verifier-secret-fixture/);
  assert.ok(fs.existsSync(hung), 'hung verifier exhaustion must preserve the local source');
  assert.ok(fs.existsSync(hungPublished.archive));
  assert.ok(fs.existsSync(`${hungPublished.archive}.sha256`));
  assert.ok(fs.existsSync(`${hungPublished.archive}.mount-id`));
  assert.deepEqual(archiveIdentity(hungPublished.archive), hungIdentityBefore,
    'timeout retries must not republish or replace the archive inode');
  dynamicScenarios.push('hung-verifier-hard-timeout-retries-status-74-no-leak-no-rearchive');

  // 6) An independently read object with the wrong size/hash fails the gate.
  const mismatch = createSource('20260817-mismatch', healthyEntries);
  const mismatchPublished = publishFailClosedWithoutVerifier(mismatch);
  copyToRemoteStore(mismatchPublished.rel);
  fs.writeFileSync(path.join(remoteStore, mismatchPublished.rel), Buffer.from('corrupted remote copy'));
  const mismatchDelete = runArchiveVerification(mismatch, '1', {
    env: envFor({ maxAttempts: '1', intervalSec: '0' }),
  });
  assert.equal(mismatchDelete.status, 74, 'a divergent remote object must exhaust the persistence gate');
  assert.doesNotMatch(mismatchDelete.stdout + mismatchDelete.stderr, /remote object mismatch/,
    'provider diagnostics must remain suppressed');
  assert.ok(fs.existsSync(mismatch), 'remote divergence must preserve the local backup');
  assert.ok(fs.existsSync(mismatchPublished.archive), 'remote divergence must preserve the mounted archive');
  dynamicScenarios.push('independent-remote-size-hash-mismatch-preserved');

  // 7) The first independent confirmation is not durable authority across the
  //    slow local revalidation.  Drift immediately after that confirmation is
  //    caught by the second pre-delete verifier and preserves all local data.
  const remoteDrift = createSource('20260817-remote-drift-before-delete', healthyEntries);
  const remoteDriftPublished = publishFailClosedWithoutVerifier(remoteDrift);
  copyToRemoteStore(remoteDriftPublished.rel);
  const remoteDriftCounter = path.join(verifierRoot, 'remote-drift.count');
  const remoteDriftIdentityBefore = archiveIdentity(remoteDriftPublished.archive);
  const remoteDriftResult = runArchiveVerification(remoteDrift, '1', {
    env: envFor({
      maxAttempts: '2',
      intervalSec: '0',
      counterFile: remoteDriftCounter,
      driftAfterCount: '1',
    }),
  });
  assert.equal(remoteDriftResult.status, 74, remoteDriftResult.stderr);
  assert.match(remoteDriftResult.stdout, /remote-verify phase=post-publish terminal=confirmed attempt=1/);
  assert.match(remoteDriftResult.stderr, /remote-verify phase=pre-delete terminal=exhausted attempts=2 status=74/);
  assert.equal(fs.readFileSync(remoteDriftCounter, 'utf8').trim(), '3',
    'one initial confirmation plus two failed final attempts must be observed');
  assert.ok(fs.existsSync(remoteDrift), 'remote drift after first confirmation must preserve the source');
  assert.ok(fs.existsSync(remoteDriftPublished.archive));
  assert.ok(fs.existsSync(`${remoteDriftPublished.archive}.sha256`));
  assert.ok(fs.existsSync(`${remoteDriftPublished.archive}.mount-id`));
  assert.deepEqual(archiveIdentity(remoteDriftPublished.archive), remoteDriftIdentityBefore,
    'final verifier failure must not republish the mounted archive');
  dynamicScenarios.push('remote-drift-after-first-readback-blocked-by-pre-delete-readback');

  // 8) Manifest-preserving content tampering of a pre-existing archive.
  const tampered = createSource('20260817-tampered', healthyEntries);
  const { archive: tamperedArchive } = publishFailClosedWithoutVerifier(tampered);
  replaceArchive(
    tamperedArchive,
    '20260817-tampered',
    { ...healthyEntries, 'shein_bi.dump': Buffer.from('changed archive bytes') },
    manifestFor(healthyEntries),
  );
  fs.writeFileSync(
    `${tamperedArchive}.sha256`,
    `${sha256(fs.readFileSync(tamperedArchive))}  ${path.basename(tamperedArchive)}\n`,
  );
  const tamperedResult = runArchiveVerification(tampered, '1');
  assert.notEqual(tamperedResult.status, 0, 'manifest-preserving content corruption must fail');
  assert.doesNotMatch(tamperedResult.stdout, /offsite-verified|removed=/);
  assert.ok(fs.existsSync(tampered), 'tampered archive must not cross the local deletion gate');
  assert.equal(fs.existsSync(`${tamperedArchive}.sha256`), false, 'stale sidecar is removed after full verification fails');
  dynamicScenarios.push('archive-content-tamper-rejected');

  // 7) Absolute / parent-traversal manifest paths.
  const absolute = createSource(
    '20260817-absolute',
    { 'payload.dump': Buffer.from('absolute path fixture') },
    `${sha256('absolute path fixture')}  /tmp/payload.dump\n`,
  );
  const absoluteResult = runArchiveVerification(absolute, '1');
  assert.notEqual(absoluteResult.status, 0, 'absolute manifest path must fail');
  assert.ok(fs.existsSync(absolute));
  dynamicScenarios.push('absolute-manifest-path-rejected');
  const traversal = createSource(
    '20260817-traversal',
    { 'payload.dump': Buffer.from('traversal fixture') },
    `${sha256('traversal fixture')}  ../payload.dump\n`,
  );
  const traversalResult = runArchiveVerification(traversal, '1');
  assert.notEqual(traversalResult.status, 0, 'parent traversal manifest path must fail');
  assert.ok(fs.existsSync(traversal));
  dynamicScenarios.push('parent-traversal-manifest-path-rejected');

  // 8) Extra / symlink archive members.
  for (const [suffix, archiveOptions] of [
    ['extra', { extraFile: true }],
    ['link', { symlink: true }],
  ]) {
    const source = createSource(`20260817-${suffix}`, { 'payload.dump': Buffer.from(`${suffix} fixture`) });
    const { archive } = publishFailClosedWithoutVerifier(source);
    const entries = { 'payload.dump': Buffer.from(`${suffix} fixture`) };
    replaceArchive(archive, `20260817-${suffix}`, entries, manifestFor(entries), archiveOptions);
    const result = runArchiveVerification(source, '1');
    assert.notEqual(result.status, 0, `${suffix} archive entry must fail`);
    assert.doesNotMatch(result.stdout, /offsite-verified|removed=/);
    assert.ok(fs.existsSync(source), `${suffix} archive must preserve local source`);
    dynamicScenarios.push(`archive-${suffix}-member-rejected`);
  }

  // 9) COS mount identity drift: publishing binds the original mount identity;
  //     after the day directory is recreated under a new inode, the deletion
  //     gate must fail closed even though the object bytes are identical.
  const drift = createSource('20260817-drift', healthyEntries);
  const { archive: driftArchive, rel: driftRel } = publishFailClosedWithoutVerifier(drift);
  const driftDay = relDayFor(driftArchive);
  copyToRemoteStore(driftRel);
  const driftBytes = fs.readFileSync(driftArchive);
  const driftId = fs.readFileSync(`${driftArchive}.mount-id`, 'utf8').trim();
  fs.rmSync(cosRoot, { recursive: true });
  fs.mkdirSync(cosRoot, { recursive: true });
  const dayDir = path.join(cosRoot, driftDay);
  fs.mkdirSync(dayDir, { recursive: true });
  fs.writeFileSync(path.join(dayDir, path.basename(driftArchive)), driftBytes);
  fs.writeFileSync(path.join(dayDir, `${path.basename(driftArchive)}.mount-id`), `${driftId}\n`, 'utf8');
  fs.writeFileSync(path.join(dayDir, `${path.basename(driftArchive)}.sha256`),
    `${sha256(driftBytes)}  ${path.basename(driftArchive)}\n`, 'ascii');
  const driftDelete = runArchiveVerification(drift, '1');
  assert.notEqual(driftDelete.status, 0, 'a remounted COS identity must fail the deletion gate');
  assert.ok(fs.existsSync(drift), 'mount identity drift must preserve the local backup');
  dynamicScenarios.push('mount-identity-drift-rejected');

  // 9b) Verifier stdout negotiation: only a byte-exact single ok-line is
  // accepted.  Leading noise, a trailing blank line and a stdout flood all
  // fail the persistence gate and preserve the local backup.
  for (const [mode, marker] of [
    ['leading-noise', 'independent remote verification mismatch'],
    ['trailing-blank', 'independent remote verification mismatch'],
    ['flood', 'reason=remote-verifier-output-flood'],
  ]) {
    const source = createSource('20260817-noise-' + mode, healthyEntries);
    const {archive: noiseArchive, rel: noiseRel} = publishFailClosedWithoutVerifier(source);
    copyToRemoteStore(noiseRel);
    const noiseResult = runArchiveVerification(source, '1', {
      env: envFor({maxAttempts: '1', fixtureMode: mode}),
    });
    assert.equal(noiseResult.status, 74, mode + ' verifier stdout must exhaust the persistence gate');
    assert.ok(fs.existsSync(source), mode + ' must preserve the local backup');
    assert.match(noiseResult.stderr, new RegExp(marker), mode + ' reason must be logged');
    assert.ok(fs.existsSync(noiseArchive), mode + ' must preserve the mounted archive');
    dynamicScenarios.push('verifier-stdout-' + mode + '-rejected');
  }

  // 9c) An in-verifier configuration error (78) is terminal: it stops at the
  // first attempt, is never retried and is never downgraded to 74 -- even
  // when the verifier also emitted noisy stdout before exiting 78.
  for (const mode of ['config78', 'config78-noise']) {
    const source = createSource('20260817-cfg-' + mode, healthyEntries);
    const {archive: cfgArchive, rel: cfgRel} = publishFailClosedWithoutVerifier(source);
    copyToRemoteStore(cfgRel);
    const cfgCounter = path.join(verifierRoot, 'cfg-' + mode + '.count');
    const cfgResult = runArchiveVerification(source, '1', {
      env: envFor({maxAttempts: '3', counterFile: cfgCounter, fixtureMode: mode}),
    });
    assert.equal(cfgResult.status, 78, mode + ' must be a terminal configuration error, not 74');
    assert.equal(fs.readFileSync(cfgCounter, 'utf8').trim(), '1', mode + ' must not be retried');
    assert.match(cfgResult.stderr, /terminal=config-error .*status=78/, mode + ' must log the config terminal');
    assert.ok(fs.existsSync(source), mode + ' must preserve the local backup');
    assert.ok(fs.existsSync(cfgArchive), mode + ' must preserve the mounted archive');
    dynamicScenarios.push('verifier-config-' + mode + '-terminal-78');
  }

  // 9d) Retention (prune) distinguishes the same terminal statuses: a
  // verifier config error surfaces as 78, retry exhaustion as 74, and both
  // preserve every local backup.
  const expiredOld = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  const pruneConfig = createSource('20260817-prune-config78', healthyEntries);
  fs.utimesSync(pruneConfig, expiredOld, expiredOld);
  const pruneConfigRun = runScriptFlag('--prune-only', [], envFor({maxAttempts: '3', fixtureMode: 'config78', pruneMountOkay: true}));
  assert.equal(pruneConfigRun.status, 78, 'prune must surface the verifier config error as 78, not 1');
  assert.match(pruneConfigRun.stderr, /retention terminal=remote-verify status=78/, 'prune must preserve the 78 terminal reason');
  assert.ok(fs.existsSync(pruneConfig), 'prune config error must preserve the local backup');
  fs.rmSync(pruneConfig, {recursive: true, force: true});
  dynamicScenarios.push('prune-retention-terminal-config-78');

  const pruneExhaust = createSource('20260817-prune-exhausted', healthyEntries);
  fs.utimesSync(pruneExhaust, expiredOld, expiredOld);
  const pruneCounter = path.join(verifierRoot, 'prune-exhausted.count');
  const pruneExhaustRun = runScriptFlag('--prune-only', [], envFor({
    maxAttempts: '1',
    counterFile: pruneCounter,
    failUntil: '99',
    fixtureMode: '',
    pruneMountOkay: true,
  }));
  assert.equal(pruneExhaustRun.status, 74, 'prune must surface verifier retry exhaustion as 74, not 1');
  assert.match(pruneExhaustRun.stderr, /retention terminal=remote-verify status=74/, 'prune must preserve the 74 terminal reason');
  assert.equal(fs.readFileSync(pruneCounter, 'utf8').trim(), '1', 'prune must run exactly one bounded attempt');
  assert.ok(fs.existsSync(pruneExhaust), 'prune exhaustion must preserve the local backup');
  fs.rmSync(pruneExhaust, {recursive: true, force: true});
  dynamicScenarios.push('prune-retention-terminal-exhausted-74');

  // 9e) Source-directory identity fault injection: after an independently
  // confirmed publication, the retention run replaces the source directory
  // with an identical-content clone at the same path.  The final delete gate
  // detects the new inode (direct-child same path, different identity),
  // preserves BOTH the original and the clone, and never deletes through the
  // replaced path.
  const swapSource = createSource('20260817-source-swap', healthyEntries);
  {
    const {rel: swapRel} = publishFailClosedWithoutVerifier(swapSource);
    copyToRemoteStore(swapRel);
    // Prepare an identical-content clone in a SEPARATE directory; the fake
    // verifier swaps it in at its pre-delete (second) call, i.e. inside the
    // slow-readback -> rm window where the source path was previously
    // unbound.  The final delete gate must detect the new directory identity
    // and refuse to delete through the replaced path.
    const cloneLock = path.join(backupRoot, '20260817-source-swap.clone');
    fs.mkdirSync(cloneLock);
    for (const entry of fs.readdirSync(swapSource)) {
      fs.copyFileSync(path.join(swapSource, entry), path.join(cloneLock, entry));
    }
    const swapCounter = path.join(verifierRoot, 'source-swap.count');
    const swapDelete = runArchiveVerification(swapSource, '1', {env: envFor({
      maxAttempts: '2',
      intervalSec: '0',
      counterFile: swapCounter,
      swapSourceDir: toBashPath(swapSource),
      swapClone: toBashPath(cloneLock),
      swapAfterCount: '2',
    })});
    assert.equal(swapDelete.status, 1, 'a source directory replaced inside the readback window must fail closed (source-identity gate is a local integrity failure, not a remote retry exhaustion)');
    assert.match(swapDelete.stderr, /source-identity-drifted-at-final-delete-gate/, 'the source identity drift must be the terminal reason');
    assert.ok(fs.existsSync(swapSource), 'the swapped-in directory must be preserved');
    assert.ok(fs.existsSync(swapSource + '.swap-orig'), 'the originally verified directory must never be deleted');
    fs.rmSync(swapSource + '.swap-orig', {recursive: true, force: true});
    fs.rmSync(cloneLock, {recursive: true, force: true});
    fs.rmSync(swapSource, {recursive: true, force: true});
    dynamicScenarios.push('source-directory-identity-drift-blocked-at-final-delete-gate');
  }

  // 9f) Path swap AFTER the final identity check, driven by the test-only
  //     hook named after-final-identity-before-quarantine.  The hook swaps
  //     the verified directory for an identical-content clone exactly between
  //     the final identity gate and the quarantine rename.  The quarantine
  //     re-verification detects the fresh inode, keeps the quarantine, and
  //     deletes neither the originally verified directory nor the
  //     replacement.  The hook is gated behind SHEIN_BI_BACKUP_TEST_MODE=1
  //     and would be inert in production.
  const hookSource = createSource('20260817-hook-swap', healthyEntries);
  {
    const { rel: hookRel } = publishFailClosedWithoutVerifier(hookSource);
    copyToRemoteStore(hookRel);
    const hookDelete = runArchiveVerification(hookSource, '1', {
      env: envFor({
        maxAttempts: '2',
        intervalSec: '0',
        testSwapAfterFinalIdentity: true,
      }),
    });
    assert.equal(hookDelete.status, 1,
      'a path swap after the final identity check must fail closed (quarantine identity drift), not pass the delete gate');
    assert.match(hookDelete.stderr, /reason=quarantine-identity-drift/,
      'the quarantine re-verification must be the terminal reason');
    assert.doesNotMatch(hookDelete.stdout, /removed=/,
      'a swapped path must never be reported as removed');
    assert.ok(fs.existsSync(hookSource + '.swap-orig'),
      'the originally verified directory must never be deleted');
    const hookQuarantines = fs.readdirSync(backupRoot).filter((name) => name.startsWith('.quarantine-'));
    assert.equal(hookQuarantines.length, 1,
      'exactly one unique hidden quarantine must remain preserved');
    const hookQuarantineDir = path.join(backupRoot, hookQuarantines[0]);
    assert.ok(fs.statSync(hookQuarantineDir).isDirectory(),
      'the replacement directory must be preserved inside the quarantine');
    assert.ok(fs.existsSync(path.join(hookQuarantineDir, 'SHA256SUMS.txt')),
      'the quarantined replacement must still carry its verified manifest');
    assert.equal(fs.existsSync(hookSource), false,
      'the swapped-in replacement name must move into the quarantine, not be deleted in place');
    fs.rmSync(hookSource + '.swap-orig', {recursive: true, force: true});
    fs.rmSync(hookQuarantineDir, {recursive: true, force: true});
    dynamicScenarios.push('path-swap-after-final-identity-preserves-original-and-replacement');
  }

  // 9g) Delete-parent security: local deletion must fail closed when the
  //     retention root is not a root-owned, group/other non-writable parent.
  //     The Windows contract fixtures are owned by the invoking user
  //     (uid != 0), so with the test-only bypass disabled the gate must
  //     refuse to delete and preserve every artifact.
  const parentInsecure = createSource('20260817-parent-insecure', healthyEntries);
  {
    const { rel: parentRel } = publishFailClosedWithoutVerifier(parentInsecure);
    copyToRemoteStore(parentRel);
    const parentInsecureRun = runArchiveVerification(parentInsecure, '1', {
      env: envFor({
        maxAttempts: '1',
        intervalSec: '0',
        allowInsecureDeleteParent: false,
      }),
    });
    assert.equal(parentInsecureRun.status, 1, 'an insecure delete parent must fail closed');
    assert.match(parentInsecureRun.stderr, /reason=delete-parent-not-secure/,
      'the insecure-parent gate must be the terminal reason');
    assert.ok(fs.existsSync(parentInsecure),
      'an insecure parent must preserve the local backup directory');
    assert.equal(fs.readdirSync(backupRoot).some((name) => name.startsWith('.quarantine-')), false,
      'no quarantine and no deletion may occur when the parent is not secure');
    fs.rmSync(parentInsecure, {recursive: true, force: true});
    dynamicScenarios.push('delete-parent-not-secure-fails-closed');
  }
  // 10) Staging trap: a mid-run crash removes its own staging directory, so
  //    no permanent final directory or accumulated staging remains.
  for (let n = 0; n < 2; n += 1) {
    const trap = runScriptFlag('--test-staging-trap');
    assert.equal(trap.status, 7, 'the staged crash must surface its own exit code');
    assert.equal(fs.readdirSync(backupRoot).some((name) => name.startsWith('.pending-')), false,
      'a crashed run must remove its staging directory');
  }
  dynamicScenarios.push('repeated-staging-failure-space-bounded');

  // 11) Staging cleanup: stale staging is bounded-removed while fresh staging is kept.
  const clean = runScriptFlag('--test-staging-cleanup');
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /staging-cleanup-ok/);
  assert.equal(fs.readdirSync(backupRoot).some((name) => name.startsWith('.pending-stale-')), false,
    'stale staging must be cleaned');
  assert.equal(fs.readdirSync(backupRoot).some((name) => name.startsWith('.pending-fresh-')), true,
    'fresh staging must be preserved');
  for (const name of fs.readdirSync(backupRoot)) {
    if (name.startsWith('.pending-')) fs.rmSync(path.join(backupRoot, name), { recursive: true, force: true });
  }
  dynamicScenarios.push('stale-staging-bounded-cleanup');

  // 12) Browser-state create receipt validation.
  const okReceipt = path.join(backupRoot, 'receipt-ok.json');
  fs.writeFileSync(okReceipt, JSON.stringify({
    ok: true, action: 'create',
    includedRoots: ['profiles', 'state/shein_webapi_sessions'],
    skippedOptionalRoots: [],
  }), 'utf8');
  const okReceiptResult = runScriptFlag('--test-check-receipt', [toBashPath(okReceipt)]);
  assert.equal(okReceiptResult.status, 0, okReceiptResult.stderr);
  const missingRootReceipt = path.join(backupRoot, 'receipt-missing.json');
  fs.writeFileSync(missingRootReceipt, JSON.stringify({
    ok: true, action: 'create',
    includedRoots: ['profiles'],
    skippedOptionalRoots: [],
  }), 'utf8');
  const missingRootResult = runScriptFlag('--test-check-receipt', [toBashPath(missingRootReceipt)]);
  assert.notEqual(missingRootResult.status, 0, 'a receipt missing a required root must fail');
  const skippedReceipt = path.join(backupRoot, 'receipt-skipped.json');
  fs.writeFileSync(skippedReceipt, JSON.stringify({
    ok: true, action: 'create',
    includedRoots: ['profiles', 'state/shein_webapi_sessions'],
    skippedOptionalRoots: ['state/shein_webapi_sessions'],
  }), 'utf8');
  const skippedResult = runScriptFlag('--test-check-receipt', [toBashPath(skippedReceipt)]);
  assert.notEqual(skippedResult.status, 0, 'a session root skipped as optional must fail the production receipt gate');
  const invalidReceipt = path.join(backupRoot, 'receipt-invalid.json');
  fs.writeFileSync(invalidReceipt, 'not json', 'utf8');
  const invalidResult = runScriptFlag('--test-check-receipt', [toBashPath(invalidReceipt)]);
  assert.notEqual(invalidResult.status, 0, 'an invalid receipt must fail');
  dynamicScenarios.push('mandatory-browser-roots-receipt-contract');

  // 13) Every integer supplied to Bash arithmetic/find is validated as a
  //     short base-10 decimal and bounded before housekeeping or archiving.
  //     Literal arithmetic payloads must remain inert environment strings.
  const arithmeticMarker = path.join(fixtureRoot, 'arithmetic-config-payload-executed');
  const arithmeticPayload = `1[$(touch "${toBashPath(arithmeticMarker)}")]`;
  let invalidConfigOrdinal = 0;
  const assertRejectedNumericConfig = (variable, value) => {
    invalidConfigOrdinal += 1;
    const sentinel = path.join(backupRoot, `.pending-invalid-config-${invalidConfigOrdinal}`);
    fs.mkdirSync(sentinel);
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(sentinel, old, old);
    const env = envFor();
    env[variable] = value;
    const result = runScriptFlag('--test-staging-cleanup', [], env);
    assert.equal(result.status, 64, `${variable}=${value} must fail before housekeeping; stderr=${result.stderr}`);
    assert.match(result.stderr, new RegExp(`invalid ${variable}; expected decimal`));
    assert.ok(fs.existsSync(sentinel), `${variable} must be rejected before stale-staging cleanup`);
    assert.equal(fs.existsSync(arithmeticMarker), false, 'arithmetic payload text must never be evaluated');
    fs.rmSync(sentinel, { recursive: true, force: true });
  };
  for (const [variable, values] of [
    ['SHEIN_BI_BACKUP_RETENTION_DAYS', ['0', '-1', 'seven', '12345678901', '3651', arithmeticPayload]],
    ['SHEIN_BI_BACKUP_STALE_STAGING_MINUTES', ['0', '-1', 'thirty', '12345678901', '10081', arithmeticPayload]],
    ['SHEIN_BI_REMOTE_VERIFY_TIMEOUT_SEC', ['0', '-1', 'thirty', '12345678901', '601', arithmeticPayload]],
    ['SHEIN_BI_REMOTE_VERIFY_KILL_AFTER_SEC', ['0', '-1', 'five', '12345678901', '61', arithmeticPayload]],
    ['SHEIN_BI_REMOTE_VERIFY_MAX_ATTEMPTS', ['0', '11', arithmeticPayload]],
    ['SHEIN_BI_REMOTE_VERIFY_RETRY_INTERVAL_SEC', ['-1', '3601', arithmeticPayload]],
  ]) {
    for (const value of values) assertRejectedNumericConfig(variable, value);
  }
  assert.equal(fs.existsSync(arithmeticMarker), false);
  dynamicScenarios.push('strict-bounded-decimal-config-before-arithmetic-find-no-injection');
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: true,
  staticContract: 'passed',
  deploymentGate: 'remote_verifier_configured',
  dynamicScenarioCount: dynamicScenarios.length,
  dynamicScenarios,
  skips: [],
}, null, 2));
