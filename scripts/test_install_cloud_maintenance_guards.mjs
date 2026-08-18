#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

import {CLOUD_MAINTENANCE_POLICY_BY_SERVICE} from '../lib/cloud_runtime_inventory.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLER = path.join(ROOT, 'scripts', 'install_cloud_maintenance_guards.sh');
const MANAGER = path.join(ROOT, 'scripts', 'manage_cloud_maintenance_mode.mjs');
const SYSTEMD_SOURCE = path.join(ROOT, 'infra', 'systemd');
const CONFIRMATION = 'APPLY_CLOUD_MAINTENANCE_GUARDS_V1';
const installerSource = await fs.readFile(INSTALLER, 'utf8');
const managerSource = await fs.readFile(MANAGER, 'utf8');

assert.match(installerSource, /exec \/usr\/bin\/node "\$MANAGER" install-guards "\$@"/);
assert.doesNotMatch(installerSource, /\brm\s+-[A-Za-z]*r[A-Za-z]*f?\b|\brm\s+-[A-Za-z]*f[A-Za-z]*r\b/);
assert.match(managerSource, /SHEIN_BI_SYSTEMD_ROOT \|\| '\/etc\/systemd\/system'/);
assert.match(managerSource, /--apply requires exact --confirm/);
assert.match(managerSource, /spawnSync\(resolvedSystemctl, \['daemon-reload'\]/);
assert.doesNotMatch(managerSource, /\['(?:enable|start|restart)'\]/);
assert.doesNotMatch(managerSource, /\brmSync\b|\brm\s+-[A-Za-z]*r[A-Za-z]*f?\b|\brm\s+-[A-Za-z]*f[A-Za-z]*r\b/);
assert.match(managerSource, /await fs\.unlink\(target\)/);
assert.match(managerSource, /installed guard final readback mismatch/);
assert.match(managerSource, /guard publish readback mismatch/);
assert.match(managerSource, /tracked template content mismatch/);
assert.match(managerSource, /repository service policy contract is invalid/);
assert.match(managerSource, /guard exists for service without repository policy/);

function commandResult(command, args, options = {}) {
  const result = spawnSync(command, args, {encoding: 'utf8', ...options});
  if (result.error) throw result.error;
  return result;
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shein-maintenance-guard-install-'));
const resolvedTempRoot = `${path.resolve(os.tmpdir())}${path.sep}`.toLowerCase();
assert.ok(`${path.resolve(tempDir)}${path.sep}`.toLowerCase().startsWith(resolvedTempRoot));

try {
  const fixtureRoot = path.join(tempDir, 'repo');
  const fixtureScripts = path.join(fixtureRoot, 'scripts');
  const fixtureLib = path.join(fixtureRoot, 'lib');
  const fixtureSystemdSource = path.join(fixtureRoot, 'infra', 'systemd');
  const fixtureManager = path.join(fixtureScripts, 'manage_cloud_maintenance_mode.mjs');
  const fixtureInstaller = path.join(fixtureScripts, 'install_cloud_maintenance_guards.sh');
  const systemdRoot = path.join(tempDir, 'systemd');
  const systemctlLog = path.join(tempDir, 'systemctl.log');
  const loadedGuardFile = path.join(tempDir, 'systemctl-loaded');
  const fakeDaemonReload = path.join(tempDir, 'daemon-reload');
  const fakeShow = path.join(tempDir, 'show');
  await fs.mkdir(fixtureScripts, {recursive: true});
  await fs.mkdir(fixtureLib, {recursive: true});
  await fs.mkdir(fixtureSystemdSource, {recursive: true});
  await fs.mkdir(systemdRoot);
  await fs.copyFile(INSTALLER, fixtureInstaller);
  await fs.copyFile(MANAGER, fixtureManager);
  for (const moduleName of [
    'atomic_file_publish.mjs',
    'cloud_maintenance_mode.mjs',
    'cloud_runtime_inventory.mjs',
  ]) {
    await fs.copyFile(path.join(ROOT, 'lib', moduleName), path.join(fixtureLib, moduleName));
  }
  for (const service of Object.keys(CLOUD_MAINTENANCE_POLICY_BY_SERVICE)) {
    await fs.copyFile(path.join(SYSTEMD_SOURCE, service), path.join(fixtureSystemdSource, service));
  }
  const templateNames = [
    'shein-bi-scheduled-maintenance-guard.conf',
    'shein-bi-infrastructure-maintenance-guard.conf',
  ];
  for (const template of templateNames) {
    await fs.copyFile(path.join(SYSTEMD_SOURCE, template), path.join(fixtureSystemdSource, template));
  }
  await fs.writeFile(fakeDaemonReload, `
const fsPromise = import('node:fs');
if (process.argv.length !== 2) process.exit(2);
fsPromise.then(fsModule => {
  if (process.env.SHEIN_BI_SYSTEMCTL_RELOAD_FAIL === '1') process.exit(1);
  fsModule.appendFileSync(process.env.SHEIN_BI_SYSTEMCTL_LOG, 'daemon-reload\\n');
  fsModule.writeFileSync(process.env.SHEIN_BI_SYSTEMCTL_LOADED_FILE, 'loaded\\n');
});
`, 'utf8');

  await fs.writeFile(fakeShow, `
const fs = await import('node:fs');
const policy = ${JSON.stringify(CLOUD_MAINTENANCE_POLICY_BY_SERVICE)};
const loaded = fs.existsSync(process.env.SHEIN_BI_SYSTEMCTL_LOADED_FILE);
fs.appendFileSync(process.env.SHEIN_BI_SYSTEMCTL_LOG, 'show\\n');
const services = process.argv.slice(2).filter(value => value.endsWith('.service'));
const blocks = services.map(service => {
  const unitClass = policy[service];
  const condition = loaded && unitClass !== 'always'
    ? '/usr/bin/node /opt/shein-bi/app/scripts/manage_cloud_maintenance_mode.mjs systemd-condition --class ' + unitClass + ' --unit ' + service
    : '';
  return 'Id=' + service + '\\nLoadState=loaded\\nExecCondition=' + condition;
});
process.stdout.write(blocks.join('\\n\\n') + '\\n');
`, 'utf8');

  function runManager(args, options = {}) {
    const command = process.platform === 'win32' || args[0] !== 'install-guards' ? process.execPath : '/bin/bash';
    const commandArgs = process.platform === 'win32' || args[0] !== 'install-guards'
      ? [fixtureManager, ...args]
      : [fixtureInstaller, ...args.slice(1)];
    return commandResult(command, commandArgs, {
      cwd: tempDir,
      env: {
        ...process.env,
        SHEIN_BI_SYSTEMCTL_BIN: process.execPath,
        SHEIN_BI_SYSTEMCTL_LOG: systemctlLog,
        SHEIN_BI_SYSTEMCTL_LOADED_FILE: options.loadedFile || loadedGuardFile,
        SHEIN_BI_SYSTEMCTL_RELOAD_FAIL: options.reloadFail ? '1' : '0',
      },
    });
  }

  function runInstaller(args, options = {}) {
    return runManager(['install-guards', ...args], options);
  }

  const rootArgs = ['--systemd-root', systemdRoot];
  const audit = runInstaller(rootArgs);
  assert.equal(audit.status, 0, audit.stderr);
  assert.deepEqual(JSON.parse(audit.stdout), {
    ok: true,
    mode: 'audit',
    policyCount: 28,
    plannedInstall: 23,
    plannedReplace: 0,
    plannedRemove: 0,
    unchanged: 5,
    confirmation: CONFIRMATION,
  });
  assert.deepEqual(await fs.readdir(systemdRoot), [], 'audit must not mutate the target root');
  await assert.rejects(fs.lstat(systemctlLog), error => error.code === 'ENOENT');

  assert.equal(runInstaller([...rootArgs, '--apply']).status, 64);
  assert.equal(runInstaller([...rootArgs, '--apply', '--confirm', 'WRONG_CONFIRMATION']).status, 64);

  const apply = runInstaller([...rootArgs, '--apply', '--confirm', CONFIRMATION]);
  assert.equal(apply.status, 0, apply.stderr);
  const applyResult = JSON.parse(apply.stdout);
  assert.equal(applyResult.mode, 'apply');
  assert.equal(applyResult.policyCount, 28);
  assert.equal(applyResult.installed, 23);
  assert.equal(applyResult.daemonReload, true);
  assert.equal(applyResult.effectiveGuardReadback, true);

  let installedGuards = 0;
  for (const [service, unitClass] of Object.entries(CLOUD_MAINTENANCE_POLICY_BY_SERVICE)) {
    const guard = path.join(systemdRoot, `${service}.d`, '40-cloud-maintenance.conf');
    if (unitClass === 'always') {
      await assert.rejects(fs.lstat(guard), error => error.code === 'ENOENT');
      continue;
    }
    installedGuards += 1;
    const template = path.join(
      SYSTEMD_SOURCE,
      unitClass === 'scheduled'
        ? 'shein-bi-scheduled-maintenance-guard.conf'
        : 'shein-bi-infrastructure-maintenance-guard.conf',
    );
    assert.equal(await fs.readFile(guard, 'utf8'), await fs.readFile(template, 'utf8'));
  }
  assert.equal(installedGuards, 23);
  assert.equal(CLOUD_MAINTENANCE_POLICY_BY_SERVICE['shein-bi-session-secret.service'], 'always');
  await assert.rejects(
    fs.lstat(path.join(systemdRoot, 'shein-bi-session-secret.service.d', '40-cloud-maintenance.conf')),
    error => error.code === 'ENOENT',
  );
  assert.equal(await fs.readFile(systemctlLog, 'utf8'), 'daemon-reload\nshow\n');

  const settledAudit = runInstaller(rootArgs);
  assert.equal(settledAudit.status, 0, settledAudit.stderr);
  assert.deepEqual(JSON.parse(settledAudit.stdout), {
    ok: true,
    mode: 'audit',
    policyCount: 28,
    plannedInstall: 0,
    plannedReplace: 0,
    plannedRemove: 0,
    unchanged: 28,
    confirmation: CONFIRMATION,
  });

  const portalGuard = path.join(systemdRoot, 'shein-bi-portal.service.d', '40-cloud-maintenance.conf');
  await fs.mkdir(path.dirname(portalGuard), {recursive: true});
  await fs.copyFile(path.join(fixtureSystemdSource, templateNames[0]), portalGuard);
  const alwaysAudit = runInstaller(rootArgs);
  assert.equal(alwaysAudit.status, 0, alwaysAudit.stderr);
  assert.equal(JSON.parse(alwaysAudit.stdout).plannedRemove, 1);
  const removeAlwaysGuard = runInstaller([...rootArgs, '--apply', '--confirm', CONFIRMATION]);
  assert.equal(removeAlwaysGuard.status, 0, removeAlwaysGuard.stderr);
  await assert.rejects(fs.lstat(portalGuard), error => error.code === 'ENOENT');

  const failedReloadRoot = path.join(tempDir, 'systemd-failed-reload');
  const failedReloadLoadedFile = path.join(tempDir, 'systemctl-failed-reload-loaded');
  await fs.mkdir(failedReloadRoot);
  const failedReload = runInstaller([
    '--systemd-root', failedReloadRoot, '--apply', '--confirm', CONFIRMATION,
  ], {loadedFile: failedReloadLoadedFile, reloadFail: true});
  assert.equal(failedReload.status, 1);
  assert.match(failedReload.stderr, /daemon-reload failed/);
  const failedPauseMarker = path.join(tempDir, 'failed-reload-maintenance.json');
  const failedPauseStatus = runManager(['status', '--file', failedPauseMarker], {
    loadedFile: failedReloadLoadedFile,
  });
  assert.equal(failedPauseStatus.status, 0, failedPauseStatus.stderr);
  const failedPauseBaseline = JSON.parse(failedPauseStatus.stdout);
  const failedPause = runManager([
    'pause', '--file', failedPauseMarker,
    '--mode', 'all', '--reason', 'must prove loaded guards', '--requested-by', 'runtime-test',
    '--expected-generation', String(failedPauseBaseline.generation),
    '--expected-hash', failedPauseBaseline.hash,
    '--systemd-root', failedReloadRoot,
  ], {loadedFile: failedReloadLoadedFile});
  assert.equal(failedPause.status, 1, failedPause.stdout);
  assert.match(failedPause.stderr, /effective|fully settled/);
  await assert.rejects(fs.lstat(failedPauseMarker), error => error.code === 'ENOENT',
    'pause must not publish a marker when daemon-reload never loaded the guard files');

  const dailyRefreshGuard = path.join(
    systemdRoot,
    'shein-bi-cloud-daily-refresh.service.d',
    '40-cloud-maintenance.conf',
  );
  const unknownContent = '[Service]\nExecCondition=/bin/false\n';
  await fs.writeFile(dailyRefreshGuard, unknownContent, 'utf8');
  const unknownGuard = runInstaller(rootArgs);
  assert.equal(unknownGuard.status, 1);
  assert.match(unknownGuard.stderr, /refusing unknown guard content/);
  assert.equal(await fs.readFile(dailyRefreshGuard, 'utf8'), unknownContent);
  await fs.copyFile(path.join(fixtureSystemdSource, templateNames[0]), dailyRefreshGuard);

  const unknownServiceDir = path.join(systemdRoot, 'shein-bi-unknown.service.d');
  const unknownServiceGuard = path.join(unknownServiceDir, '40-cloud-maintenance.conf');
  await fs.mkdir(unknownServiceDir);
  await fs.copyFile(path.join(fixtureSystemdSource, templateNames[0]), unknownServiceGuard);
  const unknownPolicy = runInstaller(rootArgs);
  assert.equal(unknownPolicy.status, 1);
  assert.match(unknownPolicy.stderr, /service without repository policy/);
  assert.equal(await fs.readFile(unknownServiceGuard, 'utf8'), await fs.readFile(path.join(fixtureSystemdSource, templateNames[0]), 'utf8'));
  await fs.unlink(unknownServiceGuard);
  await fs.rmdir(unknownServiceDir);

  const scheduledTemplate = path.join(fixtureSystemdSource, templateNames[0]);
  const scheduledTemplateContent = await fs.readFile(scheduledTemplate, 'utf8');
  await fs.writeFile(scheduledTemplate, `${scheduledTemplateContent}# drift\n`, 'utf8');
  const templateMismatch = runInstaller(rootArgs);
  assert.equal(templateMismatch.status, 1);
  assert.match(templateMismatch.stderr, /tracked template content mismatch/);
  await fs.writeFile(scheduledTemplate, scheduledTemplateContent, 'utf8');

  const missingService = path.join(fixtureSystemdSource, 'shein-bi-cloud-today.service');
  const missingServiceContent = await fs.readFile(missingService, 'utf8');
  await fs.unlink(missingService);
  const missingPolicyContract = runInstaller(rootArgs);
  assert.equal(missingPolicyContract.status, 64, missingPolicyContract.stderr);
  assert.match(missingPolicyContract.stderr, /repository service policy contract is invalid/);
  await fs.writeFile(missingService, missingServiceContent, 'utf8');

  const unclassifiedService = path.join(fixtureSystemdSource, 'shein-bi-unclassified.service');
  await fs.writeFile(unclassifiedService, '[Service]\nExecStart=/bin/true\n', 'utf8');
  const unclassifiedPolicyContract = runInstaller(rootArgs);
  assert.equal(unclassifiedPolicyContract.status, 64, unclassifiedPolicyContract.stderr);
  assert.match(unclassifiedPolicyContract.stderr, /repository service policy contract is invalid/);
  await fs.unlink(unclassifiedService);

  await fs.unlink(dailyRefreshGuard);
  const fixtureAtomic = path.join(fixtureLib, 'atomic_file_publish.mjs');
  await fs.writeFile(fixtureAtomic, `
export async function writeFileAtomic() {}
export async function writeJsonFileAtomic() {}
`, 'utf8');
  const readbackMismatch = runInstaller([...rootArgs, '--apply', '--confirm', CONFIRMATION]);
  assert.equal(readbackMismatch.status, 1);
  assert.match(readbackMismatch.stderr, /guard publish readback mismatch/);

  assert.equal(await fs.readFile(systemctlLog, 'utf8'), 'daemon-reload\nshow\ndaemon-reload\nshow\nshow\n');
  console.log(JSON.stringify({
    ok: true,
    policyServices: Object.keys(CLOUD_MAINTENANCE_POLICY_BY_SERVICE).length,
    installedGuards,
    checks: [
      'default_audit_no_write',
      'exact_confirmation_gate',
      'class_template_install',
      'always_guard_absent',
      'daemon_reload_only',
      'effective_guard_readback',
      'failed_reload_cannot_pause',
      'unknown_content_fail_closed',
      'unknown_policy_fail_closed',
      'missing_policy_fail_closed',
      'source_template_mismatch_fail_closed',
      'final_readback_mismatch_fail_closed',
      'final_readback_contract',
    ],
  }, null, 2));
} finally {
  await fs.rm(tempDir, {recursive: true, force: true});
}
