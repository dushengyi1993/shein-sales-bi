#!/usr/bin/env node
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

import {
  CLOUD_MAINTENANCE_POLICY_BY_SERVICE,
  expectedCloudMaintenanceExecCondition,
} from '../lib/cloud_runtime_inventory.mjs';
import {
  CLOUD_RUNTIME_PATH_POLICY_BY_SERVICE,
  cloudRuntimePathEffectiveDirectives,
} from '../lib/cloud_runtime_path_policy.mjs';
import {SYSTEMD_SNAPSHOT_PROPERTIES} from '../lib/systemd_unit_snapshot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATOR = path.join(ROOT, 'scripts', 'migrate_cloud_runtime_mount_layout.sh');
const NAMESPACE_INSTALLER = path.join(ROOT, 'scripts', 'install_cloud_runtime_path_namespaces.sh');
const GUARDS_INSTALLER = path.join(ROOT, 'scripts', 'install_cloud_maintenance_guards.sh');
const MANAGER = path.join(ROOT, 'scripts', 'manage_cloud_maintenance_mode.mjs');
const SYSTEMD_SOURCE = path.join(ROOT, 'infra', 'systemd');
const CONFIRMATION = 'MIGRATE_CLOUD_RUNTIME_LAYOUT_V2';
const source = await fs.readFile(MIGRATOR, 'utf8');

const isWindows = process.platform === 'win32';
const gitBash = process.env.SHEIN_TEST_GIT_BASH || 'D:\\Program Files\\Git\\bin\\bash.exe';
const cygpath = process.env.SHEIN_TEST_CYGPATH || 'D:\\Program Files\\Git\\usr\\bin\\cygpath.exe';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {encoding: 'utf8', ...options});
  if (result.error) throw result.error;
  return result;
}

if (isWindows && (!existsSync(gitBash) || !existsSync(cygpath))) {
  console.log(JSON.stringify({
    ok: true,
    runtimeFixtureSkipped: `Git Bash fixture runtime unavailable: ${gitBash}`,
    checks: ['audit_precedes_writes', 'exact_confirmation', 'backup_outside_source_tree', 'effective_exec_condition_at_critical_points', 'effective_28_service_path_readback', 'fstab_publish_last', 'journal_phase_machine', 'phase_complete_rollback_prevalidation', 'atomic_fstab_restore', 'exact_fstab_transform', 'failpoint_hook', 'kill_resume_state_machine', 'tamper_rejected', 'v1_adoption'],
  }, null, 2));
  process.exit(0);
}

function shellPath(file) {
  if (!isWindows) return file;
  const result = run(cygpath, ['-a', '-u', file]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function canonicalShellPath(file) {
  const translated = shellPath(file);
  if (!isWindows) return translated;
  // Existing paths resolve to the physical form (pwd -P agrees); not-yet-created
  // paths keep the msys logical form. The probe path travels in an env var so
  // the shell snippet never touches positional parameters.
  const result = run(gitBash, ['-c',
    'cd -- $(dirname -- $SHEIN_PROBE_PATH) && pwd -P; printf /; basename -- $SHEIN_PROBE_PATH',
    'migrate-fixture'], {env: {...process.env, SHEIN_PROBE_PATH: translated}});
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split('\n').join('');
}

// ---------------------------------------------------------------------------
// Static contract
// ---------------------------------------------------------------------------
const syntax = isWindows
  ? run(gitBash, ['-n', shellPath(MIGRATOR)])
  : run('/bin/bash', ['-n', MIGRATOR]);
assert.equal(syntax.status, 0, syntax.stderr);

const missingConfirmation = isWindows
  ? run(gitBash, [shellPath(MIGRATOR), '--apply'])
  : run('/bin/bash', [MIGRATOR, '--apply']);
assert.equal(missingConfirmation.status, 64);
assert.match(missingConfirmation.stderr, /--apply\/--rollback requires exact --confirm/);

assert.match(source, /MIGRATE_CLOUD_RUNTIME_LAYOUT_V2/);
assert.match(source, /--apply\/--rollback requires exact --confirm/);
assert.match(source, /real apply\/rollback requires root/);
assert.match(source, /maintenance marker must be active mode=all/);
assert.match(source, /STANDARD_MAINTENANCE_MARKER='\/var\/lib\/shein-bi-control\/cloud-maintenance\.json'/);
assert.doesNotMatch(source, /STANDARD_MAINTENANCE_MARKER='\/srv\/shein-bi\/runtime\/maintenance\/cloud-maintenance\.json'/);
assert.match(source, /fs\.constants\.O_NOFOLLOW/);
assert.match(source, /fs\.fstatSync\(fd\)/);
assert.match(source, /fs\.readFileSync\(fd, 'utf8'\)/);
assert.match(source, /stat\.nlink !== 1/);
assert.match(source, /stat\.uid !== 0 \|\| stat\.gid !== 0 \|\| mode !== 0o644/);
assert.match(source, /exactMode !== null && mode !== exactMode/);
assert.match(source, /Number\.isSafeInteger\(value\.generation\)/);
assert.match(source, /STANDARD_BACKUP_ROOT='\/srv\/shein-bi\/runtime\/layout-migration-backups'/);
assert.match(source, /--backup-root <absolute-directory>/);
assert.match(source, /maintenance guard installer is not fully settled/);
assert.match(source, /value\.plannedInstall !== 0 \|\| value\.plannedReplace !== 0/);
assert.match(source, /value\.plannedRemove !== 0 \|\| value\.unchanged !== value\.policyCount/);
assert.match(source, /installed service has no repository service source audited by maintenance policy/);
assert.match(source, /assert_all_services_inactive/);
assert.match(source, /assert_no_chrome/);
assert.match(source, /namespace installer is not fully settled/);
assert.match(source, /rsync[\s\S]*-aHAXnci --delete/);
assert.match(source, /state checksum dry-run is not empty/);
assert.match(source, /STATE_BACKUP="\$BACKUP_RUN_DIR\/state-underlay"/);
assert.match(source, /OUTPUTS_BACKUP="\$BACKUP_RUN_DIR\/outputs-git-underlay"/);
assert.doesNotMatch(source, /(?:STATE_BACKUP|OUTPUTS_BACKUP)="\$ROOT\//);
assert.match(source, /assert_no_source_tree_backups/);
assert.match(source, /backup root must share the application underlay device/);
assert.match(source, /assert_atomic_backup_device "\$APP_OUTPUTS"/);
assert.match(source, /assert_atomic_backup_device "\$APP_STATE"/);
assert.match(source, /ls-files -s -z -- outputs/);
assert.match(source, /cat-file blob/);
assert.match(source, /hash-object -- "\$target"/);
assert.match(source, /status --porcelain --untracked-files=no -- outputs/);
assert.match(source, /tracked outputs must not be a host mountpoint/);
assert.match(source, /find "\$target" -xdev -depth -mindepth 1 -delete/);
assert.doesNotMatch(source, /\bgit\s+(?:reset|clean|checkout)\b|\brm\s+-[A-Za-z]*r[A-Za-z]*f?\b|\brm\s+-[A-Za-z]*f[A-Za-z]*r\b/);
assert.match(source, /rollback_refused_unsafe_delete/);
assert.match(source, /prevalidate_rollback_evidence/);
assert.match(source, /rollback journal phase \$PHASE requires an exact fstab backup/);
assert.match(source, /rollback journal phase \$PHASE requires an exact outputs underlay backup/);
assert.match(source, /rollback journal phase \$PHASE requires an exact state underlay backup/);
assert.match(source, /runtime_layout_recovery=preserved_unreadable_journal/);
const onExitMatch = source.match(/on_exit\(\) \{\n([\s\S]*?)\n\}/);
assert.ok(onExitMatch, 'failure preservation handler must be extractable');
assert.doesNotMatch(onExitMatch[1], /restore_legacy/,
  'an ordinary migration failure must preserve evidence; only explicit --rollback may mutate again');
assert.match(source, /assert_generated_mount_contract/);
assert.match(source, /RequiresMountsFor is missing/);
assert.match(source, /validateCloudMaintenanceEffectiveGuards/);
assert.match(source, /validateCloudRuntimeEffectiveControls/);
assert.match(source, /RequiresMountsFor is intentionally a minimum-set contract/);
assert.doesNotMatch(source, /effective RequiresMountsFor exact validation failed/);
const effectivePropertyMatch = source.match(/--property=([A-Za-z,]+)/);
assert.ok(effectivePropertyMatch, 'effective systemd property query must be extractable');
assert.deepEqual(effectivePropertyMatch[1].split(','), SYSTEMD_SNAPSHOT_PROPERTIES,
  'migration preflight must query the complete production systemd snapshot protocol');
for (const property of ['ExecCondition', 'BindPaths', 'BindReadOnlyPaths', 'InaccessiblePaths', 'RequiresMountsFor']) {
  assert.match(source, new RegExp(property));
}
for (const criticalPoint of [
  'initial-migration-preflight',
  'before-migration-journal-init',
  'before-fstab-backup',
  'before-state-copy',
  'before-outputs-unmount',
  'before-outputs-underlay-move',
  'before-state-underlay-move',
  'before-readonly-remounts',
  'before-fstab-prepare',
  'before-fstab-atomic-rename',
  'before-verified-journal',
  'before-explicit-rollback',
]) assert.match(source, new RegExp(criticalPoint));
assert.match(source, /migration journal schema mismatch/);
assert.match(source, /migration journal path bindings conflict/);
assert.match(source, /migration journal fstab stage path is unsafe/);
assert.match(source, /multiple active migration journals found/);
assert.match(source, /kill -9 \$\$/);
assert.match(source, /SHEIN_BI_MIGRATION_STAGE_LIMIT/);
assert.match(source, /migration failpoints are fixture-only/);
assert.match(source, /# FINGERPRINT_ENGINE_BEGIN[\s\S]*# FINGERPRINT_ENGINE_END/);
assert.match(source, /--sort=name --format=posix --numeric-owner/);
assert.match(source, /--pax-option=delete=atime,delete=ctime/);
assert.doesNotMatch(source.match(/tree_fingerprint\(\) \{[\s\S]*?\n\}/)?.[0] || '', /--mtime=/,
  'source mtime must participate in migration fingerprints');
assert.match(source, /--acls --xattrs --xattrs-include='\*' --one-file-system/);
assert.doesNotMatch((source.match(/# FINGERPRINT_ENGINE_BEGIN[\s\S]*?# FINGERPRINT_ENGINE_END/)?.[0] || '')
  .split(/\r?\n/).filter(line => !line.trimStart().startsWith('#')).join('\n'),
  /--dereference|--hard-dereference/,
  'fingerprints must preserve symlink and hard-link topology');
for (const failpoint of [
  'after-outputs-move-before-recreate',
  'after-state-move-before-recreate',
  'before-fstab-atomic-rename',
  'after-fstab-publish-before-journal',
  'after-rollback-started-marker-before-mutation',
  'before-rollback-fstab-atomic-rename',
  'after-rollback-fstab-restore-before-journal',
  'after-rollback-state-unmount-before-journal',
  'after-rollback-outputs-restore-before-journal',
  'after-rollback-state-restore-before-journal',
  'after-rollback-mounts-restore-before-journal',
  'after-rollback-cleanup-before-journal',
  'before-rollback-terminal-journal',
]) assert.match(source, new RegExp(failpoint));
assert.match(source, /migration-rollback\.json/);
assert.match(source, /cloud-runtime-layout-migration-rollback\/v1/);
assert.match(source, /rollback_marker_write/);
assert.match(source, /rollback_marker_read_phase/);
assert.match(source, /load_journal_globals rollback/);
assert.match(source, /forward resume is blocked while an explicit rollback is in progress/);
assert.match(source, /ROLLBACK_RESUMING/);
assert.match(source, /ROLLBACK_PHASE/);
assert.match(source, /cloud-runtime-layout-migration-journal\/v2/);
assert.match(source, /writeJsonFileAtomic/);
assert.match(source, /sync -f -- "\$FSTAB_STAGE_PATH"/,
  'the staged fstab must be durable before its journal phase is published');
assert.match(source, /sync -f -- "\$FSTAB"[\s\S]*sync -f -- "\$\(dirname -- "\$FSTAB"\)"/,
  'the fstab file and parent directory must be durable before fstab-published is journaled');
for (const phase of ['init', 'fstab-backed-up', 'state-data-created', 'outputs-underlay-prepared', 'outputs-underlay-moved', 'state-underlay-moved', 'readonly-mounts-done', 'fstab-publish-prepared', 'fstab-published', 'verified', 'rolled-back']) {
  assert.match(source, new RegExp(`${phase}`));
}
const auditExit = source.indexOf('if ((!APPLY && !ROLLBACK_FLAG)); then');
const firstStateCopy = source.indexOf('"$RSYNC_BIN" -aHAX --numeric-ids --one-file-system');
const fstabPublish = source.indexOf('mv -- "$FSTAB_STAGE_PATH" "$FSTAB"');
const outputsMove = source.indexOf('mv -- "$APP_OUTPUTS" "$OUTPUTS_BACKUP"');
const stateMove = source.indexOf('mv -- "$APP_STATE" "$STATE_BACKUP"');
const readonlyMount = source.indexOf('step_readonly_mounts');
const discoverCall = source.lastIndexOf('discover_journal');
const applyDispatch = source.lastIndexOf('apply_migrate');
const rollbackDispatch = source.lastIndexOf('apply_rollback');
assert.ok(discoverCall > 0 && auditExit > discoverCall && applyDispatch > auditExit && rollbackDispatch > auditExit,
  'audit exit must precede every migration write dispatch');
assert.ok(fstabPublish > outputsMove && fstabPublish > stateMove, 'fstab publish must be the final topology transition');
assert.ok(readonlyMount > 0 && readonlyMount < fstabPublish, 'read-only remounts must precede fstab publish');
const firstMaintenanceAudit = source.indexOf('maintenance_policy_count="$(maintenance_guard_audit)"');
const firstInactiveGate = source.indexOf("assert_all_services_inactive >/dev/null || fail 'inactive-service gate failed'");
const freshMaintenanceAudit = source.indexOf('[[ "$(maintenance_guard_audit)" == "$maintenance_policy_count" ]]');
assert.ok(firstMaintenanceAudit > 0 && firstMaintenanceAudit < firstInactiveGate,
  'maintenance installer audit must precede the initial inactive-service gate');
assert.ok(freshMaintenanceAudit > firstStateCopy && freshMaintenanceAudit < fstabPublish,
  'maintenance installer audit must be refreshed immediately before fstab publish');
const restoreMatch = source.match(/restore_legacy\(\) \{\n([\s\S]*?)\n\}/);
assert.ok(restoreMatch, 'restore_legacy function must be extractable');
assert.ok(restoreMatch[1].indexOf('prevalidate_rollback_evidence')
  < restoreMatch[1].indexOf('ROLLBACK_MUTATION_STARTED=1'),
  'rollback evidence must be complete before its first authorized mutation');
assert.ok(restoreMatch[1].indexOf('rollback_marker_write "$ROLLBACK_PHASE"')
  < restoreMatch[1].indexOf("migration_failpoint 'after-rollback-started-marker-before-mutation'")
  && restoreMatch[1].indexOf("migration_failpoint 'after-rollback-started-marker-before-mutation'")
    < restoreMatch[1].indexOf('ROLLBACK_MUTATION_STARTED=1'),
  'rollback-started must be durable before the fixture-only pre-mutation interruption');
assert.match(restoreMatch[1], /atomic_restore_fstab/);
assert.match(restoreMatch[1], /"\$UMOUNT_BIN" -- "\$APP_STATE"/);
assert.match(restoreMatch[1], /"\$MOUNT_BIN" -o remount,bind,rw -- "\$APP_PROFILES"/);
assert.match(restoreMatch[1], /"\$MOUNT_BIN" -- "\$APP_OUTPUTS"/);
assert.match(restoreMatch[1], /\[\[ -d "\$OUTPUTS_BACKUP" && ! -L "\$OUTPUTS_BACKUP" \]\]/);
assert.match(restoreMatch[1], /\[\[ -d "\$STATE_BACKUP" && ! -L "\$STATE_BACKUP" \]\]/);
assert.match(restoreMatch[1], /"\$SYSTEMCTL_BIN" daemon-reload/);
const atomicRestoreMatch = source.match(/atomic_restore_fstab\(\) \{\n([\s\S]*?)\n\}/);
assert.ok(atomicRestoreMatch, 'atomic fstab restore function must be extractable');
assert.match(atomicRestoreMatch[1], /mktemp "\$parent\/\.fstab\.runtime-layout-rollback\.XXXXXX"/);
assert.match(atomicRestoreMatch[1], /cp --preserve=all -- "\$FSTAB_BACKUP" "\$temp"/);
assert.match(atomicRestoreMatch[1], /sync -f -- "\$temp"/);
assert.match(atomicRestoreMatch[1], /mv -- "\$temp" "\$FSTAB"/);
assert.match(atomicRestoreMatch[1], /sync -f -- "\$parent"/);
assert.ok((source.match(/"\$SYSTEMCTL_BIN" daemon-reload/g) || []).length >= 2,
  'fstab publish and restore must both daemon-reload');

// ---------------------------------------------------------------------------
// Deterministic full-metadata fingerprint engine
// ---------------------------------------------------------------------------
const fingerprintMatch = source.match(/# FINGERPRINT_ENGINE_BEGIN\n([\s\S]*?)# FINGERPRINT_ENGINE_END/);
assert.ok(fingerprintMatch, 'fingerprint engine must be extractable');
const fingerprintTemp = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-layout-fingerprint-'));
try {
  const fingerprintRunner = path.join(fingerprintTemp, 'fingerprint.sh');
  const fingerprintTree = path.join(fingerprintTemp, 'tree');
  const fingerprintFile = path.join(fingerprintTree, 'nested', 'payload.txt');
  const fingerprintLink = path.join(fingerprintTree, 'payload-hardlink.txt');
  await fs.mkdir(path.dirname(fingerprintFile), {recursive: true});
  await fs.writeFile(fingerprintFile, 'same-bytes\n', 'utf8');
  await fs.link(fingerprintFile, fingerprintLink);
  await fs.chmod(fingerprintFile, 0o644);
  const knownMtime = new Date('2020-01-02T03:04:05.000Z');
  const knownRootMtime = new Date('2020-01-02T03:04:06.000Z');
  await fs.utimes(fingerprintFile, knownMtime, knownMtime);
  await fs.utimes(fingerprintTree, knownRootMtime, knownRootMtime);
  await fs.writeFile(fingerprintRunner, `#!/usr/bin/env bash
set -Eeuo pipefail
TAR_BIN="\${SHEIN_BI_TAR_BIN:-tar}"
FINGERPRINT_READY=1
${fingerprintMatch[1]}
fingerprint_capability
tree_fingerprint "$1"
`, 'utf8');
  await fs.chmod(fingerprintRunner, 0o755);

  const fingerprint = () => {
    const result = isWindows
      ? run(gitBash, [shellPath(fingerprintRunner), shellPath(fingerprintTree)])
      : run('/bin/bash', [fingerprintRunner, fingerprintTree]);
    assert.equal(result.status, 0, result.stderr);
    const value = result.stdout.trim().split(/\r?\n/).at(-1) || '';
    assert.match(value, /^[a-f0-9]{64}$/);
    return value;
  };

  const baselineFingerprint = fingerprint();
  assert.equal(fingerprint(), baselineFingerprint, 'unchanged metadata tree must hash deterministically');
  const oldTime = new Date('2001-01-01T00:00:00.000Z');
  await fs.utimes(fingerprintFile, oldTime, oldTime);
  assert.notEqual(fingerprint(), baselineFingerprint, 'mtime drift must change the fingerprint');
  await fs.utimes(fingerprintFile, knownMtime, knownMtime);
  assert.equal(fingerprint(), baselineFingerprint, 'restoring mtime must restore the deterministic fingerprint');

  if (!isWindows) {
    await fs.chmod(fingerprintFile, 0o600);
    assert.notEqual(fingerprint(), baselineFingerprint, 'mode drift must change the fingerprint');
    await fs.chmod(fingerprintFile, 0o644);
    assert.equal(fingerprint(), baselineFingerprint, 'restoring mode must restore the deterministic fingerprint');
  }

  await fs.rm(fingerprintLink);
  await fs.copyFile(fingerprintFile, fingerprintLink);
  await fs.chmod(fingerprintLink, 0o644);
  await fs.utimes(fingerprintTree, knownRootMtime, knownRootMtime);
  assert.notEqual(fingerprint(), baselineFingerprint,
    'two independent files with identical bytes must not equal one hard-link topology');
  await fs.rm(fingerprintLink);
  await fs.link(fingerprintFile, fingerprintLink);
  await fs.utimes(fingerprintTree, knownRootMtime, knownRootMtime);
  assert.equal(fingerprint(), baselineFingerprint, 'restoring hard-link topology must restore the fingerprint');

  if (!isWindows) {
    const setXattr = run('python3', ['-c',
      'import os,sys; os.setxattr(sys.argv[1], b"user.shein_bi_test", b"present")', fingerprintFile]);
    if (setXattr.status === 0) {
      assert.notEqual(fingerprint(), baselineFingerprint, 'xattr drift must change the fingerprint');
      const removeXattr = run('python3', ['-c',
        'import os,sys; os.removexattr(sys.argv[1], b"user.shein_bi_test")', fingerprintFile]);
      assert.equal(removeXattr.status, 0, removeXattr.stderr);
      assert.equal(fingerprint(), baselineFingerprint, 'removing the xattr must restore the fingerprint');
    }
  }
} finally {
  await fs.rm(fingerprintTemp, {recursive: true, force: true});
}

// ---------------------------------------------------------------------------
// Fstab transformer
// ---------------------------------------------------------------------------
const match = source.match(/\/\/ FSTAB_TRANSFORM_BEGIN\n([\s\S]*?)\/\/ FSTAB_TRANSFORM_END/);
assert.ok(match, 'embedded fstab transformer must be extractable');
const transformer = match[1];

const transformTemp = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-layout-fstab-'));
try {
  const fixtureRoot = path.join(transformTemp, 'opt', 'shein-bi', 'app').replaceAll('\\', '/');
  const dataRoot = path.join(transformTemp, 'data', 'shein-bi').replaceAll('\\', '/');
  const fstab = path.join(transformTemp, 'fstab');
  const dataProfiles = `${dataRoot}/profiles`;
  const dataState = `${dataRoot}/state`;
  const dataOutputs = `${dataRoot}/outputs`;
  const appProfiles = `${fixtureRoot}/profiles`;
  const appState = `${fixtureRoot}/state`;
  const appOutputs = `${fixtureRoot}/outputs`;
  const legacy = [
    '# fixture',
    '/dev/data /data ext4 defaults 0 2',
    `${dataProfiles} ${appProfiles} none bind,rw 0 0`,
    `${dataOutputs} ${appOutputs} none bind 0 0`,
    '/srv/source /srv/shein-bi/runtime none bind 0 0',
    '/srv/backup-source /srv/shein-bi/backups none bind 0 0',
    '',
  ].join('\n');
  await fs.writeFile(fstab, legacy, 'utf8');
  const args = [fstab, dataProfiles, appProfiles, dataState, appState, dataOutputs, appOutputs];
  const execute = action => spawnSync(process.execPath, ['--input-type=module', '-', action, ...args], {
    input: transformer,
    encoding: 'utf8',
  });
  const mode = execute('mode');
  assert.equal(mode.status, 0, mode.stderr);
  assert.equal(mode.stdout, 'legacy');
  const transformed = execute('content');
  assert.equal(transformed.status, 0, transformed.stderr);
  const expected = legacy
    .replace(`${dataProfiles} ${appProfiles} none bind,rw 0 0`, `${dataProfiles} ${appProfiles} none bind,ro 0 0`)
    .replace(`${dataOutputs} ${appOutputs} none bind 0 0`, `${dataState} ${appState} none bind,ro 0 0`);
  assert.equal(transformed.stdout, expected);
  assert.match(transformed.stdout, /\/srv\/source \/srv\/shein-bi\/runtime none bind 0 0/);
  assert.match(transformed.stdout, /\/srv\/backup-source \/srv\/shein-bi\/backups none bind 0 0/);
  assert.doesNotMatch(transformed.stdout, new RegExp(`${dataOutputs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+${appOutputs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

  await fs.writeFile(fstab, transformed.stdout, 'utf8');
  const v2 = execute('mode');
  assert.equal(v2.status, 0, v2.stderr);
  assert.equal(v2.stdout, 'v2');
  assert.equal(execute('content').stdout, transformed.stdout, 'v2 transform must be stable');

  await fs.writeFile(fstab, `${legacy}${dataProfiles} ${appProfiles} none bind 0 0\n`, 'utf8');
  const duplicate = execute('mode');
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /duplicate profiles fstab lines/);

  await fs.writeFile(fstab, legacy.replace(
    `${dataOutputs} ${appOutputs} none bind 0 0`,
    `${dataOutputs} ${appOutputs} none bind,nofail 0 0`,
  ), 'utf8');
  const ambiguous = execute('mode');
  assert.notEqual(ambiguous.status, 0);
  assert.match(ambiguous.stderr, /neither exact legacy nor exact v2/);
} finally {
  await fs.rm(transformTemp, {recursive: true, force: true});
}
// ---------------------------------------------------------------------------
// Runtime fixture state machine (Git Bash on Windows, /bin/bash elsewhere)
// ---------------------------------------------------------------------------
async function buildFixture(tempDir) {
  const appRoot = path.join(tempDir, 'opt', 'shein-bi', 'app');
  const dataRoot = path.join(tempDir, 'data', 'shein-bi');
  const dataParent = path.join(tempDir, 'data');
  const systemdDir = path.join(tempDir, 'systemd');
  const backupRoot = path.join(tempDir, 'backup', 'shein-bi', 'runtime', 'layout-migration-backups');
  const fstabPath = path.join(tempDir, 'fstab');
  const markerPath = path.join(tempDir, 'maintenance.json');
  const binDir = path.join(tempDir, 'bin');
  const stateFile = path.join(tempDir, 'mount-state');
  const systemctlLog = path.join(tempDir, 'systemctl.log');
  const effectiveControlsFile = path.join(tempDir, 'effective-systemd-controls.json');
  const effectiveShowCountFile = path.join(tempDir, 'effective-systemd-show-count.txt');
  const systemctlShowHelper = path.join(tempDir, 'fake-systemctl-show.mjs');

  await fs.mkdir(path.join(appRoot, 'profiles'), {recursive: true});
  await fs.mkdir(path.join(appRoot, 'state', 'locks'), {recursive: true});
  await fs.mkdir(path.join(appRoot, 'outputs', 'nested'), {recursive: true});
  await fs.mkdir(path.join(appRoot, 'scripts'), {recursive: true});
  await fs.mkdir(path.join(appRoot, 'infra', 'systemd'), {recursive: true});
  await fs.mkdir(path.join(appRoot, 'lib'), {recursive: true});
  await fs.mkdir(path.join(dataRoot, 'profiles'), {recursive: true});
  await fs.mkdir(path.join(dataRoot, 'outputs'), {recursive: true});
  await fs.mkdir(systemdDir, {recursive: true});
  await fs.mkdir(backupRoot, {recursive: true});
  await fs.mkdir(binDir, {recursive: true});

  await fs.writeFile(path.join(appRoot, 'profiles', 'profile.keep'), 'profiles-data\n', 'utf8');
  await fs.writeFile(path.join(appRoot, 'state', 'cache.json'), '{"k":1}\n', 'utf8');
  await fs.writeFile(path.join(appRoot, 'state', 'locks', '.keep'), '', 'utf8');
  await fs.writeFile(path.join(appRoot, 'outputs', 'nested', 'sample.json'), '{"report":true}\n', 'utf8');
  await fs.writeFile(path.join(appRoot, 'outputs', 'report.md'), '# report\n', 'utf8');
  await fs.writeFile(path.join(appRoot, 'outputs', 'run.sh'), '#!/bin/sh\necho hi\n', 'utf8');
  await fs.writeFile(path.join(dataRoot, 'profiles', 'login.json'), '{"state":"ok"}\n', 'utf8');
  await fs.writeFile(path.join(dataRoot, 'outputs', 'market.csv'), 'a,b\n', 'utf8');
  await fs.writeFile(markerPath, `${JSON.stringify({
    schemaVersion: 'cloud-maintenance-mode/v1',
    active: true,
    mode: 'all',
    generation: 7,
  }, null, 2)}\n`, 'utf8');

  const gitEnv = {...process.env};
  const git = (args, options = {}) => run('git', ['-C', appRoot, ...args], {...options, env: {...gitEnv, ...(options.env || {})}});
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'fixture@example.com']);
  git(['config', 'user.name', 'fixture']);
  git(['config', 'core.autocrlf', 'false']);
  git(['config', 'core.filemode', 'true']);
  git(['add', 'outputs']);
  git(['commit', '-q', '-m', 'fixture outputs']);

  await fs.copyFile(NAMESPACE_INSTALLER, path.join(appRoot, 'scripts', 'install_cloud_runtime_path_namespaces.sh'));
  let guardsContent = await fs.readFile(GUARDS_INSTALLER, 'utf8');
  if (isWindows) guardsContent = guardsContent.replace('/usr/bin/node', 'node');
  else if (!existsSync('/usr/bin/node')) {
    assert.match(process.execPath, /^\/[A-Za-z0-9._\/-]+$/,
      'clean Linux fixture Node path must be shell-safe before launcher substitution');
    guardsContent = guardsContent.replace('/usr/bin/node', process.execPath);
  }
  await fs.writeFile(path.join(appRoot, 'scripts', 'install_cloud_maintenance_guards.sh'), guardsContent, 'utf8');
  await fs.copyFile(MANAGER, path.join(appRoot, 'scripts', 'manage_cloud_maintenance_mode.mjs'));
  for (const lib of [
    'cloud_runtime_path_policy.mjs',
    'cloud_maintenance_mode.mjs',
    'cloud_runtime_inventory.mjs',
    'cloud_runtime_snapshot.mjs',
    'systemd_unit_snapshot.mjs',
    'source_release_attestation.mjs',
    'atomic_file_publish.mjs',
  ]) {
    await fs.copyFile(path.join(ROOT, 'lib', lib), path.join(appRoot, 'lib', lib));
  }
  for (const file of await fs.readdir(SYSTEMD_SOURCE)) {
    await fs.copyFile(path.join(SYSTEMD_SOURCE, file), path.join(appRoot, 'infra', 'systemd', file));
  }

  const servicesFile = path.join(tempDir, 'services.txt');

  const dataProfiles = `${dataRoot}/profiles`;
  const dataState = `${dataRoot}/state`;
  const dataOutputs = `${dataRoot}/outputs`;
  const appProfiles = `${appRoot}/profiles`;
  const appState = `${appRoot}/state`;
  const appOutputs = `${appRoot}/outputs`;
  const m = p => canonicalShellPath(p).replace(/\/+$/u, '');
  const win = p => {
    if (!isWindows) return p;
    const result = run(cygpath, ['-a', '-w', m(p)]);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().replaceAll('\\', '/');
  };
  const legacyFstab = [
    '# fixture fstab',
    '/dev/data /data ext4 defaults 0 2',
    `${win(dataProfiles)} ${win(appProfiles)} none bind,rw 0 0`,
    `${win(dataOutputs)} ${win(appOutputs)} none bind 0 0`,
    '',
  ].join('\n');
  await fs.writeFile(fstabPath, legacyFstab, 'utf8');
  await fs.chmod(fstabPath, 0o640);

  const effectiveControls = {};
  for (const [service, unitClass] of Object.entries(CLOUD_MAINTENANCE_POLICY_BY_SERVICE)) {
    const directives = cloudRuntimePathEffectiveDirectives(
      service,
      CLOUD_RUNTIME_PATH_POLICY_BY_SERVICE[service],
    );
    effectiveControls[service] = {
      Id: service,
      LoadState: 'loaded',
      ActiveState: 'inactive',
      SubState: 'dead',
      Result: 'success',
      StateChangeTimestamp: '',
      ActiveEnterTimestamp: '',
      ExecMainCode: '0',
      ExecMainStatus: '0',
      ExecMainStartTimestamp: '',
      ExecMainExitTimestamp: '',
      NRestarts: '0',
      ExecCondition: unitClass === 'always'
        ? ''
        : expectedCloudMaintenanceExecCondition(service, unitClass, '%n'),
      // Production systemd appends base-unit/implicit mount dependencies (for
      // example WorkingDirectory and PrivateTmp). They are legitimate extras;
      // the canonical runtime mount set remains mandatory.
      RequiresMountsFor: [...directives.requiresMountsFor, '/implicit/base-unit-mount'].join(' '),
      BindPaths: directives.bindPaths.join(' '),
      BindReadOnlyPaths: directives.bindReadOnlyPaths.join(' '),
      ReadOnlyPaths: directives.readOnlyPaths.join(' '),
      InaccessiblePaths: directives.inaccessiblePaths.join(' '),
    };
  }
  await fs.writeFile(effectiveControlsFile, `${JSON.stringify(effectiveControls, null, 2)}\n`, 'utf8');
  await fs.writeFile(effectiveShowCountFile, '0\n', 'utf8');
  await fs.writeFile(systemctlShowHelper, `import fs from 'node:fs';
const [controlsFile, logFile, countFile, ...args] = process.argv.slice(2);
const controls = JSON.parse(fs.readFileSync(controlsFile, 'utf8'));
const propertyArg = args.find(value => value.startsWith('--property='));
const properties = propertyArg ? propertyArg.slice('--property='.length).split(',').filter(Boolean) : [];
const services = args.filter(value => /^[A-Za-z0-9_.@-]+\\.service$/.test(value));
const directReadback = properties.includes('BindPaths');
let directCount = Number.parseInt(fs.readFileSync(countFile, 'utf8').trim() || '0', 10) || 0;
if (directReadback) {
  directCount += 1;
  fs.writeFileSync(countFile, String(directCount) + '\\n');
}
const overrideService = String(process.env.SHEIN_BI_TEST_DIRECT_EXEC_CONDITION_OVERRIDE_SERVICE || '');
const driftAfter = Number.parseInt(process.env.SHEIN_BI_TEST_EXEC_CONDITION_DRIFT_AFTER_DIRECT_SHOW || '0', 10) || 0;
const fstabDriftAfter = Number.parseInt(process.env.SHEIN_BI_TEST_FSTAB_DRIFT_AFTER_DIRECT_SHOW || '0', 10) || 0;
const fstabDriftPath = String(process.env.SHEIN_BI_TEST_FSTAB_DRIFT_PATH || '');
const fstabDriftBytes = String(process.env.SHEIN_BI_TEST_FSTAB_DRIFT_BYTES || '');
const pathDriftService = String(process.env.SHEIN_BI_TEST_RUNTIME_PATH_DRIFT_AFTER_DAEMON_RELOAD || '');
const daemonReloaded = fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf8')
  .split(/\\r?\\n/).some(line => line.trim() === 'daemon-reload');
if (directReadback && fstabDriftAfter > 0 && directCount === fstabDriftAfter) {
  if (!fstabDriftPath || !fstabDriftBytes) throw new Error('fstab drift injection is incomplete');
  const driftTemp = fstabDriftPath + '.test-drift-' + process.pid;
  const original = fs.readFileSync(fstabDriftPath);
  const mode = fs.statSync(fstabDriftPath).mode;
  fs.writeFileSync(driftTemp, Buffer.concat([original, Buffer.from(fstabDriftBytes)]), {mode});
  fs.renameSync(driftTemp, fstabDriftPath);
}
for (const service of services) {
  const base = controls[service];
  if (!base) continue;
  const unit = {...base};
  if (directReadback && (overrideService === service || (driftAfter > 0 && directCount >= driftAfter))) {
    unit.ExecCondition = '/usr/bin/false --effective-override';
  }
  if (daemonReloaded && pathDriftService === service) {
    unit.BindPaths = (unit.BindPaths + ' /unexpected-effective-source:/unexpected-effective-target').trim();
  }
  for (const property of properties) {
    process.stdout.write(property + '=' + String(unit[property] ?? '') + '\\n');
  }
  process.stdout.write('\\n');
}
`, 'utf8');

  // fake external binaries -------------------------------------------------
  const fakeMount = `#!/usr/bin/env bash
set -euo pipefail
STATE="\${SHEIN_BI_MOUNT_STATE:?}"
target=''
options='rw'
args=("$@")
i=0
while ((i < $#)); do
  a="\${args[$i]}"
  if [[ "$a" == '-o' ]]; then
    i=$((i+1))
    opt="\${args[$i]}"
    case "$opt" in
      *bind,ro*) options='ro' ;;
      *bind,rw*) options='rw' ;;
      *ro*) options='ro' ;;
      *rw*) options='rw' ;;
    esac
  elif [[ "$a" == '--' ]]; then
    i=$((i+1)); target="\${args[$i]}"
  elif [[ "$a" == -* ]]; then
    :
  else
    target="$a"
  fi
  i=$((i+1))
done
[[ -n "$target" ]] || exit 2
tmp="$STATE.$$"
grep -v "^\${target} " "$STATE" > "$tmp" 2>/dev/null || true
printf '%s ext4 %s\\n' "$target" "$options" >> "$tmp"
mv -f "$tmp" "$STATE"
`;
  const fakeUmount = `#!/usr/bin/env bash
set -euo pipefail
STATE="\${SHEIN_BI_MOUNT_STATE:?}"
target=''
args=("$@")
i=0
while ((i < $#)); do
  a="\${args[$i]}"
  if [[ "$a" == '--' ]]; then
    i=$((i+1)); target="\${args[$i]}"
  elif [[ "$a" == -* ]]; then
    :
  else
    target="$a"
  fi
  i=$((i+1))
done
[[ -n "$target" ]] || exit 2
tmp="$STATE.$$"
grep -v "^\${target} " "$STATE" > "$tmp" 2>/dev/null || true
mv -f "$tmp" "$STATE"
`;
  const fakeMountpoint = `#!/usr/bin/env bash
set -euo pipefail
STATE="\${SHEIN_BI_MOUNT_STATE:?}"
target=''
args=("$@")
i=0
while ((i < $#)); do
  a="\${args[$i]}"
  if [[ "$a" == '--' ]]; then
    i=$((i+1)); target="\${args[$i]}"
  elif [[ "$a" == -* ]]; then
    :
  else
    target="$a"
  fi
  i=$((i+1))
done
[[ -n "$target" ]] || exit 2
grep -q "^\${target} " "$STATE" || exit 1
exit 0
`;
  const fakeFindmnt = `#!/usr/bin/env bash
set -euo pipefail
STATE="\${SHEIN_BI_MOUNT_STATE:?}"
fields=''
target=''
args=("$@")
i=0
while ((i < $#)); do
  a="\${args[$i]}"
  case "$a" in
    -o) i=$((i+1)); fields="\${args[$i]}" ;;
    --target) i=$((i+1)); target="\${args[$i]}" ;;
    -*) : ;;
    *) target="$a" ;;
  esac
  i=$((i+1))
done
[[ -n "$target" ]] || exit 2
line="$(grep "^\${target} " "$STATE" || true)"
[[ -n "$line" ]] || exit 1
fstype="$(printf '%s\\n' "$line" | awk '{print $2}')"
options="$(printf '%s\\n' "$line" | awk '{print $3}')"
case "$fields" in
  TARGET,FSTYPE) printf '%s %s\\n' "$target" "$fstype" ;;
  OPTIONS) printf '%s\\n' "$options" ;;
esac
`;
  const fakeSystemctl = `#!/usr/bin/env bash
set -euo pipefail
SERVICES="\${SHEIN_BI_SERVICES_FILE:?}"
LOG="\${SHEIN_BI_SYSTEMCTL_LOG:?}"
REQUIRES="\${SHEIN_BI_SYSTEMCTL_REQUIRES:?}"
cmd="\${@:1:1}"
case "$cmd" in
  daemon-reload) printf '%s\\n' daemon-reload >> "$LOG" ;;
  list-unit-files)
    while IFS= read -r svc; do printf '%s enabled\\n' "$svc"; done < "$SERVICES"
    ;;
  is-active)
    printf '%s\\n' inactive
    exit 1
    ;;
  show)
    value_mode=0
    property=''
    unit=''
    for arg in "$@"; do
      case "$arg" in
        --value) value_mode=1 ;;
        --property=*) property="\${arg#--property=}" ;;
        *.mount|*.service) unit="$arg" ;;
      esac
    done
    if ((value_mode)); then
      if [[ "$property" == LoadState ]]; then
        if [[ "$unit" == *outputs* ]]; then printf '%s\\n' not-found; else printf '%s\\n' loaded; fi
      elif [[ "$property" == RequiresMountsFor ]]; then
        printf '%s\\n' "$REQUIRES"
      else
        exit 2
      fi
    else
      node "$SHEIN_BI_SYSTEMCTL_SHOW_HELPER" \
        "$SHEIN_BI_EFFECTIVE_CONTROLS_FILE" "$LOG" "$SHEIN_BI_EFFECTIVE_SHOW_COUNT_FILE" "$@"
    fi
    ;;
  *) exit 2 ;;
esac
`;
  const fakeSystemdEscape = `#!/usr/bin/env bash
set -euo pipefail
path=''
for a in "$@"; do
  if [[ "$a" != -* ]]; then path="$a"; fi
done
[[ -n "$path" ]] || exit 2
s="\${path//\\//-}"
printf '%s.mount\\n' "$s"
`;
  const fakePgrep = '#!/usr/bin/env bash\nexit 1\n';
  const fakeRsync = `#!/usr/bin/env bash
set -euo pipefail
src=''
dst=''
for a in "$@"; do
  if [[ "$a" != -* ]]; then
    if [[ -z "$src" ]]; then src="$a"; else dst="$a"; fi
  fi
done
[[ -n "$src" && -n "$dst" ]] || exit 2
if [[ "\${@:1:1}" == *n* ]]; then
  if ! diff -rq "$src" "$dst" >/dev/null 2>&1; then
    printf '>%s\\n' "$dst"
  fi
  exit 0
fi
mkdir -p "$dst"
cp -a "\${src}." "\${dst}/"
`;
  const fakeBins = {
    'fake-mount.sh': fakeMount,
    'fake-umount.sh': fakeUmount,
    'fake-mountpoint.sh': fakeMountpoint,
    'fake-findmnt.sh': fakeFindmnt,
    'fake-systemctl.sh': fakeSystemctl,
    'fake-systemd-escape.sh': fakeSystemdEscape,
    'fake-pgrep.sh': fakePgrep,
    'fake-rsync.sh': fakeRsync,
  };
  for (const [name, content] of Object.entries(fakeBins)) {
    await fs.writeFile(path.join(binDir, name), content, 'utf8');
  }

  const chmodResult = isWindows
    ? run(gitBash, ['-c', `chmod 755 "${m(binDir)}"/*.sh`])
    : run('/bin/bash', ['-c', `chmod 755 "${m(binDir)}"/*.sh`]);
  assert.equal(chmodResult.status, 0, chmodResult.stderr);

  // legacy mount topology: profiles rw bind, outputs rw bind, state unmounted,
  // data parent mount persistent
  await fs.writeFile(stateFile, [
    `${m(dataParent)} ext4 defaults`,
    `${m(appProfiles)} ext4 rw`,
    `${m(appOutputs)} ext4 rw`,
    '',
  ].join('\n'), 'utf8');

  const fx = {
    appRoot, dataRoot, dataParent, systemdDir, backupRoot, fstabPath, markerPath, binDir, stateFile,
    systemctlLog, servicesFile, effectiveControlsFile, effectiveShowCountFile, systemctlShowHelper,
    dataProfiles, dataState, dataOutputs, appProfiles, appState, appOutputs, legacyFstab,
    m,
    w: win,
  };
  fx.baseArgs = [
    '--fixture',
    '--root', m(appRoot),
    '--data-root', m(dataRoot),
    '--fstab', m(fstabPath),
    '--systemd-dir', m(systemdDir),
    '--maintenance-marker', m(markerPath),
    '--backup-root', m(backupRoot),
  ];
  fx.baseEnv = {
    SHEIN_BI_SYSTEMCTL_BIN: m(path.join(binDir, 'fake-systemctl.sh')),
    SHEIN_BI_FINDMNT_BIN: m(path.join(binDir, 'fake-findmnt.sh')),
    SHEIN_BI_MOUNTPOINT_BIN: m(path.join(binDir, 'fake-mountpoint.sh')),
    SHEIN_BI_MOUNT_BIN: m(path.join(binDir, 'fake-mount.sh')),
    SHEIN_BI_UMOUNT_BIN: m(path.join(binDir, 'fake-umount.sh')),
    SHEIN_BI_PGREP_BIN: m(path.join(binDir, 'fake-pgrep.sh')),
    SHEIN_BI_RSYNC_BIN: m(path.join(binDir, 'fake-rsync.sh')),
    SHEIN_BI_SYSTEMD_ESCAPE_BIN: m(path.join(binDir, 'fake-systemd-escape.sh')),
    SHEIN_BI_MOUNT_STATE: m(stateFile),
    SHEIN_BI_SERVICES_FILE: m(servicesFile),
    SHEIN_BI_SYSTEMCTL_LOG: m(systemctlLog),
    SHEIN_BI_SYSTEMCTL_REQUIRES: `${m(dataProfiles)} ${m(dataState)} ${m(dataOutputs)}`,
    SHEIN_BI_EFFECTIVE_CONTROLS_FILE: m(effectiveControlsFile),
    SHEIN_BI_EFFECTIVE_SHOW_COUNT_FILE: m(effectiveShowCountFile),
    SHEIN_BI_SYSTEMCTL_SHOW_HELPER: m(systemctlShowHelper),
  };

  // Settle the 28-service maintenance guards and namespace drop-ins. On
  // Windows the guard manager spawns systemctl directly from Node, so the
  // apply phase uses node.exe plus exact daemon-reload/show subcommand shims.
  // The show shim emits daemon-loaded properties in systemctl's block format;
  // a disk-only fixture must not bypass the effective guard readback.
  const installEnv = isWindows
    ? {...process.env, ...fx.baseEnv, SHEIN_BI_SYSTEMCTL_BIN: process.execPath, SHEIN_BI_SYSTEMCTL_LOG: systemctlLog}
    : {...process.env, ...fx.baseEnv};
  if (isWindows) {
    await fs.writeFile(path.join(tempDir, 'daemon-reload'),
      ["const fs = require", "('node:fs');\nfs.appendFileSync(process.env.SHEIN_BI_SYSTEMCTL_LOG, 'daemon-reload\\n');\n"].join(''),
      'utf8');
    const policyJson = JSON.stringify(CLOUD_MAINTENANCE_POLICY_BY_SERVICE);
    await fs.writeFile(path.join(tempDir, 'show'), [
      `const policy = ${policyJson};\n`,
      "const services = process.argv.slice(2).filter(value => value && !value.startsWith('--'));\n",
      "for (const service of services) {\n",
      "  const unitClass = policy[service];\n",
      "  if (!unitClass) continue;\n",
      "  const condition = unitClass === 'always' ? '' : `/usr/bin/node /opt/shein-bi/app/scripts/manage_cloud_maintenance_mode.mjs systemd-condition --class ${unitClass} --unit %n`;\n",
      "  process.stdout.write(`Id=${service}\\nLoadState=loaded\\nExecCondition=${condition}\\n\\n`);\n",
      "}\n",
    ].join(''), 'utf8');
  }
  const bash = isWindows ? gitBash : '/bin/bash';
  const nsInstall = run(bash, [
    m(path.join(appRoot, 'scripts', 'install_cloud_runtime_path_namespaces.sh')),
    '--root', m(appRoot), '--systemd-dir', m(systemdDir),
    '--apply', '--confirm', 'INSTALL_CLOUD_RUNTIME_PATH_NAMESPACES',
  ], {env: installEnv, cwd: tempDir});
  assert.equal(nsInstall.status, 0, nsInstall.stderr);
  const guardInstall = run(bash, [
    m(path.join(appRoot, 'scripts', 'install_cloud_maintenance_guards.sh')),
    '--systemd-root', m(systemdDir),
    '--apply', '--confirm', 'APPLY_CLOUD_MAINTENANCE_GUARDS_V1',
  ], {env: installEnv, cwd: tempDir});
  assert.equal(guardInstall.status, 0, guardInstall.stderr);
  const installedServices = (await fs.readdir(systemdDir))
    .filter(name => name.endsWith('.d'))
    .map(name => name.slice(0, -2))
    .filter(service => service.endsWith('.service')
      && existsSync(path.join(systemdDir, `${service}.d`, '50-runtime-paths.conf')))
    .sort();
  assert.ok(installedServices.length > 0, 'no runtime path drop-ins were installed');
  await fs.writeFile(servicesFile, `${installedServices.join('\n')}\n`, 'utf8');
  await fs.writeFile(systemctlLog, '', 'utf8');
  await fs.writeFile(effectiveShowCountFile, '0\n', 'utf8');
  return fx;
}

function invoke(fx, args, extraEnv = {}, options = {}) {
  const env = {...process.env, ...fx.baseEnv, ...extraEnv};
  if (isWindows) {
    return run(gitBash, [shellPath(MIGRATOR), ...args], {env, ...options});
  }
  return run('/bin/bash', [MIGRATOR, ...args], {env, ...options});
}

async function readMountState(fx) {
  const text = await fs.readFile(fx.stateFile, 'utf8');
  const mounts = {};
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/u);
    if (parts.length >= 3) mounts[parts[0]] = {fstype: parts[1], options: parts[2]};
  }
  return mounts;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function runDirOf(fx) {
  const entries = await fs.readdir(fx.backupRoot);
  assert.equal(entries.length, 1, `expected exactly one backup run dir, got ${entries.join(',')}`);
  return path.join(fx.backupRoot, entries[0]);
}

async function expectTrackedClean(fx) {
  const result = run('git', ['-C', fx.appRoot, 'status', '--porcelain', '--untracked-files=no', '--', 'outputs']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '');
}
// ---------------------------------------------------------------------------
// Scenario A: clean legacy -> v2 migration, idempotent re-run, audit
// ---------------------------------------------------------------------------
{
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-layout-a-'));
  try {
    const fx = await buildFixture(tempDir);
    const audit = invoke(fx, fx.baseArgs);
    assert.equal(audit.status, 0, audit.stderr);
    const auditResult = JSON.parse(audit.stdout);
    assert.equal(auditResult.mode, 'audit');
    assert.equal(auditResult.layout, 'legacy');
    assert.equal(auditResult.maintenanceMode, 'all');
    assert.equal(await fs.readdir(fx.backupRoot).then(list => list.length), 0, 'audit must not create a backup run');

    const noConfirm = invoke(fx, [...fx.baseArgs, '--apply']);
    assert.equal(noConfirm.status, 64);
    const wrongConfirm = invoke(fx, [...fx.baseArgs, '--apply', '--confirm', 'WRONG']);
    assert.equal(wrongConfirm.status, 64);

    const apply = invoke(fx, [...fx.baseArgs, '--apply', '--confirm', CONFIRMATION]);
    assert.equal(apply.status, 0, apply.stderr);
    const result = JSON.parse(apply.stdout);
    assert.equal(result.mode, 'apply');
    assert.equal(result.layout, 'v2');
    assert.equal(result.recovery, 'fresh');
    assert.equal(result.hostProfiles, 'ro');
    assert.equal(result.hostState, 'ro');
    assert.equal(result.hostOutputsMounted, false);
    assert.equal(result.generatedMountContract, true);

    const fstabNow = await fs.readFile(fx.fstabPath, 'utf8');
    assert.match(fstabNow, new RegExp(`${fx.w(fx.dataProfiles)} ${fx.w(fx.appProfiles)} none bind,ro 0 0`));
    assert.match(fstabNow, new RegExp(`${fx.w(fx.dataState)} ${fx.w(fx.appState)} none bind,ro 0 0`));
    assert.doesNotMatch(fstabNow, new RegExp(`^${fx.w(fx.dataOutputs)} .*${fx.w(fx.appOutputs)}`, 'm'));

    const mounts = await readMountState(fx);
    assert.equal(mounts[fx.m(fx.appProfiles)].options, 'ro');
    assert.equal(mounts[fx.m(fx.appState)].options, 'ro');
    assert.ok(!mounts[fx.m(fx.appOutputs)], 'outputs must not remain mounted');

    const runDir = await runDirOf(fx);
    const journal = await readJson(path.join(runDir, 'migration-journal.json'));
    assert.equal(journal.phase, 'verified');
    assert.equal(journal.paths.backupRunDir, `${fx.w(fx.backupRoot)}/${journal.stamp}`);
    const status = await readJson(path.join(runDir, 'migration-status.json'));
    assert.equal(status.status, 'complete');
    await fs.lstat(path.join(runDir, 'fstab'));
    await fs.lstat(path.join(runDir, 'state-underlay', 'cache.json'));
    await fs.lstat(path.join(runDir, 'outputs-git-underlay', 'nested', 'sample.json'));
    await fs.lstat(path.join(fx.dataRoot, 'state', 'cache.json'));
    await expectTrackedClean(fx);

    const rerun = invoke(fx, [...fx.baseArgs, '--apply', '--confirm', CONFIRMATION]);
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.match(rerun.stdout, /"recovery":"already-complete"/);

    const audit2 = invoke(fx, fx.baseArgs);
    assert.equal(audit2.status, 0, audit2.stderr);
    const audit2Result = JSON.parse(audit2.stdout);
    assert.equal(audit2Result.layout, 'v2');
    assert.equal(audit2Result.recovery.action, 'complete');

    const rollbackRefused = invoke(fx, [...fx.baseArgs, '--rollback', '--confirm', CONFIRMATION]);
    assert.notEqual(rollbackRefused.status, 0);
    assert.match(rollbackRefused.stderr, /already complete/);

    console.log('scenario A: fresh apply + idempotent rerun OK');
  } finally {
    await fs.rm(tempDir, {recursive: true, force: true});
  }
}

// ---------------------------------------------------------------------------
// Scenario B: hard kill AFTER fstab publish (durable phase fstab-published),
// re-invoke must resume forward without EXIT-trap rollback
// ---------------------------------------------------------------------------
{
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-layout-b-'));
  try {
    const fx = await buildFixture(tempDir);
    const killed = invoke(fx, [...fx.baseArgs, '--apply', '--confirm', CONFIRMATION], {SHEIN_BI_MIGRATION_STAGE_LIMIT: '8'});
    assert.notEqual(killed.status, 0, 'stage-limit run must be hard-killed');
    assert.ok(!killed.stdout.includes('"ok":true'), 'no completion JSON after hard kill');
    assert.match(killed.stderr, /stage_limit_8_reached_phase=fstab-published/);

    const runDir = await runDirOf(fx);
    const journal = await readJson(path.join(runDir, 'migration-journal.json'));
    assert.equal(journal.phase, 'fstab-published', 'journal must record the durable phase reached before the kill');
    const status = await readJson(path.join(runDir, 'migration-status.json'));
    assert.equal(status.status, 'started', 'EXIT trap must not have rolled back after SIGKILL');
    const fstabNow = await fs.readFile(fx.fstabPath, 'utf8');
    assert.match(fstabNow, new RegExp(`${fx.w(fx.dataProfiles)} ${fx.w(fx.appProfiles)} none bind,ro 0 0`), 'fstab publish must already be durable');
    const mounts = await readMountState(fx);
    assert.equal(mounts[fx.m(fx.appProfiles)].options, 'ro');
    assert.equal(mounts[fx.m(fx.appState)].options, 'ro');
    assert.ok(!mounts[fx.m(fx.appOutputs)]);
    await fs.lstat(path.join(fx.dataRoot, 'state', 'cache.json'));

    const resume = invoke(fx, [...fx.baseArgs, '--apply', '--confirm', CONFIRMATION]);
    assert.equal(resume.status, 0, resume.stderr);
    const result = JSON.parse(resume.stdout);
    assert.equal(result.layout, 'v2');
    assert.equal(result.recovery, 'resumed:fstab-published');
    assert.equal(result.generatedMountContract, true);
    const journal2 = await readJson(path.join(runDir, 'migration-journal.json'));
    assert.equal(journal2.phase, 'verified');
    const status2 = await readJson(path.join(runDir, 'migration-status.json'));
    assert.equal(status2.status, 'complete');
    await expectTrackedClean(fx);
    console.log('scenario B: kill after fstab publish -> resume to verified OK');
  } finally {
    await fs.rm(tempDir, {recursive: true, force: true});
  }
}

// ---------------------------------------------------------------------------
// Scenario C: hard kill BEFORE fstab publish (phase outputs-underlay-moved,
// fstab still legacy); re-invoke must resume forward, not regress
// ---------------------------------------------------------------------------
{
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-layout-c-'));
  try {
    const fx = await buildFixture(tempDir);
    const killed = invoke(fx, [...fx.baseArgs, '--apply', '--confirm', CONFIRMATION], {SHEIN_BI_MIGRATION_STAGE_LIMIT: '4'});
    assert.notEqual(killed.status, 0, 'stage-limit run must be hard-killed');
    assert.match(killed.stderr, /stage_limit_4_reached_phase=outputs-underlay-moved/);

    const runDir = await runDirOf(fx);
    const journal = await readJson(path.join(runDir, 'migration-journal.json'));
    assert.equal(journal.phase, 'outputs-underlay-moved');
    const status = await readJson(path.join(runDir, 'migration-status.json'));
    assert.equal(status.status, 'started');
    const fstabNow = await fs.readFile(fx.fstabPath, 'utf8');
    assert.match(fstabNow, new RegExp(`${fx.w(fx.dataProfiles)} ${fx.w(fx.appProfiles)} none bind,rw 0 0`), 'fstab must still be legacy before publish');
    await fs.lstat(path.join(fx.appRoot, 'state', 'cache.json'), 'state underlay must still be in place');
    await fs.lstat(path.join(runDir, 'outputs-git-underlay', 'nested', 'sample.json'));
    await fs.lstat(path.join(fx.dataRoot, 'state', 'cache.json'));

    const resume = invoke(fx, [...fx.baseArgs, '--apply', '--confirm', CONFIRMATION]);
    assert.equal(resume.status, 0, resume.stderr);
    const result = JSON.parse(resume.stdout);
    assert.equal(result.layout, 'v2');
    assert.equal(result.recovery, 'resumed:outputs-underlay-moved');
    const journal2 = await readJson(path.join(runDir, 'migration-journal.json'));
    assert.equal(journal2.phase, 'verified');
    await expectTrackedClean(fx);
    console.log('scenario C: kill before fstab publish -> resume to verified OK');
  } finally {
    await fs.rm(tempDir, {recursive: true, force: true});
  }
}

// ---------------------------------------------------------------------------
// Scenario D: explicit --rollback from a half-migrated state, then a fresh
// migration from the restored legacy topology
// ---------------------------------------------------------------------------
{
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-layout-d-'));
  try {
    const fx = await buildFixture(tempDir);
    const killed = invoke(fx, [...fx.baseArgs, '--apply', '--confirm', CONFIRMATION], {SHEIN_BI_MIGRATION_STAGE_LIMIT: '6'});
    assert.notEqual(killed.status, 0);
    assert.match(killed.stderr, /stage_limit_6_reached_phase=readonly-mounts-done/);
    const runDir = await runDirOf(fx);
    let journal = await readJson(path.join(runDir, 'migration-journal.json'));
    assert.equal(journal.phase, 'readonly-mounts-done');

    const rollback = invoke(fx, [...fx.baseArgs, '--rollback', '--confirm', CONFIRMATION]);
    assert.equal(rollback.status, 0, rollback.stderr);
    const rbResult = JSON.parse(rollback.stdout);
    assert.equal(rbResult.mode, 'rollback');
    assert.equal(rbResult.layout, 'legacy');
    assert.equal(rbResult.hostState, 'unmounted');
    assert.equal(rbResult.hostOutputsMounted, true);

    const fstabNow = await fs.readFile(fx.fstabPath, 'utf8');
    assert.match(fstabNow, new RegExp(`${fx.w(fx.dataProfiles)} ${fx.w(fx.appProfiles)} none bind,rw 0 0`));
    assert.match(fstabNow, new RegExp(`${fx.w(fx.dataOutputs)} ${fx.w(fx.appOutputs)} none bind 0 0`));
    const mounts = await readMountState(fx);
    assert.equal(mounts[fx.m(fx.appProfiles)].options, 'rw');
    assert.equal(mounts[fx.m(fx.appOutputs)].options, 'rw');
    assert.ok(!mounts[fx.m(fx.appState)], 'state must be unmounted after rollback');
    await fs.lstat(path.join(fx.appRoot, 'state', 'cache.json'), 'original state underlay must be restored');
    await fs.lstat(path.join(fx.appRoot, 'outputs', 'nested', 'sample.json'), 'original outputs underlay must be restored');
    await assert.rejects(fs.lstat(path.join(fx.dataRoot, 'state')), error => error.code === 'ENOENT', 'canonical state must be removed on rollback');
    journal = await readJson(path.join(runDir, 'migration-journal.json'));
    assert.equal(journal.phase, 'rolled-back');
    const status = await readJson(path.join(runDir, 'migration-status.json'));
    assert.equal(status.status, 'rolled_back');

    const fresh = invoke(fx, [...fx.baseArgs, '--apply', '--confirm', CONFIRMATION]);
    assert.equal(fresh.status, 0, fresh.stderr);
    const result = JSON.parse(fresh.stdout);
    assert.equal(result.layout, 'v2');
    assert.equal(result.recovery, 'fresh');
    const runDirs = await fs.readdir(fx.backupRoot);
    assert.equal(runDirs.length, 2, 'a new run directory must be created after rollback');
    console.log('scenario D: explicit rollback restores exact legacy; fresh re-migration OK');
  } finally {
    await fs.rm(tempDir, {recursive: true, force: true});
  }
}
// ---------------------------------------------------------------------------
// Scenario E: tampered journal must fail closed without touching topology
// ---------------------------------------------------------------------------
{
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-layout-e-'));
  try {
    const fx = await buildFixture(tempDir);
    const killed = invoke(fx, [...fx.baseArgs, '--apply', '--confirm', CONFIRMATION], {SHEIN_BI_MIGRATION_STAGE_LIMIT: '4'});
    assert.notEqual(killed.status, 0);
    const runDir = await runDirOf(fx);
    const fstabBefore = await fs.readFile(fx.fstabPath, 'utf8');
    const mountsBefore = await readMountState(fx);
    await fs.writeFile(path.join(runDir, 'migration-journal.json'), '{not-json\n', 'utf8');
    const resume = invoke(fx, [...fx.baseArgs, '--apply', '--confirm', CONFIRMATION]);
    assert.notEqual(resume.status, 0, 'tampered journal must be rejected');
    assert.match(resume.stderr, /unreadable or tampered/);
    assert.equal(await fs.readFile(fx.fstabPath, 'utf8'), fstabBefore, 'fstab must remain untouched on unreadable journal');
    assert.deepEqual(await readMountState(fx), mountsBefore, 'mount topology must remain untouched on unreadable journal');
    assert.equal(await fs.readFile(path.join(runDir, 'migration-journal.json'), 'utf8'), '{not-json\n', 'tampered journal must not be rewritten');
    console.log('scenario E: tampered journal fails closed without mutation OK');
  } finally {
    await fs.rm(tempDir, {recursive: true, force: true});
  }
}

// ---------------------------------------------------------------------------
// Scenario F: tampered backup must fail closed; restore must refuse
// ---------------------------------------------------------------------------
{
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-layout-f-'));
  try {
    const fx = await buildFixture(tempDir);
    const killed = invoke(fx, [...fx.baseArgs, '--apply', '--confirm', CONFIRMATION], {SHEIN_BI_MIGRATION_STAGE_LIMIT: '8'});
    assert.notEqual(killed.status, 0);
    const runDir = await runDirOf(fx);
    await fs.writeFile(path.join(runDir, 'state-underlay', 'tampered.txt'), 'injected\n', 'utf8');
    const fstabBefore = await fs.readFile(fx.fstabPath, 'utf8');
    const mountsBefore = await readMountState(fx);
    const resume = invoke(fx, [...fx.baseArgs, '--apply', '--confirm', CONFIRMATION]);
    assert.notEqual(resume.status, 0, 'tampered backup must be rejected');
    assert.match(resume.stderr, /state underlay backup fingerprint mismatch/);
    assert.match(resume.stderr, /runtime_layout_recovery=preserved_for_resume_or_explicit_rollback/,
      'tampered evidence must be preserved in place instead of triggering an implicit rollback');
    assert.doesNotMatch(resume.stderr, /runtime_layout_restore_legacy=starting/,
      'evidence drift must never authorize a second topology mutation');
    assert.equal(await fs.readFile(fx.fstabPath, 'utf8'), fstabBefore, 'fstab must remain untouched on tampered backup');
    assert.deepEqual(await readMountState(fx), mountsBefore, 'mount topology must remain untouched on tampered backup');
    await fs.lstat(path.join(runDir, 'state-underlay', 'tampered.txt'));
    console.log('scenario F: tampered backup fails closed without mutation OK');
  } finally {
    await fs.rm(tempDir, {recursive: true, force: true});
  }
}

// ---------------------------------------------------------------------------
// Scenario G: legacy v1 record adoption (previously published half state)
// ---------------------------------------------------------------------------
{
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-layout-g-'));
  try {
    const fx = await buildFixture(tempDir);
    const killed = invoke(fx, [...fx.baseArgs, '--apply', '--confirm', CONFIRMATION], {SHEIN_BI_MIGRATION_STAGE_LIMIT: '8'});
    assert.notEqual(killed.status, 0);
    const runDir = await runDirOf(fx);
    await fs.rm(path.join(runDir, 'migration-journal.json'));
    await fs.writeFile(path.join(runDir, 'migration-status.json'), `${JSON.stringify({
      schemaVersion: 'cloud-runtime-layout-migration-status/v1',
      stamp: path.basename(runDir),
      status: 'started',
      message: 'legacy record simulating a crash after fstab publish',
      recordedAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8');
    const fstabNow = await fs.readFile(fx.fstabPath, 'utf8');
    assert.match(fstabNow, new RegExp(`${fx.w(fx.dataProfiles)} ${fx.w(fx.appProfiles)} none bind,ro 0 0`));

    const resume = invoke(fx, [...fx.baseArgs, '--apply', '--confirm', CONFIRMATION]);
    assert.equal(resume.status, 0, resume.stderr);
    const result = JSON.parse(resume.stdout);
    assert.equal(result.layout, 'v2');
    assert.equal(result.recovery, 'adopted-legacy:state-underlay-moved');
    const journal = await readJson(path.join(runDir, 'migration-journal.json'));
    assert.equal(journal.phase, 'verified');
    assert.equal(journal.schemaVersion, 'cloud-runtime-layout-migration-journal/v2');
    const status = await readJson(path.join(runDir, 'migration-status.json'));
    assert.equal(status.status, 'complete');
    await expectTrackedClean(fx);
    console.log('scenario G: legacy v1 record adoption resumes to verified OK');
  } finally {
    await fs.rm(tempDir, {recursive: true, force: true});
  }
}

// ---------------------------------------------------------------------------
// Scenario H: current fstab drifted before publish must fail closed
// ---------------------------------------------------------------------------
{
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-layout-h-'));
  try {
    const fx = await buildFixture(tempDir);
    const killed = invoke(fx, [...fx.baseArgs, '--apply', '--confirm', CONFIRMATION], {SHEIN_BI_MIGRATION_STAGE_LIMIT: '4'});
    assert.notEqual(killed.status, 0);
    await fs.appendFile(fx.fstabPath, '# tampered drift\n', 'utf8');
    const fstabBeforeResume = await fs.readFile(fx.fstabPath, 'utf8');
    const mountsBeforeResume = await readMountState(fx);
    const resume = invoke(fx, [...fx.baseArgs, '--apply', '--confirm', CONFIRMATION]);
    assert.notEqual(resume.status, 0, 'drifted current fstab must be rejected');
    assert.match(resume.stderr, /fstab drifted before v2 publish/);
    assert.equal(await fs.readFile(fx.fstabPath, 'utf8'), fstabBeforeResume,
      'a drift failure must preserve the exact fstab evidence instead of auto-rolling it back');
    assert.deepEqual(await readMountState(fx), mountsBeforeResume,
      'a drift failure must not make a second topology mutation');
    console.log('scenario H: drifted current fstab fails closed OK');
  } finally {
    await fs.rm(tempDir, {recursive: true, force: true});
  }
}

// ---------------------------------------------------------------------------
// Scenarios I/J/K: hard kill inside a step, between the atomic mutation and
// the phase-journal update. Re-entry must tolerate the temporarily absent app
// mountpoint and converge without relying on an EXIT trap.
// ---------------------------------------------------------------------------
for (const scenario of [
  {name: 'I', failpoint: 'after-outputs-move-before-recreate', missing: 'outputs'},
  {name: 'J', failpoint: 'after-state-move-before-recreate', missing: 'state'},
  {name: 'K1', failpoint: 'before-fstab-atomic-rename', missing: '', fstabLayout: 'legacy'},
  {name: 'K2', failpoint: 'after-fstab-publish-before-journal', missing: '', fstabLayout: 'v2'},
]) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `runtime-layout-${scenario.name.toLowerCase()}-`));
  try {
    const fx = await buildFixture(tempDir);
    const killed = invoke(fx, [...fx.baseArgs, '--apply', '--confirm', CONFIRMATION], {
      SHEIN_BI_MIGRATION_FAILPOINT: scenario.failpoint,
    });
    assert.notEqual(killed.status, 0, `${scenario.name}: failpoint must hard-kill the migration`);
    assert.match(killed.stderr, new RegExp(`runtime_layout_failpoint=${scenario.failpoint}`));
    if (scenario.missing) {
      await assert.rejects(fs.lstat(path.join(fx.appRoot, scenario.missing)), error => error.code === 'ENOENT',
        `${scenario.name}: the fixture must stop inside the missing-mountpoint crash window`);
    }
    const runDir = await runDirOf(fx);
    const before = await readJson(path.join(runDir, 'migration-journal.json'));
    assert.notEqual(before.phase, 'verified');
    if (scenario.fstabLayout === 'legacy') {
      assert.equal(before.phase, 'fstab-publish-prepared');
      assert.match(await fs.readFile(fx.fstabPath, 'utf8'),
        new RegExp(`${fx.w(fx.dataProfiles)} ${fx.w(fx.appProfiles)} none bind,rw 0 0`),
        `${scenario.name}: interruption before atomic rename must preserve the complete legacy fstab`);
    } else if (scenario.fstabLayout === 'v2') {
      assert.match(await fs.readFile(fx.fstabPath, 'utf8'),
        new RegExp(`${fx.w(fx.dataProfiles)} ${fx.w(fx.appProfiles)} none bind,ro 0 0`),
        `${scenario.name}: interruption after atomic rename must expose the complete v2 fstab`);
    }
    const resumed = invoke(fx, [...fx.baseArgs, '--apply', '--confirm', CONFIRMATION]);
    assert.equal(resumed.status, 0, `${scenario.name}: ${resumed.stderr}`);
    const result = JSON.parse(resumed.stdout);
    assert.equal(result.layout, 'v2');
    const after = await readJson(path.join(runDir, 'migration-journal.json'));
    assert.equal(after.phase, 'verified');
    await fs.lstat(path.join(fx.appRoot, 'state'));
    await fs.lstat(path.join(fx.appRoot, 'outputs'));
    await expectTrackedClean(fx);
    console.log(`scenario ${scenario.name}: ${scenario.failpoint} -> resume to verified OK`);
  } finally {
    await fs.rm(tempDir, {recursive: true, force: true});
  }
}

// A syntactically valid journal must not be able to redirect cleanup toward
// an arbitrary path through fingerprints.fstabStagePath.
{
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-layout-l-'));
  try {
    const fx = await buildFixture(tempDir);
    const killed = invoke(fx, [...fx.baseArgs, '--apply', '--confirm', CONFIRMATION], {
      SHEIN_BI_MIGRATION_STAGE_LIMIT: '7',
    });
    assert.notEqual(killed.status, 0);
    const runDir = await runDirOf(fx);
    const journalFile = path.join(runDir, 'migration-journal.json');
    const journal = await readJson(journalFile);
    const victim = path.join(tempDir, 'must-not-delete.txt');
    await fs.writeFile(victim, 'preserve-me\n', 'utf8');
    journal.fingerprints.fstabStagePath = fx.m(victim);
    await fs.writeFile(journalFile, `${JSON.stringify(journal, null, 2)}\n`, 'utf8');
    const resume = invoke(fx, [...fx.baseArgs, '--apply', '--confirm', CONFIRMATION]);
    assert.notEqual(resume.status, 0);
    assert.match(resume.stderr, /fstab stage path is unsafe|unreadable or tampered/);
    assert.equal(await fs.readFile(victim, 'utf8'), 'preserve-me\n',
      'a tampered stage path must never be deleted or replaced');
    console.log('scenario L: unsafe journal stage path rejected without touching victim OK');
  } finally {
    await fs.rm(tempDir, {recursive: true, force: true});
  }
}

// ---------------------------------------------------------------------------
// Scenario M: a daemon-loaded ExecCondition override must fail before the
// first migration journal or topology mutation. The installer audit sees the
// settled files; only the direct effective readback is overridden.
// ---------------------------------------------------------------------------
{
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-layout-m-'));
  try {
    const fx = await buildFixture(tempDir);
    const fstabBefore = await fs.readFile(fx.fstabPath, 'utf8');
    const mountsBefore = await readMountState(fx);
    const service = Object.keys(CLOUD_MAINTENANCE_POLICY_BY_SERVICE)
      .find(name => CLOUD_MAINTENANCE_POLICY_BY_SERVICE[name] !== 'always');
    assert.ok(service);
    const rejected = invoke(fx, [...fx.baseArgs, '--apply', '--confirm', CONFIRMATION], {
      SHEIN_BI_TEST_DIRECT_EXEC_CONDITION_OVERRIDE_SERVICE: service,
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /effective ExecCondition validation failed at initial-migration-preflight/);
    assert.equal(await fs.readFile(fx.fstabPath, 'utf8'), fstabBefore);
    assert.deepEqual(await readMountState(fx), mountsBefore);
    assert.deepEqual(await fs.readdir(fx.backupRoot), [],
      'an effective ExecCondition override must fail before creating a migration run');
    assert.equal(await fs.readFile(fx.systemctlLog, 'utf8'), '',
      'effective override rejection must not daemon-reload systemd');
    console.log('scenario M: effective ExecCondition override rejected before first mutation OK');
  } finally {
    await fs.rm(tempDir, {recursive: true, force: true});
  }
}

// ---------------------------------------------------------------------------
// Scenario N: ExecCondition can drift after the initial preflight. The fresh
// critical-point readback must stop before the next phase mutation.
// ---------------------------------------------------------------------------
{
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-layout-n-'));
  try {
    const fx = await buildFixture(tempDir);
    const fstabBefore = await fs.readFile(fx.fstabPath, 'utf8');
    const mountsBefore = await readMountState(fx);
    const rejected = invoke(fx, [...fx.baseArgs, '--apply', '--confirm', CONFIRMATION], {
      SHEIN_BI_TEST_EXEC_CONDITION_DRIFT_AFTER_DIRECT_SHOW: '4',
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /effective ExecCondition validation failed at before-fstab-backup/);
    assert.equal(await fs.readFile(fx.fstabPath, 'utf8'), fstabBefore);
    assert.deepEqual(await readMountState(fx), mountsBefore);
    const runDir = await runDirOf(fx);
    const journal = await readJson(path.join(runDir, 'migration-journal.json'));
    assert.equal(journal.phase, 'init');
    await assert.rejects(fs.lstat(path.join(runDir, 'fstab')), error => error.code === 'ENOENT',
      'the critical-point rejection must precede the fstab backup mutation');
    assert.equal(await fs.readFile(fx.systemctlLog, 'utf8'), '',
      'critical-point rejection must not daemon-reload systemd');
    console.log('scenario N: critical-point ExecCondition drift rejected before next mutation OK');
  } finally {
    await fs.rm(tempDir, {recursive: true, force: true});
  }
}

// ---------------------------------------------------------------------------
// Scenario O: an extra effective writable bind introduced by the daemon reload
// must block the verified journal. The resulting published-v2
// state is then used to prove rollback fstab publication is atomic across a
// hard interruption before rename.
// ---------------------------------------------------------------------------
{
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-layout-o-'));
  try {
    const fx = await buildFixture(tempDir);
    const driftService = 'shein-bi-query.service';
    const rejected = invoke(fx, [...fx.baseArgs, '--apply', '--confirm', CONFIRMATION], {
      SHEIN_BI_TEST_RUNTIME_PATH_DRIFT_AFTER_DAEMON_RELOAD: driftService,
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /effective runtime path validation failed at before-verified-journal/);
    const runDir = await runDirOf(fx);
    const journal = await readJson(path.join(runDir, 'migration-journal.json'));
    assert.equal(journal.phase, 'fstab-published', 'effective path drift must never publish verified');
    const publishedFstab = await fs.readFile(fx.fstabPath, 'utf8');
    assert.match(publishedFstab,
      new RegExp(`${fx.w(fx.dataProfiles)} ${fx.w(fx.appProfiles)} none bind,ro 0 0`));
    const publishedMounts = await readMountState(fx);
    const journalBytes = await fs.readFile(path.join(runDir, 'migration-journal.json'), 'utf8');
    const statusBytes = await fs.readFile(path.join(runDir, 'migration-status.json'), 'utf8');
    const expectedMode = (await fs.stat(fx.fstabPath)).mode & 0o777;

    const interruptedRollback = invoke(fx, [...fx.baseArgs, '--rollback', '--confirm', CONFIRMATION], {
      SHEIN_BI_MIGRATION_FAILPOINT: 'before-rollback-fstab-atomic-rename',
    });
    assert.notEqual(interruptedRollback.status, 0);
    assert.match(interruptedRollback.stderr, /before-rollback-fstab-atomic-rename/);
    assert.equal(await fs.readFile(fx.fstabPath, 'utf8'), publishedFstab,
      'interruption before atomic rollback rename must leave the complete v2 fstab untouched');
    assert.deepEqual(await readMountState(fx), publishedMounts,
      'interrupted fstab publication must precede every mount rollback mutation');
    assert.equal(await fs.readFile(path.join(runDir, 'migration-journal.json'), 'utf8'), journalBytes);
    assert.equal(await fs.readFile(path.join(runDir, 'migration-status.json'), 'utf8'), statusBytes);

    const rollback = invoke(fx, [...fx.baseArgs, '--rollback', '--confirm', CONFIRMATION]);
    assert.equal(rollback.status, 0, rollback.stderr);
    assert.equal((await fs.stat(fx.fstabPath)).mode & 0o777, expectedMode,
      'atomic rollback must preserve the reviewed fstab mode');
    assert.equal(await fs.readFile(fx.fstabPath, 'utf8'), fx.legacyFstab);
    assert.equal((await readJson(path.join(runDir, 'migration-journal.json'))).phase, 'rolled-back');
    console.log('scenario O: exact effective paths gate verified + interrupted atomic rollback OK');
  } finally {
    await fs.rm(tempDir, {recursive: true, force: true});
  }
}

// ---------------------------------------------------------------------------
// Scenario P: every phase-required source backup is mandatory. Temporarily
// remove each one from the same fstab-published run and prove explicit
// rollback performs zero mutation, including no status/journal rewrite.
// ---------------------------------------------------------------------------
{
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-layout-p-'));
  try {
    const fx = await buildFixture(tempDir);
    const killed = invoke(fx, [...fx.baseArgs, '--apply', '--confirm', CONFIRMATION], {
      SHEIN_BI_MIGRATION_STAGE_LIMIT: '8',
    });
    assert.notEqual(killed.status, 0);
    const runDir = await runDirOf(fx);
    assert.equal((await readJson(path.join(runDir, 'migration-journal.json'))).phase, 'fstab-published');
    for (const [name, expectedError] of [
      ['fstab', /requires an exact fstab backup/],
      ['state-underlay', /requires an exact state underlay backup/],
      ['outputs-git-underlay', /requires an exact outputs underlay backup/],
    ]) {
      const evidence = path.join(runDir, name);
      const hidden = path.join(runDir, `.missing-${name}`);
      await fs.rename(evidence, hidden);
      const fstabBefore = await fs.readFile(fx.fstabPath, 'utf8');
      const mountsBefore = await readMountState(fx);
      const journalBefore = await fs.readFile(path.join(runDir, 'migration-journal.json'), 'utf8');
      const statusBefore = await fs.readFile(path.join(runDir, 'migration-status.json'), 'utf8');
      const systemctlBefore = await fs.readFile(fx.systemctlLog, 'utf8');
      const rejectedRollback = invoke(fx, [...fx.baseArgs, '--rollback', '--confirm', CONFIRMATION]);
      assert.notEqual(rejectedRollback.status, 0, `${name}: missing evidence must reject rollback`);
      assert.match(rejectedRollback.stderr, expectedError);
      assert.doesNotMatch(rejectedRollback.stderr, /runtime_layout_restore_legacy=starting/,
        `${name}: mutation execution must not start without complete evidence`);
      assert.equal(await fs.readFile(fx.fstabPath, 'utf8'), fstabBefore);
      assert.deepEqual(await readMountState(fx), mountsBefore);
      assert.equal(await fs.readFile(path.join(runDir, 'migration-journal.json'), 'utf8'), journalBefore);
      assert.equal(await fs.readFile(path.join(runDir, 'migration-status.json'), 'utf8'), statusBefore);
      assert.equal(await fs.readFile(fx.systemctlLog, 'utf8'), systemctlBefore);
      await fs.rename(hidden, evidence);
    }
    console.log('scenario P: every missing required backup rejects rollback with zero mutation OK');
  } finally {
    await fs.rm(tempDir, {recursive: true, force: true});
  }
}

// ---------------------------------------------------------------------------
// Scenario Q: explicit rollback is resumable across every durable rollback
// sub-phase, and forward apply/resume is refused while the rollback marker
// exists (ordinary fstab drift is never mistaken for rollback).
// ---------------------------------------------------------------------------
for (const scenario of [
  {name: 'Q1', failpoint: 'after-rollback-fstab-restore-before-journal', phase: 'rollback-started'},
  {name: 'Q2', failpoint: 'after-rollback-state-unmount-before-journal', phase: 'rollback-fstab'},
  {name: 'Q3', failpoint: 'after-rollback-outputs-restore-before-journal', phase: 'rollback-state-unmounted'},
  {name: 'Q4', failpoint: 'after-rollback-state-restore-before-journal', phase: 'rollback-outputs-restored'},
  {name: 'Q5', failpoint: 'after-rollback-mounts-restore-before-journal', phase: 'rollback-state-restored'},
  {name: 'Q6', failpoint: 'after-rollback-cleanup-before-journal', phase: 'rollback-mounts-restored'},
  {name: 'Q7', failpoint: 'before-rollback-verified-journal', phase: 'rollback-cleanup-done'},
]) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-layout-q-'));
  try {
    const fx = await buildFixture(tempDir);
    // forward to fstab-published so every rollback sub-phase has work to do
    const killed = invoke(fx, [...fx.baseArgs, '--apply', '--confirm', CONFIRMATION], {
      SHEIN_BI_MIGRATION_STAGE_LIMIT: '8',
    });
    assert.notEqual(killed.status, 0, 'forward stage-limit run must be hard-killed');
    const runDir = await runDirOf(fx);
    const markerFile = path.join(runDir, 'migration-rollback.json');
    await assert.rejects(fs.lstat(markerFile), error => error.code === 'ENOENT',
      'a forward run must never create a rollback marker');

    const interrupted = invoke(fx, [...fx.baseArgs, '--rollback', '--confirm', CONFIRMATION], {
      SHEIN_BI_MIGRATION_FAILPOINT: scenario.failpoint,
    });
    assert.notEqual(interrupted.status, 0, `${scenario.name}: rollback failpoint must kill`);
    assert.match(interrupted.stderr, new RegExp(`runtime_layout_failpoint=${scenario.failpoint}`));
    const marker = await readJson(markerFile);
    assert.equal(marker.schemaVersion, 'cloud-runtime-layout-migration-rollback/v1');
    assert.equal(marker.rollbackPhase, scenario.phase,
      `${scenario.name}: marker must lag one sub-phase behind the durable mutation`);

    // forward resume must be refused while the rollback marker exists
    const forwardBlocked = invoke(fx, [...fx.baseArgs, '--apply', '--confirm', CONFIRMATION]);
    assert.notEqual(forwardBlocked.status, 0,
      'forward apply must be refused while a rollback is in progress');
    assert.match(forwardBlocked.stderr,
      /forward resume is blocked while an explicit rollback is in progress/);
    const mountsBlocked = await readMountState(fx);
    assert.deepEqual(await readMountState(fx), mountsBlocked);

    // resume the explicit rollback to the terminal legacy state
    const resumed = invoke(fx, [...fx.baseArgs, '--rollback', '--confirm', CONFIRMATION]);
    assert.equal(resumed.status, 0, `${scenario.name}: ${resumed.stderr}`);
    const result = JSON.parse(resumed.stdout);
    assert.equal(result.mode, 'rollback');
    assert.equal(result.layout, 'legacy');
    const journal = await readJson(path.join(runDir, 'migration-journal.json'));
    assert.equal(journal.phase, 'rolled-back');
    const status = await readJson(path.join(runDir, 'migration-status.json'));
    assert.equal(status.status, 'rolled_back');
    assert.equal(await fs.readFile(fx.fstabPath, 'utf8'), fx.legacyFstab);
    const mounts = await readMountState(fx);
    assert.equal(mounts[fx.m(fx.appProfiles)].options, 'rw');
    assert.equal(mounts[fx.m(fx.appOutputs)].options, 'rw');
    assert.ok(!mounts[fx.m(fx.appState)], 'state must be unmounted after rollback resume');
    await fs.lstat(path.join(fx.appRoot, 'state', 'cache.json'));
    await fs.lstat(path.join(fx.appRoot, 'outputs', 'nested', 'sample.json'));
    await assert.rejects(fs.lstat(path.join(fx.dataRoot, 'state')), error => error.code === 'ENOENT',
      'canonical state data must be removed');
    await expectTrackedClean(fx);
    console.log(`scenario ${scenario.name}: ${scenario.failpoint} -> resume to rolled-back OK`);
  } finally {
    await fs.rm(tempDir, {recursive: true, force: true});
  }
}

// ---------------------------------------------------------------------------
// Scenario R: an early forward phase has no expected v2 fstab hash. Once a
// rollback-started marker is durable, resume must still accept only the source
// fstab bytes; ordinary drift is rejected before any rollback mutation, while
// an unchanged source fstab resumes to rolled-back.
// ---------------------------------------------------------------------------
for (const scenario of [
  {name: 'R1', drift: true},
  {name: 'R2', drift: false},
]) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-layout-r-'));
  try {
    const fx = await buildFixture(tempDir);
    const killed = invoke(fx, [...fx.baseArgs, '--apply', '--confirm', CONFIRMATION], {
      SHEIN_BI_MIGRATION_STAGE_LIMIT: '1',
    });
    assert.notEqual(killed.status, 0, `${scenario.name}: forward stage-limit run must be hard-killed`);
    assert.match(killed.stderr, /stage_limit_1_reached_phase=fstab-backed-up/);
    const runDir = await runDirOf(fx);
    const journalFile = path.join(runDir, 'migration-journal.json');
    const statusFile = path.join(runDir, 'migration-status.json');
    const markerFile = path.join(runDir, 'migration-rollback.json');
    const earlyJournal = await readJson(journalFile);
    assert.equal(earlyJournal.phase, 'fstab-backed-up');
    assert.equal(earlyJournal.fingerprints.expectedFstabV2Hash, undefined,
      'the early journal phase must exercise the empty expected-v2-hash branch');

    const interrupted = invoke(fx, [...fx.baseArgs, '--rollback', '--confirm', CONFIRMATION], {
      SHEIN_BI_MIGRATION_FAILPOINT: 'after-rollback-started-marker-before-mutation',
    });
    assert.notEqual(interrupted.status, 0, `${scenario.name}: rollback marker failpoint must kill`);
    assert.match(interrupted.stderr,
      /runtime_layout_failpoint=after-rollback-started-marker-before-mutation/);
    const marker = await readJson(markerFile);
    assert.equal(marker.rollbackPhase, 'rollback-started');

    if (scenario.drift) {
      const driftBytes = '# external drift after rollback marker\n';
      const fstabBefore = await fs.readFile(fx.fstabPath);
      const directShowCount = Number.parseInt(
        (await fs.readFile(fx.effectiveShowCountFile, 'utf8')).trim(),
        10,
      );
      const mountsBefore = await readMountState(fx);
      const journalBefore = await fs.readFile(journalFile);
      const statusBefore = await fs.readFile(statusFile);
      const markerBefore = await fs.readFile(markerFile);
      const systemctlBefore = await fs.readFile(fx.systemctlLog);

      // The third direct effective-systemd readback is before-explicit-rollback:
      // journal globals are loaded, but resume evidence has not yet been checked.
      const rejected = invoke(fx, [...fx.baseArgs, '--rollback', '--confirm', CONFIRMATION], {
        SHEIN_BI_TEST_FSTAB_DRIFT_AFTER_DIRECT_SHOW: String(directShowCount + 3),
        SHEIN_BI_TEST_FSTAB_DRIFT_PATH: fx.fstabPath,
        SHEIN_BI_TEST_FSTAB_DRIFT_BYTES: driftBytes,
      });
      assert.notEqual(rejected.status, 0, 'drifted early rollback resume must fail closed');
      assert.match(rejected.stderr, /rollback current fstab drifted before phase fstab-backed-up/);
      assert.doesNotMatch(rejected.stderr, /runtime_layout_restore_legacy=starting/,
        'rollback execution must not start after detecting fstab drift');
      assert.deepEqual(await fs.readFile(fx.fstabPath), Buffer.concat([fstabBefore, Buffer.from(driftBytes)]),
        'rejected rollback resume must preserve the exact drifted fstab bytes');
      assert.deepEqual(await readMountState(fx), mountsBefore,
        'rejected rollback resume must not mutate mount topology');
      assert.deepEqual(await fs.readFile(journalFile), journalBefore,
        'rejected rollback resume must not rewrite the migration journal');
      assert.deepEqual(await fs.readFile(statusFile), statusBefore,
        'rejected rollback resume must not rewrite migration status');
      assert.deepEqual(await fs.readFile(markerFile), markerBefore,
        'rejected rollback resume must not advance or rewrite the rollback marker');
      assert.deepEqual(await fs.readFile(fx.systemctlLog), systemctlBefore,
        'rejected rollback resume must not issue daemon-reload');
      console.log('scenario R1: early rollback marker + fstab drift fails closed with zero mutation OK');
    } else {
      const resumed = invoke(fx, [...fx.baseArgs, '--rollback', '--confirm', CONFIRMATION]);
      assert.equal(resumed.status, 0, `${scenario.name}: ${resumed.stderr}`);
      const result = JSON.parse(resumed.stdout);
      assert.equal(result.mode, 'rollback');
      assert.equal(result.layout, 'legacy');
      assert.equal((await readJson(journalFile)).phase, 'rolled-back');
      assert.equal((await readJson(statusFile)).status, 'rolled_back');
      assert.equal(await fs.readFile(fx.fstabPath, 'utf8'), fx.legacyFstab);
      const mounts = await readMountState(fx);
      assert.equal(mounts[fx.m(fx.appProfiles)].options, 'rw');
      assert.equal(mounts[fx.m(fx.appOutputs)].options, 'rw');
      assert.ok(!mounts[fx.m(fx.appState)]);
      console.log('scenario R2: unchanged early rollback marker resumes to rolled-back OK');
    }
  } finally {
    await fs.rm(tempDir, {recursive: true, force: true});
  }
}
console.log(JSON.stringify({
  ok: true,
  checks: [
    'audit_precedes_writes',
    'exact_confirmation',
    'backup_outside_source_tree',
    'maintenance_audit_twice',
    'fstab_publish_last',
    'journal_phase_machine',
    'restore_prevalidation',
    'metadata_fingerprint_deterministic',
    'metadata_fingerprint_mtime_sensitive',
    'metadata_fingerprint_mode_sensitive_on_linux',
    'metadata_fingerprint_hardlink_sensitive',
    'metadata_fingerprint_xattr_sensitive_when_supported',
    'exact_fstab_transform',
    'failpoint_hook',
    'fresh_apply_idempotent',
    'kill_after_publish_resume',
    'kill_before_publish_resume',
    'explicit_rollback_exact_legacy',
    'tampered_journal_rejected',
    'tampered_backup_rejected',
    'v1_record_adoption',
    'drifted_fstab_rejected',
    'midstep_outputs_move_resume',
    'midstep_state_move_resume',
    'midstep_fstab_before_rename_resume',
    'midstep_fstab_publish_resume',
    'unsafe_journal_stage_path_rejected',
    'effective_exec_condition_override_zero_mutation',
    'effective_exec_condition_critical_point_refresh',
    'effective_28_service_namespace_exact_before_verified',
    'rollback_fstab_atomic_interruption',
    'rollback_fstab_mode_preserved',
    'rollback_missing_required_backups_zero_mutation',
    'rollback_started_early_fstab_drift_zero_mutation',
    'rollback_started_early_unchanged_resume',
  ],
}, null, 2));
