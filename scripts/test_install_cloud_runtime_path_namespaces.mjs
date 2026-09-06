#!/usr/bin/env node
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

import {CLOUD_RUNTIME_PATH_POLICY_BY_SERVICE} from '../lib/cloud_runtime_path_policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLER = path.join(ROOT, 'scripts', 'install_cloud_runtime_path_namespaces.sh');
const CONFIRMATION = 'INSTALL_CLOUD_RUNTIME_PATH_NAMESPACES';
const source = await fs.readFile(INSTALLER, 'utf8');
assert.match(source, /SHEIN_BI_SYSTEMD_DIR:-\/etc\/systemd\/system/);
assert.match(source, /--apply requires exact --confirm/);
assert.match(source, /50-runtime-paths\.conf/);
assert.match(source, /runtime path drop-in template drift/);
assert.match(source, /"\$SYSTEMCTL_BIN" daemon-reload/);
assert.match(source, /RUNTIME_ROOT="\$\{SHEIN_BI_RUNTIME_ROOT:-\/srv\/shein-bi\/runtime\}"/);
assert.match(source, /RUNTIME_USER="\$\{SHEIN_BI_RUNTIME_USER:-sheinops\}"/);
assert.match(source, /RUNTIME_GROUP="\$\{SHEIN_BI_RUNTIME_GROUP:-sheinops\}"/);
assert.match(source, /install -d -o "\$RUNTIME_USER" -g "\$RUNTIME_GROUP" -m 0750 -- "\$startup_dir"/);
assert.doesNotMatch(source, /\bchown\b/);
assert.doesNotMatch(source, /"\$SYSTEMCTL_BIN"\s+(?:enable|start|restart)\b/);
assert.doesNotMatch(source, /\brm\s+-[A-Za-z]*r[A-Za-z]*f?\b|\brm\s+-[A-Za-z]*f[A-Za-z]*r\b/);
assert.doesNotMatch(source, /\/(?:[0-4][0-9]|[6-9][0-9])-runtime-paths\.conf/);
const auditExit = source.indexOf('if ((!APPLY)); then');
const firstTargetRootWrite = source.indexOf('install -d -m 0755 -- "$SYSTEMD_DIR"');
const firstDropInWrite = source.indexOf('tmp="$(mktemp "$target_dir/.50-runtime-paths.conf.XXXXXX")"');
assert.ok(auditExit > 0 && firstTargetRootWrite > auditExit && firstDropInWrite > auditExit,
  'audit exit must precede every target-systemd write');

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
    staticChecks: ['audit_default', 'exact_confirmation', 'drop_in_name', 'template_drift', 'daemon_reload_only'],
  }, null, 2));
  process.exit(0);
}
function shellPath(file) {
  if (!isWindows) return file;
  const result = run(cygpath, ['-a', '-u', file]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function canonicalShellDirectory(file) {
  const translated = shellPath(file);
  if (!isWindows) return translated;
  const result = run(gitBash, ['-c', 'cd -- "$1" && pwd -P', 'runtime-path-test', translated]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-path-installer-'));
try {
  const fixtureRoot = path.join(tempDir, 'repo');
  const fixtureSystemd = path.join(fixtureRoot, 'infra', 'systemd');
  const fixtureTarget = path.join(tempDir, 'systemd');
  await fs.mkdir(path.join(fixtureRoot, 'scripts'), {recursive: true});
  await fs.mkdir(path.join(fixtureRoot, 'lib'), {recursive: true});
  await fs.mkdir(fixtureSystemd, {recursive: true});
  await fs.mkdir(fixtureTarget);
  await fs.copyFile(INSTALLER, path.join(fixtureRoot, 'scripts', path.basename(INSTALLER)));
  await fs.copyFile(path.join(ROOT, 'lib', 'cloud_runtime_path_policy.mjs'), path.join(fixtureRoot, 'lib', 'cloud_runtime_path_policy.mjs'));
  for (const service of Object.keys(CLOUD_RUNTIME_PATH_POLICY_BY_SERVICE)) {
    await fs.copyFile(path.join(ROOT, 'infra', 'systemd', service), path.join(fixtureSystemd, service));
  }

  const fakeSystemctl = path.join(tempDir, 'fake-systemctl.sh');
  const systemctlLog = path.join(tempDir, 'systemctl.log');
  await fs.writeFile(fakeSystemctl, `#!/usr/bin/env bash\nset -euo pipefail\n[[ "$#" -eq 1 && "$1" == daemon-reload ]]\nprintf '%s\\n' "$1" >> "$SHEIN_BI_SYSTEMCTL_LOG"\n`, 'utf8');
  await fs.chmod(fakeSystemctl, 0o755);

  const shellRoot = canonicalShellDirectory(fixtureRoot);
  const shellTarget = canonicalShellDirectory(fixtureTarget);
  const shellInstaller = `${shellRoot}/scripts/${path.basename(INSTALLER)}`;
  const runtimeRoot = path.join(tempDir, 'runtime');
  const locks = path.join(runtimeRoot, 'locks');
  await fs.mkdir(locks, {recursive: true, mode: 0o755});
  const parentBefore = await fs.stat(locks);
  const shell = isWindows ? gitBash : '/bin/bash';
  const identity = run(shell, ['-c', 'id -u; id -g']);
  assert.equal(identity.status, 0, identity.stderr);
  const [uid, gid] = identity.stdout.trim().split(/\s+/);
  const env = {
    SHEIN_BI_RUNTIME_ROOT: canonicalShellDirectory(runtimeRoot),
    SHEIN_BI_RUNTIME_USER: uid,
    SHEIN_BI_RUNTIME_GROUP: gid,
    SHEIN_BI_SYSTEMCTL_BIN: shellPath(fakeSystemctl),
    SHEIN_BI_SYSTEMCTL_LOG: shellPath(systemctlLog),
  };
  if (isWindows) {
    // NTFS cannot exercise Unix chown. Check its exact arguments, then run the
    // real directory creation; Linux runs the unmodified install command.
    const bashEnv = path.join(tempDir, 'windows-install-fixture.sh');
    await fs.writeFile(bashEnv, `install() {
  if [[ "$*" == *chrome-profile-startup* ]]; then
    [[ "$#" == 9 && "$1" == -d && "$2" == -o && "$3" == "$SHEIN_BI_RUNTIME_USER" && "$4" == -g && "$5" == "$SHEIN_BI_RUNTIME_GROUP" && "$6" == -m && "$7" == 0750 && "$8" == -- ]] || return 91
    mkdir -p -- "\${@: -1}"
  else
    command install "$@"
  fi
}
`);
    env.BASH_ENV = shellPath(bashEnv);
  }
  const invoke = args => isWindows
    ? run(gitBash, [shellInstaller, ...args], {env: {...process.env, ...env}})
    : run('/bin/bash', [shellInstaller, ...args], {env: {...process.env, ...env}});
  const syntax = isWindows
    ? run(gitBash, ['-n', shellInstaller])
    : run('/bin/bash', ['-n', shellInstaller]);
  assert.equal(syntax.status, 0, syntax.stderr);
  const base = ['--root', shellRoot, '--systemd-dir', shellTarget];
  const before = await fs.readdir(fixtureTarget);
  const audit = invoke(base);
  assert.equal(audit.status, 0, audit.stderr);
  assert.deepEqual(JSON.parse(audit.stdout), {
    ok: true, mode: 'audit', policyCount: 28, plannedInstall: 28, unchanged: 0, confirmation: CONFIRMATION,
  });
  assert.deepEqual(await fs.readdir(fixtureTarget), before, 'audit must not write target systemd directory');
  assert.deepEqual(await fs.readdir(locks), [], 'audit must not provision browser directories');

  assert.equal(invoke([...base, '--apply']).status, 64);
  assert.equal(invoke([...base, '--apply', '--confirm', 'WRONG']).status, 64);
  const apply = invoke([...base, '--apply', '--confirm', CONFIRMATION]);
  assert.equal(apply.status, 0, apply.stderr);
  assert.equal(JSON.parse(apply.stdout).installed, 28);
  assert.equal(await fs.readFile(systemctlLog, 'utf8'), 'daemon-reload\n');
  const startup = path.join(locks, 'chrome-profile-startup');
  const startupStat = await fs.stat(startup);
  assert.ok(startupStat.isDirectory());
  if (!isWindows) {
    assert.equal(startupStat.uid, Number(uid));
    assert.equal(startupStat.gid, Number(gid));
    assert.equal(startupStat.mode & 0o777, 0o750);
  }
  await fs.writeFile(path.join(startup, 'retained-ticket'), 'retained');
  const reapply = invoke([...base, '--apply', '--confirm', CONFIRMATION]);
  assert.equal(reapply.status, 0, reapply.stderr);
  assert.equal(await fs.readFile(path.join(startup, 'retained-ticket'), 'utf8'), 'retained');
  const parentAfter = await fs.stat(locks);
  assert.deepEqual([parentAfter.uid, parentAfter.gid, parentAfter.mode],
    [parentBefore.uid, parentBefore.gid, parentBefore.mode], 'parent permissions stay unchanged');

  const settled = invoke(base);
  assert.equal(settled.status, 0, settled.stderr);
  assert.equal(JSON.parse(settled.stdout).plannedInstall, 0);
  assert.equal(JSON.parse(settled.stdout).unchanged, 28);

  const portal = path.join(fixtureTarget, 'shein-bi-portal.service.d', '50-runtime-paths.conf');
  const portalText = await fs.readFile(portal, 'utf8');
  assert.match(portalText, /BindPaths=\/data\/shein-bi\/profiles:\/opt\/shein-bi\/app\/profiles/);
  // portal is rw/rw/rw: the reviewed namespace has no read-only or inaccessible path.
  assert.doesNotMatch(portalText, /InaccessiblePaths|ReadOnlyPaths/);
  const webhook = await fs.readFile(path.join(fixtureTarget, 'shein-bi-webhook.service.d', '50-runtime-paths.conf'), 'utf8');
  assert.match(webhook, /^InaccessiblePaths=\/data\/shein-bi\/profiles \/opt\/shein-bi\/app\/profiles$/m);
  assert.doesNotMatch(webhook, /^(?:BindPaths|BindReadOnlyPaths)=\/data\/shein-bi\/profiles:/m);
  assert.match(webhook, /BindReadOnlyPaths=\/data\/shein-bi\/state:\/opt\/shein-bi\/app\/state/);
  assert.match(webhook, /BindReadOnlyPaths=\/data\/shein-bi\/outputs:\/opt\/shein-bi\/app\/outputs/);
  // two-sided contract: canonical state/outputs source must also be read-only, profiles must never surface.
  assert.match(webhook, /^ReadOnlyPaths=\/data\/shein-bi\/state \/data\/shein-bi\/outputs$/m);
  assert.doesNotMatch(webhook, /^ReadOnlyPaths=.*\/data\/shein-bi\/profiles/m);
const query = await fs.readFile(path.join(fixtureTarget, 'shein-bi-query.service.d', '50-runtime-paths.conf'), 'utf8');
  assert.match(query, /InaccessiblePaths=\/data\/shein-bi\/profiles \/opt\/shein-bi\/app\/profiles/);
  assert.doesNotMatch(query, /profiles:\/opt\/shein-bi\/app\/profiles/);
  assert.match(query, /BindReadOnlyPaths=\/data\/shein-bi\/state:\/opt\/shein-bi\/app\/state/);
  assert.match(query, /BindReadOnlyPaths=\/data\/shein-bi\/outputs:\/opt\/shein-bi\/app\/outputs/);
  assert.match(query, /^ReadOnlyPaths=\/data\/shein-bi\/state \/data\/shein-bi\/outputs$/m);
  assert.doesNotMatch(query, /^ReadOnlyPaths=.*\/data\/shein-bi\/profiles/m);
const sessionSecret = await fs.readFile(path.join(fixtureTarget, 'shein-bi-session-secret.service.d', '50-runtime-paths.conf'), 'utf8');
  assert.match(sessionSecret, /InaccessiblePaths=\/data\/shein-bi\/profiles \/opt\/shein-bi\/app\/profiles/);
  assert.match(sessionSecret, /BindPaths=\/data\/shein-bi\/state:\/opt\/shein-bi\/app\/state/);
  assert.match(sessionSecret, /BindReadOnlyPaths=\/data\/shein-bi\/outputs:\/opt\/shein-bi\/app\/outputs/);
  assert.match(sessionSecret, /^ReadOnlyPaths=\/data\/shein-bi\/outputs$/m);
  assert.doesNotMatch(sessionSecret, /^ReadOnlyPaths=.*\/data\/shein-bi\/(?:profiles|state)/m);

  await fs.writeFile(portal, `${portalText}# drift\n`, 'utf8');
  const drift = invoke(base);
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /template drift/);

  await fs.writeFile(path.join(fixtureSystemd, 'shein-bi-unreviewed.service'), '[Service]\nExecStart=/bin/true\n', 'utf8');
  const missingPolicy = invoke(base);
  assert.equal(missingPolicy.status, 1);
  assert.match(missingPolicy.stderr, /RUNTIME_PATH_POLICY_MISSING/);
  // host-ro service: the installed drop-in must protect both the canonical and the legacy profile side.
  const sectionQueue = await fs.readFile(path.join(fixtureTarget, 'shein-bi-cloud-portal-section-queue.service.d', '50-runtime-paths.conf'), 'utf8');
  assert.match(sectionQueue, /^BindReadOnlyPaths=\/data\/shein-bi\/profiles:\/opt\/shein-bi\/app\/profiles$/m);
  assert.doesNotMatch(sectionQueue, /BindPaths=\/data\/shein-bi\/profiles/);
  assert.match(sectionQueue, /^ReadOnlyPaths=\/data\/shein-bi\/profiles \/data\/shein-bi\/outputs$/m);
  assert.match(sectionQueue, /BindPaths=\/data\/shein-bi\/state:/);

  console.log(JSON.stringify({ok: true, auditNoWrite: true, installed: 28, daemonReloadOnly: true,
    startupDirectory: true, parentPermissionsUnchanged: true,
    unixOwnershipVerified: !isWindows, windowsOwnershipArgumentsOnly: isWindows}, null, 2));
} finally {
  await fs.rm(tempDir, {recursive: true, force: true});
}
