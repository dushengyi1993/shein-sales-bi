#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  CLOUD_EXPECTED_INSTALLED_UNITS,
  CLOUD_EXPECTED_SERVICE_UNITS,
  CLOUD_LEGACY_MASKED_UNIT_ALLOWLIST,
  CLOUD_MAINTENANCE_POLICY_BY_SERVICE,
  CLOUD_TIMER_SERVICE_BY_TIMER,
  CLOUD_TIMER_UNITS,
  INVENTORY_WRITER_COMPATIBILITY_SERVICES,
  expectedInventoryWriterCompatibilityCommand,
  validateCloudServicePolicyContract,
  validateCloudTimerPolicyContract,
} from '../lib/cloud_runtime_inventory.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SYSTEMD_DIR = path.join(ROOT, 'infra', 'systemd');
const dailyInventoryGuardSource = await fs.readFile(
  path.join(SYSTEMD_DIR, 'shein-bi-daily-inventory-replenishment-guard.service'),
  'utf8',
);
const runPipelineStageSource = await fs.readFile(path.join(ROOT, 'scripts', 'run_pipeline_stage.sh'), 'utf8');
const entries = await fs.readdir(SYSTEMD_DIR, {withFileTypes: true});
const serviceFiles = entries
  .filter(entry => entry.isFile() && /^shein-bi-[A-Za-z0-9_.@-]+\.service$/.test(entry.name))
  .map(entry => entry.name)
  .sort();
assert.equal(serviceFiles.length, 28, 'repository service count changed; every service requires an explicit policy');
assert.deepEqual([...CLOUD_EXPECTED_SERVICE_UNITS].sort(), serviceFiles);
assert.deepEqual(Object.keys(CLOUD_MAINTENANCE_POLICY_BY_SERVICE).sort(), serviceFiles,
  'repository service files and maintenance policy keys must be an exact set match');
const serviceContract = validateCloudServicePolicyContract(serviceFiles);
assert.equal(serviceContract.ok, true, JSON.stringify(serviceContract.issues));

const timerFiles = entries
  .filter(entry => entry.isFile() && entry.name.endsWith('.timer') && entry.name.startsWith('shein-bi-'))
  .map(entry => entry.name)
  .sort();
assert.equal(timerFiles.length, 18, 'repository timer count changed; every timer requires an explicit contract review');

const repositoryTimerToService = [];
for (const timer of timerFiles) {
  const source = await fs.readFile(path.join(SYSTEMD_DIR, timer), 'utf8');
  const unitLines = [...source.matchAll(/^Unit=([^\r\n#;]+)\s*$/gmu)].map(match => match[1].trim());
  assert.equal(unitLines.length, 1, `${timer} must declare exactly one Unit= service`);
  assert.match(unitLines[0], /^shein-bi-[A-Za-z0-9_.@-]+\.service$/);
  await fs.access(path.join(SYSTEMD_DIR, unitLines[0]));
  repositoryTimerToService.push([timer, unitLines[0]]);
}

const contract = validateCloudTimerPolicyContract(repositoryTimerToService);
assert.equal(contract.ok, true, JSON.stringify(contract.issues));
assert.equal(contract.timerCount, 18);
assert.deepEqual([...CLOUD_TIMER_UNITS].sort(), timerFiles);
assert.equal(
  CLOUD_TIMER_SERVICE_BY_TIMER['shein-bi-cloud-marketing-repair.timer'],
  'shein-bi-cloud-marketing-repair.service',
);

for (const service of serviceFiles) {
  const expectedPolicy = [
    'shein-bi-cloud-watchdog.service',
    'shein-bi-portal.service',
    'shein-bi-query.service',
    'shein-bi-session-secret.service',
    'shein-bi-webhook.service',
  ].includes(service)
    ? 'always'
    : [
        'shein-bi-db-backup.service',
        'shein-bi-cloud-disk-maintenance.service',
        'shein-bi-cloud-portal-section-queue.service',
      ].includes(service)
      ? 'infrastructure'
      : 'scheduled';
  assert.equal(CLOUD_MAINTENANCE_POLICY_BY_SERVICE[service], expectedPolicy);
}
assert.equal(CLOUD_MAINTENANCE_POLICY_BY_SERVICE['shein-bi-portal.service'], 'always');
assert.equal(CLOUD_MAINTENANCE_POLICY_BY_SERVICE['shein-bi-webhook.service'], 'always');
assert.equal(CLOUD_MAINTENANCE_POLICY_BY_SERVICE['shein-bi-query.service'], 'always');
assert.equal(CLOUD_MAINTENANCE_POLICY_BY_SERVICE['shein-bi-session-secret.service'], 'always');
assert.equal(CLOUD_MAINTENANCE_POLICY_BY_SERVICE['shein-bi-cloud-watchdog.service'], 'always');
assert.equal(CLOUD_MAINTENANCE_POLICY_BY_SERVICE['shein-bi-db-backup.service'], 'infrastructure');
assert.equal(CLOUD_MAINTENANCE_POLICY_BY_SERVICE['shein-bi-cloud-disk-maintenance.service'], 'infrastructure');
assert.equal(CLOUD_MAINTENANCE_POLICY_BY_SERVICE['shein-bi-cloud-portal-section-queue.service'], 'infrastructure');

const dailyInventoryGuardWants = dailyInventoryGuardSource.match(/^Wants=([^\r\n]*)$/mu)?.[1] ?? '';
const dailyInventoryGuardAfter = dailyInventoryGuardSource.match(/^After=([^\r\n]*)$/mu)?.[1] ?? '';
const dailyInventoryGuardExecStart = dailyInventoryGuardSource.match(/^ExecStart=([^\r\n]*)$/mu)?.[1] ?? '';
assert.doesNotMatch(dailyInventoryGuardWants, /\bshein-bi-cloud-morning-chain\.service\b/,
  'manual start of inventory guard must not pull in morning-chain through Wants');
assert.match(dailyInventoryGuardAfter, /\bshein-bi-cloud-morning-chain\.service\b/,
  'inventory guard must still order after morning-chain when both are active');
assert.match(dailyInventoryGuardExecStart, /run_host_heavy_job\.sh/,
  'standalone inventory guard must retain the host-heavy-job wrapper');
assert.doesNotMatch(dailyInventoryGuardExecStart, /\brun_pipeline_stage\.sh\b/,
  'standalone inventory guard must not add an outer pipeline-stage wrapper');
assert.match(dailyInventoryGuardExecStart,
  /-- \/usr\/bin\/env bash \/opt\/shein-bi\/app\/scripts\/cloud_daily_inventory_replenishment_guard\.sh$/,
  'standalone inventory guard must directly invoke the guard script');
assert.match(dailyInventoryGuardSource,
  /^Environment=SHEIN_BI_INVENTORY_REQUIRE_PIPELINE_MARKERS=1$/mu,
  'the direct guard unit must retain its own DATE-bound marker gate');
const dependencyRequireSource = runPipelineStageSource.slice(
  runPipelineStageSource.indexOf('for required_stage in'),
  runPipelineStageSource.indexOf('echo "[pipeline-stage] start'),
);
assert.match(dependencyRequireSource, /pipeline_marker\.mjs" require/,
  'run_pipeline_stage must check dependency markers through pipeline_marker require');
assert.match(dependencyRequireSource, /--business-date "\$BUSINESS_DATE"/,
  'run_pipeline_stage dependency marker checks must bind the resolved businessDate');

const omittedServicePolicy = {...CLOUD_MAINTENANCE_POLICY_BY_SERVICE};
delete omittedServicePolicy['shein-bi-cloud-daily-refresh.service'];
const omittedServiceCounterexample = validateCloudServicePolicyContract(serviceFiles, omittedServicePolicy);
assert.equal(omittedServiceCounterexample.ok, false);
assert.ok(omittedServiceCounterexample.issues.some(issue => (
  issue.code === 'SERVICE_POLICY_NOT_UNIQUE'
  && issue.service === 'shein-bi-cloud-daily-refresh.service'
)));

const omittedTimerRegistry = {...CLOUD_TIMER_SERVICE_BY_TIMER};
delete omittedTimerRegistry['shein-bi-cloud-marketing-repair.timer'];
const omittedTimerCounterexample = validateCloudTimerPolicyContract(
  repositoryTimerToService,
  omittedTimerRegistry,
  CLOUD_MAINTENANCE_POLICY_BY_SERVICE,
);
assert.equal(omittedTimerCounterexample.ok, false);
assert.ok(omittedTimerCounterexample.issues.some(issue => (
  issue.code === 'TIMER_POLICY_REGISTRATION_MISSING'
  && issue.timer === 'shein-bi-cloud-marketing-repair.timer'
)));

const repositoryUnitFiles = entries
  .filter(entry => entry.isFile() && /^shein-bi-[A-Za-z0-9_.@-]+\.(?:service|timer|path)$/.test(entry.name))
  .map(entry => entry.name)
  .sort();
assert.equal(repositoryUnitFiles.length, 47);
assert.deepEqual([...CLOUD_EXPECTED_INSTALLED_UNITS].sort(), repositoryUnitFiles,
  'expected installed inventory must exactly match tracked service/timer/path files');
assert.deepEqual([...CLOUD_LEGACY_MASKED_UNIT_ALLOWLIST].sort(), [
  'shein-bi-cloud-link-business.service',
  'shein-bi-cloud-link-business.timer',
  'shein-bi-cloud-openapi-hl.service',
  'shein-bi-cloud-openapi-hl.timer',
]);

for (const [file, unitClass] of [
  ['shein-bi-scheduled-maintenance-guard.conf', 'scheduled'],
  ['shein-bi-infrastructure-maintenance-guard.conf', 'infrastructure'],
]) {
  const source = await fs.readFile(path.join(SYSTEMD_DIR, file), 'utf8');
  assert.match(source, /^\[Service\]\r?\n/);
  assert.match(source, new RegExp(`^ExecCondition=/usr/bin/node /opt/shein-bi/app/scripts/manage_cloud_maintenance_mode\\.mjs systemd-condition --class ${unitClass} --unit %n$`, 'mu'));
  assert.doesNotMatch(source, /\bsystemctl\b/);
}

const captureSource = await fs.readFile(path.join(ROOT, 'scripts', 'capture_ops_runtime_snapshot.mjs'), 'utf8');
assert.match(captureSource, /readCloudMaintenanceStatus\(args\.maintenanceFile\)/);
assert.match(captureSource, /expectedUnitFiles:\s*CLOUD_EXPECTED_INSTALLED_UNITS/);
assert.match(captureSource, /summary:\s*\{[\s\S]*?maintenance:\s*\{/);
assert.match(captureSource, /queryUrl:\s*'http:\/\/127\.0\.0\.1:8791\/api\/health'/);
assert.match(captureSource, /fetchHealth\(args\.queryUrl, 'query'\)/);
assert.match(captureSource, /surface:\s*String\(json\.surface/);
assert.match(captureSource, /sideEffectsStartedIsArray:\s*Array\.isArray\(json\.sideEffectsStarted\)/);
assert.match(captureSource, /healthEndpoints:\s*3/);
assert.deepEqual([...INVENTORY_WRITER_COMPATIBILITY_SERVICES], [
  'shein-bi-daily-inventory-replenishment-guard.service',
  'shein-bi-et-low-inventory-guard.service',
  'shein-bi-et-low-inventory-recheck.service',
]);
for (const service of INVENTORY_WRITER_COMPATIBILITY_SERVICES) {
  const expectedGuard = expectedInventoryWriterCompatibilityCommand(service);
  assert.match(expectedGuard, /^\/usr\/local\/libexec\//);
  assert.match(expectedGuard, new RegExp(`--unit ${service.replaceAll('.', '\\.')} `));
  assert.match(expectedGuard, /--systemctl-bin \/usr\/bin\/systemctl /);
  assert.match(expectedGuard, /--compatibility-file \/var\/lib\/shein-bi-control\/inventory-writer-compatibility\/compatibility\.ndjson /);
  assert.doesNotMatch(expectedGuard, /\/opt\/shein-bi\/app\/[^ ]*guard/);
}

console.log(JSON.stringify({
  ok: true,
  repositoryTimers: timerFiles.length,
  repositoryServices: serviceFiles.length,
  expectedInstalledUnits: repositoryUnitFiles.length,
  omittedTimerCounterexample: true,
  omittedServiceCounterexample: true,
  inventoryGuardDoesNotWantMorning: true,
  inventoryGuardAfterMorning: true,
  inventoryGuardDateArgs: true,
  pipelineRequireBusinessDate: true,
}, null, 2));
